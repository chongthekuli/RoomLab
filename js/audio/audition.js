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
// into a time-domain mono IR at the AudioContext's sample rate.
//
// Phase-2 implementation: dense band-shaped white noise per bucket
// (replaced the Phase-1 sparse Dirac-pulse-per-bucket which sounded
// like a spring reverb tank because the regular pulse train creates
// a frequency comb at 1/bucketDtMs Hz). Each histogram bucket of
// duration `bucketDtMs` is filled with random-sign white noise scaled
// so the bucket's total energy matches the histogram value. Result is
// continuous decaying noise — exactly what real-room reverb looks
// like in the time domain.
//
// Late tail truncation: any bucket whose energy is below -60 dB of
// the peak bucket is below the audibility threshold relative to the
// loudest reflection, so we drop it. Cuts IR length from 2 s to ~RT60
// in absorbed rooms (smaller IR, less convolver cost).
//
// histogram: Float32Array shape [receivers, bands, buckets]
// receiverIdx: which listener
// bands × buckets: per shape
// bucketDtMs: each bucket's duration (typically 2 ms)
// sampleRate: AudioContext.sampleRate (typically 48 kHz)
function buildIR(histogram, shape, bucketDtMs, receiverIdx, sampleRate) {
  const { bands: B, buckets: T } = shape;
  const bucketDtSec = bucketDtMs / 1000;
  const samplesPerBucket = Math.max(1, Math.round(bucketDtSec * sampleRate));

  // First pass — broadband energy per bucket + find peak.
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
  if (peakEnergy <= 0) return new Float32Array(samplesPerBucket);

  // Truncate at -60 dB below the peak bucket — anything quieter is
  // masked by foreground content in normal listening.
  const cutoff = peakEnergy * 1e-6;
  let lastUseful = T - 1;
  while (lastUseful > 0 && bucketEnergy[lastUseful] < cutoff) lastUseful--;
  const usefulBuckets = lastUseful + 1;
  const totalSamples = usefulBuckets * samplesPerBucket;
  const ir = new Float32Array(totalSamples);

  // Second pass — spread each bucket's energy as random-sign white noise
  // across its samples. Uniform [-1, 1] has variance 1/3, so the per-
  // sample amplitude scale is sqrt(3 × E_bucket / N) to make bucket
  // energy = N × variance × scale² = E_bucket. This preserves the
  // tracer's ENERGY DECAY ENVELOPE while replacing the pulse-train
  // spectral coloration with a flat (white-noise) spectrum.
  for (let b = 0; b < usefulBuckets; b++) {
    const energy = bucketEnergy[b];
    if (energy <= 0) continue;
    const amp = Math.sqrt(3 * energy / samplesPerBucket);
    const start = b * samplesPerBucket;
    for (let i = 0; i < samplesPerBucket; i++) {
      ir[start + i] = (Math.random() * 2 - 1) * amp;
    }
  }
  return ir;
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

  // Build the listener-specific IR from the precision histogram.
  // We DON'T peak-normalise the IR here — dense-noise IRs have most
  // samples non-zero with low individual amplitude, so peak normalisation
  // would over-amplify the body. Web Audio's `convolver.normalize = true`
  // applies equal-power normalisation to the IR, scaling the output so
  // overall loudness is comparable across rooms (a long-reverb cathedral
  // and a dry studio audition at the same gain setting). Per the W3C
  // Web Audio spec §1.34, this is the recommended path for "real" room
  // IRs — manual normalisation is for synthetic / test impulses.
  const ir = buildIR(
    precisionResult.histogram,
    precisionResult.shape,
    precisionResult.bucketDtMs,
    receiverIdx,
    ctx.sampleRate,
  );

  const irBuffer = ctx.createBuffer(1, ir.length, ctx.sampleRate);
  irBuffer.getChannelData(0).set(ir);

  const source = ctx.createBufferSource();
  source.buffer = sample;
  source.loop = true;

  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  convolver.buffer = irBuffer;

  const gain = ctx.createGain();
  gain.gain.value = DEFAULT_GAIN;

  source.connect(convolver);
  convolver.connect(gain);
  gain.connect(ctx.destination);

  source.start();

  _activeChain = { source, convolver, gain, mode: 'convolved' };
}

// Stop + tear down the active chain. Idempotent. Works for both the
// convolved (audition) chain and the dry (original) chain — they're
// mutually exclusive; only one is ever live.
export function stopAudition() {
  if (!_activeChain) return;
  const { source, convolver, gain } = _activeChain;
  try { source.stop(); } catch (_) { /* already stopped */ }
  try {
    source.disconnect();
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
