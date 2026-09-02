// src/route.js — deterministic route generator for Rock Climber: The Ritual.
//
// The wall is a FIELD of holds, not a line (B46). Maor played v0.5.0 on his phone and said the
// climb was "a straight weird path"; it was, by construction — the old generator walked one
// zig-zag of ~125 holds up a 1.4 m wide strip of a 9 m cliff and every hold was the only hold.
// Now the face is scattered with holds at climbable spacing and the player picks their own way
// through it. The runes and the summit altar are the only fixed points: they are the goals.
//
// THE REACH RULE (unchanged, and it is the whole geometry of this file). A hand hanging alone
// on hold H puts the OTHER hand's shoulder at sim.restingShoulder(H, freeSide) — 0.42 m below H
// and 0.14 m to the free hand's side. Anything within 0.9·REACH of that point is reachable, so
// from H the free hand owns a disc of radius 0.648 m centred 0.42 m below H. The most a hold can
// rise above H is 0.648 − 0.42 ≈ 0.228 m, and only straight above the shoulder; a hold 0.15 m
// higher can be 0.38 m to the side. That is why the field is a flat lattice — rows much closer
// together than columns — and why it cannot be made sparser without breaking the climb.
//
// The generator links at PLACE_USE·REACH rather than 0.9·REACH so every edge it relies on has
// ~3 cm of slack against the guarantee the tests assert.
//
// STRUCTURE
//   1. anchors      — the two start holds, one rune per RUNE_EVERY band, the summit altar
//   2. scatter      — a jittered staggered lattice grown row by row, each row finished so that
//                     every hold in the row below has a way up FOR EACH HAND
//   3. the rests    — a ladder under each rune and under the altar, which stands clear above
//                     the field's top row
//   4. repair       — a hold you cannot climb off is a trap: bridge it, or drop it. Walked from
//                     the top down, which is also what funnels the last metres into the altar
//   5. open the way — walk the field the way a climber does, tracking which hand is free, and
//                     open it wherever the walk cannot reach a goal
//   6. sizes        — grip kind from height (B8), size from grip, capped so nothing overlaps
//   7. decoys       — B10: field holds lifted OUT and turned to rock that gives way
//
// WHAT WAS TRIED AND DROPPED: blank slabs of featureless rock, to break the field up and halve
// the geometry. Under this reach rule a blank is a WALL — the hands alternate, so a hold whose
// only way up is a left-hand move stops a climber who arrives with the right hand free, and the
// bottom edge of a slab is made of exactly those. The repair that fixes it fills the slab in.
//
// Pacing note: stamina drains 0.085/s on the loaded hand and refills 0.30/s on the free one, so
// alternating hands is close to free. ROW_DY is kept near the geometric maximum, which puts the
// shortest way to the altar at ~150 moves — about the length the old single line was.

import { CFG, restingShoulder } from './sim.js';

export const ROUTE = Object.freeze({
  TOP: 24,            // summit altar height
  RUNE_EVERY: 6,      // rune checkpoints near 6, 12, 18 m, then the altar
  START_Y: 1.2, START_DX: 0.25,

  // --- the field ------------------------------------------------------------------------
  SPREAD: 3.6,        // holds cover x ∈ [−SPREAD, SPREAD] of the 9 m wall (was a 1.4 m strip)
  ROW_DY: 0.165,      // vertical pitch of the scatter's rows. Near the geometric optimum: rows
                      // further apart force columns closer together and cost MORE holds, not
                      // fewer, because the reach arc flattens as the move gets taller
  COL_DX: 0.72,       // horizontal pitch inside a row; every other row is offset by half of it,
                      // which is what gives each hold an up-left AND an up-right neighbour
  DRIFT: 0.02,       // how far a row may slide sideways from the row under it. The whole row
                      // moves together, so the lattice keeps its spacing while the field flows
  DRIFT_MAX: 0.55,    // ...and never slides further than this from the nominal column
  JITTER_X: 0.03,    // ± per-hold jitter. Small on purpose: two rows are only ROW_DY apart, so
  JITTER_Y: 0.008,    // free jitter would push neighbours into each other and tear holes
  THIN: 0.22,         // fraction of sites left as bare rock, for texture

  MIN_SEP: 0.28,      // room a scattered hold wants around it
  MIN_FIT: 0.245,     // ...and the room a REPAIR hold settles for: one squeezed in because a
                      // hold below it would otherwise have nowhere to go. Still legal rock:
                      // the size pass shrinks both to fit
  FUNNEL: 2.2,        // the last metres into the altar, where the face narrows to a point
  RUNE_SEP: 0.34,     // a rest keeps its bucket size, so its neighbours have to stand back
  CLEAR: 0.03,        // bare rock left between two hold rims

  REACH_USE: 0.9,     // the guarantee the tests assert: every link ≤ this fraction of REACH...
  PLACE_USE: 0.895,    // ...and the generator only ever builds links this long, for slack

  SIZE_MIN: 0.092,    // a crimp is a sliver, but never so small it stops being a target
  SIZE_MAX: 0.148,    // field holds stay under world.js's 0.15 detail step: 1000 holds of
                      // detail-5 geometry would not boot on a phone
  RUNE_SIZE: 0.205,   // rests are buckets
  RUNE_X: 2.0,        // how far off centre a rune may sit — this is most of a seed's character
  SUMMIT_SIZE: 0.20,
  DECOYS: 8,          // B10
});

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const SIGN = { L: -1, R: 1 };
export const SIDES = Object.freeze(['L', 'R']);

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

// ---------------------------------------------------------------------------------------
// The reach rule, as functions. Everything that has to agree about what "reachable" means —
// the generator, the route tests, the playability bot's path-finder — calls these.

// Longest link the guarantee allows, and the shorter one the generator actually builds with.
export const REACH_LINK = ROUTE.REACH_USE * CFG.REACH;
const PLACE_LINK = ROUTE.PLACE_USE * CFG.REACH;

// Can the hand `side` take `target` while the other hand hangs alone on `anchor`?
// This is the sim's own geometry: restingShoulder is where that free shoulder settles.
export function canReach(anchor, target, side, limit = REACH_LINK) {
  const sh = restingShoulder(anchor, side);
  return Math.hypot(target.x - sh.x, target.y - sh.y) <= limit + 1e-9;
}

// With a field there is no "intended" hand any more: most holds can be taken by either.
// The export stays because main.js's debug autopilot calls it, and it answers the only
// question still worth asking of a bare hold id — which side of the face the hold sits on.
// It is a hint, not a rule; nothing in the sim or the generator depends on it.
let lastRoute = null;
export function intendedHand(holdId, route = lastRoute) {
  const h = route && route.holds && route.holds[holdId];
  if (!h) return holdId % 2 === 0 ? 'L' : 'R';     // no route to ask: fall back to the old parity
  return h.x <= 0 ? 'L' : 'R';
}

// ---------------------------------------------------------------------------------------
// The roster. Generation is deterministic per seed and every seed from 1 to 40 goes through the
// graph-connectivity check in test/playability.test.js, so this list is a choice of character
// and not of validity.
//
// HONEST NOTE, v0.6.0: the four seeds barely differ any more. On the old single line a seed
// decided every hold, so seeds really were different climbs — 42 jugs here, 31 crimps there.
// A field is ~1900 holds drawn from the same height-based distribution, and the law of large
// numbers flattens it: measured across the roster the grip mix is within 2% and poor rock up
// high is 50-52% on all four. The one thing a seed still decides is WHERE THE THREE RUNES SIT,
// and so how far across the face a climb has to travel. The notes below say only that, because
// that is all that is true. Giving the seeds real character back needs the generator to vary
// per seed (density, spread, how fast the rock hardens) — a design call, not a description.
export const SEEDS = Object.freeze([
  Object.freeze({ seed: 7, name: 'Ritual', note: 'Runes left, right, left: 7.7 m of traverse' }),
  Object.freeze({ seed: 21, name: 'Ladder', note: 'Runes right, left, right: the shortest zig-zag but the widest last one' }),
  Object.freeze({ seed: 4, name: 'Serpent', note: 'Two runes on the right, then one long crossing to the last: 5.7 m, the least travel' }),
  Object.freeze({ seed: 19, name: 'Ordeal', note: 'Starts hard left at 2.0 m off centre: 8.5 m of traverse, the widest climb' }),
]);

export const DEFAULT_SEED = 7;

// A seed from outside the game (the ?seed= parameter). Anything unparseable is the default.
export function normalizeSeed(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 9999 ? n : DEFAULT_SEED;
}

// ---------------------------------------------------------------------------------------

export function generateRoute(seed = 7) {
  const rnd = mulberry32(seed);
  const U = (lo, hi) => lo + (hi - lo) * rnd();
  const R = ROUTE;
  const FIELD_TOP = R.TOP - 0.32;              // the scatter stops here; the altar sits above it

  // A uniform grid over the face, so placement and the reach graph never go quadratic.
  const CELL = 0.8;
  let grid = new Map();
  const cellKey = (cx, cy) => cx * 100000 + cy;
  const index = (list) => {
    grid = new Map();
    for (const h of list) {
      const k = cellKey(Math.floor(h.x / CELL), Math.floor(h.y / CELL));
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push(h);
    }
  };
  // Every hold whose centre is within `r` of (x, y).
  const within = (x, y, r) => {
    const out = [];
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const y0 = Math.floor((y - r) / CELL), y1 = Math.floor((y + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const a = grid.get(cellKey(cx, cy));
        if (!a) continue;
        for (const h of a) if (Math.hypot(h.x - x, h.y - y) <= r) out.push(h);
      }
    }
    return out;
  };
  // Is (x, y) too close to rock already placed? `sep` is the room a new hold wants; a rest hold
  // always wants RUNE_SEP, because a rune keeps its bucket size and its neighbour has to fit
  // beside it. Nothing here is about looks: it is the no-overlap rule the size pass depends on.
  const blocked = (x, y, sep) => {
    for (const h of within(x, y, Math.max(sep, R.RUNE_SEP))) {
      const need = h.kind === 'hold' ? sep : R.RUNE_SEP;
      if (Math.hypot(h.x - x, h.y - y) < need) return true;
    }
    return false;
  };

  // --- 1. anchors ------------------------------------------------------------------------
  const holds = [];
  const push = (x, y, kind) => {
    const h = { id: holds.length, x: r4(x), y: r4(y), size: 0.12, grip: 'edge', kind, lit: false, angle: r4(rnd() * Math.PI * 2) };
    holds.push(h);
    return h;
  };
  const startL = push(-R.START_DX, R.START_Y, 'hold');
  const startR = push(R.START_DX, R.START_Y, 'hold');

  // Runes: one per RUNE_EVERY band, wandering across the face. Where they sit is most of what
  // separates one seed from another, because every path has to come to them.
  const runes = [];
  const runeCount = Math.ceil(R.TOP / R.RUNE_EVERY) - 1;
  let side = rnd() < 0.5 ? -1 : 1;
  for (let k = 1; k <= runeCount; k++) {
    if (rnd() < 0.7) side = -side;                       // usually the next rune is the other way
    const x = clamp(side * U(0.15, R.RUNE_X), -R.SPREAD + 0.4, R.SPREAD - 0.4);
    runes.push(push(x, R.RUNE_EVERY * k + U(-0.1, 0.1), 'rune'));
  }
  const summit = push(U(-0.2, 0.2), R.TOP, 'summit');

  // --- 2. the scatter, grown row by row ---------------------------------------------------
  // A staggered lattice on rows that slide sideways as they rise, so the field flows instead of
  // ruling itself into a pegboard, with each site jittered and one in THIN left as bare rock.
  // The slide moves a whole row at once: two rows are only ROW_DY apart, so anything that moves
  // holds relative to their neighbours immediately pushes them inside MIN_SEP.
  //
  // Rejection leaves gaps, so every row is finished by looking DOWN at the row below and adding
  // whatever holds are needed for each hold there to have somewhere to go. That is what makes
  // the field climbable everywhere rather than climbable on average.
  index(holds);
  const place = (x, y, kind = 'hold') => {
    const h = push(x, y, kind);
    const k = cellKey(Math.floor(h.x / CELL), Math.floor(h.y / CELL));
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(h);
    return h;
  };
  // Every hold above `h` that the hand `side` could take from it. Sides are tracked separately
  // because the climb alternates hands: arriving on a hold with the wrong hand free and no way
  // up for THAT hand is a dead end even when the other hand has three.
  const upLinks = (h, side) => {
    const out = [];
    for (const k of within(h.x, h.y - 0.42, PLACE_LINK + 0.15)) {
      if (k === h || k.y <= h.y + 0.05) continue;
      if (side ? canReach(h, k, side, PLACE_LINK)
        : (canReach(h, k, 'L', PLACE_LINK) || canReach(h, k, 'R', PLACE_LINK))) out.push(k);
    }
    return out;
  };
  // The best free spot at height `y` that `h` could climb to with hand `s`: as near as possible
  // to straight above that shoulder, where the move gains the most and reads best.
  const spotAbove = (h, s, y, sep) => {
    let best = null;
    const sh = restingShoulder(h, s);
    const dy = y - sh.y;
    if (dy <= 0 || dy > PLACE_LINK) return null;
    const half = Math.sqrt(PLACE_LINK * PLACE_LINK - dy * dy) * 0.96;
    for (let t = -1; t <= 1.0001; t += 0.08) {
      const x = sh.x + t * half;
      if (Math.abs(x) > R.SPREAD || blocked(x, y, sep)) continue;
      if (!best || Math.abs(t) < Math.abs(best.t)) best = { x, y, t };
    }
    return best;
  };

  const rows = Math.floor((FIELD_TOP - R.START_Y) / R.ROW_DY);
  let below = [startL, startR];
  let drift = 0;
  for (let k = 1; k <= rows; k++) {
    const y0 = R.START_Y + k * R.ROW_DY;
    drift = clamp(drift + U(-R.DRIFT, R.DRIFT) - 0.05 * drift, -R.DRIFT_MAX, R.DRIFT_MAX);
    const off = (k % 2) * (R.COL_DX / 2) + drift;
    // The row's sites, on a half-column sub-lattice: the whole columns are the field, the ones
    // between them are spares the repair below may call on. Everything the row ever places
    // comes off this list, which is what keeps the field ON the lattice — a repair that put a
    // hold between the columns would serve one hold, crowd out the sites the next row wanted,
    // and force more repairs there, and the field doubles itself row on row.
    const sites = [];
    for (let x0 = -R.SPREAD + off, n = 0; x0 <= R.SPREAD + 1e-9; x0 += R.COL_DX / 2, n++) {
      sites.push({
        x: clamp(x0 + U(-R.JITTER_X, R.JITTER_X), -R.SPREAD, R.SPREAD),
        y: y0 + U(-R.JITTER_Y, R.JITTER_Y),
        spare: n % 2 === 1,
        skip: rnd() < R.THIN,                            // bare rock, for texture
      });
    }
    const row = [];
    for (const st of sites) {
      if (st.spare || st.skip || blocked(st.x, st.y, R.MIN_SEP)) continue;
      st.used = true;
      row.push(place(st.x, st.y));
    }
    // Finish the row: no hold in the row below may be left with nowhere to climb — and it needs
    // one way up per HAND, because the climb alternates and you do not get to choose which hand
    // is free when you arrive. Two ways up also stop the deletions in step 4 running downhill.
    //
    // A site this row left out is always the first choice, whole column before spare.
    for (const h of below) {
      for (const s of SIDES) {
        if (upLinks(h, s).length) continue;
        const fits = (c) => !c.used && canReach(h, c, s, PLACE_LINK) && !blocked(c.x, c.y, R.MIN_FIT);
        const st = sites.find((c) => !c.spare && fits(c)) || sites.find(fits);
        if (st) { st.used = true; row.push(place(st.x, st.y)); continue; }
        const p = spotAbove(h, s, Math.max(y0, h.y + 0.07), R.MIN_FIT);
        if (p) row.push(place(p.x, p.y));
      }
    }
    below = row.length ? row : below;
  }

  // --- 3. the rests -----------------------------------------------------------------------
  // Runes and the altar are placed before the field, so nothing was fitted to them. Each needs
  // a seat underneath — a hold on the arc that reaches it — or it is a goal no path can touch.
  // The altar always needs a short ladder: it stands clear above the field's top row.
  const alive = (h) => !h._cull;
  const reached = (t, side) => holds.some((h) => h !== t && alive(h) && h.y < t.y - 0.05 &&
    canReach(h, t, side, PLACE_LINK));
  // Rock that stands in the way of a new hold at (x, y): anything nearer than the room the new
  // hold needs. A rest wants RUNE_SEP because it keeps its bucket size; anything else MIN_FIT.
  const inTheWay = (x, y) => within(x, y, R.RUNE_SEP).filter((k) => alive(k) &&
    Math.hypot(k.x - x, k.y - y) < (k.kind === 'hold' ? R.MIN_FIT : R.RUNE_SEP));
  // The highest free spot below `t` from which a hand could take it. It has to stand clear of
  // `t` itself: a seat tucked straight under a rune would be inside the rune's own rock.
  const seatUnder = (t, s) => {
    let best = null;
    // the set of holds from which hand `s` reaches t is a disc under t, mirrored by the side
    const cx = t.x - SIGN[s] * (CFG.SHOULDER_DX - CFG.SWAY), cy = t.y + (CFG.HANG_ONE - CFG.SHOULDER_DY);
    const rad = PLACE_LINK * 0.97;
    for (let a = -0.8; a <= 0.8001; a += 0.05) {
      const x = cx + Math.sin(a) * rad, y = cy - Math.cos(a) * rad;
      if (y >= t.y - 0.06 || Math.abs(x) > R.SPREAD) continue;
      const clash = inTheWay(x, y);
      if (clash.some((k) => k.kind !== 'hold' || k === t)) continue;   // never shove a rest
      const score = y - 0.3 * clash.length;
      if (!best || score > best.score) best = { x, y, score, clash };
    }
    return best;
  };
  const displace = (spot) => {
    for (const h of spot.clash) h._cull = true;
    if (spot.clash.length) {
      holds.splice(0, holds.length, ...holds.filter((h) => !h._cull));
      index(holds);
    }
    return place(spot.x, spot.y);
  };
  // Both hands have to be able to take a rest, not just one: you do not get to choose which
  // hand is free when you arrive under it. Each rung the ladder adds needs feeding in turn, so
  // the queue grows as it is walked.
  const needFeeding = [...runes, summit];
  for (let i = 0; i < needFeeding.length && i < 60; i++) {
    const t = needFeeding[i];
    if (!alive(t)) continue;
    for (const s of SIDES) {
      if (reached(t, s)) continue;
      const seat = seatUnder(t, s);
      if (seat) needFeeding.push(displace(seat));
    }
  }

  // --- 4. repair --------------------------------------------------------------------------
  // A hold you cannot climb off is a trap. This walks the face from the top DOWN, because a
  // hold that loses its last way up strands the hold under it and the deletions run downhill:
  // going top-down resolves a whole cascade in one pass instead of one row per pass.
  //
  // Losing the rock above you is usually not a reason to be deleted — it is a reason to be
  // given a bridge, in the space that just came free.
  //
  // The bridge: a spot on the top of `h`'s reach arc that can itself be climbed off, which is
  // what stops the two rules chasing each other. `shove` lets it push scattered rock aside and
  // is used only for a rune — a rune is a goal every path has to touch, and may not be deleted
  // for want of one hold above it.
  const bridgeAbove = (h, s, shove) => {
    let best = null;
    const sh = restingShoulder(h, s);
    const rad = PLACE_LINK * 0.97;
    for (let a = -0.8; a <= 0.8001; a += 0.05) {       // along the top of the reach arc
      const x = sh.x + Math.sin(a) * rad, y = sh.y + Math.cos(a) * rad;
      if (y <= h.y + 0.06 || Math.abs(x) > R.SPREAD) continue;
      const clash = inTheWay(x, y);
      if (clash.some((k) => k.kind !== 'hold' || k === h)) continue;
      if (clash.length && !shove) continue;
      // a bridge to nowhere is not a bridge: the new hold must be climbable off itself
      if (!upLinks({ x, y }).some((k) => alive(k) && !clash.includes(k))) continue;
      const score = y - 0.3 * clash.length;
      if (!best || score > best.score) best = { x, y, score, clash };
    }
    return best;
  };
  for (let pass = 0; pass < 10; pass++) {
    index(holds);
    let changed = 0;
    // Keeping a hold asks only for ONE way up. Two-sidedness is what the field is BUILT to
    // (the row repair above, and step 5 below), but it cannot be a survival rule: in the last
    // metres the face funnels to the altar and the top rows have one way up at best, so
    // demanding two there deletes the funnel and then the whole wall under it.
    for (const h of holds.slice().sort((a, b) => b.y - a.y)) {
      if (h._cull || h.kind === 'summit') continue;
      if (upLinks(h).some(alive)) continue;
      let fixed = false;
      for (const s of SIDES) {
        const p = bridgeAbove(h, s, h.kind === 'rune'); // a rune is a goal: it gets its bridge
        if (p) { displace(p); fixed = true; break; }
      }
      if (!fixed && h.kind !== 'rune') h._cull = true;  // a stranded rune stays, so the
      changed++;                                        // connectivity check can say so
    }
    holds.splice(0, holds.length, ...holds.filter(alive));
    if (!changed) break;
  }
  index(holds);

  // --- 5. open the way ---------------------------------------------------------------------
  // The local rules make a field where every hold can be climbed off. They do not make a field
  // you can climb THROUGH. Hands alternate: a hold whose only way up is a left-hand move is a
  // wall to a climber who arrives there with the right hand free, and one row of those cuts off
  // everything above it. Seeds 4, 9, 16 and 22 all died that way with the field looking fine.
  //
  // So the last step asks the real question directly — walk the wall the way a climber walks
  // it, tracking WHICH hand is free, and wherever the walk can go no higher, put a hold there.
  // It only ever adds, so nothing it does can strand anything below it.
  const OTHER = { L: 'R', R: 'L' };
  const takeable = (h, s) => within(h.x + SIGN[s] * (CFG.SHOULDER_DX - CFG.SWAY), h.y - (CFG.HANG_ONE - CFG.SHOULDER_DY), PLACE_LINK)
    .filter((k) => k !== h);
  // Every (hold, free hand) the climber can get into, from the two start holds.
  const walk = () => {
    const idx = new Map(holds.map((h, i) => [h, i]));
    const seen = new Uint8Array(holds.length * 2);
    const stack = [];
    const open = (h, s) => {
      const k = idx.get(h) * 2 + (s === 'L' ? 0 : 1);
      if (!seen[k]) { seen[k] = 1; stack.push([h, s]); }
    };
    open(startR, 'L');                                  // right hand holds, left hand moves
    open(startL, 'R');
    const states = [], stuck = [];
    while (stack.length) {
      const [h, s] = stack.pop();
      states.push({ h, s });
      const opts = takeable(h, s);
      if (!opts.some((k) => k.y > h.y + 0.05)) stuck.push({ h, s });
      for (const k of opts) open(k, OTHER[s]);
    }
    return { seen, idx, states, stuck };
  };
  // A goal the walk cannot reach, joined to it in two moves: from a state the walk DOES reach,
  // one new hold that hand can take, from which the other hand can take the goal. A rest cannot
  // have a feeder both hands can use — anything under it that close is inside its own rock — so
  // the parity of the last move has to be arranged rather than assumed.
  const twoMoveInto = (goal, states) => {
    for (const { h, s } of states) {
      const sh = restingShoulder(h, s);
      const rad = PLACE_LINK * 0.97;
      for (let a = -0.9; a <= 0.9001; a += 0.04) {
        const x = sh.x + Math.sin(a) * rad, y = sh.y + Math.cos(a) * rad;
        if (Math.abs(x) > R.SPREAD || y <= h.y + 0.06) continue;
        if (!canReach({ x, y }, goal, OTHER[s], PLACE_LINK)) continue;
        if (inTheWay(x, y).length) continue;
        place(x, y);
        return true;
      }
    }
    return false;
  };
  for (let round = 0; round < 12; round++) {
    const { seen, idx, states, stuck } = walk();
    const missing = [...runes, summit].filter((g) => !seen[idx.get(g) * 2] && !seen[idx.get(g) * 2 + 1]);
    if (!missing.length) break;
    states.sort((a, b) => b.h.y - a.h.y);               // near the goal first
    let opened = 0;
    for (const g of missing) if (twoMoveInto(g, states)) opened++;
    // Otherwise raise the ceiling: highest first, because that is what lets the walk spread.
    if (!opened) {
      stuck.sort((a, b) => b.h.y - a.h.y);
      for (const { h, s } of stuck) {
        if (opened >= 40) break;
        const p = bridgeAbove(h, s, false);             // add only — never shove, never delete
        if (p) { place(p.x, p.y); opened++; }
      }
    }
    if (!opened) break;
  }
  index(holds);

  // Order by height (the tests, world.js's merge and main.js's teleport all read the array in
  // order), with the two start holds kept at ids 0 and 1 — createClimber puts the hands there.
  const rest = holds.filter((h) => h !== startL && h !== startR).sort((a, b) => a.y - b.y || a.x - b.x);
  holds.length = 0;
  holds.push(startL, startR, ...rest);

  // --- 6. grips and sizes ----------------------------------------------------------------
  // Hold quality hardens with height (B8): low on the face it is mostly buckets, by the altar
  // mostly edges and crimps with the odd sloper that will quietly drop you. Runes and the altar
  // are always jugs, because they are the rests.
  const gripFor = (y, roll) => {
    const t = clamp01(y / R.TOP);                       // 0 at the base, 1 at the altar
    const crimpOdds = 0.05 + 0.45 * t * t;              // crimps arrive late and then dominate
    const sloperOdds = 0.04 + 0.16 * t;
    const jugOdds = Math.max(0.06, 0.42 - 0.36 * t);
    if (roll < crimpOdds) return 'crimp';
    if (roll < crimpOdds + sloperOdds) return 'sloper';
    if (roll < crimpOdds + sloperOdds + jugOdds) return 'jug';
    return 'edge';
  };
  // A jug reads as a bucket and a crimp as a sliver, so the wall can be read before it is touched.
  const SCALE = { jug: 1.0, edge: 0.94, sloper: 0.86, crimp: 0.66 };
  for (const h of holds) {
    if (h.kind === 'rune') { h.grip = 'jug'; h.size = R.RUNE_SIZE; continue; }
    if (h.kind === 'summit') { h.grip = 'jug'; h.size = R.SUMMIT_SIZE; continue; }
    h.grip = gripFor(h.y, rnd());
    h.size = Math.max(R.SIZE_MIN, U(0.112, R.SIZE_MAX) * SCALE[h.grip]);
  }
  // Nothing may overlap. Runes and the altar keep their size (they are the rests and have to
  // read as buckets); every other hold shrinks to fit the rock it was given.
  index(holds);
  for (const h of holds) {
    if (h.kind !== 'hold') continue;
    let cap = h.size;
    for (const k of within(h.x, h.y, h.size + 0.5)) {
      if (k === h) continue;
      const d = Math.hypot(k.x - h.x, k.y - h.y);
      // against a rest: the rest keeps its size and this hold takes what is left.
      // against another hold: split the gap, so the rule holds whichever one is measured.
      cap = Math.min(cap, k.kind === 'hold' ? (d - R.CLEAR) / 2 : d - R.CLEAR - k.size);
    }
    h.size = Math.max(R.SIZE_MIN, cap);
  }

  for (const h of holds) { h.size = r4(h.size); h.x = r4(h.x); h.y = r4(h.y); delete h._cull; }

  // --- 7. decoys (B10) --------------------------------------------------------------------
  // Rock that looks exactly like the field around it and crumbles the moment you weigh it. A
  // decoy is a hold LIFTED OUT of the field, so it sits where a hold would sit and is worth
  // trying — and it may never be the only way up, which here means: with it gone, every hold
  // below it must still have somewhere to climb to.
  const fakes = [];
  const isReserved = (h) => h.kind !== 'hold' || h === startL || h === startR;
  const spanLo = R.START_Y + 2.0, spanHi = summit.y - 1.6;
  const wanted = R.DECOYS;
  for (let attempt = 0; attempt < 600 && fakes.length < wanted; attempt++) {
    // spread them up the face: one per band, in order, so a route always meets a few
    const band = fakes.length / wanted;
    const lo = spanLo + (spanHi - spanLo) * band;
    const hi = spanLo + (spanHi - spanLo) * (band + 1 / wanted);
    const y = U(lo, hi);
    const pool = holds.filter((h) => !isReserved(h) && Math.abs(h.y - y) < R.ROW_DY * 1.2);
    if (!pool.length) continue;
    const cand = pool[Math.floor(rnd() * pool.length)];
    if (cand._fake) continue;
    // would anything below be stranded without it?
    index(holds.filter((h) => h !== cand && !h._fake));
    let strands = false;
    for (const below of within(cand.x, cand.y - 0.6, 1.4)) {
      if (below.y >= cand.y || below.kind === 'summit') continue;
      if (upLinks(below).length === 0) { strands = true; break; }
    }
    if (strands) continue;
    cand._fake = true;
    fakes.push(cand);
  }
  const fakeSet = new Set(fakes);
  const kept = holds.filter((h) => !fakeSet.has(h));
  const outFakes = fakes
    .sort((a, b) => a.y - b.y)
    .map((f, i) => ({ id: 10000 + i, x: f.x, y: f.y, size: f.size, kind: 'fake', lit: false, angle: f.angle }));

  // ids are the index in holds[]; sim.js and main.js both rely on it
  kept.forEach((h, i) => { h.id = i; delete h._fake; });

  const route = { holds: kept, fakes: outFakes, top: summit.y, seed };
  lastRoute = route;
  return route;
}
