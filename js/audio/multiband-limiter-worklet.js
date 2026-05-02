// Phase 10 — 3-band Linkwitz-Riley LR4 multiband limiter (AudioWorklet).
//
// CLASSIC-SCRIPT worklet. Logic is duplicated from
// js/audio/multiband-limiter-core.js so this file can be loaded via
// `audioWorklet.addModule()` on browsers that don't support ES-module
// worklets (Chrome ≥ 91, Firefox ≥ 105, Safari ≥ 16.4 do support them;
// older targets — Chrome 66, Firefox 76, Safari 14.1 stated in the
// Phase 10 brief — don't, hence classic script).
//
// If you change the algorithm, change the core file and copy the matching
// functions here. The unit tests exercise the core file; the worklet
// shares the identical math and therefore inherits the verification.
//
// Background — why this file exists
// ----------------------------------
// Phases 7-9 chased an audible LF crack/distortion artefact through a
// progression of single-band dynamics nodes (DynamicsCompressor, then a
// WaveShaper soft-clip with dynamic RMS pre-normalisation). Every single-
// band envelope follower has the same fundamental problem on LF-heavy
// content: for inaudible "pumping" the release time must exceed
// 1 / pumping_freq, but for low frequencies that means a release window
// of hundreds of milliseconds — long enough that the gain reduction from
// one bass transient is still active when the next syllable arrives, and
// the listener perceives this as low-frequency distortion.
//
// The textbook fix (Katz "Mastering Audio" 3rd ed. §13; Izhaki "Mixing
// Secrets" §17) is a multiband limiter: split the spectrum into LF / MF /
// HF, compress each band with a release time matched to its lowest
// frequency, then sum. The LF band can have a 300 ms release without
// pumping the speech band.
//
// Architecture
// ------------
// Per-channel chain (L and R independent — diffuse-field reverb is
// decorrelated, so a sidechain-summed envelope would fight the late-
// reverb decorrelation we worked hard to build):
//
//   input
//     ├─ LR4 LPF(200) ─ AP(2k) ──── LF band ─┐
//     └─ LR4 HPF(200) ─┐                     │
//                      ├─ LR4 LPF(2k) ── MF ─┤
//                      └─ LR4 HPF(2k) ── HF ─┤
//                                            │
//   per-band envelope follower → gain ───────┘
//                                            │
//   Σ (LF·gLF + MF·gMF + HF·gHF) ──────── output
//
// LR4 = TWO cascaded 2nd-order Butterworth biquads (Q = 1/√2). The pair
// gives 24 dB/oct rolloff and — crucially — magnitude-flat sum at the
// crossover (each branch is -6 dB at fc, summing coherently to 0 dB).
// (Linkwitz J.AES 1976 Eq. 5; Audio EQ Cookbook §3.1.)
//
// LF band gets a phase-correction all-pass at 2 kHz (LP² + HP² of itself,
// summed) so it shares the 2 kHz phase response with MF and HF. Without
// this, transients would be audibly smeared because the LF band leads MF
// by 360° at fc=2k. (Linkwitz Lab "Active Filters" §5.)
//
// Numerical stability
// -------------------
// All biquads use Direct Form II Transposed (Smith "Intro to DSP Filters"
// §B.6) which keeps internal state magnitude bounded even at very low
// fc/fs ratios. Phase 6 lesson: DF1 drifts ~4 bits at 125 Hz / 48 kHz on
// Float32. DF2T residual at 200 Hz / 48 kHz is < 1 LSB f32.
//
// Envelope follower & soft knee — Reiss & McPherson, "Audio Effects:
// Theory, Implementation and Application" CRC 2014 §5.4 (peak follower)
// and §5.5 (quadratic knee).
//
// Per-band parameter rationale
// ----------------------------
// LF  thr -3 dB, ratio 10:1, attack 5 ms, release 300 ms, knee 6 dB
//   Katz "Mastering Audio" §13.3 — release ≥ 1.5× the period of the
//   lowest band. LF band extends down to ~30 Hz (T = 33 ms); 300 ms
//   gives ~9 cycles, well above the pumping perception threshold per
//   Tan & Moore J.AES 2003. Knee 6 dB avoids audible "edges" when the
//   envelope crosses threshold (frequent on bass content).
// MF  thr -1 dB, ratio 20:1, attack 1 ms, release 50 ms, knee 0 dB
//   Speech-band brick wall. 1 ms attack catches consonant transients
//   without distorting their leading edge (rise time ~5 ms minimum).
// HF  thr -1 dB, ratio 20:1, attack 0.5 ms, release 30 ms, knee 0 dB
//   Sibilance / cymbal limiter. 0.5 ms attack can momentarily distort
//   the leading edge of a /s/, but THD in this band is masked by
//   ~30 dB per Zwicker & Fastl §6.3.

const SR_FALLBACK = 48000;

// --- Biquad coefficients (Audio EQ Cookbook §3.1 / §3.2) -----------------

function lpfButterworthCoeffs(fc, fs) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const Q = Math.SQRT1_2;
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

function hpfButterworthCoeffs(fc, fs) {
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
function biquadStep(x, c, state) {
  const y = c.b0 * x + state[0];
  state[0] = c.b1 * x - c.a1 * y + state[1];
  state[1] = c.b2 * x - c.a2 * y;
  return y;
}

function makeChannelState() {
  const newStage = () => new Float32Array(2);
  return {
    lf_lp200_a: newStage(), lf_lp200_b: newStage(),
    hp200_a: newStage(),    hp200_b: newStage(),
    mf_lp2k_a: newStage(),  mf_lp2k_b: newStage(),
    hf_hp2k_a: newStage(),  hf_hp2k_b: newStage(),
    ap_lp2k_a: newStage(),  ap_lp2k_b: newStage(),
    ap_hp2k_a: newStage(),  ap_hp2k_b: newStage(),
    env_lf: 0, env_mf: 0, env_hf: 0,
  };
}

function buildLimiterParams(fs) {
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

function buildCrossoverCoeffs(fs) {
  return {
    lpf200: lpfButterworthCoeffs(200, fs),
    hpf200: hpfButterworthCoeffs(200, fs),
    lpf2k:  lpfButterworthCoeffs(2000, fs),
    hpf2k:  hpfButterworthCoeffs(2000, fs),
  };
}

// Soft-knee gain reduction (Reiss & McPherson §5.5 Eq. 5.10).
function gainFor(envLin, p) {
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
      const t = (overshoot + halfKnee) / p.kneeDb;
      reductionDb = (1 - 1 / p.ratio) * (overshoot + halfKnee) * t * 0.5;
    }
  } else {
    reductionDb = overshoot > 0 ? overshoot * (1 - 1 / p.ratio) : 0;
  }
  if (reductionDb <= 0) return 1;
  return Math.pow(10, -reductionDb / 20);
}

class MultibandLimiterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const fs = (options && options.processorOptions && options.processorOptions.sampleRate)
      || sampleRate
      || SR_FALLBACK;
    this._fs = fs;
    this._xover = buildCrossoverCoeffs(fs);
    this._params = buildLimiterParams(fs);
    this._stateL = makeChannelState();
    this._stateR = makeChannelState();
    this._bypass = false;

    // A/B testing hook — host can post `{ bypass: true }` to passthrough.
    this.port.onmessage = (e) => {
      if (e && e.data && typeof e.data.bypass === 'boolean') {
        this._bypass = e.data.bypass;
      }
    };
  }

  _processChannel(inBuf, outBuf, s) {
    const { lpf200, hpf200, lpf2k, hpf2k } = this._xover;
    const lfP = this._params.lf, mfP = this._params.mf, hfP = this._params.hf;
    const N = inBuf.length;
    for (let i = 0; i < N; i++) {
      const x = inBuf[i];
      // --- LR4 split ---
      const lf1 = biquadStep(x, lpf200, s.lf_lp200_a);
      let lf  = biquadStep(lf1, lpf200, s.lf_lp200_b);
      const hp1 = biquadStep(x, hpf200, s.hp200_a);
      const hp  = biquadStep(hp1, hpf200, s.hp200_b);
      const mf1 = biquadStep(hp, lpf2k, s.mf_lp2k_a);
      const mf  = biquadStep(mf1, lpf2k, s.mf_lp2k_b);
      const hf1 = biquadStep(hp, hpf2k, s.hf_hp2k_a);
      const hf  = biquadStep(hf1, hpf2k, s.hf_hp2k_b);
      // --- LF phase correction (LR4 all-pass at 2k) ---
      const ap_lp1 = biquadStep(lf, lpf2k, s.ap_lp2k_a);
      const ap_lp  = biquadStep(ap_lp1, lpf2k, s.ap_lp2k_b);
      const ap_hp1 = biquadStep(lf, hpf2k, s.ap_hp2k_a);
      const ap_hp  = biquadStep(ap_hp1, hpf2k, s.ap_hp2k_b);
      lf = ap_lp + ap_hp;
      // --- Envelope followers ---
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
      // --- Sum bands × gains ---
      outBuf[i] = lf * gLf + mf * gMf + hf * gHf;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }
    const nCh = Math.min(input.length, output.length);
    for (let ch = 0; ch < nCh; ch++) {
      const inBuf = input[ch];
      const outBuf = output[ch];
      if (this._bypass) {
        outBuf.set(inBuf);
        continue;
      }
      const s = (ch === 0) ? this._stateL : this._stateR;
      this._processChannel(inBuf, outBuf, s);
    }
    for (let ch = nCh; ch < output.length; ch++) output[ch].fill(0);
    return true;
  }
}

registerProcessor('multiband-limiter', MultibandLimiterProcessor);
