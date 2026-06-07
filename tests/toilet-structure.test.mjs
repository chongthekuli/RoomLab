// Toilet cubicle bank — Phase 1 pure-expander guard (2026-06-07).
//
// Guards the PURE expander expandToiletSurfaces() (js/physics/building-structures.js):
// the constituent-surface inventory the 3D renderer + Phase-2 physics both
// consume. Asserts the wall/door/ceiling/bowl counts, the open-vs-closed-top
// geometry (scuff gap vs sealed-to-floor + ceiling slab), the 0.30 m undercut,
// and doorsOpen length === cubicles. Plus the walk-mode 'toilet' prompt copy
// (same-PR rule for the walk-interaction change).
//
// Run: node tests/toilet-structure.test.mjs

import {
  STRUCTURE_TYPES, expandToiletSurfaces, structurePlanSize, structureFootprintCorners,
  structureExposedArea, structureDirectPathLossPerBand, _testing,
} from '../js/physics/building-structures.js';
import { interactionPromptText } from '../js/graphics/walk-interaction.js';
import { structureBlocksCylinder, toiletBlocksCylinder } from '../js/physics/structure-walk-collision.js';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}  ${e}`); if (!c) failed++; };
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const room = { width_m: 8, depth_m: 8, height_m: 3 };

function toiletAt(over = {}) {
  return {
    id: 'T1', type: 'toilet', position: { x: 4, y: 4 }, rotation_deg: 0,
    materialId: 'gypsum-board', elev_m: 0,
    cubicles: 3, pitch_m: 0.95, clearWidth_m: 0.90, clearDepth_m: 1.50, partitionThickness_m: 0.05,
    backToBack: false,
    topType: 'open',
    openTopBoardH_m: 2.00, closedTopBoardH_m: 2.40, ceilingThk_m: 0.05, scuffGap_m: 0.15,
    doorSide: '+y', hingeSide: 'left', doorLeafW_m: 0.60, doorLeafH_m: 2.00, doorThk_m: 0.04,
    undercut_m: 0.30,
    doorsOpen: [false, false, false],
    showBowls: true, seatHeight_m: 0.42,
    ...over,
  };
}

// =====================================================================
// 1. Type is registered.
// =====================================================================
ok(STRUCTURE_TYPES.includes('toilet'), "'toilet' is a recognised STRUCTURE_TYPE");

// =====================================================================
// 2. Geometry — pitch + bank outer rectangle.
// =====================================================================
{
  const s = toiletAt();
  const g = _testing.toiletGeom(s);
  ok(approx(g.pitch, 0.95), 'pitch = clearWidth(0.90) + partition(0.05) = 0.95', `(${g.pitch})`);
  ok(approx(g.lx, 3 * 0.95 + 0.05), 'bank width lx = cubicles*pitch + partitionThickness', `(${g.lx})`);
  ok(approx(g.ly, 1.50 + 2 * 0.05), 'bank depth ly = clearDepth + 2*partition (~1.60)', `(${g.ly})`);
  const ps = structurePlanSize(s);
  ok(approx(ps.lx, g.lx) && approx(ps.ly, g.ly), 'structurePlanSize returns the bank outer rect');
  const corners = structureFootprintCorners(s);
  ok(corners.length === 4, 'footprint corners = the 4-corner bank outline', `(${corners.length})`);
}

// =====================================================================
// 3. Wall inventory — N+1 dividers + 1 rear + N doors.
// =====================================================================
{
  const s = toiletAt();
  const inv = expandToiletSurfaces(s, room);
  const dividers = inv.walls.filter(w => w.kind === 'divider');
  const rears = inv.walls.filter(w => w.kind === 'rear');
  ok(dividers.length === s.cubicles + 1, 'N+1 shared dividing partitions', `(${dividers.length})`);
  ok(rears.length === 1, '1 continuous rear wall', `(${rears.length})`);
  ok(inv.doors.length === s.cubicles, 'N door openings (one per cubicle)', `(${inv.doors.length})`);
  ok(inv.bowls.length === s.cubicles, 'N bowls (one per cubicle)', `(${inv.bowls.length})`);
}

// =====================================================================
// 4. Open-top: scuff gap under the boards, no ceiling slab.
// =====================================================================
{
  const s = toiletAt({ topType: 'open' });
  const inv = expandToiletSurfaces(s, room);
  const w = inv.walls[0];
  ok(approx(w.base, 0.15), 'open-top board base = scuff gap 0.15 m', `(${w.base})`);
  ok(approx(w.top, 2.00), 'open-top board top = 2.00 m', `(${w.top})`);
  ok(inv.ceilings.length === 0, 'open-top has NO ceiling slabs', `(${inv.ceilings.length})`);
}

// =====================================================================
// 5. Closed-top: sealed to floor (base 0), ceiling slab per cubicle.
// =====================================================================
{
  const s = toiletAt({ topType: 'closed' });
  const tall = { ...room, height_m: 3.0 };
  const inv = expandToiletSurfaces(s, tall);
  const w = inv.walls[0];
  ok(approx(w.base, 0), 'closed-top board base = 0 (sealed to floor, no scuff gap)', `(${w.base})`);
  ok(approx(w.top, 2.40), 'closed-top board top = 2.40 m', `(${w.top})`);
  ok(inv.ceilings.length === s.cubicles, 'closed-top has 1 ceiling slab per cubicle', `(${inv.ceilings.length})`);
  ok(approx(inv.ceilings[0].base, 2.40), 'ceiling slab base = 2.40 m', `(${inv.ceilings[0].base})`);
  ok(approx(inv.ceilings[0].thickness_m, 0.05), 'ceiling slab thickness = 0.05 m', `(${inv.ceilings[0].thickness_m})`);
}

// =====================================================================
// 6. Closed-top clamp: low room → board top clamps to ceiling, slab drops.
// =====================================================================
{
  const s = toiletAt({ topType: 'closed' });
  const low = { ...room, height_m: 2.20 };   // below the 2.40 board height
  const inv = expandToiletSurfaces(s, low);
  ok(approx(inv.walls[0].top, 2.20), 'low room: board top clamps to ceiling (2.20)', `(${inv.walls[0].top})`);
  ok(inv.ceilings[0].base + inv.ceilings[0].thickness_m <= 2.20 + 1e-6,
     'low room: ceiling slab never pokes through the room ceiling',
     `(${inv.ceilings[0].base + inv.ceilings[0].thickness_m})`);
}

// =====================================================================
// 7. Doors — undercut 0.30, open flag passthrough, doorsOpen sync.
// =====================================================================
{
  const s = toiletAt({ doorsOpen: [false, true, false] });
  const inv = expandToiletSurfaces(s, room);
  ok(inv.doors.every(d => approx(d.undercut_m, 0.30)), 'every door undercut = 0.30 m (user-confirmed)');
  ok(inv.doors.every(d => approx(d.leafW, 0.60) && approx(d.leafH, 2.00)), 'leaf 0.60 × 2.00 m');
  ok(inv.doors[0].open === false && inv.doors[1].open === true && inv.doors[2].open === false,
     'doors[i].open reads doorsOpen[i]');
  ok(s.doorsOpen.length === s.cubicles, 'doorsOpen length === cubicles');
}

// =====================================================================
// 8. Phase-2 acoustics are NOT wired (no NaN, no spurious loss).
// =====================================================================
{
  const s = toiletAt();
  ok(structureExposedArea(s, room) === 0, 'structureExposedArea(toilet) === 0 (Phase 2 pending, NaN-free)');
  // A source/listener line straight through the bank must NOT pick up a loss
  // from the toilet in Phase 1 (the bank outer rect is not a solid box).
  const bands = [125, 250, 500, 1000, 2000, 4000, 8000];
  const loss = structureDirectPathLossPerBand(
    { x: 4, y: 1, z: 1.2 }, { x: 4, y: 7, z: 1.2 }, [s], new Map(), bands, room,
  );
  ok(Array.from(loss).every(v => v === 0), 'direct-path loss skips toilet in Phase 1 (all-zero)');
}

// =====================================================================
// 9. Walk-collision — closed door + boards + bowl block; open door is
//    walk-through; the generic blocker delegates to the toilet collider.
// =====================================================================
{
  const s = toiletAt();
  const inv = expandToiletSurfaces(s, room);
  const AV = { yMin: 0, yMax: 1.8, radius: 0.28 };
  // A divider board location is solid.
  const w = inv.walls.find(x => x.kind === 'divider');
  const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
  ok(toiletBlocksCylinder(mid.x, mid.y, AV.yMin, AV.yMax, AV.radius, s, room),
     'a divider board blocks the avatar');
  // The far corner is open.
  ok(!toiletBlocksCylinder(0.3, 0.3, AV.yMin, AV.yMax, AV.radius, s, room),
     'far corner is walkable');
  // A CLOSED door (cubicle 0) blocks at its leaf midpoint.
  const d0 = inv.doors[0];
  const free0 = { x: d0.hinge.x + d0.axis.x * d0.leafW, y: d0.hinge.y + d0.axis.y * d0.leafW };
  const leafMid0 = { x: (d0.hinge.x + free0.x) / 2, y: (d0.hinge.y + free0.y) / 2 };
  ok(toiletBlocksCylinder(leafMid0.x, leafMid0.y, AV.yMin, AV.yMax, AV.radius, s, room),
     'a CLOSED door blocks the avatar');
  // Open that door → its leaf no longer blocks (avatar enters the cubicle).
  const sOpen = toiletAt({ doorsOpen: [true, false, false] });
  ok(!toiletBlocksCylinder(leafMid0.x, leafMid0.y, AV.yMin, AV.yMax, AV.radius, sOpen, room),
     'an OPEN door is walk-through (leaf stops blocking)');
  // A bowl blocks the avatar (it is NOT walk-through).
  const b0 = inv.bowls[0];
  ok(toiletBlocksCylinder(b0.center.x, b0.center.y, AV.yMin, AV.yMax, AV.radius, s, room),
     'a bowl blocks the avatar');
  // The generic structureBlocksCylinder routes toilets to the per-surface path
  // (the OUTER bank rectangle is NOT solid — far corner walkable, board solid).
  ok(structureBlocksCylinder(mid.x, mid.y, AV.yMin, AV.yMax, AV.radius, [s], room),
     'structureBlocksCylinder delegates toilet → board is solid');
  ok(!structureBlocksCylinder(0.3, 0.3, AV.yMin, AV.yMax, AV.radius, [s], room),
     'structureBlocksCylinder: toilet outer rect is NOT solid (far corner walkable)');
  // The CENTRE of cubicle 1 (door open) must be reachable — proves the outer
  // rectangle is not treated as a solid box.
  const c1 = { x: 4, y: 4 };   // bank centre ≈ cubicle 1 (middle) interior
  const inv1 = expandToiletSurfaces(s, room);
  void inv1;
  ok(!toiletBlocksCylinder(c1.x, c1.y, AV.yMin, AV.yMax, 0.05, toiletAt({ doorsOpen: [false, true, false] }), room),
     'interior of a cubicle (tiny probe, door open) is reachable');
}

// =====================================================================
// 10. Rotation — the bank rotates about its centre (corners move).
// =====================================================================
{
  const a = expandToiletSurfaces(toiletAt({ rotation_deg: 0 }), room);
  const b = expandToiletSurfaces(toiletAt({ rotation_deg: 90 }), room);
  const ra = a.walls.find(w => w.kind === 'rear');
  const rb = b.walls.find(w => w.kind === 'rear');
  ok(!approx(ra.a.x, rb.a.x) || !approx(ra.a.y, rb.a.y),
     'rotating the bank moves the rear wall endpoints (rotation about centre works)');
}

// =====================================================================
// 11. Walk-mode 'Press E' prompt copy for toilet doors.
// =====================================================================
ok(interactionPromptText('toilet', null, false) === 'Press E to open the toilet door',
   "closed toilet door → 'Press E to open the toilet door'");
ok(interactionPromptText('toilet', null, true) === 'Press E to close the toilet door',
   "open toilet door → 'Press E to close the toilet door'");

console.log(failed === 0 ? '\nAll toilet-structure tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
