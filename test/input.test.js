import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInput } from '../src/input.js';

// Minimal stand-ins for DOM elements and window: listeners + geometry + pointer capture.
class FakeEl {
  constructor(rect) { this.rect = rect; this.listeners = new Map(); this.style = {}; this.captured = null; }
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

function rig({ keyboard = true } = {}) {
  const calls = [];
  const hud = {
    sticks: { L: ring(20, 600), R: ring(250, 600) },
    grips: { L: ring(20, 520, 60), R: ring(250, 520, 60) },
    setStick(side, x, y) { calls.push([side, x, y]); },
  };
  const win = new FakeEl({});
  let t = 0;
  const clock = { now: () => t };
  const input = createInput({ hud, keyboard, win, now: clock.now });
  // Let `ms` pass in 20 ms frames, reading every frame like the game loop; returns the last read.
  clock.advance = (ms) => { let r; for (let done = 0; done < ms; done += 20) { t += 20; r = input.read(); } return r; };
  return { hud, win, clock, input, calls };
}
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);
const pt = (el, fx, fy, pointerId = 1) => {
  const r = el.rect;
  return { pointerId, clientX: r.left + r.width / 2 + fx * (r.width / 2), clientY: r.top + r.height / 2 + fy * (r.height / 2) };
};

test('input: idle read is all zeros with no taps, and feeds the HUD knobs', () => {
  const { input, calls } = rig();
  assert.deepEqual(input.read(), { L: { x: 0, y: 0 }, R: { x: 0, y: 0 }, tapL: false, tapR: false, look: { x: 0, y: 0, active: false }, holdL: false, holdR: false });
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
  assert.deepEqual(r.R, { x: 0, y: 0 });
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
  assert.deepEqual(r.L, { x: 0, y: 0 });
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
  assert.deepEqual(r.R, { x: 0, y: 0 });
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
  assert.deepEqual(r.L, { x: 0, y: 0 });
  near(r.R.y, 1);
  win.fire('keydown', { code: 'Enter', key: 'Enter' });
  r = input.read();
  assert.equal(r.tapR, true);
  assert.deepEqual(r.R, { x: 0, y: 0 });
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
  assert.deepEqual(r.L, { x: 0, y: 0 });
  assert.deepEqual(r.R, { x: 0, y: 0 });
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

test('input: a pointer on a stick overrides the keyboard, and releasing it recenters the hand', () => {
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
  assert.deepEqual(r.L, { x: 0, y: 0 });
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
  assert.deepEqual(input.read().R, { x: 0, y: 0 });
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
  assert.deepEqual(bare.read(), { L: { x: 0, y: 0 }, R: { x: 0, y: 0 }, tapL: false, tapR: false, look: { x: 0, y: 0, active: false }, holdL: false, holdR: false });
  bare.dispose();
});
