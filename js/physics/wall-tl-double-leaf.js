// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Chong Ching Yong (chongthekuli). All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// js/physics/wall-tl-double-leaf.js
//
// Sharp 1973 three-region double-leaf cavity wall transmission loss.
// Pure module — no DOM, no Three.js. Node-testable. Phase 5 Step 4
// (Dr. Chen spec + sign-off 2026-05-23).
//
// Why this module exists: single-leaf mass law (wall-tl.js) is the wrong
// physics for every modern partition. A 2 × 13 mm gypsum-on-studs wall
// is a mass-spring-mass system whose isolation behaviour bears no
// resemblance to a 20 kg/m² single panel. Real predictions need Sharp's
// piecewise model with cavity-coupling, fill, and stud-bridging terms.
//
// ---------------------------------------------------------------------------
// Algorithm (Sharp 1973, reproduced Bies & Hansen 4th ed. §8.4)
// ---------------------------------------------------------------------------
//
// Two mass-spring-mass critical frequencies bracket three regions:
//
//   f_mam = 60·√((m1+m2)/(m1·m2·d))         — mass-air-mass resonance
//   f_d   = c/(2π·d)                          — cavity acoustic cutoff
//
// The constant 60 absorbs ρ₀=1.21 kg/m³, c=343 m/s, factor 1/(2π·√(ρ₀c²)),
// for normal-incidence air-filled cavities (Bies & Hansen Eq. 8.40).
//
// Region I (f < f_mam) — the two leaves move IN PHASE; the wall behaves
//   as a single panel with combined mass:
//     TL_I = 20·log10((m1+m2)·f) − 47
//
// Region II (f_mam < f < f_d) — Sharp plateau, +18 dB/oct rise:
//     TL_II = TL_M1 + TL_M2 + 20·log10(f·d) − 29
//   where TL_M1, TL_M2 are the individual-leaf mass-law values.
//   (Bies & Hansen Eq. 8.41a)
//
// Region III (f > f_d) — cavity acoustically large; leaves act
//   independently with a 6-dB incoherent-sum term:
//     TL_III = TL_M1 + TL_M2 + 6                  (Eq. 8.41b)
//
// Per Dr. Chen sign-off 2026-05-23: above f_mam, use `min(II, III)` to
// handle the f_d crossover cleanly; below f_mam, use I directly. The
// piecewise selection is by frequency band (NOT a global min across all
// three formulas, which would silently prefer the lowest at any f).
//
// ---------------------------------------------------------------------------
// Cavity-fill correction (applied to Region II/III only)
// ---------------------------------------------------------------------------
//
//   none:          0 dB
//   fibrous_50mm: +5 dB        (Bies & Hansen Eq. 8.43, simplified)
//   reflective:   -3 dB        (highly reflective cavity penalty)
//
// Dr. Chen REFUSED a partial-fill interpolation (`fibrous_lt_50`) on
// 2026-05-23: "+5 dB is a STEP function in Eq. 8.43. If a user has
// 25 mm fill they pick `none` and read the result as conservative.
// Honest beats interpolated."
//
// ---------------------------------------------------------------------------
// Stud-bridging cap
// ---------------------------------------------------------------------------
//
// Real walls are limited by mechanical short-circuit through the stud
// (a "flanking" path that bypasses the cavity). Sharp 1973 captures this
// empirically as a CEILING on the predicted TL.
//
//   ceiling(f) = (f ≥ transition_hz)
//                  ? TL_mass_law(m1+m2, f) + above_db
//                  : TL_mass_law(m1+m2, f)
//
//   wood stud, screwed both sides: transition 250 Hz, above_db = +5
//                                  (Sharp 1973 Fig. 6; Bies & Hansen §8.4.4)
//   steel stud (resilient flange): transition 250 Hz, above_db = +8
//                                  (Bies & Hansen Eq. 8.42 commentary;
//                                  conservative midpoint of 7-10 range)
//   staggered stud / double stud:  no cap — bridging mechanically removed
//   resilient channel (rc1):       NULL — empirical only, no closed-form;
//                                  WallLAB must use catalogue Rw instead
//
// The 250 Hz transition is a STEP, not a ramp. Per Dr. Chen 2026-05-23:
// "The bridging mechanism is mechanical short-circuit through the stud —
// it engages above the stud-leaf coupled resonance, which sits in the
// 200–250 Hz region for typical drywall on wood. A ramp implies
// continuous physics; the underlying phenomenon is a flanking-path
// turn-on. Step at 250 Hz; real transition smears over 200-315 Hz by
// ±2 dB. If anyone complains, that's the catalogue's job."

import { massLawTL, TL_FLOOR_DB, TL_CEIL_DB } from './wall-tl.js';

// Empirical constants — Object.freeze prevents accidental mutation.
// Sum-hash tests guard against transcription drift in the regression suite.

// Constant in f_mam = 60·√(...) for normal-incidence air cavities.
// Absorbs ρ₀ = 1.21, c = 343, factor 1/(2π·√(ρ₀c²)). Bies & Hansen Eq. 8.40.
export const F_MAM_CONST = 60;

// Phase 6 (Dr. Chen sign-off 2026-05-23): mass-air-mass dip parameters.
// Empirical depression in TL around f_mam where the two leaves move
// out of phase on the cavity's air spring. Without modelling this, the
// Step 4 formula transitions abruptly Region I → Region II at f_mam
// and over-predicts the air-cavity wood-stud row by +8 dB Rw.
//
//   Shape:    parabolic in log-frequency
//   Trough:   at f_mam exactly
//   Envelope: -1/3 octave to +w_high octave (asymmetric)
//   Depth:    -12 dB (single value, no cavity_fill dependence in v1 per
//             Dr. Chen — fill effect on dip depth is real but confounded
//             with fill effect on Region II plateau; locking fill-dep
//             here risks double-counting. Documented as ±3 dB tolerance
//             vs measured; refine when ≥ 12 fill-resolved partitions in
//             fixtures.)
//
// Asymmetric w_high — stud-bridged walls (wood, steel) have a wider
// upper sideband than mechanically-decoupled (staggered, double) walls
// because the stud bridging adds a damping skirt above f_mam.
// Hongisto 2006 Acta Acust. Fig. 6.
//   Studded   (wood / steel):    w_high = 1.0 oct
//   Decoupled (staggered/double): w_high = 2/3 oct
//
// Citations: Fahy & Gardonio 2nd ed. §4.7.3 Fig. 4.20 + Sharp 1973
// + Vinokur 1996 + Hongisto 2006 Acta Acust. Table III + Davy 2010
// JASA 127(2). Dr. Chen 2026-05-23.
export const M_A_M_DIP_DEPTH_DB = 12;
export const M_A_M_DIP_W_LOW_OCT = 1 / 3;
export const M_A_M_DIP_W_HIGH_OCT_STUDDED = 1.0;
export const M_A_M_DIP_W_HIGH_OCT_DECOUPLED = 2 / 3;

// Speed of sound at 20 °C — matches SPEED_OF_SOUND in wall-sim.js, the
// 343 m/s `c` baked into F_MAM_CONST, and the demo defaults across the
// project. NOT temperature-parametric; if temperature/humidity become a
// slider, switch to `speedOfSound(T)` from diffraction.js.
export const SPEED_OF_SOUND = 343;

// Cavity-fill bonus applied to Region II/III. Step function per Dr. Chen
// 2026-05-23 — no partial-fill interpolation.
export const CAVITY_FILL_BONUS_DB = Object.freeze({
  none: 0,
  fibrous_50mm: 5,
  reflective: -3,
});

// Stud-bridging ceiling table. wood / steel get the +5 / +8 above-band
// cap; staggered / double are uncapped; rc1 is the catalogue-only escape
// hatch the caller must check before invoking the formula.
export const STUD_TYPES = Object.freeze([
  'wood', 'steel', 'staggered', 'double', 'rc1',
]);

// Phase 6 Step 2 (v=628, Dr. Chen 2026-05-23): an attempt to add empirical
// caps for staggered (transition 315 / above_db 12) and double (250 / 18)
// — same pattern as wood/steel — was reverted after the verification Dr.
// Chen explicitly requested ("If staggered at 1 kHz comes out > 60 or
// < 56, the cap numbers are wrong"). 1 kHz fit inside [56, 60] but the
// contour-fit Rw went WRONG WAY — staggered 60 → 48 (target 56, Δ=−8)
// and double 60 → 50 (target 63, Δ=−13). The catalogue gap analysis
// revealed why:
//
// Delta = measured − mass_law(m_total):
//
//                     125Hz  500Hz  1kHz  2kHz  4kHz  8kHz
//   wood 1× air        -3.4  -3.4  -5.4 -14.5 -13.5 -15.5    Rw 33
//   wood 1× mf50       +0.6  +4.6  +3.6  -4.5  -4.5  -7.5    Rw 39
//   staggered mf90     +5.6  +13.6 +14.5 +6.5  +6.5  +3.5    Rw 56
//   double-stud mf140  +10.6 +20.6 +21.5 +13.5 +13.5 +9.5    Rw 63
//
// The over-mass-law bonus on decoupled walls is a MID-FREQUENCY BUMP
// peaking 500-1k Hz, NOT a monotonic step. A wood/steel-pattern cap
// (with mass_law(m_total) below transition + constant above) can't fit
// a bump — it under-predicts at LF (where the bonus is still +5 to +10)
// AND over-shoots in the peak region.
//
// Honest verdict: a bump-shape cap needs ≥ 4 measured rows per stud_type
// to validate the shape, not the 1 row per type currently in the
// catalogue. Single-row-fit caps are curve-trace, not physics.
//
// Decision: STAGGERED and DOUBLE stay UNCAPPED. Sharp natural rises
// past TL_CEIL = 60 at HF; the [5, 60] clamp at the end of
// doubleLeafTLBand bounds the prediction. Current Rw residuals are
// staggered Δ=+4 (60 vs measured 56) and double Δ=-3 (60 vs measured
// 63) — uncomfortable but documented. The cross-check fixture tolerance
// is ±4 dB on these two rows for that reason.
//
// Phase 7+ backlog: triangular bump cap (peak_db, peak_hz, LF_shoulder,
// HF_shoulder) validated against ≥ 4 staggered + ≥ 4 double-stud measured
// rows from the NRC IR-761 archive. When data lands, refit and ship.
const STUD_BRIDGE_TABLE = Object.freeze({
  wood:      Object.freeze({ transition_hz: 250, above_db: 5 }),
  steel:     Object.freeze({ transition_hz: 250, above_db: 8 }),
  staggered: null,        // bridging removed; cap shape unknown without more data
  double:    null,        // same
  rc1:       'CATALOGUE_ONLY',     // sentinel — caller must short-circuit
});

// =============================================================================
// Pure helpers
// =============================================================================

// f_mam = 60·√((m1+m2)/(m1·m2·d))    Bies & Hansen Eq. 8.40.
// Returns null on non-physical input (zero/negative leaf mass or cavity).
export function massAirMassFreq(leaf1_mass_kg_m2, leaf2_mass_kg_m2, cavity_depth_m) {
  if (!(leaf1_mass_kg_m2 > 0) || !(leaf2_mass_kg_m2 > 0) || !(cavity_depth_m > 0)) return null;
  const ratio = (leaf1_mass_kg_m2 + leaf2_mass_kg_m2) / (leaf1_mass_kg_m2 * leaf2_mass_kg_m2 * cavity_depth_m);
  return F_MAM_CONST * Math.sqrt(ratio);
}

// f_d = c/(2π·d)  cavity acoustic cutoff above which the cavity is
// acoustically "large" and the leaves decouple to incoherent transmission.
export function cavityCutoffFreq(cavity_depth_m) {
  if (!(cavity_depth_m > 0)) return null;
  return SPEED_OF_SOUND / (2 * Math.PI * cavity_depth_m);
}

// Predicate: is this stud type one the formula can compute? (rc1 returns
// null per Dr. Chen — UI must fall back to catalogue Rw.)
export function isFormulaStudType(stud_type) {
  if (!STUD_TYPES.includes(stud_type)) return false;
  return STUD_BRIDGE_TABLE[stud_type] !== 'CATALOGUE_ONLY';
}

// Mass-air-mass dip depression in dB at a given frequency. Parabolic
// well in log-frequency centred on f_mam with asymmetric envelope
// (1/3-oct below, 1 or 2/3-oct above depending on stud bridging).
// Returns 0 outside the envelope and 0 for invalid inputs.
//   depression(f) = depth · (1 − ((log2(f / f_mam)) / w_side)²)
// with w_side = w_low when f < f_mam, w_high otherwise. Clamped ≥ 0.
export function massAirMassDip(f_hz, f_mam, stud_type) {
  if (!(f_mam > 0) || !(f_hz > 0)) return 0;
  const sigma_oct = Math.log2(f_hz / f_mam);
  if (sigma_oct < -M_A_M_DIP_W_LOW_OCT) return 0;
  const w_high = (stud_type === 'wood' || stud_type === 'steel')
    ? M_A_M_DIP_W_HIGH_OCT_STUDDED
    : M_A_M_DIP_W_HIGH_OCT_DECOUPLED;
  if (sigma_oct > w_high) return 0;
  const w_side = sigma_oct < 0 ? M_A_M_DIP_W_LOW_OCT : w_high;
  const normalised = sigma_oct / w_side;
  const depression = M_A_M_DIP_DEPTH_DB * (1 - normalised * normalised);
  return Math.max(0, depression);
}

// =============================================================================
// Sharp three-region TL — per-band
// =============================================================================

// Single-band double-leaf TL. Returns null if:
//   • stud_type === 'rc1' (catalogue-only escape — caller must handle)
//   • stud_type unknown
//   • any of m1, m2, d, f is non-positive
//
// Result is clamped to [TL_FLOOR_DB, TL_CEIL_DB] = [5, 60] to match
// wall-tl.js's single-leaf range (Sharp's upper-band predictions can run
// to 80+ dB; real partitions never reach > Rw ≈ 65 due to flanking, so
// the ceiling is honest).
export function doubleLeafTLBand(spec, f_hz) {
  const { leaf1_mass_kg_m2, leaf2_mass_kg_m2, cavity_depth_m, cavity_fill, stud_type } = spec;
  if (!isFormulaStudType(stud_type)) return null;
  if (!(leaf1_mass_kg_m2 > 0) || !(leaf2_mass_kg_m2 > 0) || !(cavity_depth_m > 0)) return null;
  if (!(f_hz > 0)) return null;

  const f_mam = massAirMassFreq(leaf1_mass_kg_m2, leaf2_mass_kg_m2, cavity_depth_m);
  const m_total = leaf1_mass_kg_m2 + leaf2_mass_kg_m2;

  let TL;
  if (f_hz < f_mam) {
    // Region I — two leaves move in phase, mass-law of total mass.
    TL = massLawTL(m_total, f_hz);
  } else {
    // Above f_mam: take min(Region II, Region III) so the f_d crossover
    // is smooth. Sharp's Region II rises +18 dB/oct; Region III is the
    // +6 dB asymptote.
    const TL_M1 = massLawTL(leaf1_mass_kg_m2, f_hz);
    const TL_M2 = massLawTL(leaf2_mass_kg_m2, f_hz);
    const TL_II = TL_M1 + TL_M2 + 20 * Math.log10(f_hz * cavity_depth_m) - 29;
    const TL_III = TL_M1 + TL_M2 + 6;
    const TL_sharp = Math.min(TL_II, TL_III);
    // Cavity-fill correction applies in Region II/III only — Region I
    // is mass-law and has no cavity term.
    const bonus = CAVITY_FILL_BONUS_DB[cavity_fill] ?? 0;
    TL = TL_sharp + bonus;
  }

  // Stud-bridging cap — wood/steel only. Hard step at 250 Hz.
  const bridge = STUD_BRIDGE_TABLE[stud_type];
  if (bridge && bridge !== 'CATALOGUE_ONLY') {
    const baseCeiling = massLawTL(m_total, f_hz);
    const ceiling = f_hz >= bridge.transition_hz
      ? baseCeiling + bridge.above_db
      : baseCeiling;
    TL = Math.min(TL, ceiling);
  }

  // Phase 6 (Dr. Chen Gotcha #2): subtract the mass-air-mass dip around
  // f_mam. The dip rides on the user-visible TL curve (whatever the
  // natural-plus-cap value is at this band); 0 outside the envelope so
  // bands far from f_mam are unaffected.
  TL -= massAirMassDip(f_hz, f_mam, stud_type);

  return Math.max(TL_FLOOR_DB, Math.min(TL_CEIL_DB, TL));
}

// =============================================================================
// Per-band vector
// =============================================================================

// Compute TL across a band-frequency list. Returns null if the spec is
// catalogue-only (rc1) or otherwise invalid; the caller MUST check for
// null before consuming the result.
export function doubleLeafTL(spec, bands_hz) {
  if (!Array.isArray(bands_hz)) return null;
  if (!isFormulaStudType(spec.stud_type)) return null;
  const out = new Array(bands_hz.length);
  for (let i = 0; i < bands_hz.length; i++) {
    const v = doubleLeafTLBand(spec, bands_hz[i]);
    if (v === null) return null;
    out[i] = v;
  }
  return out;
}

// Test-only export so the regression test can exercise the stud-bridge
// table directly (sum-hash + key presence checks).
export const _testing = { STUD_BRIDGE_TABLE };
