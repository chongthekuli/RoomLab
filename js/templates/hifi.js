// Hi-fi listening room template — small rectangular shoebox, two
// bookshelf monitors toed in toward the listening seat. Positions are
// expressed as fractions of width/depth so the layout scales sensibly
// when the user changes dimensions.
import { SPK12 } from '../presets/shared.js';

export default {
  label: 'Hi-fi room',
  shape: 'rectangular',
  defaultDims: { width_m: 4.5, depth_m: 6, height_m: 2.7 },
  generate({ width_m, depth_m, height_m }) {
    return {
      shape: 'rectangular',
      ceiling_type: 'flat',
      width_m, depth_m, height_m,
      surfaces: {
        floor: 'carpet-heavy', ceiling: 'acoustic-tile',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
      zones: [],
      sources: [
        { modelUrl: SPK12, position: { x: width_m * 0.222, y: depth_m * 0.133, z: 1.0 }, aim: { yaw:  10, pitch: 0, roll: 0 }, power_watts: 50, groupId: 'A' },
        { modelUrl: SPK12, position: { x: width_m * 0.778, y: depth_m * 0.133, z: 1.0 }, aim: { yaw: -10, pitch: 0, roll: 0 }, power_watts: 50, groupId: 'A' },
      ],
      listeners: [
        { id: 'L1', label: 'Listener 1', position: { x: width_m / 2, y: depth_m * 0.467 }, posture: 'sitting_chair', custom_ear_height_m: null },
      ],
    };
  },
};
