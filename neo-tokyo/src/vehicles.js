import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './city.js';

// VEHICLES — spinners, distant traffic rivers, kerbside street cars.
// Owned by the VEHICLES agent.
//
// All motion is a pure function of elapsed time t (deterministic screenshots).
//
// Look notes (BR2049):
//  * Hulls are near-black wet metal. They are NOT lit by scene lights — a
//    cheap custom shader fakes the only light that exists here: cool sky from
//    above, sodium street-bounce on the belly, and a coloured neon rim picked
//    per-facet from whichever side of the canyon it faces. Nothing on a hull
//    exceeds the bloom threshold except the lamp lenses.
//  * Beams are soft volumetric cones: a single BackSide shell whose density
//    is pow(|N.V|,k) — max through the middle, zero at the silhouette — so
//    they read as haze, never as an opaque wedge. They also self-attenuate
//    with the scene's FogExp2 transmittance so distant beams do not punch
//    through the aerial perspective.
//  * NO real lights are added. Every spill is baked into emissive geometry.
//  * One hero spinner passes ~26m from the street camera, banked into a
//    turn, so the frame has a machine with weight and scale in it.

const UP = new THREE.Vector3(0, 1, 0);
// Matches atmosphere.js FogExp2 density — beams fade into the same haze.
const FOG_K = 0.0118;

// ---------------------------------------------------------------------------
// small geometry helpers
// ---------------------------------------------------------------------------
function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function cyl(rt, rb, h, seg, x, y, z, alongZ = true) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (alongZ) g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

// Attach a flat vertex color to a geometry (for merged emissive light packs).
function paint(g, r, gr, b) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = r; arr[i * 3 + 1] = gr; arr[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

// Flat annulus, normal +z (or -z when faceBack) — engine rings read as rings,
// never as filled glowing discs.
function ring(inner, outer, seg, x, y, z, faceBack = false) {
  const g = new THREE.RingGeometry(inner, outer, seg);
  if (faceBack) g.rotateY(Math.PI);
  g.translate(x, y, z);
  return g;
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// WET METAL — the only "lighting" a hull gets. Cheap, unlit, fog-aware.
// ---------------------------------------------------------------------------
const wetVert = /* glsl */`
  varying vec3 vWNormal;
  varying vec3 vWPos;
  varying vec3 vOPos;
  #include <fog_pars_vertex>
  void main() {
    vOPos = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWPos = wp.xyz;
    vWNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const wetFrag = /* glsl */`
  precision highp float;
  uniform vec3 uBase, uSky, uBelly, uRimA, uRimB, uGloss, uSheenCol, uKey;
  uniform float uRimGain, uRimPow, uSheen, uSheenPow, uGlossPow, uWrap;
  uniform float uPanel, uPanelScale, uPanelFade;
  varying vec3 vWNormal;
  varying vec3 vWPos;
  varying vec3 vOPos;
  #include <fog_pars_fragment>

  void main() {
    vec3 N = normalize(vWNormal);
    vec3 d = cameraPosition - vWPos;
    float dist = length(d);
    vec3 V = d / max(dist, 1e-4);

    float ndv = clamp(dot(N, V), 0.0, 1.0);
    // Rim windowed AWAY from the exact silhouette. pow(1-ndv,k) peaks at
    // ndv=0, i.e. on a 1px-wide edge; with no MSAA in the composer target
    // that reads as a dashed white outline. Pulling the peak just inside the
    // silhouette keeps the wet-edge read and kills the crawling.
    float fres = pow(1.0 - ndv, uRimPow) * mix(0.22, 1.0, smoothstep(0.0, 0.13, ndv));

    float up = max(N.y, 0.0);
    float dn = max(-N.y, 0.0);

    // Which side of the canyon this facet faces decides its neon rim colour.
    // Weighted by |N.x|: the neon lives on the WALLS, so a facet that does not
    // look sideways barely sees it. Without this weighting a near-horizontal
    // panel viewed from a low camera sits at grazing incidence, takes the full
    // fresnel, and — with N.x ~ 0 averaging magenta and cyan together — turns
    // into a pale lavender slab. That is what made the parked cars read white.
    vec3 rim = mix(uRimA, uRimB, clamp(N.x * 0.5 + 0.5, 0.0, 1.0));
    rim *= 0.28 + 0.72 * abs(N.x);

    vec3 col = uBase;
    col += uSky * pow(up, 1.5);          // cool overcast from above
    col += uBelly * pow(dn, 1.3);        // sodium street-bounce underneath
    col += rim * (fres * uRimGain);      // hazed neon rim-light
    // Lateral neon wrap: the two canyon walls act as huge coloured area
    // sources, so flanks pick up magenta on one side and cyan on the other.
    // Without this a hull seen from the street is one flat monochrome mass.
    col += uRimA * (uWrap * max(N.x, 0.0)) + uRimB * (uWrap * max(-N.x, 0.0));
    col += uSheenCol * (uSheen * pow(up, uSheenPow));   // wet horizontal sheen

    vec3 H = normalize(uKey + V);
    col += uGloss * pow(max(dot(N, H), 0.0), uGlossPow); // wet gloss streak

    // Panel grooves, faded out with distance so they never shimmer.
    vec2 q = vec2(vOPos.z, vOPos.x) * uPanelScale;
    vec2 f = abs(fract(q + 0.5) - 0.5) * 2.0;
    float groove = 1.0 - smoothstep(0.0, 0.09, min(f.x, f.y));
    groove *= uPanel * (1.0 - smoothstep(uPanelFade * 0.4, uPanelFade, dist));
    col *= 1.0 - 0.30 * groove;

    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

const C = (hex) => new THREE.Color(hex);

function makeWetMaterial(o) {
  return new THREE.ShaderMaterial({
    fog: true,
    vertexShader: wetVert,
    fragmentShader: wetFrag,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uBase: { value: o.base.clone() },
        uSky: { value: o.sky.clone() },
        uBelly: { value: o.belly.clone() },
        uRimA: { value: o.rimA.clone() },
        uRimB: { value: o.rimB.clone() },
        uGloss: { value: o.gloss.clone() },
        uSheenCol: { value: (o.sheenCol ?? o.gloss).clone() },
        uKey: { value: o.key.clone().normalize() },
        uRimGain: { value: o.rimGain },
        uRimPow: { value: o.rimPow },
        uSheen: { value: o.sheen ?? 0 },
        uSheenPow: { value: o.sheenPow ?? 6 },
        uGlossPow: { value: o.glossPow ?? 44 },
        uWrap: { value: o.wrap ?? 0.10 },
        uPanel: { value: o.panel ?? 0.8 },
        uPanelScale: { value: o.panelScale ?? 1.15 },
        uPanelFade: { value: o.panelFade ?? 52 },
      },
    ]),
  });
}

// ---------------------------------------------------------------------------
// SOFT VOLUMETRIC BEAM — one BackSide cone shell, density peaks through the
// middle of the cone and vanishes at the silhouette, so the edge is soft.
// Unit cone: apex at origin, base radius 1 at z = 1. aAxial carries the
// normalised 0..1 axial coordinate so cones can be pre-scaled and merged.
// ---------------------------------------------------------------------------
const beamVert = /* glsl */`
  attribute float aAxial;
  varying float vAx;
  varying vec3 vN;
  varying vec3 vV;
  varying float vDepth;
  void main() {
    vAx = aAxial;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = -mv.xyz;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const beamFrag = /* glsl */`
  precision highp float;
  uniform vec3 uColor;
  uniform float uIntensity, uEdge, uFall, uFloor;
  varying float vAx;
  varying vec3 vN;
  varying vec3 vV;
  varying float vDepth;
  void main() {
    float z = clamp(vAx, 0.0, 1.0);
    float nv = abs(dot(normalize(vN), normalize(vV)));
    // shell density: thick through the core of the cone, zero at its edge
    float dens = uFloor + (1.0 - uFloor) * pow(nv, uEdge);
    // axial: hottest at the emitter, soft tip, no hard point at the apex
    float axial = pow(1.0 - z, uFall) * smoothstep(0.0, 0.10, z);
    float h = vDepth * ${FOG_K.toFixed(5)};
    float haze = exp(-h * h);            // sink into the same aerial perspective
    gl_FragColor = vec4(uColor * (dens * axial * uIntensity * haze), 1.0);
  }
`;

function makeBeamMaterial(color, intensity, { edge = 1.35, fall = 2.0, floorV = 0.15 } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: beamVert,
    fragmentShader: beamFrag,
    uniforms: {
      uColor: { value: color.clone() },
      uIntensity: { value: intensity },
      uEdge: { value: edge },
      uFall: { value: fall },
      uFloor: { value: floorV },
    },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });
}

function unitBeamCone(radial = 14) {
  const g = new THREE.ConeGeometry(1, 1, radial, 1, true);
  g.rotateX(-Math.PI / 2);     // apex -> -z, base -> +z
  g.translate(0, 0, 0.5);      // apex at z=0, base at z=1
  const pos = g.attributes.position;
  const ax = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) ax[i] = pos.getZ(i);
  g.setAttribute('aAxial', new THREE.BufferAttribute(ax, 1));
  return g;
}

// Elliptical, aimed beam baked into a mergeable geometry.
function shapedBeam({ rx, ry, len, x, y, z, yaw = 0, pitch = 0, radial = 14 }) {
  const g = unitBeamCone(radial);
  g.scale(rx, ry, len);
  if (pitch) g.rotateX(pitch);
  if (yaw) g.rotateY(yaw);
  g.translate(x, y, z);
  return g;
}

// ---------------------------------------------------------------------------
// Spinner hull: readable silhouette — chined fuselage, canopy, outboard engine
// nacelles, tail fins and deployed skids. Nose toward +z.
//
// Everything below is authored in a convenient 1:1 frame and then squashed by
// SPINNER_PROP: short, wide and squat is what makes a spinner read as a
// spinner rather than a bus. Applied to hull, glass, lamps and beams alike so
// every mount point stays welded to the body.
// ---------------------------------------------------------------------------
const SPINNER_PROP = new THREE.Matrix4().makeScale(1.24, 1.30, 0.80);
const prop = (g) => g.applyMatrix4(SPINNER_PROP);

function makeSpinnerHullGeo() {
  const g = [];
  // primary mass
  g.push(box(1.90, 0.56, 4.00, 0, 0.02, -0.10));
  g.push(box(1.52, 0.30, 3.40, 0, -0.38, -0.10));   // belly taper
  g.push(box(1.66, 0.26, 1.55, 0, 0.34, 1.40));     // forward deck
  g.push(box(1.34, 0.44, 1.30, 0, -0.06, 2.45));    // nose block
  g.push(box(0.92, 0.30, 0.80, 0, -0.10, 3.15));    // nose tip
  g.push(box(1.24, 0.16, 0.60, 0, 0.20, 3.28));     // lamp shroud

  // canopy frame (glass is a separate mesh)
  g.push(box(1.28, 0.12, 1.82, 0, 0.80, 0.58));     // roof rail
  for (const s of [-1, 1]) {
    g.push(box(0.13, 0.56, 1.78, s * 0.63, 0.52, 0.58));  // side pillar
    g.push(box(0.13, 0.36, 0.85, s * 0.55, 0.46, 1.55));  // A-pillar
  }
  g.push(box(1.22, 0.14, 0.14, 0, 0.62, 1.96));     // windscreen header

  for (const s of [-1, 1]) {
    // chine plates — the wide flare that gives the silhouette
    g.push(box(0.95, 0.17, 2.60, s * 1.32, -0.06, 0.10));
    g.push(box(0.58, 0.15, 1.15, s * 1.62, -0.06, -1.35));
    // engine nacelle
    g.push(cyl(0.30, 0.30, 2.55, 10, s * 1.44, -0.30, -0.30));
    g.push(cyl(0.24, 0.33, 0.55, 10, s * 1.44, -0.30, 1.22));   // intake lip
    g.push(cyl(0.35, 0.25, 0.50, 10, s * 1.44, -0.30, -1.78));  // nozzle
    g.push(box(0.75, 0.16, 1.50, s * 0.95, -0.22, -0.30));      // pylon
    // deployed skid
    g.push(box(0.14, 0.44, 0.14, s * 1.20, -0.74, 0.85));
    g.push(box(0.14, 0.44, 0.14, s * 1.20, -0.74, -0.85));
    g.push(box(0.19, 0.15, 2.55, s * 1.20, -0.98, 0.00));
    // tail fin
    g.push(box(0.14, 0.80, 0.95, s * 0.78, 0.62, -1.82));
  }

  // dorsal + tail greeble
  g.push(box(0.86, 0.20, 1.70, 0, 0.40, -1.30));    // spine
  g.push(box(0.46, 0.24, 0.55, 0.34, 0.52, -0.72)); // sensor box
  g.push(box(0.30, 0.28, 0.30, -0.46, 0.50, -1.92));
  g.push(box(2.30, 0.15, 0.70, 0, 0.44, -2.22));    // tail plane
  g.push(box(1.50, 0.34, 0.90, 0, 0.10, -2.05));    // rear deck

  // VENTRAL detail. A street camera looks UP at these craft, so the underside
  // is the hero surface: turret, gear bay doors, spine rail, nacelle strakes.
  g.push(box(0.98, 0.22, 1.05, 0, -0.60, 0.35));    // belly pod
  g.push(box(0.60, 0.20, 0.60, 0, -0.70, 1.35));    // turret housing
  const turret = new THREE.SphereGeometry(0.22, 10, 6);
  turret.translate(0, -0.82, 1.35);
  g.push(turret);
  g.push(box(0.32, 0.15, 2.15, 0, -0.72, -0.55));   // ventral spine rail
  for (const s of [-1, 1]) {
    g.push(box(0.52, 0.11, 1.25, s * 0.52, -0.70, -0.60)); // gear bay door
    g.push(box(0.10, 0.11, 1.70, s * 1.44, -0.60, -0.35)); // nacelle keel strake
    g.push(box(0.13, 0.22, 1.25, s * 1.44, 0.02, 0.35));   // nacelle dorsal strake
    g.push(box(0.30, 0.11, 0.16, s * 0.80, -0.66, -1.75)); // vent louvre
    g.push(box(0.30, 0.11, 0.16, s * 0.80, -0.66, -1.50));
  }
  return prop(mergeGeometries(g));
}

function makeSpinnerGlassGeo() {
  const g = [];
  g.push(box(1.18, 0.50, 1.72, 0, 0.52, 0.58));
  g.push(box(1.02, 0.32, 0.82, 0, 0.44, 1.56));
  return prop(mergeGeometries(g));
}

// Emissive light pack (merged, vertex-coloured).
// Only these exceed the bloom threshold, and only in tight slivers.
function makeSpinnerLightsGeo() {
  const g = [];
  for (const s of [-1, 1]) {
    // headlight: a wide THIN bar, so bloom + the anamorphic streak read as a
    // lens flare rather than a round white ball.
    g.push(paint(box(0.36, 0.085, 0.06, s * 0.36, 0.20, 3.60), 1.55, 1.06, 0.50));
    g.push(paint(box(0.11, 0.055, 0.06, s * 0.36, 0.20, 3.618), 2.20, 1.66, 0.96));
    // nacelle intake ring — cold plasma (annulus, seen from ahead only)
    g.push(paint(ring(0.155, 0.225, 12, s * 1.44, -0.30, 1.46), 0.18, 0.55, 0.86));
    // nozzle glow ring — hot, but an outline: a filled disc reads as a headlamp
    g.push(paint(ring(0.105, 0.185, 12, s * 1.44, -0.30, -2.04, true), 0.95, 0.28, 0.08));
    // tail bar
    g.push(paint(box(0.46, 0.105, 0.06, s * 0.44, 0.22, -2.53), 1.25, 0.07, 0.06));
    // belly floods (small warm patches, face down)
    g.push(paint(box(0.24, 0.065, 0.32, s * 0.46, -0.745, 0.62), 0.95, 0.56, 0.22));
    g.push(paint(box(0.24, 0.065, 0.32, s * 0.46, -0.765, -1.05), 0.80, 0.46, 0.18));
  }
  // ventral formation strip + turret lens
  g.push(paint(box(0.13, 0.055, 2.10, 0, -0.815, -0.55), 0.12, 0.44, 0.60));
  g.push(paint(box(0.17, 0.065, 0.17, 0, -0.91, 1.42), 0.90, 0.86, 0.70));
  // port red / starboard green nav lights (port is local +x, nose = +z)
  g.push(paint(box(0.09, 0.09, 0.15, 1.76, -0.30, 1.20), 1.70, 0.06, 0.05));
  g.push(paint(box(0.09, 0.09, 0.15, -1.76, -0.30, 1.20), 0.06, 1.60, 0.28));
  // cockpit instrument wash, dim cyan, sits inside the glass
  g.push(paint(box(0.86, 0.075, 0.06, 0, 0.40, 1.30), 0.16, 0.50, 0.66));
  g.push(paint(box(0.10, 0.05, 0.55, 0.30, 0.32, 0.85), 0.10, 0.34, 0.46));
  return prop(mergeGeometries(g));
}

function makeStrobeGeo() {
  const g = [];
  const a = new THREE.SphereGeometry(0.13, 6, 4);
  a.translate(0.78, 1.04, -1.82);
  const b = new THREE.SphereGeometry(0.11, 6, 4);
  b.translate(0, -0.70, 0.70);
  g.push(a, b);
  return prop(mergeGeometries(g));
}

// Two elliptical head beams, merged: wide and flat, aimed slightly down.
function makeHeadBeamGeo() {
  return prop(mergeGeometries([
    shapedBeam({ rx: 1.45, ry: 0.90, len: 12, x: -0.36, y: 0.18, z: 3.4, yaw: -0.055, pitch: 0.07 }),
    shapedBeam({ rx: 1.45, ry: 0.90, len: 12, x: 0.36, y: 0.18, z: 3.4, yaw: 0.055, pitch: 0.07 }),
  ]));
}

// Downward flood from the belly — only fitted to craft flying low enough for
// it to land on the street. Reads as the spinner dragging a pool of warm
// light across the wet tarmac.
function makeBellyBeamGeo() {
  const g = unitBeamCone(16);
  g.scale(2.30, 2.30, 13);
  g.rotateX(Math.PI / 2);          // +z -> -y
  g.translate(0, -0.85, 0.20);
  return prop(g);
}

// ---------------------------------------------------------------------------
// Kerbside street car: low armoured sedan, wet dark paint.
// ---------------------------------------------------------------------------
function makeCarBodyGeo() {
  const g = [];
  g.push(box(1.98, 0.50, 4.60, 0, 0.58, 0));        // main slab
  g.push(box(1.86, 0.34, 4.15, 0, 0.24, 0));        // skirt
  g.push(box(1.72, 0.16, 2.90, 0, 0.84, -0.35));    // shoulder / beltline
  g.push(box(1.60, 0.46, 2.05, 0, 1.10, -0.45));    // cabin roof mass
  g.push(box(1.50, 0.10, 2.10, 0, 1.34, -0.45));    // roof plate
  g.push(box(1.94, 0.30, 0.95, 0, 0.44, 2.62));     // front wedge
  g.push(box(1.80, 0.18, 0.40, 0, 0.66, 2.92));     // splitter lip
  g.push(box(1.94, 0.34, 0.60, 0, 0.52, -2.55));    // rear bumper
  g.push(box(1.66, 0.14, 0.30, 0, 0.90, -2.44));    // boot lip
  for (const sx of [-1, 1]) {
    g.push(box(0.10, 0.22, 0.34, sx * 1.05, 1.02, 1.05));   // mirror stalk + head
    g.push(box(0.20, 0.16, 0.10, sx * 1.16, 1.02, 1.02));
    for (const sz of [-1, 1]) {
      const wh = new THREE.CylinderGeometry(0.38, 0.38, 0.28, 10);
      wh.rotateZ(Math.PI / 2);                                   // axle along x
      wh.translate(sx * 0.92, 0.38, sz * 1.52);
      g.push(wh);
      g.push(box(0.14, 0.34, 1.00, sx * 0.99, 0.52, sz * 1.52)); // arch blister
    }
  }
  g.push(box(0.52, 0.12, 0.90, -0.52, 1.44, -0.55)); // roof vent
  g.push(box(0.16, 0.30, 0.16, 0.56, 1.52, -1.10));  // aerial pod
  return mergeGeometries(g);
}

function makeCarGlassGeo() {
  const g = [];
  g.push(box(1.54, 0.34, 0.72, 0, 1.06, 0.86));     // windscreen
  g.push(box(1.52, 0.30, 1.90, 0, 1.14, -0.45));    // side glass band
  g.push(box(1.44, 0.30, 0.30, 0, 1.06, -1.62));    // backlight
  return mergeGeometries(g);
}

function makeCarLightsGeo() {
  const g = [];
  for (const s of [-1, 1]) {
    g.push(paint(box(0.44, 0.07, 0.04, s * 0.60, 0.66, -2.88), 1.35, 0.05, 0.04)); // tail bar
    g.push(paint(box(0.30, 0.05, 0.04, s * 0.66, 0.60, 3.10), 0.55, 0.36, 0.12));  // parking lamp
  }
  g.push(paint(box(1.10, 0.03, 0.04, 0, 0.72, -2.885), 0.55, 0.03, 0.03));         // link strip
  g.push(paint(box(0.05, 0.05, 1.90, 0.98, 0.14, 0), 0.30, 0.10, 0.42));           // sill accent
  g.push(paint(box(0.05, 0.05, 1.90, -0.98, 0.14, 0), 0.10, 0.26, 0.40));
  return mergeGeometries(g);
}

// ---------------------------------------------------------------------------
// Flight lanes — smooth parametric paths; pos is a pure function of u.
// ---------------------------------------------------------------------------
function laneAlongZ({ x0, amp, om, ph, y, zStart, dirZ, len, speed }) {
  return {
    len, speed,
    pos(u, out) {
      out.set(
        x0 + amp * Math.sin(u * om + ph),
        y + 1.4 * Math.sin(u * 0.02 + ph * 2.0),
        zStart + dirZ * u,
      );
      return out;
    },
  };
}

function laneAcrossX({ y, zBase, zAmp, zOm, ph, xStart, dirX, len, speed }) {
  return {
    len, speed,
    pos(u, out) {
      out.set(
        xStart + dirX * u,
        y + 1.2 * Math.sin(u * 0.018 + ph),
        zBase + zAmp * Math.sin(u * zOm + ph),
      );
      return out;
    },
  };
}

// Hero lane: a low, close pass across the near end of the corridor. Tuned so
// that at the screenshot time (t=12) the craft sits ~26m from the street
// camera at a 3/4 attitude — it is banking hard right out of the weave, so
// the bank is motivated by the path itself, not pasted on.
//   x(u) = -1.2 + 7 sin(0.055(u-64) - 0.3961)  ->  x=-3.9, dx/du=+0.355 at u=64
//   z(u) = 76 - u                              ->  z=12
//   phase 184 + speed 15 * t=12 = 364; 364 mod 300 = 64.
const HERO_U = 64;
const heroLane = {
  len: 300, speed: 15,
  pos(u, out) {
    const s = u - HERO_U;
    out.set(
      -1.2 + 7.0 * Math.sin(s * 0.055 - 0.39614),
      9.4 + 2.2 * (Math.sin(s * 0.024 + 2.5) - 0.59847),
      76 - u,
    );
    return out;
  },
};

// ---------------------------------------------------------------------------
// Distant traffic rivers: instanced emissive streaks on high straight lanes.
// ---------------------------------------------------------------------------
function makeStreakLane(rng, { origin, dir, len, count, speed, yaw, tint, spread }) {
  const geo = new THREE.BoxGeometry(0.26, 0.2, 3.8); // long axis +z
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    fog: false,
  });
  const im = new THREE.InstancedMesh(geo, mat, count);
  const items = [];
  const c = new THREE.Color();
  const perp = new THREE.Vector3().crossVectors(dir, UP).normalize();
  for (let i = 0; i < count; i++) {
    const s0 = (i / count) * len + (rng() - 0.5) * (len / count) * 0.8;
    const lateral = (rng() - 0.5) * spread;
    const dy = (rng() - 0.5) * spread * 0.55;
    const stretch = 0.9 + rng() * 1.8;
    items.push({ s0, lateral, dy, stretch });
    const b = 0.45 + rng() * 0.55;
    c.setRGB(tint[0] * b, tint[1] * b, tint[2] * b);
    im.setColorAt(i, c);
  }
  im.instanceColor.needsUpdate = true;
  im.frustumCulled = false;
  const tmp = new THREE.Object3D();
  return {
    mesh: im,
    update(t) {
      for (let i = 0; i < count; i++) {
        const it = items[i];
        const s = (it.s0 + speed * t) % len;
        tmp.position.copy(origin)
          .addScaledVector(dir, s)
          .addScaledVector(perp, it.lateral);
        tmp.position.y += it.dy;
        tmp.rotation.set(0, yaw, 0);
        tmp.scale.set(1, 1, it.stretch);
        tmp.updateMatrix();
        im.setMatrixAt(i, tmp.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
export function buildVehicles() {
  const group = new THREE.Group();
  const rng = mulberry32(90210);

  // ---- shared geometry ---------------------------------------------------
  const hullGeo = makeSpinnerHullGeo();
  const glassGeo = makeSpinnerGlassGeo();
  const lightsGeo = makeSpinnerLightsGeo();
  const beamGeo = makeHeadBeamGeo();
  const strobeGeo = makeStrobeGeo();

  // ---- shared materials --------------------------------------------------
  const hullMat = makeWetMaterial({
    base: C(0x000000).setRGB(0.015, 0.022, 0.032),
    sky: C(0x000000).setRGB(0.062, 0.086, 0.118),
    belly: C(0x000000).setRGB(0.050, 0.043, 0.040),   // sodium street bounce
    rimA: C(0x000000).setRGB(0.98, 0.16, 0.58),       // magenta side
    rimB: C(0x000000).setRGB(0.18, 0.76, 1.00),       // cyan side
    gloss: C(0x000000).setRGB(0.16, 0.21, 0.30),
    sheenCol: C(0x000000).setRGB(0.20, 0.29, 0.42),
    // Key is deliberately LOW and lateral (a sign on a wall, not the sky):
    // a street camera looks up at these craft, so up-facing planes project to
    // sub-pixel slivers and any highlight parked on them aliases into a
    // dotted line. Lighting the flanks instead puts the wet gloss on the
    // surfaces that actually have screen area.
    key: new THREE.Vector3(0.55, 0.32, 0.78),
    rimGain: 0.62, rimPow: 2.6, glossPow: 55, wrap: 0.046,
    sheen: 0.07, sheenPow: 4.0,
    panel: 0.55, panelScale: 0.80, panelFade: 55,
  });

  const glassMat = makeWetMaterial({
    base: C(0x000000).setRGB(0.006, 0.010, 0.016),
    sky: C(0x000000).setRGB(0.030, 0.044, 0.070),
    belly: C(0x000000).setRGB(0.030, 0.020, 0.012),
    rimA: C(0x000000).setRGB(1.00, 0.30, 0.72),
    rimB: C(0x000000).setRGB(0.30, 0.86, 1.00),
    gloss: C(0x000000).setRGB(0.52, 0.62, 0.82),
    key: new THREE.Vector3(0.50, 0.42, 0.76),
    rimGain: 0.55, rimPow: 2.2, glossPow: 60, wrap: 0.070,
    panel: 0.0, panelScale: 1.0, panelFade: 30,
  });

  const lightsMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  const beamMat = makeBeamMaterial(
    C(0x000000).setRGB(0.80, 0.62, 0.34), 0.80, { edge: 1.30, fall: 2.0, floorV: 0.085 },
  );
  const strobeMat = new THREE.MeshBasicMaterial({ color: 0xff3a44, fog: false });

  function assembleSpinner(scale) {
    const g = new THREE.Group();
    const hull = new THREE.Mesh(hullGeo, hullMat);
    const glass = new THREE.Mesh(glassGeo, glassMat);
    const lights = new THREE.Mesh(lightsGeo, lightsMat);
    const beams = new THREE.Mesh(beamGeo, beamMat);
    const strobe = new THREE.Mesh(strobeGeo, strobeMat);
    beams.frustumCulled = false;
    g.add(hull, glass, lights, beams, strobe);
    g.scale.setScalar(scale);
    group.add(g);
    return { g, strobe };
  }

  // ---- lanes + traffic spinners ------------------------------------------
  const lanes = {
    L1: laneAlongZ({ x0: -3.5, amp: 4.5, om: 0.035, ph: 0.5, y: 27, zStart: 70, dirZ: -1, len: 330, speed: 16 }),
    L2: laneAlongZ({ x0: 4.0, amp: 4.0, om: 0.03, ph: 2.1, y: 41, zStart: -260, dirZ: 1, len: 330, speed: 14 }),
    L3: laneAcrossX({ y: 66, zBase: -88, zAmp: 20, zOm: 0.012, ph: 0.8, xStart: -240, dirX: 1, len: 480, speed: 22 }),
    L4: laneAlongZ({ x0: 0.5, amp: 6.0, om: 0.028, ph: 4.0, y: 54, zStart: 60, dirZ: -1, len: 320, speed: 18 }),
  };
  // phases picked so several craft sit inside the hero frames at t=12
  const spinners = [
    { lane: lanes.L1, phase: 268 },
    { lane: lanes.L1, phase: 3 },
    { lane: lanes.L2, phase: 57 },
    { lane: lanes.L2, phase: 100 },
    { lane: lanes.L3, phase: 466 },
    { lane: lanes.L4, phase: 264 },
    // hero: the close pass. speed*12 = 180, so phase 184 puts u at 64 at t=12.
    { lane: heroLane, phase: 184, scale: 1.20 },
  ];
  for (const sp of spinners) {
    Object.assign(sp, assembleSpinner(sp.scale ?? 0.95 + rng() * 0.35));
    sp.strobePhase = rng();
    sp.bobPhase = rng() * Math.PI * 2;
  }

  // ---- police spinner ----------------------------------------------------
  const police = assembleSpinner(1.15);
  const barR = new THREE.Mesh(
    box(0.36, 0.10, 0.29, -0.384, 1.008, 0.252),
    new THREE.MeshBasicMaterial({ color: 0xff2030, fog: false }),
  );
  const barB = new THREE.Mesh(
    box(0.36, 0.10, 0.29, 0.384, 1.008, 0.252),
    new THREE.MeshBasicMaterial({ color: 0x2050ff, fog: false }),
  );
  police.g.add(barR, barB);

  // searchlight: soft volumetric cone, no real light. Deliberately dim — it
  // is a shaft of hazed air, not a spotlight painted onto the frame.
  const searchCone = new THREE.Mesh(
    unitBeamCone(16),
    makeBeamMaterial(
      C(0x000000).setRGB(0.42, 0.55, 0.74), 0.86, { edge: 1.55, fall: 1.5, floorV: 0.06 },
    ),
  );
  searchCone.frustumCulled = false;
  group.add(searchCone);

  // soft ground pool where the beam lands (baked spill, no light)
  const poolTex = canvasTex(128, 128, (ctx, w, h) => {
    const gd = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gd.addColorStop(0.00, 'rgba(255,255,255,1)');
    gd.addColorStop(0.22, 'rgba(255,255,255,0.62)');
    gd.addColorStop(0.55, 'rgba(255,255,255,0.16)');
    gd.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = gd;
    ctx.fillRect(0, 0, w, h);
  });
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x7ea4c8,
      map: poolTex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      fog: false,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  group.add(pool);

  // ---- hero spinner extras: belly flood + the pool it drags on the road ---
  const hero = spinners[spinners.length - 1];
  hero.g.add(new THREE.Mesh(
    makeBellyBeamGeo(),
    makeBeamMaterial(
      C(0x000000).setRGB(0.74, 0.48, 0.24), 0.30, { edge: 1.40, fall: 1.60, floorV: 0.06 },
    ),
  ));
  const heroPool = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xb8763a,
      map: poolTex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.30,
      depthWrite: false,
      fog: false,
    }),
  );
  heroPool.rotation.x = -Math.PI / 2;
  heroPool.scale.set(11, 15, 1);
  group.add(heroPool);

  // ---- distant traffic rivers -------------------------------------------
  const streakLanes = [
    makeStreakLane(rng, {
      origin: new THREE.Vector3(-4.5, 74, 14), dir: new THREE.Vector3(0, 0, -1),
      len: 264, count: 48, speed: 25, yaw: 0,
      tint: [1.0, 0.88, 0.62], spread: 3.2,
    }),
    makeStreakLane(rng, {
      origin: new THREE.Vector3(5.0, 82, -250), dir: new THREE.Vector3(0, 0, 1),
      len: 264, count: 42, speed: 22, yaw: 0,
      tint: [1.0, 0.24, 0.2], spread: 3.2,
    }),
    makeStreakLane(rng, {
      origin: new THREE.Vector3(-200, 132, -160), dir: new THREE.Vector3(1, 0, 0),
      len: 400, count: 44, speed: 28, yaw: Math.PI / 2,
      tint: [0.6, 0.85, 1.0], spread: 6,
    }),
  ];
  for (const l of streakLanes) group.add(l.mesh);

  // ---- kerbside street cars ----------------------------------------------
  const carBodyGeo = makeCarBodyGeo();
  const carGlassGeo = makeCarGlassGeo();
  const carLightsGeo = makeCarLightsGeo();

  // Wet paint under a canyon of signs: strong sheen on every up-facing plane
  // and a hot neon fresnel on the flanks, so the cars read as objects with
  // volume instead of black holes at the kerb.
  const carMat = makeWetMaterial({
    base: C(0x000000).setRGB(0.009, 0.013, 0.019),
    sky: C(0x000000).setRGB(0.046, 0.060, 0.082),
    belly: C(0x000000).setRGB(0.030, 0.016, 0.008),
    rimA: C(0x000000).setRGB(1.00, 0.20, 0.62),
    rimB: C(0x000000).setRGB(0.22, 0.78, 1.00),
    gloss: C(0x000000).setRGB(0.20, 0.14, 0.28),
    sheenCol: C(0x000000).setRGB(0.34, 0.15, 0.34),
    key: new THREE.Vector3(0.60, 0.30, 0.74),
    rimGain: 0.72, rimPow: 2.4, glossPow: 40, wrap: 0.080,
    sheen: 0.06, sheenPow: 3.0,
    panel: 0.60, panelScale: 1.05, panelFade: 44,
  });
  const carGlassMat = makeWetMaterial({
    base: C(0x000000).setRGB(0.004, 0.007, 0.012),
    sky: C(0x000000).setRGB(0.040, 0.055, 0.080),
    belly: C(0x000000).setRGB(0.010, 0.008, 0.006),
    rimA: C(0x000000).setRGB(1.00, 0.34, 0.76),
    rimB: C(0x000000).setRGB(0.34, 0.88, 1.00),
    gloss: C(0x000000).setRGB(0.34, 0.32, 0.46),
    sheenCol: C(0x000000).setRGB(0.30, 0.16, 0.36),
    key: new THREE.Vector3(0.56, 0.36, 0.74),
    rimGain: 0.98, rimPow: 2.0, glossPow: 62, wrap: 0.090,
    sheen: 0.12, sheenPow: 3.0,
    panel: 0.0, panelScale: 1.0, panelFade: 30,
  });
  const carLightsMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });

  // baked wet smear on the tarmac under each car — anchors it to the ground
  const smearTex = canvasTex(128, 128, (ctx, w, h) => {
    const gd = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gd.addColorStop(0.00, 'rgba(255,255,255,0.85)');
    gd.addColorStop(0.40, 'rgba(255,255,255,0.30)');
    gd.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx.fillStyle = gd;
    ctx.fillRect(0, 0, w, h);
  });

  const parked = [
    { x: 6.85, z: 17, ry: Math.PI + 0.04, s: 1.0, smear: 0x6d2a4a },
    { x: -6.8, z: -24, ry: 0.06, s: 1.05, smear: 0x1d4a63 },
    { x: 7.0, z: -58, ry: Math.PI - 0.03, s: 0.96, smear: 0x53264a },
  ];
  for (const p of parked) {
    const g = new THREE.Group();
    g.add(
      new THREE.Mesh(carBodyGeo, carMat),
      new THREE.Mesh(carGlassGeo, carGlassMat),
      new THREE.Mesh(carLightsGeo, carLightsMat),
    );
    g.position.set(p.x, 0.02, p.z);
    g.rotation.y = p.ry;
    g.scale.setScalar(p.s);
    group.add(g);

    const smear = new THREE.Mesh(
      new THREE.PlaneGeometry(6.2, 8.4),
      new THREE.MeshBasicMaterial({
        color: p.smear,
        map: smearTex,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        fog: false,   // additive: fog would ADD haze colour, not attenuate it
      }),
    );
    smear.rotation.x = -Math.PI / 2;
    smear.position.set(p.x, 0.05, p.z);
    group.add(smear);
  }

  // ---- per-frame update --------------------------------------------------
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
  const tanV = new THREE.Vector3(), accV = new THREE.Vector3();
  const sideV = new THREE.Vector3(), lookV = new THREE.Vector3();
  const target = new THREE.Vector3();
  const D = 2; // finite-difference step along lane parameter

  function flySpinner(sp, t) {
    const { lane } = sp;
    const u = ((sp.phase + lane.speed * t) % lane.len + lane.len) % lane.len;
    lane.pos(u - D, pA);
    lane.pos(u, pB);
    lane.pos(u + D, pC);
    tanV.subVectors(pC, pA).normalize();
    let roll;
    if (lane.roll) {
      roll = lane.roll(u);
    } else {
      // lateral accel (world units / u^2) -> m/s^2 via speed^2
      accV.copy(pA).addScaledVector(pB, -2).add(pC).multiplyScalar(1 / (D * D));
      sideV.crossVectors(tanV, UP).normalize();
      const lat = accV.dot(sideV) * lane.speed * lane.speed;
      roll = THREE.MathUtils.clamp((lat / 9.8) * 2.2, -0.55, 0.55);
    }
    sp.g.position.copy(pB);
    sp.g.position.y += 0.3 * Math.sin(t * 1.6 + sp.bobPhase);
    lookV.copy(pB).add(tanV);
    sp.g.lookAt(lookV);
    sp.g.rotateZ(roll);
    sp.g.rotateX(-0.03);
    // double-flash strobe
    const f = (t * 1.1 + sp.strobePhase) % 1;
    sp.strobe.visible = f < 0.05 || (f > 0.12 && f < 0.16);
  }

  function update(t) {
    for (const sp of spinners) flySpinner(sp, t);
    heroPool.position.set(hero.g.position.x, 0.10, hero.g.position.z - 1.5);

    // -- police: slow hover-drift over the street, nose tracking the beam --
    const px = 6 * Math.sin(t * 0.11);
    const pz = -46 + 10 * Math.sin(t * 0.07 + 1.0);
    const py = 34 + 1.1 * Math.sin(t * 0.5);
    target.set(
      4.5 * Math.sin(t * 0.31 + 0.7),
      0.1,
      -46 + 30 * Math.sin(t * 0.17 + 2.1),
    );
    police.g.position.set(px, py, pz);
    lookV.set(target.x, py, target.z);
    police.g.lookAt(lookV);
    police.g.rotateZ(0.05 * Math.sin(t * 0.23));
    const pf = (t * 1.3) % 1;
    police.strobe.visible = pf < 0.05 || (pf > 0.12 && pf < 0.16);
    barR.visible = Math.sin(t * 9) > 0;
    barB.visible = !barR.visible;

    // searchlight: unit cone scaled to reach the street, ~5deg half-angle
    searchCone.position.set(px, py - 0.75, pz);
    const dist = searchCone.position.distanceTo(target);
    searchCone.lookAt(target);
    searchCone.scale.set(dist * 0.085, dist * 0.085, dist);

    const pk = 1.0 + 0.12 * Math.sin(t * 2.3);
    pool.position.set(target.x, 0.09, target.z);
    pool.scale.set(9.5 * pk, 12.5 * pk, 1);

    for (const l of streakLanes) l.update(t);
  }

  return { group, update };
}
