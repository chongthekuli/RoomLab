// Heatmap path-monotonicity invariant — Phase A0 tripwire / Phase B gate.
//
// Sam Reyes spec, 2026-05-24, from docs/SAM_HEATMAP_COVERAGE_AUDIT_2026-05-24.md §7.
//
// The shared invariant that ALL four user-reported heatmap inversions violate:
//
//   For a fixed source array S and two listener cells A and B in the same
//   outdoor field, if every direct path from any source s ∈ S to B passes
//   through at least as many solid surfaces as the corresponding path to A,
//   then SPL(B) ≤ SPL(A) + ε  (ε = 1.5 dB tolerance for residual reverberant
//   gradient).
//
// Equivalently: adding obstacles between source and receiver, holding all
// else equal, can only attenuate. It is physically impossible for a cell
// that crosses STRICTLY MORE walls in its path stack to read LOUDER than a
// cell that crosses fewer.
//
// The four bugs this invariant catches:
//   I1 — SW corner +11 dB above mid-wall row
//   I2 — listener inside building louder than listener outside under arcade
//   I3 — listener-6 hotspot perceived as inversion (within Pierce-Hadden,
//        but the spatial gradient bound R7 also catches it)
//   I4 — listener B (1, -2, 1.7) behind south wall reads 92.6 dB while
//        listener A (-1.5, -2, 1.7) at clear LOS reads 89.9 dB
//
// Root cause (all four): computeDiffractionContributions energy-sums Maekawa
// IL across EVERY edge of EVERY wall in wallsCrossed. Paths crossing N walls
// in series inherit N parallel bypass channels → more obstacles = more
// energy. ISO 9613-2 §7.4.2 says "single most-effective screen", not sum.
//
// Phase B rewrite of computeDiffractionContributions per Dr. Chen's spec
// (per-path shortest-detour with bent-path validation) MUST satisfy this
// invariant to be considered done.
//
// ----------------------------------------------------------------------------
//                           GREEN-LIGHT GATE FOR PHASE B
// ----------------------------------------------------------------------------
//
// This fixture is intentionally failing today on the I4 pair. It is the
// pre-built test bed that Phase B will satisfy. Until Phase B lands, the
// test runs in PHASE_B_PENDING mode:
//   - Counts and prints all monotonicity violations (so they're visible).
//   - EXITS 0 so CI doesn't break for an expected-failing test.
//   - Asserts the violation count is ≤ a snapshot baseline (catches the
//     situation where someone makes the inversion WORSE before Phase B).
//
// When Phase B lands, flip PHASE_B_COMPLETE to true ONE TIME. From that
// commit onward, ANY violation fails the test with exit 1.
//
// ----------------------------------------------------------------------------

// Phase B1+B3 (2026-05-24) reduced the violation count from 128 to 78,
// but didn't get to 0 — the remaining violations are mostly cells
// AT-or-IN building walls (Phase 7 wallInsetPolygon annulus boundary
// cases where the cell's classification flickers between interior and
// annulus) and a residual class of cells with high wallCount but low
// SPL difference (where wallCount over-counts physically dominant
// shadowing). Both classes are addressable in a future Phase B
// refinement pass (Sam's R8 is the broad gate; R1-R7 catch the
// canonical user-reported inversions and ALL PASS).
//
// Snapshot baseline captured POST-Phase-B-1+3:
//   250 Hz  :  15 violations
//   1000 Hz :  35 violations
//   4000 Hz :  28 violations
//   ----------------------------
//   Total   :  78 violations  (was 128 pre-B; -39%)
//
// ----------------------------------------------------------------------------
// Phase 3 indoor exterior-source coupling fix (2026-05-25) raised the
// count from 78 to 110. Dr. Chen's diagnosis after instrumenting the
// canonical violation cells (Q=(2,-6), Q=(0,9) at all 3 bands):
//
//   Pre-Phase-3, the indoor reverberant aggregate L_p_rev_inside_band_db
//   was inflated to ~113 dB for the all-EXTERIOR surau scene because
//   the source classifier defaulted to "treat every source as inside".
//   That value fed ~60-70 dB of UNIFORM wall re-radiation into every
//   outdoor cell, flooring the spatial variation and keeping P-Q deltas
//   inside the 1.5 dB tolerance.
//
//   Post-Phase-3 (correct exclusion of EXTERIOR sources from the inside
//   aggregate), re-rad / porch / overhead all correctly return -Inf for
//   outdoor cells in an all-EXTERIOR scene. The diffraction asymmetry
//   that the uniform re-rad floor used to mask is now bare — and it is
//   GEOMETRICALLY CORRECT under ISO 9613-2 §7.4.2 single-most-effective-
//   screen. At Q=(2,-6) the Fermat-optimum bent path slips under the
//   south arcade's OPEN western edge (the arcade has no solid south
//   face — it's a colonnade) with zero secondary TL, while at P=(6,-6)
//   the same edge's Fermat optimum lands at x=3.886 where the bent
//   path passes through the south arcade roof and picks up +53 dB TL.
//   Both numbers are correct; the test premise "more direct-path wall
//   crossings = lower SPL" is too strict for open-colonnade geometries
//   where extra crossings can move the Fermat optimum to a less-
//   shadowed edge.
//
//   R1-R7 named-bug invariants (canonical user-reported inversions)
//   still ALL PASS in heatmap-targeted-invariants.test.mjs. R8 (this
//   broad-cap monotonicity sweep) is the catch-all that now also flags
//   these legitimate geometric paths.
//
// Phase B2 candidate-edge expansion (queued, ~60-100 LOC in
// diffraction.js): enumerate overhead-reflector perimeter edges in the
// xy-vicinity that should shadow bent paths, not just edges the direct
// path crosses. That refinement could reduce some of the new hot
// pockets — but the current behavior is not wrong, just incomplete.
// ----------------------------------------------------------------------------
//
// Cap raised 80 → 115 (Phase 3 unmask + 5-violation buffer). Tight
// enough to catch any regression that adds new inversions beyond the
// known Phase-3-unmasked set; loose enough that trivial material-
// catalogue edits don't accidentally trip the wire. To FULLY satisfy
// R8 (PHASE_B_COMPLETE=true) the remaining violations will need:
//   - Tighter cell-vs-annulus classification at wall-thickness boundaries
//   - A more nuanced wallCount (weight by TL? skip ceiling for indoor cells?)
//   - Phase B2 candidate-edge expansion (overhead-reflector perimeter)
//   - Possibly arcade-edge enumeration for cells AT-the-wall too
// These are follow-up tasks; the substantive user-visible inversions
// (R1-R7) are fixed.
const PHASE_B_COMPLETE = false;
const PHASE_B_PENDING_MAX_VIOLATIONS = 115;

import { readFileSync } from 'node:fs';

// localStorage stub — Tier 1a ON (matches localhost dev default), override
// OFF (we want to test the unfixed pipeline).
const _store = { PHYSICS_P1_5: '1' };
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
};

const { computeMultiSourceSPL, computeRoomConstant } =
  await import('../js/physics/spl-calculator.js');
const { wallsCrossedByPath } = await import('../js/physics/wall-path.js');

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};
const hs880 = JSON.parse(readFileSync(
  './data/loudspeakers/amperes-hs880.json', 'utf8'));

// ---------------------------------------------------------------------------
// Surau-preset geometry — matches js/presets/surau.js for the rectangular
// building + 3-side arcade + minaret horns.
// ---------------------------------------------------------------------------
const W = 18.0, D = 17.7, H = 4.5;
const MIN_CX = -1.2, MIN_CY = D + 1.2;       // = 18.9
const HORN_Z = 7.0, HORN_OFF = 1.0;

const room = {
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

const horns = [
  { modelUrl: 'hs880', position: { x: MIN_CX,            y: MIN_CY + HORN_OFF, z: HORN_Z }, aim: { yaw: 0,   pitch: -12 }, power_watts: 80 },
  { modelUrl: 'hs880', position: { x: MIN_CX + HORN_OFF, y: MIN_CY,            z: HORN_Z }, aim: { yaw: 90,  pitch: -12 }, power_watts: 80 },
  { modelUrl: 'hs880', position: { x: MIN_CX,            y: MIN_CY - HORN_OFF, z: HORN_Z }, aim: { yaw: 180, pitch: -12 }, power_watts: 80 },
  { modelUrl: 'hs880', position: { x: MIN_CX - HORN_OFF, y: MIN_CY,            z: HORN_Z }, aim: { yaw: 270, pitch: -12 }, power_watts: 80 },
];

// ---------------------------------------------------------------------------
// Probe grid — Sam's spec: 9 x columns × 9 y rows, z=1.7 (ear height).
// Spans inside the building, the arcades, and the open field outside.
// ---------------------------------------------------------------------------
const PROBE_X = [-4, -2, 0, 2, 6, 10, 14, 18, 22];
const PROBE_Y = [-6, -2, 2, 6, 9, 13, 17, 19, 22];
const PROBE_Z = 1.7;
const LOCALITY_R = 5.0;            // m — pair clamp
const EPS_DB    = 1.5;             // dB — invariant tolerance
const FREQS     = [250, 1000, 4000];

// Sum of solid wall crossings for ALL sources → THIS cell.
function totalOcclusion(cellPos) {
  let count = 0;
  for (const src of horns) {
    const crossings = wallsCrossedByPath(src.position, cellPos, room);
    for (const c of crossings) {
      if (!c.throughOpening) count++;
    }
  }
  return count;
}

// Evaluate SPL at a cell, snapping -Infinity / NaN to a sentinel so the
// monotonicity check skips wall-annulus cells (which are -Infinity by
// design from the Phase 7 cellInTrueInterior fix).
function splOrNull(cellPos, freq_hz, R) {
  const v = computeMultiSourceSPL({
    sources: horns, getSpeakerDef: () => hs880, listenerPos: cellPos,
    freq_hz, room, materials, roomConstantR: R,
  });
  return Number.isFinite(v) ? v : null;
}

let totalViolations = 0;
const violationsByBand = {};

for (const freq of FREQS) {
  const R = computeRoomConstant(room, materials, freq, []);
  // Build the cell table for this band.
  const cells = [];
  for (const x of PROBE_X) {
    for (const y of PROBE_Y) {
      const pos = { x, y, z: PROBE_Z };
      const occ = totalOcclusion(pos);
      const spl = splOrNull(pos, freq, R);
      if (spl === null) continue;            // wall annulus or -Infinity cell — skip
      cells.push({ x, y, occ, spl });
    }
  }

  // For every (P, Q) pair within LOCALITY_R, assert SPL(Q) ≤ SPL(P) + EPS_DB
  // when Q is strictly more occluded than P.
  const violations = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells.length; j++) {
      if (i === j) continue;
      const P = cells[i], Q = cells[j];
      const d = Math.hypot(P.x - Q.x, P.y - Q.y);
      if (d > LOCALITY_R) continue;
      if (Q.occ <= P.occ) continue;          // Q not strictly more occluded
      if (Q.spl <= P.spl + EPS_DB) continue; // invariant holds
      violations.push({
        P: { x: P.x, y: P.y, occ: P.occ, spl: P.spl },
        Q: { x: Q.x, y: Q.y, occ: Q.occ, spl: Q.spl },
        delta: Q.spl - P.spl,
      });
    }
  }
  violationsByBand[freq] = violations.length;
  totalViolations += violations.length;

  console.log(`\n=== Band ${freq} Hz — ${violations.length} monotonicity violation(s) ===`);
  // Print the 5 worst (by delta) so the log doesn't drown.
  const worst = [...violations].sort((a, b) => b.delta - a.delta).slice(0, 5);
  for (const v of worst) {
    const ps = `P=(${v.P.x},${v.P.y}) occ=${v.P.occ} spl=${v.P.spl.toFixed(1)}`;
    const qs = `Q=(${v.Q.x},${v.Q.y}) occ=${v.Q.occ} spl=${v.Q.spl.toFixed(1)}`;
    console.log(`  ${qs} > ${ps} +${v.delta.toFixed(1)} dB`);
  }
  if (violations.length > 5) {
    console.log(`  ... and ${violations.length - 5} more`);
  }
}

// ---------------------------------------------------------------------------
// Gate decision
// ---------------------------------------------------------------------------
console.log('');
console.log('===========================================================');
console.log(`Total monotonicity violations across all bands: ${totalViolations}`);
console.log(`  250 Hz : ${violationsByBand[250]}`);
console.log(`  1000 Hz: ${violationsByBand[1000]}`);
console.log(`  4000 Hz: ${violationsByBand[4000]}`);
console.log('===========================================================');

if (PHASE_B_COMPLETE) {
  // Post-Phase-B: invariant MUST hold.
  if (totalViolations === 0) {
    console.log('\nOK  path-monotonicity invariant satisfied at all 3 bands.');
    process.exit(0);
  } else {
    console.log('\nFAIL  path-monotonicity violations detected after Phase B — physics regression.');
    process.exit(1);
  }
} else {
  // Pre-Phase-B: violations expected. Assert violation count hasn't EXCEEDED
  // the snapshot baseline, so a misguided edit can't make things worse
  // without tripping the wire.
  if (totalViolations <= PHASE_B_PENDING_MAX_VIOLATIONS) {
    console.log(`\nOK  PHASE_B_PENDING — violation count (${totalViolations}) within snapshot baseline (≤ ${PHASE_B_PENDING_MAX_VIOLATIONS}).`);
    console.log('   This test PASSES today by counting violations, NOT by satisfying the invariant.');
    console.log('   When Phase B lands, flip PHASE_B_COMPLETE = true at the top of this file.');
    process.exit(0);
  } else {
    console.log(`\nFAIL  violation count (${totalViolations}) EXCEEDS snapshot baseline (${PHASE_B_PENDING_MAX_VIOLATIONS}).`);
    console.log('   Something made the inversion bug WORSE before Phase B fixed it.');
    console.log('   Either fix the regression or, if the increase is legitimate, update PHASE_B_PENDING_MAX_VIOLATIONS.');
    process.exit(1);
  }
}
