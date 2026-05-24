// js/physics/wall-composite.js
//
// Composite-wall transmission loss via area-weighted transmission-
// coefficient sum. Pure module — no DOM, no Three.js, Node-testable.
// Phase 5 Step 5 (Dr. Chen spec 2026-05-23).
//
// Why this module exists: real walls are rarely a single material — a
// concrete partition has a door, a glazing wall has a frame, an
// auditorium wall has acoustic vents. The composite TL is dominated by
// the weakest leak: a 60 dB concrete wall with a 25 dB door over just
// 1% of its area transmits as if it were a ~45 dB wall, not 60.
//
// Formula (ISO 12354-3:2017 Eq. 17; Bies & Hansen 4th ed. Eq. 8.27):
//
//                       Σᵢ τᵢ(f) · Sᵢ
//   R_composite(f) = -10·log10  ────────────────
//                       Σᵢ Sᵢ
//
// where τᵢ(f) = 10^(-Rᵢ(f)/10) is the transmission coefficient of
// element i at band f, and Sᵢ is the element's area in m².
//
// Per-band — runs once per band against an array of {tl_bands, area_m2}
// elements. All elements MUST carry the same band count; the function
// is otherwise frequency-agnostic and works against any band list
// (octave, 1/3-oct, etc) so long as the caller's tl_bands all align.

// Compute the per-band composite TL for a list of wall elements.
//
//   elements: Array<{ tl_bands: number[], area_m2: number }>
//             Each element's `tl_bands` is its per-band TL (in dB) at the
//             SAME band frequencies as every other element. `area_m2`
//             is the element's share of the total wall area.
//
// Returns:
//   number[]    — per-band R_composite in dB, length === bands.length
//   null        — on any malformed input (empty, mismatched lengths,
//                 non-finite values, non-positive areas). Defensive
//                 because catalogue data may carry partial rows during
//                 Lin's seeding pass.
export function compositeTL({ elements }) {
  if (!Array.isArray(elements) || elements.length === 0) return null;

  let totalArea = 0;
  let bandCount = null;
  for (const e of elements) {
    if (!e || !Array.isArray(e.tl_bands)) return null;
    if (!(e.area_m2 > 0) || !Number.isFinite(e.area_m2)) return null;
    if (bandCount === null) bandCount = e.tl_bands.length;
    else if (e.tl_bands.length !== bandCount) return null;
    if (bandCount === 0) return null;
    for (const v of e.tl_bands) {
      if (!Number.isFinite(v)) return null;
    }
    totalArea += e.area_m2;
  }
  if (!(totalArea > 0)) return null;

  const out = new Array(bandCount);
  for (let b = 0; b < bandCount; b++) {
    let sum_tau_S = 0;
    for (const e of elements) {
      // τᵢ = 10^(-Rᵢ/10). For real TL values in the [-50, +100] dB range
      // this stays well clear of float over/underflow.
      sum_tau_S += Math.pow(10, -e.tl_bands[b] / 10) * e.area_m2;
    }
    const tau_avg = sum_tau_S / totalArea;
    // Tau is always positive given finite TL inputs; defensive guard
    // for a future caller that passes Infinity.
    out[b] = tau_avg > 0 ? -10 * Math.log10(tau_avg) : 0;
  }
  return out;
}
