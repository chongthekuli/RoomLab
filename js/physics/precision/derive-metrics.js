// Phase C — derive time-domain metrics from the precision engine's
// impulse-response histogram. Pure math, no engine dependencies. All
// formulas per ISO 3382-1 (reverberation, clarity) and IEC 60268-16
// Annex A (STI). Inputs come straight from tracer-core's histogram.
//
// The histogram `h[receiver][band][bucket]` stores per-bucket acoustic
// ENERGY (squared pressure × Δt). For ratio-based metrics (EDT, T20,
// T30, C80, C50, D/R) the absolute scale cancels — the tracer's
// normalisation choice doesn't affect the result. For STI-from-IR the
// MTF is itself normalised (|FT{h}|/∫h), so noise correction is the
// only path where an absolute SPL could matter; we default to noise-
// free (high-SNR) conditions matching a loud-PA scenario.
//
// Public API:
//   deriveMetrics(precisionResult, opts?)    — all metrics for all receivers
//   calcEDT / calcT20 / calcT30 / calcC80 /
//     calcC50 / calcDR / calcSTIFromIR       — single-metric helpers
//   schroederDecay, decayDb                  — intermediate curves (debuggable)
//   computeMTF                               — modulation transfer at one (band, fm)

// ---- Schroeder backward integration + decay curve -----------------------

/**
 * Backward cumulative energy sum. Given a per-bucket energy array h[t],
 * returns E[t] = Σ_{τ≥t} h[τ]. E[0] is the total IR energy; E[t] → 0 as
 * t → end of the histogram. Used for reverberation-time metrics.
 */
export function schroederDecay(h) {
  const N = h.length;
  const E = new Float32Array(N);
  let sum = 0;
  for (let i = N - 1; i >= 0; i--) { sum += h[i]; E[i] = sum; }
  return E;
}

/**
 * Decay curve in dB: L(t) = 10·log10(E(t) / E(0)).
 * L(0) = 0 dB by construction; L → -∞ as t → end.
 * For a clean exponential decay this is a straight line whose slope IS
 * the reverberation rate.
 */
export function decayDb(h) {
  const E = schroederDecay(h);
  const N = h.length;
  const L = new Float32Array(N);
  const E0 = E[0];
  if (!(E0 > 0)) { for (let i = 0; i < N; i++) L[i] = -Infinity; return L; }
  for (let i = 0; i < N; i++) {
    L[i] = E[i] > 0 ? 10 * Math.log10(E[i] / E0) : -Infinity;
  }
  return L;
}

/**
 * First time (in bucket units, linearly interpolated) where L(t) first
 * drops to or below `dbLevel`. Returns -1 if never. Assumes L is
 * monotonically non-increasing (true for Schroeder decay by construction).
 */
export function timeAtDb(L, dbLevel) {
  if (L.length === 0 || !isFinite(L[0])) return -1;
  for (let i = 1; i < L.length; i++) {
    if (!isFinite(L[i])) return -1;        // ran off the end of valid data
    if (L[i] <= dbLevel && L[i - 1] > dbLevel) {
      const frac = (L[i - 1] - dbLevel) / (L[i - 1] - L[i]);
      return (i - 1) + frac;
    }
  }
  return -1;
}

/**
 * Least-squares regression slope of L[i] over the integer-bucket range
 * [i0, i1] inclusive. Returns slope in dB/bucket (negative for a decay).
 * Needs ≥ 2 points and finite data.
 */
export function regressSlope(L, i0, i1) {
  i0 = Math.max(0, Math.floor(i0));
  i1 = Math.min(L.length - 1, Math.floor(i1));
  const N = i1 - i0 + 1;
  if (N < 2) return 0;
  let sumX = 0, sumY = 0, n = 0;
  for (let i = i0; i <= i1; i++) {
    if (!isFinite(L[i])) continue;
    sumX += i; sumY += L[i]; n++;
  }
  if (n < 2) return 0;
  const xBar = sumX / n, yBar = sumY / n;
  let num = 0, den = 0;
  for (let i = i0; i <= i1; i++) {
    if (!isFinite(L[i])) continue;
    const dx = i - xBar;
    num += dx * (L[i] - yBar);
    den += dx * dx;
  }
  return den > 0 ? num / den : 0;
}

// ---- Reverberation-time metrics (all in seconds) ------------------------
//
// T60 extrapolation — the time for a 60 dB decay, inferred by regression
// over a shorter window. Standard names:
//   EDT  = T60 extrapolated from the [0, -10 dB] region (early decay time).
//          Perceptually most salient; often ≠ T30 in irregular halls.
//   T20  = from [-5, -25 dB] regression (strict ISO 3382-1).
//   T30  = from [-5, -35 dB] regression (more robust when noise floor is
//          far below -35 dB).
//
// Returns NaN when the decay curve doesn't span the required dB range
// (insufficient SNR / too few rays / too short histogram).

function t60FromRegion(L, bucketDtMs, startDb, endDb) {
  const iStart = timeAtDb(L, startDb);
  const iEnd = timeAtDb(L, endDb);
  if (iStart < 0 || iEnd < 0 || iEnd <= iStart) return NaN;
  const slope = regressSlope(L, iStart, iEnd);   // dB/bucket
  if (slope >= 0) return NaN;
  const tnBuckets = -60 / slope;
  return (tnBuckets * bucketDtMs) / 1000;
}

// EDT's start point is t=0 (L=0 dB) by definition — there's no "first
// crossing" of 0 dB because L[0] IS 0 dB exactly. Special-cased here so
// `timeAtDb(L, 0)` returning -1 doesn't short-circuit the regression.
export function calcEDT(L, bucketDtMs) {
  const iEnd = timeAtDb(L, -10);
  if (iEnd <= 0) return NaN;
  const slope = regressSlope(L, 0, iEnd);    // regress over [0, -10]
  if (slope >= 0) return NaN;
  return (-60 / slope) * bucketDtMs / 1000;
}
export function calcT20(L, bucketDtMs) { return t60FromRegion(L, bucketDtMs,  -5, -25); }
export function calcT30(L, bucketDtMs) { return t60FromRegion(L, bucketDtMs,  -5, -35); }

// ---- Clarity / definition (C80, C50) ------------------------------------
//
// Cn = 10·log10( ∫_0^n·ms h²(t) dt  /  ∫_n·ms^∞ h²(t) dt )
//
//   C80 is the classical "music clarity" index (≈ +0 dB is neutral;
//       concert halls target −2 to +4 dB).
//   C50 is "speech clarity" / "Deutlichkeit" (≈ +0 dB for good speech).
//
// Both are band-specific but also meaningful when computed on the
// broadband histogram (sum across all bands).

export function calcClarity(h, bucketDtMs, splitMs) {
  const splitBucket = Math.floor(splitMs / bucketDtMs);
  let early = 0, late = 0;
  for (let i = 0; i < h.length; i++) {
    if (i < splitBucket) early += h[i];
    else late += h[i];
  }
  if (!(early > 0) || !(late > 0)) return NaN;
  return 10 * Math.log10(early / late);
}

export function calcC80(h, bucketDtMs) { return calcClarity(h, bucketDtMs, 80); }
export function calcC50(h, bucketDtMs) { return calcClarity(h, bucketDtMs, 50); }

// ---- Direct-to-reverberant ratio ----------------------------------------
//
// "Direct" is the first `directMs` (default 10 ms) of the IR — the
// straight-line arrival plus any reflections whose path difference is
// ≤ 3.4 m. "Reverb" is everything after. D/R in dB is a strong
// predictor of speech intelligibility at the receiver's location.

export function calcDR(h, bucketDtMs, directMs = 10) {
  return calcClarity(h, bucketDtMs, directMs);
}

// ---- STI from impulse response (IEC 60268-16 Annex A, full STI) ---------
//
// The "full" STI uses 14 modulation frequencies per octave band and
// computes the MTF directly from h²(t), rather than approximating it
// with `1 / sqrt(1 + (2πf_m·T/13.8)²)` as simplified STIPA does. The
// result is more accurate for irregular rooms where the decay isn't
// purely exponential.
//
// MTF at (band, mod-freq):
//   m(f_m) = | ∫ h²(t) exp(-j 2π f_m t) dt |  /  ∫ h²(t) dt
//
// Noise correction:
//   If caller provides a per-band signal SPL and ambient noise SPL,
//   m is multiplied by (1 + 10^(-SNR/10))^-1. If either is missing,
//   assume noise-free (high-SNR limit) — physics of a loud PA system.

export const STI_MOD_FREQS_HZ = [
  0.63, 0.80, 1.00, 1.25, 1.60, 2.00, 2.50,
  3.15, 4.00, 5.00, 6.30, 8.00, 10.00, 12.50,
];
// Male weighting (IEC 60268-16 Annex A Table A.3). Matches STIPA's
// coefficients — same speech model, more modulation frequencies.
export const STI_ALPHA_MALE = [0.085, 0.127, 0.230, 0.233, 0.309, 0.224, 0.173];
export const STI_BETA_MALE  = [0.085, 0.078, 0.065, 0.011, 0.047, 0.095];
const SNR_APP_CLAMP_DB = 15;

export function computeMTF(h, bucketDtMs, fm_hz) {
  const dt_s = bucketDtMs / 1000;
  let re = 0, im = 0, total = 0;
  for (let i = 0; i < h.length; i++) {
    const t = i * dt_s;
    const phi = 2 * Math.PI * fm_hz * t;
    re += h[i] * Math.cos(phi);
    im += h[i] * Math.sin(phi);
    total += h[i];
  }
  if (total <= 0) return 0;
  return Math.sqrt(re * re + im * im) / total;
}

/**
 * Full STI for one receiver from its per-band histogram stack.
 *
 * @param {Float32Array[]} bandHistograms  length = 7, one per octave band
 * @param {number} bucketDtMs
 * @param {object} [opts]
 * @param {number[]} [opts.signalSPL_per_band]   optional; skips noise correction when absent
 * @param {number[]} [opts.ambientNoise_per_band]
 * @returns {{ sti: number, tiPerBand: number[], mtfPerBand: number[][] }}
 */
export function calcSTIFromIR(bandHistograms, bucketDtMs, opts = {}) {
  const B = bandHistograms.length;
  const signal = opts.signalSPL_per_band ?? null;
  const noise = opts.ambientNoise_per_band ?? null;
  const tiPerBand = new Array(B);
  const mtfPerBand = new Array(B);

  for (let b = 0; b < B; b++) {
    const h = bandHistograms[b];
    const mtfs = STI_MOD_FREQS_HZ.map(fm => computeMTF(h, bucketDtMs, fm));
    mtfPerBand[b] = mtfs;

    // Noise correction only if caller supplied both vectors.
    let noiseTerm = 1;
    if (signal && noise && isFinite(signal[b]) && isFinite(noise[b])) {
      const snrDb = signal[b] - noise[b];
      noiseTerm = 1 / (1 + Math.pow(10, -snrDb / 10));
    }
    // Mean MTF across 14 modulation frequencies × noise term.
    let mSum = 0;
    for (const m of mtfs) mSum += m;
    const mMean = Math.max(1e-4, Math.min(0.9999, (mSum / mtfs.length) * noiseTerm));
    const snrAppRaw = 10 * Math.log10(mMean / (1 - mMean));
    const snrApp = Math.max(-SNR_APP_CLAMP_DB, Math.min(SNR_APP_CLAMP_DB, snrAppRaw));
    tiPerBand[b] = (snrApp + SNR_APP_CLAMP_DB) / (2 * SNR_APP_CLAMP_DB);
  }

  // Weighted STI per IEC 60268-16 Annex A, same formula as simplified
  // STIPA — α on per-band TI, β on √(TI_k · TI_{k+1}) for inter-band
  // redundancy.
  let sti = 0;
  for (let k = 0; k < B; k++) sti += (STI_ALPHA_MALE[k] ?? 0) * tiPerBand[k];
  for (let k = 0; k < STI_BETA_MALE.length && k + 1 < B; k++) {
    sti -= STI_BETA_MALE[k] * Math.sqrt(Math.max(0, tiPerBand[k] * tiPerBand[k + 1]));
  }
  return {
    sti: Math.max(0, Math.min(1, sti)),
    tiPerBand,
    mtfPerBand,
  };
}

// ---- Convenience wrapper ------------------------------------------------
//
// Given the full PrecisionResult from runPrecisionRender() (or the
// equivalent shape returned by tracer-core / worker-pool), compute all
// metrics for every receiver, per band + broadband.

/**
 * Slice a per-band per-receiver histogram out of the flat Float32Array.
 */
export function histogramForReceiverBand(result, receiverIdx, bandIdx) {
  const { histogram, shape } = result;
  const { bands: B, buckets: T } = shape;
  const start = receiverIdx * B * T + bandIdx * T;
  return histogram.subarray(start, start + T);
}

export function deriveMetrics(result, opts = {}) {
  const { shape, bucketDtMs } = result;
  const { receivers: R, bands: B, buckets: T } = shape;
  const directWindowMs = opts.directWindowMs ?? 10;
  const out = [];

  for (let r = 0; r < R; r++) {
    const broadband = new Float32Array(T);
    const perBand = [];
    const bandHistograms = [];

    for (let b = 0; b < B; b++) {
      const bH = histogramForReceiverBand(result, r, b);
      bandHistograms.push(bH);
      for (let t = 0; t < T; t++) broadband[t] += bH[t];
      const L = decayDb(bH);
      perBand.push({
        edt_s: calcEDT(L, bucketDtMs),
        t20_s: calcT20(L, bucketDtMs),
        t30_s: calcT30(L, bucketDtMs),
        c80_db: calcC80(bH, bucketDtMs),
        c50_db: calcC50(bH, bucketDtMs),
        dr_db: calcDR(bH, bucketDtMs, directWindowMs),
      });
    }
    const L_bb = decayDb(broadband);
    const broadbandMetrics = {
      edt_s: calcEDT(L_bb, bucketDtMs),
      t20_s: calcT20(L_bb, bucketDtMs),
      t30_s: calcT30(L_bb, bucketDtMs),
      c80_db: calcC80(broadband, bucketDtMs),
      c50_db: calcC50(broadband, bucketDtMs),
      dr_db: calcDR(broadband, bucketDtMs, directWindowMs),
    };
    const sti = calcSTIFromIR(bandHistograms, bucketDtMs, {
      signalSPL_per_band: opts.signalSPL_per_band,
      ambientNoise_per_band: opts.ambientNoise_per_band,
    });
    out.push({ receiverIdx: r, perBand, broadband: broadbandMetrics, sti });
  }
  return out;
}
