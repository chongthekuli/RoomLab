// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE).

// Low-frequency modal sound field for the heatmap (Dr. Lena Chen spec,
// 2026-06-05). BELOW the Schroeder frequency a room is not diffuse — it is a
// sparse sum of standing-wave modes with pressure maxima at the walls/corners
// and nulls between. The statistical Hopkins-Stryker model the heatmap uses
// above f_s cannot express that spatial structure, so at 125/250 Hz in a small
// room it shows a flat distance gradient that is physically wrong.
//
// This module computes the analytic rigid-wall modal field (Kuttruff §3.2;
// Morse & Ingard §9.4) and a crossfade weight so the heatmap can blend:
//
//   below ~0.5·f_s : pure modal (hot walls/corners, nulls between)
//   ~0.5·f_s .. ~1.5·f_s : crossfade modal → statistical
//   above ~1.5·f_s : pure statistical (existing path, untouched)
//
// Steady-state modal pressure-squared at a receiver, driven by point sources:
//
//   |p(r)|² ∝ Σ_m  exc_m · ψ_m(r)²  /  [ (f² − f_m²)² + (f·f_m/Q_m)² ]
//
// where exc_m = Σ_sources P_i · ψ_m(r_src_i)²  (incoherent source energy sum)
// and ψ_m = cos(nx πx/Lx)·cos(ny πy/Ly)·cos(nz πz/Lz).
//
// HONESTY BOUNDARIES (disclosed; tracked P3/P4):
//   • Rigid walls — the cos shapes assume zero-admittance boundaries. Finite-
//     impedance walls shift f_m slightly and soften the antinodes; in dead
//     rooms (α̅ > ~0.3) the rigid-wall shape over-states boundary contrast a
//     few dB. Q is driven by the real T60 so most damping is captured.
//   • One broadband T60 → one Q per mode (mode-independent damping shortcut).
//   • Rectangular rooms ONLY — no closed-form modes for polygon/round/custom;
//     those fall back to the statistical model + the disclosure caption.
//   • Incoherent source energy sum (modal phase between sources not modelled).
//   • Steady-state magnitude, not a transient/decay field.
//
// Pure / Node-testable. Imports only sibling physics (room-modes, schroeder).

import { enumerateRoomModes, modeShape } from './room-modes.js';

// Modal regime extends to ~1.5·f_s (mode overlap completes around there).
const CUTOFF_FACTOR = 1.5;

/**
 * Crossfade weight for the modal contribution at a frequency.
 *   w = 1 for freq ≤ 0.5·f_s   (deep modal regime)
 *   w = 0 for freq ≥ 1.5·f_s   (statistical regime)
 *   smooth raised-cosine between.
 * Returns 0 when f_s is non-physical (→ heatmap stays purely statistical).
 */
export function crossfadeWeight(freq_hz, f_s) {
  if (!(f_s > 0) || !(freq_hz > 0)) return 0;
  const lo = 0.5 * f_s, hi = CUTOFF_FACTOR * f_s;
  if (freq_hz <= lo) return 1;
  if (freq_hz >= hi) return 0;
  const t = (freq_hz - lo) / (hi - lo);       // 0 at lo, 1 at hi
  return 0.5 * (1 + Math.cos(Math.PI * t));    // 1 → 0 raised cosine
}

/**
 * Band-aware low-frequency disclosure caption for the heatmap legend.
 * Returns '' when the band is at/above the Schroeder frequency (statistical
 * model valid) or f_s is unknown. Below f_s:
 *   • modalApplied → the modal field IS shown (rectangular room): note it.
 *   • else (non-rectangular / reverb off) → disclose it's a statistical
 *     estimate that doesn't resolve the standing-wave structure.
 *
 * @param {{ freq_hz:number, schroeder_hz:number|null, modalApplied:boolean }} o
 * @returns {string}
 */
export function lowFreqCaption({ freq_hz, schroeder_hz, modalApplied }) {
  if (!(schroeder_hz > 0) || !(freq_hz > 0) || freq_hz >= schroeder_hz) return '';
  const fs = Math.round(schroeder_hz);
  return modalApplied
    ? `Modal field — bass builds at walls & corners (below ~${fs} Hz Schroeder)`
    : `Below ~${fs} Hz (Schroeder): statistical estimate — standing waves at walls/corners not resolved`;
}

/**
 * Compute the relative modal pressure-squared field over a set of cells.
 *
 * @param {object}   room         must be shape 'rectangular' with width_m/depth_m/height_m
 * @param {Array}    sources      [{ x, y, z, weight }] — weight = linear power (default 1)
 * @param {number}   freq_hz      band centre
 * @param {number}   t60_s        per-band (or broadband) T60 → modal Q
 * @param {number}   f_s          Schroeder frequency (Hz)
 * @param {Array}    cells        [{ x, y }] receiver positions (state coords)
 * @param {number}   earZ         receiver height (m)
 * @returns {{ p2: Float64Array, weight: number, modeCount: number } | null}
 *          null when not applicable (non-rectangular, above cutoff, no modes,
 *          or crossfade weight 0) — caller keeps the pure statistical field.
 */
export function computeModalField({ room, sources, freq_hz, t60_s, f_s, cells, earZ }) {
  if (!room || room.shape !== 'rectangular') return null;
  const Lx = Number(room.width_m), Ly = Number(room.depth_m), Lz = Number(room.height_m);
  if (!(Lx > 0) || !(Ly > 0) || !(Lz > 0)) return null;
  if (!(f_s > 0) || !(t60_s > 0)) return null;
  if (!Array.isArray(cells) || cells.length === 0) return null;
  const weight = crossfadeWeight(freq_hz, f_s);
  if (weight <= 0) return null;                       // above the modal regime

  const cutoffHz = CUTOFF_FACTOR * f_s;
  const modes = enumerateRoomModes({ width_m: Lx, depth_m: Ly, height_m: Lz, t60_s, cutoffHz });
  if (modes.length === 0) return null;

  const srcs = (Array.isArray(sources) ? sources : []).filter(s => s && Number.isFinite(s.x));
  if (srcs.length === 0) return null;

  // Per-mode excitation + denominator (constant across cells) + the CLOSED-FORM
  // volume-mean weight 2^(−p_m), where p_m = number of non-zero mode indices
  // (axial=1, tangential=2, oblique=3). The volume mean of ψ_m² over a rigid-
  // wall box is exactly 1/2^(p_m) because ∫cos²(nπx/L)dx = L/2 for n≥1 (L for
  // n=0). Cross-modal terms integrate to zero (orthogonality), so the mean of
  // the whole relative field is Σ exc·invDenom·2^(−p). This analytic mean is
  // the CORRECT normalisation anchor (Dr. Chen 2026-06-05) — it cancels the
  // mode-truncation deficit exactly and is grid-resolution-independent, unlike
  // a mean taken over sampled cells.
  const f2 = freq_hz * freq_hz;
  const exc = new Float64Array(modes.length);
  const invDenom = new Float64Array(modes.length);
  const meanW = new Float64Array(modes.length);   // 2^(−p_m)
  for (let m = 0; m < modes.length; m++) {
    const { nx, ny, nz, freq: fm, Q } = modes[m];
    let e = 0;
    for (const s of srcs) {
      const ps = modeShape(nx, ny, nz, s.x, s.y, s.z ?? earZ, Lx, Ly, Lz);
      const w = Number.isFinite(s.weight) && s.weight > 0 ? s.weight : 1;
      e += w * ps * ps;
    }
    exc[m] = e;
    const denom = (f2 - fm * fm) * (f2 - fm * fm) + (freq_hz * fm / (Q || 1)) * (freq_hz * fm / (Q || 1));
    invDenom[m] = denom > 0 ? 1 / denom : 0;
    const p = (nx !== 0 ? 1 : 0) + (ny !== 0 ? 1 : 0) + (nz !== 0 ? 1 : 0);
    meanW[m] = Math.pow(2, -p);
  }

  // Analytic volume-mean of the relative field (the normalisation anchor).
  let analyticMean = 0;
  for (let m = 0; m < modes.length; m++) analyticMean += exc[m] * invDenom[m] * meanW[m];

  const p2 = new Float64Array(cells.length);
  for (let c = 0; c < cells.length; c++) {
    const cx = cells[c].x, cy = cells[c].y;
    let sum = 0;
    for (let m = 0; m < modes.length; m++) {
      if (exc[m] === 0 || invDenom[m] === 0) continue;
      const { nx, ny, nz } = modes[m];
      const pr = modeShape(nx, ny, nz, cx, cy, earZ, Lx, Ly, Lz);
      sum += exc[m] * pr * pr * invDenom[m];
    }
    p2[c] = sum;
  }
  return { p2, weight, modeCount: modes.length, analyticMean };
}

/**
 * Blend a relative modal field into the baseline (statistical) per-cell SPL.
 *
 * The modal field gives a relative SPATIAL pattern only; we normalise its
 * energy spatial-mean to the baseline's energy spatial-mean (over the FINITE
 * baseline cells) so the modal model only REDISTRIBUTES energy (hot walls /
 * cold nulls) without shifting the band's average level — energy conservation
 * across the crossfade. Then per cell:
 *
 *   L_final = 10·log10( (1−w)·E_base + w·E_modal_normalised )
 *
 * @param {Float32Array|number[]} baselineDb  per-cell SPL (dB); -Infinity = no-data
 * @param {{p2:Float64Array, weight:number}} modal  from computeModalField
 * @returns {Float32Array} new per-cell SPL (dB); untouched where modal is null
 */
export function blendModalIntoBaseline(baselineDb, modal) {
  const out = Float32Array.from(baselineDb);
  if (!modal || !(modal.weight > 0)) return out;
  const { p2, weight: w } = modal;
  const n = out.length;
  if (p2.length !== n) return out;            // shape mismatch — leave baseline

  // Baseline (statistical) energy mean over finite cells — the statistical
  // field is ~spatially flat so its grid-cell mean ≈ its true mean to <0.1 dB
  // regardless of resolution.
  let baseEnergySum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(out[i])) continue;
    baseEnergySum += Math.pow(10, out[i] / 10);
    count++;
  }
  // Modal mean is the CLOSED-FORM analytic volume-mean (grid-independent,
  // truncation-cancelling) — NOT a mean over sampled cells, which excludes the
  // -Infinity wall-annulus cells and so dropped the hottest near-wall
  // antinodes, biasing the LF heatmap ~1-2 dB high (Dr. Chen 2026-06-05).
  const modalMean = modal.analyticMean;
  if (count === 0 || !(modalMean > 0)) return out;
  const baseMean = baseEnergySum / count;
  const scale = baseMean / modalMean;          // normalise modal mean → baseline mean

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(out[i])) continue;
    const eBase = Math.pow(10, out[i] / 10);
    const eModal = p2[i] * scale;
    const blended = (1 - w) * eBase + w * eModal;
    out[i] = blended > 0 ? 10 * Math.log10(blended) : -Infinity;
  }
  return out;
}
