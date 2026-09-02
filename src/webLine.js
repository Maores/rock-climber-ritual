// src/webLine.js — the web the spider hand shoots.
//
// A real web line is not a wire. It is several thin strands twisted around each other, never
// quite straight, and where it lands it splays into a fan that grips the rock. This builds that:
// N strands helixed around the shot axis with a little noise wobble, plus a splayed fan and a
// small splat at the anchor end.
//
//   const web = createWebLine({ variant: 'rope' });   scene.add(web.group);
//   web.set(fromVec3, toVec3, { grow: 0..1 });        // grow animates the shot travelling out
//   web.visible = false;
//
// Variants only change colour and how much light the strands throw.

import * as THREE from 'three';

export const WEB_VARIANTS = {
  rope: {
    label: 'Twisted rope',
    color: 0xe8eef2, emissive: 0xbcd4de, emissiveIntensity: 0.35,
    strands: 4, radius: 0.0075, twist: 5.2, wobble: 0.022, fan: 7, roughness: 0.72,
  },
  thin: {
    label: 'Single clean strand',
    color: 0xf2f6f8, emissive: 0xc8dae2, emissiveIntensity: 0.3,
    strands: 1, radius: 0.011, twist: 0.0, wobble: 0.012, fan: 5, roughness: 0.6,
  },
  rune: {
    label: 'Ritual web',
    color: 0x2f9dc0, emissive: 0x7fe0ff, emissiveIntensity: 1.15,
    strands: 3, radius: 0.008, twist: 4.4, wobble: 0.02, fan: 7, roughness: 0.4,
  },
};

// Deterministic wobble: the same shot always looks the same, so it never shimmers per frame.
function hash(i) {
  const s = Math.sin(i * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

export function createWebLine({ variant = 'rope', segments = 26 } = {}) {
  const v = WEB_VARIANTS[variant] || WEB_VARIANTS.rope;
  const group = new THREE.Group();
  group.name = 'web-line';

  const mat = new THREE.MeshStandardMaterial({
    color: v.color,
    emissive: new THREE.Color(v.emissive),
    emissiveIntensity: v.emissiveIntensity,
    roughness: v.roughness,
    metalness: 0.0,
  });

  // One tube per strand, rebuilt in place as the shot travels.
  const strands = [];
  for (let i = 0; i < v.strands; i++) {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    m.frustumCulled = false;
    group.add(m);
    strands.push(m);
  }
  // The fan: short strands splaying from the anchor onto the rock.
  const fan = [];
  for (let i = 0; i < v.fan; i++) {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    m.frustumCulled = false;
    group.add(m);
    fan.push(m);
  }
  // A soft splat where it bit the rock.
  const splat = new THREE.Mesh(new THREE.CircleGeometry(1, 18), new THREE.MeshBasicMaterial({
    color: v.emissive, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  splat.frustumCulled = false;
  group.add(splat);

  const A = new THREE.Vector3(), B = new THREE.Vector3(), dir = new THREE.Vector3();
  const up = new THREE.Vector3(), side = new THREE.Vector3(), tmp = new THREE.Vector3();

  function rebuild(mesh, pts, radius) {
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, Math.max(6, pts.length * 2), radius, 5, false);
    mesh.geometry.dispose();
    mesh.geometry = geo;
  }

  /**
   * Point the web from `from` to `to`. `grow` in 0..1 animates the shot flying out; below 1 the
   * fan and splat stay hidden, so the web only bites when it arrives.
   */
  function set(from, to, { grow = 1, whip = 0, taut = 0 } = {}) {
    A.copy(from); B.copy(to);
    dir.subVectors(B, A);
    const len = dir.length();
    if (len < 1e-4) { group.visible = false; return; }
    dir.divideScalar(len);

    // a stable frame around the shot axis
    up.set(0, 1, 0);
    if (Math.abs(up.dot(dir)) > 0.95) up.set(1, 0, 0);
    side.crossVectors(dir, up).normalize();
    up.crossVectors(side, dir).normalize();

    const reach = Math.max(0.02, len * Math.min(1, Math.max(0, grow)));
    const tipIsAnchor = grow >= 0.999;

    for (let s = 0; s < strands.length; s++) {
      const phase = (s / strands.length) * Math.PI * 2;
      const pts = [];
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const along = t * reach;
        // strands twist around the axis, pinching to nothing at both ends
        const pinch = Math.sin(Math.PI * Math.min(1, t * 1.02)) ** 0.6;
        const ang = phase + t * v.twist * Math.PI;
        const r = v.radius * 1.9 * pinch * (strands.length > 1 ? 1 : 0);
        // plus a slow irregular sway so it never reads as a machined cable
        let w = v.wobble * pinch * (hash(s * 13 + i) - 0.5) * 2;
        // WHIP: while the shot is travelling the line lashes behind the tip, biggest near the
        // hand and dying at the tip, so it reads as thrown rather than extruded. Once taut it
        // straightens and hums instead.
        if (whip > 0) w += Math.sin(t * 9.0 - whip * 14.0) * 0.16 * whip * (1 - t) * (1 - t);
        if (taut > 0) w *= 1 - 0.75 * taut;
        tmp.copy(A)
          .addScaledVector(dir, along)
          .addScaledVector(side, Math.cos(ang) * r + w)
          .addScaledVector(up, Math.sin(ang) * r + w * 0.7);
        pts.push(tmp.clone());
      }
      rebuild(strands[s], pts, v.radius);
    }

    // --- the bite ------------------------------------------------------------------------
    for (let i = 0; i < fan.length; i++) fan[i].visible = tipIsAnchor;
    splat.visible = tipIsAnchor;
    if (tipIsAnchor) {
      for (let i = 0; i < fan.length; i++) {
        const a = (i / fan.length) * Math.PI * 2 + 0.4;
        const spread = 0.10 + 0.09 * hash(i * 7);
        const pts = [];
        for (let k = 0; k <= 5; k++) {
          const t = k / 5;
          const droop = Math.sin(t * Math.PI) * 0.03 * (hash(i * 3 + k) - 0.5);
          tmp.copy(B)
            .addScaledVector(dir, -0.02 + t * 0.015)
            .addScaledVector(side, Math.cos(a) * spread * t + droop)
            .addScaledVector(up, Math.sin(a) * spread * t + droop);
          pts.push(tmp.clone());
        }
        rebuild(fan[i], pts, v.radius * 0.62);
      }
      splat.position.copy(B).addScaledVector(dir, -0.012);
      splat.lookAt(tmp.copy(B).addScaledVector(dir, -1));
      splat.scale.setScalar(0.11);
    }

    group.visible = true;
  }

  return {
    group,
    material: mat,
    variant,
    set,
    set visible(b) { group.visible = b; },
    get visible() { return group.visible; },
    dispose() {
      for (const m of strands.concat(fan)) m.geometry.dispose();
      splat.geometry.dispose(); splat.material.dispose(); mat.dispose();
    },
  };
}
