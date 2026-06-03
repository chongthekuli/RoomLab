// Room Capture — DeviceOrientation / DeviceMotion sensor-fusion math (pure).
//
// Guards:
//   • levelPlaneFromGravity: an upright phone reads level; a flat/tilted phone
//     reads not-level; a zero/garbage vector degrades to level=true (never block).
//   • headingToNorthRotation / normalizeHeadingDeg: heading→radians sign + wrap.
//   • rotatePolygon: 90° rotation about gravity maps +y→+x correctly (the
//     "phone rotated 90° ends up rotated correctly" case); centroid pivot is
//     shape-preserving (edge lengths unchanged).
//   • applyHeadingToPolygon: a polygon captured facing EAST (heading 90°) is
//     rotated so its camera-far (+y) wall lands pointing NORTH (+y) again, i.e.
//     a wall that was along +y at heading 90 ends up along +x after correction
//     (it really pointed east). And the graceful-degrade null path is a copy.
//
// Run: node tests/capture-orientation.test.mjs

import {
  levelPlaneFromGravity, headingToNorthRotation, normalizeHeadingDeg,
  rotatePolygon, applyHeadingToPolygon,
} from '../js/capture/geometry/orientation.js';

let failed = 0;
function assert(c, l) { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; }
const approx = (a, b, t = 1e-6) => Math.abs(a - b) <= t;
const DEG = Math.PI / 180;

// --- levelPlaneFromGravity -------------------------------------------------
{
  // Phone held upright scanning a wall: gravity down the screen, device −Y.
  const up = levelPlaneFromGravity({ x: 0, y: -9.81, z: 0 });
  assert(approx(up.tiltRad, 0, 1e-6), 'gravity: upright phone → tilt ≈ 0');
  assert(up.level === true, 'gravity: upright phone is level (good scan pose)');

  // Phone face-up flat on a table: gravity along device −Z → tilt ≈ 90°.
  const flat = levelPlaneFromGravity({ x: 0, y: 0, z: -9.81 });
  assert(approx(flat.tiltRad, Math.PI / 2, 1e-6), 'gravity: flat phone → tilt ≈ 90°');
  assert(flat.level === false, 'gravity: flat phone is NOT level (bad scan pose)');

  // A mild 20° tilt is still within the generous tolerance → level.
  const mild = levelPlaneFromGravity({ x: 0, y: -Math.cos(20 * DEG), z: -Math.sin(20 * DEG) });
  assert(approx(mild.tiltRad, 20 * DEG, 1e-6), 'gravity: 20° tilt measured correctly');
  assert(mild.level === true, 'gravity: 20° tilt still within tolerance (level)');

  // Garbage / no reading → degrade to level=true (never block capture).
  const zero = levelPlaneFromGravity({ x: 0, y: 0, z: 0 });
  assert(zero.level === true, 'gravity: zero vector degrades to level=true (graceful)');
  const missing = levelPlaneFromGravity(null);
  assert(missing.level === true, 'gravity: null accel degrades to level=true (graceful)');

  // Magnitude is normalised away — a 1g and a 2g reading of the same direction agree.
  const a = levelPlaneFromGravity({ x: 0, y: -1, z: 0 });
  const b = levelPlaneFromGravity({ x: 0, y: -2, z: 0 });
  assert(approx(a.tiltRad, b.tiltRad), 'gravity: tilt independent of vector magnitude');
}

// --- normalizeHeadingDeg ---------------------------------------------------
{
  assert(normalizeHeadingDeg(0) === 0, 'heading wrap: 0 → 0');
  assert(normalizeHeadingDeg(360) === 0, 'heading wrap: 360 → 0');
  assert(normalizeHeadingDeg(450) === 90, 'heading wrap: 450 → 90');
  assert(normalizeHeadingDeg(-90) === 270, 'heading wrap: −90 → 270');
  assert(normalizeHeadingDeg(NaN) === 0, 'heading wrap: NaN → 0 (safe)');
}

// --- headingToNorthRotation sign -------------------------------------------
{
  assert(approx(headingToNorthRotation(0), 0), 'rotation: heading 0 (facing N) → no rotation');
  // Facing east (90° CW from N): polygon must rotate −90° (CW) to put +y on north.
  assert(approx(headingToNorthRotation(90), -90 * DEG), 'rotation: heading 90 (E) → −90° (CW correction)');
  assert(approx(headingToNorthRotation(270), -270 * DEG), 'rotation: heading 270 (W) → −270°');
}

// --- rotatePolygon: shape-preserving + correct 90° mapping -----------------
{
  // Unit square, vertices CCW. Rotating −90° (CW) about centroid maps +y→+x.
  const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const r = rotatePolygon(sq, -90 * DEG);
  // Centroid is (0.5,0.5); a −90° (CW) rotation sends a point at +y offset to +x.
  // Vertex (0,1) is at centroid + (−0.5,+0.5); after CW 90° → centroid + (+0.5,+0.5) = (1,1).
  assert(approx(r[3].x, 1) && approx(r[3].y, 1), 'rotate: −90° sends top-left (0,1) → (1,1)');
  // Edge lengths preserved (rigid rotation).
  const elen = (p, i) => Math.hypot(p[(i + 1) % p.length].x - p[i].x, p[(i + 1) % p.length].y - p[i].y);
  for (let i = 0; i < 4; i++) assert(approx(elen(sq, i), elen(r, i)), `rotate: edge ${i} length preserved`);

  // angle 0 is a no-op copy (and a fresh array).
  const z = rotatePolygon(sq, 0);
  assert(z !== sq && approx(z[1].x, 1) && approx(z[1].y, 0), 'rotate: 0 rad → unchanged copy');
}

// --- applyHeadingToPolygon: facing-east capture corrected to true north ----
{
  // The user faced EAST (heading 90°) while scanning. The rectify put the far
  // wall along +y (camera-relative). That wall REALLY points east, so after
  // north-correction the far wall must point +x (east), not +y. Take the far
  // wall as the segment from (0,1)→(1,1) of a unit square (its outward normal +y).
  const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const corrected = applyHeadingToPolygon(sq, 90);
  // The far-wall direction vector (v3→v2 = (0,1)→(1,1) originally = +x) and its
  // outward normal (+y) rotate by −90°: +y normal → +x. Check the centroid-relative
  // position of the originally-top edge midpoint moved from +y side to +x side.
  let cx = 0, cy = 0; for (const v of sq) { cx += v.x; cy += v.y; } cx /= 4; cy /= 4;
  const topMidBefore = { x: 0.5 - cx, y: 1 - cy };          // (0, +0.5) — north of centre
  const ccx = corrected.reduce((s, v) => s + v.x, 0) / 4;
  const ccy = corrected.reduce((s, v) => s + v.y, 0) / 4;
  const topMidAfter = { x: (corrected[2].x + corrected[3].x) / 2 - ccx, y: (corrected[2].y + corrected[3].y) / 2 - ccy };
  assert(approx(topMidBefore.x, 0) && approx(topMidBefore.y, 0.5), 'heading: pre-check far wall is north of centre');
  assert(approx(topMidAfter.x, 0.5, 1e-6) && approx(topMidAfter.y, 0, 1e-6),
    'heading: facing-east capture → far wall rotated to EAST (+x) after north correction');

  // Graceful degrade: null heading → unchanged copy (camera-relative kept).
  const same = applyHeadingToPolygon(sq, null);
  assert(same !== sq && approx(same[2].x, 1) && approx(same[2].y, 1), 'heading: null → unchanged copy (graceful degrade)');
  const nan = applyHeadingToPolygon(sq, NaN);
  assert(approx(nan[2].y, 1), 'heading: NaN heading → unchanged copy (graceful degrade)');
}

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll capture orientation tests passed.');
