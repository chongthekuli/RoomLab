// Flat-roof octagonal hall, 4 directional speakers near the walls.
import { SPK12 } from './shared.js';

export default {
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
};
