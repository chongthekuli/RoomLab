// tests/wall-inset.test.mjs
//
// Phase 7 Commit 2 — same-PR regression guard for js/physics/wall-inset.js.
// Locks the inset-polygon contract Sam signed off on:
//
//   inner.length === outer.length
//   same winding as outer
//   per-edge thickness via getWallEdgeThickness (three-step lookup)
//   adjacent offset lines INTERSECT (not uniform shrink)
//   degenerate case (inner area flips sign) collapses to centroid, no throw
//
// Three fixtures:
//   A  uniform 100 mm rectangular 6×8 m       (smoke test)
//   B  N=300 mm, others=100 mm rect 6×8 m     (non-uniform corner shifts)
//   C  6-vertex L-shape custom, mixed edges   (non-orthogonal handling)
// Plus:
//   - WALL_LABEL_MAX_CHARS === 12
//   - wallLabelAnchor places label on INSIDE face (positive inward offset)
//   - getWallEdgeThickness resolution order (wallSegments > slot > default)
//   - degenerate case (3 m wall in 5 m room) does not throw

import assert from 'node:assert';
import {
  wallInsetPolygon,
  wallLabelAnchor,
  getWallEdgeThickness,
  WALL_LABEL_MAX_CHARS,
  DEFAULT_WALL_THICKNESS_M,
} from '../js/physics/wall-inset.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else      { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function vertApprox(p, ex, ey, eps = 1e-6) {
  return approx(p.x, ex, eps) && approx(p.y, ey, eps);
}

// Shoelace signed area (CCW positive in standard math axes).
function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return a / 2;
}

// =============================================================================
// Constants
// =============================================================================

check('WALL_LABEL_MAX_CHARS === 12', WALL_LABEL_MAX_CHARS === 12);
check('DEFAULT_WALL_THICKNESS_M === 0.10', DEFAULT_WALL_THICKNESS_M === 0.10);

// =============================================================================
// Fixture A — uniform 100 mm rectangular 6×8 m
//   Outer CCW: (0,0) → (6,0) → (6,8) → (0,8)
//   Every wall_* slot = default thickness (0.10)
//   Expected inner: (0.10, 0.10) (5.90, 0.10) (5.90, 7.90) (0.10, 7.90)
// =============================================================================

{
  const room = {
    shape: 'rectangular',
    width_m: 6,
    depth_m: 8,
    height_m: 3,
    surfaces: {
      floor: 'gypsum-board',
      ceiling: 'gypsum-board',
      wall_north: 'gypsum-board',
      wall_south: 'gypsum-board',
      wall_east:  'gypsum-board',
      wall_west:  'gypsum-board',
    },
  };
  const out = wallInsetPolygon(room);
  check('A: outer.length === 4', out.outer.length === 4);
  check('A: inner.length === outer.length', out.inner.length === out.outer.length);
  check('A: thicknesses.length === 4', out.thicknesses.length === 4);
  check('A: every thickness === 0.10',
    out.thicknesses.every(t => approx(t, 0.10)));

  check('A: inner v0 ≈ (0.10, 0.10)',  vertApprox(out.inner[0], 0.10, 0.10));
  check('A: inner v1 ≈ (5.90, 0.10)',  vertApprox(out.inner[1], 5.90, 0.10));
  check('A: inner v2 ≈ (5.90, 7.90)',  vertApprox(out.inner[2], 5.90, 7.90));
  check('A: inner v3 ≈ (0.10, 7.90)',  vertApprox(out.inner[3], 0.10, 7.90));

  // Same winding as outer (both CCW → positive signed area).
  const innerArea = signedArea(out.inner);
  check('A: inner signed area is positive (CCW, same as outer)', innerArea > 0);
  check('A: inner area === 5.80 × 7.80 = 45.24 m²',
    approx(innerArea, 5.80 * 7.80, 1e-6),
    `got ${innerArea.toFixed(6)}`);
}

// =============================================================================
// Fixture B — non-uniform 6×8 m rectangular, state-frame +y "north" 300 mm
//   The user-brief "North wall 300 mm" = the wall at state-y = depth_m = 8.
//   In CCW edge order [edge0=y=0, edge1=x=W, edge2=y=D, edge3=x=0], the
//   "north" (state-+y, larger y) edge is edge 2 → cardinal slot `wall_south`.
//   (The compass swap docstring in room-shape.js documents this: scene
//   mesh `wall_south` lives on the state-+y face; the *preset* compass
//   label is inverted. The visible RoomLAB "North" arrow points up the
//   page, which is state +y.)
//
//   So wall_south = 0.30 m, others = 0.10 m.
//   Inner: (0.10, 0.10) (5.90, 0.10) (5.90, 7.70) (0.10, 7.70)
//   X span = 5.80 (east+west = 0.20). Y span = 7.60 (south-slot=0.30
//   on the +y face shifts those corners by 0.30 in Y; north-slot=0.10
//   on the y=0 face shifts those by 0.10 in Y).
// =============================================================================

{
  const room = {
    shape: 'rectangular',
    width_m: 6,
    depth_m: 8,
    height_m: 3,
    surfaces: {
      floor: 'gypsum-board',
      ceiling: 'gypsum-board',
      wall_north: { materialId: 'gypsum-board', thickness_m: 0.10 },
      wall_south: { materialId: 'concrete-painted', thickness_m: 0.30 },  // state +y face
      wall_east:  { materialId: 'gypsum-board', thickness_m: 0.10 },
      wall_west:  { materialId: 'gypsum-board', thickness_m: 0.10 },
    },
  };

  // Resolution check first — getWallEdgeThickness for each edge.
  check('B: edge 0 (y=0) → wall_north → 0.10',
    approx(getWallEdgeThickness(room, 0), 0.10));
  check('B: edge 1 (x=W) → wall_east → 0.10',
    approx(getWallEdgeThickness(room, 1), 0.10));
  check('B: edge 2 (y=D, state-+y / "north") → wall_south → 0.30',
    approx(getWallEdgeThickness(room, 2), 0.30));
  check('B: edge 3 (x=0) → wall_west → 0.10',
    approx(getWallEdgeThickness(room, 3), 0.10));

  const out = wallInsetPolygon(room);
  check('B: inner.length === 4', out.inner.length === 4);

  check('B: inner v0 (state-south corner) ≈ (0.10, 0.10)',
    vertApprox(out.inner[0], 0.10, 0.10));
  check('B: inner v1 (state-south corner) ≈ (5.90, 0.10)',
    vertApprox(out.inner[1], 5.90, 0.10));
  check('B: inner v2 (state-north corner) shifted 300 mm inward in Y ≈ (5.90, 7.70)',
    vertApprox(out.inner[2], 5.90, 7.70));
  check('B: inner v3 (state-north corner) shifted 300 mm inward in Y ≈ (0.10, 7.70)',
    vertApprox(out.inner[3], 0.10, 7.70));

  // Aggregate dims.
  const xSpan = out.inner[1].x - out.inner[0].x;
  const ySpan = out.inner[2].y - out.inner[1].y;
  check('B: inner X span === 5.80 (6 − 0.10 − 0.10)', approx(xSpan, 5.80));
  check('B: inner Y span === 7.60 (8 − 0.30 − 0.10)', approx(ySpan, 7.60));
}

// =============================================================================
// Fixture C — 6-vertex L-shape custom polygon, mixed thicknesses
//   Outer (CCW):
//     v0 (0,0)  v1 (8,0)  v2 (8,4)  v3 (4,4)  v4 (4,8)  v5 (0,8)
//   surfaces.edges = [0.10, 0.20, 0.10, 0.10, 0.10, 0.10]
//
//   Edge 0 (v0→v1, y=0): offset y = 0.10
//   Edge 1 (v1→v2, x=8): offset x = 7.80
//   Edge 2 (v2→v3, y=4, going -x): offset y = 4 - 0.10 = 3.90
//                                          (n = (0,-1) inward for CCW)
//                  WAIT — edge 2 here is going from (8,4) → (4,4), so
//                  d=(-1,0), n = (-dy, +dx) = (0,-1). That's "down" in
//                  state-Y — INWARD because the L-shape's interior is
//                  below the (8,4)→(4,4) segment. Correct.
//   Edge 3 (v3→v4, x=4, going +y): d=(0,1), n=(-1,0) inward.
//                  offset x = 4 - 0.10 = 3.90.
//   Edge 4 (v4→v5, y=8, going -x): d=(-1,0), n=(0,-1) inward.
//                  offset y = 8 - 0.10 = 7.90.
//   Edge 5 (v5→v0, x=0, going -y): d=(0,-1), n=(+1,0) inward.
//                  offset x = 0 + 0.10 = 0.10.
//
//   Inner v0 = ∩ edge5 (x=0.10) and edge0 (y=0.10) → (0.10, 0.10)
//   Inner v1 = ∩ edge0 (y=0.10) and edge1 (x=7.80) → (7.80, 0.10)
//   Inner v2 = ∩ edge1 (x=7.80) and edge2 (y=3.90) → (7.80, 3.90)
//   Inner v3 = ∩ edge2 (y=3.90) and edge3 (x=3.90) → (3.90, 3.90)
//   Inner v4 = ∩ edge3 (x=3.90) and edge4 (y=7.90) → (3.90, 7.90)
//   Inner v5 = ∩ edge4 (y=7.90) and edge5 (x=0.10) → (0.10, 7.90)
// =============================================================================

{
  const room = {
    shape: 'custom',
    width_m: 8,
    depth_m: 8,
    height_m: 3,
    custom_vertices: [
      { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 4 },
      { x: 4, y: 4 }, { x: 4, y: 8 }, { x: 0, y: 8 },
    ],
    surfaces: {
      floor: 'gypsum-board',
      ceiling: 'gypsum-board',
      edges: [
        { materialId: 'gypsum-board', thickness_m: 0.10 },
        { materialId: 'concrete-painted', thickness_m: 0.20 },
        { materialId: 'gypsum-board', thickness_m: 0.10 },
        { materialId: 'gypsum-board', thickness_m: 0.10 },
        { materialId: 'gypsum-board', thickness_m: 0.10 },
        { materialId: 'gypsum-board', thickness_m: 0.10 },
      ],
    },
  };

  const out = wallInsetPolygon(room);
  check('C: outer.length === 6', out.outer.length === 6);
  check('C: inner.length === 6', out.inner.length === 6);
  check('C: thicknesses === [0.10, 0.20, 0.10, 0.10, 0.10, 0.10]',
    out.thicknesses.length === 6 &&
    approx(out.thicknesses[0], 0.10) &&
    approx(out.thicknesses[1], 0.20) &&
    approx(out.thicknesses[2], 0.10) &&
    approx(out.thicknesses[3], 0.10) &&
    approx(out.thicknesses[4], 0.10) &&
    approx(out.thicknesses[5], 0.10));

  // Verify each inner vertex analytically.
  check('C: inner v0 ≈ (0.10, 0.10)', vertApprox(out.inner[0], 0.10, 0.10));
  check('C: inner v1 ≈ (7.80, 0.10) — east face uses 200 mm thickness',
    vertApprox(out.inner[1], 7.80, 0.10));
  check('C: inner v2 ≈ (7.80, 3.90) — inner corner from edge1 (0.20) ∩ edge2 (0.10)',
    vertApprox(out.inner[2], 7.80, 3.90));
  check('C: inner v3 ≈ (3.90, 3.90) — concave corner of the L',
    vertApprox(out.inner[3], 3.90, 3.90));
  check('C: inner v4 ≈ (3.90, 7.90)', vertApprox(out.inner[4], 3.90, 7.90));
  check('C: inner v5 ≈ (0.10, 7.90)', vertApprox(out.inner[5], 0.10, 7.90));

  // Same winding as outer (CCW positive).
  const innerArea = signedArea(out.inner);
  const outerArea = signedArea(out.outer);
  check('C: outer signed area > 0 (CCW)', outerArea > 0);
  check('C: inner signed area > 0 (same winding as outer)', innerArea > 0);
}

// =============================================================================
// getWallEdgeThickness resolution order
//   (1) wallSegments override wins
//   (2) cardinal slot wins over default
//   (3) absent → default
// =============================================================================

{
  // (1) wallSegments override
  const roomOverride = {
    shape: 'custom',
    width_m: 5,
    depth_m: 5,
    height_m: 3,
    custom_vertices: [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 },
    ],
    surfaces: {
      edges: [
        { materialId: 'gypsum-board', thickness_m: 0.10 },
        { materialId: 'gypsum-board', thickness_m: 0.10 },
        { materialId: 'gypsum-board', thickness_m: 0.10 },
        { materialId: 'gypsum-board', thickness_m: 0.10 },
      ],
    },
    wallSegments: [
      { id: 'edge_2', x1: 5, y1: 5, x2: 0, y2: 5, thickness_m: 0.40, materialId: 'concrete-painted', openings: [] },
    ],
  };
  check('resolution: wallSegments override wins over edges slot',
    approx(getWallEdgeThickness(roomOverride, 2), 0.40));
  check('resolution: other edges still fall back to slot thickness (0.10)',
    approx(getWallEdgeThickness(roomOverride, 0), 0.10) &&
    approx(getWallEdgeThickness(roomOverride, 1), 0.10) &&
    approx(getWallEdgeThickness(roomOverride, 3), 0.10));

  // (2) cardinal slot beats default
  const roomSlot = {
    shape: 'rectangular',
    width_m: 5,
    depth_m: 5,
    height_m: 3,
    surfaces: {
      wall_north: { materialId: 'gypsum-board', thickness_m: 0.25 },
      wall_south: 'gypsum-board',
      wall_east:  'gypsum-board',
      wall_west:  'gypsum-board',
    },
  };
  check('resolution: cardinal slot thickness wins over default',
    approx(getWallEdgeThickness(roomSlot, 0), 0.25));
  check('resolution: legacy string slot falls back to default 0.10',
    approx(getWallEdgeThickness(roomSlot, 1), DEFAULT_WALL_THICKNESS_M));

  // (3) absent slot → default
  const roomBare = {
    shape: 'rectangular',
    width_m: 5,
    depth_m: 5,
    height_m: 3,
    surfaces: { floor: 'gypsum-board', ceiling: 'gypsum-board' },
  };
  check('resolution: missing slot falls back to default 0.10',
    approx(getWallEdgeThickness(roomBare, 0), DEFAULT_WALL_THICKNESS_M));
}

// =============================================================================
// wallLabelAnchor — inside-face positioning
//   For a horizontal wall at y=0 with direction (+x), inward normal is (0,+1)
//   (CCW polygon convention). Anchor must sit at y > 0 (inside the room).
// =============================================================================

{
  // v1 → v2 in CCW state-frame for the y=0 edge.
  const anchor = wallLabelAnchor({ v1: { x: 0, y: 0 }, v2: { x: 6, y: 0 } }, 0.10);
  check('label: horizontal wall midpoint x = 3.0',
    approx(anchor.x, 3.0));
  check('label: y-offset is INTO the room (positive Y for CCW edge along +x)',
    anchor.y > 0);
  check('label: y-offset is t/2 + small gap (0.05 + 0.01 = 0.06)',
    approx(anchor.y, 0.10 * 0.5 + 0.01),
    `got y=${anchor.y.toFixed(4)}`);
  check('label: rotation_deg === 0 (edge along +x)',
    approx(anchor.rotation_deg, 0));
  check('label: maxChars === 12', anchor.maxChars === 12);

  // Vertical wall at x=0 going DOWN (CCW left-side edge: v1=(0,D), v2=(0,0)).
  // Direction (0,-1), inward normal (+1, 0).
  const left = wallLabelAnchor({ v1: { x: 0, y: 8 }, v2: { x: 0, y: 0 } }, 0.20);
  check('label: left-edge inward offset goes +x (into room)',
    left.x > 0);
  check('label: left-edge inward offset = 0.20/2 + 0.01 = 0.11',
    approx(left.x, 0.20 * 0.5 + 0.01),
    `got x=${left.x.toFixed(4)}`);
  check('label: left-edge midpoint y = 4.0 (centred on edge)',
    approx(left.y, 4.0));
  check('label: left-edge rotation_deg === -90 (edge along -y)',
    approx(left.rotation_deg, -90));

  // Missing thickness → falls back to default 0.10 (anchor offset = 0.06).
  const fallback = wallLabelAnchor({ v1: { x: 0, y: 0 }, v2: { x: 6, y: 0 } });
  check('label: missing thickness uses default 0.10 m (y = 0.06)',
    approx(fallback.y, DEFAULT_WALL_THICKNESS_M * 0.5 + 0.01));
}

// =============================================================================
// Degenerate case — a wall thicker than the room can support
//   5×5 room with edge 0 = 4.0 m thick AND edge 2 (opposite) = 4.0 m thick.
//   Combined inward shift (8.0) exceeds room depth (5) → inner polygon
//   would self-intersect / invert. Documented behaviour: collapse inner
//   to outer centroid. Critical: DO NOT throw, DO NOT crash.
// =============================================================================

{
  const room = {
    shape: 'rectangular',
    width_m: 5,
    depth_m: 5,
    height_m: 3,
    surfaces: {
      wall_north: { materialId: 'concrete-painted', thickness_m: 4.0 },  // y=0 edge
      wall_south: { materialId: 'concrete-painted', thickness_m: 4.0 },  // y=D edge
      wall_east:  { materialId: 'gypsum-board', thickness_m: 0.10 },
      wall_west:  { materialId: 'gypsum-board', thickness_m: 0.10 },
    },
  };
  let crashed = false;
  let result;
  try { result = wallInsetPolygon(room); }
  catch (e) { crashed = true; }
  check('degenerate: does not throw on inverted inset', !crashed);
  check('degenerate: inner.length still === outer.length',
    result && result.inner.length === result.outer.length);
  // Centroid of [(0,0),(5,0),(5,5),(0,5)] = (2.5, 2.5).
  check('degenerate: inner verts collapsed to outer centroid (2.5, 2.5)',
    result &&
    result.inner.every(v => vertApprox(v, 2.5, 2.5)));
}

// =============================================================================
// Round room — synthesised outer polygon (64-gon discretisation),
// concentric inner ring. inner.length === outer.length === 64.
// =============================================================================

{
  const room = {
    shape: 'round',
    width_m: 10,
    depth_m: 10,
    height_m: 3,
    round_radius_m: 5,
    surfaces: {
      floor: 'gypsum-board',
      ceiling: 'gypsum-board',
      walls: { materialId: 'gypsum-board', thickness_m: 0.10 },
    },
  };
  const out = wallInsetPolygon(room);
  check('round: outer.length === inner.length (discretised concentric)',
    out.outer.length === out.inner.length);
  check('round: 64-vertex discretisation matches roomPlanVertices convention',
    out.outer.length === 64);
  // The inner ring sits ~0.10 m inside the outer ring along each radial.
  // For a 64-gon inscribed in radius r, the inner offset by t produces a
  // polygon at radius (r − t / cos(π/n)) — i.e. the offset distance from
  // the polygon's centre is slightly more than t because the inset crosses
  // chord midpoints not vertices. Just sanity-check the inner radius is
  // between r − 2t and r − 0.5t (loose envelope).
  const r = 5;
  const cx = 5, cy = 5;
  let radiusOK = true;
  for (const v of out.inner) {
    const rr = Math.hypot(v.x - cx, v.y - cy);
    if (rr > r - 0.10 * 0.5 || rr < r - 0.10 * 2.0) { radiusOK = false; break; }
  }
  check('round: every inner vertex sits in [r − 2t, r − 0.5t] envelope',
    radiusOK);
}

// =============================================================================
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
