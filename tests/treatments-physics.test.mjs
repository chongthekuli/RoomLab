// PR-2 unit tests — treatment overlap math + clamping + zone-and-panel
// precedence + multi-panel sum + opening interaction.
//
// Reference math (Hannes' v2 brief, signed off by Dr. Chen):
//
//   A_total(f) = Σ_surfaces (S_i − Σ_panels_on_i A_pij) · α_i(f)
//              + Σ_panels A_pj · α_pj(f)
//
//   Per-wall clamping:
//     A_pj = min(catalogue_area_j, remaining_wall_area_i)
//     S_i − Σ_panels_on_i ≥ 0       (per surface, never global)
//     Multiple panels on same wall → LAST placed gets clamped, badged.
//     Panels on a wall with door/window: subtract from wall material entry
//       only, never from the opening entries.
//
// Hand-verified case from the brief:
//   wall S = 10 m², α_wall = 0.05
//   one panel covering A_p = 2 m² with α_p = 0.80
//   Sabine contribution = (10 − 2)·0.05 + 2·0.80 = 0.4 + 1.6 = 2.0 m²
//
// We exercise the engine end-to-end (computeRT60Band → roomEffective
// Surfaces) by installing a synthetic SurfaceLAB catalogue and seeding
// state.treatments. The synthetic catalogue lets us pin α values to
// the brief's example numbers regardless of any future product DB
// reshuffling.
//
// Run: node tests/treatments-physics.test.mjs

import { readFileSync } from 'node:fs';
import { state, applyBlankCustomRoom } from '../js/app-state.js';
import { computeRT60Band } from '../js/physics/rt60.js';
import { roomEffectiveSurfaces } from '../js/physics/room-shape.js';
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
// Materials — load the real DB so wall/floor α values are realistic, but
// stamp a known-α custom 'test-wall' for the hand-verification case so we
// can pin α_wall = 0.05 across all 7 bands.
// ---------------------------------------------------------------------------
const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};
// Inject test-wall α = 0.05 flat — exactly the brief's hand-verification number.
materials.byId['test-wall'] = {
  id: 'test-wall', name: 'Test Wall (α=0.05 flat)',
  absorption: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05],
};

// ---------------------------------------------------------------------------
// Synthetic catalogue — single product 'test-panel' with α = 0.80 flat
// across all bands so the (10−2)·0.05 + 2·0.80 = 2.0 m² Sabine check
// works on every band. Installed via _setCachedCatalogueForTests so
// the physics engine pulls α from this object instead of the real
// SurfaceLAB cache.
// ---------------------------------------------------------------------------
function installTestCatalogue() {
  _setCachedCatalogueForTests({
    all: [
      {
        id: 'test-panel',
        name: 'Test Panel (α=0.80 flat)',
        absorption: [0.80, 0.80, 0.80, 0.80, 0.80, 0.80, 0.80],
        category: 'absorber.porous.panel',
        geometry: { width_mm: 1000, height_mm: 2000, depth_mm: 50 },
        mounting: 'ASTM_C423_TypeA',
        manufacturer: 'TestMfr',
      },
      {
        id: 'test-diffuser',
        name: 'Test Diffuser (α=0.20 flat)',
        absorption: [0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20],
        category: 'diffuser.qrd_2d',
        geometry: { width_mm: 600, height_mm: 600, depth_mm: 100 },
        mounting: 'ASTM_C423_TypeA',
        manufacturer: 'TestMfr',
      },
    ],
    groups: [],
  });
}

// ---------------------------------------------------------------------------
// Helper: build a treatment entry with explicit area (skip the full
// makeTreatmentEntry() helper since we want to set dimensions exactly).
// Wall index follows the rectangular convention: 0=N, 1=S, 2=E, 3=W.
// ---------------------------------------------------------------------------
function tr(id, productId, wallIndex, width_m, height_m) {
  return {
    id, productId,
    label: id,
    anchor: { surface: 'wall', wallIndex },
    position: { x: 0, y: 0, z: 1.5 },
    rotation_deg: 0,
    dimensions: { width_m, height_m, depth_m: 0.05 },
  };
}

function trCeiling(id, productId, width_m, height_m) {
  return {
    id, productId,
    label: id,
    anchor: { surface: 'ceiling' },
    position: { x: 0, y: 0, z: 3 },
    rotation_deg: 0,
    dimensions: { width_m, height_m, depth_m: 0.05 },
  };
}

// ---------------------------------------------------------------------------
// Common fixture — small 10 m wide × 5 m deep × 3 m tall room.
// wall_north total area = 10 × 3 = 30 m². We override its material to
// test-wall (α = 0.05).
// ---------------------------------------------------------------------------
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
    wall_north: 'test-wall',
    wall_south: 'test-wall',
    wall_east: 'test-wall',
    wall_west: 'test-wall',
  };
  state.zones = [];
  state.treatments = [];
}

installTestCatalogue();

// ---------------------------------------------------------------------------
// TEST 1 — Hand-verification math
//   Brief's example: wall S = 10 m², panel A_p = 2 m², α_wall = 0.05,
//   α_panel = 0.80 → contribution = (10 − 2)·0.05 + 2·0.80 = 2.0 m² Sabine.
//
// We instantiate a 10 m × 1 m wall slice by placing the panel on a real
// rectangular wall and isolating its surface contribution. Wall_north
// at 10 m × 3 m = 30 m² with α=0.05 contributes 30·0.05 = 1.5 m² baseline.
// Add a 1 × 2 m panel (2 m²): wall becomes 28 m²·0.05 + 2 m²·0.80 = 1.4 + 1.6 = 3.0 m².
// Δ from baseline = 3.0 − 1.5 = 1.5 m² (= 2·(0.80 − 0.05)).
//
// We assert BOTH the wall slice and the engine-wide totalAbsorption_sabins
// delta match the hand-derived numbers.
// ---------------------------------------------------------------------------
freshScene();
const bandBefore = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [], treatments: [] });
state.treatments = [tr('T1', 'test-panel', 0, 1, 2)];   // 1 × 2 m on wall_north
const bandAfter = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [], treatments: state.treatments });

const expectedDeltaAbs = 2 * (0.80 - 0.05);   // 1.5 m² Sabine
const actualDeltaAbs = bandAfter.totalAbsorption_sabins - bandBefore.totalAbsorption_sabins;
assert(approx(actualDeltaAbs, expectedDeltaAbs, 1e-6),
  `Hand math: 1 panel (1×2 m, α=0.80) on α=0.05 wall raises total absorption by ${expectedDeltaAbs} m² Sabins ` +
  `(actual Δ = ${actualDeltaAbs.toFixed(6)})`);

// Total area MUST be conserved — we don't add new wall area, we just
// re-attribute it. The wall's area_m2 drops by A_p, and the panel
// appears as its own surface of area A_p. Sum unchanged.
assert(approx(bandAfter.totalArea_m2, bandBefore.totalArea_m2, 1e-6),
  `Total area conserved when adding a panel (S_before=${bandBefore.totalArea_m2} S_after=${bandAfter.totalArea_m2})`);

// ---------------------------------------------------------------------------
// TEST 2 — Per-wall clamping
//   Wall = 30 m² (10 × 3). Place TWO panels:
//     P1: 8 × 3 = 24 m²
//     P2: 8 × 3 = 24 m²   → total wanted = 48 m², way past wall budget.
//   Expected: P1 takes 24, P2 clamps to 30 − 24 = 6, with _physicsClamped=true.
//   Total wall-side surfaces = 30 m² (conserved).
// ---------------------------------------------------------------------------
freshScene();
state.treatments = [
  tr('T1', 'test-panel', 0, 8, 3),
  tr('T2', 'test-panel', 0, 8, 3),
];
const surf = roomEffectiveSurfaces(state.room, [], state.treatments);
const wallN = surf.find(s => s.id === 'wall_north');
const t1 = surf.find(s => s.id === 'treatment_T1');
const t2 = surf.find(s => s.id === 'treatment_T2');
assert(approx(t1.area_m2, 24),                'P1 takes its full 24 m² (wall had 30 m² remaining)');
assert(approx(t2.area_m2, 6),                 'P2 clamped to 6 m² (wall had 6 m² remaining after P1)');
assert(state.treatments[1]._physicsClamped === true, 'P2 tagged _physicsClamped:true');
assert(state.treatments[0]._physicsClamped === false, 'P1 NOT tagged _physicsClamped (fit cleanly)');
assert(approx(wallN.area_m2, 0),              'Wall_north area dropped to 0 after both panels');
const wallTotal = wallN.area_m2 + t1.area_m2 + t2.area_m2;
assert(approx(wallTotal, 30),                 'Panel + wall area sum = 30 m² (conservation)');

// Sum-on-wall surfaces never exceeds S_wall — this is the no-double-count
// invariant Sam's brief explicitly asked us to lock in.
const wallSlice = wallN.area_m2 + t1.area_m2 + t2.area_m2;
assert(wallSlice <= 30 + 1e-6, 'Σ panel area on wall_north never exceeds S_wall (30 m²)');

// ---------------------------------------------------------------------------
// TEST 3 — Multi-panel sum (non-clamping case)
//   Wall = 30 m². Place 3 panels of 2 × 2 = 4 m² each. Total 12 m².
//   Wall remainder = 30 − 12 = 18 m². No clamping.
// ---------------------------------------------------------------------------
freshScene();
state.treatments = [
  tr('T1', 'test-panel', 0, 2, 2),
  tr('T2', 'test-panel', 0, 2, 2),
  tr('T3', 'test-panel', 0, 2, 2),
];
const surf3 = roomEffectiveSurfaces(state.room, [], state.treatments);
const wallN3 = surf3.find(s => s.id === 'wall_north');
const t1_3 = surf3.find(s => s.id === 'treatment_T1');
const t2_3 = surf3.find(s => s.id === 'treatment_T2');
const t3_3 = surf3.find(s => s.id === 'treatment_T3');
assert(approx(wallN3.area_m2, 18),     '3×4 m² panels leave 18 m² of wall_north');
assert(approx(t1_3.area_m2, 4) && approx(t2_3.area_m2, 4) && approx(t3_3.area_m2, 4),
  'all 3 panels get their full 4 m² (no clamping)');
assert(state.treatments.every(t => t._physicsClamped === false),
  'no panel tagged clamped in the 12 m² < 30 m² case');

// The Sabine contribution should match: 18·0.05 + 3·4·0.80 = 0.9 + 9.6 = 10.5 m²
const band3 = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [], treatments: state.treatments });
// Compute just the wall_north contribution. We isolate by recomputing
// without treatments and subtracting non-wall contributions later;
// easier: assert the delta from "no panels" matches 3·4·(0.80−0.05) = 9.0.
freshScene();
const baseBand3 = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [], treatments: [] });
const expectedDelta3 = 3 * 4 * (0.80 - 0.05);
state.treatments = [
  tr('T1', 'test-panel', 0, 2, 2),
  tr('T2', 'test-panel', 0, 2, 2),
  tr('T3', 'test-panel', 0, 2, 2),
];
const treatBand3 = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [], treatments: state.treatments });
const actualDelta3 = treatBand3.totalAbsorption_sabins - baseBand3.totalAbsorption_sabins;
assert(approx(actualDelta3, expectedDelta3, 1e-6),
  `3-panel sum: ΔA = 3·4·(0.80−0.05) = ${expectedDelta3} m² Sabine (actual ${actualDelta3.toFixed(4)})`);

// ---------------------------------------------------------------------------
// TEST 4 — Zone + panel precedence (zones carve floor FIRST, then panels)
//   Wall has nothing to do with zones. The expected behavior: zone
//   carves floor; panel on a wall is unaffected. We just verify both
//   contribute additively without clobbering each other.
// ---------------------------------------------------------------------------
freshScene();
state.zones = [{
  id: 'Z1', vertices: [{x:1,y:1},{x:3,y:1},{x:3,y:3},{x:1,y:3}],
  material_id: 'wood-floor',  // a 4 m² carpet patch on the floor (same material as floor here)
  occupancy_percent: 0,
}];
state.treatments = [tr('T1', 'test-panel', 0, 2, 2)];   // 4 m² panel on wall_north
const surf4 = roomEffectiveSurfaces(state.room, state.zones, state.treatments);
const floor4 = surf4.find(s => s.id === 'floor');
const zone4 = surf4.find(s => s.id === 'zone_Z1');
const wallN4 = surf4.find(s => s.id === 'wall_north');
const t1_4 = surf4.find(s => s.id === 'treatment_T1');
assert(approx(floor4.area_m2, 10 * 5 - 4),  `Floor carved by zone (${(10*5-4).toFixed(0)} m² remaining)`);
assert(approx(zone4.area_m2, 4),            `Zone surface added (4 m²)`);
assert(approx(wallN4.area_m2, 30 - 4),      'Wall_north carved by panel (26 m² remaining)');
assert(approx(t1_4.area_m2, 4),             'Panel surface added (4 m²)');

// ---------------------------------------------------------------------------
// TEST 5 — Opening + panel: panel carves wall material, NOT the opening
//   Wall_north has a door (2 m × 2.1 m = 4.2 m² opening). Wall material
//   area is therefore 30 − 4.2 = 25.8 m². Place a 6 m² panel.
//   Expected: panel carves wall_north (25.8 → 19.8). The wall_north_op_0
//   entry stays at 4.2 m² untouched.
// ---------------------------------------------------------------------------
freshScene();
state.room.surfaces.wall_north = {
  materialId: 'test-wall',
  openings: [{
    kind: 'door', x_m: 4, z_m: 0,
    width_m: 2, height_m: 2.1,
    materialId: 'door-solid-wood', state: 'closed',
  }],
};
state.treatments = [tr('T1', 'test-panel', 0, 3, 2)];   // 6 m² panel on wall_north
const surf5 = roomEffectiveSurfaces(state.room, [], state.treatments);
const wallN5 = surf5.find(s => s.id === 'wall_north');
const door5 = surf5.find(s => s.id === 'wall_north_op_0');
const t1_5 = surf5.find(s => s.id === 'treatment_T1');
assert(door5 && approx(door5.area_m2, 4.2),  `Opening entry preserved (door area = 4.2 m²)`);
assert(approx(wallN5.area_m2, 30 - 4.2 - 6), `Wall_north carved by panel only — ${(30-4.2-6).toFixed(2)} m² remaining`);
assert(approx(t1_5.area_m2, 6),              'Panel surface added (6 m²)');
// Conservation: wall material + door + panel = 30 m² total wall envelope
assert(approx(wallN5.area_m2 + door5.area_m2 + t1_5.area_m2, 30),
  'Wall material + opening + panel = 30 m² (wall envelope conserved)');

// ---------------------------------------------------------------------------
// TEST 6 — Ceiling panel carves the ceiling surface
//   Wall placement is well-covered; this verifies surface='ceiling'
//   anchor resolves to the 'ceiling' surface entry, not a wall.
// ---------------------------------------------------------------------------
freshScene();
state.treatments = [trCeiling('T1', 'test-panel', 2, 3)];   // 6 m² ceiling cloud
const surf6 = roomEffectiveSurfaces(state.room, [], state.treatments);
const ceil6 = surf6.find(s => s.id === 'ceiling');
const t1_6 = surf6.find(s => s.id === 'treatment_T1');
assert(approx(ceil6.area_m2, 10 * 5 - 6),    `Ceiling carved by ceiling panel (${(10*5-6).toFixed(0)} m² remaining)`);
assert(approx(t1_6.area_m2, 6),              'Ceiling panel surface added (6 m²)');

// ---------------------------------------------------------------------------
// TEST 7 — Diffuser α added as-is (no double-count subtraction by design)
//   Same overlap math as absorbers; just a smaller α. Per Hannes' rule
//   table: "Diffuser α — Add catalogue value as-is. No double-count
//   subtraction." → α_diffuser·A_p contributes 0.20·4 = 0.8 m² Sabine,
//   wall loses 4 m²·0.05 = 0.2 m². Net Δ = 0.8 − 0.2 = 0.6 m².
// ---------------------------------------------------------------------------
freshScene();
const baseBand7 = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [], treatments: [] });
state.treatments = [tr('T1', 'test-diffuser', 0, 2, 2)];
const treatBand7 = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [], treatments: state.treatments });
const expectedDelta7 = 4 * (0.20 - 0.05);  // 0.60 m²
const actualDelta7 = treatBand7.totalAbsorption_sabins - baseBand7.totalAbsorption_sabins;
assert(approx(actualDelta7, expectedDelta7, 1e-6),
  `Diffuser: ΔA = 4·(0.20 − 0.05) = ${expectedDelta7} m² Sabine (actual ${actualDelta7.toFixed(4)})`);

// ---------------------------------------------------------------------------
// TEST 8 — Catalogue not loaded → treatments contribute α=0 (safe fallback)
//   This is the v1-compatible behavior: when the SurfaceLAB cache hasn't
//   resolved yet (e.g. a physics-only test path, or a saved scene loaded
//   with an unknown productId), the treatment STILL carves the wall but
//   contributes ZERO absorption. RT60 must NOT inflate.
// ---------------------------------------------------------------------------
_clearCachedCatalogueForTests();
freshScene();
const baseBand8 = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [], treatments: [] });
state.treatments = [tr('T1', 'unknown-product', 0, 2, 2)];   // 4 m² of unknown
const treatBand8 = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [], treatments: state.treatments });
// Wall carved 4 m² (which had α=0.05 → ΔA from wall = −0.2). Panel contributes 0
// (no catalogue → α=0). Net Δ should be −0.2 m² Sabine.
// However the brief's hard rule says "Σ surfaces never goes negative", and
// total area stays conserved. We allow the negative wall delta because
// it's the physically honest outcome — the wall material is genuinely
// replaced by an inert visual placeholder.
const expectedDelta8 = -4 * 0.05;   // −0.2 m²
const actualDelta8 = treatBand8.totalAbsorption_sabins - baseBand8.totalAbsorption_sabins;
assert(approx(actualDelta8, expectedDelta8, 1e-6),
  `Unknown product (no catalogue): ΔA = −4·0.05 = ${expectedDelta8} m² Sabine (actual ${actualDelta8.toFixed(4)})`);

// Restore catalogue for any future tests that follow this file's pattern.
installTestCatalogue();

// ---------------------------------------------------------------------------
// TEST 9 — Backward compatibility: omitting `treatments` argument is identical
//   to passing []. Critical for the many call sites that don't yet thread
//   state.treatments — they must keep returning v1 numbers.
// ---------------------------------------------------------------------------
freshScene();
const omitted = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [] });
const empty = computeRT60Band({ room: state.room, materials, bandIndex: 2, zones: [], treatments: [] });
assert(approx(omitted.totalAbsorption_sabins, empty.totalAbsorption_sabins, 1e-9),
  'Omitting treatments arg = passing [] (backward compat)');

// ---------------------------------------------------------------------------
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
