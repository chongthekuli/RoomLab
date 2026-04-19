// STIPA — IEC 60268-16 Annex C tests.
import {
  computeSTIPA, STIPA_BANDS, STIPA_MOD_FREQS, stipaRating,
} from '../js/physics/stipa.js';

let failed = 0;
function assertClose(actual, expected, tol, label) {
  const ok = Math.abs(actual - expected) < tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${actual.toFixed(3)} expected=${expected.toFixed(3)}`);
  if (!ok) failed++;
}
function expect(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// --- Band + modulation frequency tables match spec ---------------------
expect(STIPA_BANDS.length === 7, 'STIPA covers 7 octave bands (125–8k)');
expect(
  STIPA_BANDS[0] === 125 && STIPA_BANDS[6] === 8000,
  'Band range: 125 Hz to 8 kHz',
);
expect(
  STIPA_MOD_FREQS[500][0] === 0.63 && STIPA_MOD_FREQS[500][1] === 3.15,
  '500 Hz modulation pair is 0.63 / 3.15 Hz (IEC 60268-16 Annex C)',
);
expect(
  STIPA_MOD_FREQS[8000][0] === 2.50 && STIPA_MOD_FREQS[8000][1] === 12.50,
  '8 kHz modulation pair is 2.50 / 12.5 Hz',
);

// --- Rating bucket boundaries ------------------------------------------
expect(stipaRating(0.10) === 'bad',        'STI 0.10 → bad');
expect(stipaRating(0.40) === 'poor',       'STI 0.40 → poor');
expect(stipaRating(0.55) === 'fair',       'STI 0.55 → fair');
expect(stipaRating(0.70) === 'good',       'STI 0.70 → good');
expect(stipaRating(0.85) === 'excellent',  'STI 0.85 → excellent');

// --- End-to-end: a ~dry small room with high direct-field SNR → high STI
const speaker = {
  acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 6 },
  directivity: {
    azimuth_deg: [-180, -90, 0, 90, 180],
    elevation_deg: [-90, 0, 90],
    attenuation_db: {
      '1000': [
        [-20, -20, -20, -20, -20],
        [ -6,  -3,   0,  -3,  -6],
        [-20, -20, -20, -20, -20],
      ],
    },
  },
};
const materials = {
  frequency_bands_hz: [125, 250, 500, 1000, 2000, 4000],
  byId: {
    'carpet':       { absorption: [0.3, 0.5, 0.7, 0.8, 0.85, 0.85] },
    'panel':        { absorption: [0.3, 0.5, 0.7, 0.8, 0.85, 0.85] },
    'wood-floor':   { absorption: [0.3, 0.5, 0.7, 0.8, 0.85, 0.85] },
  },
};
// Small, well-damped room (α ≈ 0.7 average across bands → RT60 ≈ 0.3 s)
const dryRoom = {
  shape: 'rectangular', width_m: 6, height_m: 3, depth_m: 6,
  ceiling_type: 'flat',
  surfaces: { floor: 'wood-floor', ceiling: 'panel', walls: 'carpet',
              wall_north: 'carpet', wall_south: 'carpet',
              wall_east: 'carpet', wall_west: 'carpet' },
};
const src = { modelUrl: 'sp', position: { x: 1, y: 1, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 10 };
const listenerClose = { x: 1, y: 3, z: 1.2 };

const dry = computeSTIPA({
  sources: [src],
  getSpeakerDef: () => speaker,
  listenerPos: listenerClose,
  room: dryRoom, materials,
});
console.log(`    Dry room STIPA: sti=${dry.sti.toFixed(3)} (${dry.rating})`);
expect(dry.sti > 0.60, 'Dry near-field room → at least good intelligibility');

// --- Long RT60 reverberant arena → degraded STI ------------------------
const reverbRoom = {
  shape: 'rectangular', width_m: 60, height_m: 22, depth_m: 60,
  ceiling_type: 'flat',
  surfaces: { floor: 'wood-floor', ceiling: 'panel', walls: 'carpet',
              wall_north: 'carpet', wall_south: 'carpet',
              wall_east: 'carpet', wall_west: 'carpet' },
};
// Same room, swap in very reflective materials.
const reflectiveMaterials = {
  frequency_bands_hz: [125, 250, 500, 1000, 2000, 4000],
  byId: {
    'carpet':     { absorption: [0.02, 0.03, 0.04, 0.04, 0.04, 0.05] },
    'panel':      { absorption: [0.02, 0.03, 0.04, 0.04, 0.04, 0.05] },
    'wood-floor': { absorption: [0.02, 0.03, 0.04, 0.04, 0.04, 0.05] },
  },
};
const reverb = computeSTIPA({
  sources: [src],
  getSpeakerDef: () => speaker,
  listenerPos: { x: 30, y: 55, z: 1.2 },   // far-field in large reverberant room
  room: reverbRoom, materials: reflectiveMaterials,
});
console.log(`    Reverberant arena STIPA: sti=${reverb.sti.toFixed(3)} (${reverb.rating})`);
expect(reverb.sti < dry.sti - 0.1, 'Large reverberant hall gives LOWER STI than dry near-field');

// --- TI arrays sanity ---
expect(dry.ti_per_band.length === 7,  'Dry room returns 7 per-band TI values');
expect(dry.ti_per_band.every(v => v >= 0 && v <= 1), 'All TI values in [0, 1]');

// --- Spatial variation (D/R-aware MTF regression) ---
// Previously, STIPA gave the same STI at every listener in a reverb-
// dominated room because MTF = m_rev × (D+R)/(D+R+N) applied the reverb
// smearing to the direct field too. With the D/R-aware form
// MTF = (D + R·m_rev)/(D+R+N), close-to-source listeners see MTF ≈ 1 and
// far listeners see MTF ≈ m_rev — producing real spatial variation.
{
  const arenaSpeaker = {
    acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 10 },
    directivity: { azimuth_deg: [-180, 0, 180], elevation_deg: [-90, 0, 90], attenuation_db: {} },
  };
  const arenaSrc = {
    position: { x: 30, y: 30, z: 15 }, aim: { yaw: 0, pitch: -45, roll: 0 },
    power_watts: 500, modelUrl: 'arena.json',
  };
  const bigRoom = {
    shape: 'rectangular', width_m: 60, height_m: 20, depth_m: 60,
    ceiling_type: 'flat',
    surfaces: { floor: 'wood-floor', ceiling: 'panel', walls: 'carpet',
                wall_north: 'carpet', wall_south: 'carpet',
                wall_east: 'carpet', wall_west: 'carpet' },
  };
  const closeStiR = computeSTIPA({
    sources: [arenaSrc], getSpeakerDef: () => arenaSpeaker,
    listenerPos: { x: 30, y: 30, z: 1.6 },   // 13 m from source (near)
    room: bigRoom, materials: reflectiveMaterials,
  });
  const farStiR = computeSTIPA({
    sources: [arenaSrc], getSpeakerDef: () => arenaSpeaker,
    listenerPos: { x: 58, y: 58, z: 1.6 },   // ~45 m diagonal (far)
    room: bigRoom, materials: reflectiveMaterials,
  });
  console.log(`    Near STI=${closeStiR.sti.toFixed(3)}  Far STI=${farStiR.sti.toFixed(3)}`);
  expect(closeStiR.sti > farStiR.sti + 0.05,
    'Close-to-source STI > far-reverb STI (spatial D/R variation present)');
}

if (failed > 0) { console.log(`\n${failed} STIPA test(s) FAILED`); process.exit(1); }
console.log('\nAll STIPA tests passed.');
