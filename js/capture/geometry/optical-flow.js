// Room Capture — sparse optical-flow point tracker (Lucas-Kanade). PURE:
// no DOM, no Three.js, no npm, Node-testable. Operates on plain grayscale
// rasters ({ data: Float32Array|Uint8ClampedArray, width, height }) so the
// math is verified with synthetic translated patches, independent of <canvas>.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS IS FOR (read this before "improving" it):
//
//   This tracker exists for UX ONLY. In the live-capture mode the user pans
//   the phone across the room and taps wall corners; LK lets a placed corner
//   marker "stick" to its wall point frame-to-frame so the user can see it
//   while panning, and lets a marker placed off the current view persist by
//   accumulating the inter-frame shift. It is NOT used to fuse geometry across
//   frames — the committed floor polygon is recovered by ONE homography in a
//   single reference frame (see live-capture-mode.js, CV DECISION block).
//   Optical-flow drift therefore degrades UX (a marker slides off its corner)
//   but can NEVER produce a wrong-but-confident plan. That's the whole point.
//
//   Classic single-level Lucas-Kanade (Lucas & Kanade 1981; Bouguet's pyramidal
//   write-up, "Pyramidal Implementation of the Lucas Kanade Feature Tracker").
//   We add a small coarse-to-fine pyramid so a fast pan (displacement bigger
//   than the window) still tracks. Per-frame cost is bounded by tracking only
//   the handful of tapped corners on a downsampled raster — full-res dense flow
//   would heat/throttle an iPhone (the research constraint).
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Gray  a single-channel image.
 * @property {Float32Array|Uint8ClampedArray|number[]} data  row-major, length w*h, 0..255
 * @property {number} width
 * @property {number} height
 */

// Bilinear sample of a grayscale raster at fractional (x, y). Clamps to edge so
// a window straddling the border still returns a value (no NaN at the seam).
function sample(img, x, y) {
  const w = img.width, h = img.height, d = img.data;
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const a = d[y0 * w + x0], b = d[y0 * w + x1];
  const c = d[y1 * w + x0], e = d[y1 * w + x1];
  const top = a + (b - a) * fx;
  const bot = c + (e - c) * fx;
  return top + (bot - top) * fy;
}

/**
 * Track ONE point from image `prev` to image `next` by iterative Lucas-Kanade
 * over a square window. Returns the new {x, y} location and a `valid` flag.
 *
 * Solves, per iteration, the 2×2 normal-equation system from the spatial
 * gradients of the window and the temporal difference (prev − next):
 *   [Σ Ix²  Σ IxIy] [vx]   [Σ Ix·It]
 *   [Σ IxIy Σ Iy² ] [vy] = [Σ Iy·It]
 * accumulating the flow `g` until it converges or maxIters is hit.
 *
 * @param {Gray} prev
 * @param {Gray} next
 * @param {{x:number,y:number}} pt  point in `prev`
 * @param {Object} [opts]
 * @param {number} [opts.win=7]       window HALF-size (px); window is (2w+1)²
 * @param {number} [opts.maxIters=12]
 * @param {number} [opts.epsilon=0.03] stop when |update| < epsilon (px)
 * @param {number} [opts.minEig=1e-3]  reject ill-conditioned (low-texture) windows
 * @param {{x:number,y:number}} [opts.guess]  initial flow estimate (px), used by
 *   the pyramidal driver to seed a level with the coarser level's result. The
 *   REFERENCE patch stays at `pt` in `prev`; only the initial offset into `next`
 *   moves. Default {0,0}.
 * @returns {{x:number,y:number,valid:boolean,eig:number}}
 */
export function trackPointLK(prev, next, pt, opts = {}) {
  const win = opts.win ?? 7;
  const maxIters = opts.maxIters ?? 12;
  const epsilon = opts.epsilon ?? 0.03;
  const minEig = opts.minEig ?? 1e-3;
  const guess = opts.guess || { x: 0, y: 0 };

  const px = pt.x, py = pt.y;
  // Spatial-gradient sums over the window in `prev` (Gxx/Gxy/Gyy are constant
  // across iterations — the gradient is evaluated on the reference image).
  let Gxx = 0, Gxy = 0, Gyy = 0;
  const winN = (2 * win + 1) * (2 * win + 1);
  const Ix = new Float32Array(winN);
  const Iy = new Float32Array(winN);
  const I0 = new Float32Array(winN);
  let k = 0;
  for (let dy = -win; dy <= win; dy++) {
    for (let dx = -win; dx <= win; dx++) {
      const x = px + dx, y = py + dy;
      // central differences on the reference image
      const ix = 0.5 * (sample(prev, x + 1, y) - sample(prev, x - 1, y));
      const iy = 0.5 * (sample(prev, x, y + 1) - sample(prev, x, y - 1));
      Ix[k] = ix; Iy[k] = iy; I0[k] = sample(prev, x, y);
      Gxx += ix * ix; Gxy += ix * iy; Gyy += iy * iy;
      k++;
    }
  }
  // Smallest eigenvalue of the 2×2 [[Gxx,Gxy],[Gxy,Gyy]] — texture / trackability.
  const trace = Gxx + Gyy;
  const det = Gxx * Gyy - Gxy * Gxy;
  const disc = Math.sqrt(Math.max(0, trace * trace - 4 * det));
  const eigMin = (trace - disc) / 2;
  // Normalise the eigenvalue by window size so the threshold is window-agnostic.
  const eigNorm = eigMin / winN;
  if (!(det > 1e-12) || eigNorm < minEig) {
    return { x: px, y: py, valid: false, eig: eigNorm };
  }

  let gx = guess.x, gy = guess.y;   // accumulated flow (seeded by caller guess)
  for (let iter = 0; iter < maxIters; iter++) {
    let bx = 0, by = 0;
    k = 0;
    for (let dy = -win; dy <= win; dy++) {
      for (let dx = -win; dx <= win; dx++) {
        // temporal difference: reference minus the shifted current image
        const it = I0[k] - sample(next, px + dx + gx, py + dy + gy);
        bx += Ix[k] * it; by += Iy[k] * it;
        k++;
      }
    }
    // Solve G·d = b (2×2). det>0 guaranteed above.
    const dxk = (Gyy * bx - Gxy * by) / det;
    const dyk = (-Gxy * bx + Gxx * by) / det;
    gx += dxk; gy += dyk;
    if (dxk * dxk + dyk * dyk < epsilon * epsilon) break;
  }
  const nx = px + gx, ny = py + gy;
  // Reject a track that flew off the image (occluded / left frame).
  const valid = nx >= -1 && ny >= -1 && nx <= next.width && ny <= next.height
    && Number.isFinite(nx) && Number.isFinite(ny);
  return { x: nx, y: ny, valid, eig: eigNorm };
}

/**
 * Halve a grayscale raster with a 2×2 box average — one pyramid level down.
 * @param {Gray} img
 * @returns {Gray}
 */
export function downsampleHalf(img) {
  const w = img.width, h = img.height, d = img.data;
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const y0 = 2 * y, y1 = Math.min(h - 1, y0 + 1);
    for (let x = 0; x < nw; x++) {
      const x0 = 2 * x, x1 = Math.min(w - 1, x0 + 1);
      out[y * nw + x] = 0.25 * (d[y0 * w + x0] + d[y0 * w + x1] + d[y1 * w + x0] + d[y1 * w + x1]);
    }
  }
  return { data: out, width: nw, height: nh };
}

/**
 * Build a coarse-to-fine pyramid [level0 = full, level1 = half, ...].
 * @param {Gray} img
 * @param {number} [levels=2]
 * @returns {Gray[]}
 */
export function buildPyramid(img, levels = 2) {
  const out = [img];
  for (let i = 1; i < levels; i++) {
    const prev = out[i - 1];
    if (prev.width <= 8 || prev.height <= 8) break;
    out.push(downsampleHalf(prev));
  }
  return out;
}

/**
 * Pyramidal Lucas-Kanade: track a point across pyramids (coarse→fine) so large
 * inter-frame motion (a quick pan) is captured. `prevPyr`/`nextPyr` come from
 * buildPyramid on the same `levels`. Coordinates are in FULL-resolution pixels.
 *
 * @param {Gray[]} prevPyr
 * @param {Gray[]} nextPyr
 * @param {{x:number,y:number}} pt   point in full-res `prev`
 * @param {Object} [opts] forwarded to trackPointLK (win/maxIters/epsilon/minEig)
 * @returns {{x:number,y:number,valid:boolean,eig:number}}
 */
export function trackPointPyramidal(prevPyr, nextPyr, pt, opts = {}) {
  const levels = Math.min(prevPyr.length, nextPyr.length);
  if (levels === 0) return { x: pt.x, y: pt.y, valid: false, eig: 0 };
  // Bouguet's coarse→fine scheme: track at each level with the propagated flow
  // as the INITIAL guess (reference patch at pt scaled into the level), then
  // double the resulting flow going one level finer. The reference point pt is
  // fixed in `prev`; only the flow accumulates. Flow is kept in FULL-res px.
  let flowX = 0, flowY = 0;
  let lastEig = 0, anyValid = false;
  for (let lvl = levels - 1; lvl >= 0; lvl--) {
    const scale = 1 / (1 << lvl);
    const lp = { x: pt.x * scale, y: pt.y * scale };           // patch at this level
    const guess = { x: flowX * scale, y: flowY * scale };       // flow at this level
    const r = trackPointLK(prevPyr[lvl], nextPyr[lvl], lp, { ...opts, guess });
    lastEig = r.eig;
    if (r.valid) {
      anyValid = true;
      flowX = (r.x - lp.x) / scale;   // residual flow back to full-res
      flowY = (r.y - lp.y) / scale;
    }
    // A level that fails (low texture) leaves the propagated flow intact so a
    // finer, more-textured level can still refine it.
  }
  return { x: pt.x + flowX, y: pt.y + flowY, valid: anyValid, eig: lastEig };
}

/**
 * Convenience: track an ARRAY of points prev→next using a fresh pyramid pair.
 * Returns one result per input point (same order). Points whose track is
 * invalid keep their previous location with valid:false so the caller can mark
 * them "drifted" rather than teleporting them.
 *
 * @param {Gray} prev
 * @param {Gray} next
 * @param {{x:number,y:number}[]} points
 * @param {Object} [opts] { levels=2, ...lkOpts }
 * @returns {{x:number,y:number,valid:boolean,eig:number}[]}
 */
export function trackPoints(prev, next, points, opts = {}) {
  const levels = opts.levels ?? 2;
  const prevPyr = buildPyramid(prev, levels);
  const nextPyr = buildPyramid(next, levels);
  return points.map(p => {
    const r = trackPointPyramidal(prevPyr, nextPyr, p, opts);
    return r.valid ? r : { x: p.x, y: p.y, valid: false, eig: r.eig };
  });
}

/**
 * Robust median inter-frame translation from a set of point tracks — the
 * bounded "accumulator" the live mode uses to keep OFF-SCREEN markers roughly
 * positioned as the phone pans. Median (not mean) so a few bad tracks
 * (occlusion, low texture) don't swing the estimate. Returns {dx, dy, n} where
 * n is the count of valid tracks contributing; n===0 ⇒ no reliable motion (the
 * caller should NOT move off-screen markers that frame).
 *
 * @param {{x:number,y:number}[]} from   point locations in prev
 * @param {{x:number,y:number,valid:boolean}[]} to   trackPoints() results
 * @returns {{dx:number,dy:number,n:number}}
 */
export function medianTranslation(from, to) {
  const dxs = [], dys = [];
  for (let i = 0; i < to.length; i++) {
    if (to[i] && to[i].valid && from[i]) {
      dxs.push(to[i].x - from[i].x);
      dys.push(to[i].y - from[i].y);
    }
  }
  if (dxs.length === 0) return { dx: 0, dy: 0, n: 0 };
  const med = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  };
  return { dx: med(dxs), dy: med(dys), n: dxs.length };
}

/**
 * Convert an RGBA ImageData-like buffer to a grayscale Gray (Rec. 601 luma).
 * Browser-side helper but PURE (takes a plain object), so it's testable too.
 * @param {{data:Uint8ClampedArray|number[], width:number, height:number}} rgba
 * @returns {Gray}
 */
export function rgbaToGray(rgba) {
  const { data, width, height } = rgba;
  const out = new Float32Array(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return { data: out, width, height };
}
