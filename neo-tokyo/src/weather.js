import * as THREE from 'three';
import { mulberry32 } from './city.js';

// WEATHER — layered rain, lit splashes, structured vent steam, neon-lit haze.
// Owned by the WEATHER agent. Everything is a pure function of (t, seed):
// motion lives in vertex shaders driven by a uTime uniform, so fixed-t
// screenshots are deterministic and update() allocates nothing.
//
// Street corridor: x in [-9, 9] roadway, walls at x = +-10, z in [-230, 50].
// Scene fog: FogExp2 density 0.0125 — ShaderMaterials here fake their own.
//
// DESIGN NOTE (the thing that makes this read as weather and not as scratched
// film): RAIN IS ONLY VISIBLE WHERE LIGHT IS. The neon in this scene is baked
// into emissive geometry — there are no real point lights to sample — so this
// module carries its own cheap model of the corridor's light field and every
// drop takes BOTH its brightness and its colour from it.
//
// The first build had that architecture and still rendered a flat uniform
// hatch, because the field was dominated by two CONSTANTS: a per-shell
// `ambient` of ~0.2 and a "canyon glow" that covered |x|<19, y 5..44 and
// 100m of z at 0.30/0.44/0.58. Together those put ~0.35/0.47/0.62 of cold
// blue on EVERY drop in frame before a single sign was sampled, so the
// per-probe variation was a few percent of ripple on top of a wall of cyan.
// Dynamic range across streaks was effectively zero and the result was
// screen-space scratches.
//
// The field is now built the other way round: near-zero floor, everything
// earned locally, and a hard contrast curve on top so drops in dark air
// genuinely disappear while drops crossing a beam or a sign flare. Sources:
//   * SIGN BAND   — continuous line source at y~8, both walls, colour cycling
//                   magenta/cyan/sodium down the corridor (kanban run z 8..-116)
//   * ARCADE COVE — continuous line source at y~5.4 under the podium canopies,
//                   temperature alternating along z the way city.js picks it
//   * PROBES      — 16 point pools for the big mid- and high-band installations
//   * BEAMS       — the three atmosphere.js volumetric shafts plus the police
//                   searchlight, as analytic cones. Rain inside a shaft lights.
//   * ROAD BOUNCE — wet asphalt kicking the whole lot back up, low and local.

const SEED = 8811;
const NPROBES = 16;
const NBEAMS = 4;

// ---------------------------------------------------------------------------
// LIGHT FIELD
// ---------------------------------------------------------------------------

// Point pools for the mid/high sign bands and the mega installations.
// x, y, z, radius, r, g, b, intensity. Hotter and tighter than the first pass:
// a pool that reaches 20m at half strength is indistinguishable from ambient.
const PROBES = [
  [8.6, 8.5, 20, 11, 1.00, 0.22, 0.58, 1.55],    // magenta, shopfront run
  [-8.6, 10.5, 11, 11, 0.16, 0.86, 1.00, 1.45],  // cyan
  [8.6, 6.0, 2, 10, 1.00, 0.55, 0.14, 1.70],     // sodium, near shopfront
  [-8.6, 7.2, -6, 10, 1.00, 0.48, 0.12, 1.50],   // sodium, warm west wall
  [-8.6, 15.0, -12, 12, 1.00, 0.20, 0.60, 1.40], // magenta
  [8.6, 14.0, -21, 12, 0.16, 0.84, 1.00, 1.35],  // cyan
  [-8.6, 8.0, -32, 10, 1.00, 0.55, 0.15, 1.30],  // sodium
  [8.6, 25.0, -28, 15, 0.28, 0.70, 1.00, 0.70],  // high cyan
  [-8.6, 11.0, -46, 11, 1.00, 0.24, 0.64, 1.20], // magenta
  [8.6, 9.0, -58, 11, 0.18, 0.84, 0.96, 1.05],   // cyan
  [8.6, 20.0, -57, 14, 0.70, 0.30, 1.00, 0.80],  // violet mega, skybridge run
  [-8.6, 27.0, -70, 16, 0.66, 0.38, 1.00, 0.62], // high violet
  [8.6, 16.0, -75, 12, 1.00, 0.52, 0.18, 0.85],  // sodium
  [-8.6, 9.0, -90, 12, 0.18, 0.84, 0.96, 0.72],  // cyan
  [8.6, 15.0, -106, 14, 1.00, 0.24, 0.60, 0.58], // magenta, deep
  [-8.6, 12.0, -124, 14, 1.00, 0.52, 0.18, 0.44],// sodium, deepest
];

const probePos = new Float32Array(NPROBES * 3);
const probeCol = new Float32Array(NPROBES * 4);
for (let i = 0; i < NPROBES; i++) {
  const p = PROBES[i];
  probePos[i * 3 + 0] = p[0];
  probePos[i * 3 + 1] = p[1];
  probePos[i * 3 + 2] = p[2];
  probeCol[i * 4 + 0] = p[4] * p[7];
  probeCol[i * 4 + 1] = p[5] * p[7];
  probeCol[i * 4 + 2] = p[6] * p[7];
  probeCol[i * 4 + 3] = 1 / (p[3] * p[3]); // inverse radius squared
}

// Analytic cones, refreshed every update() from the same maths the sources
// use. Layout: A = apex.xyz + apex radius, D = axis.xyz + length,
// C = colour * intensity + radius slope (per metre along the axis).
const beamA = new Float32Array(NBEAMS * 4);
const beamD = new Float32Array(NBEAMS * 4);
const beamC = new Float32Array(NBEAMS * 4);

// Mirrors the shaft table in atmosphere.js (apex, length, topR, botR, colour)
// and its sweep, so rain lights up inside the shafts that are actually drawn.
// Gains are rain-specific: a shaft renders at ~0.25 alpha because it is a
// volume, but a drop crossing it is a mirror and reads far hotter than the air.
const SHAFTS = [
  { apex: [30, 178, -78], len: 220, topR: 3.0, botR: 17, col: [1.00, 0.63, 0.30], gain: 0.95,
    sweep: { ax: 0.10, az: 0.10, sx: 0.11, sz: 0.083, px: 0.0, pz: 1.7, tilt: 0.06, tiltZ: -0.3 } },
  { apex: [-10, 190, -110], len: 240, topR: 3.6, botR: 23, col: [0.44, 0.84, 1.00], gain: 1.05,
    sweep: { ax: 0.18, az: 0.13, sx: 0.071, sz: 0.093, px: 2.1, pz: 4.0, tilt: -0.12, tiltZ: 0 } },
  { apex: [-6, 142, -4], len: 176, topR: 2.0, botR: 11, col: [0.62, 0.71, 0.91], gain: 0.80,
    sweep: { ax: 0.13, az: 0.16, sx: 0.052, sz: 0.064, px: 4.4, pz: 0.9, tilt: 0.06, tiltZ: 0 } },
];
const SEARCH_COL = [0.42, 0.55, 0.74];

function writeBeams(t) {
  for (let i = 0; i < SHAFTS.length; i++) {
    const s = SHAFTS[i];
    const sw = s.sweep;
    // atmosphere.js drives pivot.rotation.x / .z on a cone whose axis is -Y.
    // Euler XYZ with y = 0: dir = (sin z, -cos z cos x, -cos z sin x).
    const rx = sw.tilt + Math.sin(t * sw.sx + sw.px) * sw.ax;
    const rz = sw.tiltZ + Math.sin(t * sw.sz + sw.pz) * sw.az;
    const cz = Math.cos(rz);
    const o = i * 4;
    beamA[o] = s.apex[0]; beamA[o + 1] = s.apex[1]; beamA[o + 2] = s.apex[2];
    beamA[o + 3] = s.topR;
    beamD[o] = Math.sin(rz);
    beamD[o + 1] = -cz * Math.cos(rx);
    beamD[o + 2] = -cz * Math.sin(rx);
    beamD[o + 3] = s.len;
    beamC[o] = s.col[0] * s.gain;
    beamC[o + 1] = s.col[1] * s.gain;
    beamC[o + 2] = s.col[2] * s.gain;
    beamC[o + 3] = (s.botR - s.topR) / s.len;
  }
  // Police searchlight — same drift and tracking as vehicles.js, so the rain
  // column stands exactly where the drawn cone stands.
  const px = 6 * Math.sin(t * 0.11);
  const pz = -46 + 10 * Math.sin(t * 0.07 + 1.0);
  const py = 34 + 1.1 * Math.sin(t * 0.5) - 0.75;
  const tx = 4.5 * Math.sin(t * 0.31 + 0.7);
  const tz = -46 + 30 * Math.sin(t * 0.17 + 2.1);
  let dx = tx - px, dy = 0.1 - py, dz = tz - pz;
  const L = Math.max(Math.hypot(dx, dy, dz), 0.01);
  dx /= L; dy /= L; dz /= L;
  const o = 3 * 4;
  beamA[o] = px; beamA[o + 1] = py; beamA[o + 2] = pz; beamA[o + 3] = 0.5;
  beamD[o] = dx; beamD[o + 1] = dy; beamD[o + 2] = dz; beamD[o + 3] = L;
  beamC[o] = SEARCH_COL[0] * 1.35;
  beamC[o + 1] = SEARCH_COL[1] * 1.35;
  beamC[o + 2] = SEARCH_COL[2] * 1.35;
  beamC[o + 3] = 0.085; // vehicles.js scales the unit cone by 0.085 * dist
}
writeBeams(0);

// Continuous-source colours. KAN_* drive the low kanban band, ARC_* the
// under-canopy arcade cove, ROAD the wet-asphalt bounce.
const KAN_A = [1.00, 0.16, 0.50];  // magenta
const KAN_B = [0.14, 0.74, 0.96];  // cyan
const KAN_C = [1.00, 0.50, 0.14];  // sodium
const ARC_WARM = [0.80, 0.37, 0.12];
const ARC_COOL = [0.16, 0.50, 0.63];
// Road bounce is the one term with no colour of its own, so it is the one that
// turns into milk if it is generous. Kept low and blue: it exists to stop the
// bottom of the frame going dead, not to light anything.
const ROAD_COL = [0.11, 0.16, 0.31];

const FIELD_UNIFORMS = (o = {}) => ({
  uProbePos: { value: probePos },
  uProbeCol: { value: probeCol },
  uBeamA: { value: beamA },
  uBeamD: { value: beamD },
  uBeamC: { value: beamC },
  uKanA: { value: new THREE.Color(...KAN_A).multiplyScalar(o.kan ?? 1) },
  uKanB: { value: new THREE.Color(...KAN_B).multiplyScalar(o.kan ?? 1) },
  uKanC: { value: new THREE.Color(...KAN_C).multiplyScalar(o.kan ?? 1) },
  uArcWarm: { value: new THREE.Color(...ARC_WARM).multiplyScalar(o.arc ?? 1) },
  uArcCool: { value: new THREE.Color(...ARC_COOL).multiplyScalar(o.arc ?? 1) },
  uRoad: { value: new THREE.Color(...ROAD_COL).multiplyScalar(o.road ?? 1) },
  uBeamGain: { value: o.beam ?? 1 },
});

const FIELD_GLSL = /* glsl */ `
  #define NP ${NPROBES}
  #define NB ${NBEAMS}
  uniform vec3 uProbePos[NP];
  uniform vec4 uProbeCol[NP];
  uniform vec4 uBeamA[NB];
  uniform vec4 uBeamD[NB];
  uniform vec4 uBeamC[NB];
  uniform vec3 uKanA, uKanB, uKanC, uArcWarm, uArcCool, uRoad;
  uniform float uBeamGain;

  // Line source running the length of one wall. Falloff is 1/(1+k*r^2) in the
  // plane normal to z, which is the correct profile for a line rather than the
  // 1/r^2 of a point — a continuous run of kanban does NOT fall off like a bulb.
  float lineSrc(vec3 wp, float sd, float wx, float wy, float k, float up) {
    float dx = wp.x - sd * wx;
    float dy = wp.y - wy;
    dy *= mix(1.0, up, step(0.0, dy)); // downlight spills down and out, not up
    return 1.0 / (1.0 + (dx * dx + dy * dy) * k);
  }

  vec3 sampleField(vec3 wp) {
    vec3 lit = vec3(0.0);

    // --- discrete pools: mid/high band installations ---
    for (int i = 0; i < NP; i++) {
      vec3 d = wp - uProbePos[i];
      float f = max(0.0, 1.0 - dot(d, d) * uProbeCol[i].w);
      lit += uProbeCol[i].rgb * f * f;
    }

    // --- low kanban band, both walls, z = +8 .. -116 ---
    // Colour cycles down the corridor on two incommensurate periods, so the
    // rain in front of a magenta stretch is magenta and the rain in front of a
    // sodium stretch is amber. This is the fix for globally-cyan rain.
    float zk = smoothstep(-126.0, -112.0, wp.z) * (1.0 - smoothstep(5.0, 14.0, wp.z));
    for (int s = 0; s < 2; s++) {
      float sd = s == 0 ? 1.0 : -1.0;
      float u = wp.z * 0.083 + sd * 1.9;
      float m1 = 0.5 + 0.5 * sin(u);
      float m2 = 0.5 + 0.5 * sin(u * 1.61 + 1.3);
      vec3 c = mix(mix(uKanA, uKanB, m1), uKanC, m2 * 0.55);
      lit += c * lineSrc(wp, sd, 9.4, 8.2, 0.040, 1.9) * zk;
    }

    // --- under-canopy arcade cove, both walls, podium run z = +42 .. -114 ---
    float za = smoothstep(-124.0, -108.0, wp.z) * (1.0 - smoothstep(38.0, 46.0, wp.z));
    for (int s = 0; s < 2; s++) {
      float sd = s == 0 ? 1.0 : -1.0;
      // city.js picks each podium's strip temperature independently (~62%
      // warm), so a single global tint would be a lie; alternate along z.
      float w = 0.5 + 0.5 * sin(wp.z * 0.17 + sd * 2.1);
      vec3 c = mix(uArcCool, uArcWarm, smoothstep(0.12, 0.68, w));
      lit += c * lineSrc(wp, sd, 9.0, 5.3, 0.20, 2.7) * za;
    }

    // --- wet asphalt bounce: the whole block coming back up off the road ---
    float rb = (1.0 - smoothstep(0.0, 11.0, wp.y))
             * (1.0 - smoothstep(6.5, 11.5, abs(wp.x))) * za;
    lit += uRoad * rb;

    // --- analytic beams: volumetric shafts + police searchlight ---
    for (int i = 0; i < NB; i++) {
      vec3 d = wp - uBeamA[i].xyz;
      float L = uBeamD[i].w;
      float ax = dot(d, uBeamD[i].xyz);
      float tt = clamp(ax, 0.0, L);
      float r2 = max(dot(d, d) - ax * ax, 0.0);
      float R = uBeamA[i].w + tt * uBeamC[i].w;
      float core = exp(-r2 / max(R * R, 0.02) * 2.6);
      float win = smoothstep(0.0, L * 0.20, ax) * (1.0 - smoothstep(L * 0.72, L * 1.02, ax));
      lit += uBeamC[i].rgb * (core * win * uBeamGain);
    }
    return lit;
  }

  // Contrast curve. Multiplying the field by its own luma is a near-quadratic
  // response that preserves hue: a 10:1 input range becomes ~100:1 on screen,
  // which is what makes a drop in dark air vanish and a drop crossing a sign
  // flare. Without this the streaks all land within a stop of each other and
  // the rain reads as a uniform hatch no matter how varied the field is.
  vec3 fieldPunch(vec3 wp) {
    vec3 l = sampleField(wp);
    float m = dot(l, vec3(0.30, 0.52, 0.18));
    return l * (0.14 + 2.6 * m);
  }
`;

// Global gust: one wind for the whole storm so every shell leans together.
// g(t) is the instantaneous multiplier, gi(t) its exact integral, so drop
// positions and drop orientations stay consistent and pure in t.
//
// SHEETING is separate and spatial: low-frequency density waves marching
// downwind through the volume, so density modulates across the frame and over
// time instead of the storm being one even curtain. Clamped to a floor so no
// region ever goes completely dry.
const GUST_GLSL = /* glsl */ `
  float gustAmp(float t) { return 1.0 + 0.34 * sin(t * 0.17) + 0.17 * sin(t * 0.43 + 1.1); }
  float gustInt(float t) { return t - 2.0 * cos(t * 0.17) - 0.395 * cos(t * 0.43 + 1.1); }
  float sheeting(vec3 p, float t) {
    float a = sin(p.x * 0.078 + p.z * 0.052 - t * 1.55);
    float b = sin(p.x * 0.027 - p.z * 0.043 - t * 0.86 + 2.2);
    float c = sin(p.y * 0.048 + t * 0.42 + 1.1);
    return clamp(0.66 + 0.30 * a + 0.24 * b + 0.11 * c, 0.08, 1.30);
  }
`;

// Rain occlusion. Nothing in this scene casts a shadow into the rain, so
// shelter has to be modelled analytically or the storm falls at identical
// density under a 1.6m cantilevered canopy as it does in open sky — which is
// the single loudest "this is a screen-space effect" tell.
//
// Volumes are taken straight from city.js:
//   * arcade canopy   x = +-(8.3 .. 11.0), y < ~6.6, podium run z = 42 .. -114
//   * facade slabs    projecting floor-slab noses on a 3.2m pitch at the walls
//   * alley bridges   x 12.7..17.3 (y<11.7) and 20..24 (y<22.9), z -53..-39
const SHELTER_GLSL = /* glsl */ `
  float shelter(vec3 p) {
    float ax = abs(p.x);
    float podZ = smoothstep(-120.0, -110.0, p.z) * (1.0 - smoothstep(40.0, 46.0, p.z));

    // deep sidewalk canopy: dry arcade under it, hard edge at the fascia line
    float canopy = smoothstep(8.1, 9.0, ax) * (1.0 - smoothstep(10.9, 12.2, ax))
                 * (1.0 - smoothstep(5.8, 7.4, p.y)) * podZ;
    float s = 1.0 - 0.93 * canopy;

    // floor-slab noses: rain hugging a facade is broken into bands by every
    // projecting course, so the wall face never carries an unbroken curtain
    float wall = smoothstep(8.8, 9.7, ax) * (1.0 - smoothstep(10.6, 11.8, ax))
               * smoothstep(6.5, 10.0, p.y);
    float pitch = smoothstep(0.10, 0.42, fract(p.y * 0.3125));
    s *= 1.0 - 0.58 * wall * pitch;

    // alley overhead connectors
    float alZ = smoothstep(-53.6, -52.2, p.z) * (1.0 - smoothstep(-40.4, -39.0, p.z));
    float br = smoothstep(12.4, 13.1, p.x) * (1.0 - smoothstep(16.9, 17.6, p.x))
             * (1.0 - smoothstep(11.0, 12.4, p.y))
             + smoothstep(19.6, 20.3, p.x) * (1.0 - smoothstep(23.7, 24.4, p.x))
             * (1.0 - smoothstep(22.0, 23.4, p.y));
    s *= 1.0 - 0.90 * clamp(br, 0.0, 1.0) * alZ;
    return s;
  }
`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Unit quad instanced geometry: position = corner (+-0.5), uv 0..1.
function makeQuadInstanced(count) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.instanceCount = count;
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]),
      3
    )
  );
  geo.setAttribute(
    'uv',
    new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2)
  );
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  return geo;
}

// ---------------------------------------------------------------------------
// RAIN — three depth shells that must be TELLABLE APART at a glance, because
// legible parallax is the difference between rainfall and a hatch overlay:
//
//                near            mid             far
//   gauge        13 px           3.4 px          1.25 px      (10x near:far)
//   focus        heavy DOF       slight          sharp
//   shear        ~26 deg         ~17 deg         ~13 deg
//   speed        38 m/s          27              21
//   opacity      low, broad      mid             thin veil
//
// Width is specified in SCREEN pixels and converted per-vertex, so the gauge
// difference survives depth. The near shell is deliberately SHORT as well as
// fat: real foreground rain at this focal length is a defocused smear a few
// drop-widths long, not a hairline scratch running the height of the frame.
// ---------------------------------------------------------------------------

const RAIN_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uBoxSize;
  uniform vec3 uBoxCenter;
  uniform vec2 uWind;      // horizontal drift, m/s at gust = 1
  uniform vec2 uSpeed;     // fall speed: min, range
  uniform vec2 uLen;       // streak length: min, range
  uniform float uWidth;    // half-width in world units per unit of distance
  uniform vec2 uRange;     // shell depth window: fade-in dist, fade-out dist
  uniform float uOpacity;
  uniform float uTurb;
  uniform vec3 uAmbient;
  attribute vec4 aSeed;    // xyz cell position in [0,1), w per-drop rand
  varying vec2 vUv;
  varying vec3 vCol;
  ${FIELD_GLSL}
  ${GUST_GLSL}
  ${SHELTER_GLSL}
  void main() {
    vUv = uv;
    float r = aSeed.w;
    float speed = uSpeed.x + r * uSpeed.y;
    // Wide per-drop drift spread: at a fixed t this is what stops every streak
    // in the frame sharing one angle. 0.5 .. 1.7 is roughly +-25% on the lean.
    float drift = 0.5 + r * 1.2;
    float g = gustAmp(uTime);
    float gi = gustInt(uTime);

    // per-drop turbulence, small, with its exact derivative
    float ph = aSeed.x * 12.9 + aSeed.z * 7.3;
    float s = sin(uTime * 0.9 + ph);
    float c = cos(uTime * 0.9 + ph);

    vec2 hOff = uWind * drift * gi + vec2(s, s * 0.5) * uTurb;
    vec2 hVel = uWind * drift * g + vec2(c, c * 0.5) * (uTurb * 0.9);
    vec3 off = vec3(hOff.x, -speed * uTime, hOff.y);
    vec3 vel = vec3(hVel.x, -speed, hVel.y);

    vec3 origin = uBoxCenter - 0.5 * uBoxSize;
    vec3 p = origin + mod(aSeed.xyz * uBoxSize + off, uBoxSize);

    vec3 axis = normalize(vel);
    vec3 toCam = cameraPosition - p;
    float dist = max(length(toCam), 0.01);
    vec3 side = normalize(cross(axis, toCam / dist));
    float len = uLen.x + r * uLen.y;
    vec3 wp = p + axis * ((uv.y - 0.5) * len) + side * (position.x * 2.0 * dist * uWidth);

    // match the scene FogExp2 curve so the far shell dissolves, not clips
    float ft = 0.0125 * dist;
    float atten = exp(-ft * ft);
    // depth window: each shell owns a slice, so density does not stack
    float win = smoothstep(uRange.x, uRange.x * 2.2 + 0.6, dist)
              * (1.0 - smoothstep(uRange.y * 0.55, uRange.y, dist));

    vec4 clip = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    // Gentle radial falloff. Reads as ordinary lens vignette, and it keeps the
    // fattest near streaks out of the frame corners where the post chain's
    // chromatic aberration would otherwise fringe them green/magenta.
    float rad = length(clip.xy / max(abs(clip.w), 0.001));
    float vig = 1.0 - 0.40 * smoothstep(0.5, 1.45, rad);

    float dens = sheeting(p, uTime) * shelter(p);
    vCol = (uAmbient + fieldPunch(p))
         * (atten * win * vig * dens * (0.45 + 0.55 * r) * uOpacity);
    gl_Position = clip;
  }
`;

// uSoft is the fake depth-of-field control. 0 = a sharp hairline with a bright
// comet head; 1 = a broad low-alpha gauge with both ends smeared, i.e. an
// out-of-focus foreground drop. Doing it in the profile rather than with a
// blur pass costs nothing and is the only thing that makes near rain read as
// NEAR rather than as more of the same hatch.
const RAIN_FRAG = /* glsl */ `
  precision highp float;
  uniform float uSoft;
  varying vec2 vUv;
  varying vec3 vCol;
  void main() {
    float q = vUv.x * 2.0 - 1.0;
    // across: focused = tight core; defocused = wide, flat, dim
    float ax = exp(-q * q * mix(7.0, 2.4, uSoft)) * mix(1.0, 0.46, uSoft);
    // along: comet with a bright leading head, smeared out when defocused
    float y = vUv.y;
    float tail = pow(y, mix(2.0, 1.1, uSoft));
    float head = 1.0 - smoothstep(mix(0.92, 0.58, uSoft), 1.0, y);
    gl_FragColor = vec4(vCol * (ax * tail * head), 1.0);
  }
`;

function makeRainShell(rng, cfg) {
  const geo = makeQuadInstanced(cfg.count);
  const seeds = new Float32Array(cfg.count * 4);
  for (let i = 0; i < cfg.count * 4; i++) seeds[i] = rng();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  const mat = new THREE.ShaderMaterial({
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uBoxSize: { value: new THREE.Vector3(...cfg.box) },
      uBoxCenter: { value: new THREE.Vector3(0, 20, 0) },
      uWind: { value: new THREE.Vector2(...cfg.wind) },
      uSpeed: { value: new THREE.Vector2(...cfg.speed) },
      uLen: { value: new THREE.Vector2(...cfg.len) },
      uWidth: { value: cfg.width },
      uRange: { value: new THREE.Vector2(...cfg.range) },
      uOpacity: { value: cfg.opacity },
      uSoft: { value: cfg.soft },
      uTurb: { value: cfg.turb },
      uAmbient: { value: new THREE.Color(...cfg.ambient) },
      ...FIELD_UNIFORMS(cfg.field),
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 23;
  mesh.userData.lead = cfg.lead;
  mesh.userData.yLock = cfg.yLock ?? null;
  return mesh;
}

// Half-width per unit distance for a target on-screen pixel width, assuming a
// ~900px tall frame at the presets' ~45deg fov (px/unit at distance d ~ 1071/d).
const PX = (w) => w / 2142;

const RAIN_SHELLS = [
  {
    // NEAR — few, very fat, very soft, short: defocused foreground drops.
    // Count is low on purpose; a dozen legible near smears sell depth where a
    // thousand would just be fog. Wind/speed ratio is the steepest of the
    // three so the shear angle visibly differs from the shells behind it.
    count: 380, box: [21, 26, 21], speed: [34, 14], len: [0.40, 0.40],
    width: PX(13), soft: 1.0, turb: 0.7, wind: [16.5, 5.0],
    range: [2.6, 26], opacity: 1.60, lead: 7,
    ambient: [0.056, 0.068, 0.092],
    field: { kan: 1.0, arc: 1.0, road: 1.0, beam: 1.0 },
  },
  {
    // MID — the body of the storm and the shell that carries the readable
    // streak shape. A quarter of the near gauge, slightly soft, less sheared.
    count: 2600, box: [50, 44, 50], speed: [27, 12], len: [0.62, 0.55],
    width: PX(3.4), soft: 0.22, turb: 0.36, wind: [8.4, 2.6],
    range: [7, 60], opacity: 1.05, lead: 22,
    ambient: [0.036, 0.045, 0.062],
    field: { kan: 1.0, arc: 0.95, road: 0.9, beam: 1.0 },
  },
  {
    // FAR — a fine sharp veil down the canyon; dissolves into the fog curve.
    // Least sheared, so the three shells fan apart in angle with depth.
    count: 5200, box: [130, 76, 165], speed: [21, 9], len: [0.34, 0.3],
    width: PX(1.25), soft: 0.0, turb: 0.2, wind: [5.0, 1.6],
    range: [24, 105], opacity: 0.78, lead: 52, yLock: 30,
    ambient: [0.022, 0.028, 0.040],
    field: { kan: 0.9, arc: 0.75, road: 0.6, beam: 1.15 },
  },
];

// ---------------------------------------------------------------------------
// SPLASHES — Y-billboarded impact crowns on the wet roadway. A street camera
// sits 3u up and sees the road at ~8deg grazing, which squashes a horizontal
// quad to nothing, so these stand up and face the lens.
//
// The first pass had them at a tenth of the amplitude they needed: lit only by
// a probe field that barely reaches road level and then multiplied by 0.7, the
// whole system contributed under 0.05 additive and was invisible in every
// frame. Impacts are the strongest wet-street cue there is, so they now get
// their own road-bounce term and — the part that actually mattered — they
// run the whole stretch of tarmac the lens can see. The ground cameras tilt
// UP the corridor, so the road does not enter frame until ~16m out from the
// street lens; a field that faded out at 25m was drawing almost entirely
// below the bottom edge of the plate.
// ---------------------------------------------------------------------------

const SPLASH_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec2 uHalf;
  uniform vec3 uCenter;
  uniform float uOpacity;
  attribute vec3 aSeed; // phase, r1, r2
  varying vec2 vUv;
  varying float vLife;
  varying vec3 vCol;
  varying vec2 vShape; // per-impact skew and flare, so no two crowns match
  ${FIELD_GLSL}
  ${GUST_GLSL}
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vUv = uv;
    float cycle = 0.30 + aSeed.y * 0.26;
    float ft = uTime / cycle + aSeed.x * 19.0;
    float life = fract(ft);
    float k = floor(ft);
    float hx = hash(vec2(aSeed.x * 57.3, k * 0.31));
    float hz = hash(vec2(k * 0.77, aSeed.z * 91.7));
    vec3 p = uCenter + vec3((hx - 0.5) * 2.0 * uHalf.x, 0.0, (hz - 0.5) * 2.0 * uHalf.y);

    vec3 toCam = cameraPosition - p;
    float dist = max(length(toCam), 0.01);
    // stand the quad up, facing the camera about Y
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam / dist));
    float gauge = 0.55 + aSeed.z * 0.8;    // wide spread so it never reads as a pattern
    // SMALL and HOT beats big and soft. A crown wide enough to overlap its
    // neighbours stops being an impact and becomes a layer of fog lying on the
    // road — which is exactly what killed the alley plate: hundreds of 1m
    // crowns at 2.6 gain merged into one white sheet. Half the width, a third
    // of the gain, and the gaps between impacts do the reading.
    float size = (0.10 + life * 0.32) * gauge;
    // wide and low: water thrown sideways off a film, not a standing shape
    vec3 wp = p + right * (position.x * 3.0 * size) + vec3(0.0, uv.y * size * 0.85, 0.0);

    vLife = life;
    vShape = vec2((hz - 0.5) * 1.1, 0.45 + hx * 0.85);
    // The crown is lit by the pool it lands in. Splashes sit at y ~ 0.3 where
    // the sign band barely reaches, so the road bounce does most of the work —
    // sampled a little above the surface where the spray actually is.
    vec3 lit = fieldPunch(p + vec3(0.0, 0.9, 0.0));
    float ft2 = 0.0125 * dist;
    // only the near road resolves individual impacts; beyond that the wet
    // sheen owns the read, so fade out before they can carpet the frame
    // The ground cameras are tilted UP the corridor, so the road does not
    // enter frame until ~16m out from the street lens. A splash field that
    // fades out at 25m therefore lands almost entirely below the frame edge,
    // which is why the first pass read as no splashes at all. The field now
    // runs the whole visible stretch of tarmac.
    float fade = exp(-ft2 * ft2) * smoothstep(3.0, 7.5, dist)
               * (1.0 - smoothstep(28.0, 48.0, dist));
    // impacts inherit the storm's sheeting: bursts of dense spatter, not a
    // constant sizzle across the whole road
    fade *= 0.45 + 0.75 * sheeting(p, uTime);
    vCol = (vec3(0.045, 0.058, 0.080) + lit) * (fade * uOpacity * (0.4 + hx * 1.0));
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const SPLASH_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying float vLife;
  varying vec3 vCol;
  varying vec2 vShape;
  void main() {
    float y = vUv.y;
    float x = (vUv.x * 2.0 - 1.0) - vShape.x * y * 0.5;
    // A drop landing on a film of water throws a low sheet of spray sideways
    // and leaves an expanding ring. Deliberately NOT a milk-crown: a crown is
    // a recognisable glyph, and a few hundred identical glyphs on the tarmac
    // read as a stencil pattern rather than as rain. Soft, wide and flat is
    // what actually looks like water at this scale.
    float lat = max(0.0, 1.0 - x * x);
    float low = exp(-y * y * (10.0 + vShape.y * 14.0));
    float spray = lat * lat * lat * low;
    // ring on the surface, expanding as the impact dies. Narrow and hot: the
    // ring is the shape the eye actually recognises as an impact, so it gets
    // the amplitude and the spray sheet is only there to soften its base.
    float rr = (abs(x) - 0.10 - vLife * 0.80) / 0.125;
    float ring = max(0.0, 1.0 - rr * rr) * exp(-y * y * 24.0);
    float a = (spray * 0.42 + ring * 1.35) * pow(1.0 - vLife, 1.4);
    gl_FragColor = vec4(vCol * a, 1.0);
  }
`;

function makeSplashes(rng, count) {
  const geo = makeQuadInstanced(count);
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) seeds[i] = rng();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: SPLASH_VERT,
    fragmentShader: SPLASH_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uHalf: { value: new THREE.Vector2(9.0, 26) },
      uCenter: { value: new THREE.Vector3(0, 0.06, -10) },
      uOpacity: { value: 1.8 },
      ...FIELD_UNIFORMS({ kan: 1.35, arc: 1.45, road: 1.0, beam: 1.0 }),
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 22;
  return mesh;
}

// ---------------------------------------------------------------------------
// STEAM — vent columns with structure: a hot tight core at the grate that
// cools, widens and slows as it climbs, lateral turbulence that grows with
// height, and a tint that starts on the nearest neon and washes out to cold
// grey at the top. Puff phases are evenly spaced along the column so it reads
// as a continuous plume rather than a random cloud of blobs.
// ---------------------------------------------------------------------------

function makeSteamTexture(rng) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  // Two octaves: a few large lobes for silhouette, many small for grain. The
  // blobs deliberately run out to the edge of the radial mask so the mask
  // never draws a clean circle — a sprite with a visibly circular rim is what
  // turns a column of puffs into a string of beads.
  for (const [n, lo, hi, aLo, aHi, spread] of [
    [12, 0.15, 0.25, 0.09, 0.15, 0.34],
    [55, 0.04, 0.10, 0.05, 0.10, 0.40],
  ]) {
    for (let i = 0; i < n; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = rng() * S * spread;
      const x = S / 2 + Math.cos(ang) * rad;
      // bias mass to the lower half so each puff has a lit underside
      const y = S / 2 + Math.sin(ang) * rad * 0.85 + S * 0.05;
      const r = S * (lo + rng() * (hi - lo));
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = aLo + rng() * (aHi - aLo);
      g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
      g.addColorStop(0.45, `rgba(255,255,255,${(a * 0.42).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  // circular mask so billboards never show square edges
  ctx.globalCompositeOperation = 'multiply';
  const m = ctx.createRadialGradient(S / 2, S / 2, S * 0.06, S / 2, S / 2, S * 0.52);
  m.addColorStop(0, '#fff');
  m.addColorStop(0.62, '#d2d2d2');
  m.addColorStop(1, '#000');
  ctx.fillStyle = m;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const STEAM_VERT = /* glsl */ `
  uniform float uTime;
  attribute vec3 aBase;
  attribute vec4 aSeed;  // slot 0..1 along the column, sizeRand, swayPhase, rotSign
  attribute vec3 aTint;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vUv = uv;
    float period = 6.5 + aSeed.y * 3.0;
    float life = fract(aSeed.x + uTime / period);
    // rise fast off the grate then decelerate as it cools
    float rise = 1.0 - pow(1.0 - life, 1.75);
    float H = 4.6 + aSeed.y * 2.6;
    float y = rise * H;
    // narrow and hot at the vent, wide and diffuse at the top
    float scale = (1.02 + aSeed.y * 0.72) * (0.32 + rise * 2.6);
    // lateral turbulence grows with height; drift downwind
    float sw = aSeed.z * 6.283;
    vec2 turb = vec2(
      sin(uTime * 0.45 + sw) + 0.55 * sin(uTime * 1.1 + sw * 2.3),
      cos(uTime * 0.33 + sw * 1.7) + 0.5 * sin(uTime * 0.8 + sw * 3.1)
    ) * (0.25 + rise * rise * 1.5);
    vec3 base = aBase + vec3(turb.x + rise * 1.1, y, turb.y);

    // brightness: bloom on emergence, fade as it thins out
    // long alive window: ~10 of the 17 puffs overlap at any instant, which is
    // what makes a continuous plume instead of a string of beads
    float a = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.50, 1.0, life));
    a *= mix(1.0, 0.22, rise); // base-lit column, dark crown
    float dist = distance(base, cameraPosition);
    float ft = 0.0125 * dist;
    vAlpha = a * exp(-ft * ft) * smoothstep(2.0, 6.5, dist);
    // Neon at the grate, cold blue once it has climbed. The wash to grey is
    // deliberately slow — desaturating early turns additive vapour over a
    // black plate into pastel dust, which is the one colour note this film
    // language does not have.
    vTint = mix(aTint, vec3(0.20, 0.30, 0.45), clamp(rise * 0.55, 0.0, 1.0));

    float ang = aSeed.w * (uTime * 0.3 + sw);
    float ca = cos(ang), sa = sin(ang);
    // plumes flatten as they spread and cool
    vec2 off = mat2(ca, -sa, sa, ca) * (position.xy * vec2(scale * (1.0 + rise * 0.55), scale));
    vec4 mv = viewMatrix * vec4(base, 1.0);
    mv.xy += off;
    gl_Position = projectionMatrix * mv;
  }
`;

const STEAM_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    float t = texture2D(uTex, vUv).r;
    t *= t * 3.4;               // crush the low end: wisps and lobes, not smudge
    gl_FragColor = vec4(vTint * (t * vAlpha * uOpacity), 1.0);
  }
`;

function makeSteam(rng) {
  // Four vents on the curb line (x ~= +-8.6), each keyed to the neon above it.
  // Placed so at least two columns fall inside every camera preset — a vent
  // hard against the curb at x = +-8.5 lands on the frame edge from the low
  // cameras and is effectively invisible, so these sit a little into the road.
  const vents = [
    { p: [0.2, 0.08, 11], tint: [0.26, 0.78, 0.92] },   // mid-road manhole, cyan
    { p: [3.2, 0.08, -26], tint: [1.0, 0.46, 0.16] },   // mid-road manhole, sodium
    { p: [-7.8, 0.08, -12], tint: [0.95, 0.26, 0.6] },  // curb grate, magenta
    { p: [7.6, 0.08, -48], tint: [1.0, 0.5, 0.2] },     // curb grate, sodium
    { p: [-7.4, 0.08, -78], tint: [0.3, 0.7, 0.9] },    // deep, cyan
  ];
  const PER = 17;
  const count = vents.length * PER;
  const geo = makeQuadInstanced(count);
  const base = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  const tint = new Float32Array(count * 3);
  let i = 0;
  for (const v of vents) {
    for (let k = 0; k < PER; k++, i++) {
      base[i * 3 + 0] = v.p[0] + (rng() - 0.5) * 0.6;
      base[i * 3 + 1] = v.p[1];
      base[i * 3 + 2] = v.p[2] + (rng() - 0.5) * 0.6;
      // evenly spaced phase slots -> a continuous column, not a random clump
      seed[i * 4 + 0] = (k + rng() * 0.4) / PER;
      seed[i * 4 + 1] = rng();
      seed[i * 4 + 2] = rng();
      seed[i * 4 + 3] = rng() < 0.5 ? -1 : 1;
      tint[i * 3 + 0] = v.tint[0];
      tint[i * 3 + 1] = v.tint[1];
      tint[i * 3 + 2] = v.tint[2];
    }
  }
  geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 3));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: STEAM_VERT,
    fragmentShader: STEAM_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uTex: { value: makeSteamTexture(rng) },
      uOpacity: { value: 0.4 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 21;
  return mesh;
}

// ---------------------------------------------------------------------------
// HAZE — depth-plane sheets of wet air. The old version alpha-blended a fixed
// grey, which is a milk generator: over a near-black plate a grey sheet lifts
// the shadows everywhere it covers and shows its card edges. These are ADDITIVE
// and lit by the light field instead, so a sheet crossing a dark stretch of
// corridor contributes literally nothing and a sheet in front of a kanban
// blooms in that sign's colour. Edges feather to zero on all four sides and
// the sheet fades out as it turns edge-on, so no card silhouette survives.
// ---------------------------------------------------------------------------

function makeHazeTexture(rng) {
  const W = 512, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 620; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const r = 10 + rng() * 58;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.02 + rng() * 0.05;
    g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    // wrap horizontally so RepeatWrapping has no seam
    if (x < r) { ctx.translate(W, 0); ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.translate(-W, 0); }
    if (x > W - r) { ctx.translate(-W, 0); ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.translate(W, 0); }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const HAZE_VERT = /* glsl */ `
  uniform vec3 uAmbient;
  varying vec2 vUv;
  varying vec3 vWPos;
  varying vec3 vNrm;
  varying vec3 vLit;
  ${FIELD_GLSL}
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWPos = wp.xyz;
    vNrm = normalize(mat3(modelMatrix) * normal);
    vLit = uAmbient + sampleField(wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const HAZE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uOpacity;
  uniform vec2 uDepth;   // near fade-in, far fade-out
  uniform vec3 uTint;
  varying vec2 vUv;
  varying vec3 vWPos;
  varying vec3 vNrm;
  varying vec3 vLit;
  void main() {
    float n1 = texture2D(uTex, vec2(vUv.x * 0.8 + uTime * uSpeed, vUv.y)).r;
    float n2 = texture2D(uTex, vec2(vUv.x * 2.0 - uTime * uSpeed * 1.8 + 0.37,
                                    clamp(vUv.y * 1.35 - 0.06, 0.0, 1.0))).r;
    float a = clamp(n1 * 1.05 + n2 * 0.9 - 0.30, 0.0, 1.0);
    a *= a;                       // crush: wisps, never a slab
    // feather every edge of the card to nothing
    vec2 e = smoothstep(vec2(0.0), vec2(0.34), vUv) * (1.0 - smoothstep(vec2(0.66), vec2(1.0), vUv));
    a *= e.x * e.y;
    vec3 V = cameraPosition - vWPos;
    float d = length(V);
    // edge-on cards would draw a hard band across the frame: kill them
    a *= abs(dot(vNrm, V / d));
    a *= smoothstep(uDepth.x, uDepth.x * 2.0, d) * (1.0 - smoothstep(uDepth.y * 0.6, uDepth.y, d));
    gl_FragColor = vec4(vLit * uTint * (a * uOpacity), 1.0);
  }
`;

function makeHaze(rng) {
  const tex = makeHazeTexture(rng);
  const sheets = [];
  // Two planes only, and both live DEEP in the corridor. There used to be a
  // third at y ~ 2 which banded straight across the frame at eye level from
  // the low cameras — the single worst offender for washing shadows into
  // midtones. Aerial perspective is what these are for; anything close enough
  // to the lens to cover the frame has no business being a card.
  const defs = [
    { w: 60, h: 16, pos: [1, 9, -58], speed: 0.005, opacity: 0.42, depth: [24, 130], drift: [0.037, 3.2, 2.1] },
    { w: 84, h: 28, pos: [-2, 16, -110], speed: 0.0035, opacity: 0.36, depth: [40, 215], drift: [0.029, 3.6, 4.4] },
  ];
  for (const d of defs) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: HAZE_VERT,
      fragmentShader: HAZE_FRAG,
      uniforms: {
        uTex: { value: tex },
        uTime: { value: 0 },
        uSpeed: { value: d.speed },
        uOpacity: { value: d.opacity },
        uDepth: { value: new THREE.Vector2(...d.depth) },
        uTint: { value: new THREE.Color(0.78, 0.86, 1.0) },
        uAmbient: { value: new THREE.Color(0.030, 0.040, 0.058) },
        ...FIELD_UNIFORMS({ kan: 0.55, arc: 0.35, road: 0.30, beam: 0.55 }),
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    // segmented so the per-vertex light field has somewhere to vary
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h, 14, 5), mat);
    mesh.position.set(...d.pos);
    mesh.renderOrder = 20;
    mesh.frustumCulled = false;
    mesh.userData.drift = d.drift;
    mesh.userData.homeX = d.pos[0];
    sheets.push(mesh);
  }
  return sheets;
}

// ---------------------------------------------------------------------------

export function buildWeather(ctx = {}) {
  const camera = ctx.camera;
  const rng = mulberry32(SEED);
  const group = new THREE.Group();

  const rain = RAIN_SHELLS.map((cfg) => makeRainShell(rng, cfg));
  const splashes = makeSplashes(rng, 560);
  const steam = makeSteam(rng);
  const haze = makeHaze(rng);

  group.add(...rain, splashes, steam, ...haze);

  const timeMats = [
    ...rain.map((m) => m.material),
    splashes.material,
    steam.material,
    ...haze.map((m) => m.material),
  ];

  // preallocated scratch — update() never allocates
  const fwd = new THREE.Vector3();
  const splashC = splashes.material.uniforms.uCenter.value;

  function update(t) {
    for (const m of timeMats) m.uniforms.uTime.value = t;
    // the beam table is shared by reference across every material that samples
    // the field, so one write per frame feeds all of them
    writeBeams(t);
    if (camera) {
      camera.getWorldDirection(fwd);
      const cp = camera.position;
      // each shell trails the camera at its own lead distance -> real parallax
      for (const m of rain) {
        const lead = m.userData.lead;
        const c = m.material.uniforms.uBoxCenter.value;
        const yl = m.userData.yLock;
        c.set(
          cp.x + fwd.x * lead,
          yl !== null ? yl : Math.min(Math.max(cp.y + fwd.y * lead, 5), 60),
          cp.z + fwd.z * lead
        );
      }
      splashC.set(0, 0.06, Math.min(Math.max(cp.z + fwd.z * 26, -150), 24));
    }
    // slow lateral drift of the haze planes, pure function of t
    for (const m of haze) {
      const [f, amp, ph] = m.userData.drift;
      m.position.x = m.userData.homeX + Math.sin(t * f + ph) * amp;
    }
  }

  return { group, update };
}
