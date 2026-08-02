import * as THREE from 'three';
import { mulberry32 } from './city.js';

// ---------------------------------------------------------------------------
// ATMOSPHERE — fog, sky dome, global lighting, volumetric light shafts,
// layered haze cards. Owned by the ATMOSPHERE agent.
//
// Look targets (BR2049): near-black blue city under dense wet haze; fog color
// IS the aerial perspective, so it matches the sky-dome horizon glow. No sun,
// no strong directional — neon and windows carry the scene.
// ---------------------------------------------------------------------------

const FOG_COLOR = new THREE.Color(0x121a24); // desaturated blue-teal city glow
const FOG_DENSITY = 0.0125;

// ---------------------------------------------------------------------------
// Sky dome: procedural gradient shader. Near-black zenith falling to a faint
// dirty amber/teal horizon (light pollution bouncing off overcast). Horizon
// color converges on the fog color so silhouettes melt into the sky.
// ---------------------------------------------------------------------------
function makeSkyDome() {
  const geo = new THREE.SphereGeometry(880, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0x030407) },
      uHorizon: { value: FOG_COLOR.clone().multiplyScalar(1.25) },
      uAmber: { value: new THREE.Color(0x3a2412) },
      uTeal: { value: new THREE.Color(0x0e2a2e) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uZenith, uHorizon, uAmber, uTeal;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        // Base gradient: horizon glow compressed low, zenith near-black.
        float grad = pow(1.0 - h, 3.2);
        vec3 col = mix(uZenith, uHorizon, grad);
        // Light-pollution lobes: warm sodium glow down-street (-z) and a
        // cooler teal industrial glow off to the east. Very faint, hugging
        // the horizon like bounce off low cloud.
        float az = atan(vDir.x, -vDir.z); // 0 looking down-street
        float low = pow(1.0 - h, 6.0);
        float warmLobe = exp(-2.4 * az * az);
        float tealLobe = exp(-3.0 * (az - 2.1) * (az - 2.1))
                       + exp(-3.5 * (az + 2.4) * (az + 2.4));
        col += uAmber * (low * warmLobe * 0.85);
        col += uTeal * (low * tealLobe * 0.6);
        // Faint broken-cloud mottling so the dome is not a sterile ramp.
        float m = sin(vDir.x * 9.0 + 2.0) * sin(vDir.z * 7.0 - 1.0) * sin(vDir.y * 13.0 + 4.0);
        col *= 1.0 + m * 0.06 * (1.0 - h);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  return mesh;
}

// ---------------------------------------------------------------------------
// Volumetric shaft shader: open-ended cone, additive, brighter at the source
// (uv.y = 1 end), soft silhouette edges via view-angle falloff, near-camera
// fade, and a manual exp2 haze attenuation matched to scene fog so shafts sit
// IN the murk instead of punching through it. Subtle drifting density bands
// keyed to t keep it alive but deterministic.
// ---------------------------------------------------------------------------
function makeShaftMaterial(color, intensity) {
  return new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
      uTime: { value: 0 },
      uFogDensity: { value: FOG_DENSITY },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalV;
      varying vec3 vViewPos;
      void main() {
        vUv = uv;
        vNormalV = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalV;
      varying vec3 vViewPos;
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      uniform float uFogDensity;
      void main() {
        vec3 V = normalize(-vViewPos);
        // Soft silhouette: fade where the cone surface grazes the view ray.
        float ndv = abs(dot(normalize(vNormalV), V));
        float edge = smoothstep(0.0, 0.6, ndv);
        // Along the beam: hot at the source, dies toward the ground.
        float len = pow(clamp(vUv.y, 0.0, 1.0), 1.8);
        // Slow drifting density bands (pure function of t — deterministic).
        float bands = 0.82
          + 0.18 * sin(vUv.y * 22.0 - uTime * 0.35 + vUv.x * 6.2831)
          + 0.10 * sin(vUv.y * 53.0 - uTime * 0.9);
        // Near-camera fade so a shaft crossing the lens doesn't hard-clip.
        float dist = length(vViewPos);
        float nearFade = smoothstep(2.0, 14.0, dist);
        // Haze attenuation, softer than scene fog (shafts are self-luminous
        // scatter, they survive a bit deeper into the murk).
        float f = dist * uFogDensity * 0.55;
        float haze = exp(-f * f);
        float a = uIntensity * edge * len * bands * nearFade * haze;
        // Additive blend is (srcAlpha * rgb + dst): keep rgb unscaled so the
        // contribution is linear in a, not a^2.
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
}

function makeShaft({ apex, length, topR, botR, color, intensity }) {
  // Cylinder: uv.y=1 at top. Translate so the apex (top) is the pivot origin.
  const geo = new THREE.CylinderGeometry(topR, botR, length, 20, 24, true);
  geo.translate(0, -length / 2, 0);
  const mesh = new THREE.Mesh(geo, makeShaftMaterial(color, intensity));
  mesh.renderOrder = 20;
  const pivot = new THREE.Group();
  pivot.position.copy(apex);
  pivot.add(mesh);
  return { pivot, mat: mesh.material };
}

// ---------------------------------------------------------------------------
// Haze cards: huge ultra-faint additive planes across the street canyon at
// stepped depths — cheap layered-mist depth cueing between the fog and the
// shafts. Soft procedural canvas gradient, brighter low (street-glow feeds
// the mist from below).
// ---------------------------------------------------------------------------
function makeHazeTexture(rng) {
  const W = 256, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, W, H);
  // Base: vertical falloff, densest just above street level.
  const vg = c.createLinearGradient(0, 0, 0, H);
  vg.addColorStop(0.0, 'rgba(255,255,255,0)');
  vg.addColorStop(0.55, 'rgba(255,255,255,0.10)');
  vg.addColorStop(0.85, 'rgba(255,255,255,0.30)');
  vg.addColorStop(1.0, 'rgba(255,255,255,0.16)');
  c.fillStyle = vg;
  c.fillRect(0, 0, W, H);
  // Soft blobs for uneven density.
  for (let i = 0; i < 26; i++) {
    const x = rng() * W, y = H * (0.45 + rng() * 0.55);
    const r = 22 + rng() * 46;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.05 + rng() * 0.07})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Feather the left/right ends so card edges never read.
  const fade = (x0, x1) => {
    const g = c.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = g;
    c.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), H);
    c.globalCompositeOperation = 'source-over';
  };
  fade(0, W * 0.22);
  fade(W, W * 0.78);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeHazeCard(tex, { w, h, pos, color, opacity }) {
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.copy(pos);
  mesh.renderOrder = 15;
  return mesh;
}

// ---------------------------------------------------------------------------

export function buildAtmosphere({ scene, renderer }) {
  const rng = mulberry32(9021);
  const group = new THREE.Group();

  // --- Fog + tonemap exposure -------------------------------------------
  scene.fog = new THREE.FogExp2(FOG_COLOR.clone(), FOG_DENSITY);
  scene.background = null; // sky dome supplies the background
  renderer.toneMappingExposure = 1.15;

  // --- Sky ---------------------------------------------------------------
  group.add(makeSkyDome());

  // --- Global light: moonless overcast. Hemisphere only — cool zenith
  // bounce vs faint warm street-glow from below. Deliberately dim so neon
  // and window emissives dominate.
  const hemi = new THREE.HemisphereLight(0x27313d, 0x141009, 0.55);
  group.add(hemi);
  const amb = new THREE.AmbientLight(0x0e1218, 0.5);
  group.add(amb);

  // --- Volumetric shafts -------------------------------------------------
  // One warm sodium searchlight, two cool. Apexes high, sweeping slowly.
  const shafts = [
    { apex: new THREE.Vector3(26, 116, -70), length: 120, topR: 1.5, botR: 13,
      color: 0xffa14d, intensity: 0.5, // warm sodium — leaning across the canyon
      sweep: { ax: 0.10, az: 0.10, sx: 0.11, sz: 0.083, px: 0.0, pz: 1.7, tilt: 0.06, tiltZ: -0.3 } },
    { apex: new THREE.Vector3(-8, 128, -100), length: 136, topR: 2.0, botR: 18,
      color: 0x6fd7ff, intensity: 0.5, // cool cyan — deep down-street
      sweep: { ax: 0.18, az: 0.13, sx: 0.071, sz: 0.093, px: 2.1, pz: 4.0, tilt: -0.12 } },
    { apex: new THREE.Vector3(-5, 90, -4), length: 94, topR: 1.1, botR: 10,
      color: 0x9db4e8, intensity: 0.35, // pale blue — near field, faint
      sweep: { ax: 0.13, az: 0.16, sx: 0.052, sz: 0.064, px: 4.4, pz: 0.9, tilt: 0.06 } },
  ].map((s) => {
    const shaft = makeShaft(s);
    shaft.sweep = s.sweep;
    group.add(shaft.pivot);
    return shaft;
  });

  // --- Haze cards --------------------------------------------------------
  const hazeTexA = makeHazeTexture(rng);
  const hazeTexB = makeHazeTexture(rng);
  const cards = [
    { tex: hazeTexA, w: 150, h: 55, pos: new THREE.Vector3(2, 20, -34),
      color: 0x2a4450, opacity: 0.30 },
    { tex: hazeTexB, w: 190, h: 75, pos: new THREE.Vector3(-6, 28, -78),
      color: 0x3d3448, opacity: 0.34 }, // faint magenta cast from deep signage
    { tex: hazeTexA, w: 240, h: 100, pos: new THREE.Vector3(4, 38, -118),
      color: 0x2f3d4a, opacity: 0.40 },
  ].map((c) => {
    const m = makeHazeCard(c.tex, c);
    group.add(m);
    return m;
  });
  void cards;

  // --- Update ------------------------------------------------------------
  function update(t) {
    for (const s of shafts) {
      const sw = s.sweep;
      s.pivot.rotation.x = sw.tilt + Math.sin(t * sw.sx + sw.px) * sw.ax;
      s.pivot.rotation.z = (sw.tiltZ ?? 0) + Math.sin(t * sw.sz + sw.pz) * sw.az;
      s.mat.uniforms.uTime.value = t;
    }
  }

  return { group, update };
}
