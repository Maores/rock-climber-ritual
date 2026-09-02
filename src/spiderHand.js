// src/spiderHand.js — the unlockable glove, painted onto the hand the climber already has.
//
// No third-party costume mesh ships with this game. The webbing is generated in the shader from
// the hand's own object-space position, so it wraps fingers and knuckles correctly whatever the
// model's UV layout does, and it is RAISED: the web lines perturb the normal, so they catch the
// low sun the same way real piping on a suit does.
//
// The palette was sampled from a photogrammetry scan of an actual Spider-Man figure
// (assets/models/spider/tex_a0.jpg): shaded averages came back #932526 red, #2a3f64 blue and
// #2a2930 for the webbing, which are lifted here to albedo values.
//
//   applySpiderSkin(root, { variant })   // 'classic' | 'stealth'
//
// Variants share one shader; only the colours and the emissive strength differ.

import * as THREE from 'three';

export const SPIDER_VARIANTS = {
  classic: {
    label: 'Classic red and blue',
    red: 0xb01f2a,          // scan red, lifted out of shadow
    blue: 0x2a4a8c,         // wrist cuff
    web: 0x14151b,          // near-black piping
    glow: 0x000000,
    glowStrength: 0.0,
    roughness: 0.52,
    sheen: 0.22,
  },
  stealth: {
    label: 'Stealth, teal webbing',
    red: 0x11182c,
    blue: 0x0c1120,
    web: 0x0a0d16,
    glow: 0x7fe0ff,
    glowStrength: 1.35,
    roughness: 0.44,
    sheen: 0.3,
  },
};

// The model's fingers run along +X and the palm faces +Y (measured from the GLB's bounding box:
// 2.65 x 0.57 x 1.64). CUFF_AT is where along that finger axis the blue wrist band begins, as a
// fraction of the hand's length measured from the fingertips.
const CUFF_AT = 0.90;

const WEB = /* glsl */`
  // Line mask from a repeating coordinate: 1 on the cord, 0 between.
  float cord(float q, float width) {
    float f = abs(fract(q) - 0.5);
    return smoothstep(width, 0.0, f);
  }

  // The real glove is not a uniform mesh. The back of the hand carries a spider web: straight
  // spokes fanning out from a point near the wrist, crossed by arcs that bow between them. Each
  // finger instead carries rings around it. fingerT runs 0 at the wrist to 1 at the fingertips.
  float webHeight(vec3 pos, vec3 nrm, float fingerT, vec2 centre, float spokes, float ringGap, float bandGap, float width) {
    vec2 d = vec2(pos.x, pos.z) - centre;
    float ang = atan(d.y, d.x);
    float rad = length(d);

    // spokes: constant angle. arcs: constant radius, bowed slightly between spokes so they sag
    // the way a real web does instead of reading as clean circles.
    // Fade the spokes out as they converge, or they pile into a hub the real glove has not got.
    float hub = smoothstep(ringGap * 0.35, ringGap * 1.15, rad);
    float spoke = cord(ang * spokes / 6.2831853, width * 0.55) * hub;
    float sag = 1.0 - 0.09 * abs(sin(ang * spokes * 0.5));
    float arc = cord(rad * sag / ringGap, width);
    float palm = max(spoke, arc);

    // fingers: rings around the digit, so the cord crosses the knuckles
    float band = cord(pos.x / bandGap, width * 1.15);

    float k = smoothstep(0.56, 0.70, fingerT);
    return mix(palm, band, k);
  }
`;

/**
 * Repaint every mesh under `root` as the spider glove.
 * Returns a dispose() that restores nothing (callers clone the hand first).
 */
export function applySpiderSkin(root, { variant = 'classic', width = 0.075, bump = 0.16 } = {}) {
  const v = SPIDER_VARIANTS[variant] || SPIDER_VARIANTS.classic;
  const red = new THREE.Color(v.red).convertSRGBToLinear();
  const blue = new THREE.Color(v.blue).convertSRGBToLinear();
  const web = new THREE.Color(v.web).convertSRGBToLinear();
  const glow = new THREE.Color(v.glow).convertSRGBToLinear();

  // The cuff needs the hand's own extent along the finger axis, so measure it once.
  const box = new THREE.Box3().setFromObject(root, true);
  const min = box.min.clone(), max = box.max.clone();
  const span = Math.max(1e-4, max.x - min.x);
  const cuffX = min.x + span * CUFF_AT;

  const materials = [];
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const src = Array.isArray(o.material) ? o.material[0] : o.material;

    // The web lives in the mesh's OWN object space, whose units depend on how the model was
    // exported (a glTF root node often carries a scale). Size a diamond off the geometry's own
    // bounding box so the mesh reads the same whatever those units are.
    const geo = o.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const gs = geo.boundingBox.getSize(new THREE.Vector3());
    // ...and the cuff sits along the geometry's longest axis, which is the finger axis.
    const gMinX = geo.boundingBox.min.x;
    const cuffXLocal = gMinX + gs.x * CUFF_AT;

    const m = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      normalMap: src && src.normalMap ? src.normalMap : null,   // keep the model's skin creases
      normalScale: new THREE.Vector2(0.35, 0.35),
      roughness: v.roughness,
      metalness: 0.0,
      sheen: v.sheen,
      sheenColor: new THREE.Color(0xffffff),
      clearcoat: 0.05,
      clearcoatRoughness: 0.6,
    });
    if (v.glowStrength > 0) {
      m.emissive = new THREE.Color(v.glow);
      m.emissiveIntensity = v.glowStrength;
    }

    m.userData.spider = {
      width: { value: width }, bump: { value: bump },
      centre: { value: new THREE.Vector2(geo.boundingBox.max.x - gs.x * 0.30, (geo.boundingBox.min.z + geo.boundingBox.max.z) * 0.5) },
      spokes: { value: 9.0 },
      ringGap: { value: gs.x / 14.0 },
      bandGap: { value: gs.x / 30.0 },
      tipX: { value: geo.boundingBox.max.x }, spanX: { value: Math.max(1e-6, gs.x) },
      red: { value: red }, blue: { value: blue }, webCol: { value: web },
      glow: { value: glow }, glowK: { value: v.glowStrength },
      cuffX: { value: cuffXLocal }, cuffFade: { value: Math.max(1e-5, gs.x * 0.04) },
    };

    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, m.userData.spider);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vSpiderPos;
          varying vec3 vSpiderNrm;`)
        // `transformed` and `objectNormal` are the skinned position/normal in object space, which
        // is what we want: the web must ride along with the fingers as they curl.
        .replace('#include <skinning_vertex>', `#include <skinning_vertex>
          vSpiderPos = transformed;
          vSpiderNrm = normalize(objectNormal);`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vSpiderPos;
          varying vec3 vSpiderNrm;
          uniform float width; uniform float bump;
          uniform vec2 centre; uniform float spokes; uniform float ringGap; uniform float bandGap;
          uniform float tipX; uniform float spanX;
          uniform vec3 red; uniform vec3 blue; uniform vec3 webCol; uniform vec3 glow;
          uniform float glowK; uniform float cuffX; uniform float cuffFade;
          ${WEB}`)
        // base colour: red over the glove, blue over the wrist cuff, web black on the lines
        .replace('#include <color_fragment>', `#include <color_fragment>
          float fingerT = clamp((tipX - vSpiderPos.x) / spanX, 0.0, 1.0);
          float spiderH = webHeight(vSpiderPos, vSpiderNrm, fingerT, centre, spokes, ringGap, bandGap, width);
          float cuff = smoothstep(cuffX - cuffFade, cuffX + cuffFade, vSpiderPos.x);
          vec3 spiderBase = mix(red, blue, cuff);
          diffuseColor.rgb = mix(spiderBase, webCol, spiderH);`)
        // the cord itself is matte, so it reads as stitching rather than wet plastic
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.92, spiderH);`)
        // raised piping: bend the normal along the ridge so the light rakes across it
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            float h = spiderH;
            vec3 dpdx = dFdx(-vViewPosition);
            vec3 dpdy = dFdy(-vViewPosition);
            float dhdx = dFdx(h), dhdy = dFdy(h);
            vec3 r1 = cross(dpdy, normal);
            vec3 r2 = cross(normal, dpdx);
            float det = dot(dpdx, r1);
            vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
            normal = normalize(abs(det) * normal - bump * grad);
          }`);

      if (v.glowStrength > 0) {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            totalEmissiveRadiance = glow * glowK * spiderH;`);
      }
    };
    m.customProgramCacheKey = () => 'spider-' + variant;

    o.material = m;
    o.frustumCulled = false;
    materials.push(m);
  });

  return {
    materials,
    dispose() { for (const m of materials) m.dispose(); },
  };
}
