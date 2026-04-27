// Classroom template — rectangular box with two ceiling-mount 6"
// speakers firing slightly down toward the seating.
import { SPK6 } from '../presets/shared.js';

export default {
  label: 'Classroom',
  shape: 'rectangular',
  defaultDims: { width_m: 8, depth_m: 10, height_m: 3 },
  generate({ width_m, depth_m, height_m }) {
    const ceilingZ = Math.max(0.5, height_m - 0.5);
    return {
      shape: 'rectangular',
      ceiling_type: 'flat',
      width_m, depth_m, height_m,
      surfaces: {
        floor: 'wood-floor', ceiling: 'acoustic-tile',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
      zones: [],
      sources: [
        { modelUrl: SPK6, position: { x: width_m / 2, y: depth_m * 0.15, z: ceilingZ }, aim: { yaw:   0, pitch: -15, roll: 0 }, power_watts: 60, groupId: 'A' },
        { modelUrl: SPK6, position: { x: width_m / 2, y: depth_m * 0.70, z: ceilingZ }, aim: { yaw: 180, pitch: -20, roll: 0 }, power_watts: 60, groupId: 'A' },
      ],
      listeners: [
        { id: 'L1', label: 'Listener 1', position: { x: width_m / 2, y: depth_m / 2 }, posture: 'sitting_chair', custom_ear_height_m: null },
      ],
    };
  },
};
