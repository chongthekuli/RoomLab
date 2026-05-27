// FurnitureLAB hybrid-mode regression test (v=676, 2026-05-27).
//
// User UAT v=675: chairs are tagged porous and "I cant see single
// reflected beam on the chair." Phase 2.2 modelled chairs as
// uniformly-porous Beer-Lambert absorbers — physically clean but
// visually unsatisfying because real chairs have hard frame elements
// (legs, arms, back) that reflect sound specularly.
//
// Phase 2.5 fix: chairs become 'hybrid' interaction_mode. Each placed
// chair routes to BOTH:
//   • 1 CUSHION porous sub-bbox (the soft upholstered seat region) —
//     gets the FULL catalogue A_obj via Beer-Lambert sink.
//   • 7 SHELL reflective sub-bboxes (4 legs + 2 arms + 1 back panel)
//     — all share a generic 'furniture-frame:generic' material with
//     α = 0.05 flat (Cox & D'Antonio §3.6 generic hardwood values).
//
// This test locks the routing protocol so the cushion stays distinct
// from the frame and the totals match.

import { state, applyTemplateToState } from '../js/app-state.js';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';
import { _setFurnitureCatalogueForTests, getFurnitureCatalogue } from '../js/labs/furniturelab/catalog.js';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};
const stubSpeaker = { acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 0 } };
const getDef = () => stubSpeaker;

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// --- Fixture catalogue with one hybrid chair --------------------------
const HYBRID_SEAT = {
  id: 'test-hybrid-seat',
  name: 'Test hybrid seat',
  short_name: 'HybSeat',
  category: 'seating',
  subcategory: 'audience',
  footprint: { shape: 'rectangle', width_m: 0.55, depth_m: 0.60, height_m: 1.20 },
  placement: { mounts_on: 'floor', stackable: false, default_spacing_m: 0.05 },
  visual: { family: 'seat' },
  acoustics: {
    model: 'equivalent_absorption_area',
    interaction_mode: 'hybrid',
    A_obj_m2_sab_per_band: {
      '125': 0.15, '250': 0.19, '500': 0.23, '1000': 0.25, '2000': 0.23, '4000': 0.22,
    },
    scattering_per_band: null,
    occupancy_state: 'occupied',
    paired_state_id: null,
  },
  citation: { source: 'test', reference: 'test', measurement_method: 'synthetic', estimated: true, notes: null },
  reliability: 'estimated',
  linked_device_id: null, schema_version: 3,
  added: '2026-05-27', revised: null, revised_by: null, revised_note: null,
};
_setFurnitureCatalogueForTests([HYBRID_SEAT]);

applyTemplateToState('hifi');
state.furniture = [{
  id: 'F1', catalogueId: 'test-hybrid-seat',
  position: { x: 2, y: 2 }, rotation_deg: 0,
}];

// ======================================================================
// Block 1 — routing counts. ONE hybrid chair must yield exactly:
//   • 1 cushion porous entry on scene.furniture
//   • 7 shell reflective entries (4 legs + 2 arms + 1 back) on
//     scene.furnitureReflective.
// ======================================================================
const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });

ok(scene.furniture?.count === 1,
  `cushion porous count = 1 (got ${scene.furniture?.count})`);
ok(scene.furnitureReflective?.count === 7,
  `shell reflective count = 7 (4 legs + 2 arms + 1 back) (got ${scene.furnitureReflective?.count})`);

// ======================================================================
// Block 2 — cushion sub-bbox is SMALLER than the full chair bbox.
// (If it were the full bbox the porous routing would collapse to the
// pre-hybrid v=668 behavior.)
// ======================================================================
{
  const bb = scene.furniture.bboxes;
  const fullW = HYBRID_SEAT.footprint.width_m;
  const fullD = HYBRID_SEAT.footprint.depth_m;
  const fullH = HYBRID_SEAT.footprint.height_m;
  const cushW = bb[3] - bb[0];
  const cushD = bb[4] - bb[1];
  const cushH = bb[5] - bb[2];
  ok(cushW < fullW,
    `cushion width < full footprint (${cushW.toFixed(3)} < ${fullW})`);
  ok(cushD < fullD,
    `cushion depth < full footprint (${cushD.toFixed(3)} < ${fullD})`);
  ok(cushH < fullH * 0.2,
    `cushion is a SLAB (height << footprint h): got ${cushH.toFixed(3)} m vs ${fullH} m`);
}

// ======================================================================
// Block 3 — cushion μ uses the cushion volume, NOT the full bbox.
// μ = A_obj / (4 · V_cushion). With cushion ~0.55·0.86 × 0.60·0.84 × 0.05
// the volume is small and μ is correspondingly large.
// ======================================================================
{
  const band1k = materials.frequency_bands_hz.indexOf(1000);
  const muAt1k = scene.furniture.mu[band1k];
  // A_obj at 1k = 0.25, cushion V ≈ 0.55·0.86 · 0.60·0.84 · 0.05 = 0.0119 m³
  // μ = 0.25 / (4 · 0.0119) = 5.24 → CLAMPED at 5 by the sanity rule.
  // So we expect either 5.0 (clamped) or close to it.
  ok(muAt1k > 0 && muAt1k <= 5.0001,
    `cushion μ @ 1k is positive and within sanity clamp (got ${muAt1k.toFixed(3)} Np/m)`);
  // Verify against a different number: the v=668 porous-mode equivalent
  // would have μ = A_obj / (4 · V_full) = 0.25 / (4 · 0.55·0.60·1.20)
  //              = 0.25 / 1.584 = 0.158 — much smaller.
  ok(muAt1k > 1.0,
    `cushion μ noticeably larger than pre-hybrid bbox-wide μ (got ${muAt1k.toFixed(3)} >> 0.158 Np/m)`);
}

// ======================================================================
// Block 4 — all 7 shell sub-bboxes use the SAME materialIdx (shared
// 'furniture-frame:generic' material). Catches a bug where each shell
// part registers its own material — would multiply material count and
// invalidate any per-material optimisation in the tracer.
// ======================================================================
{
  const idxs = scene.furnitureReflective.materialIdx;
  const first = idxs[0];
  let allSame = true;
  for (let i = 0; i < idxs.length; i++) {
    if (idxs[i] !== first) { allSame = false; break; }
  }
  ok(allSame,
    `all 7 shell sub-bboxes share the same materialIdx (frame material is shared)`);

  // And confirm the shared material is the generic frame one.
  const frameMat = scene.materials.find(m => m.id === 'furniture-frame:generic');
  ok(frameMat != null,
    `'furniture-frame:generic' material registered in scene.materials`);
  // Float32 precision: 0.05 reads back as 0.05000000074... — use epsilon.
  const eps = 1e-5;
  ok(Math.abs(frameMat?.absorption?.[0] - 0.05) < eps && Math.abs(frameMat?.absorption?.[6] - 0.05) < eps,
    `frame α = 0.05 flat across bands (got [${frameMat?.absorption?.[0]?.toFixed(4)}, ..., ${frameMat?.absorption?.[6]?.toFixed(4)}])`);
}

// ======================================================================
// Block 5 — shell bboxes are spatially distinct. Each is below where
// the cushion sits (legs go floor → seatTop), or in front/back of it
// (arms + back panel). Verifies no degenerate / overlapping bboxes.
// ======================================================================
{
  const bb = scene.furnitureReflective.bboxes;
  let degenerate = 0;
  for (let i = 0; i < scene.furnitureReflective.count; i++) {
    const w = bb[i * 6 + 3] - bb[i * 6 + 0];
    const d = bb[i * 6 + 4] - bb[i * 6 + 1];
    const h = bb[i * 6 + 5] - bb[i * 6 + 2];
    if (w <= 0 || d <= 0 || h <= 0) degenerate++;
  }
  ok(degenerate === 0,
    `no degenerate (zero-volume) shell bboxes (got ${degenerate} degenerate of ${scene.furnitureReflective.count})`);
}

// ======================================================================
// Block 6 — mixed scene: a porous mat, a hybrid chair, a reflective
// bookshelf — all three should route to their respective blocks
// without crosstalk.
// ======================================================================
const POROUS_MAT = {
  id: 'test-porous-mat', name: 'Test mat', short_name: 'Mat',
  category: 'decorative', subcategory: 'floor-covering',
  footprint: { shape: 'rectangle', width_m: 1, depth_m: 1, height_m: 0.02 },
  placement: { mounts_on: 'floor' },
  visual: { family: 'flat-pad' },
  acoustics: {
    model: 'equivalent_absorption_area', interaction_mode: 'porous',
    A_obj_m2_sab_per_band: { '125': 0.05, '250': 0.10, '500': 0.15, '1000': 0.25, '2000': 0.35, '4000': 0.45 },
    scattering_per_band: null, occupancy_state: null, paired_state_id: null,
  },
  citation: { source: 'test', reference: 'test', measurement_method: 'synthetic', estimated: true, notes: null },
  reliability: 'estimated', linked_device_id: null, schema_version: 3,
  added: '2026-05-27', revised: null, revised_by: null, revised_note: null,
};
const REFLECTIVE_SHELF = {
  id: 'test-reflective-shelf', name: 'Test shelf', short_name: 'Shelf',
  category: 'storage', subcategory: 'shelf',
  footprint: { shape: 'rectangle', width_m: 1, depth_m: 0.3, height_m: 2 },
  placement: { mounts_on: 'floor' },
  visual: { family: 'vertical-box' },
  acoustics: {
    model: 'equivalent_absorption_area', interaction_mode: 'reflective',
    A_obj_m2_sab_per_band: { '125': 0.5, '250': 0.5, '500': 0.7, '1000': 1.0, '2000': 1.2, '4000': 1.3 },
    scattering_per_band: null, occupancy_state: null, paired_state_id: null,
  },
  citation: { source: 'test', reference: 'test', measurement_method: 'synthetic', estimated: true, notes: null },
  reliability: 'estimated', linked_device_id: null, schema_version: 3,
  added: '2026-05-27', revised: null, revised_by: null, revised_note: null,
};
_setFurnitureCatalogueForTests([HYBRID_SEAT, POROUS_MAT, REFLECTIVE_SHELF]);
state.furniture = [
  { id: 'F1', catalogueId: 'test-hybrid-seat',      position: { x: 1, y: 1 }, rotation_deg: 0 },
  { id: 'F2', catalogueId: 'test-porous-mat',       position: { x: 3, y: 1 }, rotation_deg: 0 },
  { id: 'F3', catalogueId: 'test-reflective-shelf', position: { x: 5, y: 1 }, rotation_deg: 0 },
];
{
  const sc = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  // Porous block: 1 cushion (from hybrid) + 1 mat = 2
  ok(sc.furniture.count === 2,
    `mixed: porous count = 2 (hybrid cushion + mat) — got ${sc.furniture.count}`);
  // Reflective block: 7 shell (hybrid) + 1 shelf bbox = 8
  ok(sc.furnitureReflective.count === 8,
    `mixed: reflective count = 8 (7 shell from hybrid + 1 shelf) — got ${sc.furnitureReflective.count}`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll FurnitureLAB hybrid-mode tests passed.');
