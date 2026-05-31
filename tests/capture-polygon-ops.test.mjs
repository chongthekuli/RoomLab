// Room Capture — pure polygon operations.
// Run: node tests/capture-polygon-ops.test.mjs

import { signedArea, ensureCCW, insertVertexOnEdge, isSelfIntersecting, snapToRightAngle }
  from '../js/capture/geometry/polygon-ops.js';

let failed = 0;
function assert(c, l) { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; }
const approx = (a, b, t = 1e-9) => Math.abs(a - b) <= t;

const CCW = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];          // area +12
const CW = [{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: 4, y: 3 }, { x: 4, y: 0 }];           // area -12

// --- signedArea + ensureCCW ----------------------------------------------
assert(approx(signedArea(CCW), 12), 'signedArea CCW square = +12');
assert(approx(signedArea(CW), -12), 'signedArea CW square = -12');
assert(signedArea(ensureCCW(CW)) > 0, 'ensureCCW flips a CW polygon to CCW');
assert(signedArea(ensureCCW(CCW)) > 0, 'ensureCCW leaves a CCW polygon CCW');
assert(CW[1].y === 3, 'ensureCCW does not mutate input');

// --- insertVertexOnEdge ---------------------------------------------------
{
  const out = insertVertexOnEdge(CCW, 0);     // midpoint of v0→v1 = (2,0)
  assert(out.length === 5, 'insertVertexOnEdge adds one vertex');
  assert(approx(out[1].x, 2) && approx(out[1].y, 0), 'inserted midpoint at (2,0) after edge0');
  assert(CCW.length === 4, 'insertVertexOnEdge does not mutate input');
  const wrap = insertVertexOnEdge(CCW, 3);    // closing edge v3→v0 midpoint (0,1.5)
  assert(approx(wrap[4].x, 0) && approx(wrap[4].y, 1.5), 'insert on closing edge wraps correctly');
}

// --- isSelfIntersecting ---------------------------------------------------
assert(isSelfIntersecting(CCW) === false, 'simple square is not self-intersecting');
{
  // bowtie: 0,0 → 4,0 → 0,3 → 4,3 (edges cross)
  const bowtie = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }, { x: 4, y: 3 }];
  assert(isSelfIntersecting(bowtie) === true, 'bowtie IS self-intersecting (commit must reject)');
  // L-shape (concave but simple) must NOT be flagged
  const L = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 8 }, { x: 0, y: 8 }];
  assert(isSelfIntersecting(L) === false, 'concave L-shape is simple (not self-intersecting)');
}

// --- snapToRightAngle -----------------------------------------------------
{
  // corner near 90° but slightly off → snaps so incoming ⟂ outgoing
  const prev = { x: 0, y: 0 }, next = { x: 4, y: 4 };
  const corner = { x: 0.2, y: 4 };            // ~near a right angle at corner
  const snapped = snapToRightAngle(prev, corner, next, 12);
  const v1 = { x: snapped.x - prev.x, y: snapped.y - prev.y };
  const v2 = { x: next.x - snapped.x, y: next.y - snapped.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  assert(Math.abs(dot) < 1e-6, `snapToRightAngle makes edges perpendicular (dot=${dot.toFixed(4)})`);
  // a clearly non-right corner (~150°) is left alone
  const oblique = snapToRightAngle({ x: 0, y: 0 }, { x: 5, y: 0.2 }, { x: 9, y: 0 }, 8);
  assert(approx(oblique.x, 5) && approx(oblique.y, 0.2), 'snapToRightAngle leaves a non-right corner unchanged');
}

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll capture polygon-ops tests passed.');
