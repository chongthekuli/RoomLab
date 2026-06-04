// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Chong Ching Yong (chongthekuli). All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// Furniture obstruction of the analytical direct ray (v=679, 2026-05-27).
//
// User UAT (v=678 push): placed a bookshelf + server rack directly in
// front of a speaker, expected the 2D SPL heatmap to show the shadow.
// It didn't — the live SPL calculator's wall-TL machinery
// (wall-path.js + spl-calculator.js pathWallLossDb) only checks
// room walls + treatments, not state.furniture. So the direct field
// at any grid cell stayed bright regardless of placed furniture.
//
// This helper closes that gap. For a source → listener direct ray, it
// queries each placed furniture item's sub-volumes (via the unified
// getSubVolumes layout module shipped in v=677) and accumulates a
// per-band transmission-loss budget based on which sub-volumes the
// ray crosses and how far it travels inside each:
//
//   • Porous sub-volume (chair cushion, audience block, mat) → use
//     the same Beer-Lambert sink μ_b = A_obj(b) / (4·V_bbox) the
//     precision tracer applies. Same physics; smaller-volume porous
//     items naturally cap at μ ~5 Np/m (the catalogue sanity ceiling).
//   • Reflective_main or frame sub-volume (table top, bookshelf,
//     server rack, chair legs/arms/back) → treat as a barrier
//     introducing ISO 9613-2 §7.4-style diffraction loss. We use a
//     flat μ = 8 Np/m for any "solid" reflective material, giving a
//     pathlength-aware insertion loss:
//       L_in = 0.1 m grazing leg     → −3.5 dB
//       L_in = 0.3 m typical shelf   → −10 dB
//       L_in = 1.0 m through rack    → −35 dB
//     Better than the alternatives:
//       — Flat-N-dB-per-crossing ignores the obstruction's depth.
//       — Pure Maekawa needs geometry (edge positions) we don't have
//         in the analytical model; pathlength-attenuation captures
//         the dominant behaviour cheaply.
//
// Pure / Node-testable. No DOM, no Three.js.

import { getSubVolumes } from './furniture-sub-volumes.js';

// Effective μ for "solid" reflective sub-volumes acting as direct-path
// barriers. Pathlength-aware: tiny obstructions = small loss, deep
// solid bodies = strong shadow.
const REFLECTIVE_BARRIER_MU = 8;   // Np/m

// 10/ln(10) — convert (μ·L) Nepers-of-attenuation to decibels.
const NEPER_TO_DB = 4.342944819032518;

/**
 * Per-band direct-path TL from furniture between two world-frame
 * points. Returns a Float32Array(bands_hz.length) of TL in dB,
 * filled with 0 when no furniture is between the points.
 *
 * @param {{x:number,y:number,z:number}} srcPos
 * @param {{x:number,y:number,z:number}} listenerPos
 * @param {Array} furniture                       state.furniture
 * @param {Map}   catalogue                       Map<id, row> from getFurnitureCatalogue()
 * @param {number[]} bands_hz                     [125, 250, ..., 8000]
 * @returns {Float32Array}
 */
export function furnitureDirectPathLossPerBand(srcPos, listenerPos, furniture, catalogue, bands_hz) {
  const B = bands_hz?.length ?? 7;
  const result = new Float32Array(B);
  if (!Array.isArray(furniture) || furniture.length === 0) return result;
  if (!catalogue || catalogue.size === 0) return result;
  if (!srcPos || !listenerPos) return result;

  const p0x = srcPos.x, p0y = srcPos.y, p0z = srcPos.z ?? 0;
  const p1x = listenerPos.x, p1y = listenerPos.y, p1z = listenerPos.z ?? 0;
  const dx = p1x - p0x, dy = p1y - p0y, dz = p1z - p0z;
  const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (segLen < 1e-9) return result;
  // Unit direction; segment length goes into the t-parameter range below.
  const ux = dx / segLen, uy = dy / segLen, uz = dz / segLen;
  // Slab-method inverses with sign-preserving epsilon (per bvh.js).
  const EPS = 1e-6;
  const invx = 1 / (Math.abs(ux) > EPS ? ux : (ux >= 0 ? EPS : -EPS));
  const invy = 1 / (Math.abs(uy) > EPS ? uy : (uy >= 0 ? EPS : -EPS));
  const invz = 1 / (Math.abs(uz) > EPS ? uz : (uz >= 0 ? EPS : -EPS));

  // Running per-band Nepers-of-attenuation accumulator.
  // Use a local Float32Array sized to BANDS; faster than result[k] += ...
  // inside the per-sub-volume loop because we convert once at the end.
  const np_per_band = new Float32Array(B);

  for (const f of furniture) {
    if (!f?.position || typeof f.catalogueId !== 'string') continue;
    const row = catalogue.get(f.catalogueId);
    if (!row?.footprint) continue;
    const cx = f.position.x, cy = f.position.y;
    const subs = getSubVolumes(row);
    if (!subs?.length) continue;

    const A_obj = row.acoustics?.A_obj_m2_sab_per_band;

    for (const sub of subs) {
      // World bounds.
      const bMinX = cx + sub.bounds[0];
      const bMinY = cy + sub.bounds[1];
      const bMinZ = sub.bounds[2];
      const bMaxX = cx + sub.bounds[3];
      const bMaxY = cy + sub.bounds[4];
      const bMaxZ = sub.bounds[5];

      // Slab-method intersection of segment [p0, p0 + segLen·u] with AABB.
      let t1 = (bMinX - p0x) * invx;
      let t2 = (bMaxX - p0x) * invx;
      let tEnter = Math.min(t1, t2);
      let tExit  = Math.max(t1, t2);
      t1 = (bMinY - p0y) * invy;
      t2 = (bMaxY - p0y) * invy;
      tEnter = Math.max(tEnter, Math.min(t1, t2));
      tExit  = Math.min(tExit,  Math.max(t1, t2));
      t1 = (bMinZ - p0z) * invz;
      t2 = (bMaxZ - p0z) * invz;
      tEnter = Math.max(tEnter, Math.min(t1, t2));
      tExit  = Math.min(tExit,  Math.max(t1, t2));
      // Clamp to [0, segLen].
      if (tEnter < 0) tEnter = 0;
      if (tExit > segLen) tExit = segLen;
      const L_in = tExit - tEnter;
      if (L_in <= 0) continue;

      if (sub.role === 'porous') {
        // μ_b = A_obj(b) / (4·V_box), same as the precision tracer
        // Beer-Lambert sink. V_box is the sub-volume's volume.
        const V = (bMaxX - bMinX) * (bMaxY - bMinY) * (bMaxZ - bMinZ);
        if (!(V > 0) || !A_obj) continue;
        for (let k = 0; k < B; k++) {
          const a = A_obj[String(Math.round(bands_hz[k]))];
          if (Number.isFinite(a) && a > 0) {
            const mu = Math.min(5, a / (4 * V));
            np_per_band[k] += mu * L_in;
          }
        }
      } else {
        // reflective_main or frame — barrier model, μ flat across bands.
        const mu_x_L = REFLECTIVE_BARRIER_MU * L_in;
        for (let k = 0; k < B; k++) np_per_band[k] += mu_x_L;
      }
    }
  }

  // Convert Σ μ·L (Nepers) → dB.
  for (let k = 0; k < B; k++) result[k] = NEPER_TO_DB * np_per_band[k];
  return result;
}

/**
 * Scalar shorthand: pick the band closest to freq_hz and return that
 * band's TL in dB. Avoids the caller having to thread the per-band
 * array through for single-band callers (computeDirectSPL).
 */
export function furnitureDirectPathLossDb(srcPos, listenerPos, furniture, catalogue, bands_hz, freq_hz) {
  if (!Array.isArray(bands_hz) || bands_hz.length === 0) return 0;
  const perBand = furnitureDirectPathLossPerBand(srcPos, listenerPos, furniture, catalogue, bands_hz);
  // Find nearest-band index for the caller's requested frequency.
  let nearest = 0, bestD = Infinity;
  for (let k = 0; k < bands_hz.length; k++) {
    const d = Math.abs(bands_hz[k] - freq_hz);
    if (d < bestD) { bestD = d; nearest = k; }
  }
  return perBand[nearest] || 0;
}
