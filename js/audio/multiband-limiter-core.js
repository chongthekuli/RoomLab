// Phase 10 — Multiband limiter CORE (pure ES module, no AudioWorklet
// globals). The browser-side worklet (multiband-limiter-worklet.js) is a
// classic-script wrapper that inlines this logic so it can be loaded via
// `audioWorklet.addModule()` on browsers that don't support ES-module
// worklets (Chrome ≥ 91 / Firefox ≥ 105 / Safari ≥ 16.4 do; older targets
// stated in the Phase 10 brief — Chrome 66 / Firefox 76 / Safari 14.1 —
// don't, so we ship classic-script for safety).
//
// This file contains everything except the `AudioWorkletProcessor`
// subclass + `registerProcessor()` call, so it's directly testable in
// Node ESM.
//
// References
// ----------
// • Linkwitz, S. H. "Active Crossover Networks for Noncoincident Drivers"
//   J.AES Vol. 24, No. 1, 1976. — LR4 = LR2² where LR2 is two cascaded
//   Butterworth biquads with Q = 1/√2.
// • Bristow-Johnson, R. "Cookbook formulae for audio EQ biquad filter
//   coefficients" (Audio EQ Cookbook), §3.1 (LPF), §3.2 (HPF).
// • Smith, J. O. "Introduction to Digital Filters" §B.6 — Direct Form II
//   Transposed structure for numerical stability.
// • Reiss, J. & McPherson, A. "Audio Effects: Theory, Implementation and
//   Application" CRC Press 2014, §5.4 (envelope follower) §5.5 (knee).
// • Katz, B. "Mastering Audio" 3rd ed. 2014, §13.3 — bass-band release
//   time guidance.
// • Tan, C-T. & Moore, B. C. J. "The effect of nonlinear distortion on
//   the perceived quality of music and speech signals" J.AES 2003 —
//   pumping perception threshold.
// • Zwicker, E. & Fastl, H. "Psychoacoustics — Facts and Models" 3rd ed.
//   Springer 2007, §6.3 — HF masking.

// ---------------------------------------------------------------------
// Biquad coefficient builders (Audio EQ Cookbook).
// ---------------------------------------------------------------------

export function lpfButterworthCoeffs(fc, fs) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const Q = Math.SQRT1_2;     // Butterworth = 1/√2 = 0.7071
  const alpha = sinw0 / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw0) / 2) / a0,
    b1: (1 - cosw0) / a0,
    b2: ((1 - cosw0) / 2) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function hpfButterworthCoeffs(fc, fs) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const Q = Math.SQRT1_2;
  const alpha = sinw0 / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosw0) / 2) / a0,
    b1: (-(1 + cosw0)) / a0,
    b2: ((1 + cosw0) / 2) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  };
}

// Direct Form II Transposed single-step. Mutates `state` (length 2).
// Smith, "Intro to DSP Filters" §B.6 — DF2T keeps internal state
// magnitude bounded for low-fc/high-fs cases where DF1 drifts on f32.
export function biquadStep(x, c, state) {
  const y = c.b0 * x + state[0];
  state[0] = c.b1 * x - c.a1 * y + state[1];
  state[1] = c.b2 * x - c.a2 * y;
  return y;
}

// ---------------------------------------------------------------------
// Channel state — one per audio channel.
// ---------------------------------------------------------------------

export function makeChannelState() {
  const newStage = () => new Float32Array(2);
  return {
    // Main split path — see worklet docs for the topology.
    lf_lp200_a: newStage(), lf_lp200_b: newStage(),
    hp200_a: newStage(),   hp200_b: newStage(),
    mf_lp2k_a: newStage(),  mf_lp2k_b: newStage(),
    hf_hp2k_a: newStage(),  hf_hp2k_b: newStage(),
    // LF phase-correction all-pass at 2 kHz.
    ap_lp2k_a: newStage(), ap_lp2k_b: newStage(),
    ap_hp2k_a: newStage(), ap_hp2k_b: newStage(),
    // Envelope state (peak level, linear) per band
    env_lf: 0, env_mf: 0, env_hf: 0,
  };
}

// ---------------------------------------------------------------------
// Limiter parameter builder — translates spec (dB / ms) to runtime
// constants (linear thresholds, smoothing coefficients).
// ---------------------------------------------------------------------

export function buildLimiterParams(fs) {
  const dbToLin = (db) => Math.pow(10, db / 20);
  const tauCoef = (tauMs) => Math.exp(-1 / ((tauMs / 1000) * fs));
  return {
    lf: {
      thr: dbToLin(-3), thrDb: -3, ratio: 10,
      atkCoef: tauCoef(5), relCoef: tauCoef(300), kneeDb: 6,
    },
    mf: {
      thr: dbToLin(-1), thrDb: -1, ratio: 20,
      atkCoef: tauCoef(1), relCoef: tauCoef(50), kneeDb: 0,
    },
    hf: {
      thr: dbToLin(-1), thrDb: -1, ratio: 20,
      atkCoef: tauCoef(0.5), relCoef: tauCoef(30), kneeDb: 0,
    },
  };
}

// ---------------------------------------------------------------------
// Crossover coefficient bundle — one set shared across all channels.
// ---------------------------------------------------------------------

export function buildCrossoverCoeffs(fs) {
  return {
    lpf200: lpfButterworthCoeffs(200, fs),
    hpf200: hpfButterworthCoeffs(200, fs),
    lpf2k:  lpfButterworthCoeffs(2000, fs),
    hpf2k:  hpfButterworthCoeffs(2000, fs),
  };
}

// ---------------------------------------------------------------------
// Soft-knee gain reduction (Reiss & McPherson §5.5 Eq. 5.10).
// envLin: current envelope level (linear amplitude, ≥ 0)
// p: { thr, thrDb, ratio, kneeDb }
// Returns linear gain ≤ 1.0.
// ---------------------------------------------------------------------

export function gainFor(envLin, p) {
  if (envLin <= 1e-10) return 1;
  const envDb = 20 * Math.log10(envLin);
  const overshoot = envDb - p.thrDb;
  let reductionDb;
  if (p.kneeDb > 0) {
    const halfKnee = p.kneeDb / 2;
    if (overshoot < -halfKnee) {
      reductionDb = 0;
    } else if (overshoot > halfKnee) {
      reductionDb = overshoot * (1 - 1 / p.ratio);
    } else {
      // Quadratic transition: at overshoot = -halfKnee → 0 reduction;
      // at +halfKnee → overshoot · (1 - 1/ratio); smooth derivative
      // at both endpoints. (Reiss & McPherson Eq. 5.10.)
      const t = (overshoot + halfKnee) / p.kneeDb;     // 0..1
      reductionDb = (1 - 1 / p.ratio) * (overshoot + halfKnee) * t * 0.5;
    }
  } else {
    reductionDb = overshoot > 0 ? overshoot * (1 - 1 / p.ratio) : 0;
  }
  if (reductionDb <= 0) return 1;
  return Math.pow(10, -reductionDb / 20);
}

// ---------------------------------------------------------------------
// Process N samples for one channel.
// Mutates s (channel state) and writes outBuf.
// ---------------------------------------------------------------------

export function processChannel(inBuf, outBuf, s, xover, params) {
  const { lpf200, hpf200, lpf2k, hpf2k } = xover;
  const lfP = params.lf, mfP = params.mf, hfP = params.hf;
  const N = inBuf.length;

  for (let i = 0; i < N; i++) {
    const x = inBuf[i];

    // --- LR4 split -------------------------------------------------
    // LF path: x → LPF200 → LPF200 (24 dB/oct LR4 LPF at 200 Hz)
    const lf1 = biquadStep(x, lpf200, s.lf_lp200_a);
    let lf  = biquadStep(lf1, lpf200, s.lf_lp200_b);
    // HP200 path: x → HPF200 → HPF200 (LR4 HPF at 200 Hz)
    const hp1 = biquadStep(x, hpf200, s.hp200_a);
    const hp  = biquadStep(hp1, hpf200, s.hp200_b);
    // From hp: MF = LPF2k → LPF2k (LR4 LPF at 2k of the HP200'd signal)
    const mf1 = biquadStep(hp, lpf2k, s.mf_lp2k_a);
    const mf  = biquadStep(mf1, lpf2k, s.mf_lp2k_b);
    // From hp: HF = HPF2k → HPF2k
    const hf1 = biquadStep(hp, hpf2k, s.hf_hp2k_a);
    const hf  = biquadStep(hf1, hpf2k, s.hf_hp2k_b);

    // --- LF phase correction at 2 kHz ------------------------------
    // The MF and HF bands have been through the 2k crossover; the LF
    // band hasn't, so its phase response at 2k differs from MF+HF by
    // the LR4 phase shift. The LR4 all-pass equivalent
    //   AP(z) = LR4_LP(z) + LR4_HP(z)
    // has unit magnitude at all frequencies and the same phase shift
    // as the LR4 split branches, so passing LF through it phase-aligns
    // it with MF and HF at the 2 kHz crossover. (Linkwitz Lab tech note
    // "Active Filters" §5; Lipshitz & Vanderkooy J.AES 1986.)
    const ap_lp1 = biquadStep(lf, lpf2k, s.ap_lp2k_a);
    const ap_lp  = biquadStep(ap_lp1, lpf2k, s.ap_lp2k_b);
    const ap_hp1 = biquadStep(lf, hpf2k, s.ap_hp2k_a);
    const ap_hp  = biquadStep(ap_hp1, hpf2k, s.ap_hp2k_b);
    lf = ap_lp + ap_hp;

    // --- Per-band envelope followers (Reiss Eq. 5.7) ---------------
    const lfAbs = Math.abs(lf);
    if (lfAbs > s.env_lf) {
      s.env_lf = lfP.atkCoef * s.env_lf + (1 - lfP.atkCoef) * lfAbs;
    } else {
      s.env_lf = lfP.relCoef * s.env_lf;
    }
    const gLf = gainFor(s.env_lf, lfP);

    const mfAbs = Math.abs(mf);
    if (mfAbs > s.env_mf) {
      s.env_mf = mfP.atkCoef * s.env_mf + (1 - mfP.atkCoef) * mfAbs;
    } else {
      s.env_mf = mfP.relCoef * s.env_mf;
    }
    const gMf = gainFor(s.env_mf, mfP);

    const hfAbs = Math.abs(hf);
    if (hfAbs > s.env_hf) {
      s.env_hf = hfP.atkCoef * s.env_hf + (1 - hfP.atkCoef) * hfAbs;
    } else {
      s.env_hf = hfP.relCoef * s.env_hf;
    }
    const gHf = gainFor(s.env_hf, hfP);

    // --- Sum bands × gains ----------------------------------------
    outBuf[i] = lf * gLf + mf * gMf + hf * gHf;
  }
}
