// Post chain: RenderPass → UnrealBloomPass → vignette/grain ShaderPass → OutputPass.
// The scene is rendered into a half-float target (MSAA where the tier allows), bloom is thresholded
// on linear HDR radiance so only the runes, the sun and true highlights glow, and the OutputPass
// applies the renderer's tone mapping + sRGB encoding last. The integrator owns renderer settings
// (ACESFilmic, SRGBColorSpace, shadow map type); this module only reads them.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VignetteGrainShader } from './shaders/vignetteGrain.js';

// Bloom is thresholded on linear HDR radiance. At dusk the sunlit rock sits just under the
// threshold so only the runes, the sun glare and true highlights glow; at night the threshold drops
// and the strength rises so the teal glyphs become the brightest, softest things in frame.
const BLOOM = { threshold: 1.1, strength: 0.5, radius: 0.55, nightThreshold: 0.72, nightStrength: 0.78, nightRadius: 0.7 };
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function createPost({ renderer, scene, camera, tier }) {
  let currentTier = tier || { name: 'desktop', bloomScale: 1, antialias: true };
  const cssSize = renderer.getSize(new THREE.Vector2());
  let pixelRatio = renderer.getPixelRatio();
  let time = 0;
  let night = 0;

  // Our own target so we can ask for MSAA: the canvas' own antialias flag is irrelevant once the
  // scene is rendered off-screen. Phones get 2 samples (tile-memory resolve is cheap on Apple GPUs).
  const samples = currentTier.antialias ? (currentTier.name === 'phone' ? 2 : 4) : 0;
  const target = new THREE.WebGLRenderTarget(
    Math.max(1, Math.round(cssSize.x * pixelRatio)),
    Math.max(1, Math.round(cssSize.y * pixelRatio)),
    { type: THREE.HalfFloatType, samples },
  );
  target.texture.name = 'Ritual.scene';

  const composer = new EffectComposer(renderer, target);
  // The composer read the target's pixel size as if it were CSS size; normalise before adding passes.
  composer.setPixelRatio(pixelRatio);
  composer.setSize(cssSize.x, cssSize.y);

  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(bloomResolution(), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  const vignette = new ShaderPass(VignetteGrainShader);
  const output = new OutputPass();

  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(vignette);
  composer.addPass(output);

  applySizes();

  function bloomResolution() {
    const s = currentTier.bloomScale || 1;
    return new THREE.Vector2(
      Math.max(2, Math.round(cssSize.x * pixelRatio * s)),
      Math.max(2, Math.round(cssSize.y * pixelRatio * s)),
    );
  }

  // EffectComposer.setSize hands every pass the full-resolution size; re-apply the bloom scale after.
  function applySizes() {
    const r = bloomResolution();
    bloom.setSize(r.x, r.y);
    vignette.uniforms.resolution.value.set(cssSize.x * pixelRatio, cssSize.y * pixelRatio);
  }

  function resize(w, h) {
    cssSize.set(w, h);
    pixelRatio = renderer.getPixelRatio();
    composer.setPixelRatio(pixelRatio);
    composer.setSize(w, h);
    applySizes();
  }

  function render(dt) {
    time += Math.min(0.1, Math.max(0, dt || 0));
    vignette.uniforms.time.value = time;
    // The integrator may step the pixel ratio down on slow frames; follow it without a resize call.
    if (renderer.getPixelRatio() !== pixelRatio) resize(cssSize.x, cssSize.y);
    composer.render(dt);
  }

  // Dusk → night: bloom takes over as the runes become the brightest things in frame; grain and
  // vignette creep up like a slow film stock.
  function setNight(t01) {
    night = clamp01(t01);
    bloom.threshold = lerp(BLOOM.threshold, BLOOM.nightThreshold, night);
    bloom.strength = lerp(BLOOM.strength, BLOOM.nightStrength, night);
    bloom.radius = lerp(BLOOM.radius, BLOOM.nightRadius, night);
    vignette.uniforms.vignette.value = lerp(0.34, 0.5, night);
    vignette.uniforms.grain.value = lerp(0.035, 0.055, night);
  }

  function setTier(t) {
    currentTier = t || currentTier;
    resize(cssSize.x, cssSize.y);
  }

  setNight(0);

  return {
    render, resize, setNight, setTier,
    composer, bloom, vignette, output,
    get night() { return night; },
    get pixelRatio() { return pixelRatio; },
  };
}
