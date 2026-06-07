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
  structureExposedArea, structureDirectPathLossPerBand, toiletPlanSegments, _testing,
} from '../js/physics/building-structures.js';
import { interactionPromptText } from '../js/graphics/walk-interaction.js';
import { structureBlocksCylinder, toiletBlocksCylinder } from '../js/physics/structure-walk-collision.js';
import { readFileSync } from 'node:fs';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';

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
// 6. Closed-top: boards reach the ceiling, but the FRONT above the door is
//    OPEN (v=781 — NO transom, like a real cubicle you can see over).
// =====================================================================
{
  const s = toiletAt({ topType: 'closed' });
  const low = { ...room, height_m: 2.20 };
  const inv = expandToiletSurfaces(s, low);
  const w = inv.walls.find(x => x.kind === 'divider');
  ok(approx(w.top, 2.20), 'closed-top board.top tracks the ceiling (2.20)', `(${w.top})`);
  ok(inv.ceilings.length === 0, 'low room: still no ceiling slab', `(${inv.ceilings.length})`);
  // v=781: ZERO transom walls — the front above the door is open to the ceiling.
  const transoms = inv.walls.filter(x => x.kind === 'transom');
  ok(transoms.length === 0, 'closed-top: ZERO transom walls (front above door is OPEN)', `(${transoms.length})`);
  // The door leaf top is below board.top (the ceiling); the gap above is open.
  const ceil = low.height_m;
  ok(inv.doors.every(d => d.doorTop < ceil - 1e-6),
     'closed-top door top < ceiling (open gap above the door)', `(top ${inv.doors[0].doorTop}, ceil ${ceil})`);
  // No solid wall covers doorTop → ceil at any door opening. Each door spans
  // [hingeU .. hingeU+leafW+latchGap] on the FRONT plane (local vFront). Confirm
  // no emitted wall sits in that vertical band on the front plane (transom-free).
  const doorTopMax = Math.max(...inv.doors.map(d => d.doorTop));
  const wallsAboveDoor = inv.walls.filter(x => x.top > doorTopMax + 1e-6 && x.base >= doorTopMax - 1e-6);
  ok(wallsAboveDoor.length === 0, 'no wall covers doorTop → ceiling at the front (over-door is open)', `(${wallsAboveDoor.length})`);
}

// =====================================================================
// 6b. v=781 — adjustable door height (closed-top): doorClearH_m sets the
//     leaf top, clamped to [1.8, 2.4] AND to ≤ board.top (the ceiling).
// =====================================================================
{
  // (i) custom door height tracks through to doorTop = elev + doorClearH.
  const s = toiletAt({ topType: 'closed', doorClearH_m: 2.00, elev_m: 0 });
  const inv = expandToiletSurfaces(s, room);   // room ceiling 3.0
  ok(inv.doors.every(d => approx(d.doorTop, 2.00)),
     'closed-top door top tracks doorClearH_m (2.00)', `(${inv.doors[0].doorTop})`);
  // leaf bottom = undercut (0.30), leaf fills the opening width (0.88).
  ok(inv.doors.every(d => approx(d.doorBottom, 0.30)), 'door bottom = undercut (0.30)');
  ok(inv.doors.every(d => approx(d.leafW, 0.88)), 'leaf still fills the opening (0.88 m)', `(${inv.doors[0].leafW})`);
  ok(inv.doors.every(d => approx(d.leafH, 2.00 - 0.30)), 'computed leaf height = doorClearH − undercut', `(${inv.doors[0].leafH})`);

  // (ii) ceiling clamp: a door height TALLER than the ceiling is capped to
  //      board.top by the expander (doorTop = min(elev+doorClearH, board.top)).
  const low = { ...room, height_m: 2.10 };
  const sTall = toiletAt({ topType: 'closed', doorClearH_m: 2.40, elev_m: 0 });
  const invLow = expandToiletSurfaces(sTall, low);
  ok(invLow.doors.every(d => d.doorTop <= low.height_m + 1e-9),
     'door top clamped to ≤ board.top (ceiling) when doorClearH exceeds it', `(${invLow.doors[0].doorTop})`);
  ok(invLow.walls.filter(x => x.kind === 'transom').length === 0,
     'still no transom even when door reaches the ceiling', '');
}

// =====================================================================
// 6c. v=781 — panel-structure.js clamps doorClearH_m to [1.8, 2.4] AND ≤ ceiling.
//     Text-grep guard over the editor wiring (matches the scene-x-mirror style).
// =====================================================================
{
  const src = readFileSync(new URL('../js/ui/panel-structure.js', import.meta.url), 'utf8');
  ok(/key === 'doorClearH_m'/.test(src), 'panel clamps the doorClearH_m key');
  ok(/Math\.max\(\s*1\.8/.test(src), "panel floor-clamps doorClearH_m to 1.8 m");
  ok(/Math\.min\(\s*2\.4/.test(src), "panel ceiling-clamps doorClearH_m to 2.4 m");
  ok(/ceilH\s*-\s*elevH/.test(src), 'panel also clamps doorClearH_m to ≤ (ceiling − elev)');
  ok(/'Door height'/.test(src), "panel exposes a 'Door height' editable field");
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
// 8. Phase-2 DIRECT-PATH loss is WIRED (flipped 2026-06-07 — was a stale
//    Phase-1 zero assertion). The reverberant absorption SINK is still 0.
// =====================================================================
{
  const s = toiletAt();
  // Reverb sink still Phase-2-pending → 0 (NaN-free).
  ok(structureExposedArea(s, room) === 0, 'structureExposedArea(toilet) === 0 (reverb sink Phase-2 pending, NaN-free)');
  // A source/listener line straight through the bank (S in front, L behind the
  // rear wall) now PICKS UP a non-zero through-board loss — the bank is modelled
  // as per-surface boards, not skipped (Topology A).
  const bands = [125, 250, 500, 1000, 2000, 4000, 8000];
  // Build a real material map so the boards have a finite TL.
  const md = JSON.parse(readFileSync('data/materials.json', 'utf8'));
  const matMap = new Map(md.materials.map(m => [m.id, m]));
  const loss = structureDirectPathLossPerBand(
    { x: 4, y: 1, z: 1.2 }, { x: 4, y: 7, z: 1.2 }, [s], matMap, bands, room,
  );
  ok(Array.from(loss).some(v => v > 0), 'direct-path loss is WIRED for toilet (non-zero through the bank, Topology A)', `(${Array.from(loss).map(v => v.toFixed(1))})`);
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

// =====================================================================
// 12. 2D pick hit-area — the toilet plan is mostly unfilled strokes, so
// the rendered <g> MUST carry a transparent filled hit polygon over the
// bank footprint or a click in the cubicle interior selects nothing and
// the structure panel never opens (regression: v=775).
// =====================================================================
{
  const fs = await import('node:fs');
  const url = await import('node:url');
  const here = url.fileURLToPath(new URL('.', import.meta.url));
  const room2d = fs.readFileSync(here + '../js/graphics/room-2d.js', 'utf8');
  // Isolate the toilet branch of renderStructuresSVG.
  const m = room2d.match(/if \(st\.type === 'toilet'\)[\s\S]{0,2000}?continue;/);
  ok(!!m, "room-2d.js has a renderStructuresSVG 'toilet' branch");
  const branch = m ? m[0] : '';
  ok(/r2d-structure-hit/.test(branch),
     "toilet branch renders a 'r2d-structure-hit' hit polygon (clickable interior)");
  ok(/fill="transparent"/.test(branch),
     'toilet hit polygon uses fill="transparent" (receives pointer events; fill:none would not)');
  ok(/structureFootprintCorners\(st\)/.test(branch),
     'toilet hit polygon spans the bank footprint (structureFootprintCorners)');
}

// =====================================================================
// 13. v=776 PART A — plan door-state dependence. A CLOSED door draws a
//     FLUSH leaf along the front face (no swing arc); an OPEN door draws
//     the swung leaf + the quarter-circle swing arc.
// =====================================================================
{
  const allClosed = toiletPlanSegments(toiletAt({ doorsOpen: [false, false, false] }), room);
  const cc = (role) => allClosed.primitives.filter(p => p.role === role).length;
  ok(cc('door-leaf') === 3 && cc('door-swing') === 0,
     'CLOSED doors → N flush leaves, ZERO swing arcs', `leaf=${cc('door-leaf')} swing=${cc('door-swing')}`);
  // The closed leaf lies on the front face — its two endpoints share the same
  // perpendicular offset from the bank centre line (both on vFront). Easiest
  // check: the closed leaf endpoints are NOT swung out (tip not at radius leafW
  // from hinge in the −y direction). Both endpoints lie on the front plane, so
  // the leaf length === leafW and it is collinear with the row (front face).
  const cl = allClosed.primitives.find(p => p.role === 'door-leaf');
  const clLen = Math.hypot(cl.b.x - cl.a.x, cl.b.y - cl.a.y);
  ok(approx(clLen, 0.90 - 0.010 - 0.010), 'closed leaf length === leafW (0.88), flush along front', `(${clLen})`);

  const oneOpen = toiletPlanSegments(toiletAt({ doorsOpen: [false, true, false] }), room);
  const oc = (role) => oneOpen.primitives.filter(p => p.role === role).length;
  ok(oc('door-leaf') === 3 && oc('door-swing') === 1,
     'exactly one OPEN door → N leaves, exactly 1 swing arc', `leaf=${oc('door-leaf')} swing=${oc('door-swing')}`);
  // Toggling a door visibly changes the plan: all-closed has 0 arcs, all-open 3.
  const allOpen = toiletPlanSegments(toiletAt({ doorsOpen: [true, true, true] }), room);
  ok(allOpen.primitives.filter(p => p.role === 'door-swing').length === 3,
     'ALL-OPEN → 3 swing arcs (plan reflects state — toggling changes the drawing)');
}

// =====================================================================
// 14. v=776 PART B — the precision SNAPSHOT emits per-WALL thin prisms for a
//     toilet (NOT one solid outer-rect box). An OPEN door omits its door wall
//     (gap for rays); a CLOSED door emits a solid leaf occluder.
// =====================================================================
{
  const md = JSON.parse(readFileSync('data/materials.json', 'utf8'));
  const materials = {
    frequency_bands_hz: md.frequency_bands_hz,
    list: md.materials,
    byId: Object.fromEntries(md.materials.map(m => [m.id, m])),
  };
  const getDef = () => ({ acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 0 } });
  const baseState = (toilet) => ({
    room: { shape: 'rectangular', width_m: 8, depth_m: 8, height_m: 3, ceiling_type: 'flat',
      surfaces: { floor: 'concrete-painted', ceiling: 'gypsum-board',
        wall_north: 'concrete-painted', wall_south: 'concrete-painted',
        wall_east: 'concrete-painted', wall_west: 'concrete-painted' } },
    sources: [], listeners: [], zones: [], treatments: [], furniture: [],
    rackSystem: { racks: [] }, structures: [toilet], physics: {},
  });

  // All doors CLOSED → the bank emits MANY items (N+1 dividers + 1 rear + N
  // closed doors + N bowls), NOT a single outer-rect box.
  const sceneClosed = buildPhysicsScene({ state: baseState(toiletAt({ doorsOpen: [false, false, false] })), materials, getLoudspeakerDef: getDef });
  const itemsClosed = sceneClosed.structures.items;
  ok(sceneClosed.structures.count > 1,
     'snapshot emits per-wall prisms (count > 1, NOT a single solid box)', `count=${sceneClosed.structures.count}`);
  ok(itemsClosed.every(it => it.footprint.length === 8),
     'every toilet structureItem is a 4-corner thin prism (footprint = 8 floats)');
  const closedDoors = itemsClosed.filter(it => /:door\d+$/.test(it.id));
  ok(closedDoors.length === 3, 'all-closed → 3 solid door-leaf occluders emitted', `(${closedDoors.length})`);

  // Open cubicle 1's door → its door wall is SKIPPED (gap for rays). Now only
  // 2 door occluders remain.
  const sceneOpen = buildPhysicsScene({ state: baseState(toiletAt({ doorsOpen: [false, true, false] })), materials, getLoudspeakerDef: getDef });
  const openDoors = sceneOpen.structures.items.filter(it => /:door\d+$/.test(it.id));
  ok(openDoors.length === 2, 'one open door → that door wall omitted (2 solid leaves remain → rays enter)', `(${openDoors.length})`);

  // Wall prisms carry the wall's own [base,top] (open-top boards stop at 2.0 m;
  // no bank-wide top cap). A divider wall item's top ≤ 2.0 for an open-top bank.
  const wallItems = itemsClosed.filter(it => /:wall\d+$/.test(it.id));
  ok(wallItems.length === 3 + 1 + 1, 'open-top: N+1 dividers + 1 rear = 5 wall prisms', `(${wallItems.length})`);
  ok(wallItems.every(it => it.top <= 2.0 + 1e-6),
     'open-top wall prisms stop at the board top (≤2.0 m) — rays pass over into the open top');
}

// =====================================================================
// 15. v=776 PART C — editable cubicle width/length; cubicles follow + the
//     door leaf still fills the (now wider) opening.
// =====================================================================
{
  const wide = toiletAt({ clearWidth_m: 1.20, clearDepth_m: 2.00 });
  const g = _testing.toiletGeom(wide);
  ok(approx(g.clearWidth, 1.20) && approx(g.clearDepth, 2.00), 'toiletGeom reads the edited clear dims');
  ok(approx(g.pitch, 1.20 + 0.05), 'pitch follows the wider cubicle (clearWidth + partition)', `(${g.pitch})`);
  ok(approx(g.lx, 3 * (1.20 + 0.05) + 0.05), 'bank width lx follows the wider cubicle', `(${g.lx})`);
  ok(approx(g.ly, 2.00 + 2 * 0.05), 'bank depth ly follows the longer cubicle', `(${g.ly})`);
  const inv = expandToiletSurfaces(wide, room);
  // Door leaf still fills the opening: leafW === clearWidth − latchGap − hingeReveal.
  ok(inv.doors.every(d => approx(d.leafW, 1.20 - 0.010 - 0.010)),
     'door leaf fills the WIDER opening (leafW = clearWidth − reveals = 1.18)', `(${inv.doors[0].leafW})`);
}

// =====================================================================
// 16. v=777 — adjustable floor gap (scuffGap_m) + pilaster feet under
//     floating open-top boards.
// =====================================================================
{
  // (a) scuffGap_m = 0 → open-top boards MEET the floor (base = elev) AND no feet.
  const s0 = toiletAt({ topType: 'open', scuffGap_m: 0, elev_m: 0 });
  const inv0 = expandToiletSurfaces(s0, room);
  const w0 = inv0.walls.find(x => x.kind === 'divider');
  ok(approx(w0.base, 0), 'scuffGap 0 → open-top board base = elev (meets floor)', `(${w0.base})`);
  ok(Array.isArray(inv0.feet) && inv0.feet.length === 0, 'scuffGap 0 → feet array EMPTY (no floating boards to support)', `(${inv0.feet.length})`);
  ok(approx(inv0.meta.scuffGap, 0), 'meta.scuffGap = 0 when gap closed', `(${inv0.meta.scuffGap})`);

  // (b) scuffGap_m > 0 → board base = elev + scuffGap AND feet rendered.
  const gap = 0.12;
  const sg = toiletAt({ topType: 'open', scuffGap_m: gap, elev_m: 0, cubicles: 3 });
  const invg = expandToiletSurfaces(sg, room);
  const wg = invg.walls.find(x => x.kind === 'divider');
  ok(approx(wg.base, gap), 'scuffGap 0.12 → open-top board base = elev + scuffGap', `(${wg.base})`);
  ok(Array.isArray(invg.feet) && invg.feet.length > 0, 'scuffGap > 0 → feet array NON-empty', `(${invg.feet.length})`);
  // At least cubicles+1 front feet (one per divider front pilaster).
  const front = invg.feet.filter(f => f.kind === 'frontFoot');
  ok(front.length === sg.cubicles + 1, 'cubicles+1 front pilaster feet (one per divider)', `(${front.length})`);
  // Every foot connects the floor (base = elev = 0) to the board base (top = scuffGap).
  ok(invg.feet.every(f => approx(f.base, 0)), 'every foot base = 0 (floor)', `(${invg.feet[0].base})`);
  ok(invg.feet.every(f => approx(f.top, gap)), 'every foot top = scuffGap (board base)', `(${invg.feet[0].top})`);
  ok(invg.feet.every(f => f.size > 0 && f.size <= 0.06), 'feet are slim (~board thickness, ≤ 60 mm)', `(${invg.feet[0].size})`);
  ok(approx(invg.meta.scuffGap, gap), 'meta.scuffGap echoes the gap', `(${invg.meta.scuffGap})`);

  // (b2) feet stand UNDER the divider front ends — x/y match a divider front pilaster
  // (default rotation 0: front plane at v = -ly/2, foot centred footSize/2 inside).
  // Sanity: the front feet share the bank's divider-U coordinates.
  const dG = _testing.toiletGeom(sg);
  const expectFrontU = (j) => -dG.lx / 2 + dG.partTh / 2 + j * dG.pitch;   // dividerU
  const frontUs = front.map(f => f.center.x - sg.position.x).sort((a, b) => a - b);
  const wantUs = Array.from({ length: sg.cubicles + 1 }, (_, j) => expectFrontU(j)).sort((a, b) => a - b);
  ok(frontUs.every((u, k) => approx(u, wantUs[k], 1e-6)), 'front feet sit under each divider pilaster (U coords match dividerU)');

  // (c) closed-top is UNAFFECTED — boards floor→ceiling (base 0), NO feet.
  const sc = toiletAt({ topType: 'closed', scuffGap_m: 0.15 });
  const invc = expandToiletSurfaces(sc, room);
  const wc = invc.walls.find(x => x.kind === 'divider');
  ok(approx(wc.base, 0), 'closed-top board base = 0 regardless of scuffGap_m (unaffected)', `(${wc.base})`);
  ok(Array.isArray(invc.feet) && invc.feet.length === 0, 'closed-top → NO feet (boards already reach the floor)', `(${invc.feet.length})`);
  ok(approx(invc.meta.scuffGap, 0), 'closed-top meta.scuffGap = 0 (no gap)', `(${invc.meta.scuffGap})`);

  // (d) gap clamp — values above 0.30 are clamped by the expander's board range.
  const sClamp = toiletAt({ topType: 'open', scuffGap_m: 0.9 });
  const invClamp = expandToiletSurfaces(sClamp, room);
  ok(approx(invClamp.meta.scuffGap, 0.30), 'scuffGap clamped to 0.30 m max', `(${invClamp.meta.scuffGap})`);
}

console.log(failed === 0 ? '\nAll toilet-structure tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
