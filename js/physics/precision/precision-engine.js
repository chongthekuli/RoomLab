// Precision engine — main-thread entry point.
//
// API:
//   const result = await runPrecisionRender({ state, materials,
//                                              getLoudspeakerDef, opts });
//
// Internally: build scene snapshot → triangulate → BVH → spawn worker
// pool → fan out rays → aggregate histograms → terminate pool → return.
// Cancellation via opts.signal (AbortSignal) — aborts in-flight pool
// and rejects the returned promise.
//
// Phase C will take the returned histogram and derive metrics
// (EDT / T30 / C80 / C50 / D-R / STI-from-IR). Phase E wires this
// into a "Render Precision" UI button.

import { buildPhysicsScene } from '../scene-snapshot.js';
import { triangulateScene } from './triangulate-scene.js';
import { buildBVH } from './bvh.js';
import { PrecisionWorkerPool } from './worker-pool.js';

/**
 * Run a full precision render end-to-end.
 *
 * @param {object} args
 * @param {object} args.state                  Mutable app state (not retained)
 * @param {object} args.materials              Material DB (loaded from materials.json)
 * @param {Function} args.getLoudspeakerDef    URL → speaker JSON resolver
 * @param {object} [args.opts]                 Render options
 * @param {number} [args.opts.raysPerSource=10000]
 * @param {number} [args.opts.maxBounces=50]
 * @param {number} [args.opts.bucketDtMs=2]
 * @param {number} [args.opts.maxTimeMs=2000]
 * @param {number} [args.opts.energyCutoffDb=-60]
 * @param {number} [args.opts.seed=1]
 * @param {number} [args.opts.workerCount]     defaults to navigator.hardwareConcurrency - 1 (min 1)
 * @param {Function} [args.opts.onProgress]    (workerIdx, raysDone, raysTotal) => void
 * @param {AbortSignal} [args.opts.signal]     cancel in-flight render
 *
 * @returns {Promise<PrecisionResult>} — merged histogram + stats. See tracer-core.js.
 */
export async function runPrecisionRender({ state, materials, getLoudspeakerDef, opts = {} }) {
  const t0 = performance.now();

  // 1. Snapshot — freeze state for the duration of the render.
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef });

  // 2. Triangulate + BVH (main thread, cheap even for 1k triangles).
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);

  // 3. Worker count. Cap at a reasonable maximum so an absurd
  // hardwareConcurrency (containers, weird VMs) doesn't spawn 64 workers.
  const detected = (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined) ?? 4;
  const workerCount = Math.max(1, Math.min(opts.workerCount ?? (detected - 1), 16));

  const pool = new PrecisionWorkerPool(workerCount);
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    pool.terminate();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      throw new Error('Aborted before render started');
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    await pool.init(scene, bvh);
    const result = await pool.trace(opts, opts.onProgress);
    if (cancelled) throw new Error('Render cancelled');
    const elapsedMs = performance.now() - t0;
    return {
      ...result,
      scene,
      soup,
      bvh,
      workerCount,
      elapsedMs,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    pool.terminate();
  }
}
