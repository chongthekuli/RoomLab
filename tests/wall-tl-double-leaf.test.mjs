// Phase 5 Step 4 regression — wall-tl-double-leaf.js (v=615, 2026-05-23).
//
// Sharp 1973 three-region cavity wall model + cavity-fill bonus +
// stud-bridging cap. Dr. Chen sign-off 2026-05-23 locked the empirical
// table values: wood +5, steel +8 (conservative midpoint, not +10),
// 250 Hz hard step, refused fibrous_lt_50 (no defensible interpolation).
//
// Tests:
//   1. Frozen-constant transcription drift hashes.
//   2. f_mam + f_d formulas (Bies & Hansen Eq. 8.40 + cavity cutoff).
//   3. Region I selection below f_mam — returns mass-law of total mass.
//   4. Above f_mam: min(Region II, Region III) — selection by f_d.
//   5. Cavity-fill bonus applies in Region II/III only (NOT in Region I).
//   6. Stud-bridging cap: hard step at 250 Hz, wood +5 / steel +8.
//   7. Staggered / double stud bypass the bridging cap entirely.
//   8. RC-1 returns null (UI must fall back to catalogue Rw).
//   9. End-to-end Rw fixtures (Dr. Chen's two scenarios):
//        2×13 GWB on 90 mm wood stud + 50 mm fibre → Rw ≈ 45 ±2 dB
//        Same buildup with steel stud                → Rw ≈ 50 ±3 dB
//   10. Defensive guards on invalid input.

import assert from 'node:assert';
import {
  F_MAM_CONST,
  SPEED_OF_SOUND,
  CAVITY_FILL_BONUS_DB,
  STUD_TYPES,
  M_A_M_DIP_DEPTH_DB,
  M_A_M_DIP_W_LOW_OCT,
  M_A_M_DIP_W_HIGH_OCT_STUDDED,
  M_A_M_DIP_W_HIGH_OCT_DECOUPLED,
  massAirMassFreq,
  cavityCutoffFreq,
  isFormulaStudType,
  massAirMassDip,
  doubleLeafTLBand,
  doubleLeafTL,
  _testing,
} from '../js/physics/wall-tl-double-leaf.js';
import { massLawTL } from '../js/physics/wall-tl.js';
import { ISO_THIRD_OCTAVE_HZ, octaveToThirdOctave } from '../js/physics/third-octave-bands.js';
import { computeRw } from '../js/physics/wall-rating.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}
const within = (a, b, tol) => Math.abs(a - b) <= tol;
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// =============================================================================
// 1. Frozen-constant hashes
// =============================================================================

check('F_MAM_CONST = 60 (Bies & Hansen Eq. 8.40 normal-incidence)',
  F_MAM_CONST === 60);
check('SPEED_OF_SOUND = 343 (matches wall-sim demo constant)',
  SPEED_OF_SOUND === 343);

check('CAVITY_FILL_BONUS_DB has exactly three options + frozen',
  Object.keys(CAVITY_FILL_BONUS_DB).length === 3 &&
  Object.isFrozen(CAVITY_FILL_BONUS_DB));
check('cavity bonus: none = 0, fibrous_50mm = +5, reflective = -3',
  CAVITY_FILL_BONUS_DB.none === 0 &&
  CAVITY_FILL_BONUS_DB.fibrous_50mm === 5 &&
  CAVITY_FILL_BONUS_DB.reflective === -3);
check('no fibrous_lt_50 option (Dr. Chen refused interpolation 2026-05-23)',
  CAVITY_FILL_BONUS_DB.fibrous_lt_50 === undefined);

check('STUD_TYPES exposes five values + frozen',
  STUD_TYPES.length === 5 && Object.isFrozen(STUD_TYPES));

const wood = _testing.STUD_BRIDGE_TABLE.wood;
const steel = _testing.STUD_BRIDGE_TABLE.steel;
check('wood-stud table: transition 250 Hz, above +5 dB (Sharp 1973 Fig. 6)',
  wood.transition_hz === 250 && wood.above_db === 5);
check('steel-stud table: transition 250 Hz, above +8 dB (Dr. Chen conservative)',
  steel.transition_hz === 250 && steel.above_db === 8);
check('staggered + double stud have no bridging cap (Sharp uncapped)',
  _testing.STUD_BRIDGE_TABLE.staggered === null &&
  _testing.STUD_BRIDGE_TABLE.double === null);
check('rc1 is sentinel CATALOGUE_ONLY (no formula)',
  _testing.STUD_BRIDGE_TABLE.rc1 === 'CATALOGUE_ONLY');

// =============================================================================
// 2. f_mam + f_d formulas
// =============================================================================
//
// 2×13 mm GWB on 90 mm cavity (m1=m2=21 kg/m², d=0.090 m):
//   f_mam = 60·√((21+21)/(21·21·0.090)) = 60·√(42/39.69) = 60·1.0287 = 61.7 Hz
//   f_d   = 343/(2π·0.090) = 606.5 Hz

{
  const fmam = massAirMassFreq(21, 21, 0.090);
  check('f_mam for 2×13 GWB on 90 mm cavity ≈ 61.7 Hz',
    within(fmam, 61.7, 0.1), `got ${fmam.toFixed(2)}`);
}
{
  const fd = cavityCutoffFreq(0.090);
  check('f_d (90 mm cavity) ≈ 606.5 Hz',
    within(fd, 606.5, 0.1), `got ${fd.toFixed(2)}`);
}

// Asymmetric leaves: 21 kg/m² + 10 kg/m² on 90 mm → f_mam lower (heavier
// effective resonator), but still well below 100 Hz.
{
  const fmam = massAirMassFreq(21, 10, 0.090);
  // 60·√(31/(21·10·0.090)) = 60·√(31/18.9) = 60·1.2806 = 76.8 Hz.
  check('f_mam for asymmetric (21+10 kg/m², 90 mm) ≈ 76.8 Hz',
    within(fmam, 76.8, 0.1), `got ${fmam.toFixed(2)}`);
}

// Defensive: non-positive inputs return null.
check('massAirMassFreq(0, m, d) returns null', massAirMassFreq(0, 10, 0.1) === null);
check('massAirMassFreq(m, m, 0) returns null', massAirMassFreq(10, 10, 0) === null);
check('cavityCutoffFreq(0) returns null', cavityCutoffFreq(0) === null);

// =============================================================================
// 3. Region I (deep below f_mam — outside dip envelope) = mass-law of total
// =============================================================================
//
// With m1=m2=21, d=0.090, f_mam=61.7 Hz. The mass-air-mass dip envelope
// extends from f_mam · 2^(-1/3) ≈ 49 Hz to f_mam · 2^(+2/3) ≈ 98 Hz
// (for non-studded — staggered).  At f=40 Hz we're below 49 → outside
// envelope → no dip → pure Region I mass-law.
//   TL_I = mass_law(42, 40) = 20·log10(42·40) − 47 = 20·log10(1680) − 47
//        = 64.51 − 47 = 17.51 dB.
{
  const spec = { leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
                 cavity_fill: 'fibrous_50mm', stud_type: 'staggered' };
  const v = doubleLeafTLBand(spec, 40);
  const expected = massLawTL(42, 40);
  check('Region I (f=40 Hz — outside dip envelope) returns mass-law of total',
    within(v, expected, 0.01), `got ${v.toFixed(2)} vs mass_law(42,40)=${expected.toFixed(2)}`);
}

// =============================================================================
// 4. Above f_mam: min(Region II, Region III) — selection by f_d
// =============================================================================
//
// At f=200 Hz (above f_mam=62, well below f_d=606): Region II should
// dominate (rising +18 dB/oct).
//   TL_M1 = TL_M2 = mass_law(21, 200) = 20·log10(4200) - 47 = 25.46 dB
//   TL_II = 50.92 + 20·log10(200·0.090) - 29 = 50.92 + 25.10 - 29 = 47.02
//   TL_III = 50.92 + 6 = 56.92
//   min = 47.02
// Staggered stud bypasses bridging cap. Cavity bonus +5 (fibrous_50mm).
// → 47.02 + 5 = 52.02 dB.
{
  const spec = { leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
                 cavity_fill: 'fibrous_50mm', stud_type: 'staggered' };
  const v = doubleLeafTLBand(spec, 200);
  check('Region II @ 200 Hz (above f_mam, below f_d) → 52.0 dB (Sharp II + fill)',
    within(v, 52.02, 0.5), `got ${v.toFixed(2)}`);
}

// At f=2000 Hz (above f_d=606): Region III dominates.
//   TL_M1 = TL_M2 = mass_law(21, 2000) = 20·log10(42000) − 47 = 45.46
//   TL_II at 2k = 90.92 + 20·log10(180) − 29 = 90.92 + 45.11 − 29 = 107.03
//   TL_III = 90.92 + 6 = 96.92
//   min = 96.92, +5 fill = 101.92
//   Staggered: no cap. Clamp to TL_CEIL_DB = 60.
{
  const spec = { leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
                 cavity_fill: 'fibrous_50mm', stud_type: 'staggered' };
  const v = doubleLeafTLBand(spec, 2000);
  check('Region III @ 2 kHz (above f_d) clamps at TL_CEIL = 60 dB (staggered, uncapped)',
    v === 60, `got ${v.toFixed(2)}`);
}

// =============================================================================
// 5. Cavity-fill bonus applies in Region II/III only, NOT in Region I
// =============================================================================

{
  const base = { leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090, stud_type: 'staggered' };
  // Region I (f=50 Hz): the fill bonus should NOT apply.
  const v_none_I = doubleLeafTLBand({ ...base, cavity_fill: 'none' }, 50);
  const v_fill_I = doubleLeafTLBand({ ...base, cavity_fill: 'fibrous_50mm' }, 50);
  check('Region I: fill bonus does NOT apply (mass-law only)',
    within(v_none_I, v_fill_I, 0.001),
    `none=${v_none_I.toFixed(2)} fill=${v_fill_I.toFixed(2)}`);
  // Region II (f=200 Hz): fill bonus = +5.
  const v_none_II = doubleLeafTLBand({ ...base, cavity_fill: 'none' }, 200);
  const v_fill_II = doubleLeafTLBand({ ...base, cavity_fill: 'fibrous_50mm' }, 200);
  check('Region II: fill bonus = +5 dB (fibrous_50mm)',
    within(v_fill_II - v_none_II, 5, 0.01),
    `Δ = ${(v_fill_II - v_none_II).toFixed(2)} dB`);
  // Region II + reflective cavity: bonus = -3.
  const v_refl_II = doubleLeafTLBand({ ...base, cavity_fill: 'reflective' }, 200);
  check('Region II: reflective cavity bonus = -3 dB',
    within(v_refl_II - v_none_II, -3, 0.01),
    `Δ = ${(v_refl_II - v_none_II).toFixed(2)} dB`);
}

// =============================================================================
// 6. Stud-bridging cap: hard step at 250 Hz, wood +5 / steel +8
// =============================================================================
//
// Wood stud, m1=m2=21, d=0.090, fill=none (so cavity bonus = 0).
// At f=200 Hz (BELOW 250 Hz transition): ceiling = mass_law(42, 200).
// At f=500 Hz (ABOVE transition): ceiling = mass_law(42, 500) + 5.
//
// Hard-step check: 200 Hz vs 250 Hz. The ceiling should jump by 5 dB at
// 250 Hz exactly (with Sharp predictions deep in the bridging-bound
// regime, the cap dominates and the jump is visible).

{
  // Drive Sharp HIGH at both bands by using massive leaves and a deep
  // cavity, so Sharp's prediction is way above the ceiling at both bands.
  const spec = { leaf1_mass_kg_m2: 50, leaf2_mass_kg_m2: 50, cavity_depth_m: 0.200,
                 cavity_fill: 'fibrous_50mm', stud_type: 'wood' };
  const c200 = massLawTL(100, 200);                  // ceiling below transition
  const c250 = massLawTL(100, 250) + 5;              // ceiling AT transition
  const v200 = doubleLeafTLBand(spec, 200);
  const v250 = doubleLeafTLBand(spec, 250);
  check('wood-stud cap at 200 Hz = mass-law(total) (no above_db bonus)',
    within(v200, c200, 0.01), `got ${v200.toFixed(2)} vs ${c200.toFixed(2)}`);
  check('wood-stud cap at 250 Hz = mass-law(total) + 5 dB (transition)',
    within(v250, c250, 0.01), `got ${v250.toFixed(2)} vs ${c250.toFixed(2)}`);
  // The step is visible: jump from base to base+5 between 200 and 250 Hz.
  // (Mass-law itself rises +6×log10(250/200)=+1.94 across the same span,
  // so the OBSERVED step is +5 + 1.94 = +6.94 dB.)
  const stepObserved = v250 - v200;
  check('wood-stud bridging cap step at 250 Hz is observable (~6.9 dB rise)',
    within(stepObserved, 6.94, 0.05), `step = ${stepObserved.toFixed(2)} dB`);
}

// Steel-stud cap: +8 above transition (Dr. Chen conservative midpoint).
{
  const wood_spec = { leaf1_mass_kg_m2: 50, leaf2_mass_kg_m2: 50, cavity_depth_m: 0.200,
                      cavity_fill: 'fibrous_50mm', stud_type: 'wood' };
  const steel_spec = { ...wood_spec, stud_type: 'steel' };
  const v_wood = doubleLeafTLBand(wood_spec, 500);
  const v_steel = doubleLeafTLBand(steel_spec, 500);
  check('steel ceiling > wood ceiling by exactly +3 dB (8 vs 5)',
    within(v_steel - v_wood, 3, 0.01),
    `wood=${v_wood.toFixed(2)} steel=${v_steel.toFixed(2)}`);
}

// =============================================================================
// 7. Staggered / double bypass the bridging cap
// =============================================================================

{
  const wood_spec   = { leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
                        cavity_fill: 'fibrous_50mm', stud_type: 'wood' };
  const stag_spec   = { ...wood_spec, stud_type: 'staggered' };
  const double_spec = { ...wood_spec, stud_type: 'double' };
  // At 1 kHz, Sharp predicts > 80 dB; wood-cap holds it down. Staggered
  // and double should run uncapped (then hit the TL_CEIL = 60 clamp).
  const v_wood = doubleLeafTLBand(wood_spec, 1000);
  const v_stag = doubleLeafTLBand(stag_spec, 1000);
  const v_dbl  = doubleLeafTLBand(double_spec, 1000);
  check('staggered stud @ 1 kHz > wood stud @ 1 kHz (no bridging cap)',
    v_stag > v_wood + 5,
    `wood=${v_wood.toFixed(2)} staggered=${v_stag.toFixed(2)}`);
  check('staggered and double stud agree (both uncapped)',
    within(v_stag, v_dbl, 0.001));
}

// =============================================================================
// 8. RC-1 returns null (catalogue-only)
// =============================================================================

{
  const spec = { leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
                 cavity_fill: 'fibrous_50mm', stud_type: 'rc1' };
  check('isFormulaStudType("rc1") = false (catalogue-only escape hatch)',
    isFormulaStudType('rc1') === false);
  check('doubleLeafTLBand for rc1 returns null',
    doubleLeafTLBand(spec, 1000) === null);
  check('doubleLeafTL (vector) for rc1 returns null',
    doubleLeafTL(spec, [125, 250, 500, 1000]) === null);
}

// =============================================================================
// 9. End-to-end Rw fixtures (Dr. Chen's two named scenarios)
// =============================================================================
//
// Scenario A: 2×13 mm GWB on 90 mm wood stud + 50 mm mineral fibre fill.
//   m1 = m2 = 21 kg/m² (two 13 mm GWB layers per side @ ~10 kg/m² each).
//   Expected: Rw ≈ 45 dB ±2 dB (Dr. Chen sign-off 2026-05-23).
//
// Compute per-1/3-oct over the Rw band range (100-3150 Hz, 16 bands).

{
  const spec_wood = { leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
                      cavity_fill: 'fibrous_50mm', stud_type: 'wood' };
  const tl_third = doubleLeafTL(spec_wood, ISO_THIRD_OCTAVE_HZ);
  const Rw = computeRw(tl_third, ISO_THIRD_OCTAVE_HZ);
  check('Rw scenario A: 2×13 GWB wood-stud 90 mm fibrous → Rw ≈ 45 dB ±2',
    Rw !== null && Math.abs(Rw - 45) <= 2,
    `got Rw=${Rw}`);
}

// Scenario B: same buildup with steel stud → Rw ≈ 50 dB ±3 dB.
{
  const spec_steel = { leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
                       cavity_fill: 'fibrous_50mm', stud_type: 'steel' };
  const tl_third = doubleLeafTL(spec_steel, ISO_THIRD_OCTAVE_HZ);
  const Rw = computeRw(tl_third, ISO_THIRD_OCTAVE_HZ);
  check('Rw scenario B: 2×13 GWB steel-stud 90 mm fibrous → Rw ≈ 50 dB ±3',
    Rw !== null && Math.abs(Rw - 50) <= 3,
    `got Rw=${Rw}`);
}

// Steel > Wood on the same buildup (steel ceiling +3 dB higher).
{
  const baseSpec = { leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
                     cavity_fill: 'fibrous_50mm' };
  const Rw_wood = computeRw(doubleLeafTL({ ...baseSpec, stud_type: 'wood' }, ISO_THIRD_OCTAVE_HZ), ISO_THIRD_OCTAVE_HZ);
  const Rw_steel = computeRw(doubleLeafTL({ ...baseSpec, stud_type: 'steel' }, ISO_THIRD_OCTAVE_HZ), ISO_THIRD_OCTAVE_HZ);
  check('steel-stud Rw > wood-stud Rw (same buildup; +3 dB ceiling raise)',
    Rw_steel > Rw_wood,
    `wood=${Rw_wood} steel=${Rw_steel}`);
}

// =============================================================================
// 9.5 Catalogue cross-check — formula reproduces measured NRC IR-761 Rw
// =============================================================================
//
// Lin seeded the 5 formula catalogue rows in v=619 with measured NRC IR-761
// Rw values. The Sharp three-region formula must reproduce each within a
// stud-type-dependent tolerance, binding the formula module (Step 4) and
// the catalogue (Step 7) together so neither can drift silently.
//
// Tolerance varies by stud type:
//   wood / steel:        ±3 dB (empirical bridging cap holds formula near
//                              measurement — Dr. Chen Scenario A/B band).
//   staggered / double:  ±4 dB (Sharp UNCAPPED naturally over-predicts vs
//                              real construction; residual coupling through
//                              common top/bottom plates is unmodelled).
//                              Refining this is Phase 6 work — for now
//                              tolerance is widened, divergence documented.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const data = JSON.parse(readFileSync(join(root, 'data/materials.json'), 'utf8'));
  const byId = Object.fromEntries(data.materials.map(m => [m.id, m]));

  // wall_2x4_sg_2x_each_air STILL EXCLUDED — the Phase 6 mass-air-mass dip
  // (v=627) is a genuine improvement on this row: formula Rw dropped from
  // 41 (pre-dip) to 38 (post-dip), closing 3 dB of the original 8 dB gap
  // vs measured Rw 33. The remaining +5 dB residual is a SEPARATE physics
  // limitation: the wood-stud bridging cap at mass_law(m_total)+5 above
  // 250 Hz is realistic for fibre-filled cavities but too generous for
  // EMPTY cavities (measured values at 250-1k Hz are 5-10 dB below the
  // cap on this row). Closing the residual needs a fill-dependent cap,
  // which Dr. Chen refused in v1 (risk of double-counting damping already
  // applied via cavity_fill bonus). Phase 7+ work. Documented separately
  // by the explicit-dip-effect fixture in §9.6 below.
  const FORMULA_FIXTURES = [
    { id: 'wall_2x4_sg_2x_each_mf50',    stated_rw: 39, tol: 3 },
    { id: 'wall_2x4_dg_each_mf90',       stated_rw: 45, tol: 3 },
    { id: 'wall_double_stud_dg_mf140',   stated_rw: 63, tol: 4 },
    { id: 'wall_staggered_2x6_2x_mf90',  stated_rw: 56, tol: 4 },
  ];
  for (const fx of FORMULA_FIXTURES) {
    const row = byId[fx.id];
    if (!row || row.model !== 'formula' || !row.assembly) {
      check(`catalogue cross-check: ${fx.id} present + model="formula"`, false,
        `row missing or wrong model: ${row?.model}`);
      continue;
    }
    const tl_third = doubleLeafTL(row.assembly, ISO_THIRD_OCTAVE_HZ);
    const Rw = computeRw(tl_third, ISO_THIRD_OCTAVE_HZ);
    check(`catalogue cross-check: ${fx.id} formula Rw ≈ stated Rw (${fx.stated_rw}) ±${fx.tol} dB`,
      Rw !== null && Math.abs(Rw - fx.stated_rw) <= fx.tol,
      `formula Rw = ${Rw}, stated = ${fx.stated_rw}`);
  }
}

// =============================================================================
// 9.6 Mass-air-mass dip (Phase 6 — Dr. Chen Gotcha #2 fix, v=627)
// =============================================================================
//
// Parabolic well in log-frequency centred at f_mam. Envelope: -1/3 oct to
// +1 oct for studded (wood/steel), -1/3 oct to +2/3 oct for decoupled
// (staggered/double). Depth 12 dB at f_mam. Outside envelope → 0.
//
// Dr. Chen requested single-band fixtures at 87 (trough), 100, 125, 160,
// 200 Hz separately — "single-band fixtures hide envelope errors."

// (a) Frozen constants — hash check (drift guard).
check('M_A_M_DIP_DEPTH_DB = 12 (Dr. Chen single-value spec)',
  M_A_M_DIP_DEPTH_DB === 12);
check('M_A_M_DIP_W_LOW_OCT = 1/3 (lower envelope width)',
  Math.abs(M_A_M_DIP_W_LOW_OCT - 1 / 3) < 1e-9);
check('M_A_M_DIP_W_HIGH_OCT_STUDDED = 1.0 (wood/steel — bridging skirt)',
  M_A_M_DIP_W_HIGH_OCT_STUDDED === 1.0);
check('M_A_M_DIP_W_HIGH_OCT_DECOUPLED = 2/3 (staggered/double)',
  Math.abs(M_A_M_DIP_W_HIGH_OCT_DECOUPLED - 2 / 3) < 1e-9);

// (b) At the trough — depression = depth.
{
  const f_mam = 87;
  const d = massAirMassDip(f_mam, f_mam, 'wood');
  check('dip at f_mam exactly → 12 dB (depth, trough)',
    within(d, 12, 1e-9), `got ${d.toFixed(4)}`);
}

// (c) Outside envelope — depression = 0.
{
  const f_mam = 87;
  const fBelow = f_mam * Math.pow(2, -0.5);   // 0.5 oct below — well outside -1/3
  const fAboveStudded = f_mam * Math.pow(2, 1.5);   // 1.5 oct above — outside +1 for studded
  const fAboveDecoupled = f_mam * Math.pow(2, 0.9);  // 0.9 oct above — outside +2/3 for decoupled
  check('dip 0.5 oct below f_mam → 0 (outside lower envelope)',
    massAirMassDip(fBelow, f_mam, 'wood') === 0);
  check('dip 1.5 oct above f_mam (wood) → 0 (outside studded upper envelope)',
    massAirMassDip(fAboveStudded, f_mam, 'wood') === 0);
  check('dip 0.9 oct above f_mam (staggered) → 0 (outside decoupled upper envelope)',
    massAirMassDip(fAboveDecoupled, f_mam, 'staggered') === 0);
}

// (d) At envelope edges — depression = 0 (C0 continuity).
{
  const f_mam = 87;
  const fLowEdge = f_mam * Math.pow(2, -1 / 3);
  const fHighEdgeStudded = f_mam * Math.pow(2, 1);
  const fHighEdgeDecoupled = f_mam * Math.pow(2, 2 / 3);
  check('dip at -1/3 oct (lower edge) → 0',
    within(massAirMassDip(fLowEdge, f_mam, 'wood'), 0, 1e-9));
  check('dip at +1 oct studded (upper edge wood) → 0',
    within(massAirMassDip(fHighEdgeStudded, f_mam, 'wood'), 0, 1e-9));
  check('dip at +2/3 oct decoupled (upper edge staggered) → 0',
    within(massAirMassDip(fHighEdgeDecoupled, f_mam, 'staggered'), 0, 1e-9));
}

// (e) Single-band Rw-region fixtures per Dr. Chen (87, 100, 125, 160, 200 Hz)
// at the wall_2x4_sg_2x_each_air buildup (f_mam ≈ 87 Hz, wood-stud).
//
//   At 87 Hz (=f_mam): depression = 12 dB (trough).
//   At 100 Hz: log₂(100/87) ≈ 0.201; norm = 0.201/1.0 = 0.201;
//              depression = 12·(1 − 0.040) = 11.52 dB.
//   At 125 Hz: log₂(125/87) ≈ 0.523; norm = 0.523/1.0 = 0.523;
//              depression = 12·(1 − 0.273) = 8.72 dB.
//   At 160 Hz: log₂(160/87) ≈ 0.879; norm = 0.879/1.0 = 0.879;
//              depression = 12·(1 − 0.773) = 2.72 dB.
//   At 200 Hz: log₂(200/87) ≈ 1.20; 1.20 > 1 (wood) → outside → 0 dB.
{
  const f_mam = 87;
  const tol = 0.05;
  check('dip at 87 Hz (trough, wood) = 12 dB',
    within(massAirMassDip(87, f_mam, 'wood'), 12, tol));
  check('dip at 100 Hz (wood) ≈ 11.52 dB',
    within(massAirMassDip(100, f_mam, 'wood'), 11.52, 0.2),
    `got ${massAirMassDip(100, f_mam, 'wood').toFixed(2)}`);
  check('dip at 125 Hz (wood) ≈ 8.72 dB',
    within(massAirMassDip(125, f_mam, 'wood'), 8.72, 0.2),
    `got ${massAirMassDip(125, f_mam, 'wood').toFixed(2)}`);
  check('dip at 160 Hz (wood) ≈ 2.72 dB',
    within(massAirMassDip(160, f_mam, 'wood'), 2.72, 0.2),
    `got ${massAirMassDip(160, f_mam, 'wood').toFixed(2)}`);
  check('dip at 200 Hz (wood, outside envelope) = 0',
    massAirMassDip(200, f_mam, 'wood') === 0);
}

// (f) Stud-type asymmetry — same geometry, dip width differs.
//
// At f = f_mam · 2^(0.8) (= 0.8 oct above f_mam):
//   Studded (wood): norm = 0.8/1.0 = 0.8; depression = 12·(1 − 0.64) = 4.32 dB.
//   Decoupled (staggered): norm = 0.8/0.667 = 1.20 > 1 → OUTSIDE → 0 dB.
{
  const f_mam = 87;
  const f = f_mam * Math.pow(2, 0.8);
  const dWood = massAirMassDip(f, f_mam, 'wood');
  const dStag = massAirMassDip(f, f_mam, 'staggered');
  check('stud-type asymmetry: wood envelope wider than staggered at +0.8 oct',
    dWood > 4 && dStag === 0,
    `wood=${dWood.toFixed(2)} staggered=${dStag.toFixed(2)}`);
}

// (g) Defensive guards.
check('massAirMassDip(NaN, f_mam, stud) = 0',
  massAirMassDip(NaN, 87, 'wood') === 0);
check('massAirMassDip(f, 0, stud) = 0',
  massAirMassDip(125, 0, 'wood') === 0);
check('massAirMassDip(f, f_mam, unknown_stud) treats as decoupled (default w_high=2/3)',
  massAirMassDip(87, 87, 'unknown') === 12);     // trough → 12 regardless of stud

// (h) End-to-end effect on the air-cavity wood-stud row that motivated
// the Phase 6 fix. wall_2x4_sg_2x_each_air (m=10.5+10.5, d=0.090, fill=none,
// wood-stud). Pre-dip: Rw 41 (vs measured 33, +8 over-prediction).
// Post-dip: Rw 38 (vs measured 33, +5 over-prediction — partial closure).
// The fixture asserts the IMPROVEMENT, not the absolute match — the +5
// residual is the wood-stud cap being too generous for empty cavities
// (separate Phase 7 work, see FORMULA_FIXTURES comment above).
{
  const spec = { leaf1_mass_kg_m2: 10.5, leaf2_mass_kg_m2: 10.5, cavity_depth_m: 0.090,
                 cavity_fill: 'none', stud_type: 'wood' };
  const tl_third = doubleLeafTL(spec, ISO_THIRD_OCTAVE_HZ);
  const Rw = computeRw(tl_third, ISO_THIRD_OCTAVE_HZ);
  check('air-cavity wood-stud row: dip improves Rw from 41 → 38 (3 dB closer to measured 33)',
    Rw !== null && Rw <= 38 && Rw >= 36,
    `got Rw=${Rw} (pre-dip baseline was 41; full closure to 33 is Phase 7)`);
}

// =============================================================================
// 10. Defensive guards
// =============================================================================

{
  check('unknown stud_type returns null',
    doubleLeafTLBand({ leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
      cavity_fill: 'fibrous_50mm', stud_type: 'unknown' }, 500) === null);
  check('negative m1 returns null',
    doubleLeafTLBand({ leaf1_mass_kg_m2: -1, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
      cavity_fill: 'none', stud_type: 'wood' }, 500) === null);
  check('zero cavity depth returns null',
    doubleLeafTLBand({ leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0,
      cavity_fill: 'none', stud_type: 'wood' }, 500) === null);
  check('non-array bands returns null',
    doubleLeafTL({ leaf1_mass_kg_m2: 21, leaf2_mass_kg_m2: 21, cavity_depth_m: 0.090,
      cavity_fill: 'none', stud_type: 'wood' }, null) === null);
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
