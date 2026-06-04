// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Chong Ching Yong (chongthekuli). All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// js/physics/wall-rating.js
//
// ISO 717-1:2020 single-number ratings (Rw + Ctr + C) and ASTM E413-22
// (STC). Pure module — no DOM, no Three.js, no catalogue imports. Caller
// passes the 1/3-octave TL vector and the matching band-frequency vector.
//
// Phase 5 Step 2 (Dr. Chen spec + sign-off 2026-05-23). Reference contours
// and spectrum-adaptation curves are baked as frozen constants; transcription
// drift on a constant is exactly the bug ISO 717-1:2020 Annex A's worked
// example exists to catch, so the tests pin a sum-hash on every array.
//
// Why this module exists separately from `wall-tl.js`: the rating algorithm
// is purely contour-fit arithmetic — independent of HOW the per-band TL was
// produced (mass law, double-leaf Sharp, measured catalogue, composite
// τ-bar). Keeping the rating pure lets Step 4 (double-leaf) and Step 5
// (composite) feed straight through without coupling.
//
// ---------------------------------------------------------------------------
// Algorithm summary (Dr. Chen sign-off 2026-05-23)
// ---------------------------------------------------------------------------
//
//   1. Slide the reference contour up/down in 1 dB integer steps.
//   2. For each 1/3-oct band, the UNFAVOURABLE deviation =
//      max(0, shifted_contour − measured_R). Favourable deviations (where
//      R > contour) contribute 0 to the sum.
//   3. Find the LARGEST integer shift such that:
//        Rw:   Σ_unfav ≤ 32.0 dB. (Single-band rule REMOVED in ISO 717-1:2013
//              revision; sum is the sole criterion.)
//        STC:  Σ_unfav ≤ 32.0 dB AND single-band unfav ≤ 8 dB.
//   4. Rating = value of shifted reference contour AT 500 Hz.
//      Rw at 500 Hz reference = 52 dB; STC at 500 Hz reference = 0 dB
//      (STC's contour is stated as deviations from 500 Hz, so the shift IS
//      the STC value).
//
// Boundary (Dr. Chen sign-off): Σ = 32.0 exactly is ACCEPTED. ISO 717-1:2020
// §3.2 reads "shall not be greater than 32.0 dB", i.e. ≤ 32.0. Same wording
// in ASTM E413-22 §5.3.1. Compare with `≤ 32.0 + 1e-9` to dodge float noise.
//
// ---------------------------------------------------------------------------
// Spectrum adaptation terms (Ctr / C)
// ---------------------------------------------------------------------------
//
//   Ctr = -10·log10(Σ 10^((L_i,traffic − R_i)/10)) − Rw    (ISO 717-1 Table 2 col 3)
//   C   = -10·log10(Σ 10^((L_i,pinkA  − R_i)/10)) − Rw    (ISO 717-1 Table 2 col 2)
//
// Both spectra are evaluated over the Rw band range (100–3150 Hz, 16 bands).
// Display convention per ISO 717-1 §5: `Rw (C; Ctr) = 52 (-2; -7)`.

import { ISO_RW_BANDS_HZ, ISO_STC_BANDS_HZ } from './third-octave-bands.js';

// =============================================================================
// Reference contours — Object.freeze prevents accidental mutation by callers.
// Sum-hash tests in the regression suite catch transcription drift.
// =============================================================================

// ISO 717-1:2020 Table 1 — airborne sound reference values, 100–3150 Hz.
//   Rising +3 dB/oct equivalent below 500 Hz; +1 dB/oct from 500 Hz – 1 kHz;
//   flat at 56 dB from 1.25 kHz – 3.15 kHz.
//   Sum = 788 dB.
export const ISO_717_1_RW_CONTOUR_DB = Object.freeze([
  33, 36, 39, 42, 45, 48, 51, 52,
  53, 54, 55, 56, 56, 56, 56, 56,
]);

// ASTM E413-22 Table 1 — STC reference values, 125–4000 Hz. Stated as
// DEVIATIONS FROM 500 Hz so the shift IS the STC numerical value.
//   Sum = -21 dB.
export const ASTM_E413_STC_CONTOUR_DB = Object.freeze([
  -16, -13, -10, -7, -4, -1, 0, 1,
  2, 3, 4, 4, 4, 4, 4, 4,
]);

// ISO 717-1:2020 Table 2 column 2 — A-weighted pink-noise spectrum (for C).
//   Sum = -241 dB.
export const ISO_717_1_C_SPECTRUM_DB = Object.freeze([
  -29, -26, -23, -21, -19, -17, -15, -13,
  -12, -11, -10, -9, -9, -9, -9, -9,
]);

// ISO 717-1:2020 Table 2 column 3 — traffic-noise spectrum (for Ctr).
//   Weighted toward low frequencies (busy road / rail).
//   Sum = -214 dB.
export const ISO_717_1_CTR_SPECTRUM_DB = Object.freeze([
  -20, -20, -18, -16, -15, -14, -13, -12,
  -11, -9, -8, -9, -10, -11, -13, -15,
]);

// =============================================================================
// Algorithm constants
// =============================================================================

const RW_SUM_LIMIT_DB = 32.0;
const STC_SUM_LIMIT_DB = 32.0;
const STC_SINGLE_LIMIT_DB = 8;
const FLOAT_EPS = 1e-9;
const RW_500HZ_VALUE = 52;             // ISO_717_1_RW_CONTOUR_DB[indexOf 500] = 52
const STC_500HZ_VALUE = 0;             // ASTM E413 stated as deviations from 500

// Search bounds for the integer-shift loop. Bracketed conservatively so the
// contour-fit terminates even on extreme R values.
const SHIFT_MARGIN_DB = 80;

// =============================================================================
// Helpers
// =============================================================================

// Slice a TL vector to align with a target reference-band list. Returns null
// on any mismatch (missing band, length mismatch, non-array input). Defensive
// because catalogue rows may carry partial 1/3-oct data during Step 7 (Lin's
// catalogue seeding).
function alignToRefBands(tl_third_oct, freqs_third_oct, refBands) {
  if (!Array.isArray(tl_third_oct) || !Array.isArray(freqs_third_oct)) return null;
  if (tl_third_oct.length !== freqs_third_oct.length) return null;
  const out = new Array(refBands.length);
  for (let i = 0; i < refBands.length; i++) {
    const idx = freqs_third_oct.indexOf(refBands[i]);
    if (idx < 0) return null;
    if (!Number.isFinite(tl_third_oct[idx])) return null;
    out[i] = tl_third_oct[idx];
  }
  return out;
}

// Find the largest integer shift such that
//   Σ max(0, contour[i] + shift − measured_R[i]) ≤ sumLimit
//   AND max max(0, ...) ≤ singleLimit (when singleLimit is finite)
//
// Returns the shift (integer), or `null` if no shift in the search range
// satisfies the constraints (which should never happen for any realistic
// input — the search bounds bracket every band by ±80 dB).
function shiftContourToFit(measured_R, contour_values, sumLimit, singleLimit = Infinity) {
  if (measured_R.length !== contour_values.length) return null;
  // Conservative search bounds: high enough to overshoot every band, low
  // enough to undershoot every band. ISO 717-1 §3.2 specifies INTEGER 1 dB
  // shift steps, so round the bounds to integers — without this, non-integer
  // measured_R values (e.g. formula output rather than measured catalogue
  // rows) produce non-integer shifts and the returned Rw drifts off-grid.
  const maxR = Math.max(...measured_R);
  const minR = Math.min(...measured_R);
  const minC = Math.min(...contour_values);
  const maxC = Math.max(...contour_values);
  const shiftHi = Math.ceil(maxR - minC + SHIFT_MARGIN_DB);
  const shiftLo = Math.floor(minR - maxC - SHIFT_MARGIN_DB);
  for (let s = shiftHi; s >= shiftLo; s--) {
    let sum = 0;
    let maxUnfav = 0;
    for (let i = 0; i < measured_R.length; i++) {
      const unfav = Math.max(0, contour_values[i] + s - measured_R[i]);
      sum += unfav;
      if (unfav > maxUnfav) maxUnfav = unfav;
    }
    if (sum <= sumLimit + FLOAT_EPS && maxUnfav <= singleLimit + FLOAT_EPS) {
      return s;
    }
  }
  return null;
}

// =============================================================================
// Public API
// =============================================================================

// ISO 717-1:2020 Rw — weighted sound reduction index. Evaluates over the
// 16-band 100–3150 Hz range. Returns an integer dB value, or `null` if the
// input vector doesn't cover the Rw bands.
export function computeRw(tl_third_oct, freqs_third_oct) {
  const aligned = alignToRefBands(tl_third_oct, freqs_third_oct, ISO_RW_BANDS_HZ);
  if (!aligned) return null;
  const shift = shiftContourToFit(aligned, ISO_717_1_RW_CONTOUR_DB, RW_SUM_LIMIT_DB);
  return shift === null ? null : RW_500HZ_VALUE + shift;
}

// ASTM E413-22 STC — Sound Transmission Class. Evaluates over the 16-band
// 125–4000 Hz range; applies BOTH the sum ≤ 32 dB AND single-band ≤ 8 dB
// rules. The single-band rule is what makes STC diverge from Rw on walls
// with a deep narrow dip (typical double-leaf mass-air-mass resonance).
export function computeSTC(tl_third_oct, freqs_third_oct) {
  const aligned = alignToRefBands(tl_third_oct, freqs_third_oct, ISO_STC_BANDS_HZ);
  if (!aligned) return null;
  const shift = shiftContourToFit(
    aligned, ASTM_E413_STC_CONTOUR_DB, STC_SUM_LIMIT_DB, STC_SINGLE_LIMIT_DB,
  );
  return shift === null ? null : STC_500HZ_VALUE + shift;
}

// ISO 717-1:2020 C — spectrum adaptation term for A-weighted pink noise.
// Negative values indicate the wall under-performs vs reference on this
// spectrum; positive indicate over-performance. Typical concrete partitions
// land around C = -1 to -3 dB.
export function computeC(tl_third_oct, freqs_third_oct) {
  return spectrumAdaptation(tl_third_oct, freqs_third_oct, ISO_717_1_C_SPECTRUM_DB);
}

// ISO 717-1:2020 Ctr — spectrum adaptation term for traffic noise. Penalises
// walls that under-isolate at low frequencies (where traffic energy lives).
// Typical lightweight partitions: Ctr = -5 to -12 dB.
export function computeCtr(tl_third_oct, freqs_third_oct) {
  return spectrumAdaptation(tl_third_oct, freqs_third_oct, ISO_717_1_CTR_SPECTRUM_DB);
}

// Shared C / Ctr implementation. Term = -10·log10(Σ 10^((L_i − R_i)/10)) − Rw.
function spectrumAdaptation(tl_third_oct, freqs_third_oct, spectrum_db) {
  const Rw = computeRw(tl_third_oct, freqs_third_oct);
  if (Rw === null) return null;
  const aligned = alignToRefBands(tl_third_oct, freqs_third_oct, ISO_RW_BANDS_HZ);
  if (!aligned) return null;
  let sumEnergy = 0;
  for (let i = 0; i < spectrum_db.length; i++) {
    sumEnergy += Math.pow(10, (spectrum_db[i] - aligned[i]) / 10);
  }
  if (!(sumEnergy > 0)) return null;
  return Math.round(-10 * Math.log10(sumEnergy) - Rw);
}

// Test-only export so the regression test can exercise the contour-fit
// helper directly (used by the boundary-acceptance fixture for Σ = 32.0).
export const _testing = { shiftContourToFit, alignToRefBands };
