// Classical recital hall — 12 × 18 m shoebox with a slight domed rise,
// stage at front, tiered stalls.
import { SPK12, rectVerts } from './_shared.js';

export default {
  label: 'Recital hall',
  shape: 'rectangular', ceiling_type: 'dome',
  width_m: 12, height_m: 5, depth_m: 18,
  ceiling_dome_rise_m: 0.8,
  surfaces: {
    floor: 'wood-floor', ceiling: 'gypsum-board',
    wall_north: 'gypsum-board', wall_south: 'gypsum-board',
    wall_east: 'gypsum-board', wall_west: 'gypsum-board',
  },
  zones: [
    { id: 'Z1', label: 'Stage',         vertices: rectVerts(3, 1,   9, 4),    elevation_m: 0.6, material_id: 'wood-floor' },
    { id: 'Z2', label: 'Front stalls',  vertices: rectVerts(2, 5,  10, 9),    elevation_m: 0.0, material_id: 'carpet-heavy' },
    { id: 'Z3', label: 'Middle stalls', vertices: rectVerts(2, 9.5, 10, 13),  elevation_m: 0.3, material_id: 'carpet-heavy' },
    { id: 'Z4', label: 'Back stalls',   vertices: rectVerts(2, 13.5, 10, 17), elevation_m: 0.6, material_id: 'carpet-heavy' },
  ],
  sources: [
    { modelUrl: SPK12, position: { x: 3.5, y: 3, z: 3.5 }, aim: { yaw:  15, pitch: -12, roll: 0 }, power_watts: 150, groupId: 'A' },
    { modelUrl: SPK12, position: { x: 8.5, y: 3, z: 3.5 }, aim: { yaw: -15, pitch: -12, roll: 0 }, power_watts: 150, groupId: 'A' },
  ],
  listeners: [
    { id: 'L1', label: 'Listener 1', position: { x: 6, y: 10 }, posture: 'sitting_chair', custom_ear_height_m: null },
  ],
};
