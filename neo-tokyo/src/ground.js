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

// ---- shader lookup tables --------------------------------------------------
// Three independent fields packed into RGB. The GPU's own bilinear filter
// does the interpolation, so a 64x64 table of random values IS value noise —
// one fetch instead of four hashes and a pair of mixes.
//
// Alpha is pinned to 255 on purpose. A 2D canvas stores premultiplied pixels,
// so random alpha round-trips the colour channels through a divide by a small
// number: the table comes back quantised to near-0/near-255 garbage. Reading
// a per-cell PHASE out of such a channel puts every raindrop in the scene on
// the same clock — the splash system computes, and nothing is visible.

function noiseTable(size, seed) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const rng = mulberry32(seed);
  for (let i = 0; i < size * size; i++) {
    img.data[i * 4 + 0] = (rng() * 256) | 0;
    img.data[i * 4 + 1] = (rng() * 256) | 0;
    img.data[i * 4 + 2] = (rng() * 256) | 0;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  return tex;
}

// ---- asphalt albedo (one 18m x 35m tile) ----------------------------------

function drawAsphalt(ctx, w, h) {
  const rng = mulberry32(101);
  // Base is a hair above the old value: wet black still, but with enough
  // headroom that aggregate, seams and paint have somewhere to sit. The
  // roadway must stay darker than the fogged walls at mid distance, so the
  // lift lives in the DETAIL, not in the flat field.
  ctx.fillStyle = '#161920';
  ctx.fillRect(0, 0, w, h);

  // large soft tonal patches (repaved sections, grime) — value variation is
  // what stops a dark road reading as a flat plastic sheet
  for (let i = 0; i < 52; i++) {
    const x = rng() * w, y = rng() * h, r = 70 + rng() * 300;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rng() < 0.5 ? 'rgba(70,78,94,0.20)' : 'rgba(2,3,5,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // hard-edged repave patches with a seam around them
  for (let i = 0; i < 7; i++) {
    const px = rng() * w, py = rng() * h;
    const pw = 90 + rng() * 260, ph = 110 + rng() * 420;
    ctx.fillStyle = rng() < 0.5 ? 'rgba(58,64,78,0.13)' : 'rgba(3,4,7,0.2)';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = 'rgba(3,4,7,0.5)';
    ctx.lineWidth = 3;
    ctx.strokeRect(px, py, pw, ph);
  }

  // aggregate speckle — chunkier and higher contrast so the surface reads
  // as coarse wet tarmac rather than flat paint at mid distance
  for (let i = 0; i < 13000; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(96,104,124,0.09)' : 'rgba(0,0,0,0.09)';
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 3, 1 + rng() * 3);
  }

  // wheel-rut darkening (worn polished lanes)
  for (const cx of [w * 0.30, w * 0.70]) {
    const g = ctx.createLinearGradient(cx - 95, 0, cx + 95, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 95, 0, 190, h);
  }

  // gutters along both kerbs (wet-dark tar, silted edge)
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.fillRect(0, 0, 36, h);
  ctx.fillRect(w - 36, 0, 36, h);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(36, 0, 30, h);
  ctx.fillRect(w - 66, 0, 30, h);

  // tar-snake crack seals — raised black, plus a lighter dry lip either side.
  // Drawn three times (y, y-h, y+h) so a seam that runs off one edge of the
  // tile continues onto the next instead of stopping dead every 35 m.
  const poly = (pts, dy) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1] + dy);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1] + dy);
    ctx.stroke();
  };
  for (let i = 0; i < 16; i++) {
    let x = rng() * w, y = rng() * h * 0.8;
    const pts = [[x, y]];
    for (let s = 0; s < 5; s++) {
      x += (rng() - 0.5) * 160;
      y += 40 + rng() * 120;
      pts.push([x, y]);
    }
    const lw = 3 + rng() * 5;
    for (const [style, width] of [['rgba(74,80,96,0.16)', lw + 5], ['rgba(4,5,8,0.72)', lw]]) {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      poly(pts, 0); poly(pts, -h); poly(pts, h);
    }
  }

  // ---- lane markings: dirty off-white, high enough albedo that grazing
  // neon spill picks them out of the black. Paint is the only thing on the
  // roadway allowed to be bright.
  // neutral-cool dirty white: warm cream paint would drag the frame's
  // dominant hue toward red, which is exactly what we are fighting
  const PAINT = (a) => `rgba(198,197,186,${a})`;

  // double centre line (solid pair) with dashed lane divides either side
  ctx.fillStyle = PAINT(0.52);
  ctx.fillRect(w / 2 - 13, 0, 8, h);
  ctx.fillRect(w / 2 + 5, 0, 8, h);
  ctx.fillStyle = PAINT(0.44);
  for (const lx of [w * 0.325, w * 0.675]) {
    for (let y = 30; y < h - 300; y += 260) ctx.fillRect(lx - 5, y, 10, 130);
  }

  // solid edge lines just inboard of the gutters
  ctx.fillStyle = PAINT(0.38);
  ctx.fillRect(w * 0.082 - 5, 0, 10, h);
  ctx.fillRect(w * 0.918 - 5, 0, 10, h);

  // kerbside no-stopping hatch (diagonal bars) on one side
  ctx.save();
  ctx.beginPath(); ctx.rect(w * 0.10, h * 0.05, w * 0.10, h * 0.30); ctx.clip();
  ctx.strokeStyle = PAINT(0.28);
  ctx.lineWidth = 7;
  for (let d = -h * 0.35; d < w; d += 46) {
    ctx.beginPath(); ctx.moveTo(w * 0.10 + d, h * 0.05); ctx.lineTo(w * 0.10 + d + h * 0.30, h * 0.35); ctx.stroke();
  }
  ctx.restore();

  // straight-ahead lane arrow
  ctx.fillStyle = PAINT(0.42);
  {
    const ax = w * 0.70, ay = h * 0.60;
    ctx.fillRect(ax - 7, ay, 14, 120);
    ctx.beginPath();
    ctx.moveTo(ax, ay - 46); ctx.lineTo(ax + 30, ay + 14); ctx.lineTo(ax - 30, ay + 14);
    ctx.closePath(); ctx.fill();
  }

  // stop line + zebra crosswalk at tile end (repeats every 35 m — block rhythm)
  ctx.fillStyle = PAINT(0.42);
  ctx.fillRect(56, h - 244, w - 112, 18);
  ctx.fillStyle = PAINT(0.5);
  for (let x = 64; x < w - 82; x += 104) ctx.fillRect(x, h - 196, 60, 172);

  // wear: dark speckle eating the paint (heaviest in the crossing). Fresh
  // chalk bars read as a stage prop; broken, tyre-scrubbed paint reads real.
  for (let i = 0; i < 9000; i++) {
    const y = rng() < 0.68 ? h - 250 + rng() * 250 : rng() * h;
    ctx.fillStyle = `rgba(14,15,20,${0.32 + rng() * 0.45})`;
    ctx.fillRect(rng() * w, y, 1 + rng() * 5, 1 + rng() * 5);
  }
  // grime washes diagonally across the crossing
  for (let i = 0; i < 5; i++) {
    const gy = h - 240 + rng() * 220;
    const gg = ctx.createLinearGradient(0, gy, w, gy + 60);
    gg.addColorStop(0, 'rgba(20,23,29,0)');
    gg.addColorStop(0.5, `rgba(20,23,29,${0.3 + rng() * 0.3})`);
    gg.addColorStop(1, 'rgba(20,23,29,0)');
    ctx.fillStyle = gg;
    ctx.fillRect(0, gy - 24, w, 60);
  }
  // rut tracks scrub the paint away where tyres run
  for (const cx of [w * 0.30, w * 0.70]) {
    const g = ctx.createLinearGradient(cx - 60, 0, cx + 60, 0);
    g.addColorStop(0, 'rgba(20,23,29,0)');
    g.addColorStop(0.5, 'rgba(20,23,29,0.42)');
    g.addColorStop(1, 'rgba(20,23,29,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 60, h - 210, 120, 200);
  }

  // oil stains — near-black with a faint iridescent rim
  for (let i = 0; i < 11; i++) {
    const ox = w * (0.22 + rng() * 0.56), oy = rng() * h;
    const orx = 24 + rng() * 48, ory = 15 + rng() * 32, orot = rng() * 3.14;
    ctx.strokeStyle = rng() < 0.5 ? 'rgba(60,40,90,0.16)' : 'rgba(30,70,80,0.16)';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.ellipse(ox, oy, orx, ory, orot, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(6,6,12,0.4)';
    ctx.beginPath(); ctx.ellipse(ox, oy, orx, ory, orot, 0, Math.PI * 2); ctx.fill();
  }

  // storm drain slots cut into both gutters
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  for (let i = 0; i < 4; i++) {
    const dy = 120 + i * (h / 4) + rng() * 90;
    const dx = rng() < 0.5 ? 8 : w - 66;
    ctx.fillRect(dx, dy, 58, 30);
    ctx.fillStyle = 'rgba(88,96,112,0.2)';
    ctx.fillRect(dx, dy - 4, 58, 4);
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
  }
}

// ---- roughness / puddle mask (shared by asphalt material and reflector) ----
// Dark = standing water (mirror). All water shapes are CONNECTED and
// z-elongated: continuous gutter channels along both kerbs, chained wheel-rut
// streaks (4-8x stretch), sheet water in the crosswalk dip. No round blobs.

function drawRoughness(ctx, w, h) {
  const rng = mulberry32(202);
  ctx.fillStyle = 'rgb(206,206,206)';   // dry-ish crown
  ctx.fillRect(0, 0, w, h);

  // tonal noise on the dry crown
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)';
    const s = 4 + rng() * 26;
    ctx.fillRect(rng() * w, rng() * h, s, s * (0.5 + rng()));
  }

  // cross-slope: the camber drains toward both kerbs, so the outer thirds
  // carry a wet film even where nothing is actually standing
  const cs = ctx.createLinearGradient(0, 0, w, 0);
  cs.addColorStop(0.00, 'rgba(96,96,96,0.62)');
  cs.addColorStop(0.20, 'rgba(150,150,150,0.22)');
  cs.addColorStop(0.50, 'rgba(255,255,255,0.06)');
  cs.addColorStop(0.80, 'rgba(150,150,150,0.22)');
  cs.addColorStop(1.00, 'rgba(96,96,96,0.62)');
  ctx.fillStyle = cs;
  ctx.fillRect(0, 0, w, h);

  // damp polished wheel lanes — connective tissue between rut streaks
  for (const cx of [w * 0.30, w * 0.70]) {
    const g = ctx.createLinearGradient(cx - 56, 0, cx + 56, 0);
    g.addColorStop(0, 'rgba(118,118,118,0)');
    g.addColorStop(0.5, 'rgba(118,118,118,0.6)');
    g.addColorStop(1, 'rgba(118,118,118,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 56, 0, 112, h);
  }

  // ---- continuous gutter channels ------------------------------------
  // One unbroken polygon per kerb with an undulating waterline. Rain runs
  // in lines, so this is a ribbon, not a chain of blobs.
  // Frequencies are exact harmonics of the tile height, so the waterline
  // wraps: the gutter is one ribbon down 280 m, not eight 35 m segments
  // with a visible step at every seam.
  const K = (n) => (n * Math.PI * 2) / h;
  const wave = (y, ph) =>
    Math.sin(y * K(3) + ph) * 0.46 +
    Math.sin(y * K(7) + ph * 2.3) * 0.27 +
    Math.sin(y * K(15) + ph * 0.7) * 0.16 +
    Math.sin(y * K(37) + ph * 3.1) * 0.11;

  const channel = (side, ph, base, amp, fill) => {
    ctx.beginPath();
    const x0 = side ? w + 20 : -20;
    ctx.moveTo(x0, -30);
    for (let y = -30; y <= h + 30; y += 6) {
      const wd = base + amp * wave(y, ph);
      ctx.lineTo(side ? w - wd : wd, y);
    }
    ctx.lineTo(x0, h + 30);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  for (const side of [0, 1]) {
    const ph = side ? 2.31 : 0.44;
    channel(side, ph, 74, 26, 'rgba(126,126,126,0.55)');  // damp margin
    channel(side, ph, 52, 20, 'rgba(58,58,58,0.85)');     // shallow water
    channel(side, ph, 38, 15, 'rgb(14,14,14)');           // crisp waterline
  }

  // ---- z-stretched water shape (crisp core, short rim) ---------------
  const streak1 = (x, y, rx, ry, a) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, rx * 0.2, 0, 0, rx);
    g.addColorStop(0, `rgba(10,10,10,${a})`);
    g.addColorStop(0.86, `rgba(13,13,13,${a * 0.94})`);
    g.addColorStop(1, 'rgba(96,96,96,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  // wraps across the tile seam so a rut never gets guillotined every 35 m
  const streak = (x, y, rx, ry, a = 0.94) => {
    streak1(x, y, rx, ry, a);
    if (y - ry < 0) streak1(x, y + h, rx, ry, a);
    if (y + ry > h) streak1(x, y - h, rx, ry, a);
  };

  // ---- wheel-rut ruts: long unbroken runs, 6-14x elongated ------------
  for (const rc of [0.295, 0.705, 0.42, 0.58]) {
    const outer = rc < 0.35 || rc > 0.65;
    let x = rc * w + (rng() - 0.5) * 16;
    let y = -60 + rng() * 120;
    while (y < h + 80) {
      const ry = (outer ? 110 : 70) + rng() * (outer ? 190 : 110); // 4-20 m
      const rx = (outer ? 11 : 8) + rng() * 9;                      // 0.3-0.7 m
      streak(x, y, rx, ry, outer ? 0.94 : 0.82);
      // ruts run in pairs — a tyre track has two lines
      if (outer) streak(x + 30 + rng() * 12, y + ry * 0.25, rx * 0.8, ry * 0.85, 0.86);
      y += ry * (0.95 + rng() * 0.5);            // overlap: unbroken run
      if (rng() < 0.22) y += 110 + rng() * 190;  // occasional dry-ish break
      x += (rng() - 0.5) * 20;
      x = Math.max(w * 0.20, Math.min(w * 0.80, x));
    }
  }

  // ---- sheet water in the low spots ----------------------------------
  // Wide, shallow, irregular but CONNECTED — a sheet, not a disc.
  // Standing water has a surface-tension edge: irregular at EVERY scale and
  // feathered into a damp margin. The old 26-gon read as exactly what it was —
  // straight runs and hard corners. Seven harmonics kill any repeating lobe,
  // 240 segments put the chords under a texel, and the nested passes turn the
  // boundary into a gradient instead of a cut.
  const sheet = (cx, cy, rx, ry, a) => {
    const s = 3.1 + cx * 0.0131 + cy * 0.0071;
    const R = (th) =>
      1
      + 0.215 * Math.sin(th * 2 + s)
      + 0.135 * Math.sin(th * 3 - s * 1.7)
      + 0.092 * Math.sin(th * 5 + s * 2.3)
      + 0.061 * Math.sin(th * 8 - s * 0.9)
      + 0.040 * Math.sin(th * 13 + s * 3.1)
      + 0.026 * Math.sin(th * 21 - s * 2.2)
      + 0.017 * Math.sin(th * 34 + s * 1.3);
    const N = 240;
    for (const [k, mul] of [[1.16, 0.13], [1.09, 0.24], [1.035, 0.44], [0.985, 0.68], [0.92, 1.0]]) {
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const th = (i / N) * Math.PI * 2;
        const r = R(th) * k;
        const px = cx + Math.cos(th) * rx * r, py = cy + Math.sin(th) * ry * r;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(16,16,16,${(a * mul).toFixed(3)})`;
      ctx.fill();
    }
  };
  // crossing dip — the biggest continuous sheet, spanning most of the road
  sheet(w * 0.5, h - 120, w * 0.46, 86, 0.9);
  sheet(w * 0.34, h - 168, w * 0.24, 60, 0.86);
  sheet(w * 0.72, h - 76, w * 0.22, 52, 0.86);
  // a couple more low spots up the block, each hugging a kerb
  sheet(w * 0.14, h * 0.30, w * 0.15, 130, 0.88);
  sheet(w * 0.87, h * 0.62, w * 0.14, 150, 0.88);
  sheet(w * 0.5, h * 0.10, w * 0.30, 58, 0.72);

  // ---- dry islands ----------------------------------------------------
  // Water is continuous, but coarse aggregate breaks the surface. Without
  // these the ruts mirror as suspiciously perfect parallel brush strokes.
  for (let i = 0; i < 520; i++) {
    const x = rng() * w, y = 44 + rng() * (h - 88);
    const rx = 4 + rng() * 22, ry = rx * (0.4 + rng() * 1.9);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rng() - 0.5) * 0.5);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(214,214,214,${0.18 + rng() * 0.4})`);
    g.addColorStop(1, 'rgba(214,214,214,0)');
    ctx.scale(rx, ry);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // hairline scratches / brush marks across the film
  for (let i = 0; i < 260; i++) {
    ctx.strokeStyle = `rgba(200,200,200,${0.1 + rng() * 0.22})`;
    ctx.lineWidth = 1 + rng() * 2;
    const len = 20 + rng() * 130;
    const x = rng() * w, y = rng() * (h - len - 4);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 26, y + len);
    ctx.stroke();
  }

  // Micro sparkle / aggregate grain (also drives the bump map). Kept low
  // contrast on purpose: the reflector thresholds this map, so grain of the
  // same amplitude as the threshold window turns every waterline into a
  // stipple of half-lit pixels instead of a feathered edge.
  for (let i = 0; i < 14000; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.055)';
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
  }
}

// ---- baked neon spill for the roadway (lightMap, non-repeating) ------------
// Low grazing light licking in from the signage on both walls — magenta/cyan/
// sodium pools that let markings and manholes read while the crown stays black.

function drawStreetSpill(ctx, w, h) {
  const rng = mulberry32(808);
  // Near-black blue floor. The roadway must not glow on its own — every lit
  // patch below is a specific sign on a specific wall throwing light down.
  ctx.fillStyle = 'rgb(9,13,20)';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';

  // Saturated magenta / cyan / sodium only. No pastel, no red — the frame's
  // dominant hue must stay blue-teal with neon as local accents.
  // Cyan/teal carries the block; magenta and sodium are the minority
  // accents. A road that is uniformly violet is candy, not Deakins.
  const cols = [
    [46, 200, 240], [40, 215, 220], [255, 60, 150],
    [46, 200, 240], [50, 235, 205], [255, 140, 50], [46, 200, 240],
    [190, 70, 255], [40, 215, 220],
  ];
  for (const side of [0, 1]) {
    let y = 20 + rng() * 60;
    while (y < h) {
      const [r, g, b] = cols[Math.floor(rng() * cols.length)];
      const inten = 0.30 + rng() * 0.55;         // hotter at the kerb...
      const reach = w * (0.16 + rng() * 0.22);   // ...but reaches only 16-38%
      const len = 55 + rng() * 130;
      ctx.save();
      ctx.translate(side ? w : 0, y);
      ctx.scale(1, len / reach);
      const gr = ctx.createRadialGradient(0, 0, reach * 0.04, 0, 0, reach);
      gr.addColorStop(0, `rgba(${r},${g},${b},${inten})`);
      gr.addColorStop(0.35, `rgba(${r},${g},${b},${inten * 0.34})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(0, 0, reach, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      y += len * (1.15 + rng() * 1.3);           // gaps of pure dark between
    }
  }

  // world (x,z) -> canvas. z=+50 is the near end and maps to the canvas
  // bottom; z=-230 is the fogged far end at the top.
  const toC = (x, z) => [
    ((x + ROAD_HALF) / (ROAD_HALF * 2)) * w,
    (1 - (50 - z) / LEN) * h,
  ];

  // Hero pools at fixed world positions: the street and alley cameras both
  // look down the near end of the corridor, and a quadrant of dead black
  // there is a compositional hole, not restraint. Each is a specific sign
  // on a specific wall throwing light onto the kerb below it.
  const HERO_POOLS = [
    [-8.4, 26, [46, 200, 240], 0.85, 30, 120],   // cyan, left kerb, near
    [8.4, 6, [255, 60, 150], 0.80, 28, 105],     // magenta, right kerb
    [-8.4, -24, [190, 70, 255], 0.62, 26, 95],   // violet, left, mid
    [8.4, -52, [46, 200, 240], 0.58, 24, 90],    // cyan, right, deep
    [-8.4, -96, [50, 235, 205], 0.42, 22, 85],   // teal, fading into fog
  ];
  for (const [px, pz, [r, g, b], inten, rx, ry] of HERO_POOLS) {
    const [cx, cy] = toC(px, pz);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const gr = ctx.createRadialGradient(0, 0, rx * 0.04, 0, 0, rx * 2.6);
    gr.addColorStop(0, `rgba(${r},${g},${b},${inten})`);
    gr.addColorStop(0.30, `rgba(${r},${g},${b},${inten * 0.3})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(0, 0, rx * 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // warm sodium pools over the hero steam grates (matches the decals)
  for (const [gx, gz] of HERO_GRATES) {
    const [cx, cy] = toC(gx, gz);
    ctx.fillStyle = 'rgba(255,140,50,0.055)';
    for (let r = 52; r > 10; r -= 11) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.30, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// baked spill for the sidewalk slabs: pools at both long edges
function drawWalkSpill(ctx, w, h) {
  const rng = mulberry32(909);
  ctx.fillStyle = 'rgb(9,12,18)';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  const cols = [[255, 60, 150], [46, 200, 240], [255, 140, 50], [190, 70, 255], [46, 200, 240]];
  for (const side of [0, 1]) {
    let y = rng() * 80;
    while (y < h) {
      const [r, g, b] = cols[Math.floor(rng() * cols.length)];
      const inten = 0.30 + rng() * 0.55;
      const reach = w * (0.24 + rng() * 0.24);
      const len = 45 + rng() * 105;
      ctx.save();
      ctx.translate(side ? w : 0, y);
      ctx.scale(1, len / reach);
      const gr = ctx.createRadialGradient(0, 0, reach * 0.04, 0, 0, reach);
      gr.addColorStop(0, `rgba(${r},${g},${b},${inten})`);
      gr.addColorStop(0.35, `rgba(${r},${g},${b},${inten * 0.34})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(0, 0, reach, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      y += len * (1.25 + rng() * 1.4);
    }
  }
}

// ---- kerb sheen ------------------------------------------------------------
// A wet kerb catches the sign above it as a broken line of glints running to
// the vanishing point. Baked as an additive strip so it costs one draw call
// and no per-pixel lighting — the "bake spill into geometry" rule.

function drawKerbSheen(ctx, w, h) {
  const rng = mulberry32(717);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  const cols = [[255, 60, 150], [46, 200, 240], [255, 140, 50], [190, 70, 255], [46, 200, 240]];
  let y = rng() * 60;
  while (y < h) {
    const [r, g, b] = cols[Math.floor(rng() * cols.length)];
    const len = 26 + rng() * 90;
    const inten = 0.30 + rng() * 0.6;
    const gr = ctx.createLinearGradient(0, y, 0, y + len);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(0.5, `rgba(${r},${g},${b},${inten})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, y, w, len);
    y += len * (1.5 + rng() * 2.2);   // long dark gaps: glints, not a stripe
  }
}

// ---- kerb: road-facing face and top ---------------------------------------
// One 2.5 m length of kerb. A flat-coloured box reads as a placeholder wedge
// the instant a camera gets close, which is exactly what the alley preset
// does. What a real wet kerb has: a silt/tide line where the gutter water
// stands, vertical run-off staining, chipped corners with pale aggregate
// showing through, and a bright wet lip along the nose.

function drawKerbFace(ctx, w, h) {
  const rng = mulberry32(838);
  const SILT = h * 0.30;          // waterline height above the plane bottom

  ctx.fillStyle = '#12151b';
  ctx.fillRect(0, 0, w, h);

  // cast-concrete tonal blotching
  for (let i = 0; i < 90; i++) {
    const x = rng() * w, y = rng() * h, r = 14 + rng() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rng() < 0.5 ? 'rgba(76,84,100,0.16)' : 'rgba(2,3,5,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 5200; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(104,112,132,0.08)' : 'rgba(0,0,0,0.10)';
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
  }

  // vertical run-off staining — rain sheets off the pavement and streaks down
  for (let i = 0; i < 70; i++) {
    const x = rng() * w, ww = 2 + rng() * 11;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    const dark = rng() < 0.62;
    g.addColorStop(0, dark ? 'rgba(0,0,0,0.32)' : 'rgba(96,104,122,0.13)');
    g.addColorStop(0.7, dark ? 'rgba(0,0,0,0.14)' : 'rgba(96,104,122,0.05)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, ww, h);
  }

  // ---- silt line: the gutter's high-water mark. Warm grey deposit with a
  // ragged upper edge, grit below it, and near-black tar at the very bottom.
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 4) {
    const y = h - SILT
      + Math.sin(x * 0.031 + 1.2) * 4.5
      + Math.sin(x * 0.097 - 0.4) * 2.6
      + Math.sin(x * 0.23 + 2.7) * 1.4;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(74,68,56,0.34)';
  ctx.fill();
  // grit sitting in the silt
  for (let i = 0; i < 1800; i++) {
    const y = h - SILT * rng() * 1.05;
    ctx.fillStyle = rng() < 0.45 ? 'rgba(120,112,94,0.2)' : 'rgba(0,0,0,0.3)';
    ctx.fillRect(rng() * w, y, 1 + rng() * 3, 1 + rng() * 2);
  }
  // tar/black shadow line at the gutter itself
  const tg = ctx.createLinearGradient(0, h - SILT * 0.42, 0, h);
  tg.addColorStop(0, 'rgba(0,0,0,0)');
  tg.addColorStop(1, 'rgba(0,0,0,0.72)');
  ctx.fillStyle = tg;
  ctx.fillRect(0, h - SILT * 0.42, w, SILT * 0.42);

  // ---- chipped edges: notches out of the top nose, pale aggregate inside
  for (let i = 0; i < 22; i++) {
    const x = rng() * w, cw = 5 + rng() * 26, ch = 3 + rng() * 11;
    ctx.fillStyle = `rgba(122,128,144,${0.16 + rng() * 0.2})`;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + cw, 0);
    ctx.lineTo(x + cw * (0.3 + rng() * 0.4), ch);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x + cw * 0.2, ch * 0.6, cw * 0.5, 1.5);
  }
  // wet lip: the nose of the kerb catches the sky and every sign above it
  const lip = ctx.createLinearGradient(0, 0, 0, h * 0.16);
  lip.addColorStop(0, 'rgba(148,158,178,0.30)');
  lip.addColorStop(1, 'rgba(148,158,178,0)');
  ctx.fillStyle = lip;
  ctx.fillRect(0, 0, w, h * 0.16);

  // casting joints every section
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(0, 0, 3, h);
  ctx.fillStyle = 'rgba(120,128,146,0.14)';
  ctx.fillRect(3, 0, 2, h);
}

function drawKerbTop(ctx, w, h) {
  const rng = mulberry32(848);
  ctx.fillStyle = '#161a21';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 3400; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(110,120,142,0.09)' : 'rgba(0,0,0,0.11)';
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
  }
  // damp film pooling toward the road edge (u=0 side)
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(96,108,128,0.20)');
  g.addColorStop(0.55, 'rgba(60,68,84,0.06)');
  g.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // wet patches along the top, elongated with the kerb
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(126,140,164,${0.05 + rng() * 0.13})`;
    ctx.beginPath();
    ctx.ellipse(rng() * w, rng() * h, 4 + rng() * 14, 16 + rng() * 70, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // casting joint + chipped corners
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, w, 3);
  ctx.fillStyle = 'rgba(120,128,146,0.15)';
  ctx.fillRect(0, 3, w, 2);
  for (let i = 0; i < 9; i++) {
    const x = rng() * w, y = rng() * h, s = 3 + rng() * 9;
    ctx.fillStyle = `rgba(124,132,150,${0.12 + rng() * 0.18})`;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s * 1.6);
    ctx.closePath(); ctx.fill();
  }
}

// ---- aerial wet-floor glints ----------------------------------------------
// Non-repeating over the whole roadway, same (x,z) framing as drawStreetSpill.
// Only ever visible from a high camera, so it can be hot: puddle specular in
// the gutter channels, elongated warm pools where traffic runs, cold sign
// glints in the crossing sheet water.

function drawWetGlint(ctx, w, h) {
  const rng = mulberry32(1212);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';

  const streak = (cx, cy, rx, ry, r, g, b, a) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    gr.addColorStop(0, `rgba(${r},${g},${b},${a})`);
    gr.addColorStop(0.4, `rgba(${r},${g},${b},${a * 0.36})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };

  // gutter channels: the water that always stands, mirroring the signs above
  const cols = [[40, 190, 235], [255, 60, 150], [46, 210, 200], [190, 80, 255], [255, 150, 60]];
  for (const side of [0, 1]) {
    let y = rng() * 90;
    const bx = side ? w * 0.925 : w * 0.075;
    while (y < h) {
      const [r, g, b] = cols[Math.floor(rng() * cols.length)];
      const len = 40 + rng() * 130;
      streak(bx + (rng() - 0.5) * 12, y, 11 + rng() * 8, len, r, g, b, 0.42 + rng() * 0.45);
      y += len * (1.1 + rng() * 1.3);
    }
  }

  // vehicle light pooling: long warm smears in the two running lanes plus a
  // few red tail-light pools. Baked, so it costs no lights (perf rule).
  for (const lx of [w * 0.30, w * 0.70]) {
    let y = rng() * 200;
    while (y < h) {
      const warm = rng() < 0.72;
      const [r, g, b] = warm ? [255, 176, 96] : [255, 58, 44];
      streak(lx + (rng() - 0.5) * 34, y, 15 + rng() * 12, 90 + rng() * 230, r, g, b,
        (warm ? 0.30 : 0.22) + rng() * 0.3);
      y += 180 + rng() * 420;
    }
  }

  // crossing sheet water — the single brightest patch of floor in the block
  streak(w * 0.5, h * 0.885, w * 0.34, 70, 70, 200, 230, 0.5);
  streak(w * 0.42, h * 0.845, w * 0.2, 44, 230, 90, 190, 0.34);

  // scattered puddle sparkle
  for (let i = 0; i < 210; i++) {
    const [r, g, b] = cols[Math.floor(rng() * cols.length)];
    const s = 1.5 + rng() * 5;
    streak(rng() * w, rng() * h, s, s * (1.6 + rng() * 4), r, g, b, 0.22 + rng() * 0.5);
  }
}

// ---- sidewalk concrete -----------------------------------------------------

function drawSidewalk(ctx, w, h) {
  const rng = mulberry32(303);
  ctx.fillStyle = '#171a23';
  ctx.fillRect(0, 0, w, h);

  // slab-to-slab tonal variation — a pavement is cast in pieces, and the
  // pieces never match. Without this the walk is one flat grey plane.
  for (let sy = 0; sy < h; sy += 128) {
    for (let sx = 0; sx < w; sx += 128) {
      ctx.fillStyle = rng() < 0.5
        ? `rgba(84,92,110,${0.04 + rng() * 0.10})`
        : `rgba(2,3,6,${0.05 + rng() * 0.12})`;
      ctx.fillRect(sx, sy, 128, 128);
    }
  }

  for (let i = 0; i < 6500; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(96,104,124,0.09)' : 'rgba(0,0,0,0.10)';
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
  }
  // stains / gum / damp patches
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `rgba(4,5,9,${0.14 + rng() * 0.26})`;
    ctx.beginPath();
    ctx.ellipse(rng() * w, rng() * h, 10 + rng() * 60, 8 + rng() * 40, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // chipped slab corners
  for (let i = 0; i < 26; i++) {
    const cx = Math.floor(rng() * (w / 128)) * 128, cy = Math.floor(rng() * (h / 128)) * 128;
    ctx.fillStyle = 'rgba(2,3,6,0.5)';
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(cx + 8 + rng() * 22, cy); ctx.lineTo(cx, cy + 8 + rng() * 22);
    ctx.closePath(); ctx.fill();
  }

  // expansion joints (slab grid) — deeper groove, brighter wet lip. This is
  // the only thing giving the sidewalk scale and direction at a distance.
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = 5;
  for (let x = 0; x <= w; x += 128) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y <= h; y += 128) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(126,134,154,0.3)';
  ctx.lineWidth = 2;
  for (let x = 4; x <= w; x += 128) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 4; y <= h; y += 128) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
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

// Shared GLSL. Everything is a pure function of world position and uTime, so
// a fixed t always renders the same frame (determinism rule) — no Math.random
// and no CPU-side state.
//
// The randomness is TABULATED, not hashed. On a software rasteriser a handful
// of texture fetches is far cheaper than the ~30 fract/dot hashes the same
// number of noise octaves would cost per fragment, and this shader runs over
// most of the road in three of the four presets.
//   uNoise — bilinear-filtered RGBA, four independent smooth fields
//   uCell  — nearest-filtered RGBA, four independent constants per cell
const NOISE_GLSL = /* glsl */`
  uniform sampler2D uNoise;
  uniform sampler2D uCell;
  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }
  // One rain-impact layer. The world is cut into cells of size cs; each cell
  // owns exactly one drop at a jittered offset with its own phase, and the
  // ring never grows past half a cell, so no neighbour lookup is needed —
  // tens of legible rings per square metre for one nearest-filtered fetch.
  // xy = surface tilt of the ring wall, z = crest brightness.
  vec3 ringLayer(vec2 wp, float cs, float ofs, float rate, float t) {
    vec2 g = wp / cs;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec4 h = texture2D(uCell, (id + 0.5) * 0.015625 + ofs);
    // Drop position inside the cell. Pushed wide enough that the underlying
    // lattice stops being readable; rings that overrun their cell simply get
    // clipped, which shows up as the partial arcs real splashes make.
    vec2 c = (h.xy - 0.5) * 0.64;
    // Duty cycle below 1: a cell sits empty between strikes, so the water
    // reads as scattered impacts on dark water instead of a continuous crust
    // of rings.
    float age = fract(t * rate + h.z) * 2.05;
    if (age > 1.0) return vec3(0.0);
    vec2 d = f - c;
    float r = length(d) + 1e-5;
    float rad = age * (0.30 + 0.20 * h.x);
    // Ring WALL thickness, in cell units. A splash crest is a fat torus, not
    // a hairline: at 0.03 cells it is sub-pixel at any usable camera range
    // and the whole system renders as invisible speckle.
    float w = 0.075 + 0.150 * age;
    float q = (r - rad) / w;
    float ring = exp(-q * q) * (1.0 - age);
    return vec3(d / r * ring, ring);
  }
`;

const WetStreetShader = {
  name: 'WetStreetReflector',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uMask: { value: null },
    uNoise: { value: null },
    uCell: { value: null },
    uRepeat: { value: new THREE.Vector2(1, REPEAT_Z) },
    uTexel: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
    uMaxLod: { value: 3.1 },
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
    uniform vec2 uTexel;
    uniform float uMaxLod;
    uniform float uTime;
    uniform vec3 fogColor;
    uniform float fogDensity;
    uniform float fogNear;
    uniform float fogFar;
    varying vec4 vRefUv;
    varying vec2 vUv;
    varying vec3 vWorld;
    varying float vFogDepth;
    ${NOISE_GLSL}
    void main() {
      // ---- wetness -------------------------------------------------------
      // The mask lookup is warped in WORLD space at three octaves before the
      // threshold. Nothing drawn into the canvas can survive as a straight
      // line or a corner, so a puddle edge reads as surface tension rather
      // than as the polygon it actually is.
      vec2 w2 = vWorld.xz;
      vec4 n0 = texture2D(uNoise, w2 * 0.055);
      vec4 n1 = texture2D(uNoise, w2 * 0.230 + 0.37);
      vec4 n2 = texture2D(uNoise, w2 * 0.850 + 0.11);
      vec2 warp = (n0.rg - 0.5) * 0.032
                + (n1.rg - 0.5) * 0.010
                + (n2.rg - 0.5) * 0.0022;
      float rough = texture2D(uMask, vUv * uRepeat + warp).g;
      float wet = 1.0 - rough;
      // the threshold itself wanders, so even a perfectly straight mask edge
      // comes out ragged and feathered
      float thr = 0.485 + (n1.b - 0.5) * 0.080 + (n2.b - 0.5) * 0.035;
      float puddle = smoothstep(thr, thr + 0.240, wet);
      // In this weather NOTHING is dry. The crown is a thin film rather than
      // standing water, but it still has to take rain.
      float film = smoothstep(0.02, 0.28, wet);

      // ---- rain impacts ---------------------------------------------------
      // Three cell sizes = 8.6 + 3.7 + 17.4 drops per square metre, most of
      // them mid-flight at any instant: ~30 legible impacts/m^2 near camera.
      // Gated by range, past which a crest goes sub-pixel and only aliases.
      float dist = length(cameraPosition - vWorld);
      float nearK = 1.0 - smoothstep(12.0, 42.0, dist);
      vec3 rip = vec3(0.0);
      if (nearK > 0.004) {
        rip  = ringLayer(w2, 0.34, 0.000, 1.55, uTime);
        rip += ringLayer(w2, 0.54, 0.317, 1.15, uTime) * 1.15;
        rip += ringLayer(w2, 0.26, 0.661, 2.05, uTime) * 0.55;
        rip *= nearK * (0.75 + 0.25 * puddle) * film;
      }

      // ---- reflection tap --------------------------------------------------
      vec4 p = vRefUv;
      // slow chop under the impacts: the sheet itself is moving
      float amp = 0.00030 + 0.00060 * puddle;
      vec2 chop = vec2(
        sin(vWorld.x * 5.1 + uTime * 2.4) + 0.45 * sin(vWorld.z * 3.7 - uTime * 1.9),
        cos(vWorld.x * 4.3 - uTime * 1.6) + 0.45 * cos(vWorld.z * 6.2 + uTime * 2.8)
      ) * amp;
      p.xy += (chop + rip.xy * (0.0022 + 0.0060 * puddle)) * p.w;

      // Sub-texel dither. The mirror buffer is coarser than the frame, and a
      // single point sample of it turns every vertical neon column into a
      // hard staircase. Jittering inside a texel converts that aliasing into
      // noise the grade can absorb.
      float jit  = hash21(gl_FragCoord.xy * 1.37);
      float jit2 = hash21(gl_FragCoord.yx * 2.11 + 7.3);
      p.xy += (vec2(jit, jit2) - 0.5) * uTexel * 0.85 * p.w;

      // Roughness drives the blur. Damp asphalt scatters the mirrored sign
      // into a long vertical smear; only true standing water stays sharp.
      float damp = (1.0 - puddle) * film;
      float lod = mix(uMaxLod, 0.60, puddle);
      float smear = 0.0030 + 0.0300 * damp;
      vec4 p1 = p; p1.y += smear * (0.62 + jit  * 0.55) * p.w;
      vec4 p2 = p; p2.y -= smear * (0.34 + jit2 * 0.45) * p.w;
      vec4 p3 = p; p3.y += smear * (1.48 + jit  * 0.70) * p.w;
      float wA = mix(0.42, 0.88, puddle);
      float wR = 1.0 - wA;
      vec3 refl =
        texture2DProjLodEXT(tDiffuse, p,  lod).rgb * wA +
        texture2DProjLodEXT(tDiffuse, p1, lod + 0.40).rgb * wR * 0.42 +
        texture2DProjLodEXT(tDiffuse, p2, lod + 0.40).rgb * wR * 0.34 +
        texture2DProjLodEXT(tDiffuse, p3, lod + 0.95).rgb * wR * 0.24;

      vec3 viewDir = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 2.2);

      // Pedestal removal: the mirrored image is mostly fogged haze, and
      // that grey floor is exactly the milk that kills a night frame. Cut
      // it and re-gain, so only genuinely hot neon survives into the water.
      // The steeper the look-down, the more fogged far field lands in the
      // mirror, so the cut scales with elevation — otherwise the aerial
      // canyon floor turns into a pale lavender wash.
      refl = max(refl - (0.078 + 0.085 * (1.0 - fres)), 0.0) * (1.35 + 1.75 * puddle);
      refl *= color;
      refl *= mix(0.22, 1.0, puddle);

      // Impact crests catch whatever the water is mirroring plus a slice of
      // overcast sky, so a ring stays legible on black asphalt — which is
      // most of the roadway. Without the sky term the splash system exists
      // only in the source: mathematically present, invisible in frame.
      // NB this layer blends additively, i.e. rgb is multiplied by alpha on
      // the way out. A crest driving both terms therefore lands as crest^2,
      // which is why the first pass at this was arithmetically present and
      // optically absent. Alpha is lifted separately so a ring reads.
      float crest = clamp(rip.z, 0.0, 1.6);
      refl += crest * (refl * 1.55 + vec3(0.120, 0.240, 0.330));

      float alpha = mix(0.10, 1.0, puddle) * (0.30 + 0.70 * fres);
      alpha = max(alpha, clamp(crest * 1.6, 0.0, 0.92));

      float fogAtten = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      gl_FragColor = vec4(refl, alpha * clamp(fogAtten, 0.0, 1.0));
      #include <colorspace_fragment>
    }`,
};

// ---- wet-floor glint layer (the read from ALTITUDE) ------------------------
// A grazing planar mirror gives a bird's-eye camera almost nothing: Fresnel
// collapses and the canyon floor goes to a flat smear. But a wet street seen
// from above is the BRIGHTEST thing in a night frame — you are looking down
// into pooled sign light and vehicle spill. This additive layer supplies
// exactly that, gated on view elevation so it is worth ~0 at street level and
// full strength from the aerial camera. Cost is one extra plane that
// discards immediately for every low camera.

const WetGlintShader = {
  uniforms: {
    uMask: { value: null },
    uSpill: { value: null },
    uGlint: { value: null },
    uNoise: { value: null },
    uCell: { value: null },
    uRepeat: { value: new THREE.Vector2(1, REPEAT_Z) },
    uStrength: { value: 1.0 },
    uTime: { value: 0 },
    fogColor: { value: new THREE.Color(0x30465a) },
    fogDensity: { value: 0.0118 },
    fogNear: { value: 1 },
    fogFar: { value: 1000 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    varying vec3 vWorld;
    varying float vFogDepth;
    void main() {
      vUv = uv;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vec4 mv = viewMatrix * wp;
      vFogDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uMask;
    uniform sampler2D uSpill;
    uniform sampler2D uGlint;
    uniform vec2 uRepeat;
    uniform float uStrength;
    uniform float uTime;
    uniform vec3 fogColor;
    uniform float fogDensity;
    uniform float fogNear;
    uniform float fogFar;
    varying vec2 vUv;
    varying vec3 vWorld;
    varying float vFogDepth;
    ${NOISE_GLSL}
    void main() {
      vec3 V = normalize(cameraPosition - vWorld);
      float up = smoothstep(0.30, 0.62, V.y);
      if (up < 0.005) discard;              // street/alley/canyon pay nothing
      float rough = texture2D(uMask, vUv * uRepeat).g;
      float wet = 1.0 - rough;
      float puddle = smoothstep(0.44, 0.68, wet);
      float pud2 = puddle * puddle;    // islands, not a wash
      // The baked spill is a broad soft field — exactly the wrong shape for
      // a specular read. Cut its pedestal so only the hot cores survive and
      // let the glint streaks carry the floor.
      vec3 spill = max(texture2D(uSpill, vUv).rgb - 0.055, 0.0) * 1.7;
      vec3 glint = texture2D(uGlint, vUv).rgb;
      // broken specular glitter so the canyon floor is a surface, not a smear
      float sp = texture2D(uNoise, vWorld.xz * 0.55 + vec2(0.31, 0.77 + uTime * 0.03)).b;
      sp = max(sp - 0.58, 0.0) * 2.5;
      sp *= sp;
      vec3 c = spill * (0.12 + 1.35 * pud2)
             + glint * (0.22 + 1.75 * pud2)
             + vec3(0.16, 0.34, 0.46) * sp * pud2;
      // wet floor keeps the sign's colour; a desaturated floor reads as haze
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = max(mix(vec3(lum), c, 1.35), 0.0);
      float fogAtten = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      gl_FragColor = vec4(c * uStrength, up * clamp(fogAtten, 0.0, 1.0));
      #include <colorspace_fragment>
    }`,
};

// ---------------------------------------------------------------------------

export function buildGround(ctx = {}) {
  const { renderer, camera } = ctx;
  const group = new THREE.Group();
  const rng = mulberry32(1337);

  // -- textures --
  const asphaltMap = canvasTex(1024, 2048, drawAsphalt, { srgb: true, repeat: [1, REPEAT_Z] });
  // higher-res mask: the waterline is an EDGE, and a soft edge reads as a blob
  const roughMap = canvasTex(768, 1536, drawRoughness, { repeat: [1, REPEAT_Z] });
  const streetSpill = canvasTex(256, 1024, drawStreetSpill);       // non-repeating
  const walkSpill = canvasTex(128, 1024, drawWalkSpill);           // non-repeating
  const glintMap = canvasTex(256, 1024, drawWetGlint);             // non-repeating
  const kerbFaceMap = canvasTex(512, 128, drawKerbFace, { srgb: true, repeat: [112, 1] });
  const kerbTopMap = canvasTex(128, 512, drawKerbTop, { srgb: true, repeat: [1, 112] });
  const kerbSheen = canvasTex(32, 1024, drawKerbSheen, { srgb: true });
  // smooth field (bilinear) + per-cell constants (nearest)
  const noiseTex = noiseTable(64, 2468);
  noiseTex.minFilter = noiseTex.magFilter = THREE.LinearFilter;
  const cellTex = noiseTable(64, 1357);
  cellTex.minFilter = cellTex.magFilter = THREE.NearestFilter;
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
    bumpScale: 0.085,
    metalness: 0.05,
    lightMap: streetSpill,
    lightMapIntensity: 2.3,
  });
  const street = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, LEN), streetMat);
  street.rotation.x = -Math.PI / 2;
  street.position.set(0, 0.01, Z_CENTER);
  street.receiveShadow = true;
  group.add(street);

  // -- planar reflection overlay (puddles mirror the neon above) --
  // The mirror buffer must not be coarser than the frame it is composited
  // into: a magnified point sample of a quarter-res buffer is what turned
  // every vertical neon column into a 4-8 px staircase. Size it from the
  // actual drawing buffer so a 1600x900 verify pass gets a 1:1 mirror and a
  // 800x450 iteration pass does not waste fill on one it cannot show.
  // 0.8x the frame is the knee: with the mip chain and the sub-texel dither
  // below, the staircase is gone by 0.8x, while going to 1:1 costs ~40% of a
  // whole extra scene render per refresh for no visible gain.
  const dbSize = new THREE.Vector2(1600, 900);
  renderer?.getDrawingBufferSize?.(dbSize);
  const RW = Math.max(640, Math.min(1280, Math.round((dbSize.x || 1600) * 0.8)));
  const RH = Math.max(360, Math.min(720, Math.round((dbSize.y || 900) * 0.8)));
  const reflector = new Reflector(new THREE.PlaneGeometry(ROAD_HALF * 2, LEN), {
    clipBias: 0.003,
    textureWidth: RW,
    textureHeight: RH,
    color: 0xc9d3de,
    multisample: 0,
    shader: WetStreetShader,
  });
  reflector.rotation.x = -Math.PI / 2;
  reflector.position.set(0, 0.055, Z_CENTER);
  const reflMat = reflector.material;
  reflMat.uniforms.uMask.value = roughMap;
  reflMat.uniforms.uNoise.value = noiseTex;
  reflMat.uniforms.uCell.value = cellTex;
  reflMat.uniforms.uTexel.value.set(1 / RW, 1 / RH);
  reflMat.transparent = true;
  reflMat.blending = THREE.AdditiveBlending; // wet-film specular adds on top of asphalt
  reflMat.depthWrite = false;
  reflMat.fog = true; // let renderer feed fogColor/fogDensity
  reflector.renderOrder = 2;
  // Mip chain on the mirror buffer. This is what buys a real roughness
  // response: a damp surface samples a blurred level and smears the sign,
  // standing water samples level ~0 and stays a mirror. Bilinear-filtered
  // mips also remove the residual staircase for free — far cheaper than the
  // dozens of taps an equivalent in-shader blur would need.
  const reflRT = reflector.getRenderTarget();
  reflRT.texture.minFilter = THREE.LinearMipmapLinearFilter;
  reflRT.texture.magFilter = THREE.LinearFilter;
  reflRT.texture.generateMipmaps = true;
  // SwiftShader perf: the mirror is a second full scene render, so it is the
  // single most expensive thing this module owns. Refresh every 3rd frame —
  // 20 Hz on a rain-broken water surface is indistinguishable, and it buys
  // back the fill the bigger buffer costs. From a bird's-eye camera the road
  // is a sliver, so the buffer drops to quarter area rather than being
  // switched off entirely (switching it off is what left the aerial canyon
  // floor with no ground read at all).
  {
    let frame = 0;
    const innerOBR = reflector.onBeforeRender;
    reflector.onBeforeRender = function (renderer, scene, cam, ...rest) {
      if (frame++ % 3 !== 0) return;
      innerOBR.call(this, renderer, scene, cam, ...rest);
    };
  }
  group.add(reflector);

  // -- wet-floor glint layer (carries the ground read from altitude) --
  const glintMat = new THREE.ShaderMaterial({
    name: 'WetFloorGlint',
    uniforms: THREE.UniformsUtils.clone(WetGlintShader.uniforms),
    vertexShader: WetGlintShader.vertexShader,
    fragmentShader: WetGlintShader.fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  glintMat.uniforms.uMask.value = roughMap;
  glintMat.uniforms.uSpill.value = streetSpill;
  glintMat.uniforms.uGlint.value = glintMap;
  glintMat.uniforms.uNoise.value = noiseTex;
  glintMat.uniforms.uCell.value = cellTex;
  glintMat.uniforms.uStrength.value = 1.25;
  const glintPlane = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, LEN), glintMat);
  glintPlane.rotation.x = -Math.PI / 2;
  glintPlane.position.set(0, 0.048, Z_CENTER);
  glintPlane.renderOrder = 2;
  group.add(glintPlane);

  // NOTE: no PointLights here by design. Every lit patch on the ground is
  // baked — lightMaps on the road/walk, additive decals at the vents, and
  // the kerb sheen strip. Real point lights would multiply the per-pixel
  // cost of every standard material in the scene for no visual gain.

  // -- sidewalks + curbs --
  const walkMat = new THREE.MeshStandardMaterial({
    map: walkMap, roughness: 0.48, metalness: 0.02, bumpMap: walkMap, bumpScale: 0.06,
    lightMap: walkSpill, lightMapIntensity: 2.0,
  });
  // The kerb body is nearly always occluded by its own face and top, so it
  // stays a cheap dark solid; the two surfaces a camera actually sees get
  // real maps. A box with one flat colour is what read as a placeholder
  // wedge from the alley.
  const curbMat = new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.6, metalness: 0.02 });
  const kerbFaceMat = new THREE.MeshStandardMaterial({
    map: kerbFaceMap, bumpMap: kerbFaceMap, bumpScale: 0.045,
    roughness: 0.30, metalness: 0.04,   // low roughness = wet sheen on the nose
  });
  const kerbTopMat = new THREE.MeshStandardMaterial({
    map: kerbTopMap, bumpMap: kerbTopMap, bumpScale: 0.03,
    roughness: 0.26, metalness: 0.03,
  });
  // wet kerb glints: additive strip laid on the kerb top, running to the
  // vanishing point. Reads as a broken neon line — the strongest cheap
  // depth cue in the frame.
  const sheenMat = new THREE.MeshBasicMaterial({
    map: kerbSheen, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  });
  for (const side of [-1, 1]) {
    const walk = new THREE.Mesh(new THREE.BoxGeometry(WALK_W, 0.4, LEN), walkMat);
    walk.position.set(side * (ROAD_HALF + 0.35 + WALK_W / 2), -0.02, Z_CENTER);
    walk.receiveShadow = true;
    group.add(walk);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.44, LEN), curbMat);
    curb.position.set(side * (ROAD_HALF + 0.1), 0, Z_CENTER);
    curb.receiveShadow = true;
    group.add(curb);
    // road-facing face: silt line at the gutter, run-off staining, chipped nose
    const face = new THREE.Mesh(new THREE.PlaneGeometry(LEN, 0.28), kerbFaceMat);
    face.rotation.y = -side * Math.PI / 2;
    face.position.set(side * (ROAD_HALF - 0.16), 0.086, Z_CENTER);
    face.receiveShadow = true;
    group.add(face);
    // top: damp concrete, joints, chipped corners
    const top = new THREE.Mesh(new THREE.PlaneGeometry(0.5, LEN), kerbTopMat);
    top.rotation.x = -Math.PI / 2;
    top.rotation.z = side < 0 ? Math.PI : 0;   // damp edge always faces the road
    top.position.set(side * (ROAD_HALF + 0.1), 0.2215, Z_CENTER);
    top.receiveShadow = true;
    group.add(top);
    const sheen = new THREE.Mesh(new THREE.PlaneGeometry(0.46, LEN), sheenMat);
    sheen.rotation.x = -Math.PI / 2;
    sheen.position.set(side * (ROAD_HALF + 0.1), 0.224, Z_CENTER);
    sheen.renderOrder = 3;
    group.add(sheen);
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
  // low metalness: with no local point lights, a metal manhole is a black
  // hole. Diffuse iron reads its cast waffle against the neon spill.
  instanced(
    new THREE.CylinderGeometry(0.62, 0.62, 0.05, 20),
    new THREE.MeshStandardMaterial({ map: manholeMap, roughness: 0.44, metalness: 0.12 }),
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
  const ventGlow = glowMat(0xff8c3a, 0.55);
  const poolGeo = new THREE.PlaneGeometry(5.2, 3.4);
  for (const [hx, hz] of HERO_GRATES) {
    const pool = new THREE.Mesh(poolGeo, ventGlow);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(hx, 0.07, hz);
    pool.renderOrder = 3;
    group.add(pool);
  }

  // -- clutter clusters on the sidewalks --------------------------------
  // Kerbside, not wall-side: the hot neon spill lands near the kerb, and
  // junk only reads if it is a dark silhouette standing in a lit pool.
  // Bigger pieces than before — sub-metre debris is invisible at these
  // camera distances and was just costing draw calls.
  const crateMats = [];
  const bagMats = [];
  const cardMats = [];
  const drumMats = [];
  const clusterInfo = [];
  for (let c = 0; c < 24; c++) {
    const side = rng() < 0.5 ? -1 : 1;
    const cx = side * (10.0 + rng() * 3.0);
    // weighted toward the near half of the block: that is where every
    // camera is standing, and clutter 200 m out is fog, not silhouette
    const u = rng();
    const cz = 44 - (u * u) * 250;
    clusterInfo.push([cx, cz]);
    const n = 2 + Math.floor(rng() * 4);
    let stack = 0.18;
    for (let i = 0; i < n; i++) {
      const x = cx + (rng() - 0.5) * 2.2;
      const z = cz + (rng() - 0.5) * 3.0;
      const kind = rng();
      if (kind < 0.32) {
        // crates stack — a 1.5 m tower reads, a lone 0.5 m box does not
        const s = 0.62 + rng() * 0.55;
        crateMats.push(M(x, stack + s / 2, z, rng() * Math.PI, s, s, s, 0, (rng() - 0.5) * 0.06));
        stack = rng() < 0.55 ? stack + s * 0.98 : 0.18;
      } else if (kind < 0.66) {
        const s = 0.72 + rng() * 0.8;
        bagMats.push(M(x, 0.18 + 0.32 * s, z, rng() * Math.PI, s, s * 0.66, s * (0.8 + rng() * 0.4)));
      } else if (kind < 0.86) {
        const s = 0.9 + rng() * 0.35;
        drumMats.push(M(x, 0.18 + 0.5 * s, z, rng() * Math.PI, 1, s, 1, 0, (rng() - 0.5) * 0.05));
      } else {
        cardMats.push(M(x, 0.21, z, rng() * Math.PI, 1.0 + rng() * 0.7, 1, 0.8 + rng() * 0.5, (rng() - 0.5) * 0.1));
      }
    }
  }
  instanced(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ map: woodMap, roughness: 0.8, metalness: 0.0 }),
    crateMats
  );
  instanced(
    new THREE.IcosahedronGeometry(0.5, 1),
    // wet plastic: low roughness so the hemisphere sky puts a sheen on the
    // top of every sack — the rim that separates junk from pavement
    new THREE.MeshStandardMaterial({ color: 0x232936, roughness: 0.22, metalness: 0.08 }),
    bagMats
  );
  instanced(
    new THREE.CylinderGeometry(0.31, 0.31, 1, 12),
    new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.3, metalness: 0.25 }),
    drumMats
  );
  instanced(
    new THREE.BoxGeometry(1, 0.07, 1),
    new THREE.MeshStandardMaterial({ color: 0x3d3422, roughness: 0.95, metalness: 0.0 }),
    cardMats
  );

  // sign-spill pools under every cluster: tighter and hotter than before so
  // the junk sits in a small island of light instead of a wide soft wash
  const decalCols = [0xff4090, 0x2ec8f0, 0xff8c32, 0xbe46ff];
  const decalGeo = new THREE.PlaneGeometry(3.6, 2.9);
  const decalMats = decalCols.map((c) => glowMat(c, 0.55));
  clusterInfo.forEach(([cx, cz], i) => {
    const d = new THREE.Mesh(decalGeo, decalMats[i % 4]);
    d.rotation.x = -Math.PI / 2;
    d.position.set(cx, 0.19, cz);
    d.renderOrder = 3;
    group.add(d);
  });

  // Bird's-eye cameras get a quarter-area mirror: the road is a sliver up
  // there and the reflection is Fresnel-suppressed anyway, so the pixels are
  // better spent on the glint layer. Latched on a boolean so a moving camera
  // cannot thrash the allocation.
  let hiRes = true;
  return {
    group,
    update(t) {
      reflMat.uniforms.uTime.value = t;
      glintMat.uniforms.uTime.value = t;
      if (camera) {
        const wantHi = camera.position.y < 40;
        if (wantHi !== hiRes) {
          hiRes = wantHi;
          const w = hiRes ? RW : Math.round(RW / 2);
          const h = hiRes ? RH : Math.round(RH / 2);
          reflRT.setSize(w, h);
          reflMat.uniforms.uTexel.value.set(1 / w, 1 / h);
          reflMat.uniforms.uMaxLod.value = hiRes ? 3.1 : 2.2;
        }
      }
    },
  };
}
