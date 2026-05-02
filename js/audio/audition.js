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
// HYBRID IR (Phase 2.1) — Dirac pulses for early arrivals, noise for
// late diffuse tail:
//
//   t < HYBRID_TRANSITION_MS:
//     Single Dirac per bucket at amplitude = sqrt(energy). Preserves
//     transient sharpness — direct sound stays clean, early reflections
//     remain discrete.
//
//   t ≥ HYBRID_TRANSITION_MS:
//     Random-sign uniform noise across bucket samples, scaled so per-
//     bucket energy still matches the histogram. The diffuse late field
//     is statistically dense in real rooms, so noise modelling is
//     correct here. Smooth tail, no spring-reverb metallic comb.
//
// HYBRID_TRANSITION_MS ≈ 80 ms is the classic perceptual "mixing time"
// after which discrete reflections fuse into a diffuse field. Earlier
// rooms (e.g., a 4×3×2.5 m booth) reach mixing in ~30 ms; halls in
// ~150 ms. 80 ms is the standard average.
//
// Late tail truncation: any bucket below -60 dB of the peak bucket is
// dropped (masked by foreground content, contributes only to perceived
// "room presence"). Without this an absorbed room still gets a 2 s IR.
const HYBRID_TRANSITION_MS = 80;

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

  // Truncate at -60 dB below the peak bucket.
  const cutoff = peakEnergy * 1e-6;
  let lastUseful = T - 1;
  while (lastUseful > 0 && bucketEnergy[lastUseful] < cutoff) lastUseful--;
  const usefulBuckets = lastUseful + 1;
  const totalSamples = usefulBuckets * samplesPerBucket;
  const ir = new Float32Array(totalSamples);

  // Hybrid threshold — bucket index where we switch from Dirac to noise.
  const hybridBucket = Math.ceil(HYBRID_TRANSITION_MS / bucketDtMs);

  for (let b = 0; b < usefulBuckets; b++) {
    const energy = bucketEnergy[b];
    if (energy <= 0) continue;
    const start = b * samplesPerBucket;

    if (b < hybridBucket) {
      // EARLY — single Dirac at the start of the bucket. Sign alternates
      // so the pulse train doesn't accumulate DC if the user has pushed
      // the gain up. Energy of one Dirac at amplitude A = A², so to
      // match bucket energy E we need A = sqrt(E).
      const sign = (b & 1) ? -1 : 1;
      ir[start] = sign * Math.sqrt(energy);
    } else {
      // LATE — random-sign white noise across N=samplesPerBucket samples.
      // Uniform [-1, 1] has variance 1/3, so per-sample amplitude scale
      // sqrt(3·E/N) makes bucket energy = N × (1/3) × (3E/N) = E.
      const amp = Math.sqrt(3 * energy / samplesPerBucket);
      for (let i = 0; i < samplesPerBucket; i++) {
        ir[start + i] = (Math.random() * 2 - 1) * amp;
      }
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
  const ir = buildIR(
    precisionResult.histogram,
    precisionResult.shape,
    precisionResult.bucketDtMs,
    receiverIdx,
    ctx.sampleRate,
  );

  // Peak-normalise the IR with the direct-sound Dirac as the reference.
  // The hybrid IR's peak is the loudest early Dirac (typically the direct
  // sound). Scaling that peak to 0.5 keeps the dry-direct level consistent
  // across rooms while letting the late tail be physically proportional
  // — a cathedral's late energy is naturally close to its direct level
  // (washy), an absorbed studio's late tail is much smaller (dry).
  // We DON'T use convolver.normalize=true because Web Audio's equal-power
  // normalisation REVERSES room loudness (loud rooms scaled down, quiet
  // rooms scaled up to match), which is wrong for accurate auralization.
  normaliseIR(ir);

  const irBuffer = ctx.createBuffer(1, ir.length, ctx.sampleRate);
  irBuffer.getChannelData(0).set(ir);

  const source = ctx.createBufferSource();
  source.buffer = sample;
  source.loop = true;

  const convolver = ctx.createConvolver();
  convolver.normalize = false;
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
