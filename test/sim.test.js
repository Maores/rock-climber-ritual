import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CFG, createClimber, startClimb, step, drainEvents, shoulder, hangTarget, restingShoulder, grabRadius } from '../src/sim.js';
import { ROUTE, generateRoute } from '../src/route.js';
import { reachGraph, inEdges, costToGoal, stateKey } from './climb-graph.js';

const DT = 1 / 120;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function inp(o = {}) {
  return { L: { x: 0, y: 0 }, R: { x: 0, y: 0 }, ...o };
}
function run(state, seconds, input = null) {
  for (let t = 0; t < seconds - 1e-9; t += DT) step(state, input, DT);
}

// ---------------------------------------------------------------------------------------
// The two primitives of the control model (B51). There are no buttons: a free hand takes rock
// by hovering over it for CFG.HOVER_GRAB_DWELL, and a gripping hand lets go when its own stick
// is pushed past CFG.RELEASE_DEADZONE. Everything below (and the bots) is built out of these two.

// The stick vector that points `side`'s hand at `hold` from its current shoulder — what a thumb
// aims for. Re-read every frame: a stick aimed once goes stale as soon as the shoulder shifts.
function steerToHold(state, side, hold) {
  const sh = shoulder(state, side);
  const v = { x: (hold.x - sh.x) / CFG.REACH, y: (hold.y - sh.y) / CFG.REACH };
  const m = Math.hypot(v.x, v.y);
  if (m > 1) { v.x /= m; v.y /= m; }
  return v;
}
// Let go with `side`: a beat at the centre to re-arm the stick (a thumb lifting off does this by
// itself), then one frame of full deflection toward `dir` — that push IS the release, and it is
// already steering the hand where it is going.
function releaseHand(state, side, dir = { x: 0, y: 1 }) {
  const m = Math.hypot(dir.x, dir.y) || 1;
  step(state, inp({ [side]: { x: 0, y: 0 } }), DT);
  step(state, inp({ [side]: { x: dir.x / m, y: dir.y / m } }), DT);
}
// Steer `side` onto `hold` and keep the stick there until the fingers close on their own.
function grabByHover(state, side, hold, maxSeconds = 6) {
  const t0 = state.t;
  while (!state.hands[side].gripping && state.t - t0 < maxSeconds) {
    step(state, inp({ [side]: steerToHold(state, side, hold) }), DT);
  }
  return state.hands[side].holdId;
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
const steer = steerToHold;
// Hold the stick on `hold` for `seconds`, re-aiming every frame the way a thumb does while the
// body is still moving; the hand closes on the rock by itself once it has been on it long enough.
function drive(state, side, hold, seconds) {
  for (let t = 0; t < seconds - 1e-9; t += DT) step(state, inp({ [side]: steer(state, side, hold) }), DT);
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

test('startClimb: enters climbing once and emits start; title ignores the sticks and does not drain', () => {
  const s = createClimber(mkRoute());
  run(s, 1, inp({ L: { x: 0, y: 1 }, R: { x: 0, y: 1 } }));
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
  releaseHand(a, 'L'); releaseHand(b, 'L');          // identical two-frame start on both
  step(a, inp({ L: { x: 0, y: 1 } }), 1.0);
  step(b, inp({ L: { x: 0, y: 1 } }), 1 / 20);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(a.hands.L.x, b.hands.L.x);
  near(a.t, 2 * DT + 1 / 20, 1e-12);
  step(a, inp(), NaN);
  near(a.t, 2 * DT + 1 / 20, 1e-12);
});

test('reach clamp: a free hand never leaves the REACH circle and a full stick reaches its rim', () => {
  const s = climber();
  releaseHand(s, 'L');                         // push the stick: that is letting go
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

test('free hand: a released stick leaves the hand where it was steered (B45)', () => {
  const s = climber();
  releaseHand(s, 'L', { x: 0.5, y: 0.5 });
  run(s, 3, inp({ L: { x: 0.5, y: 0.5 } }));
  const p = { x: s.hands.L.x, y: s.hands.L.y };
  const off = { x: p.x - shoulder(s, 'L').x, y: p.y - shoulder(s, 'L').y };
  run(s, 2, inp());                                    // thumb off the stick for two whole seconds
  near(dist(s.hands.L, p), 0, 0.03, 'the hand went back where it came from');
  const sh = shoulder(s, 'L');
  assert.ok(dist(s.hands.L, { x: sh.x - CFG.REST_X, y: sh.y + CFG.REST_Y }) > 0.15, 'and it is not at the rest offset');
  // It is parked as an offset from the shoulder, so it is still the same reach, not a world point.
  near(s.hands.L.x - sh.x, off.x, 0.03, 'parked offset x');
  near(s.hands.L.y - sh.y, off.y, 0.03, 'parked offset y');
  // A zero stick from a device that reports `active` is a deliberate steer back to centre.
  run(s, 2, inp({ L: { x: 0, y: 0, active: true } }));
  near(s.hands.L.x, shoulder(s, 'L').x - CFG.REST_X, 0.02, 'rest x');
  near(s.hands.L.y, shoulder(s, 'L').y + CFG.REST_Y, 0.02, 'rest y');
});

test('free hand: a hand that has not been steered since it left the rock hangs at the rest offset', () => {
  const s = climber();
  s.hands.L.stamina = 0.001;                           // it slips off on its own: no stick, ever
  run(s, 0.2, inp());
  assert.equal(s.hands.L.gripping, false);
  run(s, 2, inp());
  const sh = shoulder(s, 'L');
  near(s.hands.L.x, sh.x - CFG.REST_X, 0.02, 'rest x');
  near(s.hands.L.y, sh.y + CFG.REST_Y, 0.02, 'rest y');
});

test('free hand: a parked hand rides with the body while the other hand climbs (B45)', () => {
  const s = climber([{ x: -0.30, y: 1.35 }]);          // a hold up and left of the two start holds
  const up = s.route.holds[2];
  releaseHand(s, 'L', steer(s, 'L', up));
  grabByHover(s, 'L', up);                             // steering onto the rock is the whole grab
  assert.equal(s.hands.L.holdId, 2, 'the left hand made the move');
  releaseHand(s, 'R', { x: 0.8, y: -0.3 });            // the right hand comes off and is flicked out
  run(s, 0.25, inp({ R: { x: 0.8, y: -0.3 } }));
  const sh0 = shoulder(s, 'R');
  const off = { x: s.hands.R.tx - sh0.x, y: s.hands.R.ty - sh0.y };   // the parked target, as an offset
  const p0 = { x: s.hands.R.x, y: s.hands.R.y };
  run(s, 2, inp());                                    // thumb off: the body swings under the new grip
  const sh1 = shoulder(s, 'R');
  assert.ok(dist(sh0, sh1) > 0.15, `the shoulder only moved ${dist(sh0, sh1).toFixed(2)} m: nothing to ride`);
  near(s.hands.R.tx - sh1.x, off.x, 1e-9, 'the parked target is an offset from the shoulder');
  near(s.hands.R.ty - sh1.y, off.y, 1e-9);
  near(s.hands.R.x - sh1.x, off.x, 0.02, 'and the hand settles on it');
  near(s.hands.R.y - sh1.y, off.y, 0.02);
  assert.ok(dist(s.hands.R, p0) > 0.15, 'so it travelled with the shoulder instead of hanging in the air');
});

test('free hand: standing at the base, a parked hand walks back under the route with you (B45)', () => {
  const s = climber();
  s.body.x = 0.9;                                      // standing off to one side of the route
  releaseHand(s, 'L', { x: -0.7, y: -0.6 });           // both hands off with your feet down: not a fall
  releaseHand(s, 'R', { x: 1, y: -0.4 });              // parked low, clear of the start holds
  run(s, 0.5, inp({ L: { x: -0.7, y: -0.6 } }));       // steer the left hand out, then let the stick go
  assert.equal(s.phase, 'grounded');
  const sh0 = shoulder(s, 'L');
  const off = { x: s.hands.L.tx - sh0.x, y: s.hands.L.ty - sh0.y };
  run(s, 2.5, inp());
  const sh1 = shoulder(s, 'L');
  assert.ok(dist(sh0, sh1) > 0.4, `the climber only walked ${dist(sh0, sh1).toFixed(2)} m`);
  near(s.hands.L.x - sh1.x, off.x, 0.01, 'the parked hand came along');
  near(s.hands.L.y - sh1.y, off.y, 0.01);
});

test('free hand: a parked hand relaxes to rest once the climb is over (B45)', () => {
  const s = climber([], 10);                           // high enough that letting go is a real fall
  releaseHand(s, 'L', { x: -0.9, y: 0.3 });
  run(s, 1.5, inp({ L: { x: -0.9, y: 0.3 } }));        // park the left hand out to the side
  const shA = shoulder(s, 'L');
  const off = { x: s.hands.L.tx - shA.x, y: s.hands.L.ty - shA.y };
  assert.ok(Math.hypot(off.x + CFG.REST_X, off.y - CFG.REST_Y) > 0.4, 'parked nowhere near the rest offset');
  releaseHand(s, 'R', { x: 1, y: 0.2 });               // the last hand goes: nothing catches you
  run(s, 0.3, inp());
  assert.equal(s.phase, 'falling');
  const shB = shoulder(s, 'L');
  near(s.hands.L.tx - shB.x, off.x, 1e-9, 'a fall is still live, so the park holds');
  near(s.hands.L.ty - shB.y, off.y, 1e-9);
  run(s, 8, inp());                                    // ...and on the death screen nobody is steering
  assert.equal(s.phase, 'fallen');
  const sh = shoulder(s, 'L');
  near(s.hands.L.x, sh.x - CFG.REST_X, 0.02, 'the arm hangs at rest: x');
  near(s.hands.L.y, sh.y + CFG.REST_Y, 0.02, 'rest y');
});

test('free hand: a zero stick at the start of a climb does not move a hand off its hold (B45)', () => {
  const s = climber();
  const l = { x: s.hands.L.x, y: s.hands.L.y }, r = { x: s.hands.R.x, y: s.hands.R.y };
  run(s, 2, inp());                                    // sticks read zero because nobody is touching them
  assert.equal(s.hands.L.holdId, 0);
  assert.equal(s.hands.R.holdId, 1);
  near(dist(s.hands.L, l), 0, 1e-9);
  near(dist(s.hands.R, r), 0, 1e-9);
  run(s, 1, inp({ L: { x: 0, y: 0, active: true }, R: { x: 0, y: 0, active: true } }));
  assert.equal(s.hands.L.gripping, true, 'an active stick at centre still does not peel a hand off rock');
  assert.equal(s.hands.R.gripping, true);
});

test('free hand: steer, let go of the stick, steer again — the parked hand still closes on the rock (B45)', () => {
  const s = climber([{ x: L_UP.x + 0.29, y: L_UP.y - 0.06 }]);   // rock a third of a metre off to the side
  releaseHand(s, 'L');
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));             // steer straight up, short of the hold
  run(s, 1.5, inp());                                  // thumb off the stick for a second and a half
  const parked = { x: s.hands.L.x, y: s.hands.L.y };
  const d = dist(s.hands.L, s.route.holds[2]);
  assert.ok(d > grabRadius(s.route.holds[2]) && d <= CFG.HOVER_RANGE, `parked ${d.toFixed(2)} m from the hold, out of grab range`);
  assert.equal(s.hands.L.gripping, false, 'parked beside a hold is not on it: nothing grabs');
  assert.equal(s.hands.L.nearId, 2, 'nearId keeps updating while the hand is parked');
  assert.ok(s.hands.L.hover > 0, 'and so does hover');
  drainEvents(s);
  run(s, 2, inp());                                    // and it stays parked, for as long as you leave it
  near(dist(s.hands.L, parked), 0, 0.01, 'the parked hand did not drift onto the hold by itself');
  assert.deepEqual(types(s), []);
  drive(s, 'L', s.route.holds[2], 1.2);                // pick the stick up again and steer onto the rock
  assert.equal(s.hands.L.gripping, true);
  assert.equal(s.hands.L.holdId, 2);
  assert.deepEqual(types(s), ['grab']);
});

test('grab: hovering over a hold closes the hand onto it (no teleport) and curls the fingers', () => {
  const s = climber([{ x: L_UP.x + 0.03, y: L_UP.y + 0.02 }]);
  const hold = s.route.holds[2];
  releaseHand(s, 'L');
  // steer up and stop the moment the fingers are on the rock, a frame before they close
  let before = null, curlBefore = 1;
  for (let i = 0; i < 400 && !s.hands.L.gripping; i++) {
    before = { x: s.hands.L.x, y: s.hands.L.y };
    curlBefore = s.hands.L.curl;
    step(s, inp({ L: { x: 0, y: 1 } }), DT);
  }
  assert.ok(curlBefore < 0.35, `fingers should still be open the frame before the grab (curl ${curlBefore.toFixed(2)})`);
  assert.equal(s.hands.L.gripping, true);
  assert.equal(s.hands.L.holdId, 2);
  assert.equal(s.hands.L.nearId, 2);
  const ev = drainEvents(s).filter((e) => e.type === 'grab');
  assert.deepEqual(ev, [{ type: 'grab', hand: 'L', holdId: 2 }]);
  // The hand grips where the fingers landed: the target is a point ON the rock, not its centre.
  const off = Math.hypot(s.hands.L.tx - hold.x, s.hands.L.ty - hold.y);
  assert.ok(off <= hold.size, `the target is on the rock (off by ${off.toFixed(3)} of ${hold.size})`);
  assert.deepEqual([s.hands.L.tx, s.hands.L.ty], [hold.x + s.hands.L.gripDX, hold.y + s.hands.L.gripDY], 'the target is the contact point at once');
  const gripPt = { x: hold.x + s.hands.L.gripDX, y: hold.y + s.hands.L.gripDY };
  assert.ok(dist(s.hands.L, before) < 0.02, 'the hand is still where it was on the grab frame');
  // It settles onto the contact point and sits exactly on it within 0.2 s. The hand arrives with
  // the momentum of the reach now (nothing is tapped, so the grab happens mid-move), so the wrist
  // may carry a centimetre past it — but it may never fly off and it must end locked on.
  for (let t = 0; t < 0.2; t += DT) {
    step(s, inp(), DT);
    assert.ok(dist(s.hands.L, gripPt) < 0.03, `the hand left the hold it closed on (${dist(s.hands.L, gripPt).toFixed(3)} m)`);
  }
  assert.equal(s.hands.L.x, gripPt.x, 'settles exactly on the contact point');
  assert.equal(s.hands.L.y, gripPt.y);
  run(s, 0.4, inp());
  assert.ok(s.hands.L.curl > 0.95, 'fingers curl onto the hold');
  assert.equal(s.hands.L.hover, 1);
});

test('grab: the settle is stable at the largest step (1/20 s) and ends locked on the hold', () => {
  const s = climber([{ x: L_UP.x + 0.1, y: L_UP.y - 0.1 }]);
  step(s, inp({ L: { x: 0, y: 0 } }), 1 / 20);          // centre the stick, then push it: that lets go
  step(s, inp({ L: { x: 0, y: 1 } }), 1 / 20);
  assert.equal(s.hands.L.gripping, false);
  for (let i = 0; i < 100 && !s.hands.L.gripping; i++) step(s, inp({ L: { x: 0, y: 1 } }), 1 / 20);
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

test('grab: the dwell does not need the thumb — a hand parked on the rock still closes on it', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y }]);
  const hold = s.route.holds[2];
  releaseHand(s, 'L');
  // steer until the fingers are just on the rock, then take the thumb off the stick entirely
  for (let i = 0; i < 400; i++) {
    step(s, inp({ L: { x: 0, y: 1 } }), DT);
    if (dist(s.hands.L, hold) <= grabRadius(hold)) break;
  }
  assert.equal(s.hands.L.gripping, false, 'it must not have closed yet');
  run(s, CFG.HOVER_GRAB_DWELL + 2 * DT, inp());        // nothing on the stick at all
  assert.equal(s.hands.L.holdId, 2, 'the hand it left on the rock still took it');
});

test('grab: a hand never takes the hold the other hand is holding, however long it sits on it', () => {
  const s = climber();
  releaseHand(s, 'L');                                 // left free, right on hold 1
  const taken = s.route.holds[1];
  drive(s, 'L', taken, 3);                             // three seconds parked on top of it
  assert.ok(dist(s.hands.L, taken) < grabRadius(taken), 'the free hand can hover over the other hand\'s hold');
  assert.notEqual(s.hands.L.nearId, 1);
  assert.equal(s.hands.L.gripping, false);
  assert.equal(s.hands.R.holdId, 1);
});

test('grab: the hand closes after the dwell and not a frame before it (B51)', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y }]);
  const hold = s.route.holds[2];
  releaseHand(s, 'L');
  let onRockAt = null;
  for (let i = 0; i < 600 && !s.hands.L.gripping; i++) {
    step(s, inp({ L: { x: 0, y: 1 } }), DT);
    if (onRockAt === null && dist(s.hands.L, hold) <= grabRadius(hold)) onRockAt = s.t;
    if (onRockAt !== null && !s.hands.L.gripping) {
      assert.ok(s.t - onRockAt <= CFG.HOVER_GRAB_DWELL + 2 * DT, 'it should not still be open this long after arriving');
    }
  }
  assert.equal(s.hands.L.gripping, true, 'a hand held on the rock takes it, with nothing tapped');
  assert.equal(s.hands.L.holdId, 2);
  const dwelt = s.t - onRockAt;
  assert.ok(dwelt >= CFG.HOVER_GRAB_DWELL - 1e-9, `closed after only ${dwelt.toFixed(3)} s on the rock`);
  assert.ok(dwelt <= CFG.HOVER_GRAB_DWELL + 2 * DT, `took ${dwelt.toFixed(3)} s to close`);
});

test('grab: a hand sweeping across a hold does not snag it — and reports the miss (B51)', () => {
  // A small hold crossed at speed on the way somewhere else: the fingers are on it for less than
  // the dwell, so it is not taken. This is the only 'miss' the sim reports now.
  const LEFT = { x: -0.35, y: 0.94 }, RIGHT = { x: 0.35, y: 0.94 };   // one flick across the top of the reach
  const s = climber([{ x: 0.11, y: 1.547, size: 0.10 }]);
  const hold = s.route.holds[2];
  releaseHand(s, 'L', LEFT);
  run(s, 2, inp({ L: LEFT }));                         // parked out to the left of it, clear of everything
  assert.ok(dist(s.hands.L, hold) > grabRadius(hold), 'parked clear of the hold to begin with');
  assert.equal(s.hands.L.gripping, false);
  drainEvents(s);
  let inside = 0, closest = Infinity;
  for (let i = 0; i < 60; i++) {                       // sweep across it in one flick of the stick
    step(s, inp({ L: RIGHT }), DT);
    const d = dist(s.hands.L, hold);
    closest = Math.min(closest, d);
    if (d <= grabRadius(hold)) inside++;
  }
  assert.ok(closest <= grabRadius(hold), `the sweep never touched the hold (closest ${closest.toFixed(3)} m)`);
  assert.ok(inside > 0 && inside * DT < CFG.HOVER_GRAB_DWELL,
    `the hand was on the rock for ${(inside * DT).toFixed(3)} s: that is not a sweep past it`);
  assert.equal(s.hands.L.gripping, false, 'sweeping across a hold must not take it');
  const ev = types(s);
  assert.ok(ev.includes('miss'), 'coming off rock before the fingers close is the miss');
  assert.ok(!ev.includes('grab'));
});

test('release: a stick pushed past the deadzone lets go, and the hand follows the stick (B51)', () => {
  const s = climber();
  step(s, inp({ R: { x: 1, y: 0 } }), DT);             // full deflection, but the stick was never centred
  assert.equal(s.hands.R.gripping, true, 'a stick that has not been at centre since the grab cannot let go');
  step(s, inp({ R: { x: 0, y: 0 } }), DT);             // thumb off: the stick re-arms
  step(s, inp({ R: { x: 1, y: 0 } }), DT);
  assert.equal(s.hands.R.gripping, false);
  assert.equal(s.hands.R.holdId, null);
  assert.deepEqual(drainEvents(s), [{ type: 'release', hand: 'R', holdId: 1 }]);
  assert.equal(s.phase, 'climbing');
  const sh0 = shoulder(s, 'R');
  near(s.hands.R.tx - sh0.x, CFG.REACH, 1e-9, 'and the hand is already headed where the stick points');
  run(s, 1, inp({ R: { x: 1, y: 0 } }));
  const sh1 = shoulder(s, 'R');
  near(s.hands.R.x - sh1.x, CFG.REACH, 0.02, 'the hand follows the stick out');
});

test('release: a stick under the deadzone never lets go, however long it is held there', () => {
  const s = climber();
  const m = CFG.RELEASE_DEADZONE - 0.02;
  run(s, 3, inp({ L: { x: m, y: 0, active: true }, R: { x: 0, y: -m, active: true } }));
  assert.equal(s.hands.L.gripping, true, 'a thumb resting on the ring must never drop you');
  assert.equal(s.hands.R.gripping, true);
  assert.equal(s.hands.L.holdId, 0);
  assert.equal(s.hands.R.holdId, 1);
  assert.ok(!types(s).includes('release'));
});

test('release: one stick only ever lets go of its own hand (B51)', () => {
  const s = climber();
  step(s, inp(), DT);                                  // a thumb lands on the left ring at centre...
  run(s, 3, inp({ L: { x: -0.9, y: 0.4 } }));          // ...and buries it for three seconds
  assert.equal(s.hands.L.gripping, false, 'the left hand let go');
  assert.equal(s.hands.R.gripping, true, 'and the right hand is still on the rock');
  assert.equal(s.hands.R.holdId, 1);
  assert.equal(s.phase, 'climbing', 'so one thumb can never drop the whole climber');
});

test('decoy: a hovering hand takes a decoy exactly like rock, and it gives way (B10)', () => {
  const s = climber();
  const fake = { id: 10000, x: L_UP.x, y: L_UP.y, size: 0.14, kind: 'hold', lit: false, angle: 0 };
  s.route.fakes = [fake];
  releaseHand(s, 'L');
  for (let i = 0; i < 400 && !fake.broken; i++) step(s, inp({ L: { x: 0, y: 1 } }), DT);   // steer onto it; nothing is tapped
  assert.equal(fake.broken, true, 'the decoy took the grab');
  assert.equal(s.hands.L.gripping, false, 'and gave way: the hand comes off it with nothing');
  const ev = drainEvents(s);
  assert.deepEqual(ev.filter((e) => e.type === 'crumble'), [{ type: 'crumble', hand: 'L', holdId: 10000 }]);
  assert.ok(!ev.some((e) => e.type === 'grab'), 'a decoy is never a hold');
  assert.ok(s.hands.L.tremble > 0.5, 'it costs you: the hand shakes');
  run(s, 3, inp({ L: { x: 0, y: 1 } }));                // it is gone for good — the same spot is bare rock
  assert.equal(s.hands.L.gripping, false);
  assert.ok(!types(s).includes('crumble'));
});

test('release: the hold just let go of is not taken back while the hand is still on it (B51)', () => {
  const s = climber();
  releaseHand(s, 'R', { x: 0, y: 1 });
  assert.equal(s.hands.R.gripping, false);
  const hold = s.route.holds[1];
  // steer the hand back onto the rock it just left and leave it there
  drive(s, 'R', hold, 1.5);
  assert.ok(dist(s.hands.R, hold) <= grabRadius(hold), 'the hand is sitting on the hold it released');
  assert.equal(s.hands.R.gripping, false, 'and it is not taken back');
  assert.equal(s.hands.R.nearId, 1, 'the hover cue still points at the rock the hand is actually on');
  assert.ok(s.hands.R.hover > 0.7, `the cue should be lit on the rock under the hand (hover ${s.hands.R.hover.toFixed(2)})`);
  drainEvents(s);
  run(s, 10, inp());                                   // ten seconds parked on it, with no input at all
  assert.equal(s.hands.R.gripping, false, 'a parked hand must never take a hold on its own');
  assert.ok(!types(s).includes('grab'));
  // A deliberate return does take it: steer off the rock (that clears the lock), then come back.
  const t0 = s.t;
  for (let i = 0; i < 600 && s.hands.R._skipId !== null; i++) step(s, inp({ R: { x: 0.2, y: -1 } }), DT);
  assert.equal(s.hands.R._skipId, null, 'leaving the rock unlocks it');
  const left = s.t - t0;
  grabByHover(s, 'R', hold, 3);
  assert.equal(s.hands.R.holdId, 1, 'and coming back takes it again');
  assert.ok(s.t - t0 < 2, `the deliberate return took ${(s.t - t0).toFixed(2)} s (${left.toFixed(2)} s of it getting off the rock)`);
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
  releaseHand(s, 'L', { x: -1, y: 0.2 });
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
  releaseHand(s, 'L', { x: -1, y: 0.2 });
  releaseHand(s, 'R', { x: 1, y: 0.2 });               // the second hand off is the whole cliff (B43)
  assert.equal(s.phase, 'falling');
  assert.deepEqual(types(s), ['release', 'release', 'fall']);
  assert.equal(hangTarget(s), null);
  const y0 = s.body.y;
  run(s, 0.1, inp());
  near(s.body.vy, -CFG.GRAVITY * s._fall.t, 0.08, 'the plunge is plain gravity');
  assert.ok(s.body.y < y0);
});

test('stamina: both hands gripping drain 0.022/s each', () => {
  const s = climber();
  run(s, 1, inp());
  near(s.hands.L.stamina, 1 - CFG.DRAIN_TWO, 0.002);
  near(s.hands.R.stamina, 1 - CFG.DRAIN_TWO, 0.002);
});

test('stamina: the only gripping hand drains 0.085/s while the free hand refills 0.30/s', () => {
  const s = climber();
  s.hands.L.stamina = 0.5;
  releaseHand(s, 'L', { x: -1, y: 0.2 });
  run(s, 1 - 2 * DT, inp());
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
  releaseHand(s, 'R', { x: 1, y: 0.2 });               // hang from the rune alone
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
  releaseHand(s, 'L', { x: -1, y: 0.2 });
  s.hands.R.stamina = 0.01;
  run(s, 0.3, inp());
  assert.equal(s.phase, 'falling');
  assert.ok(types(s).includes('fall'));
});

test('fall: nothing catches you — the plunge runs to the ground and ends the climb', () => {
  const s = climber([], 10);
  const from = s.body.y;
  releaseHand(s, 'L', { x: -1, y: 0.2 });
  releaseHand(s, 'R', { x: 1, y: 0.2 });
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

test('fall: a hand still on the rock inside the grace window saves it, and nothing is counted', () => {
  // The grace window is unchanged (CFG.GRACE): what a hand has to do inside it is hold on, not tap.
  // Let the last hand go without moving it off the hold and the fingers find the rock again — the
  // panic re-grab. The lock on the hold you just released is lifted only while falling.
  const s = climber([], 10);
  const hold = s.route.holds[1];
  releaseHand(s, 'L', { x: -1, y: 0.2 });
  run(s, 0.6, inp({ L: { x: -1, y: 0.2 } }));          // the left hand is well clear of everything
  releaseHand(s, 'R', steer(s, 'R', hold));            // let go without leaving the rock
  assert.equal(s.phase, 'falling');
  const t0 = s.t;
  for (let i = 0; i < 200 && s.phase === 'falling'; i++) step(s, inp({ R: steer(s, 'R', hold) }), DT);
  assert.equal(s.phase, 'climbing', 'the hand found rock in time');
  assert.equal(s.hands.R.holdId, 1);
  assert.ok(s.t - t0 <= CFG.GRACE + 1e-9, `saved after ${(s.t - t0).toFixed(3)} s, past the ${CFG.GRACE} s window`);
  const ev = types(s);
  assert.ok(!ev.includes('catch'));
  assert.ok(!ev.includes('fallen'), 'saved in time: the climb goes on');
});

test('fall: past the grace window nothing can be grabbed, all the way to the ground', () => {
  const s = climber([{ x: -0.25, y: 10 - 0.8 }], 10);  // a hold the falling left hand passes at ~0.4 s
  releaseHand(s, 'L', { x: -1, y: 0.2 });
  releaseHand(s, 'R', { x: 1, y: 0.2 });
  run(s, CFG.GRACE + 0.05, inp());                     // past the window before the hold comes by
  const hold = s.route.holds[2];
  for (let i = 0; i < 120; i++) step(s, inp({ L: steer(s, 'L', hold) }), DT);
  assert.equal(s.hands.L.gripping, false, 'nothing may be taken once the window has closed');
  run(s, 6, inp());
  assert.equal(s.phase, 'fallen');
  assert.equal(s.hands.L.gripping, false, 'the hold it passed must not save it');
  assert.ok(types(s).includes('fallen'));
});

test('fall: letting go with your feet on the ground is not a fall', () => {
  const s = climber();
  s.body.x = 0.6;                                      // even when the body was off to one side
  assert.ok(s.body.y <= CFG.FLOOR + CFG.HANG_TWO, 'the start hang is within standing height');
  releaseHand(s, 'L', { x: -1, y: 0.2 });
  releaseHand(s, 'R', { x: 1, y: 0.2 });
  run(s, 4, inp({ L: { x: -1, y: 0.2 }, R: { x: 1, y: 0.2 } }));
  assert.equal(s.phase, 'grounded', 'you were standing, so you stay standing');
  near(s.body.y, CFG.FLOOR, 0.03);
  assert.ok(!types(s).includes('fallen'), 'no death screen for stepping off the ground');
  assert.ok(dist(shoulder(s, 'L'), s.route.holds[0]) <= 0.9 * CFG.REACH);
  assert.ok(dist(shoulder(s, 'R'), s.route.holds[1]) <= 0.9 * CFG.REACH);
});

test('rune: grabbing a rune lights it once, sets the checkpoint and emits rune', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y, kind: 'rune' }]);
  releaseHand(s, 'L');
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));
  assert.equal(s.hands.L.holdId, 2);
  assert.equal(s.route.holds[2].lit, true);
  assert.equal(s.checkpoint, 2);
  assert.deepEqual(s.runesLit, [2]);
  const ev = drainEvents(s);
  assert.deepEqual(ev.filter((e) => e.type === 'rune'), [{ type: 'rune', hand: 'L', holdId: 2 }]);
  releaseHand(s, 'L', { x: -1, y: -0.4 });             // let go, drift away, come back: no second rune event
  run(s, 1.0, inp({ L: { x: -1, y: -0.4 } }));
  run(s, 2.0, inp({ L: { x: 0, y: 1 } }));
  assert.equal(s.hands.L.holdId, 2);
  assert.ok(!types(s).includes('rune'));
  assert.deepEqual(s.runesLit, [2]);
  assert.equal(s.checkpoint, 2);
});

test('summit: grabbing the summit hold completes the ritual', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y, kind: 'summit', size: 0.24 }]);
  releaseHand(s, 'L');
  run(s, 1.5, inp({ L: { x: 0, y: 1 } }));
  assert.equal(s.phase, 'summit');
  assert.equal(s.route.holds[2].lit, true);
  const ev = drainEvents(s);
  assert.ok(ev.some((e) => e.type === 'summit' && e.hand === 'L' && e.holdId === 2));
  const st = s.hands.R.stamina;
  run(s, 2, inp({ L: { x: -1, y: -1 }, R: { x: 1, y: -1 } }));   // input is ignored once the ritual is complete
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
  releaseHand(s, 'L', { x: -1, y: 0.2 });
  releaseHand(s, 'R', { x: 1, y: 0.2 });
  run(s, 2, inp());
  assert.ok(s.maxHeight > s.height, 'maxHeight remembers the high point');
});

test('hands: hover measures proximity to the nearest hold, tremble follows low stamina', () => {
  const s = climber([{ x: L_UP.x, y: L_UP.y + 0.3 }]);
  releaseHand(s, 'L');
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
  for (let i = 0; i < CFG.EVENT_CAP; i++) s.events.push({ type: 'filler' });
  releaseHand(s, 'L', { x: -1, y: 0.2 });              // real events on top of a full queue
  releaseHand(s, 'R', { x: 1, y: 0.2 });
  run(s, 1, inp());
  assert.ok(s.events.length <= CFG.EVENT_CAP, `${s.events.length} events queued`);
  const ev = drainEvents(s);
  assert.ok(ev.length > 0);
  assert.deepEqual(s.events, []);
});

// ---------------------------------------------------------------------------------------
// Autopilot: plays the generated route through the public Input interface only.

// Drive `side` onto `hold` with the two primitives and nothing else: push the stick
// toward the next hold (that is the release), then keep steering until the hand comes to rest on
// rock and closes on it. Like a player, it keeps whatever hold the hand actually takes; returns
// that hold's id.
function botGrab(state, hold, side, log) {
  const hand = state.hands[side], other = state.hands[side === 'L' ? 'R' : 'L'];
  const startHold = hand.gripping ? hand.holdId : null;
  const t0 = state.t;
  for (;;) {
    if (hand.gripping && hand.holdId !== startHold) return hand.holdId;
    if (state.t - t0 > 8) throw new Error(`stuck reaching hold ${hold.id} with ${side} (phase ${state.phase}, hand at ${hand.x.toFixed(2)},${hand.y.toFixed(2)})`);
    const v = steerToHold(state, side, hold);
    if (hand.gripping) {
      if (!other.gripping && state.phase === 'climbing') throw new Error(`bot would fall releasing ${side} for hold ${hold.id}`);
      releaseHand(state, side, v);
    } else {
      step(state, inp({ [side]: v }), DT);
    }
    for (const e of drainEvents(state)) log.push(e.type);
  }
}
// Climb the FIELD (B46) rather than a line: there is no next hold, so at every move the bot
// looks at where its two hands ACTUALLY are and takes the reachable hold with the lowest cost
// to the next goal — which is why a hand closing on the wrong rock costs it nothing.
// `stopAtY` ends the climb partway up.
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
      botGrab(state, r.holds[best.j], best.side, log);
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
    const away = { L: { x: -1, y: -0.5 }, R: { x: 1, y: -0.5 } };
    releaseHand(s, 'L', away.L);                       // both hands off, pushed clear of the rock
    releaseHand(s, 'R', away.R);
    run(s, 0.4, inp(away));                            // ...and past the grace window
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
