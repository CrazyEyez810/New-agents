// ---------------------------------------------------------------------------
// PAGE-SIDE EXPORT MODULE
//
// This file never runs in node. tools/export-gltf.mjs injects it into the live
// page as <script type="module" src="/tools/export-scene.mjs"> so that the
// document's importmap resolves the bare "three" / "three/addons/" specifiers
// exactly the way src/main.js does.
//
// It imports the SAME module URLs as src/main.js (/src/city.js and friends), so
// the ES module registry hands back the identical module instances — no forked
// copy of the scene code, and src/ is never modified.
//
// Options arrive on the page URL (export-gltf.mjs puts them there):
//   frames=90         simulation ticks to run before exporting
//   renderFrames=0    how many of those ticks also do a real GL render
//   maxTexture=2048   GLTFExporter maxTextureSize
//   keepFx=0|1        keep the volumetric/particle stand-in geometry
//   shot=street       which SHOTS preset drives the export camera
//   t=12              the time value the scene is frozen at
//
// Progress and the finished .glb (base64) are published on window.__NT_EXPORT__
// for the node side to poll and drain.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// Same URLs main.js uses -> same module instances, same deterministic seeds.
import { buildCity } from '/src/city.js';
import { buildGround } from '/src/ground.js';
import { buildSignage } from '/src/signage.js';
import { buildAtmosphere } from '/src/atmosphere.js';
import { buildWeather } from '/src/weather.js';
import { buildVehicles } from '/src/vehicles.js';
import { SHOTS } from '/src/main.js';

const S = (window.__NT_EXPORT__ = {
  phase: 'init',
  log: [],
  error: null,
  manifest: null,
  b64: null,
  bytes: 0,
});

const log = (m) => {
  S.log.push(m);
  console.log('[export]', m);
};

const P = new URLSearchParams(location.search);
const num = (k, d) => (P.has(k) ? Number(P.get(k)) : d);
const OPT = {
  frames: num('frames', 90),
  renderFrames: num('renderFrames', 0),
  maxTexture: num('maxTexture', 2048),
  keepFx: P.get('keepFx') === '1',
  shot: P.get('shot') ?? 'street',
  time: num('t', 12),
};

// ---------------------------------------------------------------------------
// Material classification.
//
// glTF carries geometry, transforms, PBR factors and image maps. It carries
// nothing about a fragment program. Every ShaderMaterial in this scene is one
// of two things:
//
//   (a) a VOLUMETRIC or SCREEN-SPACE effect whose geometry is a carrier, not a
//       shape — a cone shell standing in for a light shaft, a unit quad
//       instanced 5400 times into rain, a horizontal card faking ground
//       inscatter. Exporting the carrier geometry produces a white cone or a
//       single 2-triangle quad sitting in the middle of the scene: actively
//       worse than nothing. These are DROPPED, and blender_setup.py rebuilds
//       them out of things Blender is actually good at (volume scatter, a
//       particle system).
//
//   (b) a SURFACE whose look happens to be hand-written — the spinner hulls,
//       the Joi holograms. These are CONVERTED to the nearest standard/emissive
//       material so the geometry and imagery survive the trip.
//
// Identification is by uniform signature, because that is stable against
// renaming and requires no edits to src/.
// ---------------------------------------------------------------------------

const DROP = (kind) => ({ act: 'drop', kind });
const CONV = (kind) => ({ act: 'convert', kind });
const KEEP = { act: 'keep', kind: 'pbr' };

function classify(mesh) {
  const mat = mesh.material;
  if (!mat) return KEEP;
  if (Array.isArray(mat)) return KEEP;
  const u = mat.uniforms ?? {};

  // Reflector (three/addons) — a live planar mirror render target. There is no
  // glTF concept for it and Blender does reflections properly anyway.
  if (u.textureMatrix && u.tDiffuse) return DROP('reflector');

  // Anything drawn from an InstancedBufferGeometry here is a particle system
  // whose geometry is a single unit quad: rain shells, splash crowns, steam.
  if (mesh.geometry?.isInstancedBufferGeometry) return DROP('particles');

  if (mat.isShaderMaterial) {
    if (u.uZenith) return DROP('skydome');                    // atmosphere sky gradient
    if (u.uFogDensity && u.uIntensity) return DROP('shaft');  // searchlight volumetric
    if (u.uCore && u.uEdge) return DROP('inscatter');         // fog bed slabs
    if (u.uFace && u.uNear) return DROP('scrim');             // depth-plane haze cards
    if (u.uProbePos) return DROP('weather');                  // probe-lit haze sheets
    if (u.uEdge && u.uFall && u.uFloor) return DROP('beam');  // vehicle headlight cones
    if (u.uColA && u.uTex) return CONV('holo');               // Joi holograms
    if (u.uBase && u.uRimA) return CONV('wet');               // spinner hull / glass
    return mat.blending === THREE.AdditiveBlending ? DROP('fx') : CONV('generic');
  }

  // MeshBasicMaterial is how this scene spells "emissive": neon kanban, video
  // billboards, halo/spill cards, vehicle running lights, kerb sheen. Every one
  // of them becomes an emissive standard material so glTF can carry it.
  if (mat.isMeshBasicMaterial) {
    return CONV(mat.blending === THREE.AdditiveBlending ? 'additive' : 'unlit');
  }

  return KEEP;
}

// ---------------------------------------------------------------------------
// Conversions. All of them tag the result with an NT_<KIND>_<n> material name
// and a userData block, which is what blender_setup.py matches on.
// ---------------------------------------------------------------------------

let matSerial = 0;

function tag(mat, kind, extra = {}) {
  mat.name = `NT_${kind.toUpperCase()}_${matSerial++}`;
  mat.userData = {
    ...(mat.userData ?? {}),
    neoTokyo: { kind, additive: false, ...extra },
  };
  return mat;
}

// Split an HDR (>1) three colour into a unit colour plus a strength scalar, so
// emissiveFactor stays inside the glTF [0,1] range and the overshoot rides out
// on KHR_materials_emissive_strength instead of being clipped to white.
function splitEmissive(color) {
  const c = color.clone();
  const peak = Math.max(c.r, c.g, c.b);
  const scale = Math.max(peak, 1);
  c.multiplyScalar(1 / scale);
  return { color: c, strength: scale };
}

function copyCommon(dst, src) {
  dst.transparent = src.transparent;
  dst.opacity = src.opacity;
  dst.side = src.side;
  dst.alphaTest = src.alphaTest;
  dst.depthWrite = src.depthWrite;
  dst.vertexColors = !!src.vertexColors;
  dst.toneMapped = src.toneMapped;
}

// MeshBasicMaterial -> unlit-looking MeshStandardMaterial.
//
// Base colour goes to black and the texture is re-slotted as the emissive map,
// so Blender receives pure emission rather than a diffuse surface that needs
// light. The texture stays in the base-colour slot as well, purely so its ALPHA
// channel survives (glTF alpha = baseColorFactor.a * baseColorTexture.a).
function convertBasic(src, additive) {
  const { color, strength } = splitEmissive(src.color);
  const std = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: 1,
    metalness: 0,
    emissive: color,
    emissiveIntensity: strength,
  });
  if (src.map) {
    std.map = src.map;
    std.emissiveMap = src.map;
  }
  if (src.alphaMap) std.alphaMap = src.alphaMap;
  copyCommon(std, src);
  // Additive over a near-black plate needs alpha blending in glTF; Cycles gets
  // the genuinely additive version (Transparent + Emission) from blender_setup.
  if (additive) std.transparent = true;
  const kind = src.vertexColors ? 'vcol' : additive ? 'additive' : 'unlit';
  return tag(std, kind, { additive, emissiveStrength: strength });
}

// Joi holograms: an additive scanline shader over a figure canvas. The figure
// texture is the whole point, so it becomes an emissive + alpha plane.
function convertHolo(src) {
  const u = src.uniforms;
  const base = u.uColA?.value ?? new THREE.Color(0x38d8ff);
  const gain = u.uIntensity?.value ?? 1;
  const { color, strength } = splitEmissive(base.clone().multiplyScalar(gain));
  const std = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: 1,
    metalness: 0,
    emissive: color,
    emissiveIntensity: Math.max(strength, 1),
  });
  const tex = u.uTex?.value;
  if (tex) {
    std.map = tex;
    std.emissiveMap = tex;
  }
  copyCommon(std, src);
  std.transparent = true;
  return tag(std, 'holo', { additive: true, emissiveStrength: Math.max(strength, 1) });
}

// Spinner hull / canopy: a bespoke wet-lacquer lighting model. Only its base
// tint is portable; the rim and gloss terms are re-derived by Cycles from a
// metallic, low-roughness surface, which is what they were imitating.
function convertWet(src) {
  const u = src.uniforms;
  const base = u.uBase?.value ?? new THREE.Color(0x05070a);
  const gloss = u.uGloss?.value;
  const isGlass = (u.uPanel?.value ?? 1) === 0;
  const std = new THREE.MeshStandardMaterial({
    color: base.clone().multiplyScalar(6), // the shader's base sits far below its rendered value
    roughness: isGlass ? 0.08 : 0.18,
    metalness: isGlass ? 0.4 : 0.9,
  });
  if (gloss) std.emissive = gloss.clone().multiplyScalar(0.06);
  copyCommon(std, src);
  return tag(std, 'wet', { glass: isGlass });
}

function convertGeneric(src) {
  let color = new THREE.Color(0x808080);
  let map = null;
  for (const k of Object.keys(src.uniforms ?? {})) {
    const v = src.uniforms[k]?.value;
    if (!map && v?.isTexture) map = v;
    if (v?.isColor && k !== 'uAmbient') {
      color = v.clone();
      break;
    }
  }
  const std = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
  if (map) std.map = map;
  copyCommon(std, src);
  return tag(std, 'generic');
}

// ---------------------------------------------------------------------------
// InstancedMesh -> a Group of ordinary Meshes sharing one geometry+material.
//
// GLTFExporter would otherwise emit EXT_mesh_gpu_instancing and, critically,
// list it in extensionsRequired — which makes the file illegal to any importer
// that does not implement it. Expanding to plain nodes costs nothing in file
// size (the exporter caches meshes by geometry+material, so one primitive is
// referenced N times) and gives Blender N objects sharing one mesh datablock.
// ---------------------------------------------------------------------------

function expandInstances(root) {
  const targets = [];
  root.traverse((o) => {
    if (o.isInstancedMesh && o.count > 0) targets.push(o);
  });

  let expanded = 0;
  for (const im of targets) {
    const parent = im.parent;
    if (!parent) continue;

    const group = new THREE.Group();
    group.name = `${im.name || 'Instanced'}_instances`;
    group.position.copy(im.position);
    group.quaternion.copy(im.quaternion);
    group.scale.copy(im.scale);

    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    // Per-instance colour multiplies the material colour in three. Fold it into
    // a small cache of cloned materials rather than losing it.
    const byColor = new Map();

    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m4);
      let mat = im.material;
      if (im.instanceColor) {
        im.getColorAt(i, col);
        const key = `${col.r.toFixed(3)}_${col.g.toFixed(3)}_${col.b.toFixed(3)}`;
        if (!byColor.has(key)) {
          const c = im.material.clone();
          c.color = im.material.color.clone().multiply(col);
          byColor.set(key, c);
        }
        mat = byColor.get(key);
      }
      const mesh = new THREE.Mesh(im.geometry, mat);
      mesh.name = `${im.name || 'inst'}_${i}`;
      m4.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.castShadow = im.castShadow;
      mesh.receiveShadow = im.receiveShadow;
      group.add(mesh);
      expanded++;
    }

    parent.add(group);
    parent.remove(im);
  }
  return { instancedMeshes: targets.length, expanded };
}

// ---------------------------------------------------------------------------

function prepare(root, keepFx) {
  const dropped = {};
  const converted = {};
  const cache = new Map();
  const kill = [];

  root.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    const { act, kind } = classify(o);
    if (act === 'drop') {
      // keepFx exports the carrier geometry anyway, for anyone who wants to
      // see where the effects live before rebuilding them.
      if (!keepFx) {
        dropped[kind] = (dropped[kind] ?? 0) + 1;
        kill.push(o);
        return;
      }
      if (o.material?.isShaderMaterial) {
        o.material = cached(cache, o.material, () => convertGeneric(o.material));
        converted.fxcarrier = (converted.fxcarrier ?? 0) + 1;
      }
      return;
    }
    if (act !== 'convert') return;

    const src = o.material;
    o.material = cached(cache, src, () => {
      if (kind === 'holo') return convertHolo(src);
      if (kind === 'wet') return convertWet(src);
      if (kind === 'generic') return convertGeneric(src);
      return convertBasic(src, kind === 'additive');
    });
    converted[kind] = (converted[kind] ?? 0) + 1;
  });

  for (const o of kill) o.parent?.remove(o);

  // Ambient + hemisphere light have no glTF equivalent (KHR_lights_punctual is
  // directional/point/spot only). Drop them rather than emit warnings; the
  // world shader in blender_setup.py replaces them.
  const unsupportedLights = [];
  root.traverse((o) => {
    if (o.isAmbientLight || o.isHemisphereLight) unsupportedLights.push(o);
  });
  for (const l of unsupportedLights) l.parent?.remove(l);

  // Name every surviving standard material and every unnamed object so the
  // Blender outliner is navigable and blender_setup.py has handles to grab.
  root.traverse((o) => {
    const m = o.material;
    if (m && !Array.isArray(m) && !m.name) {
      const emissive = m.emissiveMap || (m.emissive && m.emissive.getHex() !== 0);
      tag(m, emissive ? 'emissive' : 'pbr');
    }
  });

  return { dropped, converted, unsupportedLights: unsupportedLights.length };
}

function cached(map, key, make) {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
}

function nameGraph(root, prefix) {
  let n = 0;
  root.traverse((o) => {
    if (!o.name) o.name = `${prefix}_${o.type}_${n}`;
    n++;
  });
}

// ---------------------------------------------------------------------------

async function run() {
  S.phase = 'building';

  const shot = SHOTS[OPT.shot] ?? SHOTS.street;
  const scene = new THREE.Scene();
  scene.name = 'NeoTokyo';
  const camera = new THREE.PerspectiveCamera(shot.fov, 16 / 9, 0.1, 2000);
  camera.position.set(...shot.pos);
  camera.lookAt(new THREE.Vector3(...shot.look));
  camera.updateMatrixWorld(true);

  // A real renderer, because buildAtmosphere writes toneMappingExposure and the
  // Reflector wants a context. Tiny, offscreen, never attached to the document.
  let renderer = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 144;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    log('offscreen WebGL renderer created');
  } catch (e) {
    renderer = { toneMappingExposure: 1, render() {} };
    log(`WebGL unavailable (${e.message}); using a stub renderer`);
  }

  const ctx = { scene, camera, renderer };
  const BUILDERS = {
    atmosphere: buildAtmosphere,
    ground: buildGround,
    architecture: buildCity,
    signage: buildSignage,
    vehicles: buildVehicles,
    weather: buildWeather,
  };

  const modules = [];
  for (const [name, build] of Object.entries(BUILDERS)) {
    const t0 = performance.now();
    const m = build(ctx);
    if (m?.group) {
      m.group.name = `NT_${name}`;
      nameGraph(m.group, name);
      scene.add(m.group);
    }
    modules.push(m);
    log(`built ${name} in ${(performance.now() - t0).toFixed(0)}ms`);
  }
  // postfx is deliberately absent: it is a screen-space chain over a render
  // target, not scene content, and has nothing to say to a glTF file.

  // --- run frames --------------------------------------------------------
  // Procedural CanvasTextures are drawn synchronously inside the builders, but
  // placement is not: vehicles, holograms and haze planes are positioned in
  // update(t). Ticking the modules to the harness time freezes the scene in the
  // same pose the reference screenshots were taken at.
  S.phase = 'simulating';
  const dt = 1 / 60;
  for (let i = 0; i < OPT.frames; i++) {
    const t = OPT.frames > 1 ? (OPT.time * i) / (OPT.frames - 1) : OPT.time;
    for (const m of modules) m?.update?.(t, dt);
    if (i < OPT.renderFrames && renderer.render) {
      try {
        renderer.render(scene, camera);
      } catch (e) {
        log(`render frame ${i} failed: ${e.message}`);
      }
    }
  }
  scene.updateMatrixWorld(true);
  log(`ran ${OPT.frames} update ticks to t=${OPT.time}s (${OPT.renderFrames} rendered)`);

  // --- inventory before surgery -----------------------------------------
  const before = { meshes: 0, instanced: 0, instances: 0, textures: new Set() };
  scene.traverse((o) => {
    if (o.isInstancedMesh) {
      before.instanced++;
      before.instances += o.count;
    } else if (o.isMesh) before.meshes++;
    const m = o.material;
    if (m && !Array.isArray(m)) {
      for (const k of ['map', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'bumpMap', 'normalMap', 'lightMap', 'alphaMap']) {
        if (m[k]) before.textures.add(m[k].uuid);
      }
    }
  });

  // --- prepare -----------------------------------------------------------
  S.phase = 'preparing';
  const inst = expandInstances(scene);
  log(`expanded ${inst.instancedMeshes} InstancedMesh -> ${inst.expanded} nodes`);
  const prep = prepare(scene, OPT.keepFx);
  log(`dropped ${JSON.stringify(prep.dropped)}`);
  log(`converted ${JSON.stringify(prep.converted)}`);

  // Cap texture sizes at the exporter level; also record what we are shipping.
  scene.traverse((o) => {
    const m = o.material;
    if (m && !Array.isArray(m) && m.map) m.map.anisotropy = Math.min(m.map.anisotropy || 1, 8);
  });

  const fog = scene.fog;
  scene.userData = {
    neoTokyo: {
      source: 'neo-tokyo/src',
      three: THREE.REVISION,
      shot: OPT.shot,
      time: OPT.time,
      fog: fog
        ? { type: fog.isFogExp2 ? 'FogExp2' : 'Fog', color: `#${fog.color.getHexString()}`, density: fog.density ?? null }
        : null,
      toneMappingExposure: renderer.toneMappingExposure ?? 1,
      droppedEffects: prep.dropped,
      convertedMaterials: prep.converted,
    },
  };

  // --- export ------------------------------------------------------------
  S.phase = 'exporting';
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => {
    warnings.push(a.map(String).join(' '));
    realWarn.apply(console, a);
  };

  const exporter = new GLTFExporter();
  const buffer = await new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      resolve,
      reject,
      {
        binary: true,
        onlyVisible: false,
        maxTextureSize: OPT.maxTexture,
        includeCustomExtensions: false,
        trs: true,
      },
    );
  });
  console.warn = realWarn;

  if (!(buffer instanceof ArrayBuffer)) throw new Error('exporter did not return an ArrayBuffer');
  log(`glb produced: ${buffer.byteLength} bytes`);

  // --- hand it back ------------------------------------------------------
  S.phase = 'encoding';
  const b64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error ?? new Error('FileReader failed'));
    fr.readAsDataURL(new Blob([buffer], { type: 'application/octet-stream' }));
  });

  S.bytes = buffer.byteLength;
  S.b64 = b64;
  S.manifest = {
    shot: OPT.shot,
    time: OPT.time,
    frames: OPT.frames,
    three: THREE.REVISION,
    fog: scene.userData.neoTokyo.fog,
    toneMappingExposure: scene.userData.neoTokyo.toneMappingExposure,
    shots: SHOTS,
    before: { meshes: before.meshes, instancedMeshes: before.instanced, instances: before.instances, textures: before.textures.size },
    expanded: inst,
    dropped: prep.dropped,
    converted: prep.converted,
    unsupportedLightsRemoved: prep.unsupportedLights,
    warnings: [...new Set(warnings)].slice(0, 40),
    bytes: buffer.byteLength,
  };
  S.phase = 'done';
}

run().catch((e) => {
  S.error = `${e?.message ?? e}\n${e?.stack ?? ''}`;
  S.phase = 'error';
  console.error('[export] failed', e);
});
