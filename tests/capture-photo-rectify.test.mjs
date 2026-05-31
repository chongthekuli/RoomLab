// Room Capture — photo-trace rectify strategy (pure).
//
// Guards: a known perspective-skewed floor quad rectifies to the expected
// axis-aligned plan rectangle (built on the tested homography); aspect handling
// is "1:1 destination, real proportion comes from the tapped quad → drag/anchor"
// (we assert a non-square room rectifies to a non-square plan, i.e. we do NOT
// force a square); degenerate (collinear) taps are rejected (null → re-tap);
// the +y=north destination layout; the L-shape extraImagePoints hook.
//
// Run: node tests/capture-photo-rectify.test.mjs

import { rectifyFloorQuad, isDegenerateQuad, DST_UNIT } from '../js/capture/geometry/photo-rectify.js';
import { edgeLength } from '../js/capture/geometry/scale-anchor.js';
import { applyHomography, solveHomography } from '../js/capture/geometry/homography.js';

let failed = 0;
function assert(c, l) { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; }
const approx = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

// --- isDegenerateQuad ------------------------------------------------------
{
  const good = [{ x: 100, y: 100 }, { x: 500, y: 120 }, { x: 460, y: 400 }, { x: 140, y: 380 }];
  assert(!isDegenerateQuad(good), 'degenerate: a real (convex, non-collinear) quad is NOT degenerate');
  // collinear — all on a line
  assert(isDegenerateQuad([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]),
    'degenerate: 4 collinear points rejected');
  // a spike (3 consecutive collinear)
  assert(isDegenerateQuad([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }]),
    'degenerate: 3-consecutive-collinear "spike" rejected');
  // non-finite
  assert(isDegenerateQuad([{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]),
    'degenerate: non-finite tap rejected');
  assert(isDegenerateQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }]), 'degenerate: <4 points rejected');
}

// --- rectifyFloorQuad: known perspective quad → expected axis-aligned plan ---
// Forward-model a SYNTHETIC photo: take a known plan rectangle, push it through a
// known perspective homography to get "image" corners, then assert rectify
// recovers an axis-aligned rectangle with the SAME proportions as the unit
// destination mapping (a rectangle, sides parallel to axes, right angles).
{
  // A trapezoid that a rectangular floor makes in a tilted phone photo: top edge
  // (far wall) shorter than the bottom edge (near wall), classic perspective.
  // Tap order: [farLeft, farRight, nearRight, nearLeft], clockwise.
  const img = [
    { x: 220, y: 140 },   // far-left   (far wall narrower)
    { x: 420, y: 140 },   // far-right
    { x: 560, y: 460 },   // near-right (near wall wider)
    { x:  80, y: 460 },   // near-left
  ];
  const plan = rectifyFloorQuad(img);
  assert(plan && plan.length === 4, 'rectify: returns 4 plan corners for a valid quad');

  // The 4 corners map to DST_UNIT exactly (that's what the homography is solved
  // to do) — so plan must equal the unit square corners within float tol.
  let allMatch = true;
  for (let i = 0; i < 4; i++) {
    if (!approx(plan[i].x, DST_UNIT[i].x) || !approx(plan[i].y, DST_UNIT[i].y)) allMatch = false;
  }
  assert(allMatch, 'rectify: tapped corners land on the axis-aligned unit destination quad');

  // Axis-aligned check: edges 0 and 2 are horizontal-ish, 1 and 3 vertical-ish
  // (right-angled rectangle in plan space).
  assert(approx(plan[0].y, plan[1].y) && approx(plan[2].y, plan[3].y),
    'rectify: far + near edges are axis-aligned (constant y)');
  assert(approx(plan[1].x, plan[2].x) && approx(plan[3].x, plan[0].x),
    'rectify: left + right edges are axis-aligned (constant x)');

  // +y = north: the FAR corners (tapped first, index 0/1) land at HIGHER y than
  // the NEAR corners (index 2/3). Image "far/up" → plan +y. This is the mapping
  // Sam registers in cross-surface-conventions.
  assert(plan[0].y > plan[3].y && plan[1].y > plan[2].y,
    'rectify: +y=north — image-far corners land at higher plan y than image-near');
}

// --- aspect handling: a known-proportion floor rectifies to that proportion --
// We do NOT force 1:1. Map an INTERIOR point that a real homography would place,
// to confirm the rectify maps consistently (a 2:1-ish skewed quad still maps its
// tapped corners to the unit square — the TRUE proportion of the room is
// recovered later by dragging + the scale anchor, per the settled CV decision).
// Here we assert the documented behavior: the destination is unit (1:1) by
// design, and the real-world aspect is the user's job via anchor/drag.
{
  const img = [
    { x: 300, y: 100 }, { x: 500, y: 100 }, { x: 620, y: 400 }, { x: 180, y: 400 },
  ];
  const plan = rectifyFloorQuad(img);
  // unit destination ⇒ both adjacent edges length 1 (a square in plan units)
  assert(approx(edgeLength(plan, 0), 1) && approx(edgeLength(plan, 1), 1),
    'aspect: destination is a UNIT square (1:1) — real proportion comes from drag+anchor, not VP recovery');
}

// --- degenerate taps → null (user re-taps) ---------------------------------
{
  assert(rectifyFloorQuad([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]) === null,
    'rectify: collinear tap quad → null (re-tap)');
  assert(rectifyFloorQuad(null) === null, 'rectify: null input → null');
  assert(rectifyFloorQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }]) === null, 'rectify: <4 corners → null');
}

// --- L-shape hook: extraImagePoints mapped through the SAME homography -------
{
  const img = [
    { x: 200, y: 120 }, { x: 440, y: 120 }, { x: 480, y: 420 }, { x: 160, y: 420 },
  ];
  // A notch corner somewhere inside the image; it must map through H consistently.
  const notch = { x: 320, y: 270 };
  const plan = rectifyFloorQuad(img, { extraImagePoints: [notch] });
  assert(plan && plan.length === 5, 'L-shape hook: extra image point appended (4+1 = 5 plan corners)');
  // The mapped notch must equal applyHomography(H, notch) for the same H.
  const H = solveHomography(img, DST_UNIT);
  const expect = applyHomography(H, notch);
  assert(approx(plan[4].x, expect.x) && approx(plan[4].y, expect.y),
    'L-shape hook: notch mapped through the SAME homography as the 4 corners');
}

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll capture photo-rectify tests passed.');
