// Pavilion 2 Bukit Jalil — 4-level shopping mall preset.
//
// Scaled model of the real Kuala Lumpur mall (which is ~340 × 90 m over
// 5 retail levels) — 80 × 40 m footprint, 4 levels at 5.8 m floor-to-
// floor, with a 20 × 14 m central atrium void punched through every
// slab. Structural columns on a 10 × 10 m grid (Malaysian super-regional
// mall norm). Ceiling speakers follow Malaysian BOMBA voice-alarm norms
// (MS IEC 60849 → MS EN 54-16/24): Amperes CS610B on ~10 m centres
// delivers ≥ 65 dBA with STI ≥ 0.5 per concourse.
//
// Walkthrough for this preset is currently limited to the ground floor —
// escalator elevation transitions are the Phase 2 upgrade.

import { SPK_AMPERES_CS610B } from './shared.js';

const W = 80, D = 40;
const levelHeight = 5.8;
const nLevels = 4;
const totalHeight = nLevels * levelHeight;
const slabThickness = 0.4;

// Central atrium — 20 × 14 m, centred in the footprint.
const atriumW = 20, atriumD = 14;
const atriumX = (W - atriumW) / 2;          // 30
const atriumY = (D - atriumD) / 2;          // 13
const inAtrium = (x, y) =>
  x > atriumX && x < atriumX + atriumW && y > atriumY && y < atriumY + atriumD;

const footprint = [
  { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: D }, { x: 0, y: D },
];
const atrium = [
  { x: atriumX, y: atriumY },
  { x: atriumX + atriumW, y: atriumY },
  { x: atriumX + atriumW, y: atriumY + atriumD },
  { x: atriumX, y: atriumY + atriumD },
];

// 10 × 10 m column grid, 900 mm square RC columns (rendered as 450 mm
// radius cylinders — close enough visually). Skip columns that fall
// inside the atrium footprint.
const columns = [];
for (let ix = 10; ix <= W - 10; ix += 10) {
  for (let iy = 10; iy <= D - 10; iy += 10) {
    if (inAtrium(ix, iy)) continue;
    columns.push({
      x: ix, y: iy, radius_m: 0.45, base_z: 0, top_z: totalHeight,
    });
  }
}

// Three floor slabs (ground is the room floor, implicit). Each slab is
// the footprint minus the atrium extruded by slab_thickness_m at the
// given elevation.
const levels = [];
for (let i = 1; i < nLevels; i++) {
  levels.push({
    index: i,
    slab_z: i * levelHeight,
    thickness_m: slabThickness,
  });
}

// Escalator scissor-pair flanking the atrium at every level pair.
const escalators = [];
for (let lv = 0; lv < nLevels - 1; lv++) {
  const z0 = lv * levelHeight;
  const z1 = (lv + 1) * levelHeight;
  // North-side (up-side runs atrium NE → NW)
  escalators.push({
    from_level: lv, to_level: lv + 1,
    base: { x: atriumX + atriumW + 2, y: atriumY + atriumD + 2 },
    top:  { x: atriumX + atriumW / 2 + 3, y: atriumY + atriumD + 2 },
    base_z: z0, top_z: z1,
    width_m: 1.2,
  });
  // South-side (scissor pair, opposite direction)
  escalators.push({
    from_level: lv, to_level: lv + 1,
    base: { x: atriumX - 2, y: atriumY - 2 },
    top:  { x: atriumX + atriumW / 2 - 3, y: atriumY - 2 },
    base_z: z0, top_z: z1,
    width_m: 1.2,
  });
}

// Ceiling-speaker grid. Amperes CS610B on 10 m centres on L0 (busiest
// concourse), 12 m centres on L1–L3 (quieter retail). Speakers hang
// ~0.1 m below the slab above.
const sources = [];
for (let lv = 0; lv < nLevels; lv++) {
  const ceilingZ = (lv + 1) * levelHeight - slabThickness - 0.10;
  const grid = lv === 0 ? 10 : 12;
  const groupId = lv === 0 ? 'A' : lv === 1 ? 'B' : lv === 2 ? 'C' : 'D';
  for (let x = grid * 0.5; x < W; x += grid) {
    for (let y = grid * 0.5; y < D; y += grid) {
      if (inAtrium(x, y)) continue;
      sources.push({
        modelUrl: SPK_AMPERES_CS610B,
        position: { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, z: ceilingZ },
        aim: { yaw: 0, pitch: -90, roll: 0 },
        power_watts: 10,
        groupId,
      });
    }
  }
}

const listeners = [
  // Ground floor (L0)
  { id: 'L1', label: 'GF — Main entrance',        position: { x: 5,  y: 20 }, elevation_m: 0,                    posture: 'standing',     custom_ear_height_m: null },
  { id: 'L2', label: 'GF — Atrium centre',        position: { x: 40, y: 20 }, elevation_m: 0,                    posture: 'standing',     custom_ear_height_m: null },
  { id: 'L3', label: 'GF — Food Republic',        position: { x: 65, y: 10 }, elevation_m: 0,                    posture: 'sitting_chair', custom_ear_height_m: null },
  { id: 'L4', label: 'GF — Parkson entrance',     position: { x: 72, y: 30 }, elevation_m: 0,                    posture: 'standing',     custom_ear_height_m: null },
  // Level 1
  { id: 'L5', label: 'L1 — Fashion concourse',    position: { x: 15, y: 32 }, elevation_m: levelHeight,          posture: 'standing',     custom_ear_height_m: null },
  { id: 'L6', label: 'L1 — Atrium balcony',       position: { x: 28, y: 20 }, elevation_m: levelHeight,          posture: 'standing',     custom_ear_height_m: null },
  { id: 'L7', label: 'L1 — Tokyo Town precinct',  position: { x: 55, y: 8  }, elevation_m: levelHeight,          posture: 'standing',     custom_ear_height_m: null },
  // Level 2
  { id: 'L8', label: 'L2 — TGV cinema lobby',     position: { x: 25, y: 8  }, elevation_m: 2 * levelHeight,      posture: 'standing',     custom_ear_height_m: null },
  { id: 'L9', label: 'L2 — Atrium balcony',       position: { x: 52, y: 20 }, elevation_m: 2 * levelHeight,      posture: 'standing',     custom_ear_height_m: null },
  // Level 3
  { id: 'L10', label: 'L3 — Harvey Norman',       position: { x: 15, y: 20 }, elevation_m: 3 * levelHeight,      posture: 'standing',     custom_ear_height_m: null },
  { id: 'L11', label: 'L3 — rooftop dining',      position: { x: 70, y: 25 }, elevation_m: 3 * levelHeight,      posture: 'sitting_chair', custom_ear_height_m: null },
];

export default {
  label: 'Pavilion 2 Bukit Jalil (4-level mall)',
  shape: 'custom',
  ceiling_type: 'flat',
  custom_vertices: footprint,
  width_m: W,
  depth_m: D,
  height_m: totalHeight,
  surfaces: {
    floor: 'concrete',
    ceiling: 'acoustic-tile',
    walls: 'gypsum-board',
    wall_north: 'gypsum-board', wall_south: 'gypsum-board',
    wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    edges: footprint.map(() => 'gypsum-board'),
  },
  multiLevelStructure: {
    footprint,
    atrium,
    levels,
    columns,
    escalators,
  },
  zones: [],
  sources,
  listeners,
};
