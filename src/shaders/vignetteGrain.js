// Vignette + film grain. Runs inside the EffectComposer *before* the OutputPass, so it works in
// linear HDR light: grain is added in scene-referred units and the vignette darkens radiance,
// which keeps highlights clean after ACES tone mapping. `time` must advance every frame so the
// grain re-seeds; `resolution` is the drawing-buffer size in pixels.
import { Vector2 } from 'three';

export const VignetteGrainShader = {
  name: 'VignetteGrainShader',

  uniforms: {
    tDiffuse:     { value: null },
    time:         { value: 0 },
    resolution:   { value: new Vector2(1, 1) },
    vignette:     { value: 0.38 },   // how dark the corners get (0 = off, 1 = black corners)
    vignetteEdge: { value: 0.30 },   // frame-space radius where the fall-off starts (corner ≈ 0.707)
    grain:        { value: 0.045 },  // grain amplitude in linear light
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform vec2 resolution;
    uniform float vignette;
    uniform float vignetteEdge;
    uniform float grain;
    varying vec2 vUv;

    // Integer-free hash (Dave Hoskins) — stable on mobile GPUs where sin()-based noise banding shows.
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      // Film grain: one hash per pixel per frame, weighted toward the midtones so deep shadow and
      // the bloomed runes stay clean instead of fizzing.
      vec2 gp = gl_FragCoord.xy + vec2(fract(time * 13.7) * 311.0, fract(time * 7.3) * 197.0);
      float n = hash12(gp) - 0.5;
      float luma = clamp(dot(color.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
      float weight = 0.25 + 0.75 * (1.0 - abs(luma * 2.0 - 1.0));
      color.rgb += n * grain * weight;

      // Vignette in frame space, so the darkening hugs the corners of a portrait frame as well.
      float d = length(vUv - 0.5);
      float v = smoothstep(vignetteEdge, 0.78, d);
      color.rgb *= 1.0 - vignette * v;

      gl_FragColor = color;
    }
  `,
};
