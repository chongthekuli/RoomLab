function getShape(room) {
  return room.shape ?? 'rectangular';
}

export function baseArea(room) {
  switch (getShape(room)) {
    case 'polygon': {
      const n = room.polygon_sides ?? 6;
      const r = room.polygon_radius_m ?? 3;
      return (n / 2) * r * r * Math.sin(2 * Math.PI / n);
    }
    case 'round': {
      const r = room.round_radius_m ?? 3;
      return Math.PI * r * r;
    }
    case 'custom': {
      const v = room.custom_vertices || [];
      if (v.length < 3) return 0;
      let a = 0;
      for (let i = 0; i < v.length; i++) {
        const j = (i + 1) % v.length;
        a += v[i].x * v[j].y - v[j].x * v[i].y;
      }
      return Math.abs(a) / 2;
    }
    default:
      return room.width_m * room.depth_m;
  }
}

export function wallPerimeter(room) {
  switch (getShape(room)) {
    case 'polygon': {
      const n = room.polygon_sides ?? 6;
      const r = room.polygon_radius_m ?? 3;
      return 2 * r * n * Math.sin(Math.PI / n);
    }
    case 'round': {
      const r = room.round_radius_m ?? 3;
      return 2 * Math.PI * r;
    }
    case 'custom': {
      const v = room.custom_vertices || [];
      if (v.length < 2) return 0;
      let p = 0;
      for (let i = 0; i < v.length; i++) {
        const j = (i + 1) % v.length;
        const dx = v[j].x - v[i].x;
        const dy = v[j].y - v[i].y;
        p += Math.sqrt(dx * dx + dy * dy);
      }
      return p;
    }
    default:
      return 2 * (room.width_m + room.depth_m);
  }
}

// Spherical-cap dome math assumes a radially-symmetric base. We approximate
// a polygonal or rectangular base with its equivalent-area circle
// (a = √(A_base/π)). For 36-sided (arena) or round bases this is <1 %
// error; for elongated bases (e.g. 10 × 100 m rectangle) the formula loses
// meaning. Reviewer audit: refuse-to-silently-lie when aspect > 2:1.
// We log a one-time warning per session rather than throw, because the
// preset may still be useful for a rough acoustic estimate even when the
// ceiling geometry is unrealistic.
function roomBaseAspectRatio(room) {
  const shape = room.shape;
  if (shape === 'round') return 1;
  if (shape === 'polygon') {
    const sides = room.polygon_sides ?? 6;
    // Very low-sided polygons (triangle, square on-edge) can be anisotropic
    // depending on the rotation convention; for sides ≥ 6 aspect ≈ 1.
    return sides >= 6 ? 1 : 1.2;
  }
  if (shape === 'custom' && Array.isArray(room.custom_vertices) && room.custom_vertices.length >= 3) {
    const xs = room.custom_vertices.map(v => v.x);
    const ys = room.custom_vertices.map(v => v.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return Math.max(w, h) / Math.max(1e-6, Math.min(w, h));
  }
  // rectangular
  const w = room.width_m ?? 1;
  const d = room.depth_m ?? 1;
  return Math.max(w, d) / Math.max(1e-6, Math.min(w, d));
}
let _domeAspectWarned = false;
function checkDomeAspect(room) {
  if (_domeAspectWarned) return;
  const r = roomBaseAspectRatio(room);
  if (r > 2) {
    _domeAspectWarned = true;
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        `[roomlab] Dome ceiling geometry assumes radial symmetry; current room has aspect ratio ${r.toFixed(1)}:1. ` +
        `Spherical-cap volume/area will be incorrect for elongated bases — switch to ceiling_type='flat' or choose ` +
        `a more symmetric room shape for reliable RT60 numbers.`
      );
    }
  }
}

export function ceilingArea(room) {
  const b = baseArea(room);
  if (room.ceiling_type === 'dome' && (room.ceiling_dome_rise_m ?? 0) > 0) {
    checkDomeAspect(room);
    const a = Math.sqrt(b / Math.PI);
    const d = room.ceiling_dome_rise_m;
    return Math.PI * (a * a + d * d);
  }
  return b;
}

export function domeVolume(room) {
  if (room.ceiling_type !== 'dome' || !((room.ceiling_dome_rise_m ?? 0) > 0)) return 0;
  checkDomeAspect(room);
  const a = Math.sqrt(baseArea(room) / Math.PI);
  const d = room.ceiling_dome_rise_m;
  return Math.PI * d / 6 * (3 * a * a + d * d);
}

// Arena presets carry a `stadiumStructure` that occupies real floor-to-
// catwalk volume in concrete (bowl tiers + concourse ring). Elena's audit:
// the raw polygon+dome volume overstates air volume by ~10%, which
// inflates Sabine RT60 by the same. Subtract the modeled concrete solids.
export function stadiumSolidVolume(stadiumStructure) {
  if (!stadiumStructure) return 0;
  const v = stadiumStructure.vomitories;
  const vomFrac = v ? (v.centerAnglesDeg?.length ?? 0) * (v.widthDeg ?? 0) / 360 : 0;
  const usedFrac = Math.max(0, Math.min(1, 1 - vomFrac));
  let vol = 0;
  const lb = stadiumStructure.lowerBowl;
  if (lb && Array.isArray(lb.tier_heights_m) && lb.tier_heights_m.length > 0) {
    const meanZ = lb.tier_heights_m.reduce((a, b) => a + b, 0) / lb.tier_heights_m.length;
    vol += Math.PI * (lb.r_out * lb.r_out - lb.r_in * lb.r_in) * meanZ * usedFrac;
  }
  const co = stadiumStructure.concourse;
  if (co && co.elevation_m > 0) {
    vol += Math.PI * (co.r_out * co.r_out - co.r_in * co.r_in) * co.elevation_m * usedFrac;
  }
  const ub = stadiumStructure.upperBowl;
  if (ub && Array.isArray(ub.tier_heights_m) && ub.tier_heights_m.length > 0) {
    const meanZ = ub.tier_heights_m.reduce((a, b) => a + b, 0) / ub.tier_heights_m.length;
    const rakeH = Math.max(0, meanZ - (ub.floor_z ?? 0));
    vol += Math.PI * (ub.r_out * ub.r_out - ub.r_in * ub.r_in) * rakeH * usedFrac;
  }
  // Scoreboard: small but nonzero volume occupied by the LED cube.
  const sb = stadiumStructure.scoreboard;
  if (sb) {
    vol += sb.width_m * sb.width_m * sb.height_m;
  }
  return vol;
}

export function roomVolume(room) {
  const gross = baseArea(room) * room.height_m + domeVolume(room);
  return Math.max(0, gross
    - stadiumSolidVolume(room.stadiumStructure)
    - multiLevelSolidVolume(room.multiLevelStructure)
  );
}

// Multi-level mall presets carry a `multiLevelStructure` with concrete
// slabs + RC columns + fire-stair / lift / toilet cores occupying real
// air volume. Subtract them so Sabine sees the actual free air.
export function multiLevelSolidVolume(mls) {
  if (!mls) return 0;
  let vol = 0;
  // Floor slabs (each slab = footprint − atrium, × thickness)
  const footArea = polygonSignedArea(mls.footprint ?? []);
  const atriumArea = polygonSignedArea(mls.atrium ?? []);
  for (const lv of (mls.levels ?? [])) {
    vol += Math.max(0, footArea - atriumArea) * (lv.thickness_m ?? 0.4);
  }
  // Columns
  for (const col of (mls.columns ?? [])) {
    const h = (col.top_z ?? 0) - (col.base_z ?? 0);
    vol += Math.PI * (col.radius_m ?? 0.4) ** 2 * h;
  }
  // Toilet / fire-stair / lift shaft boxes — they take up their footprint
  // × full shaft height. Approximate the enclosure's interior as lost
  // air volume since PA/STIPA doesn't penetrate fire-rated walls.
  const totalH = room => room?.height_m ?? (mls.levels?.length ? (mls.levels.length + 1) * 5.8 : 0);
  for (const t of (mls.toiletBlocks ?? [])) {
    vol += (t.x2 - t.x1) * (t.y2 - t.y1) * 5.4;  // per-level toilet volume
  }
  for (const s of (mls.fireStairs ?? [])) {
    vol += (s.x2 - s.x1) * (s.y2 - s.y1) * ((s.top_z ?? 0) - (s.base_z ?? 0));
  }
  for (const lift of (mls.passengerLifts ?? [])) {
    vol += (lift.x2 - lift.x1) * (lift.y2 - lift.y1) * ((lift.top_z ?? 0) - (lift.base_z ?? 0));
  }
  return vol;
}

// Absolute signed area of a polygon (shoelace).
function polygonSignedArea(verts) {
  if (!verts || verts.length < 3) return 0;
  let a = 0;
  for (let i = 0, n = verts.length; i < n; i++) {
    const p = verts[i], q = verts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function roomCenter(room) {
  return { x: room.width_m / 2, y: room.depth_m / 2 };
}

export function roomPlanVertices(room) {
  const cx = room.width_m / 2;
  const cy = room.depth_m / 2;
  switch (getShape(room)) {
    case 'polygon': {
      const n = room.polygon_sides ?? 6;
      const r = room.polygon_radius_m ?? 3;
      const verts = [];
      for (let i = 0; i < n; i++) {
        const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
        verts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
      }
      return verts;
    }
    case 'round': {
      const r = room.round_radius_m ?? 3;
      const n = 64;
      const verts = [];
      for (let i = 0; i < n; i++) {
        const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
        verts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
      }
      return verts;
    }
    case 'custom': {
      return (room.custom_vertices || []).map(v => ({ x: v.x, y: v.y }));
    }
    default: {
      const w = room.width_m, d = room.depth_m;
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
    }
  }
}

function pointInPolygon(x, y, verts) {
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

export function isInsideRoom(x, y, room) {
  switch (getShape(room)) {
    case 'round': {
      const r = room.round_radius_m ?? 3;
      const cx = room.width_m / 2, cy = room.depth_m / 2;
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    }
    case 'polygon':
    case 'custom':
      return pointInPolygon(x, y, roomPlanVertices(room));
    default:
      return x >= 0 && x <= room.width_m && y >= 0 && y <= room.depth_m;
  }
}

export function maxCeilingHeightAt(x, y, room) {
  if (room.ceiling_type !== 'dome' || !((room.ceiling_dome_rise_m ?? 0) > 0)) {
    return room.height_m;
  }
  const d = room.ceiling_dome_rise_m;
  const a = Math.sqrt(baseArea(room) / Math.PI);
  const R = (a * a + d * d) / (2 * d);
  const cx = room.width_m / 2, cy = room.depth_m / 2;
  const horizDistSq = (x - cx) ** 2 + (y - cy) ** 2;
  if (horizDistSq >= a * a) return room.height_m;
  const heightAboveWall = Math.sqrt(R * R - horizDistSq) - (R - d);
  return room.height_m + heightAboveWall;
}

export function isInsideRoom3D(pos, room) {
  if (!isInsideRoom(pos.x, pos.y, room)) return false;
  if (pos.z < 0) return false;
  if (pos.z > maxCeilingHeightAt(pos.x, pos.y, room)) return false;
  return true;
}

// Shoelace polygon area (2D).
function polygonArea2D(verts) {
  let a = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += verts[i].x * verts[j].y - verts[j].x * verts[i].y;
  }
  return Math.abs(a) / 2;
}

// Wrap roomSurfaces with zone-aware accounting. Every zone's 2D footprint
// is subtracted from the base floor regardless of the zone's elevation —
// because acoustically a sound wave traveling down only ever hits the
// topmost surface in a given column, and an elevated zone (bowl tier,
// concourse mezzanine) blocks the floor beneath it. The zone itself is
// added as a new surface with its own material + occupancy.
//
// Previously only ground-level zones (|elev| < 0.1 m) carved the floor,
// which double-counted stadium bowl footprints: the raked carpet zone was
// added AND the full wood floor underneath stayed in the Sabine budget.
// Dr. Chen flagged this in the C2 audit finding.
export function roomEffectiveSurfaces(room, zones = []) {
  const base = roomSurfaces(room);
  if (!zones || zones.length === 0) return base;
  const out = base.map(s => ({ ...s }));
  let floorCarveOut = 0;
  for (const z of zones) {
    if (!z.vertices || z.vertices.length < 3 || !z.material_id) continue;
    const area = polygonArea2D(z.vertices);
    if (area <= 0) continue;
    floorCarveOut += area;
    out.push({
      id: 'zone_' + z.id,
      area_m2: area,
      materialId: z.material_id,
      occupancy_percent: z.occupancy_percent ?? 0,
    });
  }
  if (floorCarveOut > 0) {
    const fi = out.findIndex(s => s.id === 'floor');
    if (fi >= 0) out[fi].area_m2 = Math.max(0, out[fi].area_m2 - floorCarveOut);
  }
  // Center-hung scoreboard — 4 LED side faces + steel top/bottom.
  // Acoustically significant as a hard reflector in the center of the room.
  const sb = room.stadiumStructure?.scoreboard;
  if (sb) {
    const sides = 4 * sb.width_m * sb.height_m;
    const topBot = 2 * sb.width_m * sb.width_m;
    out.push({
      id: 'scoreboard',
      area_m2: sides + topBot,
      materialId: sb.material_id ?? 'led-glass',
    });
  }
  return out;
}

export function roomSurfaces(room) {
  const shape = getShape(room);
  const b = baseArea(room);
  const wallH = room.height_m;
  const floor = { id: 'floor', area_m2: b, materialId: room.surfaces.floor };
  const ceiling = { id: 'ceiling', area_m2: ceilingArea(room), materialId: room.surfaces.ceiling };

  let result;
  if (shape === 'rectangular') {
    const { width_m: w, depth_m: d, surfaces: s } = room;
    result = [
      floor, ceiling,
      { id: 'wall_north', area_m2: w * wallH, materialId: s.wall_north },
      { id: 'wall_south', area_m2: w * wallH, materialId: s.wall_south },
      { id: 'wall_east',  area_m2: d * wallH, materialId: s.wall_east },
      { id: 'wall_west',  area_m2: d * wallH, materialId: s.wall_west },
    ];
  } else if (shape === 'custom') {
    const v = room.custom_vertices || [];
    const edges = room.surfaces.edges || [];
    result = [floor, ceiling];
    for (let i = 0; i < v.length; i++) {
      const j = (i + 1) % v.length;
      const dx = v[j].x - v[i].x, dy = v[j].y - v[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      result.push({
        id: `edge_${i}`,
        area_m2: len * wallH,
        materialId: edges[i] ?? room.surfaces.walls ?? 'gypsum-board',
      });
    }
  } else {
    const wallsMat = room.surfaces.walls ?? room.surfaces.wall_north ?? 'gypsum-board';
    result = [
      floor, ceiling,
      { id: 'walls', area_m2: wallPerimeter(room) * wallH, materialId: wallsMat },
    ];
  }

  // Append interior fixtures from multiLevelStructure (mall presets). Each
  // internal partition adds BOTH faces of absorption — shops have a
  // front storefront and a back dividing wall shared with the next bay,
  // so we count both sides once. Big RT60-drop for the Pavilion preset
  // because the slab undersides alone triple the total surface area.
  const interior = multiLevelInteriorSurfaces(room);
  if (interior.length) result = result.concat(interior);

  return result;
}

// ---------------------------------------------------------------------------
// Interior surfaces introduced by a multi-level mall / atrium structure.
// Returns an array of { id, area_m2, materialId } entries appended to
// the outer-shell surfaces by roomSurfaces(). Materials are chosen per
// real-world premium mall fit-out: slab soffits are smooth painted
// plaster (gypsum-on-metal suspended below the concrete slab — standard
// for Pavilion-class retail), slab tops are concrete / ceramic-tile
// shoppers walk on, shop dividers are gypsum, storefronts are glass,
// toilet ceilings are acoustic-tile, fire-stair enclosures are concrete,
// lift shafts are glass, columns are concrete. The atrium polygon is a
// clear void — no ceiling surface is counted over it.
function multiLevelInteriorSurfaces(room) {
  const mls = room.multiLevelStructure;
  if (!mls) return [];
  const out = [];
  const footArea = polygonSignedArea(mls.footprint ?? []);
  const atriumArea = polygonSignedArea(mls.atrium ?? []);
  const slabNetArea = Math.max(0, footArea - atriumArea);

  // Slabs — each interior slab has a top (floor of upper level, ceramic
  // tile over concrete) and a soffit (ceiling of the level below, which
  // in a premium mall is a suspended plaster/gypsum finish, not the
  // raw concrete slab). The atrium area is already excluded from
  // slabNetArea so no plaster is counted over the open void.
  for (const lv of (mls.levels ?? [])) {
    out.push({
      id: `slab_top_${lv.index}`,
      area_m2: slabNetArea,
      materialId: 'concrete-painted',
    });
    out.push({
      id: `slab_soffit_${lv.index}`,
      area_m2: slabNetArea,
      materialId: 'plaster-smooth',
    });
  }

  // Columns — lateral cylinder surface area, 2 π r h.
  for (const col of (mls.columns ?? [])) {
    const h = (col.top_z ?? 0) - (col.base_z ?? 0);
    const r = col.radius_m ?? 0.4;
    out.push({
      id: `column_${col.x.toFixed(0)}_${col.y.toFixed(0)}`,
      area_m2: 2 * Math.PI * r * h,
      materialId: 'concrete-painted',
    });
  }

  // Shops — two side dividers (gypsum) + two glass storefront panels
  // flanking a shutter gap. Shutter gap acts as a high-absorption hole
  // (tagged 'open-shutter' if available, otherwise audience-seated
  // absorption as a proxy for goods inside the shop).
  const WALL_H = 5.4;
  for (const shop of (mls.shops ?? [])) {
    const isHoriz = shop.side === 'south' || shop.side === 'north';
    const divLen = isHoriz ? (shop.y2 - shop.y1) : (shop.x2 - shop.x1);
    const bayWidth = isHoriz ? (shop.x2 - shop.x1) : (shop.y2 - shop.y1);
    // 2 side dividers × both faces = 4 gypsum rectangles of divLen × WALL_H
    out.push({
      id: `shop_dividers_${shop.level}_${shop.x1}_${shop.y1}`,
      area_m2: 4 * divLen * WALL_H,
      materialId: 'gypsum-board',
    });
    // Storefront glass — bay width minus shutter × glass height, both sides
    const shutterW = Math.min(shop.shutter_width ?? 3, bayWidth);
    const glassW = Math.max(0, bayWidth - shutterW);
    out.push({
      id: `shop_glass_${shop.level}_${shop.x1}_${shop.y1}`,
      area_m2: 2 * glassW * (WALL_H - 0.9),   // 0.9 m reserved for sign
      materialId: 'glass-window',
    });
  }

  // Toilet blocks — gypsum perimeter walls + acoustic-tile ceiling.
  for (const t of (mls.toiletBlocks ?? [])) {
    const w = t.x2 - t.x1, d = t.y2 - t.y1;
    out.push({
      id: `toilet_walls_L${t.level}_${t.x1}`,
      area_m2: 2 * (w + d) * WALL_H,
      materialId: 'gypsum-board',
    });
    out.push({
      id: `toilet_ceil_L${t.level}_${t.x1}`,
      area_m2: w * d,
      materialId: 'acoustic-tile',
    });
  }

  // Fire stair enclosures — concrete perimeter, full building height.
  for (const s of (mls.fireStairs ?? [])) {
    const w = s.x2 - s.x1, d = s.y2 - s.y1;
    const h = (s.top_z ?? 0) - (s.base_z ?? 0);
    out.push({
      id: `fire_stair_${s.x1}_${s.y1}`,
      area_m2: 2 * (w + d) * h,
      materialId: 'concrete-painted',
    });
  }

  // Lift shafts — glass perimeter full height.
  for (const lift of (mls.passengerLifts ?? [])) {
    const w = lift.x2 - lift.x1, d = lift.y2 - lift.y1;
    const h = (lift.top_z ?? 0) - (lift.base_z ?? 0);
    out.push({
      id: `lift_shaft_${lift.x1}_${lift.y1}`,
      area_m2: 2 * (w + d) * h,
      materialId: 'glass-window',
    });
  }

  return out;
}

export function domeGeometry(room) {
  if (room.ceiling_type !== 'dome' || !((room.ceiling_dome_rise_m ?? 0) > 0)) return null;
  const a = Math.sqrt(baseArea(room) / Math.PI);
  const d = room.ceiling_dome_rise_m;
  const R = (a * a + d * d) / (2 * d);
  const thetaMax = Math.acos((R - d) / R);
  return { baseRadius: a, rise: d, sphereRadius: R, thetaMax };
}
