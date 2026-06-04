// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// js/physics/wall-inset.js
//
// Phase 7 Commit 2 (Viktor Lindqvist, 2026-05-23). Pure module — NO
// Three.js, NO DOM. Imported by scene.js (3D wall extrusion), room-2d.js
// (2D fill, Commit 3 — Maya), and print-plan-svg.js (print, Commit 3 —
// Maya). All thickness arithmetic for visual rendering MUST funnel
// through here so the cross-surface parity fixture in
// tests/cross-surface-conventions.test.mjs can grep for raw `thickness_m`
// math outside this file and trip the gate.
//
// Geometry contract (locked by Sam, 2026-05-23):
//
//   The polygon edge IS the OUTER face of the wall. Each edge is offset
//   INWARD by its own thickness; adjacent offset lines are INTERSECTED
//   to produce each inner vertex (NOT a uniform shrink). For varying
//   thicknesses (e.g. 200 mm front wall + 100 mm side walls), the
//   front-corner inner vertex is shifted 200 mm in Y but 100 mm in X.
//
//   Winding: state-frame CCW (room polygons produced by roomPlanVertices
//   are CCW in standard math axes: x right, y up — verified for
//   rectangular [(0,0),(W,0),(W,D),(0,D)] which has shoelace +2WD).
//
//   For a CCW polygon, the INWARD normal of edge i (running v_i → v_{i+1})
//   is the LEFT-turn perpendicular of the edge direction:
//     d = normalize(v_{i+1} − v_i)
//     n = (-d.y, +d.x)
//
//   Inner vertex v'_i sits at the intersection of edge (i-1)'s offset line
//   and edge i's offset line — i.e. the two edges that MEET at v_i.
//
// Resolution order (the ONLY function allowed to walk it):
//   getWallEdgeThickness(room, edgeIndex)
//     1. room.wallSegments[k].thickness_m       — IF a merged-seam wall
//                                                  matches this edge by id
//                                                  (Phase 8 acoustic
//                                                  coupling will populate
//                                                  this; today it almost
//                                                  always falls through).
//     2. Cardinal slot's thickness_m via normalizeWallSlot:
//          rectangular: room.surfaces.wall_{north,east,south,west}
//                       indexed in CCW edge order:
//                         edge 0 (v0→v1, bottom y=0)     → wall_north
//                         edge 1 (v1→v2, right x=W)      → wall_east
//                         edge 2 (v2→v3, top y=D)        → wall_south
//                         edge 3 (v3→v0, left x=0)       → wall_west
//                       (matches scene.js:2771 wallOpts ordering — see
//                       feedback_room_shape_compass_swap; the *mesh* names
//                       are inverted vs preset compass labels but the
//                       state-frame edge-index → cardinal-slot mapping
//                       above is the one this module follows.)
//          custom:       room.surfaces.edges[edgeIndex]
//          polygon/round room.surfaces.walls (shared by every edge)
//     3. DEFAULT_WALL_THICKNESS_M (0.10 m).
//
// Degenerate behaviour (documented per Sam's spec — don't throw):
//   If after intersection the inner polygon's signed area is ≤ 0 (a wall
//   is thicker than its parallel opposite — e.g. a 3 m wall in a 5 m
//   room), the inner polygon collapses to the OUTER CENTROID repeated
//   `outer.length` times. The contract still holds (inner.length ===
//   outer.length, same winding by zero-area convention) — the renderer
//   ends up extruding zero-volume wall boxes, which is the most honest
//   visual signal we can give without crashing.

import {
  DEFAULT_WALL_THICKNESS_M,
  normalizeWallSlot,
} from './room-shape.js';

// Re-export so callers don't need two imports for "the thickness story".
export { DEFAULT_WALL_THICKNESS_M };

// Hard cap on wall-label text. Sam's parity fixture greps for the
// constant in 2D + print code paths; Maya's Commit 3 truncates with an
// ellipsis at this length.
export const WALL_LABEL_MAX_CHARS = 12;

// ---------------------------------------------------------------------------
// Shape helpers — match roomPlanVertices() in room-shape.js for the inner
// vertex polygon, but the OUTER-polygon synthesis lives here so the same
// vertex count drives offset math + (later) cross-surface mesh tagging.
// ---------------------------------------------------------------------------

const ROUND_VERTEX_COUNT = 64;  // matches roomPlanVertices('round')

function getShape(room) { return room?.shape ?? 'rectangular'; }

// Build the OUTER polygon for inset math. Matches roomPlanVertices() for
// rectangular / polygon / round / custom; this duplicates the synthesis
// rather than importing roomPlanVertices because (a) the contract demands
// inner.length === outer.length and we want to be self-contained for the
// round case (concentric 64-gon discretisation), and (b) the public
// roomPlanVertices() has a placeholder-rect fallback for the mid-draw
// custom-polygon case that would silently feed bad data into the inset
// math.
function outerPolygon(room) {
  switch (getShape(room)) {
    case 'polygon': {
      const n = room.polygon_sides ?? 6;
      const r = room.polygon_radius_m ?? 3;
      const cx = (room.width_m ?? 2 * r) / 2;
      const cy = (room.depth_m ?? 2 * r) / 2;
      const verts = [];
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + i * 2 * Math.PI / n;
        verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      return verts;
    }
    case 'round': {
      const r = room.round_radius_m ?? 3;
      const cx = (room.width_m ?? 2 * r) / 2;
      const cy = (room.depth_m ?? 2 * r) / 2;
      const verts = [];
      for (let i = 0; i < ROUND_VERTEX_COUNT; i++) {
        const a = -Math.PI / 2 + i * 2 * Math.PI / ROUND_VERTEX_COUNT;
        verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      return verts;
    }
    case 'custom': {
      const cv = (room.custom_vertices || [])
        .filter(v => v && Number.isFinite(v.x) && Number.isFinite(v.y))
        .map(v => ({ x: v.x, y: v.y }));
      if (cv.length >= 3) return cv;
      // Mid-draw fallback — match the placeholder rectangle that
      // roomPlanVertices() returns so visual modules don't crash before
      // the polygon closes.
      const w = room.width_m || 8;
      const d = room.depth_m || 8;
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
    }
    default: {
      const w = room.width_m ?? 1;
      const d = room.depth_m ?? 1;
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
    }
  }
}

// Cardinal-slot key for a rectangular edge in CCW order (matches the
// scene.js wallOpts ordering — see header docstring).
function rectEdgeSlotKey(edgeIndex) {
  switch (edgeIndex & 3) {
    case 0: return 'wall_north';   // edge (0,0) → (W,0)
    case 1: return 'wall_east';    // edge (W,0) → (W,D)
    case 2: return 'wall_south';   // edge (W,D) → (0,D)
    case 3: return 'wall_west';    // edge (0,D) → (0,0)
  }
  return 'wall_north';
}

// ---------------------------------------------------------------------------
// PUBLIC: thickness resolution — the ONLY function allowed to walk the
// three-step lookup (wallSegments override → cardinal/edge slot →
// DEFAULT_WALL_THICKNESS_M). Every visual surface that needs a per-edge
// thickness MUST call this — direct reads of slot.thickness_m bypass the
// wallSegments override and will diverge from the physics path in Phase 8.
// ---------------------------------------------------------------------------

export function getWallEdgeThickness(room, edgeIndex) {
  if (!room || !Number.isFinite(edgeIndex) || edgeIndex < 0) {
    return DEFAULT_WALL_THICKNESS_M;
  }

  // Step 1 — wallSegments override. Today these are merged-seam canonical
  // walls produced by wall-overlap.js (shared between parent + sub-room);
  // they carry their own thickness when a merged sub-room wall is thicker
  // than the parent slot. We match by `edge_${i}` id pattern (custom rooms)
  // OR by an explicit `edgeIndex` field (future Phase 8). String match is
  // permissive — wallSegments rarely overrides today, so a missed match
  // simply falls through to step 2.
  if (Array.isArray(room.wallSegments)) {
    for (const seg of room.wallSegments) {
      if (!seg || typeof seg !== 'object') continue;
      const sid = seg.id;
      const matchesId = (typeof sid === 'string') &&
        (sid === `edge_${edgeIndex}` || sid === `wseg_edge_${edgeIndex}`);
      const matchesField = Number.isFinite(seg.edgeIndex) && seg.edgeIndex === edgeIndex;
      if (matchesId || matchesField) {
        const t = Number(seg.thickness_m);
        if (Number.isFinite(t) && t > 0) return t;
        // wallSegments entry exists but doesn't override thickness — keep
        // walking to step 2 (so a merged wall without an explicit
        // thickness inherits the cardinal slot's value).
        break;
      }
    }
  }

  // Step 2 — cardinal slot lookup (rectangular) / edges[i] (custom) /
  // shared 'walls' (polygon, round). normalizeWallSlot fills in defaults
  // for legacy string-form slots, so the value is always finite.
  const surfaces = room.surfaces || {};
  let slot;
  switch (getShape(room)) {
    case 'custom': {
      const edges = surfaces.edges || [];
      slot = edges[edgeIndex];
      break;
    }
    case 'polygon':
    case 'round':
      slot = surfaces.walls;
      break;
    default:
      slot = surfaces[rectEdgeSlotKey(edgeIndex)];
      break;
  }
  const norm = normalizeWallSlot(slot);
  const t = Number(norm.thickness_m);

  // Step 3 — normalizeWallSlot already substitutes the default for missing
  // / invalid values, so this is a belt-and-suspenders guard. It also
  // covers the case where a future writer stuffs `thickness_m: 0` directly
  // into a slot to mean "open wall, no thickness" — we treat that as the
  // default (0 m walls would crash the offset math at the corners).
  if (!Number.isFinite(t) || t <= 0) return DEFAULT_WALL_THICKNESS_M;
  return t;
}

// ---------------------------------------------------------------------------
// 2D line-line intersection in the (point + direction) form:
//   A + s · d_a  =  B + u · d_b
// Returns the (s, u) parameters; null if d_a × d_b ≈ 0 (parallel lines).
// ---------------------------------------------------------------------------

function intersectRays(ax, ay, dax, day, bx, by, dbx, dby) {
  const cross = dax * dby - day * dbx;
  if (Math.abs(cross) < 1e-12) return null;
  const dx = bx - ax, dy = by - ay;
  const s = (dx * dby - dy * dbx) / cross;
  // We only need `s` to compute the intersection point; u is symmetric.
  return { s, x: ax + s * dax, y: ay + s * day };
}

// Shoelace signed area. + for CCW (standard math axes), − for CW.
function signedArea(poly) {
  let a = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return a / 2;
}

function centroid(poly) {
  if (!poly.length) return { x: 0, y: 0 };
  let cx = 0, cy = 0;
  for (const v of poly) { cx += v.x; cy += v.y; }
  return { x: cx / poly.length, y: cy / poly.length };
}

// ---------------------------------------------------------------------------
// PUBLIC: wallInsetPolygon — the core geometry call.
// ---------------------------------------------------------------------------

export function wallInsetPolygon(room) {
  const outer = outerPolygon(room);
  const n = outer.length;
  if (n < 3) {
    return { outer: outer.slice(), inner: outer.slice(), thicknesses: [] };
  }

  // Detect winding once. For CCW (signedArea > 0) the inward normal of
  // edge i (v_i → v_{i+1}) is the LEFT-turn perp of the edge direction.
  // For CW (negative area) we flip the normal so the inset still grows
  // INTO the polygon. roomPlanVertices() is CCW by convention but a
  // user-drawn custom polygon could legally be CW — handle both.
  const ccw = signedArea(outer) > 0;

  // Per-edge thickness AND offset line origin.
  // Edge i runs from outer[i] → outer[(i+1) % n].
  // Offset line i: passes through (outer[i] + t_i · n_i) with direction d_i.
  const thicknesses = new Array(n);
  const dirs = new Array(n);       // unit edge direction
  const normals = new Array(n);    // unit inward normal
  const offsetA = new Array(n);    // a point on the offset line (outer[i] + t·n)

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = outer[j].x - outer[i].x;
    const ey = outer[j].y - outer[i].y;
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len < 1e-9) {
      // Degenerate edge — adjacent vertices coincide. Fall back to a
      // zero-direction; the corner intersection step will skip this and
      // route through the parallel-line fallback.
      dirs[i] = { x: 0, y: 0 };
      normals[i] = { x: 0, y: 0 };
      thicknesses[i] = getWallEdgeThickness(room, i);
      offsetA[i] = { x: outer[i].x, y: outer[i].y };
      continue;
    }
    const dx = ex / len, dy = ey / len;
    // CCW: inward normal = left-turn perp = (-dy, +dx).
    // CW : inward normal = right-turn perp = (+dy, -dx).
    const nx = ccw ? -dy : +dy;
    const ny = ccw ? +dx : -dx;
    const t = getWallEdgeThickness(room, i);
    dirs[i] = { x: dx, y: dy };
    normals[i] = { x: nx, y: ny };
    thicknesses[i] = t;
    offsetA[i] = { x: outer[i].x + t * nx, y: outer[i].y + t * ny };
  }

  // Inner vertices — intersection of offset line (i-1) and offset line (i)
  // for each outer vertex i. Both lines pass through outer[i] in the
  // zero-thickness limit, so the natural inner-vertex location is where
  // their *offset* counterparts cross.
  const inner = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = (i - 1 + n) % n;   // previous edge
    const A = offsetA[k];
    const da = dirs[k];
    const B = offsetA[i];
    const db = dirs[i];
    const hit = intersectRays(A.x, A.y, da.x, da.y, B.x, B.y, db.x, db.y);
    if (hit) {
      inner[i] = { x: hit.x, y: hit.y };
    } else {
      // Parallel edges meeting at v_i (collinear vertex OR degenerate
      // adjacent edge). Fall back to outer[i] + t_i · n_i — equivalent
      // to projecting the outer vertex along the local inward normal.
      // Coincides with the line-line answer when thicknesses match;
      // when they don't, it picks the "thicker" edge's offset which is
      // conservative (inner wall doesn't poke outside the offset).
      const t = Math.max(thicknesses[k], thicknesses[i]);
      const nx = normals[i].x || normals[k].x;
      const ny = normals[i].y || normals[k].y;
      inner[i] = { x: outer[i].x + t * nx, y: outer[i].y + t * ny };
    }
  }

  // Degeneracy guard — if the inner polygon's signed area has flipped
  // sign (walls thicker than the room they live in), collapse all inner
  // vertices to the outer centroid. The contract (inner.length ===
  // outer.length, same winding by zero-area convention) holds and the
  // renderer extrudes zero-volume wall boxes. Documented signal: the
  // wall is thicker than the room can geometrically support; the user
  // sees "no inside surface" in 3D and goes looking for the WallLAB
  // thickness slider.
  const outerSign = ccw ? +1 : -1;
  const innerArea = signedArea(inner);
  if (Math.sign(innerArea) !== outerSign || Math.abs(innerArea) < 1e-9) {
    const c = centroid(outer);
    for (let i = 0; i < n; i++) inner[i] = { x: c.x, y: c.y };
  }

  return { outer, inner, thicknesses };
}

// ---------------------------------------------------------------------------
// PUBLIC: wallLabelAnchor — where a per-wall label sits.
//
// Label rides on the INSIDE face of the wall (so it's readable from
// inside the room), parallel to the wall, centred on the edge midpoint,
// and offset inward by (thickness_m / 2 + small gap) so it sits FLUSH
// with the inner face plane — neither floating inside the room nor
// embedded in the wall mesh.
//
// Returns {x, y} in state-frame, plus rotation_deg (CCW from +x axis)
// and the locked maxChars constant for the caller's truncation pass.
// ---------------------------------------------------------------------------

const WALL_LABEL_GAP_M = 0.01;  // 10 mm air gap from the inside wall face

export function wallLabelAnchor(roomEdge, thickness_m) {
  const v1 = roomEdge?.v1 || roomEdge?.[0];
  const v2 = roomEdge?.v2 || roomEdge?.[1];
  if (!v1 || !v2 || !Number.isFinite(v1.x) || !Number.isFinite(v1.y)
      || !Number.isFinite(v2.x) || !Number.isFinite(v2.y)) {
    return { x: 0, y: 0, rotation_deg: 0, maxChars: WALL_LABEL_MAX_CHARS };
  }
  const ex = v2.x - v1.x;
  const ey = v2.y - v1.y;
  const len = Math.sqrt(ex * ex + ey * ey);
  if (len < 1e-9) {
    return { x: v1.x, y: v1.y, rotation_deg: 0, maxChars: WALL_LABEL_MAX_CHARS };
  }
  const dx = ex / len, dy = ey / len;
  // For a CCW-wound polygon, the inward normal is (-dy, +dx). Callers
  // pass the edge in CCW order — same convention as wallInsetPolygon.
  const nx = -dy, ny = dx;
  const t = Number.isFinite(thickness_m) && thickness_m > 0
    ? thickness_m
    : DEFAULT_WALL_THICKNESS_M;
  // Centre on edge midpoint, offset inward by thickness/2 + gap.
  const mx = (v1.x + v2.x) / 2;
  const my = (v1.y + v2.y) / 2;
  const inset = t * 0.5 + WALL_LABEL_GAP_M;
  const x = mx + inset * nx;
  const y = my + inset * ny;
  // Rotation: edge direction in degrees CCW from +x. 2D / print SVG
  // surfaces flip Y for display — they're responsible for negating this
  // rotation if their local coord system runs in screen-Y-down. State
  // frame is the canonical reference.
  const rotation_deg = Math.atan2(dy, dx) * 180 / Math.PI;
  return { x, y, rotation_deg, maxChars: WALL_LABEL_MAX_CHARS };
}
