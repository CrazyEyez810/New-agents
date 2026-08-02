import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './city.js';

// VEHICLES — spinners, distant traffic rivers, parked street cars.
// Owned by the VEHICLES agent.
//
// All motion is a pure function of elapsed time t (deterministic screenshots).
// Spinners fly parametric weaving lanes through the canyon at 27-66m, bank
// into turns (roll ∝ lateral acceleration), and carry additive headlight
// cones + emissive nav lights + blinking strobes. One police spinner hovers
// over the street sweeping a volumetric searchlight. High between the
// background towers, instanced light streaks read as endless traffic rivers.

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// small geometry helpers
// ---------------------------------------------------------------------------
function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

// Attach a flat vertex color to a geometry (for merged emissive light packs).
function paint(g, r, gr, b) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = r; arr[i * 3 + 1] = gr; arr[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

// Open cone, apex at origin, base at +z*len, vertex-color fading apex→base.
// Reads as a hazed volumetric light beam under additive blending.
function beamCone(rad, len, r, gr, b, radial = 12) {
  const g = new THREE.ConeGeometry(rad, len, radial, 1, true);
  g.rotateX(-Math.PI / 2);       // apex → z=-len/2, base → z=+len/2
  g.translate(0, 0, len / 2);    // apex at z=0, base at z=len
  const pos = g.attributes.position;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = Math.pow(Math.max(0, 1 - pos.getZ(i) / len), 1.6);
    col[i * 3] = r * k; col[i * 3 + 1] = gr * k; col[i * 3 + 2] = b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// ---------------------------------------------------------------------------
// Spinner hull: chunky merged greeble body, nose toward +z.
// ---------------------------------------------------------------------------
function makeSpinnerHullGeo() {
  const geos = [];
  geos.push(box(1.7, 0.62, 4.4, 0, 0, 0));            // fuselage
  geos.push(box(1.25, 0.5, 1.5, 0, 0.48, 0.4));       // canopy block
  geos.push(box(1.05, 0.34, 0.8, 0, 0.44, 1.35));     // canopy nose slope
  geos.push(box(1.35, 0.42, 1.15, 0, -0.04, 2.55));   // nose wedge
  geos.push(box(1.5, 0.3, 1.6, 0, 0.14, -2.25));      // tail deck
  for (const s of [-1, 1]) {
    geos.push(box(0.6, 0.52, 3.1, s * 1.18, -0.18, -0.2));   // pontoon
    geos.push(box(0.42, 0.32, 1.15, s * 1.18, -0.1, 1.55));  // pontoon nose
    geos.push(box(0.1, 0.72, 1.15, s * 0.72, 0.58, -1.8));   // tail fin
    const eng = new THREE.CylinderGeometry(0.24, 0.3, 0.55, 8);
    eng.rotateX(Math.PI / 2);
    eng.translate(s * 1.18, -0.2, -1.95);                    // engine can
    geos.push(eng);
    geos.push(box(0.34, 0.1, 0.9, s * 0.55, 0.34, 0.9));     // hood vane
  }
  geos.push(box(0.95, 0.16, 1.9, 0, 0.44, -1.15));    // spine greeble
  geos.push(box(0.5, 0.2, 0.7, 0.3, 0.5, -0.5));      // dorsal box
  geos.push(box(1.1, 0.22, 0.9, 0, -0.42, 0.55));     // belly pod
  geos.push(box(0.4, 0.14, 1.4, -0.45, -0.4, -0.9));  // belly rail
  return mergeGeometries(geos);
}

// Emissive light pack (merged, vertex-colored): headlights, tails, markers.
function makeSpinnerLightsGeo() {
  const geos = [];
  // headlight lenses
  for (const s of [-1, 1]) {
    geos.push(paint(box(0.3, 0.13, 0.06, s * 0.42, -0.02, 3.12), 2.2, 2.0, 1.6));
    // pontoon amber marker
    geos.push(paint(box(0.1, 0.08, 0.2, s * 1.18, -0.06, 2.1), 1.6, 0.8, 0.15));
  }
  // tail light bars (red)
  for (const s of [-1, 1]) {
    geos.push(paint(box(0.55, 0.1, 0.05, s * 0.48, 0.16, -3.06), 2.4, 0.12, 0.1));
    geos.push(paint(box(0.16, 0.07, 0.05, s * 1.18, -0.2, -2.24), 1.6, 0.1, 0.08));
  }
  // cockpit instrument slit (cool cyan, dim)
  geos.push(paint(box(0.8, 0.05, 0.04, 0, 0.42, 1.77), 0.25, 0.75, 0.95));
  return mergeGeometries(geos);
}

// Headlight beam pack: outer soft cone + inner hot cone per side.
function makeHeadBeamGeo() {
  const geos = [];
  for (const s of [-1, 1]) {
    const outer = beamCone(1.25, 12, 0.55, 0.5, 0.4);
    outer.translate(s * 0.42, -0.02, 3.05);
    const inner = beamCone(0.45, 6.5, 0.85, 0.78, 0.6);
    inner.translate(s * 0.42, -0.02, 3.05);
    geos.push(outer, inner);
  }
  return mergeGeometries(geos);
}

function makeStrobeGeo() {
  const geos = [];
  const s1 = new THREE.SphereGeometry(0.16, 6, 4);
  s1.translate(0.72, 1.0, -1.8);                 // fin-tip strobe
  const s2 = new THREE.SphereGeometry(0.12, 6, 4);
  s2.translate(0, -0.56, 0.55);                  // belly anti-collision
  geos.push(s1, s2);
  return mergeGeometries(geos);
}

// ---------------------------------------------------------------------------
// Parked street car: low armored sedan, wet dark paint.
// ---------------------------------------------------------------------------
function makeParkedCarGeo() {
  const geos = [];
  geos.push(box(1.98, 0.52, 4.6, 0, 0.55, 0));        // main slab
  geos.push(box(1.7, 0.5, 2.25, 0, 1.02, -0.4));      // cabin
  geos.push(box(1.55, 0.3, 0.7, 0, 0.98, 0.95));      // windshield slope
  geos.push(box(1.94, 0.3, 0.95, 0, 0.42, 2.62));     // front wedge
  geos.push(box(1.94, 0.34, 0.6, 0, 0.5, -2.55));     // rear bumper
  geos.push(box(1.86, 0.34, 4.15, 0, 0.22, 0));       // skirt
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const wh = new THREE.CylinderGeometry(0.37, 0.37, 0.28, 10);
    wh.rotateZ(Math.PI / 2);
    wh.translate(sx * 0.92, 0.37, sz * 1.5);
    geos.push(wh);
  }
  geos.push(box(0.5, 0.12, 0.9, -0.55, 1.32, -0.5));  // roof vent
  return mergeGeometries(geos);
}

function makeParkedCarLightsGeo() {
  const geos = [];
  for (const s of [-1, 1]) {
    geos.push(paint(box(0.4, 0.08, 0.04, s * 0.62, 0.62, -2.87), 0.5, 0.04, 0.03));
  }
  geos.push(paint(box(0.1, 0.05, 0.04, 0.85, 0.75, 2.9), 0.5, 0.32, 0.08));
  return mergeGeometries(geos);
}

// ---------------------------------------------------------------------------
// Flight lanes — smooth parametric paths; pos is a pure function of u.
// ---------------------------------------------------------------------------
function laneAlongZ({ x0, amp, om, ph, y, zStart, dirZ, len, speed }) {
  return {
    len, speed,
    pos(u, out) {
      out.set(
        x0 + amp * Math.sin(u * om + ph),
        y + 1.4 * Math.sin(u * 0.02 + ph * 2.0),
        zStart + dirZ * u,
      );
      return out;
    },
  };
}

function laneAcrossX({ y, zBase, zAmp, zOm, ph, xStart, dirX, len, speed }) {
  return {
    len, speed,
    pos(u, out) {
      out.set(
        xStart + dirX * u,
        y + 1.2 * Math.sin(u * 0.018 + ph),
        zBase + zAmp * Math.sin(u * zOm + ph),
      );
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Distant traffic rivers: instanced emissive streaks on high straight lanes.
// ---------------------------------------------------------------------------
function makeStreakLane(rng, { origin, dir, len, count, speed, yaw, tint, spread }) {
  const geo = new THREE.BoxGeometry(0.26, 0.2, 3.8); // long axis +z
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    fog: false,
  });
  const im = new THREE.InstancedMesh(geo, mat, count);
  const items = [];
  const c = new THREE.Color();
  const perp = new THREE.Vector3().crossVectors(dir, UP).normalize();
  for (let i = 0; i < count; i++) {
    const s0 = (i / count) * len + (rng() - 0.5) * (len / count) * 0.8;
    const lateral = (rng() - 0.5) * spread;
    const dy = (rng() - 0.5) * spread * 0.55;
    const stretch = 0.9 + rng() * 1.8;
    items.push({ s0, lateral, dy, stretch });
    const b = 0.45 + rng() * 0.55;
    c.setRGB(tint[0] * b, tint[1] * b, tint[2] * b);
    im.setColorAt(i, c);
  }
  im.instanceColor.needsUpdate = true;
  im.frustumCulled = false;
  const tmp = new THREE.Object3D();
  return {
    mesh: im,
    update(t) {
      for (let i = 0; i < count; i++) {
        const it = items[i];
        const s = (it.s0 + speed * t) % len;
        tmp.position.copy(origin)
          .addScaledVector(dir, s)
          .addScaledVector(perp, it.lateral);
        tmp.position.y += it.dy;
        tmp.rotation.set(0, yaw, 0);
        tmp.scale.set(1, 1, it.stretch);
        tmp.updateMatrix();
        im.setMatrixAt(i, tmp.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
export function buildVehicles() {
  const group = new THREE.Group();
  const rng = mulberry32(90210);

  // ---- shared geometry / materials --------------------------------------
  const hullGeo = makeSpinnerHullGeo();
  const lightsGeo = makeSpinnerLightsGeo();
  const beamGeo = makeHeadBeamGeo();
  const strobeGeo = makeStrobeGeo();

  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x11141a, metalness: 0.85, roughness: 0.38,
  });
  const lightsMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  const beamMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const strobeMat = new THREE.MeshBasicMaterial({ color: 0xff4048, fog: false });

  function assembleSpinner(scale) {
    const g = new THREE.Group();
    const hull = new THREE.Mesh(hullGeo, hullMat);
    const lights = new THREE.Mesh(lightsGeo, lightsMat);
    const beams = new THREE.Mesh(beamGeo, beamMat);
    const strobe = new THREE.Mesh(strobeGeo, strobeMat);
    beams.frustumCulled = false;
    g.add(hull, lights, beams, strobe);
    g.scale.setScalar(scale);
    group.add(g);
    return { g, strobe };
  }

  // ---- lanes + traffic spinners ------------------------------------------
  const lanes = {
    L1: laneAlongZ({ x0: -3.5, amp: 4.5, om: 0.035, ph: 0.5, y: 27, zStart: 70, dirZ: -1, len: 330, speed: 16 }),
    L2: laneAlongZ({ x0: 4.0, amp: 4.0, om: 0.03, ph: 2.1, y: 41, zStart: -260, dirZ: 1, len: 330, speed: 14 }),
    L3: laneAcrossX({ y: 66, zBase: -88, zAmp: 20, zOm: 0.012, ph: 0.8, xStart: -240, dirX: 1, len: 480, speed: 22 }),
    L4: laneAlongZ({ x0: 0.5, amp: 6.0, om: 0.028, ph: 4.0, y: 54, zStart: 60, dirZ: -1, len: 320, speed: 18 }),
  };
  // phases picked so several craft sit inside the hero frames at t=12
  const spinners = [
    { lane: lanes.L1, phase: 268 },
    { lane: lanes.L1, phase: 3 },
    { lane: lanes.L2, phase: 57 },
    { lane: lanes.L2, phase: 100 },
    { lane: lanes.L3, phase: 466 },
    { lane: lanes.L4, phase: 264 },
  ];
  for (const sp of spinners) {
    Object.assign(sp, assembleSpinner(0.95 + rng() * 0.35));
    sp.strobePhase = rng();
    sp.bobPhase = rng() * Math.PI * 2;
  }

  // ---- police spinner ----------------------------------------------------
  const police = assembleSpinner(1.15);
  // light bar on the canopy: red / blue, alternating
  const barR = new THREE.Mesh(
    box(0.28, 0.1, 0.3, -0.3, 0.82, 0.35),
    new THREE.MeshBasicMaterial({ color: 0xff2030, fog: false }),
  );
  const barB = new THREE.Mesh(
    box(0.28, 0.1, 0.3, 0.3, 0.82, 0.35),
    new THREE.MeshBasicMaterial({ color: 0x2050ff, fog: false }),
  );
  police.g.add(barR, barB);

  // searchlight: volumetric cone (unit length, scaled per frame) + SpotLight
  const searchCone = new THREE.Mesh(
    mergeGeometries([
      beamCone(0.10, 1, 0.5, 0.55, 0.6, 14),
      beamCone(0.045, 1, 0.9, 0.95, 1.0, 12),
    ]),
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
  );
  searchCone.frustumCulled = false;
  group.add(searchCone);

  const spot = new THREE.SpotLight(0xd8e8ff, 4000, 140, 0.13, 0.55, 2.0);
  spot.castShadow = false;
  group.add(spot, spot.target);

  // hot pool where the beam meets the street
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 20),
    new THREE.MeshBasicMaterial({
      color: 0x9fbdd8,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      fog: false,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  group.add(pool);

  // ---- distant traffic rivers -------------------------------------------
  const streakLanes = [
    // twin rivers running the canyon axis, high over the street
    makeStreakLane(rng, {
      origin: new THREE.Vector3(-4.5, 74, 14), dir: new THREE.Vector3(0, 0, -1),
      len: 264, count: 48, speed: 25, yaw: 0,
      tint: [1.0, 0.88, 0.62], spread: 3.2,
    }),
    makeStreakLane(rng, {
      origin: new THREE.Vector3(5.0, 82, -250), dir: new THREE.Vector3(0, 0, 1),
      len: 264, count: 42, speed: 22, yaw: 0,
      tint: [1.0, 0.24, 0.2], spread: 3.2,
    }),
    // crossing lane above the end-block, in front of the far tower wall
    makeStreakLane(rng, {
      origin: new THREE.Vector3(-200, 132, -160), dir: new THREE.Vector3(1, 0, 0),
      len: 400, count: 44, speed: 28, yaw: Math.PI / 2,
      tint: [0.6, 0.85, 1.0], spread: 6,
    }),
  ];
  for (const l of streakLanes) group.add(l.mesh);

  // ---- parked street cars ------------------------------------------------
  const carGeo = makeParkedCarGeo();
  const carLightsGeo = makeParkedCarLightsGeo();
  const carMat = new THREE.MeshStandardMaterial({
    color: 0x0b0d11, metalness: 0.75, roughness: 0.26,
  });
  const carLightsMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  const parked = [
    { x: 6.85, z: 17, ry: Math.PI + 0.04 },
    { x: -6.8, z: -24, ry: 0.06 },
  ];
  for (const p of parked) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(carGeo, carMat), new THREE.Mesh(carLightsGeo, carLightsMat));
    g.position.set(p.x, 0.02, p.z);
    g.rotation.y = p.ry;
    group.add(g);
  }

  // ---- per-frame update --------------------------------------------------
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
  const tanV = new THREE.Vector3(), accV = new THREE.Vector3();
  const sideV = new THREE.Vector3(), lookV = new THREE.Vector3();
  const target = new THREE.Vector3();
  const D = 2; // finite-difference step along lane parameter

  function flySpinner(sp, t) {
    const { lane } = sp;
    const u = ((sp.phase + lane.speed * t) % lane.len + lane.len) % lane.len;
    lane.pos(u - D, pA);
    lane.pos(u, pB);
    lane.pos(u + D, pC);
    tanV.subVectors(pC, pA).normalize();
    // lateral accel (world units / u^2) -> m/s^2 via speed^2
    accV.copy(pA).addScaledVector(pB, -2).add(pC).multiplyScalar(1 / (D * D));
    sideV.crossVectors(tanV, UP).normalize();
    const lat = accV.dot(sideV) * lane.speed * lane.speed;
    const roll = THREE.MathUtils.clamp((lat / 9.8) * 2.2, -0.55, 0.55);
    sp.g.position.copy(pB);
    sp.g.position.y += 0.3 * Math.sin(t * 1.6 + sp.bobPhase);
    lookV.copy(pB).add(tanV);
    sp.g.lookAt(lookV);
    sp.g.rotateZ(roll);
    sp.g.rotateX(-0.03);
    // double-flash strobe
    const f = (t * 1.1 + sp.strobePhase) % 1;
    sp.strobe.visible = f < 0.05 || (f > 0.12 && f < 0.16);
  }

  function update(t) {
    for (const sp of spinners) flySpinner(sp, t);

    // -- police: slow hover-drift over the street, nose tracking the beam --
    const px = 6 * Math.sin(t * 0.11);
    const pz = -46 + 10 * Math.sin(t * 0.07 + 1.0);
    const py = 34 + 1.1 * Math.sin(t * 0.5);
    target.set(
      4.5 * Math.sin(t * 0.31 + 0.7),
      0.1,
      -46 + 30 * Math.sin(t * 0.17 + 2.1),
    );
    police.g.position.set(px, py, pz);
    lookV.set(target.x, py, target.z);
    police.g.lookAt(lookV);
    police.g.rotateZ(0.05 * Math.sin(t * 0.23));
    const pf = (t * 1.3) % 1;
    police.strobe.visible = pf < 0.05 || (pf > 0.12 && pf < 0.16);
    barR.visible = Math.sin(t * 9) > 0;
    barB.visible = !barR.visible;

    // searchlight beam from belly to street
    searchCone.position.set(px, py - 0.7, pz);
    const dist = searchCone.position.distanceTo(target);
    searchCone.lookAt(target);
    searchCone.scale.set(dist, dist, dist);
    spot.position.copy(searchCone.position);
    spot.target.position.copy(target);
    pool.position.set(target.x, 0.09, target.z);
    const pk = 0.8 + 0.2 * Math.sin(t * 2.3);
    pool.scale.setScalar(pk);

    for (const l of streakLanes) l.update(t);
  }

  return { group, update };
}
