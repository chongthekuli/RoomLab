// Main-thread worker pool — Phase B3b.
//
// Fan out a precision render across N workers. Each worker traces
// (raysPerSource ÷ N) rays from every source with a unique seed; their
// partial histograms are element-wise summed on return. Because each
// ray carries energy / raysPerSource on emission, summed partials from
// N workers give an unbiased estimate equivalent to tracing the full
// raysPerSource rays on a single worker — this is the key numerical
// invariant the pool relies on.
//
// Seed scheme: each worker gets baseSeed + workerIndex × 1_000_003
// (a prime big enough that adjacent workers don't explore correlated
// subtrees of mulberry32). Running the pool twice with the same
// baseSeed produces bit-exact same output.
//
// Transfer:
//   • init: scene + bvh structured-cloned once per worker. Total
//     ~100 KB × N workers — trivial.
//   • trace result: histogram buffer transferred back (zero-copy).
//
// No SharedArrayBuffer — A5 smoke test confirmed github.io does not
// serve COOP/COEP headers. All aggregation happens on the main thread
// after postMessage fan-in.

const WORKER_URL = new URL('./precision-worker.js', import.meta.url);

export class PrecisionWorkerPool {
  constructor(workerCount) {
    this.workerCount = workerCount;
    this.workers = [];
    this.readyCount = 0;
    this._jobSeq = 0;
    this._pending = new Map();            // jobId → { resolve, reject, onProgress }
    this._initPromise = null;
    this._initResolve = null;
  }

  /**
   * Spawn workers and deliver the initial (scene, bvh) payload.
   * Resolves when every worker has acknowledged 'ready'.
   */
  init(scene, bvh) {
    if (this._initPromise) return this._initPromise;
    this._initPromise = new Promise((resolve, reject) => {
      this._initResolve = resolve;
      for (let i = 0; i < this.workerCount; i++) {
        let w;
        try {
          w = new Worker(WORKER_URL, { type: 'module' });
        } catch (err) {
          reject(new Error(`Failed to spawn worker ${i}: ${err.message}`));
          return;
        }
        w.onmessage = (e) => this._onMessage(w, i, e.data);
        w.onerror = (e) => reject(new Error(`Worker ${i} error: ${e.message ?? e}`));
        w.postMessage({ type: 'init', scene, bvh });
        this.workers.push(w);
      }
    });
    return this._initPromise;
  }

  _onMessage(worker, workerIdx, msg) {
    switch (msg.type) {
      case 'ready':
        this.readyCount++;
        if (this.readyCount === this.workerCount && this._initResolve) {
          this._initResolve();
          this._initResolve = null;
        }
        break;
      case 'progress': {
        const job = this._pending.get(msg.jobId);
        if (job?.onProgress) job.onProgress(workerIdx, msg.raysDone, msg.raysTotal);
        break;
      }
      case 'result': {
        const job = this._pending.get(msg.jobId);
        if (job) {
          this._pending.delete(msg.jobId);
          job.resolve(msg);
        }
        break;
      }
      case 'error': {
        const job = this._pending.get(msg.jobId);
        if (job) {
          this._pending.delete(msg.jobId);
          job.reject(new Error(`Worker ${workerIdx}: ${msg.message}`));
        }
        break;
      }
    }
  }

  /**
   * Trace raysPerSource rays from each source, split across workers.
   * @param {object} opts — forwarded to tracer-core; raysPerSource is
   *                        divided evenly; seed becomes (opts.seed ?? 1).
   * @param {Function} [onProgress] — (workerIdx, raysDone, raysTotal) => void
   */
  async trace(opts, onProgress) {
    if (!this._initPromise) throw new Error('trace() called before init()');
    await this._initPromise;
    const N = this.workerCount;
    const raysPerSource = opts.raysPerSource ?? 10_000;
    const perWorker = Math.ceil(raysPerSource / N);
    const baseSeed = (opts.seed ?? 1) >>> 0;

    const jobs = this.workers.map((worker, i) => {
      const jobId = ++this._jobSeq;
      // Each worker emits `perWorker` rays but normalizes energy by the
      // FULL `raysPerSource` budget, so sum-across-workers reconstructs
      // the energy that a single N-ray trace would produce.
      const workerOpts = {
        ...opts,
        raysPerSource: perWorker,
        normalizationRays: raysPerSource,
        seed: baseSeed + i * 1_000_003,
      };
      const p = new Promise((resolve, reject) => {
        this._pending.set(jobId, { resolve, reject, onProgress });
      });
      worker.postMessage({ type: 'trace', jobId, opts: workerOpts });
      return p;
    });

    const results = await Promise.all(jobs);
    return mergePartialHistograms(results);
  }

  /**
   * Terminate every worker. Pool cannot be reused after this.
   */
  terminate() {
    for (const w of this.workers) {
      try { w.postMessage({ type: 'shutdown' }); } catch (_) {}
      w.terminate();
    }
    this.workers = [];
    this.readyCount = 0;
    this._pending.clear();
    this._initPromise = null;
  }
}

/**
 * Sum N partial tracer results into one, element-wise on the histogram.
 * Exported so tests can exercise it without spawning Workers.
 * Expects every partial to share the same { shape, bucketDtMs, maxTimeMs }.
 */
export function mergePartialHistograms(partials) {
  if (!partials || partials.length === 0) {
    throw new Error('mergePartialHistograms: no partials');
  }
  const first = partials[0];
  const len = first.histogram.length;
  const merged = new Float32Array(len);
  let hitCount = 0;
  let raysTraced = 0;
  const terminations = { escaped: 0, energy: 0, bounce: 0, timeOut: 0 };
  for (const p of partials) {
    if (p.histogram.length !== len) throw new Error('mergePartialHistograms: histogram length mismatch');
    if (p.shape.receivers !== first.shape.receivers ||
        p.shape.bands !== first.shape.bands ||
        p.shape.buckets !== first.shape.buckets) {
      throw new Error('mergePartialHistograms: shape mismatch');
    }
    for (let j = 0; j < len; j++) merged[j] += p.histogram[j];
    hitCount   += p.hitCount   ?? 0;
    raysTraced += p.raysTraced ?? 0;
    if (p.terminations) {
      terminations.escaped += p.terminations.escaped ?? 0;
      terminations.energy  += p.terminations.energy  ?? 0;
      terminations.bounce  += p.terminations.bounce  ?? 0;
      terminations.timeOut += p.terminations.timeOut ?? 0;
    }
  }
  return {
    histogram: merged,
    shape: first.shape,
    bucketDtMs: first.bucketDtMs,
    maxTimeMs: first.maxTimeMs,
    hitCount,
    raysTraced,
    terminations,
  };
}
