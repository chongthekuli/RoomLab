// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// js/physics/overhead-geometry.js
//
// Pure geometry — extracts overhead horizontal reflector polygons from
// `room.surauStructure`. Consumed by BOTH:
//   - overhead-reflection.js (image-source first-order reflection)
//   - wall-path.js (roof acts as a horizontal transmissive surface when
//     a path crosses z = roof_height)
//
// Kept in its own module so neither consumer has a circular import
// against spl-calculator.js. Polygons returned in state-frame xy with
// z_top = roof underside height and materialId from
// room.surauStructure.materials.{arcade_roof|portico_roof}.

export function extractOverheadReflectors(room) {
  const out = [];
  const s = room?.surauStructure;
  if (!s) return out;

  // --- Arcade roofs ----------------------------------------------------
  const ar = s.arcade;
  if (ar && Array.isArray(ar.sides) && ar.sides.length > 0) {
    const W = Number(room.width_m) || 0;
    const D = Number(room.depth_m) || 0;
    const depth = Number(ar.depth_m) || 3;
    const roofH = Number(ar.roof_height_m) || 4.45;
    // Compass labels match scene.js sideSpec:
    //   'south' = state-y = 0 face (main entrance side)
    //   'north' = state-y = D face (qibla — never wrapped)
    //   'east'  = state-x = W,  'west' = state-x = 0
    const sideSpec = {
      south: { p1: [0, 0], p2: [W, 0], perp: [0, -1] },
      north: { p1: [0, D], p2: [W, D], perp: [0,  1] },
      east:  { p1: [W, 0], p2: [W, D], perp: [1,  0] },
      west:  { p1: [0, 0], p2: [0, D], perp: [-1, 0] },
    };
    const startInset = depth * 0.5;
    const endInset   = depth * 0.5;
    const matId = s.materials?.arcade_roof || 'gypsum-board';
    for (const sideName of ar.sides) {
      const spec = sideSpec[sideName];
      if (!spec) continue;
      const dxs = spec.p2[0] - spec.p1[0];
      const dys = spec.p2[1] - spec.p1[1];
      const sideLen = Math.hypot(dxs, dys);
      if (sideLen <= startInset + endInset) continue;
      const sx = dxs / sideLen;
      const sy = dys / sideLen;
      const Ax = spec.p1[0] + sx * startInset;
      const Ay = spec.p1[1] + sy * startInset;
      const Bx = spec.p1[0] + sx * (sideLen - endInset);
      const By = spec.p1[1] + sy * (sideLen - endInset);
      const Cx = Bx + spec.perp[0] * depth;
      const Cy = By + spec.perp[1] * depth;
      const Dx = Ax + spec.perp[0] * depth;
      const Dy = Ay + spec.perp[1] * depth;
      out.push({
        kind: 'arcade_roof',
        side: sideName,
        vertices: [
          { x: Ax, y: Ay }, { x: Bx, y: By }, { x: Cx, y: Cy }, { x: Dx, y: Dy },
        ],
        z_top: roofH,
        materialId: matId,
      });
    }
  }

  // --- Portico flat roof — projecting entrance pavilion ----------------
  const por = s.portico;
  if (por) {
    const W = Number(room.width_m) || 0;
    const widthP = Number(por.width_m) || 0;
    const depthP = Number(por.depth_m) || 0;
    const capBaseH = Number(por.cap_base_height_m ?? por.roof_height_m) || 4.45;
    if (widthP > 0 && depthP > 0) {
      const x0 = (W - widthP) / 2;
      const x1 = x0 + widthP;
      const y0 = -depthP;
      const y1 = 0;
      const matId = s.materials?.portico_roof || 'gypsum-board';
      out.push({
        kind: 'portico_roof',
        side: 'south',
        vertices: [
          { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
        ],
        z_top: capBaseH,
        materialId: matId,
      });
    }
  }

  return out;
}

export function pointInPolygon2D(x, y, verts) {
  let inside = false;
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (((verts[i].y > y) !== (verts[j].y > y)) &&
        (x < (verts[j].x - verts[i].x) * (y - verts[i].y) / (verts[j].y - verts[i].y) + verts[i].x)) {
      inside = !inside;
    }
  }
  return inside;
}
