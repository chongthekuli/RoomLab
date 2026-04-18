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
  polygon: 'Polygon',
  round: 'Round',
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

export const state = {
  room: {
    shape: 'rectangular',
    width_m: 4.5,
    height_m: 2.7,
    depth_m: 6,
    polygon_sides: 6,
    polygon_radius_m: 2.5,
    round_radius_m: 2.5,
    ceiling_type: 'flat',
    ceiling_dome_rise_m: 0.8,
    surfaces: {
      floor: 'carpet-heavy',
      ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board',
      wall_south: 'gypsum-board',
      wall_east: 'gypsum-board',
      wall_west: 'gypsum-board',
      walls: 'gypsum-board',
    },
  },
  sources: [],
  listeners: [],
  selectedListenerId: null,
  results: { rt60: null, splGrid: null },
};

export const DEFAULT_HIFI_SOURCES = [
  { position: { x: 1.0, y: 0.8, z: 1.0 }, aim: { yaw: 10, pitch: 0, roll: 0 }, power_watts: 50 },
  { position: { x: 3.5, y: 0.8, z: 1.0 }, aim: { yaw: -10, pitch: 0, roll: 0 }, power_watts: 50 },
];

export const DEFAULT_LISTENER = {
  id: 'L1',
  label: 'Listener 1',
  position: { x: 2.25, y: 2.8 },
  posture: 'sitting_chair',
  custom_ear_height_m: null,
};

export const PRESETS = {
  bedroom: {
    label: 'Bedroom',
    shape: 'rectangular', ceiling_type: 'flat',
    width_m: 4, height_m: 2.6, depth_m: 4,
    surfaces: {
      floor: 'carpet-heavy', ceiling: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'glass-window',
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
