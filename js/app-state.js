export const state = {
  room: {
    width_m: 10,
    height_m: 3,
    depth_m: 7,
    surfaces: {
      floor: null, ceiling: null,
      wall_north: null, wall_south: null,
      wall_east: null, wall_west: null,
    },
  },
  sources: [],
  listeners: [],
  results: { rt60: null, spl: null },
};
