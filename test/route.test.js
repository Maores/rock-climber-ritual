import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRoute, intendedHand, ROUTE, SEEDS, DEFAULT_SEED, normalizeSeed } from '../src/route.js';
import { CFG, restingShoulder } from '../src/sim.js';

const route = generateRoute(7);
// runes sit at every multiple of RUNE_EVERY strictly below the summit; the summit gets the altar
const EXPECTED_RUNES = Math.ceil(ROUTE.TOP / ROUTE.RUNE_EVERY) - 1;
const H = route.holds;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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
});

test('route: every hold is within 0.9·REACH of the reaching hand\'s resting shoulder', () => {
  // Hold i is taken by intendedHand(i) while the other hand hangs alone from hold i-1.
  for (let i = 2; i < H.length; i++) {
    const sh = restingShoulder(H[i - 1], intendedHand(i));
    const d = dist(sh, H[i]);
    assert.ok(d <= 0.9 * CFG.REACH + 1e-9, `hold ${i} is ${d.toFixed(3)} m from the shoulder`);
  }
});

test('route: consecutive holds alternate sides within ±0.45 m and each move gains 4–23 cm', () => {
  let doubles = 0;
  for (let i = 2; i < H.length; i++) {
    const dx = H[i].x - H[i - 1].x, dy = H[i].y - H[i - 1].y;
    const sgn = intendedHand(i) === 'L' ? -1 : 1;
    assert.ok(Math.abs(dx) <= ROUTE.MAX_DX + 1e-9, `hold ${i} dx ${dx}`);
    assert.ok(sgn * dx >= 0.15 - 1e-9, `hold ${i} is not on its hand's side (dx ${dx})`);
    const ceiling = 0.9 * CFG.REACH - (CFG.HANG_ONE - CFG.SHOULDER_DY) + 1e-3;  // geometric max rise per move
    assert.ok(dy >= 0.04 && dy <= ceiling, `hold ${i} dy ${dy} > ceiling ${ceiling}`);
    if (dy < 0.1) doubles++;
  }
  assert.ok(doubles >= 3, `expected some near-level double holds for rests, found ${doubles}`);
});

test('route: regular moves spend nearly the whole reach (median gain ≥ 0.18 m), so the climb is ~210 moves', () => {
  // Stamina is a ~50 s time budget per rune segment under the frozen rates; tall moves are the
  // only lever the route has, so this locks the pacing in.
  const dys = [];
  for (let i = 2; i < H.length; i++) dys.push(H[i].y - H[i - 1].y);
  dys.sort((a, b) => a - b);
  assert.ok(dys[Math.floor(dys.length / 2)] >= 0.18, `median gain ${dys[Math.floor(dys.length / 2)]}`);
  assert.ok(H.length <= 230, `hold count ${H.length}`);
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

test('route: rune holds one RUNE_EVERY apart, near the center line', () => {
  const runes = H.filter((h) => h.kind === 'rune');
  assert.equal(runes.length, EXPECTED_RUNES);
  runes.forEach((r, k) => {
    assert.ok(Math.abs(r.y - ROUTE.RUNE_EVERY * (k + 1)) < 0.6, `rune ${k} at y ${r.y}`);
    assert.ok(Math.abs(r.x) <= 0.35, `rune ${k} at x ${r.x}`);
    assert.ok(r.size >= 0.2 - 1e-9, `rune ${k} size ${r.size}`);
  });
  for (let k = 1; k < runes.length; k++) {
    const gap = runes[k].y - runes[k - 1].y;
    assert.ok(Math.abs(gap - ROUTE.RUNE_EVERY) < 1, `rune spacing ${gap}`);
  }
});

test('route: the last hold is the summit at y≈24 and route.top matches it', () => {
  const last = H[H.length - 1];
  assert.equal(last.kind, 'summit');
  assert.ok(Math.abs(last.y - ROUTE.TOP) < 0.5);
  assert.ok(Math.abs(last.x) <= 0.5);
  assert.equal(route.top, last.y);
  assert.equal(H.filter((h) => h.kind === 'summit').length, 1);
  assert.ok(H.length > 80 && H.length < 160, `unexpected hold count ${H.length}`);
});

test('route: the line stays well inside the 9 m cliff', () => {
  for (const h of H) assert.ok(Math.abs(h.x) <= 2.2, `hold ${h.id} x ${h.x}`);
});

test('route: reachability, spacing, runes and summit hold for other seeds too', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const r = generateRoute(seed), hs = r.holds;
    for (let i = 2; i < hs.length; i++) {
      const sh = restingShoulder(hs[i - 1], intendedHand(i));
      assert.ok(dist(sh, hs[i]) <= 0.9 * CFG.REACH + 1e-9, `seed ${seed} hold ${i} unreachable`);
      assert.ok(hs[i].y > hs[i - 1].y, `seed ${seed} hold ${i} does not rise`);
    }
    for (let i = 0; i < hs.length; i++) {
      for (let j = i + 1; j < hs.length && hs[j].y - hs[i].y < 1.5; j++) {
        assert.ok(dist(hs[i], hs[j]) >= hs[i].size + hs[j].size + 0.02, `seed ${seed}: holds ${i}, ${j} overlap`);
      }
    }
    assert.equal(hs.filter((h) => h.kind === 'rune').length, EXPECTED_RUNES, `seed ${seed} runes`);
    assert.equal(hs[hs.length - 1].kind, 'summit');
    assert.ok(Math.abs(r.top - ROUTE.TOP) < 0.5);
  }
});

test('route: hold quality hardens with height, and the rests are always jugs', () => {
  const grips = H.filter((h) => h.kind === 'hold');
  const kinds = new Set(grips.map((h) => h.grip));
  assert.ok(kinds.size >= 3, `the wall should mix hold types, saw ${[...kinds].join(', ')}`);

  const low = grips.filter((h) => h.y < ROUTE.TOP * 0.35);
  const high = grips.filter((h) => h.y > ROUTE.TOP * 0.65);
  const hard = (set) => set.filter((h) => h.grip === 'crimp' || h.grip === 'sloper').length / Math.max(1, set.length);
  assert.ok(hard(high) > hard(low) + 0.1,
    `the top should be harder: ${(hard(low) * 100).toFixed(0)}% poor down low vs ${(hard(high) * 100).toFixed(0)}% up high`);

  for (const r of H.filter((h) => h.kind === 'rune' || h.kind === 'summit')) {
    assert.equal(r.grip, 'jug', 'a rest has to be a bucket');
  }
  // a crimp is visibly smaller than a jug, so the wall can be read before it is touched
  const avg = (k) => { const g = grips.filter((h) => h.grip === k); return g.reduce((a, h) => a + h.size, 0) / Math.max(1, g.length); };
  if (grips.some((h) => h.grip === 'crimp') && grips.some((h) => h.grip === 'jug')) {
    assert.ok(avg('crimp') < avg('jug') * 0.85, `crimps ${avg('crimp').toFixed(3)} vs jugs ${avg('jug').toFixed(3)}`);
  }
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

  const lines = SEEDS.map((r) => JSON.stringify(generateRoute(r.seed).holds.map((h) => [h.x, h.y])));
  assert.equal(new Set(lines).size, SEEDS.length, 'two routes on the roster are the same wall');
  for (const r of SEEDS) assert.equal(generateRoute(r.seed).seed, r.seed);
});
