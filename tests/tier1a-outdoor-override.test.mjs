// Tier 1a outdoor safety override — interim regression guard (2026-05-24).
//
// Context: the 2026-05-24 tri-agent audit (Dr. Chen physics + Martina code +
// Sam tests; collated in docs/HEATMAP_AUDIT_SYNTHESIS_2026-05-24.md) scoped a
// 5-6 day Phase A substrate + Phase B physics rework to fix the diffraction
// parallel-bypass bug that causes shadowed-cell SPL inversions. During that
// window, a SAFETY OVERRIDE flag lets the user disable Tier 1a contributions
// (Maekawa diffraction, Kuttruff wall re-radiation, image-source overhead,
// porch enclosure) FOR OUTDOOR MODE ONLY, so demos and stakeholder previews
// show clean direct+reverb only without the inversion artifacts.
//
// This test pins THREE properties of the override:
//   (A) Default-off — without the localStorage flag, behaviour is identical
//       to pre-override (preserves the existing test corpus's expectations).
//   (B) Outdoor scoped — when ON, INDOOR computeSPLGrid output is unchanged.
//   (C) Tier 1a actually disabled — when ON, outdoor cells that previously
//       received a diffraction contribution must drop measurably.
//
// GRADUATION: this whole test file gets DELETED in the Phase B commit that
// makes the diffraction physics correct (override no longer needed, and the
// related code in feature-flags.js + spl-calculator.js + wall-sim.js is
// removed). Pair-deletion enforced by a comment grep in the squash commit.

import { readFileSync } from 'node:fs';

// localStorage stub — values are reset between phases of the test.
const _store = { PHYSICS_P1_5: '1' };
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
};

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

const { computeMultiSourceSPL, computeRoomConstant } =
  await import('../js/physics/spl-calculator.js');
const {
  isTier1aOutdoorOverrideDisabled,
  setTier1aOutdoorOverrideDisabled,
  PHYSICS_TIER1A_OUTDOOR_OVERRIDE_KEY,
} = await import('../js/physics/feature-flags.js');

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};
const hs880 = JSON.parse(readFileSync(
  './data/loudspeakers/amperes-hs880.json', 'utf8'));

const W = 18, D = 17.7, H = 4.5;
const MIN_CX = -1.2, MIN_CY = D + 1.2;

const outdoorRoom = {
  shape: 'rectangular', width_m: W, depth_m: D, height_m: H,
  enclosure: 'outdoor',
  surfaces: {
    floor: 'carpet-heavy-underlay', ceiling: 'gypsum-board',
    wall_north: 'concrete-painted', wall_south: 'concrete-painted',
    wall_east:  'concrete-painted', wall_west:  'concrete-painted',
  },
  surauStructure: {
    arcade: { sides: ['south','east','west'], depth_m: 3, roof_height_m: 4.4 },
    materials: { arcade_roof: 'concrete-painted', podium_top: 'concrete-painted' },
    podium: { extension_m: 3 },
  },
};

// SAME geometry, INDOOR enclosure — used to verify the override is scoped
// to outdoor only.
const indoorRoom = { ...outdoorRoom, enclosure: 'indoor' };

const horns = [
  { modelUrl: 'hs880', position: { x: MIN_CX,     y: MIN_CY + 1, z: 7 }, aim: { yaw: 0,   pitch: -12 }, power_watts: 80 },
  { modelUrl: 'hs880', position: { x: MIN_CX + 1, y: MIN_CY,     z: 7 }, aim: { yaw: 90,  pitch: -12 }, power_watts: 80 },
  { modelUrl: 'hs880', position: { x: MIN_CX,     y: MIN_CY - 1, z: 7 }, aim: { yaw: 180, pitch: -12 }, power_watts: 80 },
  { modelUrl: 'hs880', position: { x: MIN_CX - 1, y: MIN_CY,     z: 7 }, aim: { yaw: 270, pitch: -12 }, power_watts: 80 },
];

function splAt(room, pos, R) {
  return computeMultiSourceSPL({
    sources: horns, getSpeakerDef: () => hs880, listenerPos: pos,
    freq_hz: 1000, room, materials, roomConstantR: R,
  });
}

// ---------------------------------------------------------------------------
// (A) Default-off — override absent from storage leaves Tier 1a active
// ---------------------------------------------------------------------------
delete _store[PHYSICS_TIER1A_OUTDOOR_OVERRIDE_KEY];
check('(A) default state — override NOT disabled',
  isTier1aOutdoorOverrideDisabled() === false);

const R_outdoor = computeRoomConstant(outdoorRoom, materials, 1000, []);
const splA_outdoor_off = splAt(outdoorRoom, { x: -1.5, y: -2, z: 1.7 }, R_outdoor);
const splB_outdoor_off = splAt(outdoorRoom, { x:  1.0, y: -2, z: 1.7 }, R_outdoor);

// With override OFF, Tier 1a is active and produces NON-TRIVIAL readings.
// The exact magnitudes are the post-Phase-B (single-best-path) values;
// they're invariant-pinned ("both > 60 dB, no inversion") rather than
// magnitude-locked because the underlying physics is still being tuned
// in Phase C (thick-barrier IL formula, materials.json thickness_m).
//
// IMPORTANT: this test was originally written (v=647) pinning the
// PRE-Phase-B values (splA ≈ 89.9, splB ≈ 92.6 — WITH the inversion).
// Phase B1 fixed the inversion (B < A now), so pinning the old
// magnitudes would make Phase B's correctness a test failure. Updated
// to invariant form 2026-05-24.
check('(A) outdoor A with override OFF reads > 60 dB (Tier 1a active)',
  splA_outdoor_off > 60,
  `splA=${splA_outdoor_off.toFixed(1)}`);
check('(A) outdoor B with override OFF reads > 60 dB (Tier 1a active)',
  splB_outdoor_off > 60,
  `splB=${splB_outdoor_off.toFixed(1)}`);
check('(A) outdoor B ≤ outdoor A (no inversion, Phase B1 fix verified here too)',
  splB_outdoor_off <= splA_outdoor_off + 1.5,
  `splA=${splA_outdoor_off.toFixed(1)}, splB=${splB_outdoor_off.toFixed(1)}, Δ=${(splB_outdoor_off-splA_outdoor_off).toFixed(1)}`);

// ---------------------------------------------------------------------------
// (B) Outdoor scoped — INDOOR not affected by the override
// ---------------------------------------------------------------------------
// Sample an indoor listener position (a cell INSIDE the building footprint
// where the listener-interior gate would activate the room-constant reverb).
const indoorPos = { x: 9, y: 9, z: 1.7 };
const R_indoor = computeRoomConstant(indoorRoom, materials, 1000, []);
const splIndoor_off = splAt(indoorRoom, indoorPos, R_indoor);

setTier1aOutdoorOverrideDisabled(true);
check('(B) override toggle wrote to storage',
  isTier1aOutdoorOverrideDisabled() === true);

const splIndoor_on = splAt(indoorRoom, indoorPos, R_indoor);
check('(B) INDOOR cell SPL unchanged by override (override is outdoor-scoped)',
  Math.abs(splIndoor_on - splIndoor_off) < 0.1,
  `Δ = ${(splIndoor_on - splIndoor_off).toFixed(3)} dB (off=${splIndoor_off.toFixed(1)} on=${splIndoor_on.toFixed(1)})`);

// ---------------------------------------------------------------------------
// (C) Tier 1a actually disabled — outdoor cell that received diffraction
//     contribution must drop measurably when override is ON
// ---------------------------------------------------------------------------
const splA_outdoor_on = splAt(outdoorRoom, { x: -1.5, y: -2, z: 1.7 }, R_outdoor);
const splB_outdoor_on = splAt(outdoorRoom, { x:  1.0, y: -2, z: 1.7 }, R_outdoor);

// A previously got most of its SPL from diffraction (~89.9 dB). With Tier 1a
// off, it falls back to direct-through-roof-TL (~49 dB pre-override probe).
// Allow generous range (≥ 20 dB drop) so material catalogue tweaks don't
// break this without changing the override semantics.
const dropA = splA_outdoor_off - splA_outdoor_on;
check('(C) outdoor A with override ON drops ≥ 20 dB (diffraction was dominant)',
  dropA >= 20,
  `off=${splA_outdoor_off.toFixed(1)} on=${splA_outdoor_on.toFixed(1)} Δ=${dropA.toFixed(1)} dB`);

const dropB = splB_outdoor_off - splB_outdoor_on;
check('(C) outdoor B with override ON drops ≥ 30 dB (deep-shadow cell, no bypass)',
  dropB >= 30,
  `off=${splB_outdoor_off.toFixed(1)} on=${splB_outdoor_on.toFixed(1)} Δ=${dropB.toFixed(1)} dB`);

// Cleanup — leave the test environment in default-off state.
setTier1aOutdoorOverrideDisabled(false);
check('(C) setter with false clears the storage key',
  isTier1aOutdoorOverrideDisabled() === false);

// ---------------------------------------------------------------------------
// Source-grep: the override is wired into BOTH computeSPLGrid AND
// computeMultiSourceSPL paths (per-listener readout must match the
// heatmap).
// ---------------------------------------------------------------------------
const splSrc = readFileSync('./js/physics/spl-calculator.js', 'utf8');
const overrideCallsites = (splSrc.match(/isTier1aOutdoorOverrideDisabled\(\)/g) || []).length;
check('source: override is consulted in BOTH computeSPLGrid + computeMultiSourceSPL',
  overrideCallsites >= 2,
  `found ${overrideCallsites} call sites`);

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${failed === 0 ? 'all checks passed' : failed + ' failed'}`);
if (failed > 0) process.exit(1);
