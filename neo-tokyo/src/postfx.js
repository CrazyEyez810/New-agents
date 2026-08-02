import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------------------
// postfx.js — the lens. Owned by the POSTFX agent.
//
// Chain: RenderPass -> UnrealBloomPass (linear HDR, tight threshold)
//        -> OutputPass (ACES filmic + sRGB, rendered into the chain buffer)
//        -> FilmGradePass (display-referred: BR2049 grade, S-curve, lifted
//           blacks, vignette, animated grain/dither, edge chromatic
//           aberration, faint anamorphic streak on brights).
//
// The grade runs AFTER tone mapping on purpose: lift / S-curve / grain are
// display-referred film operations, and grain doubles as dither against
// banding in the near-black areas the art direction lives in.
// ---------------------------------------------------------------------------

const FilmGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1600, 900) },
    // strengths — each at the edge of perception
    uGrain: { value: 0.038 },        // film grain amplitude in shadows
    uVignette: { value: 0.34 },      // corner darkening
    uAberration: { value: 0.0019 },  // radial CA at frame edges
    uStreak: { value: 0.30 },        // anamorphic horizontal streak gain
    uStreakThresh: { value: 0.72 },  // display-space threshold for streaks
    uLift: { value: new THREE.Vector3(0.012, 0.017, 0.028) }, // blue-lifted blacks
    uShadowTint: { value: new THREE.Vector3(0.905, 1.005, 1.075) }, // teal shadows
    uHighTint: { value: new THREE.Vector3(1.055, 1.005, 0.945) },   // warm highlights
    uCurve: { value: 0.33 },         // S-curve contrast blend
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uAberration;
    uniform float uStreak;
    uniform float uStreakThresh;
    uniform vec3 uLift;
    uniform vec3 uShadowTint;
    uniform vec3 uHighTint;
    uniform float uCurve;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec2 uv = vUv;
      vec2 fromCenter = uv - 0.5;
      float d2 = dot(fromCenter, fromCenter); // 0 center .. 0.5 corner

      // --- chromatic aberration: zero at center, subtle at edges ----------
      vec2 caOff = fromCenter * d2 * uAberration * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, uv - caOff).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + caOff).b;

      // --- faint anamorphic streak: horizontal blur of thresholded brights.
      // Dense linear taps (bloom pre-smooths sources, so this reads as a
      // horizontal elongation of the glow, not ghost copies).
      vec3 streak = vec3(0.0);
      float wSum = 0.0;
      float px = 1.0 / uResolution.x;
      for (int i = 1; i <= 6; i++) {
        float fi = float(i);
        float o = fi * 7.0 * px;
        float w = exp(-fi * 0.35);
        vec3 a = texture2D(tDiffuse, vec2(uv.x + o, uv.y)).rgb;
        vec3 b = texture2D(tDiffuse, vec2(uv.x - o, uv.y)).rgb;
        streak += w * (max(a - uStreakThresh, 0.0) + max(b - uStreakThresh, 0.0));
        wSum += 2.0 * w;
      }
      streak /= wSum;
      col += streak * uStreak * vec3(0.55, 0.75, 1.0);

      // --- BR2049 split tone: teal shadows, slightly warm highlights ------
      float l = luma(col);
      float w = smoothstep(0.10, 0.72, l);
      col *= mix(uShadowTint, uHighTint, w);

      // --- gentle S-curve contrast, biased slightly dark -----------------
      // (midtone gamma keeps haze moody instead of milky; whites survive)
      col = pow(max(col, 0.0), vec3(1.07));
      vec3 s = col * col * (3.0 - 2.0 * col);
      col = mix(col, s, uCurve);

      // --- vignette ------------------------------------------------------
      float vig = 1.0 - uVignette * smoothstep(0.12, 0.62, d2);
      col *= vig;

      // --- animated fine film grain (also dithers the darks) -------------
      float t = fract(uTime * 0.7);
      float n = hash12(uv * uResolution + vec2(t * 251.0, t * 127.0));
      n = n * 2.0 - 1.0;
      float gAmp = uGrain * mix(1.0, 0.28, smoothstep(0.0, 0.55, l));
      col += n * gAmp;

      // --- lifted blacks LAST: guarantees the floor survives vignette
      // and grain — near-black stays milky blue, never pure 0.
      // (clamp first: negative grain excursions must not undercut the lift)
      col = uLift + max(col, 0.0) * (1.0 - uLift);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

export function buildPostFX({ scene, camera, renderer }) {
  const size = renderer.getSize(new THREE.Vector2());

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Tight bloom: halos the neon, never washes the frame.
  // Half-res input keeps SwiftShader cost down; bloom is a blur anyway.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(Math.round(size.x / 2), Math.round(size.y / 2)),
    0.65,  // strength
    0.5,   // radius
    0.8    // threshold (linear HDR, pre-tonemap)
  );
  // Composer re-calls pass.setSize(fullW, fullH) on addPass/resize — keep
  // bloom's internal pyramid at half res regardless.
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSetSize(Math.round(w / 2), Math.round(h / 2));
  composer.addPass(bloom);

  // Tone map + sRGB into the chain buffer; grade works display-referred.
  composer.addPass(new OutputPass());

  const grade = new ShaderPass(FilmGradeShader);
  composer.addPass(grade);

  const setRes = (w, h) => {
    const pr = renderer.getPixelRatio();
    grade.uniforms.uResolution.value.set(w * pr, h * pr);
  };
  setRes(size.x, size.y);

  return {
    render(t) {
      grade.uniforms.uTime.value = t ?? 0;
      composer.render();
    },
    resize(w, h) {
      composer.setSize(w, h);
      setRes(w, h);
    },
  };
}
