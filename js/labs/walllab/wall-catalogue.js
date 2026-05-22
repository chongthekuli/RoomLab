// WallLAB curated wall-material catalogue (UI layer).
//
// Maps a subset of data/materials.json to wall-construction metadata the
// mass-law slider needs but the catalogue doesn't carry yet:
//   • wallType            — Maya's taxonomy grouping (sorted heaviest-first).
//   • reference_thickness_m — the thickness the catalogue's measured
//                            surface_density_kg_m2 was measured at, so the
//                            slider can recover bulk density (Dr. Chen). Values
//                            come from the measured rows' _tl_source prose
//                            ("150 mm concrete", "6 mm float glass", …).
//   • coincidence_band_hz — the octave where the MEASURED curve dips below the
//                            mass law (panel flexes in sympathy). null = f_c is
//                            above 8 kHz (mass-law-valid across the band, e.g.
//                            dense masonry). Annotation only — not computed
//                            (f_c-from-elastic-moduli is backlog P3).
//   • thickness_mm        — slider {min, max, default} per wall family.
//
// This metadata lives in the UI layer (NOT js/physics/wall-tl.js) per Dr.
// Chen's "UI supplies reference_thickness" decision — keeps the physics module
// pure of material-specific constants. Promote reference_thickness_m into
// materials.json (schema 1.5, route to Sam) if a second consumer ever needs it.

export const WALL_TYPES = [
  { id: 'masonry',  label: 'Solid masonry' },
  { id: 'partition', label: 'Stud partition' },
  { id: 'glazing',  label: 'Glazing' },
  { id: 'door',     label: 'Door / composite' },
];

// Keyed by material id (must exist in data/materials.json with both
// transmission_loss_db AND surface_density_kg_m2). Ordered heaviest-first
// within each type for the engineer's mental model.
export const WALL_MATERIALS = [
  // — Solid masonry —
  { id: 'concrete-painted', wallType: 'masonry',
    reference_thickness_m: 0.150, coincidence_band_hz: null,
    thickness_mm: { min: 50, max: 400, default: 150 } },
  { id: 'plaster-smooth', wallType: 'masonry',
    reference_thickness_m: 0.013, coincidence_band_hz: null,
    thickness_mm: { min: 8, max: 50, default: 13 } },

  // — Stud partition —
  { id: 'gypsum-board', wallType: 'partition',
    reference_thickness_m: 0.013, coincidence_band_hz: 4000,
    thickness_mm: { min: 9, max: 50, default: 13 } },

  // — Glazing —
  { id: 'led-glass', wallType: 'glazing',
    reference_thickness_m: 0.010, coincidence_band_hz: 2000,
    thickness_mm: { min: 4, max: 30, default: 10 } },
  { id: 'glass-window', wallType: 'glazing',
    reference_thickness_m: 0.006, coincidence_band_hz: 2000,
    thickness_mm: { min: 3, max: 25, default: 6 } },

  // — Door / composite —
  { id: 'door-solid-wood', wallType: 'door',
    reference_thickness_m: 0.045, coincidence_band_hz: null,
    thickness_mm: { min: 30, max: 60, default: 45 } },
  { id: 'door-hollow-core', wallType: 'door',
    reference_thickness_m: 0.045, coincidence_band_hz: null,
    thickness_mm: { min: 30, max: 60, default: 45 } },
  { id: 'wood-floor', wallType: 'door',
    reference_thickness_m: 0.019, coincidence_band_hz: null,
    thickness_mm: { min: 12, max: 60, default: 19 } },
];

export function wallMaterialsByType(typeId) {
  return WALL_MATERIALS.filter(m => m.wallType === typeId);
}

export function wallMaterialMeta(id) {
  return WALL_MATERIALS.find(m => m.id === id) || null;
}
