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
