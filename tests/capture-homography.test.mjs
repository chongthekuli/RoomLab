// Room Capture — planar homography (perspective rectification) math.
// Run: node tests/capture-homography.test.mjs

import { solveHomography, applyHomography, invertHomography }
  from '../js/capture/geometry/homography.js';

let failed = 0;
function assert(c, l) { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; }
const approx = (a, b, t = 1e-6) => Math.abs(a - b) <= t;
const ptApprox = (p, q, t = 1e-5) => p && q && approx(p.x, q.x, t) && approx(p.y, q.y, t);

const UNIT = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

// --- identity -------------------------------------------------------------
{
  const H = solveHomography(UNIT, UNIT);
  assert(H !== null, 'identity correspondence solves');
  assert(ptApprox(applyHomography(H, { x: 0.3, y: 0.7 }), { x: 0.3, y: 0.7 }),
    'identity homography maps a point to itself');
}

// --- affine (translate + scale) ------------------------------------------
{
  // map unit square → a 4×3 rectangle at offset (10, 5)
  const dst = [{ x: 10, y: 5 }, { x: 14, y: 5 }, { x: 14, y: 8 }, { x: 10, y: 8 }];
  const H = solveHomography(UNIT, dst);
  assert(ptApprox(applyHomography(H, { x: 0.5, y: 0.5 }), { x: 12, y: 6.5 }),
    'affine: centre of unit square → centre of the 4×3 rect at (10,5)');
}

// --- true perspective round-trip -----------------------------------------
{
  // A trapezoid (perspective-skewed floor quad as it appears in a photo) →
  // a top-down unit square. Then verify the inverse maps back.
  const photoQuad = [{ x: 120, y: 300 }, { x: 520, y: 300 }, { x: 460, y: 80 }, { x: 180, y: 80 }];
  const H = solveHomography(photoQuad, UNIT);
  assert(H !== null, 'perspective quad → unit square solves');
  // each photo corner lands on the right unit-square corner
  for (let i = 0; i < 4; i++) {
    assert(ptApprox(applyHomography(H, photoQuad[i]), UNIT[i]),
      `rectify: photo corner ${i} → unit-square corner ${i}`);
  }
  // inverse maps unit-square corners back to the photo quad
  const Hinv = invertHomography(H);
  assert(Hinv !== null, 'homography is invertible');
  for (let i = 0; i < 4; i++) {
    assert(ptApprox(applyHomography(Hinv, UNIT[i]), photoQuad[i], 1e-3),
      `invert: unit corner ${i} → photo corner ${i}`);
  }
  // a midpoint of the photo top edge maps inside [0,1]² (sanity: monotone)
  const mid = applyHomography(H, { x: (photoQuad[2].x + photoQuad[3].x) / 2, y: 80 });
  assert(mid.x > 0.2 && mid.x < 0.8 && mid.y > 0.9 && mid.y <= 1.0001,
    `rectify: photo top-edge midpoint lands near the far edge of the plan (${mid.x.toFixed(2)},${mid.y.toFixed(2)})`);
}

// --- degenerate input → null (no crash) -----------------------------------
{
  const collinear = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
  assert(solveHomography(collinear, UNIT) === null, 'collinear source points → null (degenerate, no throw)');
  assert(solveHomography([{ x: 0, y: 0 }], UNIT) === null, 'fewer than 4 points → null');
  assert(invertHomography([0, 0, 0, 0, 0, 0, 0, 0, 0]) === null, 'singular matrix invert → null');
}

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll capture homography tests passed.');
