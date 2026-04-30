function getShape(room) {
  return room.shape ?? 'rectangular';
}

// Wall-slot schema. Each slot in `room.surfaces` (wall_north/south/east/west,
// edges[i], or the shared 'walls') is either:
//   - a STRING (legacy): just the material ID, no openings.
//   - an OBJECT (new):   { materialId, openings: [{ kind, x_m, z_m,
//                          width_m, height_m, materialId, state }, ... ] }
// Both are accepted at every read site so old saved scenes / preset
// authoring code keep working with no migration step. Writers (UI,
// panel-room, scene save) use whichever form they generated; the
// normaliser smooths over the difference.
//
// Openings:
//   kind:       'door' | 'window'
//   x_m, z_m:   bottom-left corner in WALL-LOCAL coords. x along wall from
//               its first vertex (v1), z is height from floor.
//   width_m, height_m:   opening dimensions
//   materialId: solid material when state === 'closed' (e.g. door-solid-
//               wood, glass-window). Ignored when state === 'open' — the
//               opening reads as α = 1.0 (open boundary).
//   state:      'open' | 'closed'
export function normalizeWallSlot(slot, fallbackMaterialId = 'gypsum-board') {
  if (typeof slot === 'string') {
    return { materialId: slot, openings: [] };
  }
  if (slot && typeof slot === 'object') {
    return {
      materialId: typeof slot.materialId === 'string' ? slot.materialId : fallbackMaterialId,
      openings: Array.isArray(slot.openings) ? slot.openings : [],
    };
  }
  return { materialId: fallbackMaterialId, openings: [] };
}

// Total area of openings on a single wall (m²). Skips openings missing or
// invalid dimensions so a half-edited entry can't make a wall's effective
// area go negative.
function openingsArea(openings) {
  let a = 0;
  for (const op of openings || []) {
    const w = Number(op?.width_m), h = Number(op?.height_m);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) a += w * h;
  }
  return a;
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
      const cv = (room.custom_vertices || [])
        .filter(v => v && Number.isFinite(v.x) && Number.isFinite(v.y))
        .map(v => ({ x: v.x, y: v.y }));
      // While the user is mid-draw (Draw custom room button just
      // clicked → applyBlankCustomRoom set shape='custom' but
      // custom_vertices is null), the scene rebuild would crash on
      // verts[0].x on an empty array. Fall back to the default rect
      // so the 3D viewport shows a placeholder until the polygon
      // closes and real vertices arrive.
      if (cv.length < 3) {
        const w = room.width_m || 8;
        const d = room.depth_m || 8;
        return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
      }
      return cv;
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

// Bounding rectangle of the parent footprint UNIONED with every
// standaloneEnclosure polygon. The heatmap grid sizes itself from this
// — without it, an enclosure that extends past the parent's bbox would
// be invisible to the heatmap (the grid stops at width_m / depth_m).
// Returns { minX, minY, maxX, maxY } in state-plane coords.
export function roomEffectiveBounds(room) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const parentVerts = roomPlanVertices(room);
  if (Array.isArray(parentVerts)) {
    for (const v of parentVerts) {
      if (!Number.isFinite(v?.x) || !Number.isFinite(v?.y)) continue;
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
  }
  const encs = room?.standaloneEnclosures;
  if (Array.isArray(encs)) {
    for (const enc of encs) {
      if (!Array.isArray(enc?.polygon)) continue;
      for (const v of enc.polygon) {
        if (!Number.isFinite(v?.x) || !Number.isFinite(v?.y)) continue;
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
      }
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0,
             maxX: room?.width_m ?? 10, maxY: room?.depth_m ?? 10 };
  }
  return { minX, minY, maxX, maxY };
}

// Parent footprint only — does NOT include broken-out enclosures. Use
// when you specifically need the parent polygon's containment (e.g. the
// 2D plan SVG for the parent outline). Most callers want isInsideRoom()
// which unions in standaloneEnclosures so post-merge geometry is
// fully addressable by speakers / listeners / heatmap / raycasters.
export function isInsideParentFootprint(x, y, room) {
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

// Total room footprint = parent ∪ every standalone enclosure produced by
// break-to-merge. After merging Room B into Room A, Room B's interior
// lives in state.room.standaloneEnclosures[i].polygon (parent coords,
// transform already baked) — not in the parent's own custom_vertices.
// Without this union, a speaker placed in the merged Room B was being
// flagged "outside the room", the heatmap grid skipped its cells, and
// raycasters thought the wall belonged to the void.
export function isInsideRoom(x, y, room) {
  if (isInsideParentFootprint(x, y, room)) return true;
  const encs = room?.standaloneEnclosures;
  if (Array.isArray(encs)) {
    for (const enc of encs) {
      if (!Array.isArray(enc?.polygon) || enc.polygon.length < 3) continue;
      if (pointInPolygon(x, y, enc.polygon)) return true;
    }
  }
  return false;
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
  // Parent footprint first — keeps the original rectangular-/polygon-/
  // custom-shape height check fast for the common case.
  if (isInsideParentFootprint(pos.x, pos.y, room)) {
    if (pos.z < 0) return false;
    // Outdoor: no roof, so a speaker / listener at any height above the
    // floor is valid. Without this skip, a speaker hung above the wall-
    // height value (e.g. on a tall pole in a park) would be flagged
    // out-of-room and the heatmap would refuse to render outdoor listeners.
    if (room.enclosure !== 'outdoor' && pos.z > maxCeilingHeightAt(pos.x, pos.y, room)) return false;
    return true;
  }
  // Enclosure paths (broken-out sub-rooms). Each enclosure has its own
  // elevation_m + height_m so a speaker on a 1 m platform in a 2 m hut
  // attached to the parent is correctly inside [1, 3] in world Z.
  const encs = room?.standaloneEnclosures;
  if (Array.isArray(encs)) {
    for (const enc of encs) {
      if (!Array.isArray(enc?.polygon) || enc.polygon.length < 3) continue;
      if (!pointInPolygon(pos.x, pos.y, enc.polygon)) continue;
      const elev = Number.isFinite(enc.elevation_m) ? enc.elevation_m : 0;
      const h = Number.isFinite(enc.height_m) ? enc.height_m : 3;
      if (pos.z < elev) continue;
      if (room.enclosure !== 'outdoor' && pos.z > elev + h) continue;
      return true;
    }
  }
  return false;
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

// Build a wall surface entry plus zero or more opening entries from a
// raw wall slot. The wall's area is reduced by the total opening area so
// the wall material doesn't double-count regions where there's actually a
// door or window. Each opening contributes its own surface — α = 1.0
// when the opening is 'open' (boundary acts like an open wall), or the
// opening's own material when 'closed'.
//
// Returns an array of { id, area_m2, materialId } entries, with the
// wall first so existing index-based callers keep working.
function expandWallWithOpenings(rawSlot, baseId, totalArea, fallbackMatId) {
  const { materialId, openings } = normalizeWallSlot(rawSlot, fallbackMatId);
  const opArea = openingsArea(openings);
  const out = [{
    id: baseId,
    area_m2: Math.max(0, totalArea - opArea),
    materialId,
  }];
  let opi = 0;
  for (const op of openings || []) {
    const w = Number(op?.width_m), h = Number(op?.height_m);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const isOpen = op?.state === 'open';
    out.push({
      id: `${baseId}_op_${opi}`,
      area_m2: w * h,
      materialId: isOpen ? 'open-air' : (op?.materialId || 'glass-window'),
    });
    opi++;
  }
  return out;
}

export function roomSurfaces(room) {
  const shape = getShape(room);
  const b = baseArea(room);
  const wallH = room.height_m;
  const floor = { id: 'floor', area_m2: b, materialId: room.surfaces.floor };
  // Outdoor enclosure: there's no roof, so the ceiling slot is forced to
  // α = 1.0 ('open-air') regardless of the user's stored material choice.
  // Walls remain user-controlled — the user can choose to keep walls
  // (e.g. a fenced courtyard or a perimeter pavilion structure) or set
  // every wall slot to 'open-air' for a fully open footprint. Stored
  // ceiling material is preserved on disk so flipping back to indoor
  // restores it; only live acoustic accounting is overridden.
  const isOutdoor = room.enclosure === 'outdoor';
  const ceiling = {
    id: 'ceiling',
    area_m2: ceilingArea(room),
    materialId: isOutdoor ? 'open-air' : room.surfaces.ceiling,
  };

  let result;
  if (shape === 'rectangular') {
    const { width_m: w, depth_m: d, surfaces: s } = room;
    result = [floor, ceiling];
    result.push(...expandWallWithOpenings(s.wall_north, 'wall_north', w * wallH, 'gypsum-board'));
    result.push(...expandWallWithOpenings(s.wall_south, 'wall_south', w * wallH, 'gypsum-board'));
    result.push(...expandWallWithOpenings(s.wall_east,  'wall_east',  d * wallH, 'gypsum-board'));
    result.push(...expandWallWithOpenings(s.wall_west,  'wall_west',  d * wallH, 'gypsum-board'));
  } else if (shape === 'custom') {
    const v = room.custom_vertices || [];
    const edges = room.surfaces.edges || [];
    result = [floor, ceiling];
    const fallback = (typeof room.surfaces.walls === 'string')
      ? room.surfaces.walls
      : 'gypsum-board';
    for (let i = 0; i < v.length; i++) {
      const j = (i + 1) % v.length;
      const dx = v[j].x - v[i].x, dy = v[j].y - v[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      result.push(...expandWallWithOpenings(edges[i], `edge_${i}`, len * wallH, fallback));
    }
  } else {
    const fallback = (typeof room.surfaces.wall_north === 'string')
      ? room.surfaces.wall_north
      : 'gypsum-board';
    result = [floor, ceiling];
    result.push(...expandWallWithOpenings(
      room.surfaces.walls, 'walls', wallPerimeter(room) * wallH, fallback,
    ));
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
