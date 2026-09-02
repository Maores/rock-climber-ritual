// review/harness.js — evidence-capture helpers for Rock Climber: The Ritual (integrator-owned).
//
// Loaded into the running game from a DevTools session:  await import('/review/harness.js')
// Everything here drives the game through its public surfaces only — real DOM events on the sticks,
// the GRIP buttons and window (so input.js, hud.js and the sim are all exercised) — and reads state
// through window.__ritual. Nothing here ships with the game.

const R = () => window.__ritual;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const OTHER = { L: 'R', R: 'L' };
const KEYS = {
  L: { up: ['KeyW', 'w'], down: ['KeyS', 's'], left: ['KeyA', 'a'], right: ['KeyD', 'd'], grip: ['KeyQ', 'q'] },
  R: { up: ['ArrowUp', 'ArrowUp'], down: ['ArrowDown', 'ArrowDown'], left: ['ArrowLeft', 'ArrowLeft'], right: ['ArrowRight', 'ArrowRight'], grip: ['Enter', 'Enter'] },
};

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
function gripEl(side) { return document.getElementById('grip-' + side.toLowerCase()); }

// Hold a stick at unit-disc vector v (world convention: +y up) with one touch pointer per side.
const touching = { L: false, R: false };
function touchStick(side, v) {
  const el = stickEl(side), b = el.getBoundingClientRect();
  const r = Math.min(b.width, b.height) / 2, cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const id = side === 'L' ? 1 : 2;
  const x = cx + v.x * r, y = cy - v.y * r;
  if (!touching[side]) { pointer(el, 'pointerdown', x, y, id); touching[side] = true; }
  else pointer(el, 'pointermove', x, y, id);
}
function releaseStick(side) {
  if (!touching[side]) return;
  const el = stickEl(side), b = el.getBoundingClientRect();
  pointer(el, 'pointerup', b.left + b.width / 2, b.top + b.height / 2, side === 'L' ? 1 : 2);
  touching[side] = false;
}
function tapGrip(side) {
  const el = gripEl(side), b = el.getBoundingClientRect();
  const id = side === 'L' ? 3 : 4;
  pointer(el, 'pointerdown', b.left + b.width / 2, b.top + b.height / 2, id);
  pointer(el, 'pointerup', b.left + b.width / 2, b.top + b.height / 2, id);
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
// Shared planning (same idea as the sim's own autopilot test: alternate hands, reach the next hold)

function steer(st, side, hold) {
  const sh = R().sim.shoulder(st, side), REACH = R().sim.CFG.REACH;
  const v = { x: (hold.x - sh.x) / REACH, y: (hold.y - sh.y) / REACH };
  const m = Math.hypot(v.x, v.y);
  if (m > 1) { v.x /= m; v.y /= m; }
  return v;
}
function nextTarget(st) {
  const { L, R: Rh } = st.hands;
  if (!L.gripping && !Rh.gripping) {
    // on the rope (or the ground): the highest hold the hand meant for it can reach
    let best = null;
    for (const h of st.route.holds) {
      const sh = R().sim.shoulder(st, handFor(h.id));
      if (Math.hypot(h.x - sh.x, h.y - sh.y) <= 0.9 * R().sim.CFG.REACH && (!best || h.y > best.y)) best = h;
    }
    return best ? best.id : null;
  }
  const top = Math.max(L.gripping ? L.holdId : -1, Rh.gripping ? Rh.holdId : -1);
  return top + 1 < st.route.holds.length ? top + 1 : null;
}
const ACTIVE = (phase) => phase === 'climbing' || phase === 'caught';
const handFor = (id) => (id % 2 === 0 ? 'L' : 'R');

function snapshot() {
  const st = R().state;
  const h = (x) => ({ gripping: x.gripping, holdId: x.holdId, armed: x.armed, x: +x.x.toFixed(3), y: +x.y.toFixed(3), stamina: +x.stamina.toFixed(3), curl: +x.curl.toFixed(2), tremble: +x.tremble.toFixed(2), hover: +x.hover.toFixed(2) });
  return { t: +st.t.toFixed(2), phase: st.phase, body: { x: +st.body.x.toFixed(3), y: +st.body.y.toFixed(3) }, L: h(st.hands.L), R: h(st.hands.R), falls: st.fallCount, runesLit: st.runesLit.slice(), night: +st.night.toFixed(3), fps: +R().perf.fps.toFixed(1), errors: R().errors.length };
}

// ---------------------------------------------------------------------------------------------
// Touch bot: climbs `count` holds with touch events on the sticks and GRIP buttons.

export async function touchBot(count = 8, timeout = 40000) {
  const log = [];
  const t0 = performance.now();
  let done = 0, target = null, from = null, tStart = 0;
  while (done < count && performance.now() - t0 < timeout) {
    const st = R().state;
    if (!ACTIVE(st.phase)) { await frame(); continue; }
    if (target === null) {
      target = nextTarget(st);
      if (target === null) break;
      from = st.hands[handFor(target)].holdId;
      tStart = performance.now();
    }
    const side = handFor(target), hand = st.hands[side], other = st.hands[OTHER[side]];
    if (hand.gripping && hand.holdId !== from) {
      log.push({ t: +st.t.toFixed(2), grabbed: hand.holdId, wanted: target, hand: side, ms: Math.round(performance.now() - tStart) });
      releaseStick(side);
      done++; target = null;
      continue;
    }
    if (performance.now() - tStart > 10000) { log.push({ t: +st.t.toFixed(2), timeout: target }); releaseStick(side); target = null; continue; }
    if (hand.gripping) { if (other.gripping) tapGrip(side); }
    else {
      touchStick(side, steer(st, side, st.route.holds[target]));
      if (!hand.armed) tapGrip(side);
    }
    await frame();
  }
  releaseStick('L'); releaseStick('R');
  return { method: 'touch (PointerEvents on #stick-l/#stick-r and #grip-l/#grip-r)', holdsGrabbed: done, log, end: snapshot() };
}

// ---------------------------------------------------------------------------------------------
// Keyboard bot: bang-bang steering with held keys (the virtual stick integrates and holds), grip key.

export async function keyboardBot(count = 8, timeout = 60000) {
  const log = [];
  const t0 = performance.now();
  let done = 0, target = null, from = null, tStart = 0, lastArm = -1e9;
  while (done < count && performance.now() - t0 < timeout) {
    const st = R().state;
    if (!ACTIVE(st.phase)) { await frame(); continue; }
    if (target === null) {
      target = nextTarget(st);
      if (target === null) break;
      from = st.hands[handFor(target)].holdId;
      tStart = performance.now();
    }
    const side = handFor(target), hand = st.hands[side], other = st.hands[OTHER[side]], K = KEYS[side];
    if (hand.gripping && hand.holdId !== from) {
      log.push({ t: +st.t.toFixed(2), grabbed: hand.holdId, wanted: target, hand: side, ms: Math.round(performance.now() - tStart) });
      for (const k of Object.values(K)) setKey(k, false);
      done++; target = null;
      continue;
    }
    if (performance.now() - tStart > 15000) { log.push({ t: +st.t.toFixed(2), timeout: target }); for (const k of Object.values(K)) setKey(k, false); target = null; continue; }
    if (hand.gripping) {
      if (other.gripping && performance.now() - lastArm > 400) { pressKey(K.grip); lastArm = performance.now(); }
    } else {
      const hold = st.route.holds[target];
      const dx = hold.x - hand.x, dy = hold.y - hand.y, dead = 0.035;
      setKey(K.up, dy > dead); setKey(K.down, dy < -dead);
      setKey(K.right, dx > dead); setKey(K.left, dx < -dead);
      if (!hand.armed && performance.now() - lastArm > 400) { pressKey(K.grip); lastArm = performance.now(); }
    }
    await frame();
  }
  releaseAllKeys();
  return { method: 'keyboard (KeyboardEvents on window: WASD+Q / arrows+Enter)', holdsGrabbed: done, log, end: snapshot() };
}

// ---------------------------------------------------------------------------------------------
// Rapid input: hammer sticks, grips and keys at frame rate for `seconds`, then report health.

export async function rapidInput(seconds = 10) {
  const t0 = performance.now();
  const fps0 = R().perf.frames, err0 = R().errors.length;
  let frames = 0, taps = 0, keys = 0, moves = 0, worst = 0, last = t0;
  const phases = {};
  const rnd = () => Math.random() * 2 - 1;
  while (performance.now() - t0 < seconds * 1000) {
    const now = performance.now();
    worst = Math.max(worst, now - last); last = now;
    for (const side of ['L', 'R']) {
      touchStick(side, { x: rnd(), y: rnd() }); moves++;
      if (Math.random() < 0.25) { tapGrip(side); taps++; }
      if (Math.random() < 0.15) { releaseStick(side); }
      const K = KEYS[side];
      if (Math.random() < 0.3) { const ks = [K.up, K.down, K.left, K.right]; setKey(ks[Math.floor(Math.random() * 4)], Math.random() < 0.5); keys++; }
      if (Math.random() < 0.15) { pressKey(K.grip); keys++; }
    }
    const st = R().state;
    phases[st.phase] = (phases[st.phase] || 0) + 1;
    frames++;
    await frame();
  }
  releaseStick('L'); releaseStick('R'); releaseAllKeys();
  const st = R().state;
  const finite = [st.body.x, st.body.y, st.hands.L.x, st.hands.L.y, st.hands.R.x, st.hands.R.y, st.hands.L.stamina, st.hands.R.stamina].every(Number.isFinite);
  return {
    seconds, framesDriven: frames, framesRendered: R().perf.frames - fps0, stickMoves: moves, gripTaps: taps, keyEvents: keys,
    worstFrameMs: +worst.toFixed(1), phasesSeen: phases, newErrors: R().errors.length - err0, stateFinite: finite, end: snapshot(),
  };
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

// Every `fallEvery` seconds both hands let go (fall → rope catch → the autopilot climbs back on); a
// summit restarts the climb so the run always lasts the full `minutes`.
export function startSoak(minutes = 5, { fallEvery = 40 } = {}) {
  const S = {
    running: true, startedAt: Date.now(), minutes, fallEvery, samples: [], summits: 0, fallsInduced: 0,
    grabs0: R().debug.auto.grabs, errors0: R().errors.length, timeouts0: R().debug.auto.timeouts, log0: R().debug.auto.log.length,
    lastGrabT: performance.now(), lastGrabs: R().debug.auto.grabs, maxGapMs: 0, lastFallAt: Date.now(), summary: null,
  };
  R().debug.pause = false;
  R().debug.timeScale = 1;
  R().debug.autopilot(true);
  const iv = setInterval(() => {
    const st = R().state, auto = R().debug.auto, perf = R().perf;
    if (auto.grabs !== S.lastGrabs) { S.lastGrabs = auto.grabs; S.lastGrabT = performance.now(); }
    else if (st.phase === 'climbing' || st.phase === 'caught') S.maxGapMs = Math.max(S.maxGapMs, performance.now() - S.lastGrabT);
    S.samples.push({ s: Math.round((Date.now() - S.startedAt) / 1000), fps: +perf.fps.toFixed(1), pr: perf.pixelRatio, phase: st.phase, y: +st.body.y.toFixed(1), grabs: auto.grabs, falls: st.fallCount, timeouts: auto.timeouts, runes: st.runesLit.length, errors: R().errors.length });
    if (st.phase === 'summit') {
      S.summits++;
      R().debug.restart();
      R().debug.autopilot(true);
      S.lastGrabT = performance.now();
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
        wallSeconds: Math.round((Date.now() - S.startedAt) / 1000), finalPhase: st.phase, finalHeight: +st.body.y.toFixed(2), summits: S.summits,
        grabs: auto.grabs - S.grabs0, fallsInduced: S.fallsInduced, fallEvents: count('fall'), catchEvents: count('catch'), slipEvents: count('slip'), runeEvents: count('rune'), summitEvents: count('summit'),
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

export { snapshot, touchStick, releaseStick, tapGrip, pressKey, setKey, releaseAllKeys, steer };

window.__harness = { touchBot, keyboardBot, rapidInput, rmsTrace, startSoak, stopSoak, snapshot, touchStick, releaseStick, tapGrip, pressKey, setKey, releaseAllKeys, steer, soak: null };
export default window.__harness;
