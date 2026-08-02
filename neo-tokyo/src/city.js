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
const CITY_VERT_PATCH = (s) => {
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vCityW;\nvarying float vCityUp;\nvarying vec3 vCityN;')
    .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
      { vec3 cityN = objectNormal;
        #ifdef USE_INSTANCING
          cityN = mat3( instanceMatrix ) * cityN;
        #endif
        vCityN = normalize( mat3( modelMatrix ) * cityN );
        vCityUp = vCityN.y; }`)
    .replace('#include <fog_vertex>', `#include <fog_vertex>
      { vec4 cw = vec4( position, 1.0 );
        #ifdef USE_INSTANCING
          cw = instanceMatrix * cw;
        #endif
        vCityW = ( modelMatrix * cw ).xyz; }`);
};

const CITY_FRAG_DECL = /* glsl */ `
  varying vec3 vCityW;
  varying float vCityUp;
  varying vec3 vCityN;
  uniform float uUpK;
  uniform float uSheenK;
  uniform float uDetK;`;

// World-space surface break, evaluated on EVERY city surface before any
// lighting decision is made. This is the guarantee that no wall is ever
// "unlit and untextured": the result modulates albedo, the grazing sheen and
// a floor-level structural ambient, so a facade at 1% exposure still carries
// panel joints, weathering and a soffit shadow instead of being a black slab.
//
// Boxes are axis-aligned, so the in-plane horizontal coordinate is picked from
// the dominant normal axis — a triplanar read for the cost of a step().
// Fine joints are gated on view distance: procedural high frequency has no
// mip chain, so beyond ~30m it would shimmer instead of reading as material.
const CITY_DETAIL_BODY = /* glsl */ `
  vec3 pw = vCityW;
  float hc = mix( pw.x, pw.z, step( 0.5, abs( vCityN.x ) ) );
  // Cast blotching + weeping stains. Low frequency, safe at any distance.
  float mott = 0.30 * sin( pw.x * 0.43 + pw.z * 0.29 + 1.7 ) * sin( pw.y * 0.23 - 0.6 )
             + 0.16 * sin( hc * 1.15 - pw.y * 0.47 );
  float weep = smoothstep( 0.60, 1.0, 0.5 + 0.5 * sin( hc * 1.73 + 0.6 ) )
             * ( 0.30 + 0.70 * fract( pw.y * -0.055 ) );
  float det = 1.0 + mott - 0.34 * weep;
  float nearK = 1.0 - smoothstep( 9.0, 32.0, length( vViewPosition ) );
  if ( nearK > 0.003 ) {
    // Precast cladding joints, 1.1m x 0.85m — deliberately incommensurate with
    // the 2m/3.2m window grid in the maps so it reads as panelisation, not a
    // second set of ghost windows.
    float ju = 1.0 - abs( fract( hc * 0.91 ) - 0.5 ) * 2.0;
    float jw = 1.0 - abs( fract( pw.y * 1.18 ) - 0.5 ) * 2.0;
    float jo = max( 1.0 - smoothstep( 0.0, 0.14, ju ), 1.0 - smoothstep( 0.0, 0.12, jw ) );
    det -= 0.56 * jo * nearK;
    det += 0.15 * ( 1.0 - smoothstep( 0.11, 0.26, jw ) ) * nearK; // lower-lip catch
    // Conduit / service runs: a few vertical hard bands with a bright edge.
    float cd = 1.0 - abs( fract( hc * 0.13 + 0.31 ) - 0.5 ) * 2.0;
    det -= 0.30 * ( 1.0 - smoothstep( 0.0, 0.05, cd ) ) * nearK;
    // Board-formed shuttering marks and tie holes. The street and alley
    // cameras stand 2-4m off these walls and the canopy fascia passes within
    // a metre of the lens, so the detail pitch has to keep scaling up all the
    // way in or the closest surface in frame is the flattest.
    float vn = 1.0 - smoothstep( 1.5, 5.5, length( vViewPosition ) );
    if ( vn > 0.004 ) {
      float bm = 1.0 - abs( fract( pw.y * 3.7 ) - 0.5 ) * 2.0;
      det -= 0.28 * ( 1.0 - smoothstep( 0.0, 0.17, bm ) ) * vn;
      det += 0.10 * sin( hc * 25.0 ) * sin( pw.y * 19.0 ) * vn;
      det -= 0.16 * smoothstep( 0.68, 1.0, sin( hc * 5.4 ) * sin( pw.y * 4.3 ) ) * vn;
    }
  }
  // Contact AO. Anything facing down is a soffit — slab underside, balcony
  // belly, window head reveal, cornice return — and sits in its own shadow.
  det *= mix( 0.28, 1.0, smoothstep( -0.85, -0.04, vCityN.y ) );
  det = clamp( det, 0.08, 1.5 );
`;

// Shared body. The street-level bounce is a CONTACT term: it dies within a
// couple of metres and is pooled along z, so it reads as spill from discrete
// signs rather than a coat of salmon paint over the whole lower city.
const CITY_LIGHT_BODY = /* glsl */ `
  ${CITY_DETAIL_BODY}
  // Albedo takes the surface break + AO.
  diffuseColor.rgb *= mix( 1.0, det, uDetK );
  // Structural ambient: the skyglow a wet concrete face returns even with no
  // motivated source on it. Sits at ~luma 20 — well inside the shadow bucket —
  // but it is MODULATED by det, so the near walls read as panelised, stained
  // architecture at exposures where a flat term would read as fog.
  totalEmissiveRadiance += vec3( 0.14, 0.20, 0.32 ) * det * uDetK * 0.056;
  float wy = max( vCityW.y, 0.0 );
  // Height bias on window emissive. The street cameras only ever see the
  // first few floors; the aerial sees almost nothing else. Biasing interior
  // light upward gives the aerial something to hold without milking the
  // street-level frames, which is where the midtone budget is tightest.
  // The ramp deliberately starts at 22m: standing 2m off a corridor wall the
  // street camera only ever frames its first ~25m, so anything below that is
  // street budget, not aerial budget. Lifting from 8m instead washed the near
  // walls into a cream blur of blown interiors.
  totalEmissiveRadiance *= 0.90 + 1.50 * smoothstep( 22.0, 88.0, wy );
  // Overcast sky bounce on up-facing planes: roofs, ledge tops, terraces,
  // canopies. The hemisphere light is orders of magnitude too dim to reach
  // them, and from the aerial camera they are most of the frame — without
  // this the whole upper city is a field of identical black boxes.
  // Modulated by det so a cornice top is a weathered concrete edge with a dark
  // soffit under it, not a bright hairline seam.
  totalEmissiveRadiance += vec3( 0.30, 0.40, 0.55 ) * max( vCityUp, 0.0 ) * 0.125
                           * ( 0.55 + 0.45 * det );
  // Deep vertical contact AO. The canyon floor is the darkest place in
  // frame; brightness has to be earned on the way up.
  diffuseColor.rgb *= 0.34 + 0.66 * smoothstep( -4.0, 38.0, wy );
  // Neon spill bounce — local, pooled, and short-range.
  // Sharper pool exponent and a faster vertical falloff than before: at a
  // grazing angle the old wash coated the whole alley wall in warm brown and
  // took that frame's dominant hue to 0deg. Spill has to stay a pool.
  float street = 1.0 - smoothstep( 11.0, 44.0, abs( vCityW.x ) );
  float pool = 0.05 + 0.95 * pow( 0.5 + 0.5 * sin( vCityW.z * 0.23 + vCityW.x * 0.05 ), 5.0 );
  float g = exp( -wy * 0.44 ) * street * pool * uUpK;
  vec3 upCol = mix( vec3( 1.0, 0.44, 0.16 ), vec3( 0.34, 0.20, 0.72 ),
                    0.5 + 0.5 * sin( vCityW.z * 0.09 + vCityW.x * 0.06 ) );
  totalEmissiveRadiance += upCol * g * 0.058 * ( 0.45 + 0.55 * det );
  // Cool grazing sheen (wet surfaces catching skyglow) — extreme angles
  // only, so flat faces stay matte and dark.
  vec3 vDir = normalize( vViewPosition );
  float fres = pow( 1.0 - clamp( dot( normal, vDir ), 0.0, 1.0 ), 5.0 );
  totalEmissiveRadiance += vec3( 0.24, 0.40, 0.66 ) * fres * 0.052 * uSheenK
                           * ( 0.30 + 0.80 * det );
`;

function cityShader(mat, upK = 1.0, sheenK = 1.0, detK = 0.85) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uUpK = { value: upK };
    s.uniforms.uSheenK = { value: sheenK };
    s.uniforms.uDetK = { value: detK };
    CITY_VERT_PATCH(s);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>${CITY_FRAG_DECL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { ${CITY_LIGHT_BODY} }`);
  };
}

// Separate program (distinct onBeforeCompile source => distinct cache key) for
// the untextured greeble mass: ledges, pilasters, colonnades, pipes, parapets.
// These sit centimetres from the street cameras, so a flat colour reads as
// painted cardboard. World-space procedural cast-concrete: formwork blotching,
// aggregate speckle, vertical grime runs off every ledge, damp base.
function concreteShader(mat, upK = 0.9, sheenK = 1.3, detK = 0.55) {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uUpK = { value: upK };
    s.uniforms.uSheenK = { value: sheenK };
    s.uniforms.uDetK = { value: detK };
    CITY_VERT_PATCH(s);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>${CITY_FRAG_DECL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 p = vCityW;
          // Formwork panel blotching + aggregate speckle.
          float n1 = sin( p.x * 0.51 + 1.3 ) * sin( p.y * 0.37 - 0.7 ) * sin( p.z * 0.61 + 2.1 );
          float n2 = sin( p.x * 2.30 - p.z * 1.7 ) * sin( p.y * 1.90 + p.x * 0.8 );
          float n3 = sin( p.x * 8.10 + p.z * 6.9 ) * sin( p.y * 6.30 - p.z * 2.2 );
          float mott = 0.34 * n1 + 0.19 * n2 + 0.11 * n3;
          // Vertical grime runs: narrow columns weeping down the face.
          float lane = 0.5 + 0.5 * sin( p.x * 3.9 + p.z * 4.7 );
          float run = smoothstep( 0.58, 1.0, lane ) * ( 0.35 + 0.65 * fract( p.y * -0.11 ) );
          diffuseColor.rgb *= clamp( 1.0 + mott - 0.42 * run, 0.30, 1.45 );
          // Damp, darker at the wet base.
          diffuseColor.rgb *= 0.56 + 0.44 * smoothstep( 0.0, 15.0, p.y );
        }
        { ${CITY_LIGHT_BODY} }`);
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
  const floors = 20;
  const duty = opts.litBase ?? 0.15;

  const albedo = document.createElement('canvas');
  albedo.width = W; albedo.height = H;
  const a = albedo.getContext('2d');
  const emis = document.createElement('canvas');
  emis.width = W; emis.height = H;
  const e = emis.getContext('2d');

  // Base concrete: dark desaturated blue. Low enough to read as wet concrete
  // rather than painted board, high enough to still catch the hemisphere.
  const hue = 208 + rng() * 22;
  const sat = 5 + rng() * 7;
  const li = 6.0 + rng() * 2.4;
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
  // ---- Bay layout -------------------------------------------------------
  // A fixed 12-column x 20-floor grid is exactly what read as a procedural
  // stamp from the aerial. Both axes are now unequal: 10-14 bays of differing
  // width, each with its own reveal depth, mullion count, sill and head, and
  // storey heights that vary +-17% (lobbies, plant levels, double-height
  // floors). No two openings on a facade are the same module.
  const nCols = 10 + ((rng() * 5) | 0);
  const wts = [];
  for (let i = 0; i < nCols; i++) wts.push(0.5 + rng() * rng() * 2.1);
  const wTot = wts.reduce((s, v) => s + v, 0);
  const edge = [0];
  for (let i = 0; i < nCols; i++) edge.push(edge[i] + (wts[i] / wTot) * W);
  edge[nCols] = W;
  const bay = [];
  for (let c = 0; c < nCols; c++) {
    const bw = edge[c + 1] - edge[c];
    bay.push({
      x0: edge[c], bw,
      // Narrow bays and a tenth of the rest are solid: service risers, blind
      // panels, structural piers. Silhouette needs blanks as much as glass.
      solid: bw < 30 || rng() < 0.10,
      inset: 4 + rng() * 10,
      head: 9 + rng() * 13,
      sillH: 12 + rng() * 18,
      mull: bw < 52 ? 0 : rng() < 0.42 ? 1 : rng() < 0.62 ? 2 : 3,
      transom: rng() < 0.5 ? 0.66 + rng() * 0.14 : 0,
      deep: rng() < 0.38,
    });
  }
  const fwt = [];
  for (let f = 0; f < floors; f++) fwt.push(0.83 + rng() * rng() * 0.7);
  const fTot = fwt.reduce((s, v) => s + v, 0);
  const fy = [0];
  for (let f = 0; f < floors; f++) fy.push(fy[f] + (fwt[f] / fTot) * (H - BLANK));

  // Panel seams follow the real bay/floor lines.
  a.fillStyle = 'rgba(0,0,0,0.42)';
  for (let c = 0; c <= nCols; c++) a.fillRect(edge[c] - 1.5, 0, 3, H);
  for (let f = 0; f <= floors; f++) a.fillRect(0, fy[f] - 1.5, W, 3);
  // Spandrel band per floor (sill course that catches sky light) with a
  // shadow gap under it so the slab edge reads as depth, not a hairline.
  for (let f = 0; f < floors; f++) {
    const yb = fy[f + 1];
    a.fillStyle = 'rgba(150,170,200,0.10)';
    a.fillRect(0, yb - 15, W, 5);
    a.fillStyle = 'rgba(0,0,0,0.30)';
    a.fillRect(0, yb - 10, W, 6);
  }

  // ---- Occupancy: blue-noise threshold, never a grid-block sampler -------
  // Every opening is scored by a smooth low-frequency occupancy field plus a
  // per-window jitter, then the top `duty` fraction is lit. That yields soft
  // organic drifts of light with an exact duty cycle, instead of the
  // rectangular 3x3 clusters a contiguous-run stamper produces.
  const p1 = rng() * 6.283, p2 = rng() * 6.283, p3 = rng() * 6.283;
  const tPhase = rng() * 6.283;
  const plantFloor = new Array(floors).fill(false);
  for (let i = 0, n = 1 + ((rng() * 2) | 0); i < n; i++) plantFloor[(rng() * floors) | 0] = true;
  const cells = [];
  for (let f = 0; f < floors; f++) {
    if (plantFloor[f]) continue;
    for (let c = 0; c < nCols; c++) {
      if (bay[c].solid) continue;
      const u = (c / nCols) * 6.0, v = (f / floors) * 6.0;
      const field = 0.55 * Math.sin(u * 1.31 + v * 0.77 + p1)
                  + 0.30 * Math.sin(v * 1.93 - u * 0.61 + p2)
                  + 0.15 * Math.sin(u * 2.71 + v * 2.37 + p3);
      cells.push([field * 0.60 + rng() * 0.92, c, f]);
    }
  }
  cells.sort((x, y) => y[0] - x[0]);
  const litMap = new Map();
  for (let i = 0, n = Math.round(cells.length * duty); i < n; i++) {
    const [, c, f] = cells[i];
    // Temperature drifts on its own smooth field: warm districts within a
    // tower, not per-window confetti.
    const w = Math.sin(c * 0.83 + f * 0.41 + tPhase) + (rng() - 0.5) * 0.9;
    litMap.set(f * 64 + c, w > -0.05);
  }
  // Service core / stair: one bay carrying a steady low level most of the way
  // up. It is the vertical line that pins a dark tower in the haze.
  {
    let cc = (rng() * nCols) | 0;
    for (let k = 0; k < nCols && bay[cc].solid; k++) cc = (cc + 1) % nCols;
    if (!bay[cc].solid && rng() < 0.75) {
      for (let f = 0; f < floors; f++) {
        if (plantFloor[f] || rng() < 0.24) continue;
        if (!litMap.has(f * 64 + cc)) litMap.set(f * 64 + cc, false);
      }
    }
  }

  for (let f = 0; f < floors; f++) {
    const y0 = fy[f], fh = fy[f + 1] - y0;
    for (let c = 0; c < nCols; c++) {
      const b = bay[c];
      if (b.solid) {
        // Blind panel: cast concrete with a vent grille or a riser door.
        a.fillStyle = 'rgba(0,0,0,0.22)';
        a.fillRect(b.x0 + 3, y0 + 4, b.bw - 6, fh - 8);
        if (rng() < 0.4) {
          a.fillStyle = 'rgba(0,0,0,0.45)';
          for (let yy = y0 + 8; yy < y0 + fh - 8; yy += 6) a.fillRect(b.x0 + 6, yy, b.bw - 12, 3);
        }
        continue;
      }
      const wx = b.x0 + b.inset, ww = b.bw - b.inset * 2;
      const wy = y0 + b.head, wh = fh - b.head - b.sillH;
      if (ww < 8 || wh < 10) continue;
      const key = f * 64 + c;
      // Unlit glass albedo: barely lighter than the concrete, blue.
      const gl = 9 + rng() * 4;
      a.fillStyle = `rgb(${gl | 0},${(gl + 3) | 0},${(gl + 9) | 0})`;
      a.fillRect(wx, wy, ww, wh);
      // Sheen gradient on unlit glass: sky reflection brighter at the top.
      const sv = 0.6 + rng() * 0.4;
      const sg = e.createLinearGradient(0, wy, 0, wy + wh);
      sg.addColorStop(0, rgba([24 * sv, 30 * sv, 44 * sv], 1));
      sg.addColorStop(1, rgba([8 * sv, 10 * sv, 15 * sv], 1));
      e.fillStyle = sg;
      e.fillRect(wx, wy, ww, wh);
      if (plantFloor[f]) {
        // Plant floor: a dim continuous strip behind louvres, no interior.
        e.fillStyle = 'rgba(120,132,150,0.10)';
        e.fillRect(wx, wy + wh * 0.4, ww, wh * 0.2);
        a.fillStyle = 'rgba(0,0,0,0.45)';
        for (let yy = wy; yy < wy + wh; yy += 7) a.fillRect(wx, yy, ww, 4);
      } else if (litMap.has(key)) {
        drawRoom(e, wx, wy, ww, wh, litMap.get(key), rng);
      }
      // Reveal AO. Head and both jambs carry occlusion, the sill catches sky,
      // and a `deep` bay gets roughly double the darkening — that gradient of
      // recess depth across the facade is what makes openings read as modelled
      // holes rather than decals printed on a plane.
      const k = b.deep ? 1.0 : 0.55;
      const jw = b.deep ? 7 : 4;
      const grdH = a.createLinearGradient(0, wy - 5, 0, wy + wh * 0.34);
      grdH.addColorStop(0, `rgba(0,0,0,${(0.82 * k).toFixed(3)})`);
      grdH.addColorStop(1, 'rgba(0,0,0,0)');
      a.fillStyle = grdH;
      a.fillRect(wx - jw, wy - 5, ww + jw * 2, wh * 0.34 + 5);
      e.fillStyle = grdH;
      e.fillRect(wx - jw, wy - 5, ww + jw * 2, wh * 0.34 + 5);
      const grdJ = a.createLinearGradient(wx - jw, 0, wx + ww * 0.3, 0);
      grdJ.addColorStop(0, `rgba(0,0,0,${(0.78 * k).toFixed(3)})`);
      grdJ.addColorStop(1, 'rgba(0,0,0,0)');
      a.fillStyle = grdJ;
      a.fillRect(wx - jw, wy, ww * 0.3 + jw, wh);
      e.fillStyle = grdJ;
      e.fillRect(wx - jw, wy, ww * 0.3 + jw, wh);
      a.fillStyle = `rgba(0,0,0,${(0.42 * k).toFixed(3)})`;
      a.fillRect(wx + ww - jw * 0.5, wy, jw * 0.5, wh);
      e.fillStyle = `rgba(0,0,0,${(0.42 * k).toFixed(3)})`;
      e.fillRect(wx + ww - jw * 0.5, wy, jw * 0.5, wh);
      // Sill catch + the shadow the sill throws on the wall below it.
      a.fillStyle = 'rgba(152,170,198,0.16)';
      a.fillRect(wx - jw, wy + wh - 2, ww + jw * 2, 4);
      a.fillStyle = 'rgba(0,0,0,0.34)';
      a.fillRect(wx - jw, wy + wh + 2, ww + jw * 2, 5);
      // Mullions: 0-3 per opening, unevenly spaced.
      a.fillStyle = 'rgba(0,0,0,0.55)';
      e.fillStyle = 'rgba(0,0,0,0.6)';
      for (let m = 1; m <= b.mull; m++) {
        const mx = wx + ww * ((m + (rng() - 0.5) * 0.35) / (b.mull + 1));
        a.fillRect(mx - 1.5, wy, 3, wh);
        e.fillRect(mx - 1.5, wy, 3, wh);
      }
      if (b.transom) {
        a.fillRect(wx, wy + wh * b.transom, ww, 3);
        e.fillRect(wx, wy + wh * b.transom, ww, 3);
      }
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

  // Roof patch. Box tops UV-map into u in [0.01,0.04], v in [0.004,0.016] of
  // this strip, which the aerial camera stares straight down at. The
  // hemisphere is far too dim to light an up-facing surface, so the decks
  // carry their own faint skyglow reflection or the aerial reads as a void.
  {
    const rw = W * 0.06, ry = H - BLANK;
    a.fillStyle = `hsl(${hue},${sat * 0.5}%,${(li * 2.4).toFixed(1)}%)`;
    a.fillRect(0, ry, rw, BLANK);
    e.fillStyle = 'rgb(38,49,66)';
    e.fillRect(0, ry, rw, BLANK);
    for (let i = 0; i < 300; i++) {
      const bx = rng() * rw, by = ry + rng() * BLANK;
      const bw = 1 + rng() * 3, bh = 1 + rng() * 3;
      a.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.28)' : 'rgba(180,198,224,0.18)';
      a.fillRect(bx, by, bw, bh);
      e.fillStyle = rng() < 0.55 ? 'rgba(0,0,0,0.6)' : 'rgba(118,148,192,0.55)';
      e.fillRect(bx, by, bw, bh);
    }
    // A couple of warm deck-light pools per roof.
    for (let i = 0; i < 3; i++) {
      const px = rng() * rw, py = ry + rng() * BLANK, pr = 4 + rng() * 7;
      const pg = e.createRadialGradient(px, py, 0, px, py, pr);
      pg.addColorStop(0, 'rgba(255,190,116,0.85)');
      pg.addColorStop(1, 'rgba(255,190,116,0)');
      e.fillStyle = pg;
      e.fillRect(px - pr, py - pr, pr * 2, pr * 2);
    }
  }

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
  a.fillStyle = 'hsl(214,8%,6%)';
  a.fillRect(0, 0, W, H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, H);
  // Concrete texture noise + horizontal formwork lift lines.
  for (let i = 0; i < 700; i++) {
    a.fillStyle = rng() < 0.55 ? 'rgba(0,0,0,0.09)' : 'rgba(160,180,208,0.045)';
    a.fillRect(rng() * W, rng() * H, 4 + rng() * 18, 4 + rng() * 18);
  }
  a.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 24; y < H - BLANK; y += 46) a.fillRect(0, y, W, 3);
  a.fillStyle = 'rgba(150,168,196,0.05)';
  for (let y = 24; y < H - BLANK; y += 46) a.fillRect(0, y + 3, W, 2);
  // Uneven shopfront bays. This texture wraps the podium the street and alley
  // cameras stand two metres from, so its rhythm is read directly.
  const cols = 9 + ((rng() * 4) | 0);
  const cwts = [];
  for (let i = 0; i < cols; i++) cwts.push(0.6 + rng() * rng() * 1.6);
  const cTot = cwts.reduce((s, v) => s + v, 0);
  const cxs = [0];
  for (let i = 0; i < cols; i++) cxs.push(cxs[i] + (cwts[i] / cTot) * W);
  cxs[cols] = W;
  // Occupancy: a lit shopfront is the motivated source for the whole street
  // frame, so no more than two dark bays may ever sit next to each other.
  const litBay = [];
  let dark = 0;
  for (let c = 0; c < cols; c++) {
    const on = dark >= 2 ? true : rng() < 0.6;
    dark = on ? 0 : dark + 1;
    litBay.push(on);
  }
  for (let c = 0; c < cols; c++) {
    const wx = cxs[c] + 12, ww = cxs[c + 1] - cxs[c] - 24;
    const wy = 52, wh = H - BLANK - 120;
    if (ww < 14) continue;
    a.fillStyle = 'rgb(11,14,21)';
    a.fillRect(wx, wy, ww, wh);
    // Base sheen so even dark bays read as glass.
    const sg = e.createLinearGradient(0, wy, 0, wy + wh);
    sg.addColorStop(0, 'rgb(22,29,42)');
    sg.addColorStop(0.72, 'rgb(13,17,25)');
    sg.addColorStop(1, 'rgb(26,30,38)');
    e.fillStyle = sg;
    e.fillRect(wx, wy, ww, wh);
    a.fillStyle = 'rgba(0,0,0,0.7)';
    a.fillRect(wx - 6, 0, 9, H - BLANK); // pier
    a.fillRect(wx - 6, wy - 8, ww + 12, 9); // head reveal
    // Reveal AO in albedo AND emissive, so the opening still reads as a
    // recess when the bay is unlit and the frame is 1% exposed.
    {
      const hg = a.createLinearGradient(0, wy - 8, 0, wy + wh * 0.3);
      hg.addColorStop(0, 'rgba(0,0,0,0.85)');
      hg.addColorStop(1, 'rgba(0,0,0,0)');
      a.fillStyle = hg; a.fillRect(wx - 8, wy - 8, ww + 16, wh * 0.3 + 8);
      e.fillStyle = hg; e.fillRect(wx - 8, wy - 8, ww + 16, wh * 0.3 + 8);
      const jg = a.createLinearGradient(wx - 8, 0, wx + ww * 0.22, 0);
      jg.addColorStop(0, 'rgba(0,0,0,0.8)');
      jg.addColorStop(1, 'rgba(0,0,0,0)');
      a.fillStyle = jg; a.fillRect(wx - 8, wy, ww * 0.22 + 8, wh);
      e.fillStyle = jg; e.fillRect(wx - 8, wy, ww * 0.22 + 8, wh);
    }
    if (litBay[c]) {
      // Lit lobby / shopfront: glow strongest at counter height. These are
      // the motivated light for the whole street-level frame — the bounce in
      // cityShader is keyed to them, so they cannot all be dark.
      const warm = rng() < 0.55;
      const b = 0.26 + rng() * 0.36;
      const col = warm ? [255, 172, 92] : [140, 198, 255];
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
      e.fillStyle = `rgba(255,255,255,${(0.3 * b).toFixed(3)})`;
      e.fillRect(wx + 8, wy + 6, ww - 16, 5);
    } else {
      // Shuttered / vacant bay. It still has to carry information: a security
      // standby lamp, the shutter's ribbed shadow, and fly-posted paper. A
      // dark bay that is genuinely empty is what put a void in frame right.
      e.fillStyle = 'rgba(86,116,146,0.34)';
      e.fillRect(wx + ww * (0.2 + rng() * 0.5), wy + wh * (0.12 + rng() * 0.2), ww * 0.22, wh * 0.09);
      a.fillStyle = 'rgba(0,0,0,0.5)';
      for (let yy = wy + 6; yy < wy + wh * 0.92; yy += 9) a.fillRect(wx + 3, yy, ww - 6, 4);
      e.fillStyle = 'rgba(0,0,0,0.35)';
      for (let yy = wy + 6; yy < wy + wh * 0.92; yy += 9) e.fillRect(wx + 3, yy, ww - 6, 4);
      if (rng() < 0.6) {
        const px = wx + 6 + rng() * Math.max(2, ww - 40);
        a.fillStyle = `rgba(${120 + rng() * 90 | 0},${100 + rng() * 60 | 0},90,0.30)`;
        a.fillRect(px, wy + wh * (0.3 + rng() * 0.4), 22 + rng() * 14, 30 + rng() * 22);
      }
    }
    // Transom bar and stall-riser below the glass.
    a.fillStyle = 'rgba(0,0,0,0.55)';
    a.fillRect(wx, wy + wh * 0.78, ww, 5);
    e.fillStyle = 'rgba(0,0,0,0.55)';
    e.fillRect(wx, wy + wh * 0.78, ww, 5);
  }
  // Shutter / service doors between glass bays.
  for (let i = 0; i < 5; i++) {
    const x = rng() * (W - 80);
    a.fillStyle = 'rgb(20,22,26)';
    a.fillRect(x, H - BLANK - 140, 68, 140);
    a.fillStyle = 'rgba(0,0,0,0.5)';
    for (let y = 0; y < 140; y += 12) a.fillRect(x, H - BLANK - 140 + y, 68, 4);
    // Caged lamp above the shutter, with its spill baked onto the wall as a
    // soft cone. Cheaper than a real light and it keeps the pool local.
    if (rng() < 0.7) {
      const lx = x + 34, ly = H - BLANK - 150;
      const sp = e.createRadialGradient(lx, ly, 2, lx, ly, 78);
      sp.addColorStop(0, 'rgba(255,186,104,0.75)');
      sp.addColorStop(0.35, 'rgba(220,140,66,0.24)');
      sp.addColorStop(1, 'rgba(180,110,50,0)');
      e.fillStyle = sp;
      e.fillRect(lx - 78, ly - 40, 156, 118);
      e.fillStyle = 'rgba(255,208,140,0.95)';
      e.fillRect(lx - 8, ly - 3, 16, 6);
    }
  }
  // Surface plant painted onto the concrete band above the shopfronts: cable
  // trunking, junction boxes, bracket plates, meter cupboards. At two metres
  // this is the difference between a wall and a blockout.
  for (let i = 0, n = 7 + ((rng() * 6) | 0); i < n; i++) {
    const y = 6 + rng() * 34, len = 90 + rng() * 380, x = rng() * W;
    a.fillStyle = 'rgba(0,0,0,0.55)';
    a.fillRect(x, y, len, 5);
    a.fillStyle = 'rgba(150,166,190,0.16)';
    a.fillRect(x, y + 5, len, 2);
    for (let k = 0; k < len; k += 46 + rng() * 40) {
      a.fillStyle = 'rgba(0,0,0,0.5)';
      a.fillRect(x + k, y - 3, 7, 12);
    }
  }
  for (let i = 0, n = 6 + ((rng() * 6) | 0); i < n; i++) {
    const bw = 12 + rng() * 26, bh = 14 + rng() * 30;
    const x = rng() * (W - bw), y = 8 + rng() * (H - BLANK - 150 - bh);
    a.fillStyle = 'rgba(0,0,0,0.62)';
    a.fillRect(x, y, bw, bh);
    a.fillStyle = 'rgba(146,164,192,0.14)';
    a.fillRect(x, y, bw, 2);
    a.fillStyle = 'rgba(0,0,0,0.4)';
    a.fillRect(x, y + bh, bw, 4);
  }
  // Grime.
  for (let i = 0; i < 30; i++) {
    a.fillStyle = `rgba(3,4,6,${0.1 + rng() * 0.18})`;
    a.fillRect(rng() * W, 0, 3 + rng() * 14, H * (0.3 + rng() * 0.7));
  }
  // Weeping stains off every ledge, in emissive too so the wall keeps its
  // grain when nothing is lighting it.
  for (let i = 0, n = 16 + ((rng() * 10) | 0); i < n; i++) {
    const x = rng() * W, w = 2 + rng() * 9, y0 = rng() * (H - BLANK) * 0.6;
    const g2 = a.createLinearGradient(0, y0, 0, y0 + 60 + rng() * 200);
    g2.addColorStop(0, `rgba(2,3,4,${(0.16 + rng() * 0.2).toFixed(3)})`);
    g2.addColorStop(1, 'rgba(2,3,4,0)');
    a.fillStyle = g2;
    a.fillRect(x, y0, w, 260);
    e.fillStyle = g2;
    e.fillRect(x, y0, w, 260);
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
  const cols = 20 + ((rng() * 6) | 0), floors = 42 + ((rng() * 9) | 0);
  // Uneven bays and storey heights, same as the near facades — from the aerial
  // these towers are a third of the frame and a regular grid is the single
  // loudest tell that a city was stamped rather than built.
  const cwts = [];
  for (let i = 0; i < cols; i++) cwts.push(0.55 + rng() * rng() * 1.7);
  const cTot = cwts.reduce((s, v) => s + v, 0);
  const cx = [0];
  for (let i = 0; i < cols; i++) cx.push(cx[i] + (cwts[i] / cTot) * W);
  cx[cols] = W;
  const fwt = [];
  for (let f = 0; f < floors; f++) fwt.push(0.85 + rng() * rng() * 0.55);
  const fTot = fwt.reduce((s, v) => s + v, 0);
  const fy = [0];
  for (let f = 0; f < floors; f++) fy.push(fy[f] + (fwt[f] / fTot) * (H - BLANK));
  const solid = [];
  for (let c = 0; c < cols; c++) solid.push(cx[c + 1] - cx[c] < 7 || rng() < 0.09);

  // Blue-noise occupancy: smooth field + jitter, thresholded to an exact duty.
  const p1 = rng() * 6.283, p2 = rng() * 6.283, p3 = rng() * 6.283;
  const tPh = rng() * 6.283;
  const plant = new Array(floors).fill(false);
  for (let i = 0, n = 2 + ((rng() * 3) | 0); i < n; i++) plant[(rng() * floors) | 0] = true;
  const cells = [];
  for (let f = 0; f < floors; f++) {
    if (plant[f]) continue;
    for (let c = 0; c < cols; c++) {
      if (solid[c]) continue;
      const u = (c / cols) * 7.0, v = (f / floors) * 9.0;
      const fld = 0.55 * Math.sin(u * 1.27 + v * 0.71 + p1)
                + 0.30 * Math.sin(v * 1.81 - u * 0.67 + p2)
                + 0.15 * Math.sin(u * 3.11 + v * 2.53 + p3);
      cells.push([fld * 0.58 + rng() * 0.95, c, f]);
    }
  }
  cells.sort((x, y) => y[0] - x[0]);
  const lit = new Map();
  for (let i = 0, n = Math.round(cells.length * (0.11 + rng() * 0.07)); i < n; i++) {
    const [, c, f] = cells[i];
    lit.set(f * 64 + c, Math.sin(c * 0.77 + f * 0.37 + tPh) + (rng() - 0.5) * 0.9 > -0.05);
  }
  for (let f = 0; f < floors; f++) {
    const y0 = fy[f], fh = fy[f + 1] - y0;
    for (let c = 0; c < cols; c++) {
      const x0 = cx[c], cw = cx[c + 1] - cx[c];
      if (solid[c]) continue;
      a.fillStyle = 'rgb(11,14,20)';
      a.fillRect(x0 + 2, y0 + 3, cw - 4, fh - 6);
      e.fillStyle = 'rgb(8,10,15)';
      e.fillRect(x0 + 2, y0 + 3, cw - 4, fh - 6);
      const key = f * 64 + c;
      if (lit.has(key)) {
        const b = 0.3 + rng() * 0.55;
        e.fillStyle = lit.get(key)
          ? `rgb(${255 * b | 0},${165 * b | 0},${85 * b | 0})`
          : `rgb(${140 * b | 0},${195 * b | 0},${255 * b | 0})`;
        e.fillRect(x0 + 2, y0 + 3, cw - 4, fh - 6);
        // Ceiling-glow gradient: brighter at the head of the opening so a
        // window reads as a room, not a sticker.
        const gg = e.createLinearGradient(0, y0 + 3, 0, y0 + fh - 3);
        gg.addColorStop(0, `rgba(255,255,255,${(0.3 * b).toFixed(3)})`);
        gg.addColorStop(1, 'rgba(0,0,0,0.35)');
        e.fillStyle = gg;
        e.fillRect(x0 + 2, y0 + 3, cw - 4, fh - 6);
      }
      // Head reveal AO so the openings carry depth at this scale too.
      a.fillStyle = 'rgba(0,0,0,0.5)';
      a.fillRect(x0 + 1, y0 + 1, cw - 2, 3);
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
  // Habitation clusters: contiguous BLOCKS of floors x columns, so the mass
  // reads as districts stacked inside it rather than random speckle. Plus
  // two lit vertical service shafts that pin the silhouette in the haze.
  const shafts = [(rng() * cols) | 0, (rng() * cols) | 0];
  for (let i = 0, n = 7 + ((rng() * 6) | 0); i < n; i++) {
    const c0 = (rng() * cols) | 0, cN = 2 + ((rng() * 5) | 0);
    const f0 = (rng() * floors) | 0, fN = 2 + ((rng() * 7) | 0);
    const warm = rng() < 0.72;
    const base = 0.3 + rng() * 0.45;
    for (let f = f0; f < f0 + fN && f < floors; f++) {
      for (let k = 0; k < cN; k++) {
        if (rng() < 0.28) continue;
        const c = (c0 + k) % cols;
        const b = base * (0.65 + rng() * 0.55);
        e.fillStyle = warm
          ? `rgb(${255 * b | 0},${170 * b | 0},${90 * b | 0})`
          : `rgb(${145 * b | 0},${200 * b | 0},${255 * b | 0})`;
        e.fillRect(c * cw + 3, f * fh + 3, cw - 6, fh - 6);
      }
    }
  }
  for (const sc of shafts) {
    for (let f = 0; f < floors; f++) {
      if (rng() < 0.22) continue;
      const b = 0.2 + rng() * 0.25;
      e.fillStyle = `rgb(${170 * b | 0},${190 * b | 0},${215 * b | 0})`;
      e.fillRect(sc * cw + 5, f * fh + 4, cw - 10, fh - 8);
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
function facadeBox(w, h, d, cx, cy, cz, uo, texW = TEX_W, texH = TEX_H, vo = 0) {
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
      uv.setXY(i, uo + u * su, vo + y0 / texH + (v * h) / texH);
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
  const mkFacade = (litBase, ei) => {
    const { map, emissiveMap } = makeFacadeTexture(rng, { litBase });
    const m = new THREE.MeshStandardMaterial({
      map, emissiveMap,
      emissive: 0xffffff, emissiveIntensity: ei,
      roughness: 0.62 + rng() * 0.18, metalness: 0.16,
    });
    cityShader(m, 1.0, 1.0, 0.9);
    facadeMats.push(m);
  };
  for (let i = 0; i < N_VARIANTS; i++) mkFacade(0.13 + rng() * 0.13, 1.35);
  // Corridor variants (indices 6-7). The front rows are what the street and
  // alley cameras stand two metres from, so they need guaranteed occupancy —
  // a randomly-dark bay on the near wall leaves a third of frame as a void.
  const CORRIDOR_V = [N_VARIANTS, N_VARIANTS + 1];
  mkFacade(0.24, 1.3);
  mkFacade(0.20, 1.3);
  const podTex = makePodiumTexture(rng);
  const podiumMat = new THREE.MeshStandardMaterial({
    map: podTex.map, emissiveMap: podTex.emissiveMap,
    emissive: 0xffffff, emissiveIntensity: 1.0,
    roughness: 0.5, metalness: 0.2,
  });
  cityShader(podiumMat, 0.9, 1.0, 1.0);
  // Wet cast concrete: near-black blue-grey. All greebles, relief and
  // colonnade work live here, so it gets the procedural detail program.
  const concreteMat = new THREE.MeshStandardMaterial({
    color: 0x151b25, roughness: 0.78, metalness: 0.12,
  });
  // High sheen: at the grazing angles the near walls present to the street
  // cameras this is what makes ledge courses, pilaster returns and pipework
  // read as wet concrete instead of an unlit black slab.
  concreteShader(concreteMat, 0.85, 2.1, 0.9);
  const megaTex = makeMegaTexture(rng);
  const megaMat = new THREE.MeshStandardMaterial({
    map: megaTex.map, emissiveMap: megaTex.emissiveMap,
    emissive: 0xffffff, emissiveIntensity: 1.2,
    roughness: 0.9, metalness: 0.1,
  });
  cityShader(megaMat, 0.45, 0.7, 0.32);

  // Geometry bins.
  const facadeGeo = facadeMats.map(() => []);
  const podiumGeo = [];
  const concreteGeo = [];
  const megaGeo = [];
  const beacons = [];
  const roofLights = [];
  const arcadeLights = []; // [x, y, z, r, g, b] under-canopy strips
  const megaDots = []; // habitation strips on megastructure tier edges
  // Facade practicals: [x,y,z, sx,sy,sz, r,g,b]. Low-level motivated light
  // bolted to the near walls — stairwell strips behind wired glass, extract
  // vent glow, a single warm window, riser-door lamps. These exist so that no
  // wall the cameras stand against can ever be simultaneously unlit and
  // untextured: they carry silhouette and grain at 1% exposure. Baked as
  // emissive boxes in ONE instanced draw — a real PointLight here would
  // multiply the per-pixel cost of every standard material in the scene.
  const practicals = [];
  const soffitGeo = []; // canopy undersides, lit by the cove strip below them
  const soffitHotGeo = []; // the band right over the cove
  const pract = (x, y, z, sx, sy, sz, r, g, b) => practicals.push([x, y, z, sx, sy, sz, r, g, b]);

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
    // Parapet corner markers. From the aerial camera these pin each roof
    // plane; without them the upper half of that frame is an unreadable
    // black field of identical boxes.
    if (rng() < 0.8) {
      const hx = w / 2 - 0.5, hd = d / 2 - 0.5;
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (rng() < 0.22) continue;
        roofLights.push(new THREE.Vector3(cx.x + sx * hx, topY + ph + 0.3, cx.z + sz * hd));
      }
    }
    // ---- Roof crown ------------------------------------------------------
    // BR2049 skylines are read entirely by silhouette. A flat-topped extruded
    // box has none, so every roof over ~7m across gets one of four crown
    // types: a stepped machine-room setback, an open structural frame, a
    // cooling-tower cluster, or a mast array on a plinth.
    if (w > 7) {
      const kind = (rng() * 4) | 0;
      const cw2 = w * (0.4 + rng() * 0.22), cd2 = d * (0.4 + rng() * 0.22);
      const kx = cx.x + (rng() - 0.5) * (w - cw2) * 0.55;
      const kz = cx.z + (rng() - 0.5) * (d - cd2) * 0.55;
      if (kind === 0) {
        // Stepped machine room: two setbacks with their own parapets.
        const h1 = 2.6 + rng() * 3.4;
        concreteGeo.push(plainBox(cw2, h1, cd2, kx, topY + h1 / 2, kz));
        concreteGeo.push(plainBox(cw2 + 0.5, 0.4, cd2 + 0.5, kx, topY + h1 + 0.2, kz));
        const h2 = 1.6 + rng() * 2.6, w2 = cw2 * 0.55, d2 = cd2 * 0.55;
        concreteGeo.push(plainBox(w2, h2, d2, kx, topY + h1 + h2 / 2 + 0.4, kz));
        concreteGeo.push(cyl(0.09, 0.09, 4 + rng() * 5, kx, topY + h1 + h2 + 2.8, kz, 5));
        roofLights.push(new THREE.Vector3(kx + cw2 / 2 + 0.2, topY + 0.9, kz));
      } else if (kind === 1) {
        // Open structural frame / signage gantry over the deck.
        const fh2 = 4 + rng() * 5, hx = cw2 / 2, hz = cd2 / 2;
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          concreteGeo.push(plainBox(0.34, fh2, 0.34, kx + sx * hx, topY + fh2 / 2, kz + sz * hz));
        }
        concreteGeo.push(
          plainBox(cw2 + 0.4, 0.3, 0.3, kx, topY + fh2, kz - hz),
          plainBox(cw2 + 0.4, 0.3, 0.3, kx, topY + fh2, kz + hz),
          plainBox(0.3, 0.3, cd2 + 0.4, kx - hx, topY + fh2, kz),
          plainBox(0.3, 0.3, cd2 + 0.4, kx + hx, topY + fh2, kz),
          plainBox(cw2 * 0.7, 0.22, cd2 * 0.7, kx, topY + fh2 * 0.55, kz),
        );
        beacons.push(new THREE.Vector3(kx, topY + fh2 + 0.5, kz));
      } else if (kind === 2) {
        // Cooling-tower cluster on a plinth.
        concreteGeo.push(plainBox(cw2 + 0.6, 0.55, cd2 + 0.6, kx, topY + 0.28, kz));
        for (let i = 0, n = 2 + ((rng() * 3) | 0); i < n; i++) {
          const r = 0.8 + rng() * 0.9, th2 = 2.2 + rng() * 2.6;
          const tx = kx + (rng() - 0.5) * cw2, tz = kz + (rng() - 0.5) * cd2;
          concreteGeo.push(
            cyl(r * 0.82, r, th2, tx, topY + th2 / 2 + 0.55, tz, 8),
            cyl(r * 1.1, r * 1.1, 0.22, tx, topY + th2 + 0.7, tz, 8),
          );
        }
        roofLights.push(new THREE.Vector3(kx, topY + 1.2, kz + cd2 * 0.6));
      } else {
        // Mast array on a raised plinth: the tallest, thinnest silhouette.
        concreteGeo.push(plainBox(cw2 * 0.7, 1.2 + rng(), cd2 * 0.7, kx, topY + 0.7, kz));
        for (let i = 0, n = 2 + ((rng() * 3) | 0); i < n; i++) {
          const mh2 = 5 + rng() * (h > 70 ? 16 : 8);
          const mx2 = kx + (rng() - 0.5) * cw2 * 0.8, mz2 = kz + (rng() - 0.5) * cd2 * 0.8;
          concreteGeo.push(cyl(0.05, 0.13, mh2, mx2, topY + 1.4 + mh2 / 2, mz2, 5));
          if (rng() < 0.6) {
            concreteGeo.push(plainBox(1.1 + rng(), 0.1, 0.1, mx2, topY + 1.4 + mh2 * 0.7, mz2));
          }
          if (i === 0 && h > 55) beacons.push(new THREE.Vector3(mx2, topY + 1.6 + mh2, mz2));
        }
      }
    }
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
  function relief(v, cx, cy0, h, w, d, skipX) {
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
    // Front-row towers get the far denser streetSkin on their ±x faces, so
    // the coarse pilasters there would only fight it.
    if (!skipX && rng() < 0.7) { pil(0); pil(1); }
    if (rng() < 0.7) { pil(2); pil(3); }
    // Ledge band courses. Built as a real cornice profile, not a single thin
    // slab flush with the wall: a projecting cap over a shallower fascia, so
    // the cap overhangs by ~0.35m and throws the fascia into its own shadow.
    // The old flush 0.5m slab read from the aerial as a bright hairline seam —
    // an artifact, not a reveal. Depth is what makes it architecture.
    const step = 12 + rng() * 8;
    for (let y = cy0 + step; y < cy0 + h - 4; y += step) {
      // The three parts deliberately INTERPENETRATE by ~6cm. Butting them
      // face to face put the fascia top exactly on the cap underside, and
      // that coplanar pair is what stippled a dashed bright hairline across
      // every facade in the aerial.
      concreteGeo.push(plainBox(w + 1.30, 0.42, d + 1.30, cx.x, y + 0.21, cx.z));
      concreteGeo.push(plainBox(w + 0.58, 1.02, d + 0.58, cx.x, y - 0.45, cx.z));
      // Drip fillet under the fascia: a second, tighter shadow line.
      concreteGeo.push(plainBox(w + 0.86, 0.20, d + 0.86, cx.x, y - 0.99, cx.z));
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
          // Slab pushed 5cm into the wall — flush was coplanar with the
          // facade plane and stippled along the joint.
          concreteGeo.push(plainBox(2.4, 0.34, 1.06, bx, y, zf + face * 0.48));
          concreteGeo.push(plainBox(2.4, 0.9, 0.12, bx, y + 0.57, zf + face * 0.98));
          // Cheek walls: the balcony reads as a recess with a dark underside
          // rather than a shelf stuck onto a plane.
          concreteGeo.push(
            plainBox(0.16, 0.86, 1.0, bx - 1.2, y + 0.55, zf + face * 0.48),
            plainBox(0.16, 0.86, 1.0, bx + 1.2, y + 0.55, zf + face * 0.48),
          );
        }
      }
    }
  }

  // ---- Near-camera facade skin ------------------------------------------
  // The corridor walls are what the street and alley cameras stand against,
  // and a textured box at 2m reads as painted cardboard no matter how good
  // the texture is. Detail density has to scale UP toward the camera, so the
  // street-facing plane of every front-row tower gets real relief: floor-slab
  // courses, mullion ribs, structural pilasters, downpipes, conduit runs and
  // wall plant. Capped at 58m — nothing above that is resolved from the
  // street, and the tris are better spent low.
  function streetSkin(cx, cz, wx, wz, h, side, y0) {
    const fx = cx - (side * wx) / 2;      // street-facing plane
    const out = (t) => fx - side * t;     // t metres out toward the street
    const top = Math.min(h - 1.5, 58);
    if (top < y0 + 6) return;
    const z0 = cz - wz / 2, z1 = cz + wz / 2;
    const bandCol = rng() < 0.74 ? [0.10, 0.28, 0.33] : [0.40, 0.17, 0.06];
    // Floor-slab courses on the 3.2m texture pitch; every fourth is a deep
    // spandrel that throws a real shadow line across the face.
    let fi = 0;
    for (let y = 3.2; y < top; y += 3.2, fi++) {
      const deep = fi % 4 === 3;
      // Slab courses stand PROUD of the facade plane by 0.2-0.55m and carry a
      // thinner drip fin under them. Co-locating a slab with the wall plane is
      // what produced the bright coplanar hairlines; a slab that projects has
      // a lit top, a shaded face and a dark soffit, which is a reveal.
      concreteGeo.push(plainBox(
        deep ? 0.90 : 0.42, deep ? 0.50 : 0.26, wz - 0.25,
        out(deep ? 0.52 : 0.24), y, cz,
      ));
      concreteGeo.push(plainBox(
        deep ? 0.52 : 0.24, 0.13, wz - 0.4,
        out(deep ? 0.33 : 0.15), y - (deep ? 0.34 : 0.21), cz,
      ));
      // Every fourth slab carries a continuous light line tucked under its
      // nose. Horizontal reveals climbing a near-black wall are the single
      // most Villeneuve thing a facade can do, and they mean the wall keeps a
      // silhouette and a rhythm at exposures where the map contributes
      // nothing at all.
      if (deep) {
        // Outboard of the 0.9m slab nose and below its underside, or it is
        // swallowed by the very geometry it is meant to graze.
        pract(out(0.86), y - 0.36, cz, 0.06, 0.07, wz - 0.9,
          bandCol[0], bandCol[1], bandCol[2]);
      }
    }
    // Mullion ribs every 2m — the window-column pitch of the texture, so the
    // relief and the map agree and the openings read as recessed.
    for (let z = z0 + 1.0; z < z1 - 0.4; z += 2.0) {
      concreteGeo.push(plainBox(0.26, top - 1.2, 0.16, out(0.10), (top + 1.2) / 2, z));
    }
    // Structural pilasters every ~6m, full height.
    for (let z = z0 + 0.6; z <= z1 - 0.5; z += 6.0) {
      concreteGeo.push(plainBox(0.78, top, 1.05, out(0.30), top / 2, z));
    }
    concreteGeo.push(plainBox(0.78, top, 1.05, out(0.30), top / 2, z1 - 0.55));
    // Downpipes / risers with a hopper head.
    for (let i = 0; i < 3; i++) {
      const pz = z0 + 0.9 + rng() * (wz - 1.8);
      const ph = 10 + rng() * (top - 12);
      concreteGeo.push(cyl(0.15, 0.17, ph, out(0.64), ph / 2, pz, 6));
      if (rng() < 0.55) concreteGeo.push(plainBox(0.55, 0.5, 0.55, out(0.62), ph + 0.25, pz));
    }
    // Horizontal conduit / cable tray runs.
    for (let i = 0, n = 1 + ((rng() * 2) | 0); i < n; i++) {
      const y = y0 + 1.5 + rng() * Math.max(2, top - y0 - 6);
      concreteGeo.push(plainBox(
        0.24, 0.24, wz * (0.45 + rng() * 0.5),
        out(0.58), y, cz + (rng() - 0.5) * wz * 0.3,
      ));
    }
    // Wall plant: condensers, junction boxes, extract hoods.
    for (let i = 0, n = 4 + ((rng() * 5) | 0); i < n; i++) {
      const s = 0.55 + rng() * 1.15;
      concreteGeo.push(plainBox(
        s * 0.85, s, s * 1.25,
        out(0.36 + s * 0.42), y0 + 1 + rng() * Math.max(2, top - y0 - 4),
        z0 + 0.8 + rng() * (wz - 1.6),
      ));
    }
    // A cable-ladder stack on some walls.
    if (rng() < 0.4) {
      const lz = z0 + 1.4 + rng() * (wz - 2.8);
      const lt = Math.min(top - 2, y0 + 26);
      concreteGeo.push(
        cyl(0.07, 0.07, lt - y0, out(0.78), (lt + y0) / 2, lz - 0.3, 5),
        cyl(0.07, 0.07, lt - y0, out(0.78), (lt + y0) / 2, lz + 0.3, 5),
      );
      for (let y = y0 + 0.6; y < lt; y += 1.2) {
        concreteGeo.push(plainBox(0.06, 0.05, 0.66, out(0.78), y, lz));
      }
    }
    // --- Practicals -------------------------------------------------------
    // Guaranteed, not probabilistic. Every street-facing wall gets a stair
    // core lit top to bottom, a couple of extract-vent glows and at least one
    // warm window, so the wall reads as an inhabited building even when the
    // frame is exposed for the neon.
    {
      // Everything here sits at out(>=0.95): the pilasters reach out(0.69)
      // and the deep slab noses out(0.97), so anything closer to the wall
      // plane is inside solid concrete from the corridor's viewing angle.
      const sz1 = z0 + 1.2 + rng() * (wz - 2.4);
      const cool = [0.26, 0.56, 0.54];
      for (let y = y0 + 2.4; y < top - 1.2; y += 3.2) {
        pract(out(1.02), y, sz1, 0.06, 0.95, 0.38, cool[0], cool[1], cool[2]);
        // Side cheeks so the strip sits in a slot, visible from the corridor
        // as well as head-on.
        pract(out(0.78), y, sz1 + 0.22, 0.42, 0.95, 0.05,
          cool[0] * 0.6, cool[1] * 0.6, cool[2] * 0.6);
      }
      concreteGeo.push(
        plainBox(0.5, top - y0 - 2, 0.30, out(1.06), (top + y0) / 2, sz1 - 0.34),
        plainBox(0.5, top - y0 - 2, 0.30, out(1.06), (top + y0) / 2, sz1 + 0.44),
      );
      for (let i = 0, n = 2 + ((rng() * 3) | 0); i < n; i++) {
        const vy = y0 + 1.4 + rng() * Math.max(2, top - y0 - 5);
        const vz = z0 + 0.9 + rng() * (wz - 1.8);
        pract(out(1.14), vy, vz, 0.05, 0.18, 0.7, 0.58, 0.26, 0.08);
      }
      for (let i = 0, n = 1 + ((rng() * 2) | 0); i < n; i++) {
        const wy2 = y0 + 2.0 + rng() * Math.max(3, Math.min(top, 34) - y0 - 4);
        const wz2 = z0 + 1.2 + rng() * (wz - 2.4);
        const warm = rng() < 0.68;
        pract(
          out(1.00), wy2, wz2, 0.06, 0.9 + rng() * 0.5, 1.0 + rng() * 0.8,
          warm ? 0.86 : 0.24, warm ? 0.44 : 0.55, warm ? 0.17 : 0.78,
        );
      }
    }
  }

  // ---- Tower ------------------------------------------------------------
  function tower(spec) {
    const { cx, cz, wx, wz, h } = spec;
    const v = spec.variant ?? ((rng() * N_VARIANTS) | 0);
    const uo = rng();
    // Per-building storey pitch and sub-floor phase. Every tower sharing the
    // same 3.2m floor lines at the same absolute world heights is half of why
    // the aerial read as one module stamped across the city; +-14% pitch plus
    // a sub-storey offset decorrelates the horizontal rhythm between
    // neighbours without ever pushing the mechanical band off the ground.
    const tH = TEX_H * (0.86 + rng() * 0.28);
    const vo = (0.08 + rng() * 0.8) * (3.2 / tH);
    const hero = !!spec.hero;
    const nTiers = spec.tiers ?? (h > 120 ? 3 : h > 55 ? (rng() < 0.6 ? 2 : 1) : 1);
    let w = wx, d = wz, y = 0;
    let firstTop = h;
    const center = { x: cx, z: cz };
    for (let tIdx = 0; tIdx < nTiers; tIdx++) {
      const frac = tIdx === nTiers - 1 ? 1 : 0.45 + rng() * 0.25;
      const th = tIdx === nTiers - 1 ? h - y : Math.max(10, (h - y) * frac);
      facadeGeo[v].push(facadeBox(w, th, d, center.x, y + th / 2, center.z, uo, TEX_W, tH, vo));
      if (tIdx === 0) {
        firstTop = y + th;
        relief(v, center, y + 1, Math.min(th, h) - 1, w, d, !!spec.podium);
      }
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

      // --- Ground-floor colonnade ---------------------------------------
      // Wet concrete piers standing proud of the shopfront glass, under a
      // deep cantilevered canopy. This is the single most important
      // near-camera read in the street frames: it breaks the podium slab
      // into vertical rhythm and puts dark structure in front of the glow
      // instead of letting one flat lit plane fill a third of the frame.
      const o = (t) => faceX - side * t;
      const pz0 = cz - pd / 2, pz1 = cz + pd / 2;
      concreteGeo.push(plainBox(1.25, 0.6, pd + 0.5, o(0.5), 0.3, cz)); // kerb plinth
      // Colonnade. Seen from a grazing corridor angle the piers stack up and
      // occlude the shopfronts entirely, so each one carries a recessed
      // vertical light channel on its street face. That rhythm of light lines
      // receding down the corridor is what turns a flat wedge into depth.
      // Biased hard toward teal: signage owns magenta and sodium, so if the
      // architecture also glows orange the alley plate loses its dominant hue
      // to 0deg and the whole frame goes brown.
      const pierWarm = rng() < 0.3;
      const pcol = pierWarm ? [0.30, 0.125, 0.045] : [0.045, 0.155, 0.190];
      for (let z = pz0 + 0.9; z <= pz1 - 0.7; z += 3.2 + rng() * 1.1) {
        concreteGeo.push(plainBox(0.9, ph - 1.1, 1.05, o(0.42), (ph - 1.1) / 2 + 0.5, z));
        // Reveal cheeks either side of the channel, so the strip sits in a
        // slot rather than being pasted on. The pier body spans o(-0.03) to
        // o(0.87); everything luminous has to clear o(0.87) or it is simply
        // buried inside the concrete and contributes nothing.
        concreteGeo.push(
          plainBox(0.20, ph - 1.6, 0.30, o(0.80), (ph - 1.6) / 2 + 0.6, z - 0.32),
          plainBox(0.20, ph - 1.6, 0.30, o(0.80), (ph - 1.6) / 2 + 0.6, z + 0.32),
        );
        // Per-pier level, so the colonnade is a rhythm rather than a row of
        // identical bars — one dead pier in four is what makes the lit ones
        // read as fittings instead of a texture.
        const pk = rng() < 0.25 ? 0.18 : 0.7 + rng() * 0.5;
        pract(o(0.98), (ph - 1.9) / 2 + 0.7, z, 0.05, ph - 1.9, 0.16,
          pcol[0] * pk, pcol[1] * pk, pcol[2] * pk);
        // Channels on the pier FLANKS as well, standing 0.1m proud of the
        // pier face. Down a corridor the camera sees almost nothing but pier
        // sides, and consecutive piers occlude each other's flanks at that
        // angle unless the fitting projects past the front arris.
        for (const s2 of [-1, 1]) {
          pract(o(0.80), (ph - 2.0) / 2 + 0.75, z + s2 * 0.55, 0.22, ph - 2.0, 0.05,
            pcol[0] * pk * 0.8, pcol[1] * pk * 0.8, pcol[2] * pk * 0.8);
        }
        // Louvred vent slats on the pier flank. The pier side is the single
        // biggest surface the street camera sees and nothing lights it — but
        // a flat glowing panel would only swap a black void for a teal one.
        // Slats put the return into a rhythm: lit slat, dark concrete, lit
        // slat, so the flank carries texture as well as value.
        for (const s2 of [-1, 1]) {
          for (let sy = 1.4; sy < ph - 1.2; sy += 0.88) {
            pract(o(0.44), sy, z + s2 * 0.534, 0.80, 0.13, 0.02,
              0.016, 0.034, 0.041);
          }
        }
        // Grille / vent panel in some intercolumniations.
        if (rng() < 0.3) {
          concreteGeo.push(plainBox(0.3, 0.9, 1.4, o(0.35), 1.4 + rng() * 1.4, z + 1.7));
        }
      }
      concreteGeo.push(plainBox(1.15, 1.05, pd + 0.35, o(0.5), ph - 0.55, cz)); // lintel
      // Deep canopy + fascia over the sidewalk, on brackets.
      // The street camera stands UNDER this canopy, so its underside is the
      // single largest surface in the right of that frame. It is built as a
      // real lit arcade ceiling: a shallow luminous soffit, a run of deep
      // transverse ribs crossing it, and a continuous cove at the outer edge.
      // Previously it was one unlit slab, which is what put a featureless
      // near-black wedge across a third of the plate.
      // Projection is capped at 1.55m on purpose: the street camera sits at
      // x=8 and the facade at x~10, so a 2m canopy put its fascia INSIDE the
      // lens and handed the right of the plate to one unlit slab. Pulled back,
      // the camera stands in the street and reads the lit arcade side-on.
      const cyH = ph * 0.6 + 1.0;
      const cW = 1.62;
      concreteGeo.push(plainBox(cW, 0.34, pd * 0.9, o(0.74), cyH, cz));
      concreteGeo.push(plainBox(0.24, 0.85, pd * 0.9, o(1.47), cyH - 0.42, cz));
      for (let i = 0; i < 3; i++) {
        concreteGeo.push(plainBox(cW - 0.2, 0.14, 0.14, o(0.72), cyH + 0.5, cz + (i - 1) * pd * 0.31));
      }
      // Luminous soffit: two bands, brighter toward the cove at the outer lip.
      soffitGeo.push(plainBox(0.80, 0.05, pd * 0.88, o(0.44), cyH - 0.19, cz));
      soffitHotGeo.push(plainBox(0.62, 0.05, pd * 0.88, o(1.06), cyH - 0.19, cz));
      // Transverse ribs on ~1.1m centres. Down-facing, so the shared AO puts
      // them in their own shadow: the ceiling reads as a ribbed coffer with a
      // hard light/dark rhythm running away down the corridor.
      for (let z = pz0 + 0.5; z <= pz1 - 0.5; z += 1.1) {
        concreteGeo.push(plainBox(cW - 0.12, 0.24, 0.15, o(0.74), cyH - 0.32, z));
      }
      // Longitudinal cove baffle, hiding the strip from the far side.
      concreteGeo.push(plainBox(0.13, 0.28, pd * 0.88, o(1.36), cyH - 0.35, cz));
      // Under-canopy strip lights. The covered arcade is the motivated
      // source for everything at street level: a continuous line of it
      // running down the corridor is what makes the near walls read as
      // architecture rather than an unlit silhouette, and it gives the
      // shader's street bounce something real to be a bounce OF.
      {
        const warm = rng() < 0.62;
        const col = warm ? [1.02, 0.48, 0.16] : [0.26, 0.68, 0.88];
        const n = Math.max(3, Math.round(pd / 1.9));
        for (let i = 0; i < n; i++) {
          arcadeLights.push([
            o(1.15), cyH - 0.30, pz0 + ((i + 0.5) / n) * pd,
            col[0], col[1], col[2],
          ]);
        }
        // A second, cooler run tight against the shopfront head — two
        // temperatures in the same arcade is what stops it reading as a
        // single flat glowing bar.
        const c2 = warm ? [0.20, 0.52, 0.70] : [0.80, 0.38, 0.13];
        for (let i = 0, m = Math.max(2, Math.round(pd / 3.4)); i < m; i++) {
          arcadeLights.push([
            o(1.02), ph - 1.15, pz0 + ((i + 0.5) / m) * pd,
            c2[0], c2[1], c2[2],
          ]);
        }
        // Continuous shopfront head reveal, outboard of the pier line so it
        // is never occluded: one unbroken horizontal that draws the whole
        // corridor to its vanishing point.
        pract(o(1.02), ph - 1.62, cz, 0.05, 0.09, pd * 0.94,
          c2[0] * 0.5, c2[1] * 0.5, c2[2] * 0.5);
      }
      // Riser-door lamps and a fascia sign box on the pier line.
      for (let i = 0, n = 1 + ((rng() * 3) | 0); i < n; i++) {
        pract(o(0.20), 2.2 + rng() * (ph - 3.4), pz0 + 1 + rng() * (pd - 2),
          0.07, 0.26, 0.46, 0.90, 0.52, 0.20);
      }
      // Service plant and ducting bolted to the podium face.
      for (let i = 0, n = 3 + ((rng() * 4) | 0); i < n; i++) {
        const s = 0.5 + rng() * 0.95;
        concreteGeo.push(plainBox(
          s, s * 1.15, s * 1.4,
          o(0.85 + s * 0.45), ph * (0.66 + rng() * 0.28),
          cz + (rng() - 0.5) * pd * 0.8,
        ));
      }
      // Vertical extract duct climbing the podium onto the tower.
      {
        const dz = cz + (rng() - 0.5) * pd * 0.7;
        concreteGeo.push(cyl(0.34, 0.38, ph + 3.5, o(0.9), (ph + 3.5) / 2, dz, 6));
        concreteGeo.push(plainBox(1.0, 0.7, 1.0, o(0.9), ph + 3.8, dz));
      }
      // Relief on the tower plane above the podium (base tier only — upper
      // tiers are set back and would leave the skin floating in space).
      streetSkin(cx, cz, wx, wz, Math.min(h, firstTop), side, ph);
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
      list.push({
        cx, cz: czC, wx, wz, h,
        variant: CORRIDOR_V[rng() < 0.5 ? 0 : 1],
        podium: { faceX, side },
      });
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
  // FogExp2 0.0125 means transmission is exp(-(0.0125 d)^2): 57% at 60u, 21%
  // at 100u, 5% at 140u. A dark mass past ~110u converges on the fog colour
  // and simply is not there. So every landmark has to live inside that band
  // of whichever camera it serves. heroW sits at 90u along the aerial
  // sightline (28% transmission) and rises 107m above that camera — it is
  // the aerial's subject, and clips the left edge of the canyon frame as a
  // second depth plane.
  const heroE = { cx: 46, cz: -74, wx: 24, wz: 24, h: 190, hero: true, tiers: 3 };
  const heroW = { cx: -42, cz: -22, wx: 26, wz: 26, h: 185, hero: true, tiers: 3 };

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
    // Aerial: clear only the genuine near field. The previous 95u wedge was
    // flattening the whole mid-ground — including the hero tower that is the
    // frame's only landmark — leaving a boxed-in black canyon. Now just the
    // first ~55u is knocked down, and heroes are never touched: they ARE the
    // vista the camera is staged for.
    if (!s.hero) {
      const dx = s.cx - AER.x, dz = s.cz - AER.z;
      const d = Math.max(1e-3, Math.hypot(dx, dz) - Math.max(s.wx, s.wz) * 0.5);
      if (d < 56) {
        const along = dx * ADIR.x + dz * ADIR.z;
        if (along > 0 && along / d > 0.42) {
          const maxH = 10 + 0.66 * d;
          if (s.h > maxH) {
            s.h = maxH * (0.78 + rng() * 0.22);
            s.tiers = 1;
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
  // Right-hand landmark for the aerial: an east-wall tower at z~2 sits 90u
  // down that sightline, opposite heroW, so the frame is bracketed by two
  // masses at readable depth instead of opening onto nothing.
  const aerLM = findAt(eastRow, 2);
  if (aerLM) { aerLM.h = 138; aerLM.tiers = 3; }
  // heroW's new position collides with the nearest west back-row tower.
  {
    const i = westBack.reduce(
      (a, s, j) => (Math.hypot(s.cx + 42, s.cz + 22) < Math.hypot(westBack[a].cx + 42, westBack[a].cz + 22) ? j : a), 0);
    if (Math.hypot(westBack[i].cx + 42, westBack[i].cz + 22) < 34) westBack.splice(i, 1);
  }

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
    // Alley practicals: stair-core strips climbing both slot walls, extract
    // glow at the ducts, one warm window each side.
    for (const [zf, dir] of [[zA, -1], [zB, 1]]) {
      const sx = 12.5 + rng() * 8;
      for (let y = 3.0; y < 34; y += 3.4) {
        pract(sx, y, zf + dir * 0.16, 0.30, 0.8, 0.06, 0.26, 0.55, 0.52);
      }
      for (let i = 0; i < 3; i++) {
        pract(11.5 + rng() * 10, 2.2 + rng() * 16, zf + dir * 0.5,
          0.5, 0.16, 0.06, 0.58, 0.26, 0.08);
      }
      pract(11.5 + rng() * 10, 5 + rng() * 14, zf + dir * 0.14,
        1.1, 1.0, 0.05, 0.80, 0.42, 0.16);
    }
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
  // Near ziggurats. Placement is driven by the aerial cam's cone: from
  // (-40,78,70) along (0.411,-0.904) the readable haze band is 90-125u, and
  // the old positions sat either 55deg off-axis or 175u out, i.e. invisible.
  // These two land inside the cone at ~110u and ~130u, and the east one also
  // looms over the east wall in the street and canyon frames as a second
  // depth plane. Overlapping the back rows is intentional — the city is
  // built at the megastructure's feet.
  ziggurat(-64, -46, 80, 188, 5, true);
  ziggurat(66, -10, 60, 158, 4, true);
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
  for (let v = 0; v < facadeMats.length; v++) {
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
  // Arcade soffits. Unlit basic material so they are a flat luminous ceiling
  // plane the ribs cut across — the cheapest possible stand-in for the cove
  // wash, with zero per-pixel lighting cost.
  if (soffitGeo.length) {
    const sm = new THREE.Mesh(
      mergeGeometries(soffitGeo),
      new THREE.MeshBasicMaterial({ color: 0x30201a }),
    );
    sm.matrixAutoUpdate = false;
    group.add(sm);
  }
  if (soffitHotGeo.length) {
    const sm = new THREE.Mesh(
      mergeGeometries(soffitHotGeo),
      new THREE.MeshBasicMaterial({ color: 0x6b4526 }),
    );
    sm.matrixAutoUpdate = false;
    group.add(sm);
  }
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
        emissive: 0xffffff, emissiveIntensity: 1.9,
        roughness: 0.8, metalness: 0.1,
      });
      cityShader(m, 0.5, 0.5, 0.30);
      return m;
    },
  );
  // Massing pass: roughly half the distant towers get a setback shaft, so the
  // background is stepped masses rather than a picket fence of equal prisms.
  const distBoxes = [];
  for (const s of distSpecs) {
    if (s.h > 60 && rng() < 0.5) {
      const f = 0.42 + rng() * 0.26;
      const bh = s.h * (1 - f);
      distBoxes.push({ x: s.x, y: 0, z: s.z, w: s.w, h: bh, d: s.d });
      const ox = (rng() - 0.5) * s.w * 0.22, oz = (rng() - 0.5) * s.d * 0.22;
      distBoxes.push({
        x: s.x + ox, y: bh, z: s.z + oz,
        w: s.w * (0.58 + rng() * 0.2), h: s.h - bh, d: s.d * (0.58 + rng() * 0.2),
      });
    } else {
      distBoxes.push({ x: s.x, y: 0, z: s.z, w: s.w, h: s.h, d: s.d });
    }
  }
  const distByMat = [[], []];
  for (const s of distBoxes) distByMat[(rng() * 2) | 0].push(s);
  const tmp = new THREE.Object3D();
  const tc = new THREE.Color();
  distByMat.forEach((specs, i) => {
    const im = new THREE.InstancedMesh(distBox, distMats[i], specs.length);
    specs.forEach((s, j) => {
      tmp.position.set(s.x, s.y, s.z);
      tmp.scale.set(s.w, s.h, s.d);
      tmp.rotation.y = (rng() * 4 | 0) * (Math.PI / 2);
      tmp.updateMatrix();
      im.setMatrixAt(j, tmp.matrix);
      // Per-instance albedo tint. Two shared maps across ~90 towers is a
      // visible repeat; a +-18% cool/warm concrete drift breaks the match
      // without another texture or another draw call.
      const k = 0.82 + rng() * 0.36;
      im.setColorAt(j, tc.setRGB(k * (0.94 + rng() * 0.12), k, k * (1.04 + rng() * 0.1)));
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.matrixAutoUpdate = false;
    group.add(im);
  });

  // ---- Distant roof crowns ----------------------------------------------
  // The background skyline was ~90 flat-topped prisms. Villeneuve reads that
  // skyline entirely by silhouette, so every distant tower is capped with one
  // of three crowns — machine-room setback, open frame, tank cluster — built
  // in absolute metres and instanced at uniform scale so nothing distorts.
  const crownMat = new THREE.MeshStandardMaterial({
    color: 0x141a24, roughness: 0.85, metalness: 0.1,
  });
  concreteShader(crownMat, 0.4, 0.9, 0.45);
  const CR = 7.0; // crown footprint half-width, metres
  const crownGeos = [
    // 0: stepped machine room + mast
    mergeGeometries([
      plainBox(CR * 2, 0.9, CR * 2, 0, 0.45, 0),
      plainBox(CR * 1.15, 4.2, CR * 1.15, 0, 3.0, 0),
      plainBox(CR * 1.3, 0.5, CR * 1.3, 0, 5.3, 0),
      plainBox(CR * 0.6, 3.0, CR * 0.6, CR * 0.2, 7.0, -CR * 0.15),
      cyl(0.14, 0.22, 11, -CR * 0.4, 11.5, CR * 0.3, 5),
    ]),
    // 1: open structural frame / gantry
    mergeGeometries([
      plainBox(CR * 2, 0.7, CR * 2, 0, 0.35, 0),
      plainBox(0.6, 9.5, 0.6, -CR * 0.8, 5.0, -CR * 0.8),
      plainBox(0.6, 9.5, 0.6, CR * 0.8, 5.0, -CR * 0.8),
      plainBox(0.6, 9.5, 0.6, -CR * 0.8, 5.0, CR * 0.8),
      plainBox(0.6, 9.5, 0.6, CR * 0.8, 5.0, CR * 0.8),
      plainBox(CR * 1.9, 0.55, 0.55, 0, 9.6, -CR * 0.8),
      plainBox(CR * 1.9, 0.55, 0.55, 0, 9.6, CR * 0.8),
      plainBox(0.55, 0.55, CR * 1.9, -CR * 0.8, 9.6, 0),
      plainBox(0.55, 0.55, CR * 1.9, CR * 0.8, 9.6, 0),
      plainBox(CR * 1.3, 0.45, CR * 1.3, 0, 5.6, 0),
      cyl(0.12, 0.18, 8, 0, 13.8, 0, 5),
    ]),
    // 2: tank + cooling cluster
    mergeGeometries([
      plainBox(CR * 2, 1.0, CR * 2, 0, 0.5, 0),
      cyl(2.1, 2.3, 5.0, -CR * 0.45, 3.5, -CR * 0.3, 8),
      cyl(2.4, 2.4, 0.4, -CR * 0.45, 6.2, -CR * 0.3, 8),
      cyl(1.5, 1.7, 3.6, CR * 0.5, 2.8, CR * 0.35, 8),
      plainBox(CR * 0.9, 2.4, CR * 0.7, CR * 0.35, 2.2, -CR * 0.55),
      cyl(0.11, 0.16, 9, -CR * 0.75, 9.5, CR * 0.7, 5),
      plainBox(1.6, 0.16, CR * 1.4, 0, 5.3, 0),
    ]),
  ];
  const crownBuckets = [[], [], []];
  for (const s of distSpecs) {
    if (s.h < 34) continue;
    crownBuckets[(rng() * 3) | 0].push(s);
    if (s.h > 130 && rng() < 0.7) beacons.push(new THREE.Vector3(s.x, s.h + 12, s.z));
  }
  crownBuckets.forEach((specs, i) => {
    if (!specs.length) return;
    const im = new THREE.InstancedMesh(crownGeos[i], crownMat, specs.length);
    specs.forEach((s, j) => {
      const k = Math.min(s.w, s.d) / (CR * 2) * (0.85 + rng() * 0.35);
      tmp.position.set(s.x, s.h - 0.2, s.z);
      tmp.scale.set(k, k * (0.8 + rng() * 0.6), k);
      tmp.rotation.y = (rng() * 4 | 0) * (Math.PI / 2);
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
      new THREE.BoxGeometry(0.5, 0.34, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xd08838 }),
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

  // Under-canopy arcade strips: per-instance colour, one draw call.
  if (arcadeLights.length) {
    // Deliberately slender. At 0.8m across these read as glowing billboards
    // when the camera stands 3m away — a strip light has to be a strip.
    const alMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.13, 0.07, 2.0),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      arcadeLights.length,
    );
    const c = new THREE.Color();
    arcadeLights.forEach((p, i) => {
      tmp.position.set(p[0], p[1], p[2]);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      alMesh.setMatrixAt(i, tmp.matrix);
      alMesh.setColorAt(i, c.setRGB(p[3], p[4], p[5]));
    });
    alMesh.instanceMatrix.needsUpdate = true;
    if (alMesh.instanceColor) alMesh.instanceColor.needsUpdate = true;
    alMesh.matrixAutoUpdate = false;
    group.add(alMesh);
  }

  // Facade practicals: per-instance size AND colour, one draw call.
  if (practicals.length) {
    const pMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      practicals.length,
    );
    const pc = new THREE.Color();
    practicals.forEach((p, i) => {
      tmp.position.set(p[0], p[1], p[2]);
      tmp.scale.set(p[3], p[4], p[5]);
      tmp.rotation.y = 0;
      tmp.updateMatrix();
      pMesh.setMatrixAt(i, tmp.matrix);
      pMesh.setColorAt(i, pc.setRGB(p[6], p[7], p[8]));
    });
    pMesh.instanceMatrix.needsUpdate = true;
    if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
    pMesh.matrixAutoUpdate = false;
    group.add(pMesh);
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
