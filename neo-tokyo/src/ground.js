import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mulberry32 } from './city.js';

// ---------------------------------------------------------------------------
// GROUND — rain-soaked street, sidewalks, planar puddle reflections, clutter.
// Blade Runner 2049 look: near-black wet asphalt, neon mirrored in puddles,
// streaky reflections on the rougher patches, everything hazed by fog.
// Deterministic: all randomness from mulberry32 with fixed seeds.
// ---------------------------------------------------------------------------

const ROAD_HALF = 9;          // roadway x in [-9, 9]
const WALK_W = 7;             // sidewalk width
const LEN = 280;              // corridor length along z
const Z_CENTER = -90;         // corridor spans z in [-230, 50]
const TILE_Z = 35;            // metres of street per texture tile
const REPEAT_Z = LEN / TILE_Z;

// hero steam grates — weather agent puts steam here, we pool warm light here
const HERO_GRATES = [[7.2, 22], [-6.9, -14], [7.0, -62]];

// ---- canvas texture helper -------------------------------------------------

function canvasTex(w, h, draw, { srgb = false, repeat = [1, 1] } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---- asphalt albedo (one 18m x 35m tile) ----------------------------------

function drawAsphalt(ctx, w, h) {
  const rng = mulberry32(101);
  ctx.fillStyle = '#14171d';
  ctx.fillRect(0, 0, w, h);

  // large soft tonal patches (repaved sections, grime)
  for (let i = 0; i < 30; i++) {
    const x = rng() * w, y = rng() * h, r = 80 + rng() * 260;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rng() < 0.5 ? 'rgba(52,58,70,0.12)' : 'rgba(3,4,6,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // aggregate speckle
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(74,80,96,0.06)' : 'rgba(0,0,0,0.07)';
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
  }

  // wheel-rut darkening (worn polished lanes)
  for (const cx of [w * 0.30, w * 0.70]) {
    const g = ctx.createLinearGradient(cx - 95, 0, cx + 95, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.20)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 95, 0, 190, h);
  }

  // gutters along both kerbs (wet-dark tar)
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fillRect(0, 0, 36, h);
  ctx.fillRect(w - 36, 0, 36, h);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(36, 0, 30, h);
  ctx.fillRect(w - 66, 0, 30, h);

  // tar-snake crack seals
  ctx.strokeStyle = 'rgba(4,5,8,0.6)';
  for (let i = 0; i < 12; i++) {
    ctx.lineWidth = 2 + rng() * 4;
    ctx.beginPath();
    let x = rng() * w, y = rng() * h * 0.8;
    ctx.moveTo(x, y);
    for (let s = 0; s < 5; s++) {
      x += (rng() - 0.5) * 160;
      y += 40 + rng() * 120;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // faded centre dashes
  ctx.fillStyle = 'rgba(198,190,164,0.5)';
  for (let y = 60; y < h - 320; y += 300) ctx.fillRect(w / 2 - 5, y, 10, 170);

  // worn edge lines
  ctx.fillStyle = 'rgba(186,180,156,0.26)';
  ctx.fillRect(w * 0.075 - 4, 0, 8, h);
  ctx.fillRect(w * 0.925 - 4, 0, 8, h);

  // stop line + zebra crosswalk at tile end (repeats every 35 m — block rhythm)
  ctx.fillStyle = 'rgba(204,198,172,0.36)';
  ctx.fillRect(64, h - 236, w - 128, 14);
  ctx.fillStyle = 'rgba(204,198,172,0.44)';
  for (let x = 72; x < w - 90; x += 104) ctx.fillRect(x, h - 192, 56, 168);

  // wear: dark speckle eating the paint
  for (let i = 0; i < 2200; i++) {
    const y = rng() < 0.6 ? h - 240 + rng() * 240 : rng() * h;
    ctx.fillStyle = 'rgba(12,13,17,0.5)';
    ctx.fillRect(rng() * w, y, 1 + rng() * 3, 1 + rng() * 3);
  }

  // oil stains
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = 'rgba(6,6,12,0.34)';
    ctx.beginPath();
    ctx.ellipse(w * (0.25 + rng() * 0.5), rng() * h, 22 + rng() * 46, 14 + rng() * 30, rng() * 3.14, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- roughness / puddle mask (shared by asphalt material and reflector) ----
// Dark = standing water (mirror). All water shapes are CONNECTED and
// z-elongated: continuous gutter channels along both kerbs, chained wheel-rut
// streaks (4-8x stretch), sheet water in the crosswalk dip. No round blobs.

function drawRoughness(ctx, w, h) {
  const rng = mulberry32(202);
  ctx.fillStyle = 'rgb(202,202,202)';
  ctx.fillRect(0, 0, w, h);

  // tonal noise on the dry-ish crown
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)';
    const s = 4 + rng() * 26;
    ctx.fillRect(rng() * w, rng() * h, s, s * (0.5 + rng()));
  }

  // damp polished wheel lanes — mild sheen that visually connects rut streaks
  for (const cx of [w * 0.30, w * 0.70]) {
    const g = ctx.createLinearGradient(cx - 58, 0, cx + 58, 0);
    g.addColorStop(0, 'rgba(124,124,124,0)');
    g.addColorStop(0.5, 'rgba(124,124,124,0.55)');
    g.addColorStop(1, 'rgba(124,124,124,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 58, 0, 116, h);
  }

  // soft-edged, z-stretched water shape
  const streak = (x, y, rx, ry, a = 0.94) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, rx * 0.2, 0, 0, rx);
    g.addColorStop(0, `rgba(10,10,10,${a})`);
    g.addColorStop(0.72, `rgba(14,14,14,${a * 0.85})`);
    g.addColorStop(1, 'rgba(90,90,90,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // continuous gutter channels hugging both kerbs: heavily overlapping
  // lozenges make one unbroken sheet with an undulating waterline
  for (const side of [0, 1]) {
    let wd = 30;
    for (let y = -40; y <= h + 40; y += 30) {
      wd = Math.max(16, Math.min(50, wd + (rng() - 0.5) * 16));
      streak(side ? w - 5 : 5, y, wd, 58, 0.96);
    }
  }

  // wheel-rut streaks: chains of 4-8x elongated shapes with drift and gaps
  for (const rc of [0.30, 0.70]) {
    let x = rc * w + (rng() - 0.5) * 18;
    let y = rng() * 140;
    while (y < h + 80) {
      const ry = 55 + rng() * 95;          // 4-13 m long
      const rx = 9 + rng() * 12;           // 0.3-0.7 m wide
      streak(x, y, rx, ry, 0.9);
      if (rng() < 0.35) streak(x + (rng() - 0.5) * 24, y + ry * 0.6, rx * 0.7, ry * 0.7, 0.8);
      y += ry * (1.1 + rng() * 0.9);
      if (rng() < 0.3) y += 90 + rng() * 160; // broken stretch — damp only
      x += (rng() - 0.5) * 26;
      x = Math.max(w * 0.22, Math.min(w * 0.78, x));
    }
  }

  // a few isolated dip streaks elsewhere — still elongated, never round
  for (let i = 0; i < 6; i++) {
    const rx = 10 + rng() * 14;
    streak(w * (0.15 + rng() * 0.7), rng() * h, rx, rx * (4 + rng() * 4), 0.85);
  }

  // sheet water pooling across the crosswalk dip at the tile end
  const sg = ctx.createLinearGradient(0, h - 230, 0, h);
  sg.addColorStop(0, 'rgba(40,40,40,0)');
  sg.addColorStop(0.45, 'rgba(36,36,36,0.5)');
  sg.addColorStop(1, 'rgba(28,28,28,0.68)');
  ctx.fillStyle = sg;
  ctx.fillRect(0, h - 230, w, 230);

  // micro sparkle
  for (let i = 0; i < 3000; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
    ctx.fillRect(rng() * w, rng() * h, 1, 1);
  }
}

// ---- baked neon spill for the roadway (lightMap, non-repeating) ------------
// Low grazing light licking in from the signage on both walls — magenta/cyan/
// sodium pools that let markings and manholes read while the crown stays black.

function drawStreetSpill(ctx, w, h) {
  const rng = mulberry32(808);
  ctx.fillStyle = 'rgb(20,26,36)'; // faint blue floor: wet black, never a void
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';

  const cols = [
    [255, 70, 150], [70, 200, 235], [255, 150, 70],
    [200, 90, 255], [80, 235, 200], [255, 90, 90],
  ];
  for (const side of [0, 1]) {
    let y = 20 + rng() * 60;
    while (y < h) {
      const [r, g, b] = cols[Math.floor(rng() * cols.length)];
      const inten = 0.22 + rng() * 0.4;
      const reach = w * (0.25 + rng() * 0.32);   // spill reaches 25-57% across
      const len = 60 + rng() * 150;
      ctx.save();
      ctx.translate(side ? w : 0, y);
      ctx.scale(1, len / reach);
      const gr = ctx.createRadialGradient(0, 0, reach * 0.05, 0, 0, reach);
      gr.addColorStop(0, `rgba(${r},${g},${b},${inten})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(0, 0, reach, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      y += len * (0.8 + rng() * 0.9);
    }
  }

  // warm sodium pools over the hero steam grates (matches the decals)
  for (const [gx, gz] of HERO_GRATES) {
    const cx = ((gx + ROAD_HALF) / (ROAD_HALF * 2)) * w;
    const cy = (1 - (50 - gz) / LEN) * h; // canvas y=0 is far end (v=1)
    ctx.fillStyle = 'rgba(255,150,60,0.06)';
    for (let r = 60; r > 12; r -= 12) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// baked spill for the sidewalk slabs: pools at both long edges
function drawWalkSpill(ctx, w, h) {
  const rng = mulberry32(909);
  ctx.fillStyle = 'rgb(16,20,28)';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  const cols = [[255, 80, 160], [80, 200, 235], [255, 150, 70], [190, 100, 255]];
  for (const side of [0, 1]) {
    let y = rng() * 80;
    while (y < h) {
      const [r, g, b] = cols[Math.floor(rng() * cols.length)];
      const inten = 0.25 + rng() * 0.4;
      const reach = w * (0.35 + rng() * 0.3);
      const len = 50 + rng() * 120;
      ctx.save();
      ctx.translate(side ? w : 0, y);
      ctx.scale(1, len / reach);
      const gr = ctx.createRadialGradient(0, 0, reach * 0.05, 0, 0, reach);
      gr.addColorStop(0, `rgba(${r},${g},${b},${inten})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(0, 0, reach, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      y += len * (0.9 + rng() * 1.1);
    }
  }
}

// ---- sidewalk concrete -----------------------------------------------------

function drawSidewalk(ctx, w, h) {
  const rng = mulberry32(303);
  ctx.fillStyle = '#151820';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 3200; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(80,86,102,0.07)' : 'rgba(0,0,0,0.09)';
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
  }
  // stains / gum / damp patches
  for (let i = 0; i < 22; i++) {
    ctx.fillStyle = `rgba(4,5,9,${0.12 + rng() * 0.22})`;
    ctx.beginPath();
    ctx.ellipse(rng() * w, rng() * h, 10 + rng() * 60, 8 + rng() * 40, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // expansion joints (slab grid)
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 4;
  for (let x = 0; x <= w; x += 128) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y <= h; y += 128) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(100,106,122,0.14)';
  ctx.lineWidth = 2;
  for (let x = 3; x <= w; x += 128) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 3; y <= h; y += 128) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
}

// ---- manhole cover ---------------------------------------------------------

function drawManhole(ctx, w, h) {
  const rng = mulberry32(404);
  const cx = w / 2, cy = h / 2;
  ctx.fillStyle = '#1a1d22';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#08090b';
  ctx.lineWidth = 12;
  ctx.beginPath(); ctx.arc(cx, cy, w * 0.44, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(150,160,180,0.3)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, w * 0.47, -2.4, 0.6); ctx.stroke();
  // waffle pattern
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  for (let r = w * 0.10; r < w * 0.40; r += w * 0.085) {
    const n = Math.floor(r / 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r;
      ctx.fillRect(cx + Math.cos(a) * r - 3, cy + Math.sin(a) * r - 3, 6, 6);
    }
  }
  // grime
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(100,108,124,0.09)' : 'rgba(0,0,0,0.12)';
    ctx.fillRect(rng() * w, rng() * h, 2, 2);
  }
}

// ---- steam-vent grate ------------------------------------------------------

function drawGrate(ctx, w, h) {
  ctx.fillStyle = '#0f1114';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#191c22';
  ctx.fillRect(0, 0, w, 6); ctx.fillRect(0, h - 6, w, 6);
  ctx.fillRect(0, 0, 6, h); ctx.fillRect(w - 6, 0, 6, h);
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  for (let x = 10; x < w - 10; x += 12) ctx.fillRect(x, 8, 7, h - 16);
}

function drawGrateEmissive(ctx, w, h) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.shadowColor = 'rgba(255,120,40,0.9)';
  ctx.shadowBlur = 5;
  ctx.fillStyle = 'rgba(255,130,50,0.75)';
  for (let x = 10; x < w - 10; x += 12) ctx.fillRect(x, 10, 7, h - 20);
}

// ---- crate wood ------------------------------------------------------------

function drawWood(ctx, w, h) {
  const rng = mulberry32(505);
  ctx.fillStyle = '#31291b';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 220; i++) {
    ctx.strokeStyle = rng() < 0.5 ? 'rgba(84,72,52,0.3)' : 'rgba(10,9,6,0.3)';
    ctx.lineWidth = 1;
    const y = rng() * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y + (rng() - 0.5) * 6); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 3;
  for (let y = 0; y <= h; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
}

// ---- distant base fill -----------------------------------------------------

function drawBase(ctx, w, h) {
  const rng = mulberry32(606);
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(56,62,78,0.05)' : 'rgba(0,0,0,0.08)';
    const s = 1 + rng() * 5;
    ctx.fillRect(rng() * w, rng() * h, s, s);
  }
}

// ---- reflector shader (asphalt-aware planar reflection) --------------------

const WetStreetShader = {
  name: 'WetStreetReflector',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uMask: { value: null },
    uRepeat: { value: new THREE.Vector2(1, REPEAT_Z) },
    uTime: { value: 0 },
    fogColor: { value: new THREE.Color(0x121a24) },
    fogDensity: { value: 0.0125 },
    fogNear: { value: 1 },
    fogFar: { value: 1000 },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vRefUv;
    varying vec2 vUv;
    varying vec3 vWorld;
    varying float vFogDepth;
    void main() {
      vUv = uv;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vRefUv = textureMatrix * vec4(position, 1.0);
      vec4 mv = viewMatrix * wp;
      vFogDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform sampler2D uMask;
    uniform vec2 uRepeat;
    uniform float uTime;
    uniform vec3 fogColor;
    uniform float fogDensity;
    uniform float fogNear;
    uniform float fogFar;
    varying vec4 vRefUv;
    varying vec2 vUv;
    varying vec3 vWorld;
    varying float vFogDepth;
    void main() {
      float rough = texture2D(uMask, vUv * uRepeat).g;
      float wet = 1.0 - rough;
      float puddle = smoothstep(0.42, 0.86, wet);

      // rain-agitated ripple — gentle, so mirrored signs stay legible
      float amp = 0.0007 + 0.0018 * puddle;
      vec2 ripple = vec2(
        sin(vWorld.x * 2.4 + uTime * 1.9) + sin(vWorld.z * 1.7 - uTime * 1.4) + 0.35 * sin((vWorld.x + vWorld.z) * 3.9 + uTime * 2.6),
        cos(vWorld.x * 1.9 - uTime * 1.2) + cos(vWorld.z * 2.8 + uTime * 2.1) + 0.35 * cos((vWorld.z - vWorld.x) * 4.3 - uTime * 1.7)
      ) * (amp / 2.5);
      vec4 p = vRefUv;
      p.xy += ripple * p.w;

      // slight vertical smear on merely-damp asphalt -> neon streaks;
      // near-zero inside true puddles so the image survives
      float smear = 0.005 * (1.0 - puddle) + 0.0006;
      vec4 p1 = p; p1.y += smear * p.w;
      vec4 p2 = p; p2.y -= smear * 0.6 * p.w;
      vec3 refl =
        texture2DProj(tDiffuse, p).rgb * 0.55 +
        texture2DProj(tDiffuse, p1).rgb * 0.27 +
        texture2DProj(tDiffuse, p2).rgb * 0.18;
      refl *= color;
      refl *= mix(0.5, 1.0, puddle);

      vec3 viewDir = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 2.2);
      float alpha = mix(0.14, 0.95, puddle) * (0.4 + 0.6 * fres);

      float fogAtten = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      gl_FragColor = vec4(refl, alpha * clamp(fogAtten, 0.0, 1.0));
      #include <colorspace_fragment>
    }`,
};

// ---------------------------------------------------------------------------

export function buildGround() {
  const group = new THREE.Group();
  const rng = mulberry32(1337);

  // -- textures --
  const asphaltMap = canvasTex(1024, 2048, drawAsphalt, { srgb: true, repeat: [1, REPEAT_Z] });
  const roughMap = canvasTex(512, 1024, drawRoughness, { repeat: [1, REPEAT_Z] });
  const streetSpill = canvasTex(256, 1024, drawStreetSpill);       // non-repeating
  const walkSpill = canvasTex(128, 1024, drawWalkSpill);           // non-repeating
  const walkMap = canvasTex(512, 512, drawSidewalk, { srgb: true, repeat: [2, 80] });
  const baseMap = canvasTex(256, 256, drawBase, { srgb: true, repeat: [55, 55] });
  const manholeMap = canvasTex(256, 256, drawManhole, { srgb: true });
  const grateMap = canvasTex(128, 96, drawGrate, { srgb: true });
  const grateEmit = canvasTex(128, 96, drawGrateEmissive, { srgb: true });
  const woodMap = canvasTex(128, 128, drawWood, { srgb: true });

  // -- distant base fill --
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ map: baseMap, roughness: 0.55, metalness: 0.05 })
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = -0.06;
  base.receiveShadow = true;
  group.add(base);

  // -- roadway --
  const streetMat = new THREE.MeshStandardMaterial({
    map: asphaltMap,
    roughnessMap: roughMap,
    roughness: 1.0,
    bumpMap: roughMap,
    bumpScale: 0.05,
    metalness: 0.05,
    lightMap: streetSpill,
    lightMapIntensity: 2.6,
  });
  const street = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, LEN), streetMat);
  street.rotation.x = -Math.PI / 2;
  street.position.set(0, 0.01, Z_CENTER);
  street.receiveShadow = true;
  group.add(street);

  // -- planar reflection overlay (puddles mirror the neon above) --
  const reflector = new Reflector(new THREE.PlaneGeometry(ROAD_HALF * 2, LEN), {
    clipBias: 0.003,
    textureWidth: 640,
    textureHeight: 640,
    color: 0xd2d6dd,
    multisample: 0,
    shader: WetStreetShader,
  });
  reflector.rotation.x = -Math.PI / 2;
  reflector.position.set(0, 0.055, Z_CENTER);
  const reflMat = reflector.material;
  reflMat.uniforms.uMask.value = roughMap;
  reflMat.transparent = true;
  reflMat.blending = THREE.AdditiveBlending; // wet-film specular adds on top of asphalt
  reflMat.depthWrite = false;
  reflMat.fog = true; // let renderer feed fogColor/fogDensity
  reflector.renderOrder = 2;
  // SwiftShader perf: the mirrored scene render is expensive — refresh the
  // reflection texture every 3rd frame (ripple/composite is per-frame).
  {
    let frame = 0;
    const innerOBR = reflector.onBeforeRender;
    reflector.onBeforeRender = function (...args) {
      if (frame++ % 3 !== 0) return;
      innerOBR.apply(this, args);
    };
  }
  group.add(reflector);

  // -- low local lights: sodium over a vent, cyan + magenta sign spill.
  // Small distance-bounded points so markings/manholes catch real hot hits.
  const lights = [
    [0xff9a44, 55, 26, 7.2, 3.5, 22],
    [0x3fd2ff, 45, 24, -6.9, 4.0, -14],
    [0xff4fa8, 50, 26, 7.0, 4.5, -62],
  ];
  for (const [col, inten, dist, x, y, z] of lights) {
    const pl = new THREE.PointLight(col, inten, dist, 2);
    pl.position.set(x, y, z);
    group.add(pl);
  }

  // -- sidewalks + curbs --
  const walkMat = new THREE.MeshStandardMaterial({
    map: walkMap, roughness: 0.48, metalness: 0.02, bumpMap: walkMap, bumpScale: 0.06,
    lightMap: walkSpill, lightMapIntensity: 2.4,
  });
  const curbMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.5, metalness: 0.02 });
  for (const side of [-1, 1]) {
    const walk = new THREE.Mesh(new THREE.BoxGeometry(WALK_W, 0.4, LEN), walkMat);
    walk.position.set(side * (ROAD_HALF + 0.35 + WALK_W / 2), -0.02, Z_CENTER);
    walk.receiveShadow = true;
    group.add(walk);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.44, LEN), curbMat);
    curb.position.set(side * (ROAD_HALF + 0.1), 0, Z_CENTER);
    curb.receiveShadow = true;
    group.add(curb);
  }

  // -- instancing helpers --
  const M = (x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) =>
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz)
    );
  const instanced = (geo, mat, list) => {
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((mx, i) => m.setMatrixAt(i, mx));
    m.instanceMatrix.needsUpdate = true;
    group.add(m);
    return m;
  };

  // -- manhole covers --
  const manholes = [];
  for (let i = 0; i < 8; i++) {
    manholes.push(M((rng() - 0.5) * 11, 0.032, 48 - rng() * 265, rng() * Math.PI * 2));
  }
  instanced(
    new THREE.CylinderGeometry(0.62, 0.62, 0.05, 20),
    new THREE.MeshStandardMaterial({ map: manholeMap, roughness: 0.3, metalness: 0.7 }),
    manholes
  );

  // -- steam-vent grates (weather agent supplies the steam above these) --
  const grateMat = new THREE.MeshStandardMaterial({
    map: grateMap, emissiveMap: grateEmit, emissive: 0xff7a30, emissiveIntensity: 0.8,
    roughness: 0.4, metalness: 0.6,
  });
  const grates = [];
  for (const [hx, hz] of HERO_GRATES) grates.push(M(hx, 0.045, hz, 0));
  for (let i = 0; i < 5; i++) {
    const side = rng() < 0.5 ? -1 : 1;
    const inStreet = rng() < 0.4;
    const x = inStreet ? side * (ROAD_HALF - 1.6) : side * (ROAD_HALF + 1.8 + rng() * 3.5);
    const y = inStreet ? 0.045 : 0.22;
    grates.push(M(x, y, 44 - rng() * 255, rng() < 0.5 ? 0 : Math.PI / 2));
  }
  instanced(new THREE.BoxGeometry(1.5, 0.09, 1.0), grateMat, grates);

  // warm vent under-glow pooling on the wet asphalt (additive decal)
  const glowTex = canvasTex(128, 128, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.32)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }, { srgb: true });
  const glowMat = (color, opacity) => new THREE.MeshBasicMaterial({
    map: glowTex, color, opacity, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  });
  const ventGlow = glowMat(0xff8c3a, 0.8);
  const poolGeo = new THREE.PlaneGeometry(6.5, 4.4);
  for (const [hx, hz] of HERO_GRATES) {
    const pool = new THREE.Mesh(poolGeo, ventGlow);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(hx, 0.07, hz);
    pool.renderOrder = 3;
    group.add(pool);
  }

  // -- clutter clusters on the sidewalks (street corridor stays clear) --
  const crateMats = [];
  const bagMats = [];
  const cardMats = [];
  const clusterInfo = [];
  for (let c = 0; c < 14; c++) {
    const side = rng() < 0.5 ? -1 : 1;
    const cx = side * (10.6 + rng() * 4.4);
    const cz = 46 - rng() * 250;
    clusterInfo.push([cx, cz]);
    const n = 2 + Math.floor(rng() * 5);
    for (let i = 0; i < n; i++) {
      const x = cx + (rng() - 0.5) * 2.4;
      const z = cz + (rng() - 0.5) * 3.2;
      const kind = rng();
      if (kind < 0.34) {
        const s = 0.45 + rng() * 0.5;
        crateMats.push(M(x, 0.18 + s / 2, z, rng() * Math.PI, s, s, s, 0, (rng() - 0.5) * 0.06));
      } else if (kind < 0.75) {
        const s = 0.55 + rng() * 0.65;
        bagMats.push(M(x, 0.18 + 0.3 * s, z, rng() * Math.PI, s, s * 0.62, s * (0.8 + rng() * 0.4)));
      } else {
        cardMats.push(M(x, 0.21, z, rng() * Math.PI, 0.9 + rng() * 0.6, 1, 0.7 + rng() * 0.5, (rng() - 0.5) * 0.1));
      }
    }
  }
  instanced(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ map: woodMap, roughness: 0.85, metalness: 0.0 }),
    crateMats
  );
  instanced(
    new THREE.IcosahedronGeometry(0.5, 1),
    new THREE.MeshStandardMaterial({ color: 0x1a1f27, roughness: 0.3, metalness: 0.1 }),
    bagMats
  );
  instanced(
    new THREE.BoxGeometry(1, 0.07, 1),
    new THREE.MeshStandardMaterial({ color: 0x453a26, roughness: 0.95, metalness: 0.0 }),
    cardMats
  );

  // sign-spill decals under some clutter clusters so the junk reads at night
  const decalCols = [0xff4fa0, 0x33ccee, 0xff9440];
  const decalGeo = new THREE.PlaneGeometry(4.6, 3.4);
  const decalMats = decalCols.map((c) => glowMat(c, 0.4));
  clusterInfo.slice(0, 9).forEach(([cx, cz], i) => {
    const d = new THREE.Mesh(decalGeo, decalMats[i % 3]);
    d.rotation.x = -Math.PI / 2;
    d.position.set(cx, 0.19, cz);
    d.renderOrder = 3;
    group.add(d);
  });

  return {
    group,
    update(t) {
      reflMat.uniforms.uTime.value = t;
    },
  };
}
