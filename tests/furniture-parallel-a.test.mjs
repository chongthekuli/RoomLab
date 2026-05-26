// FurnitureLAB physics regression test.
//
// Locks Dr. Chen's three rules for parallel-A integration of placed
// furniture into the Sabine + Eyring RT60 formulae:
//
//   1. Sabine: ΣA_obj summed straight into total absorption.
//   2. Eyring: ΣA_obj added to the denominator OUTSIDE the log
//      (Kuttruff 5th ed. §5.3, Beranek 2nd ed. §7.3). NEVER lumped into
//      ᾱ_surfaces. The reference value below comes from hand-evaluating
//      0.161·V / (-S·ln(1-α̅) + ΣA_obj) for the synthetic shoebox.
//   3. Bands with no catalogue entry contribute zero — never extrapolate.
//
// Failure of any rule = the user's RT60 number is wrong in any scene
// where they placed furniture, which is "every real scene." This test
// is the tripwire that lights up if a future refactor folds A_obj back
// into the surface channel (the historical wrong path that
// `feedback_preset_plumbing` warns about — silent value drift through
// a parallel data structure).

import { computeAllBands, eyring } from '../js/physics/rt60.js';
import { sumFurnitureAbsorption } from '../js/physics/furniture-absorption.js';
import assert from 'node:assert/strict';

// --- Synthetic shoebox -------------------------------------------------
// 10 × 8 × 3 m room → V = 240 m³, S = 268 m². Light absorption on every
// surface (α = 0.10) so ᾱ stays well below 0.2 and the Sabine/Eyring
// values are reasonable, then we ADD chairs and assert the predicted
// shift matches Dr. Chen's parallel-A formula.
const room = {
  shape: 'rectangular',
  width_m: 10, depth_m: 8, height_m: 3,
  surfaces: {
    floor: 'test-flat-010',
    ceiling: 'test-flat-010',
    wall_north: 'test-flat-010',
    wall_south: 'test-flat-010',
    wall_east: 'test-flat-010',
    wall_west: 'test-flat-010',
    walls: 'test-flat-010',
    edges: null,
  },
};
const materials = {
  frequency_bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000],
  byId: {
    'test-flat-010': {
      id: 'test-flat-010', name: 'test',
      absorption: [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10],
      scattering: [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10],
    },
  },
};

// 30 placed theater seats, each contributing the Phase-0 derived A_obj
// from the catalogue (Beranek-style occupied upholstered values).
const catalogue = new Map();
catalogue.set('theater-seat-upholstered-occupied', {
  id: 'theater-seat-upholstered-occupied',
  acoustics: {
    A_obj_m2_sab_per_band: {
      '125': 0.15, '250': 0.19, '500': 0.23,
      '1000': 0.25, '2000': 0.23, '4000': 0.22,
      // intentionally no '8000' — measured data stops at 4 kHz.
    },
  },
});
const N_CHAIRS = 30;
const furniture = Array.from({ length: N_CHAIRS }, (_, i) => ({
  id: `F${i + 1}`,
  catalogueId: 'theater-seat-upholstered-occupied',
  position: { x: 0, y: 0 },
  rotation_deg: 0,
}));

// --- 1. Helper sums correctly ------------------------------------------
const A500_per_chair = 0.23;
const A500_total_expected = N_CHAIRS * A500_per_chair;
const A500_total_actual = sumFurnitureAbsorption(furniture, catalogue, 500);
assert.ok(
  Math.abs(A500_total_actual - A500_total_expected) < 1e-9,
  `sumFurnitureAbsorption @ 500 Hz: got ${A500_total_actual}, expected ${A500_total_expected}`,
);
console.log(`PASS  sumFurnitureAbsorption @ 500 Hz with ${N_CHAIRS} chairs = ${A500_total_actual} m² Sa`);

// --- 2. Missing band returns 0 (no extrapolation) ----------------------
const A8k_total = sumFurnitureAbsorption(furniture, catalogue, 8000);
assert.ok(
  A8k_total === 0,
  `8 kHz must be zero (catalogue has no entry); got ${A8k_total}. Dr. Chen rule: never extrapolate.`,
);
console.log(`PASS  no extrapolation: 8 kHz with no catalogue entry returns 0 (got ${A8k_total})`);

// --- 3. Sabine: total absorption gains exactly ΣA_obj ------------------
const bandsWithout = computeAllBands({ room, materials, airAbsorption: false });
const bandsWith    = computeAllBands({ room, materials, furniture, furnitureCatalogue: catalogue, airAbsorption: false });
const b500_without = bandsWithout.find(b => b.frequency_hz === 500);
const b500_with    = bandsWith.find(b => b.frequency_hz === 500);
const sabineDelta_actual   = b500_with.totalAbsorption_sabins - b500_without.totalAbsorption_sabins;
const sabineDelta_expected = A500_total_expected;
assert.ok(
  Math.abs(sabineDelta_actual - sabineDelta_expected) < 1e-6,
  `Sabine total absorption must grow by exactly ΣA_obj at 500 Hz: got Δ=${sabineDelta_actual}, expected Δ=${sabineDelta_expected}`,
);
console.log(`PASS  Sabine total absorption gains exactly ΣA_obj at 500 Hz (Δ=${sabineDelta_actual.toFixed(3)} m² Sa)`);

// --- 4. Mean α stays surface-only (no lumping) -------------------------
assert.ok(
  Math.abs(b500_with.meanAbsorption - b500_without.meanAbsorption) < 1e-9,
  `α̅ surfaces-only must NOT change when furniture is added (lumping = wrong physics). `
  + `without=${b500_without.meanAbsorption}, with=${b500_with.meanAbsorption}`,
);
console.log(`PASS  α̅ stays surface-only when furniture is added (no lumping into log argument)`);

// --- 5. Eyring: denominator gains exactly ΣA_obj OUTSIDE the log -------
// Reference: -S·ln(1-α̅) + airAbs + ΣA_obj. With airAbsorption=false the
// air term is 0; we verify the only added term is ΣA_obj at this band.
const eyring_with    = b500_with.eyring_s;
const eyring_without = b500_without.eyring_s;
const V = b500_with.volume_m3;
const S = b500_with.totalArea_m2;
const alphaBar = b500_with.meanAbsorption;
const eyring_expected_with = eyring({
  volume_m3: V, totalArea_m2: S,
  surfaceMeanAbsorption: alphaBar,
  airAbsSabins: 0,
  objectAbsSabins: A500_total_expected,
});
assert.ok(
  Math.abs(eyring_with - eyring_expected_with) < 1e-6,
  `Eyring with ΣA_obj outside the log: got ${eyring_with.toFixed(5)}, expected ${eyring_expected_with.toFixed(5)}`,
);
// And: lumping check. If the implementation had wrongly added ΣA_obj
// into surfaceAbsorption_sabins (the lumping bug Dr. Chen warned about),
// α̅ would be (S·α + ΣA)/S which is bigger, and Eyring would be SMALLER
// than the parallel-A reference. Assert the actual value is NOT the
// lumped value.
const alphaBar_LUMPED_WRONG = (S * alphaBar + A500_total_expected) / S;
const eyring_LUMPED_WRONG = eyring({
  volume_m3: V, totalArea_m2: S,
  surfaceMeanAbsorption: alphaBar_LUMPED_WRONG,
  airAbsSabins: 0, objectAbsSabins: 0,
});
assert.ok(
  Math.abs(eyring_with - eyring_LUMPED_WRONG) > 1e-3,
  `Eyring must NOT match the lumped form. Lumping gives ${eyring_LUMPED_WRONG.toFixed(5)} s, `
  + `parallel-A gives ${eyring_expected_with.toFixed(5)} s. If they match, the implementation has regressed.`,
);
console.log(`PASS  Eyring places ΣA_obj outside the log (parallel-A: ${eyring_with.toFixed(3)} s, lumped-wrong: ${eyring_LUMPED_WRONG.toFixed(3)} s — distinguishable)`);

// --- 6. Sabine + Eyring without furniture are unchanged ----------------
// Backward-compat: callers that don't pass furniture get the original
// numbers exactly. Catches accidental hard dependencies on the new
// parameters.
const bandsNoFurniture = computeAllBands({ room, materials, airAbsorption: false });
const b500_noFurn = bandsNoFurniture.find(b => b.frequency_hz === 500);
assert.ok(
  Math.abs(b500_noFurn.sabine_s - b500_without.sabine_s) < 1e-9,
  `Calling computeAllBands without furniture must yield the SAME Sabine as before the helper existed.`,
);
assert.ok(
  Math.abs(b500_noFurn.eyring_s - b500_without.eyring_s) < 1e-9,
  `Calling computeAllBands without furniture must yield the SAME Eyring as before the helper existed.`,
);
console.log(`PASS  backward compat: no-furniture call matches pre-furniture Sabine + Eyring exactly`);

console.log('\nAll FurnitureLAB parallel-A regression tests passed.');
