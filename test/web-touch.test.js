// test/web-touch.test.js — the web-zip as a thumb actually performs it on a phone (B50).
//
// Everything here drives the REAL input.js with pointer events on the REAL pad element and feeds
// what it returns to the REAL sim. Nothing hand-builds an Input object: the bugs this file exists
// to catch all lived in the seam between the two, where the sim's unit tests could not see them.
// The owner's report was "the web mechanics do nothing", and every step below was a step that did
// nothing, or worse, on a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, createClimber, startClimb, step, drainEvents, shoulder } from '../src/sim.js';
import { generateRoute } from '../src/route.js';
import { createInput } from '../src/input.js';

// --- the smallest DOM the input layer needs -------------------------------------------------
class FakeEl {
  constructor(rect) {
    this.rect = rect; this.listeners = new Map(); this.captured = null;
    this.style = { setProperty() {} };
    this.classList = { on: new Set(), add(c) { this.on.add(c); }, remove(c) { this.on.delete(c); }, toggle(c, v) { v ? this.on.add(c) : this.on.delete(c); } };
  }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture(id) { if (this.captured === id) this.captured = null; }
  fire(type, ev = {}) {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...ev };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e);
    return e;
  }
}
const ring = (left, top, size = 120) => new FakeEl({ left, top, width: size, height: size });

// An iPhone 15 in portrait is 393 x 852 CSS px; the control cluster sits along the bottom.
const PAD = { left: 273, top: 536, size: 62 };
const PAD_C = { x: PAD.left + PAD.size / 2, y: PAD.top + PAD.size / 2 };
const STICK_L = { left: 24, top: 660, size: 130 };

function phone() {
  const hud = {
    sticks: { L: ring(STICK_L.left, STICK_L.top, STICK_L.size), R: ring(239, 660, 130) },
    grips: { L: ring(44, 596, 90), R: ring(259, 596, 90) },
    webButton: ring(PAD.left, PAD.top, PAD.size),
    setStick() {},
  };
  let t = 0;
  const input = createInput({ hud, keyboard: false, win: new FakeEl({}), now: () => t });
  return { hud, input, tick: (ms) => { t += ms; } };
}

// A climber hanging by both hands near `at`, glove on. Shooting from the foot of the route is
// not a swing — a 6.5 m line from down there just parks you on the ground — so start up the wall.
function climber(at = 14) {
  const s = createClimber(generateRoute(7));
  startClimb(s);
  s.web.unlocked = true;
  const H = s.route.holds;
  let i = 0;
  for (let k = 0; k < H.length - 1; k++) if (Math.abs(H[k].y - at) < Math.abs(H[i].y - at)) i = k;
  const a = H[i], b = H[i + 1];
  const L = a.id % 2 === 0 ? a : b, R = a.id % 2 === 0 ? b : a;
  for (const [side, h] of [['L', L], ['R', R]]) {
    Object.assign(s.hands[side], { x: h.x, y: h.y, tx: h.x, ty: h.y, vx: 0, vy: 0, gripping: true, holdId: h.id, armed: false, stamina: 1, gripDX: 0, gripDY: 0 });
  }
  Object.assign(s.body, { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 - CFG.HANG_TWO, vx: 0, vy: 0 });
  s.height = s.body.y;
  drainEvents(s);
  return s;
}

// One rendered frame, exactly as main.js runs it — including the parts that bite. main.js does
// NOT pass what input.js returns: it builds a fresh object naming the fields it forwards, so a
// field it does not name never reaches the sim (that is how B48 happened). It now names `web`,
// and it also hands that ONE object to every fixed 120 Hz sub-step of the frame, clearing only
// the grip taps in between — so any other edge on it has to be consumed by the sim itself.
const SIM_DT = 1 / 120;
function frame(rg, s, ms = 1000 / 60) {
  rg.tick(ms);
  const inp = rg.input.read();
  let tapL = inp.tapL, tapR = inp.tapR;
  let acc = ms / 1000;
  while (acc >= SIM_DT) {
    step(s, { L: inp.L, R: inp.R, tapL, tapR, holdL: inp.holdL, holdR: inp.holdR, web: inp.web }, SIM_DT);
    acc -= SIM_DT;
    tapL = tapR = false;
  }
  return { inp, evs: drainEvents(s) };
}
function frames(rg, s, n, ms = 1000 / 60) {
  const evs = [];
  let inp = null;
  for (let i = 0; i < n; i++) { const r = frame(rg, s, ms); inp = r.inp; evs.push(...r.evs); }
  return { inp, evs };
}
const types = (evs) => evs.map((e) => e.type);

// The three things a thumb can do to the pad.
const padDown = (rg, id = 9) => rg.hud.webButton.fire('pointerdown', { pointerId: id, clientX: PAD_C.x, clientY: PAD_C.y });
const padDrag = (rg, dx, dy, id = 9) => rg.hud.webButton.fire('pointermove', { pointerId: id, clientX: PAD_C.x + dx, clientY: PAD_C.y + dy });
const padUp = (rg, id = 9) => rg.hud.webButton.fire('pointerup', { pointerId: id });
// ...and a thumb on the left stick, in stick units (+y up).
function stickL(rg, x, y, id = 21, type = 'pointerdown') {
  const r = STICK_L.size / 2;
  rg.hud.sticks.L.fire(type, { pointerId: id, clientX: STICK_L.left + r + x * r, clientY: STICK_L.top + r - y * r });
}

test('touch: hold the pad, drag, lift — and you swing, with no further touch (B50)', () => {
  const rg = phone(), s = climber();
  frame(rg, s);
  assert.ok(s.hands.L.gripping && s.hands.R.gripping, 'both hands start on the rock');

  // 1. thumb down. Nothing commits yet: this could still turn out to be a tap.
  padDown(rg);
  let r = frame(rg, s);
  assert.equal(s.web.mode, 'idle', 'a press that might still be a tap does not aim');
  assert.equal(types(r.evs).length, 0);

  // 2. drag to aim. The drag commits the press, and the reticle follows the thumb.
  const aim0 = { x: s.web.aimX, y: s.web.aimY };
  padDrag(rg, 40, -66);                         // up and to the right
  r = frames(rg, s, 12);
  assert.equal(s.web.mode, 'aiming', 'the drag commits the press to an aim');
  assert.ok(types(r.evs).includes('aim'), 'and says so, so the reticle has something to show');
  assert.notDeepEqual({ x: s.web.aimX, y: s.web.aimY }, aim0, 'the drag steers the aim');
  assert.ok(s.web.aimX > 0.2 && s.web.aimY > 0.2, `aimed up and right, got (${s.web.aimX.toFixed(2)}, ${s.web.aimY.toFixed(2)})`);

  // 3. lift to fire. The shot leaves on the release edge.
  padUp(rg);
  r = frame(rg, s);
  assert.equal(s.web.mode, 'flying', 'letting go looses the shot');
  assert.ok(types(r.evs).includes('webshot'));

  // 4. THE POINT OF THIS FILE. The thumb is off the pad — it had to be, lifting is what fired —
  //    and the line must still bite and hold. Before B50 the sim cut an attached line whenever
  //    holdR was false, so it severed one step after it attached and dropped the player down the
  //    whole cliff. Not one pointer event is sent here.
  r = frames(rg, s, 30);
  assert.ok(types(r.evs).includes('webhit'), 'the line bit');
  assert.equal(s.web.mode, 'attached', 'and stayed bitten with nothing held');
  assert.equal(s.phase, 'swinging', 'you are swinging, not falling');
  assert.ok(!types(r.evs).includes('webcut'), 'nothing cut the line behind your back');
  assert.ok(!types(r.evs).includes('fall'), 'and nothing started a fall');

  // 5. the left stick pumps the swing.
  const vx0 = s.body.vx;
  stickL(rg, 0.95, 0);                          // thumb hard right
  frames(rg, s, 24);
  assert.ok(s.body.vx > vx0 + 0.5, `the pump drove the swing: vx ${vx0.toFixed(2)} -> ${s.body.vx.toFixed(2)}`);
  assert.equal(s.phase, 'swinging', 'and pumping did not end it');
  stickL(rg, 0.95, 0, 21, 'pointerup');

  // 6. a TAP on the pad lets go, and the velocity you had is the velocity you leave with.
  const v = { x: s.body.vx, y: s.body.vy };
  padDown(rg, 31); rg.tick(90); padUp(rg, 31);   // down and up inside the tap window
  r = frames(rg, s, 2);
  assert.ok(types(r.evs).includes('webcut'), 'the tap let go of the line');
  assert.equal(s.web.mode, 'idle');
  assert.equal(s.phase, 'falling', 'and threw you off it');
  assert.ok(Math.abs(s.body.vx) > Math.abs(v.x) * 0.9, `the throw kept your speed: ${v.x.toFixed(2)} -> ${s.body.vx.toFixed(2)}`);
  assert.ok(s.web.cd > 0, 'and started the cooldown');
  rg.input.dispose();
});

test('touch: a thumb resting on the pad while attached does not cut the line (B50)', () => {
  const rg = phone(), s = climber();
  frame(rg, s);
  padDown(rg); padDrag(rg, 40, -66); frames(rg, s, 12); padUp(rg);
  frames(rg, s, 30);
  assert.equal(s.phase, 'swinging');
  // Press and HOLD: that is the aim gesture, not the release gesture. A thumb parked on the pad
  // through a swing must not sever the line, which is why the cut is a tap and not a press.
  padDown(rg, 41);
  rg.tick(900);
  const r = frames(rg, s, 30);
  padUp(rg, 41);
  const r2 = frames(rg, s, 3);
  assert.ok(!types([...r.evs, ...r2.evs]).includes('webcut'), 'a long press is not a release');
  assert.equal(s.phase, 'swinging');
  rg.input.dispose();
});

test('touch: aiming never takes your right hand off the rock (B50)', () => {
  const rg = phone(), s = climber();
  frame(rg, s);
  const held = s.hands.R.holdId;
  const at = { x: s.hands.R.x, y: s.hands.R.y };

  // Hold and drag the pad hard, in the direction that would fling a free hand furthest.
  padDown(rg);
  padDrag(rg, 84, 84);                          // down and to the right, away from the hold
  const r = frames(rg, s, 60);                  // a full second of aiming
  assert.equal(s.web.mode, 'aiming');
  assert.equal(s.hands.R.gripping, true, 'the right hand is still on the rock');
  assert.equal(s.hands.R.holdId, held, 'and on the same hold');
  assert.ok(Math.hypot(s.hands.R.x - at.x, s.hands.R.y - at.y) < 1e-9, 'it did not move a millimetre');
  assert.ok(!types(r.evs).includes('release'), 'and nothing released it');
  // The aim is its own field, so the right stick is still free to steer that hand.
  assert.equal(r.inp.R.x, 0); assert.equal(r.inp.R.y, 0);
  assert.equal(r.inp.R.active, false, 'the pad left the right stick alone');

  // You only let go when the line actually bites — which is the moment you want to.
  padUp(rg);
  frames(rg, s, 40);
  assert.equal(s.phase, 'swinging');
  assert.equal(s.hands.R.gripping, false, 'the bite is what takes the hands off');
  rg.input.dispose();
});

test('touch: a brush of the pad does nothing at all (B50)', () => {
  // With the aim threshold gone, a one-frame brush fired an unaimed shot straight up. It always
  // bit, and a bite takes BOTH hands off the wall -- with no rope (B43) that is a death from a
  // stray touch while reaching for the stick. A press only becomes a shot once it commits.
  const rg = phone(), s = climber();
  frame(rg, s);
  padDown(rg);
  rg.tick(40);                                   // a brush: down and up well inside the tap window
  padUp(rg);
  const r = frames(rg, s, 30);
  assert.equal(types(r.evs).length, 0, `a brush must produce no events, got [${types(r.evs)}]`);
  assert.equal(s.web.mode, 'idle');
  assert.equal(s.phase, 'climbing', 'and must certainly not take you off the wall');
  assert.ok(s.hands.L.gripping && s.hands.R.gripping, 'both hands still on the rock');
  assert.equal(s.web.cd, 0, 'and it costs no cooldown either');
  rg.input.dispose();
});

test('touch: a press held past the tap window fires, undragged, straight up (B50)', () => {
  const rg = phone(), s = climber();
  frame(rg, s);
  padDown(rg);
  const r = frames(rg, s, 20);                   // ~333 ms, past the 250 ms tap window, no drag
  assert.equal(s.web.mode, 'aiming', 'holding still is a deliberate aim');
  assert.ok(types(r.evs).includes('aim'));
  assert.ok(Math.abs(s.web.aimX) < 1e-9 && s.web.aimY > 0.9, `an undragged aim is straight up, got (${s.web.aimX}, ${s.web.aimY})`);
  padUp(rg);
  const r2 = frame(rg, s);
  assert.equal(s.web.mode, 'flying', 'and letting go fires it');
  assert.ok(types(r2.evs).includes('webshot'));
  rg.input.dispose();
});

test('touch: a quick drag-and-lift fires along the drag (B50)', () => {
  // The drag is what commits it, so this is a shot even though it is over inside the tap window.
  const rg = phone(), s = climber();
  frame(rg, s);
  padDown(rg);
  padDrag(rg, -70, -40);                         // up and to the LEFT
  rg.tick(60);
  const r = frames(rg, s, 1);
  assert.equal(s.web.mode, 'aiming');
  assert.ok(s.web.aimX < -0.2, `aimed left, got ${s.web.aimX.toFixed(2)}`);
  padUp(rg);
  const r2 = frame(rg, s);
  assert.equal(s.web.mode, 'flying', 'a dragged press is a shot however brief');
  assert.ok(types([...r.evs, ...r2.evs]).includes('webshot'));
  const sh = shoulder(s, 'R');
  assert.ok(s.web.ax < sh.x, `the anchor is to the left of the shoulder: ${s.web.ax.toFixed(2)} vs ${sh.x.toFixed(2)}`);
  rg.input.dispose();
});


test('touch: the right stick still steers the right hand while the other thumb aims (B50)', () => {
  const rg = phone(), s = climber();
  frame(rg, s);
  // free the right hand so the stick has something to steer
  rg.hud.grips.R.fire('pointerdown', { pointerId: 3 });
  frames(rg, s, 20);
  assert.equal(s.hands.R.gripping, false);
  const x0 = s.hands.R.x;

  padDown(rg); padDrag(rg, 0, -70);              // aim straight up with one thumb...
  const st = rg.hud.sticks.R;                    // ...and steer the hand right with the other
  st.fire('pointerdown', { pointerId: 22, clientX: 239 + 65 + 62, clientY: 660 + 65 });
  const r = frames(rg, s, 24);
  assert.equal(r.inp.R.active, true, 'the right stick is live while the pad is held');
  assert.ok(s.hands.R.x > x0 + 0.1, `the hand went where the stick pushed: ${x0.toFixed(2)} -> ${s.hands.R.x.toFixed(2)}`);
  assert.ok(s.web.aimY > 0.5 && Math.abs(s.web.aimX) < 0.2, `and the aim stayed where the pad put it: (${s.web.aimX.toFixed(2)}, ${s.web.aimY.toFixed(2)})`);
  rg.input.dispose();
});

test('touch: a pumped swing stays on the cliff face', () => {
  // A 6.5 m line pumped sideways carried the body to x = 7.40 — 2.9 m past a cliff that is 9 m
  // wide — out over open air with rock nowhere in reach.
  const rg = phone(), s = climber(20);
  frame(rg, s);
  padDown(rg); padDrag(rg, 70, -30); frames(rg, s, 12); padUp(rg);
  frames(rg, s, 40);
  assert.equal(s.phase, 'swinging');
  stickL(rg, 0.95, 0);                           // pump hard, one way, for five seconds
  let worst = 0;
  for (let i = 0; i < 300; i++) { frame(rg, s); worst = Math.max(worst, Math.abs(s.body.x)); }
  assert.ok(worst <= CFG.SWING_MAX_X + 1e-9, `swung to |x| = ${worst.toFixed(2)}, past the clamp at ${CFG.SWING_MAX_X}`);
  assert.ok(Math.abs(s.web.ax) <= CFG.SWING_MAX_X + 1e-9, 'and the anchor is on the rock too');
  rg.input.dispose();
});

test('desktop: the right button holds to aim, releases to fire, and clicks to let go (B50)', () => {
  // The same rule on a mouse, so the two devices do not diverge. Driven through input.js's own
  // mouse binding: hand-built Inputs cannot see a click that is measured from real button timing.
  const s = climber();
  const view = ring(0, 0, 1440);
  view.rect = { left: 0, top: 0, width: 1440, height: 900 };
  let t = 0;
  const input = createInput({ hud: null, keyboard: false, win: new FakeEl({}), now: () => t, mouse: view, getHands: () => s.hands });
  const rg = { hud: { webButton: new FakeEl({ left: 0, top: 0, width: 1, height: 1 }) }, input, tick: (ms) => { t += ms; } };
  const rmb = (type, extra = {}) => view.fire(type, { pointerType: 'mouse', button: 2, clientX: 900, clientY: 300, ...extra });

  view.fire('pointermove', { pointerType: 'mouse', clientX: 900, clientY: 300 });
  frame(rg, s);

  rmb('pointerdown');                              // press and hold: past WEB_AIM_HOLD it is an aim
  let r = frames(rg, s, 30);
  assert.equal(s.web.mode, 'aiming', 'a held right button aims');
  assert.ok(types(r.evs).includes('aim'));
  rmb('pointerup');
  r = frame(rg, s);
  assert.equal(s.web.mode, 'flying', 'releasing fires');

  // ...and with no button held the line still bites and holds, exactly as on the pad.
  r = frames(rg, s, 40);
  assert.equal(s.phase, 'swinging', 'the line held with nothing pressed');
  assert.ok(!types(r.evs).includes('webcut'));

  const v = { x: s.body.vx, y: s.body.vy };
  rmb('pointerdown'); rg.tick(60); rmb('pointerup');   // a CLICK, not a hold
  r = frames(rg, s, 2);
  assert.ok(types(r.evs).includes('webcut'), 'a right click lets go of the line');
  assert.equal(s.phase, 'falling');
  assert.ok(Math.hypot(s.body.vx, s.body.vy) > Math.hypot(v.x, v.y) * 0.9, 'and throws you with the speed you had');
  input.dispose();
});

test('touch: a tap cannot cut the bite it happens to span (B50)', () => {
  // main.js hands ONE input object to every fixed sub-step of a rendered frame, clearing only the
  // grip taps between them. A tap flag left standing is therefore read again on the next sub-step
  // -- so when `flying -> attached` lands on a non-final sub-step, the step right after it saw
  // the tap and cut: attached for one step, then the whole cliff. That is the exact failure this
  // gesture was built to end, reappearing through the sub-step loop.
  //
  // Pinned deterministically: fly to one sub-step short of the anchor, THEN run a multi-sub-step
  // frame carrying a tap, so the bite is guaranteed to land inside it. With the edge unconsumed
  // this produces webhit, fall, webcut and phase 'falling' at every frame length tried.
  for (const subSteps of [2, 4, 8, 12]) {
    const rg = phone(), s = climber();
    frame(rg, s);
    padDown(rg); padDrag(rg, 40, -66); frames(rg, s, 12); padUp(rg);
    frame(rg, s);
    assert.equal(s.web.mode, 'flying', 'the shot is in the air');

    // one sub-step at a time until the line is about to bite
    let flown = 0;
    while (s.web.mode === 'flying' && flown < 400) { frame(rg, s, 1000 / 120); flown++; }
    assert.equal(s.web.mode, 'attached', 'sanity: the line does bite');
    // ...now redo it, stopping one sub-step short
    const rg2 = phone(), s2 = climber();
    frame(rg2, s2);
    padDown(rg2); padDrag(rg2, 40, -66); frames(rg2, s2, 12); padUp(rg2);
    frame(rg2, s2);
    for (let k = 0; k < flown - 1; k++) frame(rg2, s2, 1000 / 120);
    assert.equal(s2.web.mode, 'flying', 'still in the air, one sub-step short of the anchor');

    // tap the pad, then run one long frame that crosses the bite
    padDown(rg2, 61); rg2.tick(60); padUp(rg2, 61);
    const r = frame(rg2, s2, subSteps * 1000 / 120);
    assert.ok(types(r.evs).includes('webhit'), `sub-steps=${subSteps}: the line bit in this frame`);
    assert.ok(!types(r.evs).includes('webcut'), `sub-steps=${subSteps}: a tap must not cut the bite it spans, got [${types(r.evs)}]`);
    assert.equal(s2.web.mode, 'attached', `sub-steps=${subSteps}: still on the line`);
    assert.equal(s2.phase, 'swinging', `sub-steps=${subSteps}: not falling`);

    // ...and the line is still cuttable afterwards, by a fresh tap.
    padDown(rg2, 62); rg2.tick(60); padUp(rg2, 62);
    const r2 = frames(rg2, s2, 2);
    assert.ok(types(r2.evs).includes('webcut'), `sub-steps=${subSteps}: a later tap still lets go`);
    rg.input.dispose(); rg2.input.dispose();
  }
});

test('touch: a GRIP-R tap mid-swing grabs for rock, it does not cut the line (B50)', () => {
  // The cut used to accept `tapR`, so reaching for rock with the right hand severed the line --
  // and the tap was swallowed too, so the hand did not even arm. Both halves are wrong: a GRIP
  // tap is a grab.
  const rg = phone(), s = climber();
  frame(rg, s);
  padDown(rg); padDrag(rg, 40, -66); frames(rg, s, 12); padUp(rg);
  frames(rg, s, 30);
  assert.equal(s.phase, 'swinging');
  assert.equal(s.hands.R.armed, false);

  rg.hud.grips.R.fire('pointerdown', { pointerId: 71 });
  const r = frame(rg, s);
  assert.ok(!types(r.evs).includes('webcut'), 'reaching for rock does not drop the line');
  assert.equal(s.phase, 'swinging');
  assert.ok(types(r.evs).includes('arm'), 'and the tap reaches the hand, which arms');
  assert.equal(s.hands.R.armed, true);
  rg.input.dispose();
});

test('touch: a stolen pointer aborts the aim instead of firing it (B50)', () => {
  // A system gesture, an incoming call, the browser taking the capture: none of them is a
  // release, so none of them may loose a shot the player never let go of.
  const rg = phone(), s = climber();
  frame(rg, s);
  padDown(rg); padDrag(rg, 40, -66);
  frames(rg, s, 12);
  assert.equal(s.web.mode, 'aiming');
  rg.hud.webButton.fire('pointercancel', { pointerId: 9 });
  const r = frames(rg, s, 4);
  assert.equal(s.web.mode, 'idle', 'the aim is put away');
  assert.ok(!types(r.evs).includes('webshot'), `nothing was fired, got [${types(r.evs)}]`);
  assert.equal(s.web.cd, 0, 'and it costs no cooldown: you were not charged for a shot you never took');
  assert.equal(s.phase, 'climbing');
  assert.ok(s.hands.L.gripping && s.hands.R.gripping, 'both hands still on the rock');
  rg.input.dispose();
});

test('touch: the gesture reaches the sim by either name main.js might forward (B50)', () => {
  // input.js hands the same object out as `web` and as `R.web`. main.js now names `web` on its
  // step literal, so that is the live path; `R.web` stays as the belt that survives an
  // integrator which forwards field by field, which is exactly how B48 went missing.
  const rg = phone(), s = climber();
  frame(rg, s);
  padDown(rg); padDrag(rg, 40, -66); frames(rg, s, 12); padUp(rg); frames(rg, s, 30);
  assert.equal(s.phase, 'swinging');

  // top-level `web` only: the R this literal forwards carries no gesture at all
  padDown(rg, 81); rg.tick(60); padUp(rg, 81);
  rg.tick(16);
  const inp = rg.input.read();
  assert.equal(inp.web.tap, true, 'the tap is on the top-level field');
  step(s, { L: inp.L, R: { x: 0, y: 0, active: false }, tapL: false, tapR: false, holdL: false, holdR: inp.holdR, web: inp.web }, 1 / 120);
  assert.ok(drainEvents(s).map((e) => e.type).includes('webcut'), 'top-level `web` alone reaches the sim');
  rg.input.dispose();
});

test('touch: aiming and looking are two thumbs that do not fight (B47 + B50)', () => {
  // B47 turned a drag on the play surface into the head, and B50 put the web aim in its own
  // field. The two must not reach across: a look drag never writes the aim, and the pad never
  // writes the view. On a phone they are simply two thumbs.
  const rg = phone(), s = climber();
  const surface = new FakeEl({ left: 0, top: 0, width: 393, height: 852 });
  let t = 0;
  const input = createInput({ hud: rg.hud, keyboard: false, win: new FakeEl({}), now: () => t, surface, getHands: () => s.hands });
  const tick = (ms) => { t += ms; };

  // one thumb drags the view
  surface.fire('pointerdown', { pointerType: 'touch', pointerId: 40, clientX: 200, clientY: 400 });
  surface.fire('pointermove', { pointerType: 'touch', pointerId: 40, clientX: 320, clientY: 400 });
  tick(16);
  let r = input.read();
  assert.ok(r.look.x !== 0, 'the drag turned the head');
  assert.equal(r.web.active, false, 'and it did not touch the web aim');
  assert.deepEqual({ x: r.web.x, y: r.web.y }, { x: 0, y: 1 }, 'the aim is untouched by a look');

  // the other thumb drags the pad, while the look drag is still down
  rg.hud.webButton.fire('pointerdown', { pointerId: 41, clientX: PAD_C.x, clientY: PAD_C.y });
  rg.hud.webButton.fire('pointermove', { pointerId: 41, clientX: PAD_C.x - 70, clientY: PAD_C.y - 40 });
  tick(16);
  const lookX = r.look.x;
  r = input.read();
  assert.equal(r.web.active, true, 'the pad committed on the drag');
  assert.ok(r.web.x < -0.2, `and carries its own aim, got ${r.web.x.toFixed(2)}`);
  assert.equal(r.holdR, true, 'the pad is the held right grip');
  assert.equal(r.look.x, lookX, 'while the head has not moved a degree because of it');
  assert.equal(r.R.active, false, 'and neither gesture steered the right stick');
  input.dispose();
});
