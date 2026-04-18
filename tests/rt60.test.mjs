import { sabine, eyring, computeAllBands } from '../js/physics/rt60.js';

let failed = 0;
function assertClose(actual, expected, tol, label) {
  const ok = Math.abs(actual - expected) < tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${actual.toFixed(4)} expected=${expected.toFixed(4)}`);
  if (!ok) failed++;
}

// Textbook case: room 10 x 5 x 3, every surface alpha = 0.1
// V = 150, S = 2(50+30+15) = 190, A = 19
// Sabine T60 = 0.161 * 150 / 19 = 1.2711 s
// Eyring T60 = 0.161 * 150 / (-190 * ln(0.9)) = 1.2067 s
assertClose(sabine({ volume_m3: 150, totalAbsorption_sabins: 19 }), 1.2711, 0.001, 'Sabine textbook alpha=0.1');
assertClose(eyring({ volume_m3: 150, totalArea_m2: 190, meanAbsorption: 0.1 }), 1.2067, 0.001, 'Eyring textbook alpha=0.1');

// Edge: zero absorption → infinite reverb
const t1 = sabine({ volume_m3: 100, totalAbsorption_sabins: 0 });
console.log(`${t1 === Infinity ? 'PASS' : 'FAIL'}  Sabine zero-absorption returns Infinity`);
if (t1 !== Infinity) failed++;

// Edge: fully absorbent → zero reverb (Eyring)
const t2 = eyring({ volume_m3: 100, totalArea_m2: 50, meanAbsorption: 1 });
console.log(`${t2 === 0 ? 'PASS' : 'FAIL'}  Eyring fully-absorbent returns 0`);
if (t2 !== 0) failed++;

// Integration: computeAllBands with a mock materials object
const mockMaterials = {
  frequency_bands_hz: [500, 1000],
  byId: {
    'uniform-0.1': { absorption: [0.1, 0.1] },
  },
};
const room = {
  width_m: 10, height_m: 3, depth_m: 5,
  surfaces: {
    floor: 'uniform-0.1', ceiling: 'uniform-0.1',
    wall_north: 'uniform-0.1', wall_south: 'uniform-0.1',
    wall_east: 'uniform-0.1', wall_west: 'uniform-0.1',
  },
};
const bands = computeAllBands({ room, materials: mockMaterials });
assertClose(bands[0].sabine_s, 1.2711, 0.001, 'computeAllBands @ 500 Hz Sabine');
assertClose(bands[0].eyring_s, 1.2067, 0.001, 'computeAllBands @ 500 Hz Eyring');
assertClose(bands[0].volume_m3, 150, 0.01, 'Volume calc');
assertClose(bands[0].totalArea_m2, 190, 0.01, 'Surface area calc');

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll tests passed.');
