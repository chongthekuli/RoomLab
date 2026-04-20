import { triangulateScene, SURFACE_TAGS } from '../js/physics/precision/triangulate-scene.js';
import { buildBVH, intersectRay, intersectRayBrute } from '../js/physics/precision/bvh.js';
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

// ---- Fixture: 10×10×3 m shoebox with wood floor / gypsum walls / tile
// ceiling + one ground-level zone and a scoreboard floating at centre.
function makeShoebox({ withZone = false, withScoreboard = false } = {}) {
  const state = {
    room: {
      shape: 'rectangular', width_m: 10, height_m: 3, depth_m: 10,
      surfaces: {
        floor: 'wood-floor', ceiling: 'acoustic-tile',
        walls: 'gypsum-board',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
      stadiumStructure: withScoreboard ? {
        scoreboard: { cx: 5, cy: 5, center_z_m: 2, width_m: 1, height_m: 1, material_id: 'led-glass' },
      } : null,
    },
    zones: withZone ? [{
      id: 'Z1', label: 'Audience', material_id: 'carpet-heavy',
      elevation_m: 0.0, occupancy_percent: 0,
      vertices: [{x:2,y:2},{x:8,y:2},{x:8,y:8},{x:2,y:8}],
    }] : [],
    sources: [], listeners: [],
    physics: { reverberantField: false, airAbsorption: true, freq_hz: 1000 },
  };
  return buildPhysicsScene({ state, materials, getLoudspeakerDef: () => null });
}

// ---- Triangulator tests ------------------------------------------------

{
  const scene = makeShoebox();
  const soup = triangulateScene(scene);
  ok(soup.count === 12, `Shoebox → 12 triangles (6 quads × 2) — got ${soup.count}`);
  ok(soup.positions.length === 12 * 9, 'positions array length = count × 9');
  ok(soup.normals.length === 12 * 3, 'normals array length = count × 3');
  ok(soup.materialIdx.length === 12, 'materialIdx length = count');

  // Bounding box must cover the full room.
  assertClose(soup.aabb.min[0], 0, 1e-6, 'aabb.min.x = 0');
  assertClose(soup.aabb.min[1], 0, 1e-6, 'aabb.min.y = 0');
  assertClose(soup.aabb.min[2], 0, 1e-6, 'aabb.min.z = 0');
  assertClose(soup.aabb.max[0], 10, 1e-6, 'aabb.max.x = 10');
  assertClose(soup.aabb.max[1], 10, 1e-6, 'aabb.max.y = 10');
  assertClose(soup.aabb.max[2], 3, 1e-6, 'aabb.max.z = 3');

  // Surface tags: 2 floor, 2 ceiling, 8 wall.
  const counts = { floor: 0, ceiling: 0, wall: 0, zone: 0, scoreboard: 0 };
  for (let i = 0; i < soup.count; i++) {
    switch (soup.surfaceTag[i]) {
      case SURFACE_TAGS.FLOOR: counts.floor++; break;
      case SURFACE_TAGS.CEILING: counts.ceiling++; break;
      case SURFACE_TAGS.WALL: counts.wall++; break;
      case SURFACE_TAGS.ZONE: counts.zone++; break;
      case SURFACE_TAGS.SCOREBOARD: counts.scoreboard++; break;
    }
  }
  ok(counts.floor === 2,    `floor triangles = 2 (got ${counts.floor})`);
  ok(counts.ceiling === 2,  `ceiling triangles = 2 (got ${counts.ceiling})`);
  ok(counts.wall === 8,     `wall triangles = 8 (got ${counts.wall})`);
}

// With a zone and a scoreboard, triangle count grows.
{
  const scene = makeShoebox({ withZone: true, withScoreboard: true });
  const soup = triangulateScene(scene);
  // Shell 12 + zone quad (4 verts → 2 triangles via fan) + scoreboard 6×2
  ok(soup.count === 12 + 2 + 12, `Shoebox + zone + scoreboard → 26 tris (got ${soup.count})`);
}

// ---- BVH build + ray intersection vs brute force ----------------------

{
  // --- First, test the cardinal wall rays WITHOUT a scoreboard so the
  // axis-aligned rays through the room centre actually reach the walls.
  const scenePlain = makeShoebox();
  const soupPlain = triangulateScene(scenePlain);
  const bvhPlain = buildBVH(soupPlain);
  ok(bvhPlain.nodeCount > 0, 'BVH built with ≥ 1 node');

  const rays = [
    { o: [5,5,1.5], d: [ 1,0,0], expectedT: 5,   expectedKey: 'wall_east'  },
    { o: [5,5,1.5], d: [-1,0,0], expectedT: 5,   expectedKey: 'wall_west'  },
    { o: [5,5,1.5], d: [0, 1,0], expectedT: 5,   expectedKey: 'wall_north' },
    { o: [5,5,1.5], d: [0,-1,0], expectedT: 5,   expectedKey: 'wall_south' },
    { o: [5,5,1.5], d: [0,0,-1], expectedT: 1.5, expectedKey: 'floor'      },
    { o: [5,5,1.5], d: [0,0, 1], expectedT: 1.5, expectedKey: 'ceiling'    },
  ];
  for (const { o, d, expectedT, expectedKey } of rays) {
    const hit = intersectRay(bvhPlain, o[0], o[1], o[2], d[0], d[1], d[2]);
    ok(hit !== null, `ray (${o}) (${d}) hits something`);
    if (hit) {
      assertClose(hit.t, expectedT, 1e-5, `ray (${o}) (${d}) t = ${expectedT}`);
      ok(hit.sourceKey === expectedKey, `ray (${o}) (${d}) hits ${expectedKey} (got ${hit.sourceKey})`);
    }
  }

  // --- Now with a scoreboard in the way: ray from floor corner toward
  // (5,5,2) must hit a scoreboard face, not a wall.
  const sbScene = makeShoebox({ withScoreboard: true });
  const sbSoup = triangulateScene(sbScene);
  const sbBVH = buildBVH(sbSoup);
  const sbHit = intersectRay(sbBVH, 5, 5, 0.5, 0, 0, 1);
  ok(sbHit !== null && sbHit.sourceKey === 'scoreboard_bottom',
    `ray straight up from (5,5,0.5) hits scoreboard_bottom (got ${sbHit?.sourceKey})`);
  // Scoreboard box center z=2, h=1 → bottom at z=1.5. Ray starts at z=0.5. t=1.
  if (sbHit) assertClose(sbHit.t, 1, 1e-5, 'scoreboard_bottom at t=1');

  // --- Random rays: BVH must agree with brute force. -------------------
  // 500 random rays from random origins inside the full scene (shoebox
  // + zone + scoreboard) toward random directions. Every BVH hit should
  // match brute-force within EPS.
  const scene = makeShoebox({ withZone: true, withScoreboard: true });
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const rng = mulberry32(0xC0FFEE);
  let matches = 0, total = 0;
  for (let i = 0; i < 500; i++) {
    const ox = rng() * 10;
    const oy = rng() * 10;
    const oz = rng() * 3;
    const theta = rng() * 2 * Math.PI;
    const phi = (rng() - 0.5) * Math.PI;
    const dx = Math.cos(phi) * Math.cos(theta);
    const dy = Math.cos(phi) * Math.sin(theta);
    const dz = Math.sin(phi);
    const hitBVH = intersectRay(bvh, ox, oy, oz, dx, dy, dz);
    const hitBrute = intersectRayBrute(soup, ox, oy, oz, dx, dy, dz);
    total++;
    if (hitBVH === null && hitBrute === null) { matches++; continue; }
    if (hitBVH === null || hitBrute === null) continue;
    if (Math.abs(hitBVH.t - hitBrute.t) < 1e-4 && hitBVH.triIndex === hitBrute.triIndex) matches++;
  }
  console.log(`${matches === total ? 'PASS' : 'FAIL'}  BVH vs brute force: ${matches}/${total} random rays match`);
  if (matches !== total) failed++;
}

// ---- Stress test: perf sanity for future tuning ------------------------

{
  const scene = makeShoebox({ withZone: true, withScoreboard: true });
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const N = 10_000;
  const rng = mulberry32(42);
  // Warm
  for (let i = 0; i < 1000; i++) {
    intersectRay(bvh, 5, 5, 1.5, Math.cos(i), Math.sin(i), 0.2);
  }
  const t0 = performance.now();
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const theta = rng() * 2 * Math.PI;
    const phi = (rng() - 0.5) * Math.PI;
    const h = intersectRay(bvh, 5, 5, 1.5,
      Math.cos(phi) * Math.cos(theta),
      Math.cos(phi) * Math.sin(theta),
      Math.sin(phi));
    if (h) hits++;
  }
  const ms = performance.now() - t0;
  const raysPerMs = N / ms;
  console.log(`PERF  ${N} rays vs 26-tri BVH: ${ms.toFixed(1)} ms → ${raysPerMs.toFixed(0)} rays/ms (hits=${hits})`);
  // Budget: > 500 rays/ms. At 50k-ray MVP render we'd be ~100 ms on this
  // tiny scene; scaling up to ~5000 triangles costs ~4× BVH traversal =>
  // still well under budget.
  ok(raysPerMs > 500, `perf budget: > 500 rays/ms on small scene`);
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll precision BVH tests passed.');

// Deterministic RNG for reproducible tests.
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
