// js/physics/wall-tl.js
//
// Field-incidence mass-law transmission loss (TL). Pure module — no DOM, no
// Three.js, no materials.json import (caller passes the numbers in). Node-
// testable. Powers the WallLAB thickness slider: vary surface density, see
// the per-octave isolation a limp panel gives.
//
// This is a PARTITION-ISOLATION model. It is unrelated to Maekawa edge
// diffraction / barrier insertion loss (`maekawaIL` in diffraction.js,
// ISO 9613-2 §7.4) — that's a separate over-the-wall concern. Do NOT blend
// them; WallLAB shows them in separate panels.
//
// Formula (Dr. Chen, 2026-05-22):
//
//   TL_field(m, f) = 20·log10(m · f) − 47        [dB], clamped to [5, 60]
//
//   m = surface (areal) density, kg/m²;  f = frequency, Hz.
//
// The constant is the FIELD-incidence (random/diffuse) value, −47 dB — the
// right partner for ISO 10140 / ISO 717 lab TL data (which is what the
// catalogue's measured `transmission_loss_db` rows are). The common
// textbook trap is the NORMAL-incidence constant −42 dB (~5 dB optimistic);
// the ~5 dB offset is the Beranek-Sharp diffuse-field grazing-angle
// correction. Use −47.
//   Refs: Beranek & Vér, Noise and Vibration Control Engineering 2nd ed.
//   §10.3 (eq. 10.10–10.13); Sharp 1973.
//
// Equivalent identity (worth remembering): 20·log10(m·f) rises +6.02 dB per
// DOUBLING of either m or f. That +6 dB/octave (and +6 dB per mass-doubling)
// IS the entire physical content of the mass law.
//
// Validity: holds in the MASS-controlled region — above the panel
// fundamental, below the critical/coincidence frequency f_c. At/above f_c the
// real (measured) curve dips 5–15 dB below this line (the panel flexes in
// sympathy with the sound) then recovers at ~+9 dB/oct. Heavy stiff masonry
// pushes f_c above 8 kHz, so concrete tracks the line; thin glass/gypsum do
// not. WallLAB plots computed AND measured together and labels the dip — the
// divergence is the teaching point, not a bug. Computing f_c needs elastic
// moduli the catalogue lacks (backlog P3); WallLAB annotates dip bands from a
// per-material lookup instead.

// Clamp bounds (match the catalogue `_notes` convention). Below 5 dB the
// limp-panel assumption is meaningless (leak/flanking territory); above
// ~60 dB lab floors (flanking, niche transmission) make it non-physical.
export const TL_FLOOR_DB = 5;
export const TL_CEIL_DB = 60;
// Field-incidence mass-law constant. NOT 42 (that's normal-incidence).
export const MASS_LAW_CONST_DB = 47;

function clampTL(tl) {
  if (!Number.isFinite(tl)) return TL_FLOOR_DB;
  return Math.max(TL_FLOOR_DB, Math.min(TL_CEIL_DB, tl));
}

// Single-band field mass-law TL. m in kg/m², f in Hz. Returns dB clamped to
// [TL_FLOOR_DB, TL_CEIL_DB]. Non-positive m·f → floor (open-air, zero mass).
export function massLawTL(m_kg_m2, f_hz) {
  const mf = m_kg_m2 * f_hz;
  if (!(mf > 0)) return TL_FLOOR_DB;
  return clampTL(20 * Math.log10(mf) - MASS_LAW_CONST_DB);
}

// Per-band TL across an octave-band centre list (e.g. [125,250,…,8000]).
export function massLawTLBands(m_kg_m2, bands_hz) {
  if (!Array.isArray(bands_hz)) return [];
  return bands_hz.map(f => massLawTL(m_kg_m2, f));
}

// Surface (areal) density of a single-leaf panel: thickness × bulk density.
export function surfaceDensity(thickness_m, density_kg_m3) {
  return thickness_m * density_kg_m3;
}

// Recover bulk density (kg/m³) from a catalogued surface density measured at a
// known reference thickness. Lets the slider scale m honestly off the
// catalogue's measured `surface_density_kg_m2` rather than a hardcoded
// density. Guards a non-positive reference thickness.
export function densityFromCatalogue(surface_density_kg_m2, reference_thickness_m) {
  if (!(reference_thickness_m > 0)) return 0;
  return surface_density_kg_m2 / reference_thickness_m;
}

// Convenience for the WallLAB slider: given the catalogue surface density at a
// reference thickness, the new TL bands at an arbitrary slider thickness.
// m_new = (surface_density / ref_thickness) × thickness.
export function massLawTLBandsAtThickness(surface_density_kg_m2, reference_thickness_m, thickness_m, bands_hz) {
  const density = densityFromCatalogue(surface_density_kg_m2, reference_thickness_m);
  const m = surfaceDensity(thickness_m, density);
  return massLawTLBands(m, bands_hz);
}
