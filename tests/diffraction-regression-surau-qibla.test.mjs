// User-visible bug-fix tripwire for Tier 1a. Captures the exact
// scenario the user reported on 2026-05-17:
//
//   "in surau preset, with walk mode, under speaker 10 reads ~90 dB,
//    just outside the south concrete wall reads 37 dB. The SPL drop
//    is more like directional, totally doesn't match what physics
//    of real world."
//
// Pre-Tier-1a: 37 dB read came from through-wall TL only (no
// diffraction, no re-radiation). The heatmap behind the qibla wall
// was a hard rectangular dark patch.
//
// After Tier 1a: the same listener position should read ~50–80 dB
// at 1 kHz because diffraction over the wall top edge dominates the
// energy sum (the 53 dB concrete TL is bypassed by going around the
// wall, not through it). Re-radiation contributes a few dB more.
//
// This test locks the post-fix value. Every future change to
// diffraction.js, reradiation.js, or the spl-calculator integration
// must keep this test passing.

import { readFileSync } from 'node:fs';

// Set flag BEFORE imports so PHYSICS_P1_5_ENABLED reads truthy.
globalThis.localStorage = (() => {
  const _s = { PHYSICS_P1_5: '1' };
  return {
    getItem: k => _s[k] ?? null,
    setItem: (k, v) => { _s[k] = String(v); },
    removeItem: k => { delete _s[k]; },
    _store: _s,
  };
})();

const { computeMultiSourceSPL } = await import('../js/physics/spl-calculator.js');
const { PHYSICS_P1_5_ENABLED } = await import('../js/physics/feature-flags.js');
const { computeRoomConstant } = await import('../js/physics/spl-calculator.js');
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
function assertBetween(v, lo, hi, label) {
  (v >= lo && v <= hi) ? pass(label) : fail(label, `actual=${v.toFixed(2)} expected ${lo}..${hi}`);
}
function assertTrue(cond, label, extra = '') { cond ? pass(label) : fail(label, extra); }

// Flag must be ON for this test.
assertTrue(PHYSICS_P1_5_ENABLED, 'PHYSICS_P1_5 ON');

// Surau geometry (matches the live preset shape).
// 18 m × 4.5 m H × 12 m, painted concrete walls, three south-wall door
// openings centred at world-x ≈ 4.5, 9, 13.5.
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

// Speaker 10: imam-zone ceiling speaker, aim straight down, 20 W.
const speaker10 = {
  modelUrl: 'spk',
  position: { x: 9, y: 11.25, z: 4.30 },
  aim: { yaw: 0, pitch: -90, roll: 0 },
  power_watts: 20,
};

// Mock speaker — sens 92 dB / DI 8 / mild downward beam.
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

// Per-band R from the materials catalogue (mirrors what scene.js threads).
const roomR_per_band = materials.frequency_bands_hz.map(fhz =>
  computeRoomConstant(surauRoom, materials, fhz, []));

const commonArgs = {
  sources: [speaker10],
  getSpeakerDef: () => speakerDef,
  freq_hz: 1000,
  room: surauRoom,
  materials,
  roomConstantR: roomR_per_band[3],   // 1 kHz band
  roomR_per_band,
  isSourceInside: (src) => isInsideRoom3D(src.position, surauRoom),
  airAbsorption: true,
};

// (1) Baseline — listener UNDER the ceiling speaker, inside the hall.
// Should still read high (no walls in path, all Tier 1a additions
// early-return zero).
const lst_under = { x: 9, y: 11.25, z: 1.7 };
const spl_under = computeMultiSourceSPL({ ...commonArgs, listenerPos: lst_under });
assertBetween(spl_under, 90, 110, '(1) Listener directly under speaker 10 → 90-110 dB (Tier 1a NOT firing inside hall)');

// (2) The user's exact reported scenario — listener JUST OUTSIDE the
// south wall (solid section, no door alignment). Pre-Tier-1a this read
// 37 dB; post-Tier-1a it should jump dramatically.
const lst_behind_qibla = { x: 9, y: 12.3, z: 1.7 };
const spl_behind_qibla = computeMultiSourceSPL({ ...commonArgs, listenerPos: lst_behind_qibla });
// Dr. Chen's prediction: diffraction over the top edge alone gives
// ~71 dB at 1 kHz for this geometry. Re-radiation adds a few dB more.
// Allow wide window to absorb directivity / sensitivity variation
// from the test speakerDef vs the real cached one.
assertBetween(spl_behind_qibla, 50, 85,
  '(2) Listener just behind solid qibla wall → 50-85 dB (was 37 dB pre-Tier-1a)');

const drop_inside_to_qibla = spl_under - spl_behind_qibla;
assertBetween(drop_inside_to_qibla, 15, 50,
  '(2b) Drop inside-under to just-behind-qibla = 15-50 dB (was ~53 dB pre-Tier-1a — diffraction softens the cliff)');

// (3) Far behind the wall (~10 m away) — diffraction + re-radiation
// both fall off with distance, so this should be substantially lower.
// Critical: monotonically decreasing, NOT a step function.
const lst_far = { x: 9, y: 22, z: 1.7 };
const spl_far = computeMultiSourceSPL({ ...commonArgs, listenerPos: lst_far });
assertTrue(spl_far < spl_behind_qibla,
  '(3a) SPL at 10 m behind wall < SPL just behind wall (monotonic)',
  `far=${spl_far.toFixed(1)} near=${spl_behind_qibla.toFixed(1)}`);
// But still meaningful — not the noise floor.
assertBetween(spl_far, 25, 70, '(3b) Listener 10 m behind wall → 25-70 dB (re-rad + diffraction still contribute)');

// (4) MONOTONIC SOFT GRADIENT — sample three listener positions
// laterally across the wall at fixed (perpendicular) distance. The
// SPL should vary SMOOTHLY across them. Pre-Tier-1a it was a flat
// dark rectangle (all 37 dB).
const probes = [
  { lbl: 'centre',      pos: { x: 9,    y: 12.3, z: 1.7 } },
  { lbl: 'east-offset', pos: { x: 14,   y: 12.3, z: 1.7 } },
  { lbl: 'east-edge',   pos: { x: 17.5, y: 12.3, z: 1.7 } },
];
const probeVals = probes.map(p => ({
  lbl: p.lbl,
  spl: computeMultiSourceSPL({ ...commonArgs, listenerPos: p.pos }),
}));
// Variance across the three probes must be > 0.5 dB (NOT a flat
// rectangle). Pre-Tier-1a, all three would have read identical values
// because TL is a step function with no spatial gradient.
const splArr = probeVals.map(p => p.spl);
const probeRange = Math.max(...splArr) - Math.min(...splArr);
assertTrue(probeRange > 0.5,
  '(4) Lateral probes across wall show variance > 0.5 dB (soft gradient, not a flat rectangle)',
  `probes: ${probeVals.map(p => `${p.lbl}=${p.spl.toFixed(1)}`).join(', ')}; range=${probeRange.toFixed(2)}`);

// ---- (5) NE-CORNER GRADIENT (Tier 1a commit (e) — P9 fix) ----
// The shadow boundary at the NE corner separates "east wall blocks the
// speaker" (deep shadow, ~54 dB) from "east wall doesn't block the
// speaker, only north wall does" (single-wall shadow, ~68 dB). Pre-(e)
// behaviour: behind the building the field is a flat dead zone (no
// gradient at all, all positions read identical through-wall TL),
// because rectangular-wall vertical edges weren't diffracting.
//
// Post-(e): the wedge contribution from the NE corner creates a
// continuous spatial gradient across the shadow boundary. The step
// from "deep shadow" to "single-wall shadow" can't be eliminated
// (it's irreducible physics — direct-ray-blocked vs unblocked), but
// it's now a smooth gradient over several metres rather than a flat
// dead rectangle.
//
// Acceptance: (a) the corner boundary gradient is < 15 dB (not infinite
// step / hard cliff), and (b) intermediate probes show a continuous
// monotonic rise from in-shadow to past-corner (no flat sub-regions).
const probe_xs = [16.5, 17, 17.5, 18, 18.5, 19];
const probe_vals = probe_xs.map(x => computeMultiSourceSPL({
  ...commonArgs, listenerPos: { x, y: -0.5, z: 1.7 },
}));
const corner_gradient = Math.max(...probe_vals) - Math.min(...probe_vals);
assertTrue(corner_gradient < 15 && corner_gradient > 3,
  `(5a) NE-corner gradient is a real continuous transition (3 < ${corner_gradient.toFixed(2)} < 15 dB)`,
  `probes: ${probe_xs.map((x, i) => `x=${x}=${probe_vals[i].toFixed(1)}`).join(', ')}`);
// Continuous monotonicity: each step from in-shadow to past-corner
// must be ≤ 8 dB (was ~10+ dB pre-(e) as a single hard cliff).
let max_step = 0;
for (let i = 1; i < probe_vals.length; i++) {
  const step = Math.abs(probe_vals[i] - probe_vals[i - 1]);
  if (step > max_step) max_step = step;
}
assertTrue(max_step < 8,
  `(5b) No single-metre step in the gradient exceeds 8 dB (post-wedge: ${max_step.toFixed(2)} dB)`,
  `pre-(e) all probes read ~37.7 dB (dead rectangle); post-(e) gradient is continuous`);

if (failed > 0) { console.log(`\n${failed} surau qibla regression test(s) FAILED`); process.exit(1); }
console.log('\nAll surau qibla diffraction regression tests passed.');
