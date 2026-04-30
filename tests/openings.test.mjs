// PR2: doors / windows on walls. Verifies the wall-slot schema accepts
// both legacy string and new object form, that opening area is subtracted
// from the parent wall's surface area (no double counting), and that
// open / closed state resolves to the right material id.

import { roomSurfaces, normalizeWallSlot } from '../js/physics/room-shape.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!ok) failed++;
}
function assertClose(actual, expected, tol, label) {
  const ok = Math.abs(actual - expected) < tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${actual} expected=${expected}`);
  if (!ok) failed++;
}

// ---- normalizeWallSlot ---------------------------------------------------

assertEq(
  normalizeWallSlot('gypsum-board'),
  { materialId: 'gypsum-board', openings: [] },
  'string slot → object with empty openings',
);

assertEq(
  normalizeWallSlot({ materialId: 'concrete-painted', openings: [{ kind: 'door' }] }),
  { materialId: 'concrete-painted', openings: [{ kind: 'door' }] },
  'object slot pass-through',
);

assertEq(
  normalizeWallSlot(null),
  { materialId: 'gypsum-board', openings: [] },
  'null slot → fallback default',
);

assertEq(
  normalizeWallSlot(undefined, 'wood-floor'),
  { materialId: 'wood-floor', openings: [] },
  'undefined slot → caller-supplied fallback',
);

// ---- roomSurfaces with closed door -----------------------------------------

const baseRoom = {
  shape: 'rectangular',
  width_m: 10,
  depth_m: 8,
  height_m: 3,
  ceiling_type: 'flat',
  surfaces: {
    floor: 'wood-floor',
    ceiling: 'acoustic-tile',
    wall_north: 'gypsum-board',   // legacy string
    wall_south: 'gypsum-board',
    wall_east: 'gypsum-board',
    wall_west: 'gypsum-board',
  },
};

const baselineSurfaces = roomSurfaces(baseRoom);
const baseNorth = baselineSurfaces.find(s => s.id === 'wall_north');
assertClose(baseNorth.area_m2, 30, 1e-6, 'baseline wall_north area = 10 × 3 = 30 m² (no openings)');

const roomWithDoor = JSON.parse(JSON.stringify(baseRoom));
roomWithDoor.surfaces.wall_north = {
  materialId: 'gypsum-board',
  openings: [{
    id: 'op-1', kind: 'door', x_m: 1, z_m: 0, width_m: 0.9, height_m: 2.1,
    materialId: 'door-solid-wood', state: 'closed',
  }],
};
const surfWithDoor = roomSurfaces(roomWithDoor);
const wallNorth = surfWithDoor.find(s => s.id === 'wall_north');
const doorSurf  = surfWithDoor.find(s => s.id === 'wall_north_op_0');
assertClose(wallNorth.area_m2, 30 - 0.9 * 2.1, 1e-6, 'wall_north area reduced by closed door area');
assert(wallNorth.materialId === 'gypsum-board', 'wall_north keeps gypsum-board material');
assert(doorSurf, 'door appended as wall_north_op_0 surface');
assertClose(doorSurf.area_m2, 0.9 * 2.1, 1e-6, 'door surface area = 0.9 × 2.1');
assert(doorSurf.materialId === 'door-solid-wood', 'closed door uses its solid material id');

// ---- open door resolves to open-air ---------------------------------------

const roomOpenDoor = JSON.parse(JSON.stringify(roomWithDoor));
roomOpenDoor.surfaces.wall_north.openings[0].state = 'open';
const openSurfs = roomSurfaces(roomOpenDoor);
const openDoor  = openSurfs.find(s => s.id === 'wall_north_op_0');
assert(openDoor.materialId === 'open-air', 'open door resolves to open-air boundary');

// ---- multiple openings on the same wall -----------------------------------

const roomMulti = JSON.parse(JSON.stringify(baseRoom));
roomMulti.surfaces.wall_north = {
  materialId: 'gypsum-board',
  openings: [
    { kind: 'door',   x_m: 1, z_m: 0, width_m: 0.9, height_m: 2.1, materialId: 'door-solid-wood', state: 'closed' },
    { kind: 'window', x_m: 4, z_m: 1, width_m: 1.5, height_m: 1.2, materialId: 'glass-window',    state: 'closed' },
  ],
};
const multiSurfs = roomSurfaces(roomMulti);
const multiWall = multiSurfs.find(s => s.id === 'wall_north');
assertClose(multiWall.area_m2, 30 - (0.9 * 2.1 + 1.5 * 1.2), 1e-6, 'multi-opening wall area subtracts both');
assert(multiSurfs.find(s => s.id === 'wall_north_op_0'), 'door appended (op_0)');
assert(multiSurfs.find(s => s.id === 'wall_north_op_1'), 'window appended (op_1)');

// ---- zero / negative dimensions are skipped (defensive) -------------------

const roomBadOp = JSON.parse(JSON.stringify(baseRoom));
roomBadOp.surfaces.wall_north = {
  materialId: 'gypsum-board',
  openings: [{ kind: 'door', x_m: 0, z_m: 0, width_m: 0, height_m: 2.1, materialId: 'door-solid-wood', state: 'closed' }],
};
const badSurfs = roomSurfaces(roomBadOp);
const badWall = badSurfs.find(s => s.id === 'wall_north');
assertClose(badWall.area_m2, 30, 1e-6, 'invalid (w=0) opening does not subtract from wall');
assert(!badSurfs.find(s => s.id === 'wall_north_op_0'), 'invalid opening is not surfaced');

// ---- custom-edge openings -------------------------------------------------

const customRoom = {
  shape: 'custom',
  width_m: 5, depth_m: 5, height_m: 3,
  ceiling_type: 'flat',
  custom_vertices: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }],
  surfaces: {
    floor: 'wood-floor',
    ceiling: 'acoustic-tile',
    walls: 'gypsum-board',
    edges: [
      'gypsum-board',
      { materialId: 'gypsum-board', openings: [
        { kind: 'window', x_m: 1, z_m: 1, width_m: 1, height_m: 1, materialId: 'glass-window', state: 'closed' },
      ] },
      'gypsum-board',
      'gypsum-board',
    ],
  },
};
const cs = roomSurfaces(customRoom);
const edge1 = cs.find(s => s.id === 'edge_1');
assertClose(edge1.area_m2, 5 * 3 - 1, 1e-6, 'custom edge_1 area subtracts 1 m² window');
const edge1Win = cs.find(s => s.id === 'edge_1_op_0');
assert(edge1Win, 'custom edge window surface appended');
assertClose(edge1Win.area_m2, 1, 1e-6, 'custom edge window area');

// ---- Outdoor enclosure forces ceiling → open-air ---------------------------

const outdoorRoom = JSON.parse(JSON.stringify(baseRoom));
outdoorRoom.enclosure = 'outdoor';
outdoorRoom.surfaces.ceiling = 'acoustic-tile';   // stored value preserved
const outSurf = roomSurfaces(outdoorRoom);
const outCeil = outSurf.find(s => s.id === 'ceiling');
assert(outCeil.materialId === 'open-air', 'outdoor enclosure forces ceiling materialId → open-air');
// Stored value untouched on the room itself so flipping back to indoor restores it.
assert(outdoorRoom.surfaces.ceiling === 'acoustic-tile', 'stored ceiling material survives outdoor toggle');

const indoorRoom = JSON.parse(JSON.stringify(outdoorRoom));
indoorRoom.enclosure = 'indoor';
const inSurf = roomSurfaces(indoorRoom);
const inCeil = inSurf.find(s => s.id === 'ceiling');
assert(inCeil.materialId === 'acoustic-tile', 'indoor enclosure restores stored ceiling material');

// Walls remain user-controlled in outdoor mode — only the ceiling is
// forced open-air. The user can choose per-wall (e.g. fenced courtyard
// with solid perimeter, or pavilion with all walls set to 'open-air').
const outWalls = outSurf.filter(s => s.id.startsWith('wall_'));
assert(outWalls.length === 4, 'outdoor: 4 wall surfaces still present (user-controlled)');
assert(outWalls.every(w => w.materialId === 'gypsum-board'),
  'outdoor: stored wall material respected (gypsum-board, not forced to open-air)');
const outFloor = outSurf.find(s => s.id === 'floor');
assert(outFloor.materialId === 'wood-floor', 'outdoor: floor (ground) keeps its real material');

// User opts into a fully open footprint by setting individual walls to
// 'open-air' themselves — that path still works.
const openCourtyard = JSON.parse(JSON.stringify(outdoorRoom));
openCourtyard.surfaces.wall_north = 'open-air';
const ocs = roomSurfaces(openCourtyard);
assert(ocs.find(s => s.id === 'wall_north').materialId === 'open-air',
  'outdoor: per-wall open-air choice still flows through');
assert(ocs.find(s => s.id === 'wall_south').materialId === 'gypsum-board',
  'outdoor: other walls keep their stored material');

console.log(failed === 0 ? '\nAll opening tests passed.' : `\n${failed} opening test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
