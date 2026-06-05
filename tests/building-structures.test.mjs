// Building-structures physics regression tests (Dr. Lena Chen's assertion set,
// 2026-06-05). Guards the three energy-summed paths a structural obstruction
// applies to the field: diffraction (frequency-gated), mass-law transmission,
// and reverberant absorption. Plain node + console asserts, no framework.
//
// Each assertion is written at the band where the simplification would break
// (per Dr. Chen's verification discipline) — not just one happy-path band.

import {
  structureDirectPathLossPerBand,
  structureDirectPathLossDb,
  sumStructureAbsorption,
  structureExposedArea,
  structureHeightRange,
  _testing,
} from '../js/physics/building-structures.js';
import { computeAllBands } from '../js/physics/rt60.js';

let failed = 0;
function ok(cond, label, info = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${info}`);
  if (!cond) failed++;
}

const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];
const room = { shape: 'rectangular', width_m: 10, height_m: 3, depth_m: 8,
  surfaces: { floor: 'wood', ceiling: 'gyp', wall_north: 'conc', wall_south: 'conc', wall_east: 'conc', wall_west: 'conc' } };

// Raw materials.json-shaped rows (the structure-material provider hands these in).
const mats = new Map([
  ['concrete-painted', { absorption: [0.01, 0.01, 0.02, 0.02, 0.02, 0.03, 0.03], transmission_loss_db: [39, 41, 47, 53, 58, 62, 65] }],
  ['gypsum-board',     { absorption: [0.29, 0.10, 0.05, 0.04, 0.07, 0.09, 0.09], transmission_loss_db: [15, 20, 26, 30, 32, 28, 33] }],
]);

// =====================================================================
// PILLAR
// =====================================================================
const S = { x: 1, y: 4, z: 1.5 };
const R = { x: 9, y: 4, z: 1.2 };   // pillar at x=5 sits dead between

function pillar(extra = {}) {
  return { id: 'P', type: 'pillar', crossSection: 'round', diameter_m: 0.8,
    materialId: 'concrete-painted', position: { x: 5, y: 4 }, rotation_deg: 0, fullHeight: true, ...extra };
}

// 1. Frequency-gated shadow — the headline pillar physics. A 0.8 m column
//    shadows the HF but bass wraps around it. Assert BOTH bands.
{
  const loss = structureDirectPathLossPerBand(S, R, [pillar()], mats, BANDS, room);
  ok(loss[5] >= 4, 'pillar 0.8m: 4 kHz drop ≥ 4 dB', `(${loss[5].toFixed(2)} dB)`);
  ok(loss[0] < 1, 'pillar 0.8m: 125 Hz drop < 1 dB (bass wraps around)', `(${loss[0].toFixed(2)} dB)`);
}

// 2. Width monotonicity — a wider pillar casts a deeper shadow at 2 kHz.
{
  const lossNarrow = structureDirectPathLossPerBand(S, R, [pillar({ diameter_m: 0.4 })], mats, BANDS, room);
  const lossWide = structureDirectPathLossPerBand(S, R, [pillar({ diameter_m: 1.0 })], mats, BANDS, room);
  ok(lossWide[4] > lossNarrow[4], 'wider pillar deeper shadow @ 2 kHz', `(${lossWide[4].toFixed(2)} > ${lossNarrow[4].toFixed(2)})`);
}

// 3. Off-axis null — move the listener laterally out of the geometric shadow;
//    SPL returns to ~baseline (no spurious wide shadow).
{
  const Roff = { x: 9, y: 7.5, z: 1.2 };
  const loss = structureDirectPathLossPerBand(S, Roff, [pillar()], mats, BANDS, room);
  ok(loss[5] < 0.5, 'off-axis pillar → ~no loss @ 4 kHz', `(${loss[5].toFixed(2)} dB)`);
}

// 4. Square vs round at similar width shadow comparably (within a few dB) —
//    Maekawa keys off silhouette width, not cross-section shape.
{
  const lr = structureDirectPathLossPerBand(S, R, [pillar({ crossSection: 'round', diameter_m: 0.8 })], mats, BANDS, room);
  const lsq = structureDirectPathLossPerBand(S, R, [pillar({ crossSection: 'square', width_m: 0.8, depth_m: 0.8 })], mats, BANDS, room);
  ok(Math.abs(lr[5] - lsq[5]) < 4, 'round ≈ square shadow @ 4 kHz (silhouette-driven)', `(round ${lr[5].toFixed(2)} vs square ${lsq[5].toFixed(2)})`);
}

// =====================================================================
// HALF-WALL
// =====================================================================
// Wall rotated 90° → length axis along y; it blocks travel along x.
const Slow = { x: 3.5, y: 4, z: 1.0 };
const Rlow = { x: 6.5, y: 4, z: 1.0 };   // both low + close behind a tall wall = deep shadow

function halfWall(extra = {}) {
  return { id: 'HW', type: 'half_wall', length_m: 4, height_m: 1.8, thickness_m: 0.12,
    materialId: 'gypsum-board', position: { x: 5, y: 4 }, rotation_deg: 90, fullHeight: false, ...extra };
}

// 5. Height monotonicity — raising the wall deepens the shadow @ 2 kHz.
{
  const lo = structureDirectPathLossPerBand(Slow, Rlow, [halfWall({ height_m: 1.2 })], mats, BANDS, room);
  const hi = structureDirectPathLossPerBand(Slow, Rlow, [halfWall({ height_m: 2.2 })], mats, BANDS, room);
  ok(hi[4] > lo[4], 'taller half-wall deeper shadow @ 2 kHz', `(${hi[4].toFixed(2)} > ${lo[4].toFixed(2)})`);
}

// 6. Thicker / heavier partition → higher transmission loss. Compare gypsum vs
//    concrete at 125 Hz (below the coincidence dip) where the through-path
//    transmission floor dominates a low-frequency deep shadow.
{
  const gyp = structureDirectPathLossPerBand(Slow, Rlow, [halfWall({ materialId: 'gypsum-board' })], mats, BANDS, room);
  const conc = structureDirectPathLossPerBand(Slow, Rlow, [halfWall({ materialId: 'concrete-painted' })], mats, BANDS, room);
  ok(conc[0] > gyp[0], 'concrete half-wall higher loss @ 125 Hz than gypsum (TL floor)', `(${conc[0].toFixed(2)} > ${gyp[0].toFixed(2)})`);
}

// 7. Two-path transmission floor — behind a LIGHT half-wall the field is not
//    killed to silence: the through-mass path sets a floor above what
//    diffraction alone would deliver. Verify the delivered field with a finite
//    TL is louder (lower loss) than with an opaque (infinite-TL) wall.
{
  const realTL = structureDirectPathLossPerBand(Slow, Rlow, [halfWall({ materialId: 'gypsum-board' })], mats, BANDS, room);
  const opaque = structureDirectPathLossPerBand(Slow, Rlow, [halfWall({ materialId: 'gypsum-board' })], new Map(), BANDS, room); // no TL row → infinite TL
  ok(realTL[0] < opaque[0], 'transmission floor: light wall leaks more than opaque @ 125 Hz', `(${realTL[0].toFixed(2)} < ${opaque[0].toFixed(2)})`);
}

// 8. Around-the-end path — a listener past the END of a short wall reads a
//    smaller loss than one centred behind it (end diffraction dominates).
{
  const shortWall = halfWall({ length_m: 1.5, height_m: 2.5 });
  const lossCentre = structureDirectPathLossPerBand(Slow, Rlow, [shortWall], mats, BANDS, room);
  // Listener offset past the wall end (wall spans y=3.25..4.75 at x=5).
  const Rend = { x: 6.5, y: 5.6, z: 1.0 };
  const lossEnd = structureDirectPathLossPerBand(Slow, Rend, [shortWall], mats, BANDS, room);
  ok(lossEnd[4] < lossCentre[4], 'around-the-end path: less loss past the wall end @ 2 kHz', `(end ${lossEnd[4].toFixed(2)} < centre ${lossCentre[4].toFixed(2)})`);
}

// =====================================================================
// FULL-HEIGHT PARTITION + door
// =====================================================================
// 9. A full-height partition (reaches the ceiling) attenuates via TL only —
//    no over-top path. Concrete partition gives a large loss across bands.
{
  const part = { id: 'PT', type: 'partition', length_m: 6, thickness_m: 0.15,
    materialId: 'concrete-painted', position: { x: 5, y: 4 }, rotation_deg: 90, fullHeight: true };
  const loss = structureDirectPathLossPerBand(Slow, Rlow, [part], mats, BANDS, room);
  ok(loss[3] > 20, 'concrete full partition: heavy loss @ 1 kHz (TL path)', `(${loss[3].toFixed(2)} dB)`);
}

// =====================================================================
// ABSORPTION (path 3) — RT60 contribution
// =====================================================================
const alphaAt = (id, bi) => mats.get(id)?.absorption[bi] ?? 0;

// 10. RT60 near-no-op for ONE pillar, but the ΣA term is non-zero (wired).
{
  const aOne = sumStructureAbsorption([pillar()], room, alphaAt, 3);
  ok(aOne > 0, 'single pillar absorption fires (ΣA > 0)', `(${aOne.toFixed(4)} sabins)`);
}

// 11. Colonnade — 20 pillars produce a measurable (> 2%) RT60 drop in a hard
//     room. Proves the parallel-A wiring scales (computeAllBands integration).
{
  const hardMats = {
    frequency_bands_hz: BANDS,
    byId: {
      hard: { absorption: [0.02, 0.02, 0.03, 0.03, 0.04, 0.05, 0.05] },
      'concrete-painted': { absorption: mats.get('concrete-painted').absorption },
    },
  };
  const hardRoom = { ...room, surfaces: { floor: 'hard', ceiling: 'hard', wall_north: 'hard', wall_south: 'hard', wall_east: 'hard', wall_west: 'hard' } };
  const bare = computeAllBands({ room: hardRoom, materials: hardMats, structures: [] });
  const colonnade = Array.from({ length: 20 }, (_, i) => pillar({ id: 'C' + i, position: { x: 0.5 + i * 0.45, y: 4 } }));
  const withCol = computeAllBands({ room: hardRoom, materials: hardMats, structures: colonnade });
  const i1k = 3;
  const drop = (bare[i1k].sabine_s - withCol[i1k].sabine_s) / bare[i1k].sabine_s;
  ok(drop > 0.02, '20-pillar colonnade drops RT60 > 2% @ 1 kHz', `(${(drop * 100).toFixed(1)}%)`);
}

// 12. A gypsum half-wall adds enough surface area to move RT60 in a small room.
{
  const hardMats = { frequency_bands_hz: BANDS, byId: {
    hard: { absorption: [0.02, 0.02, 0.03, 0.03, 0.04, 0.05, 0.05] },
    'gypsum-board': { absorption: mats.get('gypsum-board').absorption },
  } };
  const hardRoom = { ...room, surfaces: { floor: 'hard', ceiling: 'hard', wall_north: 'hard', wall_south: 'hard', wall_east: 'hard', wall_west: 'hard' } };
  const bare = computeAllBands({ room: hardRoom, materials: hardMats, structures: [] });
  const withHW = computeAllBands({ room: hardRoom, materials: hardMats, structures: [{ id: 'HW', type: 'half_wall', length_m: 6, height_m: 1.5, thickness_m: 0.12, materialId: 'gypsum-board', position: { x: 5, y: 4 }, rotation_deg: 0, fullHeight: false }] });
  ok(withHW[0].sabine_s < bare[0].sabine_s, 'gypsum half-wall lowers RT60 @ 125 Hz', `(${withHW[0].sabine_s.toFixed(3)} < ${bare[0].sabine_s.toFixed(3)})`);
}

// =====================================================================
// CROSS-CUTTING GUARDS
// =====================================================================
// 13. Reposition-changes-metric (mirror feedback_directivity_aim_flip): moving
//     a pillar off the S→R line MUST change the loss. A structure that is a
//     silent no-op when moved is a bug.
{
  const onLine = structureDirectPathLossDb(S, R, [pillar()], mats, BANDS, 4000, room);
  const offLine = structureDirectPathLossDb(S, R, [pillar({ position: { x: 5, y: 7 } })], mats, BANDS, 4000, room);
  ok(Math.abs(onLine - offLine) > 1, 'moving the pillar changes the metric (not a no-op)', `(on ${onLine.toFixed(2)} vs off ${offLine.toFixed(2)})`);
}

// 14. Empty / malformed structures are inert and never throw.
{
  ok(structureDirectPathLossPerBand(S, R, [], mats, BANDS, room).every(v => v === 0), 'empty structures → zero loss');
  ok(structureDirectPathLossPerBand(S, R, [{ junk: true }], mats, BANDS, room).every(v => v === 0), 'malformed structure → zero loss (no throw)');
  ok(structureDirectPathLossPerBand(S, R, [pillar()], null, BANDS, room).every(v => v >= 0), 'no material catalogue → finite loss (TL→∞, diffraction only)');
}

// 15. finiteEdgeIL gating — pure Maekawa with no graze floor: 0 at/below the
//     lit boundary, rising with the Fresnel number.
{
  ok(_testing.finiteEdgeIL(0, 0.343) === 0, 'finiteEdgeIL(δ=0) = 0 (no graze floor)');
  ok(_testing.finiteEdgeIL(0.2, 0.0857) > _testing.finiteEdgeIL(0.2, 2.744), 'finiteEdgeIL rises with frequency (shorter λ)');
}

// 16. Height-range sanity — pillar full-height tracks the ceiling; half-wall stops short.
{
  const pr = structureHeightRange(pillar(), room);
  ok(pr.top === room.height_m && pr.base === 0, 'pillar full-height spans floor→ceiling', `(${pr.base}..${pr.top})`);
  const hr = structureHeightRange(halfWall({ height_m: 1.1 }), room);
  ok(Math.abs(hr.top - 1.1) < 1e-9, 'half-wall top = height_m', `(${hr.top})`);
  ok(structureExposedArea(pillar({ crossSection: 'round', diameter_m: 0.4 }), room) > 0, 'round pillar exposed area > 0');
}

console.log(failed === 0 ? '\nAll building-structures tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
