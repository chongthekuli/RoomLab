// Small-arena chamber hall with 4-corner audience wings around a central
// stage. 20 m hexadecagonal plan, domed roof at 7 m eaves + 1.5 m rise.
import { SPK12, rectVerts, hexagonVerts } from './_shared.js';

export default {
  label: 'Chamber (small arena)',
  shape: 'polygon', ceiling_type: 'dome',
  polygon_sides: 16, polygon_radius_m: 10,
  width_m: 20, height_m: 7, depth_m: 20,
  ceiling_dome_rise_m: 1.5,
  surfaces: {
    floor: 'wood-floor', ceiling: 'acoustic-tile', walls: 'gypsum-board',
    wall_north: 'gypsum-board', wall_south: 'gypsum-board',
    wall_east: 'gypsum-board', wall_west: 'gypsum-board',
  },
  zones: [
    { id: 'Z1', label: 'Stage',          vertices: hexagonVerts(10, 10, 2),          elevation_m: 0.50, material_id: 'wood-floor' },
    { id: 'Z2', label: 'North audience', vertices: rectVerts(7,   3.5, 13,  7.5),    elevation_m: 0.00, material_id: 'carpet-heavy' },
    { id: 'Z3', label: 'East audience',  vertices: rectVerts(12.5, 7.5, 16.5, 12.5), elevation_m: 0.25, material_id: 'carpet-heavy' },
    { id: 'Z4', label: 'South audience', vertices: rectVerts(7,   12.5, 13, 16.5),   elevation_m: 0.50, material_id: 'carpet-heavy' },
    { id: 'Z5', label: 'West audience',  vertices: rectVerts(3.5,  7.5,  7.5, 12.5), elevation_m: 0.25, material_id: 'carpet-heavy' },
  ],
  sources: [
    { modelUrl: SPK12, position: { x: 10, y: 8,  z: 4.5 }, aim: { yaw: 180, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'A' },
    { modelUrl: SPK12, position: { x: 10, y: 12, z: 4.5 }, aim: { yaw: 0,   pitch: -20, roll: 0 }, power_watts: 200, groupId: 'A' },
    { modelUrl: SPK12, position: { x: 12, y: 10, z: 4.5 }, aim: { yaw: 90,  pitch: -20, roll: 0 }, power_watts: 200, groupId: 'B' },
    { modelUrl: SPK12, position: { x: 8,  y: 10, z: 4.5 }, aim: { yaw: -90, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'B' },
  ],
  listeners: [
    { id: 'L1', label: 'Listener 1', position: { x: 10, y: 5 }, posture: 'sitting_chair', custom_ear_height_m: null },
  ],
};
