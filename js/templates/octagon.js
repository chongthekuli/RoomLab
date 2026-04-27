// Octagonal-hall template — flat-roof polygon with four cardinal-aimed
// 12" speakers on the walls.
import { SPK12 } from '../presets/shared.js';

export default {
  label: 'Octagonal hall',
  shape: 'polygon',
  defaultDims: { polygon_sides: 8, polygon_radius_m: 5, height_m: 4 },
  generate({ polygon_sides, polygon_radius_m, height_m }) {
    const r = polygon_radius_m;
    const D = 2 * r;
    const cx = r, cy = r;
    const off = r * 0.6;
    const z = Math.min(height_m - 0.5, 3.2);
    return {
      shape: 'polygon',
      ceiling_type: 'flat',
      polygon_sides, polygon_radius_m,
      width_m: D, depth_m: D, height_m,
      surfaces: {
        floor: 'wood-floor', ceiling: 'acoustic-tile', walls: 'gypsum-board',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
      zones: [],
      sources: [
        { modelUrl: SPK12, position: { x: cx,        y: cy - off, z }, aim: { yaw:   0, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'A' },
        { modelUrl: SPK12, position: { x: cx,        y: cy + off, z }, aim: { yaw: 180, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'A' },
        { modelUrl: SPK12, position: { x: cx + off,  y: cy,       z }, aim: { yaw:  90, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'B' },
        { modelUrl: SPK12, position: { x: cx - off,  y: cy,       z }, aim: { yaw: -90, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'B' },
      ],
      listeners: [
        { id: 'L1', label: 'Listener 1', position: { x: cx, y: cy }, posture: 'standing', custom_ear_height_m: null },
      ],
    };
  },
};
