// Walk-collision registry guard (2026-06-05) — the avatar "stop reminding us" test.
//
// RECURRING BUG (3×): each new placeable solid type (rack → furniture →
// structure) let the walk-mode avatar pass straight through it until the user
// reported it, because scene.js combined per-type blockers inline and nothing
// failed when a type was omitted.
//
// Fix: all solid types route through ONE aggregator,
// js/physics/walk-collision.js::sceneBlocksCylinder. This test enumerates each
// solid type THROUGH that aggregator, so a new type that isn't wired fails here
// before the user has to walk through it. It also greps that scene.js calls the
// aggregator (no inline per-type chain can creep back).
//
// Run: node tests/walk-collision-registry.test.mjs

import { readFileSync } from 'node:fs';
import { sceneBlocksCylinder } from '../js/physics/walk-collision.js';
import { structureBlocksCylinder } from '../js/physics/structure-walk-collision.js';
import { STRUCTURE_TYPES } from '../js/physics/building-structures.js';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}  ${e}`); if (!c) failed++; };

const room = { width_m: 8, depth_m: 8, height_m: 3 };
function structureAt(type, x = 4, y = 4) {
  const common = { id: 'S1', type, position: { x, y }, rotation_deg: 0, materialId: 'concrete-painted', elev_m: 0 };
  switch (type) {
    case 'pillar':    return { ...common, crossSection: 'round', diameter_m: 1.0, fullHeight: true };
    case 'half_wall': return { ...common, length_m: 4, height_m: 1.6, thickness_m: 0.2, fullHeight: false, rotation_deg: 90 };
    case 'partition': return { ...common, length_m: 4, height_m: 3, thickness_m: 0.2, fullHeight: true, rotation_deg: 90 };
    case 'beam':      return { ...common, length_m: 4, width_m: 0.3, depth_m: 0.4, soffitDrop_m: 0.4 };
    case 'platform':  return { ...common, width_m: 3, depth_m: 2, height_m: 0.4 };
    case 'toilet':    return {
      ...common, cubicles: 3, clearWidth_m: 0.90, clearDepth_m: 1.50, partitionThickness_m: 0.05,
      topType: 'open', openTopBoardH_m: 2.00, scuffGap_m: 0.15, undercut_m: 0.30,
      hingeSide: 'left', doorLeafW_m: 0.60, doorLeafH_m: 2.00, doorThk_m: 0.04,
      doorsOpen: [false, false, false], showBowls: true, seatHeight_m: 0.42,
    };
    default:          return common;
  }
}

// Standing avatar: cylinder z 0..1.8, radius 0.3.
const AV = { yMin: 0, yMax: 1.8, radius: 0.3 };

// =====================================================================
// 1. Every structure type blocks the avatar at its location, and open
//    space (far corner) does not. (Beams are overhead — handled in #2.)
// =====================================================================
for (const type of STRUCTURE_TYPES) {
  const s = structureAt(type, 4, 4);
  const atIt = structureBlocksCylinder(4, 4, AV.yMin, AV.yMax, AV.radius, [s], room);
  const farAway = structureBlocksCylinder(0.3, 0.3, AV.yMin, AV.yMax, AV.radius, [s], room);
  if (type === 'beam') {
    // A floor-standing avatar walks UNDER a high beam (no block); a raised
    // probe in the beam's vertical span IS blocked.
    ok(!atIt, `beam: floor-standing avatar walks UNDER it (no block)`, `(blocked=${atIt})`);
    const up = structureBlocksCylinder(4, 4, 2.5, 3.0, AV.radius, [s], room);
    ok(up, `beam: a probe at beam height IS blocked`, `(blocked=${up})`);
  } else if (type === 'toilet') {
    // The toilet bank is a COMPOSITE — NOT a solid box. Its BOARDS + closed
    // doors + bowls block; its cubicle interiors are reachable through an OPEN
    // door. (The default doorsOpen are all closed, so a tight cubicle centre
    // can legitimately be blocked by the bowl — that's why the registry probes
    // a board for "solid" and an open-door interior for "walkable".)
    // Leftmost divider front jamb: bank centre x=4; lx = 3*0.95+0.05 = 2.90,
    // so the left outer face is at x = 4 - 1.45 = 2.55, divider0 centre at
    // 2.575; front of the bank at y = 4 - 0.80 = 3.20.
    const onBoard = structureBlocksCylinder(2.575, 3.30, AV.yMin, AV.yMax, AV.radius, [s], room);
    ok(onBoard, `toilet: a divider board IS solid to the avatar`, `(blocked=${onBoard})`);
    // Open the middle cubicle's door → a small probe just inside its threshold
    // is reachable (the outer rectangle is not a solid box).
    const sOpen = { ...s, doorsOpen: [false, true, false] };
    const insideMiddle = structureBlocksCylinder(4, 3.45, AV.yMin, AV.yMax, 0.06, [sOpen], room);
    ok(!insideMiddle, `toilet: an open cubicle's interior is reachable (composite, not a solid box)`, `(blocked=${insideMiddle})`);
  } else {
    ok(atIt, `structure type "${type}" blocks the avatar at its location`, `(blocked=${atIt})`);
  }
  ok(!farAway, `structure type "${type}": avatar in the far corner is NOT blocked`, `(blocked=${farAway})`);
}

// =====================================================================
// 2. The AGGREGATOR routes to structures (the actual scene.js code path).
// =====================================================================
{
  const s = structureAt('pillar', 4, 4);
  const hit = sceneBlocksCylinder({ sx: 4, sy: 4, yMin: 0, yMax: 1.8, radius: 0.3, structures: [s], room });
  ok(hit, 'sceneBlocksCylinder blocks on a pillar (structures wired into the aggregator)');
  const miss = sceneBlocksCylinder({ sx: 0.3, sy: 0.3, yMin: 0, yMax: 1.8, radius: 0.3, structures: [s], room });
  ok(!miss, 'sceneBlocksCylinder: open space is walkable');
  // Empty everything → never blocks, never throws.
  ok(!sceneBlocksCylinder({ sx: 1, sy: 1, yMin: 0, yMax: 1.8, radius: 0.3 }), 'sceneBlocksCylinder with nothing placed → false');
}

// =====================================================================
// 3. Registry intent (grep guards): the aggregator wires every solid type,
//    and scene.js routes walk collision THROUGH the aggregator (no inline
//    per-type chain can creep back and re-introduce the recurrence).
// =====================================================================
{
  const agg = readFileSync('js/physics/walk-collision.js', 'utf8');
  for (const fn of ['furnitureBlocksCylinder', 'rackBlocksCylinder', 'structureBlocksCylinder']) {
    ok(agg.includes(fn), `aggregator wires ${fn}`);
  }
  const scene = readFileSync('js/graphics/scene.js', 'utf8');
  ok(/sceneBlocksCylinder\s*\(/.test(scene), 'scene.js routes walk collision through sceneBlocksCylinder');
  ok(!/furnitureBlocksCylinder\s*\([^)]*\)\s*\|\|\s*rackBlocksCylinder/.test(scene),
     'scene.js no longer has the inline furniture||rack collision chain (uses the aggregator)');
}

console.log(failed === 0 ? '\nAll walk-collision-registry tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
