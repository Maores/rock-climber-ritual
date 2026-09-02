// src/route.js — deterministic route generator for Rock Climber: The Ritual.
//
// The route is a single ~40 m line of holds. Hold i is meant for the left hand when i is
// even and for the right hand when i is odd (the two start holds are 0 = left, 1 = right),
// so the hands alternate all the way up. Every hold i ≥ 2 lies within 0.9·REACH of the
// shoulder the free hand has while the other hand hangs alone from hold i-1
// (sim.restingShoulder), which is exactly the position a player reaches from.
//
// Geometry note: with REACH 0.72, HANG_ONE 0.50 and SHOULDER_DY 0.08 a settled one-arm
// hang puts the free shoulder 0.42 m below the held hold, so the most a hold can rise
// above the previous one is 0.9·0.72 − 0.42 ≈ 0.23 m. The spec's 0.35–0.6 m moves are
// not reachable under the frozen constants; regular moves here gain 0.17–0.22 m, so the
// route has ~200 holds zig-zagging around a slowly wandering center line.
//
// Pacing note: stamina drains 0.20/s on the loaded hand and refills 0.18/s on the free one,
// so alternating hands loses ~0.01–0.02/s net whatever the speed — each rune-to-rune
// segment is a ~50 s time budget. Fewer, taller moves per segment is the only lever this
// module has; the generator therefore spends nearly the whole reach on every move.

import { CFG, restingShoulder } from './sim.js';

export const ROUTE = Object.freeze({
  TOP: 24,            // summit hold height (was 40: at the geometric 0.228 m per move that is
                      // ~210 grabs / ~12 min of climbing, too long for one sitting)
  RUNE_EVERY: 6,      // rune checkpoints near 6, 12, 18 m, then the summit altar
  START_Y: 1.2, START_DX: 0.25,
  MAX_DX: 0.45,       // horizontal change between consecutive holds
  MIN_DX: 0.23,       // consecutive holds alternate sides by at least this much (0.15 in a pinch)
  REACH_USE: 0.895,   // fraction of REACH the generator uses (just under the 0.9 guarantee; the hand itself
                      // reaches REACH and grabs within SNAP, so the player has ~0.23 m of slack on top)
  CLEAR: 0.03,        // rock left between neighbouring holds (center distance − both radii)
  CENTER_ZONE: 1.6,   // pull the line back to x = 0 this far below a rune or the summit
  PAIR_ZONE: 0.36,    // plan the approach hold and a big hold jointly from this far below it
  CEILING: 0.30,      // regular moves stop this far below a rune or the altar (inside PAIR_ZONE)
  X_LIMIT: 2.2,       // keep the line well inside the 9 m cliff
  SUMMIT_SIZE: 0.20,
});

export function intendedHand(holdId) {
  return holdId % 2 === 0 ? 'L' : 'R';
}

// mulberry32 — small, fast, deterministic.
function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rnd() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const OTHER = { L: 'R', R: 'L' };
const SIGN = { L: -1, R: 1 };

export function generateRoute(seed = 7) {
  const rnd = mulberry32(seed);
  const U = (lo, hi) => lo + (hi - lo) * rnd();
  const R = ROUTE;
  const RM = R.REACH_USE * CFG.REACH;
  const holds = [];

  const add = (x, y, size, kind) => {
    const h = { id: holds.length, x: r4(x), y: r4(y), size: r4(size), kind, lit: false, angle: r4(rnd() * Math.PI * 2) };
    holds.push(h);
    return h;
  };
  const recent = () => holds.slice(Math.max(0, holds.length - 8));
  // Largest size (≤ want) that leaves CLEAR rock between a hold at (x, y) and `others`;
  // null when even the smallest hold would touch one — the candidate is then rejected.
  const fitsAmong = (others, x, y, want) => {
    let s = want;
    for (const h of others) s = Math.min(s, Math.hypot(h.x - x, h.y - y) - h.size - R.CLEAR);
    return s >= 0.10 ? s : null;
  };
  const fits = (x, y, want) => fitsAmong(recent(), x, y, want);
  // Highest point reachable at horizontal position x from shoulder sh, at reach r.
  const yAt = (sh, x, r) => { const ox = x - sh.x; return Math.abs(ox) <= r ? sh.y + Math.sqrt(r * r - ox * ox) : -Infinity; };
  const xRange = (p) => [Math.max(p.x - R.MAX_DX, -R.X_LIMIT), Math.min(p.x + R.MAX_DX, R.X_LIMIT)];

  // Every legal single move for `side` from `prev`: on the hand's own side, gaining ≥ 6 cm,
  // clearing the neighbours, and below `ceiling`. Returns [{x, y, size}] (size ≤ want).
  const candidates = (prev, side, want, ceiling, minDx) => {
    const sgn = SIGN[side], sh = restingShoulder(prev, side);
    const [lo, hi] = xRange(prev);
    const out = [];
    for (let x = lo; x <= hi + 1e-9; x += 0.01) {
      if (sgn * (x - prev.x) < minDx) continue;
      const y = Math.min(yAt(sh, x, RM), ceiling);
      if (y - prev.y < 0.06) continue;
      const size = fits(x, y, want);
      if (size !== null) out.push({ x, y, size });
    }
    return out;
  };

  // The approach hold (small, this hand) and a big hold (other hand) planned together, so
  // the big one gets its full size as close to the center line as reach allows.
  // bigY(sh2, x2) gives the big hold's height; null when no pair fits.
  const planPair = (prev, side, bigWant, bigY) => {
    const sgn = SIGN[side], sh = restingShoulder(prev, side);
    const [lo, hi] = xRange(prev);
    let best = null;
    for (let x1 = lo; x1 <= hi + 1e-9; x1 += 0.01) {
      if (sgn * (x1 - prev.x) < 0.15) continue;
      for (const f of [1.0, 0.96, 0.92, 0.88]) {
        const y1 = yAt(sh, x1, RM * f);
        if (y1 - prev.y < 0.06 || fits(x1, y1, 0.10) === null) continue;
        const h1 = { x: x1, y: y1, size: 0.10 };
        const sh2 = restingShoulder(h1, OTHER[side]);
        const [lo2, hi2] = xRange(h1);
        for (let x2 = lo2; x2 <= hi2 + 1e-9; x2 += 0.01) {
          const y2 = bigY(sh2, x2);
          if (!(y2 - y1 >= 0.08) || Math.hypot(x2 - sh2.x, y2 - sh2.y) > RM) continue;
          if (fitsAmong([...recent(), h1], x2, y2, bigWant) !== bigWant) continue;
          if (best === null || Math.abs(x2) < Math.abs(best.x2)) best = { x1, y1, x2, y2 };
        }
      }
    }
    return best;
  };

  // Last resort for a big hold when no pair fits: the reachable spot with the most clearance.
  const bestEffort = (prev, side, want, bigY) => {
    const sh = restingShoulder(prev, side);
    const [lo, hi] = xRange(prev);
    let bx = sh.x, by = yAt(sh, sh.x, RM), bs = 0;
    for (let x = lo; x <= hi + 1e-9; x += 0.01) {
      const y = bigY(sh, x);
      if (!(y - prev.y >= 0.06) || Math.hypot(x - sh.x, y - sh.y) > RM) continue;
      const s = fits(x, y, want) ?? 0.10;
      if (s > bs || (s === bs && Math.abs(x) < Math.abs(bx))) { bs = s; bx = x; by = y; }
    }
    return { x: bx, y: by, size: bs || 0.10 };
  };

  add(-R.START_DX, R.START_Y, 0.16, 'hold');
  add(R.START_DX, R.START_Y, 0.16, 'hold');

  let prev = holds[1];
  let nextRune = R.RUNE_EVERY;
  let sinceDouble = 0;
  let center = 0;                 // the line's wandering center

  for (let guard = 0; guard < 4000 && prev.kind !== 'summit'; guard++) {
    const side = intendedHand(holds.length);
    const sgn = SIGN[side];
    const sh = restingShoulder(prev, side);
    const toTop = R.TOP - prev.y;
    const runeAhead = nextRune < R.TOP - 1;
    const toRune = runeAhead ? nextRune - prev.y : Infinity;
    const centering = toTop < R.CENTER_ZONE || toRune < R.CENTER_ZONE;

    // --- finish: the approach hold and the altar at exactly TOP, planned together -------
    if (toTop <= R.PAIR_ZONE) {
      const pair = planPair(prev, side, R.SUMMIT_SIZE, () => R.TOP);
      if (pair) {
        add(pair.x1, pair.y1, 0.10, 'hold');
        add(pair.x2, R.TOP, R.SUMMIT_SIZE, 'summit');
        break;
      }
      if (R.TOP - sh.y <= RM) {            // no pair fits: the altar with the most clearance we can get
        const b = bestEffort(prev, side, R.SUMMIT_SIZE, () => R.TOP);
        add(b.x, R.TOP, b.size, 'summit');
        break;
      }
      // Altar still out of reach: creep up to the highest legal spot and plan again.
      const c = candidates(prev, side, 0.10, R.TOP - 0.19, 0.15);
      if (c.length) {
        const h = c.reduce((a, b) => (b.y > a.y ? b : a));
        prev = add(h.x, h.y, 0.10, 'hold');
      } else {                             // last resort (unchecked spacing)
        const [lo, hi] = xRange(prev);
        const x = clamp(prev.x + sgn * 0.15, lo, hi);
        prev = add(x, Math.min(yAt(sh, x, RM), R.TOP - 0.19), 0.10, 'hold');
      }
      continue;
    }

    // --- rune: the approach hold and a big rest hold near the center, planned together --
    if (runeAhead && toRune <= R.PAIR_ZONE) {
      const want = r4(U(0.20, 0.22));
      const runeY = (sh2, x2) => yAt(sh2, x2, RM * 0.97);
      const pair = planPair(prev, side, want, runeY);
      if (pair) {
        add(pair.x1, pair.y1, 0.10, 'hold');
        prev = add(pair.x2, pair.y2, want, 'rune');
      } else {
        const b = bestEffort(prev, side, want, runeY);
        prev = add(b.x, b.y, b.size, 'rune');
      }
      nextRune += R.RUNE_EVERY;
      sinceDouble++;
      continue;
    }

    // Wander the center line, pulling it home ahead of runes and the altar.
    center = centering ? center * 0.5 : clamp(center + U(-0.12, 0.12) - 0.08 * center, -0.6, 0.6);

    // Regular moves stop short of a rune or the altar so the pair planner takes over.
    const ceiling = Math.min(R.TOP - R.CEILING, runeAhead ? nextRune - R.CEILING : Infinity);

    // --- double: a matching hold barely higher, for a symmetric two-hand rest ----------
    if (sinceDouble >= 7 && !centering && toTop > 3 && rnd() < 0.15) {
      const [lo, hi] = xRange(prev);
      const x = clamp(prev.x + sgn * U(0.38, 0.45), lo, hi);
      const y = Math.min(prev.y + U(0.05, 0.09), yAt(sh, x, RM), ceiling);
      const want = r4(U(0.15, 0.18));
      if (y > prev.y && fits(x, y, want) === want) {
        prev = add(x, y, want, 'hold');
        sinceDouble = 0;
        continue;
      }
    }

    // --- regular move: zig-zag around the center line, always gaining height ---------
    // Tall moves matter: stamina is a time budget per rune segment (see the header), so every
    // regular move uses nearly the whole reach and a narrow zig-zag (a hold straight above the
    // free shoulder gains the most). The wandering center line keeps the route from looking
    // like a ladder.
    const sizeCap = toRune < 0.7 ? 0.10 : 0.15;
    let pick = null;
    for (let tries = 0; tries < 8 && !pick; tries++) {
      const amp = centering ? 0.16 : U(0.115, 0.185);
      let dx = clamp(center + sgn * amp - prev.x, -R.MAX_DX, R.MAX_DX);
      dx = sgn * clamp(sgn * dx, R.MIN_DX, R.MAX_DX);          // alternate sides, always
      const [lo, hi] = xRange(prev);
      const x = clamp(prev.x + dx, lo, hi);
      let y = yAt(sh, x, RM * U(0.975, 1.0));
      if (y - prev.y < 0.08) y = yAt(sh, x, RM);
      y = Math.min(y, ceiling);
      if (y - prev.y < 0.06) continue;
      const size = fits(x, y, U(0.10, sizeCap));
      if (size !== null) pick = { x, y, size };
    }
    if (!pick) {                       // the target spot is taken: any legal spot on the arc
      let c = candidates(prev, side, U(0.10, sizeCap), ceiling, R.MIN_DX);
      if (!c.length) c = candidates(prev, side, 0.10, ceiling, 0.15);
      if (c.length) pick = c[Math.floor(rnd() * c.length)];
    }
    if (!pick) {                       // cannot happen with these constants; keep rising anyway
      const [lo, hi] = xRange(prev);
      const x = clamp(prev.x + sgn * R.MAX_DX, lo, hi);
      pick = { x, y: Math.max(prev.y + 0.06, Math.min(yAt(sh, x, RM), ceiling)), size: 0.10 };
    }
    prev = add(pick.x, pick.y, pick.size, 'hold');
    sinceDouble++;
  }

  const summit = holds[holds.length - 1];
  return { holds, top: summit.y, seed };
}
