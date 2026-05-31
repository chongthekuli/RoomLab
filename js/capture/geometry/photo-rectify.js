// Room Capture — photo-trace rectify STRATEGY (pure, Node-testable). No DOM, no
// Three.js, no npm. Built ON ./homography.js (the tested 4-point DLT solve); we
// do NOT re-implement the solver here. See docs/ROOM_CAPTURE_PLAN.md §3, §6.
//
// ─────────────────────────────────────────────────────────────────────────
// THE CV DECISION (settled 2026-05-31, Viktor):
//
//   What the user taps:  the 4 FLOOR corners of a roughly-rectangular room,
//                        in the photo, in order around the perimeter.
//   What we rectify to:  an AXIS-ALIGNED rectangle in plan space.
//   Destination aspect:  (a) ASSUME 1:1 (square) and let the user fix the true
//                        proportion by dragging in the editor + the scale-anchor
//                        step. We do NOT recover aspect from vanishing geometry.
//
// Why (a) and not (b) recover-aspect-from-vanishing-points:
//   The metric-rectification route (Zhang / Kosecka: two orthogonal vanishing
//   points → intrinsics → true aspect) needs accurate vanishing-point estimates,
//   typically RANSAC line detection over the whole image, AND a focal-length /
//   orthogonality assumption. On a phone, with a non-expert tapping 4 fat-finger
//   corners on a floor that may not be a clean rectangle, those inputs are noisy
//   and the recovered aspect is unstable — a small tap error swings it 20–40%.
//   It is fragile exactly where our user is weakest. The scale-anchor step
//   already forces the user to pin ONE real edge length; pairing "1:1 guess +
//   drag-to-correct + anchor one edge" is honest, robust, and never produces a
//   wildly-wrong-but-confident plan. "Rough, then drag" is the product model
//   (plan §9 Q3). Sources in the deliverable writeup.
//
//   Consequence: rectifyFloorQuad returns a plan polygon in ARBITRARY units
//   (the destination square is unit-sized). scaleResolved stays FALSE until the
//   user anchors one edge to a real length (scale-anchor.js). The destination
//   square's size is irrelevant — the anchor rescales the whole polygon.
// ─────────────────────────────────────────────────────────────────────────
//
// >4 corners (non-rectangular rooms): described but NOT the MVP. A general
// N-gon floor needs either (i) a known-rectangle sub-quad to fit the homography
// then map the remaining tapped corners through it (image→plan via the SAME H),
// or (ii) per-wall multi-photo capture. rectifyFloorQuad already exposes the
// hook: pass the 4 corners that bound a rectangular reference (e.g. the main
// floor rectangle) as `imageCorners4`, and extra interior/notch corners via
// `opts.extraImagePoints`; they are mapped through the same H so an L-shape is
// supported as "fit the big rectangle, then drag the notch". Default MVP path
// is the 4-corner rectangular case + drag-to-correct in the editor.

import { solveHomography, applyHomography } from './homography.js';

// Orientation note (+y = north): the destination rectangle is laid out with
// corner[0] at plan-origin and +Y increasing toward corner[3] (see DST_UNIT).
// The MODE is responsible for asking the user to tap corners starting at the
// FAR-LEFT floor corner going CLOCKWISE in the image, so the rectified polygon
// lands with the room's "far" wall toward +y. The mapping the mode applies, and
// the +y=north contract, is documented in photo-trace-mode.js and flagged to Sam
// for tests/cross-surface-conventions.test.mjs. This pure module only guarantees
// a consistent, CCW-able, axis-aligned output for a given tap order.

/**
 * Canonical destination quad: a UNIT square in plan space. Tap order is
 * [topLeft, topRight, bottomRight, bottomLeft] in the IMAGE (clockwise from the
 * far-left floor corner). We map that to:
 *   src[0] (far-left)   → (0, 1)   far wall, left   (+y is "far"/north)
 *   src[1] (far-right)  → (1, 1)   far wall, right
 *   src[2] (near-right) → (1, 0)   near wall, right
 *   src[3] (near-left)  → (0, 0)   near wall, left  (plan origin-ish)
 * So image "up/far" becomes plan +y, and image "right" becomes plan +x — a plain
 * top-down view with north up, the same convention the 2D/3D/print surfaces use.
 */
const DST_UNIT = Object.freeze([
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: 0 },
  { x: 0, y: 0 },
]);

/**
 * Are 4 points too collinear to define a quad? Rejects the degenerate-tap case
 * (homography would be singular / unstable) BEFORE we hand bad data to the
 * solver. Returns true if any three consecutive corners are near-collinear or
 * the quad has near-zero area.
 * @param {{x:number,y:number}[]} pts length-4
 */
export function isDegenerateQuad(pts) {
  if (!Array.isArray(pts) || pts.length < 4) return true;
  for (const p of pts) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return true;
  }
  // Shoelace area; near-zero ⇒ collapsed/collinear.
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  // Scale the area threshold by the quad's own size so it's resolution-agnostic
  // (image pixels vs normalised coords both work). Bounding-box diagonal²·ε.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  const diag2 = (maxX - minX) ** 2 + (maxY - minY) ** 2;
  if (diag2 < 1e-9) return true;
  if (area < diag2 * 1e-4) return true;   // < 0.01% of bbox → collinear-ish
  // Any three consecutive corners near-collinear (a "spike") also degenerate.
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const tri = Math.abs(cross) / 2;
    if (tri < diag2 * 1e-4) return true;
  }
  return false;
}

/**
 * Rectify a tapped floor quad to an axis-aligned plan polygon (arbitrary units).
 *
 * @param {{x:number,y:number}[]} imageCorners4  the 4 floor corners tapped in
 *   the image, CLOCKWISE from the far-left floor corner: [farLeft, farRight,
 *   nearRight, nearLeft]. Pixel coords (origin top-left) are fine.
 * @param {Object} [opts]
 * @param {{x:number,y:number}[]} [opts.extraImagePoints]  additional image
 *   points (notch corners for an L-shape) to map through the SAME homography,
 *   APPENDED to the 4 rectified corners in the returned polygon. The caller owns
 *   their insertion order. (Non-MVP hook — default [].)
 * @returns {{x:number,y:number}[]|null}  plan-space polygon (unscaled, +y=north,
 *   CCW not guaranteed — caller may ensureCCW), or null if the quad is
 *   degenerate / the homography is singular (caller prompts a re-tap).
 */
export function rectifyFloorQuad(imageCorners4, opts = {}) {
  if (isDegenerateQuad(imageCorners4)) return null;
  // Solve H: image quad → unit plan square. (Note the direction — we map the
  // image corners to the KNOWN destination, so applying H to any image point
  // lands it in plan space. invertHomography(H) draws the plan grid back onto
  // the photo for the live preview — that's done in the mode, not here.)
  const H = solveHomography(imageCorners4.slice(0, 4), DST_UNIT);
  if (!H) return null;

  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = applyHomography(H, imageCorners4[i]);
    if (!p) return null;            // mapped to infinity → reject, re-tap
    out.push(p);
  }
  // Extra (notch) image points mapped through the same H — non-MVP N-gon hook.
  const extra = Array.isArray(opts.extraImagePoints) ? opts.extraImagePoints : [];
  for (const ip of extra) {
    const p = applyHomography(H, ip);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

export { DST_UNIT };
