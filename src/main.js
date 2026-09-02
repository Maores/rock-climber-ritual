// src/main.js — Rock Climber: The Ritual — the integrator.
//
// Boots the renderer, wires the four domains together and runs the loop from CONTRACTS.md:
//   input.read → sim.step (fixed 120 Hz accumulator) → drainEvents → world / arms / rig / hud / audio → post.render
// Also owns the quality tier, the fps watchdog (pixel ratio steps down by 0.25 while the 2-second
// average drops under 24 fps), and window.__ritual: the handle tests and evidence capture use
// (live state, perf counters, console-error count, and a debug autopilot that plays the route
// through the public Input interface — never through the sim's internals).

import * as THREE from 'three';
import { CFG, createClimber, startClimb, step, drainEvents, shoulder, restingShoulder, grabRadius, hangTarget, aimPoint, cutWeb } from './sim.js';
import { generateRoute, SEEDS, DEFAULT_SEED, normalizeSeed } from './route.js';
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
// B54: testing default while the controls are being reworked — flip to false to ship the real mechanic
const UNLIMITED_STAMINA = !query.has('stamina');

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
  steps: 0,             // watchdog step-downs this climb, counted at the fire (review of B27)
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
      perf.steps++;                      // counted, not derived: a clamped last step rounded away to 'steps 0'
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

// `active` is the B45 flag: false here means "nobody is on this stick", so a free hand keeps its
// parked target instead of reading a zero vector as a push toward the shoulder. There is no
// `tapL`/`tapR`/`holdL` any more: the GRIP buttons are gone (B51) and the sim reads neither.
const zeroInput = () => ({ L: { x: 0, y: 0, active: false }, R: { x: 0, y: 0, active: false }, holdR: false });
// debug.hold(side, on). Only `R` reaches the sim — `holdR` is the WEB pad's held state, and it is
// the evidence harness's way of charging a shot. `L` is kept so the call is symmetrical and so a
// harness that sets it is not silently lying; nothing downstream reads it.
const heldDebug = { L: false, R: false };
const OTHER = { L: 'R', R: 'L' };
const REACHABLE = 0.9 * CFG.REACH;   // route.js's own guarantee: every hold is this close to the
                                     // shoulder of the hand meant to take it

// dwell: seconds both hands rest after a grab before the next move — a human pace, not a blur.
// runeRest: a hand on a rune stays there until it is this fresh — runes are the route's rest holds.
// sideways: consecutive moves that gained no height; after MAX_SIDEWAYS the bot stops planning
// rather than shuffling between the same rocks for ever on a wall with no way up.
const MAX_SIDEWAYS = 3;
const auto = {
  on: false, target: null, side: null, from: null, t0: 0, centre: false,
  dwell: 0.12, restUntil: 0, runeRest: 0.95,
  grabs: 0, retargets: 0, timeouts: 0, sideways: 0, longestReach: 0, falls: 0, log: [],
};

// Stick vector that points a hand at `hold` from its current shoulder — what a player aims for.
// `full` normalises it to the rim of the ring: that is the RELEASE push (it has to clear
// CFG.RELEASE_DEADZONE), and it is already aimed at where the hand is going. Once the hand is
// free the vector is left PROPORTIONAL, because `shoulder + stick × REACH` is where the hand
// parks, and a full-deflection steer would park it at arm's length past the rock instead of on it.
function steerTo(st, side, hold, full = false) {
  const sh = shoulder(st, side);
  const v = { x: (hold.x - sh.x) / CFG.REACH, y: (hold.y - sh.y) / CFG.REACH };
  const m = Math.hypot(v.x, v.y);
  if ((m > 1 || full) && m > 1e-6) { v.x /= m; v.y /= m; }
  v.active = true;             // the bot's thumb is on the stick for this frame
  return v;
}

// The best hold for `freeSide` to reach for from the stance we are actually in. Pure geometry —
// no hold-id arithmetic, because ids are not a ladder: `max(id) + 1` is the next rung only on a
// single-line route, and on a field of a couple of thousand holds it is a rock somewhere else
// entirely. The anchor is the OTHER hand's hold; `restingShoulder` says where this hand's
// shoulder ends up once the body hangs from that anchor alone, and route.js guarantees every hold
// is within 0.9·REACH of that point. Runes are the rests and the summit ends the climb, so both
// win over a merely higher rock.
function bestReach(st, freeSide, upOnly) {
  const anchor = st.hands[OTHER[freeSide]];
  const grip = anchor.gripping ? st.route.holds[anchor.holdId] : null;   // ids equal their index (route.js)
  const free = st.hands[freeSide];
  const fromY = free.gripping ? st.route.holds[free.holdId].y : -Infinity;
  const sh = grip ? restingShoulder(grip, freeSide) : shoulder(st, freeSide);
  let best = null, bestScore = -Infinity;
  for (const h of st.route.holds) {
    if (grip && h.id === grip.id) continue;                    // two hands never share a hold
    if (free.gripping && h.id === free.holdId) continue;       // nor is the hold we are leaving a target
    if (upOnly && h.y <= fromY + 0.02) continue;               // a move up, not a shuffle
    if (Math.hypot(h.x - sh.x, h.y - sh.y) > REACHABLE) continue;
    const score = h.y + (h.kind === 'summit' ? 100 : h.kind === 'rune' ? 0.5 : 0);
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return best;
}

// Which hand moves next, and to which hold. With both hands on the rock either could go, so both
// are costed and the one that ends up highest wins — which is what makes the bot leapfrog without
// anybody telling it that hold ids alternate hands.
function pickTarget(st) {
  const both = st.hands.L.gripping && st.hands.R.gripping;
  for (const upOnly of [true, false]) {
    if (!upOnly && auto.sideways >= MAX_SIDEWAYS) break;
    let best = null;
    for (const side of ['L', 'R']) {
      if (!both && st.hands[side].gripping) continue;          // one hand free: that is the hand that moves
      const h = bestReach(st, side, upOnly);
      if (h && (!best || h.y > best.hold.y)) best = { side, hold: h };
    }
    if (best) return { side: best.side, id: best.hold.id, up: upOnly };
  }
  return null;
}

// The autopilot, played through the public Input interface and nothing else (B51): there is no
// GRIP to tap any more, so ONE gesture moves a hand — push its own stick at the target, which
// both opens the fingers and aims the reach — and then the stick keeps steering until the hover
// dwell closes the hand on the rock by itself.
function autoInput(st) {
  const inp = zeroInput();
  if (st.phase !== 'climbing' && st.phase !== 'grounded') { auto.target = null; return inp; }   // title, summit, mid-fall, the line: wait
  const H = st.route.holds;
  if (auto.target !== null && st.t - auto.t0 > (st.phase === 'grounded' ? 3 : 8)) {
    auto.timeouts++; auto.target = null;             // give up on this hold and re-plan
  }
  if (auto.target === null) {
    if (st.t < auto.restUntil && st.hands.L.gripping && st.hands.R.gripping) return inp;   // dwell after a grab
    const pick = pickTarget(st);
    if (!pick) return inp;
    auto.target = pick.id;
    auto.side = pick.side;
    auto.from = st.hands[pick.side].holdId;          // null when that hand is already free
    auto.t0 = st.t;
    auto.retargets++;
    auto.sideways = pick.up ? 0 : auto.sideways + 1;
    // One CENTRED frame before the push. `grab()` drops the sim's release latch (`_relArm`) so
    // that the stick which steered a hand onto rock cannot drop it the frame after it closed; the
    // latch re-arms only on a frame where that stick is back inside RELEASE_DEADZONE. Two
    // consecutive releases of the same hand with no centred frame between them therefore never
    // let go at all — the stall the tap-based autopilot used to hide. This is the same beat that
    // test/playability.test.js's releaseHand() opens with.
    auto.centre = true;
  }
  const side = auto.side;
  const hand = st.hands[side];
  if (hand.gripping && hand.holdId !== auto.from) {   // arrived — on the target, or on rock it found on the way
    auto.grabs++;
    auto.longestReach = Math.max(auto.longestReach, st.t - auto.t0);
    auto.restUntil = st.t + auto.dwell;
    auto.target = null;
    return inp;
  }
  if (hand.gripping) {
    const on = H[hand.holdId];
    // A rune is a rest hold: shake out here before moving on, and do not let the plan time out
    // while we do it.
    if (on && on.kind === 'rune' && hand.stamina < auto.runeRest) { auto.t0 = st.t; return inp; }
  }
  if (auto.centre) { auto.centre = false; return inp; }
  // Gripping: full deflection, because that push IS the release. Free: proportional, because the
  // stick is now parking the hand and it must park ON the rock.
  inp[side] = steerTo(st, side, H[auto.target], hand.gripping);
  return inp;
}

// Where to push a stick so the hand it frees finds nothing: the direction whose reach sweeps
// furthest from every piece of rock, decoys included. debug.fall() needs it, because with the
// grab automatic a hand let go into rock simply takes it again inside the grace window.
function escapeDir(st, side) {
  const sh = shoulder(st, side);
  let best = { x: side === 'L' ? -1 : 1, y: 0 }, bestClear = -Infinity;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    let clear = Infinity;
    for (let k = 4; k <= 10; k++) {               // sample the path out, not only the far end
      const px = sh.x + dx * CFG.REACH * (k / 10), py = sh.y + dy * CFG.REACH * (k / 10);
      for (const h of st.route.holds) { const d = Math.hypot(h.x - px, h.y - py) - grabRadius(h); if (d < clear) clear = d; }
      for (const f of st.route.fakes || []) { if (f.broken) continue; const d = Math.hypot(f.x - px, f.y - py) - grabRadius(f); if (d < clear) clear = d; }
    }
    if (clear > bestClear) { bestClear = clear; best = { x: dx, y: dy }; }
  }
  return { x: best.x, y: best.y, active: true, clear: bestClear };
}

// Put both hands on a pair of holds near height `y`, body hanging below them, every rune below
// already lit — a screenshot position, not a shortcut a player can take.
//
// The pair is chosen GEOMETRICALLY. It used to be `H[i]` and `H[i + 1]` by height order, which
// only pairs sensibly on a single-line route where consecutive ids are consecutive rungs; sort a
// field of holds by height and neighbours are metres apart, so the climber was hung from two rocks
// he could not possibly hold at once. Now: the hold nearest `y`, then the best partner within
// 2·REACH of it that lands on the opposite side of the body and that the sim can actually hang
// from — both holds inside REACH of their own shoulder at the body position the pair produces.
function teleport(y) {
  const H = state.route.holds;
  const usable = H.filter((h) => h.kind !== 'summit');        // the altar stays for the player
  if (usable.length < 2) return null;
  let a = usable[0];
  for (const h of usable) if (Math.abs(h.y - y) < Math.abs(a.y - y)) a = h;

  let best = null, bestScore = -Infinity;
  for (const b of usable) {
    if (b.id === a.id) continue;
    if (Math.abs(b.x - a.x) < 0.06) continue;                 // they have to fall either side of the body
    if (Math.hypot(b.x - a.x, b.y - a.y) > 2 * CFG.REACH) continue;
    const left = a.x < b.x ? a : b, right = a.x < b.x ? b : a;
    const bx = (a.x + b.x) / 2, by = (a.y + b.y) / 2 - CFG.HANG_TWO;      // hangTarget for two holds
    const dl = Math.hypot(left.x - (bx - CFG.SHOULDER_DX), left.y - (by + CFG.SHOULDER_DY));
    const dr = Math.hypot(right.x - (bx + CFG.SHOULDER_DX), right.y - (by + CFG.SHOULDER_DY));
    const margin = Math.min(CFG.REACH - dl, CFG.REACH - dr);
    if (margin <= 0.01) continue;                             // the sim could not hold this stance
    const score = margin - 0.25 * Math.abs(b.y - a.y);        // roomy, and level enough to look like a stance
    if (score > bestScore) { bestScore = score; best = { L: left, R: right, margin }; }
  }
  if (!best) return null;

  for (const side of ['L', 'R']) {
    const h = state.hands[side], hold = best[side];
    // Everything grab() sets, because this IS a grab that never happened: the contact offset (a
    // stale one from the last hold would hang the hand off the rock), the hover dwell, the release
    // latch down exactly as a real grab leaves it, the hold lock-out cleared, the sloper clock zeroed.
    Object.assign(h, {
      x: hold.x, y: hold.y, vx: 0, vy: 0, tx: hold.x, ty: hold.y,
      gripping: true, holdId: hold.id, armed: false, stamina: 1, curl: 1, hover: 1, tremble: 0,
      gripDX: 0, gripDY: 0, nearId: hold.id, nearDist: 0,
      _hoverId: null, _hoverT: 0, _relArm: false, _relT: 0,
      _skipId: null, _spent: false, _missT: 0, _regripT: 0, _onT: 0,
    });
    h._stick.x = h._stick.y = 0;
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
  auto.sideways = 0;
  pendingPush.L = pendingPush.R = null;
  return {
    L: best.L.id, R: best.R.id, y: +state.body.y.toFixed(3),
    gap: +Math.hypot(best.L.x - best.R.x, best.L.y - best.R.y).toFixed(3),
    reachMargin: +best.margin.toFixed(3),
  };
}

// `?fps=1` overlay. It is read on a phone held at arm's length, so B27: the headline number is
// big enough to glance at (11px was under Apple's 11pt floor), the block clears the safe area on
// every edge rather than only the top, and it answers the whole question on its own — the tier
// that was picked, the pixel ratio *now*, the worst 2-second window since the climb started, and
// how many times the watchdog stepped the pixel ratio down. Those last two are read out of
// `perf` and out of the renderer; nothing new is tracked to draw them.
let overlayEl = null, overlayNum = null, overlayRest = null;
function overlay(on) {
  if (on && !overlayEl) {
    overlayEl = document.createElement('div');
    overlayEl.id = 'fps';
    overlayEl.style.cssText = 'position:fixed;z-index:30;pointer-events:none;' +
      // 74px clears the whole of #top (the fall count, the height meter and the rune row, 66px
      // tall) whatever the rune count, so the block never lands on the HUD it is measuring.
      'top:calc(74px + env(safe-area-inset-top,0px));right:calc(12px + env(safe-area-inset-right,0px));' +
      'font:600 13px/1.5 ui-monospace,Menlo,monospace;color:#f1e6d8;text-align:right;' +
      'text-shadow:0 1px 4px #000,0 0 10px rgba(0,0,0,.9);' +
      'background:rgba(8,10,20,.74);border:1px solid rgba(127,224,255,.22);' +
      'padding:7px 10px;border-radius:10px;white-space:pre';
    overlayNum = document.createElement('div');
    overlayNum.style.cssText = 'font:700 22px/1.15 ui-monospace,Menlo,monospace;letter-spacing:-.02em;margin-bottom:2px';
    overlayRest = document.createElement('div');
    overlayEl.append(overlayNum, overlayRest);
    document.body.appendChild(overlayEl);
  } else if (!on && overlayEl) {
    overlayEl.remove();
    overlayEl = overlayNum = overlayRest = null;
  }
}
let overlayT = 0;
function updateOverlay(dt) {
  if (!overlayEl) return;
  overlayT += dt;
  if (overlayT < 0.25) return;
  overlayT = 0;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  // The watchdog only ever steps down, and only by 0.25, so the count is the distance travelled.
  const steps = perf.steps;
  const min = isFinite(perf.minFps) ? perf.minFps.toFixed(1) : '--';
  const fps = perf.fps;
  overlayNum.textContent = `${fps.toFixed(1)} fps`;
  // Rune teal at or above the 30 fps target, HUD gold between there and the watchdog line, red under it.
  overlayNum.style.color = fps <= 0 ? '#f1e6d8' : fps >= 30 ? '#7fe0ff' : fps >= WATCHDOG_MIN_FPS ? '#d99a5b' : '#e8695f';
  overlayRest.textContent =
    `min ${min}   steps ${steps}\n` +
    `tier ${tier.name}  ×${pr.toFixed(2)}\n` +
    `${size.x}×${size.y}  ${perf.frameMs.toFixed(1)} ms\n` +
    `${perf.drawCalls} calls  ${(perf.triangles / 1000).toFixed(0)}k tris\n` +
    `${state.phase} ${state.body.y.toFixed(1)}m n${state.night.toFixed(2)}`;
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
  // A stick vector, injected the way a thumb would push one. Default: it lasts exactly one
  // rendered frame — every fixed sub-step of that frame — which is all a nudge needs. `seconds`
  // holds it for that much SIM time instead. This replaces debug.tap(): there is no tap.
  push(side, x = 0, y = 1, seconds = 0) {
    if (side !== 'L' && side !== 'R') return null;
    pendingPush[side] = { x: +x || 0, y: +y || 0, active: true, until: seconds > 0 ? state.t + seconds : null };
    return pendingPush[side];
  },
  // Kept as an alias so old evidence scripts still say something true: a "tap" is now a push
  // straight up, which on a gripping hand is a release and on a free hand is a reach.
  tap(side) { return debug.push(side, 0, 1); },
  hold(side, on = true) { heldDebug[side] = !!on; return heldDebug; },
  // Let go with both hands, on purpose, and mean it. Both sticks are pushed the way that finds no
  // rock (escapeDir), held past CFG.RELEASE_CONFIRM and then through the whole grace window, so
  // nothing catches what you asked for (B43). Stepped synchronously, like advance(), so the caller
  // gets the answer rather than a promise; the plunge itself then plays out in the frame loop.
  // From the foot of the route this correctly ends 'grounded' — your feet never left the ground.
  fall() {
    // On the line both hands are already off, so there is nothing to let go of: the line is what
    // holds you, and cutting it is the fall.
    if (state.phase === 'swinging') { cutWeb(state); queuedEvents.push(...drainEvents(state)); return state.phase; }
    if (state.phase !== 'climbing' && state.phase !== 'grounded') return state.phase;
    const inp = { L: escapeDir(state, 'L'), R: escapeDir(state, 'R'), holdR: false };
    step(state, zeroInput(), SIM_DT);                     // one centred step: the release latch re-arms
    const until = state.t + CFG.RELEASE_CONFIRM + CFG.GRACE + 0.1;
    while (state.t < until && state.phase !== 'fallen' && state.phase !== 'grounded') {
      step(state, inp, SIM_DT);
      queuedEvents.push(...drainEvents(state));
    }
    queuedEvents.push(...drainEvents(state));
    return state.phase;
  },
  // The autopilot's own planner and steering, so review/harness.js drives the sticks toward the
  // same holds this file does instead of keeping a second copy that can rot.
  plan(st = state) { return pickTarget(st); },
  steer(st, side, hold, full = false) { return steerTo(st, side, hold, full); },
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
  perf.steps = 0;
  if (query.has('auto')) debug.autopilot(true);
  state.web.unlocked = spiderUnlocked();       // the egg, if the code has been typed
  state.unlimitedStamina = UNLIMITED_STAMINA;
  hud.refreshCustomBtn();
}

function restart() {
  state = createClimber(generateRoute(route.seed));   // fresh holds: nothing lit, nothing remembered
  perf.minFps = Infinity; perf.steps = 0;    // the overlay's min and step count are per climb, like start()
  state.web.unlocked = spiderUnlocked();
  state.unlimitedStamina = UNLIMITED_STAMINA;
  startClimb(state);
  rig = createCameraRig(camera);
  rig.setPortrait(window.innerHeight >= window.innerWidth);
  auto.target = null;
  auto.restUntil = 0;                 // the new climb's clock starts at zero
  auto.sideways = 0;
  pendingPush.L = pendingPush.R = null;
  hud.hideEnd();
  hud.message('Light every rune · reach the altar', 3000);
}

// B40: the way back to the title, from the Menu button mid-climb or on the end screen. Same
// rebuild as restart() — a fresh climber on the same seed — but it stops short of startClimb, so
// the state is left in phase 'title' exactly as it was at boot and "Tap to begin" starts a clean
// climb. hud.showTitle puts its own shell back (end screen, dead veil, pending end timer).
function toTitle() {
  state = createClimber(generateRoute(route.seed));
  state.web.unlocked = spiderUnlocked();
  state.unlimitedStamina = UNLIMITED_STAMINA;
  rig = createCameraRig(camera);
  rig.setPortrait(window.innerHeight >= window.innerWidth);
  auto.target = null;
  auto.restUntil = 0;
  auto.sideways = 0;
  pendingPush.L = pendingPush.R = null;
  debug.pause = false;                  // the confirmation's freeze never outlives the climb
  // The theme belongs to the climb, and start() is the only thing that ever asked for it, so a
  // title reached this way would keep playing over a screen the boot title leaves silent.
  // setMusic(null) pauses the element (and stops the decoded fallback); start()'s setMusic(MUSIC_URL)
  // finds the same src already loaded and simply plays it again.
  audio.setMusic(null);
  hud.showTitle({ touch, seeds: SEEDS, seed });
}

hud.onStart(start);
hud.onRestart(restart);
hud.onMenu(toTitle);
// The mid-climb confirmation freezes the sim while it is up — the same freeze the evidence
// harness uses — so a one-hand hang cannot run out while the question is being read.
hud.onPause((on) => { debug.pause = !!on; });
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

// debug.push(side, x, y[, seconds]) parks a stick vector here and the loop feeds it to the sim in
// place of whatever input.read() said, for one frame or for a span of sim time. A frozen sim runs
// no steps, so a push waits for the pause to lift rather than being swallowed by it.
const pendingPush = { L: null, R: null };
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

  // Input: read once per frame (the HUD knobs follow), then the autopilot and the debug pushes on
  // top of it. The two sticks are the whole climb now (B51), so this is all there is to merge.
  const inp = input.read();
  const lookIn = inp.look;
  let L = inp.L, R = inp.R;
  if (auto.on && !debug.pause) {
    const ai = autoInput(state);
    L = ai.L; R = ai.R;
    hud.setStick('L', L.x, L.y);
    hud.setStick('R', R.x, R.y);
  }
  if (pendingPush.L) L = pendingPush.L;
  if (pendingPush.R) R = pendingPush.R;

  // Sim: fixed 120 Hz steps.
  let steps = 0;
  if (!debug.pause) {
    acc += dt * Math.max(0, debug.timeScale || 1);
    const maxSteps = Math.ceil(16 * Math.max(1, debug.timeScale || 1));
    while (acc >= SIM_DT && steps < maxSteps) {
      // Everything the sim reads, and nothing it does not. Diffed against CONTRACTS' Input
      // schema: `L`, `R` (with their `active` flag and, on `R`, the same `web` object), `holdR`,
      // and `web`. `look` is the camera rig's, not the sim's. `tapL`/`tapR`/`holdL` are gone with
      // the GRIP buttons (B51) — the sim reads none of them, and naming them here only made this
      // literal look like it still had a say in the grab.
      step(state, {
        L, R,
        // the WEB pad held (input.js: `holds.R || onPad`) — the aim charges on it, and without it
        // the shot can never be loosed. heldDebug.R is the evidence harness's thumb.
        holdR: inp.holdR || heldDebug.R,
        // the WEB pad's whole gesture (B50). A field this literal does not name never reaches the
        // sim -- which is exactly how the pad's aim went missing in B48.
        web: inp.web,
      }, SIM_DT);
      acc -= SIM_DT;
      steps++;
    }
    if (steps >= maxSteps) acc = 0;    // a very long hitch: drop the remainder instead of catching up
    // A push lives for one frame, or until its span of sim time runs out.
    if (steps > 0) {
      for (const side of ['L', 'R']) {
        const p = pendingPush[side];
        if (p && (p.until === null || p.until <= state.t)) pendingPush[side] = null;
      }
    }
  }
  perf.stepsPerFrame = steps;

  const events = queuedEvents.length ? queuedEvents.splice(0).concat(drainEvents(state)) : drainEvents(state);
  // The event log and the fall tally run whether or not the autopilot is driving: review/harness.js
  // reads both while its own touch and keyboard bots are climbing, and with the rope gone (B43)
  // there is no `state.fallCount` left to read instead. Capped, so it cannot grow without bound.
  if (events.length) {
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
