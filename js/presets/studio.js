// Treated recording studio — heavy absorption on walls + ceiling giving
// a very dead, tight response suitable for critical mixing.
import { SPK6 } from './shared.js';

export default {
  label: 'Studio (dead)',
  shape: 'rectangular', ceiling_type: 'flat',
  width_m: 5, height_m: 2.7, depth_m: 6,
  surfaces: {
    floor: 'carpet-heavy', ceiling: 'acoustic-tile',
    wall_north: 'acoustic-tile', wall_south: 'acoustic-tile',
    wall_east: 'acoustic-tile', wall_west: 'acoustic-tile',
  },
  zones: [],
  sources: [
    { modelUrl: SPK6, position: { x: 1.8, y: 1.2, z: 1.2 }, aim: { yaw:  15, pitch: 0, roll: 0 }, power_watts: 40, groupId: 'A' },
    { modelUrl: SPK6, position: { x: 3.2, y: 1.2, z: 1.2 }, aim: { yaw: -15, pitch: 0, roll: 0 }, power_watts: 40, groupId: 'A' },
  ],
  listeners: [
    { id: 'L1', label: 'Listener 1', position: { x: 2.5, y: 2.5 }, posture: 'sitting_chair', custom_ear_height_m: null },
  ],
};
