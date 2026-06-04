// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

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

import { intersectRay, intersectRay_collectAabbs } from './bvh.js';
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

// Importance-sample a raised-cosine lobe D(θ) ∝ ((1+cosθ)/2)^n around
// the aim vector (ax, ay, az). Equal energy per ray. Closed-form CDF
// inverse: cos θ = 2·u^(1/(n+1)) − 1, u ∈ [0,1] uniform. Marginal density
// over the sphere is (n+1)·((1+cosθ)/2)^n / (4π) so ∫dΩ = 1 and the
// emitted total power equals L_w by construction. n=0 reduces to the
// uniform-sphere sampler. Uses Frisvad's branch-minimal basis (same
// pattern as sampleCosineHemisphere) to avoid a divide-by-zero at the
// south-pole aim.
function sampleRaisedCosineLobe(ax, ay, az, n, rng, out) {
  if (n <= 0) {
    sampleUnitSphere(rng, out);
    return;
  }
  const u1 = rng();
  const u2 = rng();
  const cosTheta = 2 * Math.pow(u1, 1 / (n + 1)) - 1;
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = 2 * Math.PI * u2;
  const lx = sinTheta * Math.cos(phi);
  const ly = sinTheta * Math.sin(phi);
  const lz = cosTheta;
  let tx, ty, tz, bx, by, bz;
  if (az < -0.9999) {
    tx = 0;  ty = -1; tz = 0;
    bx = -1; by = 0;  bz = 0;
  } else {
    const a = 1 / (1 + az);
    const cross = -ax * ay * a;
    tx = 1 - ax * ax * a;  ty = cross;            tz = -ax;
    bx = cross;            by = 1 - ay * ay * a;  bz = -ay;
  }
  out[0] = lx * tx + ly * bx + lz * ax;
  out[1] = lx * ty + ly * by + lz * ay;
  out[2] = lx * tz + ly * bz + lz * az;
}

// Cosine-weighted hemisphere sample around an arbitrary normal, for
// Lambertian scatter. Uses Frisvad's 2012 branch-minimal orthonormal-
// basis construction to avoid the sqrt + divide in the classical
// "pick-an-up-vector" approach. Writes dir into out[0..2].
function sampleCosineHemisphere(nx, ny, nz, rng, out) {
  const u1 = rng();
  const u2 = rng();
  const r = Math.sqrt(u1);
  const theta = 2 * Math.PI * u2;
  const lx = r * Math.cos(theta);
  const ly = r * Math.sin(theta);
  const lz = Math.sqrt(Math.max(0, 1 - u1));   // cos-weighted in +z

  // Frisvad 2012 — special case near the south pole to avoid blowup.
  let tx, ty, tz, bx, by, bz;
  if (nz < -0.9999) {
    tx = 0;  ty = -1; tz = 0;
    bx = -1; by = 0;  bz = 0;
  } else {
    const a = 1 / (1 + nz);
    const cross = -nx * ny * a;
    tx = 1 - nx * nx * a;  ty = cross;           tz = -nx;
    bx = cross;            by = 1 - ny * ny * a; bz = -ny;
  }
  out[0] = lx * tx + ly * bx + lz * nx;
  out[1] = lx * ty + ly * by + lz * ny;
  out[2] = lx * tz + ly * bz + lz * nz;
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
 * @param {boolean} [opts.scattering=true]      per-bounce Lambertian diffuse
 *                                              scatter decision based on each
 *                                              material's `scattering[band]`
 *                                              coefficient (ISO 17497-1). Per
 *                                              ray the choice is binary —
 *                                              specular OR Lambertian — with
 *                                              probability s_eff (the
 *                                              energy-weighted average scatter
 *                                              coef across bands). Over many
 *                                              rays this recovers the correct
 *                                              mixed BRDF. Improves cross-
 *                                              engine agreement in
 *                                              asymmetric rooms.
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
  // airAbsorption: explicit opts override wins; otherwise defer to the
  // snapshot's physics flag (set from the panel's "Air absorption"
  // toggle); otherwise default true. Without the snapshot fallback the
  // worker-pool whitelist would silently strip the user's toggle.
  const airAbsorption = opts.airAbsorption !== undefined
    ? !!opts.airAbsorption
    : (scene.physics?.airAbsorption !== false);
  const scattering = opts.scattering !== false;
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

  // --- FurnitureLAB Beer-Lambert absorber sink (Phase 2, 2026-05-26) ---
  // Each placed furniture instance contributes a per-band volumetric
  // absorption coefficient μ_b (Nepers/m) inside its bbox per Dr. Chen's
  // brief: μ_b = A_obj / (4·V_bbox) [Kuttruff 5e §4.1 eq. 4.11]. When a
  // ray segment crosses the bbox over an in-bbox pathlength L_in,
  // remaining energy per band: E' = E · exp(-μ_b · L_in). Applies to
  // BOTH the analytical direct-path injection AND every reverberant
  // ray segment (Beranek 2e §10.3 — direct sound IS occluded by tall
  // furniture; exempting direct rays produces a flattering-but-wrong
  // bug where STI looks better than reality).
  //
  // Skip path: when no furniture is placed (catalogue snapshot empty)
  // OR opts.furnitureBvh is null, hasFurniture stays false and the
  // collect-all calls below are skipped via a single early-return
  // guard inside intersectRay_collectAabbs — zero hot-loop cost.
  const furniBvh = opts.furnitureBvh ?? null;
  const furniMu  = scene.furniture?.mu ?? null;
  const hasFurniture = !!(furniBvh && furniBvh.nodeCount > 0 && furniMu);
  const scratchAabbHits = [];      // per-segment scratch; stride-3 (idx, tEnter, tExit)
  const furniExp = new Float32Array(B);     // per-band log-attenuation buffer
  const furniExpPartial = new Float32Array(B); // for partial-path receiver crossings

  // Pre-condition: direction (dx, dy, dz) must be unit-length so that
  // t parameters returned by collect-AABB are pathlengths in metres.
  // Fills out[] with Σ μ_b · L_in summed across every AABB crossed.
  // The analytical direct-path block normalises (dxs/d, dys/d, dzs/d)
  // BEFORE calling; the ray loop's directions are unit by construction.
  function fillFurnitureExp(out, ox, oy, oz, dx, dy, dz, tMax) {
    for (let k = 0; k < B; k++) out[k] = 0;
    if (!hasFurniture) return;
    const nHits = intersectRay_collectAabbs(furniBvh, ox, oy, oz, dx, dy, dz, tMax, scratchAabbHits);
    for (let h = 0; h < nHits; h++) {
      const aabbIdx = scratchAabbHits[h * 3 + 0];
      const tEnter  = scratchAabbHits[h * 3 + 1];
      const tExit   = scratchAabbHits[h * 3 + 2];
      const L_in = tExit - tEnter;
      if (L_in <= 0) continue;
      const muBase = aabbIdx * B;
      for (let k = 0; k < B; k++) out[k] += furniMu[muBase + k] * L_in;
    }
  }

  // Partial-path variant for receiver crossings at parameter tRec
  // mid-segment. Uses the SAME hit-list already collected for the full
  // segment, clamping each crossing's exit to tRec. Cheaper than a
  // second collect-all call.
  function fillFurnitureExpPartial(out, nHits, tRec) {
    for (let k = 0; k < B; k++) out[k] = 0;
    if (!hasFurniture || nHits === 0) return;
    for (let h = 0; h < nHits; h++) {
      const aabbIdx = scratchAabbHits[h * 3 + 0];
      const tEnter  = scratchAabbHits[h * 3 + 1];
      const tExit   = scratchAabbHits[h * 3 + 2];
      if (tEnter >= tRec) continue;
      const effExit = Math.min(tExit, tRec);
      const L_in = effExit - tEnter;
      if (L_in <= 0) continue;
      const muBase = aabbIdx * B;
      for (let k = 0; k < B; k++) out[k] += furniMu[muBase + k] * L_in;
    }
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
  const srcAims = scene.sources.aims;
  const srcDirN = scene.sources.directivityN;
  const recPos = scene.receivers.positions;
  const recR = scene.receivers.radii;

  // Scratch buffers reused across all rays — avoid per-ray allocations.
  const dir = new Float32Array(3);
  const energy = new Float32Array(B);
  const initialEnergy = new Float32Array(B);

  const rng = mulberry32(seed);
  const maxTime_s = maxTimeMs / 1000;

  // PHASE 11.A — analytical direct-path injection per (source, receiver)
  // pair. Replaces the stochastic Monte Carlo direct-bucket contribution
  // from rays that happen to fly through the receiver on their first
  // segment (typically ~780 of 50 000 rays for a typical close source,
  // giving ±1.5 dB variance on the direct sound). Vorländer §11.3 — every
  // pro auralization tool (Odeon, EASE, Treble) does direct sound
  // analytically. The ray loop's receiver-crossing logging is skipped on
  // bounce === 0 below to avoid double-counting.
  //
  // Per-worker scaling: each worker contributes its share (raysPerSource
  // / normalizationRays) so summing N worker partials gives the full
  // analytical value once. Without this each worker would inject the
  // FULL analytical value and the merged histogram would be N× too loud
  // on direct sound.
  const workerShare = raysPerSource / normalizationRays;
  for (let sIdx = 0; sIdx < S; sIdx++) {
    const sx = srcPos[sIdx * 3 + 0];
    const sy = srcPos[sIdx * 3 + 1];
    const sz = srcPos[sIdx * 3 + 2];
    const aimX = srcAims ? srcAims[sIdx * 3 + 0] : 0;
    const aimY = srcAims ? srcAims[sIdx * 3 + 1] : 1;
    const aimZ = srcAims ? srcAims[sIdx * 3 + 2] : 0;
    const lobeN = srcDirN ? srcDirN[sIdx] : 0;
    for (let recIdx = 0; recIdx < R; recIdx++) {
      const rx = recPos[recIdx * 3 + 0];
      const ry = recPos[recIdx * 3 + 1];
      const rz = recPos[recIdx * 3 + 2];
      const dxs = rx - sx, dys = ry - sy, dzs = rz - sz;
      const d = Math.sqrt(dxs * dxs + dys * dys + dzs * dzs);
      if (d < 1e-3) continue;     // listener at source — degenerate
      const arrival_s = d / c_mps;
      const bucket = Math.floor((arrival_s * 1000) / bucketDtMs);
      if (bucket < 0 || bucket >= T) continue;
      // Directivity D(θ) for raised-cosine lobe. Same closed-form as the
      // importance-sampling path uses internally: D(θ) = (n+1)·((1+cosθ)/2)^n
      // (n=0 → D=1 omni; integrates to 4π for any n ≥ 0).
      const dxn = dxs / d, dyn = dys / d, dzn = dzs / d;
      const cosTheta = Math.max(-1, Math.min(1, aimX * dxn + aimY * dyn + aimZ * dzn));
      const half1pCos = 0.5 + 0.5 * cosTheta;
      const Dlobe = (lobeN + 1) * Math.pow(half1pCos, lobeN);
      // Receiver capture cross-section per source: π·r² / (4π·d²) = r²/(4d²)
      const captureFrac = (recR[recIdx] * recR[recIdx]) / (4 * d * d);
      const base = recIdx * B * T + bucket;
      // Furniture absorption along the direct-path segment from source
      // to receiver. Direction (dxn, dyn, dzn) is unit; tMax = d so the
      // collect-AABB stops at the receiver position. Dr. Chen's edge
      // case #4: direct rays MUST be attenuated by occluding furniture
      // (Beranek 2e §10.3); exempting them produces flattering STI bug.
      fillFurnitureExp(furniExp, sx, sy, sz, dxn, dyn, dzn, d);
      if (airAbsorption) {
        for (let k = 0; k < B; k++) {
          const sourcePower = Math.pow(10, srcLw[sIdx * B + k] / 10);
          const E = sourcePower * Dlobe * captureFrac * Math.exp(-airCoef[k] * d - furniExp[k]) * workerShare;
          histogram[base + k * T] += E;
        }
      } else {
        for (let k = 0; k < B; k++) {
          const sourcePower = Math.pow(10, srcLw[sIdx * B + k] / 10);
          const E = sourcePower * Dlobe * captureFrac * Math.exp(-furniExp[k]) * workerShare;
          histogram[base + k * T] += E;
        }
      }
      hitCount++;
    }
  }

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
    // Lobe exponent + aim vector, hoisted out of the inner ray loop.
    // Snapshot was built with directivityN populated; missing field falls
    // back to omni so older snapshots in flight don't crash.
    const lobeN = srcDirN ? srcDirN[sIdx] : 0;
    const aimX = srcAims ? srcAims[sIdx * 3 + 0] : 0;
    const aimY = srcAims ? srcAims[sIdx * 3 + 1] : 1;
    const aimZ = srcAims ? srcAims[sIdx * 3 + 2] : 0;

    for (let ri = 0; ri < raysPerSource; ri++) {
      // Fresh direction + energy for each ray.
      sampleRaisedCosineLobe(aimX, aimY, aimZ, lobeN, rng, dir);
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

        // Collect furniture-bbox crossings for THIS segment once;
        // reuse the same hit list for (a) the per-receiver partial-
        // path attenuation and (b) the full-segment ray-energy
        // attenuation below. Scratch array `scratchAabbHits` is
        // owned by the closure; collect-AABB overwrites length.
        const nFurniHits = hasFurniture
          ? intersectRay_collectAabbs(furniBvh, ox, oy, oz, dx, dy, dz, segmentEnd_m, scratchAabbHits)
          : 0;

        // Log receiver crossings on this segment. When air absorption is
        // enabled the logged energy must be attenuated by the PARTIAL
        // path length from segment-start to the sphere-entry point tRec —
        // the ray hasn't yet travelled the full segment when it crosses
        // the receiver. Same partial-path rule applies to the furniture
        // absorber sink (Dr. Chen — receiver-crossing energy reflects
        // the in-bbox pathlength up TO tRec, not the full segment).
        //
        // Phase 11.A — skip first-segment crossings (bounce === 0). The
        // ray's first segment is the direct path from the source; we
        // injected an analytical value for this earlier (search "Phase
        // 11.A — analytical direct-path injection"). Letting the ray
        // loop ALSO log first-segment crossings would double-count
        // direct sound. NOTE the wrap is around only the inner receiver
        // loop — the wall advancement and reflection below this block
        // still run, so the ray correctly continues to bounces ≥ 1.
        if (bounce > 0) for (let recIdx = 0; recIdx < R; recIdx++) {
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
          // Furniture partial-path attenuation up to tRec (uses the
          // already-collected hit list; clamps each crossing's exit to
          // tRec). Zero contribution when hasFurniture is false.
          fillFurnitureExpPartial(furniExpPartial, nFurniHits, tRec);
          if (airAbsorption) {
            for (let k = 0; k < B; k++) {
              histogram[base + k * T] += energy[k] * Math.exp(-airCoef[k] * tRec - furniExpPartial[k]);
            }
          } else {
            for (let k = 0; k < B; k++) {
              histogram[base + k * T] += energy[k] * Math.exp(-furniExpPartial[k]);
            }
          }
          hitCount++;
        }

        if (segmentEnd_m < hit.t) { terminations.timeOut++; terminated = true; break; }

        // Advance to hit point + apply FULL-segment air absorption AND
        // full-segment furniture sink to the ray's carried energy before
        // material reflection. Dr. Chen edge case #3 — do NOT also apply
        // air absorption inside the bbox (the air sink is global; the
        // bbox is an absorber region IN the same air). Both terms are
        // additive in the log, exactly the same machinery the air
        // coefficient already uses one line below.
        totalPath += hit.t;
        ox += dx * hit.t;
        oy += dy * hit.t;
        oz += dz * hit.t;
        // Full-segment furniture exponent — sum over all AABBs the ray
        // segment crossed. nFurniHits is the same hit count collected
        // above; the data lives in scratchAabbHits.
        if (hasFurniture && nFurniHits > 0) {
          for (let k = 0; k < B; k++) furniExp[k] = 0;
          for (let h = 0; h < nFurniHits; h++) {
            const aabbIdx = scratchAabbHits[h * 3 + 0];
            const tEnter  = scratchAabbHits[h * 3 + 1];
            const tExit   = scratchAabbHits[h * 3 + 2];
            const L_in = tExit - tEnter;
            if (L_in <= 0) continue;
            const muBase = aabbIdx * B;
            for (let k = 0; k < B; k++) furniExp[k] += furniMu[muBase + k] * L_in;
          }
          if (airAbsorption) {
            for (let k = 0; k < B; k++) energy[k] *= Math.exp(-airCoef[k] * hit.t - furniExp[k]);
          } else {
            for (let k = 0; k < B; k++) energy[k] *= Math.exp(-furniExp[k]);
          }
        } else if (airAbsorption) {
          for (let k = 0; k < B; k++) energy[k] *= Math.exp(-airCoef[k] * hit.t);
        }

        const nx = hit.normal[0], ny = hit.normal[1], nz = hit.normal[2];
        const matIdx = hit.materialIdx;

        // Material-aware scatter vs specular decision, BEFORE energy update.
        // Probability of a Lambertian scatter at this bounce is s_eff,
        // the energy-weighted average of the per-band scattering
        // coefficients. Over many rays the ensemble matches the mixed
        // specular/diffuse BRDF that scattering = s implies.
        let useScatter = false;
        if (scattering && matIdx >= 0 && matIdx < scene.materials.length) {
          const scaArr = scene.materials[matIdx].scattering;
          let sWeighted = 0, eSum = 0;
          for (let k = 0; k < B; k++) {
            const e = energy[k];
            sWeighted += scaArr[k] * e;
            eSum += e;
          }
          const sEff = eSum > 0 ? sWeighted / eSum : 0;
          if (sEff > 0 && rng() < sEff) useScatter = true;
        }

        if (useScatter) {
          // Lambertian cosine-weighted hemisphere around the normal.
          sampleCosineHemisphere(nx, ny, nz, rng, dir);
          dx = dir[0]; dy = dir[1]; dz = dir[2];
        } else {
          // Specular: d_new = d − 2·(d·n)·n
          const dDotN = dx * nx + dy * ny + dz * nz;
          dx -= 2 * dDotN * nx;
          dy -= 2 * dDotN * ny;
          dz -= 2 * dDotN * nz;
        }
        // Numerical drift — renormalize to keep |d|=1. (Lambertian sample
        // is unit by construction; specular is too, up to FP jitter.)
        const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dLen > EPS) { dx /= dLen; dy /= dLen; dz /= dLen; }

        // Nudge origin off the hit surface along the (reflected) direction
        // to avoid immediate self-intersection on the next BVH query.
        ox += dx * EPS;
        oy += dy * EPS;
        oz += dz * EPS;

        // Energy attenuation. Both specular and Lambertian paths lose the
        // same fraction to absorption — scattering reshapes the direction
        // distribution, absorption removes energy. If the triangle has no
        // material tag, use a default absorption so rays terminate rather
        // than bouncing forever.
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
