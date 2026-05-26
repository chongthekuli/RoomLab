// Print-report Furnishing schedule — regression test (v=670, 2026-05-27).
//
// User scenario:
//   1. Empty scene (no furniture) → print model.furnitureBom === null.
//   2. Place identical chairs × N → schedule groups by catalogueId,
//      count = N, ΣA at 1 kHz = N × per-item A_obj.
//   3. Mixed scene (chairs + table + bookshelf) → multiple rows with
//      qty, mode (porous/reflective), correct per-band ΣA_obj.
//   4. % of room absorption denominator INCLUDES placed furniture
//      (rt60 fold) — never reads >100%.
//   5. Citations are deduplicated by source+reference — same Beranek
//      paper cited by occupied + empty seats appears ONCE.
//
// The BoM aggregator is not exported; we exercise it through the public
// buildPrintModel() entry-point per the existing print-report test
// pattern (print-cover-room-name.test.mjs, outdoor-report-exclusion.test.mjs).

import { readFileSync } from 'node:fs';
import { state, applyTemplateToState } from '../js/app-state.js';
import { buildPrintModel } from '../js/ui/print-report.js';
import { _setFurnitureCatalogueForTests } from '../js/labs/furniturelab/catalog.js';

const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// --- Fixture catalogue. Two rows so we can test grouping + citation
// dedup behaviour without depending on the live catalogue.json layout. -
const CHAIR = {
  id: 'test-chair',
  name: 'Test chair',
  short_name: 'Chair',
  category: 'seating',
  subcategory: 'audience',
  footprint: { shape: 'rectangle', width_m: 0.55, depth_m: 0.60, height_m: 1.20 },
  placement: { mounts_on: 'floor' },
  visual: { family: 'seat' },
  acoustics: {
    model: 'equivalent_absorption_area',
    interaction_mode: 'porous',
    A_obj_m2_sab_per_band: {
      '125': 0.10, '250': 0.15, '500': 0.20, '1000': 0.25, '2000': 0.23, '4000': 0.20,
    },
    scattering_per_band: null,
    occupancy_state: 'occupied',
    paired_state_id: null,
  },
  citation: {
    source: 'Beranek 1998',
    reference: 'JASA 104(6) 3169',
    measurement_method: 'ISO 354',
    estimated: false, notes: null,
  },
  reliability: 'derived',
  linked_device_id: null,
  schema_version: 3, added: '2026-05-27', revised: null, revised_by: null, revised_note: null,
};
const TABLE = {
  ...CHAIR,
  id: 'test-table',
  name: 'Test table',
  short_name: 'Table',
  category: 'table',
  subcategory: 'conference',
  footprint: { shape: 'rectangle', width_m: 2.4, depth_m: 1.0, height_m: 0.74 },
  visual: { family: 'slab-on-legs' },
  acoustics: {
    ...CHAIR.acoustics,
    interaction_mode: 'reflective',
    A_obj_m2_sab_per_band: {
      '125': 0.05, '250': 0.05, '500': 0.05, '1000': 0.10, '2000': 0.15, '4000': 0.20,
    },
    occupancy_state: null,
  },
  citation: {
    source: 'Cox & D\'Antonio 2009',
    reference: 'Acoustic Absorbers and Diffusers §3.6',
    measurement_method: 'engineering estimate',
    estimated: true, notes: null,
  },
  reliability: 'estimated',
};
_setFurnitureCatalogueForTests([CHAIR, TABLE]);

// =====================================================================
// Block 1 — Empty case: no furniture → furnitureBom is null.
// =====================================================================
applyTemplateToState('hifi');
state.furniture = [];
{
  const m = buildPrintModel({ materials });
  ok(m.furnitureBom === null,
    'empty furniture → model.furnitureBom === null (renderer skips the section)');
}

// =====================================================================
// Block 2 — Identical-items grouping.
// =====================================================================
state.furniture = [];
for (let i = 0; i < 5; i++) {
  state.furniture.push({
    id: `F${i + 1}`, catalogueId: 'test-chair',
    position: { x: 2 + i * 0.6, y: 2 }, rotation_deg: 0,
  });
}
{
  const m = buildPrintModel({ materials });
  ok(m.furnitureBom !== null,
    'with-furniture: model.furnitureBom is populated');
  ok(Array.isArray(m.furnitureBom.rows) && m.furnitureBom.rows.length === 1,
    'identical catalogueIds collapse to ONE row');
  const row = m.furnitureBom.rows[0];
  ok(row.count === 5,
    `qty = 5 (got ${row.count})`);
  // Per-item A_obj at 1 kHz = 0.25, × 5 chairs = 1.25 m² Sa
  ok(Math.abs(row.contribution_m2sa_1k - 1.25) < 1e-6,
    `ΣA @ 1 kHz = 5 × 0.25 = 1.25 m² Sa (got ${row.contribution_m2sa_1k})`);
  ok(row.interaction_mode === 'porous',
    `chair interaction_mode = "porous" (got "${row.interaction_mode}")`);
  ok(row.reliability === 'derived',
    `chair reliability = "derived" (got "${row.reliability}")`);
  // Totals per band — 1 kHz total across all rows should equal the
  // single chair row's contribution since there's only one row.
  const band1k = materials.frequency_bands_hz.indexOf(1000);
  ok(Math.abs(m.furnitureBom.total_A_per_band[band1k] - 1.25) < 1e-6,
    `total_A_per_band[1k] = 1.25 (got ${m.furnitureBom.total_A_per_band[band1k]})`);
}

// =====================================================================
// Block 3 — Mixed scene: chairs + 1 table.
// =====================================================================
state.furniture.push({ id: 'F6', catalogueId: 'test-table', position: { x: 5, y: 5 }, rotation_deg: 0 });
{
  const m = buildPrintModel({ materials });
  ok(m.furnitureBom.rows.length === 2,
    `mixed: 2 rows (chair + table); got ${m.furnitureBom.rows.length}`);
  // Rows sorted by count descending — chairs (5) before table (1).
  ok(m.furnitureBom.rows[0].catalogueId === 'test-chair',
    `mixed: chair row first (qty 5 > qty 1)`);
  ok(m.furnitureBom.rows[1].catalogueId === 'test-table',
    `mixed: table row second`);
  // Table is reflective, chair is porous — modes differ.
  ok(m.furnitureBom.rows[1].interaction_mode === 'reflective',
    `mixed: table interaction_mode = "reflective"`);
}

// =====================================================================
// Block 4 — % of room absorption ≤ 100%. Catches the bug where the
// denominator was the BARE room (excluding placed furniture) and the
// schedule reported >100% contributions.
// =====================================================================
{
  const m = buildPrintModel({ materials });
  for (const row of m.furnitureBom.rows) {
    if (row.percent_of_room_1k != null) {
      ok(row.percent_of_room_1k >= 0 && row.percent_of_room_1k <= 100,
        `row "${row.catalogueId}" % of room ∈ [0, 100]: ${row.percent_of_room_1k.toFixed(2)}%`);
    }
  }
}

// =====================================================================
// Block 5 — Citation dedup. Add an empty-chair row that cites the SAME
// Beranek paper as the occupied-chair row, verify the citations list
// contains the source ONCE (citation chip [N] reuses the same index).
// =====================================================================
const CHAIR_EMPTY = {
  ...CHAIR, id: 'test-chair-empty', name: 'Test chair (empty)',
  acoustics: { ...CHAIR.acoustics, occupancy_state: 'empty' },
  // Same citation as CHAIR — Beranek 1998 / JASA 104(6) 3169.
};
_setFurnitureCatalogueForTests([CHAIR, CHAIR_EMPTY, TABLE]);
state.furniture = [
  { id: 'F1', catalogueId: 'test-chair',       position: { x: 1, y: 1 }, rotation_deg: 0 },
  { id: 'F2', catalogueId: 'test-chair-empty', position: { x: 2, y: 1 }, rotation_deg: 0 },
  { id: 'F3', catalogueId: 'test-table',       position: { x: 3, y: 3 }, rotation_deg: 0 },
];
{
  // We can't easily inspect the citation-dedup map (it lives inside
  // the renderer function). Instead, verify the BoM rows expose the
  // citation objects so the renderer's dedup-by-source-key works.
  const m = buildPrintModel({ materials });
  ok(m.furnitureBom.rows.length === 3,
    `3 distinct catalogueIds = 3 rows`);
  // Two rows share the Beranek 1998 citation (CHAIR + CHAIR_EMPTY).
  const beranekRows = m.furnitureBom.rows.filter(r => r.citation?.source === 'Beranek 1998');
  ok(beranekRows.length === 2,
    `2 rows cite Beranek 1998 (chair + chair-empty); got ${beranekRows.length}`);
  // The dedup happens at render time. Renderer-level verification
  // would need DOM; here we just confirm the citation objects on
  // those rows have IDENTICAL source+reference so the dedup key
  // will collapse them.
  const c1 = beranekRows[0].citation;
  const c2 = beranekRows[1].citation;
  ok(c1.source === c2.source && c1.reference === c2.reference,
    `shared-citation rows expose identical source+reference for dedup`);
}

// =====================================================================
// Block 6 — Renderer integration: when furniture is placed, the print
// HTML contains the Furnishing schedule page header. We invoke the
// internal page-builder by checking model.furnitureBom is wired in —
// the actual DOM rendering needs a browser, but the model presence is
// the gate the renderer checks.
// =====================================================================
state.furniture = [
  { id: 'F1', catalogueId: 'test-chair', position: { x: 1, y: 1 }, rotation_deg: 0 },
];
{
  const m = buildPrintModel({ materials });
  ok(typeof m.furnitureBom === 'object' && m.furnitureBom !== null,
    'furniture placed → model.furnitureBom is an object (renderer will emit page)');
  ok(Array.isArray(m.furnitureBom.bands_hz) && m.furnitureBom.bands_hz.length === 7,
    'furnitureBom.bands_hz array carried (7 octave bands)');
  ok(typeof m.furnitureBom.room_total_absorption_1k === 'number',
    'furnitureBom.room_total_absorption_1k present (the % of room denominator)');
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Furnishing-schedule print-BoM tests passed.');
