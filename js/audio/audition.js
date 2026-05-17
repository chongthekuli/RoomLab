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

import { computeRectangularModes, buildModeFilterChain } from './room-modes.js';
import { LiveDirectPathChain, subtractAnalyticalDirect } from './direct-path.js';
import { state, expandSources } from '../app-state.js';
import { computeMultiSourceSPL } from '../physics/spl-calculator.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';

// Compute the broadband-equivalent SPL the user reads off the 2D / 3D
// heatmap and the probe tooltip — single-frequency (state.physics.
// freq_hz, default 1 kHz), direct-field only (roomConstantR=0 because
// reverb is handled by the convolver path, not the SPL-trim). Goes
// through the EXACT same function the heatmap uses, so audition
// loudness changes match the heatmap colour byte-for-byte.
//
// Why direct-only? If we included the reverb in the SPL trim, the
// trim would change less aggressively as the listener walks (reverb
// is roughly position-independent), which would mute the perceived
// dynamics. The current architecture has reverb baked into the
// convolver IR; the SPL trim's job is to track the SPATIAL variation
// the user sees on the heatmap.
function computeAuditionSplDb(pos) {
  if (!state?.sources?.length) return -Infinity;
  try {
    return computeMultiSourceSPL({
      sources: expandSources(state.sources),
      getSpeakerDef: url => getCachedLoudspeaker(url),
      listenerPos: pos,
      freq_hz: state.physics?.freq_hz ?? 1000,
      roomConstantR: 0,
      coherent: !!state.physics?.coherent,
      airAbsorption: state.physics?.airAbsorption !== false,
    });
  } catch (err) {
    console.warn('[audition] SPL compute failed:', err);
    return -Infinity;
  }
}

let _audioCtx = null;
// Per-URL sample cache. Keyed by URL so switching presets (and therefore
// sample file) is a fresh fetch + decode, not a stale buffer replay.
const _sampleBuffersByUrl = new Map();   // url → AudioBuffer
const _samplePromisesByUrl = new Map();  // url → Promise<AudioBuffer> (in-flight)
let _activeChain = null;          // { source, convolver, gain }
let _saturatorCurve = null;
let _lastDebugLogTs = 0;          // walk-mode SPL-trim debug print throttle
// Phase 10 — multiband limiter worklet registration state.
//   null    = not yet attempted to load
//   Promise = load in flight (await it)
//   true    = worklet is registered, AudioWorkletNode is safe to construct
//   false   = worklet load failed → fall back to WaveShaper soft-clip
let _limiterWorkletState = null;
const LIMITER_WORKLET_URL = 'js/audio/multiband-limiter-worklet.js';

// Phase 9.7 → W.1 — master gain trimmed 0.5 → 0.25 to make 6 dB more
// headroom for the post-limiter SPL-trim. Walk-mode places the SPL-trim
// AFTER the multiband limiter so position-dependent loudness changes
// survive the limiter's clamping; that pushes the worst-case DAC
// excursion up to splTrimMax × master, so master had to come down to
// keep the chain below DAC clip at maximum live-direct boost.
// Baseline audition is therefore quieter than pre-W.1 — user can
// crank speaker / headphone volume; trade is full SPL-field dynamics.
const DEFAULT_GAIN = 0.25;

// Default speech sample, available in every scene.
const DEFAULT_SAMPLE_URL = 'assets/audio/testing-1-2-3.mp3';
// Surau-only sample (azan call to prayer). Becomes the surau preset's
// default test signal; in any non-surau scene this URL is not offered.
// Drop the file at assets/audio/azan.mp3; checkSampleAvailable() will
// HEAD-probe it and the audition button stays disabled if it's missing.
const SURAU_SAMPLE_URL = 'assets/audio/azan.mp3';

// Catalogue of every sample the audition engine knows about, keyed by a
// short stable id. Panels read this to render the selector dropdown.
export const AUDITION_SAMPLES = {
  speech: { id: 'speech', label: 'Speech (testing 1-2-3)',     url: DEFAULT_SAMPLE_URL },
  azan:   { id: 'azan',   label: 'Azan (call to prayer)',      url: SURAU_SAMPLE_URL   },
};

// Returns the list of samples the user is allowed to choose from in the
// current scene. Surau scenes offer both speech AND azan (azan default);
// every other scene offers speech only. Selector UI hides itself when
// the list has length 1.
export function listAuditionSamplesForScene() {
  if (state?.room?.surauStructure) {
    return [AUDITION_SAMPLES.azan, AUDITION_SAMPLES.speech];
  }
  return [AUDITION_SAMPLES.speech];
}

// User's explicit choice this session. null = use scene default (first
// entry of listAuditionSamplesForScene). Reset to null on scene:reset
// from panel-precision.js so a preset switch always re-defaults.
let _sampleOverrideId = null;
export function setAuditionSample(id) {
  const avail = listAuditionSamplesForScene();
  if (id && avail.some(s => s.id === id)) {
    _sampleOverrideId = id;
  } else {
    _sampleOverrideId = null;
  }
}
export function getAuditionSampleId() {
  const avail = listAuditionSamplesForScene();
  if (_sampleOverrideId && avail.some(s => s.id === _sampleOverrideId)) {
    return _sampleOverrideId;
  }
  return avail[0].id;
}

// Picks the URL for the currently selected (or scene-default) test
// signal. Resolved on each play / HEAD-probe so swapping presets or
// flipping the dropdown at runtime just works.
export function getSampleUrl() {
  const id = getAuditionSampleId();
  return AUDITION_SAMPLES[id]?.url || DEFAULT_SAMPLE_URL;
}

// Phase 9.8 — hard-knee soft-clip curve, linear below -3 dBFS. Previous
// tanh-everywhere curve compressed at all amplitudes, colouring even
// normal-level speech. Now linear identity for |x| < 0.7 (no THD on
// material that doesn't need limiting) with a tanh transition to the
// ±1.0 boundary above. Combined with the new RMS target of 0.12 (which
// keeps peaks at typical speech crest factor below the threshold) the
// saturator is effectively transparent on normal content and only
// engages on rare transient excursions.
function buildSoftSaturatorCurve(threshold = 0.7, samples = 8192) {
  const curve = new Float32Array(samples);
  // Pick `k` so the slope at the threshold matches identity (no kink):
  // d/dx(threshold + (1-threshold)·tanh(k·(x-threshold))) at x=threshold
  // = (1-threshold)·k. Identity slope is 1, so k = 1/(1-threshold).
  const k = 1 / (1 - threshold);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;     // [-1, 1]
    const ax = Math.abs(x);
    let y;
    if (ax < threshold) {
      y = x;     // linear identity below threshold
    } else {
      const sign = x < 0 ? -1 : 1;
      // Smooth soft-clip from threshold to ±1 via tanh.
      y = sign * (threshold + (1 - threshold) * Math.tanh(k * (ax - threshold)));
    }
    curve[i] = y;
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

// Phase 10 — register the multiband-limiter worklet exactly once per
// AudioContext. Called from startAudition() before the chain is built.
// Returns:
//   true  — worklet is registered, caller may build an AudioWorkletNode
//   false — worklet failed to load (no AudioWorklet API, or fetch error,
//           or the worklet script failed to register). Caller falls back
//           to the legacy WaveShaper soft-clip path.
// Idempotent: subsequent calls return the cached state.
async function ensureLimiterWorklet() {
  if (_limiterWorkletState === true) return true;
  if (_limiterWorkletState === false) return false;
  if (_limiterWorkletState && typeof _limiterWorkletState.then === 'function') {
    return _limiterWorkletState;
  }
  const ctx = getCtx();
  if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
    _limiterWorkletState = false;
    return false;
  }
  _limiterWorkletState = ctx.audioWorklet.addModule(LIMITER_WORKLET_URL)
    .then(() => {
      _limiterWorkletState = true;
      return true;
    })
    .catch((err) => {
      console.warn('[audition] multiband-limiter worklet failed to load — falling back to WaveShaper soft-clip:', err);
      _limiterWorkletState = false;
      return false;
    });
  return _limiterWorkletState;
}

// Fetches and decodes the active sample (speech or surau azan, chosen
// by getSampleUrl()). Each URL is cached separately so switching presets
// at runtime swaps the test signal without re-fetching a sample we
// already have.
function loadSample() {
  const url = getSampleUrl();
  const cached = _sampleBuffersByUrl.get(url);
  if (cached) return Promise.resolve(cached);
  const inFlight = _samplePromisesByUrl.get(url);
  if (inFlight) return inFlight;
  const ctx = getCtx();
  const p = fetch(url)
    .then(res => {
      if (!res.ok) throw new Error(`Sample fetch failed: ${res.status}`);
      return res.arrayBuffer();
    })
    .then(buf => ctx.decodeAudioData(buf))
    .then(decoded => {
      _sampleBuffersByUrl.set(url, decoded);
      _samplePromisesByUrl.delete(url);
      return decoded;
    })
    .catch(err => {
      _samplePromisesByUrl.delete(url);
      throw err;
    });
  _samplePromisesByUrl.set(url, p);
  return p;
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

  // PER-BAND truncation at -40 dB of EACH band's own peak. Phase 9.7 —
  // the previous broadband -60 dB cutoff kept LF-only buckets in the
  // late tail of carpet rooms (where 125 Hz energy lingers but every
  // other band has decayed to silence). Those late-LF buckets fed the
  // velvet-noise → biquad bandpass → 1+ s of 125 Hz tonal ringing →
  // audible "low-frequency crack" on speech transients. -40 dB per
  // band is the perceptual masking threshold (real reverb below this
  // level is masked by foreground speech). Each band gets its own
  // last-useful index; the IR length = max across bands.
  const recOff = receiverIdx * B * T;
  const bandEnergyArrays = new Array(B);
  const bandLastUseful = new Array(B).fill(-1);
  let anyEnergy = false;
  for (let band = 0; band < B; band++) {
    const arr = new Float32Array(T);
    let peak = 0;
    for (let b = 0; b < T; b++) {
      const e = histogram[recOff + band * T + b];
      arr[b] = e;
      if (e > peak) peak = e;
    }
    bandEnergyArrays[band] = arr;
    if (peak <= 0) continue;
    anyEnergy = true;
    const cutoff = peak * 1e-4;     // -40 dB per band
    let lu = T - 1;
    while (lu > 0 && arr[lu] < cutoff) lu--;
    bandLastUseful[band] = lu;
  }
  if (!anyEnergy) {
    const empty = new Float32Array(samplesPerBucket);
    return { earlyL: empty, earlyR: empty, lateL: empty, lateR: empty };
  }
  // Keep up to the longest band's tail.
  let lastUseful = 0;
  for (let band = 0; band < B; band++) {
    if (bandLastUseful[band] > lastUseful) lastUseful = bandLastUseful[band];
  }
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
    const bandLastUsefulIdx = bandLastUseful[bandIdx];
    if (bandLastUsefulIdx < 0) continue;     // band has no energy at all
    const bandEarlyL = new Float32Array(totalSamples);
    const bandEarlyR = new Float32Array(totalSamples);
    const bandLateL = new Float32Array(totalSamples);
    const bandLateR = new Float32Array(totalSamples);
    const bandArr = bandEnergyArrays[bandIdx];
    let bandHasEnergy = false;

    // Iterate only up to THIS band's truncation point — beyond it the
    // band's energy is below -40 dB and its tail wouldn't be audible
    // anyway, but velvet-noise + biquad would synthesise a 1+ s tonal
    // ring that IS audible because of phase-coherent accumulation.
    const bandLastBucket = Math.min(usefulBuckets, bandLastUsefulIdx + 1);
    for (let b = 0; b < bandLastBucket; b++) {
      const E = bandArr[b];
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
// IR-length-aware RMS normalisation. Phase 9.6 — adapts target RMS_h to
// the IR's sample count so the convolution output level is consistent
// across rooms of any RT60. Cauchy-Schwarz: for white-stationary input
// of RMS σ_x and IR of L2 norm ||h||₂ = √N · RMS_h:
//
//   output_RMS = σ_x · √N · RMS_h
//
// Solve for RMS_h to land at a fixed output RMS of 0.18 (~-15 dBFS,
// comfortable monitoring level after the 0.6 master gain → -19 dBFS at
// destination, well clear of the -1 dBFS limiter):
//
//   RMS_h = OUTPUT_TARGET / (TYPICAL_INPUT_RMS · √N)
//
// For TYPICAL_INPUT_RMS = 0.25 (typical speech) and N varying with IR
// length, RMS_h scales as 1/√N — short IRs use larger amplitudes, long
// IRs use smaller. The room's loudness GRADIENT is squashed (cathedral
// and studio sound similar loudness), traded for consistent monitoring
// level across rooms. The user can always crank the master gain if they
// want a long-tail room to feel proportionally louder.
const TYPICAL_INPUT_RMS = 0.25;
// Phase 9.9 — tightened 0.12 → 0.08. With LF-heavy carpet rooms the
// convolver output's bass-band crest factor reaches 8–10× (vs 4–6×
// for typical speech) — the LF buildup integrates speech transients
// into peaks that exceed the saturator threshold. RMS 0.08 keeps
// worst-case LF peaks at 0.8, just inside the saturator's soft-clip
// region. User can boost their headphone gain ~3 dB to compensate
// for the quieter monitoring level until the AudioWorklet multiband
// limiter (Phase 10) ships proper per-band dynamics.
const OUTPUT_RMS_TARGET = 0.08;

function normaliseIR(ir) {
  if (ir.length === 0) return ir;
  const targetRms = OUTPUT_RMS_TARGET / (TYPICAL_INPUT_RMS * Math.sqrt(ir.length));
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

  // Phase 10 — load the multiband-limiter worklet (idempotent). If it
  // fails to load (older browser, fetch error) the chain falls back to
  // the legacy WaveShaper soft-clip. We await BEFORE building the chain
  // so we know which limiter node to insert.
  const limiterReady = await ensureLimiterWorklet();

  // Phase W.1 — subtract the analytical-direct contribution from the
  // histogram BEFORE building the IR. The convolved chain then carries
  // reflections + reverb only; a parallel LiveDirectPathChain (built
  // below) supplies the direct sound from the live listener pose. This
  // is what lets walk-mode update the direct cue without rebuilding
  // the IR per step. The original histogram is left untouched (we
  // operate on a copy) so a future audition for a different listener
  // re-subtracts cleanly.
  const cleanedHistogram = subtractAnalyticalDirect({
    histogram: precisionResult.histogram,
    shape: precisionResult.shape,
    bucketDtMs: precisionResult.bucketDtMs,
    scene: precisionResult.scene,
    receiverIdx,
    airAbsorption: !!precisionResult?.options?.airAbsorption,
    airAbsCoefPerBand: precisionResult?.scene?.airAbsCoefPerBand ?? null,
  });

  // Phase 8.1 — split early (HRTF-shaped, single source-direction cue)
  // from late (per-ear decorrelated, no HRTF). Two parallel convolution
  // chains sum at the output. See buildStereoIRPair for the rationale.
  const { earlyL, earlyR, lateL, lateR } = buildStereoIRPair(
    cleanedHistogram,
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

  // Phase 9.7 — subsonic high-pass on the source. Cuts 30–60 Hz rumble
  // from MP3 codec / TTS source. Q = 0.707 = no resonance.
  const hpf = ctx.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = 60;
  hpf.Q.value = 0.707;

  // Phase 9.9 → Phase 10 — LF-band shelf cut, now -1 dB (was -4 dB).
  // The original -4 dB shelf was a Phase 9.9 same-day workaround for
  // the HIFI preset's longer LF tail clipping the WaveShaper soft-clip
  // path. With the Phase 10 multiband limiter handling LF dynamics
  // properly (5 ms attack / 300 ms release / 10:1 ratio on the <200 Hz
  // band), the shelf no longer NEEDS to do gain reduction — but a small
  // residual cut keeps the LF band away from the limiter threshold on
  // the steady-state RMS so the limiter only engages on actual peaks,
  // not the broadband signal floor. -1 dB is below the JND for spectral
  // tilt (Toole, "Sound Reproduction" 3rd ed. §17.4 ≈ 1 dB) so the
  // tonal balance is preserved. If A/B testing confirms the multiband
  // limiter is sufficient, this can drop to 0 in a follow-up.
  const lfShelf = ctx.createBiquadFilter();
  lfShelf.type = 'lowshelf';
  lfShelf.frequency.value = 200;
  lfShelf.gain.value = -1;

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

  // Phase 10 — proper 3-band Linkwitz-Riley multiband limiter. Splits
  // the convolver output into LF (<200 Hz) / MF (200–2k) / HF (>2k),
  // applies independent envelope-follower limiting per band (LF: 5 ms
  // attack / 300 ms release / soft 6 dB knee; MF: 1 ms / 50 ms; HF:
  // 0.5 ms / 30 ms), then sums the bands. The 300 ms LF release
  // window is long enough to be inaudible per Tan & Moore J.AES 2003
  // — pumping is only heard when the release < 1 / pumping_freq, and
  // 300 ms covers ~9 cycles of 30 Hz so any modulation is below the
  // perception threshold.
  //
  // If the AudioWorklet API or the worklet script load failed, we fall
  // back to the legacy Phase 9.8 WaveShaper soft-clip so audition still
  // works on Chrome < 66 / Firefox < 76 / Safari < 14.1. Those browsers
  // will still hear the LF crack on HIFI content — there's no fixing
  // that without an audio-thread compressor — but at least audition
  // doesn't hard-fail.
  let limiter;
  if (limiterReady) {
    try {
      limiter = new AudioWorkletNode(ctx, 'multiband-limiter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
    } catch (err) {
      console.warn('[audition] AudioWorkletNode construction failed — falling back to WaveShaper:', err);
      limiter = ctx.createWaveShaper();
      limiter.curve = _saturatorCurve;
      limiter.oversample = '4x';
    }
  } else {
    limiter = ctx.createWaveShaper();
    limiter.curve = _saturatorCurve;
    limiter.oversample = '4x';
  }

  const gain = ctx.createGain();
  gain.gain.value = DEFAULT_GAIN;

  // Phase 11.F — modal synthesis for rectangular rooms. Below the
  // Schroeder frequency (~200 Hz in a typical 73 m³ room) geometric ray
  // tracing fundamentally fails because the field is dominated by sparse
  // modes at specific frequencies, not the smooth diffuse decay the
  // tracer produces. We synthesise the audible 8–14 lowest modes via a
  // bank of biquad peaking filters tuned to the room's eigenfrequencies,
  // amplitude-weighted by mode-source-receiver coupling. Skipped for
  // non-rectangular rooms (the eigenfrequency closed form is rectangular-
  // specific; polygonal/round rooms need an FDTD/BEM solver — Phase 12+).
  let modeFilters = null;
  const room = precisionResult.scene?.room;
  if (room?.shape === 'rectangular') {
    const sourcePos = sourceWorldCentroid(precisionResult);
    const listenerPos = receiverWorldPos(precisionResult, receiverIdx);
    const t60 = precisionResult?.metricsCache?.[receiverIdx]?.broadband?.t30_s ?? 0.4;
    const V = (room.width_m ?? 0) * (room.depth_m ?? 0) * (room.height_m ?? 0);
    const schroederHz = V > 0 && t60 > 0 ? 2000 * Math.sqrt(t60 / V) : 200;
    const modes = computeRectangularModes({
      width_m: room.width_m, depth_m: room.depth_m, height_m: room.height_m,
      sourcePos, listenerPos, t60_s: t60, schroederHz, roomVolume_m3: V,
    });
    modeFilters = buildModeFilterChain(ctx, modes);
  }

  // Phase W.1 — live direct-path chain. Built once at startAudition and
  // updated per frame from setAuditionListenerPose() as the avatar
  // walks. Only feeds the mixer (no convolver) — the IR's direct
  // contribution was subtracted out above, so there's no double-count.
  // Bypasses the LF-shelf and the modes filter (the direct sound is
  // not subject to the room's modal coupling — modes are a long-term
  // resonant-field property of the reverberant tail).
  const liveDirect = new LiveDirectPathChain(ctx, precisionResult.scene, receiverIdx);

  // Phase W.1 SPL-trim — POST-LIMITER master GainNode that scales the
  // entire mix in lock-step with the predicted broadband direct SPL at
  // the listener's CURRENT position. Same physics as the heatmap
  // (computeBroadbandDirectSPL). At baseline = 1.0 (no audible jump
  // on audition start); walking changes it.
  //
  // Why post-limiter and not per-path? Earlier W.1 draft parked the
  // splTrim between the live-direct path and the mixer — but the
  // multiband limiter sits DOWNSTREAM of the mixer and was clamping
  // the resulting peaks back to threshold, so a 20 dB SPL drop produced
  // a barely-audible level change. Putting splTrim AFTER the limiter
  // makes the whole limited mix scale linearly with predicted SPL —
  // the user hears the position-dependent dynamics matching the
  // heatmap. Reverb tail also scales (approx wrong physically but
  // perceptually convincing); W.3's grid-interpolated late field
  // refines this to real per-position reverb.
  const splTrim = ctx.createGain();
  splTrim.gain.value = 1.0;
  const baselineSplDb = computeAuditionSplDb(receiverWorldPos(precisionResult, receiverIdx));

  // Path A: source → HPF → LF-shelf → [modes] → HRTF → early IR → mixer
  source.connect(hpf);
  hpf.connect(lfShelf);
  let preConvolverNode = lfShelf;
  if (modeFilters) {
    lfShelf.connect(modeFilters.input);
    preConvolverNode = modeFilters.output;
  }
  preConvolverNode.connect(panner);
  panner.connect(earlyConv);
  earlyConv.connect(mixer);
  // Path B: source → HPF → LF-shelf → [modes] → late IR convolver → mixer
  preConvolverNode.connect(lateConv);
  lateConv.connect(mixer);
  // Path C (W.1): source → HPF → LF-shelf → liveDirect → mixer
  // Live direct shares the source-side HPF + LF-shelf treatment but
  // skips the modes filter and the convolver.
  lfShelf.connect(liveDirect.input);
  liveDirect.output.connect(mixer);
  // Common downstream: mixer → multiband limiter → SPL-trim → master
  // gain → destination. splTrim is post-limiter (see comment above)
  // so the limiter sees a stable, baseline-calibrated mix and the
  // splTrim freely scales the limited output without being clamped.
  mixer.connect(limiter);
  limiter.connect(splTrim);
  splTrim.connect(gain);
  gain.connect(ctx.destination);

  source.start();

  _activeChain = {
    source, hpf, lfShelf, modeFilters, panner, earlyConv, lateConv,
    liveDirect, splTrim, mixer, limiter, gain, mode: 'convolved',
    // Cache so setAuditionListenerPose can re-evaluate panners
    // against the live source positions.
    precisionResult, receiverIdx,
    // SPL-trim baseline — the reference dB the live trim is computed
    // RELATIVE TO. Captured at audition-start time so subsequent
    // pose updates always produce the right delta.
    baselineSplDb,
    airAbsCoefPerBand: precisionResult?.scene?.airAbsCoefPerBand ?? null,
    airAbsorption: !!precisionResult?.options?.airAbsorption,
  };
}

// Helpers for modal synthesis — return positions in STATE coords.
function sourceWorldCentroid(precisionResult) {
  const scene = precisionResult.scene;
  const sources = scene?.sources;
  if (!sources || sources.count === 0) return { x: 0, y: 0, z: 0 };
  const B = scene.bands_hz?.length ?? 7;
  let cx = 0, cy = 0, cz = 0, total = 0;
  for (let i = 0; i < sources.count; i++) {
    let lw = 0;
    for (let k = 0; k < B; k++) lw += Math.pow(10, sources.L_w[i * B + k] / 10);
    cx += sources.positions[i * 3 + 0] * lw;
    cy += sources.positions[i * 3 + 1] * lw;
    cz += sources.positions[i * 3 + 2] * lw;
    total += lw;
  }
  if (total <= 0) return { x: 0, y: 0, z: 0 };
  return { x: cx / total, y: cy / total, z: cz / total };
}
function receiverWorldPos(precisionResult, receiverIdx) {
  const positions = precisionResult.scene?.receivers?.positions;
  if (!positions) return { x: 0, y: 0, z: 0 };
  return {
    x: positions[receiverIdx * 3 + 0],
    y: positions[receiverIdx * 3 + 1],
    z: positions[receiverIdx * 3 + 2],
  };
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
  const { source, hpf, lfShelf, modeFilters, panner, convolver, earlyConv, lateConv, liveDirect, splTrim, mixer, limiter, gain } = _activeChain;
  try { source.stop(); } catch (_) { /* already stopped */ }
  try {
    source.disconnect();
    if (hpf) hpf.disconnect();
    if (lfShelf) lfShelf.disconnect();
    if (modeFilters && modeFilters.all) {
      for (const f of modeFilters.all) f.disconnect();
    }
    if (panner) panner.disconnect();
    if (convolver) convolver.disconnect();
    if (earlyConv) earlyConv.disconnect();
    if (lateConv) lateConv.disconnect();
    if (liveDirect) liveDirect.disconnect();
    if (splTrim) splTrim.disconnect();
    if (mixer) mixer.disconnect();
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

// Phase W.1 — walk-mode entry / exit hook. When set, the audition
// graph treats the AVATAR as the listener: the sidebar listener-row
// click no longer restarts audition (otherwise the user would hear
// the IR jump every time they tweaked sidebar selection unrelated to
// where they're actually walking), and the SPL baseline is re-anchored
// to the avatar's current position on the next setAuditionListenerPose
// call. Pass false on walk-mode exit to restore normal behaviour.
export function setAuditionWalkMode(active) {
  if (!_activeChain) return;
  if (active) {
    _activeChain.walkMode = true;
    _activeChain.pendingWalkAnchor = true;       // re-anchor on next pose update
  } else {
    _activeChain.walkMode = false;
    _activeChain.pendingWalkAnchor = false;
  }
}

export function isAuditionInWalkMode() {
  return !!_activeChain?.walkMode;
}

// Walk-mode listener orientation → AudioListener forward vector. Lets
// the user "look around" inside the audition — turn left and the speaker
// pans right (it stays at the same world position, the listener's frame
// rotates around it). Mapping from state coords (x right, y depth-forward,
// z up) to Web Audio (x right, y up, z back-forward = -forward):
//   forwardWorldState = (sin(yaw)·cos(pitch), cos(yaw)·cos(pitch), sin(pitch))
//   forwardAudio      = (forwardX_state, forwardZ_state, -forwardY_state)
// Up vector is fixed +Y in audio coords (state +Z up). Throttled to 30 Hz
// inside the caller — that's well within Web Audio's a-rate param-event
// budget and below the perceptual ITD-update threshold (Wenzel et al.
// J.AES 1993 found ~50 Hz update is sufficient).
export function setAuditionListenerOrientation(yawRad, pitchRad) {
  if (!_audioCtx) return;        // no audition session yet — nothing to update
  const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
  const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
  // State-frame forward.
  const fxs = sy * cp;
  const fys = cy * cp;
  const fzs = sp;
  // Audio-frame forward = (state_x, state_z, -state_y).
  const listener = _audioCtx.listener;
  if (listener.forwardX) {
    listener.forwardX.value = fxs;
    listener.forwardY.value = fzs;
    listener.forwardZ.value = -fys;
    // Up stays +Y (state +Z up = audio +Y up).
    listener.upX.value = 0;
    listener.upY.value = 1;
    listener.upZ.value = 0;
  } else if (listener.setOrientation) {
    // Older Safari / Firefox before AudioParam-style listener.
    listener.setOrientation(fxs, fzs, -fys, 0, 1, 0);
  }
}

// Phase W.1 — full pose update for walk mode. Combines orientation
// (forward vector → AudioListener) AND position (drives the live
// direct-path chain so the speakers get louder as you walk closer,
// pan correctly as you turn, and re-time their delay so the live
// transient stays aligned with the convolver's reflections).
//
// Args:
//   yawRad, pitchRad — head orientation, same convention as
//                      setAuditionListenerOrientation.
//   posState         — { x, y, z } in STATE coords (avatar world position
//                      with z = ear height). Pass null/undefined to skip
//                      the position half (orientation-only update).
//
// Throttle at the call site (10–20 Hz is the perceptual budget per
// Wenzel J.AES 1993 + Hannes spec §4). Internally we use
// setTargetAtTime with τ ≈ 15 ms so the AudioParam ramp absorbs any
// jitter in the calling cadence.
export function setAuditionListenerPose(yawRad, pitchRad, posState) {
  setAuditionListenerOrientation(yawRad, pitchRad);
  if (!posState || !_activeChain || !_activeChain.liveDirect) return;
  _activeChain.liveDirect.setPose(posState);
  // First pose update after walk-mode entry → anchor the SPL baseline
  // to the avatar's actual starting position. Without this, the
  // baseline stays at whatever sidebar listener was used to start the
  // audition, which makes SPL deltas meaningless relative to where
  // the user is actually walking. (Re-anchored ONCE per walk-mode
  // entry; flag cleared after first pose update so subsequent
  // movement produces real deltas.)
  if (_activeChain.pendingWalkAnchor) {
    const newBaseline = computeAuditionSplDb(posState);
    if (Number.isFinite(newBaseline)) {
      _activeChain.baselineSplDb = newBaseline;
      _activeChain.pendingWalkAnchor = false;
      if (typeof window !== 'undefined' && window.__rl_audition_debug) {
        console.log(`[audition] walk-mode baseline anchored to avatar: ${newBaseline.toFixed(1)} dB`);
      }
    }
  }

  // SPL-trim — heatmap-matching loudness. Computed against the same
  // direct-field physics the heatmap uses, so audible level == colour
  // on the heatmap as the avatar walks. Reverb path is intentionally
  // not scaled (statistical-acoustics late field is approximately
  // position-independent; W.3 grid-interpolation will refine that).
  if (_activeChain.splTrim && Number.isFinite(_activeChain.baselineSplDb)) {
    const liveSplDb = computeAuditionSplDb(posState);
    if (Number.isFinite(liveSplDb)) {
      const dbDelta = liveSplDb - _activeChain.baselineSplDb;
      // Asymmetric clamp: −30 dB on the quiet side (room far from
      // sources can genuinely be 30 dB below the calibrated listener
      // and we want the user to hear "almost silent there"); +12 dB
      // on the loud side (worst-case DAC headroom: limiter@1.0 ×
      // splTrim@10^(12/20)=3.98 × master@0.25 = 0.995, safely below
      // clip). Listeners inside a source can theoretically demand
      // higher gains but the point-source physics is broken there
      // anyway, so capping is the right behaviour.
      const clamped = Math.max(-30, Math.min(12, dbDelta));
      const linearGain = Math.pow(10, clamped / 20);
      const ctx = _audioCtx;
      _activeChain.splTrim.gain.setTargetAtTime(linearGain, ctx.currentTime, 0.05);
      // Diagnostic — set window.__rl_audition_debug = true in DevTools
      // to watch live SPL / baseline / delta / gain as the avatar
      // walks. Throttled to 500 ms so the console doesn't flood.
      if (typeof window !== 'undefined' && window.__rl_audition_debug) {
        const nowMs = Date.now();
        if (!_lastDebugLogTs || nowMs - _lastDebugLogTs > 500) {
          _lastDebugLogTs = nowMs;
          console.log(
            `[audition] avatar(${posState.x.toFixed(2)},${posState.y.toFixed(2)},${posState.z.toFixed(2)}) ` +
            `live=${liveSplDb.toFixed(1)}dB baseline=${_activeChain.baselineSplDb.toFixed(1)}dB ` +
            `Δ=${dbDelta.toFixed(1)}dB(clamp ${clamped.toFixed(1)}) gain=${linearGain.toFixed(2)}x`
          );
        }
      }
    }
  }
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

// HEAD-probe the currently-selected sample so the audition button can
// disable itself if the file isn't shipped (tooltip explains). Returns
// { ok, url } so the panel can show a preset-aware tooltip.
export async function checkSampleAvailable() {
  const url = getSampleUrl();
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return { ok: res.ok, url };
  } catch (_) {
    return { ok: false, url };
  }
}
