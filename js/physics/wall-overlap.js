// Wall-overlap split — break-to-merge geometric helper.
//
// When a sub-structure becomes a standaloneEnclosure, its walls may lie
// directly on (or cross) the parent room's walls. Phase 1 of merge-with-
// overlap-aware-walls splits both polygons at the contact points so each
// resulting segment becomes its own editable surface slot. Phase 2
// (acoustic merging) is still gated on Dr. Chen's audit — `wallSegments[]`
// is a VISUAL-only field; roomSurfaces() does NOT consume it yet.
//
// Why hand-rolled and not `polygon-clipping` (npm)? We only need two
// segment-segment ops (collinear-overlap detection, transverse intersect),
// both well-known closed-form. The runtime is plain ES modules served
// statically from GitHub Pages — adding a node_modules dep would force a
// bundler we don't currently need. Hand-rolled keeps the dependency tree
// at zero and the math is short enough to audit at a glance.
//
// All coordinates are in PARENT-state plane (x right, y down — y maps to
// world.z in scene.js). Snap convention: 0.5 m for any vertex inserted
// during a split; matches the placement controller and custom-room
// drawing tool. Snap CAN cause near-collinear walls to become exactly
// collinear after rounding — that's desired behaviour.

const SNAP_M = 0.5;
const EPS = 1e-6;
// Two segments count as "collinear" when their direction cross-product
// magnitude (|d1 × d2|) is below this threshold AND each endpoint of one
// projects onto the line of the other within EPS_DIST. Snap to 0.5 m
// brings near-overlaps onto exact overlaps; we still keep this slack so
// hand-edited coordinates with sub-mm noise are tolerated.
const EPS_DIST = 1e-3;
const EPS_DIR  = 1e-4;

export function snap(v) {
  return Math.round(v / SNAP_M) * SNAP_M;
}

function snapPt(p) {
  return { x: snap(p.x), y: snap(p.y) };
}

// True iff |a - b| < EPS_DIST in both axes.
function ptEq(a, b) {
  return Math.abs(a.x - b.x) < EPS_DIST && Math.abs(a.y - b.y) < EPS_DIST;
}

function dot(ax, ay, bx, by) { return ax * bx + ay * by; }

// Distance² from a point P to the infinite line through (a, b).
function distSqPointLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return (p.x - cx) ** 2 + (p.y - cy) ** 2;
}

// Test if segment AB and segment CD are collinear (same line, any
// direction). Both must lie on a common infinite line; ordering and
// direction don't matter.
export function segmentsCollinear(a, b, c, d) {
  const dx1 = b.x - a.x, dy1 = b.y - a.y;
  const dx2 = d.x - c.x, dy2 = d.y - c.y;
  // Cross product zero => parallel.
  if (Math.abs(dx1 * dy2 - dy1 * dx2) > EPS_DIR) return false;
  // C and D must lie on the line through A,B.
  return distSqPointLine(c, a, b) < EPS_DIST * EPS_DIST
      && distSqPointLine(d, a, b) < EPS_DIST * EPS_DIST;
}

// Compute the overlap of two collinear segments. Returns null when they
// share no overlap or only touch at an endpoint (zero-length overlap).
// Otherwise returns { p, q } as the endpoints of the shared piece in
// the same direction as A→B (consistent ordering for downstream code).
export function collinearOverlap(a, b, c, d) {
  if (!segmentsCollinear(a, b, c, d)) return null;
  // Project all four points onto the A→B parametric axis.
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return null;
  const tA = 0;
  const tB = 1;
  const tC = dot(c.x - a.x, c.y - a.y, dx, dy) / len2;
  const tD = dot(d.x - a.x, d.y - a.y, dx, dy) / len2;
  const tLo = Math.max(Math.min(tA, tB), Math.min(tC, tD));
  const tHi = Math.min(Math.max(tA, tB), Math.max(tC, tD));
  // Strictly positive overlap; pure endpoint touch (tHi - tLo ≈ 0)
  // doesn't count as overlap.
  if (tHi - tLo < 1e-4) return null;
  return {
    p: { x: a.x + tLo * dx, y: a.y + tLo * dy },
    q: { x: a.x + tHi * dx, y: a.y + tHi * dy },
  };
}

// Standard 2D segment-segment intersection in parametric form. Returns
// { p, t, u } when AB ∩ CD is a single proper interior point (t and u in
// (EPS, 1-EPS)), null otherwise. Collinear segments return null — caller
// must check collinearOverlap separately.
export function segmentIntersect(a, b, c, d) {
  const r1x = b.x - a.x, r1y = b.y - a.y;
  const r2x = d.x - c.x, r2y = d.y - c.y;
  const denom = r1x * r2y - r1y * r2x;
  if (Math.abs(denom) < EPS_DIR) return null;     // parallel / collinear
  const sx = c.x - a.x, sy = c.y - a.y;
  const t = (sx * r2y - sy * r2x) / denom;
  const u = (sx * r1y - sy * r1x) / denom;
  // Strictly interior intersections only — endpoint touches are NOT
  // splits (they're already vertices).
  if (t <= EPS || t >= 1 - EPS) return null;
  if (u <= EPS || u >= 1 - EPS) return null;
  return {
    p: { x: a.x + t * r1x, y: a.y + t * r1y },
    t, u,
  };
}

// Insert a list of split points into a polygon's vertex ring at the
// position `edgeIdx`. Each point becomes a NEW vertex between v[edgeIdx]
// and v[edgeIdx+1]; the original `edges[]` slot is cloned for each new
// sub-edge so material + openings carry through. Returns
// { polygon, edges, insertedAt: [indices of inserted points in new ring] }
// where `insertedAt` lets the caller find the indices it just created.
//
// Caller is responsible for SORTING `points` by their distance from
// v[edgeIdx] (closest first) — this function preserves that order.
export function insertSplitPoints(polygon, edges, edgeIdx, points) {
  if (!points || points.length === 0) {
    return { polygon: polygon.slice(), edges: edges.slice(), insertedAt: [] };
  }
  const newPoly = [];
  const newEdges = [];
  const insertedAt = [];
  for (let i = 0; i < polygon.length; i++) {
    newPoly.push(polygon[i]);
    if (i === edgeIdx) {
      // The edge currently at `edgeIdx` is ABOUT to become multiple
      // edges. Insert the split points (each in turn becomes a new
      // vertex AFTER the start of the original edge) and clone the
      // original slot once per new sub-edge.
      const origSlot = edges[edgeIdx];
      // First sub-edge slot stays at edges[edgeIdx]; we'll add (n-1)
      // more clones for the remaining sub-edges.
      newEdges.push(cloneSlot(origSlot));
      for (const pt of points) {
        newPoly.push(pt);
        insertedAt.push(newPoly.length - 1);
        newEdges.push(cloneSlot(origSlot));
      }
    } else {
      newEdges.push(cloneSlot(edges[i]));
    }
  }
  return { polygon: newPoly, edges: newEdges, insertedAt };
}

function cloneSlot(slot) {
  if (typeof slot === 'string') return slot;
  if (slot && typeof slot === 'object') return JSON.parse(JSON.stringify(slot));
  return 'gypsum-board';
}

// Add a "merge cut" opening to a wall slot so the wall mesh has a hole at
// the overlap rectangle while keeping its original material everywhere
// else. The wall mesh renders solid ABOVE / BELOW the opening (when the
// opposing wall is shorter or sits at a different elevation), which is
// the user-requested behaviour: "the area not touching another wall
// stays as a separate face."
//
// Coordinates are wall-local: x along the edge from v1, z = height from
// THIS wall's floor (i.e. relative to its own elevation_m). A short
// enclosure sitting on a 1 m platform inside a 4 m parent room produces
// a cut on the parent's wall at z=1 to z=3 (the slice the enclosure
// actually overlaps); the parent's wall remains solid 0–1 m and 3–4 m.
//
// `system: 'merge_cut'` tags the opening so the openings UI can filter it
// from the user-visible doors / windows list — the user didn't add it
// and shouldn't be tempted to delete or resize it.
function withMergeCut(slot, width_m, height_m, z_m = 0) {
  const matId = slotMatId(slot);
  const existing = (slot && typeof slot === 'object' && Array.isArray(slot.openings))
    ? slot.openings.slice()
    : [];
  existing.push({
    id: 'mcut-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    kind: 'door',           // shape category; system tag distinguishes it
    x_m: 0, z_m,
    width_m, height_m,
    materialId: 'open-air',
    state: 'open',
    system: 'merge_cut',
  });
  return { materialId: matId, openings: existing };
}

// Generate a unique-ish wall-segment id (timestamp + random). Format
// matches the enclosure id naming so eyeballing a saved JSON groups
// related entities by prefix.
export function newWallSegmentId() {
  return 'wseg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Material id of a wall slot, regardless of string-vs-object form.
function slotMatId(slot) {
  if (typeof slot === 'string') return slot;
  if (slot && typeof slot === 'object' && typeof slot.materialId === 'string') return slot.materialId;
  return 'gypsum-board';
}

// MAIN ENTRY POINT — split the parent's edge ring + an enclosure's edge
// ring against each other. Mutates neither input; returns:
//   { parentPolygon, parentEdges, encPolygon, encEdges, wallSegments }
//
// Contract:
//   - Each overlap is replaced by `'open-air'` slots in BOTH polygons'
//     edges[] arrays (so the rendered walls don't double-draw at the
//     shared seam) and the canonical surface goes into wallSegments[].
//   - Transverse-cross intersections split BOTH walls into two segments
//     in their respective edges[] (no wallSegments[] entry created — the
//     two cross walls don't share a seam, they just cross at a point).
//   - All inserted vertices are snapped to 0.5 m.
//   - Original `parentPolygon` / `encPolygon` arrays are NEVER mutated.
//
// Limitations (Phase 1):
//   - Only handles ONE enclosure-vs-parent pass at a time. Caller drives
//     the loop when multiple enclosures coexist.
//   - Parent must be a `'custom'` polygon. Rectangular / round / regular-
//     polygon parents skip splitting (the caller still pushes the
//     enclosure entry, just without overlap-aware seams).
//   - The split is single-pass: if a parent edge ALREADY has a transverse
//     intersection from a prior enclosure, the second enclosure's
//     transverse hit on the same edge will work against the post-split
//     edges (correct), but if two enclosure walls overlap the same
//     parent edge in DIFFERENT segments, only the first enclosure's
//     overlap is recorded as a wallSegment for that parent edge — the
//     second enclosure's wall lies on what is now an open-air slot of
//     the parent and won't double-up. Acceptable: same wall material,
//     same place; cosmetically identical to the user.
export function splitParentVsEnclosure(
  parentPolygon, parentEdges, encPolygon, encEdges,
  { parentHeight_m, parentElevation_m = 0, encElevation_m = 0, encHeight_m } = {},
) {
  // Default encHeight_m to parentHeight_m so callers that don't care about
  // height-bounded overlaps still get the previous full-height behaviour.
  if (!Number.isFinite(encHeight_m)) encHeight_m = parentHeight_m;
  if (!Number.isFinite(parentHeight_m)) parentHeight_m = encHeight_m ?? 3;
  // Snap all incoming vertices to the 0.5 m grid so near-collinear walls
  // resolve to exactly collinear. Both rings get fresh arrays.
  const pPoly = parentPolygon.map(snapPt);
  const ePoly = encPolygon.map(snapPt);
  let pEdges = parentEdges.map(cloneSlot);
  let eEdges = encEdges.map(cloneSlot);
  const wallSegments = [];

  // First pass: find overlaps + transverse intersections per (parent
  // edge, enclosure edge) pair against the SNAPPED rings. We collect all
  // hits, group them by edge, then apply insertions all at once per
  // edge so indices stay stable.
  // Hits are { kind: 'overlap'|'cross', pe: parent-edge-idx, ee: enc-edge-idx,
  //            p, q?, parentInsert: [...], encInsert: [...] }
  const hits = [];
  for (let pi = 0; pi < pPoly.length; pi++) {
    const a = pPoly[pi], b = pPoly[(pi + 1) % pPoly.length];
    for (let ei = 0; ei < ePoly.length; ei++) {
      const c = ePoly[ei], d = ePoly[(ei + 1) % ePoly.length];
      const overlap = collinearOverlap(a, b, c, d);
      if (overlap) {
        hits.push({ kind: 'overlap', pe: pi, ee: ei, p: snapPt(overlap.p), q: snapPt(overlap.q) });
        continue;
      }
      const cross = segmentIntersect(a, b, c, d);
      if (cross) {
        hits.push({ kind: 'cross', pe: pi, ee: ei, p: snapPt(cross.p) });
      }
    }
  }

  // Group new vertices to insert per parent edge and per enclosure edge.
  const parentInserts = new Map();   // edgeIdx -> [points]
  const encInserts = new Map();
  function pushInsert(map, idx, p) {
    if (!map.has(idx)) map.set(idx, []);
    map.get(idx).push(p);
  }
  for (const h of hits) {
    if (h.kind === 'overlap') {
      // Both endpoints of the overlap need to become vertices in BOTH
      // rings, BUT only if they aren't already a vertex (i.e. they're
      // not at the existing edge endpoints).
      const pA = pPoly[h.pe], pB = pPoly[(h.pe + 1) % pPoly.length];
      if (!ptEq(h.p, pA) && !ptEq(h.p, pB)) pushInsert(parentInserts, h.pe, h.p);
      if (!ptEq(h.q, pA) && !ptEq(h.q, pB)) pushInsert(parentInserts, h.pe, h.q);
      const eA = ePoly[h.ee], eB = ePoly[(h.ee + 1) % ePoly.length];
      if (!ptEq(h.p, eA) && !ptEq(h.p, eB)) pushInsert(encInserts, h.ee, h.p);
      if (!ptEq(h.q, eA) && !ptEq(h.q, eB)) pushInsert(encInserts, h.ee, h.q);
    } else {
      // Transverse: single point, split BOTH walls at h.p.
      const pA = pPoly[h.pe], pB = pPoly[(h.pe + 1) % pPoly.length];
      const eA = ePoly[h.ee], eB = ePoly[(h.ee + 1) % ePoly.length];
      if (!ptEq(h.p, pA) && !ptEq(h.p, pB)) pushInsert(parentInserts, h.pe, h.p);
      if (!ptEq(h.p, eA) && !ptEq(h.p, eB)) pushInsert(encInserts, h.ee, h.p);
    }
  }

  // Sort each edge's insert list by parametric distance from edge start
  // and de-duplicate (a vertex hit by both an overlap endpoint AND a
  // transverse cross at the same coordinate must only be inserted once).
  function sortAndDedupeInserts(poly, map) {
    for (const [idx, pts] of map) {
      const a = poly[idx], b = poly[(idx + 1) % poly.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      const annotated = pts.map(p => ({
        p,
        t: ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2,
      }));
      annotated.sort((x, y) => x.t - y.t);
      // Dedupe — if two points are within EPS_DIST, drop the later one.
      const dedup = [];
      for (const item of annotated) {
        if (dedup.length === 0 || !ptEq(dedup[dedup.length - 1], item.p)) {
          dedup.push(item.p);
        }
      }
      map.set(idx, dedup);
    }
  }
  sortAndDedupeInserts(pPoly, parentInserts);
  sortAndDedupeInserts(ePoly, encInserts);

  // Apply parent inserts back-to-front so indices in earlier edges stay
  // valid as we splice. After this pass pPoly + pEdges grow to include
  // every split vertex; the edge slots are CLONES of the original slot
  // (so material + openings carry through to both halves).
  let pAccum = { polygon: pPoly, edges: pEdges };
  const parentEdgeIdxs = Array.from(parentInserts.keys()).sort((x, y) => y - x);
  for (const edgeIdx of parentEdgeIdxs) {
    pAccum = insertSplitPoints(pAccum.polygon, pAccum.edges, edgeIdx, parentInserts.get(edgeIdx));
  }
  let eAccum = { polygon: ePoly, edges: eEdges };
  const encEdgeIdxs = Array.from(encInserts.keys()).sort((x, y) => y - x);
  for (const edgeIdx of encEdgeIdxs) {
    eAccum = insertSplitPoints(eAccum.polygon, eAccum.edges, edgeIdx, encInserts.get(edgeIdx));
  }

  // For each overlap hit, find the parent + enclosure edges that NOW
  // exactly match the overlap segment (post-insertion), set both to
  // 'open-air', and create a single canonical wallSegment[] entry.
  function findEdgeMatching(poly, p, q) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((ptEq(a, p) && ptEq(b, q)) || (ptEq(a, q) && ptEq(b, p))) return i;
    }
    return -1;
  }
  // Track which parent edges we've already converted to open-air this
  // pass; one parent edge can host MULTIPLE wallSegments only if there's
  // more than one overlap subsegment on it (handled by the inserted
  // vertices already separating them — each overlap maps to one
  // distinct sub-edge after insertion).
  for (const h of hits) {
    if (h.kind !== 'overlap') continue;
    const pSnap = snapPt(h.p), qSnap = snapPt(h.q);
    const pIdx = findEdgeMatching(pAccum.polygon, pSnap, qSnap);
    const eIdx = findEdgeMatching(eAccum.polygon, pSnap, qSnap);
    if (pIdx < 0 || eIdx < 0) continue; // safety net
    // Inherit material from the parent's original slot. Openings on the
    // overlapped slice are dropped (a door on a wall that no longer
    // exists has no meaningful position) — we DO carry over the
    // canonical wallSegment's material + height.
    const matId = slotMatId(pAccum.edges[pIdx]);
    // 2D OVERLAP RECTANGLE on the wall face — accounts for BOTH walls'
    // elevation_m AND height_m. The shared region is the intersection
    // of the two walls' (z_min, z_max) intervals along the vertical:
    //   parent vertical interval: [parentElevation_m, parentElevation_m + parentHeight_m]
    //   enc    vertical interval: [encElevation_m,    encElevation_m    + encHeight_m]
    //   overlap z range:          [max(p_z0, e_z0), min(p_z1, e_z1)]
    // If the intervals don't intersect (e.g. enc is above parent's roof
    // entirely), there's no shared face — we still mark a wallSegment
    // for visual continuity but produce no cut on either wall.
    const overlapW = Math.hypot(qSnap.x - pSnap.x, qSnap.y - pSnap.y);
    const pZ0 = parentElevation_m;
    const pZ1 = parentElevation_m + parentHeight_m;
    const eZ0 = encElevation_m;
    const eZ1 = encElevation_m + encHeight_m;
    const overlapZ0 = Math.max(pZ0, eZ0);
    const overlapZ1 = Math.min(pZ1, eZ1);
    const overlapH  = Math.max(0, overlapZ1 - overlapZ0);
    if (overlapH > 1e-3) {
      // Cut z-offset is wall-LOCAL: relative to that wall's own floor,
      // not the world. So the parent's cut sits at (overlapZ0 - parentEl)
      // up the parent's wall, and the enc's cut at (overlapZ0 - encEl)
      // up the enc's wall. With both walls at the same elevation this
      // collapses to z=0 (== old behaviour).
      pAccum.edges[pIdx] = withMergeCut(
        pAccum.edges[pIdx], overlapW, overlapH, overlapZ0 - pZ0,
      );
      eAccum.edges[eIdx] = withMergeCut(
        eAccum.edges[eIdx], overlapW, overlapH, overlapZ0 - eZ0,
      );
    }
    // wallSegment sits at the overlap z-range in WORLD coords (its
    // elevation_m is world-y where the shared wall starts). Height is
    // the actual overlap range. When the two walls don't intersect
    // vertically (overlapH ≤ 0), we still emit a zero-height segment
    // so the chain of overlap detection doesn't silently miss the case
    // — but rebuildWallSegments will skip h ≤ 0 entries.
    wallSegments.push({
      id: newWallSegmentId(),
      x1: pSnap.x, y1: pSnap.y, x2: qSnap.x, y2: qSnap.y,
      elevation_m: overlapZ0,
      height_m: overlapH,
      materialId: matId,
      openings: [],
      sourceLabel: 'shared',
    });
  }

  return {
    parentPolygon: pAccum.polygon,
    parentEdges:   pAccum.edges,
    encPolygon:    eAccum.polygon,
    encEdges:      eAccum.edges,
    wallSegments,
  };
}
