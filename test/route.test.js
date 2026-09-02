import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRoute, intendedHand, canReach, REACH_LINK, ROUTE, SEEDS, DEFAULT_SEED, normalizeSeed } from '../src/route.js';
import { CFG, restingShoulder } from '../src/sim.js';
import { reachGraph, connectivity } from './climb-graph.js';

const route = generateRoute(7);
// runes sit at every multiple of RUNE_EVERY strictly below the summit; the summit gets the altar
const EXPECTED_RUNES = Math.ceil(ROUTE.TOP / ROUTE.RUNE_EVERY) - 1;
const H = route.holds;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const SIDES = ['L', 'R'];

// Every hold above `h` that hand `side` (or either hand) could take from it.
const waysUp = (holds, h, side) => holds.filter((k) => k !== h && k.y > h.y + 0.05 &&
  (side ? canReach(h, k, side) : SIDES.some((s) => canReach(h, k, s))));

test('route: deterministic for a seed, different across seeds, default seed is 7', () => {
  assert.deepEqual(generateRoute(7), route);
  assert.deepEqual(generateRoute(), route);
  assert.notDeepEqual(generateRoute(8), route);
  assert.equal(route.seed, 7);
});

test('route: ids are sequential and the start holds sit at y≈1.2, x = ∓0.25', () => {
  H.forEach((h, i) => assert.equal(h.id, i));
  assert.deepEqual([H[0].x, H[0].y, H[0].kind], [-0.25, 1.2, 'hold']);
  assert.deepEqual([H[1].x, H[1].y, H[1].kind], [0.25, 1.2, 'hold']);
  for (const h of H) {
    assert.equal(h.lit, false);
    assert.ok(Number.isFinite(h.angle) && h.angle >= 0 && h.angle < 2 * Math.PI + 1e-9);
  }
  for (let i = 3; i < H.length; i++) assert.ok(H[i].y >= H[i - 1].y - 1e-9, `hold ${i} is out of height order`);
});

test('route: every hold has somewhere to go, within 0.9·REACH of the reaching shoulder', () => {
  // The field's version of the old line's rule. There is no "next hold" any more, so the
  // guarantee is: from any hold, some hold above it is inside the free hand's reach circle —
  // the disc of radius 0.9·REACH around restingShoulder(hold, thatHand). Only the altar is
  // exempt, because there is nothing above the altar.
  for (const h of H) {
    if (h.kind === 'summit') continue;
    const up = waysUp(H, h);
    assert.ok(up.length > 0, `hold ${h.id} (${h.x}, ${h.y}) is a dead end`);
    for (const k of up) {
      const s = SIDES.find((side) => canReach(h, k, side));
      const d = dist(restingShoulder(h, s), k);
      assert.ok(d <= 0.9 * CFG.REACH + 1e-9, `hold ${h.id} → ${k.id} is ${d.toFixed(3)} m from the shoulder`);
    }
  }
  assert.ok(Math.abs(REACH_LINK - 0.9 * CFG.REACH) < 1e-12, 'the exported link length must be the contract one');
});

test('route: most of the field has a way up for EACH hand, not just for one', () => {
  // The subtle one, and the reason B46 nearly shipped a wall nothing could climb. Hands
  // alternate, so you do not get to choose which one is free when you arrive: a hold whose only
  // way up is a left-hand move stops a climber who gets there with the right hand free, and one
  // row of those cuts off everything above it. The generator builds every row for both hands;
  // the cull and the funnel then take some of that back, so this is a floor and not a promise —
  // the promise is the connectivity check in playability.test.js, which walks it hand by hand.
  //
  // A single line of holds would score ~0% here, which is what this is really watching for.
  let body = 0, twoSided = 0;
  for (const h of H) {
    if (h.kind === 'summit' || h.y > ROUTE.TOP - ROUTE.FUNNEL) continue;
    body++;
    if (SIDES.every((s) => waysUp(H, h, s).length)) twoSided++;
  }
  const frac = twoSided / body;
  assert.ok(frac >= 0.65, `only ${(frac * 100).toFixed(0)}% of the field can be climbed off with either hand`);
});

test('route: the field leaves real choices — several holds reachable from most positions', () => {
  const degrees = H.filter((h) => h.kind !== 'summit').map((h) => waysUp(H, h).length);
  degrees.sort((a, b) => a - b);
  const median = degrees[degrees.length >> 1];
  assert.ok(median >= 2, `median ${median} ways up: this is a line again, not a field`);
  const anyReach = H.map((h) => H.filter((k) => k !== h && SIDES.some((s) => canReach(h, k, s))).length);
  const meanReach = anyReach.reduce((a, b) => a + b, 0) / anyReach.length;
  assert.ok(meanReach >= 8, `${meanReach.toFixed(1)} holds within reach on average: too sparse to pick a path`);
});

test('route: the field is spread across the face, not a strip', () => {
  const xs = H.map((h) => h.x);
  assert.ok(Math.min(...xs) <= -ROUTE.SPREAD + 0.25, `field starts at x ${Math.min(...xs).toFixed(2)}`);
  assert.ok(Math.max(...xs) >= ROUTE.SPREAD - 0.25, `field ends at x ${Math.max(...xs).toFixed(2)}`);
  // and it is spread at every height, not just somewhere: the funnel into the altar is the
  // only place the face is allowed to narrow.
  for (let y = 3; y < ROUTE.TOP - ROUTE.FUNNEL; y += 2) {
    const band = H.filter((h) => Math.abs(h.y - y) < 1);
    const w = Math.max(...band.map((h) => h.x)) - Math.min(...band.map((h) => h.x));
    assert.ok(w > 5.0, `at y ${y} the field is only ${w.toFixed(2)} m wide`);
    assert.ok(band.length > 40, `at y ${y} there are only ${band.length} holds`);
  }
});

test('route: the climb is a climb — the shortest way up is 110 to 210 moves', () => {
  // The old line locked pacing with "every move spends nearly the whole reach". A field has no
  // fixed moves, so the same thing is said about the whole climb: rows near the geometric
  // maximum, so the cheapest path to the altar is neither a stroll nor an afternoon. Let ROW_DY
  // creep up and this fails as a stroll; let it collapse and it fails as an afternoon.
  const c = connectivity(route);
  assert.ok(c.ok, 'seed 7 has no way to the top');
  const gaps = [];
  for (const h of H) {
    const up = waysUp(H, h);
    if (up.length) gaps.push(Math.min(...up.map((k) => k.y - h.y)));
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1];
  assert.ok(median >= 0.13, `median rise per move ${median.toFixed(3)} m: the field has gone flat`);
  const moves = Math.ceil((ROUTE.TOP - ROUTE.START_Y) / median);
  assert.ok(moves >= 110 && moves <= 210, `the shortest way up is about ${moves} moves`);
});

test('route: sizes are 0.092–0.24 and no two holds overlap', () => {
  // crimps are deliberately smaller than jugs, but never so small they stop being a target
  for (const h of H) assert.ok(h.size >= 0.092 - 1e-9 && h.size <= 0.24 + 1e-9, `hold ${h.id} size ${h.size}`);
  for (let i = 0; i < H.length; i++) {
    for (let j = i + 1; j < H.length && H[j].y - H[i].y < 1.5; j++) {
      assert.ok(dist(H[i], H[j]) >= H[i].size + H[j].size + 0.02, `holds ${i} and ${j} overlap`);
    }
  }
});

test('route: rune holds one RUNE_EVERY apart, and they are buckets', () => {
  const runes = H.filter((h) => h.kind === 'rune');
  assert.equal(runes.length, EXPECTED_RUNES);
  runes.forEach((r, k) => {
    assert.ok(Math.abs(r.y - ROUTE.RUNE_EVERY * (k + 1)) < 0.6, `rune ${k} at y ${r.y}`);
    assert.ok(Math.abs(r.x) <= ROUTE.RUNE_X + 0.1, `rune ${k} at x ${r.x}`);
    assert.ok(r.size >= 0.2 - 1e-9, `rune ${k} size ${r.size}`);
    // a goal you cannot get onto or off is not a goal
    assert.ok(H.some((h) => h.y < r.y && SIDES.some((s) => canReach(h, r, s))), `rune ${k} cannot be taken from below`);
    assert.ok(waysUp(H, r).length > 0, `rune ${k} is a dead end`);
  });
  for (let k = 1; k < runes.length; k++) {
    const gap = runes[k].y - runes[k - 1].y;
    assert.ok(Math.abs(gap - ROUTE.RUNE_EVERY) < 1, `rune spacing ${gap}`);
  }
});

test('route: the last hold is the summit at y≈24, centred, and route.top matches it', () => {
  const last = H[H.length - 1];
  assert.equal(last.kind, 'summit');
  assert.ok(Math.abs(last.y - ROUTE.TOP) < 0.5);
  assert.ok(Math.abs(last.x) <= 0.5);
  assert.equal(route.top, last.y);
  assert.equal(H.filter((h) => h.kind === 'summit').length, 1);
  assert.ok(H.length > 900 && H.length < 3000, `unexpected hold count ${H.length}`);
});

test('route: the field stays inside the 9 m cliff', () => {
  for (const h of H) assert.ok(Math.abs(h.x) <= ROUTE.SPREAD + 1e-9, `hold ${h.id} x ${h.x}`);
  for (const f of route.fakes) assert.ok(Math.abs(f.x) <= ROUTE.SPREAD + 1e-9, `decoy ${f.id} x ${f.x}`);
});

test('route: decoys are lifted out of the field, are never a rest, and are spread up it', () => {
  const F = route.fakes;
  assert.equal(F.length, ROUTE.DECOYS);
  F.forEach((f, i) => {
    assert.equal(f.id, 10000 + i);
    assert.equal(f.kind, 'fake');
    assert.equal(f.lit, false);
    assert.ok(!H.some((h) => h.x === f.x && h.y === f.y), `decoy ${f.id} is also a hold`);
    assert.ok(f.size >= 0.092 - 1e-9, `decoy ${f.id} size ${f.size}`);
  });
  const ys = F.map((f) => f.y).sort((a, b) => a - b);
  assert.ok(ys[0] > ROUTE.START_Y + 1, 'a decoy right off the ground is a coin flip, not a trick');
  assert.ok(ys[ys.length - 1] < route.top - 1, 'no decoy on the altar approach');
  assert.ok(ys[ys.length - 1] - ys[0] > (route.top - ROUTE.START_Y) * 0.6, 'the decoys are all in one place');
  // B10's promise, checked as a promise: the field without them still goes to the top
  assert.ok(connectivity(route).ok, 'the field is not climbable once the decoys are taken out');
});

test('route: reachability, spacing, runes, decoys and the summit hold for other seeds too', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const r = generateRoute(seed), hs = r.holds;
    for (const h of hs) {
      if (h.kind === 'summit') continue;
      assert.ok(waysUp(hs, h).length > 0, `seed ${seed}: hold ${h.id} is a dead end`);
    }
    for (let i = 0; i < hs.length; i++) {
      for (let j = i + 1; j < hs.length && hs[j].y - hs[i].y < 1.5; j++) {
        assert.ok(dist(hs[i], hs[j]) >= hs[i].size + hs[j].size + 0.02, `seed ${seed}: holds ${i}, ${j} overlap`);
      }
    }
    assert.equal(hs.filter((h) => h.kind === 'rune').length, EXPECTED_RUNES, `seed ${seed} runes`);
    assert.equal(hs[hs.length - 1].kind, 'summit');
    assert.equal(r.fakes.length, ROUTE.DECOYS, `seed ${seed} decoys`);
    assert.ok(Math.abs(r.top - ROUTE.TOP) < 0.5);
  }
});

test('route: hold quality hardens with height, and the rests are always jugs', () => {
  const grips = H.filter((h) => h.kind === 'hold');
  const kinds = new Set(grips.map((h) => h.grip));
  assert.ok(kinds.size >= 3, `the wall should mix hold types, saw ${[...kinds].join(', ')}`);

  const hard = (set) => set.filter((h) => h.grip === 'crimp' || h.grip === 'sloper').length / Math.max(1, set.length);
  const low = grips.filter((h) => h.y < ROUTE.TOP * 0.35);
  const high = grips.filter((h) => h.y > ROUTE.TOP * 0.65);
  assert.ok(hard(high) > hard(low) + 0.1,
    `the top should be harder: ${(hard(low) * 100).toFixed(0)}% poor down low vs ${(hard(high) * 100).toFixed(0)}% up high`);
  // ...and it has to climb the whole way, not jump once: four bands, each poorer than the last.
  const bands = [0, 1, 2, 3].map((b) => hard(grips.filter((h) => h.y >= ROUTE.TOP * b / 4 && h.y < ROUTE.TOP * (b + 1) / 4)));
  for (let b = 1; b < 4; b++) {
    assert.ok(bands[b] > bands[b - 1], `band ${b} is ${(bands[b] * 100).toFixed(0)}% poor, band ${b - 1} was ${(bands[b - 1] * 100).toFixed(0)}%`);
  }

  for (const r of H.filter((h) => h.kind === 'rune' || h.kind === 'summit')) {
    assert.equal(r.grip, 'jug', 'a rest has to be a bucket');
  }
  // a crimp is visibly smaller than a jug, so the wall can be read before it is touched
  const avg = (k) => { const g = grips.filter((h) => h.grip === k); return g.reduce((a, h) => a + h.size, 0) / Math.max(1, g.length); };
  if (grips.some((h) => h.grip === 'crimp') && grips.some((h) => h.grip === 'jug')) {
    assert.ok(avg('crimp') < avg('jug') * 0.85, `crimps ${avg('crimp').toFixed(3)} vs jugs ${avg('jug').toFixed(3)}`);
  }
});

test('route: intendedHand is a side-of-the-face hint, not a rule', () => {
  // On a field there is no hand a hold is "meant" for — most can be taken by either — so the
  // export that main.js's debug autopilot still calls answers the one question a bare hold id
  // can answer: which side of the wall it is on. Nothing in sim.js or route.js reads it.
  for (const h of H) assert.equal(intendedHand(h.id, route), h.x <= 0 ? 'L' : 'R');
  assert.equal(intendedHand(0, route), 'L');            // start holds, one either side of centre
  assert.equal(intendedHand(1, route), 'R');
  assert.ok(['L', 'R'].includes(intendedHand(999999)));  // an id off the end still answers
});

test('route: ?seed= is parsed strictly, and each roster seed really is a different route', () => {
  assert.equal(normalizeSeed('19'), 19);
  assert.equal(normalizeSeed(19), 19);
  assert.equal(normalizeSeed('19.7'), 19);              // trunc, not round: 19.7 is still route 19
  assert.equal(normalizeSeed('abc'), DEFAULT_SEED);
  assert.equal(normalizeSeed(''), DEFAULT_SEED);
  assert.equal(normalizeSeed(null), DEFAULT_SEED);
  assert.equal(normalizeSeed(undefined), DEFAULT_SEED);
  assert.equal(normalizeSeed('0'), DEFAULT_SEED);        // 0 would fall back to the generator's own
  assert.equal(normalizeSeed('-4'), DEFAULT_SEED);
  assert.equal(normalizeSeed('100000'), DEFAULT_SEED);
  assert.equal(normalizeSeed(Infinity), DEFAULT_SEED);
  assert.equal(normalizeSeed('7'), 7);

  const fields = SEEDS.map((r) => JSON.stringify(generateRoute(r.seed).holds.map((h) => [h.x, h.y])));
  assert.equal(new Set(fields).size, SEEDS.length, 'two routes on the roster are the same wall');
  for (const r of SEEDS) assert.equal(generateRoute(r.seed).seed, r.seed);
});

test('route: the reach graph agrees with the generator about what is reachable', () => {
  // The tests must not simply believe route.js. reachGraph is built from canReach and the
  // contract's 0.9·REACH; this checks it against a plain O(n²) sweep of the same rule.
  const g = reachGraph(route);
  for (const h of H) {
    for (const s of SIDES) {
      const brute = H.filter((k) => k !== h && canReach(h, k, s)).map((k) => k.id).sort((a, b) => a - b);
      assert.deepEqual(g[h.id][s].slice().sort((a, b) => a - b), brute, `hold ${h.id} ${s}`);
    }
  }
});
