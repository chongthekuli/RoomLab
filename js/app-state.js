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
  if (listener.posture === 'custom' && typeof listener.custom_ear_height_m === 'number') {
    return listener.custom_ear_height_m;
  }
  return POSTURE_EAR_HEIGHTS_M[listener.posture] ?? 1.2;
}

export function getSelectedListener() {
  if (state.selectedListenerId == null) return null;
  return state.listeners.find(l => l.id === state.selectedListenerId) || null;
}

// --- Zone + group color palettes ---
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

// --- Geometry helpers for preset construction ---
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

// --- Default state (boots into auditorium) ---
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

// PA: 4 speakers at 4.5 m ringing the stage, each pitched -20°, aimed at its audience block
export const DEFAULT_AUDITORIUM_SOURCES = [
  { position: { x: 10, y: 8,  z: 4.5 }, aim: { yaw: 180, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'A' },
  { position: { x: 10, y: 12, z: 4.5 }, aim: { yaw: 0,   pitch: -20, roll: 0 }, power_watts: 200, groupId: 'A' },
  { position: { x: 12, y: 10, z: 4.5 }, aim: { yaw: 90,  pitch: -20, roll: 0 }, power_watts: 200, groupId: 'B' },
  { position: { x: 8,  y: 10, z: 4.5 }, aim: { yaw: -90, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'B' },
];

// Stage (hex) + four tiered audience blocks at different elevations
export const DEFAULT_AUDITORIUM_ZONES = [
  { id: 'Z1', label: 'Stage',           vertices: hexagonVerts(10, 10, 2),        elevation_m: 0.50, material_id: 'wood-floor' },
  { id: 'Z2', label: 'North audience',  vertices: rectVerts(7,    3.5, 13,  7.5), elevation_m: 0.00, material_id: 'carpet-heavy' },
  { id: 'Z3', label: 'East audience',   vertices: rectVerts(12.5, 7.5, 16.5, 12.5), elevation_m: 0.25, material_id: 'carpet-heavy' },
  { id: 'Z4', label: 'South audience',  vertices: rectVerts(7,   12.5, 13,  16.5), elevation_m: 0.50, material_id: 'carpet-heavy' },
  { id: 'Z5', label: 'West audience',   vertices: rectVerts(3.5,  7.5, 7.5, 12.5), elevation_m: 0.25, material_id: 'carpet-heavy' },
];

export const DEFAULT_LISTENER = {
  id: 'L1',
  label: 'Listener 1',
  position: { x: 10, y: 5 },
  posture: 'sitting_chair',
  custom_ear_height_m: null,
};

// Kept for backward compatibility if a caller references it
export const DEFAULT_HIFI_SOURCES = [
  { position: { x: 1.0, y: 0.8, z: 1.0 }, aim: { yaw: 10, pitch: 0, roll: 0 }, power_watts: 50 },
  { position: { x: 3.5, y: 0.8, z: 1.0 }, aim: { yaw: -10, pitch: 0, roll: 0 }, power_watts: 50 },
];

// --- Presets (auditorium first so it's the default reset target) ---
export const PRESETS = {
  auditorium: {
    label: 'Auditorium (arena)',
    shape: 'polygon',
    ceiling_type: 'dome',
    polygon_sides: 16,
    polygon_radius_m: 10,
    width_m: 20, height_m: 7, depth_m: 20,
    ceiling_dome_rise_m: 1.5,
    surfaces: {
      floor: 'wood-floor', ceiling: 'acoustic-tile',
      walls: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: DEFAULT_AUDITORIUM_ZONES,
  },
  recitalhall: {
    label: 'Recital hall',
    shape: 'rectangular',
    ceiling_type: 'dome',
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
  },
  rotunda: {
    label: 'Rotunda (round + dome)',
    shape: 'round', ceiling_type: 'dome',
    round_radius_m: 4,
    width_m: 8, height_m: 3.5, depth_m: 8,
    ceiling_dome_rise_m: 1.5,
    surfaces: {
      floor: 'wood-floor', ceiling: 'gypsum-board',
      walls: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
  },
  octagon: {
    label: 'Octagonal hall',
    shape: 'polygon', ceiling_type: 'flat',
    polygon_sides: 8, polygon_radius_m: 5,
    width_m: 10, height_m: 4, depth_m: 10,
    surfaces: {
      floor: 'wood-floor', ceiling: 'acoustic-tile',
      walls: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
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
  },
};
