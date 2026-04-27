// Live-music venue template — rectangle with stage zone front-centre,
// flown line-array mains flanking the stage, plus a centre-fill 12".
import { SPK12, SPKLA, rectVerts } from '../presets/shared.js';

export default {
  label: 'Live venue',
  shape: 'rectangular',
  defaultDims: { width_m: 15, depth_m: 20, height_m: 6 },
  generate({ width_m, depth_m, height_m }) {
    const stageX1 = width_m * 0.333, stageY1 = depth_m * 0.025;
    const stageX2 = width_m * 0.667, stageY2 = depth_m * 0.20;
    return {
      shape: 'rectangular',
      ceiling_type: 'flat',
      width_m, depth_m, height_m,
      surfaces: {
        floor: 'concrete-painted', ceiling: 'acoustic-tile',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
      zones: [
        { id: 'Z1', label: 'Stage',    vertices: rectVerts(stageX1, stageY1, stageX2, stageY2),                                         elevation_m: 1.0, material_id: 'wood-floor' },
        { id: 'Z2', label: 'Audience', vertices: rectVerts(width_m * 0.067, depth_m * 0.25, width_m * 0.933, depth_m * 0.95),           elevation_m: 0.0, material_id: 'concrete-painted' },
      ],
      sources: [
        { modelUrl: SPKLA, position: { x: width_m * 0.267, y: depth_m * 0.10, z: Math.min(height_m - 1, 5)   }, aim: { yaw:  15, pitch: -10, roll: 0 }, power_watts: 500, groupId: 'A' },
        { modelUrl: SPKLA, position: { x: width_m * 0.733, y: depth_m * 0.10, z: Math.min(height_m - 1, 5)   }, aim: { yaw: -15, pitch: -10, roll: 0 }, power_watts: 500, groupId: 'A' },
        { modelUrl: SPK12, position: { x: width_m / 2,     y: depth_m * 0.05, z: Math.min(height_m - 1, 2.5) }, aim: { yaw:   0, pitch:  -5, roll: 0 }, power_watts: 200, groupId: 'B' },
      ],
      listeners: [
        { id: 'L1', label: 'Listener 1', position: { x: width_m / 2, y: depth_m * 0.6 }, posture: 'standing', custom_ear_height_m: null },
      ],
    };
  },
};
