// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE).

// Schroeder frequency — the boundary between the modal (wave) regime and the
// statistical (diffuse-field) regime of a room.
//
//   f_s = 2000 · √(T60 / V)        [Hz]   (Schroeder, JASA 1962)
//
// Below f_s the sound field is a sparse sum of discrete room modes (standing
// waves) with pressure maxima at the walls/corners and nulls between — the
// statistical Hopkins-Stryker model is NOT valid there. Above f_s modes
// overlap into a diffuse continuum and the statistical model holds.
//
// This was inlined in three+ places (panel-precision.js, print-report.js,
// audio/audition.js). Consolidated here so the heatmap modal field, the
// precision panel, the print report, and the auralization all agree on one
// definition. Pure; Node-testable.

/**
 * @param {number} t60_s        broadband (or per-band) reverberation time, seconds
 * @param {number} volume_m3    room volume, cubic metres
 * @returns {number|null}       f_s in Hz, or null when inputs are non-physical
 */
export function schroederFrequency(t60_s, volume_m3) {
  if (!(t60_s > 0) || !(volume_m3 > 0)) return null;
  return 2000 * Math.sqrt(t60_s / volume_m3);
}
