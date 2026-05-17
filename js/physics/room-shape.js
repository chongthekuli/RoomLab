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
  // Surau podium extends past the parent footprint on every side. The
  // SPL heatmap should cover the full podium so coverage from arcade
  // speakers is visible — extend the bounds outward by podium.extension_m.
  // Other surauStructure consumers (mihrab, minbar, etc.) are inside the
  // parent footprint already; only the podium pushes outward.
  const podiumExt = room?.surauStructure?.podium?.extension_m;
  if (Number.isFinite(podiumExt) && podiumExt > 0) {
    minX -= podiumExt;
    maxX += podiumExt;
    minY -= podiumExt;
    maxY += podiumExt;
  }
  return { minX, minY, maxX, maxY };
}

// Helper: true if (x, y) sits within the surau podium extent — i.e.
// outside the parent footprint but within podium.extension_m of every
// wall. Used by isInsideRoom3D so SPL grid cells over the arcade get
// computed instead of returning -Infinity.
function isOnSurauPodium(x, y, room) {
  const podiumExt = room?.surauStructure?.podium?.extension_m;
  if (!Number.isFinite(podiumExt) || podiumExt <= 0) return false;
  // Rectangular surau footprint (the only shape surauStructure supports).
  // Podium spans (-ext, -ext) to (W + ext, D + ext) in state coords.
  return (x >= -podiumExt && x <= (room.width_m ?? 0) + podiumExt &&
          y >= -podiumExt && y <= (room.depth_m ?? 0) + podiumExt);
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
  // Surau podium — outdoor measurement surface around the building.
  // Accept positions on the podium (outside the room walls but within
  // the podium extent) at any reasonable height so the SPL heatmap
  // covers the arcade and the surrounding raised concrete base. The
  // arcade flat roof is at ~4.4 m so cap the height check generously.
  if (isOnSurauPodium(pos.x, pos.y, room) && pos.z >= 0 && pos.z <= 5.0) {
    return true;
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

// Wrap roomSurfaces with zone-aware AND treatment-aware accounting.
//
// Order of operations (Hannes/Dr. Chen v2 spec, May 2026):
//   1. roomSurfaces() — bare shell, walls/floor/ceiling, openings split
//      out of their parent wall, interior mall fixtures appended.
//   2. Zones carve the floor first (each zone's 2D footprint is
//      subtracted from `floor` and the zone surface is appended).
//   3. Treatments carve their host wall SECOND (per panel: subtract
//      its catalogue area from the host surface — capped at the
//      surface's remaining area so the wall can't go negative — then
//      append the treatment as its own surface entry with its α from
//      the SurfaceLAB catalogue).
//
// Why zones FIRST then panels: a panel on the floor (rare but legal in
// the ceiling-baffle case where surface='ceiling' carves the ceiling)
// only collides with the ceiling material entry, not the zone overlay.
// A panel on a wall never overlaps a zone footprint. Multi-panel-on-
// same-wall is handled by greedy per-panel clamping in placement order
// — the LAST placed panel is the one that gets `clamped:true` if the
// wall's remaining area runs out.
//
// Openings rule: an opening (door/window) is emitted as its OWN
// surface entry with a `_op_N` suffixed id. The wall slot only owns
// the leftover area after openings are subtracted. Treatments
// carve from the wall slot ONLY (id prefix match), never from
// `wall_X_op_*` entries — pinning a panel over a door isn't a
// physically meaningful operation in v2.
//
// Catalogue access: getTreatmentAbsorption() reads from the
// SurfaceLAB cache. If the catalogue hasn't loaded yet (e.g. a
// physics-only test path), the treatment contributes ZERO absorption
// AND DOES NOT CARVE the host wall — matching v1 visual-only
// behavior so a partially-initialized engine never lies about RT60.
// The third argument is optional so all v1 callers (preset import,
// scene snapshot diffing, etc.) keep working with no changes.
export function roomEffectiveSurfaces(room, zones = [], treatments = []) {
  const base = roomSurfaces(room);
  const hasZones = Array.isArray(zones) && zones.length > 0;
  const hasTreatments = Array.isArray(treatments) && treatments.length > 0;
  if (!hasZones && !hasTreatments) return base;

  const out = base.map(s => ({ ...s }));

  // -- Zones (unchanged from v1) -------------------------------------------
  if (hasZones) {
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
  }

  // -- Treatments (new in v2) ----------------------------------------------
  if (hasTreatments) {
    applyTreatmentOverlap(out, treatments, room);
  }

  // Center-hung scoreboard — unchanged.
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

// Map a treatment's anchor to the host-surface id used by roomSurfaces().
// Rectangular rooms use wall_north/south/east/west with wallIndex 0..3
// (the conventions panel-treatments.js + scene.js already use). Custom
// rooms use edge_0, edge_1, ... matching the polygon vertex order.
// Ceiling treatments anchor to 'ceiling'. Returns null when the anchor
// can't be resolved — the panel is silently dropped from the Sabine
// budget rather than crashing the engine.
function treatmentHostSurfaceId(treatment, room) {
  const a = treatment?.anchor;
  if (!a) return null;
  if (a.surface === 'ceiling') return 'ceiling';
  if (a.surface !== 'wall') return null;
  const idx = a.wallIndex;
  if (!Number.isFinite(idx) || idx < 0) return null;
  const shape = getShape(room);
  if (shape === 'rectangular') {
    // Canonical wall ordering used by scene.js for 3D placement and
    // by panel-treatments for projection. Matches the order
    // roomSurfaces() emits walls in (N, S, E, W → 0,1,2,3).
    return ['wall_north', 'wall_south', 'wall_east', 'wall_west'][idx] ?? null;
  }
  if (shape === 'custom') return `edge_${idx}`;
  // Polygon / round rooms use the shared 'walls' slot — every panel
  // carves the same merged perimeter surface. Acoustically equivalent
  // to splitting the panels across virtual edges because the round
  // room's α is uniform.
  return 'walls';
}

// Apply treatment overlap math to a mutable surfaces[] in place.
//   For each panel in placement order:
//     1. Look up host surface entry by id.
//     2. Compute the panel's catalogue area (width × height).
//     3. Clamp panel area to the host's REMAINING area (per-wall
//        clamping — sum of all panels on one wall never exceeds the
//        wall's own area). The first panel that exceeds the host
//        budget is logged once per session and tagged `clamped:true`
//        for the UI.
//     4. Subtract clamped area from host surface.
//     5. Append a new surface entry { id: 'treatment_T1',
//        area_m2: clampedArea, materialId: 'treatment:<productId>',
//        productId, _isTreatment } so the absorption-lookup pass in
//        rt60.js can recognise it and pull α from the SurfaceLAB
//        catalogue instead of materials.byId.
function applyTreatmentOverlap(surfaces, treatments, room) {
  let clampWarned = false;
  for (const t of treatments) {
    if (!t || !t.productId) continue;
    const hostId = treatmentHostSurfaceId(t, room);
    if (!hostId) continue;
    const hostIdx = surfaces.findIndex(s => s.id === hostId);
    if (hostIdx < 0) continue;
    const dim = t.dimensions || {};
    const wantArea = (dim.width_m ?? 0) * (dim.height_m ?? 0);
    if (wantArea <= 0) continue;
    const remaining = surfaces[hostIdx].area_m2;
    let panelArea = wantArea;
    let clamped = false;
    if (panelArea > remaining) {
      panelArea = remaining;
      clamped = true;
      if (!clampWarned) {
        clampWarned = true;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(
            `[roomlab] Treatment ${t.id} (${t.productId}) catalogue area ${wantArea.toFixed(2)} m² ` +
            `exceeded remaining area on ${hostId} (${remaining.toFixed(2)} m²). Clamped to ${panelArea.toFixed(2)} m². ` +
            `Subsequent panels on the same wall this session will be clamped silently — check the UI badge.`
          );
        }
      }
      t._physicsClamped = true;   // surfaced in panel-treatments.js as a "Clamped" badge
    } else {
      t._physicsClamped = false;
    }
    surfaces[hostIdx].area_m2 = Math.max(0, remaining - panelArea);
    surfaces.push({
      id: `treatment_${t.id}`,
      area_m2: panelArea,
      materialId: `treatment:${t.productId}`,
      productId: t.productId,
      _isTreatment: true,
    });
  }
}

// Synthesise PR2-format wall openings from `room.surauStructure` for the
// named SCENE wall key. Returned openings are merged into the wall slot's
// own openings[] at both render time (scene.js → buildWallGeoWithHoles +
// attachOpeningMesh) and acoustics time (expandWallWithOpenings below)
// so the building's entrances become real holes in the wall mesh AND
// real α=1.0 boundaries in the Sabine sum.
//
// Compass-name swap: the surau preset uses building-compass labels
// (preset's `south` = the main entrance wall at state-y = 0), but
// scene.js's wall keys are inverted (`wall_north` is the mesh at world
// z = 0, which is the main entrance face). We bridge the swap inside
// this helper so callers pass scene keys.
//
//   sceneWallKey      preset's wall   building face
//   wall_north        'south'         main entrance (z = 0)
//   wall_south        'north'         qibla / mihrab (z = D)
//   wall_east         'east'          right side (x = W)
//   wall_west         'west'          left side (x = 0)
//
// Coord mapping per wall (mesh-local x along wall, z from floor):
//   wall_north (rot Y=π):   mesh-local +x → world -x.   x_m = W - center_x_m - w/2
//   wall_south (rot Y=0):   mesh-local +x → world +x.   x_m = center_x_m - w/2
//   wall_east  (rot Y=-π/2): mesh-local +x → world +z.   x_m = center_y_m - w/2
//   wall_west  (rot Y=+π/2): mesh-local +x → world -z.   x_m = D - center_y_m - w/2
//
// All openings are returned with state='open', kind='door', and
// system=false so attachOpeningMesh creates the no_walk_collide invisible
// quad and the third-person-controller's collision filter (which honours
// no_walk_collide explicitly) lets the avatar pass through.
export function surauStructureWallOpenings(room, sceneWallKey) {
  const s = room?.surauStructure;
  if (!s) return [];
  const W = Number(room.width_m) || 0;
  const D = Number(room.depth_m) || 0;
  const out = [];

  const presetWall = (
    sceneWallKey === 'wall_north' ? 'south' :
    sceneWallKey === 'wall_south' ? 'north' :
    sceneWallKey === 'wall_east'  ? 'east'  :
    sceneWallKey === 'wall_west'  ? 'west'  : null
  );
  if (!presetWall) return [];

  // entrances[] — east/west (and optionally north/south on user request).
  if (Array.isArray(s.entrances)) {
    for (const ent of s.entrances) {
      if (!ent || ent.wall !== presetWall) continue;
      const ow = Number.isFinite(ent.width_m)  ? ent.width_m  : 1.2;
      const oh = Number.isFinite(ent.height_m) ? ent.height_m : 2.4;
      if (ow <= 0 || oh <= 0) continue;
      const cy = Number.isFinite(ent.center_y_m) ? ent.center_y_m : D / 2;

      let x_m;
      if      (sceneWallKey === 'wall_east')  x_m = cy - ow / 2;          // mesh-x → world +z
      else if (sceneWallKey === 'wall_west')  x_m = (D - cy) - ow / 2;    // mesh-x → world -z
      else if (sceneWallKey === 'wall_south') x_m = cy - ow / 2;          // preset 'north' on z=D wall, mesh-x → world +x
      else /* wall_north */                   x_m = (W - cy) - ow / 2;    // preset 'south' on z=0 wall, mesh-x → world -x
      // For north/south walls, ent.center_y_m is interpreted as the world
      // x-coordinate of the door centre (caller is positioning along the
      // long axis of that wall). For east/west walls it's world-z. The
      // preset's existing usage matches this convention.

      out.push({
        id: `surau_${presetWall}_ent_${out.length}`,
        kind: 'door',
        x_m,
        z_m: 0,
        width_m: ow,
        height_m: oh,
        state: 'open',
        materialId: 'open-air',
        system: false,
      });
    }
  }

  // southPartition.doorCenters_x_m — three doors on the main entrance
  // wall (preset 'south' = scene wall_north). Width / height come from
  // shared southPartition fields.
  if (sceneWallKey === 'wall_north' && s.southPartition) {
    const sp = s.southPartition;
    const ow = Number.isFinite(sp.doorWidth_m) ? sp.doorWidth_m : 1.0;
    const oh = Number.isFinite(sp.height_m) ? sp.height_m : 2.4;
    const centers = Array.isArray(sp.doorCenters_x_m) ? sp.doorCenters_x_m : [];
    for (const dc of centers) {
      const cx = Number(dc);
      if (!Number.isFinite(cx) || ow <= 0 || oh <= 0) continue;
      const x_m = (W - cx) - ow / 2;   // wall_north: mesh-x → world -x
      out.push({
        id: `surau_southdoor_${out.length}`,
        kind: 'door',
        x_m,
        z_m: 0,
        width_m: ow,
        height_m: oh,
        state: 'open',
        materialId: 'open-air',
        system: false,
      });
    }
  }

  return out;
}

// Merge any synthetic surauStructure openings into a wall slot's own
// openings[]. Returns a NEW slot object (does not mutate `slot`) so
// repeated calls during a single rebuild stay idempotent and the
// underlying state.room.surfaces.* remains the user's authored data.
export function applySurauOpeningsToSlot(slot, room, sceneWallKey) {
  const synth = surauStructureWallOpenings(room, sceneWallKey);
  if (synth.length === 0) return slot;
  const norm = normalizeWallSlot(slot);
  return {
    materialId: norm.materialId,
    openings: [...norm.openings, ...synth],
  };
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
    // surauStructure entrances + south-partition doors become α=1.0
    // open-air surfaces here (alongside any user-authored openings on
    // the wall slot itself). Idempotent — applySurauOpeningsToSlot
    // returns the original slot unchanged when surauStructure is absent.
    result.push(...expandWallWithOpenings(applySurauOpeningsToSlot(s.wall_north, room, 'wall_north'), 'wall_north', w * wallH, 'gypsum-board'));
    result.push(...expandWallWithOpenings(applySurauOpeningsToSlot(s.wall_south, room, 'wall_south'), 'wall_south', w * wallH, 'gypsum-board'));
    result.push(...expandWallWithOpenings(applySurauOpeningsToSlot(s.wall_east,  room, 'wall_east'),  'wall_east',  d * wallH, 'gypsum-board'));
    result.push(...expandWallWithOpenings(applySurauOpeningsToSlot(s.wall_west,  room, 'wall_west'),  'wall_west',  d * wallH, 'gypsum-board'));
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

  // Append surauStructure exterior surfaces — podium top, arcade columns,
  // arcade roof undersides, portico walls + roof, southPartition. These
  // entered the precision-tracer BVH on 2026-05-17; this Sabine path
  // catches them so the simplified (Sabine / Eyring) reverberation
  // calculation reflects the same surface area. Capped at 30% of the
  // outer wall area so the arcade roof (~150 m²) doesn't dominate the
  // hall's own ~155 m² of wall area and crash RT60 unrealistically.
  const surau = surauStructureSurfaces(room);
  if (surau.length) result = result.concat(surau);

  return result;
}

// ---------------------------------------------------------------------------
// Surfaces introduced by room.surauStructure (mosque prayer-hall preset).
// Returns an array of { id, area_m2, materialId } entries appended to the
// outer-shell surfaces by roomSurfaces().
//
// Geometry (all areas in m²; coordinate convention matches the renderer):
//   • podium top   — flat rect at z=0, spans (-ext, -ext) to (W+ext, D+ext)
//                    MINUS the prayer-hall footprint (W × D), since the
//                    prayer-hall floor is already counted as the shell's
//                    'floor' entry. Net podium area = (W+2ext)(D+2ext) − W·D.
//   • arcade cols  — per side, n_bays+1 pillars, each pillar has 4 vertical
//                    faces of colT × (roofH − 0) so per-pillar lateral
//                    surface area = 4·colT·roofH. Pillar count per side
//                    derived the same way the renderer derives it.
//   • arcade roof  — per side, depth_m × (sideLen − 2·startInset). Each
//                    side counts as one underside rectangle. Skip a side
//                    with no requested wrap.
//   • portico wall — front + 2 sides, area = poH·poW + 2·poH·poD. The
//                    front-wall arch cutout is ignored (treated as solid)
//                    matching the BVH simplification.
//   • portico roof — pyramid underside, total slant area ≈ poW·poD ·
//                    sqrt(1 + (poApex/min(poW,poD))²) — approximate as the
//                    horizontal footprint scaled by 1.1 for the apex
//                    slope. Cheap and accurate to ~5%.
//   • south part'n — sum of segment widths × bandH, plus lintels above
//                    each door cutout (small).
//
// Cap: the sum of new areas is reduced to at most 30% of the prayer-hall
// total outer wall area. Mathematically equivalent to a global α-scale —
// the additional area still has the right per-band absorption profile,
// just multiplied by min(1, 0.3·wallArea / surauArea). The cap is a
// modelling simplification (Dr. Chen's audit P-class) acknowledging that
// the arcade is NOT inside the closed-room volume Sabine assumes; we're
// only crediting the absorbing surface for its first-bounce effect, not
// pretending it's a full reverberant participant.
function surauStructureSurfaces(room) {
  const s = room?.surauStructure;
  if (!s || room.shape !== 'rectangular') return [];
  const W = Number(room.width_m) || 0;
  const D = Number(room.depth_m) || 0;
  const wallH = Number(room.height_m) || 0;
  if (!(W > 0 && D > 0 && wallH > 0)) return [];

  const mats = s.materials || {};
  const podiumMatId      = mats.podium_top      || 'concrete-painted';
  const arcadeColMatId   = mats.arcade_columns  || 'concrete-painted';
  const arcadeRoofMatId  = mats.arcade_roof     || 'gypsum-board';
  const porticoWallMatId = mats.portico_walls   || 'concrete-painted';
  const porticoRoofMatId = mats.portico_roof    || 'gypsum-board';
  const partitionMatId   = mats.south_partition || s.southPartition?.materialId || 'concrete-painted';

  const out = [];

  // Podium top (extension area only — prayer-hall footprint is already
  // counted by the shell's 'floor' entry).
  if (s.podium && Number.isFinite(s.podium.extension_m) && s.podium.extension_m > 0.05) {
    const ext = s.podium.extension_m;
    const grossArea = (W + 2 * ext) * (D + 2 * ext);
    const netArea = Math.max(0, grossArea - W * D);
    if (netArea > 0.5) {
      out.push({ id: 'surau_podium_top', area_m2: netArea, materialId: podiumMatId });
    }
  }

  // Arcade columns + roof. Bay count per side mirrors the renderer's
  // floor(usableLen / bayW) and emits (n+1) columns per side.
  if (s.arcade && Array.isArray(s.arcade.sides) && s.arcade.sides.length > 0) {
    const depth_m = Number.isFinite(s.arcade.depth_m) ? s.arcade.depth_m : 3.0;
    const bayW    = Number.isFinite(s.arcade.column_spacing_m) ? s.arcade.column_spacing_m : 2.8;
    const colT    = Number.isFinite(s.arcade.column_thickness_m) ? s.arcade.column_thickness_m : 0.30;
    const roofZ   = Number.isFinite(s.arcade.roof_height_m) ? s.arcade.roof_height_m : 4.4;
    const startInset = depth_m * 0.5;
    const endInset   = depth_m * 0.5;
    const perPillarArea = 4 * colT * roofZ;       // 4 wall faces × colT × height

    let totalColArea = 0;
    let totalRoofArea = 0;
    for (const sideName of s.arcade.sides) {
      const sideLen = (sideName === 'south' || sideName === 'north') ? W : D;
      const usableLen = sideLen - startInset - endInset;
      if (usableLen < bayW) continue;
      const nBays = Math.max(1, Math.floor(usableLen / bayW));
      totalColArea  += (nBays + 1) * perPillarArea;
      totalRoofArea += depth_m * usableLen;
    }
    if (totalColArea > 0.5) {
      out.push({ id: 'surau_arcade_columns', area_m2: totalColArea, materialId: arcadeColMatId });
    }
    if (totalRoofArea > 0.5) {
      out.push({ id: 'surau_arcade_roof', area_m2: totalRoofArea, materialId: arcadeRoofMatId });
    }
  }

  // Portico walls + pyramid roof underside.
  if (s.portico) {
    const poW = Number.isFinite(s.portico.width_m) ? s.portico.width_m : 3.0;
    const poD = Number.isFinite(s.portico.depth_m) ? s.portico.depth_m : 3.0;
    const poH = Number.isFinite(s.portico.height_m) ? s.portico.height_m : 4.5;
    const poApex = Number.isFinite(s.portico.apexRise_m) ? s.portico.apexRise_m : 1.0;
    const wallArea = poW * poH + 2 * poD * poH;
    // Pyramid slant approximation: 4 triangles of base · slantH/2 each.
    // For a rectangular pyramid with apex centred, two faces have base poW
    // and slant √((poD/2)² + apex²); two have base poD and slant
    // √((poW/2)² + apex²). Total = poW·√((poD/2)² + apex²) + poD·√((poW/2)² + apex²).
    const slantA = Math.sqrt((poD / 2) ** 2 + poApex ** 2);
    const slantB = Math.sqrt((poW / 2) ** 2 + poApex ** 2);
    const roofArea = poW * slantA + poD * slantB;
    if (wallArea > 0.5) {
      out.push({ id: 'surau_portico_walls', area_m2: wallArea, materialId: porticoWallMatId });
    }
    if (roofArea > 0.5) {
      out.push({ id: 'surau_portico_roof', area_m2: roofArea, materialId: porticoRoofMatId });
    }
  }

  // South partition — segment widths × band height (excluding door gaps).
  if (s.southPartition) {
    const bandH = Number.isFinite(s.southPartition.height_m) ? s.southPartition.height_m : 2.4;
    const doorW = Number.isFinite(s.southPartition.doorWidth_m) ? s.southPartition.doorWidth_m : 1.0;
    const doorCount = Array.isArray(s.southPartition.doorCenters_x_m)
      ? s.southPartition.doorCenters_x_m.length : 0;
    const partitionSolidW = Math.max(0, W - doorCount * doorW);
    const partitionArea = partitionSolidW * bandH + doorCount * 0.25 * doorW;  // lintels at 0.25 m tall
    if (partitionArea > 0.5) {
      out.push({ id: 'south_partition', area_m2: partitionArea, materialId: partitionMatId });
    }
  }

  if (out.length === 0) return out;

  // Cap total surauStructure area at 30% of the outer-wall area so the
  // arcade roof + podium can't dominate the prayer hall's own wall
  // absorption. Documented modelling simplification — the arcade is NOT
  // inside Sabine's closed-volume assumption, so its absorption is
  // credited but capped.
  const outerWallArea = 2 * (W + D) * wallH;
  const totalNewArea = out.reduce((acc, e) => acc + e.area_m2, 0);
  const cap = 0.30 * outerWallArea;
  if (totalNewArea > cap && cap > 0) {
    const scale = cap / totalNewArea;
    for (const e of out) e.area_m2 *= scale;
  }

  return out;
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
