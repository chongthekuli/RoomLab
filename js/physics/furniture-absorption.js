// Furniture absorption helper — pure, Node-testable, no DOM.
//
// Each FurnitureLAB-placed object (state.furniture entry) carries a
// catalogueId pointing at a row in data/furniture/catalogue.json. The
// row exposes A_obj per octave-band (equivalent absorption area, m²
// Sabine) measured per ISO 354 or derived from such a measurement.
//
// Dr. Chen's integration rules (acoustics-engineer brief, 2026-05-26):
//   - Sabine: sum ΣA_obj into the total absorption (parallel term).
//   - Eyring: A_obj enters the denominator OUTSIDE the log
//     (Kuttruff 5th ed. §5.3, Beranek 2nd ed. §7.3). Lumping into
//     ᾱ_surfaces underestimates RT60 by ~8% in chair-heavy rooms.
//   - Bands with no measured A_obj contribute zero — never extrapolate
//     flat. Most published furniture data stops at 4 kHz; pretending
//     8 kHz behaves like 4 kHz over-predicts reverberant brightness.
//
// `catalogue` is a Map<catalogueId, row> built once at startup by the
// browser-side loader (js/labs/furniturelab/catalog.js) and passed in
// here. Pure-physics modules never `fetch()`.

/**
 * Sum equivalent absorption area across all placed furniture at one
 * octave band. Returns 0 when the array is empty, the catalogue is
 * missing, or no entry references a row with a value at the band.
 *
 * @param {Array}  furniture       state.furniture array
 * @param {Map}    catalogue       Map<id, row> indexed by catalogueId
 * @param {number} frequency_hz    octave-band centre (125, 250, ... 8000)
 * @returns {number} Σ A_obj at this band, in m² Sabine
 */
export function sumFurnitureAbsorption(furniture, catalogue, frequency_hz) {
  if (!Array.isArray(furniture) || furniture.length === 0) return 0;
  if (!catalogue) return 0;
  const key = String(Math.round(frequency_hz));
  let total = 0;
  for (const f of furniture) {
    if (!f || typeof f.catalogueId !== 'string') continue;
    const row = catalogue.get(f.catalogueId);
    if (!row || !row.acoustics) continue;
    const band = row.acoustics.A_obj_m2_sab_per_band;
    if (!band || typeof band !== 'object') continue;
    const v = band[key];
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

/**
 * Build a per-band absorption array for the full octave-band ladder.
 * Returns one number per frequency in `frequency_bands_hz`. Useful for
 * callers that need to fold furniture into both the rt60 result and the
 * reverberant-field constant R in one pass.
 */
export function furnitureAbsorptionPerBand(furniture, catalogue, frequency_bands_hz) {
  return (frequency_bands_hz || []).map(f => sumFurnitureAbsorption(furniture, catalogue, f));
}

/**
 * Per-row volumetric absorption coefficient μ_b (Nepers per metre) for
 * the precision ray-tracer's Beer-Lambert furniture sink.
 *
 * Derivation (Dr. Chen, acoustics-engineer brief 2026-05-26 + Kuttruff
 * 5th ed. §4.1 eq. 4.11):
 *
 *     μ_b = A_obj(b) / (4 · V_bbox)
 *
 * The factor of 4 is the Cauchy mean-chord theorem ratio for a convex
 * region. Per-ray attenuation when a ray segment of pathlength L_in
 * passes through the AABB:
 *
 *     E'(b) = E(b) · exp(−μ_b · L_in)
 *
 * The mapping depends ONLY on the object (A_obj, V_bbox), NOT on the
 * room. This is the non-obvious result that makes furniture absorption
 * a per-object property — the same way ΣA_obj enters the rt60 Sabine
 * denominator linearly without a room-volume term.
 *
 * Returns Map<catalogueId, Float32Array(bands_hz.length)>. Bands with
 * no A_obj entry in the catalogue contribute μ = 0 (Dr. Chen rule —
 * never extrapolate published data past its measured range).
 *
 * @param {Map}   catalogue        Map<id, row> from loadFurnitureCatalogue()
 * @param {number[]} frequency_bands_hz  e.g. [125, 250, 500, 1000, 2000, 4000, 8000]
 * @returns {Map<string, Float32Array>}
 */
export function furnitureVolumetricCoeffs(catalogue, frequency_bands_hz) {
  const out = new Map();
  if (!catalogue || !Array.isArray(frequency_bands_hz)) return out;
  const B = frequency_bands_hz.length;
  for (const [id, row] of catalogue.entries()) {
    const A = row?.acoustics?.A_obj_m2_sab_per_band;
    const fp = row?.footprint;
    if (!A || !fp) continue;
    const w = Math.max(0.01, fp.width_m  ?? 0);
    const d = Math.max(0.01, fp.depth_m  ?? 0);
    const h = Math.max(0.01, fp.height_m ?? 0);
    const V = w * d * h;
    if (V <= 0) continue;
    const mu = new Float32Array(B);
    for (let k = 0; k < B; k++) {
      const f = frequency_bands_hz[k];
      const a = A[String(Math.round(f))];
      if (Number.isFinite(a) && a > 0) {
        // Beer-Lambert coefficient — Nepers per metre.
        // Sanity-clamp at 5 Np/m (Dr. Chen edge case #6): a publication
        // error giving A_obj > 4·V_bbox would otherwise propagate as a
        // ray-absorbing wall. 5 Np/m corresponds to ~22 dB attenuation
        // per metre of pathlength inside the bbox — already absurdly
        // high for any real furniture absorber.
        mu[k] = Math.min(5, a / (4 * V));
      }
    }
    out.set(id, mu);
  }
  return out;
}
