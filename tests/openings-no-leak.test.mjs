// Wall-opening aliasing regression (2026-06-04).
//
// BUG: in 3D mode the user selects ONE wall, adds a door/window, and the
// opening appears on ALL walls. Root cause (Martina review) was state
// aliasing in two parts, both in js/ui/panel-room.js:
//
//   ORIGIN — the polygon-"walls" → custom-edge convert sites built the
//   per-edge slots with `verts.map(() => surfaces.walls)`, which aliases
//   ONE object reference into every edge. Harmless while surfaces.walls is
//   a string; once the user adds an opening (making it an object), all
//   edges share that one object AND its one openings[] array.
//
//   PROPAGATION — readSlotAsObject() returned slot.openings BY REFERENCE.
//   The add handler then did `next.openings.push(...)`, mutating the
//   shared array, so every aliased wall gained the opening.
//
// FIX:
//   1. readSlotAsObject clones: `openings: readSlotOpenings(slot).map(o => ({...o}))`.
//   2. both convert sites seed via cloneSlotSeed() (deep-copy objects).
//
// panel-room.js imports Three.js / DOM modules at load, so it can't be
// imported in Node. Per the repo convention (tests/scene-x-mirror.test.mjs,
// tests/cross-surface-conventions.test.mjs), this test has TWO halves:
//   (A) a BEHAVIORAL replica of the exact add path proving the de-aliasing
//       semantics are correct, and
//   (B) a GREP TRIPWIRE over the real source so removing either fix fails
//       the build. (B) is the actual regression guard; (A) documents intent.

import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${!c && e ? '  — ' + e : ''}`); if (!c) failed++; };

const SRC = readFileSync('./js/ui/panel-room.js', 'utf8');

// --------------------------------------------------------------------
// (A) Behavioral replica — mirrors panel-room.js readSlotAsObject (FIXED
//     form, with the clone) + the +Door add-handler body. If the clone is
//     present, an add to one wall must NOT touch a slot that shares its
//     openings array.
// --------------------------------------------------------------------

// Verbatim mirror of readSlotAsObject (panel-room.js ~1487) WITH the fix.
function readSlotAsObject(slot, fallback = 'gypsum-board') {
  const matId = typeof slot === 'string'
    ? slot
    : (slot && typeof slot === 'object' && typeof slot.materialId === 'string' ? slot.materialId : fallback);
  const t = slot && typeof slot === 'object' ? Number(slot.thickness_m) : NaN;
  const openings = slot && typeof slot === 'object' && Array.isArray(slot.openings) ? slot.openings : [];
  return {
    materialId: matId,
    thickness_m: Number.isFinite(t) && t > 0 ? t : 0.10,
    openings: openings.map(o => ({ ...o })),   // ← the fix under test
  };
}
const DEFAULT_DOOR = { kind: 'door', width_m: 0.9, height_m: 2.1, x_m: 0.5, z_m: 0, materialId: 'door-solid-wood', state: 'closed', thickness_m: 0.05 };

// Propagation guard: two wall slots deliberately SHARE one openings array
// (the post-convert aliased precondition). Add a door to the "north" slot
// via the real handler body; the shared "south"/"east" slots must stay
// empty.
{
  const sharedOpenings = [];
  const surfaces = {
    wall_north: { materialId: 'gypsum-board', thickness_m: 0.10, openings: sharedOpenings },
    wall_south: { materialId: 'gypsum-board', thickness_m: 0.10, openings: sharedOpenings },
    wall_east:  { materialId: 'gypsum-board', thickness_m: 0.10, openings: sharedOpenings },
  };
  // Verbatim add-handler body (panel-room.js ~2014).
  const getSlot = () => surfaces.wall_north;
  const setSlot = v => { surfaces.wall_north = v; };
  const next = readSlotAsObject(getSlot());
  next.openings.push({ ...DEFAULT_DOOR, id: 'op-test1' });
  setSlot(next);

  ok(surfaces.wall_north.openings.length === 1, 'add: target wall (north) gains the door');
  ok(surfaces.wall_south.openings.length === 0, 'no-leak: south wall stays empty (shared-array de-aliased)',
     `south has ${surfaces.wall_south.openings.length}`);
  ok(surfaces.wall_east.openings.length === 0, 'no-leak: east wall stays empty',
     `east has ${surfaces.wall_east.openings.length}`);
  ok(sharedOpenings.length === 0, 'no-leak: the original shared array was never mutated');
}

// Origin guard: cloneSlotSeed must de-alias an OBJECT seed across edges.
{
  // Verbatim mirror of cloneSlotSeed (panel-room.js ~1471).
  const cloneSlotSeed = slot => (typeof slot === 'string' ? slot : (slot ? JSON.parse(JSON.stringify(slot)) : 'gypsum-board'));
  const walls = { materialId: 'gypsum-board', thickness_m: 0.10, openings: [{ ...DEFAULT_DOOR, id: 'op-seed' }] };
  const verts = [0, 1, 2, 3];
  const edges = verts.map(() => cloneSlotSeed(walls));
  ok(edges[0] !== edges[1], 'seed: edges do not share the slot object reference');
  ok(edges[0].openings !== edges[1].openings, 'seed: edges do not share the openings array reference');
  // Mutating one edge must not touch another.
  edges[0].openings.push({ ...DEFAULT_DOOR, id: 'op-extra' });
  ok(edges[1].openings.length === 1, 'seed: adding to edge0 does not leak to edge1',
     `edge1 has ${edges[1].openings.length}`);
}

// Counter-proof: the OLD buggy form (no clone) DOES leak — proves the
// assertions above actually discriminate the fix.
{
  const buggyRead = slot => ({ openings: (slot.openings || []) });   // by-reference, pre-fix
  const sharedOpenings = [];
  const surfaces = {
    wall_north: { openings: sharedOpenings },
    wall_south: { openings: sharedOpenings },
  };
  const next = buggyRead(surfaces.wall_north);
  next.openings.push({ id: 'x' });
  surfaces.wall_north = next;
  ok(surfaces.wall_south.openings.length === 1,
     'counter-proof: pre-fix by-reference read DOES leak (test discriminates the fix)');
}

// --------------------------------------------------------------------
// (B) Grep tripwire over the REAL source — the actual regression guard.
//     If anyone reverts either fix, these fail.
// --------------------------------------------------------------------

ok(/openings:\s*readSlotOpenings\(slot\)\.map\(o\s*=>\s*\(\{\s*\.\.\.o\s*\}\)\)/.test(SRC),
   'source: readSlotAsObject clones openings (.map(o => ({...o})))',
   'the by-reference openings read is back — door adds will leak across aliased walls');

ok(/function\s+cloneSlotSeed\s*\(/.test(SRC),
   'source: cloneSlotSeed helper exists');

// Both convert sites must seed via cloneSlotSeed, NOT the raw
// `.map(() => state.room.surfaces.walls ...)` alias.
const seedAliasMatches = SRC.match(/\.map\(\(\)\s*=>\s*state\.room\.surfaces\.walls/g) || [];
ok(seedAliasMatches.length === 0,
   'source: no convert site uses the raw `.map(() => surfaces.walls)` alias',
   `found ${seedAliasMatches.length} raw-alias seed site(s) — wrap in cloneSlotSeed`);

const seedCloneMatches = SRC.match(/\.map\(\(\)\s*=>\s*cloneSlotSeed\(state\.room\.surfaces\.walls\)\)/g) || [];
ok(seedCloneMatches.length >= 2,
   'source: both convert sites seed edges via cloneSlotSeed(surfaces.walls)',
   `found ${seedCloneMatches.length} cloned seed site(s), expected ≥ 2`);

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll opening-aliasing regression tests passed.');
