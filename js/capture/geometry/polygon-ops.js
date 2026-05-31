// Room Capture — pure polygon operations shared by the live editor and tests.
// PURE: no DOM, no Three.js, Node-testable. The interaction layer (room-2d.js,
// touch handlers) is a thin shell over these so the math is verified
// independently of the canvas — directly attacking the untested-custom-draw gap
// (CLAUDE.md §6 #1). See docs/ROOM_CAPTURE_PLAN.md §5.
//
// Polygon = array of {x, y} in metres, floor plane, state +y = north.

// Signed area (shoelace). > 0 = counter-clockwise in a +y-up frame.
export function signedArea(vertices) {
  const n = vertices.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = vertices[i];
    const q = vertices[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// Return the polygon wound counter-clockwise (positive signed area). Reverses a
// copy when needed; input untouched. Keeps downstream surface/winding-sensitive
// code (triangulation, wall-id ordering) on a single convention.
export function ensureCCW(vertices) {
  const out = vertices.map(v => ({ x: v.x, y: v.y }));
  if (signedArea(out) < 0) out.reverse();
  return out;
}

// Insert a new vertex at the midpoint of edge `edgeIndex` (between vertices[i]
// and vertices[(i+1)%n]) — the "+"-handle edge-insert in the editor. Returns a
// NEW array; input untouched.
export function insertVertexOnEdge(vertices, edgeIndex) {
  const n = vertices.length;
  if (n < 2) return vertices.map(v => ({ x: v.x, y: v.y }));
  const i = ((edgeIndex % n) + n) % n;
  const a = vertices[i];
  const b = vertices[(i + 1) % n];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const out = vertices.map(v => ({ x: v.x, y: v.y }));
  out.splice(i + 1, 0, mid);
  return out;
}

// Do two segments p1-p2 and p3-p4 properly intersect (cross, not merely touch
// at a shared endpoint)? Used by isSelfIntersecting.
function segmentsCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;   // collinear / endpoint-touch cases are NOT "self-intersecting"
}

// Does the closed polygon have any pair of non-adjacent edges that cross? A
// self-intersecting "bowtie" breaks RT60 surface area + the precision tracer, so
// commitCapturedRoom should reject (or the editor should warn) on true.
export function isSelfIntersecting(vertices) {
  const n = vertices.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = vertices[i], a2 = vertices[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent edges (share a vertex) and the wrap-around adjacency.
      if (j === i) continue;
      if ((j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = vertices[j], b2 = vertices[(j + 1) % n];
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

// Snap a corner toward a right angle: given the previous vertex, the corner
// being edited, and the next vertex, if the interior angle is within tolDeg of
// 90° (or 180°, a straight run), nudge the corner so the incoming edge meets the
// outgoing edge orthogonally — by projecting the corner onto the axis that makes
// prev→corner perpendicular to corner→next. PURE; returns a possibly-moved
// {x, y}. Real rooms are mostly rectilinear, so this makes rough drags click
// into clean corners. Returns the corner unchanged when no snap applies.
export function snapToRightAngle(prev, corner, next, tolDeg = 8) {
  const v1 = { x: corner.x - prev.x, y: corner.y - prev.y };
  const v2 = { x: next.x - corner.x, y: next.y - corner.y };
  const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
  if (l1 < 1e-6 || l2 < 1e-6) return { x: corner.x, y: corner.y };
  const dot = (v1.x * v2.x + v1.y * v2.y) / (l1 * l2);
  const ang = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
  // Only snap near 90°. (180° "straight run" is left alone — that's a vertex the
  // user probably wants to keep or delete, not orthogonalise.)
  if (Math.abs(ang - 90) > tolDeg) return { x: corner.x, y: corner.y };
  // Make corner→next perpendicular to prev→corner: keep the corner on the line
  // through `next` along the direction perpendicular to v1, nearest the corner.
  const u = { x: v1.x / l1, y: v1.y / l1 };           // incoming edge dir
  const perp = { x: -u.y, y: u.x };                    // perpendicular
  // Project (corner - next) onto perp, place corner = next + perp*proj so the
  // outgoing edge is exactly perpendicular to the incoming one.
  const dx = corner.x - next.x, dy = corner.y - next.y;
  const proj = dx * perp.x + dy * perp.y;
  return { x: next.x + perp.x * proj, y: next.y + perp.y * proj };
}
