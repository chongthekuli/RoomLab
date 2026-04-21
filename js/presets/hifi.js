// Domestic hi-fi listening room — small rectangular, two bookshelf
// monitors toed in toward the listening seat.
import { SPK12 } from './_shared.js';

export default {
  label: 'Hi-fi room',
  shape: 'rectangular', ceiling_type: 'flat',
  width_m: 4.5, height_m: 2.7, depth_m: 6,
  surfaces: {
    floor: 'carpet-heavy', ceiling: 'acoustic-tile',
    wall_north: 'gypsum-board', wall_south: 'gypsum-board',
    wall_east: 'gypsum-board', wall_west: 'gypsum-board',
  },
  zones: [],
  sources: [
    { modelUrl: SPK12, position: { x: 1.0, y: 0.8, z: 1.0 }, aim: { yaw:  10, pitch: 0, roll: 0 }, power_watts: 50, groupId: 'A' },
    { modelUrl: SPK12, position: { x: 3.5, y: 0.8, z: 1.0 }, aim: { yaw: -10, pitch: 0, roll: 0 }, power_watts: 50, groupId: 'A' },
  ],
  listeners: [
    { id: 'L1', label: 'Listener 1', position: { x: 2.25, y: 2.8 }, posture: 'sitting_chair', custom_ear_height_m: null },
  ],
};
