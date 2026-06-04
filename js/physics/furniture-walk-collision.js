// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// Walk-mode avatar collision against placed furniture (v=682, 2026-05-27).
//
// User UAT (v=681 push): "now the avatar can walk through the furnitures,
// this is a bit unreal, get this physics fixed."
//
// Root cause:
//   1. Furniture meshes live in `furnitureGroup` (scene.js), NOT in
//      `roomGroup`. The ThirdPersonController only raycasts into
//      roomGroup, so the avatar never sees furniture meshes at all.
//   2. Even if we added the meshes, the controller's single chest-height
//      ray (~0.98 m) would still walk straight through tables (0.75 m
//      tall — the ray passes over the slab top).
//
// Fix: a pure cylinder-vs-AABB test against the SAME sub-volumes the
// precision tracer + direct-blocking helpers already use (sub-volumes.js).
// One source of truth for "where is this piece of furniture solid?" —
// the visible mesh, the acoustic bbox, AND the walk obstacle all come
// from the same getSubVolumes(row) call.
//
// Treats EVERY sub-volume (porous, reflective_main, frame) as solid.
// Acoustically a chair cushion is porous; physically you still can't
// walk through it. The walk-collision view is geometric, not acoustic.
//
// Pure / Node-testable. No DOM, no Three.js.

import { getSubVolumes } from './furniture-sub-volumes.js';

/**
 * Return true if a vertical cylinder at state-frame position (sx, sy)
 * with radius `radius` and vertical span [yMin, yMax] (state z, ground
 * up) overlaps ANY sub-volume of ANY placed furniture item.
 *
 * Coordinates are STATE-frame (state.x along width, state.y along depth,
 * state.z up). The caller (third-person-controller.js) converts from
 * Three.js world frame: state.x = -world.x (scene.scale.x = -1 mirror),
 * state.y = world.z, state.z = world.y.
 *
 * Per-item rotation: f.rotation_deg is applied around the item's centre
 * in state x-y. The test transforms the avatar's centre INTO the item's
 * local frame so we can use axis-aligned bbox tests against the raw
 * sub.bounds without rotating each bbox.
 *
 * @param {number} sx                       avatar centre, state x
 * @param {number} sy                       avatar centre, state y (depth)
 * @param {number} yMin                     bottom of avatar cylinder, state z (m)
 * @param {number} yMax                     top of avatar cylinder, state z (m)
 * @param {number} radius                   avatar collision radius (m)
 * @param {Array}  furniture                state.furniture
 * @param {Map}    catalogue                Map<id, row> from getFurnitureCatalogue()
 * @returns {boolean}
 */
export function furnitureBlocksCylinder(sx, sy, yMin, yMax, radius, furniture, catalogue) {
  if (!Array.isArray(furniture) || furniture.length === 0) return false;
  if (!catalogue || catalogue.size === 0) return false;
  if (!(radius > 0)) return false;
  const r2 = radius * radius;
  for (const f of furniture) {
    if (!f?.position || typeof f.catalogueId !== 'string') continue;
    const row = catalogue.get(f.catalogueId);
    if (!row?.footprint) continue;
    const fcx = f.position.x, fcy = f.position.y;
    // World→local: subtract item centre, then rotate by -rotation.
    // Per scene.js mesh.rotation.y, the rotation_deg is a yaw in the
    // state x-y plane (positive = CCW in state frame).
    const rot_rad = (f.rotation_deg || 0) * Math.PI / 180;
    const dx = sx - fcx;
    const dy = sy - fcy;
    // Rotation matrix by -rot_rad: [cos -sin; sin cos] with negated angle
    //   = [cos sin; -sin cos]
    const c = Math.cos(rot_rad), s = Math.sin(rot_rad);
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    const subs = getSubVolumes(row);
    if (!subs?.length) continue;
    for (const sub of subs) {
      // Vertical overlap (avatar z span vs sub bbox z span).
      if (yMax < sub.bounds[2] || yMin > sub.bounds[5]) continue;
      // 2D circle-vs-AABB in furniture-local frame.
      const clx = Math.max(sub.bounds[0], Math.min(lx, sub.bounds[3]));
      const cly = Math.max(sub.bounds[1], Math.min(ly, sub.bounds[4]));
      const ddx = lx - clx, ddy = ly - cly;
      if (ddx * ddx + ddy * ddy < r2) return true;
    }
  }
  return false;
}
