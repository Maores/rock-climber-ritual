// src/input.js — touch, mouse and keyboard → Input for sim.step.
//
// read() returns { L:{x,y,active}, R:{x,y,active}, tapL, tapR, look, holdL, holdR, web }, where
// `web` also appears as `R.web` (the same object). Stick vectors are in the unit disc and use the
// WORLD convention: +x right, +y UP (a thumb pushed up the screen gives y > 0).
//
// `web` is the whole web-zip gesture (B50), from the WEB pad or the desktop right button:
//   x, y   — where the shot would go. Its OWN vector, never `R.x/R.y`, so the aim never fights
//            the stick that steers the right hand; before B50 one field meant both and the right
//            stick went completely dead for as long as a thumb was on the pad.
//   active — a thumb is on the pad right now. The aim is live, and because the pad is the web and
//            nothing else, the sim aims from the first frame instead of waiting out WEB_AIM_HOLD.
//   tap    — a press and lift inside 250 ms: the gesture that lets go of an attached line. Edge-
//            triggered, true for exactly one read.
// hud.setStick(side, x, y) receives the same vector every read, so the HUD must negate y
// when it converts to CSS translate.
//
// `active` is true while something is actually on that stick this frame — a finger, the mouse
// driving that hand, a movement key, or a recenter command. The sim parks a free hand where the
// last steer left it (B45), so it has to be able to tell a stick reading zero from a stick
// nobody is touching; the vector alone cannot say that.
//
// Touch / mouse (pointer events on hud.sticks.L/R and hud.grips.L/R):
//   stick = (pointer − ring center) / ring radius, clamped to the unit disc; position
//   mapping, zero the moment the pointer lifts (and `active` false with it: the hand keeps
//   the target it was steered to). One pointer per stick; the pointer is captured so dragging
//   past the ring keeps working. GRIP taps fire on pointerdown and are edge-triggered: true
//   for exactly one read().
// Keyboard: W/A/S/D drive a virtual left stick and the arrow keys the right one, each
//   axis integrating at KEY_RATE units/s and holding its value while no key is down — which
//   is the same parked hand the touch sticks now give.
//   Q toggles the left grip and Enter or Slash the right one; a grip toggle also recenters
//   that hand's virtual stick. Escape recenters both sticks. A recenter is a command, not a
//   release, so it reads `active` for that one frame and the hand returns to its rest offset.

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

export function createInput({ hud = null, keyboard = true, win, now = defaultNow, mouse = null, getHands = null } = {}) {
  const target = win !== undefined ? win : (typeof window !== 'undefined' ? window : null);
  const pointer = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };   // position-mapped sticks
  const active = { L: null, R: null };                         // pointerId holding each stick
  const virtual = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };   // keyboard sticks
  const taps = { L: false, R: false };
  const recenter = { L: false, R: false };  // Escape / a grip key: send the hand back to rest, once
  const holds = { L: false, R: false };   // grip currently held down (the spider hand aims on a hold)
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
      recenter.L = recenter.R = true;
      return;
    }
    if (GRIP_KEYS[code]) {
      if (e.preventDefault) e.preventDefault();
      if (e.repeat) return;
      const side = GRIP_KEYS[code];
      taps[side] = true;
      virtual[side].x = virtual[side].y = 0;
      recenter[side] = true;
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

  // ---------------------------------------------------------------------------------------
  // Desktop mouse: the cursor IS the free hand, and the two buttons are the two grips.
  //
  // The pointer's offset from the middle of the view maps straight onto that hand's reach
  // circle (the same position mapping the thumb sticks use), so the hand goes where you point.
  // Left button toggles the left grip, right button the right one. Whichever hand is hanging
  // free follows the cursor; with both hands on the rock the cursor does nothing until you
  // let one go, which is exactly the rhythm of the climb.
  const mousePos = { x: 0, y: 0, has: false };
  let mouseSide = 'R';                       // which hand the cursor drives when both are free
  let rightDownT = 0;                        // when the right button went down, to tell a click from a hold
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
      const { cx, cy, r } = measure();
      mouseVec.x = (e.clientX - cx) / r;
      mouseVec.y = -(e.clientY - cy) / r;     // screen y grows downward; the sim wants up
      clampDisc(mouseVec);
    });
    on(el, 'pointerdown', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      if (e.button !== 0 && e.button !== 2) return;
      prevent(e);
      const side = e.button === 0 ? 'L' : 'R';
      mouseSide = side;
      taps[side] = true;
      holds[side] = true;
      if (e.button === 2) rightDownT = now();
    });
    const up = (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      if (e.button === 0) holds.L = false;
      else if (e.button === 2) {
        holds.R = false;
        // A right-button CLICK is the desktop half of the pad's tap: it is what lets go of an
        // attached line. A press held long enough to aim is a shot, not a click.
        if (now() - rightDownT <= WEB_TAP_MS) webTapped = true;
      } else holds.L = holds.R = false;
    };
    on(el, 'pointerup', up);
    on(el, 'pointercancel', () => { holds.L = holds.R = false; });
    on(target || el, 'blur', () => { holds.L = holds.R = false; });
    on(el, 'contextmenu', prevent);           // the right button is a grip, not a menu
  }
  if (mouse) bindMouse(mouse);

  // ---------------------------------------------------------------------------------------
  // Looking around: hold Shift on a desktop, or the LOOK button on a phone. While held, the
  // cursor (or the free hand's stick) turns the head instead of moving the hand. The camera
  // decides what is reachable — it only allows it with one hand free.
  const look = { x: 0, y: 0, active: false };
  let lookHeld = false;
  if (target && keyboard) {
    on(target, 'keydown', (e) => { if (e.key === 'Shift') lookHeld = true; });
    on(target, 'keyup', (e) => { if (e.key === 'Shift') lookHeld = false; });
    on(target, 'blur', () => { lookHeld = false; });
  }
  // On a phone the LOOK button is a drag-pad, not a modifier: press it and drag, with one
  // thumb, and your head follows the drag. (It used to need a SECOND thumb on a stick to supply
  // a direction, so pressing it on its own did nothing at all.)
  const lookPad = { x: 0, y: 0 };
  let padActive = false, padId = null, padCx = 0, padCy = 0;
  const PAD_RADIUS = 84;                   // px of drag for a full turn
  if (hud && hud.lookButton) {
    const b = hud.lookButton;
    on(b, 'pointerdown', (e) => {
      prevent(e);
      const r = b.getBoundingClientRect();
      padCx = r.left + r.width / 2; padCy = r.top + r.height / 2;
      padActive = true; padId = e.pointerId; lookHeld = true;
      lookPad.x = lookPad.y = 0;
      b.classList.add('on');
      if (b.setPointerCapture) { try { b.setPointerCapture(e.pointerId); } catch (err) {} }
    });
    on(b, 'pointermove', (e) => {
      if (!padActive || e.pointerId !== padId) return;
      lookPad.x = (e.clientX - padCx) / PAD_RADIUS;
      lookPad.y = -(e.clientY - padCy) / PAD_RADIUS;    // screen y grows downward
      clampDisc(lookPad);
    });
    const endPad = () => {
      padActive = false; padId = null; lookHeld = false;
      lookPad.x = lookPad.y = 0;
      b.classList.remove('on');
    };
    on(b, 'pointerup', endPad);
    on(b, 'pointercancel', endPad);
    on(b, 'lostpointercapture', endPad);
  }

  // The web pad: the same one-thumb drag as LOOK. Holding it IS the held right grip the sim
  // waits on, and the drag is the aim, so releasing fires. Without this the only way to aim on
  // a phone would be to hold the GRIP pill and aim with the same thumb, which is the mistake
  // the LOOK button already made once.
  //
  // The pad reports two things the shared grip button cannot, both on `web` (B50):
  //   `active` — this held right grip is the dedicated aim gesture, not the grip button that
  //     doubles as a grab. The sim skips WEB_AIM_HOLD for it, so the reticle appears the frame
  //     the thumb lands and no press is ever too short to do anything.
  //   `tap` — a press and lift inside WEB_TAP_MS. That is the gesture that lets go of an
  //     attached line and throws you. It has to be its own edge: the thumb that fired the shot
  //     is already off the pad, so "the pad is no longer held" cannot mean "cut".
  const webVec = { x: 0, y: 1 };
  // One object, handed out under two names each read (see the note in read()). Reused, like `look`.
  const web = { x: 0, y: 1, active: false, tap: false };
  let webActive = false, webId = null, webCx = 0, webCy = 0, webDownT = 0, webTapped = false;
  const WEB_TAP_MS = 250;                  // press and lift inside this and it was a tap, not a hold
  if (hud && hud.webButton) {
    const b = hud.webButton;
    on(b, 'pointerdown', (e) => {
      prevent(e);
      const r = b.getBoundingClientRect();
      webCx = r.left + r.width / 2; webCy = r.top + r.height / 2;
      webActive = true; webId = e.pointerId; webDownT = now();
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
    // A lift is a tap only if it was quick; a cancel or a stolen capture is never a tap.
    const endWeb = (tapped) => { if (tapped && webActive && now() - webDownT <= WEB_TAP_MS) webTapped = true; webActive = false; webId = null; b.classList.remove('on'); };
    on(b, 'pointerup', () => endWeb(true));
    on(b, 'pointercancel', () => endWeb(false));
    on(b, 'lostpointercapture', () => endWeb(false));
  }

  function read() {
    const t = now();
    const dt = Math.min(0.1, Math.max(0, (t - lastT) / 1000));
    lastT = t;
    integrateKeys(dt);
    const out = { L: { x: 0, y: 0, active: false }, R: { x: 0, y: 0, active: false }, tapL: taps.L, tapR: taps.R };
    taps.L = taps.R = false;
    const webTap = webTapped;                 // edge: true for exactly one read, like the grip taps
    webTapped = false;
    const keyed = { L: false, R: false };
    for (const code of held) keyed[MOVE_KEYS[code][0]] = true;
    const mSide = mouse && mousePos.has ? freeSide() : null;
    // While looking, the steering input turns the head and the hand stays put.
    look.active = lookHeld;
    if (lookHeld) {
      const src = padActive ? lookPad
        : (mSide ? mouseVec : (active.L !== null ? pointer.L : active.R !== null ? pointer.R : virtual.L));
      look.x = src.x; look.y = src.y;
    } else { look.x = 0; look.y = 0; }
    out.look = look;
    // while the web pad is held, it IS the right grip; its drag is the aim, applied after the loop
    out.holdL = holds.L;
    out.holdR = holds.R || webActive;
    for (const side of ['L', 'R']) {
      // Looking: nothing counts as on the stick, so the hand keeps the target it already has.
      if (lookHeld) { out[side].x = 0; out[side].y = 0; if (hud && typeof hud.setStick === 'function') hud.setStick(side, 0, 0); continue; }
      // touch stick wins, then the cursor for the hand it is driving, then the keyboard
      const v = active[side] !== null ? pointer[side]
        : (side === mSide ? mouseVec : virtual[side]);
      out[side].x = v.x;
      out[side].y = v.y;
      out[side].active = active[side] !== null || side === mSide || keyed[side] || recenter[side];
      if (hud && typeof hud.setStick === 'function') hud.setStick(side, v.x, v.y);
    }
    // The WEB pad's drag is the AIM, and only the aim (B50). It used to be written over `out.R`
    // after this loop, on the theory that pointing the shot should also point the arm — but the
    // sim reads `R` for the right hand's steering, so one field had to mean two things and both
    // came out wrong: the right stick went completely dead for as long as a thumb was on the pad
    // (you could not steer that hand toward rock while aiming, or while swinging), the hand could
    // never park because the pad marked it `active` every frame, and the promised "the arm stays
    // pointing at its anchor" was false anyway — `_stick` is a shoulder-relative offset that
    // rotates with the body, so the arm drifted 38–60° off the line through a swing, and a fresh
    // press reset the pad to (0,1) and pinned the arm straight up.
    //
    // So the aim travels in its own field. `R` stays the right stick, the arm keeps steering and
    // parking under B45, and the sim prefers `web` over `R` only while a thumb is actually on the
    // pad. The HUD knob is still fed the stick, not the aim: it shows the physical control.
    //
    // It is handed out twice, as `out.web` and as `out.R.web` — the SAME object, so the two can
    // never disagree. The second is not belt and braces, it is the one that arrives: main.js
    // builds the sim's input by naming the fields it forwards (L, R, tapL, tapR, holdL, holdR),
    // so a new top-level field is dropped on the floor before the sim ever sees it. That is
    // precisely how B48 happened, and riding on `R` — the right hand's own control group, which
    // is forwarded by reference — is what stops it happening again.
    web.x = webVec.x; web.y = webVec.y;
    web.active = webActive;                   // a thumb is on the pad: this is the aim, and it needs no hold
    web.tap = webTap;
    out.web = web;
    out.R.web = web;
    recenter.L = recenter.R = false;
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
