// material-family-hatch.js — materialId → hatch-rendering family bucket.
//
// Pure module (no DOM, no Three.js). Imported by:
//   • js/graphics/room-2d.js     — 2D viewport wall fills (Maya, Commit 4)
//   • js/ui/print-plan-svg.js    — print plan SVG wall fills (Maya, Commit 4)
//   • tests/cross-surface-conventions.test.mjs — Sam's `commit3_hatch_buckets`
//     parity gate (currently soft, flips hard once Maya wires the consumers).
//
// ----------------------------------------------------------------------------
// Why families, not per-material patterns
// ----------------------------------------------------------------------------
// The 2D viewport and the printed plan render the same room from the same
// state. If a wall is "concrete-painted" in one and "concrete-painted" in
// the other, the fill must read identically to a contractor flipping
// between screen and paper. Per-material patterns are not feasible (32
// catalogue rows today, growing) and not useful — a contractor reads a
// plan by construction family (dense / framed / glazed / opening), not
// by trade name. The five buckets below match the families a structural
// drawing already uses.
//
// ----------------------------------------------------------------------------
// Monochrome-safety guarantee
// ----------------------------------------------------------------------------
// Each bucket resolves to a GRAYSCALE pattern in Maya's CSS / SVG <pattern>
// definitions:
//
//   solid-dark      — flat dark fill (~25% black).
//   diagonal-hatch  — 45° line hatch on mid-grey ground.
//   outline-only    — stroke only, no fill (transparent interior).
//   open-air        — no stroke, no fill (the wall is not drawn).
//   unknown         — plain outline, light dotted stroke (visible but
//                     unmistakably "not classified").
//
// Colour is an OPTIONAL skin Maya may layer on top (e.g. blue tint on
// glazing, warm grey on masonry) for the 2D viewport. The PRINT path
// ships monochrome — fabricators print on black-and-white office
// machines and any colour-dependent meaning is lost.
//
// ----------------------------------------------------------------------------
// Why 'unknown' falls back to plain outline (NOT 'solid-dark')
// ----------------------------------------------------------------------------
// If a new row lands in data/materials.json before this map is updated,
// returning 'solid-dark' would silently render it as concrete on every
// drawing the engineer hands a client. That is a wrong-information bug
// dressed as a layout bug — the worst kind. Returning 'unknown' draws
// the wall with a plain dotted outline: visibly different from every
// classified material, so the missing mapping shows up in the first
// preview render instead of weeks later in a fabrication query.
//
// When you add a row to materials.json, add it to the table below in the
// same commit. The defensive heuristic in `getMaterialHatchKind` is a
// safety net, NOT a substitute for an explicit entry.
//
// ----------------------------------------------------------------------------
// Coverage table — materialId → bucket
// ----------------------------------------------------------------------------
// solid-dark        concrete-painted, cmu_200_hollow, cmu_200_grouted,
//                   door-solid-wood
//
// diagonal-hatch    gypsum-board, wall_2x4_sg_2x_each_air,
//                   wall_2x4_sg_2x_each_mf50, wall_2x4_dg_each_mf90,
//                   wall_double_stud_dg_mf140, wall_staggered_2x6_2x_mf90,
//                   wall_steel_25_dg_mf65_rc, wood-floor, door-hollow-core,
//                   plaster-smooth, acoustic-tile, metal-deck-acoustic,
//                   perforated-panel-fabric, arena-wall-mixed,
//                   bass-trap-broadband-corner, bass-trap-membrane-80hz,
//                   bass-trap-helmholtz-125hz, ceiling-cloud-200mm,
//                   diffuser-qrd, carpet-heavy, carpet-heavy-underlay,
//                   upholstered-seat-empty, audience-seated
//
// outline-only      glass-window, led-glass, glaz_igu_4_12_4_air,
//                   glaz_igu_6_16_8_air, glaz_lam_88_argon_lam_66
//
// open-air          open-air
//
// unknown           anything not listed above and not matched by the
//                   defensive heuristic.
//
// Notes on placement calls (Lin / docs-writer, 2026-05-23):
//   • plaster-smooth is a skim coat over an unknown substrate — without
//     the substrate the boundary is a thin lightweight finish, so it
//     reads as diagonal-hatch, not solid-dark.
//   • door-solid-wood (45 mm hardwood, 32 kg/m²) is heavy enough to read
//     as a solid in plan. door-hollow-core (10 kg/m²) is not.
//   • led-glass is a glass + steel chassis composite, but the user-facing
//     face is glass — it reads as glazing in plan and should not be
//     conflated with a structural wall.
//   • wood-floor and ceiling-cloud-200mm normally render on the floor /
//     ceiling paths rather than walls; bucketing them as diagonal-hatch
//     keeps the helper total — Sam's fixture exercises the function on
//     every materialId in the catalogue regardless of surface.
//   • Treatments (bass traps, diffusers, panels, carpets, seating) are
//     not load-bearing walls but the engineer may attach them as wall
//     materials in DeviceLAB workflows; diagonal-hatch communicates
//     "treated surface, not structure".
// ----------------------------------------------------------------------------

const FAMILY_BY_ID = Object.freeze({
  // solid-dark — dense masonry, concrete, heavy timber.
  'concrete-painted':                'solid-dark',
  'cmu_200_hollow':                  'solid-dark',
  'cmu_200_grouted':                 'solid-dark',
  'door-solid-wood':                 'solid-dark',

  // diagonal-hatch — framed partitions, lightweight finishes, treatments.
  'gypsum-board':                    'diagonal-hatch',
  'wall_2x4_sg_2x_each_air':         'diagonal-hatch',
  'wall_2x4_sg_2x_each_mf50':        'diagonal-hatch',
  'wall_2x4_dg_each_mf90':           'diagonal-hatch',
  'wall_double_stud_dg_mf140':       'diagonal-hatch',
  'wall_staggered_2x6_2x_mf90':      'diagonal-hatch',
  'wall_steel_25_dg_mf65_rc':        'diagonal-hatch',  // Phase 6 deferred row
  'wood-floor':                      'diagonal-hatch',
  'door-hollow-core':                'diagonal-hatch',
  'plaster-smooth':                  'diagonal-hatch',
  'acoustic-tile':                   'diagonal-hatch',
  'metal-deck-acoustic':             'diagonal-hatch',
  'perforated-panel-fabric':         'diagonal-hatch',
  'arena-wall-mixed':                'diagonal-hatch',
  'bass-trap-broadband-corner':      'diagonal-hatch',
  'bass-trap-membrane-80hz':         'diagonal-hatch',
  'bass-trap-helmholtz-125hz':       'diagonal-hatch',
  'ceiling-cloud-200mm':             'diagonal-hatch',
  'diffuser-qrd':                    'diagonal-hatch',
  'carpet-heavy':                    'diagonal-hatch',
  'carpet-heavy-underlay':           'diagonal-hatch',
  'upholstered-seat-empty':          'diagonal-hatch',
  'audience-seated':                 'diagonal-hatch',

  // outline-only — transparent glazing.
  'glass-window':                    'outline-only',
  'led-glass':                       'outline-only',
  'glaz_igu_4_12_4_air':             'outline-only',  // Phase 6 deferred row
  'glaz_igu_6_16_8_air':             'outline-only',  // Phase 6 deferred row
  'glaz_lam_88_argon_lam_66':        'outline-only',  // Phase 6 deferred row

  // open-air — opening / no boundary.
  'open-air':                        'open-air',
});

// Defensive heuristic for an ID not present in the table above. Maps by
// id-prefix to a family using the same rules a contractor would apply
// reading a new product name. Returns null if no rule fires — caller
// then resolves to 'unknown'.
function heuristicFamily(id) {
  // open-air variants.
  if (id === 'open' || id === 'opening' || id === 'no-wall') return 'open-air';

  // Glazing first — must precede 'door-' check because some products
  // use 'door-glass-*' style IDs.
  if (id.startsWith('glass') || id.startsWith('glaz') || id.startsWith('polycarb')) {
    return 'outline-only';
  }
  if (id.startsWith('door-') && (id.includes('glass') || id.includes('glaz'))) {
    return 'outline-only';
  }

  // Dense / solid.
  if (id.startsWith('concrete') || id.startsWith('brick') || id.includes('masonry')
      || id.startsWith('cmu') || id.startsWith('rc-slab') || id.startsWith('stone')) {
    return 'solid-dark';
  }
  // Solid heavy door — assume solid unless the id signals otherwise.
  if (id.startsWith('door-solid') || id.startsWith('door-wood')) return 'solid-dark';

  // Lightweight framed / finish / treatment.
  if (id.startsWith('gypsum') || id.startsWith('gwb') || id.startsWith('drywall')
      || id.startsWith('wall_') || id.includes('stud') || id.includes('mdf')
      || id.includes('plywood') || id.startsWith('door-hollow')
      || id.startsWith('plaster') || id.startsWith('acoustic-tile')
      || id.startsWith('bass-trap') || id.startsWith('diffuser')
      || id.startsWith('carpet') || id.startsWith('ceiling-')
      || id.startsWith('perforated') || id.startsWith('upholstered')
      || id.startsWith('audience') || id.startsWith('seat')) {
    return 'diagonal-hatch';
  }

  return null;
}

/**
 * Map a materialId to its hatch-rendering family. Used by the 2D
 * viewport and the print plan SVG.
 *
 * @param {string|null|undefined} materialId
 * @returns {'solid-dark'|'diagonal-hatch'|'outline-only'|'open-air'|'unknown'}
 *
 * Bucket strings are LOCKED — Sam's parity fixture greps for these
 * exact spellings. Do not rename without coordinating with him.
 */
export function getMaterialHatchKind(materialId) {
  // Openings / null / empty.
  if (materialId === null || materialId === undefined || materialId === '') {
    return 'open-air';
  }
  if (typeof materialId !== 'string') return 'unknown';

  const id = materialId; // case-sensitive; catalogue IDs are lowercase by convention.

  const explicit = FAMILY_BY_ID[id];
  if (explicit) return explicit;

  const heuristic = heuristicFamily(id);
  if (heuristic) return heuristic;

  // Defensive default — NEVER 'solid-dark'. A new materialId must show up
  // visibly as unclassified so the engineer notices the mapping gap on
  // the first render, not in a fabrication query weeks later.
  return 'unknown';
}

// Exported for unit tests that want to assert "every row in materials.json
// has an explicit entry". Frozen to keep callers from mutating it.
export const MATERIAL_HATCH_TABLE = FAMILY_BY_ID;

// Exported set of valid bucket strings — for callers that want to assert
// the return value falls inside the locked vocabulary.
export const HATCH_BUCKETS = Object.freeze([
  'solid-dark',
  'diagonal-hatch',
  'outline-only',
  'open-air',
  'unknown',
]);
