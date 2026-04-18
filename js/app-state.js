export const POSTURE_EAR_HEIGHTS_M = {
  standing: 1.60,
  sitting_chair: 1.15,
  sitting_floor: 0.85,
};

export const POSTURE_LABELS = {
  standing: 'Standing',
  sitting_chair: 'Sitting in chair',
  sitting_floor: 'Sitting on floor',
  custom: 'Custom height',
};

export const SHAPE_LABELS = {
  rectangular: 'Rectangular',
  polygon: 'Regular polygon',
  round: 'Round',
  custom: 'Custom (drawn)',
};

export const CEILING_LABELS = {
  flat: 'Flat',
  dome: 'Domed (spherical cap)',
};

export function earHeightFor(listener) {
  if (!listener) return 1.2;
  const elev = listener.elevation_m ?? 0;
  if (listener.posture === 'custom' && typeof listener.custom_ear_height_m === 'number') {
    return listener.custom_ear_height_m;
  }
  return elev + (POSTURE_EAR_HEIGHTS_M[listener.posture] ?? 1.2);
}

export function getSelectedListener() {
  if (state.selectedListenerId == null) return null;
  return state.listeners.find(l => l.id === state.selectedListenerId) || null;
}

export const ZONE_COLORS = [
  '#a855f7', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#6366f1',
];
export function colorForZone(idx) { return ZONE_COLORS[idx % ZONE_COLORS.length]; }

export const SPEAKER_GROUPS = [
  { id: 'A', label: 'Group A', color: '#ef4444' },
  { id: 'B', label: 'Group B', color: '#3b82f6' },
  { id: 'C', label: 'Group C', color: '#10b981' },
  { id: 'D', label: 'Group D', color: '#f59e0b' },
  { id: 'E', label: 'Group E', color: '#a855f7' },
  { id: 'F', label: 'Group F', color: '#ec4899' },
];
export function groupById(id) { return SPEAKER_GROUPS.find(g => g.id === id) || null; }
export function colorForGroup(id) { return groupById(id)?.color ?? '#ffffff'; }

export const SPEAKER_CATALOG = [
  { url: 'data/loudspeakers/generic-12inch.json',       label: 'Generic 12" 2-way' },
  { url: 'data/loudspeakers/compact-6inch.json',        label: 'Compact 6" monitor' },
  { url: 'data/loudspeakers/line-array-element.json',   label: 'Line-array element' },
];
const SPK12 = SPEAKER_CATALOG[0].url;
const SPK6  = SPEAKER_CATALOG[1].url;
const SPKLA = SPEAKER_CATALOG[2].url;

function hexagonVerts(cx, cy, r) {
  const v = [];
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    v.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return v;
}
function rectVerts(x1, y1, x2, y2) {
  return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
}

function ringSectorVerts(cx, cy, r_in, r_out, theta_start_deg, theta_end_deg, arcSteps = 5) {
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

function generateBowl({ cx, cy, r_in, r_out, elevation_m, material_id, idPrefix, labelPrefix, count = 8, startAngleDeg = -22.5 }) {
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
function generateTieredBowl({
  cx, cy, r_in, r_out, tier_heights_m, sectorCount = 4,
  material_id, idPrefix, labelPrefix, startAngleDeg,
}) {
  const sectorLabels = sectorCount === 4 ? ['E', 'S', 'W', 'N']
    : sectorCount === 8 ? ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']
    : null;
  const sectorStep = 360 / sectorCount;
  const start = startAngleDeg ?? -sectorStep / 2;
  const tierCount = tier_heights_m.length;
  const tierRadialDepth = (r_out - r_in) / tierCount;
  const zones = [];
  for (let s = 0; s < sectorCount; s++) {
    const ts = start + s * sectorStep;
    const te = ts + sectorStep;
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
      });
    }
  }
  return zones;
}

function generateCenterCluster({ cx, cy, cz, ring_r, count = 8, modelUrl, power_watts = 500, pitch = -25 }) {
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

export const state = {
  room: {
    shape: 'polygon',
    polygon_sides: 16,
    polygon_radius_m: 10,
    round_radius_m: 2.5,
    width_m: 20,
    height_m: 7,
    depth_m: 20,
    ceiling_type: 'dome',
    ceiling_dome_rise_m: 1.5,
    custom_vertices: null,
    surfaces: {
      floor: 'wood-floor',
      ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board',
      wall_south: 'gypsum-board',
      wall_east: 'gypsum-board',
      wall_west: 'gypsum-board',
      walls: 'gypsum-board',
      edges: null,
    },
  },
  sources: [],
  listeners: [],
  selectedListenerId: null,
  zones: [],
  selectedZoneId: null,
  results: { rt60: null, splGrid: null, zoneGrids: [] },
};

export const DEFAULT_PRESET_KEY = 'auditorium';

export const PRESETS = {
  auditorium: (() => {
    // Sports arena modeled after University of Wyoming Arena-Auditorium (~11,600 seats, geodesic dome).
    // 50 m polygon plan (24 sides approximates the dome). Walls 12 m + 8 m dome rise → 20 m at apex.
    // NCAA basketball court (28.7 × 15.2 m) at center. Two continuous bowls wrapping 360°, each
    // divided into 4 quadrants × 4 stepped tiers = 16 stadium rows per bowl (32 tiered zones).
    // Between lower bowl top (2.8 m) and upper bowl bottom (6 m) is the concourse. Center-hung
    // PA cluster of 8 line-array elements at 15 m.
    const cx = 25, cy = 25;
    return {
      label: 'Sports arena (dome)',
      shape: 'polygon', ceiling_type: 'dome',
      polygon_sides: 24, polygon_radius_m: 25,
      width_m: 50, height_m: 12, depth_m: 50,
      ceiling_dome_rise_m: 8,
      surfaces: {
        floor: 'wood-floor', ceiling: 'gypsum-board', walls: 'gypsum-board',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
      zones: [
        { id: 'Z_court', label: 'Court', vertices: rectVerts(10.65, 17.4, 39.35, 32.6), elevation_m: 0, material_id: 'wood-floor' },
        ...generateTieredBowl({
          cx, cy, r_in: 16, r_out: 22,
          tier_heights_m: [0.4, 1.2, 2.0, 2.8],
          sectorCount: 4, material_id: 'carpet-heavy',
          idPrefix: 'Z_lb', labelPrefix: 'Lower',
        }),
        ...generateTieredBowl({
          cx, cy, r_in: 22.5, r_out: 24.5,
          tier_heights_m: [6.0, 6.8, 7.6, 8.4],
          sectorCount: 4, material_id: 'carpet-heavy',
          idPrefix: 'Z_ub', labelPrefix: 'Upper',
        }),
      ],
      sources: generateCenterCluster({ cx, cy, cz: 15, ring_r: 3, count: 8, modelUrl: SPKLA, power_watts: 500, pitch: -25 }),
      listeners: [
        { id: 'L1', label: 'Courtside VIP',       position: { x: 12,   y: 25   }, elevation_m: 0,   posture: 'sitting_chair', custom_ear_height_m: null },
        { id: 'L2', label: 'Lower bowl front S',  position: { x: 25,   y: 41.2 }, elevation_m: 0.4, posture: 'sitting_chair', custom_ear_height_m: null },
        { id: 'L3', label: 'Lower bowl back E',   position: { x: 46.2, y: 25   }, elevation_m: 2.8, posture: 'sitting_chair', custom_ear_height_m: null },
        { id: 'L4', label: 'Upper bowl mid N',    position: { x: 25,   y: 1.8  }, elevation_m: 7.2, posture: 'sitting_chair', custom_ear_height_m: null },
      ],
    };
  })(),

  chamber: {
    label: 'Chamber (small arena)',
    shape: 'polygon', ceiling_type: 'dome',
    polygon_sides: 16, polygon_radius_m: 10,
    width_m: 20, height_m: 7, depth_m: 20,
    ceiling_dome_rise_m: 1.5,
    surfaces: {
      floor: 'wood-floor', ceiling: 'acoustic-tile', walls: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [
      { id: 'Z1', label: 'Stage',          vertices: hexagonVerts(10, 10, 2),          elevation_m: 0.50, material_id: 'wood-floor' },
      { id: 'Z2', label: 'North audience', vertices: rectVerts(7,   3.5, 13,  7.5),    elevation_m: 0.00, material_id: 'carpet-heavy' },
      { id: 'Z3', label: 'East audience',  vertices: rectVerts(12.5, 7.5, 16.5, 12.5), elevation_m: 0.25, material_id: 'carpet-heavy' },
      { id: 'Z4', label: 'South audience', vertices: rectVerts(7,   12.5, 13, 16.5),   elevation_m: 0.50, material_id: 'carpet-heavy' },
      { id: 'Z5', label: 'West audience',  vertices: rectVerts(3.5,  7.5,  7.5, 12.5), elevation_m: 0.25, material_id: 'carpet-heavy' },
    ],
    sources: [
      { modelUrl: SPK12, position: { x: 10, y: 8,  z: 4.5 }, aim: { yaw: 180, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 10, y: 12, z: 4.5 }, aim: { yaw: 0,   pitch: -20, roll: 0 }, power_watts: 200, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 12, y: 10, z: 4.5 }, aim: { yaw: 90,  pitch: -20, roll: 0 }, power_watts: 200, groupId: 'B' },
      { modelUrl: SPK12, position: { x: 8,  y: 10, z: 4.5 }, aim: { yaw: -90, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'B' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 10, y: 5 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },

  recitalhall: {
    label: 'Recital hall',
    shape: 'rectangular', ceiling_type: 'dome',
    width_m: 12, height_m: 5, depth_m: 18,
    ceiling_dome_rise_m: 0.8,
    surfaces: {
      floor: 'wood-floor', ceiling: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [
      { id: 'Z1', label: 'Stage',         vertices: rectVerts(3, 1,   9, 4),    elevation_m: 0.6, material_id: 'wood-floor' },
      { id: 'Z2', label: 'Front stalls',  vertices: rectVerts(2, 5,  10, 9),    elevation_m: 0.0, material_id: 'carpet-heavy' },
      { id: 'Z3', label: 'Middle stalls', vertices: rectVerts(2, 9.5, 10, 13),  elevation_m: 0.3, material_id: 'carpet-heavy' },
      { id: 'Z4', label: 'Back stalls',   vertices: rectVerts(2, 13.5, 10, 17), elevation_m: 0.6, material_id: 'carpet-heavy' },
    ],
    sources: [
      { modelUrl: SPK12, position: { x: 3.5, y: 3, z: 3.5 }, aim: { yaw:  15, pitch: -12, roll: 0 }, power_watts: 150, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 8.5, y: 3, z: 3.5 }, aim: { yaw: -15, pitch: -12, roll: 0 }, power_watts: 150, groupId: 'A' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 6, y: 10 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },

  rotunda: {
    label: 'Rotunda (round + dome)',
    shape: 'round', ceiling_type: 'dome',
    round_radius_m: 4,
    width_m: 8, height_m: 3.5, depth_m: 8,
    ceiling_dome_rise_m: 1.5,
    surfaces: {
      floor: 'wood-floor', ceiling: 'gypsum-board', walls: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [],
    sources: [
      { modelUrl: SPK6, position: { x: 4,   y: 1.5, z: 2.5 }, aim: { yaw:   0, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'A' },
      { modelUrl: SPK6, position: { x: 4,   y: 6.5, z: 2.5 }, aim: { yaw: 180, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'A' },
      { modelUrl: SPK6, position: { x: 6.5, y: 4,   z: 2.5 }, aim: { yaw:  90, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'B' },
      { modelUrl: SPK6, position: { x: 1.5, y: 4,   z: 2.5 }, aim: { yaw: -90, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'B' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 4, y: 4 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },

  octagon: {
    label: 'Octagonal hall',
    shape: 'polygon', ceiling_type: 'flat',
    polygon_sides: 8, polygon_radius_m: 5,
    width_m: 10, height_m: 4, depth_m: 10,
    surfaces: {
      floor: 'wood-floor', ceiling: 'acoustic-tile', walls: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [],
    sources: [
      { modelUrl: SPK12, position: { x: 5, y: 2, z: 3.2 }, aim: { yaw:   0, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 5, y: 8, z: 3.2 }, aim: { yaw: 180, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 8, y: 5, z: 3.2 }, aim: { yaw:  90, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'B' },
      { modelUrl: SPK12, position: { x: 2, y: 5, z: 3.2 }, aim: { yaw: -90, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'B' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 5, y: 5 }, posture: 'standing', custom_ear_height_m: null },
    ],
  },

  hifi: {
    label: 'Hi-fi room',
    shape: 'rectangular', ceiling_type: 'flat',
    width_m: 4.5, height_m: 2.7, depth_m: 6,
    surfaces: {
      floor: 'carpet-heavy', ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [],
    sources: [
      { modelUrl: SPK12, position: { x: 1.0, y: 0.8, z: 1.0 }, aim: { yaw:  10, pitch: 0, roll: 0 }, power_watts: 50, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 3.5, y: 0.8, z: 1.0 }, aim: { yaw: -10, pitch: 0, roll: 0 }, power_watts: 50, groupId: 'A' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 2.25, y: 2.8 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },

  classroom: {
    label: 'Classroom',
    shape: 'rectangular', ceiling_type: 'flat',
    width_m: 8, height_m: 3, depth_m: 10,
    surfaces: {
      floor: 'wood-floor', ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [],
    sources: [
      { modelUrl: SPK6, position: { x: 4, y: 1.5, z: 2.5 }, aim: { yaw:   0, pitch: -15, roll: 0 }, power_watts: 60, groupId: 'A' },
      { modelUrl: SPK6, position: { x: 4, y: 7,   z: 2.5 }, aim: { yaw: 180, pitch: -20, roll: 0 }, power_watts: 60, groupId: 'A' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 4, y: 5 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },

  livevenue: {
    label: 'Live venue',
    shape: 'rectangular', ceiling_type: 'flat',
    width_m: 15, height_m: 6, depth_m: 20,
    surfaces: {
      floor: 'concrete-painted', ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [
      { id: 'Z1', label: 'Stage',    vertices: rectVerts(5, 0.5, 10, 4),    elevation_m: 1.0, material_id: 'wood-floor' },
      { id: 'Z2', label: 'Audience', vertices: rectVerts(1, 5,   14, 19),   elevation_m: 0.0, material_id: 'concrete-painted' },
    ],
    sources: [
      { modelUrl: SPKLA, position: { x: 4,   y: 2, z: 5   }, aim: { yaw:  15, pitch: -10, roll: 0 }, power_watts: 500, groupId: 'A' },
      { modelUrl: SPKLA, position: { x: 11,  y: 2, z: 5   }, aim: { yaw: -15, pitch: -10, roll: 0 }, power_watts: 500, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 7.5, y: 1, z: 2.5 }, aim: { yaw:   0, pitch:  -5, roll: 0 }, power_watts: 200, groupId: 'B' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 7.5, y: 12 }, posture: 'standing', custom_ear_height_m: null },
    ],
  },

  studio: {
    label: 'Studio (dead)',
    shape: 'rectangular', ceiling_type: 'flat',
    width_m: 5, height_m: 2.7, depth_m: 6,
    surfaces: {
      floor: 'carpet-heavy', ceiling: 'acoustic-tile',
      wall_north: 'acoustic-tile', wall_south: 'acoustic-tile',
      wall_east: 'acoustic-tile', wall_west: 'acoustic-tile',
    },
    zones: [],
    sources: [
      { modelUrl: SPK6, position: { x: 1.8, y: 1.2, z: 1.2 }, aim: { yaw:  15, pitch: 0, roll: 0 }, power_watts: 40, groupId: 'A' },
      { modelUrl: SPK6, position: { x: 3.2, y: 1.2, z: 1.2 }, aim: { yaw: -15, pitch: 0, roll: 0 }, power_watts: 40, groupId: 'A' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 2.5, y: 2.5 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },
};

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

export function applyPresetToState(key) {
  const p = PRESETS[key];
  if (!p) return;
  state.room.shape = p.shape ?? 'rectangular';
  state.room.ceiling_type = p.ceiling_type ?? 'flat';
  state.room.width_m = p.width_m;
  state.room.height_m = p.height_m;
  state.room.depth_m = p.depth_m;
  if (p.polygon_sides != null)      state.room.polygon_sides = p.polygon_sides;
  if (p.polygon_radius_m != null)   state.room.polygon_radius_m = p.polygon_radius_m;
  if (p.round_radius_m != null)     state.room.round_radius_m = p.round_radius_m;
  if (p.ceiling_dome_rise_m != null) state.room.ceiling_dome_rise_m = p.ceiling_dome_rise_m;
  Object.assign(state.room.surfaces, p.surfaces);
  if (p.shape === 'polygon' || p.shape === 'round') {
    const r = p.shape === 'polygon' ? state.room.polygon_radius_m : state.room.round_radius_m;
    state.room.width_m = 2 * r;
    state.room.depth_m = 2 * r;
  }

  if (p.zones !== undefined) {
    state.zones = p.zones.map(deepClone);
    state.selectedZoneId = state.zones[0]?.id ?? null;
  }
  if (p.sources !== undefined) {
    state.sources = p.sources.map(deepClone);
  }
  if (p.listeners !== undefined) {
    state.listeners = p.listeners.map(deepClone);
    state.selectedListenerId = state.listeners[0]?.id ?? null;
  }
}

// Kept for backward-compatibility references
export const DEFAULT_AUDITORIUM_SOURCES = PRESETS.auditorium.sources;
export const DEFAULT_AUDITORIUM_ZONES = PRESETS.auditorium.zones;
export const DEFAULT_LISTENER = PRESETS.auditorium.listeners[0];
export const DEFAULT_HIFI_SOURCES = PRESETS.hifi.sources;
