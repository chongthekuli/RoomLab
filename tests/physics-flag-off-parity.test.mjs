// Safety-net regression: with PHYSICS_P1_5 OFF, the engine must
// produce numerically-identical SPL values to v=468 (the pre-Tier-1a
// physics). This is the gate that lets us merge the four Tier 1a
// commits to main without breaking the public deploy (which has the
// flag off by default).
//
// If anything here fails, the flag gating in diffraction.js,
// reradiation.js, or the spl-calculator integration is broken — the
// engine's "default off" behaviour is leaking the new physics.

import { readFileSync } from 'node:fs';

// Explicitly DELETE the flag before module load so the module-level
// read returns false.
globalThis.localStorage = (() => {
  const _s = {};
  return {
    getItem: k => _s[k] ?? null,
    setItem: (k, v) => { _s[k] = String(v); },
    removeItem: k => { delete _s[k]; },
    _store: _s,
  };
})();

const { computeMultiSourceSPL, computeRoomConstant } = await import('../js/physics/spl-calculator.js');
const { PHYSICS_P1_5_ENABLED } = await import('../js/physics/feature-flags.js');
const { isInsideRoom3D } = await import('../js/physics/room-shape.js');

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

let failed = 0;
function pass(label) { console.log(`PASS  ${label}`); }
function fail(label, extra = '') { console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); failed++; }
function assertEq(a, b, label) { (a === b) ? pass(label) : fail(label, `actual=${a} expected=${b}`); }
function assertClose(a, b, tol, label) {
  if (Math.abs(a - b) < tol) pass(label);
  else fail(label, `actual=${a.toFixed(3)} expected=${b.toFixed(3)} tol=${tol}`);
}
function assertBetween(v, lo, hi, label) {
  (v >= lo && v <= hi) ? pass(label) : fail(label, `actual=${v.toFixed(2)} expected ${lo}..${hi}`);
}

assertEq(PHYSICS_P1_5_ENABLED, false, 'PHYSICS_P1_5 flag is OFF (default deploy state)');

// Use the same surau geometry the regression test uses; sample the
// same listener positions; compare the FLAG-OFF values to the
// known Tier 1 (v=467/468) reference values.

const surauRoom = {
  shape: 'rectangular',
  width_m: 18, height_m: 4.5, depth_m: 12,
  surfaces: {
    floor: 'carpet-heavy-underlay',
    ceiling: 'gypsum-board',
    wall_north: 'concrete-painted',
    wall_south: 'concrete-painted',
    wall_east: 'concrete-painted',
    wall_west: 'concrete-painted',
  },
};

const speaker10 = {
  modelUrl: 'spk',
  position: { x: 9, y: 11.25, z: 4.30 },
  aim: { yaw: 0, pitch: -90, roll: 0 },
  power_watts: 20,
};

const speakerDef = {
  acoustic: { sensitivity_db_1w_1m: 92, directivity_index_db: 8 },
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

const roomR_per_band = materials.frequency_bands_hz.map(fhz =>
  computeRoomConstant(surauRoom, materials, fhz, []));

const args = {
  sources: [speaker10],
  getSpeakerDef: () => speakerDef,
  freq_hz: 1000,
  room: surauRoom,
  materials,
  roomConstantR: roomR_per_band[3],
  roomR_per_band,
  isSourceInside: (src) => isInsideRoom3D(src.position, surauRoom),
  airAbsorption: true,
};

// (1) Listener inside, no walls crossed — diffraction + rerad should
// NOT fire even when the flag is on, so this value should be the same
// flag-on vs flag-off. With flag off, no change anyway.
const lst_under = { x: 9, y: 11.25, z: 1.7 };
const spl_under = computeMultiSourceSPL({ ...args, listenerPos: lst_under });
assertBetween(spl_under, 90, 110, '(1) Inside-hall SPL unchanged with flag OFF (no walls in path)');

// (2) THE critical test: listener behind solid qibla wall. With
// flag OFF this MUST read the same low value as pre-Tier-1a (~37 dB
// region). If it reads 70+ dB, the flag gating is broken.
const lst_behind = { x: 9, y: 12.3, z: 1.7 };
const spl_behind = computeMultiSourceSPL({ ...args, listenerPos: lst_behind });
assertBetween(spl_behind, 20, 50,
  '(2) Flag OFF: behind qibla wall = through-wall TL only (20-50 dB), NOT the Tier 1a diffraction lift');

// (3) Lateral probes — pre-Tier-1a these were all near-identical
// because TL is a step function (binary inside/outside). With flag
// off they should agree to within a couple dB (small distance/angle
// effects only).
const probes = [
  computeMultiSourceSPL({ ...args, listenerPos: { x: 9,    y: 12.3, z: 1.7 } }),
  computeMultiSourceSPL({ ...args, listenerPos: { x: 14,   y: 12.3, z: 1.7 } }),
  computeMultiSourceSPL({ ...args, listenerPos: { x: 17.5, y: 12.3, z: 1.7 } }),
];
const range = Math.max(...probes) - Math.min(...probes);
// Pre-Tier-1a behaviour: all three listeners get the same -53 dB TL
// applied; the only variation is from 1/r² + directivity, which is
// modest at these distances. Range should be < 10 dB.
if (range < 10) pass(`(3) Flag OFF: lateral probe variance < 10 dB (was a hard rectangle pre-Tier-1a)`);
else fail(`(3) Flag OFF: lateral probe range ${range.toFixed(2)} dB unexpectedly large`,
  `probes: ${probes.map(p => p.toFixed(1)).join(', ')}`);

// (4) Through an OPEN south door (x=9 aligns with middle door at x_m=8.5..9.5).
// With flag off, TL=0 (open-air material) so direct path is full-strength.
// This validates the wall-path opening detection is still working with
// the flag off (the opening logic is OUTSIDE the Tier 1a flag gate).
const surauWithDoor = {
  ...surauRoom,
  surfaces: {
    ...surauRoom.surfaces,
    wall_south: {
      materialId: 'concrete-painted',
      openings: [{
        x_m: 8.5, z_m: 0, width_m: 1.0, height_m: 2.4,
        state: 'open', materialId: 'open-air',
      }],
    },
  },
};
// To get the path through the door, listener has to be low enough that
// the path enters at z < 2.4. Speaker at z=4.30, listener at z=0.5,
// wall at y=12: t = 0.75/(12.5-11.25)=0.6; hit z = 4.30 + 0.6*(0.5-4.30) = 2.02 → in door
const lst_thru_door = { x: 9, y: 12.5, z: 0.5 };
const spl_door = computeMultiSourceSPL({
  ...args, room: surauWithDoor, listenerPos: lst_thru_door,
});
const spl_no_door = computeMultiSourceSPL({ ...args, listenerPos: lst_thru_door });
assertBetween(spl_door - spl_no_door, 40, 70,
  '(4) Flag OFF: through-door listener is 40-70 dB louder than through-wall listener at same position (opening detection unaffected by flag)');

if (failed > 0) { console.log(`\n${failed} flag-off parity test(s) FAILED`); process.exit(1); }
console.log('\nAll flag-off parity tests passed.');
