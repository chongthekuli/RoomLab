// Reliability-tier colour mapping for the FurnitureLAB confidence overlay.
//
// Why this lives in its own pure module:
//   - 2D viewport (room-2d.js) reads it for SVG fill/stroke.
//   - 3D viewport (Phase 1B+) reads it as hex ints for material tint.
//   - Print BoM (Phase 1B+) reads it for the schedule row badge.
//   - Sidebar legend chip (panel-furniture.js) reads it for the swatches.
// Five consumers — the contract has to be in one place. Pure / no DOM /
// Node-testable so the tier mapping can be locked down with a test.
//
// Carmen's wedge (market-strategist brief, 2026-05-26): no competitor
// surfaces uncertainty propagation visually. This overlay is the
// editorial moat — every placed object exposes its evidence tier to
// the user at a glance.
//
// Tier vocabulary mirrors the catalogue schema (data/furniture/
// catalogue.json), which mirrors Dr. Chen's six-rule physics-grade gate:
//
//   measured  — direct ISO 354 reverberation-room measurement (cited
//               lab / DOI / measurement_method=ISO 354). Green.
//   derived   — calculated from a parent ISO 354 measurement with a
//               documented derivation (per-seat from per-m² ×
//               footprint, occupied from empty × Beranek ratio, etc.).
//               Amber.
//   estimated — engineering judgement / material-class extrapolation /
//               back-of-envelope. Red. UI MUST badge these clearly so
//               the user knows the RT60 number rests on a guess.

const COLORS = {
  measured: {
    fill:        'rgba(27, 110, 55, 0.32)',
    stroke:      'rgba(27, 110, 55, 0.95)',
    label:       'Measured',
    hexInt:      0x1B6E37,
    swatchHex:   '#1B6E37',
  },
  derived: {
    fill:        'rgba(180, 130, 36, 0.32)',
    stroke:      'rgba(180, 130, 36, 0.95)',
    label:       'Derived',
    hexInt:      0xB48224,
    swatchHex:   '#B48224',
  },
  estimated: {
    fill:        'rgba(160, 50, 38, 0.32)',
    stroke:      'rgba(160, 50, 38, 0.95)',
    label:       'Estimated',
    hexInt:      0xA03226,
    swatchHex:   '#A03226',
  },
  // Fallback for missing / broken / unknown rows. Neutral grey so a
  // broken-link object never reads as "high confidence".
  unknown: {
    fill:        'rgba(140, 140, 140, 0.25)',
    stroke:      'rgba(140, 140, 140, 0.80)',
    label:       'Unknown',
    hexInt:      0x8C8C8C,
    swatchHex:   '#8C8C8C',
  },
};

const TIER_ORDER = ['measured', 'derived', 'estimated'];

/**
 * @param {string|null|undefined} tag  one of 'measured' | 'derived' | 'estimated'
 * @returns {{fill: string, stroke: string, label: string, hexInt: number, swatchHex: string}}
 */
export function colorForReliability(tag) {
  if (typeof tag === 'string' && COLORS[tag]) return COLORS[tag];
  return COLORS.unknown;
}

/**
 * Legend rows in fixed tier order (best → worst). Each entry has a
 * label and swatchHex. Consumers use this to render the in-viewport
 * legend chip and the print BoM legend.
 * @returns {Array<{tier: string, label: string, swatchHex: string}>}
 */
export function reliabilityLegendRows() {
  return TIER_ORDER.map(t => ({
    tier: t,
    label: COLORS[t].label,
    swatchHex: COLORS[t].swatchHex,
  }));
}
