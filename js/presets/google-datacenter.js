// Google Data Center — long-shed hyperscale "data-center barn" preset.
//
// Designed against the reference image (a ~150 m white shed with a row of
// air-cooled chillers marching down one long side) by four specialists:
//   • Ravi Raghavan  (data-center architect)  — floor plate + hall schedule
//   • Marcus Thorne  (cooling engineer)        — chiller yard
//   • Felix Brandt   (PA integrator)           — 42U rack stuffed with QD2100
//   • Viktor Lindqvist (3D rendering)          — overhead cable-tray render
//
// HONEST LIMITS (also surfaced in authorComments):
//   • The halls are interior PARTITIONS, not acoustically-isolated rooms.
//     The engine computes ONE Sabine/Eyring RT60 for the whole 86,400 m³
//     box — the NOC and DH-1 share the same reverberation.
//   • The chillers are GEOMETRY ONLY. AuraLAB does not yet compute or
//     propagate their noise as an acoustic source.
//   • Representative 60×120 m footprint (not the true ~150 m) to keep the
//     simulated reverberation legible. Even so, an untreated hard box this
//     size has a very long RT60 — that is correct physics, not a bug.
//
// Generated programmatically (same idiom as pavilion.js): the rack grid,
// chiller row, and partition walls are built by the helpers below, then
// frozen into the exported preset object.

// ---- Shell ----------------------------------------------------------------
const W = 60;    // E-W (state x), x ∈ [-30, +30]
const D = 120;   // N-S (state y), y ∈ [-60, +60]
const H = 12;    // clear height (state z up)

// ---- Hall schedule (south admin → north) ----------------------------------
// Internal demising walls run E-W across the full width. Each is split into
// two segments flanking a 3 m door gap on the west circulation spine so the
// walk-mode avatar can pass between halls (a single full-width partition is
// a continuous walk-collision barrier).
const HALL_WALL_Y = [-48, -38, -26, +4, +34];   // Admin|MMR|Electrical|DH-1|DH-2|DH-3
const DOOR_GAP_X = -24;     // door centred on the west spine, clear of the rack block
const DOOR_GAP_W = 3;

function partitionSegments() {
  const out = [];
  const xMin = -W / 2, xMax = +W / 2;
  const gapL = DOOR_GAP_X - DOOR_GAP_W / 2;
  const gapR = DOOR_GAP_X + DOOR_GAP_W / 2;
  let n = 0;
  for (const y of HALL_WALL_Y) {
    // West segment: xMin → gapL
    const wLen = gapL - xMin;
    if (wLen > 0.2) {
      out.push({
        id: `dc-wall-${n++}`, type: 'partition',
        position: { x: (xMin + gapL) / 2, y }, rotation_deg: 0,
        length_m: wLen, thickness_m: 0.2, height_m: H,
        materialId: 'concrete-painted',
      });
    }
    // East segment: gapR → xMax
    const eLen = xMax - gapR;
    if (eLen > 0.2) {
      out.push({
        id: `dc-wall-${n++}`, type: 'partition',
        position: { x: (gapR + xMax) / 2, y }, rotation_deg: 0,
        length_m: eLen, thickness_m: 0.2, height_m: H,
        materialId: 'concrete-painted',
      });
    }
  }
  return out;
}

// ---- Chiller yard (Marcus) ------------------------------------------------
// 16 air-cooled units on the WEST long side, just outside the wall (x=-30).
// Each unit = a low platform pad + a white cabinet body floating on it.
const CHILLER_N = 16;
const CHILLER_PITCH = 6.5;
const CHILLER_X = -34;     // outside the west wall; pad spans x[-35.5,-32.5]
const CHILLER_PAD_H = 1.2;

function chillerYard() {
  const out = [];
  const span = (CHILLER_N - 1) * CHILLER_PITCH;
  const y0 = -span / 2;
  for (let i = 0; i < CHILLER_N; i++) {
    const y = y0 + i * CHILLER_PITCH;
    // Pad (raised steel access platform) — renders as a floor riser box.
    out.push({
      id: `dc-chiller-pad-${i}`, type: 'platform',
      position: { x: CHILLER_X, y }, rotation_deg: 0,
      width_m: 3.0, depth_m: 5.2, height_m: CHILLER_PAD_H, elev_m: 0,
      materialId: 'steel-platform',
    });
    // Body (white cabinet) — a half_wall box floating on top of the pad.
    out.push({
      id: `dc-chiller-body-${i}`, type: 'half_wall', fullHeight: false,
      position: { x: CHILLER_X, y }, rotation_deg: 0,
      length_m: 2.4, thickness_m: 4.6, height_m: 2.5, elev_m: CHILLER_PAD_H,
      materialId: 'chiller-cabinet',
    });
  }
  return out;
}

// ---- Rack grid in Data Hall DH-1 (Ravi + Felix) ---------------------------
// 10 rows × 20 racks = 200 enclosed-42U racks, hot/cold aisle. Back-to-back
// pairs: row A faces north (yaw 0), row B faces south (yaw 180) over a hot
// aisle; cold aisles between pairs. Each rack stuffed with 21× QD2100 (2U).
const RACKS_PER_ROW = 20;
const ROW_PAIRS = 5;            // → 10 rows
const X_PITCH = 0.6;           // rack width
const RACK_DEPTH = 1.2;
const HOT_AISLE = 0.9;
const COLD_AISLE = 1.2;
const Y_START = -24;           // first row, 2 m off the DH-1 south wall (y=-26)

// 21× QD2100, U1..U42 solid (2U each). Felix: ship the literal max-pack for
// this showcase preset; channels parked (zoneId null, tap 0) — the amps
// drive no audio zone here.
function stuffQD2100() {
  const slots = [];
  for (let u = 1; u <= 41; u += 2) {
    slots.push({
      uStart: u, uHeight: 2,
      amplifierId: 'qd2100', label: 'QD2100',
      channelAssignments: [{ ch: 1, zoneId: null, tap_w: 0 }],
    });
  }
  return slots;
}

// ---- Voice-alarm PA (Felix) -----------------------------------------------
// The QD2100 is a 70/100 V voice-alarm amp (EN 54-16) — a data center has
// ceiling evacuation speakers it drives. A coverage grid of 100 V-line
// ceiling speakers across the data halls, all aimed straight down. This is
// what makes the racks' amplifiers meaningful AND lets the preset show a
// real STIPA / evacuation-intelligibility result.
const VA_MODEL = 'data/loudspeakers/amperes-cs520.json';
const VA_CEILING_Z = 11.5;     // just under the 12 m deck

function vaSpeakers() {
  const out = [];
  const xs = [-18, 0, +18];
  const ys = [-20, 0, +22, +46];
  let n = 0;
  for (const y of ys) {
    for (const x of xs) {
      out.push({
        modelUrl: VA_MODEL,
        position: { x, y, z: VA_CEILING_Z },
        aim: { yaw: 0, pitch: -90, roll: 0 },
        power_watts: 10,
        groupId: 'VA',
        label: `VA-${String(++n).padStart(2, '0')}`,
      });
    }
  }
  return out;
}

function rackGrid() {
  const racks = [];
  const x0 = -((RACKS_PER_ROW - 1) * X_PITCH) / 2;   // centre the line on x=0
  let y = Y_START;
  let row = 0;
  for (let pair = 0; pair < ROW_PAIRS; pair++) {
    const yB = y + RACK_DEPTH + HOT_AISLE;            // back-to-back over hot aisle
    for (const [lineY, yaw, tag] of [[y, 0, 'A'], [yB, 180, 'B']]) {
      row++;
      for (let i = 0; i < RACKS_PER_ROW; i++) {
        racks.push({
          id: `dc-rk-${row}-${String(i + 1).padStart(2, '0')}`,
          label: `DH1-R${row}${tag}-${String(i + 1).padStart(2, '0')}`,
          rackModelKey: 'enclosed-42u',
          position: { x: x0 + i * X_PITCH, y: lineY, z: 0 },
          yaw_deg: yaw,
          doorOpen: false, rearDoorOpen: false,
          slots: stuffQD2100(),
        });
      }
    }
    y = yB + RACK_DEPTH + COLD_AISLE;                 // pair pitch = 4.5 m
  }
  return racks;
}

const preset = {
  label: 'Google Data Center',
  authorComments:
    'Long-shed hyperscale data centre. Partitions split it into a NOC, MMR, ' +
    'electrical room and three data halls, but the engine models ONE RT60 ' +
    'for the whole hard box — not per-hall isolation. Data Hall 1 holds 200 ' +
    '42U racks, each stuffed with 21 QD2100 voice-alarm amps, on hot/cold ' +
    'aisles under overhead cable trays. A ceiling EN 54-16 PA grid drives ' +
    'the STIPA result. The 16 west-side chillers are geometry only; their ' +
    'noise is not yet computed.',
  shape: 'rectangular',
  ceiling_type: 'flat',
  width_m: W,
  height_m: H,
  depth_m: D,
  // Hard, reflective data-center envelope — sealed concrete + steel deck.
  surfaces: {
    floor: 'concrete-painted',
    ceiling: 'gypsum-board',
    walls:      { materialId: 'concrete-painted', thickness_m: 0.20, openings: [] },
    wall_north: { materialId: 'concrete-painted', thickness_m: 0.20, openings: [] },
    wall_south: { materialId: 'concrete-painted', thickness_m: 0.20, openings: [] },
    wall_east:  { materialId: 'concrete-painted', thickness_m: 0.20, openings: [] },
    wall_west:  { materialId: 'concrete-painted', thickness_m: 0.20, openings: [] },
    edges: null,
  },
  // Overhead ladder cable-trays above every rack row (derived from racks).
  cableTrays: true,
  // Halls (5 demising walls = 10 split segments) + the 16-unit chiller yard.
  structures: [...partitionSegments(), ...chillerYard()],
  // 200 racks in DH-1, each fully loaded with 21× QD2100.
  rackSystem: { racks: rackGrid() },
  // Voice-alarm ceiling PA across the data halls — the evacuation system
  // the rack QD2100s drive (EN 54-16). Gives the preset a real SPL + STIPA
  // result on top of the RT60 of the hard box.
  sources: vaSpeakers(),
  zones: [],
  // A few measurement points: the control room, a DH-1 cold aisle, and the
  // chiller-yard boundary.
  listeners: [
    { id: 'L-noc',     label: 'NOC / control',      position: { x: 0,   y: -54 }, elevation_m: 0, posture: 'sitting_chair', custom_ear_height_m: null },
    { id: 'L-aisle',   label: 'DH-1 cold aisle',    position: { x: 0,   y: -15 }, elevation_m: 0, posture: 'standing',     custom_ear_height_m: null },
    { id: 'L-yard',    label: 'Chiller-yard fence', position: { x: -42, y: 0   }, elevation_m: 0, posture: 'standing',     custom_ear_height_m: null },
  ],
};

export default preset;
