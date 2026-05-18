// Surau minaret BVH presence + placement regression test.
//
// Pins the minaret shaft into the precision-tracer BVH. The minaret was
// historically excluded with a wrong rationale ("no ray path reaches it");
// outdoor arcade speakers + outdoor listeners absolutely see it. This
// test fails LOUD if it ever falls back out of the BVH.
//
// Run: node tests/surau-minaret-bvh.test.mjs

import { state, applyPresetToState } from '../js/app-state.js';
import { triangulateScene, SURFACE_TAGS } from '../js/physics/precision/triangulate-scene.js';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';
import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function assertClose(actual, expected, tol, label) {
  const diff = Math.abs(actual - expected);
  const good = diff < tol;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}  actual=${actual.toFixed(4)} expected=${expected.toFixed(4)}`);
  if (!good) failed++;
}

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

applyPresetToState('surau');
const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: () => null });
const soup = triangulateScene(scene);

// Find every triangle whose sourceKey identifies it as the minaret shaft.
const minaretTris = [];
for (let i = 0; i < soup.count; i++) {
  if (soup.sourceKey[i] === 'surau_minaret') minaretTris.push(i);
}

// 4 wall quads × 2 triangles each = 8 triangles.
ok(minaretTris.length === 8, `minaret shaft → 8 triangles (4 quads × 2)  got ${minaretTris.length}`);

// All minaret triangles must carry TAG_WALL.
const allWalls = minaretTris.every(i => soup.surfaceTag[i] === SURFACE_TAGS.WALL);
ok(allWalls, 'minaret triangles all tagged WALL');

// Compute the AABB of the minaret triangles and verify against the
// expected footprint + height. Corner is whatever the preset configures
// (NE per current preset; this test reads it dynamically so a future
// corner flip doesn't silently regress).
const mn = state.room.surauStructure.minaret;
const W = state.room.width_m, D = state.room.depth_m;
const baseSize = mn.base_size_m;
const clearance = 0.6 + baseSize / 2;
const cornerOffsets = {
  SW: { x: -clearance,    y: -clearance    },
  SE: { x: W + clearance, y: -clearance    },
  NW: { x: -clearance,    y: D + clearance },
  NE: { x: W + clearance, y: D + clearance },
};
const co = cornerOffsets[mn.corner];
const cx = co.x;
const cy = co.y;
const half = baseSize / 2;
const shaftH = mn.height_m * 0.90;
console.log(`(testing minaret at corner=${mn.corner}, centre=(${cx}, ${cy}), shaftH=${shaftH})`);

let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
for (const ti of minaretTris) {
  for (let v = 0; v < 3; v++) {
    const px = soup.positions[ti * 9 + v * 3 + 0];
    const py = soup.positions[ti * 9 + v * 3 + 1];
    const pz = soup.positions[ti * 9 + v * 3 + 2];
    if (px < xMin) xMin = px; if (px > xMax) xMax = px;
    if (py < yMin) yMin = py; if (py > yMax) yMax = py;
    if (pz < zMin) zMin = pz; if (pz > zMax) zMax = pz;
  }
}

assertClose(xMin, cx - half,   1e-6, `minaret aabb.min.x = ${(cx - half).toFixed(3)}`);
assertClose(xMax, cx + half,   1e-6, `minaret aabb.max.x = ${(cx + half).toFixed(3)}`);
assertClose(yMin, cy - half,   1e-6, `minaret aabb.min.y = ${(cy - half).toFixed(3)}`);
assertClose(yMax, cy + half,   1e-6, `minaret aabb.max.y = ${(cy + half).toFixed(3)}`);
assertClose(zMin, 0,           1e-6, 'minaret aabb.min.z = 0');
assertClose(zMax, shaftH,      1e-6, `minaret aabb.max.z = ${shaftH.toFixed(3)}`);

// All 4 face normals must point AWAY from the minaret centre (outward).
// Sum (face_normal · radial_to_centre) — should be strictly negative
// for every triangle if normals point outward.
let outwardOk = 0, outwardBad = 0;
for (const ti of minaretTris) {
  const nx = soup.normals[ti * 3 + 0];
  const ny = soup.normals[ti * 3 + 1];
  const nz = soup.normals[ti * 3 + 2];
  // Centroid of the triangle.
  let tcx = 0, tcy = 0;
  for (let v = 0; v < 3; v++) {
    tcx += soup.positions[ti * 9 + v * 3 + 0];
    tcy += soup.positions[ti * 9 + v * 3 + 1];
  }
  tcx /= 3; tcy /= 3;
  // Radial vector pointing FROM the minaret centre to the triangle centroid.
  const rx = tcx - cx, ry = tcy - cy;
  // Outward normal should have positive dot product with this radial.
  const dot = nx * rx + ny * ry + nz * 0;
  if (dot > 0.01) outwardOk++; else outwardBad++;
}
ok(outwardBad === 0, `every minaret face normal points outward (${outwardOk}/8 OK, ${outwardBad} flipped)`);

// Material index must be a real material, not -1.
const allMats = minaretTris.every(i => soup.materialIdx[i] >= 0);
ok(allMats, 'minaret triangles have a valid material index (not -1)');

console.log(failed === 0
  ? '\nAll surau minaret BVH tests passed.'
  : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
