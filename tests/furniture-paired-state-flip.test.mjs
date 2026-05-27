// FurnitureLAB paired-state flip — regression test (v=672, 2026-05-27).
//
// User scenario: place an occupied theater seat, click the "Empty"
// state-flip button on its placed-list row. The catalogueId swaps to
// the partner row; everything else (id, position, rotation) stays.
// The next rt60 recompute reads the new A_obj — empty chairs absorb
// ~3× less than occupied at mids, so RT60 lengthens noticeably.
//
// Dr. Chen physics-grade gate rule #4 (acoustics-engineer brief
// 2026-05-26): paired catalogue rows are a feature, not an excuse to
// require delete+replace. This test is the tripwire on the flip
// protocol so a future refactor can't break it silently.
//
// The flip handler is wired inside panel-furniture.js's click closure
// (DOM-dependent); we exercise the underlying state contract by
// calling the same operations directly on state.furniture[i].

import { state, applyTemplateToState } from '../js/app-state.js';
import { computeAllBands, preferredRT60 } from '../js/physics/rt60.js';
import { _setFurnitureCatalogueForTests, getFurnitureCatalogue } from '../js/labs/furniturelab/catalog.js';
import { readFileSync } from 'node:fs';

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

// --- Synthetic paired catalogue ---------------------------------------
// Occupied A_obj is 3× the empty A_obj at every band — matches Beranek
// 2e Table 7.2 vs 7.1 empirical ratio for upholstered theatre seats.
const OCCUPIED = {
  id: 'test-seat-occupied',
  name: 'Test seat (occupied)',
  short_name: 'Seat (occ)',
  category: 'seating',
  subcategory: 'audience',
  footprint: { shape: 'rectangle', width_m: 0.55, depth_m: 0.60, height_m: 1.20 },
  placement: { mounts_on: 'floor' },
  visual: { family: 'seat' },
  acoustics: {
    model: 'equivalent_absorption_area',
    interaction_mode: 'porous',
    A_obj_m2_sab_per_band: {
      '125': 0.30, '250': 0.45, '500': 0.60, '1000': 0.75, '2000': 0.70, '4000': 0.60,
    },
    scattering_per_band: null,
    occupancy_state: 'occupied',
    paired_state_id: 'test-seat-empty',
  },
  citation: { source: 'test', reference: 'test', measurement_method: 'synthetic', estimated: true, notes: null },
  reliability: 'estimated',
  linked_device_id: null, schema_version: 3,
  added: '2026-05-27', revised: null, revised_by: null, revised_note: null,
};
const EMPTY = {
  ...OCCUPIED,
  id: 'test-seat-empty',
  name: 'Test seat (empty)',
  short_name: 'Seat (empty)',
  acoustics: {
    ...OCCUPIED.acoustics,
    A_obj_m2_sab_per_band: {
      '125': 0.10, '250': 0.15, '500': 0.20, '1000': 0.25, '2000': 0.23, '4000': 0.20,
    },
    occupancy_state: 'empty',
    paired_state_id: 'test-seat-occupied',
  },
};
_setFurnitureCatalogueForTests([OCCUPIED, EMPTY]);

// --- Scene fixture ----------------------------------------------------
applyTemplateToState('hifi');
state.furniture = [];
// Place 20 OCCUPIED seats so the A_obj swing is large enough to be
// visible against the room's baseline absorption (small hifi listening
// room ~50 m² surface area). 20 × 0.75 m²·Sa @ 1k = 15 m² Sa contribution.
for (let i = 0; i < 20; i++) {
  state.furniture.push({
    id: `F${i + 1}`, catalogueId: 'test-seat-occupied',
    position: { x: 0.5 + (i % 5) * 0.7, y: 0.5 + Math.floor(i / 5) * 0.7 },
    rotation_deg: 0,
  });
}

function rt60_1k() {
  const bands = computeAllBands({
    room: state.room, materials, zones: state.zones, treatments: state.treatments,
    furniture: state.furniture, furnitureCatalogue: getFurnitureCatalogue(),
  });
  const b = bands.find(x => x.frequency_hz === 1000);
  return preferredRT60(b);
}

// =====================================================================
// Block 1 — Flip protocol: catalogueId swaps, everything else stays.
// =====================================================================
{
  const before = state.furniture.map(f => ({ ...f }));
  // Apply flip to F1.
  const target = state.furniture.find(f => f.id === 'F1');
  ok(target?.catalogueId === 'test-seat-occupied',
    'pre-flip: F1.catalogueId = test-seat-occupied');
  // Simulate the click handler.
  const cat = getFurnitureCatalogue();
  const row = cat.get(target.catalogueId);
  const pairedId = row.acoustics.paired_state_id;
  target.catalogueId = pairedId;
  if (target._cachedSpec) delete target._cachedSpec;

  ok(target.catalogueId === 'test-seat-empty',
    'post-flip: F1.catalogueId = test-seat-empty (paired_state_id)');
  ok(target.id === 'F1',
    'post-flip: F1.id unchanged');
  ok(target.position.x === before[0].position.x && target.position.y === before[0].position.y,
    'post-flip: F1.position unchanged');
  ok(target.rotation_deg === before[0].rotation_deg,
    'post-flip: F1.rotation_deg unchanged');
}

// =====================================================================
// Block 2 — Reverse flip via the new catalogueId's paired_state_id.
// =====================================================================
{
  const target = state.furniture.find(f => f.id === 'F1');
  const cat = getFurnitureCatalogue();
  const row = cat.get(target.catalogueId);
  const pairedId = row.acoustics.paired_state_id;
  ok(pairedId === 'test-seat-occupied',
    'empty row\'s paired_state_id points back to occupied');
  target.catalogueId = pairedId;
  ok(target.catalogueId === 'test-seat-occupied',
    'flip-back: F1.catalogueId = test-seat-occupied (round-trip)');
}

// =====================================================================
// Block 3 — RT60 lengthens when all seats flip occupied → empty
// (empty chairs absorb ~3× less; total A_obj at 1k drops from
// 20 × 0.75 = 15 to 20 × 0.25 = 5, so RT60 should grow).
// =====================================================================
{
  // Reset all to occupied.
  for (const f of state.furniture) f.catalogueId = 'test-seat-occupied';
  const rt60_occupied = rt60_1k();

  // Flip ALL to empty.
  for (const f of state.furniture) f.catalogueId = 'test-seat-empty';
  const rt60_empty = rt60_1k();

  console.log(`  RT60 @ 1k occupied: ${rt60_occupied.toFixed(3)} s`);
  console.log(`  RT60 @ 1k empty:    ${rt60_empty.toFixed(3)} s`);
  ok(rt60_empty > rt60_occupied,
    `RT60 lengthens when occupied seats flip to empty (got ${rt60_empty.toFixed(3)} > ${rt60_occupied.toFixed(3)})`);
  // Sanity check: the difference must be at least 0.05 s — anything
  // smaller means the new A_obj isn't actually feeding the rt60 path
  // (e.g. the cached _cachedSpec didn't clear; the catalogue map didn't
  // re-resolve; the helper read stale data).
  ok((rt60_empty - rt60_occupied) > 0.05,
    `RT60 difference > 0.05 s (got ${(rt60_empty - rt60_occupied).toFixed(3)} s — confirms new A_obj is actually applied)`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll FurnitureLAB paired-state flip tests passed.');
