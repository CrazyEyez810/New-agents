import * as THREE from 'three';

// Rain, mist, drips — with motion/physics. Owned by the WEATHER agent.
export function buildWeather() {
  const group = new THREE.Group();
  return { group, update() {} };
}
