// Treatment before/after comparison-model tests.
//
// Verifies the print-report's `buildTreatmentCompareModel` and
// `buildTreatmentSchedule` helpers — the engine for Chapter 04 of
// the proposal report. These helpers don't TOUCH the physics engine
// — they call computeAllBands twice (with [] and with treatments)
// and lay the result out for the renderer.
//
// What we want to assert:
//   (1) helpers are defined and exported
//   (2) compare is null when no treatments are placed
//   (3) compare returns the right shape (kpis, bareBands, treatedBands)
//   (4) treated RT60 < bare RT60 for an absorber-rich scene (sanity)
//   (5) Schroeder cutoff drops when RT60 drops (math contract)
//   (6) schedule has one row per placed treatment, with location +
//       per-band α + NRC + weight surfaced
//   (7) ceiling vs wall location label is rendered correctly
//   (8) ᾱ-based "treatment improvement is non-zero" check — anything else
//       would mean the report would render "no change" deltas to the
//       client, which is exactly the bug Dr. Chen warned about
//
// Reference: rt60.js computeAllBands accepts a `treatments` array; we
// drive both code paths from the same fixture.

import { readFileSync } from 'node:fs';
import { state, applyBlankCustomRoom } from '../js/app-state.js';
import {
  buildPrintModel,
  buildTreatmentCompareModel,
} from '../js/ui/print-report.js';
import {
  _setCachedCatalogueForTests,
  _clearCachedCatalogueForTests,
} from '../js/labs/surfacelab/catalog.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

// ---------------------------------------------------------------------------
// Materials — real DB. We don't need a custom test-wall here; the
// comparison test is "treatment changes the number" which only requires
// any α-bearing material plus an α-bearing panel.
// ---------------------------------------------------------------------------
const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};

// Synthetic catalogue — two products with strong, known α profiles so
// the compare deltas are large enough to assert against.
function installTestCatalogue() {
  _setCachedCatalogueForTests({
    all: [
      {
        id: 'mock-broadband-absorber',
        name: 'Mock Broadband Absorber (α=0.85 flat)',
        manufacturer: 'TestMfr',
        category: 'absorber.porous.panel',
        absorption: [0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85],
        scattering_coefficient: [0.10, 0.10, 0.10, 0.10, 0.15, 0.20, 0.20],
        geometry: { width_mm: 600, height_mm: 1200, depth_mm: 50, weight_kg_m2: 7.5 },
        mounting: 'ASTM_C423_TypeA',
        test_standard: 'ISO 354:2003',
        test_lab: 'Mock Acoustic Lab',
        test_report_id: 'MAL-2024-001',
        fire_rating: 'Euroclass B-s1,d0',
        nrc: 0.85,
      },
      {
        id: 'mock-bass-trap',
        name: 'Mock Bass Trap (α=0.95 @ 125 Hz)',
        manufacturer: 'TestMfr',
        category: 'bass.porous',
        absorption: [0.95, 0.80, 0.50, 0.40, 0.35, 0.30, 0.25],
        scattering_coefficient: 0.15,
        geometry: { width_mm: 600, height_mm: 1200, depth_mm: 200, weight_kg_m2: 14.0 },
        mounting: 'wall_corner',
        test_standard: 'ISO 354:2003',
        fire_rating: 'BS 476-7 class 1',
      },
      {
        id: 'mock-ceiling-tile',
        name: 'Mock Ceiling Tile (α=0.95 flat)',
        manufacturer: 'TestMfr',
        category: 'absorber.porous.panel',
        absorption: [0.65, 0.85, 0.95, 0.95, 0.95, 0.90, 0.85],
        geometry: { width_mm: 600, height_mm: 600, depth_mm: 25, weight_kg_m2: 3.5 },
        mounting: 'ceiling_suspended',
        fire_rating: 'A1',
      },
    ],
    groups: [],
  });
}

function tr(id, productId, wallIndex, width_m, height_m, position) {
  return {
    id, productId,
    label: id,
    anchor: { surface: 'wall', wallIndex },
    position: position || { x: 2.5, y: 2.5, z: 1.5 },
    rotation_deg: 0,
    dimensions: { width_m, height_m, depth_m: 0.05 },
  };
}
function trCeil(id, productId, width_m, height_m, position) {
  return {
    id, productId,
    label: id,
    anchor: { surface: 'ceiling' },
    position: position || { x: 4, y: 2.5, z: 3 },
    rotation_deg: 0,
    dimensions: { width_m, height_m, depth_m: 0.025 },
  };
}

function freshScene() {
  applyBlankCustomRoom();
  state.room.shape = 'rectangular';
  state.room.width_m = 10;
  state.room.depth_m = 5;
  state.room.height_m = 3;
  state.room.custom_vertices = null;
  state.room.surfaces = {
    floor: 'wood-floor',
    ceiling: 'gypsum-board',
    wall_north: 'concrete',
    wall_south: 'concrete',
    wall_east: 'concrete',
    wall_west: 'concrete',
  };
  state.zones = [];
  state.treatments = [];
}

installTestCatalogue();

// ---------------------------------------------------------------------------
// (1) Helpers are exported
// ---------------------------------------------------------------------------
assert(typeof buildTreatmentCompareModel === 'function',
  'buildTreatmentCompareModel is exported from print-report.js');

// ---------------------------------------------------------------------------
// (2) No treatments → compare is null, schedule is empty array.
// ---------------------------------------------------------------------------
freshScene();
{
  const m = buildPrintModel({ materials });
  assert(m.treatmentCompare === null,
    'no treatments placed: treatmentCompare is null (so renderer suppresses Chapter 04)');
  assert(Array.isArray(m.treatmentsSchedule) && m.treatmentsSchedule.length === 0,
    'no treatments placed: treatmentsSchedule is empty array');
}

// ---------------------------------------------------------------------------
// (3) Treatments placed → compare has the expected shape, kpis is a
//     5-row array, bareBands/treatedBands have 7 entries.
// ---------------------------------------------------------------------------
freshScene();
state.treatments = [
  tr('T1', 'mock-broadband-absorber', 0, 1.2, 2.4, { x: 5, y: 4.9, z: 1.2 }),
  tr('T2', 'mock-broadband-absorber', 1, 1.2, 2.4, { x: 5, y: 0.1, z: 1.2 }),
  tr('T3', 'mock-broadband-absorber', 2, 1.2, 2.4, { x: 9.9, y: 2.5, z: 1.2 }),
  tr('T4', 'mock-broadband-absorber', 3, 1.2, 2.4, { x: 0.1, y: 2.5, z: 1.2 }),
  tr('T5', 'mock-bass-trap',          0, 0.6, 1.2, { x: 1, y: 4.9, z: 0.6 }),
  trCeil('T6', 'mock-ceiling-tile',   0.6, 0.6),
];
{
  const m = buildPrintModel({ materials });
  const c = m.treatmentCompare;
  assert(c !== null, '6 treatments placed: compare model present');
  assert(Array.isArray(c.kpis) && c.kpis.length === 5,
    `compare.kpis has 5 rows (got ${c?.kpis?.length})`);
  assert(Array.isArray(c.bareBands) && c.bareBands.length === 7,
    `compare.bareBands is 7-band (got ${c?.bareBands?.length})`);
  assert(Array.isArray(c.treatedBands) && c.treatedBands.length === 7,
    `compare.treatedBands is 7-band (got ${c?.treatedBands?.length})`);
  assert(c.panels_n === 6,
    `compare.panels_n echoes treatment count (got ${c?.panels_n})`);

  // ---- (4) sanity: treated RT60 SHORTER than bare RT60 -----------------
  const bareT1k = c.bareBands[3].eyring_s;
  const treatedT1k = c.treatedBands[3].eyring_s;
  assert(Number.isFinite(bareT1k) && Number.isFinite(treatedT1k),
    `bare + treated RT60 @ 1 kHz both finite (bare=${bareT1k}, treated=${treatedT1k})`);
  assert(treatedT1k < bareT1k,
    `treated RT60 @ 1 kHz (${treatedT1k?.toFixed(3)}s) < bare (${bareT1k?.toFixed(3)}s) — absorbers reduce reverb`);
  assert(treatedT1k < bareT1k * 0.9,
    `treated RT60 @ 1 kHz drops > 10% (bare ${bareT1k?.toFixed(2)}s → treated ${treatedT1k?.toFixed(2)}s) — meaningful intervention`);

  // ---- (5) Schroeder cutoff math: f_s drops when T60 drops ------------
  const kpiSchroeder = c.kpis.find(k => k.key === 'schroeder_hz');
  assert(kpiSchroeder != null, 'schroeder_hz KPI row present');
  assert(Number.isFinite(kpiSchroeder.bare) && Number.isFinite(kpiSchroeder.treated),
    `Schroeder bare + treated both finite (${kpiSchroeder?.bare}, ${kpiSchroeder?.treated})`);
  assert(kpiSchroeder.treated < kpiSchroeder.bare,
    `Schroeder f_s drops with treatment (${kpiSchroeder?.bare?.toFixed(1)} → ${kpiSchroeder?.treated?.toFixed(1)} Hz) — math contract`);

  // ---- mean α at 1 kHz goes UP with absorbers in -----------------------
  const kpiAlpha = c.kpis.find(k => k.key === 'mean_alpha_1k');
  assert(kpiAlpha != null && kpiAlpha.treated > kpiAlpha.bare,
    `mean ᾱ @ 1 kHz increases with treatment (${kpiAlpha?.bare?.toFixed(3)} → ${kpiAlpha?.treated?.toFixed(3)})`);

  // ---- non-zero delta on every measurable KPI --------------------------
  for (const k of c.kpis) {
    if (Number.isFinite(k.bare) && Number.isFinite(k.treated)) {
      const delta = Math.abs(k.treated - k.bare);
      assert(delta > 1e-3,
        `KPI ${k.key}: delta is non-zero (got ${delta.toExponential(2)}) — proves treatment is in the math, not visual-only`);
    }
  }

  // ---- (6) schedule shape ---------------------------------------------
  const sched = m.treatmentsSchedule;
  assert(Array.isArray(sched) && sched.length === 6,
    `schedule has one row per placed treatment (got ${sched?.length}, expected 6)`);
  for (const r of sched) {
    assert(typeof r.tag === 'string' && r.tag.length > 0,
      `schedule row has tag: ${r.tag}`);
    assert(typeof r.name === 'string' && r.name.length > 0,
      `schedule row has resolved product name: ${r.name}`);
    assert(typeof r.location === 'string' && r.location.length > 0,
      `schedule row has location string: ${r.location}`);
    assert(Array.isArray(r.absorption) && r.absorption.length === 7,
      `schedule row has 7-band α vector`);
    assert(r.area_m2 > 0,
      `schedule row has positive area: ${r.area_m2}`);
  }

  // ---- (7) location labels: north/south/east/west + ceiling -----------
  const byTag = Object.fromEntries(sched.map(r => [r.tag, r]));
  assert(byTag.T1.location === 'North wall',
    `T1 (wall index 0) maps to "North wall" — got "${byTag.T1?.location}"`);
  assert(byTag.T2.location === 'South wall',
    `T2 (wall index 1) maps to "South wall" — got "${byTag.T2?.location}"`);
  assert(byTag.T3.location === 'East wall',
    `T3 (wall index 2) maps to "East wall" — got "${byTag.T3?.location}"`);
  assert(byTag.T4.location === 'West wall',
    `T4 (wall index 3) maps to "West wall" — got "${byTag.T4?.location}"`);
  assert(byTag.T6.location === 'Ceiling',
    `T6 (ceiling-anchored) maps to "Ceiling" — got "${byTag.T6?.location}"`);

  // ---- NRC computation: 0.85 flat → NRC should be 0.85 ----------------
  assert(approx(byTag.T1.nrc, 0.85, 1e-2),
    `T1 NRC (avg of α 250/500/1k/2k) = 0.85 (got ${byTag.T1?.nrc})`);
  // Weight: 1.2 × 2.4 = 2.88 m² × 7.5 kg/m² = 21.6 kg
  assert(approx(byTag.T1.weight_kg, 21.6, 0.05),
    `T1 weight = 21.6 kg (got ${byTag.T1?.weight_kg?.toFixed(2)})`);

  // ---- mounting + fire rating surfaced through ------------------------
  assert(byTag.T1.mounting === 'ASTM_C423_TypeA',
    `T1 mounting surfaced: ${byTag.T1?.mounting}`);
  assert(byTag.T1.fire_rating === 'Euroclass B-s1,d0',
    `T1 fire rating surfaced: ${byTag.T1?.fire_rating}`);
  assert(byTag.T6.mounting === 'ceiling_suspended',
    `T6 ceiling-tile mounting surfaced: ${byTag.T6?.mounting}`);
}

// ---------------------------------------------------------------------------
// (8) Edge case: buildTreatmentCompareModel called directly with []
//     returns null (so renderer never has to second-guess the model).
// ---------------------------------------------------------------------------
freshScene();
{
  const c = buildTreatmentCompareModel({
    room: state.room,
    materials,
    zones: state.zones,
    treatments: [],
  });
  assert(c === null,
    'buildTreatmentCompareModel([]) returns null (suppresses Chapter 04 cleanly)');
}

// ---------------------------------------------------------------------------
// (9) Edge case: buildTreatmentCompareModel called with no treatments
//     argument at all returns null without throwing.
// ---------------------------------------------------------------------------
{
  let threw = false;
  let result;
  try {
    result = buildTreatmentCompareModel({
      room: state.room,
      materials,
      zones: state.zones,
    });
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'buildTreatmentCompareModel with no treatments key does not throw');
  assert(result === null, 'returns null instead');
}

// ---------------------------------------------------------------------------
// (10) Built print model size with treatments stays under the 50 KB budget
//      (regression: a previous embed of state.results.splGrid into the
//      model busted this; the new schedule + compare must stay slim).
// ---------------------------------------------------------------------------
freshScene();
state.treatments = [
  tr('T1', 'mock-broadband-absorber', 0, 1.2, 2.4),
  tr('T2', 'mock-broadband-absorber', 1, 1.2, 2.4),
  tr('T3', 'mock-broadband-absorber', 2, 1.2, 2.4),
  tr('T4', 'mock-broadband-absorber', 3, 1.2, 2.4),
  tr('T5', 'mock-bass-trap',          0, 0.6, 1.2),
  trCeil('T6', 'mock-ceiling-tile',   0.6, 0.6),
];
{
  const m = buildPrintModel({ materials });
  const json = JSON.stringify(m);
  assert(json.length < 50_000,
    `print model with 6 treatments stays under 50 KB (${(json.length / 1024).toFixed(1)} KB)`);
}

_clearCachedCatalogueForTests();

console.log(`\n${failed === 0 ? 'OK' : 'FAILED'}  ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
