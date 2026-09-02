// src/arms.js — first-person arms for Rock Climber: The Ritual (arms-camera domain).
//
// Hands: "Realistic Hand" by J-Toastie (Poly Pizza, CC-BY 3.0, see assets/models/hands/LICENSE.md),
// one skinned GLB cloned for both sides with SkeletonUtils; the off-hand is the mirror image
// (scale.x = -1 on a parent group). The model's own axes (finger direction, thumb side, palm side)
// are measured at load time from its bones and its 'Grab' clip, so the code never hard-codes the
// exporter's frame. Forearm and upper arm are tapered cloth cylinders placed by a 2-bone IK from the
// shoulder; finger curl samples the 'Grab' clip directly (no mixer) so the amount is a plain number;
// tremble is a small high-frequency jitter. Reads `state` only, never touches the DOM.
//
// Public surface (CONTRACTS.md): createArms({ scene, tier, shoulder?, holdZ? }) → arms; arms.update(dt, state, wallZ, camera)
// Optional injections: shoulder = sim.shoulder (else the CFG offsets are mirrored here), holdZ = world.holdZ (front z of a hold blob).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

const HAND_URL = new URL('../assets/models/hands/realistic_hand.glb', import.meta.url).href;

// Mirrors of sim CFG used only when the integrator does not inject sim's shoulder().
const SHOULDER_DX = 0.19;
const SHOULDER_DY = 0.08;
const REACH = 0.72;

const HAND_LEN = 0.19;          // wrist crease → middle fingertip, metres
const PALM_OFFSET = 0.075;      // wrist → palm centre, along the fingers
const UPPER = 0.31;             // shoulder → elbow
const LOWER = 0.29;             // elbow → wrist
const LEAN = 0.22;              // the reaching shoulder rolls toward the wall by up to this much
const PROTRACT = 0.07;          // ...and slides toward the hand by up to this much
const BODY_DEPTH = 0.55;        // body z above the wall (contract)
const SHOULDER_BACK = 0.05;     // shoulders sit 5 cm closer to the wall than the body point
// Front-most z of a hold blob as a fraction of its radius — mirrors world.js HOLD (sink 0.05 +
// zScale 0.42 × 1.05). Overridden when the integrator injects world's holdZ(hold).
const HOLD_FRONT = 0.49;

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

// ---------------------------------------------------------------------------------------------
// Small helpers

/** Wall normal from finite differences of wallZ. */
function wallNormal(wz, x, y, out) {
  const e = 0.06;
  const dzdx = (wz(x + e, y) - wz(x - e, y)) / (2 * e);
  const dzdy = (wz(x, y + e) - wz(x, y - e)) / (2 * e);
  return out.set(-dzdx, -dzdy, 1).normalize();
}

/** Orientation with local Y along `axis` and local Z as close to `zHint` (the wall normal) as possible. */
function limbBasis(axis, zHint, outQ) {
  const z = _v2.copy(zHint).addScaledVector(axis, -zHint.dot(axis));
  if (z.lengthSq() < 1e-6) z.set(0, 0, 1).addScaledVector(axis, -axis.z);
  z.normalize();
  const x = _v3.crossVectors(axis, z).normalize();
  _m.makeBasis(x, axis, z);
  return outQ.setFromRotationMatrix(_m);
}

/** Cheap deterministic 1-D noise in [-1, 1] built from incommensurate sines. */
function jitter(t, seed) {
  return 0.5 * Math.sin(t * 11.3 + seed) + 0.3 * Math.sin(t * 17.9 + seed * 1.7) + 0.2 * Math.sin(t * 27.1 + seed * 2.3);
}

/** Exponential approach with a rate in 1/s (frame-rate independent). */
function approach(cur, target, rate, dt) {
  return target + (cur - target) * Math.exp(-rate * dt);
}

/** Look up a bone by its glTF name, tolerant of the loader's name sanitising ('Bone.001' → 'Bone001'). */
function findBone(root, name) {
  return root.getObjectByName(name) || root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
}

/**
 * Two-bone IK. Places the elbow for a shoulder S and wrist W given segment lengths, bending toward
 * `pole`. When the target is out of reach both segments stretch uniformly (the upper arm is off-screen
 * in first person, so a stretched arm reads better than a hand that stops short of its hold).
 */
function solveElbow(S, W, l1, l2, pole, outE) {
  const axis = _v1.subVectors(W, S);
  const d = Math.max(1e-4, axis.length());
  axis.multiplyScalar(1 / d);
  const reach = (l1 + l2) * 0.985;
  const stretch = d > reach ? d / reach : 1;
  const a1 = l1 * stretch, a2 = l2 * stretch;
  const dd = Math.min(d, a1 + a2 - 1e-4);
  const a = (a1 * a1 - a2 * a2 + dd * dd) / (2 * dd);
  const h = Math.sqrt(Math.max(0, a1 * a1 - a * a));
  const perp = _v2.copy(pole).addScaledVector(axis, -pole.dot(axis));
  if (perp.lengthSq() < 1e-6) perp.set(0, -1, 0).addScaledVector(axis, -axis.y);
  perp.normalize();
  outE.copy(S).addScaledVector(axis, a).addScaledVector(perp, h);
  return stretch;
}

// ---------------------------------------------------------------------------------------------
// Procedural cloth textures (tiny canvases, built once)

function makeNormalMap(size, heightFn) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) h[y * size + x] = heightFn(x / size, y / size);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * size * 0.5;
      const dy = (at(x, y + 1) - at(x, y - 1)) * size * 0.5;
      const n = _v1.set(-dx, -dy, 1).normalize();
      const i = (y * size + x) * 4;
      img.data[i] = (n.x * 0.5 + 0.5) * 255;
      img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      img.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Twill weave: two interleaved thread directions with slight irregularity. */
function weaveHeight(u, v) {
  const n = 14;
  const a = Math.sin(u * Math.PI * 2 * n) * Math.sin(v * Math.PI * 2 * n + 0.6);
  const b = Math.sin((u + v) * Math.PI * 2 * n * 0.5);
  const wobble = Math.sin(u * 37.1 + v * 23.7) * 0.15;
  return 0.5 + 0.02 * (a * 0.7 + b * 0.5 + wobble);
}

/** Ribbed cuff: stripes along the cuff axis. */
function ribHeight(u) {
  return 0.5 + 0.03 * Math.sin(u * Math.PI * 2 * 24);
}

/**
 * Sleeve wrinkles: a handful of narrow creases that circle the tube (u) while wandering along its
 * length (v), like a pushed-up sleeve. Each crease is a Gaussian ridge around a wavy centre line.
 */
const CREASES = [
  // v0 (0 = elbow end, 1 = cuff end), wave amplitude, wave phase, ridge height, ridge width
  [0.04, 0.05, 0.4, 0.05, 0.010],
  [0.11, 0.07, 2.1, 0.06, 0.012],
  [0.19, 0.06, 4.0, 0.045, 0.010],
  [0.28, 0.09, 1.2, 0.035, 0.011],
  [0.52, 0.10, 5.1, 0.03, 0.014],
  [0.78, 0.07, 3.3, 0.04, 0.011],
  [0.87, 0.05, 0.9, 0.055, 0.010],
  [0.94, 0.04, 2.6, 0.06, 0.009],
];
function wrinkleHeight(u, v) {
  const tau = Math.PI * 2;
  let h = 0.5;
  for (const [v0, amp, ph, height, width] of CREASES) {
    const centre = v0 + amp * Math.sin(u * tau + ph) + 0.02 * Math.sin(u * tau * 3 + ph * 2);
    let d = v - centre;
    d -= Math.round(d);                           // wrap along v
    h += height * Math.exp(-(d * d) / (2 * width * width));
  }
  h += 0.01 * Math.sin(u * tau * 4 + v * tau * 2);   // slow undulation
  return h;
}

/** Fine weave as a grey height map for bumpMap (cheap, no tangent frame needed). */
function makeHeightMap(size, heightFn) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = THREE.MathUtils.clamp((heightFn(x / size, y / size) - 0.5) * 12 + 0.5, 0, 1);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = h * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Average colour of an albedo image (used for the wrist plug under the cuff). */
function averageColor(image, fallback) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 8) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } }
    if (!n) return fallback;
    return new THREE.Color(r / n / 255, g / n / 255, b / n / 255).convertSRGBToLinear();
  } catch (_) {
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------
// Skin material with chalk toward the fingertips (per-vertex attribute, injected into the shader)

function makeSkinMaterial(srcMaterial) {
  const mat = new THREE.MeshPhysicalMaterial({
    map: srcMaterial.map || null,
    normalMap: srcMaterial.normalMap || null,
    normalScale: new THREE.Vector2(1.25, 1.25),
    roughness: 0.55,
    metalness: 0,
    sheen: 0.22,
    sheenRoughness: 0.65,
    sheenColor: new THREE.Color(0xffb890),     // warm rim, skin oil not plastic
    specularIntensity: 0.45,
    envMapIntensity: 0.9,
  });
  if (mat.map) { mat.map.anisotropy = 4; mat.map.colorSpace = THREE.SRGBColorSpace; }
  if (mat.normalMap) mat.normalMap.anisotropy = 4;
  mat.customProgramCacheKey = () => 'ritual-skin-chalk-2';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float chalk;\nvarying float vChalk;\nvarying vec2 vChalkUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvChalk = chalk;\nvChalkUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vChalk;\nvarying vec2 vChalkUv;\n' +
        'float chalkHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }\n' +
        'float chalkNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);\n' +
        '  return mix(mix(chalkHash(i), chalkHash(i + vec2(1.0, 0.0)), f.x), mix(chalkHash(i + vec2(0.0, 1.0)), chalkHash(i + vec2(1.0, 1.0)), f.x), f.y); }\n' +
        'float chalkAmount() {\n' +
        '  // magnesium chalk clings in patches: a smooth per-vertex mask broken by two noise octaves\n' +
        '  float n = 0.65 * chalkNoise(vChalkUv * 46.0) + 0.35 * chalkNoise(vChalkUv * 170.0);\n' +
        '  return smoothstep(0.30, 0.85, vChalk * (0.55 + 0.75 * n));\n' +
        '}')
      .replace('#include <map_fragment>',
        '#include <map_fragment>\n' +
        'float chalkK = chalkAmount();\n' +
        'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.78, 0.74), chalkK * 0.8);')
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = min(1.0, roughnessFactor + chalkAmount() * 0.4);');
  };
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Model analysis: measure the hand's own frame and the clip's curl profile once, at load

function analyseTemplate(gltf) {
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  let skinned = null;
  root.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
  if (!skinned) throw new Error('arms: hand model has no skinned mesh');

  const wrist = findBone(root, 'HandMain') || skinned.skeleton.bones[0];
  const midTip = findBone(root, 'MiddleF_tip_end_end') || findBone(root, 'MiddleF_tip_end') || findBone(root, 'MiddleF_tip');
  const thumbTip = findBone(root, 'Bone.003_end_end') || findBone(root, 'Bone.003_end') || findBone(root, 'Bone.003');
  const tips = ['IndexF_tip_end', 'MiddleF_tip_end', 'RingF_tip_end', 'PinkyF_tip_end'].map((n) => findBone(root, n)).filter(Boolean);

  const wristP = wrist.getWorldPosition(new THREE.Vector3());
  const tipP = midTip.getWorldPosition(new THREE.Vector3());
  const f = tipP.clone().sub(wristP);           // finger direction
  const handLen = f.length();
  f.normalize();

  // Thumb side: thumb tip offset, perpendicular to the fingers.
  const s0 = thumbTip.getWorldPosition(new THREE.Vector3()).sub(wristP);
  s0.addScaledVector(f, -s0.dot(f)).normalize();

  // Curl profile of the Grab clip: sample it, watch the fingertips move toward the palm.
  const clip = (gltf.animations || []).find((a) => /grab/i.test(a.name)) || (gltf.animations || [])[0] || null;
  const tracks = [];
  if (clip) {
    for (const t of clip.tracks) {
      if (!t.name.endsWith('.quaternion')) continue;
      const nodeName = THREE.PropertyBinding.parseTrackName(t.name).nodeName;
      if (nodeName === 'HandMain' || nodeName === THREE.PropertyBinding.sanitizeNodeName('HandMain')) continue; // root: keep our own wrist pose
      const bone = root.getObjectByName(nodeName);
      if (bone) tracks.push({ nodeName, track: t, bone });
    }
  }
  const rest = tracks.map((tr) => tr.bone.quaternion.clone());
  const tipRest = tips.map((b) => b.getWorldPosition(new THREE.Vector3()));
  // Middle joints (PIP): in a fist they swing from knuckle + L·f to knuckle + L·p, so their
  // displacement perpendicular to the fingers points squarely at the palm side.
  const mids = ['IndexF_middle', 'MiddleF_middle', 'RingF_middle', 'PinkyF_middle'].map((n) => findBone(root, n)).filter(Boolean);
  const midRest = mids.map((b) => b.getWorldPosition(new THREE.Vector3()));
  let tClosed = clip ? clip.duration : 0;
  let tStart = 0, tHook = tClosed;
  let best = -1;
  const palmDir = new THREE.Vector3();
  if (clip && tracks.length) {
    const interps = tracks.map((tr) => tr.track.createInterpolant());
    const N = 48;
    const profile = [];
    for (let i = 0; i <= N; i++) {
      const t = (clip.duration * i) / N;
      tracks.forEach((tr, k) => { interps[k].evaluate(t); tr.bone.quaternion.fromArray(interps[k].resultBuffer); });
      root.updateMatrixWorld(true);
      // closed-ness: how far the fingertips moved from their rest positions
      let score = 0;
      tips.forEach((b, k) => { score += b.getWorldPosition(_v1).distanceTo(tipRest[k]); });
      profile.push({ t, score });
      if (score > best) {
        best = score; tClosed = t;
        palmDir.set(0, 0, 0);
        mids.forEach((b, k) => palmDir.add(_v2.subVectors(b.getWorldPosition(_v1), midRest[k])));
      }
    }
    tracks.forEach((tr, k) => tr.bone.quaternion.copy(rest[k]));
    root.updateMatrixWorld(true);
    // The clip spreads the fingers first, then closes into a fist. A climber hooks a hold rather
    // than punching it, so "fully gripping" stops well short of the fist: tStart is where the
    // fingers begin to close, tHook is a hooked crimp about half way to the fist.
    const crossing = (frac) => {
      for (let i = 1; i < profile.length; i++) {
        if (profile[i].t > tClosed) break;
        if (profile[i].score >= best * frac) {
          const a = profile[i - 1], b = profile[i];
          const u = (best * frac - a.score) / Math.max(1e-6, b.score - a.score);
          return a.t + (b.t - a.t) * THREE.MathUtils.clamp(u, 0, 1);
        }
      }
      return tClosed;
    };
    tStart = crossing(0.10);
    tHook = crossing(0.5);
  }
  // Palm normal: the curl displacement, perpendicular to the fingers. Fallback: thumb rests on the palm side.
  let p = palmDir.addScaledVector(f, -palmDir.dot(f));
  if (p.lengthSq() < 1e-8) {
    p = thumbTip.getWorldPosition(new THREE.Vector3()).sub(wristP);
    p.addScaledVector(f, -p.dot(f)).addScaledVector(s0, -p.dot(s0));
    if (p.lengthSq() < 1e-8) p = new THREE.Vector3().crossVectors(s0, f);
  }
  p.normalize();
  // make the thumb side exactly perpendicular to both
  s0.addScaledVector(p, -s0.dot(p)).normalize();
  const s = new THREE.Vector3().crossVectors(f, p).normalize();     // canonical thumb side for a right hand
  const modelIsRight = s.dot(s0) > 0;

  // Extents of the bind-pose mesh along the hand axes, and the chalk attribute (shared geometry).
  const geo = skinned.geometry;
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const chalk = new Float32Array(pos.count);
  const nm = new THREE.Matrix3().getNormalMatrix(skinned.matrixWorld);
  let minP = Infinity, maxP = -Infinity, minS = Infinity, maxS = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    _v1.fromBufferAttribute(pos, i).applyMatrix4(skinned.matrixWorld).sub(wristP);
    const along = _v1.dot(f) / handLen;                // 0 wrist → 1 fingertips
    const dp = _v1.dot(p), ds = _v1.dot(s);
    if (dp < minP) minP = dp; if (dp > maxP) maxP = dp;
    if (ds < minS) minS = ds; if (ds > maxS) maxS = ds;
    _v2.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
    const palmFacing = THREE.MathUtils.clamp(_v2.dot(p) * 0.5 + 0.5, 0, 1);
    const tipness = THREE.MathUtils.smoothstep(along, 0.30, 0.90);       // knuckles → fingertips
    const palmness = THREE.MathUtils.smoothstep(along, 0.05, 0.45) * (1 - THREE.MathUtils.smoothstep(along, 0.55, 0.9));
    // palm and finger pads carry most of the chalk, the backs of the fingers only a light dusting
    chalk[i] = Math.min(1, tipness * (0.35 + 0.75 * palmFacing) + palmness * 0.7 * palmFacing);
  }
  if (!geo.getAttribute('chalk')) geo.setAttribute('chalk', new THREE.BufferAttribute(chalk, 1));

  // Rotation taking the model frame (s, f, p) to the canonical hand frame (-X, +Y, -Z):
  // fingers up, palm toward the wall (-Z), thumb toward the body centre for a right hand.
  const M = new THREE.Matrix4().makeBasis(s, f, p);
  const C = new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
  const R = C.multiply(M.clone().transpose());
  const fix = new THREE.Quaternion().setFromRotationMatrix(R);

  const k = HAND_LEN / handLen;
  return {
    gltf, root, skinned, wristP, fix, scale: k, modelIsRight,
    clip, tClosed, tStart, tHook,
    trackNames: tracks.map((tr) => tr.nodeName),
    thickness: (maxP - minP) * k,         // metres, palm ↔ back
    palmDepth: maxP * k,                  // wrist origin → palm surface
    backDepth: -minP * k,                 // wrist origin → back-of-hand surface
    width: (maxS - minS) * k,
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * Build both arms. Resolves once the hand model is loaded; the returned object's `update` is safe to
 * call before that (it simply does nothing until the meshes exist).
 */
export async function createArms({ scene, tier, shoulder, holdZ } = {}) {
  const tierName = tier && tier.name ? tier.name : 'desktop';
  const group = new THREE.Group();
  group.name = 'arms';
  if (scene) scene.add(group);

  const arms = {
    group,
    ready: false,
    template: null,
    sides: {},
    hookScale: 1.0,      // tuning: multiplies the clip time used for a full grip (1 = analysed hook)
    update,
    setTier,
    dispose,
  };

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(HAND_URL);
  const T = analyseTemplate(gltf);
  arms.template = T;

  // Materials shared by both sides.
  const skinMat = makeSkinMaterial(T.skinned.material);
  const skinTone = averageColor(T.skinned.material.map && T.skinned.material.map.image, new THREE.Color(0x8d5a3f));
  const plainSkin = new THREE.MeshPhysicalMaterial({ color: skinTone, roughness: 0.6, metalness: 0, sheen: 0.4, sheenColor: new THREE.Color(0xffc9ad), sheenRoughness: 0.6 });
  // Cloth = soft wrinkle normals at sleeve scale + a fine weave bump (~1.5 mm threads: gone at
  // arm's length, a soft grain up close).
  const wrinkles = makeNormalMap(tierName === 'phone' ? 128 : 256, wrinkleHeight);
  wrinkles.repeat.set(1, 1);
  const weave = makeHeightMap(tierName === 'phone' ? 64 : 128, weaveHeight);
  weave.repeat.set(12, 30);
  const rib = makeNormalMap(128, (u) => ribHeight(u));
  rib.repeat.set(1, 1);
  const clothMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x554f34),        // olive with an ochre lean; reads as cloth under the low sun
    roughness: 0.97,
    metalness: 0,
    sheen: 0.22,
    sheenRoughness: 0.95,
    sheenColor: new THREE.Color(0x8a7d4e),
    normalMap: wrinkles,
    normalScale: new THREE.Vector2(0.7, 0.7),
    bumpMap: weave,
    bumpScale: 0.0014,
    envMapIntensity: 0.35,
  });
  const cuffMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x4a432b),
    roughness: 0.94,
    metalness: 0,
    sheen: 0.25,
    sheenRoughness: 0.92,
    sheenColor: new THREE.Color(0x7a6f45),
    normalMap: rib,
    normalScale: new THREE.Vector2(0.6, 0.6),
    side: THREE.DoubleSide,
    envMapIntensity: 0.4,
  });
  // A braided cord around each wrist with one small rune bead: the climber's own token for the ritual.
  const cordMat = new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.85, metalness: 0 });
  const beadMat = new THREE.MeshStandardMaterial({ color: 0x23414a, emissive: new THREE.Color(0x7fe0ff), emissiveIntensity: 0.22, roughness: 0.3, metalness: 0.05 });

  // Geometries shared by both sides (unit-height cylinders scaled per frame along Y).
  const forearmGeo = new THREE.CylinderGeometry(0.031, 0.045, 1, 32, 8, true);   // wrist → elbow radius
  ripple(forearmGeo, 0.0022);
  const upperGeo = new THREE.CylinderGeometry(0.044, 0.051, 1, 28, 6, true);
  ripple(upperGeo, 0.0025);
  const elbowGeo = new THREE.SphereGeometry(0.045, 18, 14);
  const shoulderGeo = new THREE.SphereGeometry(0.053, 18, 14);   // rounds off the sleeve's top end
  const cuffGeo = new THREE.CylinderGeometry(0.037, 0.035, 0.07, 24, 1, true);
  const cuffRimGeo = new THREE.TorusGeometry(0.037, 0.0042, 8, 28);
  const plugGeo = new THREE.SphereGeometry(1, 16, 12);
  const cordGeo = new THREE.TorusGeometry(0.0385, 0.0022, 6, 36);
  const beadGeo = new THREE.SphereGeometry(0.0045, 10, 8);

  for (const side of ['L', 'R']) {
    const sgn = side === 'R' ? 1 : -1;
    const handRoot = new THREE.Group();          // posed at the wrist each frame
    handRoot.name = 'hand-' + side;
    const mirror = new THREE.Group();
    mirror.scale.x = (side === 'R') === T.modelIsRight ? 1 : -1;
    const fix = new THREE.Group();
    fix.quaternion.copy(T.fix);
    fix.scale.setScalar(T.scale);
    const model = cloneSkeleton(T.root);
    model.position.copy(T.wristP).negate();
    fix.add(model);
    mirror.add(fix);
    handRoot.add(mirror);

    let skinned = null;
    model.traverse((o) => {
      if (o.isSkinnedMesh) {
        skinned = o;
        o.material = skinMat;
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
      }
    });

    // Finger curl: sample the Grab clip per bone, blended out of the bind pose near curl = 0.
    const curlTracks = [];
    if (T.clip) {
      for (const tr of T.clip.tracks) {
        if (!tr.name.endsWith('.quaternion')) continue;
        const nodeName = THREE.PropertyBinding.parseTrackName(tr.name).nodeName;
        if (!T.trackNames.includes(nodeName)) continue;
        const bone = model.getObjectByName(nodeName);
        if (!bone) continue;
        curlTracks.push({ bone, interp: tr.createInterpolant(), rest: bone.quaternion.clone(), seed: curlTracks.length * 1.37 });
      }
    }

    // Cuff follows the forearm axis and overlaps the hand's wrist cut by ~3 cm; a skin plug sits
    // inside it (aligned with the forearm, not the hand) so the cuff never reads as a hollow tube.
    const cuff = new THREE.Group();
    const cuffMesh = new THREE.Mesh(cuffGeo, cuffMat);
    cuffMesh.castShadow = true; cuffMesh.receiveShadow = true;
    const rim = new THREE.Mesh(cuffRimGeo, cuffMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.035;
    rim.castShadow = true;
    const plug = new THREE.Mesh(plugGeo, plainSkin);
    plug.scale.set(0.031, 0.05, 0.024);
    plug.position.set(0, 0.0, 0);
    plug.castShadow = true;
    const cord = new THREE.Mesh(cordGeo, cordMat);
    cord.rotation.x = Math.PI / 2;
    cord.position.y = 0.022;
    cord.scale.set(1, 1, 0.8);
    const bead = new THREE.Mesh(beadGeo, beadMat);
    bead.position.set(-sgn * 0.0385, 0.022, 0.012);
    cuff.add(cuffMesh, rim, plug, cord, bead);

    const forearm = new THREE.Mesh(forearmGeo, clothMat);
    forearm.castShadow = true; forearm.receiveShadow = true;
    const elbow = new THREE.Mesh(elbowGeo, clothMat);
    elbow.castShadow = true; elbow.receiveShadow = true;
    const upper = new THREE.Mesh(upperGeo, clothMat);
    upper.castShadow = true; upper.receiveShadow = true;
    const shoulderBall = new THREE.Mesh(shoulderGeo, clothMat);
    shoulderBall.castShadow = true; shoulderBall.receiveShadow = true;

    group.add(handRoot, cuff, forearm, elbow, upper, shoulderBall);

    arms.sides[side] = {
      side, sgn, handRoot, mirror, model, skinned, curlTracks, cuff, plug, forearm, elbow, upper, shoulderBall,
      curl: 0.15, tremble: 0, grip: 0, tilt: 0,
      quat: new THREE.Quaternion(), pos: new THREE.Vector3(), forearmDir: new THREE.Vector3(0, 1, 0),
      S: new THREE.Vector3(), E: new THREE.Vector3(), W: new THREE.Vector3(),
      pole: new THREE.Vector3(sgn * 0.55, -1, 0.35).normalize(),
      initialised: false,
    };
  }

  // Gently ripple a cylinder's radius (two low harmonics) so the sleeve is not a perfect tube;
  // the seam column is kept identical so the normals stay continuous.
  function ripple(geo, amp) {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const ang = Math.atan2(z, x);
      const r = Math.hypot(x, z);
      const d = amp * (Math.sin(ang * 2 + y * 5) + 0.5 * Math.sin(ang * 3 - y * 8 + 1.3));
      const rr = r + d;
      p.setXYZ(i, Math.cos(ang) * rr, y, Math.sin(ang) * rr);
    }
    geo.computeVertexNormals();
    // stitch the UV seam normals
    const nrm = geo.attributes.normal;
    const radial = geo.parameters.radialSegments;
    const rows = geo.parameters.heightSegments + 1;
    for (let row = 0; row < rows; row++) {
      const a = row * (radial + 1), b = a + radial;
      const nx = (nrm.getX(a) + nrm.getX(b)) * 0.5, ny = (nrm.getY(a) + nrm.getY(b)) * 0.5, nz = (nrm.getZ(a) + nrm.getZ(b)) * 0.5;
      nrm.setXYZ(a, nx, ny, nz); nrm.setXYZ(b, nx, ny, nz);
    }
    nrm.needsUpdate = true;
  }

  let time = 0;
  let holdMap = null, holdMapRoute = null;
  function holdById(route, id) {
    if (!route || !route.holds) return null;
    if (holdMap === null || holdMapRoute !== route) {
      holdMap = new Map();
      for (const h of route.holds) holdMap.set(h.id, h);
      holdMapRoute = route;
    }
    return holdMap.get(id) || null;
  }

  /** Front-most z of a hold blob (world's holdZ when injected, else the mirrored constant). */
  function holdFront(hold, wz) {
    return typeof holdZ === 'function' ? holdZ(hold) : wz(hold.x, hold.y) + (hold.size || 0.12) * HOLD_FRONT;
  }

  /** Highest hold surface under a point, faded out over 10 cm around each blob; -Infinity when clear. */
  function clearance(route, x, y, wz) {
    let z = -Infinity;
    if (!route || !route.holds) return z;
    for (const h of route.holds) {
      const r = h.size || 0.12;
      const dx = x - h.x, dy = y - h.y;
      const d2 = dx * dx + dy * dy;
      const outer = r + 0.10;
      if (d2 > outer * outer) continue;
      const w = 1 - THREE.MathUtils.smoothstep(Math.sqrt(d2), r * 0.6, outer);   // 1 over the blob → 0 outside
      const front = holdFront(h, wz);
      const base = wz(x, y) + 0.02;
      const zz = THREE.MathUtils.lerp(base, front, w);
      if (zz > z) z = zz;
    }
    return z;
  }

  function shoulderOf(state, side) {
    if (typeof shoulder === 'function') return shoulder(state, side);
    const b = state.body;
    return { x: b.x + (side === 'R' ? SHOULDER_DX : -SHOULDER_DX), y: b.y + SHOULDER_DY };
  }

  const n = new THREE.Vector3(), fDir = new THREE.Vector3(), handC = new THREE.Vector3();
  const xAxis = new THREE.Vector3(), yAxis = new THREE.Vector3(), zAxis = new THREE.Vector3();
  const seg = new THREE.Vector3();

  function update(dt, state, wallZ, camera) {
    if (!state || !state.body || !state.hands) return;
    dt = Math.min(Math.max(dt || 0, 0), 1 / 20);
    time += dt;
    const wz = typeof wallZ === 'function' ? wallZ : () => 0;
    const body = state.body;
    const bodyZ = wz(body.x, body.y) + BODY_DEPTH;
    const falling = state.phase === 'falling';

    for (const side of ['L', 'R']) {
      const A = arms.sides[side];
      const hand = state.hands[side];
      if (!hand) continue;
      const sh = shoulderOf(state, side);
      const gripping = !!hand.gripping;
      const hover = THREE.MathUtils.clamp(hand.hover || 0, 0, 1);

      // Smoothed display values: grip weight, curl, tremble. (sim: curl → 1 gripping, 0.25·hover free)
      A.grip = approach(A.grip, gripping ? 1 : 0, gripping ? 18 : 9, dt);
      const curlTarget = THREE.MathUtils.clamp(hand.curl != null ? hand.curl : (gripping ? 1 : 0.25 * hover), 0, 1);
      A.curl = approach(A.curl, curlTarget, curlTarget > A.curl ? 16 : 8, dt);
      A.tremble = approach(A.tremble, THREE.MathUtils.clamp(hand.tremble || 0, 0, 1), 6, dt);

      // Hand centre: a free palm floats 2 cm (plus a little hover lift) off the rock; a gripping
      // palm rests on the front of its hold.
      const hx = hand.x, hy = hand.y;
      const hold = gripping && hand.holdId != null ? holdById(state.route, hand.holdId) : null;
      wallNormal(wz, hx, hy, n);
      const wallHere = wz(hx, hy);
      let freeZ = wallHere + 0.02 + T.palmDepth + 0.05 * (1 - hover) + (falling ? 0.06 : 0);
      // A free hand passing over a hold rides up onto it instead of sinking through the blob.
      freeZ = Math.max(freeZ, clearance(state.route, hx, hy, wz) + T.palmDepth + 0.012);
      let gripZ = freeZ;
      if (hold) {
        gripZ = holdFront(hold, wz) + T.palmDepth + 0.004;
      }
      handC.set(hx, hy, THREE.MathUtils.lerp(freeZ, gripZ, hold ? A.grip : 0));

      // Shoulder: as the arm reaches, the shoulder girdle rolls toward the wall and slides toward
      // the hand (real climbers lean the shoulder in; it also keeps the arm within its length).
      const inPlane = Math.hypot(hx - sh.x, hy - sh.y);
      const reachFrac = THREE.MathUtils.clamp(inPlane / REACH, 0, 1);
      fDir.set(hx - sh.x, hy - sh.y, 0);
      if (fDir.lengthSq() < 1e-6) fDir.set(0, 1, 0);
      fDir.normalize();
      const lean = reachFrac * reachFrac;
      A.S.set(sh.x + fDir.x * PROTRACT * lean, sh.y + fDir.y * PROTRACT * lean * 0.6, bodyZ - SHOULDER_BACK - LEAN * lean);

      // Finger direction: along the forearm, pulled toward "up"; two passes because the forearm
      // direction depends on where the wrist ends up.
      for (let pass = 0; pass < 2; pass++) {
        _v3.copy(fDir).addScaledVector(UP, 0.8 + 0.7 * A.grip);
        _v3.addScaledVector(n, -_v3.dot(n));                 // keep the fingers in the wall plane
        if (_v3.lengthSq() < 1e-4) _v3.copy(UP).addScaledVector(n, -UP.dot(n));
        _v3.normalize();
        A.W.copy(handC).addScaledVector(_v3, -PALM_OFFSET);
        solveElbow(A.S, A.W, UPPER, LOWER, A.pole, A.E);
        fDir.subVectors(A.W, A.E).normalize();
        A.forearmDir.copy(fDir);
      }
      _v3.copy(fDir).addScaledVector(UP, 0.8 + 0.7 * A.grip);
      _v3.addScaledVector(n, -_v3.dot(n)).normalize();
      A.W.copy(handC).addScaledVector(_v3, -PALM_OFFSET);
      solveElbow(A.S, A.W, UPPER, LOWER, A.pole, A.E);

      // Hand basis: Z = wall normal (palm faces -Z), Y = fingers, X = across the palm.
      zAxis.copy(n);
      yAxis.copy(_v3);
      xAxis.crossVectors(yAxis, zAxis).normalize();
      _m.makeBasis(xAxis, yAxis, zAxis);
      _q.setFromRotationMatrix(_m);
      // Free hands hover with the fingertips nearer the wall than the wrist; gripping hands lie flat.
      const tiltTarget = -THREE.MathUtils.degToRad(14) * (1 - A.grip) * (1 - 0.5 * hover);
      A.tilt = approach(A.tilt, tiltTarget, 10, dt);
      _q2.setFromAxisAngle(xAxis, A.tilt);
      _q.premultiply(_q2);
      if (!A.initialised) { A.quat.copy(_q); A.pos.copy(A.W); A.initialised = true; }
      A.quat.slerp(_q, 1 - Math.exp(-22 * dt));
      // ~45 ms of lag: invisible under stick control, but the 16 cm snap onto a hold becomes a short slide
      A.pos.lerp(A.W, 1 - Math.exp(-24 * dt));

      // Tremble: a muscle tremor (≈6–12 Hz) shakes the whole hand, strongest along the forearm and
      // across the wall, and rocks the wrist; the curl flutters with it below.
      const tr = A.tremble * A.tremble;
      A.handRoot.position.copy(A.pos);
      A.handRoot.quaternion.copy(A.quat);
      if (tr > 0.001) {
        const amp = 0.014 * tr;
        const tt = time * 3.1;
        A.handRoot.position.x += amp * jitter(tt, 1.0 + A.sgn);
        A.handRoot.position.y += amp * 0.8 * jitter(tt, 4.2 + A.sgn);
        A.handRoot.position.z += amp * 0.5 * jitter(tt, 7.1 + A.sgn);
        _q2.setFromAxisAngle(xAxis, THREE.MathUtils.degToRad(4.5) * tr * jitter(tt, 9.3 + A.sgn));
        A.handRoot.quaternion.premultiply(_q2);
        _q2.setFromAxisAngle(zAxis, THREE.MathUtils.degToRad(2.5) * tr * jitter(tt, 12.7 + A.sgn));
        A.handRoot.quaternion.premultiply(_q2);
      }

      // Finger curl from the clip: curl < 0.3 walks the opening "reach" spread (rest → tStart),
      // the rest of the range closes from tStart to a hooked crimp at tHook.
      if (A.curlTracks.length && T.clip) {
        const w = THREE.MathUtils.smoothstep(A.curl, 0.0, 0.1);
        for (const ct of A.curlTracks) {
          // tired fingers open a touch and flutter around it
          const flutter = tr * 0.12 * jitter(time * 3.7, ct.seed);
          const c = THREE.MathUtils.clamp(A.curl - tr * 0.08 + flutter, 0, 1);
          const t = c < 0.3
            ? THREE.MathUtils.lerp(0, T.tStart, c / 0.3)
            : THREE.MathUtils.lerp(T.tStart, T.tHook * arms.hookScale, (c - 0.3) / 0.7);
          ct.interp.evaluate(Math.min(T.tClosed, Math.max(0, t)));
          _q2.fromArray(ct.interp.resultBuffer);
          if (w >= 0.999) ct.bone.quaternion.copy(_q2);
          else ct.bone.quaternion.slerpQuaternions(ct.rest, _q2, w);
        }
      }

      // Forearm: elbow → wrist, running 3 cm on into the cuff. Unit cylinder scaled along Y.
      seg.subVectors(A.W, A.E);
      const fl = seg.length();
      seg.normalize();
      A.forearm.position.copy(A.E).addScaledVector(seg, fl * 0.5 + 0.01);
      limbBasis(seg, n, A.forearm.quaternion);
      A.forearm.scale.set(1.1, fl + 0.04, 0.88);            // a forearm is oval, flat toward the wall
      A.elbow.position.copy(A.E);
      A.elbow.quaternion.copy(A.forearm.quaternion);
      A.elbow.scale.set(1.05, 1, 0.92);

      // Cuff sits on the wrist, its far edge 5 cm up the hand.
      A.cuff.position.copy(A.W).addScaledVector(seg, 0.01);
      A.cuff.quaternion.copy(A.forearm.quaternion);

      // Upper arm: shoulder → elbow.
      seg.subVectors(A.E, A.S);
      const ul = seg.length();
      seg.normalize();
      A.upper.position.copy(A.S).addScaledVector(seg, ul * 0.5);
      limbBasis(seg, n, A.upper.quaternion);
      A.upper.scale.set(1.08, ul + 0.02, 0.9);
      A.shoulderBall.position.copy(A.S);
    }
  }

  function setTier(t) {
    const name = t && t.name ? t.name : 'desktop';
    const phone = name === 'phone';
    // Sheen is the only meaningfully expensive bit; keep it, but soften texture filtering on phones.
    if (skinMat.map) skinMat.map.anisotropy = phone ? 2 : 4;
    if (skinMat.normalMap) skinMat.normalMap.anisotropy = phone ? 2 : 4;
    skinMat.needsUpdate = true;
  }

  function dispose() {
    if (scene) scene.remove(group);
    [forearmGeo, upperGeo, elbowGeo, shoulderGeo, cuffGeo, cuffRimGeo, plugGeo, cordGeo, beadGeo].forEach((g) => g.dispose());
    [skinMat, plainSkin, clothMat, cuffMat, cordMat, beadMat].forEach((m) => m.dispose());
    weave.dispose(); rib.dispose(); wrinkles.dispose();
  }

  setTier(tier);
  arms.ready = true;
  return arms;
}
