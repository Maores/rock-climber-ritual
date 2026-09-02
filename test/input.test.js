import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInput } from '../src/input.js';

// Minimal stand-ins for DOM elements and window: listeners + geometry + pointer capture.
class FakeEl {
  constructor(rect) {
    this.rect = rect; this.listeners = new Map(); this.style = {}; this.captured = null;
    this.classList = { on: new Set(), add(c) { this.on.add(c); }, remove(c) { this.on.delete(c); } };
  }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture(id) { if (this.captured === id) this.captured = null; }
  count() { let n = 0; for (const s of this.listeners.values()) n += s.size; return n; }
  fire(type, ev = {}) {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...ev };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e);
    return e;
  }
}
const ring = (left, top, size = 120) => new FakeEl({ left, top, width: size, height: size });

function rig({ keyboard = true, look = false, hands = null, title = false } = {}) {
  const calls = [];
  const hud = {
    sticks: { L: ring(20, 600), R: ring(250, 600) },
    grips: { L: ring(20, 520, 60), R: ring(250, 520, 60) },
    setStick(side, x, y) { calls.push([side, x, y]); },
  };
  if (title) hud.elements = { title: Object.assign(new FakeEl({}), { hidden: true }) };
  const win = new FakeEl({});
  // The play surface is the canvas: a 390x844 phone, the size B34 was measured at.
  const canvas = look ? new FakeEl({ left: 0, top: 0, width: 390, height: 844 }) : null;
  let t = 0;
  const clock = { now: () => t };
  const input = createInput({ hud, keyboard, win, now: clock.now, surface: canvas, getHands: hands });
  // Let `ms` pass in 20 ms frames, reading every frame like the game loop; returns the last read.
  clock.advance = (ms) => { let r; for (let done = 0; done < ms; done += 20) { t += 20; r = input.read(); } return r; };
  return { hud, win, canvas, clock, input, calls };
}
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);
const pt = (el, fx, fy, pointerId = 1) => {
  const r = el.rect;
  return { pointerId, clientX: r.left + r.width / 2 + fx * (r.width / 2), clientY: r.top + r.height / 2 + fy * (r.height / 2) };
};

test('input: idle read is all zeros with no taps, and feeds the HUD knobs', () => {
  const { input, calls } = rig();
  assert.deepEqual(input.read(), { L: { x: 0, y: 0, active: false }, R: { x: 0, y: 0, active: false }, tapL: false, tapR: false, look: { x: 0, y: 0, active: false, homing: false, down: 85 }, holdL: false, holdR: false });
  assert.deepEqual(calls, [['L', 0, 0], ['R', 0, 0]]);
});

test('input: touch sticks map pointer position to the unit disc with y up, and drop to zero on release', () => {
  const { hud, input } = rig();
  const el = hud.sticks.L;
  const down = el.fire('pointerdown', pt(el, 0.5, -0.5));       // right and UP on screen
  assert.equal(down.defaultPrevented, true);
  assert.equal(el.captured, 1);
  let r = input.read();
  near(r.L.x, 0.5); near(r.L.y, 0.5);
  assert.deepEqual(r.R, { x: 0, y: 0, active: false });
  el.fire('pointermove', pt(el, 2, 2));                          // far outside the ring → clamped
  r = input.read();
  near(Math.hypot(r.L.x, r.L.y), 1);
  near(r.L.x, Math.SQRT1_2); near(r.L.y, -Math.SQRT1_2);
  el.fire('pointermove', pt(el, 0, -1));                         // top edge → straight up
  r = input.read();
  near(r.L.x, 0); near(r.L.y, 1);
  el.fire('pointerup', pt(el, 0, -1));
  assert.equal(el.captured, null);
  r = input.read();
  assert.deepEqual(r.L, { x: 0, y: 0, active: false });   // nothing on the stick: the sim parks the hand
  assert.equal(el.style.touchAction, 'none');
});

test('input: one pointer per stick; other pointers and other ids are ignored', () => {
  const { hud, input } = rig();
  const el = hud.sticks.R;
  el.fire('pointerdown', pt(el, 0, -1, 7));
  el.fire('pointerdown', pt(el, 1, 0, 8));                       // second finger ignored
  el.fire('pointermove', pt(el, 1, 0, 8));
  let r = input.read();
  near(r.R.x, 0); near(r.R.y, 1);
  el.fire('pointerup', pt(el, 0, 0, 8));                         // wrong id: stick stays held
  r = input.read();
  near(r.R.y, 1);
  el.fire('pointercancel', pt(el, 0, 0, 7));
  r = input.read();
  assert.deepEqual(r.R, { x: 0, y: 0, active: false });
});

test('input: grip taps are edge-triggered — one tap per read no matter how many pointerdowns', () => {
  const { hud, input } = rig();
  hud.grips.L.fire('pointerdown', { pointerId: 1 });
  hud.grips.L.fire('pointerdown', { pointerId: 2 });
  let r = input.read();
  assert.equal(r.tapL, true);
  assert.equal(r.tapR, false);
  r = input.read();
  assert.equal(r.tapL, false);
  hud.grips.R.fire('pointerdown', { pointerId: 3 });
  r = input.read();
  assert.equal(r.tapR, true);
  assert.equal(input.read().tapR, false);
});

test('input: keyboard integrates a virtual stick at 2.5 units/s and holds its value', () => {
  const { win, clock, input } = rig();
  input.read();
  win.fire('keydown', { code: 'KeyW', key: 'w' });
  clock.advance(200);
  let r = input.read();
  near(r.L.x, 0); near(r.L.y, 0.5, 1e-9);
  clock.advance(1000);
  r = input.read();
  near(r.L.y, 1);                                                 // clamped at the rim
  win.fire('keyup', { code: 'KeyW', key: 'w' });
  clock.advance(2000);
  r = input.read();
  near(r.L.y, 1, 1e-9);                                           // holds without keys
  win.fire('keydown', { code: 'KeyA', key: 'a' });
  clock.advance(200);
  r = input.read();
  assert.ok(r.L.x < -0.3 && r.L.x > -0.6);
  assert.ok(Math.hypot(r.L.x, r.L.y) <= 1 + 1e-9);
  win.fire('keyup', { code: 'KeyA', key: 'a' });
  // Arrows drive the right stick; key repeats and unknown keys are harmless.
  win.fire('keydown', { code: 'ArrowRight', key: 'ArrowRight' });
  win.fire('keydown', { code: 'ArrowRight', key: 'ArrowRight', repeat: true });
  win.fire('keydown', { code: 'KeyZ', key: 'z' });
  clock.advance(400);
  r = input.read();
  near(r.R.x, 1); near(r.R.y, 0);
  win.fire('keydown', { code: 'ArrowDown', key: 'ArrowDown' });
  clock.advance(100);
  r = input.read();
  assert.ok(r.R.y < -0.2 && r.R.y > -0.3);
});

test('input: Q, Enter and Slash toggle grips and recenter that stick; Escape recenters both', () => {
  const { win, clock, input } = rig();
  input.read();
  win.fire('keydown', { code: 'KeyW', key: 'w' });
  win.fire('keydown', { code: 'ArrowUp', key: 'ArrowUp' });
  clock.advance(1000);
  win.fire('keyup', { code: 'KeyW', key: 'w' });
  win.fire('keyup', { code: 'ArrowUp', key: 'ArrowUp' });
  let r = input.read();
  near(r.L.y, 1); near(r.R.y, 1);
  const q = win.fire('keydown', { code: 'KeyQ', key: 'q' });
  assert.equal(q.defaultPrevented, true);
  r = input.read();
  assert.equal(r.tapL, true);
  assert.deepEqual(r.L, { x: 0, y: 0, active: true });   // a recenter is a command, not a released stick
  near(r.R.y, 1);
  win.fire('keydown', { code: 'Enter', key: 'Enter' });
  r = input.read();
  assert.equal(r.tapR, true);
  assert.deepEqual(r.R, { x: 0, y: 0, active: true });
  win.fire('keydown', { code: 'Slash', key: '/' });
  assert.equal(input.read().tapR, true);
  win.fire('keydown', { code: 'Enter', key: 'Enter', repeat: true });      // held Enter does not re-tap
  assert.equal(input.read().tapR, false);
  win.fire('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' });
  win.fire('keydown', { code: 'KeyD', key: 'd' });
  clock.advance(1000);
  r = input.read();
  near(r.L.x, 1); near(r.R.x, -1);
  win.fire('keyup', { code: 'ArrowLeft', key: 'ArrowLeft' });
  win.fire('keyup', { code: 'KeyD', key: 'd' });
  win.fire('keydown', { code: 'Escape', key: 'Escape' });
  r = input.read();
  assert.deepEqual(r.L, { x: 0, y: 0, active: true });
  assert.deepEqual(r.R, { x: 0, y: 0, active: true });
  assert.deepEqual(input.read().L, { x: 0, y: 0, active: false });   // the recenter lasts exactly one read
});

test('input: key names work without `code` (synthetic events), and blur drops held keys', () => {
  const { win, clock, input } = rig();
  input.read();
  win.fire('keydown', { key: 'ArrowUp' });
  clock.advance(400);
  near(input.read().R.y, 1);
  win.fire('keydown', { key: '/' });
  assert.equal(input.read().tapR, true);
  win.fire('keydown', { key: 'W' });
  win.fire('blur');
  clock.advance(1000);
  near(input.read().L.y, 0);
});

test('input: a pointer on a stick overrides the keyboard, and releasing it leaves nothing steering', () => {
  const { hud, win, clock, input } = rig();
  input.read();
  win.fire('keydown', { code: 'KeyW', key: 'w' });
  clock.advance(1000);
  win.fire('keyup', { code: 'KeyW', key: 'w' });
  near(input.read().L.y, 1);
  const el = hud.sticks.L;
  el.fire('pointerdown', pt(el, -0.4, 0));
  let r = input.read();
  near(r.L.x, -0.4); near(r.L.y, 0);
  el.fire('pointerup', pt(el, -0.4, 0));
  r = input.read();
  assert.deepEqual(r.L, { x: 0, y: 0, active: false });
});

test('input: long-press menus are suppressed on sticks and grips; losing pointer capture ends the drag', () => {
  const { hud, input } = rig();
  assert.equal(hud.sticks.L.fire('contextmenu', {}).defaultPrevented, true);
  assert.equal(hud.grips.R.fire('contextmenu', {}).defaultPrevented, true);
  const el = hud.sticks.R;
  el.fire('pointerdown', pt(el, 0, -1, 4));
  near(input.read().R.y, 1);
  el.fire('lostpointercapture', { pointerId: 9 });                // someone else's pointer: ignored
  near(input.read().R.y, 1);
  el.fire('lostpointercapture', { pointerId: 4 });
  assert.deepEqual(input.read().R, { x: 0, y: 0, active: false });
});

// ---- looking around: a drag on the play surface (B47) --------------------------------------
// The surface is the canvas, 390x844 here, and `look` holds DEGREES of yaw and pitch clamped to
// the arc the hands allow: loose 90 either way / 62 up / 85 down with no hands known, the neck's
// 60 / 60 / 40 / 55 with both hands on the rock. A drag across the whole viewport sweeps the whole
// arc, so a quarter of the width is a quarter of 180 = 45 degrees on the loose arc.
const drag = (el, from, to, pointerId = 1, extra = {}) => {
  el.fire('pointerdown', { pointerId, clientX: from[0], clientY: from[1], ...extra });
  el.fire('pointermove', { pointerId, clientX: to[0], clientY: to[1], ...extra });
};
const bothOn = () => ({ L: { gripping: true }, R: { gripping: true } });

test('look: dragging the screen turns the head in degrees of the live arc, and the view stays', () => {
  const { canvas, input } = rig({ look: true });
  drag(canvas, [100, 400], [197.5, 400]);                // a quarter of the width: a quarter of 180
  let r = input.read();
  near(r.look.x, 45);
  near(r.look.y, 0);
  assert.equal(r.look.active, true);
  canvas.fire('pointermove', { pointerId: 1, clientX: 197.5, clientY: 189 });   // 211 px UP
  r = input.read();
  near(r.look.y, 147 * 211 / 844);                       // 62 up + 85 down over the full height
  canvas.fire('pointerup', { pointerId: 1 });
  r = input.read();
  assert.equal(r.look.active, false);
  near(r.look.x, 45);                                    // the view stays where it was left
  near(r.look.y, 147 * 211 / 844);
});

test('look: the arc is the neck when both hands are on the rock', () => {
  const { canvas, input } = rig({ look: true, hands: bothOn });
  input.read();
  drag(canvas, [100, 400], [197.5, 400]);                // the same quarter width, a 120 deg arc
  near(input.read().look.x, 30);
  assert.equal(input.read().look.down, 55);              // and the rig scales its vertigo by this
});

test('look: a thumb inside a stick never starts a look, and the two run side by side', () => {
  const { hud, canvas, input } = rig({ look: true });
  const el = hud.sticks.L;
  el.fire('pointerdown', pt(el, 0, -1, 1));              // thumb on the left stick
  el.fire('pointermove', pt(el, 0, -1, 1));
  // the same pointer moving over the canvas is not a look: it never came down there
  canvas.fire('pointermove', { pointerId: 1, clientX: 300, clientY: 400 });
  let r = input.read();
  near(r.L.y, 1);
  assert.deepEqual({ x: r.look.x, y: r.look.y, active: r.look.active }, { x: 0, y: 0, active: false });
  // a SECOND finger on the bare screen looks, while the first keeps steering the hand
  drag(canvas, [300, 400], [397.5, 400], 2);
  r = input.read();
  near(r.L.y, 1);
  assert.equal(r.L.active, true);
  near(r.look.x, 45);
});

test('look: the accumulator survives the lift, a second drag adds to it, and it clamps to the arc', () => {
  const { canvas, input } = rig({ look: true });
  drag(canvas, [100, 400], [178, 400]);                  // +36
  canvas.fire('pointerup', { pointerId: 1 });
  near(input.read().look.x, 36);
  drag(canvas, [50, 400], [128, 400], 2);                // +36 again, from wherever it was
  near(input.read().look.x, 72);
  canvas.fire('pointerup', { pointerId: 2 });
  drag(canvas, [0, 844], [390, 0], 3);                   // a whole screen: past both ends
  let r = input.read();
  near(r.look.x, 90);                                    // the loose arc: 90 across, 62 up
  near(r.look.y, 62);
  canvas.fire('pointerup', { pointerId: 3 });
  drag(canvas, [390, 0], [0, 844], 4);
  r = input.read();
  near(r.look.x, -90);
  near(r.look.y, -85);                                   // ...and 85 down, which is further
});

test('look: letting a hand go does not move the view, it only widens what you can reach', () => {
  const hands = { L: { gripping: true }, R: { gripping: true } };
  const { canvas, clock, input } = rig({ look: true, hands: () => hands });
  input.read();
  drag(canvas, [100, 400], [262.5, 400]);                // +50, inside the neck's 60
  canvas.fire('pointerup', { pointerId: 1 });
  const before = input.read().look.x;
  assert.ok(Math.abs(before - 50) < 0.1, `dragged to ${before}`);
  hands.R.gripping = false;                              // a hand lets go: the arc widens to 180
  const after = clock.advance(500).look.x;
  assert.ok(Math.abs(after - before) < 1, `a release must not pan the view: ${before} -> ${after}`);
  // ...and the head can now go further than the neck ever could
  drag(canvas, [100, 400], [297.5, 400], 2);
  assert.ok(input.read().look.x > 60, 'the wider arc is reachable');
});

test('look: taking the rock eases the view home over ~0.4 s, and a fall does too', () => {
  const hands = { L: { gripping: false }, R: { gripping: true } };
  const { canvas, clock, input } = rig({ look: true, hands: () => hands });
  input.read();
  // the left hand is the free one, so the 145 of arc is to the LEFT; dragging the other way would
  // stop at the 35 you can crane over your own gripping shoulder
  drag(canvas, [300, 400], [222, 400]);                  // -36 of the 180 deg one-hand arc
  canvas.fire('pointerup', { pointerId: 1 });
  const start = -input.read().look.x;
  near(start, 36);
  clock.advance(400);
  near(input.read().look.x, -36, 1e-9);                  // nothing moved: the view stays put
  hands.L.gripping = true;                               // a grab: a new place to be
  let r = clock.advance(100);
  assert.ok(-r.look.x > 0.35 * start && -r.look.x < 0.55 * start, `eased, not snapped: ${r.look.x}`);
  assert.equal(r.look.homing, true, 'and it tells the rig, which must not ease it a second time');
  r = clock.advance(320);
  assert.ok(Math.abs(r.look.x) < 0.07 * start, `~home after 0.4 s: ${r.look.x}`);
  r = clock.advance(600);
  near(r.look.x, 0);
  assert.equal(r.look.homing, false);
  // and the moment the last hand leaves the rock (the fall) does the same
  drag(canvas, [300, 400], [222, 400], 5);              // both hands are on now: the neck's 120
  canvas.fire('pointerup', { pointerId: 5 });
  near(input.read().look.x, -24);
  hands.L.gripping = hands.R.gripping = false;
  r = clock.advance(1000);
  near(r.look.x, 0);
});

test('look: on a desktop the mouse buttons stay the grips — the cursor looks with Shift', () => {
  const { canvas, input } = rig({ look: true });
  drag(canvas, [100, 400], [197.5, 400], 1, { pointerType: 'mouse', button: 0 });
  near(input.read().look.x, 0);                          // a plain left drag is a grip, not a look
  drag(canvas, [100, 400], [197.5, 400], 2, { pointerType: 'mouse', button: 0, shiftKey: true });
  near(input.read().look.x, 45);
  canvas.fire('pointerup', { pointerId: 2 });
  const mid = canvas.fire('pointerdown', { pointerType: 'mouse', pointerId: 3, button: 1, clientX: 100, clientY: 400 });
  assert.equal(mid.defaultPrevented, true, 'no autoscroll widget under the drag');
  canvas.fire('pointermove', { pointerType: 'mouse', pointerId: 3, button: 1, clientX: 148.75, clientY: 400 });
  near(input.read().look.x, 67.5);
});

test('look: a mouse look never drags the hand, and the hand keeps its target when it ends', () => {
  const hud = { sticks: { L: ring(20, 600), R: ring(250, 600) }, grips: {} };
  const view = ring(0, 0, 800);
  const input = createInput({
    hud, keyboard: false, win: new FakeEl({}), now: () => 0, mouse: view,
    getHands: () => ({ L: { gripping: true }, R: { gripping: false } }),
  });
  view.fire('pointermove', { pointerType: 'mouse', clientX: 500, clientY: 300 });
  let r = input.read();
  const parked = { x: r.R.x, y: r.R.y };
  assert.ok(Math.abs(parked.x) > 0.1 && r.R.active === true);
  // the middle button turns the head; the cursor moving with it must not drag the hand along
  view.fire('pointerdown', { pointerType: 'mouse', pointerId: 9, button: 1, clientX: 500, clientY: 300 });
  view.fire('pointermove', { pointerType: 'mouse', pointerId: 9, button: 1, clientX: 700, clientY: 300 });
  r = input.read();
  assert.ok(r.look.x > 0, 'the head turned');
  assert.deepEqual(r.R, { x: 0, y: 0, active: false }, 'the hand parks where it was, and is not steered');
  view.fire('pointerup', { pointerType: 'mouse', pointerId: 9, button: 1, clientX: 700, clientY: 300 });
  r = input.read();
  near(r.R.x, parked.x); near(r.R.y, parked.y);          // ...and does not jump when the drag ends
  assert.equal(r.R.active, true);
  input.dispose();
});

test('look: pointercancel ends a look, and the newest finger takes it over', () => {
  const { canvas, input } = rig({ look: true });
  drag(canvas, [100, 400], [178, 400], 1);               // +36
  canvas.fire('pointerdown', { pointerId: 2, clientX: 300, clientY: 400 });   // a second finger waits
  canvas.fire('pointermove', { pointerId: 2, clientX: 350, clientY: 400 });   // ...and does nothing yet
  let r = input.read();
  near(r.look.x, 36);
  canvas.fire('pointercancel', { pointerId: 1 });        // the browser takes the first finger away
  r = input.read();
  assert.equal(r.look.active, true, 'the waiting finger takes the drag over');
  canvas.fire('pointermove', { pointerId: 2, clientX: 428, clientY: 400 });   // +36 more, from 350
  near(input.read().look.x, 72);
  canvas.fire('pointercancel', { pointerId: 2 });
  assert.equal(input.read().look.active, false);
  near(input.read().look.x, 72);                         // and the view still stays where it was
});

test('look: a drag is ignored while the title screen is still on the glass', () => {
  const { canvas, hud, input } = rig({ look: true, title: true });
  hud.elements.title.hidden = false;                     // the title, or its 0.9 s fade
  drag(canvas, [100, 400], [197.5, 400]);
  near(input.read().look.x, 0);
  canvas.fire('pointerup', { pointerId: 1 });
  hud.elements.title.hidden = true;                      // gone: the climb owns the screen now
  drag(canvas, [100, 400], [197.5, 400], 2);
  near(input.read().look.x, 45);
});

test('look: Shift and a stick still turn the head, and the hand stays where it is', () => {
  const { hud, win, clock, input } = rig({ look: true });
  const el = hud.sticks.R;
  el.fire('pointerdown', pt(el, 1, 0));                  // right stick pushed fully right
  near(input.read().R.x, 1);
  win.fire('keydown', { key: 'Shift' });
  const r = clock.advance(500);
  assert.equal(r.look.active, true);
  const turned = r.look.x;
  assert.ok(turned > 30 && turned < 42, `0.42 arcs/s over half a second of a 180 deg arc: ${turned}`);
  assert.deepEqual(r.R, { x: 0, y: 0, active: false });  // the hand is not steered; it parks (B45)
  win.fire('keyup', { key: 'Shift' });
  const after = clock.advance(500);
  near(after.look.x, turned, 1e-9);                      // and the view stays where Shift left it
  near(after.R.x, 1);
});

test('input: keyboard can be disabled, hud can be missing, dispose removes every listener', () => {
  const a = rig({ keyboard: false });
  assert.equal(a.win.count(), 0);
  assert.ok(a.hud.sticks.L.count() > 0);
  a.input.dispose();
  assert.equal(a.hud.sticks.L.count(), 0);
  assert.equal(a.hud.grips.R.count(), 0);
  a.hud.grips.L.fire('pointerdown', { pointerId: 1 });
  assert.equal(a.input.read().tapL, false);

  const b = rig();
  assert.ok(b.win.count() >= 3);
  b.input.dispose();
  assert.equal(b.win.count(), 0);

  const bare = createInput({ hud: null, keyboard: true, win: null });
  assert.deepEqual(bare.read(), { L: { x: 0, y: 0, active: false }, R: { x: 0, y: 0, active: false }, tapL: false, tapR: false, look: { x: 0, y: 0, active: false, homing: false, down: 85 }, holdL: false, holdR: false });
  bare.dispose();
});

test('input: active tells a stick nobody is touching from a stick reading zero (B45)', () => {
  const { hud, win, clock, input } = rig();
  const el = hud.sticks.L;
  el.fire('pointerdown', pt(el, 0, 0));                            // thumb down on the dead centre
  let r = input.read();
  near(r.L.x, 0); near(r.L.y, 0);
  assert.equal(r.L.active, true, 'a thumb on the ring centre is still steering');
  el.fire('pointermove', pt(el, 0, -1));
  r = input.read();
  near(r.L.y, 1);
  assert.equal(r.L.active, true);
  assert.equal(r.R.active, false, 'the other stick is untouched');
  el.fire('pointerup', pt(el, 0, -1));
  r = input.read();
  assert.deepEqual(r.L, { x: 0, y: 0, active: false }, 'thumb off: the sim parks the hand');
  // Keyboard: active while a movement key is down; afterwards the virtual stick holds its value,
  // which is the parked hand the touch sticks now give too.
  win.fire('keydown', { code: 'ArrowUp', key: 'ArrowUp' });
  clock.advance(400);
  r = input.read();
  near(r.R.y, 1);
  assert.equal(r.R.active, true);
  win.fire('keyup', { code: 'ArrowUp', key: 'ArrowUp' });
  clock.advance(200);
  r = input.read();
  near(r.R.y, 1, 1e-9);
  assert.equal(r.R.active, false, 'no key down: a held value is a parked hand, not a live steer');
});

test('input: the WEB pad is the right grip and its drag is the aim that reaches the sim (B48)', () => {
  const knob = { L: null, R: null };
  const hud = {
    sticks: { L: ring(20, 600), R: ring(250, 600) }, grips: {},
    webButton: ring(250, 400, 60),
    setStick(side, x, y) { knob[side] = { x, y }; },
  };
  const input = createInput({ hud, keyboard: false, win: new FakeEl({}), now: () => 0 });
  const b = hud.webButton;
  const cx = 280, cy = 430;                                        // the pad's centre; PAD_RADIUS is 84 px
  assert.equal(input.read().holdR, false);
  b.fire('pointerdown', { pointerId: 5, clientX: cx, clientY: cy });
  let r = input.read();
  assert.equal(r.holdR, true, 'holding the pad IS the held right grip the sim aims on');
  assert.deepEqual(r.R, { x: 0, y: 1, active: true }, 'a fresh pad aims straight up');
  b.fire('pointermove', { pointerId: 5, clientX: cx + 84, clientY: cy - 84 });   // drag up and right
  r = input.read();
  near(r.R.x, Math.SQRT1_2); near(r.R.y, Math.SQRT1_2);
  assert.equal(r.R.active, true, 'the aim steers the hand too, the way the desktop cursor does');
  assert.deepEqual(knob.R, { x: 0, y: 0 }, 'the HUD knob still shows the stick, which nobody is touching');
  // A finger on the right stick does not outvote the pad while it is held.
  const st = hud.sticks.R;
  st.fire('pointerdown', pt(st, -1, 0, 6));
  r = input.read();
  near(r.R.x, Math.SQRT1_2); near(r.R.y, Math.SQRT1_2);
  st.fire('pointerup', pt(st, -1, 0, 6));
  b.fire('pointerup', { pointerId: 5 });                           // letting go looses the shot
  r = input.read();
  assert.equal(r.holdR, false);
  assert.deepEqual(r.R, { x: 0, y: 0, active: false }, 'and the hand parks where the aim left it (B45)');
  input.dispose();
});

test('input: the mouse is always steering the hand it drives, and a look drag takes nothing over', () => {
  const hud = { sticks: { L: ring(20, 600), R: ring(250, 600) }, grips: {} };
  const view = ring(0, 0, 800);                       // the canvas: the cursor AND the look surface
  const input = createInput({
    hud, keyboard: false, win: new FakeEl({}), now: () => 0, mouse: view,
    getHands: () => ({ L: { gripping: true }, R: { gripping: false } }),
  });
  view.fire('pointermove', { pointerType: 'mouse', clientX: 500, clientY: 300 });
  let r = input.read();
  assert.equal(r.R.active, true, 'the cursor IS the free hand');
  assert.equal(r.L.active, false);
  assert.ok(Math.abs(r.R.x) > 0.1);
  const steered = { x: r.R.x, y: r.R.y };
  // B47: a finger dragging the view takes no hand anywhere. The cursor stops steering for as long
  // as the drag lasts — the hand parks where it was (B45 `active` false) instead of being towed —
  // and when the drag ends the cursor picks the same target back up, with no jump.
  view.fire('pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 200, clientY: 400 });
  view.fire('pointermove', { pointerType: 'touch', pointerId: 3, clientX: 400, clientY: 400 });
  r = input.read();
  assert.equal(r.look.active, true);
  assert.ok(r.look.x > 0, 'dragging right turns the head right');
  assert.deepEqual(r.R, { x: 0, y: 0, active: false }, 'the hand parks; nothing tows it');
  view.fire('pointerup', { pointerType: 'touch', pointerId: 3, clientX: 400, clientY: 400 });
  r = input.read();
  assert.equal(r.R.active, true, 'the cursor drives the hand again');
  near(r.R.x, steered.x); near(r.R.y, steered.y);
  input.dispose();
});
