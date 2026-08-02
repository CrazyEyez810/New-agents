import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Bloom, grain, DOF, color grade. Owned by the POSTFX agent.
export function buildPostFX({ scene, camera, renderer }) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.5, 0.85
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  return {
    render() { composer.render(); },
    resize(w, h) { composer.setSize(w, h); },
  };
}
