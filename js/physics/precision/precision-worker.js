// Thin worker shell around the ray-tracer kernel.
// All the physics lives in tracer-core.js — this file is just the
// message adapter between the main-thread worker pool and that kernel.
//
// Protocol:
//   init  — main thread sends { scene, bvh } once per worker. Structured
//           clone copies the data; we patch `bvh.soup` back to the
//           transferred soup so the tracer's intersectRay finds vertex
//           data where it expects it.
//   trace — main thread sends { jobId, opts }. Worker runs traceRays
//           synchronously, posts progress events at ~4 Hz, and finally
//           transfers the histogram buffer back (no copy).
//   error — any exception during init/trace is reported back with the
//           originating jobId so the pool can fail the promise instead
//           of hanging.

import { traceRays } from './tracer-core.js';

let scene = null;
let bvh = null;

self.onmessage = (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init': {
        scene = msg.scene;
        bvh = msg.bvh;
        // Structured clone transferred `bvh` as a standalone object; its
        // `.soup` field was cloned separately as a sub-tree. Confirm the
        // tracer will find vertex data.
        if (!bvh || !bvh.soup || !bvh.soup.positions) {
          throw new Error('init: bvh.soup.positions missing after clone');
        }
        self.postMessage({ type: 'ready' });
        break;
      }
      case 'trace': {
        if (!scene || !bvh) throw new Error('trace called before init');
        const result = traceRays(scene, bvh, {
          ...msg.opts,
          progress: (done, total) => {
            // Throttle: only every ~512 rays, not every ray. tracer-core's
            // own gate is 0x3FF = 1023; this runs about twice per gate.
            self.postMessage({ type: 'progress', jobId: msg.jobId, raysDone: done, raysTotal: total });
          },
        });
        self.postMessage({
          type: 'result',
          jobId: msg.jobId,
          histogram: result.histogram,
          shape: result.shape,
          bucketDtMs: result.bucketDtMs,
          maxTimeMs: result.maxTimeMs,
          hitCount: result.hitCount,
          raysTraced: result.raysTraced,
          terminations: result.terminations,
        }, [result.histogram.buffer]);   // transferable — main thread receives with zero copy
        break;
      }
      case 'shutdown':
        self.close();
        break;
      default:
        self.postMessage({ type: 'error', jobId: msg.jobId ?? null, message: `unknown message type: ${msg.type}` });
    }
  } catch (err) {
    self.postMessage({ type: 'error', jobId: msg.jobId ?? null, message: err?.message ?? String(err) });
  }
};
