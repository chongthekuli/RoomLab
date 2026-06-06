// Overhead cable-tray layout — PURE geometry math, NO Three.js import.
//
// Data centers route inter-rack cabling in a continuous overhead
// ladder/basket tray running ABOVE each rack row (top-of-rack switching
// drops bundles from the horizontal tray into each cabinet). This module
// turns a flat list of placed racks into one tray "run" per rack row.
// The actual Three.js mesh is assembled in scene.js (rebuildCableTrays)
// from these descriptors — keeping this module free of `three` so it runs
// under plain Node tests, the same discipline as js/ui/print-plan-svg.js.
//
// Coordinate frame: STATE coords (x = east, y = north, z = up), matching
// rack.position. scene.js converts to Three (x, z_up, y_depth) and the
// scene-level X-mirror is applied uniformly, exactly as for the racks.
//
// A "row" = racks that share a common line and facing. Racks facing
// north/south (yaw 0/180) line up along x → the row axis is x and the
// grouping key is the shared y. Racks facing east/west (yaw 90/270) line
// up along y → axis y, key is shared x. Back-to-back rows (different y,
// opposite yaw) are distinct lines and each gets its own tray — which is
// how real white-space trays run, one over each cabinet line.

export const CABLE_TRAY_DEFAULTS = Object.freeze({
  clearance_m: 0.30,   // gap between rack top and tray underside
  overhang_m:  0.15,   // tray over-runs past the end racks each side
  depthFrac:   0.55,   // tray width across the rack = depthFrac × rack depth
  rungPitch_m: 0.30,   // spacing of ladder cross-rungs along the run
  railThk_m:   0.012,  // ladder side-rail thickness (square section)
  railH_m:     0.05,   // ladder side-rail height
  // Fallbacks when the rack catalogue lacks a model (keeps the math total).
  fallbackW_m: 0.60,
  fallbackH_m: 2.00,
  fallbackD_m: 1.00,
});

// Snap an arbitrary yaw to the nearest 0/90/180/270 and report whether the
// row those racks form runs along the x axis.
export function rowAxisForYaw(yaw_deg) {
  const n = (((Math.round((Number(yaw_deg) || 0) / 90) * 90) % 360) + 360) % 360;
  return (n === 0 || n === 180) ? 'x' : 'y';
}

// racks: [{ position:{x,y,z}, yaw_deg, rackModelKey }]
// rackCatalogue: { racks: { <key>: { outer_w_mm, outer_h_mm, outer_d_mm } } }
// opts: partial override of CABLE_TRAY_DEFAULTS
// → [{ axis, cx, cy, topY, length, depth, railThk, railH, rungPitch,
//      rungCount, clearance, rackCount }]
export function computeCableTrayRows(racks, rackCatalogue, opts = {}) {
  const cfg = { ...CABLE_TRAY_DEFAULTS, ...opts };
  if (!Array.isArray(racks) || racks.length === 0) return [];

  const modelDims = (key) => {
    const def = rackCatalogue?.racks?.[key];
    return {
      w: (def?.outer_w_mm ?? cfg.fallbackW_m * 1000) / 1000,
      h: (def?.outer_h_mm ?? cfg.fallbackH_m * 1000) / 1000,
      d: (def?.outer_d_mm ?? cfg.fallbackD_m * 1000) / 1000,
    };
  };

  // Bucket racks by row line: axis + perpendicular coordinate (+ model, so a
  // taller rack on the same line doesn't get a wrong-height tray).
  const groups = new Map();
  for (const r of racks) {
    if (!r || !r.position) continue;
    const axis = rowAxisForYaw(r.yaw_deg);
    const perp = axis === 'x' ? (r.position.y ?? 0) : (r.position.x ?? 0);
    const perpKey = Math.round(perp * 10) / 10;   // 0.1 m grid tolerance
    const key = `${axis}:${perpKey}:${r.rackModelKey ?? '?'}`;
    let g = groups.get(key);
    if (!g) { g = { axis, perp, modelKey: r.rackModelKey, along: [] }; groups.set(key, g); }
    g.along.push(axis === 'x' ? (r.position.x ?? 0) : (r.position.y ?? 0));
  }

  const rows = [];
  for (const g of groups.values()) {
    const dims = modelDims(g.modelKey);
    const minA = Math.min(...g.along);
    const maxA = Math.max(...g.along);
    const center = (minA + maxA) / 2;
    const length = (maxA - minA) + dims.w + 2 * cfg.overhang_m;
    const rungCount = Math.max(2, Math.round(length / cfg.rungPitch_m) + 1);
    rows.push({
      axis: g.axis,
      cx: g.axis === 'x' ? center : g.perp,
      cy: g.axis === 'x' ? g.perp : center,
      topY: dims.h,                       // rack top above floor (state +z)
      length,
      depth: dims.d * cfg.depthFrac,
      railThk: cfg.railThk_m,
      railH: cfg.railH_m,
      rungPitch: cfg.rungPitch_m,
      rungCount,
      clearance: cfg.clearance_m,
      rackCount: g.along.length,
    });
  }
  // Deterministic order (helps tests + stable scene-graph diffing).
  rows.sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
  return rows;
}
