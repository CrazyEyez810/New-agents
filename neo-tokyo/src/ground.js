import * as THREE from 'three';

// Wet street, puddles, reflections. Owned by the GROUND agent.
export function buildGround() {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x0a0b0e, roughness: 0.25, metalness: 0.6 });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), mat);
  plane.rotation.x = -Math.PI / 2;
  group.add(plane);
  return { group };
}
