// js/physics/wall-path.js
//
// Geometric ray-vs-wall test for sound transmission. Given a source
// position and a listener position, returns the list of wall (and
// floor / ceiling) segments the straight-line path crosses, with each
// wall's material id and whether the crossing point falls inside a
// cut-through opening (door / window).
//
// Used by spl-calculator.js to apply per-band material transmission
// loss when the direct path leaves and/or re-enters an enclosure.
//
// REPLACES the previous flat WALL_TRANSMISSION_LOSS_DB = 30 model
// which:
//   * was material-agnostic (same value for concrete and curtain),
//   * was frequency-independent (no coincidence dips, no mass-law slope),
//   * was opening-agnostic (a path through an open door still incurred
//     the full 30 dB),
//   * tested only an inside-vs-outside membership flip, not actual
//     ray-vs-wall geometry — so a source inside an enclosure and a
//     listener inside ANOTHER enclosure of the same scene would both
//     read "inside" and the wall(s) between them disappeared.
//
// Architecture notes:
//   * Walls are defined per-shape. Rectangular rooms get the four
//     canonical wall_<side> slots in the same (v1, v2) orientation
//     that triangulate-scene.js + scene.js render — this is the
//     orientation surauStructureWallOpenings emits opening `x_m`
//     coordinates against. Polygon / custom / standaloneEnclosure
//     edges use their natural CCW polygon order.
//   * Openings are matched by point-in-rectangle in the wall's local
//     (along-wall, height-above-floor) coordinates, exactly mirroring
//     the cut produced by triangulate-scene.js wallQuadsAfterOpenings.
//   * Floor + ceiling planes participate as horizontal "walls" so
//     roof-mounted sources radiating down through a suspended-ceiling
//     tile, and sub-floor sources radiating up through a wood floor,
//     pick up the correct material TL.
//   * Standalone enclosures are unioned into the parent polygon's
//     crossings list — a path from "inside parent" to "inside an
//     enclosure attached to parent" can correctly cross BOTH the
//     parent's wall AND the enclosure's wall (typical adjacent-hut
//     case), and the TLs dB-sum.

import {
  roomPlanVertices, normalizeWallSlot, applySurauOpeningsToSlot,
} from './room-shape.js';

// Canonical wall specs for a rectangular room — MUST match the
// (v1, v2) orientation used by triangulate-scene.js wallSpecs and
// surauStructureWallOpenings's x_m emission. Two of the walls
// (wall_north, wall_south) are deliberately reversed from the naive
// CCW polygon-edge order; do NOT "fix" this by switching to plain
// CCW iteration without also remapping every opening's x_m.
function rectangularWalls(room) {
  const W = Number(room.width_m) || 0;
  const D = Number(room.depth_m) || 0;
  return [
    { key: 'wall_north', v1: { x: W, y: 0 }, v2: { x: 0, y: 0 } },
    { key: 'wall_south', v1: { x: 0, y: D }, v2: { x: W, y: D } },
    { key: 'wall_east',  v1: { x: W, y: 0 }, v2: { x: W, y: D } },
    { key: 'wall_west',  v1: { x: 0, y: D }, v2: { x: 0, y: 0 } },
  ];
}

// 2D segment-segment intersection. Returns { t, u, x, y } where:
//   t = parameter along (p1 → p2) of the intersection (0..1 valid)
//   u = parameter along (q1 → q2) of the intersection (0..1 valid)
// Returns null when parallel or no intersection within both segments.
function segmentIntersect2D(p1, p2, q1, q2) {
  const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y;
  const dx2 = q2.x - q1.x, dy2 = q2.y - q1.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-12) return null;
  const dxq = q1.x - p1.x, dyq = q1.y - p1.y;
  const t = (dxq * dy2 - dyq * dx2) / denom;
  const u = (dxq * dy1 - dyq * dx1) / denom;
  // Tiny tolerance lets corner-grazing paths register one wall hit
  // instead of zero (the deterministic resolution is "the path skims
  // the wall, which counts as a crossing") — better than a flicker
  // between hit and no-hit driven by floating-point round-off.
  const EPS = 1e-9;
  if (t < -EPS || t > 1 + EPS) return null;
  if (u < -EPS || u > 1 + EPS) return null;
  return {
    t: Math.max(0, Math.min(1, t)),
    u: Math.max(0, Math.min(1, u)),
    x: p1.x + t * dx1,
    y: p1.y + t * dy1,
  };
}

function pointInPolygon2D(x, y, verts) {
  let inside = false;
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (((verts[i].y > y) !== (verts[j].y > y)) &&
        (x < (verts[j].x - verts[i].x) * (y - verts[i].y) / (verts[j].y - verts[i].y) + verts[i].x)) {
      inside = !inside;
    }
  }
  return inside;
}

// True if the wall-local point (xLocal along-wall, zLocal above-wall-bottom)
// falls inside any cut-through opening on this wall. Cut-through means
// state === 'open' OR materialId === 'open-air' — matches the rules in
// triangulate-scene.js isOpeningCutThrough and the wall-slot opening
// schema documented in room-shape.js.
function pointInOpening(xLocal, zLocal, openings) {
  if (!Array.isArray(openings) || openings.length === 0) return false;
  for (const op of openings) {
    const isOpen = op?.state === 'open' || op?.materialId === 'open-air';
    if (!isOpen) continue;
    const w = Number(op.width_m), h = Number(op.height_m);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const x0 = Math.max(0, Number(op.x_m) || 0);
    const z0 = Math.max(0, Number(op.z_m) || 0);
    if (xLocal >= x0 && xLocal <= x0 + w && zLocal >= z0 && zLocal <= z0 + h) {
      return true;
    }
  }
  return false;
}

// Test a single wall segment against the source-listener path and push
// any hit onto `out`. `slot` already has openings merged (via
// applySurauOpeningsToSlot for rectangular rooms or normalizeWallSlot
// for polygon edges).
function testWall(out, src, listener, v1, v2, elev_m, height_m, slot, wallId) {
  const hit = segmentIntersect2D(src, listener, v1, v2);
  if (!hit) return;
  // Vertical coordinate of the 2D-XY intersection — interpolate
  // src.z → listener.z by the same parameter t the XY intersection
  // returned. (The 3D segment is the straight 3D line so all three
  // axes share the same parameter t.)
  const z = src.z + hit.t * (listener.z - src.z);
  const zLocal = z - elev_m;
  // Filter: the hit must be within the wall's vertical extent.
  // Allow a small slop so a source exactly at floor / ceiling height
  // doesn't flicker between hit and miss.
  if (zLocal < -1e-6 || zLocal > height_m + 1e-6) return;
  // Along-wall coordinate from v1, in the same metric the openings
  // use (x_m measured from v1 in the v1 → v2 direction).
  const dx = v2.x - v1.x, dy = v2.y - v1.y;
  const wallLen = Math.hypot(dx, dy);
  const xLocal = hit.u * wallLen;
  const throughOpening = pointInOpening(xLocal, Math.max(0, zLocal), slot.openings);
  out.push({
    wallId,
    materialId: throughOpening ? 'open-air' : slot.materialId,
    throughOpening,
    hitPoint: { x: hit.x, y: hit.y, z },
  });
}

// Test the polygon's floor + ceiling planes for crossings. Only relevant
// when src.z and listener.z straddle the plane. A ceiling crossing reads
// the room's ceiling material (gypsum tile, plaster, etc.); a floor
// crossing reads the floor material (slab, wood, etc.).
function testHorizontalPlanes(out, src, listener, polyVerts, elev_m, height_m, floorMat, ceilingMat, idPrefix) {
  const planes = [];
  if (floorMat)   planes.push({ z: elev_m,            mat: floorMat,   id: 'floor'   });
  if (ceilingMat) planes.push({ z: elev_m + height_m, mat: ceilingMat, id: 'ceiling' });
  const dz = listener.z - src.z;
  if (Math.abs(dz) < 1e-9) return;
  for (const p of planes) {
    const t = (p.z - src.z) / dz;
    // Strict interior: a source exactly on the plane or listener exactly
    // on the plane is NOT considered a crossing. Without this strict
    // bound, a ceiling-mounted speaker at z = ceiling_height would
    // self-trigger a ceiling crossing on every direct path.
    if (t <= 1e-9 || t >= 1 - 1e-9) continue;
    const x = src.x + t * (listener.x - src.x);
    const y = src.y + t * (listener.y - src.y);
    if (!pointInPolygon2D(x, y, polyVerts)) continue;
    out.push({
      wallId: `${idPrefix}_${p.id}`,
      materialId: p.mat,
      throughOpening: false,
      hitPoint: { x, y, z: p.z },
    });
  }
}

// Iterate every wall (+ floor + ceiling) of one polygon and push hits
// onto `out`. `walls` is the wall-spec list — for rectangular rooms it
// is `rectangularWalls(room)` (with the canonical v1/v2 orientation);
// for polygon / custom / enclosures it is built from CCW polygon edges.
function collectPolygonCrossings(out, src, listener, walls, polyVerts, elev_m, height_m, slotFor, floorMat, ceilingMat, idPrefix) {
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const slot = slotFor(w, i);
    testWall(out, src, listener, w.v1, w.v2, elev_m, height_m, slot, `${idPrefix}_${w.key ?? `edge_${i}`}`);
  }
  testHorizontalPlanes(out, src, listener, polyVerts, elev_m, height_m, floorMat, ceilingMat, idPrefix);
}

// Per-edge wall slot for polygon / custom shapes. `surfaces.edges[i]`
// when present, then fall back to `surfaces.walls`, then 'gypsum-board'.
// Openings stored on the edge object follow the natural CCW
// (v[i] → v[i+1]) orientation — no flipping required.
function polygonEdgeSlot(surfaces, edgeIdx) {
  const edges = Array.isArray(surfaces?.edges) ? surfaces.edges : null;
  const raw = edges?.[edgeIdx] ?? surfaces?.walls ?? 'gypsum-board';
  return normalizeWallSlot(raw);
}

// Main entry. Returns an array of crossing objects between src and
// listener for the entire room geometry (parent polygon + every
// standaloneEnclosure + floor + ceiling planes). Empty array when both
// endpoints are inside the same enclosure with no plane crossings.
export function wallsCrossedByPath(src, listener, room) {
  if (!room) return [];
  if (!Number.isFinite(src?.x) || !Number.isFinite(src?.y) || !Number.isFinite(src?.z)) return [];
  if (!Number.isFinite(listener?.x) || !Number.isFinite(listener?.y) || !Number.isFinite(listener?.z)) return [];
  const out = [];

  // Parent polygon. Rectangular rooms use the canonical wallSpecs so
  // openings' along-wall x_m lands on the right segment; polygon /
  // custom rooms use plain CCW edges with normalizeWallSlot.
  const verts = roomPlanVertices(room);
  if (verts && verts.length >= 3) {
    const elev = 0;
    const height = Number.isFinite(room.height_m) ? room.height_m : 0;
    const surfaces = room.surfaces || {};
    const shape = room?.shape;
    const isRect = !shape || shape === 'rectangular';
    if (isRect) {
      const walls = rectangularWalls(room);
      collectPolygonCrossings(
        out, src, listener, walls, verts, elev, height,
        // applySurauOpeningsToSlot returns the raw slot unchanged when
        // no synthesised surau openings exist, so when the user's slot
        // is the legacy bare-string form (e.g. 'concrete-painted')
        // we need to normalize so slot.materialId is defined.
        (w /*, _idx*/) => normalizeWallSlot(applySurauOpeningsToSlot(surfaces[w.key], room, w.key)),
        surfaces.floor, surfaces.ceiling, 'parent',
      );
    } else {
      const walls = [];
      for (let i = 0; i < verts.length; i++) {
        walls.push({ v1: verts[i], v2: verts[(i + 1) % verts.length] });
      }
      collectPolygonCrossings(
        out, src, listener, walls, verts, elev, height,
        (_w, idx) => polygonEdgeSlot(surfaces, idx),
        surfaces.floor, surfaces.ceiling, 'parent',
      );
    }
  }

  // Standalone enclosures — each one is an independent polygon with its
  // own surface map, elevation, and height.
  const encs = room?.standaloneEnclosures;
  if (Array.isArray(encs)) {
    for (let ei = 0; ei < encs.length; ei++) {
      const enc = encs[ei];
      if (!Array.isArray(enc?.polygon) || enc.polygon.length < 3) continue;
      const surf = enc.surfaces || {};
      const elev = Number.isFinite(enc.elevation_m) ? enc.elevation_m : 0;
      const height = Number.isFinite(enc.height_m) ? enc.height_m : 3;
      const walls = [];
      for (let i = 0; i < enc.polygon.length; i++) {
        walls.push({ v1: enc.polygon[i], v2: enc.polygon[(i + 1) % enc.polygon.length] });
      }
      collectPolygonCrossings(
        out, src, listener, walls, enc.polygon, elev, height,
        (_w, idx) => polygonEdgeSlot(surf, idx),
        surf.floor, surf.ceiling, `enc${ei}`,
      );
    }
  }

  return out;
}

// Map frequency (Hz) to the band index in materials.frequency_bands_hz.
// Snaps to the nearest band on a log axis so e.g. 700 Hz returns the
// 1000 Hz band and 350 Hz returns the 250 Hz band. Returns 0 if the
// catalogue isn't loaded yet (defensive — caller should usually check).
export function bandIndexForFreq(materials, freq_hz) {
  const bands = materials?.frequency_bands_hz;
  if (!Array.isArray(bands) || bands.length === 0) return 0;
  if (!Number.isFinite(freq_hz) || freq_hz <= 0) return 0;
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < bands.length; i++) {
    const d = Math.abs(Math.log2(freq_hz / bands[i]));
    if (d < bestDelta) { bestDelta = d; best = i; }
  }
  return best;
}

// Per-band TL lookup. Returns total TL in dB for `bandIdx` summed in
// dB across every solid-wall crossing in the path. Crossings through
// an opening contribute 0 dB. Materials lacking transmission_loss_db
// fall back to a 20 dB engine floor and emit a one-time console
// warning per material id — better than silently dropping to 0 (every
// real wall has some loss) and better than failing loudly on a frame
// (we want the heatmap to keep rendering).
const _warnedMissingTL = new Set();
const ENGINE_FLOOR_TL_DB = 20;
const MULTI_WALL_SANITY_DB = 80;
let _warnedMultiWall = false;

export function transmissionLossDb(wallsCrossed, materials, bandIdx) {
  if (!wallsCrossed || wallsCrossed.length === 0) return 0;
  let totalTL = 0;
  let solidCount = 0;
  for (const w of wallsCrossed) {
    if (w.throughOpening) continue;
    solidCount++;
    const mat = materials?.byId?.[w.materialId];
    let tl;
    if (Array.isArray(mat?.transmission_loss_db) && Number.isFinite(mat.transmission_loss_db[bandIdx])) {
      tl = mat.transmission_loss_db[bandIdx];
    } else {
      tl = ENGINE_FLOOR_TL_DB;
      if (!_warnedMissingTL.has(w.materialId)) {
        _warnedMissingTL.add(w.materialId);
        console.warn(`[wall-path] material '${w.materialId}' has no transmission_loss_db — using engine floor of ${ENGINE_FLOOR_TL_DB} dB. Add transmission_loss_db[7] to data/materials.json to silence.`);
      }
    }
    totalTL += tl;
  }
  if (totalTL > MULTI_WALL_SANITY_DB && !_warnedMultiWall) {
    _warnedMultiWall = true;
    console.warn(`[wall-path] path crosses ${solidCount} solid walls totalling ${totalTL.toFixed(0)} dB TL (> ${MULTI_WALL_SANITY_DB} dB sanity floor) — geometry sanity check recommended. (Future warnings of this kind suppressed.)`);
  }
  return totalTL;
}

// Convenience — combine path test + TL lookup at one band in one call.
// Returns { tl_db, wallsCrossed }. wallsCrossed is the raw list so
// callers can also surface per-wall info in the breakdown UI.
export function pathTransmissionLoss(src, listener, room, materials, freq_hz) {
  const wallsCrossed = wallsCrossedByPath(src, listener, room);
  if (wallsCrossed.length === 0) return { tl_db: 0, wallsCrossed };
  const bandIdx = bandIndexForFreq(materials, freq_hz);
  const tl_db = transmissionLossDb(wallsCrossed, materials, bandIdx);
  return { tl_db, wallsCrossed };
}

// Test-only: clear the one-time warning caches so a unit-test fixture
// can exercise "missing TL" or "multi-wall sanity" branches repeatedly
// without polluting other tests. Not exported by name in the public
// API doc — call from tests only.
export function _resetWarningCachesForTests() {
  _warnedMissingTL.clear();
  _warnedMultiWall = false;
}
