// src/webFx.js — everything you SEE about the web-zip that is not the line itself.
//
//   • the reticle: where the shot will land, drawn on the rock while you aim
//   • the trajectory: a dotted arc from the hand to that point
//   • speed streaks: air tearing past the lens, scaled to how fast you are actually moving
//
// All three exist only while the egg is unlocked, and cost nothing when idle: the meshes are
// built once and hidden.

import * as THREE from 'three';

const RUNE = new THREE.Color(0x7fe0ff);

// A ring that reads against red rock: a bright core with a dark rim behind it, drawn on top of
// the wall so it is never lost in the noise of the texture.
function makeReticle() {
  const g = new THREE.Group();

  const rim = new THREE.Mesh(
    new THREE.RingGeometry(0.185, 0.315, 44),
    new THREE.MeshBasicMaterial({ color: 0x04101a, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }),
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.215, 0.285, 44),
    new THREE.MeshBasicMaterial({ color: 0xdff6ff, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  // four ticks, so it reads as an instrument rather than a decal
  const tickGeo = new THREE.PlaneGeometry(0.075, 0.016);
  const tickMat = new THREE.MeshBasicMaterial({ color: RUNE, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
  const ticks = [];
  for (let i = 0; i < 4; i++) {
    const t = new THREE.Mesh(tickGeo, tickMat);
    const a = (i / 4) * Math.PI * 2;
    t.position.set(Math.cos(a) * 0.335, Math.sin(a) * 0.335, 0);
    t.rotation.z = a;
    ticks.push(t);
    g.add(t);
  }
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.035, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  g.add(rim, ring, dot);
  g.renderOrder = 9;
  g.traverse((o) => { o.renderOrder = 9; o.frustumCulled = false; });
  return { group: g, ring, rim, dot, ticks, tickMat };
}

export function createWebFx({ scene, count = 90 } = {}) {
  const root = new THREE.Group();
  root.name = 'web-fx';
  if (scene) scene.add(root);

  // --- reticle + trajectory ------------------------------------------------------------------
  const ret = makeReticle();
  ret.group.visible = false;
  root.add(ret.group);

  const DOTS = 16;
  const arcGeo = new THREE.BufferGeometry();
  arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DOTS * 3), 3));
  const arcMat = new THREE.PointsMaterial({
    color: RUNE, size: 9, sizeAttenuation: false, transparent: true, opacity: 0.85,
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const arc = new THREE.Points(arcGeo, arcMat);
  arc.visible = false;
  arc.renderOrder = 9;
  arc.frustumCulled = false;
  root.add(arc);

  // --- speed streaks ---------------------------------------------------------------------------
  // Short segments living in a box around the camera, stretched along the direction of travel.
  // They are drawn in world space and recycled, so speed reads as air moving past you.
  const seg = new Float32Array(count * 6);
  const streakGeo = new THREE.BufferGeometry();
  streakGeo.setAttribute('position', new THREE.BufferAttribute(seg, 3));
  const streakMat = new THREE.LineBasicMaterial({
    color: 0xd8ecf6, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const streaks = new THREE.LineSegments(streakGeo, streakMat);
  streaks.frustumCulled = false;
  streaks.visible = false;
  root.add(streaks);

  const home = new Float32Array(count * 3);
  const rnd = (i) => { const s = Math.sin(i * 91.7) * 43758.5453; return s - Math.floor(s); };
  for (let i = 0; i < count; i++) {
    home[i * 3] = (rnd(i) - 0.5) * 5.0;
    home[i * 3 + 1] = (rnd(i + 101) - 0.5) * 5.0;
    home[i * 3 + 2] = (rnd(i + 211) - 0.5) * 3.0;
  }

  const _v = new THREE.Vector3(), _dir = new THREE.Vector3(), _p = new THREE.Vector3();
  let streakK = 0;

  /**
   * @param dt      seconds
   * @param state   the sim state
   * @param camera  the live camera
   * @param wallZ   world.wallZ, so the reticle sits on the rock rather than in it
   * @param aim     { x, y, from } from sim.aimPoint(), or null when not aiming
   */
  function update(dt, state, camera, wallZ, aim) {
    const w = state.web;
    const on = !!(w && w.unlocked);

    // ---- reticle ----------------------------------------------------------------------------
    const aiming = on && w.mode === 'aiming' && aim;
    ret.group.visible = aiming;
    arc.visible = aiming;
    if (aiming) {
      const z = wallZ(aim.x, aim.y) + 0.05;
      ret.group.position.set(aim.x, aim.y, z);
      ret.group.lookAt(camera.position);
      // Hold a constant size on screen. A reticle 7 m away is a speck otherwise, and the whole
      // point of it is to be readable at the far end of the shot.
      const dist = camera.position.distanceTo(ret.group.position);
      ret.group.scale.setScalar(Math.max(0.6, dist * 0.42));
      const pulse = 0.82 + 0.18 * Math.sin(state.t * 9);
      ret.ring.material.opacity = pulse;
      ret.tickMat.opacity = pulse;
      ret.dot.material.opacity = 0.6 + 0.4 * Math.sin(state.t * 13);
      ret.group.rotation.z += dt * 0.7;

      const hand = state.hands.R;
      const hz = wallZ(hand.x, hand.y) + 0.06;
      const pos = arcGeo.attributes.position;
      for (let i = 0; i < DOTS; i++) {
        const t = (i + 1) / (DOTS + 1);
        pos.setXYZ(i,
          THREE.MathUtils.lerp(hand.x, aim.x, t),
          THREE.MathUtils.lerp(hand.y, aim.y, t) + Math.sin(Math.PI * t) * 0.12,
          THREE.MathUtils.lerp(hz, z, t) + 0.03);
      }
      pos.needsUpdate = true;
      arcMat.opacity = 0.45 + 0.35 * Math.sin(state.t * 9);
    }

    // ---- speed streaks -----------------------------------------------------------------------
    const b = state.body;
    const speed = Math.hypot(b.vx, b.vy);
    const fast = state.phase === 'swinging' || state.phase === 'falling';
    const want = fast ? Math.min(1, Math.max(0, (speed - 3.2) / 9)) : 0;
    streakK += (want - streakK) * Math.min(1, dt * (want > streakK ? 7 : 3.5));
    streaks.visible = streakK > 0.02;
    if (streaks.visible) {
      streakMat.opacity = 0.5 * streakK;
      _dir.set(-b.vx, -b.vy, 0);
      if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0);
      _dir.normalize();
      const len = 0.35 + 2.4 * streakK;
      const cam = camera.position;
      for (let i = 0; i < count; i++) {
        // wrap each streak into a box that follows the camera
        _p.set(
          cam.x + ((home[i * 3] + state.t * b.vx * 0.35) % 5.0 + 7.5) % 5.0 - 2.5,
          cam.y + ((home[i * 3 + 1] + state.t * b.vy * 0.35) % 5.0 + 7.5) % 5.0 - 2.5,
          cam.z + home[i * 3 + 2] * 0.4 + 0.25,
        );
        seg[i * 6] = _p.x; seg[i * 6 + 1] = _p.y; seg[i * 6 + 2] = _p.z;
        seg[i * 6 + 3] = _p.x + _dir.x * len;
        seg[i * 6 + 4] = _p.y + _dir.y * len;
        seg[i * 6 + 5] = _p.z;
      }
      streakGeo.attributes.position.needsUpdate = true;
    }
  }

  return {
    root,
    update,
    get streakLevel() { return streakK; },
    dispose() {
      arcGeo.dispose(); arcMat.dispose(); streakGeo.dispose(); streakMat.dispose();
      ret.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      if (scene) scene.remove(root);
    },
  };
}
