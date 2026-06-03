// Room Capture — scale-anchor + origin-normalize geometry. PURE: no DOM, no
// Three.js, Node-testable (same discipline as js/physics/). Every capture mode
// funnels its rough polygon through these before it reaches the shared editor /
// commit path, so the "anchor scale with ONE known dimension" + "vertex[0] is
// the origin" rules live in exactly one place.
//
// Coordinate frame: metres, floor plane, state +y = north. A polygon is an
// array of {x, y}. See docs/ROOM_CAPTURE_PLAN.md §1, §6.

// Region-aware standard interior door width (metres) — the fallback scale
// anchor when the user has no tape measure. US residential 32" ≈ 0.81 m is the
// safe default; metric markets ~0.76–0.81 m. (Sourced in the plan doc Q4.)
const DOOR_WIDTH_M = Object.freeze({
  US: 0.81,    // 32" residential interior (ADA clear-opening nominal leaf)
  UK: 0.762,   // 2'6" common internal
  EU: 0.80,    // common metric leaf
  default: 0.81,
});

export function doorWidthDefault(region) {
  return DOOR_WIDTH_M[region] ?? DOOR_WIDTH_M.default;
}

// Length of edge i: from vertices[i] to vertices[(i+1) % n].
export function edgeLength(vertices, edgeIndex) {
  if (!Array.isArray(vertices) || vertices.length < 2) return 0;
  const n = vertices.length;
  const a = vertices[((edgeIndex % n) + n) % n];
  const b = vertices[((edgeIndex + 1) % n + n) % n];
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// Uniformly rescale the whole polygon so edge `edgeIndex` measures
// `targetLen_m`. Scales about the geometric mean of the vertices (stable —
// independent of which vertex is [0]); the downstream normalizeOrigin re-shifts
// to vertex[0]=(0,0) anyway, so the scale centre only affects intermediate
// coords, never the committed shape. Returns a NEW array; input untouched.
// No-ops (returns a copy) when the chosen edge is degenerate or the target is
// non-positive, so a fat-finger can't collapse the room to a point.
export function rescalePolygonToEdgeLength(vertices, edgeIndex, targetLen_m) {
  const cur = edgeLength(vertices, edgeIndex);
  if (!(cur > 1e-9) || !(targetLen_m > 0) || !Number.isFinite(targetLen_m)) {
    return vertices.map(v => ({ x: v.x, y: v.y }));
  }
  const k = targetLen_m / cur;
  let cx = 0, cy = 0;
  for (const v of vertices) { cx += v.x; cy += v.y; }
  cx /= vertices.length; cy /= vertices.length;
  return vertices.map(v => ({ x: cx + (v.x - cx) * k, y: cy + (v.y - cy) * k }));
}

// Shift the polygon so vertex[0] = (0, 0) — the RoomLAB custom-room convention
// (predictable origin for saved-room library entries regardless of which corner
// the user started at) — and derive the bounding-box extents. This is the logic
// previously inlined in room-2d.js finishDraw, lifted here so every capture mode
// AND the tests share one implementation.
//
// Returns { vertices, width_m, depth_m }. width_m/depth_m are clamped to ≥0.5 m
// (matches the room-2d floor on a sliver draw).
export function normalizeOrigin(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) {
    return { vertices: [], width_m: 0.5, depth_m: 0.5 };
  }
  const ox = vertices[0].x;
  const oy = vertices[0].y;
  const shifted = vertices.map(v => ({ x: v.x - ox, y: v.y - oy }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of shifted) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  return {
    vertices: shifted,
    width_m: Math.max(maxX - minX, 0.5),
    depth_m: Math.max(maxY - minY, 0.5),
  };
}
