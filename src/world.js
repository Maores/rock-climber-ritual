// The cliff and everything bolted to it: displaced PBR wall (wallZ is the single source of truth
// for depth), edge-shaped holds cut from the same red stone with chalk on their lips, rune holds
// with carved sigils, point lights and embers, faint glyph waymarks along the route that wake up
// as runes are lit, and the summit ledge + altar + great circle, and
// hover rings for the hands. Lighting, sky, fog and particles live in env.js; this module owns the
// solid things and drives the per-frame state (glow, rings, dust) from the shared `state`.
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
// B52 — instanced holds. Plain holds are no longer one deformed icosahedron each, merged into a
// single mesh; they are a small set of unit-scale prototype blobs drawn through InstancedMesh, so
// the cost of the rock stops growing with the number of holds. A field route (B46) is ~1900 holds
// where the old line was 125, and the merged build cost 39 MB of buffers and 3.6 s of boot for it.
const PROTO = {
  variants: 3,        // blob shapes per grip family; 4 families × 3 = 12 prototypes
  back: 1.06,         // the back of a prototype is stretched to this many unit radii, so a SHARED
                      // blob is never shallower in the rock than a per-hold one happened to be
  sink: 0.03,         // and it is seated this much deeper again, in hold radii (3–6 mm): a
                      // prototype cannot be conformed to this hold's own noise, so it pays a margin
  tilt: 0.55,         // how much of the wall's local slope an instance leans with (0 = dead front)
  tiltMax: 0.22,      // radians: ~12.6°, past which a hold starts to read as falling off the rock
  jitter: 0.10,       // per-instance non-uniform scale in x and y, so 12 shapes are not 12 copies
  shadowBand: 4.2,    // metres above the body still worth drawing into the shadow map (the shadow
                      // camera is a 6.4 m box around the body, so anything higher cannot cast into it)
  eps: 0.10,          // finite-difference step for the wall normal — half a hold, so an instance
                      // leans with the seat it sits on and not with the grit
};
// Blob shaping per grip kind. Every range here is a slice of the one range the merged build drew
// from (sx 1.15–1.55, sy 0.62–0.90, chalk 0.35–0.85), so no hold looks unlike something the old
// wall could have produced; a jug is simply drawn from the fat end of it and a crimp from the flat.
const FAMILIES = [
  { grip: 'jug',    detail: 5, sx: [1.15, 1.35], sy: [0.78, 0.90], chalk: [0.50, 0.85] },
  { grip: 'edge',   detail: 4, sx: [1.25, 1.55], sy: [0.66, 0.80], chalk: [0.40, 0.80] },
  { grip: 'crimp',  detail: 4, sx: [1.30, 1.55], sy: [0.62, 0.72], chalk: [0.35, 0.70] },
  { grip: 'sloper', detail: 4, sx: [1.15, 1.40], sy: [0.70, 0.88], chalk: [0.35, 0.60] },
];
const FAMILY_OF = { jug: 0, edge: 1, crimp: 2, sloper: 3 };
const SHADE_MEAN = 0.92;                            // baked into the prototype; per-instance colour
                                                    // then rides around 1.0 (0.89–1.11)
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

  // Runes, the summit and nothing else still get a blob of their own, baked at their world
  // position with their own noise: there are three or four of them and they carry a sigil.
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

  // ---------------------------------------------------------------------------------------
  // Prototype blobs (B52). The same shaping as holdBlob, at unit scale, with no hold's position
  // or size baked in — twelve of them stand in for every plain hold on the wall. The noise is
  // sampled once per prototype instead of once per hold, which is the whole boot cost of a field.
  function holdProto(fam, key) {
    let g = new THREE.IcosahedronGeometry(1, fam.detail);
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g = mergeVertices(g, 1e-4);
    const p = g.attributes.position;
    const n = p.count;
    const uv = new Float32Array(n * 2);
    const col = new Float32Array(n * 3);
    const s = key * 3.17 + 0.5;
    const tr = HOLD_TINT[0] * SHADE_MEAN, tg = HOLD_TINT[1] * SHADE_MEAN, tb = HOLD_TINT[2] * SHADE_MEAN;
    const sx = lerp(fam.sx[0], fam.sx[1], rnd());          // edges are wider than tall
    const sy = lerp(fam.sy[0], fam.sy[1], rnd());
    const chalkAmt = lerp(fam.chalk[0], fam.chalk[1], rnd());   // some holds are well used, some barely
    let back = 0;
    for (let i = 0; i < n; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const ny = y, nz = z;                 // unit-sphere direction, before deformation
      const n1 = noise.noise3d(x * 0.9 + s, y * 0.9, z * 0.9 + s * 0.5);
      const n2 = noise.noise3d(x * 2.4 + 41, y * 2.4 + s, z * 2.4);
      const r = 1 + 0.22 * n1 + 0.07 * n2;
      x *= r; y *= r; z *= r;
      if (y > 0) y *= 0.72;                                 // flat top lip
      if (z > 0.78) z = 0.78 + (z - 0.78) * 0.25;           // flat front face (fingers grip here)
      if (z < back) back = z;
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
      p.setXYZ(i, x * sx, y * sy, z);
    }
    // Seat the shared shape: stretch whatever back this prototype happens to have out to PROTO.back
    // radii, so a reused blob can never sit shallower in the rock than a per-hold one did. The
    // back is inside the wall and is never seen; only its depth matters.
    const grow = back < -1e-3 ? PROTO.back / -back : 1;
    if (grow > 1) for (let i = 0; i < n; i++) { const z = p.getZ(i); if (z < 0) p.setZ(i, z * grow); }
    for (let i = 0; i < n; i++) p.setZ(i, p.getZ(i) * HOLD.zScale);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return { geo: g, sx, sy, grip: fam.grip };
  }
  const protos = [];
  for (let f = 0; f < FAMILIES.length; f++) {
    for (let v = 0; v < PROTO.variants; v++) protos.push(holdProto(FAMILIES[f], f * PROTO.variants + v));
  }
  const protoOf = (hold) => {
    const f = FAMILY_OF[hold.grip] !== undefined ? FAMILY_OF[hold.grip] : 1;   // no grip → edge
    return f * PROTO.variants + (hold.id % PROTO.variants);
  };

  // Where one instance sits. `holdZ` is untouched by all of this: the placement uses the same
  // single wallZ sample the merged build used, minus PROTO.sink, and the instance leans with the
  // wall's local slope (four more wallZ samples — five per hold, against 250 per hold of noise
  // before). Writes the matrix into `m` and returns the footprint the contact shadow needs.
  const _ip = new THREE.Vector3(), _iq = new THREE.Quaternion(), _is = new THREE.Vector3();
  const _iz = new THREE.Vector3(0, 0, 1), _in = new THREE.Vector3(), _ilean = new THREE.Quaternion();
  const clampAbs = (v, lim) => (v > lim ? lim : v < -lim ? -lim : v);
  function instanceMatrix(hold, proto, r, m) {
    const e = PROTO.eps, T = Math.tan(PROTO.tiltMax);
    const gx = (wallZ(hold.x + e, hold.y) - wallZ(hold.x - e, hold.y)) / (2 * e);
    const gy = (wallZ(hold.x, hold.y + e) - wallZ(hold.x, hold.y - e)) / (2 * e);
    _in.set(clampAbs(-gx * PROTO.tilt, T), clampAbs(-gy * PROTO.tilt, T), 1).normalize();
    _iq.setFromUnitVectors(_iz, _in);
    // keep the long axis roughly horizontal: ±20° of lean, not a random spin
    const rot = (((hold.angle || 0) % (Math.PI / 2)) - Math.PI / 4) * 0.45;
    _ilean.setFromAxisAngle(_iz, rot);
    _iq.multiply(_ilean);
    const jx = 1 + (r() - 0.5) * 2 * PROTO.jitter;
    const jy = 1 + (r() - 0.5) * 2 * PROTO.jitter;
    _ip.set(hold.x, hold.y, wallZ(hold.x, hold.y) + hold.size * (HOLD.sink - PROTO.sink));
    _is.set(hold.size * jx, hold.size * jy, hold.size);     // never in z: holdZ depends on it
    m.compose(_ip, _iq, _is);
    return { sx: proto.sx * jx, sy: proto.sy * jy, rot };
  }
  // One PRNG per hold rather than one shared stream, so a hold's shade and jitter depend on its
  // own id and nothing else — the wall is the same whatever order it is built in.
  const holdRnd = (hold) => mulberry32((Math.imul(hold.id + 1, 2654435761) ^ (seed * 7919)) >>> 0);

  const chalkTex = makeChalkTexture(rnd);
  const skirtTex = makeSkirtTexture();
  const chalkGeos = [], skirtGeos = [];
  const runes = [];            // { hold, blob, mat, sigilMat, k, flash, wasLit, pos }
  const buckets = protos.map(() => []);        // plain holds, per prototype
  for (const hold of holds) {
    if (hold.kind === 'rune' || hold.kind === 'summit') {
      const mat = holdMat.clone();
      mat.emissive = RUNE.clone();
      mat.emissiveMap = makeGlyphTexture(rnd);
      mat.emissiveIntensity = 0.3;
      const blob = new THREE.Mesh(holdBlob(hold), mat);
      blob.castShadow = true; blob.receiveShadow = true;
      blob.userData.holdBucket = 'holds';
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
      buckets[protoOf(hold)].push(hold);
    }
  }

  // --- the instanced wall of rock ---------------------------------------------------------
  // One InstancedMesh per prototype, its instances sorted up the wall so the shadow pass can stop
  // at the top of the shadow camera's box instead of re-drawing the whole cliff into a 6.4 m frame.
  const holdsGroup = new THREE.Group();
  holdsGroup.name = 'holds';
  holdsGroup.userData.holdBucket = 'holds';
  root.add(holdsGroup);
  const holdMeshes = [];
  {
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    for (let i = 0; i < protos.length; i++) {
      const list = buckets[i];
      if (!list.length) continue;
      list.sort((a, b) => a.y - b.y);
      const mesh = new THREE.InstancedMesh(protos[i].geo, holdMat, list.length);
      mesh.name = `holds-${protos[i].grip}-${i % PROTO.variants}`;
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.holdBucket = 'holds';
      const ys = new Float32Array(list.length);
      for (let k = 0; k < list.length; k++) {
        const hold = list[k];
        const r = holdRnd(hold);
        footprint.set(hold.id, instanceMatrix(hold, protos[i], r, m));
        mesh.setMatrixAt(k, m);
        // per-hold shade, as the merged build had it — now a multiplier on the prototype's colours
        const shade = (0.82 + r() * 0.2) / SHADE_MEAN;
        c.setRGB(shade * (0.96 + r() * 0.08), shade * (0.96 + r() * 0.08), shade * (0.96 + r() * 0.08));
        mesh.setColorAt(k, c);
        ys[k] = hold.y;
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.userData.ys = ys;
      mesh.userData.full = list.length;
      mesh.userData.shadowCount = list.length;
      mesh.onBeforeShadow = onBeforeHoldShadow;
      mesh.onAfterShadow = onAfterHoldShadow;
      holdsGroup.add(mesh);
      holdMeshes.push(mesh);
    }
  }
  // Only the band around the climber can land in the shadow camera's 6.4 m box; the rest of the
  // cliff is drawn into the depth map for nothing. Instances are sorted by height, so the cut is
  // one count — and it cannot change a pixel, because what it drops could not have cast anything.
  function onBeforeHoldShadow() { this.count = this.userData.shadowCount; }
  function onAfterHoldShadow() { this.count = this.userData.full; }
  function updateShadowCounts(bodyY) {
    const lim = bodyY + PROTO.shadowBand;
    for (const mesh of holdMeshes) {
      const ys = mesh.userData.ys;
      let lo = 0, hi = ys.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ys[mid] <= lim) lo = mid + 1; else hi = mid; }
      mesh.userData.shadowCount = lo;
    }
  }

  // Chalk and contact shadows, one patch each per hold, still merged into a single mesh apiece:
  // a 5×5 and a 4×4 grid is 61 vertices a hold, so a whole field of them is ~5 MB and two draw
  // calls — a fiftieth of what the blobs cost. They stay conformed to the rock, which is what
  // makes a hold read as growing out of the wall at arm's length.
  for (const hold of holds) {
    // chalk splat on the wall around the hold, biased upward where the hand comes from
    chalkGeos.push(conformedPatch(hold.x, hold.y + hold.size * 0.15, hold.size * 2.3, 5, (rnd() - 0.5) * 0.8, 0.012));
    // contact shadow: a dark ellipse under the blob's footprint, so the hold grows out of the rock
    const fp = footprint.get(hold.id) || { sx: 1.3, sy: 0.75, rot: 0 };
    skirtGeos.push(conformedPatch(hold.x, hold.y - hold.size * 0.12, hold.size * 2.4 * fp.sy, 4, fp.rot, 0.008, fp.sx / fp.sy));
  }
  // --- decoys: the same rock, but each one is its own mesh so it can fall away when it gives ---
  // They are cut from the prototypes too, with the per-hold shade on a cloned material instead of
  // an instance colour, so a decoy is still pixel-for-pixel a hold until you weigh it.
  const fakeParts = [];
  {
    const m = new THREE.Matrix4();
    for (const f of fakes) {
      const g = new THREE.Group();
      const proto = protos[protoOf(f)];
      const r = holdRnd(f);
      footprint.set(f.id, instanceMatrix(f, proto, r, m));
      const mat = holdMat.clone();
      const shade = (0.82 + r() * 0.2) / SHADE_MEAN;    // the prototype already carries SHADE_MEAN
      mat.color.setRGB(shade * (0.96 + r() * 0.08), shade * (0.96 + r() * 0.08), shade * (0.96 + r() * 0.08));
      const blob = new THREE.Mesh(proto.geo, mat);
      m.decompose(blob.position, blob.quaternion, blob.scale);
      blob.castShadow = true; blob.receiveShadow = true;
      blob.userData.holdBucket = 'holds';
      g.add(blob);
      root.add(g);
      fakeParts.push({ fake: f, group: g, blob, fall: 0, vy: 0, spin: (rnd() - 0.5) * 4 });
    }
  }

  if (skirtGeos.length) {
    const skirtMat = new THREE.MeshBasicMaterial({
      map: skirtTex, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const skirtMesh = new THREE.Mesh(mergeGeometries(skirtGeos, false), skirtMat);
    skirtMesh.name = 'hold-skirts';
    skirtMesh.renderOrder = 0;
    skirtMesh.userData.holdBucket = 'holds';
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
    chalkMesh.userData.holdBucket = 'holds';
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
  // `up` biases the throw upward: a decoy sheds grit downward out of its socket (the default), a
  // body hitting the ground kicks it up out of the dirt (B53).
  function burstDust(x, y, z, up = 0) {
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
      dustVel[k + 1] = Math.sin(a) * sp * 0.55 - 0.25 + up; // biased downward: the rock is falling
      dustVel[k + 2] = 0.25 + Math.random() * 0.5;          // out of the face, toward the climber
      dustAge[i] = 0;
      dustLife[i] = 0.55 + Math.random() * 0.55;
      dust.alphas[i] = 0;
    }
    dustLive = DUST_MAX;                 // let the update loop find the dead ones itself
  }

  // B43: there is no rope. The climber's strand, the anchor ring at the summit and the belay line
  // down the face all lived here; Maor had the rope removed after playing it, and a top-rope rig
  // hanging on the wall would promise a save that no longer exists.

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

  // =========================================================================================
  // B53 — THE GROUND. Everything from here to END OF GROUND is the floor of the world.
  //
  // WHY IT IS AT -0.55. The sim's `CFG.FLOOR` (0.75) is the body point — the SHOULDER — when you
  // stand at the base with nothing held, and the eye sits at body.y + 0.30. So the dirt has to be
  // a shoulder's height below FLOOR, not at it: GROUND.y = FLOOR - 1.30 puts the standing eye at
  // 1.05, which is 1.60 m above the open terrace and 1.40 m above the scree banked against the
  // rock — a person, either way. Anything shallower and the climber is a child staring at his own
  // knees, and the start holds at y ≈ 1.2 stop reading as something you reach up to. It is the far
  // end of the range the row allowed (FLOOR minus 0.75 to 1.30), taken because that is the end
  // where the numbers come out as a human.
  //
  // WHY THERE IS NO SEAM. Nothing is skirted and `wallZ` is untouched: the wall plane already runs
  // from y = -8 to 43.5 (WALL.height/yCenter), so it passes 7.45 m THROUGH the ground and out the
  // bottom. The join is a real intersection, and what sells it is scree — the ground banks up
  // against the rock (GROUND.talus) and darkens into the corner (the vertex colours below).
  const GROUND = {
    y: -0.55,
    halfX: 15, back: -6, front: 24,   // 30 × 30 m: under the whole 9 m face, out past the camera
    seg: 96,                          // 0.31 m cells — the near ground is where you die
    tile: WALL.tile,                  // the same 3 m of stone as the wall, and the same textures
    rim: 3.4,                         // the outer ring of the terrace falls away into the cloud sea
    rimFrom: 0.72,                    // ...starting at this fraction of the half-extent
    talus: 0.12, talusRun: 1.4,       // scree banked against the foot of the rock. Kept small on
                                      // purpose: it is banked exactly where the climber stands, so
                                      // every centimetre of it comes off his height
    boulders: 12,                     // ONE InstancedMesh of ONE prototype. Measured at tier phone:
                                      // the whole ground is +3 draw calls and +30,432 triangles
                                      // standing at the base (the third call is the boulders' own
                                      // shadow pass), +1 and +18,432 from 12 m up, nothing above ~20
  };
  const GROUND_ZMID = (GROUND.back + GROUND.front) / 2;
  const GROUND_ZHALF = (GROUND.front - GROUND.back) / 2;
  // How far a point on the terrace is toward the edge, 0 at the middle and 1 at the rim.
  function groundEdge(x, z) {
    return Math.max(Math.abs(x) / GROUND.halfX, Math.abs(z - GROUND_ZMID) / GROUND_ZHALF);
  }
  // The ground's surface. Three octaves of the same noise the wall is made of, plus the talus, less
  // the rim roll-off. Exported on `world` so the camera knows where to put a head that has landed.
  function groundAt(x, z) {
    let h = GROUND.y
      + 0.155 * noise.noise(x * 0.11 + 210, z * 0.11 - 90)
      + 0.070 * noise.noise(x * 0.43 + 60, z * 0.43 + 130)
      + 0.028 * noise.noise(x * 1.35 + 5, z * 1.35 + 22);
    const out = Math.max(0, z - wallZ(x, GROUND.y));          // metres out from the rock face
    h += GROUND.talus * Math.exp(-Math.pow(out / GROUND.talusRun, 2));
    const rim = smoothstep(GROUND.rimFrom, 1, groundEdge(x, z));
    return h - GROUND.rim * rim * rim;
  }
  // The camera rig is handed `world.wallZ` by the integrator and nothing else, so the one number it
  // needs from down here rides along on the function. (CONTRACTS: world-light → arms-camera.)
  wallZ.groundY = GROUND.y;

  const groundGeo = new THREE.PlaneGeometry(GROUND.halfX * 2, GROUND_ZHALF * 2, GROUND.seg, GROUND.seg);
  groundGeo.rotateX(-Math.PI / 2);
  groundGeo.translate(0, 0, GROUND_ZMID);
  {
    const pos = groundGeo.attributes.position;
    const uv = groundGeo.attributes.uv;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, groundAt(x, z));
      uv.setXY(i, x / GROUND.tile, z / GROUND.tile);
      // Dust and bare stone in patches, fine grit over both, the corner at the foot of the wall in
      // shadow (this is what hides the join more than any geometry does), the rim rolling to dark.
      const patch = smoothstep(-0.15, 0.45, noise.noise(x * 0.33 + 410, z * 0.33 - 260));
      const grit = 0.5 + 0.5 * noise.noise(x * 1.7 + 13, z * 1.7 + 77);
      const out = Math.max(0, z - wallZ(x, GROUND.y));
      let k = (0.68 + 0.30 * patch) * (0.90 + 0.10 * grit);
      // The corner has to be dark enough to read as a corner and no darker: it is the first metre
      // in front of the climber's boots and the last thing he sees, and at 0.55 over 0.9 m the
      // ground he lands on came out nearly black.
      k *= 1 - 0.34 * Math.exp(-Math.pow(out / 0.7, 2));
      k *= 1 - 0.40 * smoothstep(GROUND.rimFrom, 1, groundEdge(x, z));
      // Dust is paler and greyer than the wall's iron red; bare stone keeps the wall's own colour,
      // which is what stops the floor reading as more wall lying down.
      col[i * 3] = lerp(0.99, 1.10, patch) * k;
      col[i * 3 + 1] = lerp(0.95, 1.07, patch) * k;
      col[i * 3 + 2] = lerp(0.91, 1.05, patch) * k;
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    groundGeo.setAttribute('uv1', new THREE.BufferAttribute(uv.array.slice(), 2));
    groundGeo.computeVertexNormals();
    groundGeo.computeBoundingSphere();
  }
  // The same material as the wall, so the ground is the same stone under the same dusk → night
  // schedule with no second copy of it: env.update drives the lights, the fog and the exposure, and
  // this picks all three up for free. Only the normal scale drops — the wall is read head-on, the
  // ground at a grazing angle, where 1.45 boils into sparkle.
  const groundMat = wallMat.clone();
  groundMat.normalScale = new THREE.Vector2(0.85, 0.85);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'ground';
  ground.receiveShadow = true;      // no castShadow: there is nothing under it to cast onto
  ground.matrixAutoUpdate = false;
  root.add(ground);

  // Scree and boulders, so the floor is not a carpet. Twelve instances of ONE hold prototype — the
  // sloper family, the one with the least chalk on it — laid on its back so the blob's flat front
  // face is the weathered top and its stretched back is buried. One draw call for all twelve.
  let boulders = null;
  {
    const proto = protos[FAMILY_OF.sloper * PROTO.variants];
    const brnd = mulberry32(seed * 2654435761 + 991);
    const mesh = new THREE.InstancedMesh(proto.geo, holdMat, GROUND.boulders);
    mesh.name = 'ground-boulders';
    mesh.castShadow = true; mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const lay = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const c = new THREE.Color();
    for (let i = 0; i < GROUND.boulders; i++) {
      // The first five are scree banked into the corner where the ground meets the rock; the rest
      // are boulders out on the terrace, kept back from where the climber lands so a rock cannot
      // end up inside the lens on the last frame of a fall.
      const near = i < 5;
      const x = (brnd() - 0.5) * (near ? 11 : 22);
      const z = near ? wallZ(x, GROUND.y) + 0.18 + brnd() * 0.75
        : (Math.abs(x) < 3.2 ? 2.6 : 1.5) + brnd() * 6.5;
      const size = near ? 0.15 + brnd() * 0.16 : 0.34 + brnd() * 0.5;
      p.set(x, groundAt(x, z) + size * 0.14, z);
      q.setFromEuler(new THREE.Euler((brnd() - 0.5) * 0.36, brnd() * Math.PI * 2, (brnd() - 0.5) * 0.36, 'YXZ'));
      q.multiply(lay);
      s.set(size * (0.9 + brnd() * 0.4), size * (0.9 + brnd() * 0.4), size * (0.7 + brnd() * 0.5));
      mesh.setMatrixAt(i, m.compose(p, q, s));
      // duller and a shade cooler than the rock on the wall: these have been down here in the shade
      const k = 0.60 + brnd() * 0.28;
      c.setRGB(k * 0.98, k, k * 1.06);
      mesh.setColorAt(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    root.add(mesh);
    boulders = mesh;
  }
  // END OF GROUND ===========================================================================

  // ---------------------------------------------------------------------------------------
  // Per-frame
  let t = 0;
  let routeRef = null;
  let shadowY = Infinity;                 // body height the shadow-band counts were cut for
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

    // The shadow band moves with the climber, a quarter metre at a time — a binary search per
    // instanced mesh, not per hold, and only when the body has actually gone somewhere.
    if (holdMeshes.length && Math.abs(body.y - shadowY) > 0.25) {
      shadowY = body.y;
      updateShadowCounts(body.y);
    }

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

    // --- B53: the ground ---------------------------------------------------------------------
    // Two things only. (1) The ground you hit: the sim's `impact` is the frame the body reaches
    // CFG.FLOOR, and it throws a puff of grit out of the dirt from the existing dust pool — the
    // screen is cutting to black over the next 80 ms, and this is what the last of those frames
    // shows. `grounded` (letting go with your feet on the ground) never fires `impact`, so it
    // never puffs. (2) The boulders leave the shadow pass once the climber is above the shadow
    // camera's box, exactly as the holds do; the ground plane itself is never hidden, because
    // looking down the drop from 30 m up is the whole point of it being there.
    if (events && events.length) {
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (!e || e.type !== 'impact') continue;
        const gz = wallZ(body.x, GROUND.y) + 0.85;      // half a metre past the eye, not in it
        burstDust(body.x, groundAt(body.x, gz) + 0.08, gz, 1.1);
      }
    }
    if (boulders) boulders.castShadow = body.y < GROUND.y + PROTO.shadowBand;

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
    // B53: the floor of the world. `groundY` is the nominal plane the row settled on; `groundAt`
    // is the surface itself (relief + the talus banked against the rock), for anything that has to
    // put something down on it. The camera reads `wallZ.groundY`, which is the same number.
    groundY: GROUND.y, groundAt, ground, boulders,
    // `holds` is the group the instanced rock hangs in (B52); `holdMeshes` is one InstancedMesh
    // per prototype blob, in case anything ever needs to reach past the group.
    env, root, wall, holds: holdsGroup, holdMeshes, chalk: chalkMesh, runes, altar, waymarks: waymarkMesh, embers, hoverRings,
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
