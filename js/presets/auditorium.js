// Sports arena / auditorium preset (key: 'auditorium').
//
// Modelled after University of Wyoming Arena-Auditorium — a 60 m polygon
// plan with a domed roof, tiered concrete bowl, 4 vomitory tunnels at the
// cardinals, and a center-hung 4-sided LED cube. PA is 4 line-array hangs
// on a 10 m ring at catwalk height aimed radially outward at each bowl
// quadrant.
//
// Bowl structure (rendered as solid LatheGeometry in scene.js):
//   Retaining wall: r = 20, z = 0 → 1.0
//   Lower bowl    : r = 20 → 24, tiers 1.0–3.25 m (tread 1.0, riser 0.45, 24° rake)
//   Concourse     : flat ring r = 24 → 26 at z = 3.25
//   Upper bowl    : r = 26 → 29, tiers 7.0–8.75 m (tread 0.5, riser 0.35, 35° rake)
//   Vomitories    : 10° wide at 0°/90°/180°/270°, ceiling at z = 3.25

import {
  SPKLA, rectVerts, generateTieredBowl, generateCenterLineArrayCluster,
} from './shared.js';

const cx = 30, cy = 30;
const lowerBowl = { r_in: 20, r_out: 24, floor_z: 0,    tier_heights_m: [1.0, 1.45, 1.9, 2.35, 2.8, 3.25] };
const upperBowl = { r_in: 26, r_out: 29, floor_z: 3.25, tier_heights_m: [7.0, 7.35, 7.7, 8.05, 8.4, 8.75] };
const concourse = { r_in: 24, r_out: 26, elevation_m: 3.25 };

export default {
  label: 'Sports arena (dome)',
  shape: 'polygon',
  ceiling_type: 'dome',
  polygon_sides: 36,
  polygon_radius_m: 30,
  width_m: 60,
  height_m: 12,
  depth_m: 60,
  ceiling_dome_rise_m: 10,
  surfaces: {
    floor: 'wood-floor', ceiling: 'metal-deck-acoustic', walls: 'arena-wall-mixed',
    wall_north: 'arena-wall-mixed', wall_south: 'arena-wall-mixed',
    wall_east: 'arena-wall-mixed', wall_west: 'arena-wall-mixed',
  },
  stadiumStructure: {
    cx, cy, lowerBowl, upperBowl, concourse,
    catwalkHeight_m: 15, catwalkRadius_m: 10,
    vomitories: {
      centerAnglesDeg: [0, 90, 180, 270],
      widthDeg: 10,
    },
    scoreboard: {
      cx, cy,
      center_z_m: 12,
      width_m: 6,
      height_m: 4,
      material_id: 'led-glass',
    },
  },
  zones: [
    { id: 'Z_court', label: 'Court', vertices: rectVerts(15.65, 22.4, 44.35, 37.6), elevation_m: 0, material_id: 'wood-floor' },
    ...generateTieredBowl({
      cx, cy, r_in: 24, r_out: 26, tier_heights_m: [3.25],
      sectorCount: 4, material_id: 'concrete-painted',
      idPrefix: 'Z_co', labelPrefix: 'Concourse',
      gapDeg: 10, startAngleDeg: 45,
      sectorLabelsOverride: ['SE', 'SW', 'NW', 'NE'],
    }),
    ...generateTieredBowl({
      cx, cy, r_in: 20, r_out: 24, tier_heights_m: lowerBowl.tier_heights_m,
      sectorCount: 4, material_id: 'upholstered-seat-empty',
      idPrefix: 'Z_lb', labelPrefix: 'Lower',
      gapDeg: 10, startAngleDeg: 45,
      sectorLabelsOverride: ['SE', 'SW', 'NW', 'NE'],
      occupancy_percent: 30,
    }),
    ...generateTieredBowl({
      cx, cy, r_in: 26, r_out: 29, tier_heights_m: upperBowl.tier_heights_m,
      sectorCount: 4, material_id: 'upholstered-seat-empty',
      idPrefix: 'Z_ub', labelPrefix: 'Upper',
      gapDeg: 10, startAngleDeg: 45,
      sectorLabelsOverride: ['SE', 'SW', 'NW', 'NE'],
      occupancy_percent: 30,
    }),
  ],
  sources: generateCenterLineArrayCluster({
    cx, cy, cz: 15, ring_r: 5,
    hangCount: 4, elementsPerArray: 6,
    startAngleDeg: 45,
    modelUrl: SPKLA, power_watts_each: 500,
    topTilt_deg: -8, elementSpacing_m: 0.42,
  }),
  listeners: [
    { id: 'L1', label: 'Courtside VIP',          position: { x: 22,   y: 30   }, elevation_m: 0,    posture: 'sitting_chair', custom_ear_height_m: null },
    { id: 'L2', label: 'Lower bowl row 1 SE',    position: { x: 43,   y: 43   }, elevation_m: 1.0,  posture: 'sitting_chair', custom_ear_height_m: null },
    { id: 'L3', label: 'Lower bowl row 6 SW',    position: { x: 13,   y: 47   }, elevation_m: 3.25, posture: 'sitting_chair', custom_ear_height_m: null },
    { id: 'L4', label: 'Upper bowl row 3 NW',    position: { x: 11,   y: 11   }, elevation_m: 7.7,  posture: 'sitting_chair', custom_ear_height_m: null },
    { id: 'L5', label: 'Concourse walker NE',    position: { x: 48,   y: 12   }, elevation_m: 3.25, posture: 'standing',      custom_ear_height_m: null },
  ],
};
