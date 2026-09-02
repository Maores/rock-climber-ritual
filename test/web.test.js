// test/web.test.js — the web-zip: aiming, the shot, the pendulum, and letting go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, createClimber, startClimb, step, drainEvents, shoulder, cutWeb } from '../src/sim.js';

const DT = 1 / 120;
const inp = (o = {}) => ({ L: { x: 0, y: 0 }, R: { x: 0, y: 0 }, holdR: false, ...o });
// Mid-swing the free hand is steered down, away from the line of holds: with the grab automatic
// (B51) a hand left drifting over rock catches it and ends the swing, which is a feature but not
// what these tests are measuring.
const HANG = { x: 0, y: -1 };
const types = (s) => drainEvents(s).map((e) => e.type);

// A bare wall of the tests' own. The web-zip has nothing to do with the shape of the cliff, and
// the FIELD of holds B46 put on it gets in the way of measuring a pendulum: with the grab
// automatic (B51) a free hand drifting over rock takes it, and on a field there is rock
// everywhere, so every swing would end after a few frames. `catchRock` adds the one piece of
// stone the catch test needs, out to the side where the swing passes it.
function bareRoute(catchRock = false) {
  const holds = [
    { x: -0.25, y: 1.2 }, { x: 0.25, y: 1.2 },       // the start pair
    { x: -0.25, y: 14 }, { x: 0.25, y: 14 },         // the ledge these tests shoot from
    ...(catchRock ? [{ x: 2.5, y: 10.35 }] : []),
  ].map((h, id) => ({ id, size: 0.16, grip: 'jug', kind: 'hold', lit: false, angle: 0, ...h }));
  holds.push({ id: holds.length, x: 0, y: 24, size: 0.2, grip: 'jug', kind: 'summit', lit: false, angle: 0 });
  return { holds, fakes: [], top: 24, seed: 0 };
}

// Put the climber on a pair of holds near `y`. Shooting from the very bottom of the route is
// not a swing: a 7 m line from down there simply parks you on the ground, correctly.
function lift(s, y) {
  const H = s.route.holds;
  let i = 0;
  for (let k = 0; k < H.length - 1; k++) if (Math.abs(H[k].y - y) < Math.abs(H[i].y - y)) i = k;
  const a = H[i], b = H[i + 1];
  const L = a.id % 2 === 0 ? a : b, R = a.id % 2 === 0 ? b : a;
  for (const [side, h] of [['L', L], ['R', R]]) {
    Object.assign(s.hands[side], { x: h.x, y: h.y, tx: h.x, ty: h.y, vx: 0, vy: 0, gripping: true, holdId: h.id, armed: false, stamina: 1, gripDX: 0, gripDY: 0 });
  }
  Object.assign(s.body, { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 - CFG.HANG_TWO, vx: 0, vy: 0 });
  s.height = s.body.y;
  return s;
}

function climber({ unlocked = true, at = 14, catchRock = false } = {}) {
  const s = createClimber(bareRoute(catchRock));
  startClimb(s);
  s.web.unlocked = unlocked;
  lift(s, at);
  drainEvents(s);
  return s;
}
function run(s, seconds, input = inp()) {
  for (let t = 0; t < seconds; t += DT) step(s, input, DT);
}
// Free the right hand (the aim itself is a stick push, which is how a hand lets go now — B51),
// then hold the pad long enough to aim and let go to fire.
function shoot(s, aim = { x: 0.2, y: 1 }) {
  step(s, inp(), DT);                               // stick at centre: the release arms
  step(s, inp({ R: aim }), DT);                     // pushed: the right hand lets go of its hold
  run(s, 0.3, inp({ L: HANG }));
  drainEvents(s);
  run(s, CFG.WEB_AIM_HOLD + 0.05, inp({ holdR: true, R: aim, L: HANG }));
  step(s, inp({ holdR: false, R: aim, L: HANG }), DT);   // release fires
}

test('web: locked, a held pad does nothing at all', () => {
  const s = climber({ unlocked: false });
  step(s, inp(), DT);
  step(s, inp({ R: { x: 0, y: 1 } }), DT);
  run(s, 0.4, inp({ L: HANG }));
  drainEvents(s);
  run(s, 0.6, inp({ holdR: true, R: { x: 0, y: 1 }, L: HANG }));
  assert.equal(s.web.mode, 'idle');
  assert.ok(!types(s).includes('aim'));
});

test('web: holding the grip aims, releasing fires, and the shot flies to its anchor', () => {
  const s = climber();
  shoot(s);
  assert.equal(s.web.mode, 'flying', 'the shot is in the air');
  const ev = types(s);
  assert.ok(ev.includes('aim'), 'aiming was announced');
  assert.ok(ev.includes('webshot'), 'the shot was announced');
  // it starts at the hand and ends at the anchor
  const sh = shoulder(s, 'R');
  assert.ok(Math.hypot(s.web.tipX - sh.x, s.web.tipY - sh.y) < 0.5, 'the tip starts at the hand');
  assert.ok(s.web.ay > s.body.y, 'aiming up anchors above you');
});

test('web: on contact both hands let go and the body starts swinging', () => {
  const s = climber();
  shoot(s);
  run(s, 0.6, inp({ holdR: true, L: HANG }));
  assert.equal(s.web.mode, 'attached');
  assert.equal(s.phase, 'swinging');
  assert.equal(s.hands.L.gripping, false);
  assert.equal(s.hands.R.gripping, false);
  assert.ok(s.web.len > 0, 'the line has a length');
});

test('swing: the body stays exactly on the line, and swings rather than falling straight', () => {
  const s = climber();
  shoot(s, { x: 0.55, y: 1 });
  run(s, 0.6, inp({ holdR: true, L: HANG }));
  assert.equal(s.phase, 'swinging');
  const { ax, ay, len } = s.web;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < 400; i++) {
    step(s, inp({ holdR: true, L: HANG }), DT);
    assert.equal(s.phase, 'swinging', 'the free hand must stay off the rock for this measurement');
    const d = Math.hypot(s.body.x - ax, s.body.y - ay);
    // exactly on the line, except on the frames where the ground is holding the body up
    if (!s.web.grounded) assert.ok(Math.abs(d - s.web.len) < 1e-6, `off the line by ${(d - s.web.len).toExponential(2)}`);
    assert.ok(Number.isFinite(s.body.x) && Number.isFinite(s.body.y), 'the pendulum stayed finite');
    minX = Math.min(minX, s.body.x); maxX = Math.max(maxX, s.body.x);
  }
  assert.ok(maxX - minX > 0.25, `it should swing sideways, travelled ${(maxX - minX).toFixed(2)} m`);
  assert.ok(len > 0);
});

test('swing: pushing the stick up reels you closer, never past the minimum', () => {
  const s = climber();
  shoot(s, { x: 0.2, y: 1 });
  run(s, 0.6, inp({ holdR: true, L: HANG }));
  assert.equal(s.phase, 'swinging');
  const before = s.web.len;
  run(s, 4, inp({ holdR: true, L: { x: 0, y: 1 } }));   // the same stick reels and steers the hand
  assert.ok(s.web.len < before, `reeled in from ${before.toFixed(2)} to ${s.web.len.toFixed(2)}`);
  assert.ok(s.web.len >= CFG.SWING_MIN_LEN - 1e-9, 'never reels past the minimum');
});

test('swing: letting go throws you, and the cooldown blocks an instant second shot', () => {
  const s = climber();
  shoot(s, { x: 0.6, y: 1 });
  run(s, 0.9, inp({ holdR: true, L: HANG }));
  assert.equal(s.phase, 'swinging');
  drainEvents(s);
  step(s, inp({ holdR: false, L: HANG }), DT);     // let go of the line
  assert.equal(s.web.mode, 'idle');
  assert.ok(s.phase === 'falling' || s.phase === 'caught', `let go into ${s.phase}`);
  assert.notEqual(s.phase, 'swinging');
  assert.ok(types(s).includes('webcut'));
  assert.ok(s.web.cd > 0, 'the cooldown started');
  // a fresh hold cannot fire while the cooldown runs
  run(s, CFG.WEB_AIM_HOLD + 0.1, inp({ holdR: true, R: { x: 0, y: 1 }, L: HANG }));
  assert.equal(s.web.mode, 'idle', 'no shot during the cooldown');
});

test('web: catching rock mid-swing ends the swing and returns you to climbing', () => {
  const s = climber({ catchRock: true });
  shoot(s, { x: 0.55, y: 1 });          // a swing, not a hoist: a near-vertical line just lifts
                                        // you back onto the ledge you left
  run(s, 0.6, inp({ holdR: true, L: HANG }));
  assert.equal(s.phase, 'swinging');
  // steer the left hand onto the nearest hold and take it
  const near = s.route.holds.reduce((best, h) => {
    const d = Math.hypot(h.x - s.hands.L.x, h.y - s.hands.L.y);
    return d < best.d ? { h, d } : best;
  }, { h: null, d: Infinity });
  // keep the hand pointed at it while the swing carries you across: steering the hand onto rock
  // is the whole catch, and a stick left at one fixed angle would sweep straight past
  for (let i = 0; i < 300 && !s.hands.L.gripping; i++) {
    const sh = shoulder(s, 'L');
    const v = { x: (near.h.x - sh.x) / CFG.REACH, y: (near.h.y - sh.y) / CFG.REACH };
    const m = Math.hypot(v.x, v.y); if (m > 1) { v.x /= m; v.y /= m; }
    step(s, inp({ holdR: true, L: v }), DT);
  }
  assert.equal(s.hands.L.gripping, true, 'the hand steered onto the rock took it');
  assert.equal(s.phase, 'climbing', 'a caught hold ends the swing');
  assert.equal(s.web.mode, 'idle');
});

test('swing: the free hand parks where the pump left it (B45)', () => {
  const s = climber();
  shoot(s);
  run(s, 0.6, inp({ holdR: true, L: HANG }));
  assert.equal(s.phase, 'swinging');
  run(s, 0.5, inp({ holdR: true, L: { x: 0.9, y: 0.2 } }));   // the left stick pumps the swing, and steers
  const sh0 = shoulder(s, 'L');
  const off = { x: s.hands.L.tx - sh0.x, y: s.hands.L.ty - sh0.y };
  run(s, 1.5, inp({ holdR: true }));                          // thumb off: the pumping stops, the arm stays out
  const sh1 = shoulder(s, 'L');
  assert.equal(s.phase, 'swinging');
  assert.ok(Math.abs(s.hands.L.tx - sh1.x - off.x) < 1e-9 && Math.abs(s.hands.L.ty - sh1.y - off.y) < 1e-9,
    'the hand target rides the shoulder around the swing instead of drifting back to rest');
});

test('web: cutWeb from outside is safe when nothing is out', () => {
  const s = climber();
  cutWeb(s);
  assert.equal(s.web.mode, 'idle');
  assert.equal(s.phase, 'climbing');
});
