// Rectangular classroom — two ceiling-mount 6" speakers firing down.
import { SPK6 } from './shared.js';

export default {
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
};
