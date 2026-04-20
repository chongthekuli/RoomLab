// Stochastic specular ray tracer — Phase B.3 kernel.
//
// Pure function, main-thread-runnable AND worker-runnable (workers import
// this file verbatim). Node-testable without any DOM/Worker mocks.
//
// Algorithm (this commit — MVP; ISM + Lambertian scattering come in
// Phase D):
//
//   for each source:
//     for each of raysPerSource rays:
//       emit uniformly over the unit sphere (no directivity yet)
//       initial energy per band = 10^(L_w[band]/10) / raysPerSource
//       for each bounce (up to maxBounces):
//         hit = BVH intersect
//         if no hit → ray escapes (terminate)
//         for each receiver:
//           if ray segment [origin, hit] crosses receiver sphere:
//             log arrival time + per-band energy into histogram
//         reflect specularly off hit normal
//         attenuate energy by (1 − α_surface) per band
//         if max(energy) < cutoff → terminate (default −60 dB)
//
// Output: Float32Array[receivers × bands × timeBuckets] of energy vs
// arrival-time. This is THE impulse response. Phase C derives EDT / C80 /
// C50 / T30 / D/R / STI-from-IR from it.
//
// Normalization: each ray carries (total source power) / raysPerSource
// per band. Absolute dB values are physically interpretable, but every
// time-domain metric we care about is a RATIO of histogram windows, so
// the exact normalization drops out. This matters for worker aggregation:
// partial histograms from different workers are summed directly without
// scale correction.

import { intersectRay } from './bvh.js';
import { airAbsorptionCoefficient_m } from '../air-absorption.js';

const SPEED_OF_SOUND_M_PER_S = 343.2;      // 20 °C dry air
const DEFAULT_RAYS_PER_SOURCE = 10_000;
const DEFAULT_MAX_BOUNCES = 50;
const DEFAULT_BUCKET_DT_MS = 2;
const DEFAULT_MAX_TIME_MS = 2_000;
const DEFAULT_ENERGY_CUTOFF_DB = -60;
const DEFAULT_UNKNOWN_MATERIAL_ABSORPTION = 0.10;   // keeps rays from bouncing forever on un-tagged surfaces
const EPS = 1e-6;

// mulberry32 — fast deterministic 32-bit PRNG. Using Math.random() would
// break reproducibility across workers (each worker has its own random
// state). Seed deliberately so the result is deterministic for a given
// (scene, options) pair.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform sample on the unit sphere. z uniform in [-1,1] + phi uniform
// in [0,2π] gives correct surface-area-weighted distribution (classic
// Archimedes result).
function sampleUnitSphere(rng, out) {
  const z = 2 * rng() - 1;
  const phi = 2 * Math.PI * rng();
  const rxy = Math.sqrt(Math.max(0, 1 - z * z));
  out[0] = rxy * Math.cos(phi);
  out[1] = rxy * Math.sin(phi);
  out[2] = z;
}

// Ray-sphere intersection on the segment [0, tMax]. Ray is assumed unit-
// direction. Returns the entry-parameter t (in world-distance units, same
// as tMax), clamped to ≥ EPS so a ray starting inside the sphere still
// logs at t≈0. Returns -1 if no intersection in segment.
function raySphereEntry(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, tMax) {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t1 = -b - sq;
  const t2 = -b + sq;
  // If the entry point is in front of us and within the segment, count it.
  if (t1 >= EPS && t1 < tMax) return t1;
  // If the ray starts inside the sphere (t1 < 0 < t2), log at EPS.
  if (t1 < 0 && t2 > 0) return EPS;
  return -1;
}

/**
 * traceRays — main kernel.
 *
 * Signature kept minimal because this is what goes over the worker wire.
 * Soup is reached via `bvh.soup` when the tracer needs vertex/normal
 * arrays (it currently only uses the hit info returned by intersectRay,
 * which reads from bvh.soup internally).
 *
 * @param {PhysicsScene} scene   snapshot from scene-snapshot.js
 * @param {BVH} bvh              from bvh.js (contains soup internally)
 * @param {object} opts
 * @param {number} [opts.raysPerSource=10000]       rays this call will emit per source
 * @param {number} [opts.normalizationRays]         denominator for per-ray energy
 *                                                  normalization. Defaults to
 *                                                  `raysPerSource`. When a pool splits
 *                                                  a N-worker render, EACH worker sets
 *                                                  raysPerSource to its own slice (say
 *                                                  2500 of 10000) but normalizationRays
 *                                                  to the TOTAL budget (10000) so
 *                                                  merging partials gives the correct
 *                                                  total energy rather than N× over-
 *                                                  count.
 * @param {number} [opts.maxBounces=50]
 * @param {number} [opts.bucketDtMs=2]
 * @param {number} [opts.maxTimeMs=2000]
 * @param {number} [opts.energyCutoffDb=-60]
 * @param {number} [opts.seed=1]                deterministic RNG seed
 * @param {number} [opts.c_mps=343.2]           speed of sound
 * @param {boolean} [opts.airAbsorption=true]   apply ISO 9613-1 volumetric air
 *                                              absorption to each ray segment.
 *                                              Matches the draft engine's
 *                                              behaviour — essential above
 *                                              2 kHz in large venues.
 * @param {Function} [opts.progress]            (raysDone, raysTotal) => void (optional)
 *
 * @returns {{
 *   histogram: Float32Array,            // shape: R × B × T (row-major)
 *   shape: { receivers, bands, buckets },
 *   bucketDtMs, maxTimeMs,
 *   hitCount: number,                    // total (ray, receiver) hit events logged
 *   raysTraced: number,
 *   terminations: { escaped, energy, bounce, timeOut },
 * }}
 */
export function traceRays(scene, bvh, opts = {}) {
  const raysPerSource = opts.raysPerSource ?? DEFAULT_RAYS_PER_SOURCE;
  const normalizationRays = opts.normalizationRays ?? raysPerSource;
  const maxBounces = opts.maxBounces ?? DEFAULT_MAX_BOUNCES;
  const bucketDtMs = opts.bucketDtMs ?? DEFAULT_BUCKET_DT_MS;
  const maxTimeMs = opts.maxTimeMs ?? DEFAULT_MAX_TIME_MS;
  const energyCutoffDb = opts.energyCutoffDb ?? DEFAULT_ENERGY_CUTOFF_DB;
  const c_mps = opts.c_mps ?? SPEED_OF_SOUND_M_PER_S;
  const seed = opts.seed ?? 1;
  const airAbsorption = opts.airAbsorption !== false;
  const progress = opts.progress ?? null;

  const bands = scene.bands_hz;
  const B = bands.length;

  // Pre-compute per-band energy-attenuation coefficient m_e (Nepers/m).
  // When airAbsorption is true, per-segment energy loss along a ray
  // travelling distance d is factor = exp(-m_e × d). At 8 kHz / 1 s of
  // reverb path (343 m) this is exp(-0.023 × 343) ≈ 5·10⁻⁴ = -33 dB —
  // the single biggest factor shortening HF RT60 in large venues.
  // Draft engine includes this as the 4mV Sabine term; before this fix
  // the precision engine's 8 kHz T30 read ~60 % longer than draft.
  const airCoef = new Float32Array(B);
  if (airAbsorption) {
    for (let k = 0; k < B; k++) airCoef[k] = airAbsorptionCoefficient_m(bands[k]);
  }
  const R = scene.receivers.count;
  const S = scene.sources.count;
  const T = Math.max(1, Math.ceil(maxTimeMs / bucketDtMs));

  const histogram = new Float32Array(R * B * T);
  let hitCount = 0;
  let raysTraced = 0;
  const terminations = { escaped: 0, energy: 0, bounce: 0, timeOut: 0 };

  if (S === 0 || R === 0 || bvh.nodeCount === 0) {
    return { histogram, shape: { receivers: R, bands: B, buckets: T },
             bucketDtMs, maxTimeMs, hitCount, raysTraced, terminations };
  }

  const srcPos = scene.sources.positions;
  const srcLw = scene.sources.L_w;
  const recPos = scene.receivers.positions;
  const recR = scene.receivers.radii;

  // Scratch buffers reused across all rays — avoid per-ray allocations.
  const dir = new Float32Array(3);
  const energy = new Float32Array(B);
  const initialEnergy = new Float32Array(B);

  const rng = mulberry32(seed);
  const maxTime_s = maxTimeMs / 1000;

  for (let sIdx = 0; sIdx < S; sIdx++) {
    // Initial per-band energy for one ray from this source. Divided by
    // `normalizationRays` (total across pool) rather than `raysPerSource`
    // (this worker's slice), so N partials summed give the correct total.
    let maxInitialE = 0;
    for (let k = 0; k < B; k++) {
      initialEnergy[k] = Math.pow(10, srcLw[sIdx * B + k] / 10) / normalizationRays;
      if (initialEnergy[k] > maxInitialE) maxInitialE = initialEnergy[k];
    }
    const cutoffE = maxInitialE * Math.pow(10, energyCutoffDb / 10);
    const ox0 = srcPos[sIdx * 3 + 0];
    const oy0 = srcPos[sIdx * 3 + 1];
    const oz0 = srcPos[sIdx * 3 + 2];

    for (let ri = 0; ri < raysPerSource; ri++) {
      // Fresh direction + energy for each ray.
      sampleUnitSphere(rng, dir);
      let dx = dir[0], dy = dir[1], dz = dir[2];
      let ox = ox0, oy = oy0, oz = oz0;
      for (let k = 0; k < B; k++) energy[k] = initialEnergy[k];
      let totalPath = 0;            // world metres from source
      let terminated = false;

      for (let bounce = 0; bounce < maxBounces; bounce++) {
        const hit = intersectRay(bvh, ox, oy, oz, dx, dy, dz);
        if (!hit) { terminations.escaped++; terminated = true; break; }

        // Clip the segment by the remaining time budget before counting
        // receiver crossings — a ray that would only hit the receiver
        // after t_max shouldn't be logged.
        const segmentEnd_m = Math.min(hit.t, (maxTime_s * c_mps) - totalPath);
        if (segmentEnd_m <= 0) { terminations.timeOut++; terminated = true; break; }

        // Log receiver crossings on this segment. When air absorption is
        // enabled the logged energy must be attenuated by the PARTIAL
        // path length from segment-start to the sphere-entry point tRec —
        // the ray hasn't yet travelled the full segment when it crosses
        // the receiver.
        for (let recIdx = 0; recIdx < R; recIdx++) {
          const tRec = raySphereEntry(
            ox, oy, oz, dx, dy, dz,
            recPos[recIdx * 3], recPos[recIdx * 3 + 1], recPos[recIdx * 3 + 2],
            recR[recIdx], segmentEnd_m,
          );
          if (tRec < 0) continue;
          const arrival_s = (totalPath + tRec) / c_mps;
          const bucket = Math.floor((arrival_s * 1000) / bucketDtMs);
          if (bucket < 0 || bucket >= T) continue;
          const base = recIdx * B * T + bucket;
          if (airAbsorption) {
            for (let k = 0; k < B; k++) {
              histogram[base + k * T] += energy[k] * Math.exp(-airCoef[k] * tRec);
            }
          } else {
            for (let k = 0; k < B; k++) histogram[base + k * T] += energy[k];
          }
          hitCount++;
        }

        if (segmentEnd_m < hit.t) { terminations.timeOut++; terminated = true; break; }

        // Advance to hit point + apply FULL-segment air absorption to
        // the ray's carried energy before material reflection.
        totalPath += hit.t;
        ox += dx * hit.t;
        oy += dy * hit.t;
        oz += dz * hit.t;
        if (airAbsorption) {
          for (let k = 0; k < B; k++) energy[k] *= Math.exp(-airCoef[k] * hit.t);
        }

        // Specular reflection: d_new = d − 2·(d·n)·n.
        const nx = hit.normal[0], ny = hit.normal[1], nz = hit.normal[2];
        const dDotN = dx * nx + dy * ny + dz * nz;
        dx -= 2 * dDotN * nx;
        dy -= 2 * dDotN * ny;
        dz -= 2 * dDotN * nz;
        // Numerical drift — renormalize to keep |d|=1.
        const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dLen > EPS) { dx /= dLen; dy /= dLen; dz /= dLen; }

        // Nudge origin off the hit surface along the (reflected) direction
        // to avoid immediate self-intersection on the next BVH query.
        ox += dx * EPS;
        oy += dy * EPS;
        oz += dz * EPS;

        // Energy attenuation. If the triangle has no material tag, use a
        // default absorption so rays terminate instead of bouncing forever.
        const matIdx = hit.materialIdx;
        if (matIdx >= 0 && matIdx < scene.materials.length) {
          const absArr = scene.materials[matIdx].absorption;
          for (let k = 0; k < B; k++) energy[k] *= (1 - absArr[k]);
        } else {
          for (let k = 0; k < B; k++) energy[k] *= (1 - DEFAULT_UNKNOWN_MATERIAL_ABSORPTION);
        }

        // Cutoff check.
        let maxE = 0;
        for (let k = 0; k < B; k++) if (energy[k] > maxE) maxE = energy[k];
        if (maxE < cutoffE) { terminations.energy++; terminated = true; break; }
      }
      if (!terminated) terminations.bounce++;
      raysTraced++;
      if (progress && (raysTraced & 0x3FF) === 0) progress(raysTraced, S * raysPerSource);
    }
  }

  return {
    histogram,
    shape: { receivers: R, bands: B, buckets: T },
    bucketDtMs,
    maxTimeMs,
    hitCount,
    raysTraced,
    terminations,
  };
}

// Utility: sum histogram across all buckets for one receiver + band.
// Used by tests + by Phase C metrics to compute total energy windows.
export function histogramWindowSum(result, receiverIdx, bandIdx, bucketStart, bucketEnd) {
  const { histogram, shape } = result;
  const { bands: B, buckets: T } = shape;
  const base = receiverIdx * B * T + bandIdx * T;
  const from = Math.max(0, bucketStart);
  const to = Math.min(T, bucketEnd);
  let s = 0;
  for (let t = from; t < to; t++) s += histogram[base + t];
  return s;
}
