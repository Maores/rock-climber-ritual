// src/sim.js — Rock Climber: The Ritual — the pure climbing simulation.
//
// Owns the shared `state` described in CONTRACTS.md; every other module only reads it.
// No three.js, no DOM. Units are meters, +y is up, +x is the climber's right, the wall
// is the x/y plane. The model is kinematic with a physical feel: hands and body are
// spring-damped toward targets, weight shifts on one-arm hangs, gravity acts only
// while falling, and the rope (or the ground) catches every fall.
//
// Hold ids must equal their index in route.holds (route.js guarantees this).

export const CFG = Object.freeze({
  // --- contract constants -------------------------------------------------------------
  REACH: 0.72,          // shoulder → fingertips; free hands never leave this circle
  SNAP: 0.16,           // floor for the grab radius; real radius is grabRadius(hold) below
  GRAB_EDGE: 0.028,     // the rock itself is the target, plus a fingertip's width of forgiveness
  SHOULDER_DX: 0.19, SHOULDER_DY: 0.08,
  HANG_TWO: 0.42,       // body hangs this far below the mean of two gripped holds
  HANG_ONE: 0.50,       // ...and this far below a single gripped hold
  ROPE_SLACK: 1.3,      // fall distance before the rope catches
  GRACE: 0.25,          // seconds after the last release during which a grab still saves the fall
  DRAIN_TWO: 0.022,     // stamina/s per hand while both hands grip
  DRAIN_ONE: 0.085,     // stamina/s for the only gripping hand (~12 s of hanging, was ~5 s)
  REFILL_FREE: 0.30,    // stamina/s for a free hand: shaking out recovers you quickly
  REFILL_RUNE: 0.50,    // stamina/s for a hand gripping a rune (runes never drain)
  ARM_TIME: 2.5,        // an armed hand grabs the first hold that comes within SNAP for this long
  SKIP_TIME: 6.0,       // backstop only: a released hold is skipped until the hand actually leaves it
  REGRIP_LOCK: 0.14,    // after letting go, a hand needs this long before it can take rock again
  MAX_DT: 1 / 20,

  // --- feel ---------------------------------------------------------------------------
  SWAY: 0.05,           // one-hand hang: the body target leans this far past the loaded hold
  REST_X: 0.14,         // free-hand rest offset from the shoulder (outward, up) when the stick is released
  REST_Y: 0.30,
  LINGER: 0.50,         // after the stick is released the hand keeps its place this long (lift the thumb, tap GRIP)...
  DRIFT_TAU: 0.25,      // ...then drifts toward the rest offset with this time constant
  HAND_OMEGA: 11.5, HAND_ZETA: 1.0,         // hand spring: weighty but not sluggish (~0.2 s per move),
                                            // critically damped so it never overshoots where you aimed
  GRAB_OMEGA: 22,       // closing onto a hold takes ~0.3 s: the fingers arrive, they are not magneted in...
  GRAB_LOCK: 0.002,     // ...and locks exactly onto it once this close
  BODY_OMEGA: 7, BODY_ZETA_Y: 0.85, BODY_ZETA_X: 0.55,   // body: settles vertically, sways sideways
  ROPE_OMEGA: 8, ROPE_ZETA: 0.40,           // rope stretch after a catch: one visible bounce
  SWING_OMEGA: 3, SWING_ZETA: 0.9,          // the rope swings the caught body back under the line of holds
  GRAVITY: 9.81,
  FLOOR: 0.75,          // lowest body height (standing at the base); the ground catches falls near the start
  FALL_TERMINAL: 26,    // m/s cap on a doomed plunge, so the drop reads rather than blurs
  HOVER_RANGE: 0.40,    // Hand.hover fades to 0 at this distance from the nearest hold
  TREMBLE_AT: 0.30,     // tremble grows as stamina drops below this
  CURL_RATE: 12, TREMBLE_RATE: 6,
  ROPE_ANCHOR_UP: 1.6,  // rope anchor sits this far above the summit hold
  EVENT_CAP: 64,        // undrained events are dropped beyond this

  // --- hold quality ---------------------------------------------------------------------
  // Not every rock is the same rock. A jug is a bucket you can hang off; a crimp is an edge
  // that eats your forearm; a sloper has nothing to pull against and quietly slips.
  //
  //   drain  — multiplier on how fast this hold burns the hand that holds it
  //   slip   — seconds of hanging before a hold this poor gives way on its own (0 = never)
  HOLD_KINDS: Object.freeze({
    jug:    { drain: 0.65, slip: 0 },
    edge:   { drain: 1.00, slip: 0 },
    crimp:  { drain: 1.85, slip: 0 },
    sloper: { drain: 1.35, slip: 9.0 },
  }),

  // --- the web-zip (the unlocked spider hand only) -------------------------------------
  WEB_RANGE: 7.0,       // furthest a shot reaches
  WEB_MIN: 1.1,         // nearest anchor worth taking
  WEB_SPEED: 26,        // m/s the shot travels out
  WEB_COOLDOWN: 3.0,    // seconds after letting go before the next shot
  WEB_AIM_HOLD: 0.16,   // hold the grip this long and it becomes an aim instead of a grab
  SWING_DAMP: 0.22,     // energy bled off per second while swinging
  SWING_PUMP: 5.5,      // how hard the free stick drives the swing
  SWING_REEL: 1.5,      // m/s the line shortens while you pull yourself up it
  SWING_MIN_LEN: 0.7,   // never reel closer than this to the anchor
  SWING_RELEASE_BOOST: 1.06,
});

const ZERO_STICK = Object.freeze({ x: 0, y: 0 });
const ZERO_INPUT = Object.freeze({ L: ZERO_STICK, R: ZERO_STICK, tapL: false, tapR: false });
const SIGN = { L: -1, R: 1 };
const OTHER = { L: 'R', R: 'L' };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------------------
// Construction

function makeHand(side, hold) {
  return {
    side, x: hold.x, y: hold.y, vx: 0, vy: 0, tx: hold.x, ty: hold.y,
    gripping: true, holdId: hold.id, armed: false,
    stamina: 1, tremble: 0, curl: 1, hover: 1,
    nearId: hold.id, nearDist: 0,             // nearest hold (extra, read-only convenience)
    _stick: { x: 0, y: 0 }, _linger: 0, _armT: 0,   // internal
    _skipId: null, _skipT: 0,                       // the hold just let go of, not re-grabbed at once
    _regripT: 0,                                    // brief beat after a release before rock can be taken
  };
}

export function createClimber(route) {
  const holds = route.holds;
  const h0 = holds[0], h1 = holds[1];
  const summit = holds.find((h) => h.kind === 'summit') || holds[holds.length - 1];
  const state = {
    t: 0,
    phase: 'title',
    body: { x: (h0.x + h1.x) / 2, y: (h0.y + h1.y) / 2 - CFG.HANG_TWO, vx: 0, vy: 0 },
    hands: { L: makeHand('L', h0), R: makeHand('R', h1) },
    ropeAnchor: { x: summit.x, y: summit.y + CFG.ROPE_ANCHOR_UP },
    fallCount: 0, height: 0, maxHeight: 0,
    // The web-zip. `mode` is idle → aiming → flying → attached; `cd` is the cooldown left.
    web: { mode: 'idle', ax: 0, ay: 0, tipX: 0, tipY: 0, len: 0, cd: 0, aimX: 0, aimY: 1, unlocked: false },
    runesLit: [], checkpoint: null, night: 0,
    route, events: [],
    _fall: { t: 0, from: 0, catchY: 0, catchX: 0 },
    _holdById: new Map(holds.map((h) => [h.id, h])),
  };
  state.height = state.maxHeight = state.body.y;
  state.night = clamp01(state.body.y / route.top);
  return state;
}

export function startClimb(state) {
  if (state.phase !== 'title') return;
  state.phase = 'climbing';
  state.t = 0;
  push(state, { type: 'start' });
}

export function drainEvents(state) {
  const out = state.events.slice();
  state.events.length = 0;
  return out;
}

// ---------------------------------------------------------------------------------------
// Geometry helpers (also used by route.js and the tests)

export function shoulder(state, side) {
  return { x: state.body.x + SIGN[side] * CFG.SHOULDER_DX, y: state.body.y + CFG.SHOULDER_DY };
}

// Body target for the current grips: mean of two holds minus HANG_TWO, or one hold minus
// HANG_ONE leaning SWAY toward the loaded arm. null when nothing is gripped.
export function hangTarget(state) {
  const { L, R } = state.hands;
  const hl = L.gripping ? state._holdById.get(L.holdId) : null;
  const hr = R.gripping ? state._holdById.get(R.holdId) : null;
  if (hl && hr) return { x: (hl.x + hr.x) / 2, y: (hl.y + hr.y) / 2 - CFG.HANG_TWO };
  if (hl) return { x: hl.x - CFG.SWAY, y: hl.y - CFG.HANG_ONE };
  if (hr) return { x: hr.x + CFG.SWAY, y: hr.y - CFG.HANG_ONE };
  return null;
}

// Where the free hand's shoulder settles while the other hand hangs alone from `hold`.
// The route generator places every hold within 0.9·REACH of this point.
export function restingShoulder(hold, freeSide) {
  const gripSide = OTHER[freeSide];
  const bx = hold.x + SIGN[gripSide] * CFG.SWAY;
  const by = hold.y - CFG.HANG_ONE;
  return { x: bx + SIGN[freeSide] * CFG.SHOULDER_DX, y: by + CFG.SHOULDER_DY };
}

export function nearestHold(state, x, y, exceptA = null, exceptB = null) {
  let best = null, bestD = Infinity;
  for (const h of state.route.holds) {
    if (h.id === exceptA || h.id === exceptB) continue;
    const dy = h.y - y;
    if (dy > bestD || dy < -bestD) continue;      // cheap reject before the hypot
    const d = Math.hypot(h.x - x, dy);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best ? { hold: best, d: bestD } : null;
}

// ---------------------------------------------------------------------------------------
// Step

export function step(state, input, dt) {
  dt = Math.min(CFG.MAX_DT, Math.max(0, +dt || 0));
  if (dt === 0) return;
  const inp = input || ZERO_INPUT;
  state.t += dt;
  const live = state.phase === 'climbing' || state.phase === 'falling' || state.phase === 'caught' ||
    state.phase === 'swinging';

  const webTap = updateWeb(state, inp, dt);      // may swallow the right tap as a shot
  if (live) {
    if (inp.tapL) tap(state, state.hands.L);
    if (inp.tapR && !webTap) tap(state, state.hands.R);
    updateStamina(state, dt);
  }
  updateBody(state, dt, inp);
  updateHand(state, state.hands.L, live ? inp.L : null, dt);
  updateHand(state, state.hands.R, live ? inp.R : null, dt);

  const b = state.body;
  state.height = b.y;
  if (b.y > state.maxHeight) state.maxHeight = b.y;
  state.night = clamp01(b.y / state.route.top);
}

// ---------------------------------------------------------------------------------------
// The web-zip. Only the unlocked spider hand can shoot, and only the right hand.
//
//   idle → (hold the right grip past WEB_AIM_HOLD) aiming → (let go) flying → attached
//
// While attached the body is a pendulum on a rigid line: gravity acts, then the position is
// projected back onto the circle around the anchor and the radial part of the velocity is
// dropped. That is a position-based constraint, which stays stable at any frame rate rather
// than exploding the way a stiff spring would.
function updateWeb(state, inp, dt) {
  const w = state.web;
  if (w.cd > 0) w.cd = Math.max(0, w.cd - dt);
  if (!w.unlocked) return false;

  const hand = state.hands.R;
  const holding = !!inp.holdR;
  // Hanging on the rope is exactly when you want to shoot, so 'caught' counts too.
  const canShoot = state.phase === 'climbing' || state.phase === 'falling' ||
    state.phase === 'swinging' || state.phase === 'caught';

  // Aim vector: whatever the right stick is pushing, defaulting to straight up.
  const ax = (inp.R && +inp.R.x) || 0, ay = (inp.R && +inp.R.y) || 0;
  if (Math.hypot(ax, ay) > 0.08) { w.aimX = ax; w.aimY = ay; }

  if (w.mode === 'idle') {
    if (holding && !hand.gripping && w.cd <= 0 && canShoot) {
      w._hold = (w._hold || 0) + dt;
      if (w._hold >= CFG.WEB_AIM_HOLD) { w.mode = 'aiming'; w._hold = 0; push(state, { type: 'aim' }); }
    } else w._hold = 0;
    return false;
  }

  if (w.mode === 'aiming') {
    if (!holding) return fire(state);            // letting go looses the shot
    return true;                                 // the grip tap is the aim, not a grab
  }

  if (w.mode === 'flying') {
    const dx = w.ax - w.tipX, dy = w.ay - w.tipY;
    const d = Math.hypot(dx, dy);
    const stepLen = CFG.WEB_SPEED * dt;
    if (d <= stepLen) {
      w.tipX = w.ax; w.tipY = w.ay;
      w.mode = 'attached';
      w.len = Math.hypot(state.body.x - w.ax, state.body.y - w.ay);
      state.phase = 'swinging';
      releaseBoth(state);
      push(state, { type: 'webhit' });
    } else {
      w.tipX += (dx / d) * stepLen;
      w.tipY += (dy / d) * stepLen;
    }
    return !!inp.tapR;
  }

  if (w.mode === 'attached') {
    if (inp.tapR || !holding) { cutWeb(state); return true; }
    return true;
  }
  return false;
}

function fire(state) {
  const w = state.web;
  const sh = shoulder(state, 'R');
  let m = Math.hypot(w.aimX, w.aimY);
  if (m < 1e-4) { w.aimX = 0; w.aimY = 1; m = 1; }
  const dx = w.aimX / m, dy = w.aimY / m;
  const reach = CFG.WEB_RANGE;
  w.ax = sh.x + dx * reach;
  w.ay = sh.y + dy * reach;
  // The cliff is the only thing up there to hit, so a shot always lands; it just cannot land
  // below the climber's feet or off the face.
  const R = state.route;
  w.ax = Math.max(-4.2, Math.min(4.2, w.ax));
  w.ay = Math.max(CFG.FLOOR + 0.4, Math.min(R.top + 1.4, w.ay));
  if (Math.hypot(w.ax - sh.x, w.ay - sh.y) < CFG.WEB_MIN) { w.mode = 'idle'; w.cd = 0.35; push(state, { type: 'webmiss' }); return true; }
  w.tipX = sh.x; w.tipY = sh.y;
  w.mode = 'flying';
  push(state, { type: 'webshot' });
  return true;
}

function releaseBoth(state) {
  for (const side of ['L', 'R']) {
    const h = state.hands[side];
    if (h.gripping) release(state, h, 'release');
  }
}

// Let go of the line: keep the velocity you had, so a well-timed release throws you.
export function cutWeb(state) {
  const w = state.web;
  if (w.mode === 'idle') return;
  const wasAttached = w.mode === 'attached';
  w.mode = 'idle';
  w._hold = 0;
  w.cd = CFG.WEB_COOLDOWN;
  if (wasAttached) {
    const b = state.body;
    b.vx *= CFG.SWING_RELEASE_BOOST;
    b.vy *= CFG.SWING_RELEASE_BOOST;
    beginFall(state);
    push(state, { type: 'webcut' });
  }
}

// The pendulum itself.
function updateSwing(state, inp, dt) {
  const w = state.web, b = state.body;
  b.vy -= CFG.GRAVITY * dt;

  // the free stick drives the swing, the way a climber pumps their legs
  const px = (inp && inp.L && +inp.L.x) || 0;
  if (px) b.vx += px * CFG.SWING_PUMP * dt;
  // pushing the stick up reels you in along the line
  const py = (inp && inp.L && +inp.L.y) || 0;
  if (py > 0.1) w.len = Math.max(CFG.SWING_MIN_LEN, w.len - py * CFG.SWING_REEL * dt);

  const damp = Math.exp(-CFG.SWING_DAMP * dt);
  b.vx *= damp; b.vy *= damp;

  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // rigid-line constraint: pull the body back onto the circle, then kill the radial velocity
  let dx = b.x - w.ax, dy = b.y - w.ay;
  const d = Math.hypot(dx, dy);
  if (d > 1e-5) {
    dx /= d; dy /= d;
    b.x = w.ax + dx * w.len;
    b.y = w.ay + dy * w.len;
    const radial = b.vx * dx + b.vy * dy;
    if (radial > 0) { b.vx -= radial * dx; b.vy -= radial * dy; }   // the line cannot push
  }
  // The ground is a hard constraint too. When the swing dips into it, the floor wins and the
  // line is left slightly slack for that frame; `grounded` says so, so nothing downstream
  // assumes the body is exactly on the circle.
  w.grounded = false;
  if (b.y < CFG.FLOOR) {
    b.y = CFG.FLOOR;
    if (b.vy < 0) b.vy = 0;
    w.grounded = true;
  }
}

function push(state, ev) {
  if (state.events.length < CFG.EVENT_CAP) state.events.push(ev);
}

function anyGripping(state) {
  return state.hands.L.gripping || state.hands.R.gripping;
}

// Grabs work while climbing, while hanging on the rope, and in the grace window of a fall.
function canGrab(state) {
  return state.phase === 'climbing' || state.phase === 'caught' || state.phase === 'swinging' ||
    (state.phase === 'falling' && state._fall.t <= CFG.GRACE);
}

// A hand grabs anywhere on a hold's surface (its own radius plus a fingertip's overlap), so a
// big rock is a big target and a crimp is a small one.
export function grabRadius(hold) {
  // Deliberately NOT floored at SNAP any more: a crimp is a small target and should feel like
  // one. You must have the hand on the rock, anywhere on it, and nowhere else.
  return (hold.size || 0.12) + CFG.GRAB_EDGE;
}

// An ARMED hand sweeping past the cliff uses a tighter radius than a deliberate tap. Without
// this an armed hand snags rock it was never reaching for — including holds behind it.
export function armRadius(hold) {
  return (hold.size || 0.12) * 0.92;
}

// Nearest decoy that has not crumbled yet.
export function nearestFake(state, x, y) {
  const F = state.route.fakes;
  if (!F || !F.length) return null;
  let best = null, bestD = Infinity;
  for (const f of F) {
    if (f.broken) continue;
    const d = Math.hypot(f.x - x, f.y - y);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best ? { hold: best, d: bestD } : null;
}

// A decoy takes the grab, then gives way: the hand comes off with nothing and cannot immediately
// re-try the same spot. It crumbles for good, so the cliff teaches you as you climb it.
function crumble(state, hand, fake) {
  fake.broken = true;
  hand.armed = false;
  hand._armT = 0;
  hand._linger = 0;
  hand.tremble = Math.max(hand.tremble, 0.7);
  push(state, { type: 'crumble', hand: hand.side, holdId: fake.id });
}

// GRIP is a toggle: release when gripping; otherwise grab the nearest hold within its radius,
// or arm the hand so it grabs the first hold that comes within SNAP during ARM_TIME.
function tap(state, hand) {
  if (hand.gripping) { release(state, hand, 'release'); return; }
  // Straight after letting go the fingers are still open and moving: a tap can only arm, so a
  // hand cannot snatch the rock it is drifting past (or the one it just left).
  if (canGrab(state) && hand._regripT <= 0) {
    const near = targetHold(state, hand);
    const fake = nearestFake(state, hand.x, hand.y);
    // A decoy wins the grab when the fingers are on it and it is the closer rock.
    if (fake && fake.d <= grabRadius(fake.hold) && (!near || fake.d < near.d)) { crumble(state, hand, fake.hold); return; }
    if (near && near.d <= grabRadius(near.hold)) { grab(state, hand, near.hold); return; }
    // A hold was close but not close enough: a real miss (the HUD shakes). A tap in empty rock,
    // or right after letting go while still on the old hold, is a deliberate pre-arm: 'arm' only.
    if (near && near.d <= CFG.HOVER_RANGE) push(state, { type: 'miss', hand: hand.side });
  }
  hand.armed = true;
  hand._armT = CFG.ARM_TIME;
  push(state, { type: 'arm', hand: hand.side });
}

// While another hand still grips, the hold this hand just released is skipped so that a
// quick second tap arms the hand instead of taking the same hold again. Once the climber
// is falling every hold counts: a panic re-grab inside the grace window saves the fall.
function skipId(state, hand) {
  return state.phase === 'climbing' ? hand._skipId : null;
}

// The hold this hand may take next: the nearest one that is neither the hold it just let go of
// (while climbing) nor the hold the other hand is holding — two hands never share a hold.
function targetHold(state, hand) {
  const other = state.hands[OTHER[hand.side]];
  return nearestHold(state, hand.x, hand.y, skipId(state, hand), other.gripping ? other.holdId : null);
}

function grab(state, hand, hold) {
  // Catching rock mid-swing ends the swing: the line goes slack and you are climbing again.
  if (state.phase === 'swinging') {
    state.web.mode = 'idle';
    state.web.cd = CFG.WEB_COOLDOWN;
    state.phase = 'climbing';
    push(state, { type: 'webcut' });
  }
  hand.gripping = true;
  hand.holdId = hold.id;
  hand.armed = false;
  hand._armT = 0;
  // Grip where the fingers actually landed: clamp the hand onto the rock's surface and keep
  // that contact point, so a wide rock can be held at its edge instead of always at its centre.
  {
    const r = Math.max(0, (hold.size || 0.12) - 0.02);
    let dx = hand.x - hold.x, dy = hand.y - hold.y;
    const d = Math.hypot(dx, dy);
    if (d > r && d > 1e-6) { dx *= r / d; dy *= r / d; }
    hand.gripDX = dx; hand.gripDY = dy;
  }
  hand.tx = hold.x + hand.gripDX;      // the hand closes onto that point over ~0.15 s; no teleport
  hand.ty = hold.y + hand.gripDY;
  hand._stick.x = hand._stick.y = 0;   // the next release starts from a neutral stick
  hand._linger = 0;
  hand._skipId = null;
  hand._onT = 0;                       // how long this hand has been on this rock (slopers time out)
  push(state, { type: 'grab', hand: hand.side, holdId: hold.id });
  if (hold.kind === 'rune') {
    state.checkpoint = hold.id;
    if (!hold.lit) {
      hold.lit = true;
      state.runesLit.push(hold.id);
      push(state, { type: 'rune', hand: hand.side, holdId: hold.id });
    }
  }
  if (hold.kind === 'summit') {
    hold.lit = true;
    state.phase = 'summit';
    push(state, { type: 'summit', hand: hand.side, holdId: hold.id });
  } else {
    state.phase = 'climbing';   // also ends a fall (grace) or a rope hang
  }
}

function release(state, hand, type) {
  const holdId = hand.holdId;
  hand.gripping = false;
  hand.holdId = null;
  hand._linger = CFG.LINGER;   // the hand hangs where it is for a moment, then drifts to rest
  if (type === 'release') { hand._skipId = holdId; hand._skipT = CFG.SKIP_TIME; hand._regripT = CFG.REGRIP_LOCK; }
  push(state, { type, hand: hand.side, holdId });
  if (state.phase === 'climbing' && !anyGripping(state)) beginFall(state);
}

function beginFall(state) {
  state.phase = 'falling';
  state._fall.t = 0;
  state._fall.from = state.body.y;
  // The rope saves you once. Once it is spent, this fall is the whole cliff: nothing stops the
  // body until the ground does, which is what the falling animation and the death screen are for.
  state._fall.doomed = state.fallCount >= 1;
  push(state, { type: 'fall', doomed: state._fall.doomed });
}

function updateStamina(state, dt) {
  const { L, R } = state.hands;
  const both = L.gripping && R.gripping;
  for (const hand of [L, R]) {
    if (!hand.gripping) { hand.stamina = Math.min(1, hand.stamina + CFG.REFILL_FREE * dt); continue; }
    const hold = state._holdById.get(hand.holdId);
    if (hold.kind === 'rune' || hold.kind === 'summit') {
      hand.stamina = Math.min(1, hand.stamina + CFG.REFILL_RUNE * dt);   // rest holds
      continue;
    }
    // Poor rock costs more, and a sloper eventually shrugs you off however fresh you are.
    const q = (hold && CFG.HOLD_KINDS[hold.grip]) || CFG.HOLD_KINDS.edge;
    hand.stamina -= (both ? CFG.DRAIN_TWO : CFG.DRAIN_ONE) * q.drain * dt;
    hand._onT = (hand._onT || 0) + dt;
    if (q.slip > 0 && hand._onT > q.slip) { release(state, hand, 'slip'); continue; }
    if (hand.stamina <= 0) { hand.stamina = 0; release(state, hand, 'slip'); }
  }
}

// Mean x of the holds a climber hanging at height y could reach; `fallback` if there are none.
function lineCenter(state, y, fallback) {
  let sum = 0, n = 0;
  for (const h of state.route.holds) {
    if (Math.abs(h.y - y) <= CFG.REACH * 0.9) { sum += h.x; n++; }
  }
  return n ? sum / n : fallback;
}

// Semi-implicit spring-damper on one axis. Stable for omega·dt < 2 (dt ≤ 1/20 → ≤ 0.8).
function spring(obj, pk, vk, target, omega, zeta, dt) {
  const a = omega * omega * (target - obj[pk]) - 2 * zeta * omega * obj[vk];
  obj[vk] += a * dt;
  obj[pk] += obj[vk] * dt;
}

// Exact step of a critically damped spring: stable for any dt, for rates too high for the
// semi-implicit integrator (the grab settle). d(t) = (d0 + (v0 + ω d0) t) e^(−ωt).
function springCritical(obj, pk, vk, target, omega, dt) {
  const d0 = obj[pk] - target, v0 = obj[vk];
  const e = Math.exp(-omega * dt), k = (v0 + omega * d0) * dt;
  obj[pk] = target + (d0 + k) * e;
  obj[vk] = (v0 - k * omega) * e;
}

function updateBody(state, dt, inp) {
  const b = state.body;
  if (state.phase === 'swinging') { updateSwing(state, inp, dt); return; }
  if (state.phase === 'falling') {
    const f = state._fall;
    f.t += dt;
    b.vy -= CFG.GRAVITY * dt;
    b.vx *= Math.exp(-3 * dt);
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    // A doomed fall has no catch: it runs all the way to the ground, gathering speed.
    if (f.doomed) {
      b.vy = Math.max(b.vy, -CFG.FALL_TERMINAL);       // terminal velocity, so it reads as a plunge
      if (b.y <= CFG.FLOOR) {
        b.y = CFG.FLOOR;
        b.vx = 0; b.vy = 0;
        state.phase = 'fallen';
        push(state, { type: 'impact' });
        push(state, { type: 'fallen' });
      }
      return;
    }
    const catchY = Math.max(f.from - CFG.ROPE_SLACK, CFG.FLOOR);
    if (b.y <= catchY) {
      b.y = catchY;
      b.vy *= 0.35;               // the rope stretches: a short bounce below the catch point
      f.catchY = catchY;
      f.catchX = lineCenter(state, catchY + CFG.SHOULDER_DY + 0.35, b.x);
      state.fallCount += 1;
      state.phase = 'caught';
      push(state, { type: 'catch' });
    }
    return;
  }
  if (state.phase === 'caught') {
    spring(b, 'x', 'vx', state._fall.catchX, CFG.SWING_OMEGA, CFG.SWING_ZETA, dt);
    spring(b, 'y', 'vy', state._fall.catchY, CFG.ROPE_OMEGA, CFG.ROPE_ZETA, dt);
    return;
  }
  const tgt = hangTarget(state);   // title / climbing / summit
  if (!tgt) return;
  spring(b, 'x', 'vx', tgt.x, CFG.BODY_OMEGA, CFG.BODY_ZETA_X, dt);
  spring(b, 'y', 'vy', tgt.y, CFG.BODY_OMEGA, CFG.BODY_ZETA_Y, dt);
}

function updateHand(state, hand, stickIn, dt) {
  const sh = shoulder(state, hand.side);
  const sgn = SIGN[hand.side];
  const hold = hand.gripping ? state._holdById.get(hand.holdId) : null;

  if (hold) {
    // Close onto the hold — fast and critically damped — then lock exactly on it.
    const gx = hold.x + (hand.gripDX || 0), gy = hold.y + (hand.gripDY || 0);
    hand.tx = gx; hand.ty = gy;
    if (hand.x !== gx || hand.y !== gy || hand.vx !== 0 || hand.vy !== 0) {
      springCritical(hand, 'x', 'vx', gx, CFG.GRAB_OMEGA, dt);
      springCritical(hand, 'y', 'vy', gy, CFG.GRAB_OMEGA, dt);
      if (Math.hypot(gx - hand.x, gy - hand.y) < CFG.GRAB_LOCK && Math.hypot(hand.vx, hand.vy) < 0.1) {
        hand.x = gx; hand.y = gy; hand.vx = hand.vy = 0;
      }
    }
    hand.nearId = hold.id;
    hand.nearDist = 0;
    hand.hover = 1;
  } else {
    // Stick: immediate while pushed; on release it lingers, then decays toward rest.
    const s = hand._stick;
    let sx = 0, sy = 0, m = 0;
    if (stickIn) {
      sx = +stickIn.x || 0; sy = +stickIn.y || 0;
      m = Math.hypot(sx, sy);
      if (m > 1) { sx /= m; sy /= m; m = 1; }
    }
    if (m > 0.02) { s.x = sx; s.y = sy; hand._linger = CFG.LINGER; }
    else if (hand._linger > 0) hand._linger -= dt;
    else { const k = Math.exp(-dt / CFG.DRIFT_TAU); s.x *= k; s.y *= k; }

    // Target = shoulder + stick·REACH, blended with the rest offset as the stick relaxes.
    const sm = Math.min(1, Math.hypot(s.x, s.y));
    let ox = sgn * CFG.REST_X * (1 - sm) + s.x * CFG.REACH;
    let oy = CFG.REST_Y * (1 - sm) + s.y * CFG.REACH;
    const om = Math.hypot(ox, oy);
    if (om > CFG.REACH) { ox *= CFG.REACH / om; oy *= CFG.REACH / om; }
    hand.tx = sh.x + ox;
    hand.ty = sh.y + oy;

    spring(hand, 'x', 'vx', hand.tx, CFG.HAND_OMEGA, CFG.HAND_ZETA, dt);
    spring(hand, 'y', 'vy', hand.ty, CFG.HAND_OMEGA, CFG.HAND_ZETA, dt);

    // Hard reach clamp; drop the outward velocity so the hand slides along the circle.
    const rx = hand.x - sh.x, ry = hand.y - sh.y;
    const rm = Math.hypot(rx, ry);
    if (rm > CFG.REACH) {
      const nx = rx / rm, ny = ry / rm;
      hand.x = sh.x + nx * CFG.REACH;
      hand.y = sh.y + ny * CFG.REACH;
      const vout = hand.vx * nx + hand.vy * ny;
      if (vout > 0) { hand.vx -= vout * nx; hand.vy -= vout * ny; }
    }

    if (hand.armed) { hand._armT -= dt; if (hand._armT <= 0) { hand.armed = false; hand._armT = 0; } }
    if (hand._regripT > 0) hand._regripT = Math.max(0, hand._regripT - dt);
    if (hand._skipId !== null) {
      hand._skipT -= dt;
      const sk = state._holdById.get(hand._skipId);
      // Clear on distance, not on a timer: an armed hand must not re-take the hold it just
      // let go of while the fingers are still inside that rock's grab zone.
      if (!sk || hand._skipT <= 0 || Math.hypot(sk.x - hand.x, sk.y - hand.y) > grabRadius(sk) + 0.04) hand._skipId = null;
    }

    const near = targetHold(state, hand);
    hand.nearId = near ? near.hold.id : null;
    hand.nearDist = near ? near.d : Infinity;
    hand.hover = near ? clamp01(1 - near.d / CFG.HOVER_RANGE) : 0;
    if (hand.armed && canGrab(state) && hand._regripT <= 0) {
      const fk = nearestFake(state, hand.x, hand.y);
      if (fk && fk.d <= armRadius(fk.hold) && (!near || fk.d < near.d)) crumble(state, hand, fk.hold);
      else if (near && near.d <= armRadius(near.hold)) grab(state, hand, near.hold);
    }
  }

  // Fingers curl onto a hold (a little anticipation when hovering); tremble grows as stamina fades.
  const curlT = hand.gripping ? 1 : 0.25 * hand.hover;
  hand.curl += (curlT - hand.curl) * (1 - Math.exp(-CFG.CURL_RATE * dt));
  const low = clamp01((CFG.TREMBLE_AT - hand.stamina) / CFG.TREMBLE_AT);
  const trembleT = hand.gripping ? low : 0.4 * low;
  hand.tremble += (trembleT - hand.tremble) * (1 - Math.exp(-CFG.TREMBLE_RATE * dt));
}
