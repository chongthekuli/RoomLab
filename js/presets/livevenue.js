// Live-music venue — 15 × 20 m rectangle, stage front, line-array mains
// flanking the stage + a centre-fill 12" driver.
import { SPK12, SPKLA, rectVerts } from './_shared.js';

export default {
  label: 'Live venue',
  shape: 'rectangular', ceiling_type: 'flat',
  width_m: 15, height_m: 6, depth_m: 20,
  surfaces: {
    floor: 'concrete-painted', ceiling: 'acoustic-tile',
    wall_north: 'gypsum-board', wall_south: 'gypsum-board',
    wall_east: 'gypsum-board', wall_west: 'gypsum-board',
  },
  zones: [
    { id: 'Z1', label: 'Stage',    vertices: rectVerts(5, 0.5, 10, 4),    elevation_m: 1.0, material_id: 'wood-floor' },
    { id: 'Z2', label: 'Audience', vertices: rectVerts(1, 5,   14, 19),   elevation_m: 0.0, material_id: 'concrete-painted' },
  ],
  sources: [
    { modelUrl: SPKLA, position: { x: 4,   y: 2, z: 5   }, aim: { yaw:  15, pitch: -10, roll: 0 }, power_watts: 500, groupId: 'A' },
    { modelUrl: SPKLA, position: { x: 11,  y: 2, z: 5   }, aim: { yaw: -15, pitch: -10, roll: 0 }, power_watts: 500, groupId: 'A' },
    { modelUrl: SPK12, position: { x: 7.5, y: 1, z: 2.5 }, aim: { yaw:   0, pitch:  -5, roll: 0 }, power_watts: 200, groupId: 'B' },
  ],
  listeners: [
    { id: 'L1', label: 'Listener 1', position: { x: 7.5, y: 12 }, posture: 'standing', custom_ear_height_m: null },
  ],
};
