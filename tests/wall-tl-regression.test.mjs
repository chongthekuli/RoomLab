// Regression guard for the surau wall-TL bug the user found on
// 2026-05-17: standing under speaker 10 (ceiling-mount, aim straight
// down) read ~90 dB, walking outside the south wall onto the podium
// read 86.3 dB — a drop of just ~3.7 dB. Pre-fix the engine applied
// NO transmission loss in walk mode (audition.js wasn't passing
// `room`) and even in modes that DID pass `room` the TL was a flat
// frequency-independent 30 dB regardless of material.
//
// This test locks in the post-fix behaviour:
//   (1) Inside the room, under the ceiling speaker → high SPL, no TL.
//   (2) Outside the south wall through SOLID painted concrete →
//       SPL drops by the per-band concrete TL (~47 dB at 1 kHz),
//       NOT by 3.7 dB and NOT by 30 dB.
//   (3) Outside the south wall through an OPEN door → near-free-air
//       drop dominated by distance only.
// Owned by Theo (regression-curator). Every future fix to wall-TL
// math must keep this test passing or update the assertions with a
// commit message explaining why the numbers moved.

import { readFileSync } from 'node:fs';
import { computeMultiSourceSPL, computeDirectSPL } from '../js/physics/spl-calculator.js';

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

let failed = 0;
function ok(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
}
function assertBetween(actual, lo, hi, label) {
  ok(actual >= lo && actual <= hi, label, `actual=${actual.toFixed(2)} expected ${lo}..${hi}`);
}

const speaker = {
  acoustic: { sensitivity_db_1w_1m: 97, directivity_index_db: 8 },
  directivity: {
    azimuth_deg: [-180, -90, 0, 90, 180],
    elevation_deg: [-90, 0, 90],
    attenuation_db: {
      '1000': [
        [-15, -10, -6, -10, -15],
        [ -6,  -3,  0,  -3,  -6],
        [-15, -10, -6, -10, -15],
      ],
    },
  },
};

// Surau-shaped room: W=18 m × D=12 m × H=4.5 m (close to the preset).
// South wall has three doors centred near x=4.5, x=9, x=13.5 each 1 m wide,
// 2.4 m tall. Other walls solid painted concrete. Matches the user's
// real scenario.
const surauRoom = {
  shape: 'rectangular',
  width_m: 18, height_m: 4.5, depth_m: 12,
  surfaces: {
    floor: 'carpet-heavy-underlay',
    ceiling: 'gypsum-board',
    wall_north: 'concrete-painted',
    wall_south: {
      materialId: 'concrete-painted',
      // South wall x_m runs from world-x=0 → world-x=18 (its v1=(0,12), v2=(18,12)).
      openings: [
        { x_m:  4.0, z_m: 0, width_m: 1.0, height_m: 2.4, state: 'open', materialId: 'open-air' },
        { x_m:  8.5, z_m: 0, width_m: 1.0, height_m: 2.4, state: 'open', materialId: 'open-air' },
        { x_m: 13.0, z_m: 0, width_m: 1.0, height_m: 2.4, state: 'open', materialId: 'open-air' },
      ],
    },
    wall_east: 'concrete-painted',
    wall_west: 'concrete-painted',
  },
};

// Speaker 10: ceiling-mount above the imam strip, aim straight down,
// 20 W. Matches the post-fix surau preset.
const speaker10 = {
  modelUrl: 'spk',
  position: { x: 9, y: 11.25, z: 4.30 },
  aim: { yaw: 0, pitch: -90, roll: 0 },
  power_watts: 20,
};

// ---- (1) Under the speaker, inside the prayer hall ---------------------
// Listener directly below speaker at ear height 1.7 m. Distance ≈ 2.6 m,
// on-axis (pitch flips listener to azimuth=0, elevation=0 in body frame).
// Expected SPL ≈ 97 + 10·log10(20) − 20·log10(2.6) ≈ 101 dB.
const lst_inside = { x: 9, y: 11.25, z: 1.7 };
const spl_inside = computeMultiSourceSPL({
  sources: [speaker10],
  getSpeakerDef: () => speaker,
  listenerPos: lst_inside,
  freq_hz: 1000,
  room: surauRoom,
  materials,
});
assertBetween(spl_inside, 95, 105,
  '(1) Under speaker 10, inside hall → ~100 dB SPL (no wall in path)');

// ---- (2) Outside south wall, through SOLID concrete -------------------
// Listener stands on the podium just past the south wall, NOT aligned
// with any door. Path from speaker (9, 11.25, 4.30) to listener
// (1.0, 13.5, 1.7) crosses wall_south at world-x ≈ 1 (well outside the
// 3 door rectangles → opaque concrete).
// Pre-fix: no TL applied (audition path) or flat 30 dB.
// Post-fix: 47 dB applied (concrete-painted band 2 = 500 Hz? — bandIndexForFreq
// snaps 1000 Hz to band 3 = 47 dB). Yes, concrete-painted[3] = 53 dB.
const lst_outside_solid = { x: 1.0, y: 13.5, z: 1.7 };
const spl_outside_solid = computeMultiSourceSPL({
  sources: [speaker10],
  getSpeakerDef: () => speaker,
  listenerPos: lst_outside_solid,
  freq_hz: 1000,
  room: surauRoom,
  materials,
});
// Distance ≈ sqrt(8² + 2.25² + 2.6²) ≈ 8.65 m. Free-field at 8.65 m,
// elev=-arctan(2.6/8.25)≈-17°, off-axis attn ≈ -1.5 dB.
// L_p_free = 97 + 13 − 20·log10(8.65) + attn − airAbs ≈ 97 + 13 − 18.74 − 1.5 − 0.04 ≈ 89.7
// After 53 dB concrete TL: ~36.7 dB. Wide band accepted because directivity
// approximation and exact angle vary.
assertBetween(spl_outside_solid, 25, 50,
  '(2) Outside south wall through SOLID concrete → ~30-45 dB (was 86 dB pre-fix)');

const drop_solid = spl_inside - spl_outside_solid;
ok(drop_solid > 45,
  `(2b) Drop from inside-under-speaker to outside-solid-wall > 45 dB`,
  `actual drop = ${drop_solid.toFixed(1)} dB (concrete TL @ 1 kHz = 53)`);

// ---- (3) Door bypass — use a LOW source (imam voice, 1.5 m high) so
// the geometric path actually passes through the door's rectangle.
// The ceiling-mounted speaker 10 above firing DOWN cannot exploit the
// door for an outside listener at ear height because its path crosses
// the wall above z=2.4 m (the door's top). This test uses a separate
// low source so the geometry passes through the opening cleanly.
const imamVoice = {
  modelUrl: 'spk',
  position: { x: 9, y: 11.7, z: 1.5 },     // imam standing at qibla mic
  aim: { yaw: 0, pitch: 0, roll: 0 },       // mouth-level forward
  power_watts: 1,
};
const lst_door = { x: 9, y: 12.3, z: 1.7 };  // ear height, 0.3 m past door
const spl_imam_door = computeMultiSourceSPL({
  sources: [imamVoice],
  getSpeakerDef: () => speaker,
  listenerPos: lst_door,
  freq_hz: 1000,
  room: surauRoom,
  materials,
});
// Path: (9, 11.7, 1.5) → (9, 12.3, 1.7). Wall_south at y=12: t = 0.5,
// hit z = 1.6 → inside the door (z 0..2.4). TL = 0.
// Distance ≈ 0.63 m. Free-field at this range: huge SPL gain. Clamp
// to a window that proves "door TL = 0" without requiring exact value.
assertBetween(spl_imam_door, 95, 130,
  '(3) Imam voice through OPEN door → near-free-air SPL (TL = 0)');

// ---- (4) Same imam source, listener moved sideways so path now
// crosses SOLID concrete instead of the door. SPL must drop by ~30+ dB
// purely from the per-band concrete TL.
const lst_offset = { x: 6.0, y: 12.3, z: 1.7 };   // 3 m sideways, misses door
const spl_imam_solid = computeMultiSourceSPL({
  sources: [imamVoice],
  getSpeakerDef: () => speaker,
  listenerPos: lst_offset,
  freq_hz: 1000,
  room: surauRoom,
  materials,
});
const tl_visible = spl_imam_door - spl_imam_solid;
// imam → door listener is ~0.63 m, imam → offset listener is ~3.06 m,
// so free-air drop alone is 20·log10(3.06/0.63) ≈ 13.7 dB.
// Concrete TL at 1 kHz adds 53 dB → total ≈ 66 dB. Allow wide window.
ok(tl_visible > 40,
  '(4) Door-path > solid-path by >40 dB (the TL spectrum is visible)',
  `actual diff = ${tl_visible.toFixed(1)} dB (free-air contributes ~14 dB; rest is wall TL)`);

// ---- (5) Per-band sanity: concrete TL is frequency-dependent ----------
// computeDirectSPL at 125 Hz vs 4 kHz through the solid south wall:
// concrete-painted has TL = [39, 41, 47, 53, 58, 62, 65]. The TL
// difference between 125 and 4 kHz is 62 − 39 = 23 dB. After distance
// + directivity + air absorption (which DOES differ by band) the SPL
// difference should reflect this.
const d125 = computeDirectSPL({
  speakerDef: speaker, speakerState: speaker10,
  listenerPos: lst_outside_solid, freq_hz: 125,
  room: surauRoom, materials,
});
const d4k = computeDirectSPL({
  speakerDef: speaker, speakerState: speaker10,
  listenerPos: lst_outside_solid, freq_hz: 4000,
  room: surauRoom, materials,
});
// Note: speaker.directivity only has 1000 Hz data → interpolateAttenuation
// falls back to that single key for both calls, so directivity is band-
// independent in this test. Air absorption at 4 kHz is much larger than
// at 125 Hz (~0.14 vs 0.0001 dB/m × 8.65 m → ~1.2 dB extra at 4 kHz).
// So the per-band SPL difference is roughly: (62 − 39) + 1.2 ≈ 24.2 dB.
const band_diff = d125.spl_db - d4k.spl_db;
ok(band_diff > 20 && band_diff < 28,
  '(5) 125 Hz vs 4 kHz through concrete: difference reflects per-band TL',
  `actual = ${band_diff.toFixed(1)} dB (expect ~24 dB)`);

// ---- (6) The tl_db_applied breakdown is exposed -----------------------
// computeDirectSPL must surface tl_db_applied + wallsCrossed so the
// per-source breakdown UI and the print/PDF report can render
// "which wall, what material, how much TL" for the user.
ok(typeof d125.tl_db_applied === 'number' && d125.tl_db_applied > 0,
  '(6) tl_db_applied is a number on the return value', `value=${d125.tl_db_applied}`);
ok(Array.isArray(d125.wallsCrossed) && d125.wallsCrossed.length === 1,
  '(6) wallsCrossed lists the one wall hit', `count=${d125.wallsCrossed?.length}`);
ok(d125.wallsCrossed?.[0]?.materialId === 'concrete-painted',
  '(6) wallsCrossed[0].materialId reports concrete-painted',
  `actual=${d125.wallsCrossed?.[0]?.materialId}`);
ok(d125.wallsCrossed?.[0]?.throughOpening === false,
  '(6) wallsCrossed[0].throughOpening = false (solid)');

if (failed > 0) { console.log(`\n${failed} wall-tl-regression test(s) FAILED`); process.exit(1); }
console.log('\nAll wall-tl-regression tests passed.');
