// Treated recording-studio template — heavy absorption on every surface
// gives a tight, near-anechoic mix position.
import { SPK6 } from '../presets/shared.js';

export default {
  label: 'Studio (dead)',
  shape: 'rectangular',
  defaultDims: { width_m: 5, depth_m: 6, height_m: 2.7 },
  generate({ width_m, depth_m, height_m }) {
    return {
      shape: 'rectangular',
      ceiling_type: 'flat',
      width_m, depth_m, height_m,
      surfaces: {
        floor: 'carpet-heavy', ceiling: 'acoustic-tile',
        wall_north: 'acoustic-tile', wall_south: 'acoustic-tile',
        wall_east: 'acoustic-tile', wall_west: 'acoustic-tile',
      },
      zones: [],
      sources: [
        { modelUrl: SPK6, position: { x: width_m * 0.36, y: depth_m * 0.20, z: 1.2 }, aim: { yaw:  15, pitch: 0, roll: 0 }, power_watts: 40, groupId: 'A' },
        { modelUrl: SPK6, position: { x: width_m * 0.64, y: depth_m * 0.20, z: 1.2 }, aim: { yaw: -15, pitch: 0, roll: 0 }, power_watts: 40, groupId: 'A' },
      ],
      listeners: [
        { id: 'L1', label: 'Listener 1', position: { x: width_m / 2, y: depth_m * 0.417 }, posture: 'sitting_chair', custom_ear_height_m: null },
      ],
    };
  },
};
