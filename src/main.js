// src/main.js — Rock Climber: The Ritual — the integrator.
//
// Boots the renderer, wires the four domains together and runs the loop from CONTRACTS.md:
//   input.read → sim.step (fixed 120 Hz accumulator) → drainEvents → world / arms / rig / hud / audio → post.render
// Also owns the quality tier, the fps watchdog (pixel ratio steps down by 0.25 while the 2-second
// average drops under 24 fps), and window.__ritual: the handle tests and evidence capture use
// (live state, perf counters, console-error count, and a debug autopilot that plays the route
// through the public Input interface — never through the sim's internals).

import * as THREE from 'three';
import { CFG, createClimber, startClimb, step, drainEvents, shoulder, hangTarget, aimPoint } from './sim.js';
import { generateRoute, intendedHand, SEEDS, DEFAULT_SEED, normalizeSeed } from './route.js';
import { createInput } from './input.js';
import { createWebLine } from './webLine.js';
import { createWebFx } from './webFx.js';
import { spiderUnlocked } from './spiderHand.js';
import { createWorld } from './world.js';
import { createPost } from './post.js';
import { createArms } from './arms.js';
import { createCameraRig } from './camera.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';

const MUSIC_URL = new URL('../assets/audio/theme.mp3', import.meta.url).href;
const SIM_DT = 1 / 120;
const MAX_FRAME_DT = 0.25;      // a hidden tab never fast-forwards the climb when it comes back
const WATCHDOG_WINDOW = 2;      // seconds per fps average
const WATCHDOG_MIN_FPS = 24;
const WATCHDOG_WARMUP = 4;      // seconds of shader-compile hitches ignored after boot
const MIN_PIXEL_RATIO = 1.0;
const query = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------------------------
// Console-error counter — installed first so a boot failure is counted too. Evidence reads
// window.__ritual.errors; nothing in the game itself relies on it.
const errors = [];
{
  const push = (m) => { if (errors.length < 200) errors.push(String(m)); };
  window.addEventListener('error', (e) => push(e.message || e));
  window.addEventListener('unhandledrejection', (e) => push((e.reason && e.reason.message) || e.reason));
  const orig = console.error.bind(console);
  console.error = (...a) => { push(a.map((x) => (x && x.message) || x).join(' ')); orig(...a); };
}

// ---------------------------------------------------------------------------------------------
// Quality tier (CONTRACTS.md). `?tier=phone|desktop` forces one for evidence capture in an
// emulated viewport, where the user agent may not be a phone's.
const ua = navigator.userAgent || '';
const forcedTier = query.get('tier');
const isPhone = forcedTier ? forcedTier === 'phone' : (navigator.maxTouchPoints > 1 && /iPhone|iPad|Android/i.test(ua));
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const tier = isPhone
  ? { name: 'phone', pixelRatio: dpr, shadowMapSize: 1024, bloomScale: 0.5, textureRes: '2k color+normal, 1k rest', antialias: true }
  : { name: 'desktop', pixelRatio: dpr, shadowMapSize: 2048, bloomScale: 1.0, textureRes: '2k', antialias: true };
const touch = navigator.maxTouchPoints > 0;

// ---------------------------------------------------------------------------------------------
// Renderer, scene, camera

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: tier.antialias, powerPreference: 'high-performance', alpha: false, stencil: false });
renderer.setPixelRatio(tier.pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
// r185 deprecates PCFSoftShadowMap and silently substitutes PCFShadowMap (with a console warning);
// asking for PCF directly gives the same soft, radius-filtered shadows and a clean console.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;       // reset once per frame so the counters cover every post pass

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(80, window.innerWidth / Math.max(1, window.innerHeight), 0.05, 900);

// ---------------------------------------------------------------------------------------------
// Domains that need no assets: sim, HUD, audio, input

// The cliff is generated from a seed and generation is deterministic, so a seed IS the route.
// `?seed=` picks one; the four in SEEDS are the hand-checked lines the title screen offers, and
// any other number still generates under the same rules with only the bot's word for it.
const seed = query.has('seed') ? normalizeSeed(query.get('seed')) : DEFAULT_SEED;
const route = generateRoute(seed);
let state = createClimber(route);

const hud = createHud(document.body);
const audio = createAudio();
hud.onMute((m) => audio.setMuted(m));
if (audio.muted !== hud.muted) audio.setMuted(hud.muted);   // both persist under the same key; keep them in step
// On a pointer device the cursor drives whichever hand is free and the two mouse buttons are
// the two grips; the thumb sticks and the keyboard keep working alongside it.
const input = createInput({
  hud,
  keyboard: true,
  mouse: canvas,
  getHands: () => state.hands,
});

let rig = createCameraRig(camera);
let post = null;     // created once the renderer has its size (below)
let world = null;
let arms = null;

// --- the web-zip's line ------------------------------------------------------------------
// One line, built once and pointed each frame. It only exists once the egg is unlocked.
let webLine = null;
let webFx = null;
let tautT = 0;                      // seconds since the line went taut, for the settle
function updateWebLine(dt) {
  const w = state.web;
  if (!w || !w.unlocked || !world) return;
  if (!webLine) { webLine = createWebLine({ variant: 'rope' }); scene.add(webLine.group); }
  if (!webFx) webFx = createWebFx({ scene });

  if (w.mode === 'flying' || w.mode === 'attached') {
    const hand = state.hands.R;
    const hz = world.wallZ(hand.x, hand.y) + 0.05;
    const az = world.wallZ(w.ax, w.ay) + 0.02;
    const flying = w.mode === 'flying';
    const grow = flying
      ? Math.min(0.999, Math.hypot(w.tipX - hand.x, w.tipY - hand.y) / Math.max(1e-3, Math.hypot(w.ax - hand.x, w.ay - hand.y)))
      : 1;
    tautT = flying ? 0 : tautT + dt;
    webLine.set(
      new THREE.Vector3(hand.x, hand.y, hz),
      new THREE.Vector3(w.ax, w.ay, az),
      {
        grow,
        // the lash while it travels, dying as it arrives
        whip: flying ? (1 - grow) * 0.9 + 0.1 : 0,
        // and once it bites, it snaps straight over about a third of a second
        taut: flying ? 0 : Math.min(1, tautT * 3),
      },
    );
  } else {
    webLine.visible = false;
    tautT = 0;
  }

  webFx.update(dt, state, camera, world.wallZ, w.mode === 'aiming' ? aimPoint(state) : null);
}

// ---------------------------------------------------------------------------------------------
// Perf counters + fps watchdog (evidence reads window.__ritual.perf)

const perf = {
  fps: 0,               // last 2-second average
  frames: 0,            // frames rendered since boot
  frameMs: 0,           // last frame time
  minFps: Infinity,     // worst 2-second window since the climb started
  history: [],          // one { t, fps, pixelRatio } per 2-second window, capped at 10 minutes
  pixelRatio: tier.pixelRatio,
  drawCalls: 0, triangles: 0,
  stepsPerFrame: 0,
  // Promise of the average fps over `seconds` of wall time from now.
  sample(seconds = 10) {
    return new Promise((resolve) => samplers.push({ t0: performance.now(), frames: 0, worst: 0, seconds, resolve }));
  },
};
const samplers = [];
let winT = 0, winN = 0, upT = 0;

function watchdog(dt) {
  upT += dt;
  winT += dt; winN++;
  if (winT < WATCHDOG_WINDOW) return;
  const fps = winN / winT;
  perf.fps = fps;
  perf.pixelRatio = renderer.getPixelRatio();
  if (perf.history.length >= 300) perf.history.shift();
  perf.history.push({ t: +state.t.toFixed(1), fps: +fps.toFixed(1), pixelRatio: perf.pixelRatio });
  if (upT > WATCHDOG_WARMUP) {
    if (fps < perf.minFps) perf.minFps = fps;
    if (fps < WATCHDOG_MIN_FPS && renderer.getPixelRatio() > MIN_PIXEL_RATIO + 1e-6) {
      const pr = Math.max(MIN_PIXEL_RATIO, renderer.getPixelRatio() - 0.25);
      renderer.setPixelRatio(pr);
      resize();
      console.warn(`[ritual] ${fps.toFixed(1)} fps: pixel ratio stepped down to ${pr}`);
    }
  }
  winT = 0; winN = 0;
}

// ---------------------------------------------------------------------------------------------
// Resize (also fires when iOS shows or hides its toolbars)

function resize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  rig.setPortrait(h >= w);
  if (post) post.resize(w, h);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 60));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

// ---------------------------------------------------------------------------------------------
// Debug surface (window.__ritual.debug): autopilot through the Input interface, teleport,
// pause/advance, fps overlay. Used by the test/evidence harness only.

const zeroInput = () => ({ L: { x: 0, y: 0 }, R: { x: 0, y: 0 }, tapL: false, tapR: false, holdL: false, holdR: false });
const heldDebug = { L: false, R: false };   // debug.hold(side, on) — the evidence harness fires the web with this
const OTHER = { L: 'R', R: 'L' };

// dwell: seconds both hands rest after a grab before the next move — a human pace, not a blur.
// minStamina: a free hand below this is refilling and does not tap GRIP (a spent hand re-grabbing slips at once).
// runeRest: a hand on a rune stays there until it is this fresh — runes are the route's rest holds.
const auto = { on: false, target: null, from: null, t0: 0, dwell: 0.12, restUntil: 0, minStamina: 0.2, runeRest: 0.95, grabs: 0, retargets: 0, timeouts: 0, longestReach: 0, falls: 0, log: [] };

// Stick vector that points a free hand at `hold` from its current shoulder — what a player aims for.
function steerTo(st, side, hold) {
  const sh = shoulder(st, side);
  const v = { x: (hold.x - sh.x) / CFG.REACH, y: (hold.y - sh.y) / CFG.REACH };
  const m = Math.hypot(v.x, v.y);
  if (m > 1) { v.x /= m; v.y /= m; }
  return v;
}

// Next hold to reach for: while climbing, the hold after the highest one held (the route
// alternates hands, so its intended hand is free or about to be); on the rope, the highest hold
// the hand meant for it can reach.
function pickTarget(st) {
  const H = st.route.holds;
  const { L, R } = st.hands;
  if (!L.gripping && !R.gripping) {
    let best = null;
    for (const h of H) {
      const sh = shoulder(st, intendedHand(h.id));
      if (Math.hypot(h.x - sh.x, h.y - sh.y) <= 0.9 * CFG.REACH && (!best || h.y > best.y)) best = h;
    }
    return best ? best.id : null;
  }
  const next = Math.max(L.gripping ? L.holdId : -1, R.gripping ? R.holdId : -1) + 1;
  return next < H.length ? next : null;
}

function autoInput(st) {
  const inp = zeroInput();
  if (st.phase !== 'climbing' && st.phase !== 'caught') { auto.target = null; return inp; }   // title, summit, mid-fall: wait
  const H = st.route.holds;
  if (auto.target !== null && st.t - auto.t0 > (st.phase === 'caught' ? 3 : 8)) {
    auto.timeouts++; auto.target = null;             // give up on this hold and re-plan
  }
  if (auto.target === null) {
    if (st.t < auto.restUntil && st.hands.L.gripping && st.hands.R.gripping) return inp;   // dwell after a grab
    auto.target = pickTarget(st);
    if (auto.target === null) return inp;
    auto.t0 = st.t;
    auto.from = st.hands[intendedHand(auto.target)].holdId;   // null when that hand is free
    auto.retargets++;
  }
  const side = intendedHand(auto.target);
  const hand = st.hands[side], other = st.hands[OTHER[side]];
  if (hand.gripping && hand.holdId !== auto.from) {          // arrived — on the target or another hold of this hand's side
    auto.grabs++;
    auto.longestReach = Math.max(auto.longestReach, st.t - auto.t0);
    auto.restUntil = st.t + auto.dwell;
    auto.target = null;
    return inp;
  }
  if (hand.gripping) {                                       // still on the previous hold: let go to reach (never into a fall)
    const on = H[hand.holdId];                               // hold ids equal their index (route.js)
    if (on && on.kind === 'rune' && hand.stamina < auto.runeRest) return inp;   // a rune is a rest hold: shake out here first
    if (other.gripping && st.phase === 'climbing') inp['tap' + side] = true;
    return inp;
  }
  inp[side] = steerTo(st, side, H[auto.target]);
  // A spent hand (it just slipped) would slip again the moment it re-grabbed: like a climber, shake it
  // out until it has some stamina back before tapping GRIP.
  if (!hand.armed && hand.stamina >= auto.minStamina) inp['tap' + side] = true;   // grabs within SNAP, else arms
  return inp;
}

// Put both hands on the two consecutive holds nearest height `y`, body hanging below them, every
// rune below already lit — a screenshot position, not a shortcut a player can take.
function teleport(y) {
  const H = state.route.holds;
  let i = 0;
  for (let k = 0; k < H.length; k++) if (Math.abs(H[k].y - y) < Math.abs(H[i].y - y)) i = k;
  if (i >= H.length - 2) i = H.length - 3;             // keep the summit hold itself for the player
  if (i < 0) i = 0;
  const a = H[i], b = H[i + 1];
  const pair = { [intendedHand(a.id)]: a, [intendedHand(b.id)]: b };
  if (!pair.L || !pair.R) { pair.L = a; pair.R = b; }
  for (const side of ['L', 'R']) {
    const h = state.hands[side], hold = pair[side];
    Object.assign(h, { x: hold.x, y: hold.y, vx: 0, vy: 0, tx: hold.x, ty: hold.y, gripping: true, holdId: hold.id, armed: false, stamina: 1, curl: 1, hover: 1, tremble: 0 });
  }
  state.phase = 'climbing';
  const tgt = hangTarget(state);
  Object.assign(state.body, { x: tgt.x, y: tgt.y, vx: 0, vy: 0 });
  for (const h of H) {
    if (h.kind === 'rune' && h.y < state.body.y + 0.6 && !h.lit) { h.lit = true; state.runesLit.push(h.id); state.checkpoint = h.id; }
  }
  state.height = state.body.y;
  state.maxHeight = Math.max(state.maxHeight, state.body.y);
  state.night = Math.min(1, Math.max(0, state.body.y / state.route.top));
  auto.target = null;
  auto.restUntil = 0;
  pendingTap.L = pendingTap.R = false;
  return { hold: i, y: state.body.y };
}

let overlayEl = null;
function overlay(on) {
  if (on && !overlayEl) {
    overlayEl = document.createElement('div');
    overlayEl.id = 'fps';
    overlayEl.style.cssText = 'position:fixed;top:calc(56px + env(safe-area-inset-top,0px));right:12px;z-index:30;pointer-events:none;' +
      'font:600 11px/1.45 ui-monospace,Menlo,monospace;color:#7fe0ff;text-align:right;text-shadow:0 1px 4px #000,0 0 10px rgba(0,0,0,.8);' +
      'background:rgba(10,12,24,.55);padding:6px 8px;border-radius:8px;white-space:pre';
    document.body.appendChild(overlayEl);
  } else if (!on && overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
}
let overlayT = 0;
function updateOverlay(dt) {
  if (!overlayEl) return;
  overlayT += dt;
  if (overlayT < 0.25) return;
  overlayT = 0;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  overlayEl.textContent =
    `${perf.fps.toFixed(1)} fps  ${perf.frameMs.toFixed(1)} ms\n` +
    `${tier.name} ×${renderer.getPixelRatio().toFixed(2)}  ${size.x}×${size.y}\n` +
    `${perf.drawCalls} calls  ${(perf.triangles / 1000).toFixed(0)}k tris\n` +
    `${state.phase}  ${state.body.y.toFixed(1)} m  night ${state.night.toFixed(2)}`;
}

const queuedEvents = [];
const debug = {
  auto,
  timeScale: 1,
  pause: false,
  autopilot(on = true) { auto.on = !!on; auto.target = null; auto.restUntil = 0; return auto.on; },
  teleport,
  overlay,
  // Step the sim synchronously (zero input) — freeze frames of a fall or a catch for a screenshot.
  advance(seconds) {
    let n = Math.max(0, Math.round(seconds / SIM_DT));
    const inp = zeroInput();
    while (n-- > 0) step(state, inp, SIM_DT);
    queuedEvents.push(...drainEvents(state));
    return state.phase;
  },
  fall() { pendingTap.L = pendingTap.R = true; },
  tap(side) { pendingTap[side] = true; },
  hold(side, on = true) { heldDebug[side] = !!on; return heldDebug; },
  start() {
    const title = document.getElementById('title');
    if (title && !title.hidden) title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  },
  restart,
};

// ---------------------------------------------------------------------------------------------
// Start / restart

function start() {
  audio.unlock();
  audio.setMusic(MUSIC_URL);
  startClimb(state);
  upT = 0;                      // the watchdog's warm-up restarts with the climb (title → HUD swap compiles shaders)
  perf.minFps = Infinity;
  if (query.has('auto')) debug.autopilot(true);
  state.web.unlocked = spiderUnlocked();       // the egg, if the code has been typed
  hud.refreshCustomBtn();
}

function restart() {
  state = createClimber(generateRoute(route.seed));   // fresh holds: nothing lit, nothing remembered
  state.web.unlocked = spiderUnlocked();
  startClimb(state);
  rig = createCameraRig(camera);
  rig.setPortrait(window.innerHeight >= window.innerWidth);
  auto.target = null;
  auto.restUntil = 0;                 // the new climb's clock starts at zero
  pendingTap.L = pendingTap.R = false;
  hud.hideEnd();
  hud.message('Light every rune · reach the altar', 3000);
}

hud.onStart(start);
hud.onRestart(restart);
// Picking a route rebuilds the cliff, the holds, the decoys and the arms, so it goes through the
// URL and one reload rather than a half-hearted in-place swap. It only happens on the title
// screen, before anything has been climbed, and it leaves a link that opens the same route.
hud.onSeed((next) => {
  if (!Number.isFinite(next) || next === seed) return;
  const q = new URLSearchParams(location.search);
  q.set('seed', String(normalizeSeed(next)));
  location.search = q.toString();
});

// ---------------------------------------------------------------------------------------------
// Frame loop

const pendingTap = { L: false, R: false };   // taps are edge-triggered; keep one until a sim step consumes it
let last = performance.now();
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (!(dt > 0)) dt = 0;
  if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
  perf.frameMs = dt * 1000;
  perf.frames++;

  // Input: read once per frame (the HUD knobs follow), merge the autopilot on top.
  let inp = input.read();
  const lookIn = inp.look;
  if (auto.on && !debug.pause) {
    const ai = autoInput(state);
    inp = { L: ai.L, R: ai.R, tapL: inp.tapL || ai.tapL, tapR: inp.tapR || ai.tapR, look: lookIn };
    hud.setStick('L', ai.L.x, ai.L.y);
    hud.setStick('R', ai.R.x, ai.R.y);
  }
  if (!debug.pause) {                  // a frozen sim swallows taps instead of firing them all on resume
    if (inp.tapL) pendingTap.L = true;
    if (inp.tapR) pendingTap.R = true;
  }

  // Sim: fixed 120 Hz steps; the first step of a frame carries the taps.
  let steps = 0;
  if (!debug.pause) {
    acc += dt * Math.max(0, debug.timeScale || 1);
    const maxSteps = Math.ceil(16 * Math.max(1, debug.timeScale || 1));
    while (acc >= SIM_DT && steps < maxSteps) {
      step(state, {
        L: inp.L, R: inp.R,
        tapL: pendingTap.L, tapR: pendingTap.R,
        // held grips drive the web-zip's aim; without these the shot can never charge
        holdL: inp.holdL || heldDebug.L, holdR: inp.holdR || heldDebug.R,
      }, SIM_DT);
      pendingTap.L = pendingTap.R = false;
      acc -= SIM_DT;
      steps++;
    }
    if (steps >= maxSteps) acc = 0;    // a very long hitch: drop the remainder instead of catching up
  }
  perf.stepsPerFrame = steps;

  const events = queuedEvents.length ? queuedEvents.splice(0).concat(drainEvents(state)) : drainEvents(state);
  if (auto.on && events.length) {
    for (const e of events) {
      if (e.type === 'fall') auto.falls++;
      if (auto.log.length < 4000) auto.log.push({ t: +state.t.toFixed(2), type: e.type, hand: e.hand, holdId: e.holdId });
    }
  }

  // Render domains, in contract order.
  renderer.info.reset();
  world.update(dt, state, camera, events);   // events: the decoy dust is fired by 'crumble'
  arms.update(dt, state, world.wallZ, camera);
  updateWebLine(dt);
  rig.update(dt, state, world.wallZ, events, lookIn,
    state.web && state.web.unlocked && state.web.mode === 'aiming' ? aimPoint(state) : null);
  hud.update(state, events);
  audio.handle(events, state, dt);
  post.setNight(state.night);
  post.render(dt);
  perf.drawCalls = renderer.info.render.calls;
  perf.triangles = renderer.info.render.triangles;

  watchdog(dt);
  updateOverlay(dt);
  for (let i = samplers.length - 1; i >= 0; i--) {
    const s = samplers[i];
    s.frames++;
    if (dt * 1000 > s.worst) s.worst = dt * 1000;
    const el = (now - s.t0) / 1000;
    if (el >= s.seconds) {
      samplers.splice(i, 1);
      s.resolve({ fps: +(s.frames / el).toFixed(2), frames: s.frames, seconds: +el.toFixed(2), worstFrameMs: +s.worst.toFixed(1), pixelRatio: renderer.getPixelRatio(), tier: tier.name });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Boot: load the world and the hands in parallel, warm the shaders with one frame, show the title.

async function boot() {
  post = createPost({ renderer, scene, camera, tier });
  let worldRef = null;
  const [w, a] = await Promise.all([
    createWorld({ renderer, scene, route, tier }),
    createArms({ scene, tier, shoulder, holdZ: (hold) => (worldRef ? worldRef.holdZ(hold) : 0) }),
  ]);
  world = worldRef = w;
  arms = a;
  resize();

  // One silent frame compiles every shader while the boot splash is still up.
  world.update(0, state, camera);
  arms.update(0, state, world.wallZ, camera);
  rig.update(0, state, world.wallZ);
  hud.update(state);
  post.setNight(state.night);
  post.render(0);

  hud.showTitle({ touch, seeds: SEEDS, seed });
  if (query.has('fps')) overlay(true);
  last = performance.now();
  requestAnimationFrame(frame);
}

window.__ritual = {
  get state() { return state; },
  get world() { return world; },
  get arms() { return arms; },
  get rig() { return rig; },
  get post() { return post; },
  hud, audio, input, renderer, scene, camera, tier, perf, errors, debug,
  seed,
  sim: { CFG, createClimber, startClimb, step, drainEvents, shoulder, generateRoute, SEEDS },
  get ready() { return !!(world && arms); },
};

boot().catch((err) => {
  console.error('[ritual] boot failed', err);
  hud.showTitle({ touch, seeds: SEEDS, seed });
  hud.message('Could not load the cliff — ' + (err && err.message ? err.message : err), 12000);
});

// Changing the glove rebuilds the hands. A skinned mesh carries its material through its clone,
// so the honest way to re-skin is to build the arms again with the new choice.
hud.onSkinChange(async () => {
  if (!arms || !scene) return;
  try {
    const next = await createArms({
      scene, tier, shoulder,
      holdZ: (hold) => (world ? world.holdZ(hold) : 0),   // module-level `world`; worldRef is scoped to boot
    });
    if (arms && arms.dispose) arms.dispose();
    else if (arms && arms.group) scene.remove(arms.group);
    arms = next;
    state.web.unlocked = spiderUnlocked();
  } catch (err) { console.error('re-skin failed', err); }
});
