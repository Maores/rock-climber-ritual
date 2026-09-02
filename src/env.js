// Everything that emits light or fills the air: HDRI sky + PMREM environment, the low sun that
// follows the climber and casts the hand shadows, moon and hemisphere fill, exponential fog,
// stars, cloud sprites in the valley, distant mountain silhouettes, drifting dust motes, and the
// dusk → night schedule driven by state.night. Also exports the small shared helpers the rest of
// the world-light domain uses (seeded PRNG, particles, canvas textures, asset URLs).
//
// The light has three acts, keyed on state.night (0 at the start holds, 1 at the summit):
//   0.0 – 0.35  golden hour: a low grazing sun from the upper left, long shadows, violet sky fill
//   0.35 – 0.65 the sun sets: direct light dies to a pink afterglow, the sky becomes the key
//   0.65 – 1.0  moonrise: a cool key from the upper right, deep blue fill, stars, teal runes rule
// One shadow-casting DirectionalLight plays both sun and moon (its colour, strength and direction
// are scheduled) so hand shadows never drop out; a second, cheaper light adds the moon's fill.
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';

// ---------------------------------------------------------------------------------------------
// Shared helpers

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// Piecewise-linear schedule through [t, value] stops (sorted by t). Numbers only.
export function sched(t, stops) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, v0] = stops[i - 1], [t1, v1] = stops[i];
      return lerp(v0, v1, (t - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}
// Same for colours: stops are [t, THREE.Color]; the result lands in `out`.
export function schedColor(out, t, stops) {
  if (t <= stops[0][0]) return out.copy(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      return out.lerpColors(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(stops[stops.length - 1][1]);
}
const col = (hex) => new THREE.Color(hex);

// mulberry32: tiny seeded PRNG, so the cliff, the clouds and the stars are the same on every load.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Asset paths resolve relative to this module, so the game works from any page location.
const ASSETS = new URL('../assets/', import.meta.url);
export const assetUrl = (rel) => new URL(rel, ASSETS).href;

export function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

export function canvasTexture(canvas, { srgb = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

// Soft round particle: white with a gaussian-ish alpha fall-off.
export function makeSoftCircleTexture(size = 64, hardness = 0.12) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(hardness, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.32)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvasTexture(c);
}

// GPU point sprites with per-particle seed + alpha. Size is in world metres at the particle, so
// motes near the lens are bigger and embers far away shrink like anything else in the scene.
export function createParticles({ count, texture, color = 0xffffff, size = 0.03, opacity = 1, additive = true, maxPx = 40 }) {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const alphas = new Float32Array(count);
  for (let i = 0; i < count; i++) { seeds[i] = Math.random(); alphas[i] = 1; }

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1); alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aAlpha', alphaAttr);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uColor: { value: new THREE.Color(color) },
      uSize: { value: size },
      uOpacity: { value: opacity },
      uTime: { value: 0 },
      uHeightPx: { value: 1000 },
      uMaxPx: { value: maxPx },
    },
    vertexShader: /* glsl */`
      attribute float aSeed;
      attribute float aAlpha;
      uniform float uTime, uSize, uHeightPx, uMaxPx;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float twinkle = 0.65 + 0.35 * sin(uTime * (1.2 + 2.3 * aSeed) + aSeed * 61.0);
        vAlpha = aAlpha * twinkle;
        float px = uSize * (0.55 + 0.9 * aSeed) * projectionMatrix[1][1] * uHeightPx * 0.5 / max(0.05, -mv.z);
        gl_PointSize = clamp(px, 1.0, uMaxPx);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        vec4 t = texture2D(uMap, gl_PointCoord);
        float a = t.a * vAlpha * uOpacity;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * t.rgb, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return {
    points, geometry, material, positions, seeds, alphas, count,
    posAttr, alphaAttr,
    setHeightPx(h) { material.uniforms.uHeightPx.value = h; },
    setTime(t) { material.uniforms.uTime.value = t; },
    setColor(c) { material.uniforms.uColor.value.copy(c); },
    setOpacity(o) { material.uniforms.uOpacity.value = o; },
    commit() { posAttr.needsUpdate = true; alphaAttr.needsUpdate = true; },
  };
}

// ---------------------------------------------------------------------------------------------
// The schedule (CONTRACTS palette: sky dusk #5b3d6e → night #0a0c18, accent #7fe0ff)

const KEY_COLOR = [
  [0.00, col(0xffb572)],   // golden hour
  [0.30, col(0xffab74)],   // amber as the sun drops (was a heavy orange that flooded the rock)
  [0.50, col(0xe8977a)],   // last light: desaturated so the red rock does not double up
  [0.68, col(0x8b9bd0)],   // moon takes over
  [1.00, col(0xb4c4ff)],
];
const KEY_INTENSITY = [[0, 4.6], [0.3, 3.6], [0.5, 2.3], [0.66, 1.3], [0.82, 2.0], [1, 2.8]];
const HEMI_SKY = [[0, col(0x9a9ec8)], [0.5, col(0x7d84c0)], [0.72, col(0x36497e)], [1, col(0x22304f)]];
const HEMI_GROUND = [[0, col(0x6a4432)], [0.5, col(0x4a3230)], [1, col(0x0c0b12)]];
const HEMI_INTENSITY = [[0, 0.60], [0.5, 1.05], [0.7, 0.72], [1, 0.6]];
const MOON_FILL_INTENSITY = [[0.45, 0], [0.75, 0.4], [1, 0.7]];
const EXPOSURE = [[0, 1.02], [0.5, 0.95], [1, 0.8]];
const BACKGROUND = [[0, 1.0], [0.5, 0.5], [0.8, 0.12], [1, 0.05]];
const ENVIRONMENT = [[0, 0.42], [0.5, 0.36], [1, 0.16]];
const FOG_COLOR = [[0, col(0xc9a5ac)], [0.5, col(0x735c86)], [0.8, col(0x1a2038)], [1, col(0x0e1222)]];
const FOG_DENSITY = [[0, 0.011], [1, 0.016]];
const CLOUD_COLOR = [[0, col(0xe2b1bc)], [0.5, col(0x8d6f9a)], [1, col(0x1e2438)]];
const MOTE_COLOR = [[0, col(0xffd9a6)], [0.5, col(0xe7b8c8)], [1, col(0xa8bcff)]];
const STAR_ALPHA = [[0.45, 0], [0.9, 1]];

// Light directions (unit vectors *toward* the light). The sun sits low and front-left at a grazing
// angle to the wall — that is what makes the normal map and the ledges read as relief and throws
// the hands' shadows down-right onto the rock. The moon rises from the opposite side, also low.
const SUN_DIR = new THREE.Vector3(-0.80, 0.34, 0.40).normalize();
const MOON_DIR = new THREE.Vector3(0.62, 0.48, 0.44).normalize();
const MOON_FILL_DIR = new THREE.Vector3(0.75, 0.5, 0.42).normalize();

const SKY_RADIUS = 300;      // stars / mountains are scaled down if the camera's far plane is closer

// ---------------------------------------------------------------------------------------------

export async function createEnvironment({ renderer, scene, tier, seed = 7 }) {
  const rnd = mulberry32(seed * 31 + 5);
  const noise = new SimplexNoise({ random: mulberry32(seed + 99) });
  const softTex = makeSoftCircleTexture(64);
  let currentTier = tier || { name: 'desktop', shadowMapSize: 2048 };
  let t = 0;

  // --- lights ------------------------------------------------------------------------------
  const key = new THREE.DirectionalLight(KEY_COLOR[0][1], KEY_INTENSITY[0][1]);
  key.castShadow = true;
  key.shadow.mapSize.set(currentTier.shadowMapSize || 2048, currentTier.shadowMapSize || 2048);
  const sc = key.shadow.camera;
  sc.left = -3.2; sc.right = 3.2; sc.top = 3.2; sc.bottom = -3.2; sc.near = 8; sc.far = 48;
  key.shadow.normalBias = 0.02;
  key.shadow.bias = -0.0002;
  key.shadow.radius = 3;
  scene.add(key, key.target);

  const moon = new THREE.DirectionalLight(0x8fa8ff, 0);
  scene.add(moon, moon.target);

  const hemi = new THREE.HemisphereLight(HEMI_SKY[0][1], HEMI_GROUND[0][1], HEMI_INTENSITY[0][1]);
  scene.add(hemi);

  // --- fog ---------------------------------------------------------------------------------
  const fog = new THREE.FogExp2(FOG_COLOR[0][1].getHex(), FOG_DENSITY[0][1]);
  scene.fog = fog;

  // --- sky (HDRI) --------------------------------------------------------------------------
  const sky = await loadSky(renderer, scene, currentTier);

  // --- far scenery: mountains + valley floor ------------------------------------------------
  const farGroup = new THREE.Group();
  const mountainRings = [
    createMountainRing(noise, { radius: 140, base: -60, hMin: 40, hAmp: 62, freq: 1.3, color: col(0x1b1626), seed: 3, haze: [0.9, 0.7, 0.5] }),
    createMountainRing(noise, { radius: 220, base: -80, hMin: 70, hAmp: 95, freq: 0.9, color: col(0x272238), seed: 11, haze: [0.96, 0.86, 0.72] }),
    createMountainRing(noise, { radius: 290, base: -90, hMin: 110, hAmp: 120, freq: 0.6, color: col(0x332c48), seed: 23, haze: [0.98, 0.93, 0.86] }),
  ];
  for (const m of mountainRings) farGroup.add(m);
  const floorMat = new THREE.MeshBasicMaterial({ color: FOG_COLOR[0][1], fog: false });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(600, 48), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -48;
  farGroup.add(floor);
  scene.add(farGroup);

  // --- stars -------------------------------------------------------------------------------
  const stars = createStars(rnd, softTex, 1400);
  scene.add(stars);

  // --- clouds ------------------------------------------------------------------------------
  const cloudTex = makeCloudTexture(rnd);
  const cloudMat = new THREE.SpriteMaterial({ map: cloudTex, color: CLOUD_COLOR[0][1], transparent: true, opacity: 0.62, depthWrite: false, fog: true });
  const clouds = [];
  const cloudGroup = new THREE.Group();
  for (let i = 0; i < 26; i++) {
    const s = new THREE.Sprite(cloudMat);
    let w;
    if (i < 9) {           // valley: a soft sea of cloud far below the start
      w = 26 + rnd() * 34;
      s.position.set(-70 + rnd() * 140, -38 + rnd() * 30, -15 + rnd() * 85);
    } else if (i < 14) {   // shoulders: wisps drifting past the cliff's flanks at climbing height
      w = 22 + rnd() * 26;
      const side = i % 2 ? 1 : -1;
      s.position.set(side * (20 + rnd() * 25), 6 + rnd() * 26, -5 + rnd() * 30);
    } else {               // base layer: dense cloud hugging the cliff just under the start holds
      w = 10 + rnd() * 16;
      s.position.set(-22 + rnd() * 44, -9 + rnd() * 7, 1 + rnd() * 22);
    }
    s.scale.set(w, w * 0.42, 1);
    s.userData.speed = 0.12 + rnd() * 0.28;
    clouds.push(s);
    cloudGroup.add(s);
  }
  scene.add(cloudGroup);

  // --- dust motes --------------------------------------------------------------------------
  const MOTES = 400;
  const motes = createParticles({ count: MOTES, texture: softTex, color: MOTE_COLOR[0][1].getHex(), size: 0.016, opacity: 0.7, maxPx: 26 });
  const moteVel = new Float32Array(MOTES * 3);
  const MOTE_BOX = new THREE.Vector3(2.4, 2.2, 0.6);   // half extents, centred between lens and wall
  const moteCenter = new THREE.Vector3();
  let motesSeeded = false;
  for (let i = 0; i < MOTES; i++) {
    moteVel[i * 3] = (rnd() - 0.5) * 0.08;
    moteVel[i * 3 + 1] = 0.01 + rnd() * 0.05;
    moteVel[i * 3 + 2] = (rnd() - 0.5) * 0.04;
  }
  scene.add(motes.points);

  // --- scratch -----------------------------------------------------------------------------
  const _target = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _size = new THREE.Vector2();
  const _col = new THREE.Color();
  let lastFar = -1;

  // ---------------------------------------------------------------------------------------
  function update(dt, night, camera, body, wallZ) {
    dt = Math.min(0.1, Math.max(0, dt || 0));
    t += dt;
    const n = clamp01(night || 0);
    const bx = body ? body.x : 0, by = body ? body.y : 2;
    const bz = wallZ ? wallZ(bx, by) : 0;

    // Exposure and sky: the HDRI dims to a last-light band at the horizon; the environment keeps a
    // whisper of ambient so night rock is moon-grey, not black.
    renderer.toneMappingExposure = sched(n, EXPOSURE);
    scene.backgroundIntensity = sched(n, BACKGROUND);
    scene.environmentIntensity = sched(n, ENVIRONMENT);

    // Fog + everything tinted by it
    schedColor(fog.color, n, FOG_COLOR);
    fog.density = sched(n, FOG_DENSITY);
    floorMat.color.copy(fog.color).lerp(cloudMat.color, 0.4);
    for (const m of mountainRings) tintMountainRing(m, fog.color, _col);

    // Key light: sun → afterglow → moon, one shadow caster. The direction swings from the sun's
    // side to the moon's between 0.45 and 0.85 so the shadows slowly migrate with height.
    const m = smoothstep(0.45, 0.85, n);
    _dir.lerpVectors(SUN_DIR, MOON_DIR, m).normalize();
    schedColor(key.color, n, KEY_COLOR);
    key.intensity = sched(n, KEY_INTENSITY);
    _target.set(bx, by, bz);
    key.target.position.copy(_target);
    key.position.copy(_target).addScaledVector(_dir, 25);
    key.target.updateMatrixWorld();

    moon.intensity = sched(n, MOON_FILL_INTENSITY);
    moon.target.position.copy(_target);
    moon.position.copy(_target).addScaledVector(MOON_FILL_DIR, 20);
    moon.target.updateMatrixWorld();

    schedColor(hemi.color, n, HEMI_SKY);
    schedColor(hemi.groundColor, n, HEMI_GROUND);
    hemi.intensity = sched(n, HEMI_INTENSITY);

    // Far scenery scales to the camera's far plane so nothing is ever clipped away.
    if (camera && camera.far !== lastFar) {
      lastFar = camera.far;
      const s = Math.min(1, (camera.far * 0.92) / SKY_RADIUS);
      farGroup.scale.setScalar(s);
      stars.scale.setScalar(SKY_RADIUS * s);
    }
    if (camera) stars.position.copy(camera.position);
    stars.material.opacity = sched(n, STAR_ALPHA);

    // Clouds drift and dim
    schedColor(cloudMat.color, n, CLOUD_COLOR);
    cloudMat.opacity = lerp(0.55, 0.42, n);
    for (let i = 0; i < clouds.length; i++) {
      const s = clouds[i];
      s.position.x += s.userData.speed * dt;
      if (s.position.x > 85) s.position.x -= 170;
      if (i >= 14 && s.position.x > 30) s.position.x -= 60;
    }

    // Dust motes: drift, swirl, wrap around a box parked between the lens and the rock.
    if (camera) {
      renderer.getDrawingBufferSize(_size);
      motes.setHeightPx(_size.y);
      motes.setTime(t);
      schedColor(_col, n, MOTE_COLOR);
      motes.setColor(_col);
      motes.setOpacity(lerp(0.75, 0.5, n));
      moteCenter.set(camera.position.x, camera.position.y + 0.4, camera.position.z - 0.45);
      const p = motes.positions;
      if (!motesSeeded) {
        motesSeeded = true;
        for (let i = 0; i < MOTES; i++) {
          p[i * 3] = moteCenter.x + (rnd() * 2 - 1) * MOTE_BOX.x;
          p[i * 3 + 1] = moteCenter.y + (rnd() * 2 - 1) * MOTE_BOX.y;
          p[i * 3 + 2] = moteCenter.z + (rnd() * 2 - 1) * MOTE_BOX.z;
        }
      }
      for (let i = 0; i < MOTES; i++) {
        const k = i * 3, s = motes.seeds[i];
        p[k] += (moteVel[k] + Math.sin(t * 0.7 + s * 12.0) * 0.03) * dt;
        p[k + 1] += (moteVel[k + 1] + Math.cos(t * 0.5 + s * 9.0) * 0.02) * dt;
        p[k + 2] += moteVel[k + 2] * dt;
        // wrap each axis around the box
        let d = p[k] - moteCenter.x; if (d > MOTE_BOX.x) p[k] -= 2 * MOTE_BOX.x; else if (d < -MOTE_BOX.x) p[k] += 2 * MOTE_BOX.x;
        d = p[k + 1] - moteCenter.y; if (d > MOTE_BOX.y) p[k + 1] -= 2 * MOTE_BOX.y; else if (d < -MOTE_BOX.y) p[k + 1] += 2 * MOTE_BOX.y;
        d = p[k + 2] - moteCenter.z; if (d > MOTE_BOX.z) p[k + 2] -= 2 * MOTE_BOX.z; else if (d < -MOTE_BOX.z) p[k + 2] += 2 * MOTE_BOX.z;
      }
      motes.posAttr.needsUpdate = true;
    }
  }

  function setTier(tierNext) {
    currentTier = tierNext || currentTier;
    const s = currentTier.shadowMapSize || 2048;
    if (key.shadow.mapSize.x !== s) {
      key.shadow.mapSize.set(s, s);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
  }

  return {
    update, setTier,
    key, moon, hemi, fog, stars, clouds, motes, farGroup, sky,
    sunDir: SUN_DIR, moonDir: MOON_DIR,
    softTex,
    get time() { return t; },
  };
}

// ---------------------------------------------------------------------------------------------
// HDRI sky: background + PMREM environment, rotated so the HDRI's own sun sits where our
// directional light comes from. The sun texel is found by scanning the equirect; the HDR is also
// clamped so the disc becomes a glare spot that can fade out at night instead of a white hole.

async function loadSky(renderer, scene, tier) {
  const url = assetUrl('hdri/kloppenheim_06_puresky_2k.hdr');
  let hdr;
  try {
    hdr = await new HDRLoader().loadAsync(url);
  } catch (err) {
    console.warn('[env] HDRI failed to load, falling back to a flat sky', err);
    scene.background = new THREE.Color(0x5b3d6e);
    return { ok: false };
  }
  hdr.mapping = THREE.EquirectangularReflectionMapping;

  const { width: w, height: h, data } = hdr.image;
  const isHalf = data instanceof Uint16Array;
  const rd = isHalf ? (v) => THREE.DataUtils.fromHalfFloat(v) : (v) => v;
  const wr = isHalf ? (v) => THREE.DataUtils.toHalfFloat(v) : (v) => v;
  const CAP = 16;               // radiance ceiling: keeps clouds' range, tames the sun disc
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y < h; y++) {
    // dusk grade per row: elevation 0 → warm amber, zenith → violet
    const el = (0.5 - (y + 0.5) / h) * 2;                 // -1 (nadir) .. 1 (zenith)
    const t = smoothstep(0, 0.75, Math.max(0, el));
    const tr = lerp(1.24, 0.60, t), tg = lerp(0.84, 0.54, t), tb = lerp(0.66, 1.0, t);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = rd(data[i]) * tr, g = rd(data[i + 1]) * tg, b = rd(data[i + 2]) * tb;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum > best) { best = lum; bx = x; by = y; }
      if (lum > CAP) { const s = CAP / lum; r *= s; g *= s; b *= s; }
      data[i] = wr(r); data[i + 1] = wr(g); data[i + 2] = wr(b);
    }
  }
  hdr.needsUpdate = true;

  // flipY = true → buffer row 0 is the zenith. three samples equirects with
  // u = atan(dir.z, dir.x)/2π + 0.5, v = asin(dir.y)/π + 0.5.
  const u = (bx + 0.5) / w;
  const v = 1 - (by + 0.5) / h;
  const texAz = (u - 0.5) * Math.PI * 2;
  const texEl = (v - 0.5) * Math.PI;
  const wantAz = Math.atan2(SUN_DIR.z, SUN_DIR.x);
  const rotY = texAz - wantAz;
  scene.backgroundRotation.set(0, rotY, 0);
  scene.environmentRotation.set(0, rotY, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromEquirectangular(hdr);
  pmrem.dispose();

  scene.environment = envRT.texture;
  scene.background = hdr;
  scene.backgroundIntensity = 1;
  scene.environmentIntensity = 1;
  scene.backgroundBlurriness = 0;

  return { ok: true, texture: hdr, envRT, sun: { azimuth: texAz, elevation: texEl, luminance: best }, rotationY: rotY };
}

// ---------------------------------------------------------------------------------------------
// Distant mountains: a ring whose top edge is a rolling skyline built from two smooth noise
// octaves (no abs() folds, so no paper-cut spikes). Vertex colours grade lighter toward the base
// so the fog reads as pooling in the valleys.

function createMountainRing(noise, { radius, base, hMin, hAmp, freq, color, seed, haze }) {
  const N = 512;
  const rows = 3;
  const positions = new Float32Array((N + 1) * rows * 3);
  const colors = new Float32Array((N + 1) * rows * 3);
  const index = [];
  const light = color.clone().lerp(new THREE.Color(0x6a5a7a), 0.45);
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const r = radius * (1 + 0.10 * noise.noise(ca * 1.7 + seed, sa * 1.7 - seed));
    const broad = 0.5 + 0.5 * noise.noise(ca * freq + seed * 3, sa * freq + 7);
    const medium = 0.5 + 0.5 * noise.noise(ca * freq * 2.6 + seed, sa * freq * 2.6 + 1);
    const fine = 0.5 + 0.5 * noise.noise(ca * freq * 6.5 + 2, sa * freq * 6.5 + seed);
    const top = base + hMin + hAmp * (0.6 * broad + 0.3 * medium + 0.1 * fine);
    const ys = [base - 30, base + (top - base) * 0.45, top];
    for (let j = 0; j < rows; j++) {
      const k = (i * rows + j) * 3;
      positions[k] = ca * r; positions[k + 1] = ys[j]; positions[k + 2] = sa * r;
      const c = j === 0 ? light : j === 1 ? color.clone().lerp(light, 0.35) : color;
      colors[k] = c.r; colors[k + 1] = c.g; colors[k + 2] = c.b;
    }
    if (i < N) {
      for (let j = 0; j < rows - 1; j++) {
        const a0 = i * rows + j, a1 = a0 + 1, b0 = (i + 1) * rows + j, b1 = b0 + 1;
        index.push(a0, b0, a1, a1, b0, b1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(index);
  g.attributes.color.setUsage(THREE.DynamicDrawUsage);
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.userData = { base: color.clone(), haze, rows, N, lastFog: new THREE.Color(-1, -1, -1) };
  return mesh;
}

// Distant ridges sit in their own haze: base colour pulled toward the current fog colour, more so
// toward the valley floor, so the fog reads as pooling below the peaks at every time of day.
// Only rewritten when the fog colour actually changed (it is constant while the body rests).
function tintMountainRing(mesh, fogColor, scratch) {
  const { base, haze, rows, N, lastFog } = mesh.userData;
  if (Math.abs(lastFog.r - fogColor.r) + Math.abs(lastFog.g - fogColor.g) + Math.abs(lastFog.b - fogColor.b) < 0.002) return;
  lastFog.copy(fogColor);
  const arr = mesh.geometry.attributes.color.array;
  for (let j = 0; j < rows; j++) {
    scratch.copy(base).lerp(fogColor, haze[j]);
    for (let i = 0; i <= N; i++) {
      const k = (i * rows + j) * 3;
      arr[k] = scratch.r; arr[k + 1] = scratch.g; arr[k + 2] = scratch.b;
    }
  }
  mesh.geometry.attributes.color.needsUpdate = true;
}

function createStars(rnd, tex, count) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // uniform on the sphere, then keep the upper hemisphere plus a little below the horizon
    let x, y, z;
    do {
      const u = rnd() * 2 - 1, phi = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      x = s * Math.cos(phi); y = u; z = s * Math.sin(phi);
    } while (y < -0.05);
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    const b = 0.35 + rnd() * rnd() * 1.1;                 // few bright, many faint
    const warm = rnd();
    c.setRGB(b * (0.85 + warm * 0.25), b * (0.9 + warm * 0.1), b * (1.0 - warm * 0.2));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({
    size: 3.2, sizeAttenuation: false, vertexColors: true, map: tex,
    transparent: true, opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = -1;
  return p;
}

function makeCloudTexture(rnd) {
  const size = 256;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 20; i++) {
    const x = 128 + (rnd() - 0.5) * 160, y = 140 + (rnd() - 0.5) * 70, r = 28 + rnd() * 58;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.30)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  // fade the borders so a sprite edge is never visible
  const mask = ctx.createRadialGradient(128, 128, 50, 128, 128, 128);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.7, 'rgba(0,0,0,0.6)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
  return canvasTexture(c);
}
