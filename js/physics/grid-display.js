// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Chong Ching Yong (chongthekuli). All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// js/physics/grid-display.js
//
// DISPLAY-ONLY grid post-processing. Never feed this output back into any
// metric (min / max / avg / uniformity), STIPA, or per-listener readout —
// it fabricates a one-cell cosmetic ring of values that do NOT correspond
// to real sample points. Pure array math, no DOM, no Three.js, so every
// render surface (2D SVG, 3D scalar texture, print PNG) and the Node tests
// can import it.
//
// Why this exists (bug 2026-05-21, reported by the user with 3 screenshots
// at 0.5 m room-size increments):
//   computeSPLGrid / computeZoneSPLGrid lay a grid of square cells over the
//   room (or zone) bounding box and KEEP a cell only if its CENTRE point is
//   inside the room polygon — otherwise the cell is -Infinity ("no data").
//   But every render surface paints the KEPT cell as a FULL square. Two
//   symptoms result at any wall:
//     * a cell whose centre is just INSIDE the wall paints a full square
//       that pokes PAST the wall            → LEAK
//     * a cell whose centre is just OUTSIDE the wall (the wall slices
//       through the cell) is dropped entirely → white GAP along the wall,
//       even though half that cell is really inside the room
//   Growing the room by 0.5 m resizes the cells, so the wall lands at a
//   different spot inside each edge cell and the look flips between leak
//   and gap. That is exactly the per-0.5 m behaviour the user observed.
//
// The fix is two complementary halves — BOTH must ship together:
//   1. dilateGridForDisplay (this file) bleeds the value of each boundary
//      cell outward by one ring so the field fills UP TO the wall instead
//      of leaving a white moat.
//   2. every surface hard-clips to the true room polygon so the now-
//      generous fill cannot leak past the wall (the clip trims the
//      overshoot). 2D + print clip via an SVG clipPath; the 3D path clips
//      via the zone ShapeGeometry silhouette, which is already exact.
//   Dilation alone trades gaps for leaks; clipping alone leaves gaps.
//
// Approved render-only by Dr. Chen (acoustics) 2026-05-21: nearest-
// neighbour extrapolation by one cell ring is standard practice
// (EASE / Odeon / CATT) and stays < 1 dB error at the default grid
// resolution. Tracked caveat (project_chen_audit, P4): at gridSize <= 15
// on a large room with a wall-mounted source in a bass band, the bled
// ring under-states near-wall reflective pressure-doubling. Not material
// at the default gridSize = 25.
//
// Guarded by tests/cross-surface-conventions.test.mjs (dilation unit
// behaviour + all-three-surfaces-import-it parity + print clipPath).

/**
 * Return a NEW grid where every "no-data" cell (-Infinity / non-finite)
 * that is 8-adjacent to >= 1 finite cell takes the AVERAGE of its finite
 * 8-neighbours. Cells with no finite neighbour stay -Infinity. Finite
 * cells are copied through unchanged.
 *
 * Single-pass: neighbours are read from the ORIGINAL grid only, so the
 * filled ring grows by EXACTLY one cell — a cell filled this pass never
 * seeds another fill. Does not mutate `grid`; allocates fresh rows.
 *
 * Average (not nearest) fill is deliberate: the 3D path bilinear-filters
 * the scalar texture, so an averaged ring reads as a smooth continuation
 * whereas a single-neighbour pick can leave a faint directional seam
 * where two bled cells from different sources meet. At cell granularity
 * (2D rects, print PNG pixels) average vs nearest is invisible. The fill
 * value is always within [min, max] of the real neighbours, so it never
 * fabricates a value outside the sampled range.
 *
 * @param {Array<Array<number>>} grid  grid[j][i], j in [0,cellsY), i in [0,cellsX)
 * @param {number} cellsX
 * @param {number} cellsY
 * @returns {Array<Array<number>>} new grid, same shape
 */
export function dilateGridForDisplay(grid, cellsX, cellsY) {
  if (!Array.isArray(grid) || !(cellsX > 0) || !(cellsY > 0)) return grid;
  const out = new Array(cellsY);
  for (let j = 0; j < cellsY; j++) {
    const srcRow = grid[j] || [];
    const dstRow = new Array(cellsX);
    for (let i = 0; i < cellsX; i++) {
      const v = srcRow[i];
      if (Number.isFinite(v)) { dstRow[i] = v; continue; }
      // No-data cell — average finite ORIGINAL 8-neighbours, if any.
      let sum = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= cellsY) continue;
        const nRow = grid[jj];
        if (!nRow) continue;
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ii = i + di;
          if (ii < 0 || ii >= cellsX) continue;
          const nv = nRow[ii];
          if (Number.isFinite(nv)) { sum += nv; n++; }
        }
      }
      dstRow[i] = n > 0 ? sum / n : -Infinity;
    }
    out[j] = dstRow;
  }
  return out;
}

/**
 * Build a HI-RES validity mask that clips a heatmap to the true room
 * silhouette at sub-cell precision. Used by the 3D room-level heatmap
 * path (heatmap-shader.js), which renders the dilated scalar field on a
 * rectangular plane that has NO geometric clip — so the mask itself must
 * carry the polygon boundary.
 *
 * Why a per-texel mask at higher-than-grid resolution: dilateGridForDisplay
 * fills exactly the cells whose CENTRE is outside the wall (that is why
 * computeSPLGrid dropped them). A mask at grid resolution using a
 * cell-centre inside-test would re-drop those same cells — undoing the
 * fill (gap returns) — because a single grid cell can't be half-rendered.
 * Sampling the inside-test at sub-cell resolution lets the discard
 * boundary follow the polygon THROUGH a boundary cell: the inside-the-wall
 * half keeps the dilated colour (gap filled), the outside-the-wall half is
 * discarded (no leak). See heatmap-shader.js FRAG `discard` + Viktor's
 * 2026-05-21 review.
 *
 * Returns a Uint8Array of length maskW*maskH (row-major, row 0 at the
 * texture's v=0 edge), 255 = inside / render, 0 = outside / discard.
 * Texel (mi,mj) is tested at its own state-coord centre. The Y mapping
 * matches buildScalarTexture's flipY emulation: texture v=0 holds the
 * MAX-Y (north) physics edge, so state-Y decreases as mj increases.
 *
 * Pure (no THREE) so it is Node-testable.
 *
 * @param {number} maskW   mask texels across (= maskScale * cellsX)
 * @param {number} maskH   mask texels down   (= maskScale * cellsY)
 * @param {number} originX state-X of the grid's min-X edge (splResult.originX_m)
 * @param {number} originY state-Y of the grid's min-Y edge (splResult.originY_m)
 * @param {number} totalW  grid width in metres  (cellsX * cellW_m)
 * @param {number} totalD  grid depth in metres  (cellsY * cellD_m)
 * @param {(x:number,y:number)=>boolean} insideFn  true if state (x,y) is inside the room
 * @returns {Uint8Array}
 */
export function buildSilhouetteMask(maskW, maskH, originX, originY, totalW, totalD, insideFn) {
  const mask = new Uint8Array(maskW * maskH);
  for (let mj = 0; mj < maskH; mj++) {
    const v = (mj + 0.5) / maskH;            // texture V at this row's centre
    const sy = originY + (1 - v) * totalD;   // flipY: v=0 → max-Y edge
    const rowBase = mj * maskW;
    for (let mi = 0; mi < maskW; mi++) {
      const u = (mi + 0.5) / maskW;
      const sx = originX + u * totalW;
      mask[rowBase + mi] = insideFn(sx, sy) ? 255 : 0;
    }
  }
  return mask;
}
