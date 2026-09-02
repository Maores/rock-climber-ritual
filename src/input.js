// src/input.js — touch, mouse and keyboard → Input for sim.step.
//
// read() returns { L:{x,y,active}, R:{x,y,active}, look, holdR }. Stick vectors are in the unit
// disc and use the WORLD convention: +x right, +y UP (a thumb pushed up the screen gives y > 0).
// hud.setStick(side, x, y) receives the same vector every read, so the HUD must negate y
// when it converts to CSS translate.
//
// There are no grip buttons and no taps (B51): the two sticks are the whole climb. A stick push
// past CFG.RELEASE_DEADZONE is how a hand lets go, and a hand that hovers over rock grabs it, so
// everything this module has to deliver is where each thumb is pointing.
//
// `active` is true while something is actually on that stick this frame — a finger, the mouse
// driving that hand, or a movement key. The sim parks a free hand where the last steer left it
// (B45), so it has to be able to tell a stick reading zero from a stick nobody is touching; the
// vector alone cannot say that.
//
// Touch / mouse (pointer events on hud.sticks.L/R):
//   stick = (pointer − ring center) / ring radius, clamped to the unit disc; position
//   mapping, zero the moment the pointer lifts (and `active` false with it: the hand keeps
//   the target it was steered to). One pointer per stick; the pointer is captured so dragging
//   past the ring keeps working.
// Looking: a drag on the play surface itself (`surface`, the canvas) accumulates into
//   `look`, which holds DEGREES of yaw and pitch, clamped to what the hands allow. See below.
// Keyboard: W/A/S/D drive a virtual left stick and the arrow keys the right one, each
//   axis integrating at KEY_RATE units/s and holding its value while no key is down — which
//   is the same parked hand the touch sticks give. Escape zeroes both virtual sticks: a touch
//   stick recentres itself when the thumb lifts, and this is how the keyboard does the same,
//   which is also how you re-arm the release after a grab.
//   Shift turns the head instead of steering a hand.

const KEY_RATE = 2.5;          // virtual stick units per second per axis
const MOVE_KEYS = {
  KeyW: ['L', 0, 1], KeyS: ['L', 0, -1], KeyA: ['L', -1, 0], KeyD: ['L', 1, 0],
  ArrowUp: ['R', 0, 1], ArrowDown: ['R', 0, -1], ArrowLeft: ['R', -1, 0], ArrowRight: ['R', 1, 0],
};
// Fallback from `key` to `code` for synthetic events and browsers without `code`.
const KEY_TO_CODE = {
  w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Escape: 'Escape',
};

const defaultNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function clampDisc(v) {
  const m = Math.hypot(v.x, v.y);
  if (m > 1) { v.x /= m; v.y /= m; }
  return v;
}

function keyCode(e) {
  if (e.code && (MOVE_KEYS[e.code] || e.code === 'Escape')) return e.code;
  const k = typeof e.key === 'string' ? (e.key.length === 1 ? e.key.toLowerCase() : e.key) : '';
  return KEY_TO_CODE[k] || e.code || '';
}

export function createInput({ hud = null, keyboard = true, win, now = defaultNow, mouse = null, getHands = null, surface } = {}) {
  const target = win !== undefined ? win : (typeof window !== 'undefined' ? window : null);
  // The play surface is the canvas: everything the HUD does not claim. The integrator already
  // hands it over as `mouse`, so looking needs no new plumbing; `surface` only exists so a test
  // can bind the look drag without also binding the desktop cursor.
  const lookSurface = surface !== undefined ? surface : mouse;
  const pointer = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };   // position-mapped sticks
  const active = { L: null, R: null };                         // pointerId holding each stick
  const virtual = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };   // keyboard sticks
  const holds = { R: false };   // the right mouse button: the spider hand aims while it is down
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

  function onKeyDown(e) {
    const code = keyCode(e);
    if (code === 'Escape') {
      // Both keyboard sticks back to centre. It does NOT pull the hands home: a parked hand is
      // only moved by a steer or by taking rock (B45), and nothing here quietly overrides that.
      virtual.L.x = virtual.L.y = virtual.R.x = virtual.R.y = 0;
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

  // ---------------------------------------------------------------------------------------
  // Desktop mouse: the cursor IS the free hand.
  //
  // The pointer's offset from the middle of the view maps straight onto that hand's reach
  // circle (the same position mapping the thumb sticks use), so the hand goes where you point,
  // and holding it over a hold takes it. Whichever hand is hanging free follows the cursor; with
  // both hands on the rock the cursor does nothing until W/A/S/D or the arrows let one go, which
  // is exactly the rhythm of the climb. The buttons no longer grip (B51: nothing does) — the
  // right one is only the web-zip's hold-to-aim, which is what it already was on a phone.
  const mousePos = { x: 0, y: 0, has: false };
  let mouseSide = 'R';                       // which hand the cursor drives when both are free
  const mouseVec = { x: 0, y: 0 };

  function freeSide() {
    const h = typeof getHands === 'function' ? getHands() : null;
    if (!h || !h.L || !h.R) return mouseSide;
    const lFree = !h.L.gripping, rFree = !h.R.gripping;
    if (lFree && !rFree) return 'L';
    if (rFree && !lFree) return 'R';
    if (lFree && rFree) return mouseSide;
    return null;                             // both hands on the rock: the cursor rests
  }

  function bindMouse(el) {
    const measure = () => {
      const b = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
      return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, r: Math.max(1, Math.min(b.width, b.height) * 0.36) };
    };
    on(el, 'pointermove', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      mousePos.x = e.clientX; mousePos.y = e.clientY; mousePos.has = true;
      // A cursor that is dragging the view is not steering a hand, so its hand vector freezes:
      // without this the hand followed the look drag and then jumped when the drag ended.
      // (`lookLive` is declared below; nothing calls this handler before the module finishes.)
      if (lookLive()) return;
      const { cx, cy, r } = measure();
      mouseVec.x = (e.clientX - cx) / r;
      mouseVec.y = -(e.clientY - cy) / r;     // screen y grows downward; the sim wants up
      clampDisc(mouseVec);
    });
    on(el, 'pointerdown', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      if (e.button !== 2) return;             // right button only: hold to aim the web
      if (e.shiftKey) return;                 // Shift is the look modifier, not an aim
      prevent(e);
      mouseSide = 'R';                        // with both hands free the cursor is the aim
      holds.R = true;
    });
    const up = (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      if (e.button === 2 || e.button === undefined) holds.R = false;
    };
    on(el, 'pointerup', up);
    on(el, 'pointercancel', () => { holds.R = false; });
    on(target || el, 'blur', () => { holds.R = false; });
    on(el, 'contextmenu', prevent);           // the right button aims the web, it is not a menu
  }
  if (mouse) bindMouse(mouse);

  // ---------------------------------------------------------------------------------------
  // Looking around: drag the view on the screen itself (B47).
  //
  // There is no LOOK button any more, and no free-arm rule: you can turn your head with both
  // hands on the rock. The play surface IS the control. A pointer that comes down on a stick, a
  // grip or the WEB pad belongs to that control and never reaches here — the HUD is
  // pointer-events:none with pointer-events:auto children, so "the event reached the canvas" is
  // exactly "the finger was not on a control". It is a hit region, not a z-index. A look drag and
  // a thumb on a stick are different pointer ids and run side by side.
  //
  // The view STAYS where you leave it: a drag ACCUMULATES into `look` and lifting the finger
  // changes nothing. It only comes home when a hand takes the rock or the last hand leaves it —
  // a new hold is a new place to be — and then it eases rather than snapping. `look.active` means
  // a look gesture is in progress; it no longer says whether looking is allowed at all.
  //
  // The accumulator holds DEGREES of yaw and pitch, not a fraction of the arc, because the arc
  // changes under you: letting a hand go widens it from the neck to the whole body. A normalised
  // accumulator kept its fraction and so PANNED THE VIEW BY ITSELF on a release — 87 degrees in
  // half a second, measured. Degrees are absolute, so the rendered angle is continuous across an
  // arc change and only the limit moves; when the arc narrows the angle eases back inside it.
  const LOOK_SWEEP = 1.0;        // fraction of the arc swept by a drag across the whole viewport
  const LOOK_HOME_RATE = 7.5;    // e-folds/s back to centre on a grab or a fall: ~95% home in 0.4 s
  const LOOK_FIT_RATE = 6;       // ...and back inside an arc that has just narrowed under you
  const KEY_LOOK_RATE = 0.42;    // arcs per second at full stick, for Shift + a stick on a desktop

  // How far you can really see, in degrees, by what your hands are doing. The table lives here
  // rather than in camera.js because the accumulator is absolute: it has to clamp itself to the
  // arc that is live right now. camera.js takes the degrees and renders them, so there is one
  // copy of these numbers and no way for the two to drift apart.
  const NECK = { out: 60, in: 60, up: 40, down: 55 };    // both hands on the rock: the neck alone
  const ARM = { out: 145, in: 35, up: 62, down: 85 };    // one hand free: the body turns with it (B22)
  const LOOSE = { out: 90, in: 90, up: 62, down: 85 };   // nothing held: the same 180 across, symmetric

  const look = { x: 0, y: 0, active: false, homing: false, down: ARM.down };
  let lookId = null;             // the pointer doing the dragging
  let lookPX = 0, lookPY = 0;    // ...and where it was last seen
  const pending = new Map();     // other fingers down on the surface, newest last
  let homing = false;            // easing back to the climb after a grab or a fall
  let shiftHeld = false;
  let prevHeld = null;           // how many hands were on the rock at the last read
  if (target && keyboard) {
    on(target, 'keydown', (e) => { if (e.key === 'Shift') shiftHeld = true; });
    on(target, 'keyup', (e) => { if (e.key === 'Shift') shiftHeld = false; });
    on(target, 'blur', () => { shiftHeld = false; });
  }
  const lookLive = () => lookId !== null || shiftHeld;

  /** The arc the head can reach right now: right/left/up/down half-widths in degrees. */
  function arc() {
    const h = typeof getHands === 'function' ? getHands() : null;
    const L = h && h.L, R = h && h.R;
    if (!L || !R) return { pos: LOOSE.out, neg: LOOSE.in, up: LOOSE.up, down: LOOSE.down };
    const lFree = !L.gripping, rFree = !R.gripping;
    if (!lFree && !rFree) return { pos: NECK.out, neg: NECK.in, up: NECK.up, down: NECK.down };
    if (lFree && rFree) return { pos: LOOSE.out, neg: LOOSE.in, up: LOOSE.up, down: LOOSE.down };
    // one hand free: the wide side is the side of the free arm — hanging off your right you crane left
    const out = rFree ? ARM.out : ARM.in;
    const inn = rFree ? ARM.in : ARM.out;
    return { pos: out, neg: inn, up: ARM.up, down: ARM.down };
  }

  // The title overlay owns its own pointers, but for the 0.9 s it spends fading out it is
  // pointer-events:none and a drag lands on the canvas behind it — which used to start the climb
  // with the view already 30 degrees off the wall.
  const titleEl = hud && hud.elements ? hud.elements.title : null;
  const overlayUp = () => !!(titleEl && titleEl.hidden === false);

  function bindLook(el) {
    const span = () => {
      const b = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return {
        w: Math.max(1, (b && b.width) || (target && target.innerWidth) || 1),
        h: Math.max(1, (b && b.height) || (target && target.innerHeight) || 1),
      };
    };
    on(el, 'pointerdown', (e) => {
      // On a desktop the two mouse buttons are the two grips, so the cursor only looks with Shift
      // held — the same modifier as the keyboard path — or on the middle button.
      if (e.pointerType === 'mouse' && !(e.shiftKey || e.button === 1)) return;
      if (e.button === 1) prevent(e);                 // no autoscroll widget under the drag
      if (overlayUp()) return;                        // the title is still on screen
      if (lookId !== null) {                          // a second finger waits its turn
        pending.set(e.pointerId, { x: e.clientX, y: e.clientY });
        return;
      }
      lookId = e.pointerId;
      lookPX = e.clientX; lookPY = e.clientY;
      look.active = true;
      homing = false;                                 // a finger on the screen outranks the ease home
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ } }
    });
    on(el, 'pointermove', (e) => {
      if (pending.has(e.pointerId)) { pending.set(e.pointerId, { x: e.clientX, y: e.clientY }); return; }
      if (lookId === null || e.pointerId !== lookId) return;
      const { w, h } = span();
      const a = arc();
      // A drag across the whole viewport sweeps the whole arc, so the gesture is the size of the
      // screen it happens on and stays the same gesture as the arc changes.
      look.x += (e.clientX - lookPX) * ((a.pos + a.neg) * LOOK_SWEEP / w);
      look.y -= (e.clientY - lookPY) * ((a.up + a.down) * LOOK_SWEEP / h);   // screen down → look down
      look.x = Math.max(-a.neg, Math.min(a.pos, look.x));
      look.y = Math.max(-a.down, Math.min(a.up, look.y));
      lookPX = e.clientX; lookPY = e.clientY;
    });
    const endLook = (e) => {
      const id = e && e.pointerId !== undefined ? e.pointerId : lookId;
      if (pending.delete(id) && id !== lookId) return;
      if (lookId === null || id !== lookId) return;
      lookId = null;
      look.active = false;                            // and the view stays exactly where it was left
      // Hand the drag to the newest finger still on the glass, from where that finger is now, so a
      // second finger put down mid-drag is not dead until you lift it and touch again.
      let next = null;
      for (const [pid, at] of pending) next = [pid, at];
      if (next) {
        pending.delete(next[0]);
        lookId = next[0];
        lookPX = next[1].x; lookPY = next[1].y;
        look.active = true;
        homing = false;
      }
    };
    on(el, 'pointerup', endLook);
    on(el, 'pointercancel', endLook);
    on(el, 'lostpointercapture', endLook);
    on(el, 'contextmenu', prevent);                   // a long-press look must not open a callout
    if (el.style) el.style.touchAction = 'none';
  }
  if (lookSurface) bindLook(lookSurface);

  // A hand taking the rock is a new place to be, and so is the moment the last hand leaves it (a
  // fall, or a swing), so the view eases home on both. input.js can see both without any new
  // plumbing: it already reads the hands for the desktop cursor, and it owns the accumulator, so
  // the ease is a change to the accumulator itself rather than a correction bolted on downstream.
  // A hand LETTING GO is not one of them: that only widens the arc, and the view must not move on
  // its own when the player did nothing.
  function watchHands() {
    const h = typeof getHands === 'function' ? getHands() : null;
    if (!h || !h.L || !h.R) { prevHeld = null; return; }
    const n = (h.L.gripping ? 1 : 0) + (h.R.gripping ? 1 : 0);
    if (prevHeld !== null && n !== prevHeld && (n > prevHeld || n === 0)) homing = true;
    prevHeld = n;
  }

  /** Keep the angle inside the arc that is live now, easing in when the arc has just narrowed. */
  function fitLook(dt) {
    const a = arc();
    look.down = a.down;                               // the rig scales its vertigo by this
    const fit = (v, lo, hi) => {
      const t = v > hi ? hi : v < lo ? lo : v;
      if (t === v) return v;
      const eased = t + (v - t) * Math.exp(-LOOK_FIT_RATE * dt);
      return Math.abs(eased - t) < 0.05 ? t : eased;
    };
    look.x = fit(look.x, -a.neg, a.pos);
    look.y = fit(look.y, -a.down, a.up);
    return a;
  }

  // The web pad: a one-thumb press-and-drag. Holding it IS the held right grip the sim
  // waits on, and the drag is the aim, so releasing fires.
  //
  // The pad's vector is a full deflection of the right stick, so pressing it also lets the right
  // hand go (B51) — which is what has to happen anyway, since the web only charges with that hand
  // free. Mind that it costs you the right hand even if you never fire.
  const PAD_RADIUS = 84;                   // px of drag for a full deflection of the aim
  const webVec = { x: 0, y: 1 };
  let webActive = false, webId = null, webCx = 0, webCy = 0;
  if (hud && hud.webButton) {
    const b = hud.webButton;
    on(b, 'pointerdown', (e) => {
      prevent(e);
      const r = b.getBoundingClientRect();
      webCx = r.left + r.width / 2; webCy = r.top + r.height / 2;
      webActive = true; webId = e.pointerId;
      webVec.x = 0; webVec.y = 1;
      b.classList.add('on');
      if (b.setPointerCapture) { try { b.setPointerCapture(e.pointerId); } catch (err) {} }
    });
    on(b, 'pointermove', (e) => {
      if (!webActive || e.pointerId !== webId) return;
      const dx = (e.clientX - webCx) / PAD_RADIUS;
      const dy = -(e.clientY - webCy) / PAD_RADIUS;
      if (Math.hypot(dx, dy) > 0.12) { webVec.x = dx; webVec.y = dy; clampDisc(webVec); }
    });
    const endWeb = () => { webActive = false; webId = null; b.classList.remove('on'); };
    on(b, 'pointerup', endWeb);
    on(b, 'pointercancel', endWeb);
    on(b, 'lostpointercapture', endWeb);
  }

  function read() {
    const t = now();
    const dt = Math.min(0.1, Math.max(0, (t - lastT) / 1000));
    lastT = t;
    integrateKeys(dt);
    const out = { L: { x: 0, y: 0, active: false }, R: { x: 0, y: 0, active: false } };
    const keyed = { L: false, R: false };
    for (const code of held) keyed[MOVE_KEYS[code][0]] = true;
    const mSide = mouse && mousePos.has ? freeSide() : null;
    // --- looking -------------------------------------------------------------------------
    watchHands();
    const a = fitLook(dt);
    // Shift + a stick (or the cursor) still turns the head on a desktop. It feeds the same
    // accumulator, as a rate rather than a position, so the view stays where the keys leave it
    // exactly as a drag does. The rate is in arcs per second, so it crosses the arc in the same
    // time whether the arc is the neck's or the whole body's.
    let steering = false;
    if (shiftHeld && lookId === null) {
      const src = mSide ? mouseVec : (active.L !== null ? pointer.L : active.R !== null ? pointer.R : virtual.L);
      if (src.x || src.y) {
        look.x = Math.max(-a.neg, Math.min(a.pos, look.x + src.x * (a.pos + a.neg) * KEY_LOOK_RATE * dt));
        look.y = Math.max(-a.down, Math.min(a.up, look.y + src.y * (a.up + a.down) * KEY_LOOK_RATE * dt));
        steering = true;
        homing = false;
      }
    }
    if (homing && lookId === null && !steering) {
      const k = Math.exp(-LOOK_HOME_RATE * dt);
      look.x *= k; look.y *= k;
      if (Math.abs(look.x) < 0.05 && Math.abs(look.y) < 0.05) { look.x = look.y = 0; homing = false; }
    }
    look.active = lookId !== null || shiftHeld;
    look.homing = homing;      // the rig follows an easing value straight through, or it eases twice
    out.look = look;
    // while the web pad is held, it IS the held right grip the sim aims on; its drag is the aim,
    // applied after the loop
    out.holdR = holds.R || webActive;
    // While the view is being dragged the CURSOR is turning the head, not steering a hand, so it
    // stops driving one; the hand parks where it was (B45 `active` false) instead of following the
    // drag and jumping again when it ends. Thumb sticks are untouched by this: a finger on a stick
    // and a finger on bare wall are two different fingers and both work at once (B47).
    const steer = lookLive() ? null : mSide;
    for (const side of ['L', 'R']) {
      // Shift is a modifier, not a finger: while it is held nothing counts as on the stick, so the
      // hand keeps the target it already has.
      if (shiftHeld) { out[side].x = 0; out[side].y = 0; if (hud && typeof hud.setStick === 'function') hud.setStick(side, 0, 0); continue; }
      // touch stick wins, then the cursor for the hand it is driving, then the keyboard
      const v = active[side] !== null ? pointer[side]
        : (side === steer ? mouseVec : virtual[side]);
      out[side].x = v.x;
      out[side].y = v.y;
      out[side].active = active[side] !== null || side === steer || keyed[side];
      if (hud && typeof hud.setStick === 'function') hud.setStick(side, v.x, v.y);
    }
    // The WEB pad's drag IS the aim, and it has to be written AFTER the loop: the loop rewrites
    // out.R from the stick every frame, which used to swallow this and left every shot going
    // wherever the right stick last pointed — straight up, on a phone, where that stick is not
    // being touched at all. It beats the stick (and the Shift look) for the frames the pad is
    // held, because a thumb on the pad is aiming. The HUD knob is deliberately not fed the aim:
    // it shows the physical stick, which nobody is touching.
    //
    // Aiming also points the free right hand, because the sim reads inp.R for the aim AND for
    // that hand's steering. That is already how the desktop cursor works (it is the hand and the
    // aim at once), and it is marked `active`, so under B45 the arm parks along the line it just
    // shot instead of dropping back to rest: the spider hand stays pointing at its anchor.
    if (webActive) { out.R.x = webVec.x; out.R.y = webVec.y; out.R.active = true; }
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
