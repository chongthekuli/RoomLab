import { sabine, eyring, computeAllBands } from '../js/physics/rt60.js';
import { airAbsorptionCoefficient_m, airSabins } from '../js/physics/air-absorption.js';

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
assertClose(eyring({ volume_m3: 150, totalArea_m2: 190, surfaceMeanAbsorption: 0.1, airAbsSabins: 0 }), 1.2067, 0.001, 'Eyring textbook alpha=0.1 (no air)');

// Edge: zero absorption → infinite reverb
const t1 = sabine({ volume_m3: 100, totalAbsorption_sabins: 0 });
console.log(`${t1 === Infinity ? 'PASS' : 'FAIL'}  Sabine zero-absorption returns Infinity`);
if (t1 !== Infinity) failed++;

// Edge: fully absorbent → zero reverb (Eyring)
const t2 = eyring({ volume_m3: 100, totalArea_m2: 50, surfaceMeanAbsorption: 1, airAbsSabins: 0 });
console.log(`${t2 === 0 ? 'PASS' : 'FAIL'}  Eyring fully-absorbent returns 0`);
if (t2 !== 0) failed++;

// Integration: computeAllBands with a mock materials object, air off to
// preserve the textbook α=0.1 exact values.
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
const bandsNoAir = computeAllBands({ room, materials: mockMaterials, airAbsorption: false });
assertClose(bandsNoAir[0].sabine_s, 1.2711, 0.001, 'computeAllBands @ 500 Hz Sabine (air off)');
assertClose(bandsNoAir[0].eyring_s, 1.2067, 0.001, 'computeAllBands @ 500 Hz Eyring (air off)');
assertClose(bandsNoAir[0].volume_m3, 150, 0.01, 'Volume calc');
assertClose(bandsNoAir[0].totalArea_m2, 190, 0.01, 'Surface area calc');

// --- Air absorption (4mV) — ISO 9613-1 table → Nepers/m conversion -------
// Reviewer-challenged omission: big rooms at HF need the 4mV volumetric
// sink in the Sabine/Eyring denominator. At 4 kHz the table value is
// 0.03751 dB/m, converted m = 0.03751 / (10·log10 e) = 0.03751 / 4.3429 =
// 0.008637 Nepers/m. At 8 kHz: 0.10200 / 4.3429 = 0.02349 Np/m.
assertClose(airAbsorptionCoefficient_m(4000), 0.008637, 1e-5, 'm(4kHz) ≈ 0.008637 Np/m');
assertClose(airAbsorptionCoefficient_m(8000), 0.023488, 1e-5, 'm(8kHz) ≈ 0.023488 Np/m');
assertClose(airAbsorptionCoefficient_m(1000), 0.001121, 1e-5, 'm(1kHz) ≈ 0.001121 Np/m');

// 4mV Sabins for a 1000 m³ room at 8 kHz: 4 · 0.023488 · 1000 = 94 Sabins
assertClose(airSabins(8000, 1000), 93.95, 0.05, '4mV at 8 kHz / 1000 m³ ≈ 94 Sabins');
// Bypass flag must return exactly 0
assertClose(airSabins(8000, 1000, false), 0, 1e-9, 'airSabins disabled returns 0');

// --- Big-room HF: air absorption must drop RT60 (Kuttruff §5) ------------
// 48000 m³ reverberant volume with sparse surface absorption. Without 4mV
// the 8 kHz RT60 would be at least double.
{
  const bigRoom = {
    shape: 'rectangular', width_m: 60, height_m: 20, depth_m: 40,
    surfaces: {
      floor: 'uniform-0.1', ceiling: 'uniform-0.1',
      wall_north: 'uniform-0.1', wall_south: 'uniform-0.1',
      wall_east: 'uniform-0.1', wall_west: 'uniform-0.1',
    },
  };
  const mat = {
    frequency_bands_hz: [125, 8000],
    byId: { 'uniform-0.1': { absorption: [0.1, 0.1] } },
  };
  const noAir = computeAllBands({ room: bigRoom, materials: mat, airAbsorption: false });
  const withAir = computeAllBands({ room: bigRoom, materials: mat, airAbsorption: true });
  // At 125 Hz air is small (~2 % of surface absorption on this geometry).
  const pct125 = 100 * Math.abs(noAir[0].sabine_s - withAir[0].sabine_s) / noAir[0].sabine_s;
  console.log(`${pct125 < 5 ? 'PASS' : 'FAIL'}  4mV near-negligible at 125 Hz (Δ=${pct125.toFixed(1)} %)`);
  if (pct125 >= 5) failed++;
  // At 8 kHz air should dominate → at least 30 % RT60 drop (measured ~84 %).
  const drop8k = (noAir[1].sabine_s - withAir[1].sabine_s) / noAir[1].sabine_s;
  console.log(`${drop8k > 0.3 ? 'PASS' : 'FAIL'}  4mV cuts 8 kHz RT60 by > 30 % in big room (noAir=${noAir[1].sabine_s.toFixed(2)}s, withAir=${withAir[1].sabine_s.toFixed(2)}s, drop=${(drop8k*100).toFixed(0)}%)`);
  if (drop8k <= 0.3) failed++;
}

// --- Small absorptive room: air absorption is negligible -----------------
// 50 m³ treated control room (studio-grade α=0.8 average). 4mV is ~7 % of
// surface absorption even at 8 kHz — Sabine RT60 barely shifts.
// NB: the negligibility depends on surface absorption being high; a small
// unfurnished concrete box with α≈0.03 would still see a big HF effect
// because 4mV is a volumetric, not surface, quantity.
{
  const smallRoom = {
    shape: 'rectangular', width_m: 5, height_m: 2.5, depth_m: 4,
    surfaces: {
      floor: 'absorptive', ceiling: 'absorptive',
      wall_north: 'absorptive', wall_south: 'absorptive',
      wall_east: 'absorptive', wall_west: 'absorptive',
    },
  };
  const mat = {
    frequency_bands_hz: [8000],
    byId: { 'absorptive': { absorption: [0.8] } },
  };
  const noAir = computeAllBands({ room: smallRoom, materials: mat, airAbsorption: false });
  const withAir = computeAllBands({ room: smallRoom, materials: mat, airAbsorption: true });
  const pctChange = 100 * Math.abs(noAir[0].sabine_s - withAir[0].sabine_s) / noAir[0].sabine_s;
  console.log(`${pctChange < 10 ? 'PASS' : 'FAIL'}  Treated small-room 8kHz air-abs effect < 10 % (got ${pctChange.toFixed(1)} %)`);
  if (pctChange >= 10) failed++;
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll tests passed.');
