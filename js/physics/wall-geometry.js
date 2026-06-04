// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// js/physics/wall-geometry.js
//
// Shared wall / overhead-reflector geometry helpers — extracted from
// diffraction.js in Phase A1 (2026-05-24, per Martina's audit §2.E + §3
// "extract resolveWallGeometry into a new wall-geometry.js so diffraction
// and reradiation don't share via the wrong dependency direction").
//
// Both diffraction.js AND reradiation.js need to resolve a wallId back to
// its geometric definition (v1/v2/elev_m/height_m), and the diffraction
// shadow-path gate (cornerIsInShadowPath) needs signedDistanceToLine2D and
// wallFootprintLine. Before this module existed, reradiation imported
// resolveWallGeometry FROM diffraction.js — the wrong direction because
// neither module is the natural owner of "wall geometry."
//
// No behaviour change. Pure mechanical move. Imports updated in:
//   - js/physics/diffraction.js
//   - js/physics/reradiation.js
//   - tests/*.test.mjs (any that imported _testing's resolveWallGeometry)

import { extractOverheadReflectors } from './overhead-geometry.js';

// ---------------------------------------------------------------------------
// resolveOverheadGeometry — wallId "arcade_roof_<side>_ceiling" or
//   "portico_roof_<side>_ceiling" → the reflector polygon record
//   { kind, side, vertices, z_top, materialId } emitted by
//   extractOverheadReflectors. Returns null if the wallId isn't an
//   overhead-roof crossing.
// ---------------------------------------------------------------------------
export function resolveOverheadGeometry(room, wallId) {
  const match = /^(arcade_roof|portico_roof)_([a-z]+)_ceiling$/.exec(wallId);
  if (!match) return null;
  const kind = match[1];
  const side = match[2];
  const reflectors = extractOverheadReflectors(room);
  if (!Array.isArray(reflectors)) return null;
  const refl = reflectors.find(r => r.kind === kind && r.side === side);
  return refl || null;
}

// ---------------------------------------------------------------------------
// resolveWallGeometry — wallId (from wallsCrossedByPath) → its (v1, v2)
//   endpoints + elev_m + height_m. Mirrors the canonical wallSpecs ordering
//   in wall-path.js + triangulate-scene.js wallSpecs.
//
//   Two parent walls are deliberately REVERSED from naive CCW order; don't
//   "fix" without also updating wall-path.js and the test
//   tests/diffraction-multipath.test.mjs which depends on the specific
//   signed-distance sign convention.
//
//   Returns null for non-wall ids (overhead roofs are routed through
//   resolveOverheadGeometry; parent_floor and parent_ceiling are not
//   diffractable surfaces in the current model).
// ---------------------------------------------------------------------------
export function resolveWallGeometry(room, wallId) {
  if (!room) return null;
  const W = Number(room.width_m) || 0;
  const D = Number(room.depth_m) || 0;
  const H = Number(room.height_m) || 0;
  // Parent rectangular walls.
  if (wallId === 'parent_wall_north') return { v1: { x: W, y: 0 }, v2: { x: 0, y: 0 }, elev_m: 0, height_m: H };
  if (wallId === 'parent_wall_south') return { v1: { x: 0, y: D }, v2: { x: W, y: D }, elev_m: 0, height_m: H };
  if (wallId === 'parent_wall_east')  return { v1: { x: W, y: 0 }, v2: { x: W, y: D }, elev_m: 0, height_m: H };
  if (wallId === 'parent_wall_west')  return { v1: { x: 0, y: D }, v2: { x: 0, y: 0 }, elev_m: 0, height_m: H };
  // Parent floor / ceiling: diffraction not applied — perimeter edges
  // coincide with the wall TOP edges (the eave line), already integrated
  // via the wall-side enumerateFreeEdges path.
  if (wallId === 'parent_floor' || wallId === 'parent_ceiling') return null;
  // Phase 8 Step 5: arcade / portico roof crossings get a separate
  // roof-polygon geometry via resolveOverheadGeometry; not a wall.
  if (wallId.startsWith('arcade_roof_') || wallId.startsWith('portico_roof_')) return null;
  // Polygon edge: parent_edge_<i>
  const polyMatch = /^parent_edge_(\d+)$/.exec(wallId);
  if (polyMatch && Array.isArray(room.custom_vertices)) {
    const i = Number(polyMatch[1]);
    const v = room.custom_vertices;
    if (v[i] && v[(i + 1) % v.length]) {
      return { v1: v[i], v2: v[(i + 1) % v.length], elev_m: 0, height_m: H };
    }
  }
  // Standalone enclosure edge: enc<ei>_edge_<i>
  const encMatch = /^enc(\d+)_edge_(\d+)$/.exec(wallId);
  if (encMatch && Array.isArray(room.standaloneEnclosures)) {
    const enc = room.standaloneEnclosures[Number(encMatch[1])];
    const i = Number(encMatch[2]);
    if (enc?.polygon && enc.polygon[i] && enc.polygon[(i + 1) % enc.polygon.length]) {
      return {
        v1: enc.polygon[i],
        v2: enc.polygon[(i + 1) % enc.polygon.length],
        elev_m: Number.isFinite(enc.elevation_m) ? enc.elevation_m : 0,
        height_m: Number.isFinite(enc.height_m) ? enc.height_m : 3,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// signedDistanceToLine2D — 2D cross-product magnitude relative to the
//   directed line from v1 to v2. The sign indicates which side of the
//   line the point sits on; the magnitude is proportional to the
//   perpendicular distance.
//
//   Used by cornerIsInShadowPath to test if source and receiver sit on
//   OPPOSITE sides of a wall face (one diagnostic for "this wedge is in
//   the shadow path"). The sign convention follows the v1→v2 direction;
//   for canonical wall_<side> orientations this puts the room interior
//   on the +Z-cross side, but we only ever compare two signs to each
//   other — never need to know which side is "inside."
// ---------------------------------------------------------------------------
export function signedDistanceToLine2D(point, v1, v2) {
  const ex = v2.x - v1.x, ey = v2.y - v1.y;
  const px = point.x - v1.x, py = point.y - v1.y;
  return ex * py - ey * px;
}

// ---------------------------------------------------------------------------
// wallFootprintLine — cheap helper that strips a wall's vertical
//   information (elev_m / height_m) and returns just the 2D footprint
//   line { v1, v2 }. Used by the shadow-path gate where we only care
//   about the wall's 2D projection (vertical containment is enforced
//   downstream by diffractionPointOnEdge's segment clamp).
// ---------------------------------------------------------------------------
export function wallFootprintLine(wallId, room) {
  const w = resolveWallGeometry(room, wallId);
  if (!w) return null;
  return { v1: w.v1, v2: w.v2 };
}
