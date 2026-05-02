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

const DEFAULT_GAIN = 0.6;
const SAMPLE_URL = 'assets/audio/testing-1-2-3.mp3';

function getCtx() {
  if (_audioCtx) return _audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API unavailable in this browser');
  _audioCtx = new Ctx();
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
const VELVET_DENSITY_PULSES_PER_SEC = 1500;

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

// Build a 2-channel IR via filtered velvet noise (Phase 6). Direct,
// early, and late are now ONE code path — per band, place Nv random-
// position random-sign impulses per bucket, run the band's impulse
// stream through a biquad bandpass, sum across bands. L and R channels
// use independent random draws → decorrelated diffuse field for the
// out-of-head listening cue (Phase 4 win retained).
function buildStereoIR(histogram, shape, bucketDtMs, receiverIdx, sampleRate) {
  const { bands: B, buckets: T } = shape;
  const bucketDtSec = bucketDtMs / 1000;
  const samplesPerBucket = Math.max(1, Math.round(bucketDtSec * sampleRate));

  // Broadband energy per bucket → find peak → truncate at -60 dB. Peak
  // calc only used for IR truncation length, not for synthesis amplitude.
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
    return [new Float32Array(samplesPerBucket), new Float32Array(samplesPerBucket)];
  }
  const cutoff = peakEnergy * 1e-6;
  let lastUseful = T - 1;
  while (lastUseful > 0 && bucketEnergy[lastUseful] < cutoff) lastUseful--;
  const usefulBuckets = lastUseful + 1;
  const totalSamples = usefulBuckets * samplesPerBucket;
  const irL = new Float32Array(totalSamples);
  const irR = new Float32Array(totalSamples);

  // Velvet pulse count per bucket per band. At 48 kHz with 2 ms buckets,
  // Nv = 3 → 7×3 = 21 pulses/bucket aggregate = 10 500 pulses/s, well
  // above Karjalainen's 1500 smoothness threshold.
  const Nv = Math.max(1, Math.round(samplesPerBucket * VELVET_DENSITY_PULSES_PER_SEC / sampleRate));
  const nBands = Math.min(B, BAND_CENTERS_HZ.length);

  for (let bandIdx = 0; bandIdx < nBands; bandIdx++) {
    const cf = BAND_CENTERS_HZ[bandIdx];
    const bandIRL = new Float32Array(totalSamples);
    const bandIRR = new Float32Array(totalSamples);
    const bandOff = recOff + bandIdx * T;
    let bandHasEnergy = false;

    for (let b = 0; b < usefulBuckets; b++) {
      const E = histogram[bandOff + b];
      if (E <= 0) continue;
      bandHasEnergy = true;
      // Parseval-correct amplitude — Nv impulses each at magnitude
      // √(E/Nv) sum to bucket energy E (random sign cancels DC).
      const amp = Math.sqrt(E / Nv);
      const start = b * samplesPerBucket;
      for (let n = 0; n < Nv; n++) {
        // L channel — independent random position + sign.
        const posL = start + (Math.random() * samplesPerBucket) | 0;
        bandIRL[posL] += (Math.random() < 0.5 ? -1 : 1) * amp;
        // R channel — fully independent draw → diffuse-field decorrelation.
        const posR = start + (Math.random() * samplesPerBucket) | 0;
        bandIRR[posR] += (Math.random() < 0.5 ? -1 : 1) * amp;
      }
    }
    if (!bandHasEnergy) continue;

    // Bandpass-filter both channels, then sum into final IR.
    biquadBandpassInPlace(bandIRL, cf, BAND_Q, sampleRate);
    biquadBandpassInPlace(bandIRR, cf, BAND_Q, sampleRate);
    for (let i = 0; i < totalSamples; i++) {
      irL[i] += bandIRL[i];
      irR[i] += bandIRR[i];
    }
  }

  return [irL, irR];
}

// Normalise so peak amplitude = 0.5 — keeps the convolver output well
// under +/- 1.0 even after sample envelope. Without this loud rooms
// clip; quiet rooms are inaudible.
function normaliseIR(ir, targetPeak = 0.5) {
  let peak = 0;
  for (let i = 0; i < ir.length; i++) {
    const v = Math.abs(ir[i]);
    if (v > peak) peak = v;
  }
  if (peak <= 0) return ir;
  const scale = targetPeak / peak;
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

  // Build the per-channel IRs (L and R) — independent random sequences
  // for the late tail produce the decorrelated diffuse field that real
  // rooms have between ears. Direct + early reflections are identical
  // on both channels (broadband Dirac).
  const [irL, irR] = buildStereoIR(
    precisionResult.histogram,
    precisionResult.shape,
    precisionResult.bucketDtMs,
    receiverIdx,
    ctx.sampleRate,
  );

  // Peak-normalise each channel using the direct-sound Dirac as the
  // reference. We DON'T use convolver.normalize=true because Web Audio's
  // equal-power normalisation reverses room loudness (quiet rooms scale
  // up, loud rooms scale down), which is wrong for accurate auralization.
  normaliseIR(irL);
  normaliseIR(irR);

  const irBuffer = ctx.createBuffer(2, irL.length, ctx.sampleRate);
  irBuffer.getChannelData(0).set(irL);
  irBuffer.getChannelData(1).set(irR);

  const source = ctx.createBufferSource();
  source.buffer = sample;
  source.loop = true;

  // Phase 5 — HRTF spatialisation. PannerNode in 'HRTF' mode pre-shapes
  // the dry signal with binaural cues (interaural time + level diff +
  // pinna filtering) for the position of the dominant source relative
  // to the listener BEFORE the room convolution. The result is "in-
  // space" listening — speaker on the left actually feels left, sources
  // overhead feel overhead — instead of "in-the-head" mono playback.
  // Source centroid is L_w-weighted average of all sources; for typical
  // PA configurations this lands at the dominant cluster.
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 1;
  panner.maxDistance = 100;
  panner.rolloffFactor = 0.5;     // softer than physical 1/r — convolver already adds attenuation
  const rel = sourceCentroidRelative(precisionResult, receiverIdx);
  if (rel) {
    // State coords (x=right, y=depth-forward, z=up) → Web Audio coords
    // (x=right, y=up, z=-forward). Listener is at origin facing -Z by
    // default; we just place the panner at the source's relative offset.
    panner.positionX.value = rel.x;
    panner.positionY.value = rel.z;
    panner.positionZ.value = -rel.y;
  }

  const convolver = ctx.createConvolver();
  convolver.normalize = false;
  convolver.buffer = irBuffer;

  const gain = ctx.createGain();
  gain.gain.value = DEFAULT_GAIN;

  source.connect(panner);
  panner.connect(convolver);
  convolver.connect(gain);
  gain.connect(ctx.destination);

  source.start();

  _activeChain = { source, panner, convolver, gain, mode: 'convolved' };
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
  const { source, panner, convolver, gain } = _activeChain;
  try { source.stop(); } catch (_) { /* already stopped */ }
  try {
    source.disconnect();
    if (panner) panner.disconnect();
    if (convolver) convolver.disconnect();
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
