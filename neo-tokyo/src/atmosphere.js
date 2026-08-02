import * as THREE from 'three';

// Fog, sky, key lighting, volumetrics. Owned by the ATMOSPHERE agent.
export function buildAtmosphere({ scene }) {
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.FogExp2(0x0a0d16, 0.012);
  const group = new THREE.Group();
  group.add(new THREE.AmbientLight(0x223, 2.0));
  const key = new THREE.DirectionalLight(0x5577aa, 1.2);
  key.position.set(-40, 80, 20);
  group.add(key);
  return { group };
}
