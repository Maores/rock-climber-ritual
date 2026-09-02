// test/playability.test.js — guards against the game quietly becoming unplayable.
//
// These are the numbers that turned the climb into a fight once already: targets shrank to 11%
// of the reach circle while the hand slowed down, and the result was miserable without a single
// unit test failing. Each assertion here is a floor on how hard the game may get.
//
// B46 made the wall a FIELD, and that changed what this file has to prove. Walking the holds in
// id order used to be the climb; on a field, ids are only height order and walking them proves
// nothing. So there are two guards now, and they are independent on purpose:
//
//   1. CONNECTIVITY, pure graph, no simulation and no control model at all. Start → every rune →
//      the altar, under the reach rule and the alternating hands, for every seed the game offers
//      and for seeds 1-40. This is the one that catches a generator that quietly builds a field
//      with no way through it.
//   2. THE BOT, which path-finds over that same graph and drives the REAL sim, with every
//      threshold this file has always had.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, createClimber, startClimb, step, drainEvents, shoulder, grabRadius } from '../src/sim.js';
import { generateRoute, ROUTE, SEEDS, DEFAULT_SEED } from '../src/route.js';
import { reachGraph, inEdges, costToGoal, connectivity, stateKey, OTHER } from './climb-graph.js';

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

// ---------------------------------------------------------------------------------------
// 1. Connectivity — the field itself, with neither the sim nor the control model in the way.

test('playability: start, every rune and the altar are connected on every route offered', () => {
  for (const { seed, name } of SEEDS) {
    const r = generateRoute(seed);
    const c = connectivity(r);
    assert.ok(c.ok, `${name} (seed ${seed}): no way to reach hold ${c.failed}` +
      (c.failed === null ? '' : ` (${r.holds[c.failed].kind} at ${r.holds[c.failed].y.toFixed(1)} m)`));
  }
});

test('playability: and on every seed from 1 to 40, with the decoys taken out', () => {
  // A decoy is a hold LIFTED OUT of the field, so `route.holds` already IS the field without
  // them: this asserts B10's promise directly — no decoy is ever the only way past.
  const bad = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = generateRoute(seed);
    assert.equal(r.fakes.length, ROUTE.DECOYS, `seed ${seed}: ${r.fakes.length} decoys`);
    for (const f of r.fakes) assert.ok(!r.holds.some((h) => h.id === f.id), `seed ${seed}: decoy ${f.id} is still a hold`);
    if (!connectivity(r).ok) bad.push(seed);
  }
  assert.deepEqual(bad, [], `seeds with no way to the top: ${bad.join(', ')}`);
});

// ---------------------------------------------------------------------------------------
// 2. The bot.

// The two primitives of the control model (B51), the same pair the sim tests use: there are no
// buttons, so a hand lets go when its own stick is pushed past CFG.RELEASE_DEADZONE and a free
// hand takes rock by hovering over it for CFG.HOVER_GRAB_DWELL. Everything below them is route
// geometry — the path-finder never touches the sim except through these two.
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

// One move, as one gesture: push toward the hold (that is the release), keep steering, and the
// dwell closes the fingers. Like a player it keeps whatever the hand actually catches, and
// returns that hold's id.
function moveHand(state, side, hold, log) {
  const hand = state.hands[side];
  const startHold = hand.holdId, t0 = state.t;
  for (;;) {
    if (hand.gripping && hand.holdId !== startHold) return hand.holdId;
    if (state.t - t0 > 8) return null;
    const v = steerToHold(state, side, hold);
    if (hand.gripping) releaseHand(state, side, v);
    else step(state, inp({ [side]: v }), DT);
    // With the rope gone (B43) there is no fallCount to read, and counting the event is the
    // stronger guard anyway: it fires even for a slip the grace window recovers. A 'miss' is now
    // a hand that came off rock before the fingers closed on it — what the HUD shakes on.
    for (const e of drainEvents(state)) {
      if (e.type === 'miss') log.misses++;
      else if (e.type === 'fall') log.falls++;
      else if (e.type === 'crumble') log.crumbles++;
    }
  }
}

// A steady, human-paced climber that finds its own way up the field. It holds no route: at every
// move it looks at where its two hands actually are and takes the neighbour with the lowest cost
// to the next goal, which is why a hand closing on the wrong rock costs it nothing.
function botClimb(state) {
  const r = state.route;
  const graph = reachGraph(r);
  const inE = inEdges(graph);
  const goals = r.holds.filter((h) => h.kind === 'rune' || h.kind === 'summit').sort((a, b) => a.y - b.y);
  const log = { misses: 0, falls: 0, crumbles: 0 };
  let grabs = 0, offPlan = 0;

  for (const goal of goals) {
    const dist = costToGoal(r, graph, inE, goal.id);
    for (let move = 0; move < 400; move++) {
      const { L, R } = state.hands;
      if (L.holdId === goal.id || R.holdId === goal.id) break;
      // Either hand may move; the anchor is the other hand's hold. Take the cheaper option.
      let best = null;
      for (const side of ['L', 'R']) {
        const anchor = state.hands[OTHER[side]];
        if (!anchor.gripping) continue;
        for (const j of graph[anchor.holdId][side]) {
          if (j === anchor.holdId) continue;
          const d = dist[stateKey(j, OTHER[side])];
          if (d === Infinity) continue;
          if (!best || d < best.d) best = { side, j, d };
        }
      }
      if (!best) return { stuck: goal.id, grabs, offPlan, ...log, t: state.t };
      const got = moveHand(state, best.side, r.holds[best.j], log);
      if (got === null) return { stuck: best.j, grabs, offPlan, ...log, t: state.t };
      grabs++;
      if (got !== best.j) offPlan++;
    }
  }
  return { stuck: null, grabs, offPlan, ...log, t: state.t };
}

function assertClimb(seed, at) {
  const s = createClimber(generateRoute(seed));
  startClimb(s);
  drainEvents(s);
  const out = botClimb(s);
  assert.equal(out.stuck, null, `${at}: stuck trying to reach hold ${out.stuck}`);
  assert.equal(s.phase, 'summit', `${at}: ended in ${s.phase}`);
  assert.equal(out.falls, 0, `${at}: a steady rhythm should never fall`);
  assert.ok(out.t < 420, `${at}: the climb took ${(out.t / 60).toFixed(1)} min of game time`);
  assert.ok(out.t > 30, `${at}: the climb took only ${out.t.toFixed(0)} s: something is skipping the route`);
  assert.ok(out.misses < out.grabs * 0.35,
    `${at}: ${out.misses} misses over ${out.grabs} grabs: aiming at a hold should usually land it`);
  return out;
}

test('playability: a steady climber tops out, and it does not take all afternoon', () => {
  assertClimb(7, 'seed 7');
});

// B13: the title screen offers more than one line. A seed that stops being climbable must fail
// here rather than reach a player, so every seed on the roster goes through the same bot.
test('playability: every route the title screen offers can be topped out', () => {
  for (const { seed, name } of SEEDS) {
    const at = `${name} (seed ${seed})`;
    for (const h of generateRoute(seed).holds) {
      assert.ok(grabRadius(h) / CFG.REACH >= 0.15,
        `${at}: hold ${h.id} is only ${(grabRadius(h) / CFG.REACH * 100).toFixed(1)}% of the reach circle`);
    }
    assertClimb(seed, at);
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
