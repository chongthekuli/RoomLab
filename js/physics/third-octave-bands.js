// js/physics/third-octave-bands.js
//
// Third-octave frequency bands per ISO 266 and log-linear interpolation
// from the catalogue's octave-band TL/absorption data. Pure module — no
// DOM, no Three.js, no materials.json import (caller passes the numbers
// in). Node-testable.
//
// Phase 5 Step 1 (Dr. Chen spec, 2026-05-23). Needed because the ISO
// 717-1 single-number rating (Rw + Ctr + C) and ASTM E413 STC are
// computed against a 16-band 1/3-octave reference contour — the
// existing octave-band catalogue rows must be interpolated up to that
// resolution before the contour-shift algorithm runs.
//
// Convention (Bies & Hansen §6.4, ISO 266 R10 preferred series):
//   • 18-band master list covers 100 Hz – 5000 Hz, log-spaced by 2^(1/3).
//   • ISO 717-1 Rw uses the first 16 bands (100 – 3150 Hz).
//   • ASTM E413 STC uses bands 2–17 (125 – 4000 Hz).
//   • The master list is the union of both rating frequency ranges so
//     a single 1/3-oct vector can drive either rating without slicing.
//
// Interpolation policy: log-linear between adjacent octave-band centres.
// Below the lowest octave (125 Hz) the 100-Hz band edge-clamps to the
// 125-Hz value; above the highest (8 kHz) the 5-kHz band sits inside
// the 4 k → 8 k interval and interpolates normally. This is the same
// policy `airAbsorptionDbPerM` uses for sub-octave queries — match it
// so cross-module behaviour stays predictable.

// 1/3-octave preferred centre frequencies, ISO 266 R10 series, 100 – 5000 Hz.
// Eighteen bands — covers both the Rw contour range (100–3150) and the
// STC contour range (125–4000) so a single Float64Array drives both.
export const ISO_THIRD_OCTAVE_HZ = Object.freeze([
  100, 125, 160, 200, 250, 315, 400, 500,
  630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000,
]);

// ISO 717-1:2020 §3.1 — Rw reference contour evaluation range.
export const ISO_RW_BANDS_HZ = Object.freeze([
  100, 125, 160, 200, 250, 315, 400, 500,
  630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
]);

// ASTM E413-22 §5 — STC reference contour evaluation range.
export const ISO_STC_BANDS_HZ = Object.freeze([
  125, 160, 200, 250, 315, 400, 500, 630,
  800, 1000, 1250, 1600, 2000, 2500, 3150, 4000,
]);

// The catalogue's octave-band centre list (data/materials.json
// `frequency_bands_hz`). Re-exported here so callers don't have to
// repeat the literal — single source of truth for "what octave bands
// the materials catalogue carries."
export const CATALOGUE_OCTAVE_BANDS_HZ = Object.freeze([
  125, 250, 500, 1000, 2000, 4000, 8000,
]);

// Log-linear interpolation between two octave centres. Used for every
// 1/3-oct band that falls strictly between two octaves; edge cases
// handled by the caller.
function logLerp(f, f0, f1, v0, v1) {
  const t = Math.log(f / f0) / Math.log(f1 / f0);
  return v0 + t * (v1 - v0);
}

// Convert an octave-band vector to a 1/3-octave vector by log-linear
// interpolation between adjacent octave centres. Edge-clamp outside the
// octave range.
//
//   octave_values      — array of values at the octave centres (same length as octave_bands_hz).
//   octave_bands_hz    — octave centre frequencies (default = CATALOGUE_OCTAVE_BANDS_HZ).
//   third_octave_bands_hz — 1/3-octave centre frequencies to interpolate to (default = ISO_THIRD_OCTAVE_HZ).
//
// Returns a new array of values at the 1/3-octave centres.
//
// Guards:
//   • octave_values.length !== octave_bands_hz.length → return [].
//   • octave_bands_hz not strictly increasing → return [] (defensive; the
//     caller should always pass a sorted band list).
export function octaveToThirdOctave(
  octave_values,
  octave_bands_hz = CATALOGUE_OCTAVE_BANDS_HZ,
  third_octave_bands_hz = ISO_THIRD_OCTAVE_HZ,
) {
  if (!Array.isArray(octave_values) || !Array.isArray(octave_bands_hz)) return [];
  if (octave_values.length !== octave_bands_hz.length) return [];
  for (let i = 1; i < octave_bands_hz.length; i++) {
    if (!(octave_bands_hz[i] > octave_bands_hz[i - 1])) return [];
  }
  const fLow = octave_bands_hz[0];
  const fHigh = octave_bands_hz[octave_bands_hz.length - 1];
  const vLow = octave_values[0];
  const vHigh = octave_values[octave_values.length - 1];

  return third_octave_bands_hz.map((f3) => {
    if (f3 <= fLow) return vLow;
    if (f3 >= fHigh) return vHigh;
    // Find the bracketing octave centres.
    for (let i = 0; i < octave_bands_hz.length - 1; i++) {
      const f0 = octave_bands_hz[i];
      const f1 = octave_bands_hz[i + 1];
      if (f3 >= f0 && f3 <= f1) {
        // Exact-match short-circuit so doubled boundaries (e.g. 1000 Hz in
        // both lists) return the catalogue value exactly, no log-rounding.
        if (f3 === f0) return octave_values[i];
        if (f3 === f1) return octave_values[i + 1];
        return logLerp(f3, f0, f1, octave_values[i], octave_values[i + 1]);
      }
    }
    return vHigh;     // unreachable given the band-range guards above
  });
}
