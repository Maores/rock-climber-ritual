// src/camera.js — first-person camera rig for Rock Climber: The Ritual (arms-camera domain).
//
// The eye sits at body + (0, 0.30, 0.62 above the wall) and looks at a point on the wall biased
// upward toward the hands (you look up while you reach). A framing dolly eases the eye back only as
// far as the current hand spread needs so both hands stay in frame at the narrow portrait aspect
// without shrinking them more than necessary; the lens itself keeps one vertical fov per orientation.
// On top: breathing sway, roll toward the loaded arm on one-hand hangs, a quick fov punch on grab,
// a downward pitch plus shake while falling and a spring bounce when the rope catches, and a slow
// rising crane shot on the summit that settles on the altar. Reads `state` only. Grab/fall/catch are
// detected from state transitions, or from the drained event list when the integrator passes it as
// the optional fourth argument.
//
// Public surface (CONTRACTS.md): createCameraRig(camera) → rig; rig.update(dt, state, wallZ[, events]); rig.setPortrait(isPortrait)

import * as THREE from 'three';

const EYE_UP = 0.30;       // eye above the shoulder centre
const EYE_OUT = 0.62;      // eye above the wall surface at the body
const FOV_PORTRAIT = 84;
const FOV_LANDSCAPE = 70;
// Framing dolly: the eye eases back (never forward of EYE_OUT) until the hands fit the frame width
// with FRAME_MARGIN to spare; PULL_MAX caps it so a wide reach crops the resting hand's edge rather
// than shrinking everything.
const PULL_MAX = 0.60;
const FRAME_MARGIN = 0.92;
const HAND_HALF = 0.075;   // half-width of a hand plus a finger of margin
const HAND_LIFT = 0.06;    // a hand sits about this far off the wall surface (hold front or hover)
const GAZE_GRIP_WEIGHT = 0.4;   // a hand resting on a hold pulls the gaze less than the hand you steer
// Summit crane: rise a little and pull back over a few seconds, settle level on the altar.
const SUMMIT_RISE = 1.0;
const SUMMIT_BACK = 0.95;
const SUMMIT_TAU = 3.2;
// On the rope the eye leans to the climber's right so the rope runs up past the face instead of
// through the lens (the harness point sits just in front of the eye when the rope is taut).
const ROPE_LEAN = 0.14;
const ROPE_PULL = 0.16;

const _v = new THREE.Vector3();
const _look = new THREE.Vector3();

/** Semi-implicit damped spring step; mutates s = { x, v }. */
function spring(s, target, omega, zeta, dt) {
  // sub-step so the integrator stays stable for stiff springs at 20 Hz frames
  const n = Math.max(1, Math.ceil(omega * dt / 0.5));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const a = -2 * zeta * omega * s.v - omega * omega * (s.x - target);
    s.v += a * h;
    s.x += s.v * h;
  }
}

function approach(cur, target, rate, dt) {
  return target + (cur - target) * Math.exp(-rate * dt);
}

/** Pseudo-random 1-D noise in [-1, 1], continuous in t. */
function noise(t, seed) {
  return 0.55 * Math.sin(t * 13.1 + seed) + 0.3 * Math.sin(t * 21.7 + seed * 1.9) + 0.15 * Math.sin(t * 34.3 + seed * 3.1);
}

// --- looking around ---------------------------------------------------------------------
// With one hand on the rock and one hand free you can turn your head. The arc you can reach
// depends on which hand is free: hanging off your right arm you can crane left, and the other
// way round. Straight down is allowed on purpose — the drop is the point.
const LOOK = {
  yawInward: THREE.MathUtils.degToRad(35),    // toward the gripping arm
  yawOutward: THREE.MathUtils.degToRad(145),  // toward the free arm: 180 deg of arc together
  pitchUp: THREE.MathUtils.degToRad(62),
  pitchDown: THREE.MathUtils.degToRad(85),    // nearly straight down into the pit
  rate: 8,                                    // how fast the head follows the input
  recenter: 3.2,                              // how fast it returns when you let go
  vertigoFov: 9,                              // the lens creeps wider the longer you stare down
  vertigoRate: 0.5,
};

export function createCameraRig(camera) {
  let portrait = null;                      // null until setPortrait is called → inferred from aspect
  let lookYaw = 0, lookPitch = 0, vertigo = 0;
  const clamp1 = (v) => (v > 1 ? 1 : v < -1 ? -1 : (+v || 0));
  camera.near = 0.05;
  camera.far = Math.max(camera.far || 0, 900);
  camera.fov = FOV_PORTRAIT;
  camera.updateProjectionMatrix();

  const eye = new THREE.Vector3();          // smoothed eye position (before effects)
  const look = new THREE.Vector3();         // smoothed look target
  const fovKick = { x: 0, v: 0 };           // degrees, spring around 0
  const roll = { x: 0, v: 0 };              // radians, + tilts the head to the climber's right
  const bounce = { x: 0, v: 0 };            // metres on eye y, spring around 0
  const pull = { x: 0, v: 0 };              // framing dolly, metres back from EYE_OUT
  const lean = { x: 0, v: 0 };              // sideways eye offset while hanging on the rope
  let shake = 0;                            // 0..1 envelope
  let fallBlend = 0;                        // 0..1 look-down amount
  let summitT = -1;                         // seconds since summit, -1 when not on the summit
  let doom = 0;                             // 0..1 how far into a doomed plunge we are
  let tumble = 0;                           // spin accumulated while plunging
  let impact = 0;                           // jolt envelope when the ground arrives
  let titleBias = 1;                        // look higher on the title screen
  let t = 0;
  let initialised = false;
  let prevPhase = null;
  const prevGrip = { L: null, R: null };
  let lastFov = -1;

  function setPortrait(isPortrait) {
    portrait = !!isPortrait;
  }

  function isPortraitNow() {
    if (portrait !== null) return portrait;
    return !(camera.aspect > 1);
  }

  /** Base vertical fov for the current orientation. */
  function baseFov() {
    return isPortraitNow() ? FOV_PORTRAIT : FOV_LANDSCAPE;
  }

  /** External nudge (the integrator may call this for HUD-driven moments); amount in degrees/s. */
  function kick(amount) {
    fovKick.v += amount;
  }

  function detectEvents(state, events) {
    const out = { grab: false, release: false, fall: false, catch: false, summit: false, miss: false };
    if (Array.isArray(events) && events.length) {
      for (const e of events) if (e && e.type in out) out[e.type] = true;
    }
    // Always run the state-transition detector too; it is idempotent with the event list because
    // the flags are booleans for this frame.
    const phase = state.phase;
    if (prevPhase !== null && phase !== prevPhase) {
      if (phase === 'falling') out.fall = true;
      if (phase === 'caught') out.catch = true;
      if (phase === 'summit') out.summit = true;
    }
    for (const side of ['L', 'R']) {
      const g = !!(state.hands && state.hands[side] && state.hands[side].gripping);
      if (prevGrip[side] !== null && g !== prevGrip[side]) {
        if (g) out.grab = true; else if (phase === 'climbing') out.release = true;
      }
      prevGrip[side] = g;
    }
    prevPhase = phase;
    return out;
  }

  function update(dt, state, wallZ, events, lookIn) {
    if (!state || !state.body) return;
    dt = Math.min(Math.max(dt || 0, 0), 1 / 20);
    t += dt;
    const wz = typeof wallZ === 'function' ? wallZ : () => 0;
    const body = state.body;
    const hands = state.hands || {};
    const L = hands.L, R = hands.R;
    const ev = detectEvents(state, events);
    const fov0 = baseFov();
    const aspect = camera.aspect > 0 ? camera.aspect : 1;

    // --- gaze: weighted toward the hand being steered --------------------------------------
    let hx = body.x, hy = body.y + EYE_UP + 0.25, wsum = 0;
    if (L || R) {
      hx = 0; hy = 0;
      for (const h of [L, R]) {
        if (!h) continue;
        const w = h.gripping ? GAZE_GRIP_WEIGHT : 1;
        hx += h.x * w; hy += h.y * w; wsum += w;
      }
      hx /= wsum; hy /= wsum;
    }
    let lookX = THREE.MathUtils.lerp(body.x, hx, 0.7);
    let lookY = THREE.MathUtils.lerp(body.y + EYE_UP, hy + 0.12, 0.65);
    titleBias = approach(titleBias, state.phase === 'title' ? 1 : 0, 2.5, dt);
    lookY += 0.35 * titleBias;

    // --- framing dolly: how far back must the eye sit for the hands to fit the frame width? ------
    // Both hands fit whole, except during a one-handed reach, when the resting hand may lose its
    // outer edge rather than pull the eye back from the hand being steered.
    // Each hand is measured at its own depth: a hand on a bulge is nearer the lens than the body's
    // wall point and so needs the eye further back for the same frame width.
    const nFree = (L && !L.gripping ? 1 : 0) + (R && !R.gripping ? 1 : 0);
    const relaxResting = nFree === 1;
    const halfTan = Math.max(1e-3, Math.tan(THREE.MathUtils.degToRad(fov0 / 2)) * aspect * FRAME_MARGIN);
    const eyeBaseZ = wz(body.x, body.y) + EYE_OUT;
    let pullTarget = 0;
    for (const h of [L, R]) {
      if (!h) continue;
      const dx = Math.abs(h.x - lookX);
      const need = relaxResting && h.gripping ? dx - 0.02 : dx + HAND_HALF;
      const handZ = wz(h.x, h.y) + HAND_LIFT;
      pullTarget = Math.max(pullTarget, handZ + need / halfTan - eyeBaseZ);
    }
    pullTarget = THREE.MathUtils.clamp(pullTarget, 0, PULL_MAX);
    const onRope = state.phase === 'falling' || state.phase === 'caught';
    if (onRope) pullTarget = Math.max(pullTarget, ROPE_PULL);
    if (!initialised) { pull.x = pullTarget; pull.v = 0; }
    spring(pull, pullTarget, 3.2, 1.0, dt);
    spring(lean, onRope ? ROPE_LEAN : 0, 3.0, 1.0, dt);

    // --- eye target ----------------------------------------------------------------------
    const eyeTarget = _v.set(body.x + lean.x, body.y + EYE_UP, wz(body.x, body.y) + EYE_OUT + pull.x);
    if (summitT >= 0) {
      const ease = 1 - Math.exp(-summitT / SUMMIT_TAU);
      eyeTarget.y += SUMMIT_RISE * ease;
      eyeTarget.z += SUMMIT_BACK * ease;
    }
    if (!initialised) {
      eye.copy(eyeTarget);
    } else {
      // stiff follow: the sim already spring-damps the body, this adds a hint of head lag
      eye.lerp(eyeTarget, 1 - Math.exp(-16 * dt));
    }

    // --- look target ---------------------------------------------------------------------
    // Falling: pitch down toward the valley; caught: come back up over a second or so.
    const fallTarget = state.phase === 'falling' ? 1 : 0;
    fallBlend = approach(fallBlend, fallTarget, fallTarget ? 9 : 2.5, dt);
    if (fallBlend > 0.001) {
      lookY = THREE.MathUtils.lerp(lookY, body.y - 1.6, fallBlend);
      lookX = THREE.MathUtils.lerp(lookX, body.x, fallBlend);
    }

    // --- the plunge --------------------------------------------------------------------------
    // Once the rope is spent the fall runs the whole cliff, so it gets its own treatment: the
    // head pitches right over toward the ground, the world tumbles, the lens widens with speed
    // and the wall streams past close to the lens. `doom` ramps with how fast you are going.
    const doomed = state.phase === 'falling' && state._fall && state._fall.doomed;
    const speed = doomed ? Math.min(1, Math.abs(body.vy) / 22) : 0;
    doom = approach(doom, doomed ? 0.35 + 0.65 * speed : 0, doomed ? 3.2 : 6, dt);
    if (state.phase === 'fallen') doom = approach(doom, 0, 1.4, dt);
    if (doom > 0.001) {
      lookY -= 4.2 * doom;                       // straight down the face
      tumble += dt * (0.8 + 2.6 * doom);
    } else tumble = 0;

    // Summit: the gaze settles on the altar while the crane rises.
    if (state.phase === 'summit') {
      summitT = summitT < 0 ? 0 : summitT + dt;
      const altar = state.route && state.route.holds ? state.route.holds.find((h) => h.kind === 'summit') : null;
      if (altar) {
        const ease = 1 - Math.exp(-summitT / 1.6);
        lookX = THREE.MathUtils.lerp(lookX, altar.x, ease);
        lookY = THREE.MathUtils.lerp(lookY, altar.y + 0.62, ease);
      }
    } else if (summitT >= 0) {
      summitT = -1;
    }

    _look.set(lookX, lookY, wz(lookX, lookY));
    if (state.phase === 'summit') _look.z += 0.25;      // the altar stone stands proud of the shelf
    if (!initialised) look.copy(_look);
    else look.lerp(_look, 1 - Math.exp(-7 * dt));

    // --- events → impulses ---------------------------------------------------------------
    if (ev.grab) fovKick.v -= 150;          // punch in
    if (ev.release) fovKick.v += 55;        // small breath out
    if (ev.miss) fovKick.v += 25;
    if (ev.fall) { shake = 1; fovKick.v += 90; }
    if (ev.catch) { bounce.v -= 2.4; shake = Math.max(shake, 0.8); fovKick.v -= 60; }
    if (ev.summit) fovKick.v -= 40;

    spring(fovKick, 0, 17, 0.55, dt);
    spring(bounce, 0, 9, 0.32, dt);
    shake = approach(shake, 0, state.phase === 'falling' ? 0.6 : 3.2, dt);

    // --- roll toward the loaded arm ------------------------------------------------------
    const gL = !!(L && L.gripping), gR = !!(R && R.gripping);
    let rollTarget = 0;
    if (gR && !gL) rollTarget = THREE.MathUtils.degToRad(5);
    else if (gL && !gR) rollTarget = -THREE.MathUtils.degToRad(5);
    spring(roll, rollTarget, 4.2, 0.7, dt);

    // --- breathing: faster and deeper when the arms are tired -----------------------------
    const stamina = Math.min(L ? L.stamina : 1, R ? R.stamina : 1);
    const exhaustion = THREE.MathUtils.clamp(1 - (isFinite(stamina) ? stamina : 1), 0, 1);
    const breathHz = THREE.MathUtils.lerp(0.27, 0.6, exhaustion);
    const breathAmp = THREE.MathUtils.lerp(0.011, 0.02, exhaustion);
    const breath = Math.sin(t * Math.PI * 2 * breathHz);
    const sway = Math.sin(t * Math.PI * 2 * 0.19 + 1.3);

    // --- compose -------------------------------------------------------------------------
    camera.position.copy(eye);
    camera.position.y += breath * breathAmp + bounce.x;
    camera.position.x += sway * 0.006;
    const totalShake = Math.max(shake, doom * 0.8, impact);
    if (totalShake > 0.001) {
      const s = totalShake * totalShake * 0.055;
      camera.position.x += s * noise(t, 2.0);
      camera.position.y += s * noise(t, 5.0);
      camera.position.z += s * 0.5 * noise(t, 8.0);
    }
    // --- look around ------------------------------------------------------------------------
    // Only while exactly one hand holds the rock: the other arm is what lets you turn.
    const freeSide = (L && !L.gripping && R && R.gripping) ? 'L' : (R && !R.gripping && L && L.gripping) ? 'R' : null;
    const canLook = !!freeSide && (state.phase === 'climbing' || state.phase === 'caught');
    const wantX = canLook && lookIn && lookIn.active ? clamp1(lookIn.x) : 0;
    const wantY = canLook && lookIn && lookIn.active ? clamp1(lookIn.y) : 0;
    const outSign = freeSide === 'L' ? -1 : 1;                 // free left arm turns you left
    const yawWant = wantX >= 0
      ? wantX * (outSign > 0 ? LOOK.yawOutward : LOOK.yawInward)
      : wantX * (outSign > 0 ? LOOK.yawInward : LOOK.yawOutward);
    const pitchWant = wantY >= 0 ? wantY * LOOK.pitchUp : wantY * LOOK.pitchDown;
    const k = (wantX || wantY) ? LOOK.rate : LOOK.recenter;
    lookYaw = approach(lookYaw, canLook ? yawWant : 0, k, dt);
    lookPitch = approach(lookPitch, canLook ? pitchWant : 0, k, dt);
    // staring down widens the lens a little, so the drop opens up under you
    const down = Math.max(0, -lookPitch / LOOK.pitchDown);
    vertigo = approach(vertigo, down * down, LOOK.vertigoRate, dt);

    if (Math.abs(lookYaw) > 1e-4 || Math.abs(lookPitch) > 1e-4) {
      const d = look.clone().sub(camera.position);
      const len = Math.max(0.35, d.length());
      const az = Math.atan2(d.x, d.z) + lookYaw;               // rotate about the world up axis
      const el = Math.asin(THREE.MathUtils.clamp(d.y / len, -1, 1)) + lookPitch;
      const ce = Math.cos(THREE.MathUtils.clamp(el, -1.5, 1.5));
      look.set(
        camera.position.x + len * ce * Math.sin(az),
        camera.position.y + len * Math.sin(THREE.MathUtils.clamp(el, -1.5, 1.5)),
        camera.position.z + len * ce * Math.cos(az),
      );
    }

    if (state.phase === 'fallen' && impact < 0.001 && doom > 0.2) impact = 1;
    impact = approach(impact, 0, 2.2, dt);
    const rollNow = roll.x + THREE.MathUtils.degToRad(2.5) * shake * noise(t, 11.0) + breath * 0.004
      + Math.sin(tumble * 0.9) * 0.5 * doom                       // the world turns over
      + THREE.MathUtils.degToRad(9) * impact * noise(t, 23.0);    // and slams still
    camera.up.set(Math.sin(rollNow), Math.cos(rollNow), 0);
    camera.lookAt(look);

    let fov = fov0 + fovKick.x + 6 * fallBlend + LOOK.vertigoFov * vertigo + 22 * doom - 10 * impact;
    if (summitT >= 0) fov -= 8 * (1 - Math.exp(-summitT / SUMMIT_TAU));
    fov = THREE.MathUtils.clamp(fov, 40, 110);
    if (Math.abs(fov - lastFov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
      lastFov = fov;
    }
    initialised = true;
  }

  return {
    update,
    setPortrait,
    kick,
    get portrait() { return isPortraitNow(); },
    get eye() { return eye; },
    get look() { return look; },
    get roll() { return roll.x; },
    get pull() { return pull.x; },
    get lean() { return lean.x; },
    get fov() { return camera.fov; },
  };
}
