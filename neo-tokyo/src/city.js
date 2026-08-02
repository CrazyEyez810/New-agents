import * as THREE from 'three';

// Megastructure city block. Owned by the ARCHITECTURE agent.
export function buildCity() {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.85, metalness: 0.3 });
  const rng = mulberry32(42);
  for (let i = 0; i < 40; i++) {
    const w = 6 + rng() * 10, d = 6 + rng() * 10, h = 20 + rng() * 80;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    b.position.set((rng() - 0.5) * 160, h / 2, -20 - rng() * 160);
    group.add(b);
  }
  return { group };
}

export function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
