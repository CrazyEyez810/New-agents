import * as THREE from 'three';
import { mulberry32 } from './city.js';

// ---------------------------------------------------------------------------
// ATMOSPHERE — fog, sky dome, global lighting, volumetric light shafts,
// street-level fog inscatter bed, layered depth-plane scrims, local light
// probes that make the air carry the colour of the emitters standing in it.
// Owned by the ATMOSPHERE agent.
//
// Look targets (BR2049): near-black blue-teal city under dense wet haze. Fog
// IS the aerial perspective, so it matches the sky-dome horizon and is the only
// thing separating the deep building planes from pure black. No sun, no strong
// directional — neon, windows and the ground inscatter carry the scene.
//
// Value discipline: darkness is the canvas. Every luminous element here is
// LOCAL (a beam, a pool of ground glow, a probe around one emitter) and bounded
// by an explicit distance window, so nothing ever presents as a broad sheet.
//
// Geometry discipline: NO element in this file may ever show its own polygon
// boundary. Every card, cone and probe drives alpha to exactly zero strictly
// INSIDE its mesh silhouette. The rule is enforced per-shader below.
// ---------------------------------------------------------------------------

const FOG_DENSITY = 0.0126;

// Aerial perspective needs a fog RAMP, not a fog colour. Near haze is dark and
// slightly desaturated — a few tens of metres of wet air over black asphalt.
// Far haze is lighter and bluer — hundreds of metres integrating every window,
// sign and streetlamp in the district into a luminous wall. A single FogExp2
// colour collapses every plane past the knee onto one value, which is exactly
// the "monotone blue mush, no depth cueing" failure.
// Both endpoints carry real chroma. A near-neutral haze is what lets a frame
// with little neon in it (the alley) drift out of the city's palette: the fog
// is the only thing touching every pixel, so it has to be blue on purpose.
const FOG_NEAR = new THREE.Color(0x1a2f40);
const FOG_FAR = new THREE.Color(0x3a577c);
// Where the ramp lives, in world units of view depth. The knee sits close
// enough that the SECOND building rank already reads lighter than the first —
// pushed further out, only the unreachable distance separates and the mid field
// stays a single mass.
const AERIAL_A = 46.0;
const AERIAL_B = 255.0;

// FogExp2 still wants one colour for anything that reads scene.fog.color
// directly; give it the midpoint so nothing that samples it looks wrong.
const FOG_COLOR = FOG_NEAR.clone().lerp(FOG_FAR, 0.45);

// ---------------------------------------------------------------------------
// Depth-ramped fog, patched into the stock chunk.
//
// three's fog mixes toward a single uniform. Rather than plumb a second colour
// uniform through every material in the scene (including other modules' custom
// ShaderMaterials, which this file must not touch), the two endpoint colours are
// baked into the chunk as GLSL literals. Every fogged material in the project
// picks up true aerial perspective with zero changes on their side.
//
// Colours must be injected in the renderer's WORKING (linear) space — THREE.Color
// already converts on construction when ColorManagement is on, so .r/.g/.b are
// exactly the values the stock `fogColor` uniform would carry.
// ---------------------------------------------------------------------------
function glslVec3(c) {
  return `vec3(${c.r.toFixed(6)}, ${c.g.toFixed(6)}, ${c.b.toFixed(6)})`;
}

let fogPatched = false;
function patchFogChunk() {
  if (fogPatched) return;
  fogPatched = true;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  // Aerial perspective: the haze colour itself ramps with depth so successive
  // building planes separate in BOTH value and hue instead of converging on one
  // flat blue. Near planes are pulled toward near-black; only the true distance
  // earns the lifted, bluer haze.
  // pow < 1 front-loads the ramp: the SECOND and THIRD building ranks pick up
  // most of their lift, instead of the whole mid field sitting at near-fog and
  // only the unreachable distance separating.
  float aerialT = pow( smoothstep( ${AERIAL_A.toFixed(1)}, ${AERIAL_B.toFixed(1)}, vFogDepth ), 0.72 );
  vec3 aerialFog = mix( ${glslVec3(FOG_NEAR)}, ${glslVec3(FOG_FAR)}, aerialT );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, aerialFog, fogFactor );
#endif
`;
}
patchFogChunk();

// ---------------------------------------------------------------------------
// Sky dome: procedural gradient shader. Near-black zenith falling to a faint
// dirty teal horizon (light pollution bouncing off overcast). Horizon color
// converges on the FAR fog color so silhouettes melt into the sky. The warm
// sodium lobe is deliberately pushed OFF the down-street axis — pointing it
// straight at the street camera turns the whole corridor salmon.
// ---------------------------------------------------------------------------
function makeSkyDome() {
  const geo = new THREE.SphereGeometry(880, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0x030508) },
      uHorizon: { value: FOG_FAR.clone().multiplyScalar(1.12) },
      uAmber: { value: new THREE.Color(0x33200f) },
      uTeal: { value: new THREE.Color(0x12303a) },
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
        // Light-pollution lobes hugging the horizon like bounce off low cloud.
        // Warm sodium sits off to one shoulder; the down-street axis stays cool.
        float az = atan(vDir.x, -vDir.z); // 0 looking down-street
        float low = pow(1.0 - h, 6.0);
        float warmLobe = exp(-3.0 * (az - 0.95) * (az - 0.95));
        float tealLobe = exp(-1.9 * az * az)
                       + 0.7 * exp(-3.5 * (az + 2.4) * (az + 2.4));
        col += uAmber * (low * warmLobe * 0.6);
        col += uTeal * (low * tealLobe * 0.65);
        // Faint broken-cloud mottling so the dome is not a sterile ramp.
        float m = sin(vDir.x * 9.0 + 2.0) * sin(vDir.z * 7.0 - 1.0) * sin(vDir.y * 13.0 + 4.0);
        col *= 1.0 + m * 0.07 * (1.0 - h);
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
// Volumetric shaft: open-ended cone, additive.
//
// THE RADIAL PROFILE IS THE WHOLE GAME, and the obvious physical answer is the
// wrong one. The chord length a view ray takes through a uniform cone shell is
// proportional to |dot(N,V)|, so using ndv directly integrates a uniform medium
// exactly — but that profile meets zero at the silhouette with a VERTICAL
// tangent. At 95% of the beam radius it is still at 31% of peak, so the last
// 5% of the width collapses the whole remaining value in a couple of pixels and
// the eye reads a straight cut line: a translucent quad, not light in air.
//
// A real shaft has no medium boundary — the illuminated density falls off
// smoothly with radius. So the profile here is Gaussian in the NORMALISED
// SCREEN RADIUS rad = sqrt(1 - ndv^2), multiplied by a hard-zero window that
// closes at rad 0.94, comfortably inside the mesh silhouette. Alpha is provably
// zero on every polygon boundary:
//   - sides: `soft` -> 0 at rad = 0.94 < 1
//   - top (source cap): `len` -> 0 at vUv.y = 1
//   - bottom: pow(y, 1.5) -> 0 at vUv.y = 0
//
// Peak alpha is also kept well under the bloom threshold — a beam that pushes a
// channel past it gets bloomed to white and loses all colour and softness.
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
      precision highp float;
      varying vec2 vUv;
      varying vec3 vNormalV;
      varying vec3 vViewPos;
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      uniform float uFogDensity;
      void main() {
        vec3 V = normalize(-vViewPos);
        float ndv = clamp(abs(dot(normalize(vNormalV), V)), 0.0, 1.0);
        // Normalised screen radius across the beam: 0 on the axis, 1 at the
        // silhouette. Working in radius (not chord) is what kills the cut edge.
        float rad = sqrt(max(0.0, 1.0 - ndv * ndv));
        float halo = exp(-rad * rad * 3.4);   // wide soft scatter
        float hot  = exp(-rad * rad * 17.0);  // thin bright core
        // Hard zero well inside the polygon border. Non-negotiable.
        float soft = 1.0 - smoothstep(0.44, 0.94, rad);
        // The hot core is what makes this read as a BEAM rather than a patch of
        // brighter haze; the halo is what stops the beam having an edge.
        float radial = (0.60 * halo + 0.40 * hot) * soft;
        // Along the beam: a long lit PLATEAU with both ends rolled fully to
        // zero. A pure pow(y) ramp puts all the brightness in the last few
        // metres below the source, which then has to sit inside frame — and the
        // source cap with it. Plateauing lets the apex (and its roll-off) live
        // far above every camera while the visible span still carries the beam.
        float y = clamp(vUv.y, 0.0, 1.0);
        float len = smoothstep(0.0, 0.30, y)
                  * (1.0 - smoothstep(0.72, 1.0, y))
                  * mix(0.70, 1.0, y);
        // Slow drifting density bands (pure function of t — deterministic).
        float bands = 0.80
          + 0.20 * sin(y * 19.0 - uTime * 0.35 + vUv.x * 6.2831)
          + 0.10 * sin(y * 47.0 - uTime * 0.9);
        // Near-camera fade so a shaft crossing the lens doesn't hard-clip.
        float dist = length(vViewPos);
        float nearFade = smoothstep(3.0, 22.0, dist);
        // Haze attenuation, softer than scene fog (shafts are self-luminous
        // scatter, they survive a bit deeper into the murk).
        float f = dist * uFogDensity * 0.55;
        float haze = exp(-f * f);
        float a = uIntensity * radial * len * bands * nearFade * haze;
        // Additive blend is (srcAlpha * rgb + dst): keep rgb unscaled so the
        // contribution is linear in a, not a^2.
        gl_FragColor = vec4(uColor, clamp(a, 0.0, 1.0));
      }
    `,
  });
}

function makeShaft({ apex, length, topR, botR, color, intensity }) {
  // Cylinder: uv.y=1 at top. Translate so the apex (top) is the pivot origin.
  const geo = new THREE.CylinderGeometry(topR, botR, length, 32, 28, true);
  geo.translate(0, -length / 2, 0);
  const mesh = new THREE.Mesh(geo, makeShaftMaterial(color, intensity));
  mesh.renderOrder = 22;
  mesh.frustumCulled = false;
  const pivot = new THREE.Group();
  pivot.position.copy(apex);
  pivot.add(mesh);
  return { pivot, mat: mesh.material };
}

// ---------------------------------------------------------------------------
// FOG INSCATTER BED — the defining BR2049 street ingredient.
//
// Horizontal additive slabs hugging the roadway (y 1.7 .. 10). Teal in the core
// of the wet tarmac, sodium at the kerb line where the lamps live. From an
// elevated camera the canyon floor glows from below; from street level the
// slabs are seen edge-on and read as a luminous band of ground haze receding
// down the corridor.
//
// Every term is bounded: an explicit near cutoff keeps it off the lens, an
// exp2 far term stops it banking up into a bright wall at the horizon, and the
// grazing-incidence boost is capped so a low camera can't get a hard bright
// band out of a zero-thickness plane.
// ---------------------------------------------------------------------------
const SLAB_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vViewPos;
  varying vec3 vNrm;
  void main() {
    vUv = uv;
    vNrm = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const SLAB_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vViewPos;
  varying vec3 vNrm;
  uniform vec3 uCore;
  uniform vec3 uEdge;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uSeed;
  uniform float uDrift;
  void main() {
    float lx = vUv.x * 2.0 - 1.0;
    float ax = abs(lx);
    // Across the roadway: soft bell that is already zero before the card border.
    float lat = exp(-ax * ax * 2.6) * (1.0 - smoothstep(0.72, 0.98, ax));
    // Along the corridor: feather both ends.
    float ly = clamp(vUv.y, 0.0, 1.0);
    float along = smoothstep(0.0, 0.14, ly) * (1.0 - smoothstep(0.76, 1.0, ly));
    // Slow deterministic mottling — pure function of t.
    float ph = uTime * uDrift;
    float n = sin(lx * 2.7 + uSeed + ph) * sin(ly * 13.0 - ph * 1.7 + uSeed * 1.9)
            + 0.55 * sin(lx * 6.9 - ly * 24.0 + uSeed * 0.7 - ph * 0.6);
    float mott = clamp(0.62 + 0.38 * n, 0.10, 1.20);
    // Kerb-line sodium bleeding into the teal core of the roadway. The sodium
    // is held OUT at the kerbs with a cubic ramp: pulled any further inboard it
    // dominates a tight low camera and drags the whole frame to a brown cast.
    float rim = smoothstep(0.44, 0.96, ax);
    vec3 col = mix(uCore, uEdge, rim * rim * rim);
    float dist = length(vViewPos);
    // Off the lens, strongest mid-corridor, swallowed by the murk beyond.
    // The near cutoff is deliberately far out: a ground-hugging slab that
    // reaches the near field lifts a low camera's whole lower frame into
    // midtone. The glow has to start down the street, not at the lens.
    float near = smoothstep(14.0, 52.0, dist);
    float fd = dist * 0.0054;
    float far = exp(-fd * fd);
    // Slab optical depth: longer path at grazing incidence, gently capped.
    float ndv = abs(dot(normalize(vNrm), normalize(-vViewPos)));
    float slab = clamp(0.55 / (ndv + 0.50), 0.55, 1.15);
    float a = uOpacity * lat * along * mott * near * far * slab;
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  }
`;

function makeInscatterBed() {
  // Corridor is roadway x in [-9,9] + 7u sidewalks, running along z about
  // z = -105 (ground.js: ROAD_HALF 9, WALK_W 7, Z_CENTER -90, LEN 280).
  const defs = [
    { y: 1.7, w: 76, len: 250, op: 0.44, seed: 0.0, drift: 0.030, edge: 0x8e5527 },
    { y: 3.3, w: 84, len: 250, op: 0.38, seed: 1.7, drift: 0.026, edge: 0x8e5527 },
    { y: 5.2, w: 92, len: 250, op: 0.28, seed: 3.1, drift: 0.022, edge: 0x6d4a5e },
    { y: 7.5, w: 100, len: 250, op: 0.18, seed: 4.6, drift: 0.018, edge: 0x5b4270 },
    { y: 10.2, w: 108, len: 250, op: 0.11, seed: 6.0, drift: 0.014, edge: 0x4a3d72 },
  ];
  // The bed climbs out of sodium and into magenta with height: the kerb lamps
  // are at street level, the big signage is above, so the upper slabs belong to
  // the neon and keep the column inside the teal-magenta family.
  const core = new THREE.Color(0x3d7f9c);
  return defs.map((d) => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: SLAB_VERT,
      fragmentShader: SLAB_FRAG,
      uniforms: {
        uCore: { value: core.clone() },
        uEdge: { value: new THREE.Color(d.edge) },
        uOpacity: { value: d.op },
        uTime: { value: 0 },
        uSeed: { value: d.seed },
        uDrift: { value: d.drift },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.len), mat);
    mesh.rotation.x = -Math.PI / 2; // local +Y -> world -Z (down-street)
    mesh.position.set(0, d.y, -105);
    mesh.renderOrder = 12;
    mesh.frustumCulled = false;
    return mesh;
  });
}

// ---------------------------------------------------------------------------
// Depth-plane scrims: ultra-faint additive planes deep down the canyon, purely
// to give the far building masses something to separate against.
//
// The round-1 mask was `1 - smoothstep(0.18, 1.0, length(vec2(p.x*0.70, p.y)))`.
// The 0.70 squash means the LEFT AND RIGHT borders of the card sit at r = 0.70,
// where the mask is still 0.116 — a non-zero alpha running straight down the
// polygon edge, i.e. a visible rectangular boundary. That is the "card-edged
// haze" failure exactly, and it is a maths bug, not a tuning problem.
//
// The replacement multiplies an interior ellipse by a per-axis border feather
// that is IDENTICALLY ZERO on all four edges, so no border can exist at any
// opacity. Scrims are additionally deployed in offset PAIRS at different depths
// and yaws, so even the soft density falloff of one plane cannot be read as a
// plane: there is always a second, differently-oriented one overlapping it.
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
  vg.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  vg.addColorStop(0.85, 'rgba(255,255,255,0.34)');
  vg.addColorStop(1.0, 'rgba(255,255,255,0.20)');
  c.fillStyle = vg;
  c.fillRect(0, 0, W, H);
  // Soft blobs for uneven density.
  for (let i = 0; i < 26; i++) {
    const x = rng() * W, y = H * (0.45 + rng() * 0.55);
    const r = 22 + rng() * 46;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.05 + rng() * 0.08})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace; // alpha channel only
  return tex;
}

const SCRIM_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vViewPos;
  varying vec3 vNrm;
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uNear;
  uniform float uFar;
  uniform float uFace;   // CPU: 1 = camera square-on to this card, 0 = grazing
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    // Border feather: zero on ALL FOUR edges of the quad, by construction.
    vec2 e = 1.0 - abs(p);
    float border = smoothstep(0.0, 0.62, e.x) * smoothstep(0.0, 0.48, e.y);
    // Interior ellipse so the density is a blob, not a panel.
    float ell = 1.0 - smoothstep(0.06, 0.99, length(p * vec2(0.72, 1.0)));
    float mask = border * border * ell * ell;
    float m = texture2D(uMap, vUv).a;
    float dist = length(vViewPos);
    // A scrim this large must never present itself to a near camera.
    float near = smoothstep(uNear, uFar, dist);
    // ...nor read as a flat sheet when the lens is square-on to it.
    float ang = mix(1.0, 0.38, uFace);
    gl_FragColor = vec4(uColor, clamp(uOpacity * mask * m * near * ang, 0.0, 1.0));
  }
`;

function makeScrim(tex, { w, h, pos, rotY, color, opacity, near, far }) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SLAB_VERT,
    fragmentShader: SCRIM_FRAG,
    uniforms: {
      uMap: { value: tex },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uNear: { value: near },
      uFar: { value: far },
      uFace: { value: 0 },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.copy(pos);
  mesh.rotation.y = rotY;
  mesh.renderOrder = 15;
  return mesh;
}

// ---------------------------------------------------------------------------
// LOCAL INSCATTER PROBES — the BR2049 signature that was missing.
//
// Two forty-metre emissive holograms stand in dense rain-fog and the air around
// them was doing nothing. Real scattering means the medium next to a big source
// glows in that source's colour, brightest at the source and falling off fast.
//
// Implemented as billboarded additive quads with an anisotropic Gaussian, so
// they cost one cheap quad each rather than a light that would multiply the
// per-pixel cost of every standard material in the scene (the perf rule).
// The Gaussian is windowed to hard zero at 0.86 of the quad half-extent, so
// like everything else here the polygon boundary can never be seen.
//
// `y` billboards keep their vertical axis and read as a glow COLUMN around a
// standing figure; `full` billboards face the lens outright and read as a bloom
// ball around a panel.
// ---------------------------------------------------------------------------
const PROBE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vViewPos;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTight;
  uniform float uSquash;
  uniform float uCore;
  uniform float uNear0;
  uniform float uNear1;
  uniform float uFarK;
  uniform float uTime;
  uniform float uSeed;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(vec2(p.x, p.y * uSquash));
    float halo = exp(-r * r * uTight);
    float core = exp(-r * r * uTight * 6.0);
    // Zero strictly inside the quad on every axis.
    float win = 1.0 - smoothstep(0.50, 0.86, max(abs(p.x), abs(p.y)));
    // Deterministic breathing so the air is alive, never a static decal.
    float puls = 0.86 + 0.14 * sin(uTime * 0.55 + uSeed)
                      + 0.06 * sin(uTime * 1.9 + uSeed * 2.3);
    float dist = length(vViewPos);
    float nearFade = smoothstep(uNear0, uNear1, dist);
    float fd = dist * uFarK;
    float farFade = exp(-fd * fd);
    float a = uOpacity * (halo + uCore * core) * win * win * puls * nearFade * farFade;
    gl_FragColor = vec4(uColor, clamp(a, 0.0, 1.0));
  }
`;

function makeProbe(d) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SLAB_VERT,
    fragmentShader: PROBE_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(d.color) },
      uOpacity: { value: d.opacity },
      uTight: { value: d.tight ?? 3.2 },
      uSquash: { value: d.squash ?? 1.0 },
      uCore: { value: d.core ?? 0.5 },
      uNear0: { value: d.near0 ?? 2.0 },
      uNear1: { value: d.near1 ?? 12.0 },
      uFarK: { value: d.farK ?? 0.0052 },
      uTime: { value: 0 },
      uSeed: { value: d.seed ?? 0 },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), mat);
  mesh.position.set(...d.pos);
  mesh.renderOrder = 18;
  mesh.frustumCulled = false;
  return { mesh, mat, mode: d.mode ?? 'y' };
}

// ---------------------------------------------------------------------------

export function buildAtmosphere({ scene, camera, renderer }) {
  patchFogChunk();
  const rng = mulberry32(9021);
  const group = new THREE.Group();

  // --- Fog + tonemap exposure -------------------------------------------
  scene.fog = new THREE.FogExp2(FOG_COLOR.clone(), FOG_DENSITY);
  scene.background = null; // sky dome supplies the background
  // Exposure is the last global lever and it is set from the TIGHTEST frame,
  // not the average one. The alley preset resolves far more thin neon detail
  // at full res than the wide shots do, so it clips first; pulling exposure
  // until the alley's highlights sit inside budget leaves the wide shots a
  // little darker, which is the correct direction for this look anyway.
  renderer.toneMappingExposure = 1.02;

  // --- Sky ---------------------------------------------------------------
  group.add(makeSkyDome());

  // --- Global light: moonless overcast. Hemisphere only — cool zenith bounce
  // vs a deep violet street-glow from below. The ground term used to be a warm
  // brown (0x1d150c); a hemisphere light mixes sky/ground by normal.y, so every
  // VERTICAL surface in the scene took a 50% dose of it. In a tight alley the
  // frame is nothing but vertical surfaces, which is precisely why that preset
  // came out a monochrome brown that belonged to a different city. The bounce
  // colour now sits in the same teal-magenta family as the neon; warmth is
  // earned locally from sodium emissives, never from the global term.
  const hemi = new THREE.HemisphereLight(0x3a4f60, 0x1a1526, 0.82);
  group.add(hemi);
  const amb = new THREE.AmbientLight(0x141d2c, 0.42);
  group.add(amb);

  // --- Volumetric shafts -------------------------------------------------
  // One warm sodium searchlight, two cool. Apexes are lifted well above every
  // preset's frame top and the cones run long, so the soft source cap does its
  // roll-off entirely off-screen and the beam simply arrives from above.
  const shafts = [
    { apex: new THREE.Vector3(30, 178, -78), length: 220, topR: 3.0, botR: 17,
      color: 0xffa14d, intensity: 0.24, // warm sodium — leaning across the canyon
      sweep: { ax: 0.10, az: 0.10, sx: 0.11, sz: 0.083, px: 0.0, pz: 1.7, tilt: 0.06, tiltZ: -0.3 } },
    { apex: new THREE.Vector3(-10, 190, -110), length: 240, topR: 3.6, botR: 23,
      color: 0x6fd7ff, intensity: 0.30, // cool cyan — deep down-street
      sweep: { ax: 0.18, az: 0.13, sx: 0.071, sz: 0.093, px: 2.1, pz: 4.0, tilt: -0.12 } },
    { apex: new THREE.Vector3(-6, 142, -4), length: 176, topR: 2.0, botR: 11,
      color: 0x9db4e8, intensity: 0.15, // pale blue — near field, barely there
      sweep: { ax: 0.13, az: 0.16, sx: 0.052, sz: 0.064, px: 4.4, pz: 0.9, tilt: 0.06 } },
  ].map((s) => {
    const shaft = makeShaft(s);
    shaft.sweep = s.sweep;
    group.add(shaft.pivot);
    return shaft;
  });

  // --- Fog inscatter bed -------------------------------------------------
  const bedMats = makeInscatterBed().map((m) => {
    group.add(m);
    return m.material;
  });

  // --- Depth-plane scrims ------------------------------------------------
  // Deployed as offset pairs: for each depth plane there is a partner at a
  // different z and a markedly different yaw. Two overlapping, differently
  // oriented density falloffs give the eye no single plane to latch onto.
  const hazeTexA = makeHazeTexture(rng);
  const hazeTexB = makeHazeTexture(rng);
  const hazeTexC = makeHazeTexture(rng);
  const scrims = [
    { tex: hazeTexA, w: 190, h: 78, pos: new THREE.Vector3(2, 26, -72), rotY: 0.18,
      color: 0x33596b, opacity: 0.30, near: 44, far: 112 },
    { tex: hazeTexC, w: 150, h: 62, pos: new THREE.Vector3(-14, 20, -92), rotY: -0.62,
      color: 0x45385e, opacity: 0.22, near: 52, far: 124 }, // partner, off-axis
    { tex: hazeTexB, w: 240, h: 100, pos: new THREE.Vector3(-6, 34, -126), rotY: -0.12,
      color: 0x4b4368, opacity: 0.40, near: 62, far: 150 }, // faint magenta from deep signage
    { tex: hazeTexA, w: 180, h: 84, pos: new THREE.Vector3(18, 30, -150), rotY: 0.55,
      color: 0x3a5468, opacity: 0.28, near: 74, far: 168 }, // partner, off-axis
    { tex: hazeTexC, w: 300, h: 130, pos: new THREE.Vector3(4, 44, -186), rotY: 0.08,
      color: 0x3c5a72, opacity: 0.44, near: 92, far: 206 },
    { tex: hazeTexB, w: 220, h: 110, pos: new THREE.Vector3(-22, 40, -214), rotY: -0.48,
      color: 0x46536e, opacity: 0.30, near: 104, far: 226 }, // partner, off-axis
  ].map((c) => {
    const m = makeScrim(c.tex, c);
    group.add(m);
    return m;
  });

  // --- Local inscatter probes -------------------------------------------
  // Anchored to the emitters that actually exist in the scene: the two giant
  // holograms (signage.js: [7.6,0,-58] h46 cyan/violet, [-7.9,0,-22] h27
  // violet/blue) and the three video billboards ([11.5,30,-46], [-11.4,24,-64],
  // [10.6,13.5,-6]). Colours are taken from those emitters so the air reads as
  // carrying THEIR light, not as a generic coloured cloud.
  const probes = [
    // Hologram A — tall cyan glow column around the 46m figure, plus a hot
    // waist bloom and a ground-level pool where the projector sits.
    { pos: [7.6, 25, -58], w: 52, h: 68, color: 0x3fbdf5, opacity: 0.165,
      tight: 3.0, squash: 0.62, core: 0.55, near0: 4, near1: 16, farK: 0.0046,
      seed: 0.4, mode: 'y' },
    { pos: [7.6, 16, -58], w: 26, h: 30, color: 0x74a8ff, opacity: 0.185,
      tight: 3.6, squash: 0.9, core: 1.55, near0: 4, near1: 16, farK: 0.0050,
      seed: 2.1, mode: 'full' },
    { pos: [7.6, 3.4, -58], w: 40, h: 16, color: 0x2f9fd8, opacity: 0.150,
      tight: 3.4, squash: 2.1, core: 0.7, near0: 4, near1: 16, farK: 0.0050,
      seed: 3.9, mode: 'full' },
    // Hologram B — violet-magenta column, the alley's palette anchor.
    { pos: [-7.9, 15, -22], w: 34, h: 44, color: 0xa163ff, opacity: 0.170,
      tight: 3.0, squash: 0.66, core: 0.55, near0: 4, near1: 15, farK: 0.0058,
      seed: 5.2, mode: 'y' },
    { pos: [-7.9, 9, -22], w: 20, h: 22, color: 0xc07dff, opacity: 0.180,
      tight: 3.6, squash: 0.95, core: 1.5, near0: 4, near1: 15, farK: 0.0060,
      seed: 1.3, mode: 'full' },
    { pos: [-7.9, 2.6, -22], w: 28, h: 13, color: 0x8a5bea, opacity: 0.140,
      tight: 3.4, squash: 2.1, core: 0.7, near0: 4, near1: 15, farK: 0.0060,
      seed: 6.6, mode: 'full' },
    // Corridor floor between the two figures: the alley preset reads far more
    // wall and wet stone than the wide shots do, and both are low-chroma. This
    // is the frame's colour anchor — without it the alley is the one
    // desaturated, off-palette shot in the set.
    { pos: [1.0, 5.0, -34], w: 44, h: 20, color: 0xa845d8, opacity: 0.105,
      tight: 3.0, squash: 2.3, core: 0.6, near0: 6, near1: 20, farK: 0.0062,
      seed: 4.1, mode: 'full' },
    { pos: [3.5, 8.0, -46], w: 40, h: 24, color: 0x2fb6d8, opacity: 0.100,
      tight: 3.0, squash: 1.7, core: 0.6, near0: 6, near1: 20, farK: 0.0056,
      seed: 2.6, mode: 'full' },
    // Billboards — bloom balls pushed a few units off the wall face so the
    // quad sits in open air rather than half-buried in the facade.
    { pos: [7.4, 30, -46], w: 30, h: 24, color: 0xff4f9e, opacity: 0.115,
      tight: 3.4, squash: 1.15, core: 0.8, near0: 4, near1: 15, farK: 0.0052,
      seed: 2.8, mode: 'full' },
    { pos: [-7.6, 24, -64], w: 26, h: 32, color: 0x37c8ff, opacity: 0.115,
      tight: 3.4, squash: 0.85, core: 0.8, near0: 4, near1: 15, farK: 0.0048,
      seed: 4.7, mode: 'full' },
    { pos: [6.6, 13.5, -6], w: 24, h: 18, color: 0xff8a3c, opacity: 0.085,
      tight: 3.6, squash: 1.2, core: 0.7, near0: 6, near1: 22, farK: 0.0075,
      seed: 0.9, mode: 'full' },
    // High-altitude scatter: where the two big shafts rake past the towers the
    // air has to show something, otherwise the aerial frame has no life above
    // roof level at all.
    { pos: [26, 84, -74], w: 46, h: 58, color: 0xffb26a, opacity: 0.100,
      tight: 2.6, squash: 0.7, core: 1.35, near0: 10, near1: 40, farK: 0.0044,
      seed: 3.3, mode: 'y' },
    { pos: [-12, 96, -104], w: 58, h: 72, color: 0x7fdcff, opacity: 0.115,
      tight: 2.6, squash: 0.7, core: 1.35, near0: 10, near1: 40, farK: 0.0040,
      seed: 5.9, mode: 'y' },
  ].map((d) => {
    const p = makeProbe(d);
    group.add(p.mesh);
    return p;
  });

  // --- Update ------------------------------------------------------------
  // Scratch vectors — update() must never allocate.
  const camFwd = new THREE.Vector3();
  const cardNrm = new THREE.Vector3();
  const camPos = new THREE.Vector3();

  function update(t) {
    for (const s of shafts) {
      const sw = s.sweep;
      s.pivot.rotation.x = sw.tilt + Math.sin(t * sw.sx + sw.px) * sw.ax;
      s.pivot.rotation.z = (sw.tiltZ ?? 0) + Math.sin(t * sw.sz + sw.pz) * sw.az;
      s.mat.uniforms.uTime.value = t;
    }
    for (const m of bedMats) m.uniforms.uTime.value = t;
    for (const p of probes) p.mat.uniforms.uTime.value = t;
    if (camera) {
      camera.getWorldDirection(camFwd);
      camera.getWorldPosition(camPos);
      for (const s of scrims) {
        cardNrm.set(0, 0, 1).applyQuaternion(s.quaternion);
        const face = Math.abs(camFwd.dot(cardNrm));
        // 1 only when the lens is genuinely square-on to the card.
        s.material.uniforms.uFace.value = THREE.MathUtils.smoothstep(face, 0.86, 0.995);
      }
      for (const p of probes) {
        if (p.mode === 'y') {
          // Yaw-only billboard: the glow column stays vertical like the figure
          // it wraps, instead of tipping with the camera in the aerial shot.
          p.mesh.rotation.set(
            0,
            Math.atan2(camPos.x - p.mesh.position.x, camPos.z - p.mesh.position.z),
            0,
          );
        } else {
          p.mesh.quaternion.copy(camera.quaternion);
        }
      }
    }
  }

  return { group, update };
}
