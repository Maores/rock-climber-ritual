// src/sim.js — Rock Climber: The Ritual — the pure climbing simulation.
//
// Owns the shared `state` described in CONTRACTS.md; every other module only reads it.
// No three.js, no DOM. Units are meters, +y is up, +x is the climber's right, the wall
// is the x/y plane. The model is kinematic with a physical feel: hands and body are
// spring-damped toward targets, weight shifts on one-arm hangs, gravity acts only
// while falling. Nothing catches a fall: it runs to the ground and ends the climb.
//
// There are no grip buttons (B51). A free hand that stays on a piece of rock for
// HOVER_GRAB_DWELL closes on it; a gripping hand lets go when its own stick is pushed past
// RELEASE_DEADZONE. Every control the sim has is two sticks.
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
  GRACE: 0.25,          // seconds after the last release during which a grab still saves the fall
  DRAIN_TWO: 0.022,     // stamina/s per hand while both hands grip
  DRAIN_ONE: 0.085,     // stamina/s for the only gripping hand (~12 s of hanging, was ~5 s)
  REFILL_FREE: 0.30,    // stamina/s for a free hand: shaking out recovers you quickly
  REFILL_RUNE: 0.50,    // stamina/s for a hand gripping a rune (runes never drain)
  SKIP_CLEAR: 0.04,     // the hold a hand just came off is locked out until the hand is this far
                        // outside its grab radius — a distance, never a timer (see updateHand)
  REGRIP_LOCK: 0.14,    // after letting go, a hand needs this long before it can take rock again
  MAX_DT: 1 / 20,

  // --- the grab, without a button (B51) ------------------------------------------------
  // There is no GRIP any more: a hand that hovers over rock closes on it, and a gripping hand
  // lets go when its own stick is pushed. Both of these are FEEL constants — the owner may want
  // them retuned once he has climbed on them; the grab radius itself must not move (B3, B5).
  HOVER_GRAB_DWELL: 0.12,   // seconds a free hand must stay on a hold before the fingers close,
                            // so a hand sweeping across rock does not snag it
  RELEASE_DEADZONE: 0.35,   // fraction of full stick deflection past which a gripping hand lets
                            // go. Below it a gripping hand does not move, so a resting thumb
                            // (or a thumb reaching for the other stick) can never drop you.

  // --- feel ---------------------------------------------------------------------------
  SWAY: 0.05,           // one-hand hang: the body target leans this far past the loaded hold
  REST_X: 0.14,         // where a hand hangs when it has not been steered since it last held rock
  REST_Y: 0.30,         // (offset from the shoulder, outward and up). A steered hand parks — see updateHand.
  HAND_OMEGA: 11.5, HAND_ZETA: 1.0,         // hand spring: weighty but not sluggish (~0.2 s per move),
                                            // critically damped so it never overshoots where you aimed
  GRAB_OMEGA: 22,       // closing onto a hold takes ~0.3 s: the fingers arrive, they are not magneted in...
  GRAB_LOCK: 0.002,     // ...and locks exactly onto it once this close
  BODY_OMEGA: 7, BODY_ZETA_Y: 0.85, BODY_ZETA_X: 0.55,   // body: settles vertically, sways sideways
  SWING_OMEGA: 3, SWING_ZETA: 0.9,          // the web line swings the body back under the line of holds
  GRAVITY: 9.81,
  FLOOR: 0.75,          // lowest body height (standing at the base); the ground catches falls near the start
  FALL_TERMINAL: 26,    // m/s cap on the plunge, so the drop reads rather than blurs
  HOVER_RANGE: 0.40,    // Hand.hover fades to 0 at this distance from the nearest hold
  TREMBLE_AT: 0.30,     // tremble grows as stamina drops below this
  CURL_RATE: 12, TREMBLE_RATE: 6,
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
  WEB_RANGE: 6.5,       // furthest a shot reaches (the camera turns to look at the anchor while
                        // you aim, so range is not limited by what happens to be in frame)
  WEB_MIN: 1.1,         // nearest anchor worth taking
  WEB_SPEED: 26,        // m/s the shot travels out
  WEB_COOLDOWN: 3.0,    // seconds after letting go before the next shot
  WEB_AIM_HOLD: 0.16,   // hold the grip this long and it becomes an aim instead of a grab
  SWING_DAMP: 0.22,     // energy bled off per second while swinging
  SWING_PUMP: 5.5,      // how hard the free stick drives the swing
  SWING_REEL: 1.5,      // m/s the line shortens while you pull yourself up it
  SWING_MIN_LEN: 0.7,   // never reel closer than this to the anchor
  WEB_YANK: 3.4,        // m/s kick along the line the instant it goes taut
  WEB_YANK_REEL: 0.35,  // ...and this much of the line taken up with it
  SWING_RELEASE_BOOST: 1.22,   // letting go throws you: a timed release is the point
});

const ZERO_STICK = Object.freeze({ x: 0, y: 0 });
const ZERO_INPUT = Object.freeze({ L: ZERO_STICK, R: ZERO_STICK });
const SIGN = { L: -1, R: 1 };
const OTHER = { L: 'R', R: 'L' };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------------------
// Construction

function makeHand(side, hold) {
  return {
    side, x: hold.x, y: hold.y, vx: 0, vy: 0, tx: hold.x, ty: hold.y,
    gripping: true, holdId: hold.id,
    // `armed` never becomes true since B51 (nothing arms: hovering grabs). It stays on the hand
    // because world.js reads it for the hover ring; it is a constant false, not a state.
    armed: false,
    stamina: 1, tremble: 0, curl: 1, hover: 1,
    nearId: hold.id, nearDist: 0,             // nearest hold (extra, read-only convenience)
    _stick: { x: 0, y: 0 },                         // internal; _stick is also where a free hand is parked
    _hoverId: null, _hoverT: 0,                     // rock the fingers are on, and for how long (B51)
    _relArm: false,                                 // the stick has been back at centre since this grab
    _skipId: null, _slipped: false,                 // the hold just let go of, until the hand leaves it
                                                    // (_slipped: the fingers failed there, they did not choose)
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
    height: 0, maxHeight: 0,
    // The web-zip. `mode` is idle → aiming → flying → attached; `cd` is the cooldown left.
    web: { mode: 'idle', ax: 0, ay: 0, tipX: 0, tipY: 0, len: 0, cd: 0, aimX: 0, aimY: 1, unlocked: false },
    runesLit: [], checkpoint: null, night: 0,
    route, events: [],
    _fall: { t: 0, from: 0 },
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
  const live = state.phase === 'climbing' || state.phase === 'falling' || state.phase === 'swinging' ||
    state.phase === 'grounded';

  updateWeb(state, inp, dt);
  if (live) {
    // Letting go is a stick push now, one stick per hand (B51). Done before the hands move so a
    // release and the reach it starts land on the same frame.
    releaseFromStick(state, state.hands.L, inp.L);
    releaseFromStick(state, state.hands.R, inp.R);
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
  // Mid-fall is exactly when you want to shoot: the line is the only thing left that can stop you.
  const canShoot = state.phase === 'climbing' || state.phase === 'falling' || state.phase === 'swinging';

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
      const b = state.body;
      w.len = Math.hypot(b.x - w.ax, b.y - w.ay);
      state.phase = 'swinging';
      releaseBoth(state);
      // The yank: a line going taut does not politely take over, it pulls. A kick along the
      // line, and the constraint immediately shortens it a little so you are drawn upward.
      const dx = (w.ax - b.x) / Math.max(1e-4, w.len);
      const dy = (w.ay - b.y) / Math.max(1e-4, w.len);
      b.vx += dx * CFG.WEB_YANK;
      b.vy += dy * CFG.WEB_YANK;
      w.len = Math.max(CFG.SWING_MIN_LEN, w.len - CFG.WEB_YANK_REEL);
      push(state, { type: 'webhit', yank: CFG.WEB_YANK });
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

// Where the shot would land from here. Exported so the reticle can show it while you aim,
// which is the whole difference between committing blind and committing on purpose.
export function aimPoint(state) {
  const w = state.web;
  const sh = shoulder(state, 'R');
  let m = Math.hypot(w.aimX, w.aimY);
  const ax0 = m < 1e-4 ? 0 : w.aimX / m;
  const ay0 = m < 1e-4 ? 1 : w.aimY / m;
  return {
    x: Math.max(-4.2, Math.min(4.2, sh.x + ax0 * CFG.WEB_RANGE)),
    y: Math.max(CFG.FLOOR + 0.4, Math.min(state.route.top + 1.4, sh.y + ay0 * CFG.WEB_RANGE)),
    from: sh,
  };
}

function fire(state) {
  const w = state.web;
  const sh = shoulder(state, 'R');
  const p = aimPoint(state);
  w.ax = p.x;
  w.ay = p.y;
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

// Grabs work while climbing, while swinging, and in the grace window just after a slip — the
// quarter second in which a hand can still find rock. Nothing else stops a fall.
function canGrab(state) {
  return state.phase === 'climbing' || state.phase === 'swinging' || state.phase === 'grounded' ||
    (state.phase === 'falling' && state._fall.t <= CFG.GRACE);
}

// A hand grabs anywhere on a hold's surface (its own radius plus a fingertip's overlap), so a
// big rock is a big target and a crimp is a small one. Since B51 this is also the HOVER radius:
// stay inside it for HOVER_GRAB_DWELL and the fingers close on their own.
export function grabRadius(hold) {
  // Deliberately NOT floored at SNAP any more: a crimp is a small target and should feel like
  // one. You must have the hand on the rock, anywhere on it, and nowhere else.
  return (hold.size || 0.12) + CFG.GRAB_EDGE;
}

// Letting go, with no button to do it (B51): push this hand's own stick past the deadzone and
// the fingers open, and the same push is already steering the hand where it is going. A stick
// under the deadzone leaves a gripping hand exactly where it is. One stick, one hand — pushing
// the left stick can never drop the right hand, so no single thumb can let go of the cliff.
//
// It is the PUSH that lets go, not the pushed stick: the stick has to come back inside the
// deadzone before it can let go again. Without that latch the stick you steered a hand across
// the wall with would drop that hand again the frame after it closed on the rock, for ever.
function releaseFromStick(state, hand, stick) {
  if (!hand.gripping) return;
  const sx = (stick && +stick.x) || 0, sy = (stick && +stick.y) || 0;
  if (Math.hypot(sx, sy) <= CFG.RELEASE_DEADZONE) { hand._relArm = true; return; }
  if (hand._relArm) release(state, hand, 'release');
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
  hand._hoverId = null;                    // whatever is under it now needs its own dwell
  hand._hoverT = 0;
  hand._regripT = CFG.REGRIP_LOCK;
  hand.tremble = Math.max(hand.tremble, 0.7);
  push(state, { type: 'crumble', hand: hand.side, holdId: fake.id });
}

// The hold this hand just came off is locked out of it, so that a hand still sitting inside that
// rock does not simply take it again — which under an automatic grab would mean never being able
// to let go at all. Falling lifts the lock, because once you are off the wall every hold counts
// and closing again on the rock you just let go of is the grace window's panic re-grab — but not
// when that rock is what spat the hand off: fingers that have just failed there do not re-close
// on it, and without that a spent hand would grab and slip and grab again on the spot.
function skipId(state, hand) {
  if (state.phase === 'falling' && !hand._slipped) return null;
  return hand._skipId;
}

// The hold this hand may take next: the nearest one that is neither the hold it just let go of
// (while climbing) nor the hold the other hand is holding — two hands never share a hold.
function targetHold(state, hand) {
  const other = state.hands[OTHER[hand.side]];
  return nearestHold(state, hand.x, hand.y, skipId(state, hand), other.gripping ? other.holdId : null);
}

// What the hand is visibly OVER, for Hand.nearId / Hand.hover and the glow the world draws from
// them. The skipped hold counts here even though it cannot be taken: a hand resting on the rock
// it just released must light THAT rock, not point at some other one across the wall.
function cueHold(state, hand) {
  const other = state.hands[OTHER[hand.side]];
  return nearestHold(state, hand.x, hand.y, other.gripping ? other.holdId : null);
}

// The grab, with no button (B51). A free hand that stays on a piece of rock for HOVER_GRAB_DWELL
// closes on it. The dwell is the whole difference between reaching for a hold and sweeping past
// one; leaving the rock before the fingers close is the 'miss' the HUD shakes on, and is the only
// miss there is now that nothing is tapped. Decoys are taken exactly like real rock (B10).
function updateHoverGrab(state, hand, dt, cue) {
  // Mid-fall the regrip beat is waived: the fingers have to be allowed to close on whatever they
  // are still touching, which is the whole of the grace window now that nothing is tapped.
  // And the right hand does not grab rock while the line is out — a hand that is aiming, or has
  // just shot, must not snag a hold and cancel the shot out from under you.
  const eligible = canGrab(state) &&
    (state.phase === 'falling' || hand._regripT <= 0) &&
    !(hand.side === 'R' && state.web.mode !== 'idle');
  let hold = null, fake = false;
  if (eligible) {
    // the cue already found the nearest rock; only re-search when it is the one locked out
    const skip = skipId(state, hand);
    const near = cue && cue.hold.id === skip ? targetHold(state, hand) : cue;
    const fk = nearestFake(state, hand.x, hand.y);
    if (fk && fk.d <= grabRadius(fk.hold) && (!near || fk.d < near.d)) { hold = fk.hold; fake = true; }
    else if (near && near.d <= grabRadius(near.hold)) hold = near.hold;
  }
  const id = hold ? hold.id : null;
  if (id !== hand._hoverId) {
    // came off the rock (or slid onto a different one) before the fingers closed
    if (hand._hoverId !== null && eligible) push(state, { type: 'miss', hand: hand.side, holdId: hand._hoverId });
    hand._hoverId = id;
    hand._hoverT = 0;
    return;
  }
  if (id === null) return;
  hand._hoverT += dt;
  if (hand._hoverT < CFG.HOVER_GRAB_DWELL) return;
  hand._hoverId = null;
  hand._hoverT = 0;
  if (fake) crumble(state, hand, hold);
  else grab(state, hand, hold);
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
  hand._hoverId = null;
  hand._hoverT = 0;
  hand._relArm = false;                // the stick that steered the hand here must not also drop it
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
  // Taking rock clears where the hand was parked, so letting go of this hold hangs the arm at
  // the rest offset rather than throwing it back to wherever the last reach ended.
  hand._stick.x = hand._stick.y = 0;
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
    state.phase = 'climbing';   // also ends a swing, a stand at the base, or a fall inside the grace window
  }
}

function release(state, hand, type) {
  const holdId = hand.holdId;
  hand.gripping = false;
  hand.holdId = null;
  hand._hoverId = null;
  hand._hoverT = 0;
  // Every way off a hold locks that hold out of this hand until the hand has left it — a slip and
  // a sloper timing out included, because the fingers are still inside the rock's radius and an
  // automatic grab would otherwise take it straight back and drop you again a moment later.
  // The lock is a distance, not a timer: see updateHand.
  hand._skipId = holdId;
  hand._slipped = type === 'slip';
  hand._regripT = CFG.REGRIP_LOCK;
  push(state, { type, hand: hand.side, holdId });
  if (state.phase === 'climbing' && !anyGripping(state)) beginFall(state);
}

function beginFall(state) {
  state.phase = 'falling';
  state._fall.t = 0;
  state._fall.from = state.body.y;
  // Nothing catches you. Every fall is the whole cliff, down to the ground and the death screen
  // (B43 — Maor had the rope removed after playing it). The only way out is the grace window.
  push(state, { type: 'fall' });
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
    b.vy = Math.max(b.vy, -CFG.FALL_TERMINAL);         // terminal velocity, so it reads as a plunge
    if (b.y <= CFG.FLOOR) {
      b.y = CFG.FLOOR;
      b.vx = 0; b.vy = 0;
      // Letting go while your feet are still on the ground is not a fall: at the base of the
      // cliff you are standing, not hanging, so you stay standing and can take the rock again --
      // stepping back under the line of holds, because on the ground you have feet.
      if (f.from <= CFG.FLOOR + CFG.HANG_TWO) {
        state.phase = 'grounded';
        return;
      }
      state.phase = 'fallen';
      push(state, { type: 'impact' });
      push(state, { type: 'fallen' });
    }
    return;
  }
  if (state.phase === 'grounded') {
    // Standing at the base with nothing held: walk back under the start holds and wait. The
    // moment a hand takes rock, `grabHold` puts the phase back to 'climbing'.
    const home = lineCenter(state, CFG.FLOOR + CFG.SHOULDER_DY + 0.35, b.x);
    spring(b, 'x', 'vx', home, CFG.SWING_OMEGA, CFG.SWING_ZETA, dt);
    b.y = CFG.FLOOR; b.vy = 0;
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
    // The stick steers the hand while a thumb is on it, and the hand STAYS where it is left
    // (B45: a reach is a thing you do once, not a thing you hold). `_stick` is the parked
    // target as an offset from the shoulder in REACH units, so the hand rides along when the
    // body moves instead of hanging in the air where you put it.
    const s = hand._stick;
    let sx = 0, sy = 0, m = 0;
    if (stickIn) {
      sx = +stickIn.x || 0; sy = +stickIn.y || 0;
      m = Math.hypot(sx, sy);
      if (m > 1) { sx /= m; sy /= m; m = 1; }
    }
    // "Reads zero" is not "let go of": at the start of a climb the sticks read zero and both
    // hands are on rock. `active` (input.js) says a thumb, the cursor or a key is on this stick
    // right now, so a thumb resting at the middle of the ring is still steering. An Input
    // without the flag keeps the pre-B45 meaning — only a non-zero stick steers — which is the
    // safe fallback, because ignoring a zero stick can only ever leave the hand where it is.
    if (m > 0.02 || (stickIn && stickIn.active === true)) { s.x = sx; s.y = sy; }
    // A null stick is not a released stick: it is `step` saying the phase is not live at all —
    // the title card, the summit, the death screen. Nobody is steering anything there, so the
    // hand lets go of its reach and relaxes to the rest offset on the same spring, rather than
    // holding an arm out mid-move through the whole of the crane over the altar or the drop.
    else if (!stickIn) { s.x = 0; s.y = 0; }

    // Target = shoulder + stick·REACH, blended with the rest offset as the stick nears centre:
    // a hand that has not been steered since it last held rock hangs at rest.
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

    if (hand._regripT > 0) hand._regripT = Math.max(0, hand._regripT - dt);
    if (hand._skipId !== null) {
      const sk = state._holdById.get(hand._skipId);
      // Clear on DISTANCE ONLY — there is no timer behind it. With the grab automatic, a hand
      // parked on the hold it just let go of would otherwise be taken back by that hold with no
      // input at all, the moment any timer lapsed. It stays locked until the hand is actually off
      // the rock, which is always one deliberate stick push away.
      if (!sk || Math.hypot(sk.x - hand.x, sk.y - hand.y) > grabRadius(sk) + CFG.SKIP_CLEAR) hand._skipId = null;
    }

    const cue = cueHold(state, hand);
    hand.nearId = cue ? cue.hold.id : null;
    hand.nearDist = cue ? cue.d : Infinity;
    hand.hover = cue ? clamp01(1 - cue.d / CFG.HOVER_RANGE) : 0;
    updateHoverGrab(state, hand, dt, cue);
  }

  // Fingers curl onto a hold (a little anticipation when hovering); tremble grows as stamina fades.
  const curlT = hand.gripping ? 1 : 0.25 * hand.hover;
  hand.curl += (curlT - hand.curl) * (1 - Math.exp(-CFG.CURL_RATE * dt));
  const low = clamp01((CFG.TREMBLE_AT - hand.stamina) / CFG.TREMBLE_AT);
  const trembleT = hand.gripping ? low : 0.4 * low;
  hand.tremble += (trembleT - hand.tremble) * (1 - Math.exp(-CFG.TREMBLE_RATE * dt));
}
