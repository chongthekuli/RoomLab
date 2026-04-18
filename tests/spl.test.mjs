import { computeDirectSPL, localAngles } from '../js/physics/spl-calculator.js';

const speaker = {
  acoustic: { sensitivity_db_1w_1m: 97 },
  directivity: {
    azimuth_deg: [-180, -90, 0, 90, 180],
    elevation_deg: [-90, 0, 90],
    attenuation_db: {
      "1000": [
        [-20, -20, -20, -20, -20],
        [ -6,  -3,   0,  -3,  -6],
        [-20, -20, -20, -20, -20],
      ],
    },
  },
};

const baseState = {
  position: { x: 0, y: 0, z: 0 },
  aim: { yaw: 0, pitch: 0, roll: 0 },
  power_watts: 1,
};

let failed = 0;
function assertClose(actual, expected, tol, label) {
  const ok = Math.abs(actual - expected) < tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${actual.toFixed(3)} expected=${expected.toFixed(3)}`);
  if (!ok) failed++;
}

// On-axis, 1m, 1W → SPL should equal sensitivity
const t1 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 0, y: 1, z: 0 } });
assertClose(t1.spl_db, 97, 0.01, 'On-axis 1m 1W = sensitivity (97 dB)');

// 2m doubles distance → -6 dB
const t2 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 0, y: 2, z: 0 } });
assertClose(t2.spl_db, 97 - 20 * Math.log10(2), 0.01, '2m: -6 dB from 1m');

// 4m quadruples distance → -12 dB
const t3 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 0, y: 4, z: 0 } });
assertClose(t3.spl_db, 97 - 20 * Math.log10(4), 0.01, '4m: -12 dB from 1m');

// 10W increases SPL by +10 dB
const s10 = { ...baseState, power_watts: 10 };
const t4 = computeDirectSPL({ speakerDef: speaker, speakerState: s10, listenerPos: { x: 0, y: 1, z: 0 } });
assertClose(t4.spl_db, 97 + 10, 0.01, '10W: +10 dB from 1W');

// 90° off-axis should apply -3 dB from directivity grid
const t5 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 1, y: 0, z: 0 } });
assertClose(t5.spl_db, 97 - 3, 0.01, '90° off-axis: -3 dB directivity');

// localAngles: listener straight ahead
const a1 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 1, z: 0 });
assertClose(a1.azimuth_deg, 0, 0.01, 'localAngles on-axis azimuth=0');
assertClose(a1.elevation_deg, 0, 0.01, 'localAngles on-axis elevation=0');

// localAngles: listener to the right
const a2 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 1, y: 0, z: 0 });
assertClose(a2.azimuth_deg, 90, 0.01, 'Listener at +X = azimuth 90°');

// Rotated speaker (yaw=90°): listener at +X should now be on-axis (azimuth=0)
const a3 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 90, pitch: 0 }, { x: 1, y: 0, z: 0 });
assertClose(a3.azimuth_deg, 0, 0.01, 'Yaw=90° speaker: +X listener = on-axis');

// Pitch: listener at (0, 3, 3) → horizDist=3, dz=3, raw elev=45°.
// Speaker pitched up 30° → local elevation = 45 - 30 = 15°.
const a4 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 30 }, { x: 0, y: 3, z: 3 });
assertClose(a4.elevation_deg, 15, 0.01, 'Pitch up 30° on a 45° listener → local elev 15°');

// --- Multi-source SPL tests ---
import { computeMultiSourceSPL } from '../js/physics/spl-calculator.js';

// Two co-located 1W speakers, both on-axis to listener at 1m
// Each contributes 97 dB; pressure sum = 2 × 10^9.7 → total = 97 + 10·log₁₀(2) ≈ 100.01 dB
const coLocated = [
  { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
  { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
];
const lookup = () => speaker;
const t6 = computeMultiSourceSPL({
  sources: coLocated, getSpeakerDef: lookup,
  listenerPos: { x: 0, y: 1, z: 0 },
});
assertClose(t6, 97 + 10 * Math.log10(2), 0.01, 'Two identical co-located sources = +3 dB');

// Four identical sources → +6 dB
const four = Array.from({ length: 4 }, () => ({
  modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1,
}));
const t7 = computeMultiSourceSPL({
  sources: four, getSpeakerDef: lookup,
  listenerPos: { x: 0, y: 1, z: 0 },
});
assertClose(t7, 97 + 10 * Math.log10(4), 0.01, 'Four identical sources = +6 dB');

// Empty source list returns -Infinity
const t8 = computeMultiSourceSPL({
  sources: [], getSpeakerDef: lookup,
  listenerPos: { x: 0, y: 1, z: 0 },
});
const t8ok = t8 === -Infinity;
console.log(`${t8ok ? 'PASS' : 'FAIL'}  Empty sources returns -Infinity  actual=${t8}`);
if (!t8ok) failed++;

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll SPL tests passed.');
