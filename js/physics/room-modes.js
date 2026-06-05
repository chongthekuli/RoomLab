// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE).

// Rigid-wall room eigenmodes for a rectangular (shoebox) room — the wave-
// acoustic model that governs the sound field BELOW the Schroeder frequency,
// where the statistical Hopkins-Stryker model is invalid.
//
// Moved here from js/audio/room-modes.js (2026-06-05): the modal math is pure
// physics and is now shared by BOTH the walk-mode auralization (biquad bank in
// audio/room-modes.js) AND the low-frequency heatmap modal field
// (js/physics/modal-field.js). Keeping it under js/physics/ honours the
// nymphysics "pure, Node-testable, no outbound imports" invariant.
//
// Theory (Kuttruff, Room Acoustics 6th ed §3.2; Morse & Ingard §9.4;
// Mechel, Formulas of Acoustics §M.5):
//
//   Eigenfrequencies of a rigid-wall box Lx × Ly × Lz:
//     f(nx,ny,nz) = (c/2)·√((nx/Lx)² + (ny/Ly)² + (nz/Lz)²)
//   for non-negative integers (nx,ny,nz) excluding (0,0,0).
//
//   Pressure mode shape (= ±1 at every wall, hence antinodes at the corners):
//     ψ(x,y,z) = cos(nx·π·x/Lx)·cos(ny·π·y/Ly)·cos(nz·π·z/Lz)
//
//   Modal damping from broadband T60 (Schroeder 1962):
//     Q ≈ π·f·T60 / ln(10³) = π·f·T60 / 6.908

const SPEED_OF_SOUND_M_PER_S = 343.2;
const MAX_MODE_INDEX = 8;            // raised from 5 (heatmap needs modes up to ~1.5·f_s reliably)
const MAX_MODE_GAIN_DB = 4;          // perceptual cap (audio bank); +∞ would ring forever
const MAX_FILTERS = 16;              // CPU budget for the audio biquad bank

// Q from T60, capped to keep Float32 biquads / the modal denominator well
// behaved. Shared by the audio bank and the heatmap field so both agree.
export function modalQ(freq_hz, t60_s) {
  if (!(freq_hz > 0) || !(t60_s > 0)) return 0;
  return Math.min(30, (Math.PI * freq_hz * t60_s) / Math.log(1000));
}

// Pressure mode shape ψ at a point (state coords; x=width, y=depth, z=height).
export function modeShape(nx, ny, nz, x, y, z, Lx, Ly, Lz) {
  return Math.cos((nx * Math.PI * x) / Lx)
       * Math.cos((ny * Math.PI * y) / Ly)
       * Math.cos((nz * Math.PI * z) / Lz);
}

// Enumerate every eigenmode up to `cutoffHz` (no source/receiver coupling
// filter — the heatmap evaluates ψ per cell). Returns
//   [{ nx, ny, nz, freq, Q }]
// sorted ascending by frequency. Used by the modal heatmap field.
export function enumerateRoomModes({ width_m, depth_m, height_m, t60_s, cutoffHz }) {
  if (!(width_m > 0) || !(depth_m > 0) || !(height_m > 0)) return [];
  if (!(t60_s > 0) || !(cutoffHz > 0)) return [];
  const out = [];
  for (let nx = 0; nx <= MAX_MODE_INDEX; nx++) {
    for (let ny = 0; ny <= MAX_MODE_INDEX; ny++) {
      for (let nz = 0; nz <= MAX_MODE_INDEX; nz++) {
        if (nx === 0 && ny === 0 && nz === 0) continue;
        const fx = nx / width_m, fy = ny / depth_m, fz = nz / height_m;
        const f = (SPEED_OF_SOUND_M_PER_S / 2) * Math.sqrt(fx * fx + fy * fy + fz * fz);
        if (f > cutoffHz) continue;
        out.push({ nx, ny, nz, freq: f, Q: modalQ(f, t60_s) });
      }
    }
  }
  out.sort((a, b) => a.freq - b.freq);
  return out;
}

// Modes to synthesise for the audio biquad bank at ONE listener position.
// Returns [{ freq, Q, gainDb, coupling, nx, ny, nz }] sorted by descending
// |coupling|, capped at MAX_FILTERS. (Behaviour preserved from the original
// audio/room-modes.js — the audition chain depends on this exact shape.)
export function computeRectangularModes({
  width_m, depth_m, height_m, sourcePos, listenerPos,
  t60_s, schroederHz, roomVolume_m3,
}) {
  if (!Number.isFinite(width_m) || !Number.isFinite(depth_m) || !Number.isFinite(height_m)) return [];
  if (width_m <= 0 || depth_m <= 0 || height_m <= 0) return [];
  if (!sourcePos || !listenerPos) return [];
  if (!(t60_s > 0)) return [];
  const cutoffHz = Math.max(60, Math.min(400, schroederHz * 1.5));
  const modes = [];
  for (let nx = 0; nx <= MAX_MODE_INDEX; nx++) {
    for (let ny = 0; ny <= MAX_MODE_INDEX; ny++) {
      for (let nz = 0; nz <= MAX_MODE_INDEX; nz++) {
        if (nx === 0 && ny === 0 && nz === 0) continue;
        const fx = nx / width_m, fy = ny / depth_m, fz = nz / height_m;
        const f = (SPEED_OF_SOUND_M_PER_S / 2) * Math.sqrt(fx * fx + fy * fy + fz * fz);
        if (f > cutoffHz) continue;
        const psi_s = modeShape(nx, ny, nz, sourcePos.x, sourcePos.y, sourcePos.z, width_m, depth_m, height_m);
        const psi_r = modeShape(nx, ny, nz, listenerPos.x, listenerPos.y, listenerPos.z, width_m, depth_m, height_m);
        const coupling = Math.abs(psi_s * psi_r);
        if (coupling < 0.05) continue;
        const Q = modalQ(f, t60_s);
        const gainDb = MAX_MODE_GAIN_DB * coupling;
        modes.push({ freq: f, Q, gainDb, coupling, nx, ny, nz });
      }
    }
  }
  modes.sort((a, b) => b.coupling - a.coupling);
  return modes.slice(0, MAX_FILTERS);
}
