import {
  schroederDecay, decayDb, timeAtDb, regressSlope,
  calcEDT, calcT20, calcT30, calcC80, calcC50, calcDR,
  computeMTF, calcSTIFromIR, deriveMetrics,
  STI_MOD_FREQS_HZ,
} from '../js/physics/precision/derive-metrics.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function assertClose(actual, expected, tol, label) {
  const good = Number.isFinite(actual) && Math.abs(actual - expected) < tol;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}  actual=${Number(actual).toFixed(4)} expected=${expected.toFixed(4)}`);
  if (!good) failed++;
}

// Helper: synthesize a decaying-exponential IR.
// h_bucket[i] = A · exp(-2·α·t_i) × Δt  (energy per bucket for a
// single-pole exponential with decay rate α in 1/s).
// Analytical T60 = 3·ln(10)/α ≈ 6.908/α seconds.
// So given desired T60, set α = 3·ln(10)/T60.
function synthExponentialIR({ bucketDtMs, T60_s, length_ms, amplitude = 1 }) {
  const nBuckets = Math.ceil(length_ms / bucketDtMs);
  const h = new Float32Array(nBuckets);
  const alpha = 3 * Math.LN10 / T60_s;   // natural decay constant (1/s)
  const dt_s = bucketDtMs / 1000;
  for (let i = 0; i < nBuckets; i++) {
    const t = i * dt_s;
    h[i] = amplitude * Math.exp(-2 * alpha * t) * dt_s;
  }
  return h;
}

// ---- Schroeder backward integration + decay curve ----------------------

{
  const h = new Float32Array([1, 2, 3, 4]);
  const E = schroederDecay(h);
  ok(E[0] === 10 && E[1] === 9 && E[2] === 7 && E[3] === 4,
    `schroederDecay([1,2,3,4]) = [10,9,7,4] (got [${[...E]}])`);

  const L = decayDb(h);
  ok(Math.abs(L[0] - 0) < 1e-6, 'decayDb[0] = 0 dB by construction');
  assertClose(L[1], 10 * Math.log10(9/10), 1e-5, 'decayDb[1] matches formula');
  assertClose(L[2], 10 * Math.log10(7/10), 1e-5, 'decayDb[2] matches formula');
}

// ---- timeAtDb — linear interpolation between buckets -------------------

{
  const L = new Float32Array([0, -2, -4, -6, -8]);
  const t1 = timeAtDb(L, -3);   // between bucket 1 (-2) and 2 (-4)
  ok(Math.abs(t1 - 1.5) < 1e-6, `timeAtDb(L, -3) = 1.5 (got ${t1})`);
  const t2 = timeAtDb(L, -8);
  ok(t2 === -1 || Math.abs(t2 - 4) < 1e-6,
    `timeAtDb(L, -8) at end-point either -1 (not strict crossing) or 4 (got ${t2})`);
  ok(timeAtDb(L, -100) === -1, 'timeAtDb returns -1 when never crossed');
}

// ---- Synthetic exponential IR: T30 recovers the analytical T60 ---------
//
// For a pure exponential decay h²(t) = exp(-2·α·t), the Schroeder curve
// is also exponential: L(t) = 10·log10(exp(-2·α·t)) = -20·α·t/ln(10) dB/s
// which is a straight line → T20/T30 regressions return exactly T60.

{
  const bucketDtMs = 2;
  const targets = [0.8, 1.5, 3.0];  // seconds
  for (const target of targets) {
    // IR length must span at least 45 dB of decay so T30's -35 dB target
    // lands inside the histogram. 3·T60 is enough for pure exponentials.
    const length_ms = target * 3000;
    const h = synthExponentialIR({ bucketDtMs, T60_s: target, length_ms });
    const L = decayDb(h);
    assertClose(calcEDT(L, bucketDtMs), target, 0.05, `EDT recovers T60=${target}s (linear decay)`);
    assertClose(calcT20(L, bucketDtMs), target, 0.02, `T20 recovers T60=${target}s`);
    assertClose(calcT30(L, bucketDtMs), target, 0.02, `T30 recovers T60=${target}s`);
  }
}

// ---- Direct impulse + exponential tail: C80 sanity ---------------------
//
// An IR with a huge direct impulse at t=0 and a short exponential tail
// should have very high clarity (C80 > 0 dB). An IR that's pure tail
// should have low clarity.

{
  const bucketDtMs = 2;
  const directHeavy = synthExponentialIR({ bucketDtMs, T60_s: 0.5, length_ms: 500 });
  directHeavy[0] += 10;   // add a big direct impulse at t=0
  const tailOnly = synthExponentialIR({ bucketDtMs, T60_s: 3.0, length_ms: 2000 });
  const c80_direct = calcC80(directHeavy, bucketDtMs);
  const c80_tail = calcC80(tailOnly, bucketDtMs);
  ok(c80_direct > c80_tail, `Direct-heavy C80 (${c80_direct.toFixed(1)} dB) > reverby C80 (${c80_tail.toFixed(1)} dB)`);
  ok(c80_direct > 3, `Direct-heavy C80 > +3 dB (got ${c80_direct.toFixed(1)})`);
  // Reverby IR: C80 should be less than 0 dB — much more tail than first 80 ms.
  ok(c80_tail < 0, `Long-decay C80 < 0 dB (got ${c80_tail.toFixed(1)})`);
}

// ---- D/R scales with direct-tail ratio ---------------------------------

{
  const bucketDtMs = 2;
  const dr1 = calcDR(synthExponentialIR({ bucketDtMs, T60_s: 3.0, length_ms: 1500 }), bucketDtMs, 10);
  // Synthesise a "loud direct" IR: spike at t=0, tiny tail.
  const loudDirect = new Float32Array(500);
  loudDirect[0] = 100;  for (let i = 1; i < 500; i++) loudDirect[i] = 0.001 * Math.exp(-i / 20);
  const dr2 = calcDR(loudDirect, bucketDtMs, 10);
  ok(dr2 > dr1, `Loud-direct D/R (${dr2.toFixed(1)} dB) > reverb-only D/R (${dr1.toFixed(1)} dB)`);
  ok(dr2 > 10, `Loud-direct D/R > +10 dB (got ${dr2.toFixed(1)})`);
}

// ---- computeMTF sanity: flat DC energy → MTF(fm) ≈ expected ------------

{
  // For an exponential decay exp(-2αt), the modulation-transfer function
  // against an exponential envelope has closed form:
  //   MTF(fm) = 1 / sqrt(1 + (π·fm·T60/6.9)²)
  // (standard result; see Schroeder 1962 / Houtgast-Steeneken 1985).
  const bucketDtMs = 2;
  const T60 = 1.5;
  const h = synthExponentialIR({ bucketDtMs, T60_s: T60, length_ms: 3000 });

  for (const fm of [1, 4, 10]) {
    const mMeasured = computeMTF(h, bucketDtMs, fm);
    const mAnalytic = 1 / Math.sqrt(1 + Math.pow(2 * Math.PI * fm * T60 / 13.8, 2));
    assertClose(mMeasured, mAnalytic, 0.05, `MTF(fm=${fm}Hz, T60=${T60}s) ≈ analytical formula`);
  }
}

// ---- STI sanity: dry room → high STI, wet room → low STI ---------------

{
  const bucketDtMs = 2;
  const mkStack = (T60_s, length_ms) => {
    const stack = [];
    for (let b = 0; b < 7; b++) {
      stack.push(synthExponentialIR({ bucketDtMs, T60_s, length_ms }));
    }
    return stack;
  };
  const dry = calcSTIFromIR(mkStack(0.3, 1500), bucketDtMs);   // control room / treated studio
  const fair = calcSTIFromIR(mkStack(1.2, 3000), bucketDtMs);  // classroom / seminar
  const wet = calcSTIFromIR(mkStack(4.0, 6000), bucketDtMs);   // cathedral / large church

  // STI thresholds calibrated against IEC 60268-16 ratings:
  //   Good  (≥ 0.6) — dry studio / small treated room
  //   Fair  (0.45–0.60) — moderate classroom, live venue at a listener
  //   Poor  (0.30–0.45) — reverberant hall with background noise
  //   Bad   (< 0.30) — cathedral without amplification
  // A pure exponential decay at T60=0.3s gives MTF mean ≈ 0.8 → STI ≈ 0.75.
  // The 0.9+ range only happens with active speech transmission through a
  // well-aimed close-mic PA, not just room decay physics.
  ok(dry.sti > 0.65, `Dry room STI > 0.65 (got ${dry.sti.toFixed(3)})`);
  ok(fair.sti > 0.40 && fair.sti < 0.75, `Fair-room STI in [0.40, 0.75] (got ${fair.sti.toFixed(3)})`);
  ok(wet.sti < 0.45, `Wet/reverberant STI < 0.45 (got ${wet.sti.toFixed(3)})`);
  ok(dry.sti > fair.sti && fair.sti > wet.sti, 'STI monotone in RT60 (dry > fair > wet)');
  ok(dry.tiPerBand.length === 7, 'tiPerBand length = 7');
  ok(dry.mtfPerBand.length === 7, 'mtfPerBand outer length = 7');
  ok(dry.mtfPerBand[0].length === STI_MOD_FREQS_HZ.length,
    `mtfPerBand inner length = ${STI_MOD_FREQS_HZ.length} modulation freqs`);
}

// ---- deriveMetrics end-to-end: mock precision result -------------------

{
  const bucketDtMs = 2;
  // Single receiver, 7 bands, identical exponential per band.
  const nBuckets = 500;
  const H = new Float32Array(1 * 7 * nBuckets);
  for (let b = 0; b < 7; b++) {
    const h = synthExponentialIR({ bucketDtMs, T60_s: 1.5, length_ms: 1000 });
    for (let t = 0; t < h.length; t++) H[b * nBuckets + t] = h[t];
  }
  // Use enough buckets to capture the -35 dB crossing for T30 regression.
  const nBucketsLong = Math.ceil((1.5 * 3000) / bucketDtMs);   // 3·T60 = 4.5s
  const Hlong = new Float32Array(1 * 7 * nBucketsLong);
  for (let b = 0; b < 7; b++) {
    const h = synthExponentialIR({ bucketDtMs, T60_s: 1.5, length_ms: 4500 });
    for (let t = 0; t < h.length; t++) Hlong[b * nBucketsLong + t] = h[t];
  }
  const result = {
    histogram: Hlong,
    shape: { receivers: 1, bands: 7, buckets: nBucketsLong },
    bucketDtMs, maxTimeMs: 4500,
  };
  const metrics = deriveMetrics(result);
  ok(metrics.length === 1, 'deriveMetrics returns one entry per receiver');
  const r0 = metrics[0];
  ok(r0.perBand.length === 7, 'perBand has 7 entries');
  ok(r0.broadband && typeof r0.broadband === 'object', 'broadband object present');
  ok(r0.sti && typeof r0.sti.sti === 'number', 'STI present on result');
  assertClose(r0.perBand[3].t30_s, 1.5, 0.05, 'band 3 T30 ≈ 1.5s (matches synth)');
  assertClose(r0.broadband.t30_s, 1.5, 0.05, 'broadband T30 ≈ 1.5s');
  // T60=1.5s synth → MTF mean ≈ 0.65 → STI ≈ 0.55–0.60. "Fair" per IEC.
  ok(r0.sti.sti > 0.40 && r0.sti.sti < 0.70,
    `Synth STI for T60=1.5s in [0.40, 0.70] (got ${r0.sti.sti.toFixed(3)})`);
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll precision metrics tests passed.');
