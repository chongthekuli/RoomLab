// Surau arcade bay-column + corner-post placement regression test.
//
// Pins the BVH triangulation of the surau arcade against the formula
// the renderer must agree with. Catches:
//   - RL-XXX (Viktor diagnosis 2026-05-18): south + east bay-slabs were
//     shifted by bayW because the renderer's position formula used
//     `(sx, sy)`-based offsets that didn't account for the `R_y(θ)` of
//     local +X. Renderer now centers the geometry before extrude, so
//     `position.set(cxBay, 0, cyBay)` lands the bay's geometric centre
//     at the same world coords the BVH expects.
//   - RL-YYY (corner posts 2026-05-18): 4 freestanding posts at the
//     outer corners of cantilevered slabs where two wrapped sides meet.
//
// Run: node tests/surau-arcade-placement.test.mjs

import { state, applyPresetToState } from '../js/app-state.js';
import { triangulateScene } from '../js/physics/precision/triangulate-scene.js';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';
import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function assertClose(actual, expected, tol, label) {
  const diff = Math.abs(actual - expected);
  const good = diff < tol;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}  actual=${actual.toFixed(4)} expected=${expected.toFixed(4)}`);
  if (!good) failed++;
}

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

applyPresetToState('surau');
const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: () => null });
const soup = triangulateScene(scene);

// Collect all triangle indices grouped by sourceKey.
const trisByKey = new Map();
for (let i = 0; i < soup.count; i++) {
  const key = soup.sourceKey[i];
  if (!key) continue;
  if (!trisByKey.has(key)) trisByKey.set(key, []);
  trisByKey.get(key).push(i);
}

// Compute the xy centroid of all vertices belonging to a set of triangles.
function centroidXY(indices) {
  let sx = 0, sy = 0, n = 0;
  for (const ti of indices) {
    for (let v = 0; v < 3; v++) {
      sx += soup.positions[ti * 9 + v * 3 + 0];
      sy += soup.positions[ti * 9 + v * 3 + 1];
      n++;
    }
  }
  return { x: sx / n, y: sy / n };
}

// ---- Surau preset geometry constants (mirror surau.js values) ----
const W = 18.0, D = 17.7;
const depth = 3.0, colT = 0.30, bayW = 2.8;
const startInset = depth * 0.5;          // 1.5
const endInset   = depth * 0.5;          // 1.5
const outwardDist = depth - colT / 2;    // 2.85

const sides = {
  south: { p1: [0, 0], p2: [W, 0], sx: 1,  sy: 0,  perpX: 0,  perpY: -1, code: 'S' },
  east:  { p1: [W, 0], p2: [W, D], sx: 0,  sy: 1,  perpX: 1,  perpY: 0,  code: 'E' },
  west:  { p1: [0, 0], p2: [0, D], sx: 0,  sy: 1,  perpX: -1, perpY: 0,  code: 'W' },
};

// ---- Bay-column placement: 6 columns per side (ci = 0..nBays). ----
// Verify the first AND the last column on each of the 3 wrapped sides
// match the formula. If south/east drift again, this fails immediately.
for (const [sideName, spec] of Object.entries(sides)) {
  const sideLen = sideName === 'south' ? W : D;
  const usableLen = sideLen - startInset - endInset;
  const nBays = Math.max(1, Math.floor(usableLen / bayW));
  const actualBayW = usableLen / nBays;

  for (const ci of [0, nBays]) {
    const u = startInset + ci * actualBayW;
    const ux = spec.p1[0] + spec.sx * u;
    const uy = spec.p1[1] + spec.sy * u;
    const cx = ux + spec.perpX * outwardDist;
    const cy = uy + spec.perpY * outwardDist;
    const key = `surau_arcade_column_${spec.code}_${ci}`;
    const tris = trisByKey.get(key);
    ok(tris != null && tris.length > 0, `${key}: BVH triangles present`);
    if (tris && tris.length > 0) {
      const c = centroidXY(tris);
      assertClose(c.x, cx, 1e-3, `${key}: column centroid x (1 mm tol)`);
      assertClose(c.y, cy, 1e-3, `${key}: column centroid y (1 mm tol)`);
    }
  }
}

// ---- Corner posts: 4 freestanding posts at the outer corners of
// cantilevered slabs where two wrapped sides meet (SE pair + SW pair). ----
const cornerPosts = [
  { key: 'surau_arcade_column_corner_SE_S', cx: W - depth * 0.5,  cy: -depth },          // (16.5, -3)
  { key: 'surau_arcade_column_corner_SE_E', cx: W + depth,         cy: depth * 0.5 },     // (21, 1.5)
  { key: 'surau_arcade_column_corner_SW_S', cx: depth * 0.5,       cy: -depth },          // (1.5, -3)
  { key: 'surau_arcade_column_corner_SW_W', cx: -depth,            cy: depth * 0.5 },     // (-3, 1.5)
];
for (const cp of cornerPosts) {
  const tris = trisByKey.get(cp.key);
  ok(tris != null && tris.length > 0, `${cp.key}: corner-post BVH triangles present`);
  if (tris && tris.length > 0) {
    const c = centroidXY(tris);
    assertClose(c.x, cp.cx, 1e-3, `${cp.key}: post centroid x (1 mm tol)`);
    assertClose(c.y, cp.cy, 1e-3, `${cp.key}: post centroid y (1 mm tol)`);
  }
}

console.log(failed === 0
  ? '\nAll surau arcade placement tests passed.'
  : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
