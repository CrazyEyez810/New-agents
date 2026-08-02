import * as THREE from 'three';

// Neon signs, holograms, video billboards. Owned by the SIGNAGE agent.
export function buildSignage() {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xff2d78 });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), mat);
  sign.position.set(0, 18, -28);
  group.add(sign);
  return { group };
}
