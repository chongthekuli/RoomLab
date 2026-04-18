import {
  computeDirectSPL,
  localAngles,
  computeMultiSourceSPL,
  computeListenerBreakdown,
} from '../js/physics/spl-calculator.js';

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

// --- Single-source SPL tests ---
const t1 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 0, y: 1, z: 0 } });
assertClose(t1.spl_db, 97, 0.01, 'On-axis 1m 1W = sensitivity (97 dB)');

const t2 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 0, y: 2, z: 0 } });
assertClose(t2.spl_db, 97 - 20 * Math.log10(2), 0.01, '2m: -6 dB from 1m');

const t3 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 0, y: 4, z: 0 } });
assertClose(t3.spl_db, 97 - 20 * Math.log10(4), 0.01, '4m: -12 dB from 1m');

const s10 = { ...baseState, power_watts: 10 };
const t4 = computeDirectSPL({ speakerDef: speaker, speakerState: s10, listenerPos: { x: 0, y: 1, z: 0 } });
assertClose(t4.spl_db, 97 + 10, 0.01, '10W: +10 dB from 1W');

const t5 = computeDirectSPL({ speakerDef: speaker, speakerState: baseState, listenerPos: { x: 1, y: 0, z: 0 } });
assertClose(t5.spl_db, 97 - 3, 0.01, '90° off-axis: -3 dB directivity');

const a1 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 1, z: 0 });
assertClose(a1.azimuth_deg, 0, 0.01, 'localAngles on-axis azimuth=0');
assertClose(a1.elevation_deg, 0, 0.01, 'localAngles on-axis elevation=0');

const a2 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 1, y: 0, z: 0 });
assertClose(a2.azimuth_deg, 90, 0.01, 'Listener at +X = azimuth 90°');

const a3 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 90, pitch: 0 }, { x: 1, y: 0, z: 0 });
assertClose(a3.azimuth_deg, 0, 0.01, 'Yaw=90° speaker: +X listener = on-axis');

const a4 = localAngles({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 30 }, { x: 0, y: 3, z: 3 });
assertClose(a4.elevation_deg, 15, 0.01, 'Pitch up 30° on a 45° listener → local elev 15°');

// --- Multi-source SPL tests ---
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

const four = Array.from({ length: 4 }, () => ({
  modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1,
}));
const t7 = computeMultiSourceSPL({
  sources: four, getSpeakerDef: lookup,
  listenerPos: { x: 0, y: 1, z: 0 },
});
assertClose(t7, 97 + 10 * Math.log10(4), 0.01, 'Four identical sources = +6 dB');

const t8 = computeMultiSourceSPL({
  sources: [], getSpeakerDef: lookup,
  listenerPos: { x: 0, y: 1, z: 0 },
});
const t8ok = t8 === -Infinity;
console.log(`${t8ok ? 'PASS' : 'FAIL'}  Empty sources returns -Infinity  actual=${t8}`);
if (!t8ok) failed++;

// --- Listener breakdown tests (no room) ---
const br1 = computeListenerBreakdown({
  sources: [{ modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 }],
  getSpeakerDef: () => speaker,
  listenerPos: { x: 0, y: 1, z: 0 },
});
assertClose(br1.perSpeaker[0].spl_db, 97, 0.01, 'Breakdown single speaker SPL');
assertClose(br1.total_spl_db, 97, 0.01, 'Breakdown total with 1 source = single SPL');

const br2 = computeListenerBreakdown({
  sources: [
    { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
    { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
  ],
  getSpeakerDef: () => speaker,
  listenerPos: { x: 0, y: 1, z: 0 },
});
assertClose(br2.perSpeaker[0].spl_db, 97, 0.01, 'Breakdown speaker 1 of 2');
assertClose(br2.perSpeaker[1].spl_db, 97, 0.01, 'Breakdown speaker 2 of 2');
assertClose(br2.total_spl_db, 97 + 10 * Math.log10(2), 0.01, 'Breakdown total with 2 co-located = +3 dB');

// --- Wall transmission loss (bug fix) ---
const rectRoom = {
  shape: 'rectangular',
  width_m: 5, height_m: 3, depth_m: 5,
  surfaces: { floor: 'f', ceiling: 'c', wall_north: 'w', wall_south: 'w', wall_east: 'w', wall_west: 'w' },
};

// Both inside: no TL
const s_in = { position: { x: 2.5, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
const l_in = { x: 2.5, y: 2, z: 1 };
const t_both_in = computeDirectSPL({ speakerDef: speaker, speakerState: s_in, listenerPos: l_in, room: rectRoom });
assertClose(t_both_in.spl_db, 97, 0.01, 'Both inside: no TL');
const t_both_in_flag = t_both_in.through_wall === false;
console.log(`${t_both_in_flag ? 'PASS' : 'FAIL'}  through_wall=false when both inside`);
if (!t_both_in_flag) failed++;

// Speaker outside, listener inside: -30 dB applied
const s_out = { position: { x: 10, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
const t_out = computeDirectSPL({ speakerDef: speaker, speakerState: s_out, listenerPos: l_in, room: rectRoom });
const expectedFree = 97 - 20 * Math.log10(Math.sqrt(7.5 * 7.5 + 1 * 1));
const expectedAttn = -3 + (8 / 90) * 3;
const expectedOut = expectedFree + expectedAttn - 30;
assertClose(t_out.spl_db, expectedOut, 0.05, 'Speaker outside → -30 dB TL');
const t_out_flag = t_out.through_wall === true;
console.log(`${t_out_flag ? 'PASS' : 'FAIL'}  through_wall=true when speaker outside`);
if (!t_out_flag) failed++;

// No room param: backward compat, no TL
const t_no_room = computeDirectSPL({ speakerDef: speaker, speakerState: s_out, listenerPos: l_in });
const t_no_tl_ok = Math.abs(t_no_room.spl_db - (expectedFree + expectedAttn)) < 0.05;
console.log(`${t_no_tl_ok ? 'PASS' : 'FAIL'}  No room param: no TL (backward compat)  actual=${t_no_room.spl_db.toFixed(3)}`);
if (!t_no_tl_ok) failed++;

// Breakdown flags outside speakers
const br3 = computeListenerBreakdown({
  sources: [
    { modelUrl: 'x', position: { x: 2.5, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
    { modelUrl: 'x', position: { x: 10, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 },
  ],
  getSpeakerDef: () => speaker,
  listenerPos: { x: 2.5, y: 2, z: 1 },
  room: rectRoom,
});
const br3_ok = br3.perSpeaker[0].outsideRoom === false && br3.perSpeaker[1].outsideRoom === true;
console.log(`${br3_ok ? 'PASS' : 'FAIL'}  Breakdown outsideRoom flags correct`);
if (!br3_ok) failed++;

// --- Ceiling/floor containment (fixes P0 gap) ---
const ceilRoom = {
  shape: 'rectangular',
  width_m: 5, height_m: 3, depth_m: 5,
  ceiling_type: 'flat',
  surfaces: { floor: 'f', ceiling: 'c', wall_north: 'w', wall_south: 'w', wall_east: 'w', wall_west: 'w' },
};
// Speaker above ceiling (z=5 > height 3) but inside horizontal
const s_above = { position: { x: 2.5, y: 2.5, z: 5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
const l_mid  = { x: 2.5, y: 2.5, z: 1.2 };
const t_above = computeDirectSPL({ speakerDef: speaker, speakerState: s_above, listenerPos: l_mid, room: ceilRoom });
const t_above_ok = t_above.through_wall === true;
console.log(`${t_above_ok ? 'PASS' : 'FAIL'}  Speaker above flat ceiling → TL applied (through_wall=true)`);
if (!t_above_ok) failed++;

// Speaker below floor (z=-1) — also outside
const s_below = { position: { x: 2.5, y: 2.5, z: -1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
const t_below = computeDirectSPL({ speakerDef: speaker, speakerState: s_below, listenerPos: l_mid, room: ceilRoom });
const t_below_ok = t_below.through_wall === true;
console.log(`${t_below_ok ? 'PASS' : 'FAIL'}  Speaker below floor → TL applied`);
if (!t_below_ok) failed++;

// --- Zone SPL grid test ---
import { computeZoneSPLGrid } from '../js/physics/spl-calculator.js';

// Zone is a 2m square, speaker 1m above center at sensitivity
const zoneRoom = {
  shape: 'rectangular',
  width_m: 10, height_m: 5, depth_m: 10,
  ceiling_type: 'flat',
  surfaces: { floor: 'f', ceiling: 'c', wall_north: 'w', wall_south: 'w', wall_east: 'w', wall_west: 'w' },
};
const zone = {
  id: 'Z1', label: 'Test zone',
  vertices: [{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }],
  elevation_m: 0,
};
const zSrc = { modelUrl: 'x', position: { x: 5, y: 5, z: 1.2 + 1 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
// Speaker directly above zone center at 1m above ear. On-axis listener at zone center: r=1, elev=-90.
// At elev=-90 with speaker aim pitch=0, my mock speaker has -20 attenuation.
const zg = computeZoneSPLGrid({
  zone, sources: [zSrc],
  getSpeakerDef: () => speaker,
  room: zoneRoom, gridSize: 5,
});
const zgok = zg && zg.id === 'Z1' && zg.grid.length === 5 && isFinite(zg.avgSPL_db);
console.log(`${zgok ? 'PASS' : 'FAIL'}  Zone SPL grid computed (avg=${zg.avgSPL_db.toFixed(1)} dB)`);
if (!zgok) failed++;

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll SPL tests passed.');
