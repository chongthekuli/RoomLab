// Mass-law transmission-loss regression guard (js/physics/wall-tl.js).
//
// Three assertions per Dr. Chen's spec (2026-05-22). Each tests a band where
// the physics is load-bearing, not a happy-path fixture. Test 3 deliberately
// encodes the KNOWN over-prediction of dense concrete as a PASSING test, so a
// future "fix" that silently zeroes the computed-vs-measured divergence trips
// the regression — the divergence is the WallLAB teaching point.

import assert from 'node:assert';
import {
  massLawTL, massLawTLBands, surfaceDensity, densityFromCatalogue,
  TL_FLOOR_DB, TL_CEIL_DB, MASS_LAW_CONST_DB,
} from '../js/physics/wall-tl.js';

let passed = 0;
function check(name, cond) { assert.ok(cond, `FAIL: ${name}`); console.log(`PASS  ${name}`); passed++; }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Constants are the field-incidence ones (guards the −42/−47 trap).
check('MASS_LAW_CONST_DB is the field-incidence 47 (not normal-incidence 42)', MASS_LAW_CONST_DB === 47);
check('clamp bounds are [5, 60]', TL_FLOOR_DB === 5 && TL_CEIL_DB === 60);

// --- Test 1 — doubling mass gives +6.02 dB (the defining property) ----------
// f = 500 Hz, m = 50 → 100 kg/m²; both stay unclamped (40.96 → 46.98 dB).
{
  const a = massLawTL(50, 500);
  const b = massLawTL(100, 500);
  check('mass doubling → +6.02 dB ±0.1 (50→100 kg/m² @ 500 Hz)', near(b - a, 6.02, 0.1));
  // Below-clamp proof: tiny m·f returns exactly the floor.
  check('m·f below clamp returns TL_FLOOR_DB exactly', massLawTL(0.001, 125) === TL_FLOOR_DB);
  check('zero mass (open-air) returns floor, never NaN/-Inf', massLawTL(0, 1000) === TL_FLOOR_DB);
}

// --- Test 2 — +6.02 dB per octave (frequency slope) -------------------------
// m = 200 kg/m²; 500→1000 Hz stays unclamped (53.02 → 59.04 dB).
{
  const a = massLawTL(200, 500);
  const b = massLawTL(200, 1000);
  check('octave doubling of f → +6.02 dB ±0.1 (200 kg/m², 500→1000 Hz)', near(b - a, 6.02, 0.1));
}

// --- Test 3 — concrete: slope right, absolute OVER-predicts (divergence) -----
// concrete-painted m = 345 kg/m², measured TL = [39,41,47,53,58,62,65].
// Concrete's f_c is above 8 kHz, so it's the mass-law-valid exemplar for
// SLOPE — but the raw field mass law still over-predicts the absolute level
// (real thick slabs lose the limp assumption). Assert BOTH so the known
// limitation is locked in as expected behaviour.
{
  const bands = [125, 250, 500, 1000, 2000, 4000, 8000];
  const measured = [39, 41, 47, 53, 58, 62, 65];
  const computed = massLawTLBands(345, bands);

  // (a) slope in the mass-controlled bands (125→250→500) is +6.02 dB/oct.
  const s1 = computed[1] - computed[0];
  const s2 = computed[2] - computed[1];
  check('concrete computed slope 125→250→500 is +6.02 dB/oct ±0.3',
    near(s1, 6.02, 0.3) && near(s2, 6.02, 0.3));

  // (b) the documented over-prediction: computed exceeds measured at 500 Hz
  // by 8–12 dB. If a refactor "corrects" this away, the test fails — the
  // divergence is the WallLAB teaching point, not a defect.
  const offset500 = computed[2] - measured[2];
  check('concrete computed OVER-predicts measured at 500 Hz by 8–12 dB (expected divergence)',
    offset500 >= 8 && offset500 <= 12);

  // High bands clamp at the 60 dB ceiling (sanity — no runaway values).
  check('concrete computed clamps at 60 dB ceiling in HF bands',
    computed[3] === TL_CEIL_DB && computed[6] === TL_CEIL_DB);
}

// --- Density helpers --------------------------------------------------------
// concrete: surface 345 kg/m² at 0.150 m → ~2300 kg/m³ bulk (matches source).
{
  const rho = densityFromCatalogue(345, 0.150);
  check('densityFromCatalogue recovers concrete bulk density ~2300 kg/m³', near(rho, 2300, 5));
  check('surfaceDensity(0.30 m, 2300) = 690 kg/m² (doubling thickness doubles m)',
    near(surfaceDensity(0.30, rho), 690, 1));
  check('densityFromCatalogue guards non-positive reference thickness', densityFromCatalogue(345, 0) === 0);
}

console.log(`\nOK  ${passed} assertions passed`);
