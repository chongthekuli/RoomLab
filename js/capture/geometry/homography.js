// Room Capture — planar homography (4-point perspective rectification). PURE:
// no DOM, no Three.js, no npm — a hand-written 8×8 DLT solve, Node-testable.
// This is the math core of the photo-trace capture mode: the user taps four
// floor corners in a photo, and a homography maps that perspective-skewed quad
// to a top-down plan. The MODE (camera/canvas/tap UI + the choice of what
// destination rectangle to map to) is Viktor's photo-trace-mode.js on top of
// this primitive. See docs/ROOM_CAPTURE_PLAN.md §5.
//
// A homography H is a 3×3 matrix stored row-major as a flat length-9 array.
// It maps src point (x,y) → dst point (u,v) with a perspective divide:
//   u = (H0·x + H1·y + H2) / (H6·x + H7·y + H8)
//   v = (H3·x + H4·y + H5) / (H6·x + H7·y + H8)

// Solve an n×n linear system A·x = b by Gaussian elimination with partial
// pivoting. A is an array of n rows (each length n); b is length n. Returns the
// solution vector, or null if the matrix is singular (degenerate input).
function solveLinear(A, b) {
  const n = b.length;
  // Augmented matrix (copy — don't mutate caller's arrays).
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Partial pivot: largest |value| in this column at or below the diagonal.
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;   // singular
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    // Eliminate below.
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  // Back-substitution.
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Solve the homography mapping 4 source points → 4 destination points.
 * @param {{x,y}[]} src  length-4
 * @param {{x,y}[]} dst  length-4
 * @returns {number[]|null}  9-element row-major H (H8 normalised to 1), or null
 *   if the correspondence is degenerate (collinear points → singular system).
 */
export function solveHomography(src, dst) {
  if (!Array.isArray(src) || !Array.isArray(dst) || src.length < 4 || dst.length < 4) return null;
  // 8 unknowns: [h0..h5, h6, h7]; h8 fixed at 1. Two rows per correspondence.
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    if (![x, y, u, v].every(Number.isFinite)) return null;
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Apply homography H (length-9) to a point. Returns {x,y}, or null if the
 *  point maps to the plane at infinity (denominator ≈ 0). */
export function applyHomography(H, p) {
  const denom = H[6] * p.x + H[7] * p.y + H[8];
  if (Math.abs(denom) < 1e-12) return null;
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / denom,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / denom,
  };
}

/** Invert a 3×3 homography (length-9 row-major). Returns a length-9 array, or
 *  null if singular. Useful to map plan→image (e.g. to overlay the rectified
 *  grid back on the photo). */
export function invertHomography(H) {
  const a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7], i = H[8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return [
    A * invDet,            (c * h - b * i) * invDet, (b * f - c * e) * invDet,
    B * invDet,            (a * i - c * g) * invDet, (c * d - a * f) * invDet,
    C * invDet,            (b * g - a * h) * invDet, (a * e - b * d) * invDet,
  ];
}
