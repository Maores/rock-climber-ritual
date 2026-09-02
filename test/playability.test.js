// test/playability.test.js — guards against the game quietly becoming unplayable.
//
// These are the numbers that turned the climb into a fight once already: targets shrank to 11%
// of the reach circle while the hand slowed down, and the result was miserable without a single
// unit test failing. Each assertion here is a floor on how hard the game may get.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, createClimber, startClimb, step, drainEvents, shoulder, grabRadius } from '../src/sim.js';
import { generateRoute, intendedHand, ROUTE, SEEDS, DEFAULT_SEED } from '../src/route.js';

const route = generateRoute(7);
const climbing = route.holds.filter((h) => h.kind === 'hold');

test('playability: every hold is a real target, not a pixel hunt', () => {
  for (const h of route.holds) {
    const frac = grabRadius(h) / CFG.REACH;
    assert.ok(frac >= 0.15, `hold ${h.id} (${h.grip}) is only ${(frac * 100).toFixed(1)}% of the reach circle`);
  }
});

test('playability: hard holds are harder than easy ones, but not by an absurd factor', () => {
  const r = climbing.map(grabRadius);
  const ratio = Math.max(...r) / Math.min(...r);
  assert.ok(ratio > 1.25, `holds barely differ (${ratio.toFixed(2)}x): the wall has no texture`);
  assert.ok(ratio < 2.6, `holds differ too wildly (${ratio.toFixed(2)}x): the small ones will feel broken`);
});

test('playability: the hand answers quickly enough to feel connected', () => {
  const move = 2.3 / CFG.HAND_OMEGA;             // ~90% of a move
  assert.ok(move < 0.30, `a hand takes ${move.toFixed(2)} s to move: that reads as lag`);
  assert.ok(move > 0.08, `a hand takes ${move.toFixed(2)} s: that is a teleport, not an arm`);
  assert.ok(CFG.HAND_ZETA >= 0.95, 'the hand must not overshoot where it was aimed');
});

test('playability: you can hang long enough to think', () => {
  for (const [name, q] of Object.entries(CFG.HOLD_KINDS)) {
    const oneArm = 1 / (CFG.DRAIN_ONE * q.drain);
    assert.ok(oneArm >= 5, `${name}: only ${oneArm.toFixed(1)} s on one arm`);
    if (q.slip) assert.ok(q.slip >= 6, `${name} slips after ${q.slip} s, too soon to plan a move`);
  }
});

// The two primitives of the control model (B51), the same pair the sim tests use: there are no
// buttons, so a hand lets go when its own stick is pushed past CFG.RELEASE_DEADZONE and a free
// hand takes rock by hovering over it for CFG.HOVER_GRAB_DWELL.
const DT = 1 / 120;
const inp = (o = {}) => ({ L: { x: 0, y: 0 }, R: { x: 0, y: 0 }, holdR: false, ...o });
function steerToHold(state, side, hold) {
  const sh = shoulder(state, side);
  const v = { x: (hold.x - sh.x) / CFG.REACH, y: (hold.y - sh.y) / CFG.REACH };
  const m = Math.hypot(v.x, v.y);
  if (m > 1) { v.x /= m; v.y /= m; }
  return v;
}
// A beat at the centre (a thumb lifting off does this by itself), then one frame of full
// deflection toward `dir`: that push is the release, and it already aims the reach.
function releaseHand(state, side, dir = { x: 0, y: 1 }) {
  const m = Math.hypot(dir.x, dir.y) || 1;
  step(state, inp({ [side]: { x: 0, y: 0 } }), DT);
  step(state, inp({ [side]: { x: dir.x / m, y: dir.y / m } }), DT);
}

// The real check: a steady, human-paced bot has to get up the whole thing.
function botClimb(state) {
  const H = state.route.holds;
  let grabs = 0, misses = 0, falls = 0;
  const count = () => {
    // With the rope gone (B43) there is no fallCount to read, and counting the event is the
    // stronger guard anyway: it fires even for a slip the grace window recovers. A 'miss' is now
    // a hand that came off rock before the fingers closed on it — the same thing the HUD shakes on.
    for (const e of drainEvents(state)) { if (e.type === 'miss') misses++; else if (e.type === 'fall') falls++; }
  };
  for (let i = 2; i < H.length;) {
    const side = intendedHand(i), hand = state.hands[side], hold = H[i];
    const startHold = hand.holdId, t0 = state.t;
    for (;;) {
      if (hand.gripping && hand.holdId !== startHold) break;
      if (state.t - t0 > 8) return { stuck: i, grabs, misses, falls, t: state.t };
      const v = steerToHold(state, side, hold);
      if (hand.gripping) releaseHand(state, side, v);   // push toward the next hold: that is letting go
      else step(state, inp({ [side]: v }), DT);         // then keep steering; the dwell does the grab
      count();
    }
    grabs++;
    i = hand.holdId >= i ? hand.holdId + 1 : i;
  }
  return { stuck: null, grabs, misses, falls, t: state.t };
}

test('playability: a steady climber tops out, and it does not take all afternoon', () => {
  const s = createClimber(generateRoute(7));
  startClimb(s);
  drainEvents(s);
  const out = botClimb(s);
  assert.equal(out.stuck, null, `stuck trying to reach hold ${out.stuck}`);
  assert.equal(s.phase, 'summit', `ended in ${s.phase}`);
  assert.equal(out.falls, 0, 'a steady rhythm should never fall');
  assert.ok(out.t < 420, `the climb took ${(out.t / 60).toFixed(1)} min of game time`);
  assert.ok(out.t > 30, `the climb took only ${out.t.toFixed(0)} s: something is skipping the route`);
  assert.ok(out.misses < out.grabs * 0.35,
    `${out.misses} misses over ${out.grabs} grabs: aiming at a hold should usually land it`);
});

// B13: the title screen offers more than one line. A seed that stops being climbable must fail
// here rather than reach a player, so every seed on the roster goes through the same bot.
test('playability: every route the title screen offers can be topped out', () => {
  for (const { seed, name } of SEEDS) {
    const r = generateRoute(seed);
    const at = `${name} (seed ${seed})`;
    for (const h of r.holds) {
      assert.ok(grabRadius(h) / CFG.REACH >= 0.15,
        `${at}: hold ${h.id} is only ${(grabRadius(h) / CFG.REACH * 100).toFixed(1)}% of the reach circle`);
    }
    const s = createClimber(generateRoute(seed));
    startClimb(s);
    drainEvents(s);
    const out = botClimb(s);
    assert.equal(out.stuck, null, `${at}: stuck trying to reach hold ${out.stuck}`);
    assert.equal(s.phase, 'summit', `${at}: ended in ${s.phase}`);
    assert.equal(out.falls, 0, `${at}: a steady rhythm should never fall`);
    assert.ok(out.t < 420, `${at}: the climb took ${(out.t / 60).toFixed(1)} min of game time`);
    assert.ok(out.t > 30, `${at}: the climb took only ${out.t.toFixed(0)} s`);
    assert.ok(out.misses < out.grabs * 0.35,
      `${at}: ${out.misses} misses over ${out.grabs} grabs`);
  }
});

test('playability: the roster is a real menu — unique seeds, named, and the default is on it', () => {
  assert.ok(SEEDS.length >= 2, 'one route is not a choice');
  const seeds = SEEDS.map((r) => r.seed);
  assert.equal(new Set(seeds).size, seeds.length, 'duplicate seed on the roster');
  assert.ok(seeds.includes(DEFAULT_SEED), 'the default route must be offered too');
  for (const r of SEEDS) {
    assert.ok(Number.isInteger(r.seed) && r.seed >= 1, `seed ${r.seed} is not a usable seed`);
    assert.ok(typeof r.name === 'string' && r.name.length > 0 && r.name.length <= 12, `name ${r.name}`);
    assert.ok(typeof r.note === 'string' && r.note.length > 0, `seed ${r.seed} has no description`);
  }
});
