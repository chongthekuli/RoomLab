// Phase 5 Step 2 regression — wall-rating.js (v=614, 2026-05-23).
//
// Dr. Chen signed off on all four contour arrays + the rules on 2026-05-23.
// This test pins:
//   1. Contour-array transcription drift (sum-hash on every frozen array).
//   2. The off-by-one canary: flat 50 dB across all bands → Rw = 50, STC = 50.
//   3. The single-deviation rule divergence: a deep narrow dip drives STC
//      below Rw (Dr. Chen's #5 gotcha — easy to ship wrong if STC drops
//      the rule alongside Rw).
//   4. Boundary acceptance: Σ_unfav = 32.0 exactly must ACCEPT, not reject.
//   5. Spectrum adaptation (C / Ctr) returns finite numbers and stays near
//      zero on a flat wall (no preferential band failure).
//   6. Defensive guards: missing bands, length mismatch, non-finite input.

import assert from 'node:assert';
import {
  ISO_717_1_RW_CONTOUR_DB,
  ASTM_E413_STC_CONTOUR_DB,
  ISO_717_1_C_SPECTRUM_DB,
  ISO_717_1_CTR_SPECTRUM_DB,
  computeRw,
  computeSTC,
  computeC,
  computeCtr,
  _testing,
} from '../js/physics/wall-rating.js';
import { ISO_THIRD_OCTAVE_HZ, ISO_RW_BANDS_HZ } from '../js/physics/third-octave-bands.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// =============================================================================
// 1. Contour-array transcription drift (sum-hash on each frozen array)
// =============================================================================

// Rw reference contour (ISO 717-1:2020 Table 1): 33+36+39+42+45+48+51+52
//   +53+54+55+56*5 = 788.
check('Rw contour: 16 bands, sum-hash = 788, frozen',
  ISO_717_1_RW_CONTOUR_DB.length === 16 &&
  sum(ISO_717_1_RW_CONTOUR_DB) === 788 &&
  Object.isFrozen(ISO_717_1_RW_CONTOUR_DB));

// Rw contour: spot-check the +3 dB/oct equivalent rise below 500 Hz.
check('Rw contour at 500 Hz = 52 dB (the ISO 717-1 anchor)',
  ISO_717_1_RW_CONTOUR_DB[ISO_RW_BANDS_HZ.indexOf(500)] === 52);
check('Rw contour at 100 Hz = 33 dB AND 1.25k-3.15k = 56 dB plateau',
  ISO_717_1_RW_CONTOUR_DB[0] === 33 &&
  ISO_717_1_RW_CONTOUR_DB.slice(-5).every(v => v === 56));

// STC reference (ASTM E413-22 Table 1, deviations from 500 Hz):
//   -16-13-10-7-4-1+0+1+2+3+4*6 = -21.
check('STC contour: 16 bands, sum-hash = -21, frozen',
  ASTM_E413_STC_CONTOUR_DB.length === 16 &&
  sum(ASTM_E413_STC_CONTOUR_DB) === -21 &&
  Object.isFrozen(ASTM_E413_STC_CONTOUR_DB));
check('STC contour at 500 Hz deviation = 0 (anchor; STC = shift)',
  ASTM_E413_STC_CONTOUR_DB[6] === 0);   // 500 Hz is index 6 in 125-4000 Hz

// C spectrum (ISO 717-1:2020 Table 2 col 2, pink/A-weighted):
//   -29-26-23-21-19-17-15-13-12-11-10-9-9-9-9-9 = -241.
check('C spectrum: 16 bands, sum-hash = -241, frozen',
  ISO_717_1_C_SPECTRUM_DB.length === 16 &&
  sum(ISO_717_1_C_SPECTRUM_DB) === -241 &&
  Object.isFrozen(ISO_717_1_C_SPECTRUM_DB));

// Ctr spectrum (ISO 717-1:2020 Table 2 col 3, traffic):
//   -20-20-18-16-15-14-13-12-11-9-8-9-10-11-13-15 = -214.
check('Ctr spectrum: 16 bands, sum-hash = -214, frozen',
  ISO_717_1_CTR_SPECTRUM_DB.length === 16 &&
  sum(ISO_717_1_CTR_SPECTRUM_DB) === -214 &&
  Object.isFrozen(ISO_717_1_CTR_SPECTRUM_DB));

// =============================================================================
// 2. Off-by-one canary: flat 50 dB → Rw = 50, STC = 50 (Dr. Chen #1 gotcha)
// =============================================================================
//
// Hand verification of Rw shift on flat R = 50:
//   shift = -2: contour = ref-2. Unfav per band = max(0, ref[i]-2-50) =
//     max(0, ref[i]-52). Bands with ref > 52: 630→1, 800→2, 1000→3,
//     1250-3150→4 each (5 bands). Σ = 1+2+3+20 = 26. ≤ 32 → accept.
//   shift = -1: contour = ref-1. Unfav: 500→1, 630→2, 800→3, 1000→4,
//     1250-3150→5 each. Σ = 1+2+3+4+25 = 35. > 32 → reject.
//   Largest valid = -2 → Rw = 52 + (-2) = 50.

{
  const flat = new Array(ISO_THIRD_OCTAVE_HZ.length).fill(50);
  const Rw = computeRw(flat, ISO_THIRD_OCTAVE_HZ);
  const STC = computeSTC(flat, ISO_THIRD_OCTAVE_HZ);
  check('flat R = 50 dB → Rw = 50 (off-by-one canary)',
    Rw === 50, `got Rw=${Rw}`);
  check('flat R = 50 dB → STC = 50',
    STC === 50, `got STC=${STC}`);
  check('flat curve: Rw === STC (no asymmetric rule fires)',
    Rw === STC);
}

// =============================================================================
// 3. Single-deviation rule divergence: STC < Rw on deep narrow dip
// =============================================================================
//
// Construct: R = 70 dB everywhere except R[1 kHz] = 60 dB (10 dB dip).
//
// Rw analysis:
//   At shift = 17: 1k-band unfav = max(0, 55+17-60) = 12. Plateau bands
//     unfav = max(0, 56+17-70) = 3 each × 5 = 15. Σ = 12+15 = 27. ≤ 32 → accept.
//   At shift = 18: 1k unfav = 13. Plateau = 4 each × 5 = 20. Σ = 33. > 32 → reject.
//   Largest valid = 17 → Rw = 52 + 17 = 69.
//
// STC analysis (single-band rule ≤ 8 dB kicks in BEFORE Σ rule):
//   At shift = 65: 1k unfav = max(0, 3+65-60) = 8 (= STC limit). Other bands:
//     max(0, dev[i]+65-70). dev = +4 plateau (6 bands): -1=0. dev = +3 (1k,
//     already counted): -2=0. All zero. Σ = 8. Single = 8 ≤ 8 → accept.
//   At shift = 66: 1k unfav = 9 > 8 → STC single-deviation REJECT (even though
//     Σ rule would still pass).
//   Largest valid = 65 → STC = 0 + 65 = 65.
//
// STC < Rw by 4 dB — this is exactly the case where the rules diverge.

{
  const dipped = new Array(ISO_THIRD_OCTAVE_HZ.length).fill(70);
  dipped[ISO_THIRD_OCTAVE_HZ.indexOf(1000)] = 60;
  const Rw = computeRw(dipped, ISO_THIRD_OCTAVE_HZ);
  const STC = computeSTC(dipped, ISO_THIRD_OCTAVE_HZ);
  check('deep dip @ 1 kHz: Rw = 69 (Σ ≤ 32 only; single 12 dB tolerated)',
    Rw === 69, `got Rw=${Rw}`);
  check('deep dip @ 1 kHz: STC = 65 (single-dev rule rejects 9+ dB)',
    STC === 65, `got STC=${STC}`);
  check('STC < Rw by 4 dB (single-deviation rule active — Dr. Chen #5)',
    Rw - STC === 4, `Rw=${Rw} STC=${STC}`);
}

// =============================================================================
// 4. Boundary acceptance: Σ = 32.0 exactly is ACCEPTED
// =============================================================================
//
// Construct a case where Σ_unfav = 32 EXACTLY at one shift. With the STC
// contour and flat R = 50: at shift = 50, Σ = 30 (worked out by hand in the
// Step 2 prep). Easier: use shiftContourToFit directly on a curated synthetic.
//
// Synthetic: contour = [0, 0, …, 0] (16 zeros), measured R = [-2, -2, …, -2]
// (16 negative twos). At shift = 0: unfav per band = max(0, 0-(-2)) = 2.
// Σ = 32. Single = 2. ≤ 32 → accept at shift 0. At shift = 1: unfav per band
// = 3, Σ = 48 → reject. Largest valid shift = 0. Σ at the answer shift = 32
// EXACTLY — proves the ≤ boundary is inclusive.

{
  const flatContour = new Array(16).fill(0);
  const negTwoR = new Array(16).fill(-2);
  const shift = _testing.shiftContourToFit(negTwoR, flatContour, 32.0);
  check('Σ = 32.0 exactly accepted (boundary inclusive, Dr. Chen #3)',
    shift === 0, `got shift=${shift}`);
}

// =============================================================================
// 5. Spectrum adaptation — C / Ctr near zero on flat wall
// =============================================================================
//
// On a flat-R wall, the spectrum-adaptation correction collapses toward zero
// because the wall has no preferential band failure. The formula:
//   X = -10·log10(Σ 10^((L_i − R)/10)) − Rw
// For flat R = K and Rw = K:
//   Σ 10^((L_i − K)/10) = 10^(-K/10) · Σ 10^(L_i/10)
//   -10·log10(...) = K − 10·log10(Σ 10^(L_i/10))
//   X = (K − 10·log10(Σ 10^(L_i/10))) − K = -10·log10(Σ 10^(L_i/10))
// For traffic spectrum, Σ 10^(L_i/10) ≈ 0.996 → X ≈ 0.0.
// For pink/A spectrum, Σ 10^(L_i/10) ≈ 1.003 → X ≈ 0.0.

{
  const flat = new Array(ISO_THIRD_OCTAVE_HZ.length).fill(50);
  const c = computeC(flat, ISO_THIRD_OCTAVE_HZ);
  const ctr = computeCtr(flat, ISO_THIRD_OCTAVE_HZ);
  check('flat wall: C is finite and near 0 (no preferential band failure)',
    Number.isFinite(c) && Math.abs(c) <= 1,
    `got C=${c}`);
  check('flat wall: Ctr is finite and near 0',
    Number.isFinite(ctr) && Math.abs(ctr) <= 1,
    `got Ctr=${ctr}`);
}

// Spectrum adaptation on a low-frequency-weak wall: R[100-200 Hz] = 20 dB,
// rising to R[800-3150 Hz] = 60 dB. Ctr should be more negative than C
// (traffic spectrum penalises low-frequency weakness more aggressively).
{
  const lowWeak = new Array(ISO_THIRD_OCTAVE_HZ.length).fill(60);
  for (const f of [100, 125, 160, 200]) {
    lowWeak[ISO_THIRD_OCTAVE_HZ.indexOf(f)] = 20;
  }
  const c = computeC(lowWeak, ISO_THIRD_OCTAVE_HZ);
  const ctr = computeCtr(lowWeak, ISO_THIRD_OCTAVE_HZ);
  check('low-frequency-weak wall: Ctr more negative than C (traffic favours LF)',
    Number.isFinite(c) && Number.isFinite(ctr) && ctr < c,
    `C=${c} Ctr=${ctr}`);
}

// =============================================================================
// 6. Defensive guards
// =============================================================================

{
  // Length mismatch returns null.
  check('length mismatch returns null (defensive)',
    computeRw([50, 50, 50], ISO_THIRD_OCTAVE_HZ) === null);
}
{
  // Missing band returns null.
  const missingBands = ISO_THIRD_OCTAVE_HZ.filter(f => f !== 1000);   // strip 1 kHz
  const tl = new Array(missingBands.length).fill(50);
  check('missing required band returns null',
    computeRw(tl, missingBands) === null);
}
{
  // Non-finite input returns null (NaN guard).
  const flat = new Array(ISO_THIRD_OCTAVE_HZ.length).fill(50);
  flat[5] = NaN;
  check('NaN in input returns null (defensive)',
    computeRw(flat, ISO_THIRD_OCTAVE_HZ) === null);
}
{
  // Non-array input returns null.
  check('non-array tl returns null',
    computeRw(null, ISO_THIRD_OCTAVE_HZ) === null);
  check('non-array freqs returns null',
    computeRw([50, 50], null) === null);
}

// =============================================================================
console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
