import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// ---------------------------------------------------------------------------
// postfx.js — the lens. Owned by the POSTFX agent.
//
// Chain: RenderPass
//     -> UnrealBloomPass  (linear HDR, high threshold: haloes neon cores only)
//     -> OutputPass       (ACES filmic + sRGB, into the chain buffer)
//     -> ExposurePass     (measures frame body luma into a 1x1 target)
//     -> FilmGradePass    (display-referred BR2049 grade: haze-compensating
//                          saturation, split tone, contrast + soft shoulder,
//                          vignette, fine grain, sub-pixel CA, anamorphic
//                          streak, teal black lift)
//
// The grade runs AFTER tone mapping on purpose: lift / contrast / grain are
// display-referred film operations, and grain doubles as dither against
// banding in the near-black the art direction lives in.
//
// TWO RULES LEARNED THE HARD WAY, both about isolated coloured pixels:
//
//  1. Chromatic aberration must stay SUB-PIXEL. An earlier version offset the
//     R and B taps by ~4px at the frame corners. The scene is full of 1px-wide
//     rain streaks, so every streak in the outer frame was torn into a separate
//     red line and a separate blue line — measured 0.41% of all pixels as
//     isolated chroma excursions. CA is now specified in PIXELS (uCA) and
//     capped below one, so the buffer's linear filtering makes it a smooth
//     fringe that can never separate a thin feature into coloured copies.
//
//  2. Never threshold a bright-pass PER CHANNEL. `max(rgb - k, 0)` on a
//     saturated magenta sign passes R and B but kills G, so the streak taps
//     scattered pure-magenta and pure-green ghosts. The streak now keys off
//     LUMA with a soft knee and carries a desaturated version of the source
//     colour, so it elongates a highlight instead of colour-separating it.
// ---------------------------------------------------------------------------

// Luma clip used by the exposure probe. Anything brighter than this is
// treated as "neon island" and does not count toward the frame's body
// brightness — a few hot signs must never stop down the whole image.
const BODY_CLIP = 0.55;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// --- exposure probe: full frame -> 16x9 -> 1x1 -----------------------------
// Cost is ~9k texture fetches total, i.e. nothing, and it makes the grade
// robust to whatever the scene modules do upstream instead of being tuned
// against one camera preset.

const DownsampleShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 16, 1 / 9) },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      // 8x8 stratified taps across this output texel's footprint, each tap's
      // luma clipped before accumulation so highlights cannot drag the mean.
      float acc = 0.0;
      for (int j = 0; j < 8; j++) {
        for (int i = 0; i < 8; i++) {
          vec2 o = ((vec2(float(i), float(j)) + 0.5) / 8.0 - 0.5) * uTexel;
          vec3 c = texture2D(tDiffuse, vUv + o).rgb;
          acc += min(dot(c, vec3(0.2126, 0.7152, 0.0722)), ${BODY_CLIP});
        }
      }
      // normalise into 0..1 so the 8-bit target uses its full range
      float v = (acc / 64.0) / ${BODY_CLIP};
      gl_FragColor = vec4(v, v, v, 1.0);
    }
  `,
};

const ReduceShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      float acc = 0.0;
      for (int j = 0; j < 9; j++) {
        for (int i = 0; i < 16; i++) {
          acc += texture2D(tDiffuse, (vec2(float(i), float(j)) + 0.5) / vec2(16.0, 9.0)).r;
        }
      }
      float v = acc / 144.0;
      gl_FragColor = vec4(v, v, v, 1.0);
    }
  `,
};

class ExposurePass extends Pass {
  constructor() {
    super();
    this.needsSwap = false; // read-only probe: leaves the chain buffers alone

    const rtOpts = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.rtSmall = new THREE.WebGLRenderTarget(16, 9, rtOpts);
    this.rtAvg = new THREE.WebGLRenderTarget(1, 1, rtOpts);

    this.matDown = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(DownsampleShader.uniforms),
      vertexShader: DownsampleShader.vertexShader,
      fragmentShader: DownsampleShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.matReduce = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(ReduceShader.uniforms),
      vertexShader: ReduceShader.vertexShader,
      fragmentShader: ReduceShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quadDown = new FullScreenQuad(this.matDown);
    this.quadReduce = new FullScreenQuad(this.matReduce);

    // ?fxdebug=1 reads the 1x1 result back so the measured value can be
    // inspected from the page. Off by default — no readback, no stall.
    this.debug =
      typeof location !== 'undefined' && location.search.indexOf('fxdebug') >= 0;
    this._px = new Uint8Array(4);
  }

  get texture() {
    return this.rtAvg.texture;
  }

  render(renderer, writeBuffer, readBuffer) {
    const prev = renderer.getRenderTarget();

    this.matDown.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.rtSmall);
    this.quadDown.render(renderer);

    this.matReduce.uniforms.tDiffuse.value = this.rtSmall.texture;
    renderer.setRenderTarget(this.rtAvg);
    this.quadReduce.render(renderer);

    renderer.setRenderTarget(prev);

    if (this.debug) {
      renderer.readRenderTargetPixels(this.rtAvg, 0, 0, 1, 1, this._px);
      window.__POSTFX_AVG__ = +((this._px[0] / 255) * BODY_CLIP).toFixed(4);
    }
  }

  dispose() {
    this.rtSmall.dispose();
    this.rtAvg.dispose();
    this.matDown.dispose();
    this.matReduce.dispose();
    this.quadDown.dispose();
    this.quadReduce.dispose();
  }
}

// --- the grade -------------------------------------------------------------

const FilmGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAvgTex: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1600, 900) },

    // auto-exposure: normalises the frame's BODY brightness so the grade is
    // robust to upstream haze/fog changes instead of tuned for one shot.
    // Measured pre-grade body luma of the four presets was
    //   street .153  canyon .134  aerial .168  alley .293
    // i.e. the alley was carrying more than twice the canyon's haze load.
    // Target sits at the street/canyon level; K<1 is a PARTIAL correction so
    // the presets keep their relative character instead of being flattened
    // to one exposure.
    uAvgTarget: { value: 0.17 },  // desired body luma, display-referred
    uAvgK: { value: 0.92 },       // partial correction: keeps shot-to-shot variety
    uGainMin: { value: 0.5 },
    uGainMax: { value: 1.2 },

    // Extra contrast applied ONLY to a frame the probe says is milky, i.e.
    // one the auto-exposure had to pull down hard. A wide dark vista (aerial)
    // must not get this — it is already at the shadow ceiling.
    uMilkAt: { value: 0.85 },     // exposure gain below which "milky" starts
    uMilkRange: { value: 0.3 },
    uGammaMilk: { value: 0.22 },  // extra gamma at full milk

    // lens — each at the edge of perception
    // MAX chromatic aberration in PIXELS. Keep well under 1: this scene is
    // full of 1px-wide rain streaks, which is the pathological input for CA.
    // Verified by cropping the frame CENTRE (where this term is exactly zero)
    // — streaks there are clean, so any fringe seen elsewhere is this value.
    uCA: { value: 0.35 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.026 },
    uGrainTint: { value: new THREE.Vector3(0.92, 0.98, 1.06) }, // cool grain cast
    uStreak: { value: 0.16 },      // anamorphic streak gain
    uStreakThresh: { value: 0.78 },// LUMA knee for the streak bright-pass

    // grade
    uSatShadow: { value: 1.22 },   // haze washes the low mids to pastel: undo it
    uSatHigh: { value: 1.0 },
    uShadowTint: { value: new THREE.Vector3(0.90, 1.0, 1.09) },
    uHighTint: { value: new THREE.Vector3(1.06, 1.005, 0.945) },
    uGamma: { value: 1.18 },       // contrast: deepens below the crossover...
    uCross: { value: 0.56 },       // ...and lifts above it. Gain is derived so
                                   // this pivot stays pinned as gamma adapts.
    uShoulder: { value: 0.93 },    // whites roll off asymptotically, never clip flat
    uLift: { value: new THREE.Vector3(0.010, 0.015, 0.026) }, // teal black floor
  },

  vertexShader: VERT,

  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D uAvgTex;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uAvgTarget, uAvgK, uGainMin, uGainMax;
    uniform float uMilkAt, uMilkRange, uGammaMilk;
    uniform float uCA, uVignette, uGrain, uStreak, uStreakThresh;
    uniform float uSatShadow, uSatHigh, uGamma, uCross, uShoulder;
    uniform vec3 uShadowTint, uHighTint, uLift, uGrainTint;
    varying vec2 vUv;

    const vec3 W = vec3(0.2126, 0.7152, 0.0722);
    float luma(vec3 c) { return dot(c, W); }

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 dir = (uv - 0.5) * 2.0;        // -1..1 across the frame
      float r2 = dot(dir, dir);           // 0 centre .. 2 corner

      // --- auto-exposure -------------------------------------------------
      // Body luma of this frame, highlight-clipped, measured by ExposurePass.
      float body = texture2D(uAvgTex, vec2(0.5)).r * ${BODY_CLIP};
      float expo = clamp(
        pow(uAvgTarget / max(body, 0.005), uAvgK), uGainMin, uGainMax);

      // --- lateral chromatic aberration ----------------------------------
      // Offset is in PIXELS and capped below 1, so with the buffer's linear
      // filtering this is always a smooth sub-pixel fringe. It can never
      // split a 1px rain streak into isolated red and blue copies.
      vec2 caOff = dir * min(r2, 1.0) * uCA / uResolution;
      vec3 col;
      col.r = texture2D(tDiffuse, uv - caOff).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + caOff).b;
      col *= expo;

      // --- anamorphic streak ---------------------------------------------
      // Dense taps (2.6px apart, ~16px reach) so this reads as a horizontal
      // elongation of a highlight, not ghost copies. Keyed on LUMA with a
      // soft knee and carried at reduced saturation: a per-channel threshold
      // here is what used to scatter magenta and green dots.
      vec3 streak = vec3(0.0);
      float wSum = 1e-5;
      float px = 1.0 / uResolution.x;
      for (int i = 1; i <= 6; i++) {
        float fi = float(i);
        float o = fi * 2.6 * px;
        float w = exp(-fi * fi * 0.10);
        vec3 a = texture2D(tDiffuse, vec2(uv.x + o, uv.y)).rgb;
        vec3 b = texture2D(tDiffuse, vec2(uv.x - o, uv.y)).rgb;
        float ka = smoothstep(uStreakThresh, uStreakThresh + 0.20, luma(a));
        float kb = smoothstep(uStreakThresh, uStreakThresh + 0.20, luma(b));
        // desaturate the carried colour by half — a flare takes the hue of
        // its source but never its full chroma
        a = mix(vec3(luma(a)), a, 0.5);
        b = mix(vec3(luma(b)), b, 0.5);
        streak += w * (a * ka + b * kb);
        wSum += 2.0 * w;
      }
      col += (streak / wSum) * uStreak * expo * vec3(0.72, 0.86, 1.0);

      float l = luma(col);

      // --- haze-compensating saturation ----------------------------------
      // Dense wet haze desaturates the low mids toward pastel lavender. Push
      // chroma back there, and NOT in the highlights, so neon cores stay hot
      // and white-hearted rather than turning to candy.
      float hi = smoothstep(0.04, 0.75, l);
      col = mix(vec3(l), col, mix(uSatShadow, uSatHigh, hi));

      // --- split tone: teal shadows, faintly warm highlights --------------
      col *= mix(uShadowTint, uHighTint, smoothstep(0.10, 0.72, l));

      // --- contrast -------------------------------------------------------
      // Gamma deepens below uCross and the derived gain lifts above it. A
      // frame the probe found milky (exposure had to pull it down hard) gets
      // extra gamma to break up the flat haze mass; a frame that is already
      // dark and contrasty gets none, so this cannot over-crush the vistas.
      float milk = clamp((uMilkAt - expo) / uMilkRange, 0.0, 1.0);
      float gam = uGamma + milk * uGammaMilk;
      col = pow(max(col, 0.0), vec3(gam)) * pow(uCross, 1.0 - gam);

      // --- soft shoulder: slope 1 at the join, asymptotic to white --------
      vec3 d = max(col - uShoulder, 0.0);
      col = min(col, uShoulder) + (1.0 - uShoulder) * d / (d + (1.0 - uShoulder));

      // --- vignette -------------------------------------------------------
      col *= 1.0 - uVignette * smoothstep(0.35, 2.0, r2);

      // --- fine film grain (also dithers the darks against banding) -------
      // STRICTLY monochrome, from a single hash: independent per-channel
      // noise is itself a source of coloured speckle, which is the artifact
      // this pass exists to avoid. The cool cast is a constant tint, not
      // noise, so it costs nothing and cannot speckle.
      float t = fract(uTime * 0.7);
      float n = hash12(uv * uResolution + vec2(t * 251.0, t * 127.0)) * 2.0 - 1.0;
      col += n * uGrainTint * uGrain * mix(1.0, 0.30, smoothstep(0.0, 0.55, l));

      // --- lifted blacks LAST: the floor survives vignette and grain, so
      // near-black stays a cold teal rather than a dead 0. Clamp first so a
      // negative grain excursion cannot undercut the lift.
      col = uLift + max(col, 0.0) * (1.0 - uLift);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

export function buildPostFX({ scene, camera, renderer }) {
  const size = renderer.getSize(new THREE.Vector2());

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Tight bloom: haloes hot neon cores, never lifts broad areas. Threshold is
  // in LINEAR HDR (tone mapping happens later in OutputPass), so >1 means
  // "only things already brighter than diffuse white". Small radius keeps the
  // glow local instead of turning haze into milk.
  // Half-res input keeps SwiftShader fill cost down; bloom is a blur anyway.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(Math.round(size.x / 2), Math.round(size.y / 2)),
    0.55, // strength
    0.30, // radius
    1.05, // threshold
  );
  // Composer re-calls pass.setSize(fullW, fullH) on addPass/resize — keep
  // bloom's internal pyramid at half res regardless.
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSetSize(Math.round(w / 2), Math.round(h / 2));
  composer.addPass(bloom);

  // Tone map + sRGB into the chain buffer; grade works display-referred.
  composer.addPass(new OutputPass());

  const exposure = new ExposurePass();
  composer.addPass(exposure);

  const grade = new ShaderPass(FilmGradeShader);
  grade.uniforms.uAvgTex.value = exposure.texture;
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
