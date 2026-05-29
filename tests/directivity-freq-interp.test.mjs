// Regression: directivity must interpolate THROUGH frequency bands.
//
// Bug (Dr. Chen P3, 2026-05-29): interpolateAttenuation looked up
// attenuation_db[String(freq_hz)] and returned 0 (omni) for any frequency
// that wasn't an exact measured band key. The octave heatmap/STIPA callers
// pass exact centres so they were fine, but the EQ frequency-response probe
// (log-spaced points between bands) and sparse custom-speaker JSONs read omni
// instead of the beamed pattern.
//
// Fix: keep the exact-band fast path (octave callers byte-identical), and
// log-frequency interpolate the attenuation between the two enclosing bands
// for off-grid queries; clamp to nearest band outside the measured range.
//
// Run: node tests/directivity-freq-interp.test.mjs

import { interpolateAttenuation } from '../js/physics/loudspeaker.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function approx(a, b, tol = 1e-9) { return Math.abs(a - b) <= tol; }

// Minimal directivity: single az/el cell pair so bilinear is trivial and the
// returned value equals the band's stored attenuation at that angle. Two
// measured bands an octave apart: 1000 Hz (−6 dB off-axis) and 2000 Hz (−12).
const directivity = {
  azimuth_deg: [0, 90],
  elevation_deg: [0, 90],
  attenuation_db: {
    '1000': [[0, -6], [0, -6]],   // [el][az]; az=90 → −6 dB
    '2000': [[0, -12], [0, -12]], // az=90 → −12 dB
  },
};

// Off-axis (az=90) so the band values differ. el=0.
const at = (f) => interpolateAttenuation(directivity, 90, 0, f);

// --- exact-band fast path unchanged ---
assert(approx(at(1000), -6), 'exact 1000 Hz returns measured −6 dB');
assert(approx(at(2000), -12), 'exact 2000 Hz returns measured −12 dB');

// --- the bug: off-grid no longer returns omni 0 ---
assert(at(1500) !== 0, '1500 Hz (off-grid) is NOT omni 0 anymore');

// --- log-frequency interpolation between the two bands ---
// t = (ln1500 − ln1000)/(ln2000 − ln1000); value = (1−t)·(−6) + t·(−12).
const t = (Math.log(1500) - Math.log(1000)) / (Math.log(2000) - Math.log(1000));
const expected1500 = (1 - t) * -6 + t * -12;
assert(approx(at(1500), expected1500, 1e-9), `1500 Hz = log-freq interp ≈ ${expected1500.toFixed(3)} dB (got ${at(1500).toFixed(3)})`);
assert(at(1500) < -6 && at(1500) > -12, '1500 Hz sits strictly between the 1k and 2k values');

// --- clamp outside the measured range to nearest band ---
assert(approx(at(500), -6), 'below lowest band clamps to 1000 Hz value (−6)');
assert(approx(at(8000), -12), 'above highest band clamps to 2000 Hz value (−12)');

if (failed) {
  console.log(`\n${failed} test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll directivity frequency-interpolation tests passed.');
