// FurnitureLAB Beer-Lambert sink — precision-tracer regression test.
//
// Phase 2 (2026-05-26). The precision ray-tracer used to shoot rays
// straight through placed furniture. This commit adds an absorber-
// volume sink (Dr. Chen brief: μ_b = A_obj / (4·V_bbox), Kuttruff
// 5e §4.1 eq. 4.11). This test locks down the behaviours that catch
// the canonical bugs Dr. Chen warned about:
//
//   1. Formula: μ = A_obj/(4·V_bbox) — dropping the factor of 4 is
//      the classic 25%-low bug.
//   2. Null case: empty state.furniture → tracer output unchanged
//      (regression guard against breaking the existing engine).
//   3. Sign + magnitude: adding furniture must DECREASE T30, by an
//      amount that scales with the per-object A_obj.
//   4. AABB intersection: the AABB BVH actually fires on rays that
//      pass through placed bboxes (catches "snapshot didn't include
//      furniture" wiring bugs).
//   5. Multiplicativity: 10× more furniture absorbs roughly 10× more
//      (catches per-bounce probabilistic absorption bug — would lose
//      the linearity).
//
// What this test deliberately DOESN'T do: assert exact ±7% match to
// the Sabine prediction. Doing so requires maxBounces ~300+ for the
// tracer's energy histogram to fully converge against the
// statistical-acoustics limit — Phase 2.5 work, not a tripwire goal.
// The properties above are enough to catch every canonical bug
// without paying the convergence cost.

import { triangulateScene } from '../js/physics/precision/triangulate-scene.js';
import { buildBVH, buildAabbBVH, intersectRay_collectAabbs } from '../js/physics/precision/bvh.js';
import { traceRays } from '../js/physics/precision/tracer-core.js';
import { deriveMetrics } from '../js/physics/precision/derive-metrics.js';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';
import { _setFurnitureCatalogueForTests } from '../js/labs/furniturelab/catalog.js';
import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// --- Materials --------------------------------------------------------
const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const FLAT_010 = {
  id: 'test-flat-010',
  name: 'Flat 0.10 test material',
  absorption: [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10],
  // High scattering so the field is closer to diffuse — gives the
  // furniture sink a fair chance to act uniformly (Sabine assumption).
  scattering: [0.80, 0.80, 0.80, 0.80, 0.80, 0.80, 0.80],
};
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: [...matJson.materials, FLAT_010],
  byId: Object.fromEntries([...matJson.materials, FLAT_010].map(m => [m.id, m])),
};
const stubSpeaker = { acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 0 } };
const getDef = () => stubSpeaker;

// --- Synthetic shoebox ------------------------------------------------
const ROOM_W = 10, ROOM_D = 8, ROOM_H = 4;
function makeShoeboxState({ furniture = [] } = {}) {
  return {
    room: {
      shape: 'rectangular', width_m: ROOM_W, depth_m: ROOM_D, height_m: ROOM_H,
      surfaces: {
        floor: 'test-flat-010', ceiling: 'test-flat-010',
        wall_north: 'test-flat-010', wall_south: 'test-flat-010',
        wall_east: 'test-flat-010', wall_west: 'test-flat-010',
        walls: 'test-flat-010',
      },
    },
    zones: [],
    sources: [{ modelUrl: 'stub', position: { x: 2, y: 2, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 }],
    listeners: [{ id: 'L1', label: 'Rec', position: { x: 8, y: 6 }, elevation_m: 0, receiver_radius_m: 0.5, posture: 'standing' }],
    physics: { airAbsorption: false },
    treatments: [],
    furniture,
  };
}

const TRACE_OPTS = {
  raysPerSource: 100_000,
  maxBounces: 80,
  bucketDtMs: 2,
  maxTimeMs: 3_000,
  seed: 42,
  airAbsorption: false,
};

const N_FURNI = 20;
const A_OBJ = 0.5;
const FOOTPRINT_W = 1.0;
const FOOTPRINT_D = 1.0;
const FOOTPRINT_H = 0.5;

// --- Catalogue ---------------------------------------------------------
const TEST_ROW = {
  id: 'test-absorber-half-sabine',
  name: 'Test absorber',
  short_name: 'Test',
  category: 'decorative',
  footprint: { shape: 'rectangle', width_m: FOOTPRINT_W, depth_m: FOOTPRINT_D, height_m: FOOTPRINT_H },
  placement: { mounts_on: 'floor' },
  visual: { family: 'flat-pad' },
  acoustics: {
    model: 'equivalent_absorption_area',
    A_obj_m2_sab_per_band: { '125': A_OBJ, '250': A_OBJ, '500': A_OBJ, '1000': A_OBJ, '2000': A_OBJ, '4000': A_OBJ },
    scattering_per_band: null,
    occupancy_state: null,
    paired_state_id: null,
  },
  citation: { source: 'test', reference: 'synthetic', measurement_method: 'synthetic', estimated: true, notes: null },
  reliability: 'estimated',
  linked_device_id: null,
  schema_version: 2,
  added: '2026-05-26', revised: null, revised_by: null, revised_note: null,
};
// Same row but with 10× higher A_obj — used for the multiplicativity
// check below.
const TEST_ROW_10X = {
  ...TEST_ROW,
  id: 'test-absorber-10x',
  acoustics: {
    ...TEST_ROW.acoustics,
    A_obj_m2_sab_per_band: { '125': A_OBJ * 10, '250': A_OBJ * 10, '500': A_OBJ * 10, '1000': A_OBJ * 10, '2000': A_OBJ * 10, '4000': A_OBJ * 10 },
  },
};
_setFurnitureCatalogueForTests([TEST_ROW, TEST_ROW_10X]);

// 20 placements on a 5×4 grid inside the room.
function makePlacements(catalogueId) {
  const out = [];
  let n = 1;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 4; j++) {
      out.push({
        id: `F${n++}`,
        catalogueId,
        position: { x: 1.5 + i * 1.6, y: 1.5 + j * 1.5 },
        rotation_deg: 0,
      });
    }
  }
  return out;
}
const placements    = makePlacements(TEST_ROW.id);
const placements10x = makePlacements(TEST_ROW_10X.id);

const band1k = materials.frequency_bands_hz.indexOf(1000);
ok(band1k >= 0, 'materials catalogue includes 1 kHz octave band');

// =====================================================================
// Block 1 — Formula: μ_b = A_obj / (4·V_bbox)
// Catches Dr. Chen's "dropped the factor of 4" bug at snapshot time,
// before the tracer even sees the value.
// =====================================================================
{
  const state = makeShoeboxState({ furniture: placements });
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  const V_bbox = FOOTPRINT_W * FOOTPRINT_D * FOOTPRINT_H;
  const muExpected = A_OBJ / (4 * V_bbox);
  const muActual = scene.furniture.mu[0 * materials.frequency_bands_hz.length + band1k];
  ok(Math.abs(muActual - muExpected) < 1e-5,
    `μ @ 1 kHz = A_obj / (4·V_bbox) = ${muExpected} Np/m (got ${muActual.toFixed(6)})`);
  // Sanity: with V_bbox = 0.5 m³ and A_obj = 0.5, μ MUST be 0.25 — not
  // 0.5 (which would be A_obj/V_bbox, the canonical bug) and not 1.0
  // (A_obj·2/V_bbox, a sign-style typo).
  ok(Math.abs(muActual - 0.25) < 1e-5,
    `μ NOT 0.5 (would be the "dropped the 4 in A/(4V)" bug) — got ${muActual.toFixed(6)}`);
}

// =====================================================================
// Block 2 — Null case: empty furniture array → tracer is bit-equivalent
// to the pre-Phase-2 engine (regression guard).
// =====================================================================
let t30_null = null;
{
  const state = makeShoeboxState({ furniture: [] });
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  ok(scene.furniture && scene.furniture.count === 0,
    'null case: scene.furniture.count = 0');
  ok(scene.furniture.bboxes.length === 0,
    'null case: bboxes Float32Array is empty');
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const furnitureBvh = buildAabbBVH(scene.furniture.bboxes);
  ok(furnitureBvh.nodeCount === 0,
    'null case: furnitureBvh has zero nodes (skip-when-empty trivially achieved)');
  const result = traceRays(scene, bvh, { ...TRACE_OPTS, furnitureBvh });
  result.scene = scene;
  const metrics = deriveMetrics(result);
  t30_null = metrics[0]?.perBand?.[band1k]?.t30_s;
  ok(Number.isFinite(t30_null) && t30_null > 0.3 && t30_null < 3.0,
    `null-case T30 @ 1 kHz in plausible range: ${t30_null?.toFixed(3)} s`);
  console.log(`  null-case T30 @ 1 kHz: ${t30_null?.toFixed(3)} s`);
}

// Independent check: traceRays() called WITHOUT a furnitureBvh at all
// (opts.furnitureBvh === undefined) must give identical numbers to the
// empty-BVH path — catches "what if a caller forgets to pass it" bugs.
{
  const state = makeShoeboxState({ furniture: [] });
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const result = traceRays(scene, bvh, { ...TRACE_OPTS });   // no furnitureBvh
  result.scene = scene;
  const metrics = deriveMetrics(result);
  const t30 = metrics[0]?.perBand?.[band1k]?.t30_s;
  // Bit-equivalent — same scene, same seed, same opts modulo
  // furnitureBvh=undefined which the tracer treats as null.
  ok(Math.abs((t30 - t30_null) / t30_null) < 1e-9,
    `traceRays without furnitureBvh = with empty furnitureBvh (bit-equivalent; got Δ = ${((t30 - t30_null) / t30_null).toExponential(2)})`);
}

// =====================================================================
// Block 3 — AABB intersection actually fires. Probe the BVH with three
// canonical rays and verify the pathlength integrals are sensible. If
// the snapshot wiring is broken (state.furniture not flowing into
// scene.furniture), nFurniHits would be 0 here and the rest of the
// physics machinery wouldn't matter.
// =====================================================================
{
  const state = makeShoeboxState({ furniture: placements });
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  const fb = buildAabbBVH(scene.furniture.bboxes);
  ok(fb.nodeCount > 0, 'AABB BVH built with N=20 leaves');
  const scratch = [];
  // Vertical ray at (5, 4) — passes through F8 at (4.7, 4.5) bbox y[4.0,5.0].
  // From z=1.5 going down to z=0 (segment length 1.5 m). Should record
  // L_in = 0.5 m (the absorber-layer thickness).
  const n1 = intersectRay_collectAabbs(fb, 5, 4, 1.5, 0, 0, -1, 1.5, scratch);
  let L1 = 0;
  for (let h = 0; h < n1; h++) L1 += scratch[h * 3 + 2] - scratch[h * 3 + 1];
  ok(n1 === 1 && Math.abs(L1 - 0.5) < 1e-3,
    `vertical ray through F8 column: 1 hit, L_in=0.5 m (got ${n1} hits, ${L1.toFixed(3)} m)`);

  // Upward ray — escapes the absorber layer (z<0.5) immediately, so 0 hits.
  const n2 = intersectRay_collectAabbs(fb, 5, 4, 1.5, 0, 0, +1, 2.5, scratch);
  ok(n2 === 0,
    `upward ray from z=1.5: 0 absorber crossings (got ${n2})`);

  // Slanted ray crossing two absorbers in series (along +x at z=0.25).
  const n3 = intersectRay_collectAabbs(fb, 1.5, 1.5, 0.25, 1, 0, 0, 5, scratch);
  ok(n3 >= 2,
    `slanted ray crossing multiple absorbers in series: nHits >= 2 (got ${n3})`);
}

// =====================================================================
// Block 4 — Sign + magnitude. T30 must DECREASE when furniture is
// added, by a meaningful amount.
// =====================================================================
let t30_full = null;
{
  const state = makeShoeboxState({ furniture: placements });
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  ok(scene.furniture.count === N_FURNI,
    `with-furniture: scene.furniture.count = ${N_FURNI}`);
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const furnitureBvh = buildAabbBVH(scene.furniture.bboxes);
  const result = traceRays(scene, bvh, { ...TRACE_OPTS, furnitureBvh });
  result.scene = scene;
  const metrics = deriveMetrics(result);
  t30_full = metrics[0]?.perBand?.[band1k]?.t30_s;
  console.log(`  with-furniture T30 @ 1 kHz: ${t30_full?.toFixed(3)} s`);
  const dropFraction = (t30_null - t30_full) / t30_null;
  console.log(`  T30 drop from furniture: ${(dropFraction * 100).toFixed(1)}%`);

  ok(t30_full < t30_null,
    `T30 DECREASES with furniture: ${t30_null?.toFixed(3)} → ${t30_full?.toFixed(3)} s (correct sign)`);
  // The drop should be at least 3% — a strong-enough signal to be
  // confident the furniture sink is doing something, while loose
  // enough to survive stochastic noise + ray-budget convergence.
  ok(dropFraction > 0.03,
    `furniture drop is meaningful (> 3%): got ${(dropFraction * 100).toFixed(1)}%`);
  // And not absurd — a 60%+ drop with this much A_obj would indicate
  // the absorption is being applied multiple times (e.g. on both
  // directions of a Lambertian re-scatter).
  ok(dropFraction < 0.50,
    `furniture drop is plausible (< 50%): got ${(dropFraction * 100).toFixed(1)}%`);
}

// =====================================================================
// Block 5 — Multiplicativity. 10× more A_obj should cause noticeably
// more drop. Catches "per-bounce probabilistic absorption" bugs that
// would lose the linear-in-A_obj relationship.
// =====================================================================
{
  const state = makeShoeboxState({ furniture: placements10x });
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  // 10× A_obj → μ = 10× → in-bbox attenuation is multiplied by 10 in
  // the exponent. For weak absorption (μ·L_in << 1) this is roughly 10×
  // more energy loss per traversal. Even with saturation effects, the
  // drop should be substantially larger.
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const furnitureBvh = buildAabbBVH(scene.furniture.bboxes);
  const result = traceRays(scene, bvh, { ...TRACE_OPTS, furnitureBvh });
  result.scene = scene;
  const metrics = deriveMetrics(result);
  const t30_10x = metrics[0]?.perBand?.[band1k]?.t30_s;
  console.log(`  with-furniture (10×) T30 @ 1 kHz: ${t30_10x?.toFixed(3)} s`);
  const drop1x  = (t30_null - t30_full) / t30_null;
  const drop10x = (t30_null - t30_10x)  / t30_null;
  console.log(`  drop@1×: ${(drop1x * 100).toFixed(1)}%   drop@10×: ${(drop10x * 100).toFixed(1)}%`);
  // 10× absorption must produce strictly more drop than 1× — this is
  // a sign/monotonicity check, not a strict ratio (saturation +
  // bounce-budget make a precise 10× ratio unrealistic).
  ok(drop10x > drop1x + 0.05,
    `10× A_obj produces meaningfully more drop than 1× (Δ ≥ 5%): drop10× − drop1× = ${((drop10x - drop1x) * 100).toFixed(1)}%`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll FurnitureLAB precision-tracer regression tests passed.');
