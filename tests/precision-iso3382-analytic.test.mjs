// Golden: ISO 3382-1 reverberation metrics on an analytic decay.
//
// Locks calcEDT / calcT20 / calcT30 against a closed-form case: a pure
// exponential ENERGY decay of a known T60 must yield that T60 from all three
// regressions (EDT [0,−10], T20 [−5,−25], T30 [−5,−35]). For a clean
// exponential the Schroeder-integrated decay curve is exactly linear, so all
// three resolve to the same number — there is no kink for them to disagree on.
// (Dr. Chen, docs/NYMPHYSICS_AUDIT_2026-05-29.md item 6.)
//
// CRITICAL: these functions regress on the Schroeder DECAY CURVE L, not the
// raw impulse response — so the test feeds the energy buckets through
// decayDb() (which runs schroederDecay internally) first, exactly as
// deriveMetrics does. Feeding raw h would chase a phantom slope.
//
// Run: node tests/precision-iso3382-analytic.test.mjs

import { decayDb, calcEDT, calcT20, calcT30 } from '../js/physics/precision/derive-metrics.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// --- Synthesise a known-T60 exponential energy decay ----------------------
// Energy decays 60 dB in T60 s → rate = 60/T60 dB/s. The energy time constant
// τ_E satisfies 10·log10(e^(−t/τ_E)) = −rate·t  →  τ_E = 10/(rate·ln10).
// Bucket dt = 1 ms (fine enough for clean −5/−25/−35 dB crossings). Record
// length must reach well past −60 dB so the −35 dB region T30 uses sits in the
// clean linear middle, far from the finite-record Schroeder tail bend — use
// 2.0 s (2000 buckets), i.e. ~−80 dB of raw decay.
const T60_TRUE = 1.5;
const bucketDtMs = 1;
const dt_s = bucketDtMs / 1000;
const rate_db_per_s = 60 / T60_TRUE;                 // 40 dB/s
const tauE_s = 10 / (rate_db_per_s * Math.LN10);     // ≈ 0.10857 s
const N = 2000;

const h = new Float32Array(N);
for (let i = 0; i < N; i++) h[i] = Math.exp(-(i * dt_s) / tauE_s);

const L = decayDb(h);   // Schroeder backward integration → dB decay curve

const edt = calcEDT(L, bucketDtMs);
const t20 = calcT20(L, bucketDtMs);
const t30 = calcT30(L, bucketDtMs);
console.log(`   T60_true=${T60_TRUE}  EDT=${edt.toFixed(4)}  T20=${t20.toFixed(4)}  T30=${t30.toFixed(4)} s`);

// 1% tolerance is generous; the dominant residual is the finite-record
// Schroeder tail. If any of these ever drifts past 1%, LENGTHEN the record —
// do not loosen the tolerance (that's the tell the window ate the tail bend).
const within1pct = (v) => Number.isFinite(v) && Math.abs(v - T60_TRUE) / T60_TRUE < 0.01;
assert(within1pct(edt), `EDT within 1% of ${T60_TRUE} s (got ${edt.toFixed(4)})`);
assert(within1pct(t20), `T20 within 1% of ${T60_TRUE} s (got ${t20.toFixed(4)})`);
assert(within1pct(t30), `T30 within 1% of ${T60_TRUE} s (got ${t30.toFixed(4)})`);

// All three must agree with each other on a clean exponential (no kink).
assert(Math.abs(edt - t30) < 0.01 && Math.abs(t20 - t30) < 0.01,
  'EDT, T20, T30 agree on a clean exponential (linear decay curve)');

if (failed) {
  console.log(`\n${failed} test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll ISO 3382 analytic-decay tests passed.');
