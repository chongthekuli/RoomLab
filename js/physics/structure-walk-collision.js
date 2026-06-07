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
  expandToiletSurfaces,
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
    // The toilet bank is a COMPOSITE — its outer rectangle is NOT solid (the
    // avatar enters cubicles through open doors). Per-surface collision (boards
    // + closed doors + bowls; OPEN doors are walk-through) is delegated.
    if (s.type === 'toilet') {
      if (toiletBlocksCylinder(sx, sy, yMin, yMax, radius, s, room)) return true;
      continue;
    }
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

// Capsule (a thin oriented rectangle) for a wall segment of given thickness:
// build the 4 corners of the slab so we can reuse circleHitsPolygon.
function wallSlabCorners(a, b, thickness) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;        // unit normal
  const h = thickness / 2;
  return [
    { x: a.x + nx * h, y: a.y + ny * h },
    { x: b.x + nx * h, y: b.y + ny * h },
    { x: b.x - nx * h, y: b.y - ny * h },
    { x: a.x - nx * h, y: a.y - ny * h },
  ];
}

/**
 * Per-surface walk-collision for ONE toilet bank. Solid: every board (dividers +
 * rear wall), every CLOSED door leaf, and every bowl pedestal. Walk-through:
 * OPEN door leaves (the avatar enters that cubicle). Each surface uses its own
 * vertical [base, top] gate so the open-top scuff gap doesn't matter at avatar
 * waist height (the boards span the avatar's body either way).
 */
export function toiletBlocksCylinder(sx, sy, yMin, yMax, radius, s, room) {
  let inv;
  try { inv = expandToiletSurfaces(s, room ?? {}); } catch (_) { return false; }
  if (!inv) return false;

  // Boards (dividers + rear wall) — solid across their [base, top].
  for (const w of inv.walls) {
    if (yMax < w.base || yMin > w.top) continue;
    if (circleHitsPolygon(sx, sy, radius, wallSlabCorners(w.a, w.b, w.thickness_m))) return true;
  }

  // Doors — CLOSED leaves block; OPEN leaves are walk-through. A closed leaf is a
  // thin slab from the hinge along the row axis, undercut at the bottom (the
  // avatar's feet pass under, but the chest-height test still catches it).
  for (const d of inv.doors) {
    if (d.open) continue;
    const top = d.undercut_m + d.leafH;
    if (yMax < d.undercut_m || yMin > top) continue;
    const free = { x: d.hinge.x + d.axis.x * d.leafW, y: d.hinge.y + d.axis.y * d.leafW };
    if (circleHitsPolygon(sx, sy, radius, wallSlabCorners(d.hinge, free, d.thickness_m))) return true;
  }

  // Bowls — solid pedestal up to the seat height (the avatar can't walk through
  // it; it's short so a probe above the seat clears it). Approximate as a circle
  // of the pedestal half-diagonal.
  for (const b of inv.bowls) {
    if (yMin > b.seatH) continue;     // probe entirely above the bowl → clears
    const r = Math.hypot(b.bbox.lx, b.bbox.ly) / 2;
    if (Math.hypot(sx - b.center.x, sy - b.center.y) < r + radius) return true;
  }
  return false;
}
