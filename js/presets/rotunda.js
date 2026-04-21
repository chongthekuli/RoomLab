// Small round domed room — 4 compact speakers on the walls.
import { SPK6 } from './_shared.js';

export default {
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
};
