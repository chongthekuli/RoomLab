// Occluder-registry guard (2026-06-05) — the "stop reminding us" test.
//
// RECURRING BUG (3×): each new placeable solid object type (furniture → racks
// → building structures) shot rays straight THROUGH it because it was never
// added to the triangle-soup occluder set the ray viz + precision tracer
// consume. Each was hand-patched only after the user noticed. Root cause
// (Hannes audit): nothing FAILS when a new type is omitted from
// scene-snapshot.js → triangulate-scene.js.
//
// This test is the tripwire. For every placeable solid entity type it asserts:
//   (1) a placed instance produces ≥1 triangle in the soup (it occludes), and
//   (2) a ray fired through it actually HITS it in the BVH (it reflects).
//
// A future 6th object type added to state but not wired into the snapshot /
// triangulator will fail here BEFORE the user has to report it again.
//
// Run: node tests/occluder-registry.test.mjs

import { readFileSync } from 'node:fs';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';
import { triangulateScene, SURFACE_TAGS } from '../js/physics/precision/triangulate-scene.js';
import { buildBVH, intersectRay } from '../js/physics/precision/bvh.js';
import { STRUCTURE_TYPES } from '../js/physics/building-structures.js';

const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};
const getDef = () => ({ acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 0 } });

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${!c && e ? '  — ' + e : ''}`); if (!c) failed++; };

function baseState(structures) {
  return {
    room: {
      shape: 'rectangular', width_m: 8, depth_m: 8, height_m: 3, ceiling_type: 'flat',
      surfaces: { floor: 'concrete-painted', ceiling: 'gypsum-board',
        wall_north: 'concrete-painted', wall_south: 'concrete-painted',
        wall_east: 'concrete-painted', wall_west: 'concrete-painted' },
    },
    sources: [], listeners: [], zones: [], treatments: [], furniture: [],
    rackSystem: { racks: [] },
    structures,
    physics: {},
  };
}

function makeStructureOf(type) {
  const common = { id: 'S1', type, position: { x: 4, y: 4 }, rotation_deg: 0, materialId: 'concrete-painted', elev_m: 0 };
  switch (type) {
    case 'pillar':    return { ...common, crossSection: 'round', diameter_m: 1.0, fullHeight: true };
    case 'half_wall': return { ...common, length_m: 3, height_m: 1.6, thickness_m: 0.2, fullHeight: false, rotation_deg: 90 };
    case 'partition': return { ...common, length_m: 4, height_m: 3, thickness_m: 0.2, fullHeight: true, rotation_deg: 90 };
    case 'beam':      return { ...common, length_m: 4, width_m: 0.3, depth_m: 0.4, soffitDrop_m: 0.4 };
    case 'platform':  return { ...common, width_m: 3, depth_m: 2, height_m: 0.4 };
    default:          return common;
  }
}

function structureTriCount(soup) {
  let n = 0;
  for (let i = 0; i < soup.count; i++) if (soup.surfaceTag[i] === SURFACE_TAGS.STRUCTURE) n++;
  return n;
}

// =====================================================================
// 1. Every structure type produces occluder triangles in the soup.
//    (The recurrence guard: a future structure subtype that isn't
//    triangulated trips here.)
// =====================================================================
for (const type of STRUCTURE_TYPES) {
  const scene = buildPhysicsScene({ state: baseState([makeStructureOf(type)]), materials, getLoudspeakerDef: getDef });
  const soup = triangulateScene(scene);
  ok(structureTriCount(soup) > 0, `structure type "${type}" produces occluder triangles`, 'not in the triangle soup → rays shoot through');
}

// =====================================================================
// 2. Empty structures → no structure triangles, no crash.
// =====================================================================
{
  const scene = buildPhysicsScene({ state: baseState([]), materials, getLoudspeakerDef: getDef });
  const soup = triangulateScene(scene);
  ok(structureTriCount(soup) === 0, 'no structures → zero structure triangles');
}

// =====================================================================
// 3. A ray fired through a pillar HITS it in the BVH (it occludes/reflects).
//    Pillar Ø1.0 at (4,4); ray along +x at ear height from (1,4) → (7,4).
// =====================================================================
{
  const scene = buildPhysicsScene({ state: baseState([makeStructureOf('pillar')]), materials, getLoudspeakerDef: getDef });
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const hit = intersectRay(bvh, 1, 4, 1.2, 1, 0, 0, 6);
  ok(hit && hit.surfaceTag === SURFACE_TAGS.STRUCTURE,
     'ray through a pillar hits the structure (no shoot-through)',
     hit ? `hit tag=${hit.surfaceTag} at t=${hit.t.toFixed(2)}` : 'no hit at all');
  // The hit must occur BEFORE the far wall (t < 6) — i.e. the pillar, not the wall behind it.
  ok(hit && hit.t < 5, 'pillar hit precedes the far wall', hit ? `t=${hit.t.toFixed(2)}` : 'no hit');
}

// =====================================================================
// 4. Unresolved material → still a SOLID occluder (reflective fallback),
//    never a hole. (Guards the catalogue-race silent-skip.)
// =====================================================================
{
  const bogus = { ...makeStructureOf('pillar'), materialId: 'this-material-does-not-exist' };
  const scene = buildPhysicsScene({ state: baseState([bogus]), materials, getLoudspeakerDef: getDef });
  const soup = triangulateScene(scene);
  ok(structureTriCount(soup) > 0, 'structure with unknown material still triangulates (solid fallback)');
  const bvh = buildBVH(soup);
  const hit = intersectRay(bvh, 1, 4, 1.2, 1, 0, 0, 6);
  ok(hit && hit.surfaceTag === SURFACE_TAGS.STRUCTURE && hit.materialIdx >= 0,
     'ray hits the unresolved-material structure with a valid (fallback) material',
     hit ? `tag=${hit.surfaceTag} mat=${hit.materialIdx}` : 'no hit');
}

// =====================================================================
// 5. Registry intent: scene-snapshot must READ state.structures. A future
//    refactor that drops the read (so the block is always empty) trips here.
// =====================================================================
{
  const withStruct = buildPhysicsScene({ state: baseState([makeStructureOf('pillar')]), materials, getLoudspeakerDef: getDef });
  ok(withStruct.structures && withStruct.structures.count === 1,
     'scene snapshot reads state.structures into scene.structures', `count=${withStruct.structures?.count}`);
}

console.log(failed === 0 ? '\nAll occluder-registry tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
