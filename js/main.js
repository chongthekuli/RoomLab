// SPA bootstrap. Mounts the header nav once, hands off to the hash
// router, and wires the dev-mode worker-smoke + precision-demo
// banners. Each Lab is a separate module that the router lazy-mounts
// the first time the user visits its route — so SpeakerLAB doesn't
// pay Three.js cold-start cost, and RoomLAB's WebGL scene stays
// alive when you flip away to DeviceLAB and back.

import { state } from './app-state.js';
import { mountHeaderNav } from './shared/header-nav.js';
import { startRouter } from './shared/router.js';

mountHeaderNav();

// Cache-bust dynamic imports with the same ?v= that index.html uses on
// the top-level <script>. Without this, a deploy that ships new HTML
// (e.g. new panel IDs) plus new lab JS can hit a stale cached lab
// module — the new HTML has new selectors but the cached JS writes
// to the OLD IDs, so panels appear stuck on "Loading…".
// `import.meta.url` here is the URL js/main.js was fetched from,
// which INCLUDES the cache-bust param.
const _v = new URL(import.meta.url).searchParams.get('v');
const _vQ = _v ? `?v=${_v}` : '';

// Lab mounts are dynamic-imported lazily so each Lab's modules don't
// load until the route is visited. Visiting #/speaker doesn't pull
// in scene.js; visiting #/room doesn't pull in speaker-detail.js.
// The router caches the mount Promise so a repeat visit is a no-op.
startRouter({
  mounts: {
    room:    () => import(`./labs/roomlab/main.js${_vQ}`).then(m => m.mountRoomLab()),
    speaker: () => import(`./labs/speakerlab/main.js${_vQ}`).then(m => m.mountSpeakerLab()),
    device:  () => import(`./labs/devicelab/main.js${_vQ}`).then(m => m.mountDeviceLab()),
    surface: () => import(`./labs/surfacelab/main.js${_vQ}`).then(m => m.mountSurfaceLab()),
  },
});

// ---------- Dev hooks --------------------------------------------------
// `?smoketest` runs the worker-pool smoke driver in a banner.
// `?precision-demo` runs the precision tracer end-to-end with a
// real scene. Both are lazy-imported so they cost zero on default
// page loads.
if (typeof window !== 'undefined') {
  window.__roomlabWorkerSmoke = async (opts) => {
    const mod = await import('./physics/precision/worker-smoke-driver.js');
    return mod.runWorkerSmokeTest(opts);
  };
  if (new URLSearchParams(window.location.search).has('smoketest')) {
    window.addEventListener('load', async () => {
      const banner = document.createElement('div');
      banner.id = 'smoketest-banner';
      banner.style.cssText = 'position:fixed;inset:16px;z-index:9999;background:#0f1218;color:#cfd3d9;border:1px solid #3a5a8a;border-radius:8px;padding:16px;overflow:auto;font-family:monospace;font-size:12px;line-height:1.45;box-shadow:0 12px 40px rgba(0,0,0,0.6)';
      banner.innerHTML = '<div style="color:#4aa3ff;font-size:14px;margin-bottom:12px;">⏳ Running worker smoke test — ~3 seconds…</div>';
      document.body.appendChild(banner);
      try {
        const result = await window.__roomlabWorkerSmoke({ log: true });
        const closeBtn = '<button style="position:absolute;top:8px;right:12px;background:#2a2f38;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;" onclick="this.parentElement.remove()">×</button>';
        const summaryLines = [
          `<strong style="color:#4aa3ff;font-size:14px;">RoomLab worker smoke test — ${result.startedAt}</strong>`,
          closeBtn,
          '',
          '<strong style="color:#89c0ff">Environment</strong>',
          `  hardwareConcurrency: ${result.env.hardwareConcurrency}`,
          `  crossOriginIsolated: ${result.env.crossOriginIsolated}`,
          `  sharedArrayBufferAvailable: ${result.env.sharedArrayBufferAvailable}`,
          `  atomicsAvailable: ${result.env.atomicsAvailable}`,
          '',
          '<strong style="color:#89c0ff">Tests</strong>',
          `  echo:      spawn ${fmt(result.tests.echo?.spawnMs)} ms,  roundTrip median ${fmt(result.tests.echo?.roundTripMs_median)} ms  (min ${fmt(result.tests.echo?.roundTripMs_min)} / max ${fmt(result.tests.echo?.roundTripMs_max)})`,
          `  parallel:  ${result.tests.parallel?.workerCount} workers × ${(result.tests.parallel?.iterations ?? 0).toLocaleString()} ops  →  parallelMs ${fmt(result.tests.parallel?.parallelMs)},  medianWorkerMs ${fmt(result.tests.parallel?.medianWorkerMs)},  speedup ${fmt(result.tests.parallel?.achievedSpeedup)} × (ideal ${result.tests.parallel?.ideal})`,
          `  transfer:  ${fmt(result.tests.transfer?.MB)} MB round-trip ${fmt(result.tests.transfer?.roundTripMs)} ms  (pure-transfer est ${fmt(result.tests.transfer?.pureTransferMs_est)} ms)`,
          '',
          '<strong style="color:#89c0ff">Recommendations</strong>',
          ...result.recommendations.map(r => '  • ' + r),
          '',
          '<span style="color:#89929d">Paste THIS whole block back into the chat. Close with × top-right.</span>',
        ];
        banner.innerHTML = summaryLines.map(l => `<div>${l}</div>`).join('');
      } catch (err) {
        banner.innerHTML = `<div style="color:#ff6565;">Smoke test failed: ${err?.message ?? err}</div>`;
        console.error('Smoke test failed:', err);
      }
    });
  }

  // Precision-demo dev hook — same as before, just relocated to the
  // SPA shell so it works regardless of the active route.
  window.__roomlabPrecisionRender = async (opts) => {
    const { SPEAKER_CATALOG, applyPresetToState, DEFAULT_PRESET_KEY } = await import('./app-state.js');
    const { loadMaterials } = await import('./physics/materials.js');
    const { loadLoudspeaker, getCachedLoudspeaker } = await import('./physics/loudspeaker.js');
    const { runPrecisionRender } = await import('./physics/precision/precision-engine.js');
    const materials = await loadMaterials();
    await Promise.all(SPEAKER_CATALOG.map(c => loadLoudspeaker(c.url)));
    if (state.sources.length === 0 && state.listeners.length === 0 && state.zones.length === 0) {
      applyPresetToState(DEFAULT_PRESET_KEY);
    }
    return runPrecisionRender({
      state, materials,
      getLoudspeakerDef: (url) => getCachedLoudspeaker(url),
      opts: { raysPerSource: 1000, maxBounces: 30, maxTimeMs: 1000, ...opts },
    });
  };
  if (new URLSearchParams(window.location.search).has('precision-demo')) {
    window.addEventListener('load', async () => {
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;inset:16px;z-index:9999;background:#0f1218;color:#cfd3d9;border:1px solid #3a5a8a;border-radius:8px;padding:16px;overflow:auto;font-family:monospace;font-size:12px;line-height:1.45;box-shadow:0 12px 40px rgba(0,0,0,0.6)';
      banner.innerHTML = '<div style="color:#4aa3ff;font-size:14px;margin-bottom:12px;">⏳ Running precision render — spawning workers…</div><div id="precision-progress" style="color:#89929d;"></div>';
      document.body.appendChild(banner);
      const progressEl = banner.querySelector('#precision-progress');
      const progressByWorker = new Map();
      try {
        const render = await window.__roomlabPrecisionRender({
          onProgress: (workerIdx, done, total) => {
            progressByWorker.set(workerIdx, { done, total });
            const entries = [...progressByWorker.entries()].sort((a, b) => a[0] - b[0]);
            progressEl.innerHTML = entries.map(([i, p]) =>
              `  worker ${i}: ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`
            ).join('<br>');
          },
        });
        const closeBtn = '<button style="position:absolute;top:8px;right:12px;background:#2a2f38;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;" onclick="this.parentElement.remove()">×</button>';
        const { hitCount, raysTraced, terminations, workerCount, elapsedMs } = render;
        const { deriveMetrics } = await import('./physics/precision/derive-metrics.js');
        const allMetrics = deriveMetrics(render);
        const m0 = allMetrics[0];
        const fmt2 = (v, decimals = 2, unit = '') =>
          Number.isFinite(v) ? `${v.toFixed(decimals)}${unit}` : '—';

        const summaryLines = [
          `<strong style="color:#4aa3ff;font-size:14px;">RoomLab precision render — ${render.generatedAt}</strong>`,
          closeBtn,
          '',
          '<strong style="color:#89c0ff">Pipeline</strong>',
          `  triangles:     ${render.soup.count.toLocaleString()}`,
          `  BVH nodes:     ${render.bvh.nodeCount.toLocaleString()}`,
          `  workers:       ${workerCount}`,
          `  rays traced:   ${raysTraced.toLocaleString()}`,
          `  ray hits:      ${hitCount.toLocaleString()}`,
          `  wall-clock:    ${elapsedMs.toFixed(0)} ms`,
          `  throughput:    ${(raysTraced / elapsedMs).toFixed(0)} rays/ms (${(raysTraced * 1000 / elapsedMs).toLocaleString()} rays/s)`,
          '',
          '<strong style="color:#89c0ff">Terminations</strong>',
          `  escaped:       ${terminations.escaped.toLocaleString()}`,
          `  energy cutoff: ${terminations.energy.toLocaleString()}`,
          `  bounce limit:  ${terminations.bounce.toLocaleString()}`,
          `  time out:      ${terminations.timeOut.toLocaleString()}`,
          '',
          `<strong style="color:#89c0ff">Metrics — receiver 0 (broadband)</strong>`,
          `  EDT:           ${fmt2(m0.broadband.edt_s, 2, ' s')}   <span style="color:#89929d">(early decay time, 0 to −10 dB)</span>`,
          `  T20:           ${fmt2(m0.broadband.t20_s, 2, ' s')}   <span style="color:#89929d">(reverb time, −5 to −25 dB × 3)</span>`,
          `  T30:           ${fmt2(m0.broadband.t30_s, 2, ' s')}   <span style="color:#89929d">(reverb time, −5 to −35 dB × 2)</span>`,
          `  C80:           ${fmt2(m0.broadband.c80_db, 1, ' dB')}  <span style="color:#89929d">(music clarity; 0 is neutral)</span>`,
          `  C50:           ${fmt2(m0.broadband.c50_db, 1, ' dB')}  <span style="color:#89929d">(speech clarity; +0 dB good)</span>`,
          `  D/R:           ${fmt2(m0.broadband.dr_db, 1, ' dB')}  <span style="color:#89929d">(direct-to-reverb, 10 ms window)</span>`,
          `  STI:           ${fmt2(m0.sti.sti, 3)}    <span style="color:#89929d">(full IR, 14 × 7 MTF; ≥0.60 good)</span>`,
          '',
          `<strong style="color:#89c0ff">T30 per band</strong>`,
          `  125 Hz: ${fmt2(m0.perBand[0].t30_s, 2, ' s')}   250 Hz: ${fmt2(m0.perBand[1].t30_s, 2, ' s')}   500 Hz: ${fmt2(m0.perBand[2].t30_s, 2, ' s')}   1 kHz: ${fmt2(m0.perBand[3].t30_s, 2, ' s')}`,
          `  2 kHz: ${fmt2(m0.perBand[4].t30_s, 2, ' s')}   4 kHz: ${fmt2(m0.perBand[5].t30_s, 2, ' s')}   8 kHz: ${fmt2(m0.perBand[6].t30_s, 2, ' s')}`,
          '',
          `<span style="color:#89929d">Note: low ray counts (${raysTraced.toLocaleString()}) give noisy late-tail metrics. Production UI (Phase E) defaults to 50k-500k rays.</span>`,
        ];
        banner.innerHTML = summaryLines.map(l => `<div>${l}</div>`).join('');
      } catch (err) {
        banner.innerHTML = `<div style="color:#ff6565;">Precision render failed: ${err?.message ?? err}</div>`;
        console.error('Precision render failed:', err);
      }
    });
  }
}
function fmt(v) { return v == null || !isFinite(v) ? '—' : (Math.round(v * 100) / 100).toString(); }
