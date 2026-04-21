// Shared constants + helpers used by individual preset files.
//
// Keeping them in one module lets the per-preset files stay short and
// declarative. When a preset needs a tiered bowl, a center-cluster of
// speakers, or a rectangular audience block — they just import the
// helper and call it with the room-specific arguments.

// Speaker model URLs — matches the first three entries in SPEAKER_CATALOG
// (js/app-state.js). Presets reference these instead of hard-coding the
// file path so a catalogue rename only touches one place.
export const SPK12  = 'data/loudspeakers/generic-12inch.json';
export const SPK6   = 'data/loudspeakers/compact-6inch.json';
export const SPKLA  = 'data/loudspeakers/line-array-element.json';
export const SPK_AMPERES_CS610B = 'data/loudspeakers/amperes-cs610b.json';

// -- Simple polygon helpers -------------------------------------------------

export function hexagonVerts(cx, cy, r) {
  const v = [];
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    v.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return v;
}

export function rectVerts(x1, y1, x2, y2) {
  return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
}

// Sector of an annulus (r_in → r_out over angle range), polyline-approximated.
export function ringSectorVerts(cx, cy, r_in, r_out, theta_start_deg, theta_end_deg, arcSteps = 5) {
  const verts = [];
  const ts = theta_start_deg * Math.PI / 180;
  const te = theta_end_deg * Math.PI / 180;
  for (let i = 0; i <= arcSteps; i++) {
    const t = ts + (te - ts) * (i / arcSteps);
    verts.push({ x: cx + r_out * Math.cos(t), y: cy + r_out * Math.sin(t) });
  }
  for (let i = arcSteps; i >= 0; i--) {
    const t = ts + (te - ts) * (i / arcSteps);
    verts.push({ x: cx + r_in * Math.cos(t), y: cy + r_in * Math.sin(t) });
  }
  return verts;
}

// Simple (non-tiered) bowl — N pie-wedge sectors at a single elevation.
export function generateBowl({ cx, cy, r_in, r_out, elevation_m, material_id, idPrefix, labelPrefix, count = 8, startAngleDeg = -22.5 }) {
  const labels8 = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const step = 360 / count;
  const zones = [];
  for (let i = 0; i < count; i++) {
    const ts = startAngleDeg + i * step;
    const te = ts + step;
    zones.push({
      id: `${idPrefix}${i + 1}`,
      label: `${labelPrefix} ${labels8[i] ?? i + 1}`,
      vertices: ringSectorVerts(cx, cy, r_in, r_out, ts, te, 5),
      elevation_m,
      material_id,
    });
  }
  return zones;
}

// Tiered bowl: each sector is divided into multiple stepped tiers (rows of seats).
// Each tier is a thin ring sub-sector at its own elevation, creating a visible
// staircase profile in 3D when sampled by the per-zone heatmap planes.
// When `gapDeg` > 0, sectors are placed with angular gaps between them (for vomitory
// entrances). Center of sector N = startAngleDeg + N × (360/sectorCount).
// Sector angular width = (360/sectorCount) − gapDeg.
export function generateTieredBowl({
  cx, cy, r_in, r_out, tier_heights_m, sectorCount = 4,
  gapDeg = 0, sectorLabelsOverride = null,
  material_id, idPrefix, labelPrefix, startAngleDeg,
  occupancy_percent = 0,
}) {
  const defaultLabels4 = ['E', 'S', 'W', 'N'];
  const defaultLabels8 = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const sectorLabels = sectorLabelsOverride
    ?? (sectorCount === 4 ? defaultLabels4
        : sectorCount === 8 ? defaultLabels8
        : null);
  const sectorAngularStep = 360 / sectorCount;
  const sectorWidth = sectorAngularStep - gapDeg;
  const centerStart = startAngleDeg ?? (gapDeg > 0 ? 0 : -sectorAngularStep / 2);
  const tierCount = tier_heights_m.length;
  const tierRadialDepth = (r_out - r_in) / tierCount;
  const zones = [];
  for (let s = 0; s < sectorCount; s++) {
    const centerDeg = centerStart + s * sectorAngularStep;
    const ts = centerDeg - sectorWidth / 2;
    const te = centerDeg + sectorWidth / 2;
    const sLabel = sectorLabels?.[s] ?? (s + 1);
    for (let t = 0; t < tierCount; t++) {
      const ri = r_in + t * tierRadialDepth;
      const ro = ri + tierRadialDepth;
      zones.push({
        id: `${idPrefix}${s + 1}_${t + 1}`,
        label: `${labelPrefix} ${sLabel} row ${t + 1}`,
        vertices: ringSectorVerts(cx, cy, ri, ro, ts, te, 4),
        elevation_m: tier_heights_m[t],
        material_id,
        occupancy_percent,
      });
    }
  }
  return zones;
}

// Factory for a center-hung line-array cluster: creates N line-array entries
// (one per compass direction), each hanging from the catwalk ring and aimed
// outward+down at its audience quadrant. Each "source" here is a compound
// line-array descriptor — `expandSources` unpacks it to individual elements
// at SPL-compute / render time.
export function generateCenterLineArrayCluster({ cx, cy, cz, ring_r, hangCount = 4, elementsPerArray = 4, modelUrl, power_watts_each = 500, topTilt_deg = -12, splayAnglesDeg = null, elementSpacing_m = 0.42, startAngleDeg = 0 }) {
  const arrays = [];
  const DEFAULT_SPLAYS_BY_COUNT = {
    2: [10],
    3: [5, 10],
    4: [4, 8, 14],
    5: [2, 5, 10, 15],
    6: [2, 4, 6, 10, 14],
    8: [1, 2, 3, 4, 6, 10, 14],
  };
  const splay = splayAnglesDeg
    ?? DEFAULT_SPLAYS_BY_COUNT[elementsPerArray]
    ?? new Array(Math.max(0, elementsPerArray - 1)).fill(3);
  const step = 360 / hangCount;
  for (let i = 0; i < hangCount; i++) {
    const a_deg = startAngleDeg + i * step;
    const a_rad = a_deg * Math.PI / 180;
    const ox = cx + ring_r * Math.cos(a_rad);
    const oy = cy + ring_r * Math.sin(a_rad);
    const baseYaw = ((90 - a_deg) % 360 + 360) % 360;
    const baseYaw_signed = baseYaw > 180 ? baseYaw - 360 : baseYaw;
    arrays.push({
      kind: 'line-array',
      id: `LA${i + 1}`,
      modelUrl,
      origin: { x: ox, y: oy, z: cz },
      baseYaw_deg: baseYaw_signed,
      topTilt_deg,
      splayAnglesDeg: splay,
      elementSpacing_m,
      power_watts_each,
      groupId: (i % 2 === 0) ? 'A' : 'B',
    });
  }
  return arrays;
}

export function generateCenterCluster({ cx, cy, cz, ring_r, count = 8, modelUrl, power_watts = 500, pitch = -25 }) {
  const sources = [];
  const step = 360 / count;
  for (let i = 0; i < count; i++) {
    const a_deg = i * step;
    const a_rad = a_deg * Math.PI / 180;
    const x = cx + ring_r * Math.cos(a_rad);
    const y = cy + ring_r * Math.sin(a_rad);
    const yaw = ((90 - a_deg) % 360 + 360) % 360;
    const yaw_signed = yaw > 180 ? yaw - 360 : yaw;
    const groupId = (i % 2 === 0) ? 'A' : 'B';
    sources.push({
      modelUrl, position: { x, y, z: cz },
      aim: { yaw: yaw_signed, pitch, roll: 0 },
      power_watts, groupId,
    });
  }
  return sources;
}
