// src/input.js — touch, mouse and keyboard → Input for sim.step.
//
// read() returns { L:{x,y}, R:{x,y}, tapL, tapR }. Stick vectors are in the unit disc and
// use the WORLD convention: +x right, +y UP (a thumb pushed up the screen gives y > 0).
// hud.setStick(side, x, y) receives the same vector every read, so the HUD must negate y
// when it converts to CSS translate.
//
// Touch / mouse (pointer events on hud.sticks.L/R and hud.grips.L/R):
//   stick = (pointer − ring center) / ring radius, clamped to the unit disc; position
//   mapping, zero the moment the pointer lifts. One pointer per stick; the pointer is
//   captured so dragging past the ring keeps working. GRIP taps fire on pointerdown and
//   are edge-triggered: true for exactly one read().
// Keyboard: W/A/S/D drive a virtual left stick and the arrow keys the right one, each
//   axis integrating at KEY_RATE units/s and holding its value while no key is down.
//   Q toggles the left grip and Enter or Slash the right one; a grip toggle also recenters
//   that hand's virtual stick. Escape recenters both sticks.

const KEY_RATE = 2.5;          // virtual stick units per second per axis
const MOVE_KEYS = {
  KeyW: ['L', 0, 1], KeyS: ['L', 0, -1], KeyA: ['L', -1, 0], KeyD: ['L', 1, 0],
  ArrowUp: ['R', 0, 1], ArrowDown: ['R', 0, -1], ArrowLeft: ['R', -1, 0], ArrowRight: ['R', 1, 0],
};
const GRIP_KEYS = { KeyQ: 'L', Enter: 'R', NumpadEnter: 'R', Slash: 'R' };
// Fallback from `key` to `code` for synthetic events and browsers without `code`.
const KEY_TO_CODE = {
  w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', q: 'KeyQ', '/': 'Slash',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Enter: 'Enter', Escape: 'Escape',
};

const defaultNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function clampDisc(v) {
  const m = Math.hypot(v.x, v.y);
  if (m > 1) { v.x /= m; v.y /= m; }
  return v;
}

function keyCode(e) {
  if (e.code && (MOVE_KEYS[e.code] || GRIP_KEYS[e.code] || e.code === 'Escape')) return e.code;
  const k = typeof e.key === 'string' ? (e.key.length === 1 ? e.key.toLowerCase() : e.key) : '';
  return KEY_TO_CODE[k] || e.code || '';
}

export function createInput({ hud = null, keyboard = true, win, now = defaultNow } = {}) {
  const target = win !== undefined ? win : (typeof window !== 'undefined' ? window : null);
  const pointer = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };   // position-mapped sticks
  const active = { L: null, R: null };                         // pointerId holding each stick
  const virtual = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };   // keyboard sticks
  const taps = { L: false, R: false };
  const held = new Set();
  const cleanups = [];
  let lastT = now();

  const on = (el, type, fn) => {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  };
  const prevent = (e) => { if (e.preventDefault) e.preventDefault(); };

  function bindStick(side, el) {
    let cx = 0, cy = 0, r = 1;
    const measure = () => {
      const b = el.getBoundingClientRect();
      cx = b.left + b.width / 2;
      cy = b.top + b.height / 2;
      r = Math.max(1, Math.min(b.width, b.height) / 2);
    };
    const set = (e) => {
      const v = pointer[side];
      v.x = (e.clientX - cx) / r;
      v.y = -(e.clientY - cy) / r;      // screen down → world up
      clampDisc(v);
    };
    const end = (e) => {
      if (active[side] !== e.pointerId) return;
      active[side] = null;
      pointer[side].x = pointer[side].y = 0;
      virtual[side].x = virtual[side].y = 0;   // no stale keyboard value takes over
      try { el.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    };
    on(el, 'pointerdown', (e) => {
      if (active[side] !== null) return;        // one finger per stick
      active[side] = e.pointerId;
      if (e.preventDefault) e.preventDefault();
      measure();
      try { el.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
      set(e);
    });
    on(el, 'pointermove', (e) => { if (e.pointerId === active[side]) set(e); });
    on(el, 'pointerup', end);
    on(el, 'pointercancel', end);
    on(el, 'lostpointercapture', end);       // safety net: the browser took the pointer away
    on(el, 'contextmenu', prevent);          // a long press must not open a menu / callout
    if (el.style) el.style.touchAction = 'none';
  }

  function bindGrip(side, el) {
    on(el, 'pointerdown', (e) => {
      if (e.preventDefault) e.preventDefault();
      taps[side] = true;
    });
    on(el, 'contextmenu', prevent);
    if (el.style) el.style.touchAction = 'none';
  }

  function onKeyDown(e) {
    const code = keyCode(e);
    if (code === 'Escape') {
      virtual.L.x = virtual.L.y = virtual.R.x = virtual.R.y = 0;
      return;
    }
    if (GRIP_KEYS[code]) {
      if (e.preventDefault) e.preventDefault();
      if (e.repeat) return;
      const side = GRIP_KEYS[code];
      taps[side] = true;
      virtual[side].x = virtual[side].y = 0;
      return;
    }
    if (MOVE_KEYS[code]) {
      if (e.preventDefault) e.preventDefault();
      held.add(code);
    }
  }
  function onKeyUp(e) { held.delete(keyCode(e)); }
  function onBlur() { held.clear(); }

  if (hud) {
    for (const side of ['L', 'R']) {
      if (hud.sticks && hud.sticks[side]) bindStick(side, hud.sticks[side]);
      if (hud.grips && hud.grips[side]) bindGrip(side, hud.grips[side]);
    }
  }
  if (keyboard && target) {
    on(target, 'keydown', onKeyDown);
    on(target, 'keyup', onKeyUp);
    on(target, 'blur', onBlur);
  }

  function integrateKeys(dt) {
    if (!held.size) return;
    const d = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };
    for (const code of held) { const [side, dx, dy] = MOVE_KEYS[code]; d[side].x += dx; d[side].y += dy; }
    for (const side of ['L', 'R']) {
      if (!d[side].x && !d[side].y) continue;
      const v = virtual[side];
      v.x = Math.max(-1, Math.min(1, v.x + Math.sign(d[side].x) * KEY_RATE * dt));
      v.y = Math.max(-1, Math.min(1, v.y + Math.sign(d[side].y) * KEY_RATE * dt));
      clampDisc(v);
    }
  }

  function read() {
    const t = now();
    const dt = Math.min(0.1, Math.max(0, (t - lastT) / 1000));
    lastT = t;
    integrateKeys(dt);
    const out = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 }, tapL: taps.L, tapR: taps.R };
    taps.L = taps.R = false;
    for (const side of ['L', 'R']) {
      const v = active[side] !== null ? pointer[side] : virtual[side];
      out[side].x = v.x;
      out[side].y = v.y;
      if (hud && typeof hud.setStick === 'function') hud.setStick(side, v.x, v.y);
    }
    return out;
  }

  function dispose() {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
    held.clear();
    active.L = active.R = null;
  }

  return { read, dispose };
}
