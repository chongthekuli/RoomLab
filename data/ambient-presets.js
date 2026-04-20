// Ambient noise presets — real-world background noise profiles that drive
// the STI denominator in IEC 60268-16 calculations. Values are octave-band
// SPL (dB re 20 µPa) at the listener ear for the 7 STIPA centres:
//   125, 250, 500, 1k, 2k, 4k, 8k Hz
//
// Profile sources:
// - NC curves: ANSI S12.2-2019 tabulated values.
// - Urban/occupancy profiles: Beranek "Noise and Vibration Control
//   Engineering" + field measurements (Malaysia DOE noise survey data
//   for pasar/bus-station; ASHRAE for mall HVAC+crowd).
// - dBA is the weighted sum, displayed to users as a single-number
//   summary. Recomputed live when the per-band values are edited.
//
// Every preset must have exactly 7 values. The fit-for-use range for
// STIPA is roughly 20 – 100 dB per band — outside that the apparent-SNR
// clamp dominates and moving the slider does nothing.

export const STIPA_BANDS_HZ = [125, 250, 500, 1000, 2000, 4000, 8000];

// A-weighting dB adjustments for STIPA band centres (IEC 61672).
const A_WEIGHT = [-16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];

export function bandsToDBA(per_band) {
  let sum = 0;
  for (let k = 0; k < 7; k++) {
    sum += Math.pow(10, (per_band[k] + A_WEIGHT[k]) / 10);
  }
  return 10 * Math.log10(sum);
}

export const AMBIENT_PRESETS = {
  'nc-20': {
    label: 'NC-20 · Recording studio',
    description: 'Professionally treated listening room. Barely any HVAC audible.',
    per_band: [51, 40, 32, 25, 20, 17, 16],
  },
  'nc-30': {
    label: 'NC-30 · Quiet office',
    description: 'Library, private office, small meeting room with quiet HVAC.',
    per_band: [57, 48, 41, 35, 31, 29, 28],
  },
  'nc-35': {
    label: 'NC-35 · Typical office (default)',
    description: 'Open-plan office with fans and HVAC running. IEC 60268-16 reference.',
    per_band: [60, 52, 45, 40, 36, 34, 33],
  },
  'nc-45': {
    label: 'NC-45 · Light industrial',
    description: 'Print shop, loud HVAC plant room, busy kitchen.',
    per_band: [67, 60, 54, 49, 46, 44, 43],
  },
  mosque: {
    label: 'Mosque (during khutbah)',
    description: 'Congregation seated, low murmur. Fans running.',
    per_band: [52, 48, 46, 44, 42, 40, 38],
  },
  classroom: {
    label: 'Classroom (occupied)',
    description: 'K-12 classroom with children rustling, chairs scraping.',
    per_band: [58, 55, 52, 50, 48, 45, 42],
  },
  restaurant: {
    label: 'Restaurant (busy)',
    description: 'Fully occupied mid-dinner. Cutlery + table conversation.',
    per_band: [70, 68, 66, 64, 62, 60, 56],
  },
  mall: {
    label: 'Shopping mall (concourse)',
    description: 'Atrium with shoppers, background music, escalator whirr.',
    per_band: [65, 62, 60, 58, 56, 54, 52],
  },
  'pasar-pagi': {
    label: 'Pasar pagi (morning market)',
    description: 'Open-air wet market — vendor shouts, haggling, motorbike idle.',
    per_band: [72, 70, 70, 72, 70, 65, 58],
  },
  'bus-station': {
    label: 'Bus station',
    description: 'Diesel idle, PA announcements, pedestrian traffic.',
    per_band: [78, 75, 72, 70, 68, 62, 55],
  },
  traffic: {
    label: 'Heavy traffic (street-facing)',
    description: 'Urban arterial — constant tyre/engine noise, occasional horn.',
    per_band: [75, 72, 70, 68, 66, 62, 56],
  },
  'arena-crowd': {
    label: 'Sports arena (full crowd)',
    description: 'Home-team roar during play — the worst-case PA scenario.',
    per_band: [82, 80, 78, 75, 72, 68, 62],
  },
  custom: {
    label: 'Custom…',
    description: 'Enter per-band values manually.',
    per_band: [55, 50, 45, 40, 36, 34, 33],
  },
};

export const AMBIENT_DEFAULT_KEY = 'nc-35';
