// Recital hall template — shoebox with a slight domed roof, stage at
// the front, three tiered stalls in the audience.
import { SPK12, rectVerts } from '../presets/shared.js';

export default {
  label: 'Recital hall',
  shape: 'rectangular',
  defaultDims: { width_m: 12, depth_m: 18, height_m: 5, ceiling_dome_rise_m: 0.8 },
  generate({ width_m, depth_m, height_m, ceiling_dome_rise_m }) {
    return {
      shape: 'rectangular',
      ceiling_type: 'dome',
      width_m, depth_m, height_m,
      ceiling_dome_rise_m,
      surfaces: {
        floor: 'wood-floor', ceiling: 'gypsum-board',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
      zones: [
        { id: 'Z1', label: 'Stage',         vertices: rectVerts(width_m * 0.25, depth_m * 0.056, width_m * 0.75, depth_m * 0.222), elevation_m: 0.6, material_id: 'wood-floor' },
        { id: 'Z2', label: 'Front stalls',  vertices: rectVerts(width_m * 0.167, depth_m * 0.278, width_m * 0.833, depth_m * 0.50), elevation_m: 0.0, material_id: 'carpet-heavy' },
        { id: 'Z3', label: 'Middle stalls', vertices: rectVerts(width_m * 0.167, depth_m * 0.528, width_m * 0.833, depth_m * 0.722), elevation_m: 0.3, material_id: 'carpet-heavy' },
        { id: 'Z4', label: 'Back stalls',   vertices: rectVerts(width_m * 0.167, depth_m * 0.75, width_m * 0.833, depth_m * 0.944), elevation_m: 0.6, material_id: 'carpet-heavy' },
      ],
      sources: [
        { modelUrl: SPK12, position: { x: width_m * 0.292, y: depth_m * 0.167, z: Math.min(height_m - 1, 3.5) }, aim: { yaw:  15, pitch: -12, roll: 0 }, power_watts: 150, groupId: 'A' },
        { modelUrl: SPK12, position: { x: width_m * 0.708, y: depth_m * 0.167, z: Math.min(height_m - 1, 3.5) }, aim: { yaw: -15, pitch: -12, roll: 0 }, power_watts: 150, groupId: 'A' },
      ],
      listeners: [
        { id: 'L1', label: 'Listener 1', position: { x: width_m / 2, y: depth_m * 0.556 }, posture: 'sitting_chair', custom_ear_height_m: null },
      ],
    };
  },
};
