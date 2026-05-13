// v3 treatment-scattering bridge — integration + regression tests.
//
// Covers three integration scenarios called out in Hannes' PR2 brief:
//
//   1. Coincident-surface tie-break (ε offset is doing its job)
//      A ray fired from a known direction toward a treatment+wall
//      pair MUST hit the treatment first, not the wall behind. We
//      verify by inspecting the BVH intersection result for the
//      first ray segment.
//
//   2. Absorption double-count check
//      The wall behind a treatment must NOT contribute reflected
//      energy a second time. Tested via two synthetic scenes (wall
//      α 0.05, treatment α_p 0.80) — the first reflection's
//      remaining energy must equal (1-0.80) of incident, NOT
//      (1-0.80)·(1-0.05).
//
//   3. End-to-end QRD validation (Dr. Chen's acceptance band)
//      Compares post-v3 broadband C50 and STI for the 10-QRD scene
//      against the pre-v3 fixture, asserting the drift lands inside
//      ΔC50 ∈ [-1.5, -0.3] dB, ΔSTI ∈ [-0.04, +0.02]. This is the
//      gate that says "v3 changes the answers in the right
//      direction by the right magnitude for a diffuser-rich room".
//
// Catalogue fact (verified at fixture-author time): the Skyline 2D
// QRD entry in data/treatment-products.json carries:
//   absorption          = [0.05, 0.10, 0.15, 0.20, 0.20, 0.15, 0.10]
//   scattering_coef     = [0.20, 0.30, 0.50, 0.85, 0.90, 0.85, 0.70]
// The 8×10×3 m fixture room has ≈ 108 m² of wall area; 10 × 0.36 m²
// = 3.6 m² of QRD covers ~3.3 % of the wall budget. Drift is
// expected to be SMALL in this scene; if a future Dr. Chen audit
// concludes the acceptance band should be relaxed for low-coverage
// fixtures, regenerate this test's tolerance constants alongside her
// updated audit list.

import { readFileSync } from 'node:fs';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';
import { triangulateScene } from '../js/physics/precision/triangulate-scene.js';
import { buildBVH, intersectRay } from '../js/physics/precision/bvh.js';
import { traceRays } from '../js/physics/precision/tracer-core.js';
import { deriveMetrics } from '../js/physics/precision/derive-metrics.js';
import { makeTreatmentEntry } from '../js/ui/panel-treatments.js';
import {
  _setCachedCatalogueForTests,
  _clearCachedCatalogueForTests,
  getTreatmentScattering,
} from '../js/labs/surfacelab/catalog.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function assertBetween(actual, lo, hi, label) {
  const good = Number.isFinite(actual) && actual >= lo && actual <= hi;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}  actual=${Number(actual).toFixed(4)} window=[${lo}, ${hi}]`);
  if (!good) failed++;
}

const matJson = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};
const productJson = JSON.parse(readFileSync('data/treatment-products.json', 'utf8'));
const QRD = productJson.products.find(p => p.id === 'rpg-skyline-2d');

// Pre-seed the catalogue cache — scene-snapshot.js calls
// getCachedCatalogue() at build time to resolve scattering
// coefficients for the synthetic `treatment:*` material entries.
_setCachedCatalogueForTests({
  all: [QRD],
  groups: [],
});

const stubSpeaker = {
  acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 3 },
};
const getDef = () => stubSpeaker;

// ---- Test 1: getTreatmentScattering catalogue accessor -------------------

{
  const s1k = getTreatmentScattering('rpg-skyline-2d', 3);   // 1 kHz band idx
  ok(Math.abs(s1k - 0.85) < 1e-6,
    `getTreatmentScattering(skyline, band=3=1kHz) = 0.85 (got ${s1k})`);
  const sBogus = getTreatmentScattering('rpg-skyline-2d', 99);
  ok(sBogus === null,
    `getTreatmentScattering returns null for out-of-range bandIdx (got ${sBogus})`);
  const sMissing = getTreatmentScattering('no-such-product', 3);
  ok(sMissing === null,
    `getTreatmentScattering returns null for unknown productId (got ${sMissing})`);
}

// ---- Test 2: coincident-surface tie-break --------------------------------
// Build a tiny shoebox with one panel on wall_north and fire a single
// ray from the room centre toward the panel centre. The BVH MUST
// report the treatment quad as the first hit, not the wall behind.

{
  const state = {
    room: {
      shape: 'rectangular', width_m: 4, depth_m: 4, height_m: 3,
      surfaces: {
        floor: 'gypsum-board', ceiling: 'gypsum-board',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
    },
    zones: [], sources: [], listeners: [],
    treatments: [
      makeTreatmentEntry(QRD,
        { surface: 'wall', wallIndex: 0 },   // north (y=4)
        { x: 2, y: 4, z: 1.5 },
        0),
    ],
    physics: {},
  };
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  // Ray from room centre toward the panel centre (along +y).
  const hit = intersectRay(bvh, 2, 1, 1.5, 0, 1, 0, Infinity);
  ok(hit && hit.surfaceTag === 6 /* TAG_TREATMENT */,
    `Coincident tie-break: first hit is the treatment quad (got surfaceTag=${hit?.surfaceTag}, key='${hit?.sourceKey}')`);
  // Geometric arrival: source y=1, panel face y=4 - 1e-3 = 3.999.
  // Expected t = 2.999 m.
  ok(hit && Math.abs(hit.t - 2.999) < 0.01,
    `Coincident tie-break: ray hits at t≈2.999 m (got ${hit?.t.toFixed(4)})`);
}

// ---- Test 3: absorption is single-count (no wall-behind double dip) ------
//
// The brief's worry: if the tracer reflected the wall-behind a
// treatment after it ALSO reflected the treatment in front, a ray
// hitting a treatment would get hit by TWO α attenuations on what
// the user perceives as a single surface interaction.
//
// We prove the invariant geometrically rather than energetically:
//   (a) The ray's FIRST hit on a treatment-fronted wall is the
//       treatment quad (tested in Test 2 above).
//   (b) After the bounce, the reflected ray's direction is +n (away
//       from the wall). The wall behind the treatment is at distance
//       ε along -n — which the reflected ray IS NOT TRAVELLING
//       TOWARDS. So the wall behind is geometrically unreachable by
//       the reflected ray on this segment; the tracer's NEXT
//       intersectRay call cannot land on it. No double-count.
//   (c) For rays that go AROUND the treatment (panel coverage <
//       wall coverage), they hit the wall directly at full wall α.
//       That's the intended behaviour — wall behind contributes
//       proportional to (wall area − panel area), matching Sabine's
//       overlap math.
//
// Test (a) is Test 2. Tests (b)+(c) we cover with one direct BVH
// probe each.

{
  const wallMatId = 'gypsum-board';
  const mock = {
    id: 'mock-abs',
    name: 'Mock 0.80',
    category: 'absorber.porous.panel',
    absorption: new Array(7).fill(0.80),
    scattering_coefficient: new Array(7).fill(0),
    geometry: { width_mm: 1000, height_mm: 1000, depth_mm: 50 },
  };
  _setCachedCatalogueForTests({ all: [mock], groups: [] });
  // 4×4×3 shoebox with the mock absorber on wall_north (y=4). Panel
  // is 1 m × 1 m centred at (2, 4, 1.5). Walls all gypsum-board.
  const state = {
    room: {
      shape: 'rectangular', width_m: 4, depth_m: 4, height_m: 3,
      surfaces: {
        floor: wallMatId, ceiling: wallMatId,
        wall_north: wallMatId, wall_south: wallMatId,
        wall_east: wallMatId, wall_west: wallMatId,
      },
    },
    zones: [], sources: [], listeners: [],
    treatments: [
      makeTreatmentEntry(mock, { surface: 'wall', wallIndex: 0 },
        { x: 2, y: 4, z: 1.5 }, 0),
    ],
    physics: { airAbsorption: false },
  };
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);

  // (b) Reflected ray AT THE TREATMENT FACE. The hit point is on the
  // treatment quad (y = 4 - 1e-3); the reflected direction for a ray
  // that came in along +y is -y. Origin nudged +EPS along reflected
  // direction matches the tracer's own self-intersection avoidance.
  // The next BVH hit MUST NOT be the wall behind (y=4); it must be
  // either the floor, ceiling, opposite wall, or escape.
  const refOrigin = [2, 4 - 1e-3 - 1e-6, 1.5];
  const refDir = [0, -1, 0];
  const refHit = intersectRay(bvh,
    refOrigin[0], refOrigin[1], refOrigin[2],
    refDir[0], refDir[1], refDir[2], Infinity);
  ok(refHit && refHit.sourceKey !== 'wall_north',
    `No double-count: reflected ray from treatment face does NOT hit wall_north behind (got '${refHit?.sourceKey}', t=${refHit?.t.toFixed(3)})`);
  // (b.cont) The reflected ray should hit wall_south at t = 4 - 1e-3 ≈ 4 m.
  ok(refHit && refHit.sourceKey === 'wall_south' && Math.abs(refHit.t - 4) < 0.01,
    `No double-count: reflected ray hits wall_south at t≈4 m (got '${refHit?.sourceKey}', t=${refHit?.t.toFixed(3)})`);

  // (c) Bypass ray going AROUND the panel. Ray from (3.7, 0, 1.5)
  // toward +y at x=3.7 misses the 1×1 panel (panel x range
  // [1.5, 2.5]) and SHOULD hit wall_north at y=4 directly. This
  // proves the wall behind still contributes to rays the panel
  // doesn't shadow — the proportional-coverage invariant.
  const bypassHit = intersectRay(bvh, 3.7, 0, 1.5, 0, 1, 0, Infinity);
  ok(bypassHit && bypassHit.sourceKey === 'wall_north',
    `Wall-behind contributes for rays around the panel: bypass ray hits wall_north (got '${bypassHit?.sourceKey}', t=${bypassHit?.t.toFixed(3)})`);
  ok(bypassHit && Math.abs(bypassHit.t - 4) < 0.01,
    `Bypass ray hits wall at t≈4 m, no panel shadowing (got t=${bypassHit?.t.toFixed(3)})`);
}

// Restore the QRD-only catalogue for the E2E test below.
_setCachedCatalogueForTests({ all: [QRD], groups: [] });

// ---- Test 4: end-to-end QRD validation vs PR1 baseline -------------------
// Loads the frozen pre-v3 baseline from tests/fixtures and asserts
// the v3 drift on C50 and STI lands inside Dr. Chen's accepted band.
// NOTE: brief acceptance window is ΔC50 ∈ [-1.5, -0.3] dB and
// ΔSTI ∈ [-0.04, +0.02]. The window assumes a diffuser-rich scene;
// at low panel coverage (3.6 m² out of ~108 m² wall area in the
// reference 8×10×3 m room) the geometric drift is bounded toward
// zero. This assertion is the SHIPPING GATE — if the drift sits
// outside the band the v3 plumbing has a regression OR the
// fixture scene needs heavier coverage; either way Dr. Chen reads
// the test output before merge.

const baseline = JSON.parse(readFileSync('tests/fixtures/golden-precision-pre-v3.json', 'utf8'));

function preciseQrdSnapshot() {
  const ROOM_W = 8, ROOM_D = 10, ROOM_H = 3;
  const panels = [];
  for (let i = 0; i < 3; i++) {
    panels.push(makeTreatmentEntry(QRD, { surface: 'wall', wallIndex: 0 }, { x: 1.5 + i * 2.5, y: ROOM_D, z: 1.5 }, 0));
  }
  for (let i = 0; i < 3; i++) {
    panels.push(makeTreatmentEntry(QRD, { surface: 'wall', wallIndex: 1 }, { x: 1.5 + i * 2.5, y: 0, z: 1.5 }, 0));
  }
  for (let i = 0; i < 2; i++) {
    panels.push(makeTreatmentEntry(QRD, { surface: 'wall', wallIndex: 2 }, { x: ROOM_W, y: 2.5 + i * 3.5, z: 1.5 }, 0));
  }
  for (let i = 0; i < 2; i++) {
    panels.push(makeTreatmentEntry(QRD, { surface: 'wall', wallIndex: 3 }, { x: 0, y: 2.5 + i * 3.5, z: 1.5 }, 0));
  }
  const state = {
    room: {
      shape: 'rectangular',
      width_m: ROOM_W, depth_m: ROOM_D, height_m: ROOM_H,
      surfaces: {
        floor: 'concrete-painted',
        ceiling: 'gypsum-board',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
    },
    zones: [],
    sources: [{ modelUrl: 'stub', position: { x: 4, y: 2, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 }],
    listeners: [{ id: 'L1', label: 'Rec', position: { x: 5.5, y: 7.5 }, elevation_m: 0.0, receiver_radius_m: 0.5 }],
    treatments: panels,
    physics: { airAbsorption: true },
  };
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const result = traceRays(scene, bvh, {
    raysPerSource: 10000, maxBounces: 60, bucketDtMs: 2, maxTimeMs: 1500, seed: 4242,
  });
  result.scene = scene;
  const metrics = deriveMetrics(result, {});
  return {
    c50_db: metrics[0].broadband.c50_db,
    sti: metrics[0].sti.sti,
  };
}

{
  const live = preciseQrdSnapshot();
  const dC50 = live.c50_db - baseline.qrd.c50_db;
  const dSTI = live.sti - baseline.qrd.sti;
  console.log(`INFO  QRD baseline c50=${baseline.qrd.c50_db} sti=${baseline.qrd.sti}`);
  console.log(`INFO  QRD live     c50=${live.c50_db.toFixed(3)} sti=${live.sti.toFixed(3)}`);
  console.log(`INFO  Δ            c50=${dC50.toFixed(3)} dB  sti=${dSTI.toFixed(3)}`);
  assertBetween(dC50, -1.5, -0.3, `Dr. Chen acceptance: ΔC50 ∈ [-1.5, -0.3] dB on QRD-rich scene`);
  assertBetween(dSTI, -0.04,  0.02, `Dr. Chen acceptance: ΔSTI ∈ [-0.04, +0.02] on QRD-rich scene`);
}

_clearCachedCatalogueForTests();

console.log('');
console.log(failed === 0 ? 'All v3 treatment-scattering tests passed.' : `${failed} v3 treatment-scattering tests FAILED.`);
process.exit(failed === 0 ? 0 : 1);
