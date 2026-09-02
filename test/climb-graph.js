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
import { CFG, restingShoulder } from '../src/sim.js';

export const OTHER = { L: 'R', R: 'L' };
export const stateKey = (anchor, side) => anchor * 2 + (side === 'L' ? 0 : 1);

// For every hold, the holds each hand could take while the other hand hangs on it.
// Holds come sorted by height, so the candidate window is a slice and not a scan of the field.
export function reachGraph(route) {
  const H = route.holds;
  const out = H.map(() => ({ L: [], R: [] }));
  const drop = CFG.HANG_ONE - CFG.SHOULDER_DY;               // the resting shoulder, below the hold
  const lo = -(drop + REACH_LINK), hi = REACH_LINK - drop;   // how far a target can sit from H
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

// What a move costs the bot: one move, plus nudges so that among equally short ways up it picks
// the one a person would — fewer, bigger, more upward, and well inside the reach circle.
//
// COMFORT is the one that earns its place. A hold at 0.9·REACH from the SETTLED one-arm shoulder
// is reachable by the contract, but the body is still on its way down to that shoulder when the
// hand goes out, so at the rim the move often cannot be made at all. The bot may still take one
// when there is nothing else; it just stops routing through them by preference.
const COMFORT = 0.80;
export const moveCost = (from, to, side) => {
  const sh = restingShoulder(from, side);
  const reach = Math.hypot(to.x - sh.x, to.y - sh.y) / CFG.REACH;
  return 1
    + 0.8 * Math.max(0, (0.2 - (to.y - from.y)) / 0.2)
    + 0.6 * (0.16 - Math.min(0.16, to.size))
    + 6 * Math.max(0, reach - COMFORT);
};

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
      const nd = d + moveCost(H[a], H[j], s);
      const ka = stateKey(a, s);
      if (nd < dist[ka]) { dist[ka] = nd; push(nd, ka); }
    }
  }
  return dist;
}

// The next move, given where the two hands actually are: the reachable hold with the lowest
// cost onward to the goal `dist` was built for. `refused` holds the moves the sim could not
// actually make, so the bot stops proposing them.
//
// Stamina is part of the choice, not an afterthought. Whichever hand moves, the OTHER one hangs
// alone and burns; steer by cost alone and the bot will spend its last hand holding a crimp
// while the fresh one goes shopping, and then fall off. So a tired anchor is expensive, and the
// cheapest way to make it cheap again is to move THAT hand and let it rest.
// A hand this tired must not be the one left hanging: it is the one that has to move next, so
// that it comes off the rock and shakes out. Only a free hand refills.
const SPENT = 0.45;
export function chooseMove(state, route, graph, dist, refused = new Set(), lastSide = null) {
  const pick = (rested) => {
    let best = null;
    for (const side of ['L', 'R']) {
      const anchor = state.hands[OTHER[side]];
      if (!anchor.gripping) continue;
      if (rested && anchor.stamina < SPENT) continue;
      // climbing is alternation: taking the same hand twice leaves the other hanging twice as long
      // ...and what it hangs FROM matters. A crimp burns a hand nearly three times as fast as a
      // jug, so the hand on the crimp is the one that should be moving.
      const q = CFG.HOLD_KINDS[route.holds[anchor.holdId].grip] || CFG.HOLD_KINDS.edge;
      const rhythm = (side === lastSide ? 1.5 : 0) + 1.2 * (q.drain - 0.65);
      for (const j of graph[anchor.holdId][side]) {
        // never "move" a hand to the rock it is already on, nor onto the other hand's
        if (j === anchor.holdId || j === state.hands[side].holdId) continue;
        if (refused.has(`${anchor.holdId}:${side}:${j}`)) continue;
        // A move that gets no nearer the goal is still a move, and sometimes it is the only one
        // worth making: it takes the tired hand off the rock so it can shake out. Costed high
        // enough that it is never preferred to actual progress.
        const onward = dist[stateKey(j, OTHER[side])];
        // How far this hand has to travel. It matters most when the hand is already out in the
        // air because the last reach failed: the anchor is burning, and the answer is the
        // nearest rock, not the best rock.
        const hand = state.hands[side];
        const travel = Math.hypot(route.holds[j].x - hand.x, route.holds[j].y - hand.y) / CFG.REACH;
        const urgency = hand.gripping ? 0.5 : 3 + 12 * Math.max(0, 0.5 - anchor.stamina);
        const d = (onward === Infinity ? 200 : onward)
          + moveCost(route.holds[anchor.holdId], route.holds[j], side) + rhythm + urgency * travel;
        if (!best || d < best.d) best = { side, j, d, from: anchor.holdId };
      }
    }
    return best;
  };
  return pick(true) || pick(false);
}
