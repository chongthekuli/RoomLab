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
const SPK_HEIGHT = 3.0;  // column-speaker mount height on side walls
const SPK_MODEL = 'data/loudspeakers/amperes-cs520.json';

// Audience zone — prayer mat covering most of the floor with a small
// inset from each wall so the audience figures don't clip into them.
// Excludes a strip in front of the qibla wall reserved for the imam.
const ZONE_INSET = 0.4;
const IMAM_STRIP = 1.5;  // depth of imam zone in front of mihrab

export default {
  label: 'Surau (mosque prayer hall)',
  shape: 'rectangular',
  ceiling_type: 'flat',
  width_m: W,
  depth_m: D,
  height_m: H,
  surfaces: {
    // Carpet over concrete is the prayer-time floor across modern
    // Malaysian surau. Plastered painted blockwork walls. Plasterboard
    // suspended ceiling (more common than exposed roof in this build
    // class). All assumed to be the listed catalogue materials.
    floor: 'carpet-heavy-underlay',
    ceiling: 'gypsum-board',
    walls: 'plaster-smooth',
    wall_north: 'plaster-smooth',  // qibla / mihrab wall
    wall_south: 'plaster-smooth',  // main entrance wall
    wall_east: 'plaster-smooth',
    wall_west: 'plaster-smooth',
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
      occupancy_percent: 40,  // mid-week prayer; rises to ~100 % at Jumaah
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
    // Column speakers mounted at 3 m on the side walls, aimed horizontally
    // across the hall (-10° pitch tilts toward the kneeling congregation
    // at ear height ~1.1 m). Two on each long wall, spaced 1/3 and 2/3 of
    // the depth so coverage doesn't bunch at the front or rear.
    {
      modelUrl: SPK_MODEL,
      position: { x: 0.30, y: D * 0.33, z: SPK_HEIGHT },
      aim: { yaw: 0, pitch: -10, roll: 0 },
      power_watts: 20,
      groupId: 'A',
    },
    {
      modelUrl: SPK_MODEL,
      position: { x: 0.30, y: D * 0.66, z: SPK_HEIGHT },
      aim: { yaw: 0, pitch: -10, roll: 0 },
      power_watts: 20,
      groupId: 'A',
    },
    {
      modelUrl: SPK_MODEL,
      position: { x: W - 0.30, y: D * 0.33, z: SPK_HEIGHT },
      aim: { yaw: 180, pitch: -10, roll: 0 },
      power_watts: 20,
      groupId: 'B',
    },
    {
      modelUrl: SPK_MODEL,
      position: { x: W - 0.30, y: D * 0.66, z: SPK_HEIGHT },
      aim: { yaw: 180, pitch: -10, roll: 0 },
      power_watts: 20,
      groupId: 'B',
    },
  ],
  listeners: [
    { id: 'L1', label: 'Front row (behind imam)',  position: { x: W / 2,        y: D - IMAM_STRIP - 1.0 }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    { id: 'L2', label: 'Mid-hall centre',          position: { x: W / 2,        y: D * 0.55             }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    { id: 'L3', label: 'Mid-hall east flank',      position: { x: W * 0.78,     y: D * 0.55             }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    { id: 'L4', label: 'Mid-hall west flank',      position: { x: W * 0.22,     y: D * 0.55             }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
    { id: 'L5', label: 'Back row (near entrance)', position: { x: W / 2,        y: 2.0                  }, elevation_m: 0, posture: 'standing', custom_ear_height_m: null },
  ],
};
