// test/climb-graph.js — the reach graph of a route, and the shortest way up it.
//
// Not a test file (node --test only collects *.test.js) and not game code: this is what both
// guards in test/playability.test.js are built on — the pure connectivity check, and the
// path-finder the sim-driving bot follows. It knows nothing about grabbing, hovering, stamina
// or input. It knows the reach rule and nothing else.
//
// THE RULE (sim.restingShoulder + 0.9·REACH, which is what route.js builds the field to): while
// one hand hangs alone on hold H, the other hand's shoulder rests at restingShoulder(H, side),
// and any hold within 0.9·REACH of that point can be taken by that hand.
//
// THE STATE. The climber is two hands on two holds. Moving the left hand is anchored on the
// right hand's hold and the other way round, so the useful state is (anchor, hand about to
// move): "the still hand is on `anchor`, the `side` hand is free". Taking hold K with that hand
// leaves the pair (K, anchor) — the state (K, other side). Which makes the walk exact and the
// search small: 2n states rather than n² pairs. Getting this wrong is not academic; a field
// where every hold has a way up can still be unclimbable, because you do not get to choose
// which hand is free when you arrive.

import { canReach, REACH_LINK } from '../src/route.js';

export const OTHER = { L: 'R', R: 'L' };
export const stateKey = (anchor, side) => anchor * 2 + (side === 'L' ? 0 : 1);

// For every hold, the holds each hand could take while the other hand hangs on it.
// Holds come sorted by height, so the candidate window is a slice and not a scan of the field.
export function reachGraph(route) {
  const H = route.holds;
  const out = H.map(() => ({ L: [], R: [] }));
  const lo = -(0.42 + REACH_LINK), hi = REACH_LINK - 0.42;   // how far a target can sit from H
  let first = 0;
  for (let i = 0; i < H.length; i++) {
    while (first < H.length && H[first].y < H[i].y + lo) first++;
    for (let j = first; j < H.length && H[j].y <= H[i].y + hi; j++) {
      if (i === j) continue;
      for (const side of ['L', 'R']) if (canReach(H[i], H[j], side)) out[i][side].push(j);
    }
  }
  return out;
}

// The same edges read backwards: every hold from which hand `side` could take hold j.
export function inEdges(graph) {
  const inE = graph.map(() => ({ L: [], R: [] }));
  graph.forEach((e, a) => { for (const s of ['L', 'R']) for (const j of e[s]) inE[j][s].push(a); });
  return inE;
}

// Every state the climber can get into, starting from the two hands on `from`.
export function reachableStates(graph, from) {
  const seen = new Set();
  const stack = [];
  const open = (a, s) => { const k = stateKey(a, s); if (!seen.has(k)) { seen.add(k); stack.push([a, s]); } };
  if (Array.isArray(from)) for (const [a, s] of from) open(a, s);
  else { open(from.R, 'L'); open(from.L, 'R'); }        // either hand may move first
  while (stack.length) {
    const [a, s] = stack.pop();
    for (const j of graph[a][s]) open(j, OTHER[s]);
  }
  return seen;
}

// Is start → every rune in height order → the altar a climb that exists? Leg by leg, carrying
// the set of positions the previous leg could have left you in, because which hand is free
// when you arrive at a rune decides what you can do next.
export function connectivity(route, graph = reachGraph(route)) {
  const goals = route.holds
    .filter((h) => h.kind === 'rune' || h.kind === 'summit')
    .sort((a, b) => a.y - b.y)
    .map((h) => h.id);
  let states = [[1, 'L'], [0, 'R']];
  const legs = [];
  for (const goal of goals) {
    const seen = reachableStates(graph, states);
    const arrived = ['L', 'R'].filter((s) => seen.has(stateKey(goal, s)));
    if (!arrived.length) return { ok: false, failed: goal, legs };
    legs.push(goal);
    states = arrived.map((s) => [goal, s]);
  }
  return { ok: true, failed: null, legs };
}

// What a move costs the bot: one move, plus a nudge toward tall moves and big holds, so that
// among equally short ways up it picks the one a person would — fewer, bigger, more upward.
const moveCost = (from, to) =>
  1 + 0.8 * Math.max(0, (0.2 - (to.y - from.y)) / 0.2) + 0.6 * (0.16 - Math.min(0.16, to.size));

// Cost from every state to arriving on `goalId`, by Dijkstra run backwards from the goal.
// One of these per goal is all the bot needs: wherever a grab actually lands it, the next move
// is the neighbour with the smallest cost, so nothing ever has to be re-planned.
export function costToGoal(route, graph, inE, goalId) {
  const H = route.holds;
  const dist = new Float64Array(H.length * 2).fill(Infinity);
  const heap = [[0, stateKey(goalId, 'L')], [0, stateKey(goalId, 'R')]];
  dist[stateKey(goalId, 'L')] = 0;
  dist[stateKey(goalId, 'R')] = 0;
  const swap = (i, j) => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t; };
  const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; swap(p, i); i = p; } };
  const down = (i) => {
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
      if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
      if (m === i) return;
      swap(m, i); i = m;
    }
  };
  const push = (c, k) => { heap.push([c, k]); up(heap.length - 1); };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; down(0); } return top; };
  up(1);
  while (heap.length) {
    const [d, k] = pop();
    if (d > dist[k]) continue;
    const j = k >> 1, t = (k & 1) ? 'R' : 'L';
    const s = OTHER[t];                                 // the hand that made the move into j
    for (const a of inE[j][s]) {
      const nd = d + moveCost(H[a], H[j]);
      const ka = stateKey(a, s);
      if (nd < dist[ka]) { dist[ka] = nd; push(nd, ka); }
    }
  }
  return dist;
}
