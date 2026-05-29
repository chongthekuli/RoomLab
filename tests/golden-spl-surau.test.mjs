// Golden: frozen SPL at 6 surau points × 2 bands — the physics tripwire.
//
// Dr. Chen's audit (docs/NYMPHYSICS_AUDIT_2026-05-29.md item 3) asked for a
// frozen-snapshot SPL fixture so the diffraction pipeline — which has churned
// through inversions (v=494→504 X-mirror, v=515→525 north-arrow, the qibla
// regressions, and the DEFERRED P1 thick-barrier-floor rework) — can't ship
// the next drift undetected. Sam owns it as the cross-surface convention owner.
//
// Scene: the surau azan-horn config — 4× hs880 on the minaret (NW corner,
// OUTSIDE the building) firing outward in cardinal directions at −12°, over a
// rectangular hall with a 3-side arcade. This exercises exactly what the
// deferred diffraction fix will touch: over-wall diffraction (B, C), arcade
// porch lift (D), and the NE corner shadow (F). Same geometry as
// tests/heatmap-path-monotonicity.test.mjs, but this asserts ABSOLUTE values
// (drift), where that one asserts monotonicity (relative).
//
// Two assertion tiers per point (Dr. Chen's spec):
//   Tier 1 — drift: |spl − FROZEN| < 1.0 dB. THE golden. A deliberate physics
//            change (e.g. the thick-barrier-floor rework) re-blesses these.
//   Tier 2 — sanity orderings appropriate to THIS scene. NB: Dr. Chen's audit
//            A–F dB ranges assumed an INTERIOR PA; this scene's sources are
//            EXTERIOR azan horns, so they don't apply (A in-hall is quiet, B
//            next-to-horn is loud). We assert scene-correct orderings instead.
//
// Run: node tests/golden-spl-surau.test.mjs

// Flag ON before imports (Tier 1a diffraction + re-radiation active).
globalThis.localStorage = (() => {
  const s = { PHYSICS_P1_5: '1' };
  return { getItem: k => s[k] ?? null, setItem: (k, v) => { s[k] = String(v); }, removeItem: k => { delete s[k]; } };
})();

import { readFileSync } from 'node:fs';
const { computeMultiSourceSPL, computeRoomConstant } = await import('../js/physics/spl-calculator.js');
const { registerLoudspeaker, getCachedLoudspeaker } = await import('../js/physics/loudspeaker.js');

let failed = 0;
function assert(cond, label) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; }

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

// Production fill path (hs880 ships only 1000 Hz; class_hint fills the rest).
registerLoudspeaker('test://hs880', JSON.parse(readFileSync('./data/loudspeakers/amperes-hs880.json', 'utf8')));
const hs880 = getCachedLoudspeaker('test://hs880');

const W = 18.0, D = 17.7, H = 4.5;
const MIN_CX = -1.2, MIN_CY = D + 1.2, HORN_Z = 7.0, HORN_OFF = 1.0;
const room = {
  shape: 'rectangular', width_m: W, depth_m: D, height_m: H, enclosure: 'outdoor',
  surfaces: {
    floor: 'carpet-heavy-underlay', ceiling: 'gypsum-board',
    wall_north: 'concrete-painted', wall_south: 'concrete-painted',
    wall_east: 'concrete-painted', wall_west: 'concrete-painted',
  },
  surauStructure: {
    arcade: { sides: ['south', 'east', 'west'], depth_m: 3, roof_height_m: 4.4 },
    materials: { arcade_roof: 'concrete-painted', podium_top: 'concrete-painted' },
    podium: { extension_m: 3 },
  },
};
const horns = [
  { modelUrl: 'hs880', position: { x: MIN_CX,            y: MIN_CY + HORN_OFF, z: HORN_Z }, aim: { yaw: 0,   pitch: -12 }, power_watts: 80 },
  { modelUrl: 'hs880', position: { x: MIN_CX + HORN_OFF, y: MIN_CY,            z: HORN_Z }, aim: { yaw: 90,  pitch: -12 }, power_watts: 80 },
  { modelUrl: 'hs880', position: { x: MIN_CX,            y: MIN_CY - HORN_OFF, z: HORN_Z }, aim: { yaw: 180, pitch: -12 }, power_watts: 80 },
  { modelUrl: 'hs880', position: { x: MIN_CX - HORN_OFF, y: MIN_CY,            z: HORN_Z }, aim: { yaw: 270, pitch: -12 }, power_watts: 80 },
];
const R = materials.frequency_bands_hz.map(f => computeRoomConstant(room, materials, f, []));
const BAND_IDX = { 1000: 3, 4000: 5 };

// 6 representative points (Dr. Chen's A–F intent, mapped to this geometry).
const POINTS = {
  A: { pos: [9, 9, 1.7],     desc: 'clear in-hall (horns fire OUTward, so wall-leak only)' },
  B: { pos: [9, 18.5, 1.7],  desc: 'just past north/qibla wall, near a horn' },
  C: { pos: [9, 24, 1.7],    desc: 'deep behind the building (north)' },
  D: { pos: [-1.5, 9, 1.7],  desc: 'under the west arcade (porch lift active)' },
  E: { pos: [16, 2, 1.7],    desc: 'in-building far SE corner' },
  F: { pos: [18.5, -0.5, 1.7], desc: 'NE shadow corner, just outside' },
};

// FROZEN baseline — captured 2026-05-29 against the engine at commit ae83147
// (pre the DEFERRED diffraction thick-barrier-floor rework). When that lands,
// re-capture and re-bless these deliberately. [band1000, band4000] dB.
const FROZEN = {
  A: { 1000: 64.95, 4000: 65.10 },
  B: { 1000: 105.22, 4000: 103.50 },
  C: { 1000: 101.04, 4000: 97.60 },
  D: { 1000: 90.80, 4000: 83.14 },
  E: { 1000: 61.91, 4000: 62.29 },
  F: { 1000: 38.06, 4000: 24.40 },
};
const DRIFT_DB = 1.0;

const spl = {};
for (const [name, { pos, desc }] of Object.entries(POINTS)) {
  spl[name] = {};
  for (const f of [1000, 4000]) {
    const [x, y, z] = pos;
    const v = computeMultiSourceSPL({
      sources: horns, getSpeakerDef: () => hs880, listenerPos: { x, y, z },
      freq_hz: f, room, materials, roomConstantR: R[BAND_IDX[f]],
    });
    spl[name][f] = v;
    const frozen = FROZEN[name][f];
    const drift = Math.abs(v - frozen);
    assert(Number.isFinite(v) && drift < DRIFT_DB,
      `[${name} ${f}Hz] ${desc} — ${Number.isFinite(v) ? v.toFixed(2) : v} dB within ${DRIFT_DB} of frozen ${frozen} (Δ=${drift.toFixed(2)})`);
  }
}

// --- Tier 2: scene-correct sanity orderings (exterior azan horns) ----------
// All finite + physically plausible.
const allFinite = Object.values(spl).every(b => Number.isFinite(b[1000]) && Number.isFinite(b[4000]));
assert(allFinite, 'all 6 points produce finite SPL at both bands');
// F (NE corner, double-shadowed) is the quietest point at both bands.
assert(spl.F[1000] < spl.A[1000] && spl.F[4000] < spl.A[4000], 'F (corner shadow) quieter than A (in-hall)');
assert(spl.F[1000] < spl.E[1000], 'F (corner shadow) quieter than E (in-building)');
// B (next to a horn, just past the wall) is the loudest point.
assert(spl.B[1000] >= Math.max(...Object.values(spl).map(b => b[1000])) - 1e-6, 'B (next to horn) is the loudest point @ 1k');
// D under the arcade gets a porch lift → louder than the in-hall A.
assert(spl.D[1000] > spl.A[1000], 'D (under arcade, porch lift) louder than A (in-hall)');

if (failed) {
  console.log(`\n${failed} test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll golden-spl-surau tests passed.');
