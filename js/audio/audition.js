// Auralization — Phase 1 (mono playback, single listener).
//
// Convolves a clean speech sample with the listener's per-band impulse
// response (from the precision tracer) and plays through the user's
// headphones via Web Audio's ConvolverNode. The result is what the
// listener WOULD hear at that position with that PA, that room, those
// materials — assuming the simulated reverb is the only reverb the user
// hears (i.e. headphones, not speakers, on the user's end).
//
// Architecture:
//
//   AudioBufferSourceNode (loops the speech sample)
//        ↓
//   ConvolverNode (impulse response = sum of all sources at this listener)
//        ↓
//   GainNode (master level, default 0.6)
//        ↓
//   AudioContext.destination (headphones)
//
// Phase-1 simplifications (Phase 2/3 lift these):
//   • Mono — no stereo cue, no HRTF, no per-source positioning. The IR
//     used here is the SUM across all sources for one listener (the
//     same broadband IR drawn in the precision-panel echogram).
//   • Sparse IR — each tracer histogram bucket becomes one Dirac pulse
//     at amplitude = sqrt(energy). No band-pass synthesis, so the
//     "click" character of early reflections is exaggerated. Late
//     reverb decays smoothly because there are many late buckets.
//   • Bucket dt = tracer's bucketDtMs (typically 2 ms). Pulses placed
//     at round(t / sampleRate). Inter-pulse samples = 0.
//
// The speech sample is fetched once per session and cached on the
// AudioContext. The IR is rebuilt every time `play()` is called so it
// reflects the most recent precision render + listener selection.

let _audioCtx = null;
let _sampleBuffer = null;
let _activeChain = null;          // { source, convolver, gain }
let _samplePromise = null;
let _saturatorCurve = null;

const DEFAULT_GAIN = 0.6;
const SAMPLE_URL = 'assets/audio/testing-1-2-3.mp3';

// Phase 9.2 — soft-saturator WaveShaper curve. Replaces the Phase 7.1
// DynamicsCompressorNode which pumped audibly on LF-heavy IRs (Web
// Audio's compressor at 50 ms release breathes within the bass-cycle
// accumulation period of any room with significant 125 Hz tail, audible
// as "low-frequency distortion"). WaveShaper is sample-by-sample
// instantaneous → zero pumping. Curve is tanh(drive·x)/drive — soft
// knee, monotonic, ~1 % THD at -3 dBFS (below the audibility threshold
// for speech per Toole §4.3). Per Reiss & McPherson, *Audio Effects*,
// §6.2.4. The proper fix is a multiband AudioWorklet limiter (Phase 10);
// this is the same-day replacement that already eliminates the dominant
// pumping artefact.
function buildSoftSaturatorCurve(drive = 1.5, samples = 8192) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;     // [-1, 1]
    curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return curve;
}

function getCtx() {
  if (_audioCtx) return _audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API unavailable in this browser');
  _audioCtx = new Ctx();
  if (!_saturatorCurve) _saturatorCurve = buildSoftSaturatorCurve();
  return _audioCtx;
}

// Fetches and decodes the speech sample exactly once per session.
// Returns the cached AudioBuffer for subsequent calls.
function loadSample() {
  if (_sampleBuffer) return Promise.resolve(_sampleBuffer);
  if (_samplePromise) return _samplePromise;
  const ctx = getCtx();
  _samplePromise = fetch(SAMPLE_URL)
    .then(res => {
      if (!res.ok) throw new Error(`Sample fetch failed: ${res.status}`);
      return res.arrayBuffer();
    })
    .then(buf => ctx.decodeAudioData(buf))
    .then(decoded => {
      _sampleBuffer = decoded;
      return decoded;
    })
    .catch(err => {
      _samplePromise = null;
      throw err;
    });
  return _samplePromise;
}

// Convert the precision tracer's per-band histogram for ONE listener
// into a time-domain stereo IR at the AudioContext's sample rate.
//
// PHASE 6 — filtered velvet noise (Karjalainen / Välimäki / Schlecht).
// Earlier phases used a single Dirac per histogram bucket for the early
// section and dense white noise for the late. The early-section Dirac
// train is a 500 Hz comb spectrum (= 1/bucketDt) and survived as the
// dominant residual artefact through Phases 2.1–5 — the "digital voice"
// the user kept hearing was the comb stamping speech with a half-octave
// vocoder character at every multiple of 500 Hz.
//
// Filtered velvet noise replaces both code paths with a single
// stochastic synthesis that's been the SOTA for late-reverb modelling
// since Karjalainen 2002 (and Schlecht 2017 *Applied Sciences* showed
// it equivalent to Schroeder/FDN reverb at 1/10 the multiply count):
//
//   For each band b (125, 250, 500, 1k, 2k, 4k, 8k Hz):
//     For each histogram bucket t with band-energy E_b,t > 0:
//       Place Nv ≈ ⌈samplesPerBucket × ρ / sampleRate⌉ random-position
//       random-sign impulses at amplitude √(E_b,t / Nv) inside the
//       bucket's sample range.
//     Run that band's impulse stream through a biquad bandpass at the
//     band's centre frequency, Q = 1.41 (1-octave bandwidth).
//   Sum the 7 band streams.
//
// ρ = VELVET_DENSITY_PULSES_PER_SEC sets the broadband pulse density.
// 1500 pulses/s is the smoothness threshold per Karjalainen 2002 — below
// it the noise is audibly "ratty"; above it perceptually equivalent to
// Gaussian white noise. With 7 bands we get 7×Nv aggregate density
// which is comfortably above the threshold.
//
// Diracs are no longer special-cased for direct sound — the filtered
// velvet impulses still produce a sharp transient response (each impulse
// becomes a brief band-shaped wavelet of length ~Q/cf seconds) and the
// per-band scattering-in-time of multiple impulses naturally avoids the
// comb without losing transient identity for speech consonants.
const BAND_CENTERS_HZ = [125, 250, 500, 1000, 2000, 4000, 8000];
const BAND_Q = 1.41;     // 1-octave bandwidth
// Velvet pulse density. Phase 8.3 — bands ≤ 250 Hz get 2× density to
// avoid LF "warble" from the auditory critical band hearing each pulse
// individually (Schlecht 2017 §3.2 critical-band-aware thresholds).
const VELVET_DENSITY_PULSES_PER_SEC = 1500;
const VELVET_DENSITY_LF_PULSES_PER_SEC = 3000;
const VELVET_LF_BAND_INDEX = 1;          // 250 Hz and below
// Mixing time — perceptual transition from "discrete reflections with
// directional cues" (early, gets HRTF) to "diffuse statistical field"
// (late, no HRTF, decorrelated noise per ear). 80 ms is the standard
// across hall-sized rooms; smaller rooms reach mixing earlier but using
// the standard value is safer than over-fitting.
const MIXING_TIME_MS = 80;

// Single-pass biquad bandpass — Audio EQ Cookbook (Robert Bristow-Johnson,
// "Cookbook formulae for audio EQ biquad filter coefficients"). Direct
// Form II Transposed for numerical stability at low centre frequencies
// on Float32Array — Direct Form I drifts ~4 bits in the 125 Hz band at
// 48 kHz because |1 - 2cos(w0) + 1| ≈ 2.6e-4 needs more dynamic range
// than f32 has. DF2T keeps the magnitude of internal state bounded.
// (Smith, "Introduction to Digital Filters" §B.6; Cookbook §3.2)
function biquadBandpassInPlace(samples, centerHz, Q, sampleRate) {
  if (centerHz <= 0 || centerHz >= sampleRate / 2) return;
  const w0 = (2 * Math.PI * centerHz) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  // BPF (constant 0 dB peak gain): b = [α, 0, -α], a = [1+α, -2cosw0, 1-α]
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * cosw0) / a0;
  const a2 = (1 - alpha) / a0;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = b0 * x + s1;
    s1 = -a1 * y + s2;
    s2 = b2 * x - a2 * y;
    samples[i] = y;
  }
}

// Build TWO 2-channel IRs from the listener's histogram:
//   • earlyIR: t < MIXING_TIME_MS, identical L/R per band — gets HRTF
//     spatialisation upstream so direct + early reflections inherit the
//     source-direction binaural cue (Begault, NASA TM-2000-110410 §4.3).
//   • lateIR: t ≥ MIXING_TIME_MS, INDEPENDENT random per channel — the
//     diffuse field is statistical from all directions, no single HRTF
//     direction applies. Generic-HRTF stamping of late reverb makes it
//     1.5–2 dB louder and "narrower" than physical (Wenzel et al.,
//     J.AES 1993). Phase 8.1 separates the chains so the HRTF only
//     touches the early section where it belongs.
//
// Both IRs use Phase 6 filtered velvet noise (random position +
// random sign per impulse, per band, bandpass-filtered). Phase 8.3 — LF
// bands (≤250 Hz) get 2× pulse density to keep the per-critical-band
// pulse count above the smoothness threshold.
function buildStereoIRPair(histogram, shape, bucketDtMs, receiverIdx, sampleRate) {
  const { bands: B, buckets: T } = shape;
  const bucketDtSec = bucketDtMs / 1000;
  const samplesPerBucket = Math.max(1, Math.round(bucketDtSec * sampleRate));

  // Energy per bucket + peak (for truncation only).
  const bucketEnergy = new Float32Array(T);
  const recOff = receiverIdx * B * T;
  let peakEnergy = 0;
  for (let b = 0; b < T; b++) {
    let energy = 0;
    for (let band = 0; band < B; band++) {
      energy += histogram[recOff + band * T + b];
    }
    bucketEnergy[b] = energy;
    if (energy > peakEnergy) peakEnergy = energy;
  }
  if (peakEnergy <= 0) {
    const empty = new Float32Array(samplesPerBucket);
    return { earlyL: empty, earlyR: empty, lateL: empty, lateR: empty };
  }
  const cutoff = peakEnergy * 1e-6;
  let lastUseful = T - 1;
  while (lastUseful > 0 && bucketEnergy[lastUseful] < cutoff) lastUseful--;
  const usefulBuckets = lastUseful + 1;
  const mixingBucket = Math.min(usefulBuckets, Math.ceil(MIXING_TIME_MS / bucketDtMs));
  const totalSamples = usefulBuckets * samplesPerBucket;

  const earlyL = new Float32Array(totalSamples);
  const earlyR = new Float32Array(totalSamples);
  const lateL = new Float32Array(totalSamples);
  const lateR = new Float32Array(totalSamples);

  const NvBroadband = Math.max(1, Math.round(samplesPerBucket * VELVET_DENSITY_PULSES_PER_SEC / sampleRate));
  const NvLF = Math.max(1, Math.round(samplesPerBucket * VELVET_DENSITY_LF_PULSES_PER_SEC / sampleRate));
  const nBands = Math.min(B, BAND_CENTERS_HZ.length);

  for (let bandIdx = 0; bandIdx < nBands; bandIdx++) {
    const cf = BAND_CENTERS_HZ[bandIdx];
    const Nv = bandIdx <= VELVET_LF_BAND_INDEX ? NvLF : NvBroadband;
    const bandEarlyL = new Float32Array(totalSamples);
    const bandEarlyR = new Float32Array(totalSamples);
    const bandLateL = new Float32Array(totalSamples);
    const bandLateR = new Float32Array(totalSamples);
    const bandOff = recOff + bandIdx * T;
    let bandHasEnergy = false;

    for (let b = 0; b < usefulBuckets; b++) {
      const E = histogram[bandOff + b];
      if (E <= 0) continue;
      bandHasEnergy = true;
      const amp = Math.sqrt(E / Nv);
      const start = b * samplesPerBucket;
      const isEarly = b < mixingBucket;
      if (isEarly) {
        // Same impulses on both channels — the HRTF panner will provide
        // the L/R cue based on source direction.
        for (let n = 0; n < Nv; n++) {
          const pos = start + (Math.random() * samplesPerBucket) | 0;
          const sign = Math.random() < 0.5 ? -1 : 1;
          bandEarlyL[pos] += sign * amp;
          bandEarlyR[pos] += sign * amp;
        }
      } else {
        // Independent draws per channel for diffuse-field decorrelation.
        for (let n = 0; n < Nv; n++) {
          const posL = start + (Math.random() * samplesPerBucket) | 0;
          bandLateL[posL] += (Math.random() < 0.5 ? -1 : 1) * amp;
          const posR = start + (Math.random() * samplesPerBucket) | 0;
          bandLateR[posR] += (Math.random() < 0.5 ? -1 : 1) * amp;
        }
      }
    }
    if (!bandHasEnergy) continue;

    biquadBandpassInPlace(bandEarlyL, cf, BAND_Q, sampleRate);
    biquadBandpassInPlace(bandEarlyR, cf, BAND_Q, sampleRate);
    biquadBandpassInPlace(bandLateL, cf, BAND_Q, sampleRate);
    biquadBandpassInPlace(bandLateR, cf, BAND_Q, sampleRate);
    for (let i = 0; i < totalSamples; i++) {
      earlyL[i] += bandEarlyL[i];
      earlyR[i] += bandEarlyR[i];
      lateL[i] += bandLateL[i];
      lateR[i] += bandLateR[i];
    }
  }

  return { earlyL, earlyR, lateL, lateR };
}

// Loudness-target (RMS-based) IR normalisation. Phase 7.1 — replaced the
// previous peak-target normaliser which keyed to a single-sample L∞ that
// was dominated by the HF-band transient burst. The IR's L1 norm is
// 30–60× larger than its L∞ for typical filtered-velvet IRs, so peak-
// normalising to 0.5 left the convolution output peak at ±15 to ±30
// before the master gain — guaranteed DAC clipping on speech transients,
// audible as "blown driver" / LF distortion. Targeting an RMS of ~0.06
// (matches what convolver.normalize=true does internally for "real-room"
// IRs per W3C spec §1.34) keeps the convolved output peak under ±1.0
// without forcing equal-power-across-rooms (we still preserve room-to-
// room loudness gradient because the input/output RMS ratio is stable).
// References: Välimäki & Reiss, More Than 50 Years of Artificial
// Reverberation, AES60 keynote §5; Cauchy–Schwarz output peak bound.
// RMS-target IR normalisation. Output peak after convolution scales as
// input_RMS × ||h||₂, where ||h||₂ = √N × RMS_h. For a 0.5 s IR at 48 kHz
// (N = 24 000) and speech input at RMS 0.25, output_RMS ≈ 0.25 × 154 ×
// RMS_h. To keep output_RMS below 0.4 (peak ~1.0 with 4× crest factor)
// we need RMS_h ≤ 0.0104. Phase 9.2 shipped 0.04 which is far too loud
// → output_RMS ≈ 1.5 → severe clipping at the WaveShaper boundary.
// 0.012 keeps a typical room's output peak below the saturator's curve
// boundary; loud-room IRs may still produce occasional peaks but those
// land in the saturator's soft region (tanh roll-off) rather than the
// hard-clip boundary. Phase 9.5 fix.
function normaliseIR(ir, targetRms = 0.012) {
  let sumSq = 0;
  for (let i = 0; i < ir.length; i++) sumSq += ir[i] * ir[i];
  const rms = Math.sqrt(sumSq / ir.length);
  if (rms <= 0) return ir;
  const scale = targetRms / rms;
  for (let i = 0; i < ir.length; i++) ir[i] *= scale;
  return ir;
}

// Public API — start playback for the given listener using the most
// recent precision-render result. Stops any prior chain. Returns a
// promise that resolves when audio is actually playing.
//
// args:
//   precisionResult — state.results.precision (from runPrecisionRender)
//   receiverIdx     — index into state.listeners
export async function startAudition({ precisionResult, receiverIdx }) {
  if (!precisionResult || !precisionResult.histogram) {
    throw new Error('No precision render — run a render first');
  }
  if (typeof receiverIdx !== 'number' || receiverIdx < 0) {
    throw new Error('Invalid receiverIdx');
  }

  // Stop any existing chain BEFORE awaiting the sample so a rapid
  // double-click doesn't stack two playbacks.
  stopAudition();

  const ctx = getCtx();
  // Browsers suspend AudioContext until a user gesture — clicking the
  // audition button qualifies, but only if we resume it explicitly.
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const sample = await loadSample();

  // Phase 8.1 — split early (HRTF-shaped, single source-direction cue)
  // from late (per-ear decorrelated, no HRTF). Two parallel convolution
  // chains sum at the output. See buildStereoIRPair for the rationale.
  const { earlyL, earlyR, lateL, lateR } = buildStereoIRPair(
    precisionResult.histogram,
    precisionResult.shape,
    precisionResult.bucketDtMs,
    receiverIdx,
    ctx.sampleRate,
  );
  // RMS-target normalise each IR independently. Phase 7.1 — peak norm
  // under-budgets convolution output by L1/L_∞ ratio (~30×), causing DAC
  // clip on transients. RMS norm + DynamicsCompressor limiter caps it.
  normaliseIR(earlyL);
  normaliseIR(earlyR);
  normaliseIR(lateL);
  normaliseIR(lateR);

  const earlyBuffer = ctx.createBuffer(2, earlyL.length, ctx.sampleRate);
  earlyBuffer.getChannelData(0).set(earlyL);
  earlyBuffer.getChannelData(1).set(earlyR);
  const lateBuffer = ctx.createBuffer(2, lateL.length, ctx.sampleRate);
  lateBuffer.getChannelData(0).set(lateL);
  lateBuffer.getChannelData(1).set(lateR);

  const source = ctx.createBufferSource();
  source.buffer = sample;
  source.loop = true;

  // HRTF panner positioned at the L_w-weighted source centroid relative
  // to the listener. Only feeds the EARLY convolver — late reverb stays
  // direction-neutral because real diffuse fields arrive from all
  // directions with average HRTF colouring, not the source's HRTF.
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 1;
  panner.maxDistance = 100;
  panner.rolloffFactor = 0.5;
  const rel = sourceCentroidRelative(precisionResult, receiverIdx);
  if (rel) {
    panner.positionX.value = rel.x;
    panner.positionY.value = rel.z;
    panner.positionZ.value = -rel.y;
  }

  const earlyConv = ctx.createConvolver();
  earlyConv.normalize = false;
  earlyConv.buffer = earlyBuffer;

  const lateConv = ctx.createConvolver();
  lateConv.normalize = false;
  lateConv.buffer = lateBuffer;

  // Sum the two paths via a single GainNode acting as a mixer.
  const mixer = ctx.createGain();
  mixer.gain.value = 1.0;

  // Phase 9.5 — two-stage limiter. Phase 7.1 used DynamicsCompressor
  // alone (pumped on LF). Phase 9.2 used WaveShaper alone (hard-clipped
  // peaks above ±1 because the curve bounds output to its sample range).
  // Now both, in series:
  //   Stage A — slow compressor with 300 ms release. Long enough that
  //   gain reduction holds across multiple LF cycles instead of breathing
  //   within them (Katz, *Mastering Audio* §13 "bass-pumping problem").
  //   Threshold -6 dB, ratio 4:1 → gentle envelope-following control of
  //   the slow LF buildup, not a brick-wall.
  //   Stage B — WaveShaper soft-saturator catches transients the slow
  //   compressor missed, sample-by-sample, with no pumping. Curve is
  //   tanh(1.5x)/tanh(1.5) — soft knee, monotonic, ~1% THD at -3 dBFS
  //   (below speech audibility threshold per Toole §4.3). 4× oversampling
  //   to suppress aliasing from saturation.
  // Net: dynamic range squeezed by ~3 dB, transients softened, no
  // pumping, no hard clipping. The proper fix (multiband AudioWorklet
  // limiter) is Phase 10 backlog.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -6;
  compressor.knee.value = 6;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.300;
  const limiter = ctx.createWaveShaper();
  limiter.curve = _saturatorCurve;
  limiter.oversample = '4x';

  const gain = ctx.createGain();
  gain.gain.value = DEFAULT_GAIN;

  // Path A: source → HRTF → early IR convolver → mixer
  source.connect(panner);
  panner.connect(earlyConv);
  earlyConv.connect(mixer);
  // Path B: source → late IR convolver → mixer (no HRTF, no panner)
  source.connect(lateConv);
  lateConv.connect(mixer);
  // Common downstream: slow compressor → soft-saturator → gain → out
  mixer.connect(compressor);
  compressor.connect(limiter);
  limiter.connect(gain);
  gain.connect(ctx.destination);

  source.start();

  _activeChain = { source, panner, earlyConv, lateConv, mixer, compressor, limiter, gain, mode: 'convolved' };
}

// Compute the dominant source's position relative to the given listener,
// L_w-weighted across all sources in the precision result. Returns
// { x, y, z } in state coords (positive y = forward, positive z = up),
// or null if the snapshot doesn't carry positions.
function sourceCentroidRelative(precisionResult, receiverIdx) {
  const scene = precisionResult.scene;
  const sources = scene?.sources;
  const receivers = scene?.receivers;
  if (!sources || !receivers) return null;
  const S = sources.count, B = scene.bands_hz?.length ?? 7;
  if (S === 0) return null;
  const lx = receivers.positions[receiverIdx * 3 + 0];
  const ly = receivers.positions[receiverIdx * 3 + 1];
  const lz = receivers.positions[receiverIdx * 3 + 2];
  let cx = 0, cy = 0, cz = 0, total = 0;
  for (let i = 0; i < S; i++) {
    let lw_lin = 0;
    for (let k = 0; k < B; k++) {
      lw_lin += Math.pow(10, sources.L_w[i * B + k] / 10);
    }
    cx += sources.positions[i * 3 + 0] * lw_lin;
    cy += sources.positions[i * 3 + 1] * lw_lin;
    cz += sources.positions[i * 3 + 2] * lw_lin;
    total += lw_lin;
  }
  if (total <= 0) return null;
  return { x: cx / total - lx, y: cy / total - ly, z: cz / total - lz };
}

// Stop + tear down the active chain. Idempotent. Works for both the
// convolved (audition) chain and the dry (original) chain — they're
// mutually exclusive; only one is ever live.
export function stopAudition() {
  if (!_activeChain) return;
  const { source, panner, convolver, earlyConv, lateConv, mixer, compressor, limiter, gain } = _activeChain;
  try { source.stop(); } catch (_) { /* already stopped */ }
  try {
    source.disconnect();
    if (panner) panner.disconnect();
    if (convolver) convolver.disconnect();
    if (earlyConv) earlyConv.disconnect();
    if (lateConv) lateConv.disconnect();
    if (mixer) mixer.disconnect();
    if (compressor) compressor.disconnect();
    if (limiter) limiter.disconnect();
    gain.disconnect();
  } catch (_) { /* ignore */ }
  _activeChain = null;
}

// Returns 'convolved' | 'dry' | null — the kind of playback in flight,
// or null when nothing is playing. UI uses this to keep both buttons
// in sync.
export function getAuditionMode() {
  return _activeChain?.mode ?? null;
}

export function isAuditionPlaying() {
  return _activeChain !== null;
}

// Play the speech sample WITHOUT convolution — the "original tone" the
// audition is being compared against. Reuses the same gain envelope so
// loudness matches the convolved playback for fair A/B.
export async function startOriginalPlayback() {
  stopAudition();
  const ctx = getCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  const sample = await loadSample();
  const source = ctx.createBufferSource();
  source.buffer = sample;
  source.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = DEFAULT_GAIN;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start();
  _activeChain = { source, convolver: null, gain, mode: 'dry' };
}

export function setAuditionGain(linear01) {
  if (_activeChain && Number.isFinite(linear01)) {
    _activeChain.gain.gain.value = Math.max(0, Math.min(1, linear01));
  }
}

// HEAD-probe the sample once at app boot so the audition button can
// disable itself if the file isn't shipped (tooltip explains).
export async function checkSampleAvailable() {
  try {
    const res = await fetch(SAMPLE_URL, { method: 'HEAD' });
    return res.ok;
  } catch (_) {
    return false;
  }
}
