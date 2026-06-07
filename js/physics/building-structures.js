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
// 'toilet' is a COMPOSITE structure (a bank of N cubicles sharing dividing
// partitions). It is recognised here so it round-trips, draws its bank-outline
// footprint, and is enumerated by the walk-collision registry — but its
// acoustic loss model (open/closed-top dB) is PHASE 2: structureExposedArea
// returns 0 for it for now, and the direct-path loss loop skips it. The
// renderer + (later) physics expand it into constituent surfaces via the pure
// expandToiletSurfaces() expander below.
export const STRUCTURE_TYPES = ['pillar', 'half_wall', 'partition', 'beam', 'platform', 'toilet'];

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
    case 'toilet': {
      const g = toiletGeom(s);
      return { lx: g.lx, ly: g.ly };
    }
    default:
      return { lx: 0.4, ly: 0.4 };
  }
}

// -------------------------------------------------------------------------
// Toilet cubicle bank — composite structure geometry (Phase 1).
// A 'toilet' is ONE placeable/rotatable object that expands into N cubicles
// sharing dividing partitions. position = plan CENTRE of the bank; rotation_deg
// rotates the whole bank about that centre. All metres / state coords.
//
//   • Cubicle pitch = clearWidth + partitionThickness (centre-to-centre).
//   • N cubicles → N+1 shared dividing partitions (run in the DEPTH direction;
//     the wall between two cubicles is shared — drawn ONCE) + 1 continuous rear
//     wall + N front door openings.
//   • OPEN-top: side+rear boards span scuffGap → openTopBoardH (floor gap under
//     the boards, open above to the room). No ceiling slab.
//   • CLOSED-top: boards run floor → the REAL room ceiling (base elev, top
//     room.height_m). The side boards themselves seal the cubicle to the
//     structural ceiling — there is NO floating ceiling slab (DEFECT 1, v=773).
//     The front is sealed top-to-ceiling by a transom panel above each door.
//
// Local frame (before rotation): bank centred at origin. Local +x runs along the
// row of cubicles (the bank's long axis); local +y runs front→rear (the door
// openings face local −y "front", the rear wall sits at local +y "rear").
// -------------------------------------------------------------------------

function toiletGeom(s) {
  const cubicles = Math.max(1, Math.min(20, Math.round(Number(s.cubicles) || 3)));
  const clearWidth = Number(s.clearWidth_m) > 0 ? Number(s.clearWidth_m) : 0.90;
  const clearDepth = Number(s.clearDepth_m) > 0 ? Number(s.clearDepth_m) : 1.50;
  const partTh = Number(s.partitionThickness_m) > 0 ? Number(s.partitionThickness_m) : 0.05;
  const pitch = clearWidth + partTh;                 // centre-to-centre
  const lx = cubicles * pitch + partTh;              // bank outer width
  const ly = clearDepth + 2 * partTh;                // bank outer depth (~1.60)
  return { cubicles, clearWidth, clearDepth, partTh, pitch, lx, ly };
}

// Shared front-face door layout (v=774). The SAME hinge/leaf/filler math feeds
// (a) the 3D door swing in expandToiletSurfaces, (b) the 2D + print plan
// door-leaf + swing-arc in toiletPlanSegments. Factored out so the 3D leaf and
// the plan arc pivot from the IDENTICAL hinge point — a drift here would make
// the swing arc miss the rendered door.
//
// Local frame: u runs along the row (+x), front plane at v = vFront. Composition
// from the HINGE jamb inward: [ hingeReveal | (optional filler) | leaf | latchGap ].
// At the default (no custom doorLeafW_m) fillerW === 0 and the leaf fills the
// opening (≈0.88 m).
function toiletFrontLayout(s) {
  const g = toiletGeom(s);
  const { clearWidth, partTh, pitch, lx } = g;
  const latchGap = Number(s.frontLatchGap_m) >= 0 ? Number(s.frontLatchGap_m) : 0.010;
  const hingeReveal = Number(s.hingeReveal_m) >= 0 ? Number(s.hingeReveal_m) : 0.010;
  const fillLeafW = Math.max(0, clearWidth - latchGap - hingeReveal);
  let leafW = Number(s.doorLeafW_m) > 0 ? Math.min(Number(s.doorLeafW_m), fillLeafW) : fillLeafW;
  let fillerW = clearWidth - leafW - latchGap - hingeReveal;
  if (fillerW < 1e-9) fillerW = 0;
  const hingeLeft = (s.hingeSide ?? 'left') !== 'right';
  const sgn = hingeLeft ? +1 : -1;
  const cubicleU = (i) => -lx / 2 + partTh + clearWidth / 2 + i * pitch;
  // Hinge sits a reveal in from the hinge jamb, then (if any) the filler, then
  // the leaf runs toward the latch jamb. hingeU is the LEAF pivot — the same
  // point the 3D door group and the plan swing-arc rotate about.
  const hingeU = (i) => {
    const cu = cubicleU(i);
    const jambLeftU = cu - clearWidth / 2;
    const jambRightU = cu + clearWidth / 2;
    const hingeJambU = hingeLeft ? jambLeftU : jambRightU;
    return hingeJambU + sgn * (hingeReveal + fillerW);
  };
  // Filler centre U (only meaningful when fillerW > 0). The filler sits between
  // the hinge reveal and the leaf: from (hinge jamb + reveal) inward by fillerW.
  const fillerU = (i) => {
    const cu = cubicleU(i);
    const jambLeftU = cu - clearWidth / 2;
    const jambRightU = cu + clearWidth / 2;
    const hingeJambU = hingeLeft ? jambLeftU : jambRightU;
    return hingeJambU + sgn * (hingeReveal + fillerW / 2);
  };
  return { leafW, fillerW, latchGap, hingeReveal, hingeLeft, sgn, hingeU, fillerU, cubicleU, g };
}

// Vertical board extents { base, top } for the side/rear boards, given top-type
// and the room ceiling.
//   • OPEN-top: scuff gap under the boards (base = elev + scuffGap), top at
//     openTopBoardH (clamped to ceiling). Open above to the room.
//   • CLOSED-top: boards run floor → REAL room ceiling (base = elev, top = ceil).
//     No floating ceiling slab — the side boards themselves seal the cubicle to
//     the structural ceiling (DEFECT 1 fix, v=773).
function toiletBoardRange(s, room) {
  const ceil = Number(room?.height_m) || 3;
  const elev = Number(s.elev_m) || 0;
  if (s.topType === 'closed') {
    return { base: elev, top: ceil };   // floor → real ceiling, no slab
  }
  // open-top: scuff gap under the boards, open above to the room.
  const scuff = Number(s.scuffGap_m) >= 0 ? Number(s.scuffGap_m) : 0.15;
  const want = Number(s.openTopBoardH_m) > 0 ? Number(s.openTopBoardH_m) : 2.00;
  return { base: elev + scuff, top: Math.min(ceil, elev + want) };
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
    case 'toilet':
      // Overall vertical envelope of the bank (board base → board top). Used by
      // structureExposedArea (Phase 2) + as a coarse vertical gate. The per-
      // cubicle walk-collision uses the same board range; door/bowl colliders
      // refine within it.
      return toiletBoardRange(s, room);
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
    // PHASE 2: toilet-bank acoustic loss (open/closed-top dB, per-surface TL)
    // is not modelled yet. Skip it here so the bank's outer rectangle is NOT
    // treated as a solid box on the direct path. The expander inventory is
    // ready (expandToiletSurfaces) for Phase 2 to consume.
    if (s.type === 'toilet') continue;
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
    case 'toilet':
      // PHASE 2: the open/closed-top exposed-area + per-surface absorption model
      // is not wired yet. Returning 0 keeps RT60 / the room constant NaN-free
      // until Phase 2 consumes the expandToiletSurfaces() inventory. (The
      // direct-path loss loop in structureDirectPathLossPerBand also skips
      // 'toilet' for now — see the guard there.)
      return 0;
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

/**
 * PURE expander — turn one 'toilet' bank into its constituent surfaces, in
 * WORLD (state) coordinates (rotation applied). Node-testable, no Three.js. The
 * 3D renderer and (Phase 2) the acoustic loss model both consume this single
 * inventory so they never disagree on "where are the boards / doors / bowls".
 *
 * Local frame (before rotation, bank centred on s.position):
 *   • local +x runs along the row of cubicles (the long axis),
 *   • local +y runs front → rear; DOOR openings face local −y (front), the
 *     REAR wall sits at local +y.
 *
 * @param {object} s    a state.structures entry with type==='toilet'
 * @param {object} room for ceiling-height clamp
 * @returns {{
 *   walls:   Array<{a:{x,y}, b:{x,y}, thickness_m:number, base:number, top:number, isDoorWall:boolean, kind:string, materialId:string}>,
 *   ceilings:Array<...>,   // ALWAYS EMPTY for toilets now (v=773) — kept for API stability
 *   doors:   Array<{cubicleIndex:number, hinge:{x,y}, leafW:number, leafH:number, doorBottom:number, doorTop:number, thickness_m:number, swingDir:number, undercut_m:number, open:boolean, normal:{x,y}, axis:{x,y}}>,
 *   bowls:   Array<{cubicleIndex:number, center:{x,y}, seatH:number, bbox:{lx,ly,h}}>,
 *   meta:    {cubicles, pitch, clearWidth, clearDepth, partTh, lx, ly, topType}
 * }}
 */
export function expandToiletSurfaces(s, room) {
  const g = toiletGeom(s);
  const { cubicles, clearWidth, clearDepth, partTh, pitch, lx, ly } = g;
  const board = toiletBoardRange(s, room);
  const cx = s.position.x, cy = s.position.y;
  const th = deg2rad(s.rotation_deg || 0);
  const cos = Math.cos(th), sin = Math.sin(th);
  // local (u along +x row, v along +y front→rear) → world state coords.
  const toWorld = (u, v) => ({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos });
  // Local front/rear v: bank outer depth is ly; centred on origin.
  const vFront = -ly / 2;      // door side (local −y)
  const vRear = ly / 2;        // rear wall (local +y)
  const materialId = s.materialId || 'gypsum-board';

  // Cubicle i centre (local u); divider j centre (local u).
  const cubicleU = (i) => -lx / 2 + partTh + clearWidth / 2 + i * pitch;
  const dividerU = (j) => -lx / 2 + partTh / 2 + j * pitch;

  const walls = [];
  const ceilings = [];
  const doors = [];
  const bowls = [];

  // --- N+1 shared dividing partitions (run front→rear along local +y) -------
  for (let j = 0; j <= cubicles; j++) {
    const u = dividerU(j);
    walls.push({
      a: toWorld(u, vFront), b: toWorld(u, vRear),
      thickness_m: partTh, base: board.base, top: board.top,
      isDoorWall: false, kind: 'divider', materialId,
    });
  }

  // --- 1 continuous rear wall (runs along local +x at v = vRear) ------------
  walls.push({
    a: toWorld(-lx / 2, vRear), b: toWorld(lx / 2, vRear),
    thickness_m: partTh, base: board.base, top: board.top,
    isDoorWall: false, kind: 'rear', materialId,
  });

  // --- Front face = hinged door leaf (+ optional filler + closed-top transom) ---
  // v=774: the leaf now FILLS the opening so the avatar walks through. Compose
  // the front of each cubicle at the front plane vFront as:
  //   [ 10 mm hinge reveal | (optional filler) | door leaf (leafW) | 10 mm latch
  //     reveal ]   so  hingeReveal + fillerW + leafW + latchGap === clearWidth.
  // At the default fillerW === 0 and leafW ≈ 0.88 (clearWidth − the two reveals).
  // A smaller custom doorLeafW_m re-emits the filler (back-compat). hingeSide
  // 'left' (viewed from outside, looking toward local +y / rear) = local −x jamb
  // of the cubicle. Door swings OUT (toward the front, local −y); the outward
  // normal of the door wall is local −y.
  const ceil = Number(room?.height_m) || 3;
  const elev = Number(s.elev_m) || 0;
  const undercut = Number(s.undercut_m) >= 0 ? Number(s.undercut_m) : 0.30;
  const doorClearH = Number(s.doorClearH_m) > 0 ? Number(s.doorClearH_m) : 2.10;
  const doorThk = Number(s.doorThk_m) > 0 ? Number(s.doorThk_m) : 0.04;
  const doorsOpen = Array.isArray(s.doorsOpen) ? s.doorsOpen : [];

  // Leaf / filler / hinge from the SHARED front layout (v=774). DEFAULT: the
  // leaf fills the opening (leafW = clearWidth − latchGap − hingeReveal ≈ 0.88),
  // fillerW = 0. A smaller custom doorLeafW_m re-emits the hinge-side filler so
  // the front stays gap-free. ACOUSTIC NOTE (Phase 2 / Dr. Chen): the front area
  // split changed — the fixed filler (was 0.29 m) is now 0 at the default and
  // the door leaf grew 0.60 → 0.88 m. Phase 2 must weight the OPEN-door aperture
  // as ~0.88 m (leaf) + the 0.010 m reveals, NOT the old 0.60 m.
  const fl = toiletFrontLayout(s);
  const leafW = fl.leafW;
  const fillerW = fl.fillerW;
  const latchGap = fl.latchGap;

  // Door vertical extent (DEFECT 3 — computed, never exceeds the stall sides).
  const doorBottom = elev + undercut;                 // always undercut off floor
  let doorTop;
  if (s.topType === 'closed') {
    doorTop = Math.min(elev + doorClearH, board.top); // ≤ side-board top (= ceil)
  } else {
    doorTop = board.top;                              // open-top: align to sides
  }
  const leafH = Math.max(0, doorTop - doorBottom);
  // Opening width (leaf + latch reveal) — the transom above spans this.
  const openingW = leafW + latchGap;

  const frontNormalLocal = { x: 0, y: -1 };        // local outward (front)
  const rowAxisLocal = { x: 1, y: 0 };             // along the row
  // hingeSide flips which jamb the hinge sits at within the clear span.
  const hingeLeft = (s.hingeSide ?? 'left') !== 'right';
  // Outward normal + row axis in WORLD coords (rotate the local unit vectors).
  const normal = {
    x: frontNormalLocal.x * cos - frontNormalLocal.y * sin,
    y: frontNormalLocal.x * sin + frontNormalLocal.y * cos,
  };
  const axis = {
    x: rowAxisLocal.x * cos - rowAxisLocal.y * sin,
    y: rowAxisLocal.x * sin + rowAxisLocal.y * cos,
  };
  const sgn = fl.sgn;
  for (let i = 0; i < cubicles; i++) {
    // Fixed front filler (back-compat: only when a smaller custom leaf is set,
    // so fillerW > 0). At the default leaf-fills-opening case this branch is
    // skipped (fillerW === 0). The filler sits between the hinge reveal and the
    // leaf; fillerU(i) is its centre U.
    if (fillerW > 1e-6) {
      const fillerCentreU = fl.fillerU(i);
      const fa = fillerCentreU - sgn * (fillerW / 2);
      const fb = fillerCentreU + sgn * (fillerW / 2);
      walls.push({
        a: toWorld(fa, vFront), b: toWorld(fb, vFront),
        thickness_m: partTh, base: board.base, top: board.top,
        isDoorWall: false, kind: 'frontFiller', materialId,
      });
    }

    // Hinge sits a reveal (+ any filler) in from the hinge jamb; the leaf runs
    // from there toward the latch jamb, stopping latchGap short. hingeU is the
    // SHARED pivot the plan swing-arc reuses (toiletPlanSegments).
    const hingeU = fl.hingeU(i);
    const hinge = toWorld(hingeU, vFront);
    doors.push({
      cubicleIndex: i, hinge,
      leafW, leafH, doorBottom, doorTop, thickness_m: doorThk,
      swingDir: hingeLeft ? -1 : +1,
      undercut_m: undercut,
      open: !!doorsOpen[i],
      normal, axis,
    });

    // CLOSED-top transom: a fixed solid panel above the door opening, spanning the
    // opening width (leaf + latch reveal) from doorTop → ceil, so the closed front
    // is sealed top-to-ceiling. Coplanar with the leaf/filler (same front plane),
    // above the leaf — does not clip the OUT swing.
    if (s.topType === 'closed' && ceil - doorTop > 1e-4 && openingW > 1e-6) {
      // Opening spans from the inner filler edge (hingeU) to latchGap short of the
      // latch jamb; the transom covers leaf+latchGap = openingW from hingeU.
      const ta = hingeU;
      const tb = hingeU + sgn * openingW;
      walls.push({
        a: toWorld(ta, vFront), b: toWorld(tb, vFront),
        thickness_m: partTh, base: doorTop, top: ceil,
        isDoorWall: false, kind: 'transom', materialId,
      });
    }
  }
  // NOTE (DEFECT 1, v=773): no closed-top ceiling slab is emitted. `ceilings`
  // stays EMPTY for toilets — the side boards run to the real ceiling and the
  // transom seals the front. The array is returned for API stability only.

  // --- Toilet bowls: a recognizable WC flush to the rear wall ---------------
  // (DEFECT 4, v=773). The bowl is a 3-primitive WC (tank + pan + seat ring)
  // built by the renderer relative to `center`. Here we expose only the overall
  // bbox + centre so the renderer and the walk-collider agree. The bbox depth
  // (ly 0.62) is fully inside clearDepth (1.50); width 0.36 ≤ clearWidth (0.90).
  // vWall = inner face of the rear board; the tank's back face sits exactly on it
  // (centre y = vWall − 0.08 for a 0.16-deep tank); the bbox centre bowlV is the
  // shared origin the 3 renderer primitives offset from.
  if (s.showBowls !== false) {
    const seatH = Number(s.seatHeight_m) > 0 ? Number(s.seatHeight_m) : 0.42;
    const vWall = vRear - partTh / 2;          // rear board inner face
    const bowlV = vWall - 0.31;                // bbox centre (depth 0.62 → span vWall−0.62 .. vWall)
    for (let i = 0; i < cubicles; i++) {
      bowls.push({
        cubicleIndex: i,
        center: toWorld(cubicleU(i), bowlV),
        seatH,
        bbox: { lx: 0.36, ly: 0.62, h: 0.78 },
      });
    }
  }

  return {
    walls, ceilings, doors, bowls,
    meta: { cubicles, pitch, clearWidth, clearDepth, partTh, lx, ly, topType: s.topType ?? 'open' },
  };
}

/**
 * PURE plan-view primitives for a toilet bank — the architectural floor symbol
 * the 2D viewport + print plan SVG both draw (cubicle dividers + per-cubicle
 * part-open door leaf + quarter-circle door-swing arc + WC plan symbol). Node-
 * testable, NO Three.js / DOM (nymphysics no-outbound-imports invariant).
 *
 * Shares toiletGeom + the toiletFrontLayout hinge/leaf math with
 * expandToiletSurfaces, so the plan door pivots from the IDENTICAL hinge the
 * 3D door swings about. The 2D + print renderers consume this single helper.
 *
 * All coords are STATE coords — already rotated by rotation_deg + translated to
 * s.position, with Y UNFLIPPED (each renderer applies its own Y-flip). Arc
 * angles are in the STATE frame (radians). Primitive kinds:
 *   line    { kind, role, a:{x,y}, b:{x,y} }
 *   arc     { kind, role, center:{x,y}, r, a0, a1, ccw }
 *   ellipse { kind, role, center:{x,y}, rx, ry, rot }   rot = state-frame radians
 *   rect    { kind, role, center:{x,y}, lx, ly, rot }
 *
 * Local frame: origin = bank centre, +x along the row, +y front→rear,
 * vFront = −ly/2 (door side), vRear = +ly/2 (rear wall), vWall = vRear − partTh/2
 * (rear board inner face). The door leaf swings OUT toward −y (front).
 *
 * @param {object} s    a state.structures entry with type==='toilet'
 * @param {object} room (unused today; accepted for signature parity)
 * @returns {{ primitives: Array, meta:{cubicles, lx, ly, rotation_deg} }}
 */
export function toiletPlanSegments(s, room) {
  void room;
  const fl = toiletFrontLayout(s);
  const { leafW, fillerW, sgn, hingeLeft, g } = fl;
  const { cubicles, clearWidth, partTh, pitch, lx, ly } = g;
  const cx = s.position.x, cy = s.position.y;
  const rotDeg = Number(s.rotation_deg) || 0;
  const th = deg2rad(rotDeg);
  const cos = Math.cos(th), sin = Math.sin(th);
  // local (u along +x row, v along +y front→rear) → state coords (rotated +
  // translated, Y UNFLIPPED — each renderer flips Y itself).
  const toState = (u, v) => ({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos });

  const vFront = -ly / 2;          // door side (local −y)
  const vRear = ly / 2;            // rear wall (local +y)
  const vWall = vRear - partTh / 2;   // rear board inner face

  const dividerU = (j) => -lx / 2 + partTh / 2 + j * pitch;

  const prims = [];

  // bank-outline — outer rect lx × ly, rotated to rotDeg, centred on s.position.
  prims.push({ kind: 'rect', role: 'bank-outline', center: { x: cx, y: cy }, lx, ly, rot: th });

  // divider lines × (cubicles+1): each runs front→rear at dividerU(j).
  for (let j = 0; j <= cubicles; j++) {
    const u = dividerU(j);
    prims.push({ kind: 'line', role: 'divider', a: toState(u, vFront), b: toState(u, vRear) });
  }
  // rear wall line (role 'divider'). NO continuous front line (openings there).
  prims.push({ kind: 'line', role: 'divider', a: toState(-lx / 2, vRear), b: toState(lx / 2, vRear) });

  const COS35 = Math.cos(35 * Math.PI / 180);
  const SIN35 = Math.sin(35 * Math.PI / 180);

  for (let i = 0; i < cubicles; i++) {
    const cu = fl.cubicleU(i);
    const hingeU = fl.hingeU(i);

    // front-filler — only when a smaller custom leaf is set (fillerW > 0).
    if (fillerW > 1e-6) {
      const fc = fl.fillerU(i);
      prims.push({
        kind: 'line', role: 'front-filler',
        a: toState(fc - sgn * (fillerW / 2), vFront),
        b: toState(fc + sgn * (fillerW / 2), vFront),
      });
    }

    // door-leaf — drawn part-open ~35°, hinge H at (hingeU, vFront), tip swings
    // OUT toward −y. Open tip (local): u = hingeU + sgn*leafW*cos35,
    // v = vFront − leafW*sin35.
    const H = toState(hingeU, vFront);
    const tip = toState(hingeU + sgn * leafW * COS35, vFront - leafW * SIN35);
    prims.push({ kind: 'line', role: 'door-leaf', a: H, b: tip });

    // door-swing arc — centre H, r = leafW, quarter circle from CLOSED (along
    // the front, toward the latch) to fully-open OUT (toward −y). In the LOCAL
    // frame the closed leaf points along +sgn·u (a0 = hingeLeft?0:π) and the open
    // leaf points along −v (−π/2). Rotate the angles into the STATE frame by th.
    const a0Local = hingeLeft ? 0 : Math.PI;
    const a1Local = -Math.PI / 2;
    prims.push({
      kind: 'arc', role: 'door-swing',
      center: H, r: leafW,
      a0: a0Local + th, a1: a1Local + th,
      ccw: !hingeLeft,
    });

    // wc-cistern — rect against the rear wall, between the pan and the rear.
    prims.push({
      kind: 'rect', role: 'wc-cistern',
      center: toState(cu, vWall - 0.08), lx: 0.36, ly: 0.16, rot: th,
    });
    // wc-pan — ellipse in front of the cistern.
    prims.push({
      kind: 'ellipse', role: 'wc-pan',
      center: toState(cu, vWall - 0.435), rx: 0.18, ry: 0.275, rot: th,
    });
  }

  return {
    primitives: prims,
    meta: { cubicles, lx, ly, rotation_deg: rotDeg },
  };
}

// Test/diagnostic export.
export const _testing = {
  finiteEdgeIL,
  structureBlocks,
  segPolyTRange,
  structureDeliveredRatio,
  speedOfSound,
  toiletGeom,
  toiletBoardRange,
};
