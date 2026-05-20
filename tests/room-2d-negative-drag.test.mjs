// 2D drag clamp — negative-coordinate regression.
//
// 2026-05-20: user reported that clicking a room node / audience /
// speaker positioned at negative X or Y instantly snapped it to 0,
// and they could only drag it to positive coordinates from then on.
// Root cause: roomEffectiveBounds() returns {minX: 0, minY: 0, ...}
// for any non-surau room, and the drag-clamp at room-2d.js:2240-2242
// (+ the vertex clamp at :2300-2301) applied that floor unconditionally
// — the very first drag tick at start = (-2, 0) computed
// max(0+margin, -2) = margin = 0.5, teleporting the item.
//
// The fix extracts the clamp math into two pure helpers
// (clampDragTargetToBounds for sources/listeners/treatments,
// clampVertexDragTarget for room vertices) that expand the clamp to
// include the drag-start position when start sits outside normal
// bounds. This file pins that behaviour.

import { clampDragTargetToBounds, clampVertexDragTarget } from '../js/graphics/room-2d.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function near(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

// Standard non-surau room: 10 × 10, no enclosures, no podium.
const ROOM_BOUNDS = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
const MARGIN = 0.5;

// ---- clampDragTargetToBounds (sources / listeners / treatments) ----

// Case 1: in-room item, in-room target → normal margin clamp.
{
  const { x, y } = clampDragTargetToBounds({
    targetX: 5, targetY: 5, startX: 5, startY: 5,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, 5) && near(y, 5),
    'in-room target stays at target (5, 5)');
}

// Case 2: in-room start, target pushed off west wall → clamped to margin.
{
  const { x } = clampDragTargetToBounds({
    targetX: -1, targetY: 5, startX: 5, startY: 5,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, MARGIN),
    `in-room start, target -1 west → clamped to margin (0.5); got ${x}`);
}

// Case 3: in-room start, target pushed off east wall → clamped to width-margin.
{
  const { x } = clampDragTargetToBounds({
    targetX: 100, targetY: 5, startX: 5, startY: 5,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, 10 - MARGIN),
    `in-room start, target +100 east → clamped to maxX-margin (9.5); got ${x}`);
}

// Case 4: THE BUG — start at negative X, tiny drag (target ≈ start).
// Pre-fix this returned x = margin (0.5), teleporting the item from
// -2 to +0.5 on first click. Post-fix it must return the start position.
{
  const { x, y } = clampDragTargetToBounds({
    targetX: -2, targetY: 5, startX: -2, startY: 5,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, -2),
    `start at -2, target -2 (no drag) → must NOT snap to 0; got ${x}`);
  assert(near(y, 5),
    `Y unchanged on a pure-X negative start; got ${y}`);
}

// Case 5: start at negative X, drag further negative within halo (default 5 m).
{
  const { x } = clampDragTargetToBounds({
    targetX: -5, targetY: 5, startX: -2, startY: 5,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, -5),
    `start -2, target -5 (within halo) → reached; got ${x}`);
}

// Case 6: start at negative X, drag MORE negative than halo allows → clamped.
{
  const { x } = clampDragTargetToBounds({
    targetX: -20, targetY: 5, startX: -2, startY: 5,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, -2 - 5),
    `start -2, target -20 → clamped to start-halo (-7); got ${x}`);
}

// Case 7: start at negative X, drag BACK toward room → reaches in-room target.
{
  const { x } = clampDragTargetToBounds({
    targetX: 3, targetY: 5, startX: -2, startY: 5,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, 3),
    `start -2, target +3 (in room) → reached; got ${x}`);
}

// Case 8: start beyond east wall (e.g. x = 12), drag east → halo expansion on max side.
{
  const { x } = clampDragTargetToBounds({
    targetX: 15, targetY: 5, startX: 12, startY: 5,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, 15),
    `start +12, target +15 (within halo) → reached; got ${x}`);
}

// Case 9: start beyond east wall, tiny drag → does not snap to maxX-margin.
{
  const { x } = clampDragTargetToBounds({
    targetX: 12, targetY: 5, startX: 12, startY: 5,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, 12),
    `start +12, target +12 (no drag) → must NOT snap to 9.5; got ${x}`);
}

// Case 10: both axes negative — Y also gets the same treatment.
{
  const { x, y } = clampDragTargetToBounds({
    targetX: -3, targetY: -4, startX: -3, startY: -4,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, -3) && near(y, -4),
    'start (-3, -4), target same → no snap on either axis');
}

// Case 11: in-room start, in-room target near edge — margin still respected.
// (This guards against the fix accidentally widening margins for normal use.)
{
  const { x } = clampDragTargetToBounds({
    targetX: 0.1, targetY: 5, startX: 5, startY: 5,
    bounds: ROOM_BOUNDS, margin: MARGIN,
  });
  assert(near(x, MARGIN),
    `in-room start, target 0.1 (inside margin) → clamped to margin; got ${x}`);
}

// ---- clampVertexDragTarget (room vertices) ------------------------

// Case V1: in-quadrant vertex, in-quadrant target → unchanged.
{
  const { x, y } = clampVertexDragTarget({
    targetX: 3, targetY: 4, startX: 3, startY: 4,
  });
  assert(near(x, 3) && near(y, 4),
    'vertex in-quadrant: target preserved');
}

// Case V2: in-quadrant vertex, target pushed negative → floor at 0.
{
  const { x } = clampVertexDragTarget({
    targetX: -1, targetY: 4, startX: 3, startY: 4,
  });
  assert(near(x, 0),
    `vertex in-quadrant, target -1 → floor at 0; got ${x}`);
}

// Case V3: THE BUG — vertex at negative X, tiny drag.
// Pre-fix: Math.max(0, -2) = 0 → vertex teleports.
// Post-fix: floor expands to min(0, -2-5) = -7, target stays at -2.
{
  const { x, y } = clampVertexDragTarget({
    targetX: -2, targetY: 5, startX: -2, startY: 5,
  });
  assert(near(x, -2),
    `vertex start -2, target -2 (no drag) → must NOT snap to 0; got ${x}`);
  assert(near(y, 5), 'Y unchanged on pure-X negative vertex start');
}

// Case V4: negative vertex, drag within halo.
{
  const { x } = clampVertexDragTarget({
    targetX: -4, targetY: 5, startX: -2, startY: 5,
  });
  assert(near(x, -4),
    `vertex start -2, target -4 (within halo) → reached; got ${x}`);
}

// Case V5: negative vertex, drag back into positive — works.
{
  const { x } = clampVertexDragTarget({
    targetX: 6, targetY: 5, startX: -2, startY: 5,
  });
  assert(near(x, 6),
    `vertex start -2, target +6 → reached; got ${x}`);
}

// Case V6: negative vertex, drag MORE negative than halo → clamped.
{
  const { x } = clampVertexDragTarget({
    targetX: -50, targetY: 5, startX: -2, startY: 5,
  });
  assert(near(x, -2 - 5),
    `vertex start -2, target -50 → clamped to start-halo (-7); got ${x}`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll 2D negative-drag clamp tests passed.');
