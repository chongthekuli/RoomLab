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
  function diffusionFromOneOctave(entry) {
    if (entry.category !== 'diffuser') return null;
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
    if (entry.category === 'finish') return null;     // raw materials are fine without mounting
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
];
