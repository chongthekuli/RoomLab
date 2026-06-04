// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Chong Ching Yong (chongthekuli). All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// Rack direct-path blocking helper (v=700, 2026-05-27).
//
// User UAT: "when i put the rack in front speaker, the heatmap doesnt
// change, by right the sound got disturbed by the rack."
//
// Mirrors js/physics/furniture-direct-blocking.js but for placed racks.
// Each rack contributes ONE axis-aligned bounding box (outer footprint
// × outer height); a barrier μ = 8 Np/m is applied to the segment
// length passing through the bbox. Rotation (rack.yaw_deg) is folded
// in by transforming the source→listener segment into the rack's local
// frame, then doing the slab-method intersection against the
// axis-aligned bounds.
//
// Why a single bbox + flat barrier μ (and not per-face Helmholtz-
// resonator math): the direct-path attenuation model is intentionally
// pessimistic for "solid obstacles" — a 600 × 1000 mm enclosed rack
// blocks ~30+ dB of direct field at 1 kHz across its profile, which
// matches the user's intuition ("disturbed"). A more detailed per-
// face split (mesh-glass front softer than steel side) is a P2
// refinement once we have a real measurement vs the model.
//
// Pure / Node-testable. No DOM, no Three.js.

const BARRIER_MU = 8;                              // Np/m, same as reflective furniture
const NEPER_TO_DB = 4.342944819032518;

/**
 * Per-band direct-path TL from placed racks between two world-frame
 * points. Returns a Float32Array(bands_hz.length) of TL in dB, all
 * zeros when no rack intersects the segment.
 *
 * @param {{x:number,y:number,z:number}} srcPos
 * @param {{x:number,y:number,z:number}} listenerPos
 * @param {Array}  racks                            state.rackSystem.racks
 * @param {object} rackCatalogue                    raw JSON or Map
 * @param {number[]} bands_hz                       [125, 250, ..., 8000]
 * @returns {Float32Array}
 */
export function rackDirectPathLossPerBand(srcPos, listenerPos, racks, rackCatalogue, bands_hz) {
  const B = bands_hz?.length ?? 7;
  const result = new Float32Array(B);
  if (!Array.isArray(racks) || racks.length === 0) return result;
  if (!rackCatalogue) return result;
  if (!srcPos || !listenerPos) return result;

  const p0x = srcPos.x, p0y = srcPos.y, p0z = srcPos.z ?? 0;
  const p1x = listenerPos.x, p1y = listenerPos.y, p1z = listenerPos.z ?? 0;
  const dx = p1x - p0x, dy = p1y - p0y, dz = p1z - p0z;
  const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (segLen < 1e-9) return result;

  const lookup = typeof rackCatalogue.get === 'function'
    ? (k) => rackCatalogue.get(k)
    : (k) => rackCatalogue.racks?.[k] ?? null;
  const EPS = 1e-6;

  let totalNp = 0;
  for (const rack of racks) {
    if (!rack?.position || typeof rack.rackModelKey !== 'string') continue;
    const def = lookup(rack.rackModelKey);
    if (!def) continue;
    const w_m = (Number(def.outer_w_mm) || 600) / 1000;
    const d_m = (Number(def.outer_d_mm) || 600) / 1000;
    const h_m = (Number(def.outer_h_mm) || 1000) / 1000;
    const halfW = w_m / 2;
    const halfD = d_m / 2;
    const fcx = rack.position.x;
    const fcy = rack.position.y;

    // Transform segment into the rack's local frame (rotated about
    // state-Z by yaw_deg around the rack centre).
    const rot_rad = (Number(rack.yaw_deg) || 0) * Math.PI / 180;
    const c = Math.cos(rot_rad), s = Math.sin(rot_rad);
    // World→local: subtract (fcx, fcy), rotate by -rot_rad.
    const lpx0 = (p0x - fcx) * c + (p0y - fcy) * s;
    const lpy0 = -(p0x - fcx) * s + (p0y - fcy) * c;
    const lpx1 = (p1x - fcx) * c + (p1y - fcy) * s;
    const lpy1 = -(p1x - fcx) * s + (p1y - fcy) * c;
    const ldx = lpx1 - lpx0;
    const ldy = lpy1 - lpy0;
    const ldz = dz;                                // z is unaffected by yaw

    const invx = 1 / (Math.abs(ldx) > EPS ? ldx : (ldx >= 0 ? EPS : -EPS));
    const invy = 1 / (Math.abs(ldy) > EPS ? ldy : (ldy >= 0 ? EPS : -EPS));
    const invz = 1 / (Math.abs(ldz) > EPS ? ldz : (ldz >= 0 ? EPS : -EPS));

    // Slab-method: t is a fraction of the WORLD segment length, since
    // both world and local segments share the same parametric length
    // (rotation preserves distance).
    let t1 = (-halfW - lpx0) * invx;
    let t2 = (+halfW - lpx0) * invx;
    let tEnter = Math.min(t1, t2);
    let tExit  = Math.max(t1, t2);
    t1 = (-halfD - lpy0) * invy;
    t2 = (+halfD - lpy0) * invy;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit  = Math.min(tExit,  Math.max(t1, t2));
    t1 = (0     - p0z)  * invz;
    t2 = (h_m   - p0z)  * invz;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit  = Math.min(tExit,  Math.max(t1, t2));
    if (tEnter < 0) tEnter = 0;
    if (tExit > 1) tExit = 1;
    if (tExit <= tEnter) continue;
    const L_in = (tExit - tEnter) * segLen;
    totalNp += BARRIER_MU * L_in;
  }
  if (totalNp <= 0) return result;
  const lossDb = NEPER_TO_DB * totalNp;
  for (let k = 0; k < B; k++) result[k] = lossDb;
  return result;
}

/**
 * Scalar shorthand for callers that just want the loss at one frequency.
 */
export function rackDirectPathLossDb(srcPos, listenerPos, racks, rackCatalogue, bands_hz, freq_hz) {
  if (!Array.isArray(bands_hz) || bands_hz.length === 0) return 0;
  const perBand = rackDirectPathLossPerBand(srcPos, listenerPos, racks, rackCatalogue, bands_hz);
  let nearest = 0, bestD = Infinity;
  for (let k = 0; k < bands_hz.length; k++) {
    const d = Math.abs(bands_hz[k] - freq_hz);
    if (d < bestD) { bestD = d; nearest = k; }
  }
  return perBand[nearest] || 0;
}
