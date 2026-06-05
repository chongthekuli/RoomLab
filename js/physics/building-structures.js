// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// Building-structure acoustics — pillars, half-walls, full-height interior
// partitions, overhead beams/soffits, and raised platforms (state.structures).
//
// Unlike furniture (a lumped Beer-Lambert absorber), a building structure is a
// STRUCTURAL OBSTRUCTION that modifies the sound field on up to THREE parallel
// energy-summed paths (Dr. Lena Chen's spec, 2026-06-05):
//
//   1. DIFFRACTION around/over the obstacle — sound that reaches the listener
//      by bending around the free edges. Reuses the Maekawa primitives from
//      diffraction.js. Two regimes:
//        • SEMI-INFINITE SCREEN (over the TOP of a half-wall / under a beam):
//          signed path-difference via overBarrierPathDifference + the floored
//          thickBarrierIL (the 5 dB graze handoff is correct for a screen).
//        • FINITE OBSTACLE wrap-around (the two vertical SIDES of a pillar, the
//          two vertical ENDS of a half-wall): a narrow obstacle of cross-width
//          d only casts a shadow above f_c ≈ c/(2d) — bass wraps around it. The
//          floored maekawaIL would wrongly give a ≥5 dB shadow for a thin pillar
//          at 125 Hz; so the side/end edges use a PURE Maekawa N-curve with NO
//          graze floor (finiteEdgeIL below). The frequency gate then falls out
//          of the Fresnel number for free, and the delivered field is capped at
//          the direct level (an obstacle can attenuate, never amplify).
//
//   2. TRANSMISSION through the mass — sound straight through the body, using
//      the material's tabulated transmission_loss_db[] (mass law with the
//      coincidence dip baked in). Parallel to path 1; energy-summed. This sets
//      the floor behind a light partition where diffraction is strong.
//
//   3. ABSORPTION sink — the obstacle's exposed surface area × α removes energy
//      from the reverberant field. Fed into RT60 + the Hopkins-Stryker room
//      constant via sumStructureAbsorption (rt60.js → spl-calculator.js), the
//      same parallel-A channel furniture + racks use (Kuttruff §5.3).
//
// Honesty boundaries (Theo P-level backlog; surfaced in the panel + glossary):
//   • Single-edge Maekawa is ±3 dB in the deep shadow, worse near the shadow
//     boundary, and untrustworthy below ~150 Hz (modal regime) — diffraction is
//     a free-field model.
//   • The pillar shadow cutoff (no LF shadow) is REAL physics, not a bug.
//   • Mass-law TL from surface_density ignores the coincidence dip; we prefer
//     the tabulated transmission_loss_db[] which bakes it in. Custom mass-only
//     materials get the optimistic value.
//   • No specular early-reflection coloration from structures in the analytical
//     field (needs the precision ray tracer).
//   • Multiple structures on one path are treated as independent series barriers
//     (dB losses added) — a conservative simplification, not a coupled solve.
//   • Any TL shown is a lab value; field isolation is lower (no flanking).
//
// Pure / Node-testable. No DOM, no Three.js, no outbound imports beyond the
// pure diffraction primitives (nymphysics no-outbound-imports invariant).

import {
  maekawaIL,
  thickBarrierIL,
  overBarrierPathDifference,
  diffractionPointOnEdge,
  MAEKAWA_IL_MAX_DB,
} from './diffraction.js';

const DEFAULT_TEMPERATURE_C = 20;
function speedOfSound(T_C = DEFAULT_TEMPERATURE_C) {
  return 331.3 * Math.sqrt(1 + T_C / 273.15);
}

// Recognised structure types (mirrors app-state deserialize filter).
export const STRUCTURE_TYPES = ['pillar', 'half_wall', 'partition', 'beam', 'platform'];

// Nearest octave-band index for a frequency.
function nearestBandIdx(bands_hz, freq_hz) {
  let nearest = 0, bestD = Infinity;
  for (let k = 0; k < bands_hz.length; k++) {
    const d = Math.abs(bands_hz[k] - freq_hz);
    if (d < bestD) { bestD = d; nearest = k; }
  }
  return nearest;
}

// -------------------------------------------------------------------------
// Geometry helpers — shared by physics AND the 2D / 3D / print renderers so
// every surface draws the same footprint (cross-surface convention). All in
// state coordinates (state +y = north); rotation_deg is yaw about vertical.
// -------------------------------------------------------------------------

function deg2rad(d) { return (d * Math.PI) / 180; }

// Effective plan dimensions (metres) of a structure's bounding rectangle,
// BEFORE rotation: { lx (length / width along local x), ly (depth / thickness
// along local y) }. Round pillars report their diameter on both axes.
export function structurePlanSize(s) {
  switch (s.type) {
    case 'pillar': {
      if (s.crossSection === 'round') {
        const d = Number(s.diameter_m) || 0.4;
        return { lx: d, ly: d };
      }
      if (s.crossSection === 'polygon') {
        const d = Number(s.diameter_m) || 0.4;   // circumscribed diameter
        return { lx: d, ly: d };
      }
      // square (or default)
      const w = Number(s.width_m) || Number(s.diameter_m) || 0.4;
      const dep = Number(s.depth_m) || w;
      return { lx: w, ly: dep };
    }
    case 'half_wall':
    case 'partition':
      return { lx: Number(s.length_m) || 3, ly: Number(s.thickness_m) || 0.12 };
    case 'beam':
      return { lx: Number(s.length_m) || 5, ly: Number(s.width_m) || 0.3 };
    case 'platform':
      return { lx: Number(s.width_m) || 3, ly: Number(s.depth_m) || 2 };
    default:
      return { lx: 0.4, ly: 0.4 };
  }
}

// Vertical extent { base, top } (metres above floor). Pillars/partitions are
// floor-to-ceiling by default; half-walls stop at height_m; beams hang below
// the ceiling; platforms are short risers.
export function structureHeightRange(s, room) {
  const ceil = Number(room?.height_m) || 3;
  const elev = Number(s.elev_m) || 0;
  switch (s.type) {
    case 'pillar':
      return { base: elev, top: (s.fullHeight === false && Number.isFinite(s.height_m)) ? elev + Number(s.height_m) : ceil };
    case 'partition':
      return { base: elev, top: ceil };
    case 'half_wall':
      return { base: elev, top: s.fullHeight ? ceil : elev + (Number(s.height_m) || 1.1) };
    case 'beam': {
      const drop = Number(s.soffitDrop_m) || 0.4;
      const depth = Number(s.depth_m) || 0.4;
      const bottom = Math.max(0, ceil - drop);
      return { base: bottom, top: Math.min(ceil, bottom + depth) };
    }
    case 'platform':
      return { base: 0, top: Number(s.height_m) || 0.3 };
    default:
      return { base: elev, top: ceil };
  }
}

// True when the structure is a planar barrier (wall-like) vs a finite column.
function isPlanarBarrier(type) {
  return type === 'half_wall' || type === 'partition' || type === 'beam' || type === 'platform';
}

// Round-pillar footprint as a circle, or null for non-round.
export function structureFootprintCircle(s) {
  if (s.type === 'pillar' && s.crossSection === 'round') {
    return { cx: s.position.x, cy: s.position.y, r: (Number(s.diameter_m) || 0.4) / 2 };
  }
  return null;
}

// Footprint corner polygon in plan (state coords), rotated by rotation_deg.
// For round pillars, returns a 24-gon approximation so renderers + the
// blocking test share one path; the circle helper is offered separately for
// the exact distance test.
export function structureFootprintCorners(s) {
  const cx = s.position.x, cy = s.position.y;
  const th = deg2rad(s.rotation_deg || 0);
  const cos = Math.cos(th), sin = Math.sin(th);
  const place = (lx, ly) => ({ x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos });

  if (s.type === 'pillar' && s.crossSection === 'round') {
    const r = (Number(s.diameter_m) || 0.4) / 2;
    const out = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * 2 * Math.PI;
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return out;
  }
  if (s.type === 'pillar' && s.crossSection === 'polygon') {
    const R = (Number(s.diameter_m) || 0.4) / 2;
    const n = Math.max(3, Math.min(12, Number(s.sides) || 6));
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = th + (i / n) * 2 * Math.PI;
      out.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    }
    return out;
  }
  const { lx, ly } = structurePlanSize(s);
  const hx = lx / 2, hy = ly / 2;
  return [place(-hx, -hy), place(hx, -hy), place(hx, hy), place(-hx, hy)];
}

// The structure's local length-axis direction in plan (unit vector). For a
// wall/beam this is the long axis; for a pillar it's the +x local axis.
function lengthAxis(s) {
  const th = deg2rad(s.rotation_deg || 0);
  return { x: Math.cos(th), y: Math.sin(th) };
}

// -------------------------------------------------------------------------
// Ray ↔ structure blocking test (does the direct 3D segment pass through the
// solid prism?). Returns the in-prism pathlength midpoint parameter t∈[0,1]
// and the z-height there, or null when the segment misses the body.
// -------------------------------------------------------------------------

// 2D segment vs convex polygon entry/exit parameters (t along S→R in [0,1]).
function segPolyTRange(sx, sy, rx, ry, corners) {
  const dx = rx - sx, dy = ry - sy;
  let tEnter = 0, tExit = 1;
  // Clip against each edge's inward half-plane (corners assumed CCW or CW;
  // we use the convex-polygon Liang-Barsky style clip).
  const n = corners.length;
  // Compute polygon centroid to orient inward normals consistently.
  let cgx = 0, cgy = 0;
  for (const c of corners) { cgx += c.x; cgy += c.y; }
  cgx /= n; cgy /= n;
  for (let i = 0; i < n; i++) {
    const a = corners[i], b = corners[(i + 1) % n];
    let nx = -(b.y - a.y), ny = (b.x - a.x);   // edge normal
    // Orient inward (towards centroid).
    if (nx * (cgx - a.x) + ny * (cgy - a.y) < 0) { nx = -nx; ny = -ny; }
    const denom = nx * dx + ny * dy;
    const num = nx * (a.x - sx) + ny * (a.y - sy);
    if (Math.abs(denom) < 1e-12) {
      // Parallel to edge: if origin outside this half-plane, no intersection.
      if (num > 0) return null;
      continue;
    }
    const t = num / denom;
    if (denom > 0) { if (t > tEnter) tEnter = t; }
    else { if (t < tExit) tExit = t; }
    if (tEnter > tExit) return null;
  }
  return { tEnter, tExit };
}

function structureBlocks(s, S, R, room) {
  const corners = structureFootprintCorners(s);
  const rng = segPolyTRange(S.x, S.y, R.x, R.y, corners);
  if (!rng) return null;
  const { base, top } = structureHeightRange(s, room);
  // z along the segment at entry/exit of the footprint.
  const zAt = (t) => S.z + (R.z - S.z) * t;
  const zEnter = zAt(rng.tEnter), zExit = zAt(rng.tExit);
  // Vertical overlap of [min,max] segment-z over the footprint span with the
  // prism's [base, top]. If the segment within the footprint is entirely above
  // the top (clears it) or below the base, it does NOT pass through the body.
  const zLo = Math.min(zEnter, zExit), zHi = Math.max(zEnter, zExit);
  if (zHi < base || zLo > top) return null;
  return { tEnter: rng.tEnter, tExit: rng.tExit, base, top };
}

// -------------------------------------------------------------------------
// Diffraction sub-models
// -------------------------------------------------------------------------

// Pure Maekawa N-curve with NO graze floor — for FINITE-obstacle wrap-around
// (pillar sides, half-wall ends). Returns 0 for δ ≤ 0 (lit / wrap zone) and
// rises with the Fresnel number, capped at the single-edge ceiling. This is
// what makes a narrow pillar transparent to bass (the floored maekawaIL would
// wrongly report ≥5 dB). delta_m from diffractionPointOnEdge (always ≥ 0; the
// blocking gate upstream guarantees the bypass is a genuine shadow path).
function finiteEdgeIL(delta_m, lambda_m) {
  if (!(delta_m > 0) || !(lambda_m > 0)) return 0;
  const N = 2 * delta_m / lambda_m;
  const x = Math.sqrt(2 * Math.PI * N);
  const il = 20 * Math.log10(x / Math.tanh(x));
  return Math.min(MAEKAWA_IL_MAX_DB, Math.max(0, il));
}

// Delivered power ratio (relative to the unobstructed direct field) of one
// diffracted bypass path: 10^(−(IL + extra-spread)/10). extraSpread accounts
// for the longer detour length.
function bypassPowerRatio(il_db, detour_m, directLen_m) {
  const spread = detour_m > directLen_m ? 20 * Math.log10(detour_m / directLen_m) : 0;
  return Math.pow(10, -(il_db + spread) / 10);
}

// Per-structure delivered-power ratio at one band, combining diffraction
// (path 1) + transmission (path 2). Returns a number in (0, 1]; 1 = no effect.
function structureDeliveredRatio(s, S, R, blocking, lambda_m, tl_db) {
  const directLen = Math.max(0.1, Math.hypot(R.x - S.x, R.y - S.y, R.z - S.z));
  const { base, top } = blocking;

  // --- Diffraction bypasses -------------------------------------------------
  let diffractionRatio = 0;
  const axis = lengthAxis(s);
  // Perpendicular (in plan) to the structure's length axis.
  const nperp = { x: -axis.y, y: axis.x };

  if (s.type === 'pillar') {
    // FINITE column — sound wraps around BOTH vertical side edges; the two
    // bypasses are simultaneous real paths, energy-summed (Dr. Chen: the
    // +3 dB "two ways around"). Side edges sit at the silhouette tangents
    // perpendicular to the S→R line.
    const C = { x: s.position.x, y: s.position.y };
    const dir = { x: R.x - S.x, y: R.y - S.y };
    const dlen = Math.hypot(dir.x, dir.y) || 1;
    const perp = { x: -dir.y / dlen, y: dir.x / dlen };
    // Silhouette half-width perpendicular to the ray.
    let halfW;
    const circle = structureFootprintCircle(s);
    if (circle) {
      halfW = circle.r;
    } else {
      // Project footprint corners onto perp; half-width = max |projection|.
      halfW = 0;
      for (const c of structureFootprintCorners(s)) {
        const p = Math.abs((c.x - C.x) * perp.x + (c.y - C.y) * perp.y);
        if (p > halfW) halfW = p;
      }
    }
    for (const sgn of [-1, 1]) {
      const ex = C.x + sgn * halfW * perp.x;
      const ey = C.y + sgn * halfW * perp.y;
      const E1 = { x: ex, y: ey, z: base };
      const E2 = { x: ex, y: ey, z: top };
      const opt = diffractionPointOnEdge(S, R, E1, E2);
      if (!opt) continue;
      const il = finiteEdgeIL(opt.delta, lambda_m);
      diffractionRatio += bypassPowerRatio(il, opt.detour, directLen);
    }
  } else {
    // PLANAR barrier (half-wall / partition / beam / platform riser). The
    // candidate bypasses are: over the TOP (semi-infinite screen, floored
    // thick-barrier IL) and around each vertical END (finite wrap, no floor).
    // Per ISO 9613-2 §7.4.2 keep the SINGLE dominant bypass (max delivered).
    const candidates = [];

    // Over-the-top bypass (skipped for a full-height partition — it reaches
    // the ceiling, so there is no over-top path, only around-the-ends + TL).
    if (s.type !== 'partition') {
      const C = { x: s.position.x, y: s.position.y };
      const d1 = Math.abs((S.x - C.x) * nperp.x + (S.y - C.y) * nperp.y);
      const d2 = Math.abs((R.x - C.x) * nperp.x + (R.y - C.y) * nperp.y);
      const edgeRef = s.type === 'beam' ? base : top;   // beams diffract under the bottom edge
      const delta = overBarrierPathDifference({
        sourceH: S.z, barrierH: edgeRef, sourceToBarrier: d1, barrierToReceiver: d2, receiverH: R.z,
      });
      const il = thickBarrierIL(delta, lambda_m, Number(s.thickness_m) || Number(s.depth_m) || 0.12);
      if (il > 0) {
        const detour = directLen + Math.max(0, delta);
        candidates.push(bypassPowerRatio(il, detour, directLen));
      } else {
        candidates.push(1);   // lit over the top → no attenuation on this path
      }
    }

    // Around each END (finite vertical edge at the two ends of the length axis).
    const { lx } = structurePlanSize(s);
    const half = lx / 2;
    for (const sgn of [-1, 1]) {
      const ex = s.position.x + sgn * half * axis.x;
      const ey = s.position.y + sgn * half * axis.y;
      const E1 = { x: ex, y: ey, z: base };
      const E2 = { x: ex, y: ey, z: top };
      const opt = diffractionPointOnEdge(S, R, E1, E2);
      if (!opt) continue;
      const il = finiteEdgeIL(opt.delta, lambda_m);
      candidates.push(bypassPowerRatio(il, opt.detour, directLen));
    }

    for (const c of candidates) if (c > diffractionRatio) diffractionRatio = c;
  }

  // --- Transmission through the mass (parallel path) ------------------------
  //   • finite TL > 0  → leaks 10^(−TL/10) of the field through the body.
  //   • finite TL ≤ 0  → an "open" material (e.g. a doorway): fully transparent.
  //   • TL unknown (no material row / no TL array) → OPAQUE through-path, so the
  //     diffraction shadow still governs. A solid structure must never become
  //     acoustically invisible just because its TL couldn't be resolved — that
  //     would silently drop the user's structure from the result.
  let transmissionRatio;
  if (!Number.isFinite(tl_db)) transmissionRatio = 0;
  else if (tl_db > 0) transmissionRatio = Math.pow(10, -tl_db / 10);
  else transmissionRatio = 1;

  // Energy-sum, capped at the direct field (an obstacle attenuates, never
  // amplifies — the cap is what makes a narrow pillar transparent at LF).
  return Math.min(1, diffractionRatio + transmissionRatio);
}

// -------------------------------------------------------------------------
// Public: per-band direct-path loss from all blocking structures
// -------------------------------------------------------------------------

/**
 * Per-band direct-path loss (dB) from every building structure that blocks the
 * source→listener segment. Returns Float32Array(bands_hz.length), all-zero when
 * nothing blocks. Multiple structures are treated as independent series
 * barriers (their dB losses add).
 *
 * @param {{x,y,z}} srcPos
 * @param {{x,y,z}} listenerPos
 * @param {Array}   structures        state.structures
 * @param {Map}     materialMap       Map<materialId, rawMaterialRow> (TL + α)
 * @param {number[]} bands_hz         octave-band centres
 * @param {object}  room              for ceiling height / full-height extents
 * @param {number}  temperature_C
 * @returns {Float32Array}
 */
export function structureDirectPathLossPerBand(srcPos, listenerPos, structures, materialMap, bands_hz, room, temperature_C = DEFAULT_TEMPERATURE_C) {
  const B = bands_hz?.length ?? 7;
  const out = new Float32Array(B);
  if (!Array.isArray(structures) || structures.length === 0) return out;
  if (!srcPos || !listenerPos) return out;
  const S = { x: srcPos.x, y: srcPos.y, z: srcPos.z ?? 0 };
  const R = { x: listenerPos.x, y: listenerPos.y, z: listenerPos.z ?? 0 };
  if (Math.hypot(R.x - S.x, R.y - S.y, R.z - S.z) < 1e-6) return out;
  const c = speedOfSound(temperature_C);

  for (const s of structures) {
    if (!s || !s.position || !STRUCTURE_TYPES.includes(s.type)) continue;
    const blocking = structureBlocks(s, S, R, room);
    if (!blocking) continue;
    const row = materialMap && typeof materialMap.get === 'function' ? materialMap.get(s.materialId) : null;
    const tlBand = row && Array.isArray(row.transmission_loss_db) ? row.transmission_loss_db : null;
    for (let k = 0; k < B; k++) {
      const lambda = c / bands_hz[k];
      const tl = tlBand ? tlBand[k] : null;
      const ratio = structureDeliveredRatio(s, S, R, blocking, lambda, Number.isFinite(tl) ? tl : Infinity);
      const lossDb = ratio > 0 ? -10 * Math.log10(ratio) : MAEKAWA_IL_MAX_DB;
      out[k] += Math.max(0, lossDb);
    }
  }
  return out;
}

/**
 * Scalar shorthand: the structure direct-path loss (dB) at the band nearest
 * `freq_hz`. Mirrors furnitureDirectPathLossDb so spl-calculator can call it
 * in the single-band hot loop.
 */
export function structureDirectPathLossDb(srcPos, listenerPos, structures, materialMap, bands_hz, freq_hz, room, temperature_C = DEFAULT_TEMPERATURE_C) {
  if (!Array.isArray(bands_hz) || bands_hz.length === 0) return 0;
  const perBand = structureDirectPathLossPerBand(srcPos, listenerPos, structures, materialMap, bands_hz, room, temperature_C);
  return perBand[nearestBandIdx(bands_hz, freq_hz)] || 0;
}

// -------------------------------------------------------------------------
// Public: reverberant absorption sink (path 3)
// -------------------------------------------------------------------------

// Exposed surface area (m²) of a structure that faces the room interior.
export function structureExposedArea(s, room) {
  const { base, top } = structureHeightRange(s, room);
  const h = Math.max(0, top - base);
  switch (s.type) {
    case 'pillar': {
      if (s.crossSection === 'round') {
        const d = Number(s.diameter_m) || 0.4;
        return Math.PI * d * h;
      }
      if (s.crossSection === 'polygon') {
        const R = (Number(s.diameter_m) || 0.4) / 2;
        const n = Math.max(3, Math.min(12, Number(s.sides) || 6));
        const side = 2 * R * Math.sin(Math.PI / n);
        return n * side * h;
      }
      const w = Number(s.width_m) || Number(s.diameter_m) || 0.4;
      const dep = Number(s.depth_m) || w;
      return 2 * (w + dep) * h;
    }
    case 'half_wall':
    case 'partition': {
      const len = Number(s.length_m) || 3;
      const th = Number(s.thickness_m) || 0.12;
      // Two large faces + (for a half-wall) the exposed top cap + two ends.
      const ends = 2 * th * h;
      const topCap = s.type === 'half_wall' && !s.fullHeight ? len * th : 0;
      return 2 * len * h + ends + topCap;
    }
    case 'beam': {
      const len = Number(s.length_m) || 5;
      const w = Number(s.width_m) || 0.3;
      // Two sides + the bottom soffit face (top is against the ceiling).
      return 2 * len * h + len * w;
    }
    case 'platform': {
      const w = Number(s.width_m) || 3;
      const dep = Number(s.depth_m) || 2;
      // Top deck + the riser sides.
      return w * dep + 2 * (w + dep) * h;
    }
    default:
      return 0;
  }
}

/**
 * Sum equivalent absorption area (m² Sabine) across all placed structures at
 * one octave band. α resolves from the same materials catalogue the room
 * surfaces use, via the `alphaAt(materialId, bandIndex)` closure (so this
 * module stays decoupled from the catalogue shape — mirrors rack-absorption).
 *
 * @param {Array}    structures   state.structures
 * @param {object}   room         for full-height extents
 * @param {Function} alphaAt      (materialId, bandIndex) => α (0..1)
 * @param {number}   bandIndex    octave-band index
 * @returns {number} Σ (exposed area × α) in m² Sabine
 */
export function sumStructureAbsorption(structures, room, alphaAt, bandIndex) {
  if (!Array.isArray(structures) || structures.length === 0) return 0;
  if (typeof alphaAt !== 'function') return 0;
  let total = 0;
  for (const s of structures) {
    if (!s || !STRUCTURE_TYPES.includes(s.type)) continue;
    const alpha = alphaAt(s.materialId, bandIndex);
    if (!Number.isFinite(alpha) || alpha <= 0) continue;
    const area = structureExposedArea(s, room);
    if (area > 0) total += area * alpha;
  }
  return total;
}

// Test/diagnostic export.
export const _testing = {
  finiteEdgeIL,
  structureBlocks,
  segPolyTRange,
  structureDeliveredRatio,
  speedOfSound,
};
