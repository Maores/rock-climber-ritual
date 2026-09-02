import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CFG, createClimber, startClimb, step, drainEvents, shoulder, hangTarget, restingShoulder } from '../src/sim.js';
import { ROUTE, generateRoute } from '../src/route.js';
import { reachGraph, inEdges, costToGoal, stateKey } from './climb-graph.js';

const DT = 1 / 120;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function inp(o = {}) {
  return { L: { x: 0, y: 0 }, R: { x: 0, y: 0 }, tapL: false, tapR: false, ...o };
}
function run(state, seconds, input = null) {
  for (let t = 0; t < seconds - 1e-9; t += DT) step(state, input, DT);
}
// A tiny route: the two start holds plus whatever extra holds a test needs.
function mkRoute(extra = [], startY = 1.2, top = 40) {
  const holds = [
    { x: -0.25, y: startY, size: 0.16, kind: 'hold' },
    { x: 0.25, y: startY, size: 0.16, kind: 'hold' },
    ...extra,
  ].map((h, id) => ({ id, size: 0.14, lit: false, angle: 0, kind: 'hold', ...h }));
  return { holds, top, seed: 0 };
}
function climber(extra, startY, top) {
  const s = createClimber(mkRoute(extra, startY, top));
  startClimb(s);
  drainEvents(s);
  return s;
}
const types = (state) => drainEvents(state).map((e) => e.type);
// Stick vector that points a free hand at `hold` from its current shoulder (what a player aims for).
function steer(state, side, hold) {
  const sh = shoulder(state, side);
  const v = { x: (hold.x - sh.x) / CFG.REACH, y: (hold.y - sh.y) / CFG.REACH };
  const m = Math.hypot(v.x, v.y);
  if (m > 1) { v.x /= m; v.y /= m; }
  return v;
}
// Where the free left hand ends up with the stick straight up while the right hand hangs
// alone from the right start hold: body (0.30, 0.70) → shoulder (0.11, 0.78) → hand (0.11, 1.50).
const L_UP = { x: 0.25 + CFG.SWAY - CFG.SHOULDER_DX, y: 1.2 - CFG.HANG_ONE + CFG.SHOULDER_DY + CFG.REACH };

test('createClimber: title phase, both hands on the start holds, full stamina, body hanging below', () => {
  const s = createClimber(mkRoute());
  assert.equal(s.phase, 'title');
  assert.equal(s.hands.L.gripping, true);
  assert.equal(s.hands.L.holdId, 0);
  assert.equal(s.hands.R.gripping, true);
  assert.equal(s.hands.R.holdId, 1);
  assert.equal(s.hands.L.stamina, 1);
  assert.equal(s.hands.R.stamina, 1);
  near(s.body.x, 0, 1e-9);
  near(s.body.y, 1.2 - CFG.HANG_TWO, 1e-9);
  assert.deepEqual(s.runesLit, []);
  assert.equal(s.checkpoint, null);
  near(s.night, s.body.y / 40, 1e-9);
  assert.equal(s.ropeAnchor, undefined, 'B43: there is no rope, so there is no anchor to hang it from');
  assert.equal(s.fallCount, undefined, 'B43: nothing counts falls, because one fall ends the climb');
  assert.deepEqual(s.events, []);
});

test('startClimb: enters climbing once and emits start; title ignores taps and does not drain', () => {
  const s = createClimber(mkRoute());
  run(s, 1, inp({ tapL: true, tapR: true }));
  assert.equal(s.phase, 'title');
  assert.equal(s.hands.L.gripping, true);
  assert.equal(s.hands.L.stamina, 1);
  startClimb(s);
  assert.equal(s.phase, 'climbing');
  assert.deepEqual(types(s), ['start']);
  startClimb(s);
  assert.deepEqual(types(s), []);
});

test('step: dt is clamped to 1/20 and non-finite dt is ignored', () => {
  const a = climber(), b = climber();
  step(a, inp({ tapL: true }), 1.0);
  step(b, inp({ tapL: true }), 1 / 20);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(a.hands.L.x, b.hands.L.x);
  near(a.t, 1 / 20, 1e-12);
  step(a, inp(), NaN);
  near(a.t, 1 / 20, 1e-12);
});

test('reach clamp: a free hand never leaves the REACH circle and a full stick reaches its rim', () => {
  const s = climber();
  step(s, inp({ tapL: true }), DT);            // release the left hand
  run(s, 2, inp({ L: { x: 1, y: 1 } }));       // diagonal, beyond the unit disc
  let sh = shoulder(s, 'L');
  const d = dist(s.hands.L, sh);
  assert.ok(d <= CFG.REACH + 1e-9, `hand ${d} m from the shoulder`);
  assert.ok(d >= CFG.REACH - 0.02, 'a full stick should reach the rim');
  run(s, 2, inp({ L: { x: 0, y: 1 } }));
  sh = shoulder(s, 'L');
  near(s.hands.L.x, sh.x, 0.02, 'hand x');
  near(s.hands.L.y, sh.y + CFG.REACH, 0.02, 'hand y');
  near(s.hands.L.tx, sh.x, 1e-9);
  near(s.hands.L.ty, sh.y + CFG.REACH, 1e-9);
  // Every intermediate frame respects the clamp too.
  for (let i = 0; i < 240; i++) {
    step(s, inp({ L: { x: (i % 2 ? 1 : -1), y: 1 } }), DT);
    assert.ok(dist(s.hands.L, shoulder(s, 'L')) <= CFG.REACH + 1e-9);
  }
});

test('free hand: a released stick lingers, then drifts to the rest offset', () => {
  const s = climber();
  step(s, inp({ tapL: true }), DT);
  run(s, 3, inp({ L: { x: 0.5, y: 0.5 } }));
  const p = { x: s.hands.L.x, y: s.hands.L.y };
  run(s, CFG.LINGER * 0.8, inp());
  near(dist(s.hands.L, p), 0, 0.02, 'hand moved during the linger');
  run(s, 3, inp());
  const sh = shoulder(s, 'L');
  near(s.hands.L.x, sh.x - CFG.REST_X, 0.02, 'rest x');
  near(s.hands.L.y, sh.y + CFG.REST_Y, 0.02, 'rest y');
});

test('grab: a tap grabs the nearest hold within SNAP, closes the hand onto it (no teleport) and curls the fingers', () => {
  const s = climber([{ x: L_UP.x + 0.03, y: L_UP.y + 0.02 }]);
  step(s, inp({ tapL: true }), DT);
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));
  assert.ok(s.hands.L.curl < 0.3, 'fingers open while free');
  assert.ok(s.hands.L.hover > 0.8, 'hover rises next to the hold');
  assert.equal(s.hands.L.nearId, 2);
  drainEvents(s);
  const before = { x: s.hands.L.x, y: s.hands.L.y };
  const hold = s.route.holds[2];
  step(s, inp({ tapL: true, L: { x: 0, y: 1 } }), DT);
  assert.equal(s.hands.L.gripping, true);
  assert.equal(s.hands.L.holdId, 2);
  // The hand grips where the fingers landed: the target is a point ON the rock, not its centre.
  const off = Math.hypot(s.hands.L.tx - hold.x, s.hands.L.ty - hold.y);
  assert.ok(off <= hold.size, `the target is on the rock (off by ${off.toFixed(3)} of ${hold.size})`);
  assert.deepEqual([s.hands.L.tx, s.hands.L.ty], [hold.x + s.hands.L.gripDX, hold.y + s.hands.L.gripDY], 'the target is the contact point at once');
  const gripPt = { x: hold.x + s.hands.L.gripDX, y: hold.y + s.hands.L.gripDY };
  assert.ok(dist(s.hands.L, before) < 0.02, 'the hand is still where it was on the grab frame');
  assert.deepEqual(drainEvents(s), [{ type: 'grab', hand: 'L', holdId: 2 }]);
  // It closes onto the hold without overshoot and sits exactly on it within 0.2 s.
  let d = dist(s.hands.L, hold);
  for (let t = 0; t < 0.2; t += DT) {
    step(s, inp(), DT);
    const nd = dist(s.hands.L, gripPt);
    assert.ok(nd <= d + 1e-9, `closing in (${nd} after ${d})`);
    d = nd;
  }
  assert.equal(s.hands.L.x, gripPt.x, 'settles exactly on the contact point');
  assert.equal(s.hands.L.y, gripPt.y);
  run(s, 0.4, inp());
  assert.ok(s.hands.L.curl > 0.95, 'fingers curl onto the hold');
  assert.equal(s.hands.L.hover, 1);
});

test('grab: the settle is stable at the largest step (1/20 s) and ends locked on the hold', () => {
  const s = climber([{ x: L_UP.x + 0.1, y: L_UP.y - 0.1 }]);
  step(s, inp({ tapL: true }), DT);
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));
  step(s, inp({ tapL: true, L: { x: 0, y: 1 } }), 1 / 20);
  assert.equal(s.hands.L.holdId, 2);
  const hold = s.route.holds[2];
  const grip = { x: hold.x + s.hands.L.gripDX, y: hold.y + s.hands.L.gripDY };
  let d = dist(s.hands.L, grip);
  for (let i = 0; i < 10; i++) {
    step(s, inp(), 1 / 20);
    const nd = dist(s.hands.L, grip);
    assert.ok(Number.isFinite(nd) && nd <= d + 1e-9, `diverged: ${nd} after ${d}`);
    d = nd;
  }
  assert.equal(s.hands.L.x, hold.x + s.hands.L.gripDX, 'locked exactly on the contact point');
  assert.equal(s.hands.L.vx, 0);
});

test('grab: lifting the thumb and tapping GRIP within the linger still takes the hold', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y }]);
  step(s, inp({ tapL: true }), DT);
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));
  run(s, 0.4, inp());                                  // thumb off the stick for 0.4 s
  step(s, inp({ tapL: true }), DT);
  assert.equal(s.hands.L.holdId, 2);
});

test('grab: a hand never takes the hold the other hand is holding', () => {
  const s = climber();
  step(s, inp({ tapL: true }), DT);                    // left free, right on hold 1
  const taken = s.route.holds[1];
  for (let t = 0; t < 2; t += DT) step(s, inp({ L: steer(s, 'L', taken) }), DT);
  assert.ok(dist(s.hands.L, taken) < CFG.SNAP, 'the free hand can hover over the other hand\'s hold');
  assert.notEqual(s.hands.L.nearId, 1);
  drainEvents(s);
  step(s, inp({ tapL: true, L: steer(s, 'L', taken) }), DT);
  assert.equal(s.hands.L.gripping, false);
  assert.equal(s.hands.L.armed, true);
  for (let t = 0; t < 1; t += DT) step(s, inp({ L: steer(s, 'L', taken) }), DT);   // armed on top of it: still no
  assert.equal(s.hands.L.gripping, false);
  assert.equal(s.hands.R.holdId, 1);
});

test('miss: a tap near a hold (within hover range) is a miss; a tap in empty rock only arms', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y - 0.15 }]);
  step(s, inp({ tapL: true }), DT);
  run(s, 2, inp());                                    // at rest: ~0.30 m from hold 2
  const d = dist(s.hands.L, s.route.holds[2]);
  assert.ok(d > CFG.SNAP && d <= CFG.HOVER_RANGE, `rest distance ${d}`);
  drainEvents(s);
  step(s, inp({ tapL: true }), DT);
  assert.deepEqual(types(s), ['miss', 'arm']);
  run(s, 3, inp({ L: { x: -1, y: -0.3 } }));           // low and far out on the left: nothing within hover range
  assert.equal(s.hands.L.hover, 0);
  assert.equal(s.hands.L.armed, false);
  drainEvents(s);
  step(s, inp({ tapL: true, L: { x: -1, y: -0.3 } }), DT);
  assert.deepEqual(types(s), ['arm']);
});

test('grab: a tap beyond SNAP misses and arms the hand; an armed hand grabs the first hold that comes within SNAP', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y }]);
  step(s, inp({ tapL: true }), DT);
  run(s, 2, inp());                                    // hand at rest, far from hold 2
  assert.ok(dist(s.hands.L, s.route.holds[2]) > CFG.SNAP);
  drainEvents(s);
  step(s, inp({ tapL: true }), DT);
  assert.equal(s.hands.L.gripping, false);
  assert.equal(s.hands.L.armed, true);
  assert.deepEqual(types(s), ['miss', 'arm']);
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));            // steer onto the hold, no second tap
  assert.equal(s.hands.L.gripping, true);
  assert.equal(s.hands.L.holdId, 2);
  assert.equal(s.hands.L.armed, false);
  assert.deepEqual(types(s), ['grab']);
});

test('grab: arming expires after ARM_TIME without a hold', () => {
  const s = climber();
  step(s, inp({ tapL: true }), DT);
  run(s, 2, inp());
  step(s, inp({ tapL: true }), DT);
  assert.equal(s.hands.L.armed, true);
  run(s, CFG.ARM_TIME - 0.2, inp());
  assert.equal(s.hands.L.armed, true);
  run(s, 0.4, inp());
  assert.equal(s.hands.L.armed, false);
  assert.equal(s.hands.L.gripping, false);
});

test('release: a tap on a gripping hand lets go and emits release', () => {
  const s = climber();
  step(s, inp({ tapR: true }), DT);
  assert.equal(s.hands.R.gripping, false);
  assert.equal(s.hands.R.holdId, null);
  assert.deepEqual(drainEvents(s), [{ type: 'release', hand: 'R', holdId: 1 }]);
  assert.equal(s.phase, 'climbing');
});

test('release then tap: the second tap arms the hand instead of re-taking the same hold', () => {
  const s = climber();
  step(s, inp({ tapR: true }), DT);
  step(s, inp({ tapR: true }), DT);                    // still on top of hold 1
  assert.equal(s.hands.R.gripping, false);
  assert.equal(s.hands.R.armed, true);
  assert.equal(s.hands.R.hover < 1, true);
  assert.deepEqual(types(s), ['release', 'arm']);      // a deliberate pre-arm, not a miss: no pill shake
  run(s, 0.4, inp());                                  // armed and lingering on the old hold: still no grab
  assert.equal(s.hands.R.gripping, false);
  run(s, CFG.SKIP_TIME, inp());                        // the skip expires; a tap takes the hold again if it is still in reach
  const d = dist(s.hands.R, s.route.holds[1]);
  step(s, inp({ tapR: true }), DT);
  assert.equal(s.hands.R.gripping, d <= CFG.SNAP);
});

test('body: two gripping hands → mean of the holds minus HANG_TWO', () => {
  const s = climber();
  s.body.x += 0.2; s.body.y -= 0.2;                    // perturb, then settle
  run(s, 3, inp());
  near(s.body.x, 0, 0.01, 'body x');
  near(s.body.y, 1.2 - CFG.HANG_TWO, 0.01, 'body y');
  assert.deepEqual(hangTarget(s), { x: 0, y: 1.2 - CFG.HANG_TWO });
});

test('body: one gripping hand → hold minus HANG_ONE, swaying toward the loaded arm', () => {
  const s = climber();
  step(s, inp({ tapL: true }), DT);
  let maxX = -Infinity;
  for (let t = 0; t < 3; t += DT) { step(s, inp(), DT); maxX = Math.max(maxX, s.body.x); }
  near(s.body.x, 0.25 + CFG.SWAY, 0.01, 'body x');
  near(s.body.y, 1.2 - CFG.HANG_ONE, 0.01, 'body y');
  assert.ok(maxX > 0.25 + CFG.SWAY + 0.01, 'the body should sway past the target before settling');
  assert.deepEqual(hangTarget(s), { x: 0.25 + CFG.SWAY, y: 1.2 - CFG.HANG_ONE });
  assert.deepEqual(restingShoulder(s.route.holds[1], 'L'), shoulder({ body: hangTarget(s) }, 'L'));
});

test('body: no gripping hand → falling under gravity with a fall event', () => {
  const s = climber([], 10);
  step(s, inp({ tapL: true, tapR: true }), DT);
  assert.equal(s.phase, 'falling');
  assert.deepEqual(types(s), ['release', 'release', 'fall']);
  assert.equal(hangTarget(s), null);
  const y0 = s.body.y;
  run(s, 0.1, inp());
  assert.ok(s.body.vy < -0.9 && s.body.vy > -1.1, `vy ${s.body.vy}`);
  assert.ok(s.body.y < y0);
});

test('stamina: both hands gripping drain 0.05/s each', () => {
  const s = climber();
  run(s, 1, inp());
  near(s.hands.L.stamina, 1 - CFG.DRAIN_TWO, 0.002);
  near(s.hands.R.stamina, 1 - CFG.DRAIN_TWO, 0.002);
});

test('stamina: the only gripping hand drains 0.20/s while the free hand refills 0.18/s', () => {
  const s = climber();
  s.hands.L.stamina = 0.5;
  step(s, inp({ tapL: true }), DT);
  run(s, 1 - DT, inp());
  near(s.hands.R.stamina, 1 - CFG.DRAIN_ONE, 0.003, 'gripping hand');
  near(s.hands.L.stamina, 0.5 + CFG.REFILL_FREE, 0.003, 'free hand');
  run(s, 5, inp());
  assert.equal(s.hands.L.stamina, 1);
});

test('stamina: a rune hold never drains and refills 0.50/s', () => {
  const s = climber();
  s.route.holds[0].kind = 'rune';
  run(s, 1, inp());
  assert.equal(s.hands.L.stamina, 1);
  near(s.hands.R.stamina, 1 - CFG.DRAIN_TWO, 0.002);
  s.hands.L.stamina = 0.2;
  run(s, 1, inp());
  near(s.hands.L.stamina, 0.2 + CFG.REFILL_RUNE, 0.003);
  step(s, inp({ tapR: true }), DT);                    // hang from the rune alone
  run(s, 2, inp());
  assert.equal(s.hands.L.stamina, 1);
});

test('stamina: reaching zero forces a release with a slip event, the other hand keeps the climber up', () => {
  const s = climber();
  s.hands.L.stamina = 0.02;
  run(s, 0.02 / CFG.DRAIN_TWO + 0.3, inp());           // long enough to hit zero whatever the rate
  assert.equal(s.hands.L.gripping, false);
  assert.equal(s.hands.L.stamina >= 0, true);
  assert.equal(s.phase, 'climbing');
  const ev = drainEvents(s);
  assert.deepEqual(ev.filter((e) => e.type === 'slip'), [{ type: 'slip', hand: 'L', holdId: 0 }]);
  assert.ok(s.hands.L.tremble > 0.3, 'tremble builds as stamina fades');
});

test('stamina: slipping off the last hold starts a fall', () => {
  const s = climber([], 10);
  step(s, inp({ tapL: true }), DT);
  s.hands.R.stamina = 0.01;
  run(s, 0.3, inp());
  assert.equal(s.phase, 'falling');
  assert.ok(types(s).includes('fall'));
});

test('fall: nothing catches you — the plunge runs to the ground and ends the climb', () => {
  const s = climber([], 10);
  const from = s.body.y;
  step(s, inp({ tapL: true, tapR: true }), DT);
  let hitAt = null, maxSpeed = 0;
  for (let t = 0; t < 8 && hitAt === null; t += DT) {
    step(s, inp(), DT);
    maxSpeed = Math.max(maxSpeed, Math.abs(s.body.vy));
    if (s.phase === 'fallen') hitAt = t;
  }
  assert.equal(s.phase, 'fallen', 'the fall must reach the ground');
  near(s.body.y, CFG.FLOOR, 1e-9, 'and stop there');
  assert.equal(s.body.vy, 0);
  const ev = types(s);
  assert.ok(!ev.includes('catch'), 'B43: there is no rope, so nothing is ever caught');
  assert.equal(ev.filter((e) => e === 'fall').length, 1);
  assert.equal(ev.filter((e) => e === 'impact').length, 1);
  assert.equal(ev.filter((e) => e === 'fallen').length, 1);
  // It falls the whole way, under gravity, capped so the drop reads instead of blurring.
  assert.ok(maxSpeed <= CFG.FALL_TERMINAL + 1e-6, `terminal velocity broken: ${maxSpeed}`);
  const freeFall = Math.sqrt(2 * (from - CFG.FLOOR) / CFG.GRAVITY);
  assert.ok(hitAt > freeFall * 0.9 && hitAt < freeFall * 1.6, `fell ${from - CFG.FLOOR} m in ${hitAt}s`);
  assert.equal(s.hands.L.gripping, false);
  assert.equal(s.hands.R.gripping, false);
});

test('fall: a grab inside the grace window saves it, and nothing is counted', () => {
  const s = climber([], 10);
  step(s, inp({ tapL: true, tapR: true }), DT);
  run(s, 0.12, inp());
  assert.equal(s.phase, 'falling');
  step(s, inp({ tapL: true }), DT);                    // the left hand is still next to hold 0
  assert.equal(s.phase, 'climbing');
  assert.equal(s.hands.L.holdId, 0);
  const ev = types(s);
  assert.ok(!ev.includes('catch'));
  assert.ok(!ev.includes('fallen'), 'saved in time: the climb goes on');
});

test('fall: past the grace window nothing can be grabbed, all the way to the ground', () => {
  const s = climber([{ x: -0.25, y: 10 - 0.8 }], 10);  // a hold the falling left hand passes at ~0.4 s
  step(s, inp({ tapL: true, tapR: true }), DT);
  run(s, 0.3, inp());
  step(s, inp({ tapL: true }), DT);                    // arms only: past the grace window
  assert.equal(s.hands.L.armed, true);
  assert.ok(!types(s).includes('miss'));
  run(s, 6, inp());
  assert.equal(s.phase, 'fallen');
  assert.equal(s.hands.L.gripping, false, 'the hold it passed must not save it');
  assert.ok(types(s).includes('fallen'));
});

test('fall: letting go with your feet on the ground is not a fall', () => {
  const s = climber();
  s.body.x = 0.6;                                      // even when the body was off to one side
  assert.ok(s.body.y <= CFG.FLOOR + CFG.HANG_TWO, 'the start hang is within standing height');
  step(s, inp({ tapL: true, tapR: true }), DT);
  run(s, 4, inp());
  assert.equal(s.phase, 'grounded', 'you were standing, so you stay standing');
  near(s.body.y, CFG.FLOOR, 0.03);
  assert.ok(!types(s).includes('fallen'), 'no death screen for stepping off the ground');
  assert.ok(dist(shoulder(s, 'L'), s.route.holds[0]) <= 0.9 * CFG.REACH);
  assert.ok(dist(shoulder(s, 'R'), s.route.holds[1]) <= 0.9 * CFG.REACH);
});

test('rune: grabbing a rune lights it once, sets the checkpoint and emits rune', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y, kind: 'rune' }]);
  step(s, inp({ tapL: true }), DT);
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));
  step(s, inp({ tapL: true }), DT);
  run(s, 0.1, inp());
  assert.equal(s.hands.L.holdId, 2);
  assert.equal(s.route.holds[2].lit, true);
  assert.equal(s.checkpoint, 2);
  assert.deepEqual(s.runesLit, [2]);
  const ev = drainEvents(s);
  assert.deepEqual(ev.filter((e) => e.type === 'rune'), [{ type: 'rune', hand: 'L', holdId: 2 }]);
  step(s, inp({ tapL: true }), DT);                    // let go, drift away, come back: no second rune event
  run(s, 1.0, inp());
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));
  step(s, inp({ tapL: true }), DT);
  assert.equal(s.hands.L.holdId, 2);
  assert.ok(!types(s).includes('rune'));
  assert.deepEqual(s.runesLit, [2]);
  assert.equal(s.checkpoint, 2);
});

test('summit: grabbing the summit hold completes the ritual', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y, kind: 'summit', size: 0.24 }]);
  step(s, inp({ tapL: true }), DT);
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));
  step(s, inp({ tapL: true }), DT);
  run(s, 0.1, inp());
  assert.equal(s.phase, 'summit');
  assert.equal(s.route.holds[2].lit, true);
  const ev = drainEvents(s);
  assert.ok(ev.some((e) => e.type === 'summit' && e.hand === 'L' && e.holdId === 2));
  const st = s.hands.R.stamina;
  run(s, 2, inp({ tapL: true, tapR: true }));          // input is ignored once the ritual is complete
  assert.equal(s.phase, 'summit');
  assert.equal(s.hands.L.gripping, true);
  assert.equal(s.hands.R.stamina, st);
});

test('derived: height, maxHeight and night follow the body', () => {
  const s = climber([], 1.2, 2);
  run(s, 0.5, inp());
  assert.equal(s.height, s.body.y);
  near(s.night, s.body.y / 2, 1e-9);
  assert.ok(s.maxHeight >= s.height);
  step(s, inp({ tapL: true, tapR: true }), DT);
  run(s, 2, inp());
  assert.ok(s.maxHeight > s.height, 'maxHeight remembers the high point');
});

test('hands: hover measures proximity to the nearest hold, tremble follows low stamina', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y + 0.3 }]);
  step(s, inp({ tapL: true }), DT);
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));
  assert.equal(s.hands.L.nearId, 2);
  near(s.hands.L.hover, 1 - 0.3 / CFG.HOVER_RANGE, 0.08);
  run(s, 1.5, inp({ L: { x: -1, y: -0.2 } }));
  assert.equal(s.hands.L.hover, 0);
  assert.equal(s.hands.L.tremble, 0);
  const t = climber();                                 // both hands on, one of them nearly spent
  t.hands.R.stamina = 0.15;
  run(t, 1, inp());
  assert.ok(t.hands.R.gripping);
  assert.ok(t.hands.R.tremble > 0.5, `tremble ${t.hands.R.tremble}`);
  assert.ok(t.hands.L.tremble < 0.05);
  assert.equal(t.hands.R.hover, 1);
});

test('events: drainEvents returns and clears; undrained events are capped', () => {
  const s = climber();
  for (let i = 0; i < 200; i++) step(s, inp({ tapL: true }), DT);
  assert.ok(s.events.length <= CFG.EVENT_CAP);
  const ev = drainEvents(s);
  assert.ok(ev.length > 0);
  assert.deepEqual(s.events, []);
});

// ---------------------------------------------------------------------------------------
// Autopilot: plays the generated route through the public Input interface only.

// Drive `side` onto `hold` (release first if it is holding something else, then steer and let
// the hand close). Like a player, it keeps whatever the hand actually catches; returns that id.
function botGrab(state, side, hold, log) {
  const hand = state.hands[side], other = state.hands[side === 'L' ? 'R' : 'L'];
  const t0 = state.t;
  while (hand.gripping) {
    if (!other.gripping && state.phase === 'climbing') throw new Error(`bot would fall releasing ${side}`);
    step(state, inp({ [`tap${side}`]: true }), DT);
    for (const e of drainEvents(state)) log.push(e.type);
  }
  while (!hand.gripping) {
    if (state.t - t0 > 8) throw new Error(`stuck reaching hold ${hold.id} with ${side} (phase ${state.phase})`);
    step(state, inp({ [side]: steer(state, side, hold), [`tap${side}`]: !hand.armed }), DT);
    for (const e of drainEvents(state)) log.push(e.type);
  }
  return hand.holdId;
}

// Climb the FIELD (B46) rather than a line: at every move the bot looks at where its hands
// actually are and takes the reachable hold with the lowest cost to the next goal, so a hand
// closing on the wrong rock costs it nothing. `stopAtY` ends the climb partway up.
function botClimb(state, log, stopAtY = Infinity) {
  const r = state.route;
  const graph = reachGraph(r);
  const inE = inEdges(graph);
  const goals = r.holds.filter((h) => h.kind === 'rune' || h.kind === 'summit').sort((a, b) => a.y - b.y);
  for (const goal of goals) {
    const dist = costToGoal(r, graph, inE, goal.id);
    for (let move = 0; move < 400; move++) {
      const { L, R } = state.hands;
      if (L.holdId === goal.id || R.holdId === goal.id) break;
      if (state.body.y >= stopAtY) return;
      let best = null;
      for (const side of ['L', 'R']) {
        const anchor = state.hands[side === 'L' ? 'R' : 'L'];
        if (!anchor.gripping) continue;
        for (const j of graph[anchor.holdId][side]) {
          const d = dist[stateKey(j, side === 'L' ? 'R' : 'L')];
          if (d !== Infinity && (!best || d < best.d)) best = { side, j, d };
        }
      }
      if (!best) throw new Error(`no way on toward hold ${goal.id}`);
      botGrab(state, best.side, r.holds[best.j], log);
    }
  }
}

test('autopilot: the generated route can be climbed to the summit without a fall, lighting every rune', () => {
  const route = generateRoute(7);
  const s = createClimber(route);
  startClimb(s);
  const log = [];
  botClimb(s, log);
  assert.equal(s.phase, 'summit');
  assert.ok(!log.includes('fall'), 'a steady rhythm should never fall');
  assert.equal(s.runesLit.length, Math.ceil(ROUTE.TOP / ROUTE.RUNE_EVERY) - 1);
  assert.equal(log.filter((t) => t === 'rune').length, Math.ceil(ROUTE.TOP / ROUTE.RUNE_EVERY) - 1);
  assert.equal(log.filter((t) => t === 'summit').length, 1);
  assert.ok(!log.includes('slip'), 'a steady rhythm should never run out of stamina');
  assert.ok(s.t < 480, `took ${s.t.toFixed(0)} s`);
});

test('autopilot: a fall from anywhere on the route runs to the ground and ends the climb', () => {
  const route = generateRoute(7);
  // heights up the field, rather than hold indices: on a field an index is only height order
  for (const fallAt of [2.5, 7, 12, 18, ROUTE.TOP - 1]) {
    const s = createClimber(route);
    startClimb(s);
    const log = [];
    botClimb(s, log, fallAt);
    const from = s.body.y;
    assert.ok(from > CFG.FLOOR + CFG.HANG_TWO, `${fallAt} m is above standing height`);
    drainEvents(s);
    step(s, inp({ tapL: true, tapR: true }), DT);      // both hands off, and past the grace window
    run(s, 0.4, inp());
    assert.equal(s.phase, 'falling', `fall from ${fallAt} m`);
    // Nothing may stop it: not a hold it passes, not a rune, not the height it started from.
    run(s, 12, inp());
    assert.equal(s.phase, 'fallen', `fall from hold ${fallAt} never reached the ground`);
    near(s.body.y, CFG.FLOOR, 1e-9, `fall from ${fallAt} m`);
    const ev = types(s);
    assert.ok(!ev.includes('catch'), 'B43: nothing catches a fall any more');
    assert.equal(ev.filter((e) => e === 'impact').length, 1, `fall from ${fallAt} m`);
    assert.equal(ev.filter((e) => e === 'fallen').length, 1, `fall from ${fallAt} m`);
    // and a fall from higher up must take longer, or the plunge is not being integrated
    assert.ok(s.t > 0, `fall from ${fallAt} m`);
  }
});
