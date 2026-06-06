// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE).

// Walk-mode avatar collision against placed building structures (2026-06-05).
//
// Third time this class of bug recurred (racks → furniture → structures): a new
// solid object type was added and the avatar walked straight through it until
// the user reported it. This is the structure collider; it is routed through
// the single js/physics/walk-collision.js aggregator that the walk-collision
// registry test enumerates, so the NEXT solid type can't silently ship
// walk-through.
//
// Geometric (not acoustic): every structure is solid to the avatar. Reuses the
// SAME footprint + height helpers the 3D mesh, the 2D plan, the ray occluder,
// and the acoustic prism all use (building-structures.js) — one source of truth
// for "where is this structure solid?".
//
// Pure / Node-testable. No DOM, no Three.js.

import {
  STRUCTURE_TYPES, structureFootprintCorners, structureFootprintCircle, structureHeightRange,
} from './building-structures.js';

// Squared distance from point (px,py) to segment (ax,ay)-(bx,by).
function distSqToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

function pointInPolygon(px, py, corners) {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const xi = corners[i].x, yi = corners[i].y, xj = corners[j].x, yj = corners[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Circle (centre px,py, radius r) overlaps a convex/simple polygon iff the
// centre is inside OR within r of any edge.
function circleHitsPolygon(px, py, r, corners) {
  if (!Array.isArray(corners) || corners.length < 3) return false;
  if (pointInPolygon(px, py, corners)) return true;
  const r2 = r * r;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    if (distSqToSeg(px, py, corners[j].x, corners[j].y, corners[i].x, corners[i].y) <= r2) return true;
  }
  return false;
}

/**
 * True if a vertical cylinder at state-frame (sx, sy), radius `radius`, vertical
 * span [yMin, yMax] (state z) overlaps ANY placed building structure. Beams /
 * elevated structures clear a short avatar via the [base, top] vertical gate —
 * the avatar walks UNDER a high beam but INTO a pillar/wall.
 *
 * @param {number} sx avatar centre, state x
 * @param {number} sy avatar centre, state y (depth)
 * @param {number} yMin bottom of avatar cylinder, state z (m)
 * @param {number} yMax top of avatar cylinder, state z (m)
 * @param {number} radius avatar collision radius (m)
 * @param {Array}  structures state.structures
 * @param {object} room for full-height / ceiling-relative extents
 * @returns {boolean}
 */
export function structureBlocksCylinder(sx, sy, yMin, yMax, radius, structures, room) {
  if (!Array.isArray(structures) || structures.length === 0) return false;
  if (!(radius > 0)) return false;
  for (const s of structures) {
    if (!s || !s.position || !STRUCTURE_TYPES.includes(s.type)) continue;
    const { base, top } = structureHeightRange(s, room ?? {});
    if (yMax < base || yMin > top) continue;   // avatar clears it vertically
    const circle = structureFootprintCircle(s);
    if (circle) {
      const dx = sx - circle.cx, dy = sy - circle.cy;
      if (Math.hypot(dx, dy) < circle.r + radius) return true;
      continue;
    }
    if (circleHitsPolygon(sx, sy, radius, structureFootprintCorners(s))) return true;
  }
  return false;
}
