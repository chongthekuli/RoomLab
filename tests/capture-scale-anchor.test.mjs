// Room Capture — scale-anchor + origin-normalize geometry (pure).
// Run: node tests/capture-scale-anchor.test.mjs

import { normalizeOrigin, rescalePolygonToEdgeLength, edgeLength, doorWidthDefault }
  from '../js/capture/geometry/scale-anchor.js';

let failed = 0;
function assert(c, l) { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; }
const approx = (a, b, t = 1e-9) => Math.abs(a - b) <= t;

// --- normalizeOrigin: vertex[0] → (0,0), bbox derive (matches room-2d) ----
{
  const poly = [{ x: 5, y: 3 }, { x: 11, y: 3 }, { x: 11, y: 8 }, { x: 5, y: 8 }];
  const { vertices, width_m, depth_m } = normalizeOrigin(poly);
  assert(vertices[0].x === 0 && vertices[0].y === 0, 'normalizeOrigin: vertex[0] = (0,0)');
  assert(approx(width_m, 6) && approx(depth_m, 5), `bbox derive width=6 depth=5 (got ${width_m},${depth_m})`);
  // relative shape preserved
  assert(approx(vertices[1].x, 6) && approx(vertices[2].y, 5), 'normalizeOrigin: relative shape preserved');
  assert(poly[0].x === 5, 'normalizeOrigin does not mutate input');
}
{
  // sliver → width/depth floored at 0.5
  const { width_m, depth_m } = normalizeOrigin([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.05, y: 0.1 }]);
  assert(width_m >= 0.5 && depth_m >= 0.5, 'normalizeOrigin: sliver floored to ≥0.5 m');
}

// --- edgeLength ------------------------------------------------------------
{
  const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
  assert(approx(edgeLength(sq, 0), 4), 'edgeLength edge0 = 4');
  assert(approx(edgeLength(sq, 1), 3), 'edgeLength edge1 = 3');
  assert(approx(edgeLength(sq, 3), 3), 'edgeLength wraps (edge3 closes to v0) = 3');
}

// --- rescalePolygonToEdgeLength: anchor scale from one known dimension -----
{
  // A "unit" square from photo-trace; anchor edge0 to a real 3.2 m wall.
  const unit = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const scaled = rescalePolygonToEdgeLength(unit, 0, 3.2);
  assert(approx(edgeLength(scaled, 0), 3.2), 'rescale: anchored edge becomes 3.2 m');
  assert(approx(edgeLength(scaled, 1), 3.2), 'rescale: uniform — square stays square (edge1 also 3.2)');
  // shape preserved after re-normalizing origin
  const norm = normalizeOrigin(scaled);
  assert(approx(norm.width_m, 3.2) && approx(norm.depth_m, 3.2), 'rescale→normalize: 3.2×3.2 bbox');
}
{
  // degenerate / non-positive guards — must not collapse the room
  const sq = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
  const a = rescalePolygonToEdgeLength(sq, 0, 0);
  assert(approx(edgeLength(a, 0), 2), 'rescale: target 0 is a no-op (no collapse)');
  const b = rescalePolygonToEdgeLength([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }], 0, 5);
  assert(b.length === 3, 'rescale: degenerate (zero-length) edge is a no-op copy');
}

// --- doorWidthDefault ------------------------------------------------------
{
  assert(approx(doorWidthDefault('US'), 0.81), 'door width US = 0.81 m');
  assert(approx(doorWidthDefault('UK'), 0.762), 'door width UK = 0.762 m');
  assert(approx(doorWidthDefault('nope'), 0.81), 'door width unknown region → default 0.81 m');
}

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll capture scale-anchor tests passed.');
