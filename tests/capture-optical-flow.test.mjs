// Room Capture — Lucas-Kanade optical-flow point tracker math.
// Run: node tests/capture-optical-flow.test.mjs
//
// The tracker is UX-only (markers stick while panning); these tests pin the
// math: a synthetic textured patch translated by a known vector must be
// recovered to sub-pixel accuracy, large motion needs the pyramid, low-texture
// windows must be rejected (valid:false), and the median-translation
// accumulator must be robust to a few bad tracks.

import {
  trackPointLK, trackPointPyramidal, buildPyramid, downsampleHalf,
  trackPoints, medianTranslation, rgbaToGray,
} from '../js/capture/geometry/optical-flow.js';

let failed = 0;
function assert(c, l) { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; }
const approx = (a, b, t) => Math.abs(a - b) <= t;

// Build a grayscale image with smooth high-frequency texture (so gradients are
// rich everywhere — a trackable surface). f(x,y) sampled at integer pixels.
function makeTextured(w, h, f) {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { data, width: w, height: h };
}

// A continuous texture field we can shift exactly by sampling f(x - dx, y - dy).
function texField(x, y) {
  return 128
    + 60 * Math.sin(x * 0.45) * Math.cos(y * 0.37)
    + 40 * Math.sin((x + y) * 0.21)
    + 25 * Math.cos(x * 0.13 - y * 0.29);
}

// --- small translation, single-level LK -----------------------------------
{
  const W = 80, H = 80;
  const prev = makeTextured(W, H, (x, y) => texField(x, y));
  const TRUE = { dx: 1.3, dy: -0.8 };
  const next = makeTextured(W, H, (x, y) => texField(x - TRUE.dx, y - TRUE.dy));
  const start = { x: 40, y: 40 };
  const r = trackPointLK(prev, next, start, { win: 7 });
  assert(r.valid, 'LK: textured window is trackable (valid)');
  assert(approx(r.x - start.x, TRUE.dx, 0.15), `LK: recovered dx≈${TRUE.dx} (got ${(r.x - start.x).toFixed(3)})`);
  assert(approx(r.y - start.y, TRUE.dy, 0.15), `LK: recovered dy≈${TRUE.dy} (got ${(r.y - start.y).toFixed(3)})`);
}

// --- large translation needs the pyramid -----------------------------------
{
  const W = 160, H = 160;
  const prev = makeTextured(W, H, (x, y) => texField(x, y));
  const TRUE = { dx: 9, dy: 6 };   // bigger than a single 7px window can capture
  const next = makeTextured(W, H, (x, y) => texField(x - TRUE.dx, y - TRUE.dy));
  const start = { x: 80, y: 80 };

  // single level should under-shoot a 9px move
  const single = trackPointLK(prev, next, start, { win: 7 });
  const singleErr = Math.hypot(single.x - start.x - TRUE.dx, single.y - start.y - TRUE.dy);

  // pyramidal (3 levels) should lock on
  const pPrev = buildPyramid(prev, 3), pNext = buildPyramid(next, 3);
  const pyr = trackPointPyramidal(pPrev, pNext, start, { win: 7 });
  const pyrErr = Math.hypot(pyr.x - start.x - TRUE.dx, pyr.y - start.y - TRUE.dy);

  assert(pyr.valid, 'pyramidal LK: large-motion track valid');
  assert(pyrErr < 0.5, `pyramidal LK: 9px move recovered within 0.5px (err ${pyrErr.toFixed(3)})`);
  assert(pyrErr < singleErr, `pyramidal beats single level on large motion (${pyrErr.toFixed(2)} < ${singleErr.toFixed(2)})`);
}

// --- low-texture window is rejected (no false confident track) -------------
{
  const W = 60, H = 60;
  const flat = makeTextured(W, H, () => 100);     // flat grey, no gradient
  const next = makeTextured(W, H, () => 100);
  const r = trackPointLK(flat, next, { x: 30, y: 30 }, { win: 7 });
  assert(r.valid === false, 'LK: flat (texture-less) window → valid:false (no aperture-problem guess)');
}

// --- downsample halves dimensions ------------------------------------------
{
  const img = makeTextured(64, 48, (x, y) => texField(x, y));
  const half = downsampleHalf(img);
  assert(half.width === 32 && half.height === 24, 'downsampleHalf halves W and H');
  const pyr = buildPyramid(img, 3);
  assert(pyr.length === 3 && pyr[2].width === 16, 'buildPyramid: 3 levels, coarsest is 1/4 size');
}

// --- trackPoints + medianTranslation robustness ----------------------------
{
  const W = 120, H = 120;
  const prev = makeTextured(W, H, (x, y) => texField(x, y));
  const TRUE = { dx: 2.5, dy: 1.5 };
  const next = makeTextured(W, H, (x, y) => texField(x - TRUE.dx, y - TRUE.dy));
  const from = [
    { x: 30, y: 30 }, { x: 90, y: 30 }, { x: 60, y: 80 }, { x: 45, y: 95 },
  ];
  const to = trackPoints(prev, next, from, { levels: 2, win: 7 });
  assert(to.every(t => t.valid), 'trackPoints: all textured corners tracked');

  const m = medianTranslation(from, to);
  assert(m.n === 4, 'medianTranslation: counts all 4 valid tracks');
  assert(approx(m.dx, TRUE.dx, 0.2) && approx(m.dy, TRUE.dy, 0.2),
    `medianTranslation recovers the pan (${m.dx.toFixed(2)},${m.dy.toFixed(2)})`);

  // Inject ONE bad track (an outlier) — median must shrug it off.
  const poisoned = to.map((t, i) => i === 1 ? { x: t.x + 50, y: t.y - 40, valid: true } : t);
  const m2 = medianTranslation(from, poisoned);
  assert(approx(m2.dx, TRUE.dx, 0.4) && approx(m2.dy, TRUE.dy, 0.4),
    'medianTranslation: robust to one outlier track');

  // No valid tracks → n:0, zero motion (caller freezes off-screen markers).
  const allBad = to.map(t => ({ ...t, valid: false }));
  const m3 = medianTranslation(from, allBad);
  assert(m3.n === 0 && m3.dx === 0 && m3.dy === 0, 'medianTranslation: no valid tracks → {0,0,n:0}');
}

// --- rgbaToGray luma --------------------------------------------------------
{
  // a 2x1 image: white pixel then black pixel
  const rgba = { data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), width: 2, height: 1 };
  const g = rgbaToGray(rgba);
  assert(approx(g.data[0], 255, 1) && approx(g.data[1], 0, 1), 'rgbaToGray: white→255, black→0');
}

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll capture optical-flow tests passed.');
