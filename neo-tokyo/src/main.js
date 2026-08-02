import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { buildCity } from './city.js';
import { buildGround } from './ground.js';
import { buildSignage } from './signage.js';
import { buildAtmosphere } from './atmosphere.js';
import { buildWeather } from './weather.js';
import { buildVehicles } from './vehicles.js';
import { buildPostFX } from './postfx.js';

// Camera presets used by the screenshot harness (?shot=key).
// Keep keys stable — the critic pipeline references them by name.
export const SHOTS = {
  street: { pos: [8, 3.2, 34], look: [0, 14, -30], fov: 42 },
  canyon: { pos: [-14, 22, 46], look: [4, 26, -60], fov: 48 },
  aerial: { pos: [-40, 78, 70], look: [10, 20, -40], fov: 50 },
  alley: { pos: [-6, 2.2, 12], look: [8, 10, -40], fov: 55 },
};

const params = new URLSearchParams(location.search);
const shotKey = params.get('shot');
const fixedTime = params.has('t') ? parseFloat(params.get('t')) : null;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 2000);

const shot = SHOTS[shotKey] ?? SHOTS.street;
camera.fov = shot.fov;
camera.position.set(...shot.pos);
camera.lookAt(new THREE.Vector3(...shot.look));
camera.updateProjectionMatrix();

let controls = null;
if (!shotKey) {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...shot.look);
  controls.enableDamping = true;
}

// Each module returns { group?, update?(t, dt) } — modules own their objects.
// ?skip=signage,weather omits modules, for isolating render cost.
const skip = new Set((params.get('skip') ?? '').split(',').filter(Boolean));
const ctx = { scene, camera, renderer };
const BUILDERS = {
  atmosphere: buildAtmosphere,
  ground: buildGround,
  architecture: buildCity,
  signage: buildSignage,
  vehicles: buildVehicles,
  weather: buildWeather,
};
const modules = Object.entries(BUILDERS)
  .filter(([name]) => !skip.has(name))
  .map(([, build]) => build(ctx));
for (const m of modules) if (m?.group) scene.add(m.group);

const post = skip.has('postfx') ? null : buildPostFX(ctx);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  post?.resize?.(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let elapsed = 0;
let warmupFrames = 0;

function renderFrame(t, dt) {
  for (const m of modules) m?.update?.(t, dt);
  if (post?.render) post.render(t, dt);
  else renderer.render(scene, camera);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed = fixedTime !== null ? fixedTime : elapsed + dt;
  controls?.update();
  renderFrame(elapsed, fixedTime !== null ? 1 / 60 : dt);
  // Signal the screenshot harness once the scene has rendered enough
  // frames for async textures/shaders to settle.
  if (++warmupFrames === 30) {
    window.__SCENE_STATS__ = {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? 0,
      textures: renderer.info.memory.textures,
    };
    window.__SCENE_READY__ = true;
  }
}
animate();
