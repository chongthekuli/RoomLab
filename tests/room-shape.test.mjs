import {
  baseArea, wallPerimeter, ceilingArea, roomVolume, domeVolume,
  isInsideRoom, isInsideRoom3D, maxCeilingHeightAt,
} from '../js/physics/room-shape.js';

let failed = 0;
function assertClose(actual, expected, tol, label) {
  const ok = Math.abs(actual - expected) < tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${actual.toFixed(4)} expected=${expected.toFixed(4)}`);
  if (!ok) failed++;
}
function assertEq(actual, expected, label) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${actual} expected=${expected}`);
  if (!ok) failed++;
}

// --- Rectangular, flat: should match hand math ---
const rect = {
  shape: 'rectangular',
  width_m: 10, height_m: 3, depth_m: 5,
  ceiling_type: 'flat',
  surfaces: { floor: 'f', ceiling: 'c', wall_north: 'w', wall_south: 'w', wall_east: 'w', wall_west: 'w' },
};
assertClose(baseArea(rect), 50, 0.001, 'Rectangular base area 10*5=50');
assertClose(wallPerimeter(rect), 30, 0.001, 'Rectangular perimeter 2*(10+5)=30');
assertClose(roomVolume(rect), 150, 0.001, 'Rectangular volume 10*3*5=150');

// --- Polygon (hexagon), flat ---
const hex = {
  shape: 'polygon',
  polygon_sides: 6, polygon_radius_m: 2,
  width_m: 4, height_m: 3, depth_m: 4,
  ceiling_type: 'flat',
  surfaces: { floor: 'f', ceiling: 'c', walls: 'w' },
};
// Regular hexagon circumradius 2: area = (3√3/2) * r^2 = 2.598 * 4 = 10.392
assertClose(baseArea(hex), (3 * Math.sqrt(3) / 2) * 4, 0.01, 'Hexagon base area');
// Perimeter = 6 sides of length r (for hex, side=r)
assertClose(wallPerimeter(hex), 6 * 2, 0.01, 'Hexagon perimeter 6*2=12');
assertClose(roomVolume(hex), ((3 * Math.sqrt(3) / 2) * 4) * 3, 0.01, 'Hexagon volume');

// --- Round, flat ---
const round = {
  shape: 'round',
  round_radius_m: 3,
  width_m: 6, height_m: 2.5, depth_m: 6,
  ceiling_type: 'flat',
  surfaces: { floor: 'f', ceiling: 'c', walls: 'w' },
};
assertClose(baseArea(round), Math.PI * 9, 0.001, 'Round base area πr²');
assertClose(wallPerimeter(round), 2 * Math.PI * 3, 0.001, 'Round perimeter 2πr');
assertClose(roomVolume(round), Math.PI * 9 * 2.5, 0.001, 'Round volume');

// --- Dome on round base ---
const dome = {
  shape: 'round',
  round_radius_m: 3,
  width_m: 6, height_m: 2.5, depth_m: 6,
  ceiling_type: 'dome', ceiling_dome_rise_m: 1,
  surfaces: { floor: 'f', ceiling: 'c', walls: 'w' },
};
// Dome spherical cap volume = π*d/6 * (3a² + d²) for base radius a=3, rise d=1
// = π * 1/6 * (27 + 1) = π * 28/6
assertClose(domeVolume(dome), Math.PI * 28 / 6, 0.001, 'Dome volume spherical cap');
// Ceiling area = π * (a² + d²) = π * (9 + 1) = 10π
assertClose(ceilingArea(dome), Math.PI * 10, 0.001, 'Dome ceiling area');
assertClose(roomVolume(dome), Math.PI * 9 * 2.5 + Math.PI * 28 / 6, 0.001, 'Round+dome total volume');

// --- isInsideRoom ---
assertEq(isInsideRoom(5, 2.5, rect), true, 'Point inside rect');
assertEq(isInsideRoom(-1, 2.5, rect), false, 'Point left of rect');
assertEq(isInsideRoom(3, 3, round), true, 'Center of round');
assertEq(isInsideRoom(6.5, 3, round), false, 'Outside round (beyond radius)');
assertEq(isInsideRoom(2, 2, hex), true, 'Near center of hex');

// --- Custom polygon (shoelace area) ---
const lShape = {
  shape: 'custom',
  custom_vertices: [
    { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }, { x: 2.5, y: 3 }, { x: 2.5, y: 5 }, { x: 0, y: 5 },
  ],
  width_m: 5, depth_m: 5, height_m: 3,
  ceiling_type: 'flat',
  surfaces: { floor: 'f', ceiling: 'c', walls: 'w', edges: ['w','w','w','w','w','w'] },
};
// L-shape: 5×3 rect + 2.5×2 rect = 15 + 5 = 20 m²
assertClose(baseArea(lShape), 20, 0.01, 'Custom L-shape area via shoelace = 20 m²');
// Perimeter: 5 + 3 + 2.5 + 2 + 2.5 + 5 = 20 m
assertClose(wallPerimeter(lShape), 20, 0.01, 'Custom L-shape perimeter = 20 m');
assertClose(roomVolume(lShape), 60, 0.01, 'Custom L-shape volume = 60 m³');

// Inside checks for L-shape: (1, 1) inside main rect
assertEq(isInsideRoom(1, 1, lShape), true, 'Custom (1,1) inside L main part');
// (4, 4) is inside the "notch" (outside room)
assertEq(isInsideRoom(4, 4, lShape), false, 'Custom (4,4) in notch is outside');
// (1, 4) is inside the narrow extension
assertEq(isInsideRoom(1, 4, lShape), true, 'Custom (1,4) inside L extension');

// Square custom shape
const square = {
  shape: 'custom',
  custom_vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
  width_m: 2, depth_m: 2, height_m: 2,
  ceiling_type: 'flat',
  surfaces: { floor: 'f', ceiling: 'c', walls: 'w', edges: ['w','w','w','w'] },
};
assertClose(baseArea(square), 4, 0.001, 'Custom square area = 4');
assertClose(wallPerimeter(square), 8, 0.001, 'Custom square perimeter = 8');

// --- 3D containment: ceiling / floor ---
const flatRect = {
  shape: 'rectangular',
  width_m: 5, height_m: 3, depth_m: 5,
  ceiling_type: 'flat',
  surfaces: { floor: 'f', ceiling: 'c', wall_north: 'w', wall_south: 'w', wall_east: 'w', wall_west: 'w' },
};
assertEq(isInsideRoom3D({ x: 2.5, y: 2.5, z: 1.5 }, flatRect), true, '3D inside flat rect');
assertEq(isInsideRoom3D({ x: 2.5, y: 2.5, z: 5.0 }, flatRect), false, 'Above ceiling = outside');
assertEq(isInsideRoom3D({ x: 2.5, y: 2.5, z: -0.5 }, flatRect), false, 'Below floor = outside');
assertEq(isInsideRoom3D({ x: 10, y: 2.5, z: 1.5 }, flatRect), false, 'Beyond horizontal = outside');
assertClose(maxCeilingHeightAt(2.5, 2.5, flatRect), 3, 0.001, 'Flat ceiling height');

const domeRound = {
  shape: 'round',
  round_radius_m: 3,
  width_m: 6, height_m: 2.5, depth_m: 6,
  ceiling_type: 'dome', ceiling_dome_rise_m: 1,
  surfaces: { floor: 'f', ceiling: 'c', walls: 'w' },
};
// At center: max ceiling = H + rise = 3.5
assertClose(maxCeilingHeightAt(3, 3, domeRound), 3.5, 0.001, 'Dome apex height = H + rise');
// At dome base edge (horizDist = a = 3): max ceiling = H
assertClose(maxCeilingHeightAt(6, 3, domeRound), 2.5, 0.001, 'Dome edge height = wall H');
// Speaker at center, z just under apex → inside
assertEq(isInsideRoom3D({ x: 3, y: 3, z: 3.4 }, domeRound), true, 'Under dome apex = inside');
// Speaker at center, above apex → outside
assertEq(isInsideRoom3D({ x: 3, y: 3, z: 3.6 }, domeRound), false, 'Above dome apex = outside');
// Speaker near wall, z above wall but dome is thin here → outside
assertEq(isInsideRoom3D({ x: 5.9, y: 3, z: 2.7 }, domeRound), false, 'Near wall, above wall height = outside (dome very low there)');

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll room-shape tests passed.');
