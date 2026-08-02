import * as THREE from 'three';

// Spinners, street-level props, traffic. Owned by the VEHICLES agent.
export function buildVehicles() {
  const group = new THREE.Group();
  return { group, update() {} };
}
