// Walk-mode direct-path module. Phase W.1 of the hybrid auralization
// engine (see spec from Hannes / Dr. Chen, 2026-05-03).
//
// Two responsibilities:
//
//   1. Pure-function analytical direct math, mirroring the closed form
//      used by the precision tracer's Phase 11.A injection. Used here
//      to SUBTRACT the baked-in direct contribution from a precision
//      histogram so the convolved IR carries reflections + reverb only.
//      The live (per-frame) direct sound is then synthesised by the
//      audio graph below — the two halves recombine at the mixer.
//
//   2. LiveDirectPathChain — a Web Audio sub-graph that produces the
//      direct sound for the current listener pose. Per-source delay,
//      distance gain (true 1/r pressure law, NOT Web Audio's softer
//      'inverse' rolloff), high-shelf air absorption, and HRTF
//      spatialisation. setPose(listenerPos, yaw, pitch) re-targets all
//      AudioParams via setTargetAtTime(τ ≈ 15 ms) so a walking listener
//      doesn't hear zipper noise on either gain or delay.
//
// Why split direct from convolved? Because the precision IR is baked
// for ONE listener position. As the avatar walks, the reflected /
// reverberant tail is still approximately right (statistical / late-
// field assumption), but the DIRECT sound is dramatically wrong —
// 6 dB per doubling of distance, and a different HRTF angle. Letting
// the convolver handle reflections while a live chain handles the
// direct path gives the listener the correct walk-mode direct cue
// without paying the cost of recomputing the IR per step.
//
// W.1 simplification: a SINGLE L_w-weighted source centroid drives one
// HRTF panner. In W.2 (per-source early reflections via image-source
// method) we'll fan out to per-source panners with independent
// directivity. For now, the centroid model is what the current static
// audition graph already uses — we extend it, we don't re-architect.

const SPEED_OF_SOUND_M_PER_S = 343.2;

// ISO 9613-1 air-absorption coefficient at 1 kHz, 20 °C, 50 % RH —
// matches the value the precision tracer uses for its direct-path
// injection. Single-band scalar; the per-band table from materials.json
// is not reused here because the live direct path only carries a single
// high-shelf approximation (full per-band EQ would need a 7-stage
// biquad chain per source — defer to W.5 polish if needed).
const AIR_ABS_DB_PER_M_1KHZ = 0.013;
// High-shelf cutoff and excess HF absorption used by the live air-EQ.
// Distance > 8 m at 8 kHz attenuates ~3 dB more than at 1 kHz; we model
// that as a high-shelf at 4 kHz with shelf gain = -k·d. k tuned so a
// 10 m walk-back produces the audible "muffled" effect characteristic
// of large rooms (Beranek 2nd ed. eq. 7-2 family).
const AIR_HF_SHELF_HZ = 4000;
const AIR_HF_EXCESS_DB_PER_M = 0.05;

// Compute the analytical-direct ENERGY a source contributes to a
// receiver, identical closed form to tracer-core.js Phase 11.A.
// Returns a Float64Array of length B (one per band) — the energy that
// would land in the receiver's first-arrival bucket, BEFORE per-worker
// scaling.
//
// Used to subtract the direct from a baked precision histogram. The
// math here MUST stay in lockstep with tracer-core.js — if the tracer
// changes its directivity / capture-cross-section formula, this changes
// too. Tested via tests/direct-path-isl.test.mjs.
export function computeAnalyticalDirectEnergy({
  sourcePos, sourceAim, sourceLobeN, sourceLwPerBand,
  receiverPos, receiverRadius_m,
  bands_count, airAbsorption = true, airAbsCoefPerBand = null,
}) {
  const dxs = receiverPos.x - sourcePos.x;
  const dys = receiverPos.y - sourcePos.y;
  const dzs = receiverPos.z - sourcePos.z;
  const d = Math.sqrt(dxs * dxs + dys * dys + dzs * dzs);
  const out = new Float64Array(bands_count);
  if (d < 1e-3) return out;

  const dxn = dxs / d, dyn = dys / d, dzn = dzs / d;
  const aimX = sourceAim?.x ?? 0;
  const aimY = sourceAim?.y ?? 1;
  const aimZ = sourceAim?.z ?? 0;
  const lobeN = sourceLobeN ?? 0;
  const cosTheta = Math.max(-1, Math.min(1, aimX * dxn + aimY * dyn + aimZ * dzn));
  const half1pCos = 0.5 + 0.5 * cosTheta;
  const Dlobe = (lobeN + 1) * Math.pow(half1pCos, lobeN);
  const captureFrac = (receiverRadius_m * receiverRadius_m) / (4 * d * d);

  for (let k = 0; k < bands_count; k++) {
    const sourcePower = Math.pow(10, sourceLwPerBand[k] / 10);
    let E = sourcePower * Dlobe * captureFrac;
    if (airAbsorption && airAbsCoefPerBand) {
      E *= Math.exp(-airAbsCoefPerBand[k] * d);
    }
    out[k] = E;
  }
  return out;
}

// Subtract the analytical-direct contribution from a precision-tracer
// histogram. Returns a NEW histogram (Float32Array) — does not mutate
// the input. After this, the convolved IR built from the result holds
// reflections + reverb only; the live direct path supplies the
// transient.
//
// `precisionResult` matches the shape stored on
// state.results.precision: { histogram, shape: {receivers, bands,
// buckets}, bucketDtMs, scene: {sources, receivers, ...} }.
//
// receiverIdx selects which receiver's slice of the histogram we touch
// (we only zero out the buckets for THAT receiver — other receivers
// are untouched so a second audition for a different listener still
// works).
export function subtractAnalyticalDirect({
  histogram, shape, bucketDtMs, scene, receiverIdx,
  airAbsorption = true, airAbsCoefPerBand = null,
  c_mps = SPEED_OF_SOUND_M_PER_S,
}) {
  const out = new Float32Array(histogram.length);
  out.set(histogram);
  if (!scene?.sources || !scene?.receivers) return out;
  const S = scene.sources.count ?? 0;
  if (S === 0) return out;
  const B = shape.bands;
  const T = shape.buckets;
  const recR = scene.receivers.radii ?? scene.receivers.radius;
  const radius_m = Array.isArray(recR) ? recR[receiverIdx] : (typeof recR === 'number' ? recR : 0.1);
  const recPos = {
    x: scene.receivers.positions[receiverIdx * 3 + 0],
    y: scene.receivers.positions[receiverIdx * 3 + 1],
    z: scene.receivers.positions[receiverIdx * 3 + 2],
  };
  for (let sIdx = 0; sIdx < S; sIdx++) {
    const sourcePos = {
      x: scene.sources.positions[sIdx * 3 + 0],
      y: scene.sources.positions[sIdx * 3 + 1],
      z: scene.sources.positions[sIdx * 3 + 2],
    };
    const sourceAim = scene.sources.aims ? {
      x: scene.sources.aims[sIdx * 3 + 0],
      y: scene.sources.aims[sIdx * 3 + 1],
      z: scene.sources.aims[sIdx * 3 + 2],
    } : { x: 0, y: 1, z: 0 };
    const lobeN = scene.sources.dirN ? scene.sources.dirN[sIdx] : 0;
    const lwPerBand = new Float64Array(B);
    for (let k = 0; k < B; k++) lwPerBand[k] = scene.sources.L_w[sIdx * B + k];
    const Eperband = computeAnalyticalDirectEnergy({
      sourcePos, sourceAim, sourceLobeN: lobeN, sourceLwPerBand: lwPerBand,
      receiverPos: recPos, receiverRadius_m: radius_m,
      bands_count: B, airAbsorption, airAbsCoefPerBand,
    });
    const dxs = recPos.x - sourcePos.x;
    const dys = recPos.y - sourcePos.y;
    const dzs = recPos.z - sourcePos.z;
    const d = Math.sqrt(dxs * dxs + dys * dys + dzs * dzs);
    if (d < 1e-3) continue;
    const arrival_s = d / c_mps;
    const bucket = Math.floor((arrival_s * 1000) / bucketDtMs);
    if (bucket < 0 || bucket >= T) continue;
    const base = receiverIdx * B * T + bucket;
    for (let k = 0; k < B; k++) {
      // Subtract; clamp at zero so a tracer that didn't actually inject
      // (e.g. legacy histogram, pre-W.A) doesn't go negative.
      const after = out[base + k * T] - Eperband[k];
      out[base + k * T] = after > 0 ? after : 0;
    }
  }
  return out;
}

// Compute direct-sound SPL in dB for a single source-receiver pair at
// the given distance. Pure 1/r² point-source law plus directivity and
// air absorption — mirrors what the live audio chain produces, used by
// tests and by the metrics-readout in walk mode.
//
// Lp = 10·log10(sourcePower) - 20·log10(d) + 11 - DI - airAbs·d
// where DI is encoded in the lobe shape (omnidirectional reference
// integrates back to 4π).
export function computeDirectPathSPL({
  sourcePos, sourceAim, sourceLobeN, sourceLwBroadband_db,
  receiverPos,
  airAbsorption = true, airAbsDbPerMeter = AIR_ABS_DB_PER_M_1KHZ,
}) {
  const dxs = receiverPos.x - sourcePos.x;
  const dys = receiverPos.y - sourcePos.y;
  const dzs = receiverPos.z - sourcePos.z;
  const d = Math.sqrt(dxs * dxs + dys * dys + dzs * dzs);
  if (d < 1e-3) return Infinity;
  const aimX = sourceAim?.x ?? 0, aimY = sourceAim?.y ?? 1, aimZ = sourceAim?.z ?? 0;
  const lobeN = sourceLobeN ?? 0;
  const dxn = dxs / d, dyn = dys / d, dzn = dzs / d;
  const cosTheta = Math.max(-1, Math.min(1, aimX * dxn + aimY * dyn + aimZ * dzn));
  const half1pCos = 0.5 + 0.5 * cosTheta;
  const Dlobe = (lobeN + 1) * Math.pow(half1pCos, lobeN);
  const Dlobe_db = 10 * Math.log10(Math.max(1e-12, Dlobe));
  const inverseSquare_db = -20 * Math.log10(d);
  const air_db = airAbsorption ? -airAbsDbPerMeter * d : 0;
  // L_w already includes the 11 dB power-to-pressure term plus DI; we
  // ADD the band-relative directivity (lobe shape, normalised to omni
  // reference of 0 dB on-axis) on top. -20·log10(d) is the inverse-
  // square law in dB.
  return sourceLwBroadband_db + inverseSquare_db + Dlobe_db + air_db;
}

// Compute the L_w-weighted source centroid in WORLD coords from a
// precision-result scene snapshot. Same closed form as audition.js's
// sourceWorldCentroid; lifted here so the live-chain builder doesn't
// need to import from audition.
export function sourceCentroid(scene) {
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

// Sum L_w in dB across all sources, broadband — used to set the live
// chain's nominal source-power. Same incoherent power-sum as
// computeMultiSourceSPL uses.
export function broadbandSourceLwDb(scene) {
  const sources = scene?.sources;
  if (!sources || sources.count === 0) return 0;
  const B = scene.bands_hz?.length ?? 7;
  let totalLin = 0;
  for (let i = 0; i < sources.count; i++) {
    for (let k = 0; k < B; k++) {
      totalLin += Math.pow(10, sources.L_w[i * B + k] / 10);
    }
  }
  if (totalLin <= 0) return 0;
  // Average across bands → broadband single-figure L_w.
  return 10 * Math.log10(totalLin / B);
}

// Broadband direct-field SPL at any listener position, summed
// incoherently across all sources in a precision scene. Same physics
// as the 2D / 3D heatmap's direct-only branch: per-source 1/r²
// inverse-square + raised-cosine directivity + ISO 9613-1 air
// absorption, energy-summed. Used by the audition graph's master SPL-
// trim so audition loudness tracks exactly what the heatmap shows as
// you walk.
//
//   pos                — { x, y, z } in state coords
//   options.airAbsorption          — match the heatmap toggle
//   options.airAbsCoefPerBand      — 7-band air-absorption table
//                                    (Float32Array). Falls back to a
//                                    flat 1 kHz value if absent.
//
// Returns total SPL in dB. Returns -Infinity if no sources / degenerate.
export function computeBroadbandDirectSPL({
  scene, pos,
  airAbsorption = true,
  airAbsCoefPerBand = null,
}) {
  if (!scene?.sources || scene.sources.count === 0) return -Infinity;
  if (!pos) return -Infinity;
  const B = scene.bands_hz?.length ?? 7;
  let totalEnergy = 0;
  for (let s = 0; s < scene.sources.count; s++) {
    const sx = scene.sources.positions[s * 3 + 0];
    const sy = scene.sources.positions[s * 3 + 1];
    const sz = scene.sources.positions[s * 3 + 2];
    const dxs = pos.x - sx, dys = pos.y - sy, dzs = pos.z - sz;
    const d = Math.sqrt(dxs * dxs + dys * dys + dzs * dzs);
    if (d < 1e-3) return Infinity;       // listener inside source
    const aimX = scene.sources.aims ? scene.sources.aims[s * 3 + 0] : 0;
    const aimY = scene.sources.aims ? scene.sources.aims[s * 3 + 1] : 1;
    const aimZ = scene.sources.aims ? scene.sources.aims[s * 3 + 2] : 0;
    const lobeN = scene.sources.dirN ? scene.sources.dirN[s] : 0;
    const dxn = dxs / d, dyn = dys / d, dzn = dzs / d;
    const cosTheta = Math.max(-1, Math.min(1, aimX * dxn + aimY * dyn + aimZ * dzn));
    const half1pCos = 0.5 + 0.5 * cosTheta;
    const Dlobe = (lobeN + 1) * Math.pow(half1pCos, lobeN);
    // Per-band incoherent power sum: Lp(band) = L_w + 10·log10(D) - 20·log10(d) + 11 - air·d
    // In linear energy: E_band = sourcePower · D · 1/(4πd²) · 10^(11/10) · 10^(-air·d/10)
    // The "11 dB power-to-pressure" + 4π ref factors cancel in the
    // delta-only use case; we keep them here so the absolute SPL is
    // correct and the audition's nominal level lines up with the
    // heatmap reading.
    const oneOver4PIr2 = 1 / (4 * Math.PI * d * d);
    const eleven = Math.pow(10, 11 / 10);
    for (let k = 0; k < B; k++) {
      const sourcePower = Math.pow(10, scene.sources.L_w[s * B + k] / 10);
      let E = sourcePower * Dlobe * oneOver4PIr2 * eleven;
      if (airAbsorption) {
        const air = airAbsCoefPerBand ? airAbsCoefPerBand[k] : 0.013 * Math.LN10 / 10;
        E *= Math.exp(-air * d);
      }
      totalEnergy += E;
    }
  }
  if (totalEnergy <= 0) return -Infinity;
  return 10 * Math.log10(totalEnergy);
}

// Build a Web Audio sub-graph that produces a single live-direct-path
// signal using the L_w-weighted source-centroid model (W.1 simplification
// — per-source panners are W.2). The chain looks like:
//
//   input → DelayNode → AirShelfBiquad → DistanceGain → HRTFPanner → output
//
// All four AudioParams update in setPose(). The chain's `input` and
// `output` are `AudioNode` references the audition.js wiring code
// connects to.
//
// Construction args:
//   audioCtx — the live AudioContext
//   scene    — precisionResult.scene (carries sources, receivers, bands)
//   options.refDb — perceived loudness reference. Defaults to a
//                   broadband-summed L_w-derived value so the W.1
//                   live direct sits roughly where the precision IR's
//                   direct sat at the baseline listener position. We
//                   derive this once at construction; setPose() then
//                   trims relative to it.
//
// State:
//   _baselineDist  — distance at construction time (from the original
//                    receiverIdx position to source centroid). The
//                    distance-gain delta is computed as 20·log10(
//                    baselineDist / liveDist) so at the baseline pose
//                    the live direct equals the IR's baked direct (no
//                    discontinuity when audition starts).
//   _baselineLw    — broadband source L_w used to derive the gain
//                    constant.
//
// Simplified vs. spec:
//   • Single panner. Per-source panners come in W.2.
//   • Single high-shelf for air abs. Per-band BiquadFilter chain in W.5.
//   • No Doppler. setPose() honours velocity ONLY for AudioParam ramp
//     time (faster walk → shorter ramp → tighter tracking). Doppler
//     pitch shift is intentionally omitted; would need a SoundTouch /
//     phase-vocoder stage. Spec doesn't ask for it.
export class LiveDirectPathChain {
  constructor(audioCtx, scene, receiverIdx, options = {}) {
    this._ctx = audioCtx;
    this._scene = scene;
    // Source centroid in world coords — anchor for panner.position
    // updates when listener moves.
    this._centroid = sourceCentroid(scene);
    // Broadband source L_w (dB) for the gain calibration.
    this._broadbandLwDb = broadbandSourceLwDb(scene);
    // Baseline listener position = the receiverIdx the audition was
    // started with. setPose(pos) computes 1/r relative to THIS, so the
    // live direct equals the baked direct at baseline (no audible
    // jump when audition starts and the listener hasn't moved yet).
    const recPositions = scene?.receivers?.positions;
    if (recPositions) {
      this._baselinePos = {
        x: recPositions[receiverIdx * 3 + 0],
        y: recPositions[receiverIdx * 3 + 1],
        z: recPositions[receiverIdx * 3 + 2],
      };
    } else {
      this._baselinePos = { x: 0, y: 0, z: 0 };
    }
    const dxs = this._centroid.x - this._baselinePos.x;
    const dys = this._centroid.y - this._baselinePos.y;
    const dzs = this._centroid.z - this._baselinePos.z;
    this._baselineDist = Math.max(0.5, Math.sqrt(dxs * dxs + dys * dys + dzs * dzs));

    // --- Build nodes -----------------------------------------------------
    // Delay matches the geometric travel time at baseline so the live
    // chain's transient lines up with the convolver's reflections-only
    // first arrival (which, post-subtractAnalyticalDirect, no longer
    // contains the direct sound — the live chain provides it).
    this._delay = audioCtx.createDelay(0.5);                  // 500 ms cap
    this._delay.delayTime.value = this._baselineDist / SPEED_OF_SOUND_M_PER_S;

    // Air absorption: a single high-shelf at 4 kHz. The shelf gain is
    // proportional to distance — closer = no attenuation, further =
    // more high-frequency loss. Beranek 2nd ed. §7.2 (air absorption is
    // strongly frequency-dependent above 2 kHz; below ~1 kHz it's
    // negligible at the distances RoomLAB rooms cover).
    this._airShelf = audioCtx.createBiquadFilter();
    this._airShelf.type = 'highshelf';
    this._airShelf.frequency.value = AIR_HF_SHELF_HZ;
    this._airShelf.gain.value = -AIR_HF_EXCESS_DB_PER_M * this._baselineDist;

    // Distance gain — pinned at 1.0. The W.1 SPL-trim (computed by
    // audition.js as a master GainNode using computeBroadbandDirectSPL)
    // is what actually scales loudness as the listener walks, because
    // it sums each source's direct contribution properly (multi-source
    // aware) instead of relying on a single L_w-weighted-centroid
    // distance. _distGain stays here as an identity passthrough so the
    // chain ordering doesn't have to change later if we want a per-
    // source gain hook.
    this._distGain = audioCtx.createGain();
    this._distGain.gain.value = 1.0;

    // HRTF panner — listener at audio-frame origin, panner placed at
    // (centroid - liveListener) in audio coords. distanceModel set to
    // 'linear' with rolloffFactor = 0 disables Web Audio's built-in
    // attenuation curve so OUR distGain is the single authority on
    // distance loudness — otherwise the two compound and inverse-square
    // sanity tests fail.
    this._panner = audioCtx.createPanner();
    this._panner.panningModel = 'HRTF';
    this._panner.distanceModel = 'linear';
    this._panner.rolloffFactor = 0;          // we own distance gain
    this._panner.refDistance = 1;
    this._panner.maxDistance = 1000;
    const rel0 = {
      x: this._centroid.x - this._baselinePos.x,
      y: this._centroid.y - this._baselinePos.y,
      z: this._centroid.z - this._baselinePos.z,
    };
    // State (x right, y depth-forward, z up) → audio (x right, y up, z back).
    this._panner.positionX.value = rel0.x;
    this._panner.positionY.value = rel0.z;
    this._panner.positionZ.value = -rel0.y;

    // Wire input→delay→shelf→gain→panner→output. Caller connects to
    // .input and from .output.
    this._delay.connect(this._airShelf);
    this._airShelf.connect(this._distGain);
    this._distGain.connect(this._panner);
  }

  get input() { return this._delay; }
  get output() { return this._panner; }

  // Update the live direct path for a new listener pose. Call from the
  // walk-mode tick; throttle to 10–20 Hz at the call site (Web Audio
  // AudioParam writes are cheap but pose-update RAF-rate would burn
  // CPU pointlessly — perceptual update budget is 50–100 ms per
  // Wenzel J.AES 1993).
  //
  // Args:
  //   pos       — { x, y, z } in state coords (live avatar position).
  //   options.tau_s — exponential-ramp time constant; default 0.015 s
  //                   (the 15 ms zipper-noise threshold; safely below
  //                   any audible AudioParam-modulation artefact, see
  //                   Olive J.AES 2008 §3).
  //
  // Orientation updates go through the existing AudioListener.forward
  // setter in audition.js — the panner reads listener.forward
  // implicitly. setPose() does NOT touch orientation so the two
  // entry points compose cleanly.
  setPose(pos, { tau_s = 0.015 } = {}) {
    if (!pos) return;
    const ctx = this._ctx;
    const now = ctx.currentTime;

    const rx = this._centroid.x - pos.x;
    const ry = this._centroid.y - pos.y;
    const rz = this._centroid.z - pos.z;
    const d = Math.max(0.5, Math.sqrt(rx * rx + ry * ry + rz * rz));

    // _distGain stays at 1.0; the master SPL-trim in audition.js
    // owns the loudness change. (See constructor comment.)

    // Path delay — geometric travel time. setTargetAtTime ramps the
    // delay smoothly so a 1 m/s walk doesn't pitch-shift the audio.
    // (Doppler is intentionally not modelled; matched ramp τ keeps the
    // delay change inaudible.)
    const delay_s = d / SPEED_OF_SOUND_M_PER_S;
    this._delay.delayTime.setTargetAtTime(delay_s, now, tau_s);

    // Air absorption shelf — gain in dB scales linearly with distance.
    // A 200 ms time constant matches Dr. Chen's spec for slow modal
    // updates; the air-EQ is a similarly slow perceptual cue.
    const shelfDb = -AIR_HF_EXCESS_DB_PER_M * d;
    this._airShelf.gain.setTargetAtTime(shelfDb, now, 0.2);

    // Panner — relative position (state → audio frame). Orientation
    // not touched here.
    this._panner.positionX.setTargetAtTime(rx, now, tau_s);
    this._panner.positionY.setTargetAtTime(rz, now, tau_s);
    this._panner.positionZ.setTargetAtTime(-ry, now, tau_s);
  }

  disconnect() {
    try { this._delay.disconnect(); } catch (_) { /* */ }
    try { this._airShelf.disconnect(); } catch (_) { /* */ }
    try { this._distGain.disconnect(); } catch (_) { /* */ }
    try { this._panner.disconnect(); } catch (_) { /* */ }
  }
}
