// Generate catalogue JSON files for the Amperes Electronics ceiling-
// speaker range. Data is extracted from the public catalogue PDF
// (https://www.ampereselectronics.com/ceiling-speakers — pages 59-61,
// also CS606FR-E from the EN54 page). Where a spec wasn't printed we
// fill in a physically-plausible default and flag it in the JSON note.
//
//   node scripts/gen-amperes-speakers.mjs
//
// Writes one file per model into data/loudspeakers/amperes-<id>.json.

import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('data/loudspeakers');

// ---- Spec table -----------------------------------------------------------
// Units: W = watts, dB, mm, kg. Dispersion = nominal −6 dB cone angle
// (degrees). When the catalogue didn't print a dispersion for a coaxial
// model we use a sensible default based on driver size + waveguide.
// Where no explicit max SPL is given we compute it as sens + 10·log10(W).

const SPEAKERS = [
  // ----- Dual-cone ceiling speakers (page 59) -----
  { id: 'cs210',  model: 'Amperes CS210',  type: 'dual-cone', driverInches: 2,   watts: 6,  sens: 90, flo: 150, fhi: 15000, disp: 120, ovDia: 110, ovH: 110, cutDia: 85,  weightKg: 0.50, note: '2\" dual-cone ceiling speaker, 100 V line — ABS enclosure and aluminium grille with spring clip mount.' },
  { id: 'cs510',  model: 'Amperes CS510',  type: 'dual-cone', driverInches: 5,   watts: 6,  sens: 92, flo: 150, fhi: 19000, disp: 160, ovDia: 165, ovH: 110, cutDia: 145, weightKg: 0.78, note: '5\" dual-cone ceiling speaker, 100 V line — ABS enclosure, optional FR grade.' },
  { id: 'cs610',  model: 'Amperes CS610',  type: 'dual-cone', driverInches: 6,   watts: 6,  sens: 92, flo: 120, fhi: 19000, disp: 165, ovDia: 205, ovH: 110, cutDia: 185, weightKg: 0.84, note: '6\" dual-cone ceiling speaker, 6 W 100 V — ABS enclosure with metal grille.' },
  { id: 'cs610b', model: 'Amperes CS610B', type: 'dual-cone', driverInches: 6,   watts: 10, sens: 92, flo: 120, fhi: 19000, disp: 165, ovDia: 205, ovH: 110, cutDia: 185, weightKg: 0.85, note: '6\" dual-cone ceiling speaker, 10 W 100 V variant of the CS610.' },

  // ----- Dual-cone ceiling speakers (page 60) -----
  { id: 'cs606',  model: 'Amperes CS606',  type: 'dual-cone', driverInches: 6,   watts: 6,  sens: 91, flo: 150, fhi: 16000, disp: 150, ovDia: 200, ovH: 70,  cutDia: 165, weightKg: 0.78, note: '6\" dual-cone ceiling speaker, metal enclosure, fire-retardant build.' },
  { id: 'cs515',  model: 'Amperes CS515',  type: 'dual-cone', driverInches: 5,   watts: 6,  sens: 92, flo: 150, fhi: 17000, disp: 150, ovDia: 175, ovH: 95,  cutDia: 145, weightKg: 0.62, note: '5\" dual-cone ceiling speaker — ABS with honeycomb grille.' },
  { id: 'cs516',  model: 'Amperes CS516',  type: 'dual-cone', driverInches: 5,   watts: 6,  sens: 92, flo: 150, fhi: 17000, disp: 150, ovDia: 222, ovH: 65,  cutDia: null, weightKg: 0.66, note: '5\" surface-mount ceiling speaker, white or black — ABS plastic enclosure.' },
  { id: 'cs343',  model: 'Amperes CS343',  type: 'dual-cone', driverInches: 4,   watts: 6,  sens: 90, flo: 150, fhi: 18000, disp: 140, ovDia: 140, ovH: 130, cutDia: 120, weightKg: 0.85, note: '4\" IP65-rated weatherproof ceiling speaker — aluminium rustproof grille.' },

  // ----- Co-axial ceiling speakers (page 61) -----
  { id: 'cs520',  model: 'Amperes CS520',  type: 'coaxial',   driverInches: 5,   watts: 20, sens: 86, flo: 100, fhi: 18000, disp: 120, ovDia: 205, ovH: 145, cutDia: 170, weightKg: 1.70, maxSpl: 99,  note: '5\" co-axial + 1\" tweeter, 20 W 100 V — metal enclosure, adjustable power taps.' },
  { id: 'cs630',  model: 'Amperes CS630',  type: 'coaxial',   driverInches: 6.5, watts: 30, sens: 88, flo: 75,  fhi: 18000, disp: 110, ovDia: 230, ovH: 150, cutDia: 185, weightKg: 2.15, maxSpl: 102, note: '6.5\" co-axial + 1\" tweeter, 30 W 100 V — metal enclosure, adjustable power taps.' },
  { id: 'cs620',  model: 'Amperes CS620',  type: 'coaxial',   driverInches: 6.5, watts: 20, sens: 88, flo: 80,  fhi: 18000, disp: 110, ovDia: 240, ovH: 142, cutDia: 205, weightKg: 2.40, maxSpl: 101, note: '6.5\" co-axial + 1\" tweeter — ABS back enclosure, metal grille.' },
  { id: 'cs840',  model: 'Amperes CS840',  type: 'coaxial',   driverInches: 8,   watts: 40, sens: 90, flo: 90,  fhi: 19000, disp: 100, ovDia: 280, ovH: 142, cutDia: 240, weightKg: 2.10, maxSpl: 106, note: '8\" co-axial + 1\" tweeter, 40 W 100 V — ABS back, metal grille.' },
  { id: 'cs518',  model: 'Amperes CS518',  type: 'coaxial',   driverInches: 5,   watts: 20, sens: 85, flo: 100, fhi: 18000, disp: 115, ovDia: 180, ovH: 135, cutDia: 150, weightKg: 1.80, maxSpl: 98,  note: '5\" square-grille co-axial, 20 W 100 V — drops into the same tile grid as light fixtures.', squareGrille: true },

  // ----- EN54 fire-compliant variant (page 70) -----
  { id: 'cs606fr-e', model: 'Amperes CS606FR-E', type: 'dual-cone', driverInches: 6, watts: 6, sens: 89, flo: 150, fhi: 16000, disp: 150, ovDia: 200, ovH: 94, cutDia: 165, weightKg: 1.20, note: '6\" dual-cone EN54-24 compliant ceiling speaker — metal enclosure, ceramic connectors with thermal fuse.' },
];

// ---- Directivity builder --------------------------------------------------
// Axi-symmetric pattern typical of a ceiling speaker. On-axis (0 dB) at the
// aim point; −6 dB at the published nominal half-coverage angle; smooth
// fall-off beyond that with a mild front-to-rear ratio that keeps the rear
// hemisphere well below the main beam.

const AZIMUTHS = [-180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180];
const ELEVATIONS = [-90, -60, -30, 0, 30, 60, 90];

function polarAtt(angleDeg, dispersionDeg) {
  const half = dispersionDeg / 2;
  const a = Math.abs(angleDeg);
  if (a <= 0.01) return 0;
  // Quadratic-ish roll-off that hits −6 dB exactly at ±half, −18 dB at ±2·half,
  // asymptotes near −32 dB at the rear.
  const ratio = a / half;
  if (ratio <= 1) return -6 * Math.pow(ratio, 1.7);
  // Beyond the −6 dB point — steeper tail.
  const extra = (ratio - 1) * 9;
  return Math.min(0, -6 - extra);
}

function buildDirectivityGrid(dispersionDeg) {
  const attenuation = {};
  const row = AZIMUTHS.map(az => roundHalf(polarAtt(az, dispersionDeg)));
  const grid = [];
  for (const el of ELEVATIONS) {
    const elAtt = polarAtt(el, dispersionDeg);
    // Compose az × el as independent cone roll-offs (ceiling speaker is
    // axi-symmetric — elevation-wise dispersion is roughly the same as
    // azimuth-wise dispersion for a single driver).
    const combined = row.map(azAtt => roundHalf(Math.min(0, azAtt + elAtt * 0.35)));
    grid.push(combined);
  }
  attenuation['1000'] = grid;
  return {
    angular_resolution_deg: 30,
    class_hint: 'standard',
    azimuth_deg: AZIMUTHS.slice(),
    elevation_deg: ELEVATIONS.slice(),
    attenuation_db: attenuation,
  };
}

// ---- Realistic on-axis FR + CSD templates ---------------------------------
// Dual-cone cheap paper driver → peaky midrange, rolled-off HF above 10 kHz.
// Co-axial with tweeter → flatter, HF extends to 18 kHz.

const FR_DUAL = [
  [50, -25], [63, -18], [80, -10], [100, -5], [125, -3], [160, -1], [200, 0],
  [250, 0], [315, 0.5], [400, 1], [500, 0.5], [630, 0], [800, -0.5],
  [1000, 0], [1250, 0.5], [1600, 1.5], [2000, 2], [2500, 1.5], [3150, 0.5],
  [4000, -1], [5000, -2.5], [6300, -4], [8000, -6], [10000, -9], [12500, -14],
  [16000, -20], [20000, -28],
];
const FR_COAXIAL = [
  [40, -18], [50, -10], [63, -4], [80, -1.5], [100, 0], [125, 0.5], [160, 0],
  [200, -0.5], [250, 0], [315, 0.5], [400, 0.5], [500, 0], [630, 0],
  [800, -0.5], [1000, 0], [1250, 0.5], [1600, 0], [2000, 0.5], [2500, 1],
  [3150, 1], [4000, 0.5], [5000, 0], [6300, 0.5], [8000, 0], [10000, -1],
  [12500, -2], [16000, -4], [20000, -8],
];
const CSD_DUAL = { 125: 10, 250: 7, 500: 5, 1000: 4, 2000: 3.5, 4000: 3, 8000: 2.5, 16000: 2 };
const CSD_COAX = { 125: 12, 250: 8, 500: 5.5, 1000: 4.5, 2000: 3.8, 4000: 3.2, 8000: 2.8, 16000: 2.3 };

// ---- Per-speaker builder --------------------------------------------------

function buildDef(s) {
  const isCoax = s.type === 'coaxial';
  const sens = s.sens;
  const maxSpl = s.maxSpl ?? round1(sens + 10 * Math.log10(s.watts));
  const ovDiaM = s.ovDia / 1000;
  const ovHM = s.ovH / 1000;
  const dir = buildDirectivityGrid(s.disp);
  if (isCoax) dir.class_hint = 'horn';      // waveguide-loaded HF holds pattern

  const frFine = (isCoax ? FR_COAXIAL : FR_DUAL).map(([hz, db]) => [hz, db]);
  const fr_band = {};
  for (const hz of [125, 250, 500, 1000, 2000, 4000, 8000, 16000]) {
    fr_band[String(hz)] = interpFine(frFine, hz);
  }

  return {
    schema_version: '1.1',
    id: `${s.id}-v1`,
    manufacturer: 'Amperes Electronics',
    model: s.model,
    license: 'Catalogue data © Amperes Electronics — imported from public spec sheets.',
    note: `${s.note} Directivity is approximated from the published ${s.disp}° coverage; off-axis measurements were not published in the public catalogue.`,
    mount_type: 'ceiling',
    physical: {
      weight_kg: s.weightKg,
      dimensions_m: {
        // Treat the disc cabinet as a cylinder — width and depth equal the
        // outside diameter, height is the cabinet depth (front-to-back).
        w: round3(ovDiaM),
        h: round3(ovHM),
        d: round3(ovDiaM),
      },
      cutout_diameter_m: s.cutDia != null ? round3(s.cutDia / 1000) : null,
      shape: s.squareGrille ? 'square' : 'round',
      driver_size_inches: s.driverInches,
    },
    electrical: {
      nominal_impedance_ohm: 8,                   // transformer secondary
      line_voltage: '100V',
      max_input_watts: s.watts,
      max_spl_db: maxSpl,
    },
    acoustic: {
      sensitivity_db_1w_1m: sens,
      frequency_range_hz: [s.flo, s.fhi],
      frequency_bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000, 16000],
      directivity_index_db: round1(diFromDispersion(s.disp)),
      nominal_dispersion_deg: s.disp,
      on_axis_response_db: fr_band,
      fr_fine_db: frFine,
      csd_ms: isCoax ? { ...CSD_COAX } : { ...CSD_DUAL },
    },
    placement: {
      // Ceiling speakers point straight down by convention.
      position_m: { x: 0, y: 0, z: 3.0 },
      aim_deg: { yaw: 0, pitch: -90, roll: 0 },
    },
    directivity: dir,
  };
}

function interpFine(fine, hz) {
  if (hz <= fine[0][0]) return fine[0][1];
  if (hz >= fine[fine.length - 1][0]) return fine[fine.length - 1][1];
  for (let i = 0; i < fine.length - 1; i++) {
    const [loHz, loDb] = fine[i];
    const [hiHz, hiDb] = fine[i + 1];
    if (hz >= loHz && hz <= hiHz) {
      const t = (Math.log2(hz) - Math.log2(loHz)) / (Math.log2(hiHz) - Math.log2(loHz));
      return round1(loDb + t * (hiDb - loDb));
    }
  }
  return 0;
}

// Rough DI estimate from coverage cone angle (steradian solid-angle model).
function diFromDispersion(degrees) {
  const half = degrees * Math.PI / 360;
  const solid = 2 * Math.PI * (1 - Math.cos(half));
  return 10 * Math.log10(4 * Math.PI / solid);
}

function round1(v) { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function roundHalf(v) { return Math.round(v * 2) / 2; }

// ---- Write ----------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const spec of SPEAKERS) {
  const def = buildDef(spec);
  const file = path.join(OUT_DIR, `amperes-${spec.id}.json`);
  fs.writeFileSync(file, JSON.stringify(def, null, 2) + '\n');
  console.log(`wrote ${file}`);
}
console.log(`done: ${SPEAKERS.length} speakers`);
