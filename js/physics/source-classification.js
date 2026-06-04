// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// js/physics/source-classification.js
//
// Phase 1 of the indoor exterior-source coupling fix (Hannes plan,
// 2026-05-25). Classifies a source as INTERIOR / EXTERIOR / FLUSH_INWARD
// for the room reverberant-field aggregate.
//
// Why this exists: the indoor SPL path historically treated every source
// as a full-power contributor to the room's Hopkins-Stryker reverberant
// term, even when the source was physically outside the room polygon
// (e.g. surau azan horns mounted on a minaret gallery). That inflated
// the reverb aggregate by 3-5 dB at indoor listeners. The outdoor SPL
// path already gates with isInsideRoom3D(src.position, room); this
// module is the canonical predicate the indoor path (Phase 3) will
// call. Phase 1 ships the predicate + tests only — spl-calculator.js is
// not edited here.
//
// Classification kinds:
//   INTERIOR      — source's W feeds the room's reverberant field at
//                   full power. Standard ceiling / flown / floor units.
//   EXTERIOR      — source is outside the room volume. Couples to the
//                   interior only via wall transmission loss (Phase 2).
//   FLUSH_INWARD  — source mounted on the inner face of a wall, facing
//                   inward. Treated as INTERIOR for the reverb feed but
//                   flagged so Phase 2 can apply a boundary-loading
//                   boost (half-space radiation impedance).
//
// Pure module: no Three.js, no DOM. Imports only from js/physics/*.
// Tested via tests/source-classification.test.mjs.

import {
  isInsideRoom3D,
  isInsideParentFootprint,
  maxCeilingHeightAt,
  roomPlanVertices,
} from './room-shape.js';
import { extractPorches } from './porch-enclosure.js';
import { pointInPolygon2D } from './overhead-geometry.js';

// Mount tags that pin the source INSIDE the room volume regardless of
// where the (x, y, z) coords sit. Covers the flown-line-array landmine
// (rigged points may sit above ceiling_height for catwalk-rigged arrays)
// and wall-mounted-on-inner-face units that round the boundary check.
const INTERIOR_MOUNTS = new Set([
  'ceiling', 'flown', 'pendant', 'wall_inner', 'floor', 'tripod', 'stand',
]);

// Mount tags that pin the source OUTSIDE the room volume. Used for
// exterior PA — minaret horns, facade-mounted sirens, pole-mounted
// outdoor speakers, gallery-mounted azan units.
const EXTERIOR_MOUNTS = new Set([
  'wall_outer', 'pole', 'gallery', 'minaret', 'facade',
]);

// Boundary hysteresis for the geometric flush-inner test. A source
// sitting within this distance of any inner wall facet (in 3D) and
// otherwise inside the room is classified FLUSH_INWARD instead of
// INTERIOR. 0.05 m (5 cm) avoids λ/4 flip-flop at mid-band (λ/4 at 1 kHz
// is ~8.6 cm; 5 cm is safely smaller than the smallest mount offset a
// real installer would use) while staying large enough to absorb the
// 1 mm geometry snap the wall-segment splitter applies.
const FLUSH_HYSTERESIS_M = 0.05;

/**
 * Classify a source for indoor reverberant-field coupling.
 *
 * @param {object} src    Source state — must carry { position:{x,y,z} }.
 *                        Optional `mount` string takes precedence over
 *                        the geometric fallback.
 * @param {object} room   Room state (state.room).
 * @param {object} [opts] Reserved for future tuning knobs (e.g. caller
 *                        override of FLUSH_HYSTERESIS_M).
 * @returns {{ kind: 'INTERIOR'|'EXTERIOR'|'FLUSH_INWARD',
 *             confidence: 'high'|'medium'|'low',
 *             reason: string,
 *             facets?: object }}
 */
export function classifySource(src, room, opts = {}) {
  if (!src || !src.position || !room) {
    return { kind: 'INTERIOR', confidence: 'low', reason: 'invalid-input' };
  }
  const pos = src.position;
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
    return { kind: 'INTERIOR', confidence: 'low', reason: 'invalid-position' };
  }

  // --- Rule 1: mount tag dominance ----------------------------------------
  const mount = typeof src.mount === 'string' ? src.mount : null;
  if (mount && INTERIOR_MOUNTS.has(mount)) {
    return { kind: 'INTERIOR', confidence: 'high', reason: `mount:${mount}` };
  }
  if (mount && EXTERIOR_MOUNTS.has(mount)) {
    return { kind: 'EXTERIOR', confidence: 'high', reason: `mount:${mount}` };
  }
  // mount === 'wall' (legacy ambiguous) and mount === null both fall
  // through to the geometric path. Confidence is medium in either case.

  // --- Rule 2: porch / arcade override ------------------------------------
  // A source physically inside a surau porch sits in its OWN coupled
  // volume — the porch has a roof and a back wall (semi-open enclosure)
  // distinct from the parent prayer hall. Crediting its power to the
  // parent hall's reverberant aggregate would double-dip; the porch
  // gets its own treatment in Phase 2's porch-enclosure path.
  const porches = extractPorches(room);
  for (const porch of porches) {
    if (sourceInPorch(pos, porch)) {
      return { kind: 'EXTERIOR', confidence: 'high', reason: 'in-porch' };
    }
  }

  // --- Rule 3: standalone enclosures --------------------------------------
  // Source sitting inside a broken-out sub-room (state.room.standalone-
  // Enclosures[i]). For Phase 1 the answer is INTERIOR — meaning interior
  // to SOME room. The parent-vs-sub-enclosure resolution (whose reverb
  // aggregate does this source feed?) is deferred to Phase 3, where the
  // caller has the routing context.
  const encs = room.standaloneEnclosures;
  if (Array.isArray(encs)) {
    for (const enc of encs) {
      if (!Array.isArray(enc?.polygon) || enc.polygon.length < 3) continue;
      if (!pointInPolygon2D(pos.x, pos.y, enc.polygon)) continue;
      const elev = Number.isFinite(enc.elevation_m) ? enc.elevation_m : 0;
      const h = Number.isFinite(enc.height_m) ? enc.height_m : 3;
      if (pos.z < elev || pos.z > elev + h) continue;
      return { kind: 'INTERIOR', confidence: 'medium', reason: 'in-standalone-enclosure' };
    }
  }

  // --- Rule 4: geometric fallback -----------------------------------------
  const isInside = isInsideRoom3D(pos, room);

  if (isInside) {
    // FLUSH_INWARD if within FLUSH_HYSTERESIS_M of any wall facet.
    const nearestWallDist = distanceToNearestWallFacet(pos, room);
    if (Number.isFinite(nearestWallDist) && nearestWallDist <= FLUSH_HYSTERESIS_M) {
      return { kind: 'FLUSH_INWARD', confidence: 'medium', reason: 'geom:flush-inner' };
    }
    return { kind: 'INTERIOR', confidence: 'medium', reason: 'geom:inside' };
  }

  // --- Rule 5: flown-line-array safeguard ---------------------------------
  // isInsideRoom3D returned false. If the source's (x,y) is inside the
  // parent footprint AND its z sits ABOVE the ceiling, it's almost
  // certainly a flown / catwalk-rigged unit that the operator placed at
  // its rig point (above the visible ceiling height). Re-classify as
  // INTERIOR so the reverb aggregate sees it. Confidence is LOW so Sam
  // can audit which presets hit this branch — the right long-term fix
  // is for the preset to carry mount:'flown'.
  if (isInsideParentFootprint(pos.x, pos.y, room)) {
    const ceilH = maxCeilingHeightAt(pos.x, pos.y, room);
    if (Number.isFinite(ceilH) && pos.z > ceilH) {
      return { kind: 'INTERIOR', confidence: 'low', reason: 'geom:flown-above-ceiling' };
    }
  }

  return { kind: 'EXTERIOR', confidence: 'medium', reason: 'geom:outside' };
}

// ---------------------------------------------------------------------------
// Porch membership — mirrors listenerInPorch in porch-enclosure.js but
// inlined so the classifier does not import the listener-specific
// helper (semantic clarity: "source in porch" is a different concept
// from "listener in porch", even though the geometry test is identical).
// ---------------------------------------------------------------------------
function sourceInPorch(pos, porch) {
  if (!porch || !pos) return false;
  if (pos.z < porch.z_floor || pos.z >= porch.z_ceil) return false;
  return pointInPolygon2D(pos.x, pos.y, porch.polygon);
}

// ---------------------------------------------------------------------------
// Distance from a 3D point to the nearest wall facet's surface. Used by
// the flush-inner test. Only parent walls are considered — standalone
// enclosure walls are handled by rule 3 (inside-enclosure path).
// ---------------------------------------------------------------------------
function distanceToNearestWallFacet(pos, room) {
  const facets = listWallFacets(room);
  let best = Infinity;
  for (const f of facets) {
    const d = distanceToWallFacet3D(pos, f);
    if (d < best) best = d;
  }
  return best;
}

// Perpendicular-or-clamped distance from a point to a finite wall
// rectangle. The wall is defined by its 2D footprint segment (v1→v2 in
// xy) extruded vertically from z=elev to z=elev+height. Treats the wall
// as a finite quad: project the point onto the wall's infinite plane,
// clamp the projection to the quad's bounds, and return the distance
// to the clamped point.
function distanceToWallFacet3D(pos, facet) {
  const { v1, v2, elev_m, height_m } = facet;
  const ex = v2.x - v1.x, ey = v2.y - v1.y;
  const lenSq = ex * ex + ey * ey;
  if (lenSq <= 1e-12) return Infinity;
  const len = Math.sqrt(lenSq);
  // Project (pos.x, pos.y) onto the v1→v2 line; parameter t ∈ [0, 1]
  // clamps to the segment.
  const px = pos.x - v1.x, py = pos.y - v1.y;
  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / lenSq));
  const closestX = v1.x + t * ex;
  const closestY = v1.y + t * ey;
  const closestZ = Math.max(elev_m, Math.min(elev_m + height_m, pos.z));
  const dx = pos.x - closestX, dy = pos.y - closestY, dz = pos.z - closestZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Enumerate the room's wall facets — used by Phase 2's view-factor /
 * boundary-loading helpers. Each entry carries the wall id (matching
 * the canonical scene.js / triangulate-scene.js naming), 3D centroid
 * and outward-or-inward normal, area, materialId, and an isOpening
 * flag (always false for now; openings ride alongside their parent
 * walls in this contract — Phase 2 can split if needed).
 *
 * Coordinate convention matches the rest of js/physics/*: +x right,
 * +y depth-into-room, +z up. Normals point INTO the room interior
 * (so a source flush on the inside of a wall has dot(srcOffset, n) > 0
 * when offset slightly inward).
 *
 * Standalone enclosures contribute their perimeter walls too, prefixed
 * `enc<i>_edge_<j>` to match the diffraction module's wallId scheme.
 *
 * @param {object} room
 * @returns {Array<{ id:string, v1:object, v2:object, elev_m:number,
 *                   height_m:number, centroid:object, normal:object,
 *                   area:number, materialId:string, isOpening:boolean }>}
 */
export function listWallFacets(room) {
  const out = [];
  if (!room) return out;
  const H = Number(room.height_m) || 0;
  if (H <= 0) return out;
  const surfaces = room.surfaces || {};

  // --- Parent room walls --------------------------------------------------
  const shape = room.shape ?? 'rectangular';
  if (shape === 'rectangular') {
    const W = Number(room.width_m) || 0;
    const D = Number(room.depth_m) || 0;
    // Canonical wallSpecs lifted from triangulate-scene.js — inward
    // normals, same v1→v2 ordering, same key strings.
    const specs = [
      { id: 'parent_wall_north', v1: { x: W, y: 0 }, v2: { x: 0, y: 0 }, n: { x: 0, y:  1, z: 0 }, slotKey: 'wall_north' },
      { id: 'parent_wall_south', v1: { x: 0, y: D }, v2: { x: W, y: D }, n: { x: 0, y: -1, z: 0 }, slotKey: 'wall_south' },
      { id: 'parent_wall_east',  v1: { x: W, y: 0 }, v2: { x: W, y: D }, n: { x: -1, y: 0, z: 0 }, slotKey: 'wall_east' },
      { id: 'parent_wall_west',  v1: { x: 0, y: D }, v2: { x: 0, y: 0 }, n: { x:  1, y: 0, z: 0 }, slotKey: 'wall_west' },
    ];
    for (const s of specs) {
      const matId = resolveSlotMaterial(surfaces[s.slotKey] ?? surfaces.walls);
      out.push(makeFacet(s.id, s.v1, s.v2, 0, H, s.n, matId));
    }
  } else if (shape === 'custom') {
    const verts = Array.isArray(room.custom_vertices) ? room.custom_vertices : [];
    if (verts.length >= 3) {
      const edges = Array.isArray(surfaces.edges) ? surfaces.edges : [];
      const fallback = resolveSlotMaterial(surfaces.walls) || 'gypsum-board';
      // Determine polygon winding to point normals INWARD (toward centroid).
      const cx = verts.reduce((a, v) => a + v.x, 0) / verts.length;
      const cy = verts.reduce((a, v) => a + v.y, 0) / verts.length;
      for (let i = 0; i < verts.length; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % verts.length];
        const normal = inwardNormal2D(v1, v2, cx, cy);
        const matId = resolveSlotMaterial(edges[i]) || fallback;
        out.push(makeFacet(`parent_edge_${i}`, v1, v2, 0, H, normal, matId));
      }
    }
  } else {
    // 'polygon' / 'round' — discretize via roomPlanVertices and share
    // one merged 'walls' slot (matches roomSurfaces() semantics).
    const verts = roomPlanVertices(room);
    if (Array.isArray(verts) && verts.length >= 3) {
      const matId = resolveSlotMaterial(surfaces.walls) || 'gypsum-board';
      const cx = verts.reduce((a, v) => a + v.x, 0) / verts.length;
      const cy = verts.reduce((a, v) => a + v.y, 0) / verts.length;
      for (let i = 0; i < verts.length; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % verts.length];
        const normal = inwardNormal2D(v1, v2, cx, cy);
        out.push(makeFacet(`parent_edge_${i}`, v1, v2, 0, H, normal, matId));
      }
    }
  }

  // --- Standalone enclosure perimeter walls -------------------------------
  const encs = room.standaloneEnclosures;
  if (Array.isArray(encs)) {
    for (let ei = 0; ei < encs.length; ei++) {
      const enc = encs[ei];
      if (!enc || !Array.isArray(enc.polygon) || enc.polygon.length < 3) continue;
      const elev = Number.isFinite(enc.elevation_m) ? enc.elevation_m : 0;
      const encH = Number.isFinite(enc.height_m) ? enc.height_m : 3;
      const verts = enc.polygon;
      const cx = verts.reduce((a, v) => a + v.x, 0) / verts.length;
      const cy = verts.reduce((a, v) => a + v.y, 0) / verts.length;
      const fallback = resolveSlotMaterial(enc.materialId) || 'gypsum-board';
      for (let i = 0; i < verts.length; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % verts.length];
        const normal = inwardNormal2D(v1, v2, cx, cy);
        out.push(makeFacet(`enc${ei}_edge_${i}`, v1, v2, elev, encH, normal, fallback));
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers — kept small, pure, no exports.
// ---------------------------------------------------------------------------

function resolveSlotMaterial(slot) {
  if (typeof slot === 'string') return slot;
  if (slot && typeof slot === 'object' && typeof slot.materialId === 'string') return slot.materialId;
  return null;
}

function inwardNormal2D(v1, v2, centroidX, centroidY) {
  const ex = v2.x - v1.x, ey = v2.y - v1.y;
  const len = Math.sqrt(ex * ex + ey * ey);
  if (len <= 1e-12) return { x: 0, y: 1, z: 0 };
  // Two perpendicular candidates; pick the one pointing toward the centroid.
  const nxA = -ey / len, nyA = ex / len;
  const midX = 0.5 * (v1.x + v2.x), midY = 0.5 * (v1.y + v2.y);
  const toCentX = centroidX - midX, toCentY = centroidY - midY;
  const sign = (nxA * toCentX + nyA * toCentY) >= 0 ? 1 : -1;
  return { x: sign * nxA, y: sign * nyA, z: 0 };
}

function makeFacet(id, v1, v2, elev_m, height_m, normal, materialId) {
  const ex = v2.x - v1.x, ey = v2.y - v1.y;
  const len = Math.sqrt(ex * ex + ey * ey);
  return {
    id,
    v1: { x: v1.x, y: v1.y },
    v2: { x: v2.x, y: v2.y },
    elev_m,
    height_m,
    centroid: {
      x: 0.5 * (v1.x + v2.x),
      y: 0.5 * (v1.y + v2.y),
      z: elev_m + 0.5 * height_m,
    },
    normal,
    area: len * height_m,
    materialId: materialId || 'gypsum-board',
    isOpening: false,
  };
}
