// Worker smoke test — main-thread driver.
//
// Purpose: on a live deploy, verify the worker plumbing Phase B will rely
// on actually works. Nothing UI-facing; run from DevTools console:
//
//     await window.__roomlabWorkerSmoke()
//
// The returned object reports:
//   • env.crossOriginIsolated       — needed for SharedArrayBuffer
//   • env.sharedArrayBufferAvailable — fallback decision for Phase B
//   • tests.echo.roundTripMs        — postMessage ping-pong latency
//   • tests.parallel                — N workers in parallel × synthetic
//                                      compute; reports achieved speedup
//   • tests.transfer                — 1 MB ArrayBuffer round-trip with
//                                      transferable semantics; critical
//                                      for ray-batch handoff
//
// Numbers we want to see (budgets for Phase B):
//   • roundTripMs                         < 5 ms      (progress updates OK)
//   • parallel.achievedSpeedup            > 0.7 × N   (not serialized)
//   • transfer.transferMs for 1 MB        < 10 ms     (ray batches cheap)
//
// If any of those miss, Phase B needs a different architecture (e.g.
// bigger batches, fewer workers, or a WASM inner loop that does more
// work per message).

const WORKER_URL = new URL('./worker-smoke.js', import.meta.url);

function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function spawnWorker() {
  return new Worker(WORKER_URL, { type: 'module' });
}

function once(worker) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => reject(e);
  });
}

export async function runWorkerSmokeTest({ log = true } = {}) {
  const out = {
    startedAt: new Date().toISOString(),
    env: {
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      crossOriginIsolated: typeof self !== 'undefined' ? !!self.crossOriginIsolated : false,
      sharedArrayBufferAvailable: typeof SharedArrayBuffer !== 'undefined',
      atomicsAvailable: typeof Atomics !== 'undefined',
      userAgent: navigator.userAgent,
    },
    tests: {},
    recommendations: [],
  };

  // ---- Test 1: echo round-trip --------------------------------------
  try {
    const tSpawn0 = performance.now();
    const worker = spawnWorker();
    const spawnMs = performance.now() - tSpawn0;

    const samples = [];
    for (let i = 0; i < 20; i++) {
      const promise = once(worker);
      const startedAt = performance.now();
      worker.postMessage({ type: 'echo', startedAt });
      const reply = await promise;
      const roundTripMs = performance.now() - startedAt;
      samples.push({ roundTripMs, recv_latency_ms: reply.recv_latency_ms });
    }
    worker.terminate();
    out.tests.echo = {
      samples: samples.length,
      spawnMs,
      roundTripMs_median: median(samples.map(s => s.roundTripMs)),
      roundTripMs_min: Math.min(...samples.map(s => s.roundTripMs)),
      roundTripMs_max: Math.max(...samples.map(s => s.roundTripMs)),
      recv_latency_ms_median: median(samples.map(s => s.recv_latency_ms)),
    };
  } catch (err) {
    out.tests.echo = { error: err.message };
  }

  // ---- Test 2: N workers in parallel --------------------------------
  try {
    const cpuCount = Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1);
    const N = Math.min(8, cpuCount);
    const workers = Array.from({ length: N }, () => spawnWorker());
    const iterations = 10_000_000;

    // Warm each worker with a tiny echo so the module is parsed + ready.
    await Promise.all(workers.map(w => {
      const p = once(w);
      w.postMessage({ type: 'echo', startedAt: performance.now() });
      return p;
    }));

    // Now time the parallel compute.
    const tPar0 = performance.now();
    const replies = await Promise.all(workers.map(w => {
      const p = once(w);
      w.postMessage({ type: 'compute', iterations });
      return p;
    }));
    const parallelMs = performance.now() - tPar0;
    workers.forEach(w => w.terminate());

    const workerWorkMs = replies.map(r => r.work_ms);
    const medianWorkerMs = median(workerWorkMs);
    // "Achieved speedup" — if a single worker's own clock says it did X ms
    // of work, and N workers finished in Y ms wall-clock, the speedup is
    // X/Y. Ideal = 1.0 (because each is doing its own chunk in parallel;
    // we are NOT subdividing work). Actually: if parallelMs ≈ medianWorkerMs,
    // speedup = N (N-way parallelism achieved). If parallelMs ≈ N × median,
    // workers serialized.
    const achievedSpeedup = (medianWorkerMs * N) / parallelMs;
    out.tests.parallel = {
      workerCount: N,
      iterations,
      parallelMs,
      medianWorkerMs,
      achievedSpeedup,
      ideal: N,
    };
  } catch (err) {
    out.tests.parallel = { error: err.message };
  }

  // ---- Test 3: 1 MB transferable round-trip -------------------------
  try {
    const worker = spawnWorker();
    // Warm up: one echo round-trip so the module is parsed + ready.
    const warmP = once(worker);
    worker.postMessage({ type: 'echo', startedAt: performance.now() });
    await warmP;

    const floatCount = 250_000;   // 1 MB
    const buf = new ArrayBuffer(floatCount * 4);
    const arr = new Float32Array(buf);
    for (let i = 0; i < floatCount; i++) arr[i] = (i * 31) % 997;

    const t0 = performance.now();
    const promise = once(worker);
    worker.postMessage({ type: 'transfer', buf }, [buf]);
    const reply = await promise;
    const roundTripMs = performance.now() - t0;
    worker.terminate();
    out.tests.transfer = {
      byteLength: reply.byteLength,
      MB: reply.byteLength / 1048576,
      roundTripMs,
      worker_work_ms: reply.work_ms,
      pureTransferMs_est: roundTripMs - reply.work_ms,
    };
  } catch (err) {
    out.tests.transfer = { error: err.message };
  }

  // ---- Recommendations ----------------------------------------------
  const e = out.tests.echo, p = out.tests.parallel, t = out.tests.transfer;
  if (e && !e.error) {
    if (e.roundTripMs_median < 5) out.recommendations.push('Echo latency OK (<5 ms) — progress updates will be smooth.');
    else out.recommendations.push(`Echo latency high (${e.roundTripMs_median.toFixed(1)} ms) — throttle progress posts.`);
  }
  if (p && !p.error) {
    const ratio = p.achievedSpeedup / p.ideal;
    if (ratio > 0.7) out.recommendations.push(`Parallel scaling OK (${p.achievedSpeedup.toFixed(1)}× of ${p.ideal}× ideal).`);
    else out.recommendations.push(`Parallel scaling weak (${(ratio * 100).toFixed(0)}% of ideal) — reduce worker count or increase batch size.`);
  }
  if (t && !t.error) {
    if (t.roundTripMs < 10) out.recommendations.push(`1 MB round-trip ${t.roundTripMs.toFixed(1)} ms — ray batches cheap.`);
    else out.recommendations.push(`1 MB round-trip ${t.roundTripMs.toFixed(1)} ms — prefer larger batches.`);
  }
  if (!out.env.sharedArrayBufferAvailable) {
    out.recommendations.push('SharedArrayBuffer NOT available (no COOP/COEP headers on this deploy). Phase B will use postMessage + transferable — still fine for our data sizes, but histogram aggregation has to run on main thread instead of shared memory.');
  } else {
    out.recommendations.push('SharedArrayBuffer available — histograms can be shared across workers.');
  }

  if (log) {
    console.log('[RoomLab worker smoke test]');
    console.log('Env:', out.env);
    console.log('Tests:', out.tests);
    console.log('Recommendations:');
    out.recommendations.forEach(r => console.log('  •', r));
  }
  return out;
}
