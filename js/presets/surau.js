// Surau (mosque prayer hall) preset (key: 'surau').
//
// Modelled after the Surau (Binaan Baru) at Rejimen 512 Askar Wataniah,
// Kem Sri Tembila, Terengganu — Drawing PNZZ/Z2506/ELV/PA/018 (Sep 2025,
// Perunding NZZ Sdn Bhd, tender drawing). RoomLAB simulates ONLY the
// prayer hall (the 318 m² central space). The southern side rooms
// (Imam, Bilal, AV, VIP, Staff, Utility, Toilets, Bilik Jenazah) and
// the ablution area are acoustically separate spaces not served by the
// indoor PA — they're excluded from the room polygon.
//
// Coordinate convention:
//   +x = east (room is 18.0 m E–W)
//   +y = north toward the mihrab / qibla (17.7 m N–S)
//   +z = up (4.5 m flat-ceiling approximation of the 25° pitched roof)
// Main entrance is on the south wall (y = 0); congregation faces north
// toward the imam at the qibla wall (y = 17.7).
//
// PA system per the tender schematic PNZZ/Z2506/ELV/SCH/019:
//   • 4× 20 W column speakers on the long walls (zones Z1–Z4)
//   • Plus 1× zone (Z5) for the bilal/imam rooms — excluded here
//   • Plus 4× 80 W horn speakers on the roof (Z6) for outdoor azan — excluded here
//   • 12-channel pre-amplifier mixer + 360 W power amp per zone + standby
//   • 40 Ah NiCd battery backup, automatic changeover
//   • Rack located in BILIK AV (south side, outside the modelled room)
//
// Closest catalogue match for the 20 W column speakers is Amperes CS520
// (5" co-axial, 20 W @ 100 V, 120° dispersion, 99 dB max SPL). A true
// column speaker is a vertical array; the CS520 is a single point source
// with similar power and dispersion — acceptable as a directivity
// approximation for the broadband simulation.

import { rectVerts } from './shared.js';

const W = 18.0;          // E–W
const D = 17.7;          // N–S
const H = 4.5;           // ceiling
const SPK_CEILING_Z = 4.30;  // ceiling-mount speaker height (just under ceiling)
const SPK_ARCADE_Z  = 4.20;  // arcade ceiling-mount speaker height (under arcade flat roof at 4.4)
const SPK_MODEL = 'data/loudspeakers/amperes-cs520.json';

// Audience zone — prayer mat covering most of the floor with a small
// inset from each wall so the audience figures don't clip into them.
// Excludes a strip in front of the qibla wall reserved for the imam.
const ZONE_INSET = 0.4;
const IMAM_STRIP = 1.5;  // depth of imam zone in front of mihrab

export default {
  label: 'Surau (mosque prayer hall)',
  shape: 'rectangular',
  ceiling_type: 'flat',  // flat is overridden by surauStructure.hipRoof below
  width_m: W,
  depth_m: D,
  height_m: H,
  // Architectural elements that turn the plain shoebox into a recognisable
  // surau. Each element is rendered by rebuildSurauStructure() in scene.js
  // — see the schema header comment there for field-level documentation.
  surauStructure: {
    // Mihrab — concave semicircular niche on the qibla wall (state +y).
    // 1.8 m × 0.6 m × 3.0 m, centred E–W. Marble would be ideal; gypsum-
    // board is the closest catalogued material until a stone is added.
    mihrab: {
      center_x_m: W / 2,
      width_m: 1.8,
      depth_m: 0.6,
      height_m: 3.0,
      sill_m: 0.0,
      materialId: 'gypsum-board',
    },
    // Minbar — stepped pulpit, west of the mihrab, abutting the qibla wall.
    // 3 steps × 0.5 m rise + 1.0 × 0.6 m platform = ~1.8 m total.
    minbar: {
      footprint: { x_m: 6.3, y_m: 16.1, width_m: 1.0, depth_m: 0.6 },
      steps: 3,
      step_rise_m: 0.5,
      platform_height_m: 1.8,
      materialId: 'wood-floor',
    },
    // Hip roof — replaces the flat ceiling with a 4-sided pyramid rising
    // 1.5 m above the eaves. Matches the FALL 25° pitched roof in the
    // tender drawing (4.5 m at eaves → 6.0 m at apex). Apex defaults to
    // room centre.
    hipRoof: {
      apexRise_m: 1.5,
    },
    // Saf lines — prayer-row alignment markers on the carpet. 13 rows ×
    // 1.2 m spacing covers ~15.6 m of usable congregation depth, leaving
    // ~1.5 m clear at the back near the main entrance.
    safLines: {
      rows: 13,
      spacing_m: 1.2,
      start_y_m: 16.0,
      lineThickness_m: 0.05,
      edge_inset_m: 0.5,
      opacity: 0.55,
    },
    // South-wall partition — thin band hinting at the side rooms (Imam,
    // Bilal, AV, etc.) that sit behind the south wall in the real building.
    // Acoustically a no-op (it's part of the south wall surface); visually
    // a strong cue that this side has doors, not open space.
    southPartition: {
      thickness_m: 0.2,
      height_m: 2.4,
      doorCenters_x_m: [5.0, 9.0, 13.0],
      doorWidth_m: 1.0,
      materialId: 'concrete-painted',
    },
    // Three entrance openings — east + west match the porches in the PDF;
    // south central is the MAIN ENTRANCE (already cut by the southPartition
    // doorCenters above, so not duplicated here).
    entrances: [
      { wall: 'east', center_y_m: D / 2, width_m: 1.2, height_m: 2.4 },
      { wall: 'west', center_y_m: D / 2, width_m: 1.2, height_m: 2.4 },
    ],

    // ---- EXTERIOR ELEMENTS (visual only — no acoustic effect) ----
    // The six elements below turn the box-with-hat into a recognisable
    // Malaysian surau: clerestory tower for daylight + visual hierarchy,
    // slender minaret at the NW corner, pointed-arch arcade wrapping
    // the south + east + west sides, perforated jali screens on the
    // south facade, raised podium foundation, projecting south portico
    // framing the main entrance. All marked no_acoustic in scene.js so
    // the precision tracer ignores them.

    // Clerestory tower — square box of ribbon windows above the main
    // hip roof, capped by its own smaller pyramid. ~55% of the main
    // building footprint so it reads as the architectural focal point.
    clerestory: {
      width_m: 10,
      height_m: 3.5,
      sill_m: 0.5,
      window_height_m: 2.0,
      apexRise_m: 1.0,
    },
    // Minaret — slender square tower with crescent finial at the NW
    // corner of the building footprint. ~8.5 m tall.
    minaret: {
      corner: 'NW',
      base_size_m: 1.2,
      height_m: 8.5,
      cap_style: 'crescent',
    },
    // Arcade / serambi — covered porch wrapping the front (south) plus
    // the two side walls (east + west). The qibla wall (north) is never
    // wrapped. Pointed Moorish arches between solid bay walls.
    arcade: {
      sides: ['south', 'east', 'west'],
      depth_m: 3.0,
      column_spacing_m: 2.8,
      column_thickness_m: 0.30,
      arch_height_m: 3.2,        // springline (where the pointed curve starts)
      arch_peak_height_m: 4.0,   // peak of the pointed arch
      roof_height_m: 4.4,        // flat roof above arcade
    },
    // Jali screens — disabled on south side per user 2026-05-15 (the
    // perforated grille was visually showing through the open door
    // cutouts and made the doors look barred). Empty sides[] keeps
    // the schema field present so the renderer no-ops cleanly.
    jaliScreens: {
      sides: [],
      sill_m: 1.0,
      height_m: 2.4,
      cell_size_m: 0.25,
      opacity: 0.7,
    },
    // Raised podium — concrete base extending 3.5 m past the building
    // footprint on every side. Sized to fully contain the 3.0 m deep
    // arcade columns (south + east + west sides) plus a 0.5 m visual
    // margin so the columns clearly stand ON the podium, not at its
    // edge. Reads as a 0.4 m step up to the entrances.
    podium: {
      extension_m: 3.5,
      height_m: 0.4,
    },
    // Front portico — projecting entrance pavilion at the south wall
    // centre, framing the main entrance arch. Own small pyramid roof.
    portico: {
      side: 'south',
      width_m: 3.0,
      depth_m: 3.0,
      height_m: 4.5,
      apexRise_m: 1.0,
    },
  },
  surfaces: {
    // Carpet over concrete is the prayer-time floor across modern
    // Malaysian surau. Painted concrete blockwork walls (per user
    // 2026-05-15 — was plaster-smooth, but painted concrete is the
    // honest as-built material in this construction class).
    // Plasterboard suspended ceiling (more common than exposed roof
    // in this build class). All from the catalogued materials list.
    floor: 'carpet-heavy-underlay',
    ceiling: 'gypsum-board',
    walls: 'concrete-painted',
    wall_north: 'concrete-painted',  // qibla / mihrab wall
    wall_south: 'concrete-painted',  // main entrance wall
    wall_east: 'concrete-painted',
    wall_west: 'concrete-painted',
  },
  zones: [
    {
      id: 'Z_congregation',
      label: 'Congregation (carpeted prayer mat)',
      vertices: rectVerts(
        ZONE_INSET, ZONE_INSET,
        W - ZONE_INSET, D - IMAM_STRIP,
      ),
      elevation_m: 0,
      material_id: 'audience-seated',
      occupancy_percent: 5,  // default sparse — bumps to 40 mid-week, ~100 at Jumaah
    },
    {
      id: 'Z_imam',
      label: 'Imam / mihrab strip',
      vertices: rectVerts(
        ZONE_INSET, D - IMAM_STRIP,
        W - ZONE_INSET, D - ZONE_INSET,
      ),
      elevation_m: 0,
      material_id: 'carpet-heavy-underlay',
      occupancy_percent: 5,
    },
  ],
  sources: [
    // PRAYER HALL ceiling speakers — 2×2 grid at z = 4.30 m (just below
    // the 4.5 m ceiling), all aimed straight down (pitch = -90). Per
    // user 2026-05-15: column-on-side-wall layout replaced with this
    // ceiling-mount layout, all speakers facing downward to match the
    // typical Malaysian surau ceiling-speaker convention.
    // Group A = front pair (closer to qibla / mihrab).
    // Group B = rear pair (closer to main entrance).
    {
      modelUrl: SPK_MODEL,
      position: { x: W * 0.25, y: D * 0.66, z: SPK_CEILING_Z },
      aim: { yaw: 0, pitch: -90, roll: 0 },
      power_watts: 20,
      groupId: 'A',
    },
    {
      modelUrl: SPK_MODEL,
      position: { x: W * 0.75, y: D * 0.66, z: SPK_CEILING_Z },
      aim: { yaw: 0, pitch: -90, roll: 0 },
      power_watts: 20,
      groupId: 'A',
    },
    {
      modelUrl: SPK_MODEL,
      position: { x: W * 0.25, y: D * 0.33, z: SPK_CEILING_Z },
      aim: { yaw: 0, pitch: -90, roll: 0 },
      power_watts: 20,
      groupId: 'B',
    },
    {
      modelUrl: SPK_MODEL,
      position: { x: W * 0.75, y: D * 0.33, z: SPK_CEILING_Z },
      aim: { yaw: 0, pitch: -90, roll: 0 },
      power_watts: 20,
      groupId: 'B',
    },

    // ARCADE / SERAMBI speakers — outdoor PA coverage under the
    // arcade flat roof (~4.4 m). All aimed straight down. Positioned
    // OUTSIDE the prayer-hall room boundary (x or y past the wall),
    // representing speakers mounted on the arcade soffit. Acoustic
    // engine treats them as direct-field sources to listeners L6–L8
    // standing in the corridor — proper arcade-coupling physics is
    // a future engine feature; this is a first-order approximation.
    // Group C = south arcade (front), Group D = east + west sides.
    {
      modelUrl: SPK_MODEL,
      position: { x: 4.5, y: -1.5, z: SPK_ARCADE_Z },
      aim: { yaw: 0, pitch: -90, roll: 0 },
      power_watts: 20,
      groupId: 'C',
    },
    {
      modelUrl: SPK_MODEL,
      position: { x: 9.0, y: -1.5, z: SPK_ARCADE_Z },
      aim: { yaw: 0, pitch: -90, roll: 0 },
      power_watts: 20,
      groupId: 'C',
    },
    {
      modelUrl: SPK_MODEL,
      position: { x: 13.5, y: -1.5, z: SPK_ARCADE_Z },
      aim: { yaw: 0, pitch: -90, roll: 0 },
      power_watts: 20,
      groupId: 'C',
    },
    {
      modelUrl: SPK_MODEL,
      position: { x: -1.5, y: D / 2, z: SPK_ARCADE_Z },
      aim: { yaw: 0, pitch: -90, roll: 0 },
      power_watts: 20,
      groupId: 'D',
    },
    {
      modelUrl: SPK_MODEL,
      position: { x: W + 1.5, y: D / 2, z: SPK_ARCADE_Z },
      aim: { yaw: 0, pitch: -90, roll: 0 },
      power_watts: 20,
      groupId: 'D',
    },
  ],
  listeners: [
    // Inside the prayer hall — 5 representative congregation positions.
    { id: 'L1', label: 'Front row (behind imam)',  position: { x: W / 2,        y: D - IMAM_STRIP - 1.0 }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    { id: 'L2', label: 'Mid-hall centre',          position: { x: W / 2,        y: D * 0.55             }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    { id: 'L3', label: 'Mid-hall east flank',      position: { x: W * 0.78,     y: D * 0.55             }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    { id: 'L4', label: 'Mid-hall west flank',      position: { x: W * 0.22,     y: D * 0.55             }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    { id: 'L5', label: 'Back row (near entrance)', position: { x: W / 2,        y: 2.0                  }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    // Outside in the arcade — 3 corridor positions for overflow worshippers
    // during Friday/Eid prayers when the hall fills past capacity.
    // Positioned outside the prayer-hall room boundary; SPL is computed
    // from the arcade speakers' direct field. RT60/STIPA at these
    // positions reflect the arcade-only direct-field coverage, not the
    // prayer hall's reverberant field (no inside-to-outside coupling
    // physics yet).
    { id: 'L6', label: 'South arcade centre',      position: { x: W / 2,        y: -1.5                 }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    { id: 'L7', label: 'East arcade',              position: { x: W + 1.5,      y: D / 2                }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    { id: 'L8', label: 'West arcade',              position: { x: -1.5,         y: D / 2                }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
  ],
};
