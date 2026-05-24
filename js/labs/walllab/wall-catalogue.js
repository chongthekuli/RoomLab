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
//   • assembly_type       — 'single_leaf' | 'double_leaf' | 'composite'. Drives
//                            the workbench's computed-vs-measured Δ display:
//                            single-leaf mass-law TL = 20·log10(m·f) − 47 is
//                            only meaningful against a row whose measured
//                            value reflects single-leaf physics. For
//                            double-leaf assemblies (drywall on studs — Sharp
//                            1973 mass-spring-mass + cavity + bridging) and
//                            composites (sandwich panels, sealed door
//                            assemblies, floor-ceiling assemblies) the mass-
//                            law line is the WRONG comparator — drawing it
//                            on a Δ table tells the user the assembly is
//                            "diverging" from mass law when it never followed
//                            mass law in the first place. WallLAB hides the
//                            Δ + measured curve and shows an assembly note
//                            instead. Phase 5 will replace the hidden state
//                            with the real double-leaf / composite predictor.
//                            (Dr. Chen audit 2026-05-23.)
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
  // — Solid masonry — single dense leaf, mass law tracks the measured curve.
  { id: 'concrete-painted', wallType: 'masonry', assembly_type: 'single_leaf',
    reference_thickness_m: 0.150, coincidence_band_hz: null,
    thickness_mm: { min: 50, max: 400, default: 150 } },
  { id: 'plaster-smooth', wallType: 'masonry', assembly_type: 'single_leaf',
    reference_thickness_m: 0.013, coincidence_band_hz: null,
    thickness_mm: { min: 8, max: 50, default: 13 } },

  // — Stud partition — drywall on steel studs IS a double-leaf cavity wall:
  // mass-spring-mass + cavity + stud bridging, NOT a limp panel. Mass law
  // is the wrong comparator (Dr. Chen, 2026-05-23). The catalogue row's
  // STC ~35 reflects the assembly; Phase 5 ships the real predictor.
  { id: 'gypsum-board', wallType: 'partition', assembly_type: 'double_leaf',
    reference_thickness_m: 0.013, coincidence_band_hz: 4000,
    thickness_mm: { min: 9, max: 50, default: 13 } },

  // — Glazing — single pane IS single-leaf (mass law + coincidence at f_c).
  // led-glass is an estimated panel-+-chassis composite, not a single leaf.
  { id: 'led-glass', wallType: 'glazing', assembly_type: 'composite',
    reference_thickness_m: 0.010, coincidence_band_hz: 2000,
    thickness_mm: { min: 4, max: 30, default: 10 } },
  { id: 'glass-window', wallType: 'glazing', assembly_type: 'single_leaf',
    reference_thickness_m: 0.006, coincidence_band_hz: 2000,
    thickness_mm: { min: 3, max: 25, default: 6 } },

  // — Door / composite — door + seals is an assembly (plateau is the
  // perimeter-leak / diffraction-around-edge floor, not coincidence).
  // Floor-on-joists is a floor-ceiling assembly between storeys.
  { id: 'door-solid-wood', wallType: 'door', assembly_type: 'composite',
    reference_thickness_m: 0.045, coincidence_band_hz: null,
    thickness_mm: { min: 30, max: 60, default: 45 } },
  { id: 'door-hollow-core', wallType: 'door', assembly_type: 'composite',
    reference_thickness_m: 0.045, coincidence_band_hz: null,
    thickness_mm: { min: 30, max: 60, default: 45 } },
  { id: 'wood-floor', wallType: 'door', assembly_type: 'composite',
    reference_thickness_m: 0.019, coincidence_band_hz: null,
    thickness_mm: { min: 12, max: 60, default: 19 } },

  // — Phase 5 Step 7 (Lin, 2026-05-23): formula and mass-law catalogue rows.
  // The model field on the materials.json row (Step 3 schema 1.5) drives the
  // workbench's UI branch — `formula` rows show the double-leaf slider rail,
  // `mass-law` rows show the thickness slider, `catalogue` rows show the
  // measured curve only. WallLAB-layer fields below are catalogue-only
  // annotations (slider ranges for the mass-law UI; null for formula rows
  // since their parameter space lives in `assembly`).
  { id: 'wall_2x4_sg_2x_each_air', wallType: 'partition', assembly_type: 'double_leaf',
    reference_thickness_m: null, coincidence_band_hz: 2500,
    thickness_mm: null },
  { id: 'wall_2x4_sg_2x_each_mf50', wallType: 'partition', assembly_type: 'double_leaf',
    reference_thickness_m: null, coincidence_band_hz: 2500,
    thickness_mm: null },
  { id: 'wall_2x4_dg_each_mf90', wallType: 'partition', assembly_type: 'double_leaf',
    reference_thickness_m: null, coincidence_band_hz: 2500,
    thickness_mm: null },
  { id: 'wall_double_stud_dg_mf140', wallType: 'partition', assembly_type: 'double_leaf',
    reference_thickness_m: null, coincidence_band_hz: 2500,
    thickness_mm: null },
  { id: 'wall_staggered_2x6_2x_mf90', wallType: 'partition', assembly_type: 'double_leaf',
    reference_thickness_m: null, coincidence_band_hz: 2500,
    thickness_mm: null },
  { id: 'cmu_200_hollow', wallType: 'masonry', assembly_type: 'single_leaf',
    reference_thickness_m: 0.200, coincidence_band_hz: null,
    thickness_mm: { min: 100, max: 400, default: 200 } },
  { id: 'cmu_200_grouted', wallType: 'masonry', assembly_type: 'single_leaf',
    reference_thickness_m: 0.200, coincidence_band_hz: null,
    thickness_mm: { min: 100, max: 400, default: 200 } },

  // Phase 6 deferred rows (Lin 2026-05-23) — visible in the dropdown
  // DISABLED with a "· measured data pending" sublabel per Maya §5. Lin
  // refused to fabricate the 1/3-octave TL curves (paywalled NRC IR-761
  // + Saint-Gobain Acoustic Guide 2022 graphed-only). Removed from this
  // list when the rows ship in materials.json with real data — the UI
  // auto-promotes them at that point (the `deferred: true` flag lets
  // refreshMaterialOptions render `<option disabled>` regardless of
  // materials.byId presence).
  { id: 'wall_steel_25_dg_mf65_rc', wallType: 'partition',
    name: 'Steel stud, 2×13 GWB e/s, 65 mm fibre, RC one side',
    deferred: true },
  { id: 'glaz_igu_4_12_4_air', wallType: 'glazing',
    name: 'IGU 4-12-4 mm float, air cavity',
    deferred: true },
  { id: 'glaz_igu_6_16_8_air', wallType: 'glazing',
    name: 'IGU 6-16-8 mm asymmetric, air',
    deferred: true },
  { id: 'glaz_lam_88_argon_lam_66', wallType: 'glazing',
    name: 'Laminated 8.8 / argon 16 / laminated 6.6',
    deferred: true },
];

export function wallMaterialsByType(typeId) {
  return WALL_MATERIALS.filter(m => m.wallType === typeId);
}

export function wallMaterialMeta(id) {
  return WALL_MATERIALS.find(m => m.id === id) || null;
}

// True iff the catalogue row's measured TL reflects single-leaf, mass-law-
// comparable physics. Anything else (double-leaf cavity, sealed door,
// composite panel, floor-ceiling assembly) returns false and the workbench
// hides the computed-vs-measured Δ comparison.
export function isSingleLeafAssembly(id) {
  const meta = wallMaterialMeta(id);
  return (meta?.assembly_type ?? 'single_leaf') === 'single_leaf';
}
