import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './city.js';

// ============================================================================
// SIGNAGE — neon kanban, lightboxes, LED panels, video billboards, holograms.
// Owned by the SIGNAGE agent. Deterministic (mulberry32), fully procedural.
//
// DESIGN LAW (round 2). Every sign is a PANEL, not a floating additive smear.
//   * The old build drew glyphs onto a transparent canvas and multiplied them
//     by ~4.35 into an additive plane. Everything above 1.05 linear blooms, so
//     the entire glyph body — not just its core — haloed, the counters filled,
//     and a three-character kanban resolved as three white blobs that the
//     reviewer read as a traffic light. Additive also means the sign has no
//     body: at distance it mip-averages into coloured haze instead of a sign.
//   * Now: an OPAQUE cabinet face carries the artwork, mipmaps do the
//     down-res, and the emissive multiplier sits ~2.1 so only the thin eroded
//     tube core crosses the bloom threshold. Shape survives at every scale.
//   * Legibility floor: sub-text is only rendered as TYPE when its plate is
//     physically tall enough to resolve. Below that it degrades to a designed
//     solid bar; below that again it is dropped. Smeared type is worse than
//     no type.
// ============================================================================

const FONT = '"IPAGothic","WenQuanYi Zen Hei",sans-serif';
const CELL = 128;            // glyph cell, canvas px

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------
function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w));
  c.height = Math.max(2, Math.round(h));
  return c;
}
let _measure = null;
function measurer() {
  if (!_measure) _measure = mk(8, 8).getContext('2d');
  return _measure;
}
function hexRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexRGB(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function shade(hex, k) {
  const [r, g, b] = hexRGB(hex);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}
// Deterministic 2D hash — never Math.random().
function h2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function setSpacing(g, px) {
  try { g.letterSpacing = `${px}px`; } catch { /* older canvas2d */ }
}
// Shrink a font until the string fits maxW.
function fitFont(g, text, maxW, startPx, weight = 'bold') {
  let px = startPx;
  g.font = `${weight} ${px}px ${FONT}`;
  const w = g.measureText(text).width;
  if (w > maxW && w > 0) {
    px = Math.max(7, px * (maxW / w));
    g.font = `${weight} ${px}px ${FONT}`;
  }
  return px;
}

// ---------------------------------------------------------------------------
// Sign layout — computed BEFORE the plane is sized, so the legibility floor
// can be decided against real-world metres.
// ---------------------------------------------------------------------------
function planSign(spec) {
  const chars = [...spec.text];
  const g = measurer();
  g.font = `bold ${CELL * 0.86}px ${FONT}`;
  const widths = chars.map((c) => g.measureText(c).width);
  const M = Math.round(CELL * 0.27);
  const GAP = Math.round(CELL * 0.07);
  const subH = spec.sub ? Math.round(CELL * 0.60) : 0;
  let W, H;
  if (spec.vertical) {
    W = CELL + M * 2;
    H = chars.length * CELL + (chars.length - 1) * GAP + M * 2 + subH;
  } else {
    W = widths.reduce((a, b) => a + b, 0) + (chars.length - 1) * GAP + M * 2;
    H = CELL + M * 2 + subH;
  }
  return { chars, widths, W, H, M, GAP, subH, plateH: subH * 0.70 };
}

function glyphSlots(L, vertical) {
  const out = [];
  if (vertical) {
    for (let i = 0; i < L.chars.length; i++) {
      out.push({ c: L.chars[i], x: L.W / 2, y: L.M + i * (CELL + L.GAP) + CELL * 0.53 });
    }
  } else {
    let x = L.M;
    for (let i = 0; i < L.chars.length; i++) {
      out.push({ c: L.chars[i], x: x + L.widths[i] / 2, y: L.M + CELL * 0.53 });
      x += L.widths[i] + L.GAP;
    }
  }
  return out;
}

// A real neon tube is a saturated glass sheath with a HOT CORE INSIDE it. The
// core has to be an eroded copy of the letterform, not a white fill of it —
// a white fill is what turned every glyph into a lozenge. Erode by stroking
// the same path with destination-out.
function coreMask(slots, W, H, erode, res) {
  const c = mk(W * res, H * res);
  const g = c.getContext('2d');
  g.scale(res, res);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${CELL * 0.86}px ${FONT}`;
  g.fillStyle = '#ffffff';
  for (const s of slots) g.fillText(s.c, s.x, s.y);
  g.globalCompositeOperation = 'destination-out';
  g.lineWidth = erode;
  g.lineJoin = 'round';
  g.strokeStyle = '#000';
  for (const s of slots) g.strokeText(s.c, s.x, s.y);
  g.globalCompositeOperation = 'source-over';
  return c;
}

// Knock text (or tick slots) out of a solid colour plate. Used for sub-lines
// and lightbox faces: at any downscale this mips to a clean coloured bar
// instead of a mush of glowing pixels.
function knockPlate(w, h, color, text, mode, res = 1) {
  const c = mk(w * res, h * res);
  const g = c.getContext('2d');
  g.scale(res, res);
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, shade(color, 1.0));
  grd.addColorStop(0.55, shade(color, 0.82));
  grd.addColorStop(1, shade(color, 0.62));
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-out';
  if (mode === 'text' && text) {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    setSpacing(g, Math.max(1, h * 0.09));
    fitFont(g, text, w * 0.86, h * 0.66);
    g.fillStyle = '#000';
    g.fillText(text, w / 2, h * 0.54);
    setSpacing(g, 0);
  } else {
    // Designed filler: a run of slots, reads as a legend strip at any size.
    const n = 5;
    const sw = w / (n * 2 + 1);
    for (let i = 0; i < n; i++) {
      g.fillStyle = '#000';
      g.fillRect(sw * (1 + i * 2), h * 0.32, sw * (i === 2 ? 1.4 : 1), h * 0.36);
    }
  }
  g.globalCompositeOperation = 'source-over';
  return c;
}

// ---------------------------------------------------------------------------
// The sign face. style: 'neon' | 'lightbox' | 'led'
// ---------------------------------------------------------------------------
function renderSign(spec, L, o) {
  const { color, style, deadSet, plate, seed, scanY } = o;
  const res = o.res ?? 1;      // supersample factor — megas render at 2x so a
                               // 30m sign still has texels to spare on screen
  const W = L.W, H = L.H;
  const cv = mk(W * res, H * res);
  const g = cv.getContext('2d');
  g.scale(res, res);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const slots = glyphSlots(L, spec.vertical);
  const faceB = H - L.subH;         // bottom of the glyph field

  // -- cabinet face ---------------------------------------------------------
  // The cabinet is NOT black. A black face on an opaque plane punches a hole
  // through whatever is behind it and reads as a missing polygon, not a sign.
  // This sits at roughly the albedo of the surrounding concrete so an unlit
  // or half-dead unit reads as a dark object in the city, not a void.
  const bg = g.createLinearGradient(0, 0, W * 0.3, H);
  bg.addColorStop(0, '#191d27');
  bg.addColorStop(1, '#0b0e15');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // faint colour cast so an unlit cabinet still belongs to its tube
  g.fillStyle = rgba(color, 0.07);
  g.fillRect(0, 0, W, H);
  // weather streaking
  for (let i = 0; i < 16; i++) {
    const y = h2(i, seed) * H;
    const hh = 1 + h2(i + 31, seed) * H * 0.045;
    g.fillStyle = `rgba(0,0,0,${(0.06 + h2(i + 7, seed) * 0.14).toFixed(3)})`;
    g.fillRect(0, y, W, hh);
  }

  if (style === 'lightbox') {
    // Illuminated acrylic face, glyphs knocked out dark. Highest-legibility
    // option — it survives to a few pixels as a coloured tile.
    const lbW = W - L.M * 0.9, lbH = faceB - L.M * 0.45;
    const lb = mk(lbW * res, lbH * res);
    const lg = lb.getContext('2d');
    lg.scale(res, res);
    const gr = lg.createLinearGradient(0, 0, 0, lbH);
    gr.addColorStop(0, shade(color, 0.95));
    gr.addColorStop(0.5, shade(color, 0.70));
    gr.addColorStop(1, shade(color, 0.50));
    lg.fillStyle = gr;
    lg.fillRect(0, 0, lbW, lbH);
    lg.textAlign = 'center';
    lg.textBaseline = 'middle';
    lg.font = `bold ${CELL * 0.86}px ${FONT}`;
    lg.globalCompositeOperation = 'destination-out';
    const ox = -L.M * 0.45, oy = -L.M * 0.22;
    slots.forEach((s, i) => {
      if (deadSet && deadSet.has(i)) return;
      lg.fillStyle = '#000';
      lg.fillText(s.c, s.x + ox, s.y + oy);
    });
    lg.globalCompositeOperation = 'source-over';
    g.drawImage(lb, L.M * 0.45, L.M * 0.22, lbW, lbH);
    // unlit glyphs on a lightbox read as dark patches on the face
    if (deadSet) {
      g.font = `bold ${CELL * 0.86}px ${FONT}`;
      slots.forEach((s, i) => {
        if (!deadSet.has(i)) return;
        g.fillStyle = 'rgba(10,12,16,0.9)';
        g.fillText(s.c, s.x, s.y);
      });
    }
  } else {
    // -- channel-letter neon ------------------------------------------------
    g.font = `bold ${CELL * 0.86}px ${FONT}`;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // 1. tight bleed onto the cabinet. Deliberately narrow: a blur wider than
    //    the gap between two strokes closes the counters and the glyph blobs.
    g.save();
    g.shadowColor = color;
    g.fillStyle = color;
    g.globalAlpha = 0.15;
    for (const b of [CELL * 0.10, CELL * 0.042]) {
      g.shadowBlur = b;
      slots.forEach((s, i) => {
        if (deadSet && deadSet.has(i)) return;
        g.fillText(s.c, s.x, s.y);
      });
    }
    g.restore();
    // 2. glass sheath — the letterform itself, saturated.
    g.shadowColor = color;
    g.shadowBlur = CELL * 0.022;
    g.strokeStyle = color;
    g.fillStyle = color;
    // A dense kanji like 電 has internal gaps of ~6% of the cell. Any sheath
    // fatter than half of that closes its own counters and the glyph becomes
    // the lozenge this whole rebuild exists to kill.
    g.lineWidth = CELL * 0.028;
    slots.forEach((s, i) => {
      if (deadSet && deadSet.has(i)) return;
      g.strokeText(s.c, s.x, s.y);
      g.fillText(s.c, s.x, s.y);
    });
    g.shadowBlur = 0;
    // 3. hot core: eroded letterform, the only thing allowed past bloom.
    const live = slots.filter((_, i) => !(deadSet && deadSet.has(i)));
    if (live.length) {
      const core = coreMask(live, W, H, CELL * 0.045, res);
      // A white core inside a white sheath is just extra clipping.
      g.globalAlpha = o.whiteTube ? 0.16 : 0.46;
      g.drawImage(core, 0, 0, W, H);
      g.globalAlpha = 1;
    }
    // 4. dead tubes: unlit glass, faint grey with a colour memory.
    if (deadSet) {
      slots.forEach((s, i) => {
        if (!deadSet.has(i)) return;
        g.globalAlpha = 1;
        g.lineWidth = CELL * 0.05;
        g.strokeStyle = '#1a1f27';
        g.fillStyle = '#141922';
        g.strokeText(s.c, s.x, s.y);
        g.fillText(s.c, s.x, s.y);
        g.globalAlpha = 0.16;
        g.fillStyle = color;
        g.fillText(s.c, s.x, s.y);
        g.globalAlpha = 1;
      });
    }
  }

  // -- LED raster overlay: dot grid, refresh band, one dead row -------------
  if (style === 'led') {
    const p = Math.max(4, Math.round(CELL * 0.045));
    g.fillStyle = 'rgba(0,0,0,0.46)';
    for (let y = 0; y < faceB; y += p) g.fillRect(0, y, W, Math.max(1, p * 0.36));
    for (let x = 0; x < W; x += p) g.fillRect(x, 0, Math.max(1, p * 0.36), faceB);
    // refresh sweep — a still frame still reads as a live transmission
    const by = faceB * scanY;
    const sg = g.createLinearGradient(0, by - faceB * 0.12, 0, by + faceB * 0.12);
    sg.addColorStop(0, 'rgba(255,255,255,0)');
    sg.addColorStop(0.5, 'rgba(255,255,255,0.13)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sg;
    g.fillRect(0, by - faceB * 0.12, W, faceB * 0.24);
    // dead driver row
    g.fillStyle = 'rgba(0,0,0,0.8)';
    g.fillRect(0, faceB * 0.63, W, Math.max(1, p * 0.6));
  }

  // -- sub plate ------------------------------------------------------------
  if (plate !== 'none' && L.subH > 0) {
    const pw = W - L.M * 1.7;
    const ph = L.plateH;
    const px = L.M * 0.85;
    const py = H - L.M * 0.5 - ph;
    const pl = knockPlate(pw, ph, color, spec.sub, plate, res);
    g.drawImage(pl, px, py, pw, ph);
    // thin bright top edge sells it as an illuminated strip
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillRect(px, py, pw, Math.max(1, ph * 0.045));
  }

  // -- bezel + hardware -----------------------------------------------------
  const b = L.M * 0.42;
  g.strokeStyle = '#12161d';
  g.lineWidth = b;
  g.strokeRect(b / 2, b / 2, W - b, H - b);
  g.strokeStyle = '#2c3441';
  g.lineWidth = Math.max(1.5, b * 0.16);
  g.strokeRect(b * 0.5, b * 0.5, W - b, H - b);
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = Math.max(1, b * 0.12);
  g.strokeRect(b * 1.15, b * 1.15, W - b * 2.3, H - b * 2.3);
  const bolt = Math.max(2, b * 0.22);
  g.fillStyle = '#39424f';
  for (const [bx, by2] of [[b, b], [W - b, b], [b, H - b], [W - b, H - b]]) {
    g.beginPath();
    g.arc(bx, by2, bolt, 0, Math.PI * 2);
    g.fill();
  }
  return cv;
}

// ---------------------------------------------------------------------------
// Shared soft radial gradient for wall-spill glow quads.
// ---------------------------------------------------------------------------
function radialGlowTexture() {
  const cv = mk(128, 128);
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
// Horizontal band used for the animated scanline roll on LED units.
function bandTexture() {
  const cv = mk(8, 64);
  const g = cv.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.42, 'rgba(255,255,255,0.30)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  gr.addColorStop(0.58, 'rgba(255,255,255,0.30)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 8, 64);
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
  const on = s > -1.35 ? 1 : 0.12;
  return on * (0.93 + 0.07 * Math.sin(t * 118 + ph));
}
function buzzVal(t, ph) {
  const s = Math.sin(t * 23.7 + ph) * Math.sin(t * 5.3 + ph * 1.7) + Math.sin(t * 3.1 + ph);
  // Floor kept high: the deadness is BAKED into the canvas now (unlit glass
  // glyphs). Dimming the whole material as well turned the cabinet into a
  // black rectangle floating in mid-air.
  return s > 1.25 ? 1.0 : 0.62 + 0.05 * Math.sin(t * 91 + ph);
}

// ---------------------------------------------------------------------------
// Video billboard ad rendering — animated, deterministic in t.
// ---------------------------------------------------------------------------
const AD_PALETTES = [
  { bg0: '#080d1c', bg1: '#12244a', a: '#31e5ff', b: '#ff2d95', accent: 0x31c8ff },
  { bg0: '#18080c', bg1: '#3a141b', a: '#ffab2e', b: '#ff4433', accent: 0xff8830 },
  { bg0: '#110a20', bg1: '#261648', a: '#c96bff', b: '#31e5ff', accent: 0x9a5cff },
  { bg0: '#081608', bg1: '#0f3220', a: '#3affc3', b: '#ffd447', accent: 0x2fe0a8 },
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
  const S = Math.min(W, H) / 256;   // motif scale, so a bigger canvas is more
                                    // resolution, not more clutter.

  // Background.
  const grad = g.createLinearGradient(0, 0, W * 0.3, H);
  grad.addColorStop(0, pal.bg0);
  grad.addColorStop(1, pal.bg1);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  if (type === 0) {
    g.strokeStyle = pal.a; g.globalAlpha = 0.18; g.lineWidth = 1 * S;
    for (let x = 0; x < W; x += 28 * S) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = 0; y < H; y += 28 * S) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.globalAlpha = 1;
    const cx = W * 0.5, cy = H * (portrait ? 0.32 : 0.44);
    for (let k = 0; k < 3; k++) {
      const r = ((tl * 0.35 + k * 0.33) % 1);
      g.globalAlpha = (1 - r) * 0.6;
      g.strokeStyle = k % 2 ? pal.b : pal.a;
      g.lineWidth = 5 * S;
      g.beginPath(); g.arc(cx, cy, (12 + r * 140) * S, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
  } else if (type === 1) {
    g.fillStyle = pal.b; g.globalAlpha = 0.14;
    g.beginPath(); g.moveTo(W, 0); g.lineTo(W, H); g.lineTo(W * 0.35, H); g.closePath(); g.fill();
    g.globalAlpha = 1;
    for (let i = 0; i < 14; i++) {
      const bx = hash1(i * 7.7 + bbSeed) * W;
      const by = H + 30 - ((tl * 60 * S + i * 53 * S) % (H + 60 * S));
      const br = (3 + hash1(i * 3.1) * 9) * S;
      g.globalAlpha = 0.7;
      g.strokeStyle = pal.a; g.lineWidth = 2.5 * S;
      g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
  } else {
    for (let k = 0; k < 3; k++) {
      g.strokeStyle = k === 1 ? pal.b : pal.a;
      g.globalAlpha = 0.8 - k * 0.18;
      g.lineWidth = 4 * S;
      g.beginPath();
      for (let x = 0; x <= W; x += 6 * S) {
        const y = H * (0.58 + k * 0.12) +
          Math.sin(x * 0.03 / S + tl * (2 + k) + k * 9) * H * 0.055 *
          (1 + 0.6 * Math.sin(x * 0.008 / S + tl));
        x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  // ---- typography ---------------------------------------------------------
  // Hierarchy: hero kanji, a rule, a knocked-back Latin sub, a tagline.
  // No shadowBlur on anything below hero size — blur is what turned the old
  // sub-line into coloured mush at every viewing distance.
  const bigSize = Math.min(W / (txt.big.length * 0.98), H * (portrait ? 0.17 : 0.34));
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${bigSize}px ${FONT}`;
  const ty = H * (portrait ? 0.40 : 0.42);
  g.shadowColor = pal.a; g.shadowBlur = bigSize * 0.10;
  g.fillStyle = pal.a;
  g.fillText(txt.big, W / 2, ty);
  g.shadowBlur = 0;
  // eroded core rather than a white wash over the whole glyph
  g.lineWidth = bigSize * 0.05;
  g.strokeStyle = 'rgba(255,255,255,0.34)';
  g.strokeText(txt.big, W / 2, ty);

  const subY = ty + bigSize * 0.74;
  const ruleW = Math.min(W * 0.72, bigSize * txt.big.length * 0.95);
  g.fillStyle = rgba(pal.b, 0.85);
  g.fillRect((W - ruleW) / 2, subY - bigSize * 0.30, ruleW, Math.max(1.5, bigSize * 0.022));
  setSpacing(g, bigSize * 0.06);
  const subPx = fitFont(g, txt.sub, W * 0.86, Math.max(15 * S, bigSize * 0.30));
  g.lineWidth = subPx * 0.24;
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(txt.sub, W / 2, subY);
  g.fillStyle = '#ffffff';
  g.fillText(txt.sub, W / 2, subY);
  setSpacing(g, 0);

  const tagPx = fitFont(g, txt.tag, W * 0.8, Math.max(12 * S, bigSize * 0.19), '');
  g.lineWidth = tagPx * 0.28;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.strokeText(txt.tag, W / 2, H * 0.9);
  g.fillStyle = rgba(pal.a, 0.9);
  g.fillText(txt.tag, W / 2, H * 0.9);

  // Sweep band + scanlines + a dead driver row + vignette.
  const sy = (tl * 0.22 % 1) * H;
  const sg = g.createLinearGradient(0, sy - 26 * S, 0, sy + 26 * S);
  sg.addColorStop(0, 'rgba(255,255,255,0)');
  sg.addColorStop(0.5, 'rgba(255,255,255,0.11)');
  sg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sg; g.fillRect(0, sy - 26 * S, W, 52 * S);
  g.fillStyle = 'rgba(0,0,0,0.17)';
  const sl = Math.max(3, Math.round(4 * S));
  for (let y = 0; y < H; y += sl) g.fillRect(0, y, W, Math.max(1, sl * 0.4));
  g.fillStyle = 'rgba(0,0,0,0.62)';
  g.fillRect(0, Math.floor(H * 0.735), W, Math.max(1, 2 * S));
  const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.48)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  return pal.accent;
}

// ---------------------------------------------------------------------------
// Hologram figure, baked to a two-channel mask canvas.
//
//   R = body    — dim translucent interior volume
//   G = rim     — bright contour: silhouette edge AND every internal seam
// ---------------------------------------------------------------------------
const FIG_W = 320, FIG_H = 1280;

const FIG_PARTS = [
  // hair mass — falls behind and past the jaw, wider than the skull
  (p) => {
    p.moveTo(-52, 178);
    p.bezierCurveTo(-56, 72, 56, 72, 52, 178);
    p.bezierCurveTo(58, 218, 55, 254, 47, 292);
    p.lineTo(30, 287);
    p.bezierCurveTo(37, 244, 39, 206, 36, 164);
    p.bezierCurveTo(21, 146, -21, 146, -36, 164);
    p.bezierCurveTo(-39, 206, -37, 244, -30, 287);
    p.lineTo(-47, 292);
    p.bezierCurveTo(-55, 254, -58, 218, -52, 178);
    p.closePath();
  },
  // face / skull
  (p) => { p.ellipse(0, 166, 40, 55, 0, 0, Math.PI * 2); },
  // neck
  (p) => {
    p.moveTo(-15, 202); p.lineTo(15, 202);
    p.bezierCurveTo(17, 240, 18, 254, 19, 266);
    p.lineTo(-19, 266);
    p.bezierCurveTo(-18, 254, -17, 240, -15, 202);
    p.closePath();
  },
  // torso / coat: shoulders -> waist -> hips -> hem
  (p) => {
    p.moveTo(-17, 252);
    p.quadraticCurveTo(-50, 268, -73, 314);
    p.bezierCurveTo(-80, 398, -60, 476, -44, 558);
    p.bezierCurveTo(-64, 620, -74, 676, -68, 748);
    p.lineTo(-56, 792);
    p.quadraticCurveTo(2, 812, 64, 786);
    p.lineTo(76, 742);
    p.bezierCurveTo(80, 672, 70, 618, 50, 558);
    p.bezierCurveTo(66, 476, 86, 398, 79, 314);
    p.quadraticCurveTo(56, 268, 21, 252);
    p.closePath();
  },
  // figure's right arm
  (p) => {
    p.moveTo(-68, 318);
    p.bezierCurveTo(-92, 382, -94, 472, -87, 558);
    p.bezierCurveTo(-85, 642, -81, 702, -77, 766);
    p.lineTo(-57, 770);
    p.bezierCurveTo(-59, 702, -61, 642, -63, 560);
    p.bezierCurveTo(-65, 472, -63, 392, -50, 332);
    p.closePath();
  },
  // figure's left arm
  (p) => {
    p.moveTo(74, 318);
    p.bezierCurveTo(96, 382, 98, 468, 91, 550);
    p.bezierCurveTo(87, 622, 79, 678, 67, 732);
    p.lineTo(47, 724);
    p.bezierCurveTo(59, 670, 65, 618, 67, 554);
    p.bezierCurveTo(69, 472, 65, 392, 53, 332);
    p.closePath();
  },
  // figure's right leg
  (p) => {
    p.moveTo(-55, 746);
    p.bezierCurveTo(-51, 852, -44, 902, -38, 960);
    p.bezierCurveTo(-36, 1052, -32, 1132, -31, 1198);
    p.lineTo(-33, 1250); p.lineTo(-9, 1250); p.lineTo(-9, 1200);
    p.bezierCurveTo(-11, 1132, -13, 1052, -14, 960);
    p.bezierCurveTo(-15, 882, -13, 812, -8, 752);
    p.closePath();
  },
  // figure's left leg
  (p) => {
    p.moveTo(11, 752);
    p.bezierCurveTo(17, 812, 21, 882, 23, 960);
    p.bezierCurveTo(24, 1052, 25, 1132, 26, 1200);
    p.lineTo(25, 1250); p.lineTo(51, 1250); p.lineTo(51, 1198);
    p.bezierCurveTo(53, 1132, 55, 1052, 55, 960);
    p.bezierCurveTo(57, 892, 61, 852, 62, 746);
    p.closePath();
  },
];

const FIG_PART_RIM = [0.92, 0.15, 0.45, 1.0, 1.0, 1.0, 1.0, 1.0];

const FIG_DETAILS = [
  (p) => { p.moveTo(-30, 270); p.lineTo(1, 322); p.lineTo(28, 266); },  // collar V
  (p) => { p.moveTo(-45, 566); p.quadraticCurveTo(2, 582, 50, 562); },  // belt
  (p) => { p.moveTo(-35, 966); p.lineTo(-15, 964); },                   // knee
  (p) => { p.moveTo(24, 966); p.lineTo(52, 964); },                     // knee
];

function figureCanvas() {
  const W = FIG_W, H = FIG_H;
  const bodyC = mk(W, H);
  const bg = bodyC.getContext('2d');
  bg.translate(W / 2, 0);
  bg.fillStyle = '#ffffff';
  bg.filter = 'blur(2px)';
  for (const part of FIG_PARTS) { bg.beginPath(); part(bg); bg.fill(); }
  bg.filter = 'none';

  const rimC = mk(W, H);
  const rg = rimC.getContext('2d');
  rg.translate(W / 2, 0);
  rg.strokeStyle = '#ffffff';
  rg.shadowColor = '#ffffff';
  rg.lineJoin = 'round';
  rg.lineCap = 'round';
  rg.lineWidth = 5.5;
  rg.shadowBlur = 5;
  FIG_PARTS.forEach((part, i) => {
    rg.globalAlpha = FIG_PART_RIM[i];
    rg.beginPath(); part(rg); rg.stroke();
  });
  rg.lineWidth = 3.2;
  rg.shadowBlur = 3;
  rg.globalAlpha = 0.42;
  for (const d of FIG_DETAILS) { rg.beginPath(); d(rg); rg.stroke(); }
  rg.globalAlpha = 1;

  const out = mk(W, H);
  const og = out.getContext('2d');
  const bd = bg.getImageData(0, 0, W, H).data;
  const rd = rg.getImageData(0, 0, W, H).data;
  const im = og.createImageData(W, H);
  const o = im.data;
  const sstep = (a, b, x) => {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  for (let y = 0; y < H; y++) {
    const fy = y / H;
    const vert = (0.52 + 0.48 * Math.exp(-Math.pow((fy - 0.30) / 0.40, 2)))
      * (1 - 0.55 * sstep(0.60, 1.0, fy));
    const rimVert = 1 - 0.35 * sstep(0.66, 1.0, fy);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      o[i] = bd[i + 3] * vert;
      o[i + 1] = rd[i + 3] * rimVert;
      o[i + 2] = 0;
      o[i + 3] = 255;
    }
  }
  og.putImageData(im, 0, 0);
  return out;
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
    float band = floor(uv.y * 60.0);
    float gl = hash(band * 1.37 + floor(uTime * 6.0) * 0.61 + uPhase);
    uv.x += (hash(band + floor(uTime * 11.0)) - 0.5) * step(0.962, gl) * 0.042;
    float tear = step(0.988, hash(floor(uTime * 3.0) + uPhase * 3.1));
    uv.x += tear * (step(0.5, fract(uv.y * 7.0 + uTime)) - 0.5) * 0.018;

    vec4 s = texture2D(uTex, uv);
    float body = s.r;
    float rim  = s.g;

    float sl = sin((uv.y + uTime * 0.013) * 690.0);
    float scanB = 0.74 + 0.26 * sl;
    float scanR = 0.93 + 0.07 * sl;
    float vband = 0.90 + 0.10 * sin(uv.x * 96.0 + uTime * 0.8 + uPhase);
    float sweep = exp(-38.0 * pow(fract(uv.y - uTime * 0.06 + uPhase * 0.3) - 0.5, 2.0));
    float flick = 0.88 + 0.12 * sin(uTime * 29.0 + uPhase) * sin(uTime * 7.7 + uPhase * 2.0);
    float fade = smoothstep(0.0, 0.06, uv.y) * smoothstep(1.0, 0.90, uv.y);

    vec3 inner = mix(uColB, uColA, uv.y * 0.85 + 0.10);
    vec3 edge  = mix(uColA, vec3(0.74, 0.88, 1.0), 0.26);

    vec3 c = inner * body * 0.62 * scanB * vband
           + edge  * rim  * 0.72 * scanR;
    c *= fade * flick * (1.0 + sweep * 0.5) * uIntensity;
    gl_FragColor = vec4(c, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Main build.
// ---------------------------------------------------------------------------
export function buildSignage(ctx = {}) {
  const rng = mulberry32(90210);
  const group = new THREE.Group();
  const steelGeos = [];   // frames, backings, brackets — one dark merged mesh
  const cableGeos = [];   // thin cables — separate near-black merged mesh
  const flickers = [];    // { mat, base, ph, kind, haloIdx, haloCol }
  const rollers = [];     // animated LED scanline bands
  const glowTex = radialGlowTexture();
  const bandTex = bandTexture();
  const ANISO = Math.min(8, ctx?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4);

  // -- Neon sign catalogue --------------------------------------------------
  // Latin subs are kept SHORT on purpose: a 16-character string on a 3m sign
  // can never resolve, and the fix is fewer, larger letters — not more pixels.
  const POOL = [
    { text: 'ラーメン', sub: 'RAMEN', v: true },
    { text: '寿司', v: true },
    { text: 'ホテル', sub: 'HOTEL', v: true },
    { text: '電気', v: false },
    { text: 'カラオケ', sub: 'KARAOKE', v: true },
    { text: '夢', v: false },
    { text: '未来', v: false },
    { text: '居酒屋', v: true },
    { text: 'バー月光', sub: 'BAR', v: false },
    { text: '質屋', v: true },
    { text: '薬局', v: false },
    { text: '焼肉', v: true },
    { text: 'パチンコ', v: false },
    { text: 'スナック蘭', v: true },
    { text: '純喫茶', sub: 'COFFEE', v: true },
    { text: 'ソラ・コーラ', sub: 'COLA', v: false },
    { text: '月光ビール', sub: 'BEER', v: false },
    { text: '銀河', sub: 'GINGA', v: false },
    { text: 'サウナ', v: true },
    { text: '深夜営業', v: false },
    { text: '24時間', sub: 'OPEN', v: false },
    { text: '天ぷら', v: true },
    { text: 'ゲーム', v: true },
    { text: '東雲電子', sub: 'DENSHI', v: false },
    { text: 'ビリヤード', v: true },
    { text: '酒', v: false },
    { text: 'クラブ夜光', v: true },
    { text: '麺屋一番', v: true },
    { text: 'ネオ茶', sub: 'NEO-CHA', v: false },
    { text: '占い', v: true },
  ];
  // Deakins' palette is magenta and cyan with sodium as the ACCENT, not the
  // body. The first pass ran three sodium entries in eleven and the street
  // came back amber; sodium is now one in eight and the cold end carries the
  // block.
  const COLORS = [
    '#ff2d95', '#ff2d95', '#ff5fb0', '#ff2d95',   // magenta / pink
    '#2ee6ff', '#2ee6ff', '#19d3c5', '#2ee6ff',   // cyan / teal
    '#ffa028', '#ffb545',                          // warm sodium orange
    '#ff2626',                                     // deep red (rare)
    '#b46bff', '#b46bff',                          // violet
    '#dff0ff',                                     // cold fluorescent white
  ];

  // Halo spill quads: instanced, per-instance color.
  const haloMat = new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const haloEntries = []; // { pos, rotY, w, h, color }

  // Deterministic shuffle with a short memory. Round-robin through the pool
  // put the same shop name on both walls at the same z, because each side
  // places a similar count — two identical HOTEL kanban facing each other
  // reads as a texture atlas, not a street.
  let poolIdx = 0;
  const recent = [];
  const nextSpec = () => {
    let pick = 0;
    for (let tries = 0; tries < 6; tries++) {
      pick = (rng() * POOL.length) | 0;
      if (!recent.includes(pick)) break;
    }
    recent.push(pick);
    if (recent.length > 7) recent.shift();
    poolIdx++;
    return POOL[pick];
  };

  // Emissive multiplier per face type. These are the numbers that decide
  // whether a glyph reads or blobs: bloom threshold is 1.05 LINEAR, so a
  // saturated tube at ~2.1 puts its sheath just over the line and its eroded
  // core well over — while the cabinet, at 0.05 albedo, stays at 0.1 and
  // black. The old build ran 4.35 on an additive plane with no cabinet at
  // all, which is 4x over threshold across the entire glyph area.
  const GAIN = { neon: 2.05, lightbox: 1.34, led: 1.72 };

  // Reserved wall runs — the mega installations own these, ordinary kanban
  // must not grow into them.
  const RESERVED = [
    { side: 1, z0: -63, z1: -51 },
    { side: -1, z0: -63, z1: -51 },
  ];
  const reserved = (side, z) =>
    RESERVED.some((r) => r.side === side && z > r.z0 && z < r.z1);

  // -- one sign -------------------------------------------------------------
  // kind: 'flag' (perpendicular, protruding) | 'wall'
  function addNeonSign({ side, z, y, kind, height, flicker, halfDead, forceStyle }) {
    const spec = nextSpec();
    const color = COLORS[(rng() * COLORS.length) | 0];
    const L = planSign(spec);
    const aspect = L.W / L.H;

    let hgt = height, wid = hgt * aspect;
    const maxW = kind === 'flag' ? 4.6 : 9.5;
    if (wid > maxW) { wid = maxW; hgt = wid / aspect; }

    // LEGIBILITY FLOOR. The sub plate's real-world height decides whether it
    // can carry type at all. Below ~0.6m it becomes a designed legend bar;
    // below ~0.26m it is dropped entirely. Nothing is ever rendered as type
    // that the frame cannot resolve.
    const plateM = spec.sub ? hgt * (L.plateH / L.H) : 0;
    const plate = !spec.sub ? 'none' : plateM >= 0.60 ? 'text' : plateM >= 0.26 ? 'bar' : 'none';
    if (plate === 'none' && spec.sub) { L.H -= L.subH; L.subH = 0; L.plateH = 0; }

    const r = rng();
    // Cold-white tubes stay CHANNEL LETTERS. As a lightbox the same colour is
    // a full-face white slab that eats a third of the exposure budget on its
    // own; as a tube it is the one genuinely hot island a saturated magenta
    // or cyan can never provide, since neither has the luma to reach it.
    const white = color === '#dff0ff';
    const style = forceStyle ?? (white || r < 0.62 ? 'neon' : r < 0.82 ? 'lightbox' : 'led');
    const deadSet = halfDead
      ? new Set(rng() < 0.5 ? [0] : [L.chars.length - 1])
      : null;

    const cv = renderSign(spec, L, {
      color, style, deadSet, plate,
      seed: 3 + poolIdx * 1.37 + side * 0.5,
      scanY: 0.24 + rng() * 0.5,
      whiteTube: white,
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = ANISO;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;

    // Cold white carries luma in all three channels, so the SAME multiplier
    // that leaves a magenta tube crisp puts a white one three stops over the
    // bloom threshold and its counters close. Pulled to 0.58.
    const base = GAIN[style] * (white ? 0.58 : 1)
      * (halfDead ? 0.86 : 1) * (0.94 + rng() * 0.16);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide });
    mat.color.setScalar(base);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wid, hgt), mat);

    const wallX = side * 10.1;
    const haloCol = new THREE.Color(color);
    const warm = (haloCol.r - haloCol.b) > 0.25 ? 0.62 : 1.0;
    const nearCam = z > -14 ? 0.45 : z > -26 ? 0.6 : z < -45 ? 1.15 : 1.0;
    // With the face now opaque, the wall spill IS the sign's contribution to
    // the surrounding air — it has to carry what the additive plane used to.
    const haloGain = 0.50 * warm * nearCam;
    let haloIdx = -1;

    if (kind === 'flag') {
      const cx = wallX - side * (0.35 + wid / 2);
      mesh.position.set(cx, y + hgt / 2, z);
      steelGeos.push(box(wid + 0.24, hgt + 0.3, 0.26, cx, y + hgt / 2, z));
      mesh.position.z += 0.18;
      const a1 = new THREE.Vector3(wallX, y + hgt - 0.3, z);
      const a2 = new THREE.Vector3(wallX, y + 0.3, z);
      steelGeos.push(strut(a1, new THREE.Vector3(cx - side * wid * 0.45, y + hgt - 0.3, z), 0.09));
      steelGeos.push(strut(a2, new THREE.Vector3(cx - side * wid * 0.45, y + 0.3, z), 0.09));
      cableGeos.push(strut(
        new THREE.Vector3(wallX, y + hgt + 1.6, z),
        new THREE.Vector3(cx - side * wid * 0.4, y + hgt - 0.2, z), 0.035));
      haloIdx = haloEntries.length;
      haloEntries.push({
        pos: new THREE.Vector3(wallX - side * 0.15, y + hgt / 2, z),
        rotY: side > 0 ? -Math.PI / 2 : Math.PI / 2,
        w: hgt * 1.7, h: hgt * 1.7, color: haloCol.clone().multiplyScalar(haloGain),
      });
    } else {
      const px = wallX - side * 0.34;
      mesh.position.set(px, y + hgt / 2, z);
      mesh.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      // Backing is a RIM, not a slab. A solid backing plate behind a
      // front-face-culled panel is invisible from the street and a black
      // rectangle from any camera on the other side of the wall — the aerial
      // was getting a hole punched through the hologram by one of these.
      // Top and bottom mounting rails only. A full rectangular frame still
      // draws a hard outline when the camera grazes along the far side of the
      // wall and the panel itself is culled; two horizontal rails read as
      // hardware at any angle.
      {
        const bx = wallX - side * 0.08, r = 0.2;
        steelGeos.push(box(0.18, r, wid + 0.24, bx, y - r * 0.4, z));
        steelGeos.push(box(0.18, r, wid + 0.24, bx, y + hgt + r * 0.4, z));
      }
      for (const dz of [-wid * 0.4, wid * 0.4]) {
        steelGeos.push(box(0.5, 0.12, 0.12, wallX + side * 0.1, y + 0.2, z + dz));
        steelGeos.push(box(0.5, 0.12, 0.12, wallX + side * 0.1, y + hgt - 0.2, z + dz));
      }
      cableGeos.push(strut(
        new THREE.Vector3(wallX - side * 0.2, y + hgt + 2.2 + rng() * 1.5, z + wid * 0.3),
        new THREE.Vector3(px, y + hgt - 0.1, z - wid * 0.1), 0.035));
      haloIdx = haloEntries.length;
      haloEntries.push({
        pos: new THREE.Vector3(wallX - side * 0.5, y + hgt / 2, z),
        rotY: side > 0 ? -Math.PI / 2 : Math.PI / 2,
        w: wid * 1.75, h: hgt * 2.0, color: haloCol.clone().multiplyScalar(haloGain),
      });
    }
    group.add(mesh);

    // Animated raster roll on LED units — the sign is alive in a still frame
    // because the band is a pure function of t, and it costs one small quad.
    if (style === 'led' && hgt > 2.2 && rollers.length < 4) {
      const rm = new THREE.MeshBasicMaterial({
        map: bandTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.FrontSide,
      });
      rm.color.set(color).multiplyScalar(0.5);
      const roll = new THREE.Mesh(new THREE.PlaneGeometry(wid * 0.92, hgt * 0.22), rm);
      roll.position.z = 0.03;
      mesh.add(roll);
      rollers.push({ mesh: roll, hgt, ph: rng() * 6.283, speed: 0.16 + rng() * 0.1 });
    }

    if (flicker || halfDead) {
      flickers.push({
        mat, base, ph: rng() * 20,
        kind: halfDead ? 'buzz' : 'flicker',
        haloIdx, haloCol: haloEntries[haloIdx].color.clone(),
      });
    }
    return mesh;
  }

  // -- Placement along the corridor ----------------------------------------
  let flickerBudget = 5, deadBudget = 4;
  for (const side of [-1, 1]) {
    // Low band: dense shop-front kanban, y 4–10.
    let n = 0;
    for (let z = 8 - rng() * 4; z > -116; z -= 8.5 + rng() * 6) {
      const kind = rng() < 0.62 ? 'flag' : 'wall';
      // Guaranteed derelict units, not budget-and-luck: one visibly half-dead
      // kanban per side inside each low camera's reach.
      const forceDead = (n === 2 || n === 7) && deadBudget > 0;
      const doFlicker = !forceDead && flickerBudget > 0 && rng() < 0.16;
      const doDead = forceDead || (!doFlicker && deadBudget > 0 && rng() < 0.06);
      if (doFlicker) flickerBudget--;
      if (doDead) deadBudget--;
      addNeonSign({
        side, z, y: 4 + rng() * 5.5, kind,
        height: kind === 'flag' ? 4.2 + rng() * 2.6 : 2.4 + rng() * 1.6,
        flicker: doFlicker, halfDead: doDead,
      });
      n++;
    }
    // Mid band: y 13–30, sparser, larger. One unit per side is forced into a
    // half-dead state here rather than left to the budget dice — the low band
    // sits under the sightline of both ground cameras, so a derelict kanban
    // down there is a derelict kanban nobody ever sees.
    let m = 0;
    for (let z = 2 - rng() * 8; z > -112; z -= 15 + rng() * 10) {
      if (reserved(side, z)) continue;
      const doDead = m === 1;
      addNeonSign({
        side, z, y: 13 + rng() * 16, kind: rng() < 0.4 ? 'flag' : 'wall',
        height: 4.5 + rng() * 3.5,
        flicker: !doDead && flickerBudget > 0 && rng() < 0.1 && !!flickerBudget--,
        halfDead: doDead,
      });
      m++;
    }
    // High band: y 33–54 — signage climbing the towers is what gives the
    // canyon its vertical layering from the elevated cameras.
    for (let z = -6 - rng() * 8; z > -108; z -= 19 + rng() * 11) {
      if (reserved(side, z)) continue;
      addNeonSign({
        side, z, y: 33 + rng() * 21, kind: rng() < 0.25 ? 'flag' : 'wall',
        height: 5.5 + rng() * 4.5,
      });
    }
  }

  // -- Mega installations ----------------------------------------------------
  // Large-format building signs. These exist because the aerial camera sits
  // 85-140u out: at that range a 4m kanban is 8 pixels of coloured blur and
  // the city loses its cultural signature entirely. A 30m sign is 380px tall
  // from up there, and still reads as typography.
  //
  // Anchoring is deliberate, not decorative: city.js forces an east-row tower
  // at z≈2 to h=138 (its "aerial landmark") and the skybridge flanks at
  // z≈-57 to h≥58, so these are the only wall runs guaranteed to have mass
  // behind them at height. Each also carries its own lattice, so it reads as
  // a built structure rather than a decal.
  function latticeFrame(side, zc, yBot, yTop, halfW) {
    const xPost = side * 9.95;
    const zA = zc - halfW - 0.55, zB = zc + halfW + 0.55;
    for (const zp of [zA, zB]) {
      steelGeos.push(box(0.62, yTop - yBot, 0.62, xPost, (yTop + yBot) / 2, zp));
    }
    const span = zB - zA + 0.6;
    const nTie = Math.max(2, Math.round((yTop - yBot) / 5.5));
    for (let i = 0; i <= nTie; i++) {
      const yy = yBot + (yTop - yBot) * (i / nTie);
      steelGeos.push(box(0.4, 0.4, span, side * 9.98, yy, zc));
      // alternating diagonal web
      if (i < nTie) {
        const y2 = yBot + (yTop - yBot) * ((i + 1) / nTie);
        const p1 = new THREE.Vector3(xPost, yy, i % 2 ? zA : zB);
        const p2 = new THREE.Vector3(xPost, y2, i % 2 ? zB : zA);
        steelGeos.push(strut(p1, p2, 0.2));
      }
    }
    // maintenance catwalks crossing in front of the face
    for (const f of [0.03, 0.52]) {
      const yy = yBot + (yTop - yBot) * f;
      steelGeos.push(box(1.0, 0.16, span * 0.96, side * 9.16, yy, zc));
      steelGeos.push(box(0.08, 0.85, span * 0.96, side * 8.72, yy + 0.45, zc));
    }
    // standoff arms into the wall
    for (const f of [0.12, 0.5, 0.88]) {
      const yy = yBot + (yTop - yBot) * f;
      steelGeos.push(box(1.4, 0.34, 0.34, side * 10.3, yy, zA + 0.3));
      steelGeos.push(box(1.4, 0.34, 0.34, side * 10.3, yy, zB - 0.3));
    }
  }

  function addMegaSign({ side, z, yBot, height, text, sub, vertical, color, style, scanY }) {
    const spec = { text, sub, vertical };
    const L = planSign(spec);
    const aspect = L.W / L.H;
    const hgt = height, wid = hgt * aspect;
    const plateM = sub ? hgt * (L.plateH / L.H) : 0;
    const plate = !sub ? 'none' : plateM >= 0.60 ? 'text' : 'bar';
    const cv = renderSign(spec, L, {
      color, style, deadSet: null, plate, seed: 91 + z * 0.13,
      scanY: scanY ?? 0.42, res: 2,
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = ANISO;
    // A mega covers hundreds of pixels, so every fragment of its glyph feeds
    // the bloom pyramid; the same gain that reads as a hot tube on a 3m
    // kanban turns a 30m one into a lantern. Pulled down accordingly.
    const base = GAIN[style] * 0.80;
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide });
    mat.color.setScalar(base);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wid, hgt), mat);
    mesh.position.set(side * 9.55, yBot + hgt / 2, z);
    mesh.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(mesh);
    latticeFrame(side, z, yBot - 1.2, yBot + hgt + 1.2, wid / 2);
    haloEntries.push({
      pos: new THREE.Vector3(side * 9.9, yBot + hgt / 2, z),
      rotY: side > 0 ? -Math.PI / 2 : Math.PI / 2,
      w: wid * 2.0, h: hgt * 1.25,
      color: new THREE.Color(color).multiplyScalar(0.30),
    });
    return { mesh, wid, hgt, mat, base };
  }

  // 1. The aerial's hero: a 32m tube column on the z≈2 landmark tower.
  addMegaSign({
    side: 1, z: 1, yBot: 34, height: 31,
    text: '東雲電子', sub: 'SHINONOME', vertical: true,
    color: '#2ee6ff', style: 'neon',
  });
  // 2. Its crown: a 5.4m LED band above the column — the second large-format
  //    unit the aerial needs. It sits above rather than below because the
  //    airspace beneath the column is a spinner lane and the band was being
  //    eaten by a passing craft at t=12.
  {
    const t = addMegaSign({
      side: 1, z: 1.6, yBot: 67, height: 5.4,
      text: '深夜営業', sub: 'OPEN 24H', vertical: false,
      color: '#ffa028', style: 'led', scanY: 0.36,
    });
    const rm = new THREE.MeshBasicMaterial({
      map: bandTex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.FrontSide,
    });
    rm.color.set('#ffc36a').multiplyScalar(0.55);
    const roll = new THREE.Mesh(new THREE.PlaneGeometry(t.wid * 0.95, t.hgt * 0.3), rm);
    roll.position.z = 0.05;
    t.mesh.add(roll);
    rollers.push({ mesh: roll, hgt: t.hgt, ph: 1.9, speed: 0.22 });
  }
  // 3+4. The skybridge gate: facing columns at z=-57, under the bridge deck.
  addMegaSign({
    side: 1, z: -57, yBot: 14, height: 25,
    text: '銀河館', sub: 'GINGA', vertical: true,
    color: '#ff2d95', style: 'neon',
  });
  addMegaSign({
    side: -1, z: -57, yBot: 12, height: 23,
    text: '月光荘', sub: 'GEKKO', vertical: true,
    color: '#ffa028', style: 'lightbox',
  });

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
  // Canvas resolution is set so the Latin sub-line lands above the resolve
  // threshold from the camera that actually frames each board, not at a
  // round number: the old 448x256 put 'SHINONOME DENSHI' at 19px on the
  // canvas and roughly 8px on screen, which is the definition of mush.
  const billboards = [];
  const BB_DEFS = [
    { w: 14, h: 8, pos: [11.5, 30, -46], yaw: -Math.PI / 2 + 0.5, seed: 0.13, light: true, cw: 768, ch: 440 },
    { w: 8.5, h: 13, pos: [-11.4, 24, -64], yaw: Math.PI / 2 - 0.55, seed: 0.47, light: false, cw: 448, ch: 688 },
    { w: 11, h: 6.5, pos: [10.6, 13.5, -6], yaw: -Math.PI / 2 + 0.28, seed: 0.81, light: true, cw: 832, ch: 492 },
  ];
  for (const def of BB_DEFS) {
    const cv = mk(def.cw, def.ch);
    const g2 = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = ANISO;
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    mat.color.setScalar(1.55);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(def.w, def.h), mat);
    const holder = new THREE.Group();
    holder.position.set(...def.pos);
    holder.rotation.y = def.yaw;
    screen.position.z = 0.18;
    holder.add(screen);
    const bezel = new THREE.Mesh(
      new THREE.BoxGeometry(def.w + 0.9, def.h + 0.9, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x0c0e13, roughness: 0.6, metalness: 0.5 }));
    bezel.position.z = -0.2;
    holder.add(bezel);
    const walk = new THREE.Mesh(
      new THREE.BoxGeometry(def.w + 1.6, 0.18, 1.1),
      new THREE.MeshStandardMaterial({ color: 0x101218, roughness: 0.8, metalness: 0.4 }));
    walk.position.set(0, -def.h / 2 - 0.75, 0.4);
    holder.add(walk);
    group.add(holder);
    const side = Math.sign(def.pos[0]);
    const wall = new THREE.Vector3(side * 12.5, def.pos[1] - def.h * 0.7, def.pos[2]);
    cableGeos.push(strut(wall, new THREE.Vector3(def.pos[0], def.pos[1] - def.h / 2 - 0.7, def.pos[2] - 2), 0.09));
    cableGeos.push(strut(wall, new THREE.Vector3(def.pos[0], def.pos[1] - def.h / 2 - 0.7, def.pos[2] + 2), 0.09));

    const glowMat = new THREE.MeshBasicMaterial({
      map: glowTex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(def.w * 1.02, def.h * 1.12), glowMat);
    glow.position.z = 0.55;
    holder.add(glow);
    const spillMat = new THREE.MeshBasicMaterial({
      map: glowTex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const spill = new THREE.Mesh(new THREE.PlaneGeometry(def.w * 1.5, def.h * 1.7), spillMat);
    spill.position.z = -0.72;
    holder.add(spill);
    let light = null;
    if (def.light) {
      const near = def.pos[2] > -25;
      light = new THREE.PointLight(0xffffff, near ? 115 : 380, near ? 24 : 46, 2);
      light.position.z = 3;
      holder.add(light);
    }
    billboards.push({ g2, tex, cv, seed: def.seed, glowMat, spillMat, light, lastBucket: -1 });
  }

  // -- Giant holograms -------------------------------------------------------
  const figTex = new THREE.CanvasTexture(figureCanvas());
  figTex.colorSpace = THREE.NoColorSpace;
  const holoUniformsList = [];
  function addHologram({ pos, height, yaw, colA, colB, intensity, phase }) {
    const holder = new THREE.Group();
    holder.position.set(...pos);
    holder.rotation.y = yaw;
    const w = height * (FIG_W / FIG_H) * 1.35;
    const LAYERS = [
      { gain: 1.0, dx: 0, dz: 0 },
      { gain: 0.3, dx: w * 0.016, dz: -height * 0.01 },
    ];
    LAYERS.forEach((L, i) => {
      const uniforms = {
        uTex: { value: figTex },
        uTime: { value: 0 },
        uPhase: { value: phase + i * 1.7 },
        uIntensity: { value: intensity * L.gain },
        uColA: { value: new THREE.Color(colA) },
        uColB: { value: new THREE.Color(colB) },
      };
      const mat = new THREE.ShaderMaterial({
        vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG, uniforms,
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, height), mat);
      plane.position.set(L.dx, height / 2 + 0.4, L.dz);
      holder.add(plane);
      holoUniformsList.push(uniforms);
    });
    const wash = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 1.3, w * 1.3),
      new THREE.MeshBasicMaterial({
        map: glowTex, color: new THREE.Color(colA).multiplyScalar(0.30),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
    wash.rotation.x = -Math.PI / 2;
    wash.position.y = 0.12;
    holder.add(wash);
    const proj = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.1, 2.2),
      new THREE.MeshStandardMaterial({ color: 0x0d0f14, roughness: 0.55, metalness: 0.6 }));
    proj.position.y = 0.55;
    holder.add(proj);
    const lens = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.35),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colA).multiplyScalar(2.0) }));
    lens.rotation.x = -Math.PI / 2;
    lens.position.y = 1.11;
    holder.add(lens);
    group.add(holder);
  }
  addHologram({
    pos: [7.6, 0, -58], height: 46, yaw: -0.42,
    colA: 0x38d8ff, colB: 0x6a4bff, intensity: 1.22, phase: 0.0,
  });
  addHologram({
    pos: [-7.9, 0, -22], height: 27, yaw: 0.5,
    colA: 0xb06bff, colB: 0x3577ff, intensity: 1.06, phase: 4.2,
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
    // Raster roll: a pure function of t, so screenshots at a fixed t are
    // reproducible and the band still sits somewhere believable.
    for (const r of rollers) {
      const f = (t * r.speed + r.ph) % 1;
      r.mesh.position.y = (f - 0.5) * r.hgt * 0.94;
    }
    const bucket = Math.floor(t * 10);
    for (const bb of billboards) {
      if (bb.lastBucket !== bucket) {
        bb.lastBucket = bucket;
        const accent = drawAd(bb.g2, bb.cv.width, bb.cv.height, t, bb.seed);
        bb.tex.needsUpdate = true;
        bb.glowMat.color.set(accent).multiplyScalar(0.24);
        bb.spillMat.color.set(accent).multiplyScalar(0.44);
        if (bb.light) bb.light.color.set(accent);
      }
    }
    for (const u of holoUniformsList) u.uTime.value = t;
  }

  return { group, update };
}
