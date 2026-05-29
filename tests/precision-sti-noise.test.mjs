// Regression: Precision STI must respond to ambient noise.
//
// Bug (Dr. Chen P0, 2026-05-29): panel-precision.js passed ambientNoise_per_band
// to deriveMetrics but never signalSPL_per_band, so calcSTIFromIR's both-vectors
// gate left the SNR term dead — NC-25 and NC-45 produced IDENTICAL precision STI,
// inflating reverb-dominated (back-row) STI by up to ~0.12.
//
// Fix: the panel borrows the draft STIPA engine's calibrated per-band signal SPL
// (signalSPLPerBandAt) and feeds it through; calcSTIFromIR then applies the
// IEC 60268-16 noise factor [1 + 10^(−SNR/10)]^−1 to the modulation index.
//
// This test drives calcSTIFromIR directly with a synthetic reverb-dominated IR
// (no tracer needed). Assertions per Dr. Chen's spec:
//   1. Monotonicity  — STI(NC-25) > STI(NC-35) > STI(NC-45)  [would FAIL pre-fix]
//   2. Magnitude     — STI(NC-25) − STI(NC-45) >= 0.05       [not toothless]
//   3. High-SNR no-op — flat 95 dB signal == noise-free result [didn't break loud-PA]
//
// Run: node tests/precision-sti-noise.test.mjs

import { calcSTIFromIR } from '../js/physics/precision/derive-metrics.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// --- Synthetic reverb-dominated IR ----------------------------------------
// 7 octave bands, T buckets at 10 ms. A small impulsive direct arrival in
// bucket 0 plus a long exponential reverb tail → modulation is reverb-limited,
// so the noise term meaningfully drives the per-band TI.
const B = 7;
const T = 120;            // 1.2 s at 10 ms
const bucketDtMs = 10;
const tailTauBuckets = 35;  // ~ T30 ≈ 1.2 s

function makeReverbIR() {
  const bands = [];
  for (let b = 0; b < B; b++) {
    const h = new Float32Array(T);
    h[0] = 1.0;                                  // direct
    for (let t = 0; t < T; t++) {
      h[t] += 0.6 * Math.exp(-t / tailTauBuckets); // diffuse tail (reverb-dominated)
    }
    bands.push(h);
  }
  return bands;
}

const ir = makeReverbIR();

// NC ambient profiles (125 → 8k Hz), Dr. Chen's spec values.
const NC25 = [45, 40, 35, 30, 26, 24, 23];
const NC35 = [55, 50, 45, 40, 36, 34, 33];
const NC45 = [60, 55, 51, 47, 44, 42, 41];

// Calibrated speech signal — flat 50 dB (a quiet back-row speech level) so the
// NC-45 profile straddles/exceeds the signal across the high-weight mid bands,
// where the noise term bites hardest and STI moves most.
const SIGNAL = new Array(B).fill(50);

function sti(signal, noise) {
  return calcSTIFromIR(ir, bucketDtMs, {
    signalSPL_per_band: signal,
    ambientNoise_per_band: noise,
  }).sti;
}

// --- 1. Monotonicity ------------------------------------------------------
const s25 = sti(SIGNAL, NC25);
const s35 = sti(SIGNAL, NC35);
const s45 = sti(SIGNAL, NC45);
console.log(`   STI: NC-25=${s25.toFixed(3)}  NC-35=${s35.toFixed(3)}  NC-45=${s45.toFixed(3)}`);
assert(s25 > s35 && s35 > s45, 'precision STI strictly decreases as ambient noise rises (NC-25 > NC-35 > NC-45)');

// --- 2. Magnitude floor (not toothless) -----------------------------------
assert((s25 - s45) >= 0.05, `NC-25 vs NC-45 differ by >= 0.05 (got ${(s25 - s45).toFixed(3)})`);

// --- 3. High-SNR no-op ----------------------------------------------------
// Flat 95 dB signal vs NC-35: noise term → 1, must match the noise-free result.
// Not bit-exact: the [−40,40] dB SNR overflow guard caps the term at 0.9999, so
// a ~2e-5 STI residual is expected and physically inert (loud-PA limit).
const sLoud = sti(new Array(B).fill(95), NC35);
const sNoiseFree = calcSTIFromIR(ir, bucketDtMs, {}).sti;     // no signal supplied
console.log(`   loud-PA STI=${sLoud.toFixed(6)}  noise-free STI=${sNoiseFree.toFixed(6)}  Δ=${Math.abs(sLoud - sNoiseFree).toExponential(2)}`);
assert(Math.abs(sLoud - sNoiseFree) < 1e-3, 'high-SNR (95 dB) precision STI ≈ noise-free result (loud-PA case unbroken)');

if (failed) {
  console.log(`\n${failed} test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll precision-STI-noise tests passed.');
