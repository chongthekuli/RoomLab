// Non-overlapping placement for wall openings (doors / windows).
//
// Real walls can't have a door and a window (or two doors) occupying the same
// span. Both DEFAULT_DOOR and DEFAULT_WINDOW used to spawn at x_m = 0.5, so a
// door + window on the same wall stacked on top of each other (user report,
// 2026-06-05). This picks a left-edge x for a NEW opening that doesn't overlap
// the existing ones: packed to the right of the rightmost, else into the first
// gap from the wall start, else clamped to the wall end.
//
// Pure — no DOM, no state. Node-testable. (wallLengthFor stays in panel-room.js
// because it reads room geometry; this is just the packing arithmetic.)

const GAP_M = 0.1;   // reveal between adjacent openings

/**
 * @param {Array}  openings  existing openings on the wall ({x_m, width_m, system?})
 * @param {number} width     width (m) of the opening being added
 * @param {number|null} wallLen  along-wall length (m), or null when unknown
 * @returns {number} left-edge x_m for the new opening
 */
export function placeOpeningX(openings, width, wallLen) {
  const w = Math.max(0.1, Number(width) || 0.9);
  const len = Number.isFinite(wallLen) && wallLen > 0 ? wallLen : null;
  const existing = (openings || [])
    .filter(o => o && !o.system && Number.isFinite(o.x_m) && Number.isFinite(o.width_m))
    .map(o => [Number(o.x_m), Number(o.x_m) + Number(o.width_m)])
    .sort((a, b) => a[0] - b[0]);

  if (existing.length === 0) {
    const def = 0.5;
    return len ? Math.max(0, Math.min(def, len - w)) : def;
  }

  const rightmost = existing.reduce((mx, [, r]) => Math.max(mx, r), 0);
  const x = rightmost + GAP_M;
  if (!len || x + w <= len) return Math.max(0, x);

  // No room to the right — scan for the first gap from the wall start.
  let cursor = 0;
  for (const [l, r] of existing) {
    if (l - cursor >= w + GAP_M) return cursor;
    cursor = Math.max(cursor, r + GAP_M);
  }
  // Last resort: clamp to the wall end (wall too short to hold both without
  // touching — the user can resize; never a stacked same-x overlap).
  return Math.max(0, len - w);
}
