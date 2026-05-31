// Sub-volume routing test — v=677 (2026-05-27).
//
// The unified per-family layout module (js/labs/furniturelab/
// sub-volumes.js) is the single source of truth for how each
// catalogue row breaks down into acoustic sub-bboxes. This test
// covers every family + mode combination so a future contributor
// adding a new family or flipping an existing item's mode gets a
// loud failure if they forget to declare the layout.
//
// Catches structurally:
//   • table (slab-on-legs, reflective) producing a SOLID bbox →
//     bug 2 from v=676 UAT ("rays can't pass under the table").
//   • bookshelf (vertical-box) being sub-divided incorrectly into
//     legs (would be wrong — bookshelves are solid).
//   • prayer mat (flat-pad, porous) becoming reflective by accident.
//   • chair (seat, hybrid) collapsing back to a single porous bbox.

import { state, applyTemplateToState } from '../js/app-state.js';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';
import { _setFurnitureCatalogueForTests } from '../js/labs/furniturelab/catalog.js';
import { getSubVolumes } from '../js/labs/furniturelab/sub-volumes.js';
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

// Helper — build a synthetic catalogue row with the given family + mode.
function row(id, family, mode, fp = { width_m: 1, depth_m: 0.6, height_m: 0.74 }) {
  return {
    id, name: id, short_name: id,
    category: 'table', subcategory: null,
    footprint: { shape: 'rectangle', ...fp },
    placement: { mounts_on: 'floor' },
    visual: { family },
    acoustics: {
      model: 'equivalent_absorption_area',
      interaction_mode: mode,
      A_obj_m2_sab_per_band: { '125': 0.05, '250': 0.05, '500': 0.05, '1000': 0.10, '2000': 0.15, '4000': 0.20 },
      scattering_per_band: null,
      occupancy_state: null,
      paired_state_id: null,
    },
    citation: { source: 'test', reference: 'test', measurement_method: 'synthetic', estimated: true, notes: null },
    reliability: 'estimated', linked_device_id: null, schema_version: 3,
    added: '2026-05-27', revised: null, revised_by: null, revised_note: null,
  };
}

// =====================================================================
// Block A — Pure getSubVolumes() shape per family + mode.
// =====================================================================
{
  // slab-on-legs reflective → 1 top + 4 legs = 5 sub-bboxes.
  const sub = getSubVolumes(row('t-table', 'slab-on-legs', 'reflective', { width_m: 2.4, depth_m: 1.0, height_m: 0.74 }));
  ok(sub.length === 5,
    `slab-on-legs reflective: 5 sub-volumes (1 top + 4 legs); got ${sub.length}`);
  const mains = sub.filter(s => s.role === 'reflective_main');
  const frames = sub.filter(s => s.role === 'frame');
  ok(mains.length === 1, `slab-on-legs: 1 reflective_main (the top slab); got ${mains.length}`);
  ok(frames.length === 4, `slab-on-legs: 4 frame (legs); got ${frames.length}`);

  // The top slab must SIT AT THE TOP (zMin > 0.5·h), not span the whole height.
  const top = mains[0];
  ok(top.bounds[2] > 0.74 * 0.5,
    `slab-on-legs: top slab zMin > h/2 (got ${top.bounds[2].toFixed(3)})`);
  // The legs must reach the floor (zMin === 0).
  for (const leg of frames) {
    ok(leg.bounds[2] === 0,
      `slab-on-legs leg: zMin === 0 (touches the floor); got ${leg.bounds[2]}`);
  }
}
{
  // vertical-box reflective → 1 single bbox.
  const sub = getSubVolumes(row('t-shelf', 'vertical-box', 'reflective', { width_m: 1, depth_m: 0.3, height_m: 2 }));
  ok(sub.length === 1,
    `vertical-box reflective: 1 sub-volume (whole bbox); got ${sub.length}`);
  ok(sub[0].role === 'reflective_main',
    `vertical-box: role = reflective_main`);
  // Spans floor → ceiling of the item.
  ok(sub[0].bounds[2] === 0 && sub[0].bounds[5] === 2,
    `vertical-box: spans floor → top (z 0..h)`);
}
{
  // flat-pad porous → 1 thin slab.
  const sub = getSubVolumes(row('t-mat', 'flat-pad', 'porous', { width_m: 1, depth_m: 1, height_m: 0.02 }));
  ok(sub.length === 1, `flat-pad porous: 1 sub-volume; got ${sub.length}`);
  ok(sub[0].role === 'porous', `flat-pad porous: role = porous`);
  ok(sub[0].bounds[5] <= 0.04,
    `flat-pad: thin slab (z height <= 0.04); got ${sub[0].bounds[5].toFixed(3)}`);
}
{
  // seat hybrid → 1 cushion (porous) + 7 frame (legs/arms/back).
  const sub = getSubVolumes(row('t-chair', 'seat', 'hybrid', { width_m: 0.55, depth_m: 0.60, height_m: 1.20 }));
  ok(sub.length === 8,
    `seat hybrid: 8 sub-volumes (1 cushion + 4 legs + 2 arms + 1 back); got ${sub.length}`);
  const porous = sub.filter(s => s.role === 'porous');
  const frames = sub.filter(s => s.role === 'frame');
  ok(porous.length === 1, `seat hybrid: 1 porous (cushion); got ${porous.length}`);
  ok(frames.length === 7, `seat hybrid: 7 frame; got ${frames.length}`);
}
{
  // seat porous (e.g. fully upholstered ottoman) → all sub-volumes
  // promoted to porous.
  const sub = getSubVolumes(row('t-ott', 'seat', 'porous', { width_m: 0.55, depth_m: 0.60, height_m: 0.50 }));
  ok(sub.every(s => s.role === 'porous'),
    `seat + porous mode: every sub-volume forced to porous`);
}

// =====================================================================
// Block B — End-to-end snapshot routing for a mixed scene. Verifies
// scene.furniture (porous) + scene.furnitureReflective (reflective)
// counts match the per-family layouts.
// =====================================================================
const CAT_TABLE  = row('cat-table',  'slab-on-legs', 'reflective', { width_m: 2.4, depth_m: 1.0, height_m: 0.74 });
const CAT_SHELF  = row('cat-shelf',  'vertical-box', 'reflective', { width_m: 1, depth_m: 0.3, height_m: 2 });
const CAT_MAT    = row('cat-mat',    'flat-pad',     'porous',     { width_m: 1, depth_m: 1, height_m: 0.02 });
const CAT_CHAIR  = row('cat-chair',  'seat',         'hybrid',     { width_m: 0.55, depth_m: 0.60, height_m: 1.20 });
_setFurnitureCatalogueForTests([CAT_TABLE, CAT_SHELF, CAT_MAT, CAT_CHAIR]);

applyTemplateToState('hifi');
state.furniture = [
  { id: 'F1', catalogueId: 'cat-table', position: { x: 2, y: 2 }, rotation_deg: 0 },
  { id: 'F2', catalogueId: 'cat-shelf', position: { x: 4, y: 2 }, rotation_deg: 0 },
  { id: 'F3', catalogueId: 'cat-mat',   position: { x: 1, y: 1 }, rotation_deg: 0 },
  { id: 'F4', catalogueId: 'cat-chair', position: { x: 3, y: 1 }, rotation_deg: 0 },
];

const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });

// Expected: 1 cushion (from chair) + 1 mat = 2 porous entries.
ok(scene.furniture.count === 2,
  `mixed: porous count = 2 (1 chair cushion + 1 mat); got ${scene.furniture.count}`);

// Expected reflective entries:
//   table:    1 top + 4 legs   = 5
//   shelf:    1 box            = 1
//   chair:    4 legs + 2 arms + 1 back = 7
//   = 13 total
ok(scene.furnitureReflective.count === 13,
  `mixed: reflective count = 13 (table 5 + shelf 1 + chair shell 7); got ${scene.furnitureReflective.count}`);

// =====================================================================
// Block C — Bug 2 regression. Verify that the under-table space is
// NOT covered by any reflective sub-bbox. A vertical ray straight
// down through the centre of the table (avoiding the top slab) at
// height z = h/2 should NOT intersect any reflective sub-bbox.
// =====================================================================
{
  // The under-table space is at x=cx (centre), y=cy (centre), z ∈
  // [0, h - slabThk]. For our test table at (2, 2) with h=0.74, the
  // slab starts at z = 0.74 - 0.05 = 0.69. Below that is air —
  // except where the legs are (at the corners, inset 0.05 m).
  //
  // Centre of table (2, 2) is FAR from any leg corner (leg at
  // x = 2 ± (2.4/2 - 0.05) = 2 ± 1.15). So a vertical ray at (2, 2, z)
  // for z < 0.69 should hit nothing reflective.
  const bb = scene.furnitureReflective.bboxes;
  let anyOverlap = false;
  for (let i = 0; i < scene.furnitureReflective.count; i++) {
    const o = i * 6;
    const cid = scene.furnitureReflective.catalogueIds[i];
    if (cid !== 'cat-table') continue;
    const xMin = bb[o], yMin = bb[o + 1], zMin = bb[o + 2];
    const xMax = bb[o + 3], yMax = bb[o + 4], zMax = bb[o + 5];
    // Probe at (2, 2, 0.35) — middle of the table interior, definitely
    // air in real life.
    if (xMin <= 2 && 2 <= xMax && yMin <= 2 && 2 <= yMax && zMin <= 0.35 && 0.35 <= zMax) {
      anyOverlap = true;
      console.log(`  table sub-bbox ${i}: [${xMin.toFixed(2)},${yMin.toFixed(2)},${zMin.toFixed(2)} → ${xMax.toFixed(2)},${yMax.toFixed(2)},${zMax.toFixed(2)}] contains the under-table probe point`);
    }
  }
  ok(!anyOverlap,
    'under-table centre (2, 2, 0.35) is AIR — no reflective sub-bbox covers it');
}

// =====================================================================
// Block — flat-pad height split (Dr. Chen 2026-05-31). A thin mat stays a
// floor slab (≤0.04 m, doesn't shadow a standing talker); a tall occupied
// audience block becomes a porous COLUMN to 0.92·h so the Beer-Lambert
// direct-shadow acts at seated-ear height. Regression tripwire for the
// audience-block free-pass-over bug.
// =====================================================================
{
  const mat = getSubVolumes(row('t-mat', 'flat-pad', 'porous', { width_m: 1, depth_m: 1, height_m: 0.02 }));
  ok(mat.length === 1 && mat[0].role === 'porous' && mat[0].bounds[5] <= 0.04,
    `flat-pad thin mat (h=0.02): single floor slab ≤0.04 m (got zMax ${mat[0].bounds[5].toFixed(3)})`);

  const aud = getSubVolumes(row('t-audience', 'flat-pad', 'porous', { width_m: 1, depth_m: 1, height_m: 1.20 }));
  const zTop = aud[0].bounds[5];
  ok(aud.length === 1 && aud[0].role === 'porous' && Math.abs(zTop - 1.2 * 0.92) < 1e-6,
    `flat-pad audience (h=1.2): porous column to 0.92·h = ${(1.2 * 0.92).toFixed(3)} m (got ${zTop.toFixed(3)}), NOT a 4 cm mat`);
  ok(zTop > 1.0,
    `audience sub-volume reaches seated-ear height (${zTop.toFixed(3)} m > 1.0) so a direct ray is shadowed`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll FurnitureLAB sub-volume routing tests passed.');
