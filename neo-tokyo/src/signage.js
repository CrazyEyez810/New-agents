import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './city.js';

// ============================================================================
// SIGNAGE — neon signs, giant holograms, video billboards.
// Owned by the SIGNAGE agent. Deterministic (mulberry32), fully procedural.
// ============================================================================

const FONT = '"IPAGothic","WenQuanYi Zen Hei",sans-serif';

// ---------------------------------------------------------------------------
// Neon tube canvas rendering: hot white core + saturated colored halo.
// ---------------------------------------------------------------------------
function neonCanvas({ text, sub, color, vertical, border, dead }) {
  const chars = [...text];
  const cell = 104, pad = 64;
  const scratch = document.createElement('canvas').getContext('2d');
  scratch.font = `bold ${cell * 0.82}px ${FONT}`;
  let w, h;
  const widths = chars.map((c) => scratch.measureText(c).width);
  if (vertical) {
    w = cell + pad * 2;
    h = chars.length * cell + pad * 2 + (sub ? 70 : 0);
  } else {
    w = widths.reduce((a, b) => a + b + 10, 0) + pad * 2;
    h = cell + pad * 2 + (sub ? 74 : 0);
  }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  const drawGlyph = (c, x, y, isDead) => {
    g.font = `bold ${cell * 0.82}px ${FONT}`;
    if (isDead) {
      // Dead tube: faint colored ghost, no core, no halo.
      g.globalAlpha = 0.13;
      g.shadowBlur = 0;
      g.fillStyle = color;
      g.fillText(c, x, y);
      g.globalAlpha = 1;
      return;
    }
    g.shadowColor = color;
    g.fillStyle = color;
    for (const b of [46, 26, 14]) { g.shadowBlur = b; g.fillText(c, x, y); }
    g.shadowBlur = 7;
    g.fillStyle = '#ffffff';
    g.fillText(c, x, y);
    g.shadowBlur = 0;
    g.globalAlpha = 0.95;
    g.fillText(c, x, y);
    g.globalAlpha = 1;
  };

  if (vertical) {
    chars.forEach((c, i) => drawGlyph(c, w / 2, pad + cell * (i + 0.52), dead?.includes(i)));
  } else {
    let x = pad;
    chars.forEach((c, i) => {
      drawGlyph(c, x + widths[i] / 2, pad + cell * 0.52, dead?.includes(i));
      x += widths[i] + 10;
    });
  }

  if (sub) {
    g.font = `bold 42px ${FONT}`;
    g.shadowColor = color;
    for (const b of [22, 10]) { g.shadowBlur = b; g.fillStyle = color; g.fillText(sub, w / 2, h - 52); }
    g.shadowBlur = 4; g.fillStyle = '#fff'; g.fillText(sub, w / 2, h - 52);
    g.shadowBlur = 0;
  }

  if (border) {
    const m = 26;
    g.lineWidth = 7;
    g.strokeStyle = color;
    g.shadowColor = color;
    for (const b of [30, 14]) { g.shadowBlur = b; g.strokeRect(m, m, w - m * 2, h - m * 2); }
    g.lineWidth = 3.5;
    g.strokeStyle = '#fff';
    g.shadowBlur = 5;
    g.strokeRect(m, m, w - m * 2, h - m * 2);
    g.shadowBlur = 0;
  }
  return cv;
}

// Shared soft radial gradient for wall-spill glow quads.
function radialGlowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.18)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Oriented strut box between two points (for cables / bracket arms).
const _up = new THREE.Vector3(0, 1, 0);
function strut(p1, p2, r) {
  const dir = new THREE.Vector3().subVectors(p2, p1);
  const len = dir.length();
  const geo = new THREE.BoxGeometry(r, len, r);
  const q = new THREE.Quaternion().setFromUnitVectors(_up, dir.clone().normalize());
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5),
    q,
    new THREE.Vector3(1, 1, 1),
  );
  geo.applyMatrix4(m);
  return geo;
}
function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

// Deterministic flicker curves (pure functions of t).
function flickerVal(t, ph) {
  const s = Math.sin(t * 2.1 + ph) + Math.sin(t * 5.77 + ph * 2.3) + Math.sin(t * 13.9 + ph * 0.7);
  const on = s > -1.35 ? 1 : 0.1;
  return on * (0.93 + 0.07 * Math.sin(t * 118 + ph));
}
function buzzVal(t, ph) {
  const s = Math.sin(t * 23.7 + ph) * Math.sin(t * 5.3 + ph * 1.7) + Math.sin(t * 3.1 + ph);
  return s > 1.25 ? 0.9 : 0.16 + 0.05 * Math.sin(t * 91 + ph);
}

// ---------------------------------------------------------------------------
// Video billboard ad rendering — animated, deterministic in t.
// ---------------------------------------------------------------------------
const AD_PALETTES = [
  { bg0: '#0a0f1f', bg1: '#172c55', a: '#31e5ff', b: '#ff2d95', accent: 0x31c8ff },
  { bg0: '#1c0a0e', bg1: '#43181f', a: '#ffab2e', b: '#ff4433', accent: 0xff8830 },
  { bg0: '#140c24', bg1: '#2c1b52', a: '#c96bff', b: '#31e5ff', accent: 0x9a5cff },
  { bg0: '#0a1a10', bg1: '#123a26', a: '#3affc3', b: '#ffd447', accent: 0x2fe0a8 },
];
const AD_TEXTS = [
  { big: '未来', sub: 'MIRAI CORP', tag: '明日を設計する' },
  { big: 'ソラ・コーラ', sub: 'SORA COLA', tag: '冷たい夜に' },
  { big: '東雲電子', sub: 'SHINONOME DENSHI', tag: 'SYSTEM 7 発売中' },
  { big: '夢を買う', sub: 'DREAM MARKET', tag: '24時間営業' },
  { big: '銀河ホテル', sub: 'HOTEL GINGA', tag: '空室あり VACANCY' },
  { big: '月光ビール', sub: 'GEKKO BEER', tag: '生 DRAFT' },
];
function hash1(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }

function drawAd(g, W, H, t, bbSeed) {
  const CYCLE = 7;
  const idx = Math.floor(t / CYCLE + bbSeed);
  const tl = (t / CYCLE + bbSeed - idx) * CYCLE; // 0..CYCLE local time
  const pal = AD_PALETTES[Math.floor(hash1(idx * 3.7 + bbSeed) * AD_PALETTES.length)];
  const txt = AD_TEXTS[Math.floor(hash1(idx * 9.1 + bbSeed * 2) * AD_TEXTS.length)];
  const type = Math.floor(hash1(idx * 5.3 + bbSeed) * 3);
  const portrait = H > W;

  // Background.
  const grad = g.createLinearGradient(0, 0, W * 0.3, H);
  grad.addColorStop(0, pal.bg0);
  grad.addColorStop(1, pal.bg1);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  if (type === 0) {
    // Expanding rings + grid.
    g.strokeStyle = pal.a; g.globalAlpha = 0.22; g.lineWidth = 1;
    for (let x = 0; x < W; x += 28) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = 0; y < H; y += 28) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.globalAlpha = 1;
    const cx = W * 0.5, cy = H * (portrait ? 0.34 : 0.46);
    for (let k = 0; k < 3; k++) {
      const r = ((tl * 0.35 + k * 0.33) % 1);
      g.globalAlpha = (1 - r) * 0.7;
      g.strokeStyle = k % 2 ? pal.b : pal.a;
      g.lineWidth = 5;
      g.beginPath(); g.arc(cx, cy, 12 + r * Math.min(W, H) * 0.55, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
  } else if (type === 1) {
    // Diagonal duotone + rising bubbles.
    g.fillStyle = pal.b; g.globalAlpha = 0.16;
    g.beginPath(); g.moveTo(W, 0); g.lineTo(W, H); g.lineTo(W * 0.35, H); g.closePath(); g.fill();
    g.globalAlpha = 1;
    for (let i = 0; i < 14; i++) {
      const bx = hash1(i * 7.7 + bbSeed) * W;
      const by = H + 30 - ((tl * 60 + i * 53) % (H + 60));
      const br = 3 + hash1(i * 3.1) * 9;
      g.globalAlpha = 0.75;
      g.strokeStyle = pal.a; g.lineWidth = 2.5;
      g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
  } else {
    // Scrolling waveforms.
    for (let k = 0; k < 3; k++) {
      g.strokeStyle = k === 1 ? pal.b : pal.a;
      g.globalAlpha = 0.85 - k * 0.18;
      g.lineWidth = 4;
      g.beginPath();
      for (let x = 0; x <= W; x += 6) {
        const y = H * (0.55 + k * 0.13) +
          Math.sin(x * 0.03 + tl * (2 + k) + k * 9) * H * 0.06 *
          (1 + 0.6 * Math.sin(x * 0.008 + tl));
        x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  // Main kanji.
  const bigSize = Math.min(W / (txt.big.length * 0.95), H * (portrait ? 0.16 : 0.34));
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${bigSize}px ${FONT}`;
  g.shadowColor = pal.a; g.shadowBlur = 24;
  g.fillStyle = pal.a;
  const ty = H * (portrait ? 0.42 : 0.44);
  g.fillText(txt.big, W / 2, ty);
  g.shadowBlur = 6; g.fillStyle = '#fff';
  g.fillText(txt.big, W / 2, ty);
  g.shadowBlur = 0;
  // Latin sub + tagline.
  g.font = `bold ${Math.max(16, bigSize * 0.22)}px ${FONT}`;
  g.fillStyle = pal.b;
  g.shadowColor = pal.b; g.shadowBlur = 10;
  g.fillText(txt.sub, W / 2, ty + bigSize * 0.72);
  g.shadowBlur = 0;
  g.font = `${Math.max(13, bigSize * 0.16)}px ${FONT}`;
  g.fillStyle = 'rgba(255,255,255,0.75)';
  g.fillText(txt.tag, W / 2, H * 0.9);

  // Sweep band + scanlines + vignette.
  const sy = (tl * 0.22 % 1) * H;
  const sg = g.createLinearGradient(0, sy - 26, 0, sy + 26);
  sg.addColorStop(0, 'rgba(255,255,255,0)');
  sg.addColorStop(0.5, 'rgba(255,255,255,0.10)');
  sg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sg; g.fillRect(0, sy - 26, W, 52);
  g.fillStyle = 'rgba(0,0,0,0.16)';
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1.6);
  const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  return pal.accent;
}

// ---------------------------------------------------------------------------
// Hologram figure silhouette (Joi-like), baked to canvas.
// ---------------------------------------------------------------------------
function figureCanvas() {
  const W = 256, H = 1024;
  const buf = document.createElement('canvas');
  buf.width = W; buf.height = H;
  const b = buf.getContext('2d');
  b.translate(W / 2, 0);
  b.fillStyle = '#ffffff';

  // Head + sleek bob hair, kept narrower than the shoulders.
  b.beginPath(); b.ellipse(0, 138, 32, 42, 0, 0, Math.PI * 2); b.fill();
  b.beginPath();
  b.moveTo(-34, 110);
  b.quadraticCurveTo(-42, 152, -35, 192);
  b.quadraticCurveTo(-18, 200, 0, 196);
  b.quadraticCurveTo(18, 200, 35, 192);
  b.quadraticCurveTo(42, 152, 34, 110);
  b.quadraticCurveTo(0, 80, -34, 110);
  b.closePath(); b.fill();
  // Neck.
  b.fillRect(-13, 178, 26, 52);
  // Torso: sloped shoulders -> waist -> hips.
  b.beginPath();
  b.moveTo(-13, 222);
  b.quadraticCurveTo(-46, 234, -54, 272);
  b.quadraticCurveTo(-46, 350, -33, 424);
  b.quadraticCurveTo(-48, 468, -51, 520);
  b.quadraticCurveTo(-28, 552, 0, 558);
  b.quadraticCurveTo(28, 552, 51, 520);
  b.quadraticCurveTo(48, 468, 33, 424);
  b.quadraticCurveTo(46, 350, 54, 272);
  b.quadraticCurveTo(46, 234, 13, 222);
  b.closePath(); b.fill();
  // Arms hanging with a sliver of negative space beside the waist.
  for (const s of [-1, 1]) {
    b.beginPath();
    b.moveTo(s * 44, 252);
    b.quadraticCurveTo(s * 62, 296, s * 63, 396);
    b.quadraticCurveTo(s * 63, 486, s * 58, 562);
    b.lineTo(s * 46, 562);
    b.quadraticCurveTo(s * 48, 470, s * 46, 396);
    b.quadraticCurveTo(s * 44, 322, s * 36, 276);
    b.closePath(); b.fill();
  }
  // Long legs.
  for (const s of [-1, 1]) {
    b.beginPath();
    b.moveTo(s * 49, 512);
    b.quadraticCurveTo(s * 42, 660, s * 30, 780);
    b.quadraticCurveTo(s * 23, 880, s * 21, 952);
    b.lineTo(s * 27, 986);
    b.lineTo(s * 9, 986);
    b.lineTo(s * 8, 940);
    b.quadraticCurveTo(s * 7, 840, s * 10, 720);
    b.quadraticCurveTo(s * 11, 620, s * 6, 556);
    b.closePath(); b.fill();
  }

  // Composite with soft halo + bright rim.
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.shadowColor = '#ffffff';
  for (const bl of [26, 12]) { g.shadowBlur = bl; g.globalAlpha = 0.5; g.drawImage(buf, 0, 0); }
  g.shadowBlur = 0; g.globalAlpha = 0.92;
  g.drawImage(buf, 0, 0);
  g.globalAlpha = 1;
  return cv;
}

const HOLO_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const HOLO_FRAG = /* glsl */`
  uniform sampler2D uTex;
  uniform float uTime, uPhase, uIntensity;
  uniform vec3 uColA, uColB;
  varying vec2 vUv;
  float hash(float n) { return fract(sin(n) * 43758.5453123); }
  void main() {
    vec2 uv = vUv;
    // Horizontal band glitch.
    float band = floor(uv.y * 72.0);
    float gl = hash(band * 1.37 + floor(uTime * 6.0) * 0.61 + uPhase);
    uv.x += (hash(band + floor(uTime * 11.0)) - 0.5) * step(0.955, gl) * 0.05;
    // Rare whole-figure tear.
    float tear = step(0.986, hash(floor(uTime * 3.0) + uPhase * 3.1));
    uv.x += tear * (step(0.5, fract(uv.y * 7.0 + uTime)) - 0.5) * 0.02;
    vec4 s = texture2D(uTex, uv);
    float lum = s.r * s.a;
    vec3 col = mix(uColB, uColA, uv.y);
    float scan = 0.72 + 0.28 * sin(uv.y * 700.0 + uTime * 3.0);
    float vband = 0.88 + 0.12 * sin(uv.x * 80.0 + uTime * 0.8 + uPhase);
    float sweep = exp(-45.0 * pow(fract(uv.y + uTime * 0.055 + uPhase * 0.3) - 0.5, 2.0)) * 0.55;
    float flick = 0.84 + 0.16 * sin(uTime * 29.0 + uPhase) * sin(uTime * 7.7 + uPhase * 2.0);
    float fade = smoothstep(0.0, 0.05, uv.y) * smoothstep(1.0, 0.93, uv.y);
    vec3 c = col * lum * uIntensity * scan * vband * (1.0 + sweep) * flick * fade;
    gl_FragColor = vec4(c, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Main build.
// ---------------------------------------------------------------------------
export function buildSignage() {
  const rng = mulberry32(90210);
  const group = new THREE.Group();
  const steelGeos = [];   // frames, backings, brackets — one dark merged mesh
  const cableGeos = [];   // thin cables — separate near-black merged mesh
  const flickers = [];    // { mat, base, ph, kind, haloIdx, haloCol }
  const glowTex = radialGlowTexture();

  // -- Neon sign catalogue --------------------------------------------------
  const POOL = [
    { text: 'ラーメン', sub: 'RAMEN', v: true },
    { text: '寿司', v: true, border: true },
    { text: 'ホテル', sub: 'HOTEL', v: true },
    { text: '電気', v: false },
    { text: 'カラオケ', sub: 'KARAOKE', v: true },
    { text: '夢', v: false, border: true },
    { text: '未来', v: false },
    { text: '居酒屋', v: true },
    { text: 'バー月光', sub: 'BAR GEKKO', v: false },
    { text: '質屋', v: true, border: true },
    { text: '薬局', v: false },
    { text: '焼肉', v: true },
    { text: 'パチンコ', v: false },
    { text: 'スナック蘭', v: true },
    { text: '純喫茶', sub: 'COFFEE', v: true },
    { text: 'ソラ・コーラ', sub: 'SORA COLA', v: false },
    { text: '月光ビール', sub: 'GEKKO BEER', v: false },
    { text: '銀河ホテル', sub: 'HOTEL GINGA', v: false },
    { text: 'サウナ', v: true },
    { text: '深夜営業', v: false },
    { text: '24時間', sub: 'OPEN', v: false, border: true },
    { text: '天ぷら', v: true },
    { text: 'ゲーム', v: true },
    { text: '東雲電子', sub: 'SHINONOME', v: false },
    { text: 'ビリヤード', v: true },
    { text: '酒', v: false, border: true },
    { text: 'クラブ夜光', v: true },
    { text: '麺屋一番', v: true },
    { text: 'ネオ茶', sub: 'NEO-CHA', v: false },
    { text: '占い', v: true },
  ];
  const COLORS = [
    '#ff2d95', '#ff2d95', '#ff5fb0',        // magenta / pink
    '#2ee6ff', '#2ee6ff', '#19d3c5',        // cyan / teal
    '#ffa028', '#ffb545', '#ffa028',        // warm sodium orange
    '#ff2626',                              // deep red (rare)
    '#b46bff',                              // violet (rare)
  ];

  // Halo spill quads: instanced, per-instance color.
  const haloMat = new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const haloEntries = []; // { pos, quat, scale, color }

  let poolIdx = 0;
  const nextSpec = () => POOL[poolIdx++ % POOL.length];

  // Build one neon sign. kind: 'flag' (perpendicular, protruding) | 'wall'.
  function addNeonSign({ side, z, y, kind, height, flicker, halfDead }) {
    const spec = nextSpec();
    const color = COLORS[(rng() * COLORS.length) | 0];
    const dead = halfDead
      ? [...spec.text].map((_, i) => i).filter(() => rng() < 0.5)
      : null;
    const cv = neonCanvas({ ...spec, vertical: spec.v, color, dead });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const aspect = cv.width / cv.height;
    let hgt = height, wid = hgt * aspect;
    // Keep kanban from spanning the street / walls from looking like barn doors.
    const maxW = kind === 'flag' ? 4.0 : 9.5;
    if (wid > maxW) { wid = maxW; hgt = wid / aspect; }
    const base = (spec.border ? 2.8 : 3.6) + rng() * 1.2;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    mat.color.setScalar(halfDead ? base * 0.55 : base);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wid, hgt), mat);

    const wallX = side * 10.1;
    const haloCol = new THREE.Color(color);
    let haloIdx = -1;

    if (kind === 'flag') {
      // Perpendicular kanban sticking out over the sidewalk, faces along z.
      const cx = wallX - side * (0.35 + wid / 2);
      mesh.position.set(cx, y + hgt / 2, z);
      // Dark cabinet behind the tubes.
      steelGeos.push(box(wid + 0.24, hgt + 0.3, 0.22, cx, y + hgt / 2, z));
      mesh.position.z += 0.16; // proud of cabinet on +z face
      // Bracket arms to the wall.
      const a1 = new THREE.Vector3(wallX, y + hgt - 0.3, z);
      const a2 = new THREE.Vector3(wallX, y + 0.3, z);
      steelGeos.push(strut(a1, new THREE.Vector3(cx - side * wid * 0.45, y + hgt - 0.3, z), 0.09));
      steelGeos.push(strut(a2, new THREE.Vector3(cx - side * wid * 0.45, y + 0.3, z), 0.09));
      // Diagonal tie cable.
      cableGeos.push(strut(
        new THREE.Vector3(wallX, y + hgt + 1.6, z),
        new THREE.Vector3(cx - side * wid * 0.4, y + hgt - 0.2, z), 0.035));
      // Wall spill behind.
      haloIdx = haloEntries.length;
      haloEntries.push({
        pos: new THREE.Vector3(wallX - side * 0.15, y + hgt / 2, z),
        rotY: side > 0 ? -Math.PI / 2 : Math.PI / 2,
        w: hgt * 1.4, h: hgt * 1.4, color: haloCol.clone().multiplyScalar(0.16),
      });
    } else {
      // Flat against the wall, facing the street.
      const px = wallX - side * 0.32;
      mesh.position.set(px, y + hgt / 2, z);
      mesh.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      steelGeos.push(box(0.2, hgt + 0.3, wid + 0.3, wallX - side * 0.1, y + hgt / 2, z));
      // Standoff pins.
      for (const dz of [-wid * 0.4, wid * 0.4]) {
        steelGeos.push(box(0.5, 0.12, 0.12, wallX + side * 0.1, y + 0.2, z + dz));
        steelGeos.push(box(0.5, 0.12, 0.12, wallX + side * 0.1, y + hgt - 0.2, z + dz));
      }
      // Sagging feed cable.
      cableGeos.push(strut(
        new THREE.Vector3(wallX - side * 0.2, y + hgt + 2.2 + rng() * 1.5, z + wid * 0.3),
        new THREE.Vector3(px, y + hgt - 0.1, z - wid * 0.1), 0.035));
      haloIdx = haloEntries.length;
      haloEntries.push({
        pos: new THREE.Vector3(wallX - side * 0.5, y + hgt / 2, z),
        rotY: side > 0 ? -Math.PI / 2 : Math.PI / 2,
        w: wid * 1.6, h: hgt * 2.0, color: haloCol.clone().multiplyScalar(0.16),
      });
    }
    group.add(mesh);

    if (flicker || halfDead) {
      flickers.push({
        mat, base: mat.color.r, ph: rng() * 20,
        kind: halfDead ? 'buzz' : 'flicker',
        haloIdx, haloCol: haloEntries[haloIdx].color.clone(),
      });
    }
  }

  // -- Placement along the corridor ----------------------------------------
  let flickerBudget = 5, deadBudget = 2, signCount = 0;
  for (const side of [-1, 1]) {
    // Low band: dense shop-front kanban, y 4–10.
    for (let z = 8 - rng() * 4; z > -116; z -= 8.5 + rng() * 6) {
      const kind = rng() < 0.62 ? 'flag' : 'wall';
      const doFlicker = flickerBudget > 0 && rng() < 0.16;
      const doDead = !doFlicker && deadBudget > 0 && rng() < 0.09;
      if (doFlicker) flickerBudget--;
      if (doDead) deadBudget--;
      addNeonSign({
        side, z, y: 4 + rng() * 5.5, kind,
        height: kind === 'flag' ? 4.2 + rng() * 2.6 : 2.4 + rng() * 1.6,
        flicker: doFlicker, halfDead: doDead,
      });
      signCount++;
    }
    // Mid band: y 13–30, sparser, larger.
    for (let z = 2 - rng() * 8; z > -112; z -= 15 + rng() * 10) {
      addNeonSign({
        side, z, y: 13 + rng() * 16, kind: rng() < 0.4 ? 'flag' : 'wall',
        height: 4.5 + rng() * 3.5,
        flicker: flickerBudget > 0 && rng() < 0.1 && !!flickerBudget--,
      });
      signCount++;
    }
    // High band: y 32–56, rare, big wall pieces.
    for (let z = -6 - rng() * 10; z > -105; z -= 32 + rng() * 16) {
      addNeonSign({
        side, z, y: 32 + rng() * 22, kind: 'wall',
        height: 6 + rng() * 4,
      });
      signCount++;
    }
  }

  // Instanced halo quads.
  const haloMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1), haloMat, haloEntries.length);
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const e = new THREE.Euler();
    haloEntries.forEach((hEnt, i) => {
      e.set(0, hEnt.rotY, 0);
      q.setFromEuler(e);
      s.set(hEnt.w, hEnt.h, 1);
      m.compose(hEnt.pos, q, s);
      haloMesh.setMatrixAt(i, m);
      haloMesh.setColorAt(i, hEnt.color);
    });
    haloMesh.instanceMatrix.needsUpdate = true;
    if (haloMesh.instanceColor) haloMesh.instanceColor.needsUpdate = true;
  }
  group.add(haloMesh);

  // -- Video billboards ------------------------------------------------------
  const billboards = [];
  const BB_DEFS = [
    { w: 14, h: 8, pos: [11.5, 30, -46], yaw: -Math.PI / 2 + 0.5, seed: 0.13, light: true, cw: 448, ch: 256 },
    { w: 8.5, h: 13, pos: [-11.4, 24, -64], yaw: Math.PI / 2 - 0.55, seed: 0.47, light: false, cw: 256, ch: 384 },
    { w: 11, h: 6.5, pos: [10.6, 13.5, -6], yaw: -Math.PI / 2 + 0.28, seed: 0.81, light: true, cw: 448, ch: 256 },
  ];
  for (const def of BB_DEFS) {
    const cv = document.createElement('canvas');
    cv.width = def.cw; cv.height = def.ch;
    const g2 = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    mat.color.setScalar(2.6);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(def.w, def.h), mat);
    const holder = new THREE.Group();
    holder.position.set(...def.pos);
    holder.rotation.y = def.yaw;
    screen.position.z = 0.18;
    holder.add(screen);
    // Bezel + backbox + support truss down to the wall.
    const bezel = new THREE.Mesh(
      new THREE.BoxGeometry(def.w + 0.9, def.h + 0.9, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x0c0e13, roughness: 0.6, metalness: 0.5 }));
    bezel.position.z = -0.2;
    holder.add(bezel);
    // Maintenance catwalk under the screen.
    const walk = new THREE.Mesh(
      new THREE.BoxGeometry(def.w + 1.6, 0.18, 1.1),
      new THREE.MeshStandardMaterial({ color: 0x101218, roughness: 0.8, metalness: 0.4 }));
    walk.position.set(0, -def.h / 2 - 0.75, 0.4);
    holder.add(walk);
    group.add(holder);
    // Truss struts to wall (world space).
    const side = Math.sign(def.pos[0]);
    const wall = new THREE.Vector3(side * 12.5, def.pos[1] - def.h * 0.7, def.pos[2]);
    cableGeos.push(strut(wall, new THREE.Vector3(def.pos[0], def.pos[1] - def.h / 2 - 0.7, def.pos[2] - 2), 0.09));
    cableGeos.push(strut(wall, new THREE.Vector3(def.pos[0], def.pos[1] - def.h / 2 - 0.7, def.pos[2] + 2), 0.09));

    // Colored spill: glow quad in front + optional real light.
    const glowMat = new THREE.MeshBasicMaterial({
      map: glowTex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(def.w * 1.6, def.h * 1.8), glowMat);
    glow.position.z = 0.8;
    holder.add(glow);
    let light = null;
    if (def.light) {
      light = new THREE.PointLight(0xffffff, 420, 55, 2);
      light.position.z = 4;
      holder.add(light);
    }
    billboards.push({ g2, tex, cv, seed: def.seed, glowMat, light, lastBucket: -1 });
  }

  // -- Giant holograms -------------------------------------------------------
  const figTex = new THREE.CanvasTexture(figureCanvas());
  figTex.colorSpace = THREE.SRGBColorSpace;
  const holoUniformsList = [];
  function addHologram({ pos, height, yaw, colA, colB, intensity, phase }) {
    const holder = new THREE.Group();
    holder.position.set(...pos);
    holder.rotation.y = yaw;
    const w = height * (256 / 1024) * 1.35;
    for (let i = 0; i < 3; i++) {
      const uniforms = {
        uTex: { value: figTex },
        uTime: { value: 0 },
        uPhase: { value: phase + i * 1.7 },
        uIntensity: { value: intensity * (i === 0 ? 1 : 0.4) },
        uColA: { value: new THREE.Color(colA) },
        uColB: { value: new THREE.Color(colB) },
      };
      const mat = new THREE.ShaderMaterial({
        vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG, uniforms,
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, height), mat);
      plane.position.set(0, height / 2 + 0.4, (i - 1) * height * 0.012);
      holder.add(plane);
      holoUniformsList.push(uniforms);
    }
    // Ground wash.
    const wash = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 1.5, w * 1.5),
      new THREE.MeshBasicMaterial({
        map: glowTex, color: new THREE.Color(colA).multiplyScalar(0.5),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
    wash.rotation.x = -Math.PI / 2;
    wash.position.y = 0.12;
    holder.add(wash);
    // Projector unit.
    const proj = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.1, 2.2),
      new THREE.MeshStandardMaterial({ color: 0x0d0f14, roughness: 0.55, metalness: 0.6 }));
    proj.position.y = 0.55;
    holder.add(proj);
    const lens = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.35),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colA).multiplyScalar(5) }));
    lens.rotation.x = -Math.PI / 2;
    lens.position.y = 1.11;
    holder.add(lens);
    const hlight = new THREE.PointLight(new THREE.Color(colA), 260, 45, 2);
    hlight.position.y = height * 0.35;
    holder.add(hlight);
    group.add(holder);
  }
  // Big Joi against the east wall mid-corridor, angled toward the street mouth.
  addHologram({
    pos: [7.6, 0, -58], height: 46, yaw: -0.42,
    colA: 0x38d8ff, colB: 0x6a4bff, intensity: 1.5, phase: 0.0,
  });
  // Smaller violet figure, west side, nearer.
  addHologram({
    pos: [-7.9, 0, -22], height: 27, yaw: 0.5,
    colA: 0xb06bff, colB: 0x3577ff, intensity: 1.25, phase: 4.2,
  });

  // -- Merge static steel / cables ------------------------------------------
  if (steelGeos.length) {
    const steel = new THREE.Mesh(
      mergeGeometries(steelGeos),
      new THREE.MeshStandardMaterial({ color: 0x0d0f14, roughness: 0.62, metalness: 0.55 }));
    group.add(steel);
  }
  if (cableGeos.length) {
    const cables = new THREE.Mesh(
      mergeGeometries(cableGeos),
      new THREE.MeshStandardMaterial({ color: 0x07080b, roughness: 0.9, metalness: 0.3 }));
    group.add(cables);
  }

  // -- Update -----------------------------------------------------------------
  const tmpC = new THREE.Color();
  function update(t) {
    // Neon flicker.
    let haloDirty = false;
    for (const f of flickers) {
      const v = f.kind === 'buzz' ? buzzVal(t, f.ph) : flickerVal(t, f.ph);
      f.mat.color.setScalar(f.base * v);
      if (f.haloIdx >= 0) {
        tmpC.copy(f.haloCol).multiplyScalar(v);
        haloMesh.setColorAt(f.haloIdx, tmpC);
        haloDirty = true;
      }
    }
    if (haloDirty && haloMesh.instanceColor) haloMesh.instanceColor.needsUpdate = true;
    // Billboards: redraw at 10 Hz buckets (deterministic in t).
    const bucket = Math.floor(t * 10);
    for (const bb of billboards) {
      if (bb.lastBucket !== bucket) {
        bb.lastBucket = bucket;
        const accent = drawAd(bb.g2, bb.cv.width, bb.cv.height, t, bb.seed);
        bb.tex.needsUpdate = true;
        bb.glowMat.color.set(accent).multiplyScalar(0.4);
        if (bb.light) bb.light.color.set(accent);
      }
    }
    // Holograms.
    for (const u of holoUniformsList) u.uTime.value = t;
  }

  return { group, update };
}
