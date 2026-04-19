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

export function ceilingArea(room) {
  const b = baseArea(room);
  if (room.ceiling_type === 'dome' && (room.ceiling_dome_rise_m ?? 0) > 0) {
    const a = Math.sqrt(b / Math.PI);
    const d = room.ceiling_dome_rise_m;
    return Math.PI * (a * a + d * d);
  }
  return b;
}

export function domeVolume(room) {
  if (room.ceiling_type !== 'dome' || !((room.ceiling_dome_rise_m ?? 0) > 0)) return 0;
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
  return Math.max(0, gross - stadiumSolidVolume(room.stadiumStructure));
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

  if (shape === 'rectangular') {
    const { width_m: w, depth_m: d, surfaces: s } = room;
    return [
      floor, ceiling,
      { id: 'wall_north', area_m2: w * wallH, materialId: s.wall_north },
      { id: 'wall_south', area_m2: w * wallH, materialId: s.wall_south },
      { id: 'wall_east',  area_m2: d * wallH, materialId: s.wall_east },
      { id: 'wall_west',  area_m2: d * wallH, materialId: s.wall_west },
    ];
  }

  if (shape === 'custom') {
    const v = room.custom_vertices || [];
    const edges = room.surfaces.edges || [];
    const result = [floor, ceiling];
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
    return result;
  }

  const wallsMat = room.surfaces.walls ?? room.surfaces.wall_north ?? 'gypsum-board';
  return [
    floor, ceiling,
    { id: 'walls', area_m2: wallPerimeter(room) * wallH, materialId: wallsMat },
  ];
}

export function domeGeometry(room) {
  if (room.ceiling_type !== 'dome' || !((room.ceiling_dome_rise_m ?? 0) > 0)) return null;
  const a = Math.sqrt(baseArea(room) / Math.PI);
  const d = room.ceiling_dome_rise_m;
  const R = (a * a + d * d) / (2 * d);
  const thetaMax = Math.acos((R - d) / R);
  return { baseRadius: a, rise: d, sphereRadius: R, thetaMax };
}
