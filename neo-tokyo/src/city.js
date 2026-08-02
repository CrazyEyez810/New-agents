import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Megastructure city block. Owned by the ARCHITECTURE agent.
//
// Layout: the street corridor runs along z with walls at x = ±10.
// Front rows of podium towers flank the street, second rows of taller
// towers behind them, hero spires and near ziggurats sit in the 90-130u
// haze band (FogExp2 0.0125 kills anything past ~150u, so landmarks live
// inside that), and an instanced wall of distant towers fills the deep
// planes for the free-orbit view. All geometry merged/instanced.

export function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Shared shader patch: world-space vertical contact AO, a warm neon up-light
// gradient in the lowest ~15m (streets glow up onto the concrete), and a
// faint cool grazing sheen so wet concrete / unlit glass reads as material
// instead of void. Textures tile vertically, so this must be world-space.
// ---------------------------------------------------------------------------
function cityShader(mat, upK = 1.0, sheenK = 1.0) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uUpK = { value: upK };
    s.uniforms.uSheenK = { value: sheenK };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCityW;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>
        { vec4 cw = vec4( position, 1.0 );
          #ifdef USE_INSTANCING
            cw = instanceMatrix * cw;
          #endif
          vCityW = ( modelMatrix * cw ).xyz; }`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vCityW;
        uniform float uUpK;
        uniform float uSheenK;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float wy = max( vCityW.y, 0.0 );
          // Vertical contact AO: streets and podium roots sit in shadow.
          diffuseColor.rgb *= 0.72 + 0.28 * smoothstep( 0.0, 26.0, wy );
          // Warm neon up-light: strongest along the street corridor.
          float street = 0.4 + 0.6 * ( 1.0 - smoothstep( 20.0, 70.0, abs( vCityW.x ) ) );
          float g = exp( -wy / 6.0 ) * street * uUpK;
          vec3 upCol = mix( vec3( 1.0, 0.40, 0.13 ), vec3( 0.85, 0.22, 0.50 ),
                            0.5 + 0.5 * sin( vCityW.z * 0.11 + vCityW.x * 0.07 ) );
          totalEmissiveRadiance += upCol * g * 0.5;
          // Cool grazing sheen (wet surfaces catching skyglow).
          vec3 vDir = normalize( vViewPosition );
          float fres = pow( 1.0 - clamp( dot( normal, vDir ), 0.0, 1.0 ), 3.0 );
          totalEmissiveRadiance += vec3( 0.30, 0.45, 0.70 ) * fres * 0.055 * uSheenK;
        }`);
  };
}

// ---------------------------------------------------------------------------
// Facade texture: world-space tiling. One tile = TEX_W x TEX_H world units.
// The bottom BLANK rows are a windowless "mechanical band" — roofs and box
// tops are UV-mapped into it.
// Window lighting is clustered by whole floors: a floor is either awake
// (a contiguous lit run with 2-tone interiors) or asleep (near-black), for
// an overall 10-20% duty cycle.
// ---------------------------------------------------------------------------
const TEX_W = 24; // world units per horizontal tile (12 window columns @ 2u)
const TEX_H = 64; // world units per vertical tile (20 floors @ 3.2u)

function rgba(c, a) {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}

// 2-tone interior: gradient room glow, ceiling fixture, accent wall,
// furniture / figure occluders, curtains, blinds.
function drawRoom(e, wx, wy, ww, wh, warm, rng) {
  const b = 0.35 + rng() * 0.6;
  const main = warm
    ? [255, 158 + rng() * 40, 66 + rng() * 40]
    : [150 + rng() * 40, 196 + rng() * 30, 255];
  const g = e.createLinearGradient(0, wy, 0, wy + wh);
  g.addColorStop(0, rgba(main, Math.min(1, b)));
  g.addColorStop(1, rgba(main, b * 0.38));
  e.fillStyle = g;
  e.fillRect(wx, wy, ww, wh);
  // Ceiling fixture strip.
  e.fillStyle = `rgba(255,255,255,${(0.35 * b).toFixed(3)})`;
  e.fillRect(wx + 4, wy + 2, ww - 8, 4);
  // Accent wall / TV glow in the opposite temperature (the 2nd tone).
  if (rng() < 0.55) {
    const acc = warm ? [120 + rng() * 60, 190, 255] : [255, 180, 110];
    e.fillStyle = rgba(acc, b * 0.5);
    e.fillRect(wx + (rng() < 0.5 ? 2 : ww * 0.58), wy + wh * 0.25, ww * 0.36, wh * 0.5);
  }
  // Furniture occluders along the lower half.
  e.fillStyle = 'rgba(0,0,0,0.6)';
  for (let i = 0, n = 1 + ((rng() * 3) | 0); i < n; i++) {
    e.fillRect(wx + rng() * (ww - 14), wy + wh * (0.5 + rng() * 0.32), 8 + rng() * 14, wh * (0.15 + rng() * 0.3));
  }
  // Occasional standing figure.
  if (rng() < 0.1) {
    e.fillStyle = 'rgba(0,0,0,0.78)';
    const fx = wx + 6 + rng() * (ww - 18);
    e.fillRect(fx, wy + wh * 0.36, 7, wh * 0.5);
    e.fillRect(fx + 1.5, wy + wh * 0.27, 4, 7);
  }
  // Curtains.
  if (rng() < 0.22) {
    e.fillStyle = warm ? 'rgba(60,30,16,0.75)' : 'rgba(20,30,50,0.75)';
    e.fillRect(wx, wy, ww * (0.2 + rng() * 0.25), wh);
    e.fillRect(wx + ww * (0.75 - rng() * 0.2), wy, ww * 0.3, wh);
  }
  // Blinds.
  if (rng() < 0.15) {
    e.fillStyle = 'rgba(0,0,0,0.45)';
    for (let yy = wy; yy < wy + wh * 0.6; yy += 6) e.fillRect(wx, yy, ww, 2.5);
  }
}

function makeFacadeTexture(rng, opts = {}) {
  const W = 768, H = 2048, BLANK = 48;
  const cols = 12, floors = 20;
  const cw = W / cols, fh = (H - BLANK) / floors;
  const floorLitP = (opts.litBase ?? 0.13) * 1.7;

  const albedo = document.createElement('canvas');
  albedo.width = W; albedo.height = H;
  const a = albedo.getContext('2d');
  const emis = document.createElement('canvas');
  emis.width = W; emis.height = H;
  const e = emis.getContext('2d');

  // Base concrete: dark desaturated blue, but with enough albedo (~9-12%
  // lightness) to actually catch the hemisphere light.
  const hue = 210 + rng() * 25;
  const sat = 6 + rng() * 8;
  const li = 8.5 + rng() * 3.2;
  a.fillStyle = `hsl(${hue},${sat}%,${li}%)`;
  a.fillRect(0, 0, W, H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);

  // Panel noise.
  for (let i = 0; i < 2000; i++) {
    const v = rng();
    a.fillStyle = v < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(165,185,215,0.045)';
    a.fillRect(rng() * W, rng() * H, 3 + rng() * 14, 3 + rng() * 14);
  }
  // Panel seams.
  a.fillStyle = 'rgba(0,0,0,0.4)';
  for (let c = 0; c <= cols; c++) a.fillRect(c * cw - 1.5, 0, 3, H);
  for (let f = 0; f <= floors; f++) a.fillRect(0, f * fh - 1.5, W, 3);
  // Spandrel band per floor (lighter sill line that catches sky light).
  a.fillStyle = 'rgba(150,170,200,0.09)';
  for (let f = 0; f < floors; f++) a.fillRect(0, f * fh + fh - 14, W, 6);

  // Windows, clustered by floor.
  for (let f = 0; f < floors; f++) {
    const lit = new Array(cols).fill(false);
    const floorWarm = rng() < 0.6;
    if (rng() < floorLitP) {
      // Awake floor: one or two contiguous runs.
      const len = 3 + ((rng() * cols * 0.7) | 0);
      const start = (rng() * cols) | 0;
      for (let k = 0; k < len; k++) if (rng() < 0.88) lit[(start + k) % cols] = true;
      if (rng() < 0.35) {
        const l2 = 2 + ((rng() * 3) | 0), s2 = (rng() * cols) | 0;
        for (let k = 0; k < l2; k++) lit[(s2 + k) % cols] = true;
      }
    } else if (rng() < 0.12) {
      lit[(rng() * cols) | 0] = true; // lone insomniac
    }
    for (let c = 0; c < cols; c++) {
      const wx = c * cw + 9, wy = f * fh + 18;
      const ww = cw - 18, wh = fh - 36;
      // Unlit glass albedo: a shade lighter than concrete, blue.
      const gl = 13 + rng() * 6;
      a.fillStyle = `rgb(${gl | 0},${(gl + 4) | 0},${(gl + 11) | 0})`;
      a.fillRect(wx, wy, ww, wh);
      // Sheen gradient on unlit glass: sky reflection brighter at the top.
      const sv = 0.7 + rng() * 0.45;
      const sg = e.createLinearGradient(0, wy, 0, wy + wh);
      sg.addColorStop(0, rgba([26 * sv, 32 * sv, 46 * sv], 1));
      sg.addColorStop(1, rgba([9 * sv, 11 * sv, 16 * sv], 1));
      e.fillStyle = sg;
      e.fillRect(wx, wy, ww, wh);
      if (lit[c]) {
        const warm = rng() < 0.15 ? !floorWarm : floorWarm;
        drawRoom(e, wx, wy, ww, wh, warm, rng);
      }
      // Mullion + transom over everything.
      a.fillStyle = 'rgba(0,0,0,0.5)';
      a.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
      a.fillRect(wx, wy + wh * 0.68, ww, 3);
      e.fillStyle = 'rgba(0,0,0,0.55)';
      e.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
      e.fillRect(wx, wy + wh * 0.68, ww, 3);
    }
  }

  // Grime streaks (over windows; also dim emissive under them).
  for (let i = 0; i < 46; i++) {
    const x = rng() * W, w = 3 + rng() * 16;
    const y0 = rng() * H * 0.7, len = H * (0.15 + rng() * 0.5);
    const grd = a.createLinearGradient(0, y0, 0, y0 + len);
    const al = 0.1 + rng() * 0.16;
    grd.addColorStop(0, `rgba(4,5,7,${al})`);
    grd.addColorStop(1, 'rgba(4,5,7,0)');
    a.fillStyle = grd;
    a.fillRect(x, y0, w, len);
    e.fillStyle = `rgba(0,0,0,${al * 0.7})`;
    e.fillRect(x, y0, w, len);
  }
  // Occasional rust drip.
  for (let i = 0; i < 10; i++) {
    const x = rng() * W;
    a.fillStyle = `rgba(80,52,28,${0.07 + rng() * 0.08})`;
    a.fillRect(x, rng() * H * 0.6, 2 + rng() * 5, 80 + rng() * 320);
  }

  // Mechanical band (bottom strip): plain dark concrete + vent slits.
  a.fillStyle = `hsl(${hue},${sat * 0.6}%,${li * 0.8}%)`;
  a.fillRect(0, H - BLANK, W, BLANK);
  a.fillStyle = 'rgba(0,0,0,0.4)';
  for (let x = 16; x < W; x += 32) a.fillRect(x, H - BLANK + 16, 16, 6);
  e.fillStyle = '#000';
  e.fillRect(0, H - BLANK, W, BLANK);

  return { map: canvasTex(albedo), emissiveMap: canvasTex(emis) };
}

// Podium texture: double-height lobby glass, most bays lit — shopfronts and
// lobbies are what the street cameras stand next to. One tile spans
// POD_W x POD_H world units. Bottom strip = blank for tops.
const POD_W = 24, POD_H = 12;
function makePodiumTexture(rng) {
  const W = 1024, H = 512, BLANK = 40;
  const albedo = document.createElement('canvas');
  albedo.width = W; albedo.height = H;
  const a = albedo.getContext('2d');
  const emis = document.createElement('canvas');
  emis.width = W; emis.height = H;
  const e = emis.getContext('2d');
  a.fillStyle = 'hsl(216,9%,9%)';
  a.fillRect(0, 0, W, H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  // Concrete texture noise.
  for (let i = 0; i < 500; i++) {
    a.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(170,190,215,0.05)';
    a.fillRect(rng() * W, rng() * H, 4 + rng() * 16, 4 + rng() * 16);
  }
  const cols = 10, cw = W / cols;
  for (let c = 0; c < cols; c++) {
    const wx = c * cw + 12, ww = cw - 24;
    const wy = 52, wh = H - BLANK - 120;
    a.fillStyle = 'rgb(15,19,28)';
    a.fillRect(wx, wy, ww, wh);
    // Base sheen so even dark bays read as glass.
    const sg = e.createLinearGradient(0, wy, 0, wy + wh);
    sg.addColorStop(0, 'rgb(24,30,42)');
    sg.addColorStop(1, 'rgb(10,12,17)');
    e.fillStyle = sg;
    e.fillRect(wx, wy, ww, wh);
    a.fillStyle = 'rgba(0,0,0,0.55)';
    a.fillRect(wx - 5, 0, 7, H - BLANK); // pier
    if (rng() < 0.55) {
      // Lit lobby / shopfront: glow strongest at counter height.
      const warm = rng() < 0.55;
      const b = 0.35 + rng() * 0.5;
      const col = warm ? [255, 178, 96] : [150, 205, 255];
      const grd = e.createLinearGradient(0, wy + wh, 0, wy);
      grd.addColorStop(0, rgba(col.map((v) => v * b), 1));
      grd.addColorStop(1, rgba(col.map((v) => v * b), 0.18));
      e.fillStyle = grd;
      e.fillRect(wx + 3, wy, ww - 6, wh);
      // Interior clutter: shelving lines + silhouettes.
      e.fillStyle = 'rgba(0,0,0,0.5)';
      for (let i = 0, n = 2 + ((rng() * 3) | 0); i < n; i++) {
        e.fillRect(wx + 6 + rng() * (ww - 30), wy + wh * (0.35 + rng() * 0.45), 12 + rng() * 24, 6 + rng() * 14);
      }
      if (rng() < 0.4) {
        const fx = wx + 10 + rng() * (ww - 34);
        e.fillStyle = 'rgba(0,0,0,0.8)';
        e.fillRect(fx, wy + wh * 0.45, 12, wh * 0.42);
        e.fillRect(fx + 3, wy + wh * 0.38, 7, 12);
      }
      // Ceiling tubes.
      e.fillStyle = `rgba(255,255,255,${0.4 * b})`;
      e.fillRect(wx + 8, wy + 6, ww - 16, 5);
    }
  }
  // Shutter / service doors between glass bays.
  for (let i = 0; i < 5; i++) {
    const x = rng() * (W - 80);
    a.fillStyle = 'rgb(20,22,26)';
    a.fillRect(x, H - BLANK - 140, 68, 140);
    a.fillStyle = 'rgba(0,0,0,0.5)';
    for (let y = 0; y < 140; y += 12) a.fillRect(x, H - BLANK - 140 + y, 68, 4);
    // Dim caged lamp above some shutters.
    if (rng() < 0.5) {
      e.fillStyle = 'rgba(210,150,70,0.8)';
      e.fillRect(x + 26, H - BLANK - 152, 16, 6);
    }
  }
  // Grime.
  for (let i = 0; i < 30; i++) {
    a.fillStyle = `rgba(3,4,6,${0.1 + rng() * 0.18})`;
    a.fillRect(rng() * W, 0, 3 + rng() * 14, H * (0.3 + rng() * 0.7));
  }
  a.fillStyle = 'hsl(216,6%,7%)';
  a.fillRect(0, H - BLANK, W, BLANK);
  e.fillStyle = '#000';
  e.fillRect(0, H - BLANK, W, BLANK);
  return { map: canvasTex(albedo), emissiveMap: canvasTex(emis) };
}

// Distant-tower texture: dense tiny window grid, floor-clustered, mapped
// 0..1 per building.
function makeDistantTexture(rng) {
  const W = 256, H = 512, BLANK = 10;
  const albedo = document.createElement('canvas');
  albedo.width = W; albedo.height = H;
  const a = albedo.getContext('2d');
  const emis = document.createElement('canvas');
  emis.width = W; emis.height = H;
  const e = emis.getContext('2d');
  a.fillStyle = 'hsl(216,8%,9%)';
  a.fillRect(0, 0, W, H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  const cols = 22, floors = 46;
  const cw = W / cols, fh = (H - BLANK) / floors;
  for (let f = 0; f < floors; f++) {
    const lit = new Array(cols).fill(false);
    const warm = rng() < 0.55;
    if (rng() < 0.2) {
      const len = 4 + ((rng() * cols * 0.6) | 0), start = (rng() * cols) | 0;
      for (let k = 0; k < len; k++) if (rng() < 0.85) lit[(start + k) % cols] = true;
    } else if (rng() < 0.1) lit[(rng() * cols) | 0] = true;
    for (let c = 0; c < cols; c++) {
      a.fillStyle = 'rgb(13,16,22)';
      a.fillRect(c * cw + 2, f * fh + 3, cw - 4, fh - 6);
      e.fillStyle = 'rgb(9,11,16)';
      e.fillRect(c * cw + 2, f * fh + 3, cw - 4, fh - 6);
      if (lit[c]) {
        const b = 0.25 + rng() * 0.55;
        e.fillStyle = warm
          ? `rgb(${255 * b | 0},${165 * b | 0},${85 * b | 0})`
          : `rgb(${140 * b | 0},${195 * b | 0},${255 * b | 0})`;
        e.fillRect(c * cw + 2, f * fh + 3, cw - 4, fh - 6);
      }
    }
  }
  for (let i = 0; i < 20; i++) {
    a.fillStyle = `rgba(3,4,6,${0.12 + rng() * 0.15})`;
    a.fillRect(rng() * W, 0, 3 + rng() * 10, H);
  }
  a.fillStyle = 'hsl(216,5%,7%)';
  a.fillRect(0, H - BLANK, W, BLANK);
  e.fillStyle = '#000';
  e.fillRect(0, H - BLANK, W, BLANK);
  return { map: canvasTex(albedo), emissiveMap: canvasTex(emis) };
}

// Megastructure texture: very sparse dim habitation dots on colossal dark
// mass — enough emissive speckle to punch a silhouette through the haze.
const MEGA_W = 44, MEGA_H = 88;
function makeMegaTexture(rng) {
  const W = 256, H = 512, BLANK = 12;
  const albedo = document.createElement('canvas');
  albedo.width = W; albedo.height = H;
  const a = albedo.getContext('2d');
  const emis = document.createElement('canvas');
  emis.width = W; emis.height = H;
  const e = emis.getContext('2d');
  a.fillStyle = 'hsl(214,10%,10%)';
  a.fillRect(0, 0, W, H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  for (let i = 0; i < 300; i++) {
    a.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(160,180,210,0.05)';
    a.fillRect(rng() * W, rng() * H, 4 + rng() * 20, 4 + rng() * 20);
  }
  // Faint vertical service-shaft lines.
  a.fillStyle = 'rgba(0,0,0,0.3)';
  for (let x = 0; x < W; x += 20 + rng() * 26) a.fillRect(x, 0, 3, H);
  const cols = 20, floors = 42;
  const cw = W / cols, fh = (H - BLANK) / floors;
  for (let f = 0; f < floors; f++) {
    if (rng() > 0.3) continue;
    const len = 2 + ((rng() * 8) | 0), start = (rng() * cols) | 0;
    const warm = rng() < 0.7;
    for (let k = 0; k < len; k++) {
      if (rng() < 0.3) continue;
      const c = (start + k) % cols;
      const b = 0.3 + rng() * 0.5;
      e.fillStyle = warm
        ? `rgb(${255 * b | 0},${170 * b | 0},${90 * b | 0})`
        : `rgb(${145 * b | 0},${200 * b | 0},${255 * b | 0})`;
      e.fillRect(c * cw + 3, f * fh + 3, cw - 6, fh - 6);
    }
  }
  a.fillStyle = 'hsl(214,7%,8%)';
  a.fillRect(0, H - BLANK, W, BLANK);
  e.fillStyle = '#000';
  e.fillRect(0, H - BLANK, W, BLANK);
  return { map: canvasTex(albedo), emissiveMap: canvasTex(emis) };
}

function canvasTex(cv) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 1;
  return t;
}

// ---------------------------------------------------------------------------
// UV helpers: map box side faces in world units, tops into the blank strip.
// BoxGeometry face order: +x(0-3), -x(4-7), +y(8-11), -y(12-15), +z(16-19), -z(20-23).
// ---------------------------------------------------------------------------
function facadeBox(w, h, d, cx, cy, cz, uo, texW = TEX_W, texH = TEX_H) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const y0 = cy - h / 2;
  for (let i = 0; i < 24; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    const face = (i / 4) | 0;
    if (face === 2 || face === 3) {
      // top/bottom → blank strip
      uv.setXY(i, 0.01 + u * 0.03, 0.004 + v * 0.012);
    } else {
      const su = (face < 2 ? d : w) / texW;
      uv.setXY(i, uo + u * su, y0 / texH + (v * h) / texH);
    }
  }
  g.translate(cx, cy, cz);
  return g;
}

function plainBox(w, h, d, cx, cy, cz) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
  return g;
}

function cyl(rT, rB, h, cx, cy, cz, seg = 8) {
  const g = new THREE.CylinderGeometry(rT, rB, h, seg);
  g.translate(cx, cy, cz);
  return g;
}

// ---------------------------------------------------------------------------
// City builder
// ---------------------------------------------------------------------------
export function buildCity() {
  const group = new THREE.Group();
  const rng = mulberry32(1337);

  // ---- Materials --------------------------------------------------------
  const N_VARIANTS = 6;
  const facadeMats = [];
  for (let i = 0; i < N_VARIANTS; i++) {
    const { map, emissiveMap } = makeFacadeTexture(rng, { litBase: 0.1 + rng() * 0.12 });
    const m = new THREE.MeshStandardMaterial({
      map, emissiveMap,
      emissive: 0xffffff, emissiveIntensity: 1.35,
      roughness: 0.55 + rng() * 0.2, metalness: 0.18,
    });
    cityShader(m, 1.0, 1.0);
    facadeMats.push(m);
  }
  const podTex = makePodiumTexture(rng);
  const podiumMat = new THREE.MeshStandardMaterial({
    map: podTex.map, emissiveMap: podTex.emissiveMap,
    emissive: 0xffffff, emissiveIntensity: 1.25,
    roughness: 0.45, metalness: 0.22,
  });
  cityShader(podiumMat, 1.15, 1.1);
  const concreteMat = new THREE.MeshStandardMaterial({
    color: 0x1c212a, roughness: 0.85, metalness: 0.15,
  });
  cityShader(concreteMat, 0.95, 1.5);
  const megaTex = makeMegaTexture(rng);
  const megaMat = new THREE.MeshStandardMaterial({
    map: megaTex.map, emissiveMap: megaTex.emissiveMap,
    emissive: 0xffffff, emissiveIntensity: 1.2,
    roughness: 0.9, metalness: 0.1,
  });
  cityShader(megaMat, 0.45, 0.7);

  // Geometry bins.
  const facadeGeo = facadeMats.map(() => []);
  const podiumGeo = [];
  const concreteGeo = [];
  const megaGeo = [];
  const beacons = [];
  const roofLights = [];
  const megaDots = []; // habitation strips on megastructure tier edges

  // ---- Rooftop clutter --------------------------------------------------
  function rooftop(cx, topY, w, d, h, hero) {
    const rw = w - 2, rd = d - 2;
    const rx = () => cx.x + (rng() - 0.5) * rw * 0.7;
    const rz = () => cx.z + (rng() - 0.5) * rd * 0.7;
    // Parapet.
    const pt = 0.45, ph = 1.1 + rng() * 0.5;
    concreteGeo.push(
      plainBox(w, ph, pt, cx.x, topY + ph / 2, cx.z - d / 2 + pt / 2),
      plainBox(w, ph, pt, cx.x, topY + ph / 2, cx.z + d / 2 - pt / 2),
      plainBox(pt, ph, d, cx.x - w / 2 + pt / 2, topY + ph / 2, cx.z),
      plainBox(pt, ph, d, cx.x + w / 2 - pt / 2, topY + ph / 2, cx.z),
    );
    // Penthouse / stair head.
    if (w > 8 && rng() < 0.8) {
      const sw = 2.5 + rng() * 3, sh = 2.2 + rng() * 1.6;
      const sx = rx(), sz = rz();
      concreteGeo.push(plainBox(sw, sh, sw * 0.8, sx, topY + sh / 2, sz));
      // Doorway service light beside the stair head.
      if (rng() < 0.65) roofLights.push(new THREE.Vector3(sx + sw / 2 + 0.3, topY + 1.1, sz));
    }
    // Stray roof-level work lights.
    if (rng() < 0.35) roofLights.push(new THREE.Vector3(rx(), topY + 0.5, rz()));
    // Water tank.
    if (w > 7 && rng() < 0.75) {
      const r = 1.1 + rng() * 1.1, th = 2.4 + rng() * 1.6;
      const tx = rx(), tz = rz();
      concreteGeo.push(
        cyl(r, r, th, tx, topY + th / 2 + 0.8, tz, 10),
        cyl(r * 1.02, r * 1.02, 0.3, tx, topY + th + 0.9, tz, 10),
        plainBox(r * 1.6, 0.8, r * 1.6, tx, topY + 0.4, tz),
      );
    }
    // AC units.
    const nAC = 1 + (rng() * 4) | 0;
    for (let i = 0; i < nAC; i++) {
      const s = 1.2 + rng() * 1.6;
      concreteGeo.push(plainBox(s, s * 0.7, s * 0.8, rx(), topY + s * 0.35, rz()));
    }
    // Vents.
    for (let i = 0, n = 1 + (rng() * 3) | 0; i < n; i++) {
      concreteGeo.push(cyl(0.35, 0.45, 1.1 + rng(), rx(), topY + 0.7, rz(), 6));
    }
    // Roof pipe run.
    if (w > 9 && rng() < 0.6) {
      concreteGeo.push(plainBox(0.3, 0.3, rd * 0.75, cx.x + (rng() - 0.5) * rw * 0.5, topY + 0.35, cx.z));
    }
    // Antenna masts.
    const nMast = hero ? 1 : 1 + (rng() * 2.4) | 0;
    for (let i = 0; i < nMast; i++) {
      const mh = hero ? 22 + rng() * 8 : 3.5 + rng() * (h > 80 ? 13 : 7);
      const mr = hero ? 0.7 : 0.12 + rng() * 0.1;
      const mx = hero ? cx.x : rx(), mz = hero ? cx.z : rz();
      concreteGeo.push(cyl(hero ? 0.08 : mr * 0.6, mr, mh, mx, topY + mh / 2, mz, 6));
      // Crossbars.
      const nBar = hero ? 3 : rng() < 0.5 ? 1 : 0;
      for (let b = 0; b < nBar; b++) {
        const by = topY + mh * (0.45 + 0.2 * b + rng() * 0.08);
        concreteGeo.push(plainBox(hero ? 3.2 - b * 0.8 : 1.6, 0.12, 0.12, mx, by, mz));
      }
      if (hero || (h > 100 && i === 0) || (h > 60 && rng() < 0.25)) {
        beacons.push(new THREE.Vector3(mx, topY + mh + 0.3, mz));
      }
    }
  }

  // ---- Facade relief ----------------------------------------------------
  function relief(v, cx, cy0, h, w, d) {
    // Pilasters on ±x and ±z faces.
    const pil = (face) => {
      const span = face < 2 ? d : w;
      if (span < 10) return;
      const n = Math.max(2, Math.round(span / 5.5));
      for (let i = 0; i <= n; i++) {
        const off = -span / 2 + (i / n) * span;
        const px = face === 0 ? cx.x + w / 2 : face === 1 ? cx.x - w / 2 : cx.x + off;
        const pz = face < 2 ? cx.z + off : face === 2 ? cx.z + d / 2 : cx.z - d / 2;
        concreteGeo.push(plainBox(
          face < 2 ? 0.5 : 0.7, h, face < 2 ? 0.7 : 0.5,
          px, cy0 + h / 2, pz,
        ));
      }
    };
    if (rng() < 0.7) { pil(0); pil(1); }
    if (rng() < 0.7) { pil(2); pil(3); }
    // Ledge band courses.
    const step = 12 + rng() * 8;
    for (let y = cy0 + step; y < cy0 + h - 4; y += step) {
      concreteGeo.push(plainBox(w + 0.7, 0.5, d + 0.7, cx.x, y, cx.z));
    }
    // Balconies on one z face for some towers.
    if (rng() < 0.35 && w > 8) {
      const face = rng() < 0.5 ? 1 : -1;
      const zf = cx.z + face * (d / 2);
      const nc = Math.min(4, Math.floor(w / 4));
      for (let y = cy0 + 6; y < cy0 + h - 5; y += 6.4) {
        for (let c = 0; c < nc; c++) {
          if (rng() < 0.4) continue;
          const bx = cx.x - w / 2 + (c + 0.5) * (w / nc);
          concreteGeo.push(plainBox(2.4, 0.3, 1.0, bx, y, zf + face * 0.5));
          concreteGeo.push(plainBox(2.4, 0.9, 0.1, bx, y + 0.55, zf + face * 1.0));
        }
      }
    }
  }

  // ---- Tower ------------------------------------------------------------
  function tower(spec) {
    const { cx, cz, wx, wz, h } = spec;
    const v = spec.variant ?? ((rng() * N_VARIANTS) | 0);
    const uo = rng();
    const hero = !!spec.hero;
    const nTiers = spec.tiers ?? (h > 120 ? 3 : h > 55 ? (rng() < 0.6 ? 2 : 1) : 1);
    let w = wx, d = wz, y = 0;
    const center = { x: cx, z: cz };
    for (let tIdx = 0; tIdx < nTiers; tIdx++) {
      const frac = tIdx === nTiers - 1 ? 1 : 0.45 + rng() * 0.25;
      const th = tIdx === nTiers - 1 ? h - y : Math.max(10, (h - y) * frac);
      facadeGeo[v].push(facadeBox(w, th, d, center.x, y + th / 2, center.z, uo));
      if (tIdx === 0) relief(v, center, y + 1, Math.min(th, h) - 1, w, d);
      const topY = y + th;
      if (tIdx < nTiers - 1) {
        // Setback ledge + partial clutter on the terrace.
        concreteGeo.push(plainBox(w + 0.6, 0.7, d + 0.6, center.x, topY + 0.1, center.z));
        const nw = w * (0.55 + rng() * 0.25), nd = d * (0.55 + rng() * 0.25);
        // Shift the upper tier toward one edge sometimes.
        if (rng() < 0.6) {
          center.x += (rng() - 0.5) * (w - nw) * 0.8;
          center.z += (rng() - 0.5) * (d - nd) * 0.8;
        }
        // Terrace parapet on the exposed part.
        concreteGeo.push(
          plainBox(w, 1.0, 0.4, cx, topY + 0.5, cz - d / 2 + 0.2),
          plainBox(w, 1.0, 0.4, cx, topY + 0.5, cz + d / 2 - 0.2),
        );
        if (rng() < 0.5) {
          const s = 1 + rng() * 1.4;
          concreteGeo.push(plainBox(s, s * 0.6, s, cx + (rng() - 0.5) * w * 0.6, topY + s * 0.3, cz + (rng() - 0.5) * d * 0.6));
        }
        w = nw; d = nd; y = topY;
      } else {
        rooftop(center, topY, w, d, h, hero);
      }
    }
    // Podium.
    if (spec.podium) {
      const { faceX, side } = spec.podium; // side: +1 east block, -1 west block
      const ph = 6.5 + rng() * 4.5;
      const backX = cx - side * (wx / 2 + 0.5 + rng() * 2);
      const pw = Math.abs(faceX - backX);
      const pcx = (faceX + backX) / 2;
      const pd = wz + 2 + rng() * 5;
      podiumGeo.push(facadeBox(pw, ph, pd, pcx, ph / 2, cz, rng(), POD_W, POD_H));
      // Podium parapet + roof clutter.
      concreteGeo.push(plainBox(pw + 0.5, 0.9, pd + 0.5, pcx, ph + 0.35, cz));
      if (rng() < 0.7) {
        const s = 1.2 + rng() * 1.5;
        concreteGeo.push(plainBox(s, s * 0.6, s * 0.9, pcx + (rng() - 0.5) * pw * 0.5, ph + 0.9 + s * 0.3, cz + (rng() - 0.5) * pd * 0.5));
      }
      // Canopy over sidewalk.
      if (rng() < 0.5) {
        concreteGeo.push(plainBox(1.6, 0.25, Math.min(pd * 0.6, 10), faceX + (side > 0 ? -0.8 : 0.8), 4.2, cz));
      }
    }
    return spec;
  }

  // ---- Phase A: generate specs ------------------------------------------
  const westRow = [], eastRow = [];
  function frontRow(side, list) {
    // side = -1 (west, face at x≈-10) or +1 (east, face at x≈+10)
    let z = 42;
    let prevH = 0;
    while (z > -114) {
      const wz = 12 + rng() * 13;
      const czC = z - wz / 2;
      // East alley gap: skip z ∈ [-40, -52].
      if (side > 0 && czC + wz / 2 > -53 && czC - wz / 2 < -39) {
        if (z > -40) { z = -52.5; continue; }
      }
      const wx = 13 + rng() * 9;
      const recess = 1 + rng() * 3.5;
      const faceX = side * (9.8 + rng() * 0.7);
      const cx = faceX + side * (recess + wx / 2);
      let h = rng() < 0.24 ? 85 + rng() * 65 : 26 + rng() * 42;
      if (Math.abs(h - prevH) < 13) h += 24;
      prevH = h;
      list.push({ cx, cz: czC, wx, wz, h, podium: { faceX, side } });
      z -= wz + 1.2 + rng() * 2.8;
    }
  }
  frontRow(-1, westRow);
  frontRow(1, eastRow);

  // Alley flanking towers must be tall (tight slot walls).
  for (const s of eastRow) {
    if (Math.abs(s.cz + 36) < 8 || Math.abs(s.cz + 57) < 8) s.h = Math.max(s.h, 62 + rng() * 25);
  }

  // Second rows: taller, no podium.
  const westBack = [], eastBack = [];
  for (let i = 0; i < 5; i++) {
    westBack.push({
      cx: -34 - rng() * 18, cz: 26 - i * 32 - rng() * 8,
      wx: 16 + rng() * 12, wz: 16 + rng() * 12,
      h: 65 + rng() * 95,
    });
    eastBack.push({
      cx: 33 + rng() * 18, cz: 30 - i * 33 - rng() * 8,
      wx: 16 + rng() * 12, wz: 16 + rng() * 12,
      h: 60 + rng() * 90,
    });
  }
  // Hero towers with spires — placed inside the ~90-130u haze band of the
  // cameras that need a landmark (fog eats anything much past 150u).
  const heroE = { cx: 46, cz: -74, wx: 24, wz: 24, h: 190, hero: true, tiers: 3 };
  const heroW = { cx: -46, cz: -34, wx: 22, wz: 22, h: 172, hero: true, tiers: 3 };

  // End-of-street block (terminates the corridor in fog).
  const endBlock = [
    { cx: 0, cz: -128, wx: 26, wz: 20, h: 120 },
    { cx: -24, cz: -140, wx: 20, wz: 22, h: 88 },
    { cx: 26, cz: -136, wx: 22, wz: 20, h: 145 },
  ];

  // Camera clearance.
  // Canyon cam sits at (-14,22,46): keep its immediate area low.
  // Aerial cam at (-40,78,70) looks toward (10,20,-40): clamp everything in
  // its near-field view wedge so the frame opens onto the mid-field skyline
  // instead of being blocked by two flanking slabs.
  const canyonClear = { x: -14, z: 46, r: 22, maxH: 11 };
  const AER = { x: -40, z: 70 };
  const ADIR = { x: 50 / 121.6, z: -110 / 121.6 };
  const clampSpec = (s) => {
    {
      const dx = s.cx - canyonClear.x, dz = s.cz - canyonClear.z;
      const rr = canyonClear.r + Math.max(s.wx, s.wz) * 0.5;
      if (dx * dx + dz * dz < rr * rr && s.h > canyonClear.maxH) {
        s.h = canyonClear.maxH * (0.6 + rng() * 0.4);
        s.tiers = 1;
        s.hero = false;
      }
    }
    {
      const dx = s.cx - AER.x, dz = s.cz - AER.z;
      const d = Math.max(1e-3, Math.hypot(dx, dz) - Math.max(s.wx, s.wz) * 0.5);
      if (d < 95) {
        const along = dx * ADIR.x + dz * ADIR.z;
        if (along > 0 && along / d > 0.5) {
          const maxH = 12 + 0.38 * d;
          if (s.h > maxH) {
            s.h = maxH * (0.8 + rng() * 0.2);
            s.tiers = 1;
            s.hero = false;
          }
        }
      }
    }
  };

  // Skybridge anchors: force min height on street-flanking towers at z≈-57.
  const findAt = (list, zTarget) =>
    list.find((s) => zTarget > s.cz - s.wz / 2 && zTarget < s.cz + s.wz / 2);
  const bw = findAt(westRow, -57), be = findAt(eastRow, -57);
  if (bw) bw.h = Math.max(bw.h, 58);
  if (be) be.h = Math.max(be.h, 58);
  const b2 = findAt(eastRow, -16);
  if (b2) b2.h = Math.max(b2.h, 42);

  // ---- Phase B: build all towers ----------------------------------------
  const all = [...westRow, ...eastRow, ...westBack, ...eastBack, heroE, heroW, ...endBlock];
  for (const s of all) clampSpec(s);
  for (const s of all) tower(s);

  // Skybridge across the street canyon.
  if (bw && be) {
    const y = 44;
    const x0 = bw.cx + bw.wx / 2, x1 = be.cx - be.wx / 2;
    facadeGeo[0].push(facadeBox(x1 - x0 + 2, 3.2, 4.6, (x0 + x1) / 2, y, -57, rng()));
    concreteGeo.push(plainBox(x1 - x0 + 2, 0.4, 5.0, (x0 + x1) / 2, y + 1.8, -57));
  }
  // Bridge from an east front tower to the east back row.
  if (b2) {
    const back = eastBack.reduce((a, b) => (Math.abs(b.cz - b2.cz) < Math.abs(a.cz - b2.cz) ? b : a));
    const y = Math.min(b2.h, back.h) * 0.62;
    const x0 = b2.cx + b2.wx / 2 - 1, x1 = back.cx;
    facadeGeo[1].push(facadeBox(x1 - x0, 3.0, 4.2, (x0 + x1) / 2, y, (b2.cz + back.cz) / 2, rng()));
  }
  // Alley furniture: overhead connectors, fire-escape racks, wall pipes.
  {
    const flankA = eastRow.reduce((a, b) =>
      Math.abs(b.cz - b.wz / 2 + 40) < Math.abs(a.cz - a.wz / 2 + 40) ? b : a);
    const flankB = eastRow.reduce((a, b) =>
      Math.abs(b.cz + b.wz / 2 + 52.5) < Math.abs(a.cz + a.wz / 2 + 52.5) ? b : a);
    const zA = flankA.cz - flankA.wz / 2; // south face of north flank
    const zB = flankB.cz + flankB.wz / 2; // north face of south flank
    concreteGeo.push(plainBox(4.5, 2.6, Math.abs(zA - zB) + 1, 15, 13, (zA + zB) / 2));
    concreteGeo.push(plainBox(4.0, 2.2, Math.abs(zA - zB) + 1, 22, 24, (zA + zB) / 2));
    // Fire-escape slab stacks on both alley walls.
    for (const [zf, dir, spec] of [[zA, -1, flankA], [zB, 1, flankB]]) {
      const x0 = Math.max(11, spec.cx - spec.wx / 2 + 1);
      for (let yy = 4; yy < Math.min(spec.h - 6, 38); yy += 3.6) {
        for (let k = 0; k < 3; k++) {
          if (rng() < 0.3) continue;
          concreteGeo.push(plainBox(2.6, 0.22, 1.0, x0 + 1.6 + k * 3.4, yy, zf + dir * 0.55));
          concreteGeo.push(plainBox(2.6, 0.8, 0.08, x0 + 1.6 + k * 3.4, yy + 0.5, zf + dir * 1.0));
        }
      }
      // Vertical pipe runs.
      for (let i = 0; i < 4; i++) {
        const ph = 22 + rng() * 26;
        concreteGeo.push(cyl(0.15 + rng() * 0.08, 0.18 + rng() * 0.08, ph, x0 + rng() * 11, ph / 2, zf + dir * 0.35, 6));
      }
    }
    // A couple of dim alley wall lights (caged service lamps).
    roofLights.push(new THREE.Vector3(13.5, 8.5, zA - 0.4), new THREE.Vector3(19, 5.5, zB + 0.4));
  }

  // ---- Megastructures (haze-band silhouettes) ---------------------------
  // dotted=true rings each tier's parapet with warm habitation lights so
  // the stepped silhouette reads through the fog.
  function ziggurat(cx, cz, base, h, tiers, dotted) {
    let w = base, y = 0;
    for (let i = 0; i < tiers; i++) {
      const th = h / tiers;
      megaGeo.push(facadeBox(w, th, w, cx, y + th / 2, cz, rng(), MEGA_W, MEGA_H));
      y += th;
      const nw = w * (0.72 + rng() * 0.08);
      if (dotted) {
        // Habitation dots along the exposed tier-top ledge (all 4 edges).
        const half = w / 2 - 1.2;
        for (let t = -half; t <= half; t += 8 + rng() * 3) {
          megaDots.push([cx + t, y + 0.8, cz - half], [cx + t, y + 0.8, cz + half]);
          megaDots.push([cx - half, y + 0.8, cz + t], [cx + half, y + 0.8, cz + t]);
        }
      }
      w = nw;
    }
    beacons.push(new THREE.Vector3(cx, y + 2, cz));
    megaGeo.push(cyl(0.3, 1.2, 24, cx, y + 12, cz, 6));
  }
  // Near ziggurats: inside the 100-140u haze band of the aerial / street /
  // canyon cameras — visible as layered stepped silhouettes.
  ziggurat(-100, -30, 85, 175, 5, true);
  ziggurat(92, -45, 72, 150, 4, true);
  // Deep ones for the free-orbit view (fog-eaten from the presets).
  ziggurat(-95, -195, 115, 225, 6, false);
  ziggurat(115, -235, 140, 255, 5, false);
  // Tyrell-style pyramid rising behind the east block, on the street axis'
  // vanishing region — a colossal sloped ghost with lit ridge lines.
  {
    const px = 25, pz = -135, pr = 68, phh = 215;
    const pyr = new THREE.CylinderGeometry(7, pr, phh, 4);
    pyr.rotateY(Math.PI / 4);
    pyr.translate(px, phh / 2, pz);
    megaGeo.push(pyr);
    beacons.push(new THREE.Vector3(px, phh + 3, pz));
    // Lit service lines up the two camera-facing ridges.
    const ridges = [
      [[px, 0, pz + pr], [px, phh, pz + 7]],
      [[px - pr, 0, pz], [px - 7, phh, pz]],
    ];
    for (const [b0, b1] of ridges) {
      for (let t = 0.12; t < 0.96; t += 0.07) {
        megaDots.push([
          b0[0] + (b1[0] - b0[0]) * t,
          b0[1] + (b1[1] - b0[1]) * t,
          b0[2] + (b1[2] - b0[2]) * t,
        ]);
      }
    }
  }

  // ---- Merge & add ------------------------------------------------------
  for (let v = 0; v < N_VARIANTS; v++) {
    if (!facadeGeo[v].length) continue;
    const m = new THREE.Mesh(mergeGeometries(facadeGeo[v]), facadeMats[v]);
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  if (podiumGeo.length) {
    const m = new THREE.Mesh(mergeGeometries(podiumGeo), podiumMat);
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  const cm = new THREE.Mesh(mergeGeometries(concreteGeo), concreteMat);
  cm.matrixAutoUpdate = false;
  group.add(cm);
  const mm = new THREE.Mesh(mergeGeometries(megaGeo), megaMat);
  mm.matrixAutoUpdate = false;
  group.add(mm);

  // ---- Distant instanced tower wall -------------------------------------
  const distSpecs = [];
  // Far arc behind everything.
  for (let x = -190; x <= 190; x += 13 + rng() * 8) {
    distSpecs.push({
      x: x + (rng() - 0.5) * 6, z: -150 - rng() * 90,
      w: 11 + rng() * 16, d: 11 + rng() * 16,
      h: 55 + rng() * rng() * 190,
    });
  }
  // Side bands beyond the second rows.
  for (let z = 55; z >= -140; z -= 15 + rng() * 9) {
    for (const sx of [-1, 1]) {
      distSpecs.push({
        x: sx * (85 + rng() * 70), z: z + (rng() - 0.5) * 6,
        w: 12 + rng() * 15, d: 12 + rng() * 15,
        h: 45 + rng() * rng() * 160,
      });
    }
  }
  // Keep the aerial cam's near field low so the vista reads.
  for (const s of distSpecs) {
    const dx = s.x + 40, dz = s.z - 70;
    if (dx * dx + dz * dz < 80 * 80 && s.h > 45) s.h = 26 + rng() * 18;
  }
  const distBox = new THREE.BoxGeometry(1, 1, 1);
  {
    // Compress side-face v into [strip..1]; tops into the blank strip.
    const uv = distBox.attributes.uv;
    for (let i = 0; i < 24; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      const face = (i / 4) | 0;
      if (face === 2 || face === 3) uv.setXY(i, 0.005 + u * 0.02, 0.003 + v * 0.01);
      else uv.setXY(i, u, 0.03 + v * 0.97);
    }
  }
  distBox.translate(0, 0.5, 0);
  const distMats = [makeDistantTexture(rng), makeDistantTexture(rng)].map(
    (t) => {
      const m = new THREE.MeshStandardMaterial({
        map: t.map, emissiveMap: t.emissiveMap,
        emissive: 0xffffff, emissiveIntensity: 1.1,
        roughness: 0.8, metalness: 0.1,
      });
      cityShader(m, 0.5, 0.5);
      return m;
    },
  );
  const distByMat = [[], []];
  for (const s of distSpecs) distByMat[(rng() * 2) | 0].push(s);
  const tmp = new THREE.Object3D();
  distByMat.forEach((specs, i) => {
    const im = new THREE.InstancedMesh(distBox, distMats[i], specs.length);
    specs.forEach((s, j) => {
      tmp.position.set(s.x, 0, s.z);
      tmp.scale.set(s.w, s.h, s.d);
      tmp.rotation.y = 0;
      tmp.updateMatrix();
      im.setMatrixAt(j, tmp.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    im.matrixAutoUpdate = false;
    group.add(im);
  });

  // ---- Aircraft-warning beacons -----------------------------------------
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2a30 });
  const beaconMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.4, 6, 5), beaconMat, beacons.length,
  );
  beacons.forEach((p, i) => {
    tmp.position.copy(p);
    tmp.scale.set(1, 1, 1);
    tmp.updateMatrix();
    beaconMesh.setMatrixAt(i, tmp.matrix);
  });
  beaconMesh.instanceMatrix.needsUpdate = true;
  beaconMesh.matrixAutoUpdate = false;
  group.add(beaconMesh);

  // Dim warm service lights on rooftops / alley walls.
  if (roofLights.length) {
    const rlMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.35, 0.25, 0.35),
      new THREE.MeshBasicMaterial({ color: 0xa06a2c }),
      roofLights.length,
    );
    roofLights.forEach((p, i) => {
      tmp.position.copy(p);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      rlMesh.setMatrixAt(i, tmp.matrix);
    });
    rlMesh.instanceMatrix.needsUpdate = true;
    rlMesh.matrixAutoUpdate = false;
    group.add(rlMesh);
  }

  // Megastructure habitation dots: bright warm points sized to survive the
  // fog attenuation at 100-140u.
  if (megaDots.length) {
    const mdMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.3, 0.9, 1.3),
      new THREE.MeshBasicMaterial({ color: 0xffc27a }),
      megaDots.length,
    );
    megaDots.forEach((p, i) => {
      tmp.position.set(p[0], p[1], p[2]);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      mdMesh.setMatrixAt(i, tmp.matrix);
    });
    mdMesh.instanceMatrix.needsUpdate = true;
    mdMesh.matrixAutoUpdate = false;
    group.add(mdMesh);
  }

  function update(t) {
    // Slow deterministic beacon pulse.
    const k = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2.1));
    beaconMat.color.setRGB(k, 0.10 * k, 0.11 * k);
  }

  return { group, update };
}
