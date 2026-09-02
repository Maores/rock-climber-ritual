// review/harness.js — evidence-capture helpers for Rock Climber: The Ritual (integrator-owned).
//
// Loaded into the running game from a DevTools session:  await import('/review/harness.js')
// Everything here drives the game through its public surfaces only — real DOM events on the two
// sticks and on window (so input.js, hud.js and the sim are all exercised) — and reads state
// through window.__ritual. Nothing here ships with the game.
//
// B51 rewrote what "driving it" means. There are no GRIP buttons: #grip-l and #grip-r do not
// exist, hud.grips is gone, and the grip keys Q / Enter / Slash do nothing. So `gripEl()` and
// `tapGrip()` are DELETED rather than repaired — there is no button to press and no tap to send,
// and every helper that called one (touchBot, keyboardBot, rapidInput) would have thrown on a
// null element. The whole climb is two sticks now:
//
//   let go  = push that hand's OWN stick past CFG.RELEASE_DEADZONE and hold it there past
//             CFG.RELEASE_CONFIRM. The stick has to have been back inside the deadzone since the
//             last grab, so every move opens with one CENTRED frame.
//   grab    = leave the hand on a piece of rock for CFG.HOVER_GRAB_DWELL. Nothing is pressed.
//
// The push is also the reach, so one gesture moves a hand: centre, push at the target, keep
// steering, and the fingers close by themselves.

const R = () => window.__ritual;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const KEYS = {
  L: { up: ['KeyW', 'w'], down: ['KeyS', 's'], left: ['KeyA', 'a'], right: ['KeyD', 'd'] },
  R: { up: ['ArrowUp', 'ArrowUp'], down: ['ArrowDown', 'ArrowDown'], left: ['ArrowLeft', 'ArrowLeft'], right: ['ArrowRight', 'ArrowRight'] },
};
// Escape zeroes both virtual keyboard sticks. With the grip keys gone it is the only way the
// keyboard re-arms a release, and it is what a thumb lifting off a touch ring does for free.
const ESCAPE = ['Escape', 'Escape'];

// ---------------------------------------------------------------------------------------------
// Synthetic input

function pointer(el, type, x, y, id) {
  el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: id === 1,
    clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  }));
}
function keyEvent(type, [code, key]) {
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, code, key }));
}
function stickEl(side) { return document.getElementById('stick-' + side.toLowerCase()); }

// Hold a stick at unit-disc vector v (world convention: +y up) with one touch pointer per side.
// The radius is bindStick's own — half the ring's short side — so v = 1 is exactly the full
// deflection the sim will read, which matters now that full deflection is what lets go.
const touching = { L: false, R: false };
function touchStick(side, v) {
  const el = stickEl(side), b = el.getBoundingClientRect();
  const r = Math.max(1, Math.min(b.width, b.height) / 2);
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const id = side === 'L' ? 1 : 2;
  const x = cx + v.x * r, y = cy - v.y * r;
  if (!touching[side]) { pointer(el, 'pointerdown', x, y, id); touching[side] = true; }
  else pointer(el, 'pointermove', x, y, id);
}
// Put the thumb back at the middle of the ring without lifting it. This is the CENTRED frame that
// re-arms the sim's release latch (`_relArm`), and it is deliberately not a lift: it proves a
// player can re-arm by sliding back to centre.
function centreStick(side) { touchStick(side, { x: 0, y: 0 }); }
function releaseStick(side) {
  if (!touching[side]) return;
  const el = stickEl(side), b = el.getBoundingClientRect();
  pointer(el, 'pointerup', b.left + b.width / 2, b.top + b.height / 2, side === 'L' ? 1 : 2);
  touching[side] = false;
}

const heldKeys = new Set();
function setKey(pair, down) {
  const k = pair[0];
  if (down && !heldKeys.has(k)) { heldKeys.add(k); keyEvent('keydown', pair); }
  else if (!down && heldKeys.has(k)) { heldKeys.delete(k); keyEvent('keyup', pair); }
}
function releaseAllKeys() { for (const side of ['L', 'R']) for (const k of Object.values(KEYS[side])) setKey(k, false); }
function pressKey(pair) { keyEvent('keydown', pair); keyEvent('keyup', pair); }

// ---------------------------------------------------------------------------------------------
// Shared planning. Both bots ask main.js's own autopilot which hand goes where, through
// `debug.plan()` / `debug.steer()`, rather than keeping a second copy of the planner that can
// drift from the one the game ships. It is geometry, not hold ids: the highest hold within
// 0.9·REACH of where the free hand's shoulder ends up, so it works on a line and on a field.

function plan(st) { return R().debug.plan(st); }
function steer(st, side, hold, full = false) { return R().debug.steer(st, side, hold, full); }
const ACTIVE = (phase) => phase === 'climbing' || phase === 'grounded' || phase === 'swinging';

function snapshot() {
  const st = R().state;
  const h = (x) => ({ gripping: x.gripping, holdId: x.holdId, x: +x.x.toFixed(3), y: +x.y.toFixed(3), stamina: +x.stamina.toFixed(3), curl: +x.curl.toFixed(2), tremble: +x.tremble.toFixed(2), hover: +x.hover.toFixed(2), nearId: x.nearId });
  return {
    t: +st.t.toFixed(2), phase: st.phase, body: { x: +st.body.x.toFixed(3), y: +st.body.y.toFixed(3) },
    L: h(st.hands.L), R: h(st.hands.R),
    // There is no fallCount on the state any more (B43 took the rope, and with it the counter):
    // the autopilot's own tally of 'fall' events is the honest number, and maxHeight says how far
    // the climb actually got.
    falls: R().debug.auto.falls, maxHeight: +st.maxHeight.toFixed(2),
    web: st.web.mode, runesLit: st.runesLit.slice(), night: +st.night.toFixed(3),
    fps: +R().perf.fps.toFixed(1), errors: R().errors.length,
  };
}

// One move, driven with touch: centre the stick (re-arm), push it at the target at full
// deflection (that is the release AND the reach), then keep steering proportionally so the hand
// parks ON the rock rather than at arm's length past it, and let the dwell close the fingers.
async function touchMove(side, hold, timeoutMs) {
  const t0 = performance.now();
  const hand0 = R().state.hands[side];
  const from = hand0.gripping ? hand0.holdId : null;
  if (hand0.gripping) { centreStick(side); await frame(); }
  while (performance.now() - t0 < timeoutMs) {
    const st = R().state, hand = st.hands[side];
    if (hand.gripping && hand.holdId !== from) return { ok: true, holdId: hand.holdId, ms: Math.round(performance.now() - t0) };
    if (!ACTIVE(st.phase)) return { ok: false, why: st.phase, ms: Math.round(performance.now() - t0) };
    touchStick(side, steer(st, side, hold, hand.gripping));
    await frame();
  }
  return { ok: false, why: 'timeout', ms: Math.round(performance.now() - t0) };
}

// ---------------------------------------------------------------------------------------------
// Touch bot: climbs `count` holds with nothing but PointerEvents on #stick-l / #stick-r.

export async function touchBot(count = 8, timeout = 60000) {
  const log = [];
  const t0 = performance.now();
  let done = 0, timeouts = 0;
  while (done < count && performance.now() - t0 < timeout) {
    const st = R().state;
    if (!ACTIVE(st.phase)) { await frame(); continue; }
    const pick = plan(st);
    if (!pick) { log.push({ t: +st.t.toFixed(2), stuck: 'nothing in reach' }); break; }
    const hold = st.route.holds[pick.id];
    const out = await touchMove(pick.side, hold, 10000);
    if (out.ok) { log.push({ t: +R().state.t.toFixed(2), hand: pick.side, wanted: pick.id, grabbed: out.holdId, ms: out.ms }); done++; }
    else { log.push({ t: +R().state.t.toFixed(2), hand: pick.side, wanted: pick.id, failed: out.why, ms: out.ms }); timeouts++; if (timeouts > 3) break; }
    releaseStick(pick.side);           // thumb off between moves, like a player
    await frame();
  }
  releaseStick('L'); releaseStick('R');
  return { method: 'touch (PointerEvents on #stick-l / #stick-r only — there are no GRIP buttons)', holdsGrabbed: done, timeouts, log, end: snapshot() };
}

// ---------------------------------------------------------------------------------------------
// Keyboard bot: bang-bang steering with held keys. The keyboard's virtual stick INTEGRATES at
// KEY_RATE and holds its value, so holding a direction eventually buries the stick — which is
// what lets go — and Escape zeroes both sticks, which is how the keyboard re-arms the latch.

export async function keyboardBot(count = 8, timeout = 90000) {
  const log = [];
  const t0 = performance.now();
  let done = 0, timeouts = 0;
  while (done < count && performance.now() - t0 < timeout) {
    const st0 = R().state;
    if (!ACTIVE(st0.phase)) { await frame(); continue; }
    const pick = plan(st0);
    if (!pick) { log.push({ t: +st0.t.toFixed(2), stuck: 'nothing in reach' }); break; }
    const side = pick.side, K = KEYS[side], hold = st0.route.holds[pick.id];
    const from = st0.hands[side].gripping ? st0.hands[side].holdId : null;
    pressKey(ESCAPE);                       // both virtual sticks to centre: the latch re-arms
    await frame();
    const tStart = performance.now();
    let ok = false;
    while (performance.now() - tStart < 12000) {
      const st = R().state, hand = st.hands[side];
      if (hand.gripping && hand.holdId !== from) { ok = true; break; }
      if (!ACTIVE(st.phase)) break;
      // While gripping, drive straight at the hold and let the stick bury itself: that is the
      // release. Once free, steer to the hold's own offset and stop when it is under the hand.
      const dead = hand.gripping ? 0 : 0.035;
      const dx = hold.x - hand.x, dy = hold.y - hand.y;
      setKey(K.up, dy > dead); setKey(K.down, dy < -dead);
      setKey(K.right, dx > dead); setKey(K.left, dx < -dead);
      await frame();
    }
    for (const k of Object.values(K)) setKey(k, false);
    if (ok) { log.push({ t: +R().state.t.toFixed(2), hand: side, wanted: pick.id, grabbed: R().state.hands[side].holdId, ms: Math.round(performance.now() - tStart) }); done++; }
    else { log.push({ t: +R().state.t.toFixed(2), hand: side, wanted: pick.id, failed: 'timeout', ms: Math.round(performance.now() - tStart) }); timeouts++; if (timeouts > 3) break; }
    await frame();
  }
  releaseAllKeys();
  return { method: 'keyboard (KeyboardEvents on window: WASD / arrows, Escape to re-centre)', holdsGrabbed: done, timeouts, log, end: snapshot() };
}

// ---------------------------------------------------------------------------------------------
// Rapid input: hammer both sticks and the keyboard at frame rate for `seconds`, then report
// health. No grip taps: there is nothing to tap. Escape goes in at random instead, because a
// stick recentre is the one edge the release latch cares about.

export async function rapidInput(seconds = 10) {
  const t0 = performance.now();
  const fps0 = R().perf.frames, err0 = R().errors.length;
  let frames = 0, escapes = 0, keys = 0, moves = 0, worst = 0, last = t0;
  const phases = {};
  const rnd = () => Math.random() * 2 - 1;
  while (performance.now() - t0 < seconds * 1000) {
    const now = performance.now();
    worst = Math.max(worst, now - last); last = now;
    for (const side of ['L', 'R']) {
      touchStick(side, { x: rnd(), y: rnd() }); moves++;
      if (Math.random() < 0.15) releaseStick(side);
      const K = KEYS[side];
      if (Math.random() < 0.3) { const ks = [K.up, K.down, K.left, K.right]; setKey(ks[Math.floor(Math.random() * 4)], Math.random() < 0.5); keys++; }
    }
    if (Math.random() < 0.15) { pressKey(ESCAPE); escapes++; }
    const st = R().state;
    phases[st.phase] = (phases[st.phase] || 0) + 1;
    frames++;
    await frame();
  }
  releaseStick('L'); releaseStick('R'); releaseAllKeys();
  const st = R().state;
  const finite = [st.body.x, st.body.y, st.hands.L.x, st.hands.L.y, st.hands.R.x, st.hands.R.y, st.hands.L.stamina, st.hands.R.stamina].every(Number.isFinite);
  return {
    seconds, framesDriven: frames, framesRendered: R().perf.frames - fps0, stickMoves: moves, escapes, keyEvents: keys,
    worstFrameMs: +worst.toFixed(1), phasesSeen: phases, newErrors: R().errors.length - err0, stateFinite: finite, end: snapshot(),
  };
}

// ---------------------------------------------------------------------------------------------
// Web-zip: charge and fire a shot through the debug thumb (heldDebug.R -> Input.holdR), which is
// the one path debug.hold() exists for.

export async function webShot(aimX = 0.4, aimY = 0.9, holdMs = 700) {
  if (!R().state.web.unlocked) return { skipped: 'the spider hand is locked (type the egg first)' };
  const seen = [];
  const t0 = performance.now();
  // The aim rides the right stick when no pad is supplying one, and `aimPoint` normalises it — so
  // it is scaled UNDER CFG.RELEASE_DEADZONE here. At full deflection the same vector would let go
  // of the right hand, and aiming is never supposed to cost you a hand (B50).
  const m = Math.hypot(aimX, aimY) || 1, k = (R().sim.CFG.RELEASE_DEADZONE - 0.05) / m;
  R().debug.push('R', aimX * k, aimY * k, holdMs / 1000);
  R().debug.hold('R', true);
  while (performance.now() - t0 < holdMs) { seen.push(R().state.web.mode); await frame(); }
  R().debug.hold('R', false);                          // letting go looses the shot
  const t1 = performance.now();
  while (performance.now() - t1 < 3000 && R().state.web.mode !== 'idle') { seen.push(R().state.web.mode); await frame(); }
  return { modes: [...new Set(seen)], end: snapshot() };
}

// ---------------------------------------------------------------------------------------------
// Audio: RMS + wind trace at ~30 Hz with the sim events that happened in the window.

export async function rmsTrace(seconds = 6) {
  const a = R().audio, auto = R().debug.auto;
  const t0 = performance.now(), n0 = auto.log.length;
  const samples = [];
  while (performance.now() - t0 < seconds * 1000) {
    const d = a.debug();
    samples.push({ ms: Math.round(performance.now() - t0), rms: d.rms, wind: d.wind ? d.wind.level : null, heartbeats: d.heartbeats, phase: R().state.phase });
    await sleep(33);
  }
  return { seconds, samples, events: auto.log.slice(n0), audio: a.debug() };
}

// ---------------------------------------------------------------------------------------------
// Soak: autopilot in real time for `minutes`, sampled in the background (poll window.__harness.soak).

// Every `fallEvery` seconds both hands let go (debug.fall) — and with the rope gone (B43) that is
// the whole cliff, so the run restarts from the death screen. A summit restarts it too, so the run
// always lasts the full `minutes`.
export function startSoak(minutes = 5, { fallEvery = 40 } = {}) {
  const S = {
    running: true, startedAt: Date.now(), minutes, fallEvery, samples: [], summits: 0, deaths: 0, fallsInduced: 0,
    grabs0: R().debug.auto.grabs, errors0: R().errors.length, timeouts0: R().debug.auto.timeouts, log0: R().debug.auto.log.length,
    lastGrabT: performance.now(), lastGrabs: R().debug.auto.grabs, maxGapMs: 0, lastFallAt: Date.now(), summary: null,
  };
  R().debug.pause = false;
  R().debug.timeScale = 1;
  R().debug.autopilot(true);
  const iv = setInterval(() => {
    const st = R().state, auto = R().debug.auto, perf = R().perf;
    if (auto.grabs !== S.lastGrabs) { S.lastGrabs = auto.grabs; S.lastGrabT = performance.now(); }
    else if (ACTIVE(st.phase)) S.maxGapMs = Math.max(S.maxGapMs, performance.now() - S.lastGrabT);
    S.samples.push({ s: Math.round((Date.now() - S.startedAt) / 1000), fps: +perf.fps.toFixed(1), pr: perf.pixelRatio, phase: st.phase, y: +st.body.y.toFixed(1), grabs: auto.grabs, falls: auto.falls, timeouts: auto.timeouts, runes: st.runesLit.length, errors: R().errors.length });
    if (st.phase === 'summit' || st.phase === 'fallen') {
      if (st.phase === 'summit') S.summits++; else S.deaths++;
      R().debug.restart();
      R().debug.autopilot(true);
      S.lastGrabT = performance.now();
      S.lastFallAt = Date.now();
    } else if (fallEvery && Date.now() - S.lastFallAt > fallEvery * 1000 && st.phase === 'climbing' && st.body.y > 3 && st.hands.L.gripping && st.hands.R.gripping) {
      R().debug.fall();
      S.fallsInduced++;
      S.lastFallAt = Date.now();
    }
    if (Date.now() - S.startedAt >= minutes * 60000) {
      clearInterval(iv);
      S.running = false;
      const fps = S.samples.map((x) => x.fps).filter((x) => x > 0);
      const events = auto.log.slice(S.log0);
      const count = (type) => events.filter((e) => e.type === type).length;
      S.summary = {
        wallSeconds: Math.round((Date.now() - S.startedAt) / 1000), finalPhase: st.phase, finalHeight: +st.body.y.toFixed(2), summits: S.summits, deaths: S.deaths,
        grabs: auto.grabs - S.grabs0, fallsInduced: S.fallsInduced, fallEvents: count('fall'), missEvents: count('miss'), slipEvents: count('slip'), runeEvents: count('rune'), summitEvents: count('summit'),
        autopilotTimeouts: auto.timeouts - S.timeouts0, longestGapBetweenGrabsMs: Math.round(S.maxGapMs),
        fpsMean: +(fps.reduce((a, b) => a + b, 0) / Math.max(1, fps.length)).toFixed(1), fpsMin: Math.min(...fps), fpsMax: Math.max(...fps),
        pixelRatioEnd: perf.pixelRatio, minFpsWindow: +R().perf.minFps.toFixed(1), newErrors: R().errors.length - S.errors0,
      };
    }
  }, 2000);
  S.timer = iv;
  window.__harness.soak = S;
  return S;
}
export function stopSoak() {
  const S = window.__harness.soak;
  if (S && S.timer) { clearInterval(S.timer); S.running = false; }
  return S;
}

export { snapshot, touchStick, centreStick, releaseStick, touchMove, pressKey, setKey, releaseAllKeys, steer, plan };

window.__harness = { touchBot, keyboardBot, rapidInput, webShot, rmsTrace, startSoak, stopSoak, snapshot, touchStick, centreStick, releaseStick, touchMove, pressKey, setKey, releaseAllKeys, steer, plan, soak: null };
export default window.__harness;
