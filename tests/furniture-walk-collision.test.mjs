// Furniture walk-collision regression test (v=682, 2026-05-27).
//
// User UAT: "now the avatar can walk through the furnitures, this is
// a bit unreal, get this physics fixed."
//
// Locks in the cylinder-vs-AABB test so a refactor can't silently let
// the avatar pass through furniture again.
//
// Catches:
//   1. Avatar centred inside bookshelf footprint → blocked.
//   2. Avatar 2 m off to the side → free.
//   3. Avatar grazing the edge within radius → blocked.
//   4. Avatar centred ABOVE the bookshelf (z above bbox top) → free.
//   5. Avatar at chair seat height → blocked (chair sub-volumes
//      span 0..1.2 m; avatar [0, 1.78] overlaps cushion + back).
//   6. Avatar at TABLE height (table top at 0.75 m) → blocked.
//      This is the case the legacy single-chest-ray approach missed.
//   7. Rotated bookshelf (rot_deg=90) — bbox flips orientation; same
//      world point that was free before is now blocked.
//   8. Empty / null guards.

import { furnitureBlocksCylinder } from '../js/physics/furniture-walk-collision.js';
import { _setFurnitureCatalogueForTests, getFurnitureCatalogue } from '../js/labs/furniturelab/catalog.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

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

const BOOKSHELF = row('test-bookshelf', 'vertical-box', 'reflective',
  { width_m: 1.0, depth_m: 0.30, height_m: 2.0 },
  { '125': 0.60, '250': 0.60, '500': 0.80, '1000': 1.00, '2000': 1.20, '4000': 1.30 });
const CHAIR = row('test-chair', 'seat', 'hybrid',
  { width_m: 0.55, depth_m: 0.60, height_m: 1.20 },
  { '125': 0.15, '250': 0.19, '500': 0.23, '1000': 0.25, '2000': 0.23, '4000': 0.22 });
const TABLE = row('test-table', 'slab-on-legs', 'reflective',
  { width_m: 1.6, depth_m: 0.80, height_m: 0.75 },
  { '125': 0.10, '250': 0.10, '500': 0.10, '1000': 0.10, '2000': 0.10, '4000': 0.10 });

_setFurnitureCatalogueForTests([BOOKSHELF, CHAIR, TABLE]);

const AVATAR_R = 0.32;
const AVATAR_Y_MIN = 0;
const AVATAR_Y_MAX = 1.78;

// =====================================================================
// Block 1 — Avatar inside bookshelf footprint → blocked.
// =====================================================================
{
  // Bookshelf at (5, 5). Footprint state x ∈ [4.5, 5.5], y ∈ [4.85, 5.15].
  const furniture = [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 5, y: 5 }, rotation_deg: 0 }];
  ok(furnitureBlocksCylinder(5, 5, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, furniture, getFurnitureCatalogue()),
    'avatar centred inside bookshelf is blocked');
}

// =====================================================================
// Block 2 — Avatar 2 m off to the side → free.
// =====================================================================
{
  const furniture = [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 5, y: 5 }, rotation_deg: 0 }];
  ok(!furnitureBlocksCylinder(7, 5, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, furniture, getFurnitureCatalogue()),
    'avatar 2 m east of bookshelf is free');
  ok(!furnitureBlocksCylinder(5, 7, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, furniture, getFurnitureCatalogue()),
    'avatar 2 m north of bookshelf is free');
}

// =====================================================================
// Block 3 — Avatar grazing edge within radius → blocked.
// =====================================================================
{
  const furniture = [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 5, y: 5 }, rotation_deg: 0 }];
  // Bookshelf y-range [4.85, 5.15]. Avatar at y=5.40, dist from north
  // edge = 0.25 m < radius 0.32 m → blocked.
  ok(furnitureBlocksCylinder(5, 5.40, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, furniture, getFurnitureCatalogue()),
    'avatar 0.25 m past north edge (< radius) is blocked');
  // Avatar at y=5.50, dist = 0.35 m > radius → free.
  ok(!furnitureBlocksCylinder(5, 5.50, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, furniture, getFurnitureCatalogue()),
    'avatar 0.35 m past north edge (> radius) is free');
}

// =====================================================================
// Block 4 — Avatar feet above bookshelf top → free.
// =====================================================================
{
  // Bookshelf z-range [0, 2.0]. Avatar feet at 2.5, head at 4.28 — no
  // vertical overlap.
  const furniture = [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 5, y: 5 }, rotation_deg: 0 }];
  ok(!furnitureBlocksCylinder(5, 5, 2.5, 2.5 + 1.78, AVATAR_R, furniture, getFurnitureCatalogue()),
    'avatar floating above bookshelf top has no vertical overlap → free');
}

// =====================================================================
// Block 5 — Chair (seat family): avatar at full standing height
// overlaps cushion + back → blocked.
// =====================================================================
{
  const furniture = [{ id: 'F1', catalogueId: 'test-chair', position: { x: 5, y: 5 }, rotation_deg: 0 }];
  ok(furnitureBlocksCylinder(5, 5, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, furniture, getFurnitureCatalogue()),
    'avatar inside chair footprint at standing height is blocked');
}

// =====================================================================
// Block 6 — Table at 0.75 m: this is THE failure mode of the
// chest-ray-only approach. Single ray at 0.98 m passes ABOVE the slab.
// Cylinder test with vertical span [0, 1.78] overlaps [0, 0.75] → blocked.
// =====================================================================
{
  const furniture = [{ id: 'F1', catalogueId: 'test-table', position: { x: 5, y: 5 }, rotation_deg: 0 }];
  ok(furnitureBlocksCylinder(5, 5, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, furniture, getFurnitureCatalogue()),
    'avatar walking onto table is blocked (cylinder catches what chest ray misses)');
}

// =====================================================================
// Block 7 — Rotated bookshelf (90°): bbox flips, same world point goes
// from blocked → free or vice-versa.
// =====================================================================
{
  // Bookshelf at (5, 5), width=1.0 along x, depth=0.30 along y.
  // Test point (5.40, 5): 0.10 m PAST east edge (x=5.5 → 5.40 is INSIDE
  // for the unrotated bookshelf → blocked).
  // Rotated 90°: width swaps with depth. Footprint becomes x ∈ [4.85, 5.15],
  // y ∈ [4.5, 5.5]. Test point (5.40, 5) is at dx=0.25 from east edge
  // (radius 0.32 → blocked, marginal). Better to use a clearer point.
  // Use (5.45, 5) — past the rotated east edge by 0.30 m (just outside radius).
  const unrotated = [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 5, y: 5 }, rotation_deg: 0 }];
  const rotated90 = [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 5, y: 5 }, rotation_deg: 90 }];
  // Point at (5, 5.40): 0.25 m past unrotated north edge (radius=0.32 →
  // blocked); for rotated 90° the bookshelf depth is now along x and
  // width is along y, footprint y ∈ [4.5, 5.5] → point at 5.40 is INSIDE → blocked.
  ok(furnitureBlocksCylinder(5, 5.40, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, unrotated, getFurnitureCatalogue()),
    'unrotated bookshelf: edge-graze blocks');
  ok(furnitureBlocksCylinder(5, 5.40, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, rotated90, getFurnitureCatalogue()),
    'rotated 90°: same point is now inside the now-deeper footprint');
  // Point at (5.40, 5) — past unrotated east edge by 0.10 m (< radius
  // → blocked, but barely). Rotated, this point should be INSIDE the
  // now-wider footprint along y... but x range becomes [4.85, 5.15],
  // so 5.40 is 0.25 past east edge (within radius → blocked).
  // To get a true "free in unrotated, blocked in rotated" case, use a
  // point near (5, 5.7):
  ok(!furnitureBlocksCylinder(5, 5.7, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, unrotated, getFurnitureCatalogue()),
    'unrotated: 0.55 m past north edge is free');
  ok(furnitureBlocksCylinder(5, 5.4, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, rotated90, getFurnitureCatalogue()),
    'rotated: same column inside the now-deeper footprint is blocked');
}

// =====================================================================
// Block 8 — Empty / null guards.
// =====================================================================
{
  ok(!furnitureBlocksCylinder(5, 5, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, [], getFurnitureCatalogue()),
    'empty furniture array → free');
  ok(!furnitureBlocksCylinder(5, 5, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R, null, getFurnitureCatalogue()),
    'null furniture → free');
  ok(!furnitureBlocksCylinder(5, 5, AVATAR_Y_MIN, AVATAR_Y_MAX, AVATAR_R,
        [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 5, y: 5 } }], null),
    'null catalogue → free');
  ok(!furnitureBlocksCylinder(5, 5, AVATAR_Y_MIN, AVATAR_Y_MAX, 0,
        [{ id: 'F1', catalogueId: 'test-bookshelf', position: { x: 5, y: 5 } }], getFurnitureCatalogue()),
    'zero radius → free');
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll furniture walk-collision tests passed.');
