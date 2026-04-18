export const state = {
  room: {
    width_m: 6,
    height_m: 2.8,
    depth_m: 8,
    surfaces: {
      floor: 'wood-floor',
      ceiling: 'gypsum-board',
      wall_north: 'gypsum-board',
      wall_south: 'gypsum-board',
      wall_east: 'gypsum-board',
      wall_west: 'glass-window',
    },
  },
  sources: [],
  listeners: [],
  results: { rt60: null, spl: null },
};

export const PRESETS = {
  bedroom: {
    label: 'Bedroom',
    width_m: 4, height_m: 2.6, depth_m: 4,
    surfaces: {
      floor: 'carpet-heavy', ceiling: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'glass-window',
    },
  },
  classroom: {
    label: 'Classroom',
    width_m: 8, height_m: 3, depth_m: 10,
    surfaces: {
      floor: 'wood-floor', ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
  },
  conference: {
    label: 'Conference room',
    width_m: 6, height_m: 2.8, depth_m: 8,
    surfaces: {
      floor: 'carpet-heavy', ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'glass-window',
    },
  },
  livevenue: {
    label: 'Live venue',
    width_m: 15, height_m: 6, depth_m: 20,
    surfaces: {
      floor: 'concrete-painted', ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
  },
  studio: {
    label: 'Studio (dead)',
    width_m: 5, height_m: 2.7, depth_m: 6,
    surfaces: {
      floor: 'carpet-heavy', ceiling: 'acoustic-tile',
      wall_north: 'acoustic-tile', wall_south: 'acoustic-tile',
      wall_east: 'acoustic-tile', wall_west: 'acoustic-tile',
    },
  },
};
