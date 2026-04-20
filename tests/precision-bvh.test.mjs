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

// ---- Phase B2 — polygon rooms ----------------------------------------

{
  const state = {
    room: {
      shape: 'polygon', polygon_sides: 6, polygon_radius_m: 10,
      width_m: 20, depth_m: 20, height_m: 5,
      ceiling_type: 'flat',
      surfaces: { floor: 'wood-floor', ceiling: 'acoustic-tile', walls: 'gypsum-board' },
    },
    zones: [], sources: [], listeners: [],
    physics: { reverberantField: false, airAbsorption: true, freq_hz: 1000 },
  };
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: () => null });
  const soup = triangulateScene(scene);
  // Hexagon: floor = 6 tris (fan from centroid), ceiling = 6 tris, 6 walls × 2 = 12.
  ok(soup.count === 6 + 6 + 12, `Hexagonal flat room → 24 tris (got ${soup.count})`);
  // Ray from centroid straight up must hit the flat ceiling.
  const bvh = buildBVH(soup);
  const hit = intersectRay(bvh, 10, 10, 2.5, 0, 0, 1);
  ok(hit !== null && hit.sourceKey === 'ceiling' && Math.abs(hit.t - 2.5) < 1e-5,
    `Hex flat ceiling hit from centroid (got ${hit?.sourceKey} at t=${hit?.t.toFixed(3)})`);
  // Ray along +x from centroid hits hex VERTEX 0 at (20,10) exactly —
  // t = polygon_radius_m = 10. Pick a non-axis-aligned direction
  // (30° off-axis) so the ray strikes a wall midpoint instead:
  // expected distance = apothem = R·cos(π/6) ≈ 8.66 m.
  const dir = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0];
  const side = intersectRay(bvh, 10, 10, 2.5, dir[0], dir[1], dir[2]);
  ok(side !== null && side.sourceKey.startsWith('wall_'), `Hex 30°-off-axis ray hits a wall_N (got ${side?.sourceKey})`);
  const expectedApothem = 10 * Math.cos(Math.PI / 6);
  ok(side && Math.abs(side.t - expectedApothem) < 0.05,
    `Hex wall midpoint distance ≈ apothem ${expectedApothem.toFixed(2)} m (got ${side?.t.toFixed(3)})`);
}

// ---- Phase B2 — round room -------------------------------------------

{
  const state = {
    room: {
      shape: 'round', round_radius_m: 8,
      width_m: 16, depth_m: 16, height_m: 4,
      ceiling_type: 'flat',
      surfaces: { floor: 'wood-floor', ceiling: 'gypsum-board', walls: 'concrete-painted' },
    },
    zones: [], sources: [], listeners: [],
    physics: { reverberantField: false, airAbsorption: true, freq_hz: 1000 },
  };
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: () => null });
  const soup = triangulateScene(scene);
  // Round approximated as 32-sided polygon: 32 floor + 32 ceiling + 64 wall = 128.
  ok(soup.count === 32 + 32 + 64, `Round flat room → 128 tris (got ${soup.count})`);
  // Ray sideways from centre should hit a wall at ~round_radius_m. Exact
  // value depends on whether the ray hits vertex or midpoint of a wall
  // segment — 32 sides gives min r ≈ 8 × cos(π/32) = 7.96, max = 8.
  const bvh = buildBVH(soup);
  const hit = intersectRay(bvh, 8, 8, 2, 1, 0, 0);
  ok(hit !== null && hit.sourceKey.startsWith('wall_'), `Round side ray hits a wall`);
  ok(hit && hit.t > 7.5 && hit.t < 8.1,
    `Round side distance ≈ radius 8 (got ${hit?.t.toFixed(3)})`);
}

// ---- Phase B2 — dome ceiling -----------------------------------------

{
  // Small test dome: polygon base radius 10, rise 4, so sphere radius R = (100+16)/8 = 14.5.
  // Cap apex is at z = baseZ + 4 = 4 (baseZ=0).
  const state = {
    room: {
      shape: 'polygon', polygon_sides: 12, polygon_radius_m: 10,
      width_m: 20, depth_m: 20, height_m: 0,       // wall height 0 → domed roof sits directly on floor
      ceiling_type: 'dome', ceiling_dome_rise_m: 4,
      surfaces: { floor: 'wood-floor', ceiling: 'acoustic-tile', walls: 'gypsum-board' },
    },
    zones: [], sources: [], listeners: [],
    physics: {},
  };
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: () => null });
  const soup = triangulateScene(scene);
  // 12-sided floor fan = 12 tris. Walls at h=0 collapse to zero-area quads
  // (2 tris each, 12 walls = 24 degenerate tris). Dome: 24 lon × 8 lat:
  //   apex ring = 24 tris, remaining 7 rings × 24 lon × 2 = 336 tris.
  //   Total dome = 24 + 336 = 360 tris.
  const expectedFloor = 12;
  const expectedWalls = 24;              // degenerate but still emitted
  const expectedDome  = 24 + 7 * 24 * 2;  // = 360
  const expectedTotal = expectedFloor + expectedWalls + expectedDome;
  ok(soup.count === expectedTotal,
    `Dome polygon room → ${expectedTotal} tris (got ${soup.count}; floor=${expectedFloor}, walls=${expectedWalls}, dome=${expectedDome})`);

  const bvh = buildBVH(soup);
  // Ray straight up from the centroid must hit the dome apex.
  // apex is at z = 4 (baseZ=0, rise=4). Origin at z=2 → t=2.
  const apexHit = intersectRay(bvh, 10, 10, 2, 0, 0, 1);
  ok(apexHit !== null && apexHit.surfaceTag === SURFACE_TAGS.CEILING,
    `Dome apex ray hits CEILING tag (got tag=${apexHit?.surfaceTag})`);
  ok(apexHit && Math.abs(apexHit.t - 2) < 0.01,
    `Dome apex hit at t=2 (got ${apexHit?.t.toFixed(3)})`);

  // Ray at 45° from centroid must hit the dome somewhere above the base
  // rim — hit elevation z > 0 expected.
  const diagHit = intersectRay(bvh, 10, 10, 0.1, 1, 0, 1);
  ok(diagHit !== null && diagHit.point[2] > 0.1,
    `Dome diagonal ray hits above the floor plane (got z=${diagHit?.point[2].toFixed(3)})`);
}

// ---- Phase B2 — custom polygon room ---------------------------------

{
  // L-shaped custom polygon would be concave; fan triangulation would
  // fail. For now custom rooms must be convex. Use a pentagon.
  const state = {
    room: {
      shape: 'custom', height_m: 3,
      width_m: 10, depth_m: 10,
      ceiling_type: 'flat',
      custom_vertices: [
        { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 10, y: 4 }, { x: 6, y: 8 }, { x: 0, y: 6 },
      ],
      surfaces: { floor: 'wood-floor', ceiling: 'gypsum-board', walls: 'concrete-painted' },
    },
    zones: [], sources: [], listeners: [],
    physics: {},
  };
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: () => null });
  const soup = triangulateScene(scene);
  // Pentagon: floor = 3 tris (fan from v0), ceiling = 3, walls = 5×2 = 10. Total 16.
  ok(soup.count === 3 + 3 + 10, `Custom pentagon room → 16 tris (got ${soup.count})`);
}

// ---- Phase B2 — arena preset end-to-end ------------------------------

{
  // This is the real-world stress case. Uses the live app-state.js to
  // apply the auditorium preset, then triangulates.
  const { state: appState, applyPresetToState } = await import('../js/app-state.js');
  applyPresetToState('auditorium');
  const scene = buildPhysicsScene({ state: appState, materials, getLoudspeakerDef: () => null });
  const soup = triangulateScene(scene);
  // Sanity: must have lots of triangles, BVH must build, rays must hit things.
  ok(soup.count > 500, `Arena preset → > 500 tris (got ${soup.count})`);
  const bvh = buildBVH(soup);
  // Ray upward from court centre must hit either scoreboard or dome.
  const hit = intersectRay(bvh, 30, 30, 1.5, 0, 0, 1);
  ok(hit !== null, `Arena court-centre ray-up hits something (sourceKey=${hit?.sourceKey})`);
  ok(hit && (hit.sourceKey?.startsWith('scoreboard_') || hit.sourceKey?.startsWith('dome_')),
    `Court-centre ray-up hits scoreboard or dome (got ${hit?.sourceKey})`);
  // Perf spot-check: 1000 rays on this larger BVH.
  const N = 1000;
  const rng = mulberry32(7);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const theta = rng() * 2 * Math.PI;
    const phi = (rng() - 0.5) * Math.PI;
    intersectRay(bvh, 30, 30, 2,
      Math.cos(phi) * Math.cos(theta),
      Math.cos(phi) * Math.sin(theta),
      Math.sin(phi));
  }
  const ms = performance.now() - t0;
  const raysPerMs = N / ms;
  console.log(`PERF  ${N} rays vs arena BVH (${soup.count} tris, ${bvh.nodeCount} nodes): ${ms.toFixed(1)} ms → ${raysPerMs.toFixed(0)} rays/ms`);
  ok(raysPerMs > 100, `perf budget on arena-scale scene: > 100 rays/ms`);
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
