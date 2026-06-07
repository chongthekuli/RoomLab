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
    openTopBoardH_m: 2.00, scuffGap_m: 0.15, doorClearH_m: 2.10,
    // v=774: doorLeafW_m UNSET → leaf fills the opening (0.88 m). hingeReveal_m
    // is the 10 mm hinge-jamb gap that replaces the old 0.29 m fixed filler.
    doorSide: '+y', hingeSide: 'left', frontLatchGap_m: 0.010, hingeReveal_m: 0.010, doorThk_m: 0.04,
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
// 5. Closed-top (DEFECT 1): boards run floor → REAL room ceiling, NO slab.
// =====================================================================
{
  const s = toiletAt({ topType: 'closed' });
  const tall = { ...room, height_m: 3.0 };
  const inv = expandToiletSurfaces(s, tall);
  const w = inv.walls.find(x => x.kind === 'divider');
  ok(approx(w.base, 0), 'closed-top board base = 0 (sealed to floor)', `(${w.base})`);
  // Priya assert (1a): closed-top board.top === room.height_m (reaches ceiling).
  ok(approx(w.top, tall.height_m), 'closed-top board.top === room.height_m (3.0)', `(${w.top})`);
  // Priya assert (1b): inv.ceilings is EMPTY (no floating slab).
  ok(inv.ceilings.length === 0, 'closed-top emits NO ceiling slab (ceilings empty)', `(${inv.ceilings.length})`);
}

// =====================================================================
// 6. Closed-top, different ceiling height → boards still reach it; transom seals.
// =====================================================================
{
  const s = toiletAt({ topType: 'closed' });
  const low = { ...room, height_m: 2.20 };
  const inv = expandToiletSurfaces(s, low);
  const w = inv.walls.find(x => x.kind === 'divider');
  ok(approx(w.top, 2.20), 'closed-top board.top tracks the ceiling (2.20)', `(${w.top})`);
  ok(inv.ceilings.length === 0, 'low room: still no ceiling slab', `(${inv.ceilings.length})`);
  // A transom panel seals the front above each door (doorTop → ceil).
  const transoms = inv.walls.filter(x => x.kind === 'transom');
  ok(transoms.length === s.cubicles, 'closed-top: 1 transom per door opening', `(${transoms.length})`);
  ok(transoms.every(t => approx(t.top, 2.20)), 'transom top === ceiling (sealed top-to-ceiling)');
}

// =====================================================================
// 7. Doors — undercut 0.30, computed leaf, open flag, doorsOpen sync.
// =====================================================================
{
  const s = toiletAt({ doorsOpen: [false, true, false] });
  const inv = expandToiletSurfaces(s, room);
  ok(inv.doors.every(d => approx(d.undercut_m, 0.30)), 'every door undercut = 0.30 m (user-confirmed)');
  // v=774: leaf fills the opening = clearWidth − latchGap − hingeReveal = 0.88.
  ok(inv.doors.every(d => approx(d.leafW, 0.90 - 0.010 - 0.010)), 'leaf width = 0.88 m (fills opening, walkable)', `(${inv.doors[0].leafW})`);
  // DEFECT 3: leafH is COMPUTED (doorTop − doorBottom). Open-top: 2.00 − 0.30 = 1.70.
  ok(inv.doors.every(d => approx(d.doorBottom, 0.30)), 'doorBottom = elev + undercut = 0.30');
  ok(inv.doors.every(d => approx(d.leafH, 1.70)), 'open-top computed leaf height = 1.70 m', `(${inv.doors[0].leafH})`);
  ok(inv.doors[0].open === false && inv.doors[1].open === true && inv.doors[2].open === false,
     'doors[i].open reads doorsOpen[i]');
  ok(s.doorsOpen.length === s.cubicles, 'doorsOpen length === cubicles');
}

// =====================================================================
// 7b. v=774 — DEFAULT leaf fills the opening: NO filler, and
//     hingeReveal + leafW + latchGap === clearWidth (gap-free front).
// =====================================================================
{
  const s = toiletAt();   // clearWidth 0.90, leaf UNSET → fills, latchGap 0.010, hingeReveal 0.010
  const inv = expandToiletSurfaces(s, room);
  const fillers = inv.walls.filter(w => w.kind === 'frontFiller');
  ok(fillers.length === 0, 'default leaf fills the opening → NO front filler emitted', `(${fillers.length})`);
  const leafW = inv.doors[0].leafW;
  const latchGap = Number(s.frontLatchGap_m);
  const hingeReveal = Number(s.hingeReveal_m);
  ok(approx(hingeReveal + leafW + latchGap, s.clearWidth_m),
     'hingeReveal + leafW + latchGap === clearWidth (gap-free front, 0.90)', `(${hingeReveal + leafW + latchGap})`);
}

// =====================================================================
// 7b-2. CUSTOM smaller leaf → filler re-emitted (back-compat), gap-free.
// =====================================================================
{
  const s = toiletAt({ doorLeafW_m: 0.60 });   // smaller than the 0.88 fill width
  const inv = expandToiletSurfaces(s, room);
  const fillers = inv.walls.filter(w => w.kind === 'frontFiller');
  ok(fillers.length === s.cubicles, 'custom smaller leaf → one filler per cubicle (back-compat)', `(${fillers.length})`);
  const fW = Math.hypot(fillers[0].b.x - fillers[0].a.x, fillers[0].b.y - fillers[0].a.y);
  const leafW = inv.doors[0].leafW;
  const latchGap = Number(s.frontLatchGap_m), hingeReveal = Number(s.hingeReveal_m);
  ok(approx(leafW, 0.60), 'custom leaf honored at 0.60', `(${leafW})`);
  ok(approx(fW, 0.90 - 0.60 - 0.010 - 0.010), 'fillerW = clearWidth − leaf − latchGap − hingeReveal = 0.28', `(${fW})`);
  ok(approx(hingeReveal + fW + leafW + latchGap, s.clearWidth_m),
     'hingeReveal + fillerW + leafW + latchGap === clearWidth (gap-free)', `(${hingeReveal + fW + leafW + latchGap})`);
  ok(approx(fillers[0].base, inv.walls.find(w => w.kind === 'divider').base) &&
     approx(fillers[0].top, inv.walls.find(w => w.kind === 'divider').top),
     'front filler spans full board height');
}

// =====================================================================
// 7c. Clamp — custom leaf ≥ fill width → filler 0, leaf clamped to fill width.
// =====================================================================
{
  const s = toiletAt({ doorLeafW_m: 1.20 });   // wider than the clear span
  const inv = expandToiletSurfaces(s, room);
  ok(inv.walls.filter(w => w.kind === 'frontFiller').length === 0, 'over-wide leaf → no filler emitted');
  ok(approx(inv.doors[0].leafW, 0.90 - 0.010 - 0.010),
     'over-wide leaf clamped to clearWidth − latchGap − hingeReveal (never overhangs)', `(${inv.doors[0].leafW})`);
}

// =====================================================================
// 7d. DEFECT 3 — door never exceeds the stall side height (top-type-aware).
// =====================================================================
{
  // Open-top: doorTop === board.top (door top aligns to side boards exactly).
  const so = toiletAt({ topType: 'open' });
  const io = expandToiletSurfaces(so, room);
  const boardTopO = io.walls.find(w => w.kind === 'divider').top;
  ok(io.doors.every(d => approx(d.doorTop, boardTopO)), 'open-top doorTop === board.top', `(${io.doors[0].doorTop} vs ${boardTopO})`);
  // Closed-top: doorTop === min(elev + doorClearH, board.top) = 2.10 (room 3.0).
  const sc = toiletAt({ topType: 'closed' });
  const ic = expandToiletSurfaces(sc, room);
  ok(ic.doors.every(d => approx(d.doorTop, 2.10)), 'closed-top doorTop = doorClearH (2.10)', `(${ic.doors[0].doorTop})`);
  ok(ic.doors.every(d => d.doorTop <= ic.walls.find(w => w.kind === 'divider').top + 1e-9),
     'closed-top doorTop never exceeds the side-board top');
}

// =====================================================================
// 7e. DEFECT 4 — bowl is flush to the rear wall inner face; bbox inside cubicle.
// =====================================================================
{
  const s = toiletAt({ rotation_deg: 0, position: { x: 4, y: 4 } });
  const inv = expandToiletSurfaces(s, room);
  const g = _testing.toiletGeom(s);
  const vWallWorld = s.position.y + (g.ly / 2 - g.partTh / 2);   // rear board inner face, world y
  const b0 = inv.bowls[0];
  // bbox: lx 0.36, ly 0.62, h 0.78; centre at bowlV = vWall − 0.31.
  ok(approx(b0.bbox.lx, 0.36) && approx(b0.bbox.ly, 0.62) && approx(b0.bbox.h, 0.78),
     'bowl bbox = 0.36 × 0.62 × 0.78');
  // Back face (toward wall, local +y) = centre.y + ly/2 must land on vWall.
  const backFace = b0.center.y + b0.bbox.ly / 2;
  ok(approx(backFace, vWallWorld), 'bowl back face sits exactly on rear-wall inner face (vWall)', `(${backFace} vs ${vWallWorld})`);
  // Footprint fully inside: depth 0.62 ≤ clearDepth 1.50, width 0.36 ≤ clearWidth 0.90.
  ok(b0.bbox.ly <= s.clearDepth_m + 1e-9, 'bowl depth 0.62 ≤ clearDepth (inside cubicle)');
  ok(b0.bbox.lx <= s.clearWidth_m + 1e-9, 'bowl width 0.36 ≤ clearWidth (inside cubicle)');
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
