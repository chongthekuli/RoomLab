// Wall-naming convention fixture (Sam, 2026-05-19).
//
// Failure mode this prevents
// --------------------------
// js/physics/precision/triangulate-scene.js maps axis-aligned walls to
// sourceKey strings ('wall_north', 'wall_south', 'wall_east',
// 'wall_west') via the `wallSpecs` table at triangulate-scene.js
// L493-498. The convention is:
//
//     wall_north sits at state-y = 0  (inward normal +y)
//     wall_south sits at state-y = d  (inward normal -y)
//     wall_east  sits at state-x = w  (inward normal -x)
//     wall_west  sits at state-x = 0  (inward normal +x)
//
// This convention was REVERSED from what naive intuition suggests (you
// might expect "north" to mean +y / "front of room"). The current
// mapping was chosen to align with scene.js's wall_north / wall_south
// mesh placement so that user-authored surfaces[wall_north] = "wood-
// floor" lands on the correct quad. See the comment at L468-489 for
// the full reasoning.
//
// Brittleness this fixture pins
// -----------------------------
// At least two existing tests implicitly depended on this convention:
//
//   • tests/precision-bvh.test.mjs — counts triangles by tag, asserts
//     wall sourceKeys; commit f49895b had to align "wall_X" expectations
//     with the current spec.
//   • tests/treatments-precision-v3.test.mjs — places a treatment on
//     'wall_north' and shoots a ray; commit e20b223 had to align which
//     wall the ray actually hits at state-y=0 vs state-y=d.
//
// Both broke today's CI when an orientation refactor flipped the
// convention. Five-plus tests will be silently sensitive to any future
// flip. One canonical fixture — this file — names the convention so the
// next person who proposes a flip sees the violation immediately and
// decides intentionally.
//
// Authoritative source: js/physics/precision/triangulate-scene.js
//   L493-498 (the wallSpecs table).
//
// Run: node tests/wall-naming-convention.test.mjs

import { readFileSync } from 'node:fs';
import { triangulateScene } from '../js/physics/precision/triangulate-scene.js';
import { buildBVH, intersectRay } from '../js/physics/precision/bvh.js';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';

let failed = 0;
const pass = (l) => console.log(`PASS  ${l}`);
const fail = (l, e = '') => { console.log(`FAIL  ${l}${e ? '  — ' + e : ''}`); failed++; };
const ok = (c, l, e = '') => (c ? pass(l) : fail(l, e));

// --------------------------------------------------------------------
// Materials (same shape as every other physics test).
// --------------------------------------------------------------------

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

// --------------------------------------------------------------------
// Fixture: 10×10×3 m rectangular room, NO openings, NO sources, NO
// listeners, NO treatments. The simplest possible geometry that has
// all four cardinal walls — anything more elaborate would muddy which
// quad a ray actually hits.
// --------------------------------------------------------------------

const state = {
  room: {
    shape: 'rectangular',
    width_m: 10, depth_m: 10, height_m: 3,
    surfaces: {
      floor: 'wood-floor', ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east:  'gypsum-board', wall_west:  'gypsum-board',
    },
  },
  sources: [], listeners: [], zones: [], treatments: [],
  physics: {},
};

const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: () => null });
const soup = triangulateScene(scene);
const bvh = buildBVH(soup);

// --------------------------------------------------------------------
// Ray probes from the room centre. Origin (5, 5, 1.5) — middle of the
// 10×10×3 m box. Shoot one ray along each cardinal direction; assert
// which wall sourceKey wins AND that the hit distance is exactly 5 m
// (sanity check on the room-extents math, in case anyone breaks the
// quad placement and the convention test still happens to pass by
// luck).
// --------------------------------------------------------------------

const ORIGIN = { x: 5, y: 5, z: 1.5 };
const TOL_DIST_M = 0.01;

const probes = [
  { dir: { dx: +1, dy:  0, dz: 0 }, expect: 'wall_east',  why: '+x → east wall at state-x = 10' },
  { dir: { dx: -1, dy:  0, dz: 0 }, expect: 'wall_west',  why: '-x → west wall at state-x = 0'  },
  { dir: { dx:  0, dy: +1, dz: 0 }, expect: 'wall_south', why: '+y → south wall at state-y = 10 (convention: south = +y direction)' },
  { dir: { dx:  0, dy: -1, dz: 0 }, expect: 'wall_north', why: '-y → north wall at state-y = 0  (convention: north = -y direction)' },
];

for (const probe of probes) {
  const hit = intersectRay(bvh, ORIGIN.x, ORIGIN.y, ORIGIN.z,
                                probe.dir.dx, probe.dir.dy, probe.dir.dz);
  if (!hit) {
    fail(`ray ${JSON.stringify(probe.dir)} → no hit (BVH empty or geometry broken)`);
    continue;
  }
  // sourceKey carries a `_p<quadIndex>` suffix (per-quad cutout index)
  // — equality would be too strict; startsWith tolerates the suffix
  // without permitting cross-wall confusion.
  ok(hit.sourceKey.startsWith(probe.expect),
     `${probe.why} → sourceKey starts with '${probe.expect}'`,
     `actual sourceKey: '${hit.sourceKey}'`);
  ok(Math.abs(hit.t - 5.0) < TOL_DIST_M,
     `${probe.why} → distance = 5.0 m ± ${TOL_DIST_M}`,
     `actual t = ${hit.t.toFixed(4)} m`);
}

// --------------------------------------------------------------------
// Z-axis sanity — floor / ceiling tags. Not strictly part of the
// wall-naming convention but they share the wallSpecs table's
// "implicit assumption" surface area: if anyone moves the floor or
// ceiling to a non-standard z, the precision tracer breaks. Cheap
// to assert here.
// --------------------------------------------------------------------

const floorHit = intersectRay(bvh, ORIGIN.x, ORIGIN.y, ORIGIN.z, 0, 0, -1);
ok(floorHit && floorHit.sourceKey === 'floor',
   '-z → floor sourceKey === "floor"',
   `actual: ${floorHit?.sourceKey ?? 'no-hit'}`);
ok(floorHit && Math.abs(floorHit.t - 1.5) < TOL_DIST_M,
   '-z → distance = 1.5 m from origin (1.5) to floor (0)');

const ceilingHit = intersectRay(bvh, ORIGIN.x, ORIGIN.y, ORIGIN.z, 0, 0, +1);
ok(ceilingHit && ceilingHit.sourceKey === 'ceiling',
   '+z → ceiling sourceKey === "ceiling"',
   `actual: ${ceilingHit?.sourceKey ?? 'no-hit'}`);
ok(ceilingHit && Math.abs(ceilingHit.t - 1.5) < TOL_DIST_M,
   '+z → distance = 1.5 m from origin (1.5) to ceiling (3.0)');

// --------------------------------------------------------------------
// Text-grep gate on the wallSpecs table. If anyone rewrites the
// triangulator's wall iteration in a way that changes the convention
// without updating this fixture, the ray probes above will fail. But
// they'll fail with a generic "wrong wall" message — the grep below
// names the EXACT source-line that needs review.
// --------------------------------------------------------------------

const triSrc = readFileSync('./js/physics/precision/triangulate-scene.js', 'utf8');

// wall_north at v1.y = 0 / v2.y = 0
ok(/key: 'wall_north', v1: \{ x: w, y: 0 \}, v2: \{ x: 0, y: 0 \}, n: \[0, +1, 0\]/.test(triSrc),
   "triangulate-scene.js: wall_north anchored at state-y = 0 with inward normal +y");

// wall_south at v1.y = d / v2.y = d
ok(/key: 'wall_south', v1: \{ x: 0, y: d \}, v2: \{ x: w, y: d \}, n: \[0, -1, 0\]/.test(triSrc),
   "triangulate-scene.js: wall_south anchored at state-y = d with inward normal -y");

// wall_east at v1.x = w / v2.x = w
ok(/key: 'wall_east',  v1: \{ x: w, y: 0 \}, v2: \{ x: w, y: d \}, n: \[-1, 0, 0\]/.test(triSrc),
   "triangulate-scene.js: wall_east anchored at state-x = w with inward normal -x");

// wall_west at v1.x = 0 / v2.x = 0
ok(/key: 'wall_west',  v1: \{ x: 0, y: d \}, v2: \{ x: 0, y: 0 \}, n: \[ 1, 0, 0\]/.test(triSrc),
   "triangulate-scene.js: wall_west anchored at state-x = 0 with inward normal +x");

// --------------------------------------------------------------------
// Report.
// --------------------------------------------------------------------

if (failed > 0) {
  console.log('\n--- Hit map (origin 5, 5, 1.5 in a 10×10×3 m room) ---');
  for (const probe of probes) {
    const hit = intersectRay(bvh, ORIGIN.x, ORIGIN.y, ORIGIN.z,
                                  probe.dir.dx, probe.dir.dy, probe.dir.dz);
    console.log(`  dir=${JSON.stringify(probe.dir)}  expect=${probe.expect}  got=${hit?.sourceKey ?? 'no-hit'}  t=${hit?.t.toFixed(4) ?? '-'}`);
  }
}

console.log(failed === 0
  ? '\nAll wall-naming convention tests passed.'
  : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
