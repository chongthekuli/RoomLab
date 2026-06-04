// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// Walk-mode avatar collision against placed racks (v=699, 2026-05-27).
//
// User UAT: "now the avatar can walk through this rack."
//
// Each placed rack contributes ONE axis-aligned bounding box covering
// its outer footprint (outerW × outerD × acoustic-active height). The
// box is rotated about state-Z by rack.yaw_deg around the rack centre.
//
// This mirrors the furniture-walk-collision.js pattern (cylinder-vs-
// AABB in the item's local frame, transforming the avatar's centre
// into the rack's local frame so the box test is axis-aligned).
//
// Castor height is subtracted from the acoustic-active height so the
// rack body sits at z ∈ [castorH, castorH + bodyH]. The avatar
// cylinder spans [0, characterHeight] — castors are knee-height or
// lower so the body+wheel region is fully covered by the cylinder.
//
// Pure / Node-testable. No DOM, no Three.js.

/**
 * Return true if a vertical cylinder at state-frame position (sx, sy)
 * with radius `radius` and vertical span [yMin, yMax] (state z, ground
 * up) overlaps ANY placed rack's footprint AABB.
 *
 * @param {number} sx                       avatar centre, state x
 * @param {number} sy                       avatar centre, state y (depth)
 * @param {number} yMin                     bottom of cylinder, state z (m)
 * @param {number} yMax                     top of cylinder, state z (m)
 * @param {number} radius                   avatar collision radius (m)
 * @param {Array}  racks                    state.rackSystem.racks
 * @param {object} rackCatalogue            raw JSON {schema_version, racks: {key: def}}
 *                                          (sumRackAbsorption already
 *                                          accepts both shapes)
 * @returns {boolean}
 */
export function rackBlocksCylinder(sx, sy, yMin, yMax, radius, racks, rackCatalogue) {
  if (!Array.isArray(racks) || racks.length === 0) return false;
  if (!rackCatalogue || !(radius > 0)) return false;
  const r2 = radius * radius;
  // Accept either Map<key,def> OR the raw catalogue object {racks: {...}}.
  const lookup = typeof rackCatalogue.get === 'function'
    ? (k) => rackCatalogue.get(k)
    : (k) => rackCatalogue.racks?.[k] ?? null;
  for (const rack of racks) {
    if (!rack?.position || typeof rack.rackModelKey !== 'string') continue;
    const def = lookup(rack.rackModelKey);
    if (!def) continue;

    const fcx = rack.position.x;
    const fcy = rack.position.y;
    const w_m = (Number(def.outer_w_mm) || 600) / 1000;
    const d_m = (Number(def.outer_d_mm) || 600) / 1000;
    const outerH_mm = Number(def.outer_h_mm) || 1000;
    const castorH_mm = Number(def.castor_h_mm) || 0;
    const bodyTopZ = (outerH_mm) / 1000;        // include castor height — full bbox
    const bodyBottomZ = 0;                       // wheels touch the floor

    // Vertical overlap first (cheap reject).
    if (yMax < bodyBottomZ || yMin > bodyTopZ) continue;

    // Transform avatar centre into rack-local frame (rack.yaw_deg rotates
    // the rack about state-Z around its centre — same convention as
    // furniture).
    const rot_rad = (Number(rack.yaw_deg) || 0) * Math.PI / 180;
    const dx = sx - fcx;
    const dy = sy - fcy;
    const c = Math.cos(rot_rad), s = Math.sin(rot_rad);
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;

    // 2D circle-vs-AABB in rack-local frame. Local bounds span
    // ±w_m/2 in lx, ±d_m/2 in ly.
    const halfW = w_m / 2;
    const halfD = d_m / 2;
    const clx = Math.max(-halfW, Math.min(lx, +halfW));
    const cly = Math.max(-halfD, Math.min(ly, +halfD));
    const ddx = lx - clx;
    const ddy = ly - cly;
    if (ddx * ddx + ddy * ddy < r2) return true;
  }
  return false;
}
