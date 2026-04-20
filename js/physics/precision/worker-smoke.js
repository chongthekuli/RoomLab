// Worker smoke test — the absolute minimum worker that can respond to
// main-thread pings. Used by the A5 deploy-readiness check (see
// worker-smoke-driver.js). NOT the actual Phase B ray-tracing worker;
// that's a separate file to be written once this smoke test confirms
// the plumbing works on the live deploy.
//
// Handlers:
//   • 'echo'      — replies immediately with round-trip timing
//   • 'compute'   — runs a fixed-count synthetic loop, returns wall-time
//   • 'transfer'  — accepts a transferable ArrayBuffer, echoes it back
//                   via [buf] transfer list so the cost we measure is
//                   real transfer, not a copy
//
// Must be loaded as a module worker (`new Worker(url, { type: 'module' })`)
// so this file remains compatible with Phase B's need for module imports
// inside workers.

self.onmessage = (e) => {
  const t_recv = performance.now();
  const msg = e.data;
  switch (msg.type) {
    case 'echo': {
      self.postMessage({
        type: 'echo-reply',
        startedAt: msg.startedAt,
        recv_latency_ms: t_recv - msg.startedAt,
        repliedAt: performance.now(),
      });
      break;
    }
    case 'compute': {
      // Deterministic CPU-bound loop — sin·cos so V8 can't fold it away.
      const n = msg.iterations | 0;
      const t0 = performance.now();
      let s = 0;
      for (let i = 0; i < n; i++) s += Math.sin(i) * Math.cos(i);
      self.postMessage({
        type: 'compute-reply',
        iterations: n,
        work_ms: performance.now() - t0,
        result: s,        // returned so V8 can't dead-code-eliminate
      });
      break;
    }
    case 'transfer': {
      // Receive a transferable ArrayBuffer, touch every element, transfer back.
      const { buf } = msg;
      const arr = new Float32Array(buf);
      const len = arr.length;
      let touch = 0;
      for (let i = 0; i < len; i += 1024) touch += arr[i];   // light touch
      const work_ms = performance.now() - t_recv;
      self.postMessage(
        {
          type: 'transfer-reply',
          byteLength: buf.byteLength,
          work_ms,
          touchSample: touch,
          buf,                // echoed back
        },
        [buf],                // transfer list — no copy
      );
      break;
    }
    default:
      self.postMessage({ type: 'error', message: `unknown type: ${msg?.type}` });
  }
};
