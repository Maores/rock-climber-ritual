// The cliff and everything bolted to it: displaced PBR wall (wallZ is the single source of truth
// for depth), edge-shaped holds cut from the same red stone with chalk on their lips, rune holds
// with carved sigils, point lights and embers, faint glyph waymarks along the route that wake up
// as runes are lit, the summit ledge + altar + great circle, the rope from harness to anchor, and
// hover rings for the hands. Lighting, sky, fog and particles live in env.js; this module owns the
// solid things and drives the per-frame state (glow, rope, rings) from the shared `state`.
import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  createEnvironment, createParticles, makeCanvas, canvasTexture,
  mulberry32, lerp, clamp01, smoothstep, assetUrl,
} from './env.js';

const RUNE = new THREE.Color(0x7fe0ff);
const WALL = { width: 13, height: 51.5, segX: 104, segY: 515, yCenter: 17.75, flank: 4.5, tile: 3.0, maxZ: 0.35 };   // y ∈ [-8, 43.5]
// Holds are squashed toward the wall (zScale), sit almost flush in it (sink) and have a flat front
// face at `front` × zScale where the fingers grip — holdZ() is exact, not an estimate.
const HOLD = { zScale: 0.42, sink: 0.05, front: 0.925 };
const ROPE = { radius: 0.011, segments: 44, radial: 6, stripe: 0.22 };
const RUNE_LIGHTS = 2;                              // shared point lights re-parked on the nearest runes
const WAYMARK_EVERY = 2.6;                          // metres between glyph waymarks along the route
// The boulder set is beige; this multiplier lands it on the wall's own red stone. Vertex colours
// multiply in linear light, so the ratio is taken between linearised averages (wall 131/105/80,
// boulder 168/155/140 in sRGB).
const HOLD_TINT = [0.58, 0.43, 0.31];

export async function createWorld({ renderer, scene, route, tier }) {
  const seed = (route && route.seed) || 7;
  const holds = (route && route.holds) || [];
  const fakes = (route && route.fakes) || [];
  // Off for this build: the rock should be read, not labelled. The waymark glyphs went with
  // the ring — scattered teal marks beside the route read as a UI overlay painted on the stone.
  const HOVER_CUE = false;
  const WAYMARKS = false;
  const rnd = mulberry32(seed * 7919 + 13);
  const noise = new SimplexNoise({ random: mulberry32(seed) });
  const summit = holds.find((h) => h.kind === 'summit') || null;
  const runeHolds = holds.filter((h) => h.kind === 'rune');
  let currentTier = tier || { name: 'desktop', shadowMapSize: 2048 };

  // ---------------------------------------------------------------------------------------
  // wallZ — deterministic relief shared by geometry, hands and camera. Three noise octaves for
  // bulges/boulders/grit, horizontal ledges where stretched noise crests, thin cracks along the
  // zero-crossings of tall noise, all clamped to ±0.35. The summit shelf blends toward the max
  // protrusion so the altar has a lip to stand on, and beyond the 9 m cliff the face rolls back
  // so the edges read as a rounded pillar instead of a paper cut-out.
  function shelfMask(x, y) {
    if (!summit) return 0;
    const dx = Math.abs(x - summit.x);
    if (dx > 1.6) return 0;
    const wobble = noise.noise(x * 1.3 + 900, y * 1.3 - 40);
    const ex = 1 - smoothstep(0.3, 1.5, dx + wobble * 0.18);
    const ey = smoothstep(summit.y - 0.55 + wobble * 0.1, summit.y - 0.12, y) * (1 - smoothstep(summit.y + 0.05, summit.y + 0.42, y));
    return ex * ey;
  }
  // where the flat face ends and the pillar starts rolling back, wandering with height
  function flankAt(y) { return WALL.flank + 0.5 * noise.noise(y * 0.12 + 800, 3.3); }
  function wallZ(x, y) {
    let z = 0.17 * noise.noise(x * 0.23 + 11, y * 0.23 - 3)
          + 0.085 * noise.noise(x * 0.62 + 90, y * 0.62 + 40)
          + 0.035 * noise.noise(x * 1.9 + 7, y * 1.9 + 5);
    const edge = 1 - smoothstep(4.0, 5.6, Math.abs(x));
    const ledgeAmp = 0.15 * (0.45 + 0.55 * smoothstep(-0.2, 0.5, noise.noise(x * 0.09 + 640, y * 0.09 + 320)));
    z += ledgeAmp * edge * smoothstep(0.42, 0.72, noise.noise(x * 0.35 + 200, y * 1.7 + 60));
    z -= 0.09 * edge * (1 - smoothstep(0, 0.08, Math.abs(noise.noise(x * 0.9 + 300, y * 0.28 + 20))));
    if (z > WALL.maxZ) z = WALL.maxZ; else if (z < -WALL.maxZ) z = -WALL.maxZ;
    const s = shelfMask(x, y);
    if (s > 0) z += (WALL.maxZ - z) * s;
    const ax = Math.abs(x) - flankAt(y);
    if (ax > 0) z -= 0.9 * ax * ax + 0.3 * ax * (0.5 + 0.5 * noise.noise(y * 0.35 + 700, Math.abs(x) * 0.4));
    return z;
  }
  // Front face of a hold — where a gripping palm sits.
  function holdZ(hold) {
    return wallZ(hold.x, hold.y) + hold.size * (HOLD.sink + HOLD.zScale * HOLD.front);
  }

  // ---------------------------------------------------------------------------------------
  // Assets + environment, loaded in parallel.
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const loader = new THREE.TextureLoader();
  const loadTex = (rel, srgb) => loader.loadAsync(assetUrl(rel)).then((t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(8, maxAniso);
    return t;
  }).catch((err) => { console.warn('[world] texture failed', rel, err); return null; });

  const [wDiff, wNor, wRough, wAO, bDiff, bNor, bRough, bAO, env] = await Promise.all([
    loadTex('textures/rock_face_03/Diffuse_2k.jpg', true),
    loadTex('textures/rock_face_03/nor_gl_2k.jpg', false),
    loadTex('textures/rock_face_03/Rough_1k.jpg', false),
    loadTex('textures/rock_face_03/AO_1k.jpg', false),
    loadTex('textures/rock_boulder_dry/Diffuse_1k.jpg', true),
    loadTex('textures/rock_boulder_dry/nor_gl_1k.jpg', false),
    loadTex('textures/rock_boulder_dry/Rough_1k.jpg', false),
    loadTex('textures/rock_boulder_dry/AO_1k.jpg', false),
    createEnvironment({ renderer, scene, tier: currentTier, seed }),
  ]);
  if (wAO) wAO.channel = 1;
  if (bAO) bAO.channel = 1;

  // arc length along the parabolic flank z = -0.9 s²
  function arcLen(s) { const k = 1.8; return 0.5 * (s * Math.sqrt(1 + k * k * s * s) + Math.asinh(k * s) / k); }

  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);

  // ---------------------------------------------------------------------------------------
  // Wall
  const wallGeo = new THREE.PlaneGeometry(WALL.width, WALL.height, WALL.segX, WALL.segY);
  wallGeo.translate(0, WALL.yCenter, 0);
  {
    const pos = wallGeo.attributes.position;
    const uv = wallGeo.attributes.uv;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const z = wallZ(x, y);
      pos.setZ(i, z);
      const fl = flankAt(y), ax = Math.abs(x) - fl;
      const u = ax > 0 ? Math.sign(x) * (fl + arcLen(ax)) : x;
      uv.setXY(i, u / WALL.tile, y / WALL.tile);
      // Large-scale tint: dark water streaks running down, warm iron patches, faint sedimentary
      // strata, shadowed recesses.
      const streak = noise.noise(x * 1.1 + 500, y * 0.09 + 10);
      const dark = 0.42 * smoothstep(0.30, 0.75, streak);
      const warm = 0.65 * smoothstep(0.25, 0.7, noise.noise(x * 0.19 + 700, y * 0.19 + 70));
      const strata = 0.5 + 0.5 * Math.sin(y * 1.9 + 1.6 * noise.noise(x * 0.15 + 30, y * 0.05 + 9));
      const crev = 0.7 + 0.3 * smoothstep(-0.30, 0.12, z);
      let r = 0.98, g = 0.95, b = 0.92;
      r = lerp(r, r * 1.1, warm); g = lerp(g, g * 0.92, warm); b = lerp(b, b * 0.8, warm);
      const k = (1 - dark) * crev * (1 - 0.08 * strata);
      col[i * 3] = r * k; col[i * 3 + 1] = g * k; col[i * 3 + 2] = b * k;
    }
    wallGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    wallGeo.setAttribute('uv1', new THREE.BufferAttribute(uv.array.slice(), 2));
    wallGeo.computeVertexNormals();
    wallGeo.computeBoundingSphere();
  }
  const wallMat = new THREE.MeshStandardMaterial({
    map: wDiff, normalMap: wNor, normalScale: new THREE.Vector2(1.45, 1.45),
    roughnessMap: wRough, roughness: 1.0, aoMap: wAO, aoMapIntensity: 1.0,
    metalness: 0.0, vertexColors: true,
  });
  const wall = new THREE.Mesh(wallGeo, wallMat);
  wall.name = 'wall';
  wall.castShadow = true;
  wall.receiveShadow = true;
  wall.matrixAutoUpdate = false;
  root.add(wall);

  // ---------------------------------------------------------------------------------------
  // Holds: noise-deformed icosahedron blobs shaped like edges — wider than tall, a flat-ish top
  // lip, a flat front face, a rounder undercut belly — tinted to the wall's stone, darkened where
  // they meet the rock and dusted with chalk along the lip.
  const holdMat = new THREE.MeshStandardMaterial({
    map: bDiff, normalMap: bNor, normalScale: new THREE.Vector2(1.1, 1.1),
    roughnessMap: bRough, roughness: 1.0, aoMap: bAO, metalness: 0.0, vertexColors: true,
  });

  const footprint = new Map();   // hold id → { sx, sy, rot } of its blob, for the contact shadow on the wall
  function holdBlob(hold) {
    let g = new THREE.IcosahedronGeometry(1, hold.size < 0.15 ? 4 : 5);
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g = mergeVertices(g, 1e-4);
    const p = g.attributes.position;
    const n = p.count;
    const uv = new Float32Array(n * 2);
    const col = new Float32Array(n * 3);
    const s = hold.id * 3.17 + 0.5;
    const shade = 0.82 + rnd() * 0.2;
    const tr = HOLD_TINT[0] * shade * (0.96 + rnd() * 0.08);
    const tg = HOLD_TINT[1] * shade * (0.96 + rnd() * 0.08);
    const tb = HOLD_TINT[2] * shade * (0.96 + rnd() * 0.08);
    const sx = 1.15 + rnd() * 0.4;          // edges are wider than tall
    const sy = 0.62 + rnd() * 0.28;
    const chalkAmt = 0.35 + rnd() * 0.5;    // some holds are well used, some barely
    for (let i = 0; i < n; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const ny = y, nz = z;                 // unit-sphere direction, before deformation
      const n1 = noise.noise3d(x * 0.9 + s, y * 0.9, z * 0.9 + s * 0.5);
      const n2 = noise.noise3d(x * 2.4 + 41, y * 2.4 + s, z * 2.4);
      const r = 1 + 0.22 * n1 + 0.07 * n2;
      x *= r; y *= r; z *= r;
      if (y > 0) y *= 0.72;                                 // flat top lip
      if (z > 0.78) z = 0.78 + (z - 0.78) * 0.25;           // flat front face (fingers grip here)
      const len = Math.hypot(x, y, z) || 1;
      // chalk: patchy along the top lip, a little on the front where fingers smear it
      const patch = smoothstep(0.05, 0.55, noise.noise3d(x * 3.1 + s, y * 3.1 + 7, z * 3.1));
      const lip = smoothstep(0.55, 0.95, ny) * (0.3 + 0.7 * patch);
      const front = 0.15 * smoothstep(0.75, 1.0, nz) * patch;
      const chalk = clamp01((lip + front) * chalkAmt);
      // contact: darker toward the wall plane so the hold reads as growing out of the rock
      const seat = 1 - 0.45 * (1 - smoothstep(-0.1, 0.45, nz));
      // chalk is white powder: the map's mid-grey has to be pushed well past 1 to read as white
      col[i * 3] = lerp(tr * seat, 1.9, chalk);
      col[i * 3 + 1] = lerp(tg * seat, 1.88, chalk);
      col[i * 3 + 2] = lerp(tb * seat, 1.85, chalk);
      // spherical uv with the seam at the back (inside the wall)
      uv[i * 2] = (Math.atan2(x, z) / (Math.PI * 2) + 0.5) * 2;
      uv[i * 2 + 1] = Math.asin(Math.max(-1, Math.min(1, y / len))) / Math.PI + 0.5;
      p.setXYZ(i, x * sx, y * sy, z * HOLD.zScale);
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    // keep the long axis roughly horizontal: ±20° of lean, not a random spin
    const rot = (((hold.angle || 0) % (Math.PI / 2)) - Math.PI / 4) * 0.45;
    footprint.set(hold.id, { sx, sy, rot });
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(hold.x, hold.y, wallZ(hold.x, hold.y) + hold.size * HOLD.sink),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, rot)),
      new THREE.Vector3(hold.size, hold.size, hold.size),
    );
    g.applyMatrix4(m);
    return g;
  }

  // A small grid that hugs the wall relief — used for chalk splats, sigils and waymarks so flat
  // decals never sink into a bump or float over a crack.
  function conformedPatch(cx, cy, size, seg, rotation, lift, aspect = 1) {
    const g = new THREE.PlaneGeometry(size * aspect, size, seg, seg);
    if (rotation) g.rotateZ(rotation);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const wx = cx + p.getX(i), wy = cy + p.getY(i);
      p.setXYZ(i, wx, wy, wallZ(wx, wy) + lift);
    }
    g.computeVertexNormals();
    return g;
  }

  const chalkTex = makeChalkTexture(rnd);
  const skirtTex = makeSkirtTexture();
  const plainGeos = [], chalkGeos = [], skirtGeos = [];
  const runes = [];            // { hold, blob, mat, sigilMat, k, flash, wasLit, pos }
  for (const hold of holds) {
    if (hold.kind === 'rune' || hold.kind === 'summit') {
      const mat = holdMat.clone();
      mat.emissive = RUNE.clone();
      mat.emissiveMap = makeGlyphTexture(rnd);
      mat.emissiveIntensity = 0.3;
      const blob = new THREE.Mesh(holdBlob(hold), mat);
      blob.castShadow = true; blob.receiveShadow = true;
      root.add(blob);
      // sigil carved around the hold
      const sz = Math.max(0.46, hold.size * 2.6);   // ~0.55 m: reads as a carving, not a portal
      const sigilMat = new THREE.MeshBasicMaterial({
        map: makeSigilTexture(rnd, 512, { rings: 2, ticks: 16, strokes: 7 }), color: RUNE.clone(),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      const sigil = new THREE.Mesh(conformedPatch(hold.x, hold.y, sz, 12, rnd() * Math.PI * 2, 0.015), sigilMat);
      sigil.renderOrder = 2;
      root.add(sigil);
      runes.push({ hold, blob, mat, sigilMat, k: 0.2, flash: 0, wasLit: !!hold.lit, pos: new THREE.Vector3(hold.x, hold.y, holdZ(hold)) });
    } else {
      plainGeos.push(holdBlob(hold));
    }
    // chalk splat on the wall around the hold, biased upward where the hand comes from
    chalkGeos.push(conformedPatch(hold.x, hold.y + hold.size * 0.15, hold.size * 2.3, 5, (rnd() - 0.5) * 0.8, 0.012));
    // contact shadow: a dark ellipse under the blob's footprint, so the hold grows out of the rock
    const fp = footprint.get(hold.id) || { sx: 1.3, sy: 0.75, rot: 0 };
    skirtGeos.push(conformedPatch(hold.x, hold.y - hold.size * 0.12, hold.size * 2.4 * fp.sy, 4, fp.rot, 0.008, fp.sx / fp.sy));
  }
  // --- decoys: the same rock, but each one is its own mesh so it can fall away when it gives ---
  const fakeParts = [];
  for (const f of fakes) {
    const g = new THREE.Group();
    const blob = new THREE.Mesh(holdBlob(f), holdMat);
    blob.castShadow = true; blob.receiveShadow = true;
    g.add(blob);
    root.add(g);
    fakeParts.push({ fake: f, group: g, blob, fall: 0, vy: 0, spin: (rnd() - 0.5) * 4 });
  }

  let holdsMesh = null;
  if (plainGeos.length) {
    holdsMesh = new THREE.Mesh(mergeGeometries(plainGeos, false), holdMat);
    holdsMesh.name = 'holds';
    holdsMesh.castShadow = true; holdsMesh.receiveShadow = true;
    root.add(holdsMesh);
  }
  if (skirtGeos.length) {
    const skirtMat = new THREE.MeshBasicMaterial({
      map: skirtTex, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const skirtMesh = new THREE.Mesh(mergeGeometries(skirtGeos, false), skirtMat);
    skirtMesh.name = 'hold-skirts';
    skirtMesh.renderOrder = 0;
    root.add(skirtMesh);
  }
  let chalkMesh = null;
  if (chalkGeos.length) {
    const chalkMat = new THREE.MeshStandardMaterial({
      map: chalkTex, transparent: true, opacity: 0.38, depthWrite: false, roughness: 1, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    chalkMesh = new THREE.Mesh(mergeGeometries(chalkGeos, false), chalkMat);
    chalkMesh.name = 'chalk';
    chalkMesh.receiveShadow = true;
    chalkMesh.renderOrder = 1;
    root.add(chalkMesh);
  }

  // Shared rune point lights, re-parked each frame on the two runes nearest the climber.
  const runeLights = [];
  for (let i = 0; i < RUNE_LIGHTS; i++) {
    const l = new THREE.PointLight(RUNE, 0, 5, 2);
    root.add(l);
    runeLights.push(l);
  }

  // ---------------------------------------------------------------------------------------
  // Waymarks: small glyphs carved beside the line every few metres. They glow faintly at dusk and
  // brightly at night; the stretch up to the next rune "wakes" when the rune below it is lit. One
  // merged additive mesh; per-glyph brightness lives in the vertex colours.
  const waymarks = [];
  let waymarkMesh = null;
  if (WAYMARKS) {
    let lastY = -Infinity;
    for (const h of holds) {
      if (h.kind !== 'hold' || h.y - lastY < WAYMARK_EVERY) continue;
      if (runeHolds.some((r) => Math.abs(r.y - h.y) < 1.4) || (summit && summit.y - h.y < 1.6)) continue;
      lastY = h.y;
      const side = waymarks.length % 2 === 0 ? -1 : 1;
      const cx = h.x + side * (0.36 + rnd() * 0.14);
      const cy = h.y + (rnd() - 0.5) * 0.24;
      const size = 0.2 + rnd() * 0.08;
      const g = conformedPatch(cx, cy, size, 4, (rnd() - 0.5) * 0.5, 0.012);
      const cell = Math.floor(rnd() * 4);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + (cell % 2)) * 0.5, (uv.getY(i) + Math.floor(cell / 2)) * 0.5);
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(uv.count * 3).fill(0.3), 3));
      waymarks.push({ y: cy, geo: g, count: uv.count });
    }
    if (waymarks.length) {
      const glyphMat = new THREE.MeshBasicMaterial({
        map: makeWaymarkAtlas(rnd), color: RUNE.clone(), vertexColors: true,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      waymarkMesh = new THREE.Mesh(mergeGeometries(waymarks.map((w) => w.geo), false), glyphMat);
      waymarkMesh.name = 'waymarks';
      waymarkMesh.renderOrder = 2;
      root.add(waymarkMesh);
    }
  }
  let wakeY = -1;
  // Everything below the first rune is awake from the start; each lit rune wakes the next stretch.
  function updateWaymarkWake(runesLit) {
    let top = runeHolds.length ? runeHolds[0].y : Infinity;
    for (const id of runesLit) {
      const r = runeHolds.find((h) => h.id === id);
      if (!r) continue;
      const idx = runeHolds.indexOf(r);
      const next = runeHolds[idx + 1];
      top = Math.max(top, next ? next.y : Infinity);
    }
    if (top === wakeY || !waymarkMesh) return;
    wakeY = top;
    const arr = waymarkMesh.geometry.attributes.color.array;
    let o = 0;
    for (const w of waymarks) {
      const b = w.y < top ? 1.0 : 0.32;
      for (let i = 0; i < w.count; i++, o += 3) { arr[o] = b; arr[o + 1] = b; arr[o + 2] = b; }
    }
    waymarkMesh.geometry.attributes.color.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------------------
  // Summit: shelf (baked into wallZ), standing stone with a rune disc, great circle on the wall,
  // an always-on teal beacon light.
  let altar = null;
  if (summit) {
    const altarMat = holdMat.clone();
    altarMat.vertexColors = false;
    altarMat.color = new THREE.Color(0x8c7f78);
    const stoneGeo = new RoundedBoxGeometry(0.62, 0.95, 0.34, 3, 0.03);
    stoneGeo.setAttribute('uv1', stoneGeo.attributes.uv.clone());
    const stone = new THREE.Mesh(stoneGeo, altarMat);
    stone.position.set(summit.x, summit.y - 0.02 + 0.475, 0.35 - 0.17);
    stone.castShadow = true; stone.receiveShadow = true;
    root.add(stone);

    const discMat = new THREE.MeshBasicMaterial({
      map: makeSigilTexture(rnd, 512, { rings: 2, ticks: 12, strokes: 5 }), color: RUNE.clone(),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), discMat);
    disc.position.set(summit.x, summit.y + 0.55, 0.35 + 0.006);
    disc.renderOrder = 2;
    root.add(disc);

    const circleMat = new THREE.MeshBasicMaterial({
      map: makeSigilTexture(rnd, 1024, { rings: 3, ticks: 24, strokes: 12, lineScale: 0.7 }), color: RUNE.clone(),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const circle = new THREE.Mesh(conformedPatch(summit.x, summit.y + 1.9, 2.2, 24, 0, 0.02), circleMat);
    circle.renderOrder = 2;
    root.add(circle);

    const beacon = new THREE.PointLight(RUNE, 0.3, 8, 2);
    beacon.position.set(summit.x, summit.y + 1.0, 0.9);
    root.add(beacon);

    altar = { stone, disc, discMat, circle, circleMat, beacon, k: 0.35, pos: new THREE.Vector3(summit.x, summit.y + 0.98, 0.25) };
  }

  // ---------------------------------------------------------------------------------------
  // Embers: one particle system for every rune plus the altar.
  const EMBERS_PER = 22, ALTAR_EMBERS = 40;
  const emberHomes = [];        // { pos: Vector3, rune | altar }
  for (const r of runes) emberHomes.push({ pos: r.pos, rune: r });
  if (altar) emberHomes.push({ pos: altar.pos, altar });
  const emberCount = runes.length * EMBERS_PER + (altar ? ALTAR_EMBERS : 0);
  const embers = createParticles({ count: Math.max(1, emberCount), texture: env.softTex, color: 0xa8f4ff, size: 0.055, opacity: 2.4 });
  const emberHome = new Uint16Array(Math.max(1, emberCount));
  const emberAge = new Float32Array(Math.max(1, emberCount));
  const emberLife = new Float32Array(Math.max(1, emberCount));
  const emberVel = new Float32Array(Math.max(1, emberCount) * 3);
  {
    let i = 0;
    for (let h = 0; h < emberHomes.length; h++) {
      const per = emberHomes[h].altar ? ALTAR_EMBERS : EMBERS_PER;
      for (let j = 0; j < per; j++, i++) {
        emberHome[i] = h;
        emberLife[i] = 1.8 + rnd() * 1.6;
        emberAge[i] = rnd() * emberLife[i];
        embers.alphas[i] = 0;
      }
    }
  }
  embers.commit();
  root.add(embers.points);

  function respawnEmber(i) {
    const home = emberHomes[emberHome[i]];
    const a = rnd() * Math.PI * 2, r = rnd() * (home.altar ? 0.22 : 0.34);
    embers.positions[i * 3] = home.pos.x + Math.cos(a) * r;
    embers.positions[i * 3 + 1] = home.pos.y + Math.sin(a) * r * 0.5 - 0.08;
    embers.positions[i * 3 + 2] = home.pos.z + 0.06 + rnd() * 0.16;
    emberVel[i * 3] = (rnd() - 0.5) * 0.06;
    emberVel[i * 3 + 1] = 0.2 + rnd() * 0.22;
    emberVel[i * 3 + 2] = 0.02 + rnd() * 0.05;
    emberAge[i] = 0;
    emberLife[i] = 1.8 + rnd() * 1.6;
  }

  // ---------------------------------------------------------------------------------------
  // Decoy dust: one small pool of grit, fired by the sim's `crumble` event. A decoy that gave way
  // had the sound and the tumble but nothing in the air, so it read as a rock deciding to leave.
  // Non-additive so it reads as dust rather than another glow, and dimmed with the night so it
  // does not float on the dark like a lamp.
  const DUST_MAX = 42;                 // two overlapping bursts; the pool never grows
  const DUST_PER = 18;                 // particles per decoy
  const DUST_COLOR = new THREE.Color(0xbda285);
  const dust = createParticles({
    count: DUST_MAX, texture: env.softTex, color: DUST_COLOR.getHex(),
    size: 0.075, opacity: 0.95, additive: false, maxPx: 34,
  });
  dust.points.renderOrder = 3;
  const dustVel = new Float32Array(DUST_MAX * 3);
  const dustAge = new Float32Array(DUST_MAX);
  const dustLife = new Float32Array(DUST_MAX);
  const _dustCol = new THREE.Color();
  let dustNext = 0, dustLive = 0;
  for (let i = 0; i < DUST_MAX; i++) { dust.alphas[i] = 0; dustAge[i] = 1; dustLife[i] = 1; }
  dust.commit();
  root.add(dust.points);

  // Decoys never move, so their positions can be looked up by id once.
  const fakeById = new Map();
  for (const f of fakes) fakeById.set(f.id, f);

  // A burst: grit thrown out of the socket, mostly sideways and down, with the puff hanging
  // where the rock was. Oldest particles are recycled, so a second decoy never grows the pool.
  function burstDust(x, y, z) {
    for (let n = 0; n < DUST_PER; n++) {
      const i = dustNext;
      dustNext = (dustNext + 1) % DUST_MAX;
      const a = Math.random() * Math.PI * 2;
      const sp = 0.25 + Math.random() * 1.05;
      const k = i * 3;
      dust.positions[k] = x + Math.cos(a) * 0.05;
      dust.positions[k + 1] = y + Math.sin(a) * 0.05;
      dust.positions[k + 2] = z + 0.02 + Math.random() * 0.05;
      dustVel[k] = Math.cos(a) * sp;
      dustVel[k + 1] = Math.sin(a) * sp * 0.55 - 0.25;      // biased downward: the rock is falling
      dustVel[k + 2] = 0.25 + Math.random() * 0.5;          // out of the face, toward the climber
      dustAge[i] = 0;
      dustLife[i] = 0.55 + Math.random() * 0.55;
      dust.alphas[i] = 0;
    }
    dustLive = DUST_MAX;                 // let the update loop find the dead ones itself
  }

  // ---------------------------------------------------------------------------------------
  // Rope: harness → anchor, our own tube so we can rewrite the vertices every frame without GC.
  const ropeTex = makeRopeTexture();
  const rope = createRopeMesh(ropeTex);
  root.add(rope.mesh);
  const anchorGroup = new THREE.Group();
  {
    const metal = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, metalness: 0.85, roughness: 0.35 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.009, 10, 24), metal);
    ring.position.z = 0.05;
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.12, 10), metal);
    bolt.rotation.x = Math.PI / 2;
    bolt.position.z = -0.01;
    ring.castShadow = bolt.castShadow = true;
    anchorGroup.add(ring, bolt);
  }
  root.add(anchorGroup);

  // Belay strand: the other half of a top rope, running from the anchor down the face to the
  // belayer at the base. It lies against the rock a little to the side of the line, so it is in
  // frame most of the time without ever crossing the lens, and it twangs when a fall is caught.
  const belayTex = ropeTex.clone();
  belayTex.needsUpdate = true;
  const belayHome = [];          // resting control points, from the anchor down
  {
    const ax0 = summit ? summit.x : 0, ay0 = summit ? summit.y + 1.6 : 41;
    for (let y = ay0; y > -1.5; y -= 2) {
      const f = smoothstep(ay0, ay0 - 3, y);                  // leaves the anchor ring, then hugs the face
      const x = ax0 - 0.58 * f + 0.12 * noise.noise(y * 0.21 + 55, 8.8) * f;
      belayHome.push(new THREE.Vector3(x, y, wallZ(x, y) + 0.05 + 0.05 * f));
    }
    belayHome.push(new THREE.Vector3(ax0 - 0.5, -3.5, wallZ(ax0 - 0.5, -3.5) + 0.1));
    belayTex.repeat.set(Math.max(1, (ay0 + 3.5) / ROPE.stripe), 1);
  }
  const belay = createRopeMesh(belayTex, 72, belayHome.length);
  belay.mesh.name = 'belay';
  root.add(belay.mesh);
  let twang = 0;

  // Hover rings: one per hand, parked on the nearest grabbable hold.
  const ringMat = new THREE.MeshBasicMaterial({
    color: RUNE, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const hoverRings = { L: null, R: null };
  for (const side of ['L', 'R']) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.94, 1.0, 48), ringMat.clone());
    m.visible = false;
    m.renderOrder = 3;
    root.add(m);
    // soft teal glow behind the ring so the cue reads as light on the rock, not a UI circle
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: env.softTex, color: RUNE, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    glow.visible = false;
    glow.renderOrder = 3;
    root.add(glow);
    hoverRings[side] = { mesh: m, glow, k: 0 };
  }

  // ---------------------------------------------------------------------------------------
  // Per-frame
  let t = 0;
  let taut = 0;
  let routeRef = null;
  const holdById = new Map();
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();
  const _size = new THREE.Vector2();
  const runeByDist = [];

  function syncRoute(state) {
    const r = (state && state.route) || route;
    if (r === routeRef) return;
    routeRef = r;
    holdById.clear();
    for (const h of (r && r.holds) || []) holdById.set(h.id, h);
    syncFakes(r);
  }

  // "Climb again" builds a fresh route from the same seed, so the sim's decoys are whole again --
  // but the meshes were bound to the boot-time objects and stayed broken and 60 m below, leaving a
  // rock you could grab that was not there (B35). Re-point every part at the new object with its id
  // and put the group back where it started. Same seed means same decoys in the same places, which
  // is why the geometry, baked at boot, is still right; a different seed reloads the page instead.
  function syncFakes(r) {
    const next = (r && r.fakes) || [];
    fakeById.clear();
    for (const f of next) fakeById.set(f.id, f);
    for (const fp of fakeParts) {
      const f = fakeById.get(fp.fake.id);
      if (f) fp.fake = f;
      fp.fall = 0;
      fp.vy = 0;
      fp.group.position.set(0, 0, 0);
      fp.group.rotation.z = 0;
      fp.group.visible = !fp.fake.broken;
    }
  }

  function update(dt, state, camera, events) {
    dt = Math.min(0.1, Math.max(0, dt || 0));
    t += dt;
    syncRoute(state);
    const body = (state && state.body) || { x: 0, y: 2 };
    const night = state ? clamp01(state.night || 0) : 0;
    const phase = state ? state.phase : 'climbing';
    const runesLit = (state && state.runesLit) || [];

    env.update(dt, night, camera, body, wallZ);
    renderer.getDrawingBufferSize(_size);
    embers.setHeightPx(_size.y);
    embers.setTime(t);

    // --- runes -----------------------------------------------------------------------------
    runeByDist.length = 0;
    for (let i = 0; i < runes.length; i++) {
      const r = runes[i];
      const live = holdById.get(r.hold.id) || r.hold;
      const isSummit = live.kind === 'summit';
      const lit = !!live.lit || runesLit.indexOf(live.id) >= 0 || (isSummit && phase === 'summit');
      if (lit && !r.wasLit) r.flash = 1;
      r.wasLit = lit;
      r.flash = Math.max(0, r.flash - dt * 0.9);
      const prox = 1 - smoothstep(1.5, 7.0, Math.abs(live.y - body.y));
      const target = lit ? 1.0 : 0.12 + 0.3 * prox;
      r.k += (target - r.k) * Math.min(1, dt * 3);
      const pulse = lit ? 1 + 0.12 * Math.sin(t * 2.1 + i) : 1 + 0.25 * Math.sin(t * 1.3 + i * 1.7);
      const I = r.k * pulse + r.flash * 1.5;
      r.I = I;
      // fade the additive sigil with distance ourselves (fog would add colour to it instead)
      const dz = camera ? Math.hypot(live.x - camera.position.x, live.y - camera.position.y) : 5;
      const att = Math.exp(-Math.pow(dz * 0.02, 2));
      // additive: keep the lit sigil under 1.0 so it stays teal instead of clipping to white
      r.sigilMat.color.copy(RUNE).multiplyScalar(Math.min(0.92, (0.20 + 0.60 * I) * att));
      r.mat.emissiveIntensity = 0.15 + 1.5 * I;
      runeByDist.push(r);
    }
    runeByDist.sort((a, b) => Math.abs(a.hold.y - body.y) - Math.abs(b.hold.y - body.y));
    for (let i = 0; i < runeLights.length; i++) {
      const l = runeLights[i];
      const r = runeByDist[i];
      if (!r) { l.intensity = 0; continue; }
      l.position.set(r.pos.x, r.pos.y + 0.05, r.pos.z + 0.45);
      l.intensity = 0.08 + 0.42 * r.I;
    }

    // --- waymarks --------------------------------------------------------------------------
    if (waymarkMesh) {
      updateWaymarkWake(runesLit);
      const glow = (0.28 + 0.95 * smoothstep(0.25, 0.95, night)) * (1 + 0.1 * Math.sin(t * 1.7));
      waymarkMesh.material.color.copy(RUNE).multiplyScalar(glow);
    }

    // --- altar -----------------------------------------------------------------------------
    if (altar) {
      const lit = phase === 'summit';
      const prox = 1 - smoothstep(4, 22, Math.abs(summit.y - body.y));
      const target = lit ? 1.0 : 0.18 + 0.3 * prox;
      altar.k += (target - altar.k) * Math.min(1, dt * 2.5);
      const pulse = 1 + (lit ? 0.1 : 0.2) * Math.sin(t * 1.7);
      const I = altar.k * pulse;
      altar.I = I;
      const dz = camera ? Math.hypot(summit.x - camera.position.x, summit.y + 1.9 - camera.position.y) : 5;
      const att = Math.exp(-Math.pow(dz * 0.02, 2));
      altar.circleMat.color.copy(RUNE).multiplyScalar(Math.min(1.15, (0.25 + 0.8 * I) * att));
      altar.discMat.color.copy(RUNE).multiplyScalar(Math.min(1.05, (0.22 + 0.7 * I) * att));
      altar.beacon.intensity = 0.12 + 0.42 * I;
    }

    // --- decoys: a rock that gave way tips out of the face and drops into the fog -----------
    // The sim says when one gives; the dust is fired from that event so it lands on the frame
    // the hand comes off, not a frame later from a polled flag.
    if (events && events.length) {
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (!e || e.type !== 'crumble') continue;
        const f = fakeById.get(e.holdId);
        if (f) burstDust(f.x, f.y, holdZ(f));
      }
    }
    for (const fp of fakeParts) {
      if (!fp.fake.broken) continue;
      if (fp.fall === 0) fp.vy = -0.4;
      fp.fall += dt;
      fp.vy -= 9.81 * dt * 0.55;
      fp.group.position.y += fp.vy * dt;
      fp.group.position.z += 0.35 * dt;
      fp.group.rotation.z += fp.spin * dt;
      if (fp.fall > 4 || fp.group.position.y < -60) fp.group.visible = false;
    }

    // --- decoy dust ------------------------------------------------------------------------
    if (dustLive > 0) {
      const p = dust.positions, a = dust.alphas;
      let alive = 0;
      for (let i = 0; i < DUST_MAX; i++) {
        if (dustAge[i] >= dustLife[i]) { a[i] = 0; continue; }
        dustAge[i] += dt;
        const k = i * 3;
        dustVel[k + 1] -= 3.2 * dt;                      // grit falls, but lightly: it is dust
        const drag = Math.exp(-dt * 3.4);                // and it loses the throw fast
        dustVel[k] *= drag; dustVel[k + 1] *= drag; dustVel[k + 2] *= drag;
        p[k] += dustVel[k] * dt;
        p[k + 1] += dustVel[k + 1] * dt;
        p[k + 2] += dustVel[k + 2] * dt;
        const life = Math.min(1, dustAge[i] / dustLife[i]);
        a[i] = Math.min(1, life * 7) * (1 - life) * (1 - life);   // snaps on, hangs, thins out
        alive++;
      }
      dustLive = alive;
      dust.setHeightPx(_size.y);
      // uTime is deliberately left at 0: the shader's twinkle then becomes a fixed per-particle
      // brightness instead of a shimmer, which is what grit wants and embers do not.
      dust.setColor(_dustCol.copy(DUST_COLOR).multiplyScalar(1 - 0.55 * night));
      dust.commit();
    }

    // --- embers ----------------------------------------------------------------------------
    {
      const p = embers.positions, a = embers.alphas;
      const camY = camera ? camera.position.y : body.y;
      for (let i = 0; i < emberCount; i++) {
        const home = emberHomes[emberHome[i]];
        const I = home.altar ? (altar ? altar.I : 0) : home.rune.I;
        const far = Math.abs(home.pos.y - camY) > 16;
        emberAge[i] += dt;
        if (emberAge[i] >= emberLife[i]) {
          if (far || I < 0.05) { a[i] = 0; emberAge[i] = emberLife[i]; continue; }
          respawnEmber(i);
        }
        if (far) { a[i] = 0; continue; }
        const k = i * 3;
        p[k] += (emberVel[k] + Math.sin(t * 2.3 + i) * 0.04) * dt;
        p[k + 1] += emberVel[k + 1] * dt;
        p[k + 2] += emberVel[k + 2] * dt;
        const life = emberAge[i] / emberLife[i];
        a[i] = Math.sin(life * Math.PI) * Math.min(1.3, 0.35 + I);
      }
      embers.commit();
    }

    // --- rope ------------------------------------------------------------------------------
    {
      const anchor = (state && state.ropeAnchor) || (summit ? { x: summit.x, y: summit.y + 1.2 } : { x: 0, y: 41 });
      const bz = wallZ(body.x, body.y);
      const hx = body.x, hy = body.y - 0.35, hz = bz + 0.55 + 0.12;
      const az = wallZ(anchor.x, anchor.y) + 0.06;
      const tautTarget = (phase === 'falling' || phase === 'caught') ? 1 : 0;
      taut += (tautTarget - taut) * Math.min(1, dt * 5);
      const side = anchor.x >= hx - 0.6 ? 1 : -1;
      const P = rope.points;
      P[0].set(hx, hy, hz);
      P[3].set(anchor.x, anchor.y, az);
      // slack path bows out to the side and away from the wall; under load the rope runs up past
      // the climber's shoulder (where a top rope really hangs) so the catch is seen, and hums.
      const sway = 0.04 * Math.sin(t * 1.1);
      const hum = taut * 0.012 * Math.sin(t * 23.0);
      _a.set(hx + side * (0.58 + sway), hy + 0.3, hz + 0.05);
      _b.set(hx + side * (0.34 + hum), hy + 0.62, hz + 0.02);
      P[1].lerpVectors(_a, _b, taut);
      _a.set(hx + side * (0.62 + sway), hy + 2.6, wallZ(hx + side * 0.6, hy + 2.6) + 0.32);
      _b.set(lerp(hx, anchor.x, 0.4) + side * (0.22 + hum), lerp(hy, anchor.y, 0.4), lerp(hz, az, 0.4) + 0.12);
      P[2].lerpVectors(_a, _b, taut);
      rope.update();
      const L = Math.hypot(anchor.x - hx, anchor.y - hy, az - hz);
      ropeTex.repeat.set(Math.max(1, L / ROPE.stripe), 1);
      anchorGroup.position.set(anchor.x, anchor.y, az - 0.06);

      // belay strand: slow sway in the wind, a sharp decaying twang while the climber's strand
      // is loaded, both fading out toward the fixed ends
      twang = phase === 'falling' ? 1 : twang * Math.exp(-dt * 1.6);
      const BP = belay.points;
      for (let i = 0; i < BP.length; i++) {
        const h = belayHome[i];
        const end = Math.min(1, i / 1.5) * Math.min(1, (BP.length - 1 - i) / 1.5);
        const sway = 0.035 * Math.sin(t * 0.8 + h.y * 0.35) * end;
        const tw = twang * 0.03 * Math.sin(t * 28 + h.y * 1.7) * end;
        BP[i].set(h.x + sway + tw, h.y, h.z + 0.02 * Math.sin(t * 0.6 + h.y * 0.5) * end + Math.abs(tw) * 0.6);
      }
      belay.update();
    }

    // --- hover rings -----------------------------------------------------------------------
    if (state && state.hands) {
      for (const side of ['L', 'R']) {
        const hand = state.hands[side];
        const ring = hoverRings[side];
        let target = 0, best = null, bestD = 0.34;
        if (HOVER_CUE && hand && !hand.gripping) {
          for (const h of holdById.size ? holdById.values() : holds) {
            const d = Math.hypot(h.x - hand.x, h.y - hand.y);
            if (d < bestD) { bestD = d; best = h; }
          }
          if (best) {
            const near = 1 - bestD / 0.34;
            target = Math.max(hand.hover || 0, near) * (hand.armed ? 0.26 + 0.08 * Math.sin(t * 9) : 0.18);
          }
        }
        ring.k += (target - ring.k) * Math.min(1, dt * 10);
        const m = ring.mesh, g = ring.glow;
        if (best) {
          m.position.set(best.x, best.y, holdZ(best) + 0.01);
          const s = best.size * 1.15;
          m.scale.set(s, s, 1);
          g.position.set(best.x, best.y, holdZ(best) + 0.04);
          g.scale.set(best.size * 3.4, best.size * 3.4, 1);
        }
        m.visible = g.visible = ring.k > 0.02;
        m.material.opacity = ring.k;
        g.material.opacity = ring.k * 0.9;
      }
    }
  }

  function setTier(tierNext) {
    currentTier = tierNext || currentTier;
    env.setTier(currentTier);
  }

  return {
    wallZ, holdZ, update, setTier,
    env, root, wall, holds: holdsMesh, chalk: chalkMesh, runes, altar, waymarks: waymarkMesh, rope: rope.mesh, embers, hoverRings,
    dust,
    get dustLive() { return dustLive; },
    get time() { return t; },
  };
}

// ---------------------------------------------------------------------------------------------
// Canvas textures

// Chalk splat: a couple of crisp hand-sized dabs plus finger streaks, white on transparent.
function makeChalkTexture(rnd) {
  const size = 256;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  // two or three palm-sized dabs with a fairly hard edge (chalk is dry powder, not smoke)
  for (let i = 0; i < 3; i++) {
    const x = 128 + (rnd() - 0.5) * 70, y = 122 + (rnd() - 0.5) * 60, r = 16 + rnd() * 18;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  // finger smears: mostly downward, where a hand slid off
  ctx.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    ctx.lineWidth = 3 + rnd() * 5;
    ctx.strokeStyle = `rgba(255,255,255,${0.3 + rnd() * 0.45})`;
    ctx.beginPath();
    const x = 128 + (rnd() - 0.5) * 90, y = 120 + (rnd() - 0.5) * 50, a = Math.PI / 2 + (rnd() - 0.5) * 1.0, l = 18 + rnd() * 40;
    ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  // speckle
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + rnd() * 0.6})`;
    const x = 128 + (rnd() - 0.5) * 190, y = 128 + (rnd() - 0.5) * 190;
    ctx.fillRect(x, y, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  const mask = ctx.createRadialGradient(128, 128, 70, 128, 128, 128);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
  return canvasTexture(c);
}

// Contact shadow under a hold: opaque at the centre (hidden by the blob), fading to nothing.
function makeSkirtTexture() {
  const size = 128;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvasTexture(c, { srgb: false });
}

// A ring drawn as many short arcs of wandering width and alpha, so it reads as a groove chiselled
// by hand rather than a vector circle.
function roughRing(ctx, rnd, r, width, alpha) {
  const segs = 64;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1.15) / segs) * Math.PI * 2;
    ctx.lineWidth = width * (0.7 + rnd() * 0.6);
    ctx.globalAlpha = alpha * (0.6 + rnd() * 0.4);
    ctx.beginPath(); ctx.arc(0, 0, r + (rnd() - 0.5) * width * 0.4, a0, a1); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Rune sigil: rings, tick marks and a seeded glyph of straight strokes, white on transparent with
// a soft glow so the additive decal has a bright core (bloom) and a wide faint halo.
function makeSigilTexture(rnd, size, { rings = 2, ticks = 16, strokes = 7, lineScale = 1 } = {}) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const u = size / 512;             // geometry scale
  const lw = u * lineScale;          // stroke scale
  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 22 * lw;
  const R = 200 * u;
  for (let i = 0; i < rings; i++) {
    const rr = R - i * 48 * u;
    roughRing(ctx, rnd, rr, 9 * lw, 0.55);
    roughRing(ctx, rnd, rr, 4 * lw, 1);
  }
  ctx.lineWidth = 5 * lw;
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2;
    const r0 = R - 40 * u, r1 = R - (i % 4 === 0 ? 8 : 20) * u;
    ctx.globalAlpha = 0.7 + rnd() * 0.3;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 11 * lw;
  const inner = R - 48 * u * rings - 20 * u;
  for (let i = 0; i < strokes; i++) {
    const a0 = rnd() * Math.PI * 2, a1 = a0 + (rnd() - 0.5) * 2.4;
    const r0 = inner * (0.2 + rnd() * 0.8), r1 = inner * (0.2 + rnd() * 0.8);
    ctx.lineWidth = (8 + rnd() * 6) * lw;
    ctx.beginPath(); ctx.moveTo(Math.cos(a0) * r0, Math.sin(a0) * r0); ctx.lineTo(Math.cos(a1) * r1, Math.sin(a1) * r1); ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, 10 * u, 0, Math.PI * 2); ctx.fill();
  return canvasTexture(c);
}

// Emissive map for a rune hold: glowing cracks on black, centred where the blob faces out.
function makeGlyphTexture(rnd) {
  const size = 256;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255,255,255,0.85)';
  ctx.shadowBlur = 12;
  for (let i = 0; i < 6; i++) {
    ctx.lineWidth = 6 + rnd() * 5;
    const x = 128 + (rnd() - 0.5) * 100, y = 128 + (rnd() - 0.5) * 100, a = rnd() * Math.PI * 2, l = 25 + rnd() * 55;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  ctx.lineWidth = 7;
  ctx.beginPath(); ctx.arc(128, 128, 24, 0, Math.PI * 2); ctx.stroke();
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// 2×2 atlas of small runic glyphs: a stem with branches and a dot, glow baked in.
function makeWaymarkAtlas(rnd) {
  const size = 512, cell = 256;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 14;
  for (let k = 0; k < 4; k++) {
    ctx.save();
    ctx.translate((k % 2) * cell + cell / 2, Math.floor(k / 2) * cell + cell / 2);
    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(0, -80); ctx.lineTo(0, 80); ctx.stroke();
    const branches = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < branches; i++) {
      const y = -60 + rnd() * 110, dir = rnd() < 0.5 ? -1 : 1, up = rnd() < 0.6 ? -1 : 1;
      const l = 35 + rnd() * 35;
      ctx.lineWidth = 7 + rnd() * 3;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(dir * l, y + up * l * (0.5 + rnd() * 0.6)); ctx.stroke();
    }
    if (rnd() < 0.7) { ctx.beginPath(); ctx.arc((rnd() - 0.5) * 60, 90 + rnd() * 10, 7, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  return canvasTexture(c);
}

function makeRopeTexture() {
  const w = 256, h = 32;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e8702a';
  ctx.fillRect(0, 0, w, h);
  // helical teal and white tracers
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#2fb8c8';
  for (let x = -h; x < w + h; x += 128) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke(); }
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#4a2a18';
  for (let x = -h + 64; x < w + h; x += 128) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke(); }
  // fibre noise
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.12})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 1);
  }
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Rope tube with a parallel-transport frame, rewritten in place each frame.

function createRopeMesh(texture, segments = ROPE.segments, controlPoints = 4) {
  const N = segments, R = ROPE.radial;
  const count = (N + 1) * (R + 1);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const index = [];
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= R; j++) {
      const k = i * (R + 1) + j;
      uvs[k * 2] = i / N; uvs[k * 2 + 1] = j / R;
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < R; j++) {
      const a = i * (R + 1) + j, b = a + 1, c = a + (R + 1), d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
  const norAttr = new THREE.BufferAttribute(normals, 3); norAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', posAttr);
  g.setAttribute('normal', norAttr);
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(index);

  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, material);
  mesh.name = 'rope';
  mesh.castShadow = true;
  mesh.frustumCulled = false;

  const points = [];
  for (let i = 0; i < controlPoints; i++) points.push(new THREE.Vector3());
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
  const samples = [];
  for (let i = 0; i <= N; i++) samples.push(new THREE.Vector3());
  const T = new THREE.Vector3(), Nn = new THREE.Vector3(), B = new THREE.Vector3(), A = new THREE.Vector3(), X = new THREE.Vector3();

  function update() {
    for (let i = 0; i <= N; i++) curve.getPoint(i / N, samples[i]);
    for (let i = 0; i <= N; i++) {
      const p = samples[i];
      if (i === 0) T.subVectors(samples[1], samples[0]);
      else if (i === N) T.subVectors(samples[N], samples[N - 1]);
      else T.subVectors(samples[i + 1], samples[i - 1]);
      if (T.lengthSq() < 1e-12) T.set(0, 1, 0); else T.normalize();
      if (i === 0) {
        A.set(Math.abs(T.y) < 0.9 ? 0 : 1, Math.abs(T.y) < 0.9 ? 1 : 0, 0);
        Nn.crossVectors(T, A).normalize();
      } else {
        Nn.addScaledVector(T, -Nn.dot(T));
        if (Nn.lengthSq() < 1e-8) { A.set(1, 0, 0); Nn.crossVectors(T, A); }
        Nn.normalize();
      }
      B.crossVectors(T, Nn);
      for (let j = 0; j <= R; j++) {
        const ang = (j / R) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        X.set(Nn.x * ca + B.x * sa, Nn.y * ca + B.y * sa, Nn.z * ca + B.z * sa);
        const k = (i * (R + 1) + j) * 3;
        normals[k] = X.x; normals[k + 1] = X.y; normals[k + 2] = X.z;
        positions[k] = p.x + X.x * ROPE.radius; positions[k + 1] = p.y + X.y * ROPE.radius; positions[k + 2] = p.z + X.z * ROPE.radius;
      }
    }
    posAttr.needsUpdate = true;
    norAttr.needsUpdate = true;
  }

  return { mesh, points, update };
}
