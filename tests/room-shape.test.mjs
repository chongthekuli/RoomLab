import {
  baseArea, wallPerimeter, ceilingArea, roomVolume, domeVolume, isInsideRoom,
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

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll room-shape tests passed.');
