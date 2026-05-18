// Outdoor obstacle path-loss module for the fast SPL engine.
//
// The HEATMAP engine (spl-calculator.js) historically only knew about
// ROOM walls via wall-path.js. Outdoor structures — minaret, arcade
// columns, portico walls — were invisible to it, so listeners standing
// behind them got the same SPL as listeners in clear air. The precision
// tracer (BVH route) sees them, but the heatmap doesn't.
//
// This module adds the missing pathway. Per Dr. Chen sign-off
// (2026-05-18):
//   • COLUMNS  → Maekawa edge-diffraction only, no transmission loss.
//     1.2 m or 0.3 m wide concrete columns are too narrow to give a real
//     50 dB TL shadow; waves diffract AROUND them. Take the shorter of
//     the two bracketing-edge detours per ISO 9613-2 §7.4.
//   • WALLS    → parallel sum of TL through and Maekawa over/around.
//     10·log10(10^(-TL/10) + 10^(-IL/10)) per ISO 17497-1 §5.2.
//   • MULTIPLE in-line columns → max(IL_i) capped at 8 dB. NOT additive.
//     Cox & D'Antonio §3.5; Pierce §9.3 empirical cascade.
//
// Standards: IEC 60268-16, ISO 9613-2 §7.4 (Maekawa), ISO 17497-1 §5.2
// (parallel TL+diffraction sum), Cox & D'Antonio §3.5 (small obstacles),
// Pierce *Acoustics* §9.2–9.3 (edge diffraction, cascade).
//
// Performance: each heatmap cell × source iterates the obstacle list.
// For the surau preset that's 25 obstacles × 10 sources × 2500 cells =
// 625k cheap checks per heatmap render. Plan-view AABB pre-test rejects
// >90 % in <50 ns each; only the remaining few pay the Maekawa cost.

import { maekawaIL, diffractionPointOnEdge } from './diffraction.js';
import { transmissionLossDb, bandIndexForFreq } from './wall-path.js';

const SPEED_OF_SOUND_M_S = 343;                // 20 °C, dry air
const COLUMN_CASCADE_CAP_DB = 8;               // Pierce §9.3 empirical cap

// Build the outdoor-obstacle list from a state.room.surauStructure block.
// Returns [] for non-surau presets. Each obstacle has:
//   { id, type: 'column' | 'wall',
//     cx, cy,              // plan-view centre (state coords)
//     halfX, halfY,        // half-extents along world x / y
//     base_z, top_z,       // vertical extent
//     material }           // looked up in materials catalogue for TL term
export function extractOutdoorObstacles(room) {
  if (!room || room.shape !== 'rectangular') return [];
  const s = room.surauStructure;
  if (!s) return [];
  const W = Number(room.width_m), D = Number(room.depth_m);
  if (!(W > 0 && D > 0)) return [];
  const out = [];

  // ----- Minaret (1 square column) -----
  if (s.minaret) {
    const mn = s.minaret;
    const baseSize = Number.isFinite(mn.base_size_m) ? mn.base_size_m : 1.2;
    const totalH   = Number.isFinite(mn.height_m)    ? mn.height_m    : 8.5;
    const shaftH   = totalH * 0.90;
    const clearance = 0.6 + baseSize / 2;
    const cornerOffsets = {
      SW: { x: -clearance,    y: -clearance    },
      SE: { x: W + clearance, y: -clearance    },
      NW: { x: -clearance,    y: D + clearance },
      NE: { x: W + clearance, y: D + clearance },
    };
    const co = cornerOffsets[mn.corner || 'NW'] || cornerOffsets.NW;
    const half = baseSize / 2;
    const matId = s.materials?.minaret || mn.materialId || 'concrete-painted';
    out.push({
      id: 'surau_minaret',
      type: 'column',
      cx: co.x, cy: co.y,
      halfX: half, halfY: half,
      base_z: 0, top_z: shaftH,
      material: matId,
    });
  }

  // ----- Arcade columns (bay-edge + corner posts) -----
  if (s.arcade?.sides?.length) {
    const ar = s.arcade;
    const depth  = Number.isFinite(ar.depth_m) ? ar.depth_m : 3.0;
    const bayW   = Number.isFinite(ar.column_spacing_m) ? ar.column_spacing_m : 2.8;
    const colT   = Number.isFinite(ar.column_thickness_m) ? ar.column_thickness_m : 0.30;
    const roofH  = Number.isFinite(ar.roof_height_m) ? ar.roof_height_m : 4.4;
    const matId  = s.materials?.arcade_columns || 'concrete-painted';
    const half   = colT / 2;
    const sideSpec = {
      south: { p1: [0, 0], p2: [W, 0], sx: 1,  sy: 0,  perpX: 0,  perpY: -1 },
      east:  { p1: [W, 0], p2: [W, D], sx: 0,  sy: 1,  perpX: 1,  perpY: 0  },
      west:  { p1: [0, 0], p2: [0, D], sx: 0,  sy: 1,  perpX: -1, perpY: 0  },
      north: { p1: [0, D], p2: [W, D], sx: 1,  sy: 0,  perpX: 0,  perpY: 1  },
    };
    // Bay-edge columns: same math as the BVH / renderer (nBays+1 per side).
    const outwardDist = depth - colT / 2;
    for (const sideName of ar.sides) {
      const spec = sideSpec[sideName];
      if (!spec) continue;
      const dx = spec.p2[0] - spec.p1[0];
      const dy = spec.p2[1] - spec.p1[1];
      const sideLen = Math.hypot(dx, dy);
      if (sideLen < bayW) continue;
      const startInset = depth * 0.5, endInset = depth * 0.5;
      const usableLen = sideLen - startInset - endInset;
      if (usableLen < bayW) continue;
      const nBays = Math.max(1, Math.floor(usableLen / bayW));
      const actualBayW = usableLen / nBays;
      for (let ci = 0; ci <= nBays; ci++) {
        const u = startInset + ci * actualBayW;
        const ux = spec.p1[0] + spec.sx * u;
        const uy = spec.p1[1] + spec.sy * u;
        const cx = ux + spec.perpX * outwardDist;
        const cy = uy + spec.perpY * outwardDist;
        out.push({
          id: `surau_arcade_column_${sideName[0].toUpperCase()}_${ci}`,
          type: 'column',
          cx, cy,
          halfX: half, halfY: half,
          base_z: 0, top_z: roofH,
          material: matId,
        });
      }
    }
    // Corner posts (added 2026-05-18, see scene.js arcade builder).
    const cornerSpecs = [];
    const wrapped = new Set(ar.sides);
    if (wrapped.has('south') && wrapped.has('east')) {
      cornerSpecs.push({ cx: W - depth * 0.5, cy: -depth,        id: 'SE_S' });
      cornerSpecs.push({ cx: W + depth,        cy: depth * 0.5,  id: 'SE_E' });
    }
    if (wrapped.has('south') && wrapped.has('west')) {
      cornerSpecs.push({ cx: depth * 0.5,      cy: -depth,       id: 'SW_S' });
      cornerSpecs.push({ cx: -depth,           cy: depth * 0.5,  id: 'SW_W' });
    }
    if (wrapped.has('north') && wrapped.has('east')) {
      cornerSpecs.push({ cx: W - depth * 0.5, cy: D + depth,     id: 'NE_N' });
      cornerSpecs.push({ cx: W + depth,        cy: D - depth * 0.5, id: 'NE_E' });
    }
    if (wrapped.has('north') && wrapped.has('west')) {
      cornerSpecs.push({ cx: depth * 0.5,      cy: D + depth,    id: 'NW_N' });
      cornerSpecs.push({ cx: -depth,           cy: D - depth * 0.5, id: 'NW_W' });
    }
    for (const cp of cornerSpecs) {
      out.push({
        id: `surau_arcade_column_corner_${cp.id}`,
        type: 'column',
        cx: cp.cx, cy: cp.cy,
        halfX: half, halfY: half,
        base_z: 0, top_z: roofH,
        material: matId,
      });
    }
  }

  // ----- Portico side walls (2 vertical walls flanking the entrance) -----
  // The portico's FRONT wall is acoustically transparent (pointed-arch
  // opening) and the BACK is the south building wall itself. The two
  // SIDE walls are real outdoor obstacles for paths between an outdoor
  // listener and a side source.
  if (s.portico) {
    const po = s.portico;
    const side = po.side || 'south';
    const poW = Number.isFinite(po.width_m)  ? po.width_m  : 3.0;
    const poD = Number.isFinite(po.depth_m)  ? po.depth_m  : 3.0;
    const poH = Number.isFinite(po.height_m) ? po.height_m : 4.5;
    const matId = s.materials?.portico_walls || 'concrete-painted';
    // Anchor + outward direction per scene.js convention.
    const anchors = {
      south: { ax: W / 2, ay: 0, outX: 0,  outY: -1, sideX: 1, sideY: 0 },
      north: { ax: W / 2, ay: D, outX: 0,  outY:  1, sideX: 1, sideY: 0 },
      east:  { ax: W, ay: D / 2, outX: 1,  outY: 0,  sideX: 0, sideY: 1 },
      west:  { ax: 0, ay: D / 2, outX: -1, outY: 0,  sideX: 0, sideY: 1 },
    };
    const a = anchors[side];
    if (a) {
      const halfW = poW / 2;
      // Two SIDE walls — each is a thin rectangle along the outward
      // direction, of length poD and thickness ~0.20 m. Place each side
      // wall centred at (anchor ± halfW · sideDir) + halfD · outwardDir.
      const thickness = 0.20;
      for (const sgn of [-1, 1]) {
        const cx = a.ax + sgn * halfW * a.sideX + (poD / 2) * a.outX;
        const cy = a.ay + sgn * halfW * a.sideY + (poD / 2) * a.outY;
        // The wall's long axis runs along outward direction; its thin
        // axis runs along sideDir. Half-extents in world XY:
        const halfX = Math.abs(a.outX) * (poD / 2) + Math.abs(a.sideX) * (thickness / 2);
        const halfY = Math.abs(a.outY) * (poD / 2) + Math.abs(a.sideY) * (thickness / 2);
        out.push({
          id: `surau_portico_wall_${side}_${sgn < 0 ? 'L' : 'R'}`,
          type: 'wall',
          cx, cy, halfX, halfY,
          base_z: 0, top_z: poH,
          material: matId,
        });
      }
    }
  }

  return out;
}

// Plan-view AABB test for "does the segment S→R cross the obstacle's
// footprint?" Fast reject: if the segment's bbox doesn't overlap the
// obstacle's, skip. Then a parametric line-vs-AABB test.
function segmentCrossesFootprint(sx, sy, rx, ry, ob) {
  const x0 = ob.cx - ob.halfX, x1 = ob.cx + ob.halfX;
  const y0 = ob.cy - ob.halfY, y1 = ob.cy + ob.halfY;
  // Quick segment-bbox vs obstacle-bbox overlap test.
  if (Math.max(sx, rx) < x0 || Math.min(sx, rx) > x1) return false;
  if (Math.max(sy, ry) < y0 || Math.min(sy, ry) > y1) return false;
  // Parametric Liang-Barsky-style clip — does the line segment intersect the AABB?
  const dx = rx - sx, dy = ry - sy;
  let tMin = 0, tMax = 1;
  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (sx < x0 || sx > x1) return false;
  } else {
    const t1 = (x0 - sx) / dx;
    const t2 = (x1 - sx) / dx;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return false;
  }
  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (sy < y0 || sy > y1) return false;
  } else {
    const t1 = (y0 - sy) / dy;
    const t2 = (y1 - sy) / dy;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return false;
  }
  return tMin < 1 && tMax > 0;
}

// For a square footprint, find the two vertical corner edges that
// BRACKET the source-to-receiver line in plan view (Dr. Chen Q2:
// cross-product test, edges with opposite signs). Returns the two
// edge endpoints in 3D (z covers the obstacle's full vertical extent).
function bracketingEdges(src, listener, ob) {
  const x0 = ob.cx - ob.halfX, x1 = ob.cx + ob.halfX;
  const y0 = ob.cy - ob.halfY, y1 = ob.cy + ob.halfY;
  const corners = [
    { x: x0, y: y0 }, { x: x1, y: y0 },
    { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
  const dx = listener.x - src.x, dy = listener.y - src.y;
  // Signed cross of (R − S) with (corner − S). Positive = corner is LEFT
  // of the S→R line in standard math orientation (CCW), negative = RIGHT.
  const signs = corners.map(c => {
    const cx = c.x - src.x, cy = c.y - src.y;
    return Math.sign(dx * cy - dy * cx);
  });
  let leftCorner = null, rightCorner = null;
  // Pick the LEFT-side corner with max |distance from line| and the
  // RIGHT-side corner with max |distance from line|. These are the
  // bracketing edges per Dr. Chen Q2 / ISO 9613-2 §7.4 finite-width case.
  let leftMax = -1, rightMax = -1;
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    const cx = c.x - src.x, cy = c.y - src.y;
    const cross = dx * cy - dy * cx;
    const segLen = Math.hypot(dx, dy);
    const perpDist = Math.abs(cross) / Math.max(segLen, 1e-9);
    if (signs[i] > 0 && perpDist > leftMax) { leftMax = perpDist; leftCorner = c; }
    if (signs[i] < 0 && perpDist > rightMax) { rightMax = perpDist; rightCorner = c; }
  }
  if (!leftCorner || !rightCorner) return null;  // S→R line outside footprint
  return {
    left: {
      E1: { x: leftCorner.x, y: leftCorner.y, z: ob.base_z },
      E2: { x: leftCorner.x, y: leftCorner.y, z: ob.top_z },
    },
    right: {
      E1: { x: rightCorner.x, y: rightCorner.y, z: ob.base_z },
      E2: { x: rightCorner.x, y: rightCorner.y, z: ob.top_z },
    },
  };
}

// Filter the obstacle list to those whose footprint is crossed by the
// source-listener segment in plan view. Optionally pre-rejects obstacles
// the path is "above" — if min(z_src, z_listener) > obstacle.top_z, the
// path goes above the obstacle and there's no edge shadow.
export function obstaclesCrossedByPath(src, listener, obstacles) {
  if (!obstacles?.length) return [];
  const minPathZ = Math.min(src.z, listener.z);
  const out = [];
  for (const ob of obstacles) {
    if (minPathZ > ob.top_z + 0.05) continue;             // path clears top
    if (Math.max(src.z, listener.z) < ob.base_z - 0.05) continue;  // below base
    if (!segmentCrossesFootprint(src.x, src.y, listener.x, listener.y, ob)) continue;
    out.push(ob);
  }
  return out;
}

// Compute the diffraction insertion loss (dB) for a single obstacle.
// COLUMN: Maekawa, taking min(δ_left, δ_right) per Dr. Chen Q2.
// WALL:   parallel sum of through-wall TL and over/around Maekawa.
function singleObstacleIL(src, listener, ob, freq_hz, materials) {
  const edges = bracketingEdges(src, listener, ob);
  if (!edges) return 0;
  const lambda = SPEED_OF_SOUND_M_S / freq_hz;

  // Diffraction term — Maekawa around the column / wall edges.
  const dL = diffractionPointOnEdge(src, listener, edges.left.E1, edges.left.E2);
  const dR = diffractionPointOnEdge(src, listener, edges.right.E1, edges.right.E2);
  const deltaL = dL ? dL.delta : Infinity;
  const deltaR = dR ? dR.delta : Infinity;
  const minDelta = Math.min(deltaL, deltaR);
  if (!Number.isFinite(minDelta)) return 0;
  const il_diffr = maekawaIL(minDelta, lambda);

  if (ob.type === 'column') {
    // Maekawa-only, no TL term. Per Dr. Chen — 1.2 m wide column has
    // negligible mass-law TL contribution; waves diffract around.
    return il_diffr;
  }

  // WALL: parallel sum of TL and IL (ISO 17497-1 §5.2).
  // Through-wall TL needs the materials catalogue. If absent, default
  // to a flat 30 dB so the wall still blocks (legacy back-compat).
  let tl_db = 30;
  if (materials) {
    const bandIdx = bandIndexForFreq(materials, freq_hz);
    tl_db = transmissionLossDb([{ material_id: ob.material }], materials, bandIdx);
  }
  // Parallel-power sum: total IL = -10·log10(10^(-TL/10) + 10^(-IL/10)).
  const eTL = Math.pow(10, -tl_db / 10);
  const eIL = Math.pow(10, -il_diffr / 10);
  return -10 * Math.log10(eTL + eIL);
}

// Total outdoor-obstacle attenuation for a source→listener path at
// a given frequency. Returns positive dB to SUBTRACT from the direct-
// field SPL.
//
// For COLUMNS: takes max(IL_i) across all crossed columns, capped at
// COLUMN_CASCADE_CAP_DB (Dr. Chen Q1 — Pierce §9.3 empirical cap).
// For WALLS:   takes max(IL_i) — multiple walls on the same path are
// rare; the worst (closest geometric shadow) dominates.
//
// `obstacles` is the pre-extracted list. Callers extract once per render
// (extractOutdoorObstacles(room)) and pass it down the hot loop.
export function outdoorObstacleLossDb({
  src, listener, freq_hz, obstacles, materials = null,
}) {
  const crossed = obstaclesCrossedByPath(src, listener, obstacles);
  if (crossed.length === 0) return 0;
  let maxColumnIL = 0;
  let maxWallIL = 0;
  for (const ob of crossed) {
    const il = singleObstacleIL(src, listener, ob, freq_hz, materials);
    if (ob.type === 'column') {
      if (il > maxColumnIL) maxColumnIL = il;
    } else if (ob.type === 'wall') {
      if (il > maxWallIL) maxWallIL = il;
    }
  }
  // Cap the column cascade per Dr. Chen.
  const columnTotal = Math.min(maxColumnIL, COLUMN_CASCADE_CAP_DB);
  // Walls and columns combine in series (different obstacles) — add dB.
  return columnTotal + maxWallIL;
}
