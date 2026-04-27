// Chamber-arena template — small polygon hall with a centre stage and
// audience wings on every cardinal side. Scales with polygon radius.
import { SPK12, rectVerts, hexagonVerts } from '../presets/shared.js';

export default {
  label: 'Chamber (small arena)',
  shape: 'polygon',
  defaultDims: { polygon_sides: 16, polygon_radius_m: 10, height_m: 7, ceiling_dome_rise_m: 1.5 },
  generate({ polygon_sides, polygon_radius_m, height_m, ceiling_dome_rise_m }) {
    const r = polygon_radius_m;
    const D = 2 * r;
    const cx = r, cy = r;
    const wingHalf = r * 0.30;          // 6 m at r=10
    const wingDepth = r * 0.20;         // 4 m at r=10
    const wingOff = r * 0.65;           // 6.5 m from centre at r=10
    return {
      shape: 'polygon',
      ceiling_type: 'dome',
      polygon_sides, polygon_radius_m,
      width_m: D, depth_m: D, height_m,
      ceiling_dome_rise_m,
      surfaces: {
        floor: 'wood-floor', ceiling: 'acoustic-tile', walls: 'gypsum-board',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
      zones: [
        { id: 'Z1', label: 'Stage',          vertices: hexagonVerts(cx, cy, r * 0.20),                                              elevation_m: 0.50, material_id: 'wood-floor' },
        { id: 'Z2', label: 'North audience', vertices: rectVerts(cx - wingHalf, cy - wingOff - wingDepth, cx + wingHalf, cy - wingOff), elevation_m: 0.00, material_id: 'carpet-heavy' },
        { id: 'Z3', label: 'East audience',  vertices: rectVerts(cx + wingOff, cy - wingHalf, cx + wingOff + wingDepth, cy + wingHalf), elevation_m: 0.25, material_id: 'carpet-heavy' },
        { id: 'Z4', label: 'South audience', vertices: rectVerts(cx - wingHalf, cy + wingOff, cx + wingHalf, cy + wingOff + wingDepth), elevation_m: 0.50, material_id: 'carpet-heavy' },
        { id: 'Z5', label: 'West audience',  vertices: rectVerts(cx - wingOff - wingDepth, cy - wingHalf, cx - wingOff, cy + wingHalf), elevation_m: 0.25, material_id: 'carpet-heavy' },
      ],
      sources: [
        { modelUrl: SPK12, position: { x: cx,            y: cy - r * 0.20, z: Math.min(height_m - 0.5, 4.5) }, aim: { yaw: 180, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'A' },
        { modelUrl: SPK12, position: { x: cx,            y: cy + r * 0.20, z: Math.min(height_m - 0.5, 4.5) }, aim: { yaw:   0, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'A' },
        { modelUrl: SPK12, position: { x: cx + r * 0.20, y: cy,            z: Math.min(height_m - 0.5, 4.5) }, aim: { yaw:  90, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'B' },
        { modelUrl: SPK12, position: { x: cx - r * 0.20, y: cy,            z: Math.min(height_m - 0.5, 4.5) }, aim: { yaw: -90, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'B' },
      ],
      listeners: [
        { id: 'L1', label: 'Listener 1', position: { x: cx, y: cy - r * 0.50 }, posture: 'sitting_chair', custom_ear_height_m: null },
      ],
    };
  },
};
