// Rotunda template — small round room with a domed roof and four
// cardinal-aimed compact 6" speakers.
import { SPK6 } from '../presets/shared.js';

export default {
  label: 'Rotunda (round + dome)',
  shape: 'round',
  defaultDims: { round_radius_m: 4, height_m: 3.5, ceiling_dome_rise_m: 1.5 },
  generate({ round_radius_m, height_m, ceiling_dome_rise_m }) {
    const r = round_radius_m;
    const D = 2 * r;
    const cx = r, cy = r;
    const off = r * 0.625;
    const z = Math.min(height_m - 0.3, 2.5);
    return {
      shape: 'round',
      ceiling_type: 'dome',
      round_radius_m,
      width_m: D, depth_m: D, height_m,
      ceiling_dome_rise_m,
      surfaces: {
        floor: 'wood-floor', ceiling: 'gypsum-board', walls: 'gypsum-board',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
      zones: [],
      sources: [
        { modelUrl: SPK6, position: { x: cx,       y: cy - off, z }, aim: { yaw:   0, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'A' },
        { modelUrl: SPK6, position: { x: cx,       y: cy + off, z }, aim: { yaw: 180, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'A' },
        { modelUrl: SPK6, position: { x: cx + off, y: cy,       z }, aim: { yaw:  90, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'B' },
        { modelUrl: SPK6, position: { x: cx - off, y: cy,       z }, aim: { yaw: -90, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'B' },
      ],
      listeners: [
        { id: 'L1', label: 'Listener 1', position: { x: cx, y: cy }, posture: 'sitting_chair', custom_ear_height_m: null },
      ],
    };
  },
};
