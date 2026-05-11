// SurfaceLAB import-time auditor — Dr. Chen's "fake it" risk list as
// code. Catches the seven most common manufacturer-datasheet lies so
// SurfaceLAB can chip the spec card with a caution glyph.
//
// Each rule returns null (no flag) or an object { id, severity, message }.
// `severity` is 'warn' (display amber chip) or 'high' (display red chip).
//
// We do NOT mutate the entry. The caller folds the returned flags into
// a `trust_flags` array on the catalogue record.

const C = 343;   // m/s — speed of sound at 20 °C, used for QRD physical bounds

export function runTrustFlagAudit(entry) {
  const flags = [];
  for (const rule of RULES) {
    try {
      const f = rule(entry);
      if (f) flags.push(f);
    } catch (e) {
      // Don't let a malformed entry break the catalogue load.
      console.warn(`[trust-flags] rule ${rule.name} threw on ${entry.id}:`, e);
    }
  }
  return flags;
}

const RULES = [
  // 1. α > 0.95 below 250 Hz on a thin (<100 mm) panel claiming Type A
  //    mounting. Physically suspect — usually means the test was
  //    actually done with a 400 mm air gap (E-400/E-405) and the
  //    datasheet quietly relabelled the mounting.
  function highAlphaSuspectMounting(entry) {
    if (!entry.absorption || !entry.geometry) return null;
    const a125 = entry.absorption[0];
    const depth = entry.geometry.depth_mm ?? entry.geometry.thickness_mm ?? 999;
    const mounting = entry.mounting || '';
    if (a125 > 0.95 && depth < 100 && /TypeA|^reference$/i.test(mounting)) {
      return {
        id: 'high_alpha_thin_panel',
        severity: 'warn',
        message: `α(125 Hz) = ${a125.toFixed(2)} on a ${depth} mm panel rated Type A is physically suspect — likely tested with an air gap. Check mounting before trusting LF claims.`,
      };
    }
    return null;
  },

  // 2. α > 1.0 anywhere — ASTM C423 edge-diffraction artefact. We
  //    don't reject the value but flag it so the user sees the
  //    "exceeded unity" caveat.
  function alphaExceedsUnity(entry) {
    if (!entry.absorption) return null;
    const peak = Math.max(...entry.absorption.filter(v => Number.isFinite(v)));
    if (peak > 1.05) {
      return {
        id: 'alpha_exceeds_unity',
        severity: 'warn',
        message: `Reported α exceeds 1.0 (peak ${peak.toFixed(2)}). ASTM C423 edge-diffraction artefact — common at 250–500 Hz for small samples. Treat values >1.0 as edge-effect-inflated.`,
      };
    }
    return null;
  },

  // 3. QRD claims f₀ below the physical longest-well limit.
  //    f_lower = c / (2 · max_well_depth) — anything below this is
  //    geometrically impossible.
  function qrdImpossibleLowerLimit(entry) {
    if (entry.kind !== 'diffuser_qrd_1d' && entry.kind !== 'diffuser_skyline') return null;
    const dMax = entry.geometry?.max_well_depth_mm;
    const claimed = entry.operating_range_hz?.[0];
    if (!dMax || !Number.isFinite(claimed)) return null;
    const physical = C / (2 * dMax * 1e-3);
    if (claimed < physical * 0.7) {        // > ½ octave below the physical limit
      return {
        id: 'qrd_below_physical_limit',
        severity: 'high',
        message: `Claimed f_lower = ${claimed} Hz, but max well depth ${dMax} mm gives a physical floor of ${physical.toFixed(0)} Hz. Datasheet exaggerates LF performance by >½ octave.`,
      };
    }
    return null;
  },

  // 4. NRC reported on a tuned membrane / Helmholtz trap. NRC averages
  //    250–2 kHz, which is exactly where these traps DON'T work.
  //    Reporting NRC for one is meaningless and usually a red flag.
  function nrcOnTunedTrap(entry) {
    if (entry.kind !== 'trap_membrane' && entry.kind !== 'trap_helmholtz') return null;
    if (entry.nrc != null) {
      return {
        id: 'nrc_on_tuned_trap',
        severity: 'warn',
        message: `NRC is reported but this is a tuned trap (${entry.trap?.type}). NRC averages 250–2k Hz, missing the trap's actual operating band around f₀ = ${entry.trap?.f0_hz} Hz. Use the f₀ + bandwidth instead.`,
      };
    }
    return null;
  },

  // 5. "Diffusion" claimed but only one-octave d(f) data. Real
  //    broadband-diffusion claims need ≥ 4 octaves of test data.
  //    Schema v2: dotted-path categories — match any diffuser.*
  function diffusionFromOneOctave(entry) {
    const cat = entry.category;
    if (typeof cat !== 'string' || !cat.startsWith('diffuser')) return null;
    const d = entry.diffusion_d || [];
    const finite = d.filter(v => Number.isFinite(v)).length;
    if (finite > 0 && finite < 3) {
      return {
        id: 'diffusion_data_thin',
        severity: 'warn',
        message: `Diffusion coefficient d(f) reported at only ${finite} octave band${finite === 1 ? '' : 's'}. ISO 17497-2 requires multi-band testing for credible broadband claims.`,
      };
    }
    return null;
  },

  // 6. Mounting designation missing or unclear on a panel-style entry.
  //    Without it the α curve is ambiguous (Type A vs E-400 changes
  //    LF α by 3×).
  function mountingMissing(entry) {
    const cat = entry.category;
    // Plain surface finishes don't need mounting designation — they
    // are the substrate, not an applied treatment.
    if (typeof cat === 'string' && cat.startsWith('surface')) return null;
    if (!entry.mounting || entry.mounting === 'null' || entry.mounting === '') {
      return {
        id: 'mounting_unclear',
        severity: 'warn',
        message: `Mounting designation not stated. ASTM C423 / ISO 354 results vary 3× with mounting depth. Treat α curve as approximate.`,
      };
    }
    return null;
  },

  // 7. Test standard absent or self-reported. Flag self-reported tests
  //    as a soft warning so the reviewer knows.
  function selfReportedOrUntested(entry) {
    const std = (entry.test_standard || '').toLowerCase();
    if (!std || std === 'reference') {
      return {
        id: 'untested_legacy',
        severity: 'warn',
        message: `No formal test standard cited. Values are textbook references — use as starting points, not specifications.`,
      };
    }
    if (/manufacturer|self.?report|internal/.test(std)) {
      return {
        id: 'self_reported',
        severity: 'warn',
        message: `Specs are manufacturer self-reported, not third-party tested. Verify in-situ before final design.`,
      };
    }
    return null;
  },

  // 8. Mandatory fields per category per Dr. Chen §3. Catches catalogue
  //    entries that don't carry the per-mechanism fields needed to be
  //    physically defensible (e.g. a bass.membrane without f0_hz, or a
  //    diffuser.qrd_1d without prime_N + max_well_depth_mm).
  //
  //    Returns one flag listing every missing field — one row in the
  //    spec card rather than seven separate chips for the same entry.
  function mandatoryFieldsMissing(entry) {
    const cat = entry.category;
    if (typeof cat !== 'string') return null;
    const requirements = MANDATORY_FIELDS[cat] || MANDATORY_FIELDS_BY_SEGMENT[cat.split('.')[0]] || null;
    if (!requirements) return null;
    const missing = [];
    for (const path of requirements) {
      if (!hasNonNullPath(entry, path)) missing.push(path);
    }
    if (missing.length === 0) return null;
    return {
      id: 'mandatory_fields_missing',
      severity: 'high',
      message: `Category ${cat} requires ${requirements.join(', ')}. Missing: ${missing.join(', ')}.`,
    };
  },

  // 9. Diffuser without scattering coefficient data. A diffuser entry
  //    that cannot show s(f) per ISO 17497-1 is asking the reviewer to
  //    trust a manufacturer's marketing copy — flag as high severity
  //    because diffusion is the entire product claim.
  function diffuserWithoutScattering(entry) {
    const cat = entry.category;
    if (typeof cat !== 'string' || !cat.startsWith('diffuser.')) return null;
    const s = entry.scattering_coefficient;
    const validCount = Array.isArray(s) ? s.filter(v => Number.isFinite(v)).length : 0;
    if (validCount < 3) {
      return {
        id: 'diffuser_no_scattering',
        severity: 'high',
        message: `Diffuser claim unverified — scattering_coefficient[] has ${validCount} octave value${validCount === 1 ? '' : 's'} (ISO 17497-1 requires multi-band testing for a credible diffusion claim).`,
      };
    }
    return null;
  },
];

// Mandatory fields per category. Dotted-path keys allow nested lookups
// like `bass.f0_hz` (entry.bass.f0_hz). Most exact matches; fall back
// to MANDATORY_FIELDS_BY_SEGMENT for the first segment if no exact key.
const MANDATORY_FIELDS = {
  'surface.hard': ['geometry.width_mm', 'mounting'],
  'surface.soft': ['geometry.width_mm', 'mounting'],
  'surface.wood': ['geometry.width_mm', 'mounting'],

  'absorber.porous.panel':   ['porous.panel_thickness_mm', 'porous.density_kgm3', 'mounting'],
  'absorber.porous.foam':    ['porous.panel_thickness_mm', 'porous.cell_structure', 'mounting'],
  'absorber.porous.curtain': ['porous.areal_density_kg_m2', 'porous.distance_from_wall_mm'],
  'absorber.microperf':      ['porous.hole_diameter_mm', 'porous.perforation_ratio_pct', 'porous.panel_thickness_mm', 'porous.cavity_depth_mm'],

  'bass.porous':       ['porous.panel_thickness_mm', 'porous.corner_mounted', 'bass.bandwidth_alpha05_hz'],
  'bass.membrane':     ['bass.f0_hz', 'bass.bandwidth_alpha05_hz', 'bass.membrane_mass_kg_m2', 'bass.cavity_depth_mm'],
  'bass.helmholtz':    ['bass.f0_hz', 'bass.neck_area_mm2', 'bass.neck_length_mm', 'bass.cavity_volume_L'],
  'bass.tuned_array':  ['bass.f0_hz', 'bass.bandwidth_alpha05_hz'],

  'diffuser.qrd_1d':     ['diffuser.prime_N', 'diffuser.period_width_mm', 'diffuser.max_well_depth_mm', 'diffuser.fmin_hz', 'diffuser.fmax_hz'],
  'diffuser.qrd_2d':     ['diffuser.prime_N', 'diffuser.period_width_mm', 'diffuser.max_well_depth_mm', 'diffuser.fmin_hz', 'diffuser.fmax_hz'],
  'diffuser.geometric':  ['diffuser.period_mm', 'diffuser.depth_mm', 'diffuser.fmin_hz', 'diffuser.fmax_hz', 'diffuser.sequence_type'],
  'diffuser.parametric': ['diffuser.period_mm', 'diffuser.depth_mm', 'diffuser.fmin_hz', 'diffuser.fmax_hz', 'diffuser.sequence_type'],
  'diffuser.hybrid':     ['diffuser.fmin_hz', 'diffuser.fmax_hz', 'diffuser.crossover_hz'],

  'opening.door':   ['opening.Rw_dB', 'opening.leaf_mass_kg_m2', 'opening.seal'],
  'opening.window': ['opening.Rw_dB', 'opening.glazing_mm'],
  'opening.vent':   ['opening.Rw_dB', 'opening.aperture_mm2'],

  'system.partition': ['system.Rw_dB', 'system.construction_layers'],
  'system.modular':   ['system.module_dimensions_mm'],
  'system.active':    ['system.processor_model'],
};

// Per first-segment fallback so adding a new sub-kind doesn't need a
// schema edit on day one — at least the segment-level required fields
// still get enforced.
const MANDATORY_FIELDS_BY_SEGMENT = {
  // Already covered exhaustively by MANDATORY_FIELDS above; keep this
  // map so future additions (e.g. new diffuser sub-kinds) inherit a
  // sensible baseline.
};

// Resolve a dotted path against an object. Returns the leaf value, or
// undefined if any intermediate is missing. Treats empty strings and
// `null` as missing; preserves `false` and `0` (legitimate values).
function hasNonNullPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return false;
    cur = cur[p];
  }
  if (cur == null) return false;
  if (cur === '') return false;
  if (Array.isArray(cur) && cur.length === 0) return false;
  return true;
}
