import * as THREE from 'three';
import { mulberry32 } from './city.js';

// WEATHER — rain streaks, ground splashes, vent steam, drifting mist.
// Owned by the WEATHER agent. Everything is a pure function of (t, seed):
// motion lives in vertex shaders driven by a uTime uniform, so fixed-t
// screenshots are deterministic and update() allocates nothing.
//
// Street corridor: x in [-9, 9] roadway, walls at x = +-10, z in [-230, 50].
// Scene fog: FogExp2 density 0.0125 — ShaderMaterials here fake their own.

const SEED = 8811;

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
// RAIN — instanced streak quads in a wrap-around box that trails the camera.
// Two shells: a dense near volume (thin sharp streaks) and a wide far volume.
// ---------------------------------------------------------------------------

const RAIN_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uBoxSize;
  uniform vec3 uBoxCenter;
  uniform vec2 uWind;
  attribute vec4 aSeed; // xyz in [0,1), w rand
  varying vec2 vUv;
  varying float vFade;
  void main() {
    vUv = uv;
    float r = aSeed.w;
    float speed = 26.0 + r * 16.0;
    vec3 vel = vec3(uWind.x * (0.6 + r * 0.8), -speed, uWind.y * (0.6 + r * 0.8));
    vec3 origin = uBoxCenter - 0.5 * uBoxSize;
    vec3 p = origin + mod(aSeed.xyz * uBoxSize + vel * uTime - origin, uBoxSize);
    vec3 axis = normalize(vel);
    vec3 toCam = p - cameraPosition;
    float dist = max(length(toCam), 0.001);
    vec3 side = normalize(cross(axis, toCam / dist));
    float len = 0.4 + r * 0.7;
    float width = 0.009 + dist * 0.0009;
    vec3 wp = p + axis * ((uv.y - 0.5) * len) + side * (position.x * width);
    float fogF = exp(-dist * 0.026);
    float nearF = smoothstep(1.2, 3.5, dist);
    vFade = fogF * nearF * (0.45 + 0.55 * r);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const RAIN_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    float ax = 1.0 - abs(vUv.x * 2.0 - 1.0);
    float ay = smoothstep(0.0, 0.3, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
    float a = ax * ax * ay * vFade * uOpacity;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;

function makeRainLayer(rng, count, boxSize, opacity) {
  const geo = makeQuadInstanced(count);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds[i * 4 + 0] = rng();
    seeds[i * 4 + 1] = rng();
    seeds[i * 4 + 2] = rng();
    seeds[i * 4 + 3] = rng();
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  const mat = new THREE.ShaderMaterial({
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uBoxSize: { value: new THREE.Vector3(...boxSize) },
      uBoxCenter: { value: new THREE.Vector3(0, 20, 0) },
      uWind: { value: new THREE.Vector2(1.7, 0.6) },
      uColor: { value: new THREE.Color(0.62, 0.75, 0.9) },
      uOpacity: { value: opacity },
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
  return mesh;
}

// ---------------------------------------------------------------------------
// SPLASHES — instanced expanding impact rings on the wet roadway. Each
// instance loops on its own cycle; position re-hashes every cycle so hits
// scatter over the road, all derived from (uTime, instance seed).
// ---------------------------------------------------------------------------

const SPLASH_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec2 uHalf;
  uniform vec3 uCenter;
  attribute vec3 aSeed; // phase, r1, r2
  varying vec2 vUv;
  varying float vLife;
  varying float vFade;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vUv = uv;
    float cycle = 0.45 + aSeed.y * 0.35;
    float ft = uTime / cycle + aSeed.x * 19.0;
    float life = fract(ft);
    float k = floor(ft);
    float hx = hash(vec2(aSeed.x * 57.3, k * 0.31));
    float hz = hash(vec2(k * 0.77, aSeed.z * 91.7));
    vec3 p = uCenter + vec3((hx - 0.5) * 2.0 * uHalf.x, 0.0, (hz - 0.5) * 2.0 * uHalf.y);
    float size = 0.08 + life * (0.3 + aSeed.z * 0.25);
    vec3 wp = p + vec3(position.x, 0.0, -position.y) * size;
    wp.y = uCenter.y;
    vLife = life;
    float dist = distance(wp, cameraPosition);
    vFade = exp(-dist * 0.035) * smoothstep(2.0, 5.0, dist);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const SPLASH_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vLife;
  varying float vFade;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float ring = smoothstep(0.55, 0.88, d) * (1.0 - smoothstep(0.88, 1.0, d));
    float dot_ = (1.0 - smoothstep(0.0, 0.4, d)) * (1.0 - smoothstep(0.0, 0.3, vLife));
    float a = (ring + dot_ * 1.4) * pow(1.0 - vLife, 1.8) * vFade * uOpacity;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;

function makeSplashes(rng, count) {
  const geo = makeQuadInstanced(count);
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    seeds[i * 3 + 0] = rng();
    seeds[i * 3 + 1] = rng();
    seeds[i * 3 + 2] = rng();
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: SPLASH_VERT,
    fragmentShader: SPLASH_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uHalf: { value: new THREE.Vector2(8.5, 50) },
      uCenter: { value: new THREE.Vector3(0, 0.075, -10) },
      uColor: { value: new THREE.Color(0.5, 0.66, 0.8) },
      uOpacity: { value: 0.75 },
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
// STEAM — billboard sprite columns rising from street vents, tinted by the
// nearest neon. Soft blob texture, additive, view-space billboarding.
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
  for (let i = 0; i < 46; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = rng() * S * 0.3;
    const x = S / 2 + Math.cos(ang) * rad;
    const y = S / 2 + Math.sin(ang) * rad;
    const r = S * (0.05 + rng() * 0.11);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.05 + rng() * 0.09;
    g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // enforce circular falloff so billboards never show square edges
  ctx.globalCompositeOperation = 'multiply';
  const m = ctx.createRadialGradient(S / 2, S / 2, S * 0.15, S / 2, S / 2, S * 0.5);
  m.addColorStop(0, '#fff');
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
  attribute vec4 aSeed; // phase, sizeRand, swayPhase, rotSign
  attribute vec3 aTint;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vUv = uv;
    vTint = aTint;
    float period = 7.0 + aSeed.y * 4.0;
    float life = fract(aSeed.x + uTime / period);
    float y = life * (5.5 + aSeed.y * 2.5);
    float scale = (0.9 + aSeed.y * 0.7) * (0.55 + life * 2.8);
    float alpha = smoothstep(0.02, 0.18, life) * (1.0 - smoothstep(0.4, 0.95, life));
    vec2 sway = vec2(
      sin(uTime * 0.4 + aSeed.z * 6.283),
      cos(uTime * 0.31 + aSeed.z * 4.19)
    ) * life * 0.8;
    vec3 base = aBase + vec3(sway.x, y, sway.y);
    float dist = distance(base, cameraPosition);
    vAlpha = alpha * exp(-dist * 0.02) * smoothstep(2.5, 7.0, dist);
    float ang = aSeed.w * (uTime * 0.35 + aSeed.z * 6.283);
    float ca = cos(ang), sa = sin(ang);
    vec2 off = mat2(ca, -sa, sa, ca) * (position.xy * scale);
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
    float a = t * vAlpha * uOpacity;
    gl_FragColor = vec4(vTint * a, 1.0);
  }
`;

function makeSteam(rng) {
  // vent positions along the curbs (curb line at x ~= +-9), neon-ish tints.
  const vents = [
    { p: [8.4, 0.1, 24], tint: [1.0, 0.5, 0.22] },   // sodium orange
    { p: [-8.5, 0.1, 2], tint: [0.25, 0.75, 0.85] }, // cyan
    { p: [8.3, 0.1, -24], tint: [0.9, 0.3, 0.65] },  // magenta
    { p: [-8.5, 0.1, -54], tint: [0.3, 0.7, 0.8] },  // teal
    { p: [8.4, 0.1, -88], tint: [1.0, 0.45, 0.2] },  // orange
    { p: [-8.4, 0.1, -120], tint: [0.8, 0.35, 0.7] },// magenta, deep in fog
  ];
  const PER = 16;
  const count = vents.length * PER;
  const geo = makeQuadInstanced(count);
  const base = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  const tint = new Float32Array(count * 3);
  let i = 0;
  for (const v of vents) {
    for (let k = 0; k < PER; k++, i++) {
      base[i * 3 + 0] = v.p[0] + (rng() - 0.5) * 0.8;
      base[i * 3 + 1] = v.p[1];
      base[i * 3 + 2] = v.p[2] + (rng() - 0.5) * 0.8;
      seed[i * 4 + 0] = rng();
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
      uOpacity: { value: 0.18 },
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
// MIST — big slow translucent noise sheets drifting at street level.
// ---------------------------------------------------------------------------

function makeMistTexture(rng) {
  const W = 512, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 700; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const r = 8 + rng() * 50;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.02 + rng() * 0.045;
    g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    // wrap horizontally so RepeatWrapping has no seam
    if (x < r) { ctx.fillStyle = g; ctx.translate(W, 0); ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.translate(-W, 0); }
    if (x > W - r) { ctx.fillStyle = g; ctx.translate(-W, 0); ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.translate(W, 0); }
  }
  // vertical fade to zero at top and bottom
  ctx.globalCompositeOperation = 'multiply';
  const m = ctx.createLinearGradient(0, 0, 0, H);
  m.addColorStop(0, '#000');
  m.addColorStop(0.3, '#fff');
  m.addColorStop(0.75, '#fff');
  m.addColorStop(1, '#000');
  ctx.fillStyle = m;
  ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const MIST_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const MIST_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float n1 = texture2D(uTex, vec2(vUv.x + uTime * uSpeed, vUv.y)).r;
    float n2 = texture2D(uTex, vec2(vUv.x * 2.1 - uTime * uSpeed * 1.6 + 0.37, clamp(vUv.y * 1.4 - 0.1, 0.0, 1.0))).r;
    float a = clamp(n1 * 0.85 + n2 * 0.7 - 0.10, 0.0, 1.0);
    float edge = smoothstep(0.0, 0.12, vUv.x) * (1.0 - smoothstep(0.88, 1.0, vUv.x));
    gl_FragColor = vec4(uColor, a * edge * uOpacity);
  }
`;

function makeMist(rng) {
  const tex = makeMistTexture(rng);
  const sheets = [];
  const defs = [
    { w: 46, h: 8, pos: [0, 3.2, -16], speed: 0.006, opacity: 0.10 },
    { w: 54, h: 10, pos: [2, 4.0, -52], speed: 0.004, opacity: 0.12 },
    { w: 66, h: 13, pos: [-2, 5.0, -100], speed: 0.003, opacity: 0.14 },
  ];
  for (const d of defs) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      uniforms: {
        uTex: { value: tex },
        uTime: { value: 0 },
        uSpeed: { value: d.speed },
        uOpacity: { value: d.opacity },
        uColor: { value: new THREE.Color(0.45, 0.56, 0.68) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), mat);
    mesh.position.set(...d.pos);
    mesh.renderOrder = 20;
    mesh.frustumCulled = false;
    sheets.push(mesh);
  }
  return sheets;
}

// ---------------------------------------------------------------------------

export function buildWeather(ctx = {}) {
  const camera = ctx.camera;
  const rng = mulberry32(SEED);
  const group = new THREE.Group();

  const rainNear = makeRainLayer(rng, 6000, [26, 26, 26], 0.20);
  const rainFar = makeRainLayer(rng, 8000, [90, 54, 90], 0.11);
  const splashes = makeSplashes(rng, 420);
  const steam = makeSteam(rng);
  const mist = makeMist(rng);

  group.add(rainNear, rainFar, splashes, steam);
  for (const m of mist) group.add(m);

  const timeMats = [
    rainNear.material,
    rainFar.material,
    splashes.material,
    steam.material,
    ...mist.map((m) => m.material),
  ];

  // preallocated scratch — update() never allocates
  const fwd = new THREE.Vector3();
  const nearC = rainNear.material.uniforms.uBoxCenter.value;
  const farC = rainFar.material.uniforms.uBoxCenter.value;
  const splashC = splashes.material.uniforms.uCenter.value;

  function update(t) {
    for (const m of timeMats) m.uniforms.uTime.value = t;
    if (camera) {
      camera.getWorldDirection(fwd);
      const cp = camera.position;
      nearC.set(
        cp.x + fwd.x * 9,
        Math.min(Math.max(cp.y + fwd.y * 9, 6), 60),
        cp.z + fwd.z * 9
      );
      farC.set(cp.x + fwd.x * 30, 26, cp.z + fwd.z * 30);
      splashC.set(
        0,
        0.075,
        Math.min(Math.max(cp.z + fwd.z * 28, -140), 20)
      );
    }
    // slow drift of the mist sheets, pure function of t
    mist[0].position.x = 0 + Math.sin(t * 0.05) * 2.5;
    mist[1].position.x = 2 + Math.sin(t * 0.037 + 2.1) * 3.0;
    mist[2].position.x = -2 + Math.sin(t * 0.043 + 4.4) * 3.5;
  }

  return { group, update };
}
