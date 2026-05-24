// Phase 5 Step 1 regression — third-octave-bands.js (v=613, 2026-05-23).
//
// Pure-helper module + log-linear interpolation. Tests:
//   1. The frozen band lists carry the correct lengths and edge values.
//   2. Flat octave → flat 1/3-octave (no spurious slope from interp).
//   3. Linear ramp → monotone 1/3-octave with exact octave-centre match.
//   4. Concrete-painted catalogue row → hand-computed 1/3-octave snapshot.
//   5. Edge-clamp policy (below lowest, above highest octave).
//   6. Defensive guards (mismatched lengths, unsorted bands).

import assert from 'node:assert';
import {
  ISO_THIRD_OCTAVE_HZ,
  ISO_RW_BANDS_HZ,
  ISO_STC_BANDS_HZ,
  CATALOGUE_OCTAVE_BANDS_HZ,
  octaveToThirdOctave,
} from '../js/physics/third-octave-bands.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}
const within = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// 1. Band-list contracts
// ---------------------------------------------------------------------------

// Master 18-band 1/3-octave list — covers both Rw and STC.
check('ISO_THIRD_OCTAVE_HZ has 18 bands covering 100–5000 Hz',
  ISO_THIRD_OCTAVE_HZ.length === 18 &&
  ISO_THIRD_OCTAVE_HZ[0] === 100 &&
  ISO_THIRD_OCTAVE_HZ[ISO_THIRD_OCTAVE_HZ.length - 1] === 5000);

// ISO 717-1 Rw evaluation range.
check('ISO_RW_BANDS_HZ has 16 bands covering 100–3150 Hz (ISO 717-1 §3.1)',
  ISO_RW_BANDS_HZ.length === 16 &&
  ISO_RW_BANDS_HZ[0] === 100 &&
  ISO_RW_BANDS_HZ[ISO_RW_BANDS_HZ.length - 1] === 3150);

// ASTM E413 STC evaluation range.
check('ISO_STC_BANDS_HZ has 16 bands covering 125–4000 Hz (ASTM E413 §5)',
  ISO_STC_BANDS_HZ.length === 16 &&
  ISO_STC_BANDS_HZ[0] === 125 &&
  ISO_STC_BANDS_HZ[ISO_STC_BANDS_HZ.length - 1] === 4000);

// Catalogue octave list — must match data/materials.json frequency_bands_hz.
check('CATALOGUE_OCTAVE_BANDS_HZ matches data/materials.json (125–8000 Hz)',
  JSON.stringify([...CATALOGUE_OCTAVE_BANDS_HZ]) ===
  JSON.stringify([125, 250, 500, 1000, 2000, 4000, 8000]));

// Frozen so callers can't accidentally mutate the canonical band list.
check('ISO_THIRD_OCTAVE_HZ is frozen (no accidental mutation)',
  Object.isFrozen(ISO_THIRD_OCTAVE_HZ));

// Subset relationship: Rw + STC are slices of the master list.
{
  const masterContainsAllRw = ISO_RW_BANDS_HZ.every(f => ISO_THIRD_OCTAVE_HZ.includes(f));
  const masterContainsAllStc = ISO_STC_BANDS_HZ.every(f => ISO_THIRD_OCTAVE_HZ.includes(f));
  check('Rw bands ⊂ master 18-band list', masterContainsAllRw);
  check('STC bands ⊂ master 18-band list', masterContainsAllStc);
}

// ---------------------------------------------------------------------------
// 2. Flat octave → flat 1/3-octave (no spurious interp slope)
// ---------------------------------------------------------------------------

{
  const flat = [30, 30, 30, 30, 30, 30, 30];        // 30 dB at every octave
  const out = octaveToThirdOctave(flat);
  check('flat octave (30 dB) → all 1/3-octave values exactly 30 dB',
    out.length === 18 && out.every(v => v === 30));
}

// ---------------------------------------------------------------------------
// 3. Linear ramp — exact octave-centre match + monotonicity
// ---------------------------------------------------------------------------

{
  // Per-octave values 10, 20, 30, 40, 50, 60, 70 at 125, 250, 500, 1k, 2k, 4k, 8k.
  const ramp = [10, 20, 30, 40, 50, 60, 70];
  const out = octaveToThirdOctave(ramp);
  // Exact-match short-circuit at octave centres: at 250 Hz (index 4) → 20 dB,
  // 500 Hz (index 7) → 30 dB, 1 kHz (index 10) → 40 dB.
  const exactMatches =
    out[ISO_THIRD_OCTAVE_HZ.indexOf(125)] === 10 &&
    out[ISO_THIRD_OCTAVE_HZ.indexOf(250)] === 20 &&
    out[ISO_THIRD_OCTAVE_HZ.indexOf(500)] === 30 &&
    out[ISO_THIRD_OCTAVE_HZ.indexOf(1000)] === 40 &&
    out[ISO_THIRD_OCTAVE_HZ.indexOf(2000)] === 50 &&
    out[ISO_THIRD_OCTAVE_HZ.indexOf(4000)] === 60;
  check('linear ramp: 1/3-octave at octave centres matches input exactly',
    exactMatches);
  // Monotone non-decreasing across the whole vector — log-linear interp on a
  // log-linear input stays log-linear, so monotonicity is automatic; but pin
  // it as a tripwire against a future "improvement" that breaks the order.
  let monotone = true;
  for (let i = 1; i < out.length; i++) {
    if (out[i] < out[i - 1]) { monotone = false; break; }
  }
  check('linear ramp: 1/3-octave output is monotone non-decreasing',
    monotone, `output = [${out.map(v => v.toFixed(1)).join(', ')}]`);
}

// ---------------------------------------------------------------------------
// 4. Concrete-painted (catalogue) — hand-computed snapshot
// ---------------------------------------------------------------------------
//
// data/materials.json `concrete-painted.transmission_loss_db`:
//   125Hz → 39, 250Hz → 41, 500Hz → 47, 1k → 53, 2k → 58, 4k → 62, 8k → 65.
//
// Snapshots at three diagnostic 1/3-octave centres (log-linear interp):
//   160 Hz between 125 and 250: t = log(160/125)/log(250/125) = log(1.28)/log(2)
//                                  ≈ 0.35614 → v = 39 + 0.35614·2 = 39.712
//   400 Hz between 250 and 500: t = log(400/250)/log(500/250) = log(1.6)/log(2)
//                                  ≈ 0.67807 → v = 41 + 0.67807·6 = 45.068
//   3150 Hz between 2000 and 4000: t = log(3150/2000)/log(2) = log(1.575)/log(2)
//                                  ≈ 0.65535 → v = 58 + 0.65535·4 = 60.621
{
  const concrete = [39, 41, 47, 53, 58, 62, 65];
  const out = octaveToThirdOctave(concrete);
  const v160 = out[ISO_THIRD_OCTAVE_HZ.indexOf(160)];
  const v400 = out[ISO_THIRD_OCTAVE_HZ.indexOf(400)];
  const v3150 = out[ISO_THIRD_OCTAVE_HZ.indexOf(3150)];
  check('concrete-painted @ 160 Hz (between 125 and 250) → 39.71 dB',
    within(v160, 39.712, 0.01), `got ${v160.toFixed(3)}`);
  check('concrete-painted @ 400 Hz (between 250 and 500) → 45.07 dB',
    within(v400, 45.068, 0.01), `got ${v400.toFixed(3)}`);
  check('concrete-painted @ 3150 Hz (between 2k and 4k) → 60.62 dB',
    within(v3150, 60.621, 0.01), `got ${v3150.toFixed(3)}`);
  // Catalogue octave centres unchanged through the interpolator.
  check('concrete-painted @ catalogue octave centres pass through exact',
    out[ISO_THIRD_OCTAVE_HZ.indexOf(125)] === 39 &&
    out[ISO_THIRD_OCTAVE_HZ.indexOf(250)] === 41 &&
    out[ISO_THIRD_OCTAVE_HZ.indexOf(500)] === 47 &&
    out[ISO_THIRD_OCTAVE_HZ.indexOf(1000)] === 53 &&
    out[ISO_THIRD_OCTAVE_HZ.indexOf(2000)] === 58 &&
    out[ISO_THIRD_OCTAVE_HZ.indexOf(4000)] === 62);
}

// ---------------------------------------------------------------------------
// 5. Edge-clamp policy (below 125 Hz, above 4000 Hz)
// ---------------------------------------------------------------------------

{
  // The 100-Hz 1/3-octave band sits below the catalogue's lowest octave (125 Hz)
  // → clamp to the 125-Hz catalogue value. Matches airAbsorptionDbPerM policy.
  const concrete = [39, 41, 47, 53, 58, 62, 65];
  const out = octaveToThirdOctave(concrete);
  check('100 Hz (below catalogue lowest 125 Hz) clamps to 125-Hz value (= 39)',
    out[ISO_THIRD_OCTAVE_HZ.indexOf(100)] === 39);
  // 5000 Hz sits BETWEEN 4000 and 8000 — interpolated, not clamped.
  // t = log(5000/4000)/log(2) = log(1.25)/log(2) ≈ 0.3219
  // v = 62 + 0.3219·3 = 62.966.
  const v5000 = out[ISO_THIRD_OCTAVE_HZ.indexOf(5000)];
  check('5000 Hz (between 4000 and 8000) interpolates, does NOT clamp',
    within(v5000, 62.966, 0.01), `got ${v5000.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 6. Defensive guards
// ---------------------------------------------------------------------------

{
  // Length mismatch → return empty (defensive, not exception).
  const out = octaveToThirdOctave([10, 20, 30], CATALOGUE_OCTAVE_BANDS_HZ);
  check('length mismatch returns [] (defensive)',
    Array.isArray(out) && out.length === 0);
}
{
  // Unsorted bands → return empty.
  const out = octaveToThirdOctave([10, 20, 30], [500, 250, 1000]);
  check('unsorted octave bands return [] (defensive)',
    Array.isArray(out) && out.length === 0);
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
