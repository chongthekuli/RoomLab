// Furniture direct-path blocking regression test (v=679, 2026-05-27).
//
// User UAT: 'i put bookshelf and rack infront speaker blocking them, i am
// expecting the heatmap will be updated, but no, the heatmap doesnt change
// no matter how i move the furniture. this is not right.'
//
// The 2D + 3D SPL heatmaps use the analytical computeSPLGrid, which
// applies wall + outdoor-obstacle TL to the direct ray but had no
// concept of furniture. This test locks the fix in place so a future
// refactor can't silently regress.
//
// Catches:
//   1. Bookshelf placed BETWEEN source and listener → listener SPL drops.
//   2. Same bookshelf placed OFF to the side → no drop (segment misses bbox).
//   3. Bigger bbox (rack) → bigger drop.
//   4. Chair cushion in the path → drop via Beer-Lambert porous sink.
//   5. Per-band Φ_b values are non-negative and finite.

import { furnitureDirectPathLossDb, furnitureDirectPathLossPerBand } from '../js/physics/furniture-direct-blocking.js';
import { _setFurnitureCatalogueForTests, getFurnitureCatalogue } from '../js/labs/furniturelab/catalog.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];

function row(id, family, mode, fp, Aobj) {
  return {
    id, name: id, short_name: id,
    category: 'storage', subcategory: null,
    footprint: { shape: 'rectangle', ...fp },
    placement: { mounts_on: 'floor' },
    visual: { family },
    acoustics: {
      model: 'equivalent_absorption_area',
      interaction_mode: mode,
      A_obj_m2_sab_per_band: Aobj,
      scattering_per_band: null,
      occupancy_state: null,
      paired_state_id: null,
    },
    citation: { source: 'test', reference: 'test', measurement_method: 'synthetic', estimated: true, notes: null },
    reliability: 'estimated',
    linked_device_id: null, schema_version: 3,
    added: '2026-05-27', revised: null, revised_by: null, revised_note: null,
  };
}

// --- Fixtures ----------------------------------------------------------
const BOOKSHELF = row('test-bookshelf', 'vertical-box', 'reflective',
  { width_m: 1.0, depth_m: 0.30, height_m: 2.0 },
  { '125': 0.60, '250': 0.60, '500': 0.80, '1000': 1.00, '2000': 1.20, '4000': 1.30 });
const RACK = row('test-rack', 'vertical-box', 'reflective',
  { width_m: 0.60, depth_m: 1.00, height_m: 2.0 },
  { '125': 0.08, '250': 0.15, '500': 0.25, '1000': 0.35, '2000': 0.30, '4000': 0.25 });
const CHAIR = row('test-chair', 'seat', 'hybrid',
  { width_m: 0.55, depth_m: 0.60, height_m: 1.20 },
  { '125': 0.15, '250': 0.19, '500': 0.23, '1000': 0.25, '2000': 0.23, '4000': 0.22 });
// Occupied audience block, per m². flat-pad family, 1.2 m tall — its
// sub-volume is a porous column floor→0.92·h (Dr. Chen 2026-05-31), so an
// ear-height direct ray now attenuates (was 0 with the old 4 cm flat pad).
const AUDIENCE = row('test-audience', 'flat-pad', 'porous',
  { width_m: 1.0, depth_m: 1.0, height_m: 1.20 },
  { '125': 0.62, '250': 0.70, '500': 0.80, '1000': 0.83, '2000': 0.85, '4000': 0.86 });

_setFurnitureCatalogueForTests([BOOKSHELF, RACK, CHAIR, AUDIENCE]);

// Source→listener path runs along state +y (depth into room). This matches
// the natural orientation of a bookshelf placed "in front of" a speaker:
// width_m runs along state x (the cabinet face), depth_m along state y
// (how thick the cabinet is from front to back). With this orientation
// the ray crosses depth_m (≈0.30 m) of the bookshelf, NOT width_m, which
// is the physically meaningful crossing distance for a bookshelf-shaped
// obstruction.

// =====================================================================
// Block 1 — Bookshelf BETWEEN source and listener → finite TL.
// =====================================================================
{
  // Bookshelf at midpoint (0, 2.5). Local bbox [-0.5,-0.15,0]→[0.5,0.15,2]
  // → world x ∈ [-0.5, 0.5], y ∈ [2.35, 2.65]. Ray along y crosses 0.30 m.
  const furniture = [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 0, y: 2.5 }, rotation_deg: 0 }];
  const tl = furnitureDirectPathLossDb(
    { x: 0, y: 0, z: 1.5 }, { x: 0, y: 5, z: 1.5 },
    furniture, getFurnitureCatalogue(), BANDS, 1000,
  );
  console.log(`  bookshelf in path: TL @ 1k = ${tl.toFixed(2)} dB`);
  // 0.30 m in-path depth × 8 Np/m × 4.343 = 10.4 dB
  ok(tl > 6, `bookshelf blocks direct ray @ 1 kHz: TL > 6 dB (got ${tl.toFixed(2)})`);
  ok(tl < 25, `TL bounded — not absurdly large (got ${tl.toFixed(2)} dB)`);
}

// =====================================================================
// Block 2 — Bookshelf OFF to the side → segment misses, zero TL.
// =====================================================================
{
  // Bookshelf 10 m off the path along x; ray runs at x=0.
  const furniture = [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 10, y: 2.5 }, rotation_deg: 0 }];
  const tl = furnitureDirectPathLossDb(
    { x: 0, y: 0, z: 1.5 }, { x: 0, y: 5, z: 1.5 },
    furniture, getFurnitureCatalogue(), BANDS, 1000,
  );
  ok(tl === 0,
    `bookshelf far off-axis: zero TL (got ${tl.toFixed(3)})`);
}

// =====================================================================
// Block 3 — Bigger obstruction → bigger drop. Rack is 1.0 m deep along
// the path (vs bookshelf 0.30 m); should attenuate much more.
// =====================================================================
{
  // Both placed at (0, 2.5); ray along +y crosses depth_m of each.
  const fBook = [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 0, y: 2.5 }, rotation_deg: 0 }];
  const fRack = [{ id: 'F1', catalogueId: 'test-rack',      position: { x: 0, y: 2.5 }, rotation_deg: 0 }];
  const tlBook = furnitureDirectPathLossDb({x:0,y:0,z:1.5}, {x:0,y:5,z:1.5}, fBook, getFurnitureCatalogue(), BANDS, 1000);
  const tlRack = furnitureDirectPathLossDb({x:0,y:0,z:1.5}, {x:0,y:5,z:1.5}, fRack, getFurnitureCatalogue(), BANDS, 1000);
  console.log(`  bookshelf TL: ${tlBook.toFixed(2)} dB | rack TL: ${tlRack.toFixed(2)} dB`);
  ok(tlRack > tlBook,
    `deeper rack attenuates more than thinner bookshelf (rack ${tlRack.toFixed(2)} > book ${tlBook.toFixed(2)})`);
}

// =====================================================================
// Block 4 — Chair (hybrid) in the path: cushion is a thin porous slab
// at seat height. Direct ray AT ear height (1.5 m) likely passes
// ABOVE the cushion (cushion z range ~[0.50, 0.55]). Test at ear height
// SHOULD see little TL; test passing through the cushion height should.
// =====================================================================
{
  // Source AT cushion height aiming at receiver same height — line
  // passes through chair cushion volume.
  const furniture = [{ id: 'F1', catalogueId: 'test-chair', position: { x: 0, y: 2.5 }, rotation_deg: 0 }];
  const tlAtCushion = furnitureDirectPathLossDb(
    { x: 0, y: 0, z: 0.52 }, { x: 0, y: 5, z: 0.52 },
    furniture, getFurnitureCatalogue(), BANDS, 1000,
  );
  const tlAboveCushion = furnitureDirectPathLossDb(
    { x: 0, y: 0, z: 1.5 }, { x: 0, y: 5, z: 1.5 },
    furniture, getFurnitureCatalogue(), BANDS, 1000,
  );
  console.log(`  chair @ cushion height: ${tlAtCushion.toFixed(2)} dB | above cushion: ${tlAboveCushion.toFixed(2)} dB`);
  ok(tlAtCushion > 0,
    `ray through cushion height attenuates (got ${tlAtCushion.toFixed(2)} dB)`);
  ok(tlAboveCushion < tlAtCushion,
    `ray above cushion attenuates LESS than ray through it (got above ${tlAboveCushion.toFixed(2)} < at ${tlAtCushion.toFixed(2)})`);
}

// =====================================================================
// Block 5 — Per-band shape: all values non-negative finite, generally
// non-decreasing for porous-only items (higher freq → more absorption).
// =====================================================================
{
  const furniture = [{ id: 'F1', catalogueId: 'test-chair', position: { x: 0, y: 2.5 }, rotation_deg: 0 }];
  const perBand = furnitureDirectPathLossPerBand(
    { x: 0, y: 0, z: 0.52 }, { x: 0, y: 5, z: 0.52 },
    furniture, getFurnitureCatalogue(), BANDS,
  );
  let allFinite = true, allNonNeg = true;
  for (let k = 0; k < BANDS.length; k++) {
    if (!Number.isFinite(perBand[k])) allFinite = false;
    if (perBand[k] < -1e-6) allNonNeg = false;
  }
  ok(allFinite, `per-band TL: all bands finite`);
  ok(allNonNeg, `per-band TL: all bands non-negative`);
}

// =====================================================================
// Block 6 — Empty / null guards.
// =====================================================================
{
  ok(furnitureDirectPathLossDb({x:0,y:0,z:1.5}, {x:0,y:5,z:1.5}, [], getFurnitureCatalogue(), BANDS, 1000) === 0,
    'empty furniture array → 0 dB');
  ok(furnitureDirectPathLossDb({x:0,y:0,z:1.5}, {x:0,y:5,z:1.5}, null, getFurnitureCatalogue(), BANDS, 1000) === 0,
    'null furniture → 0 dB');
  ok(furnitureDirectPathLossDb({x:0,y:0,z:1.5}, {x:0,y:5,z:1.5}, [{id:'F1', catalogueId:'test-bookshelf', position:{x:0,y:2.5}}], null, BANDS, 1000) === 0,
    'null catalogue → 0 dB');
  ok(furnitureDirectPathLossDb({x:0,y:0,z:1.5}, {x:0,y:0,z:1.5}, [{id:'F1', catalogueId:'test-bookshelf', position:{x:0,y:2.5}}], getFurnitureCatalogue(), BANDS, 1000) === 0,
    'zero-length segment → 0 dB');
}

// =====================================================================
// Block 7 — Occupied audience block grazing attenuation (Dr. Chen 2026-05-31).
// The 1.2 m audience block's porous sub-volume is now a column to 0.92·h
// (≈1.104 m), so a direct ray at seated-ear height crosses the bodies and
// attenuates — it did NOT before (the old 4 cm flat pad let the ray sail over).
// =====================================================================
{
  // One 1 m² audience block centred at (0, 2.5). Ray along +y at ear height.
  const furniture = [{ id: 'A1', catalogueId: 'test-audience', position: { x: 0, y: 2.5 }, rotation_deg: 0 }];
  const cat = getFurnitureCatalogue();

  // Ear-height ray (z = 1.0 m) crosses ~1 m of audience → a few tenths of dB.
  const earLoss = furnitureDirectPathLossDb({ x: 0, y: 0, z: 1.0 }, { x: 0, y: 5, z: 1.0 }, furniture, cat, BANDS, 1000);
  console.log(`  audience grazing loss @ ear (z=1.0, 1k) = ${earLoss.toFixed(2)} dB`);
  ok(earLoss > 0.3 && earLoss < 2.0,
    `audience block attenuates the ear-height direct ray (0.3 < ${earLoss.toFixed(2)} < 2 dB; was 0 pre-fix)`);

  // Listener whose ears CLEAR the ~1.104 m column (z = 1.3 m) → not shadowed.
  const aboveLoss = furnitureDirectPathLossDb({ x: 0, y: 0, z: 1.3 }, { x: 0, y: 5, z: 1.3 }, furniture, cat, BANDS, 1000);
  ok(aboveLoss < 0.05,
    `ray above the crowd (z=1.3 > 1.104 m column) is NOT shadowed (${aboveLoss.toFixed(2)} ≈ 0 dB)`);

  // Spectral shape: bulk absorption rises with frequency — it is NOT a low-mid
  // seat-dip. Guards the model contract (a future "fix" that dips at 200 Hz
  // would change the documented physics).
  const pb = furnitureDirectPathLossPerBand({ x: 0, y: 0, z: 1.0 }, { x: 0, y: 5, z: 1.0 }, furniture, cat, BANDS);
  ok(pb[0] < pb[5],
    `audience loss is broadband-monotone (125 Hz ${pb[0].toFixed(2)} < 4 kHz ${pb[5].toFixed(2)}) — bulk absorption, not a seat-dip`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll furniture direct-blocking tests passed.');
