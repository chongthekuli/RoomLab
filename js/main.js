import { state, SPEAKER_CATALOG, DEFAULT_PRESET_KEY, applyPresetToState } from './app-state.js';
import { loadMaterials } from './physics/materials.js';
import { loadLoudspeaker } from './physics/loudspeaker.js';
import { mountRoomPanel } from './ui/panel-room.js';
import { mountSourcesPanel } from './ui/panel-sources.js';
import { mountListenersPanel } from './ui/panel-listeners.js';
import { mountZonesPanel } from './ui/panel-zones.js';
import { mountAmbientPanel } from './ui/panel-ambient.js';
import { mountResultsPanel } from './ui/panel-results.js';
import { mountPrecisionPanel } from './ui/panel-precision.js';
import { mountWelcomeCard } from './ui/welcome-card.js';
import { mountSpeakerView } from './ui/speaker-detail.js';
import { mount2DViewport } from './graphics/room-2d.js';
import { mount3DViewport, toggleHeatmaps, toggleAimLines, toggleIsobars, toggleProbe, toggleReverbField, toggleHeatmapMode, setWalkthroughMode } from './graphics/scene.js';

function setupTabs() {
  const tabs = document.querySelectorAll('.vp-tab');
  const views = document.querySelectorAll('.viewport-view');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.view;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      // Walkthrough shares the 3D viewport container — it just swaps the
      // camera. Any view other than "walk" exits walkthrough mode.
      const visibleViewId = target === 'walk' ? 'view-3d' : `view-${target}`;
      views.forEach(v => { v.hidden = v.id !== visibleViewId; });
      setWalkthroughMode(target === 'walk');
      document.dispatchEvent(new CustomEvent('viewport:tab-changed', { detail: { view: target } }));
    });
  });

  const heatBtn = document.getElementById('toggle-heatmaps');
  // Isobars + Reverb field + STIPA mode are heatmap sub-options — when
  // the heatmap layer is hidden, they can't contribute anything visible,
  // so reflect that by greying them out. Priya called this out as HIGH
  // priority for the viewport toolbar.
  const heatmapDependents = () => ['toggle-isobars', 'toggle-reverb', 'toggle-stipa-mode']
    .map(id => document.getElementById(id)).filter(Boolean);
  const syncHeatmapDependents = () => {
    const on = !!state.display.showHeatmaps;
    for (const el of heatmapDependents()) el.disabled = !on;
  };
  if (heatBtn) {
    heatBtn.addEventListener('click', () => {
      toggleHeatmaps();
      heatBtn.classList.toggle('active', state.display.showHeatmaps);
      syncHeatmapDependents();
    });
  }
  syncHeatmapDependents();

  const aimBtn = document.getElementById('toggle-aim-lines');
  if (aimBtn) {
    aimBtn.addEventListener('click', () => {
      toggleAimLines();
      aimBtn.classList.toggle('active', state.display.showAimLines);
    });
  }

  const stipaBtn = document.getElementById('toggle-stipa-mode');
  if (stipaBtn) {
    stipaBtn.addEventListener('click', () => {
      toggleHeatmapMode();
      stipaBtn.classList.toggle('active', state.display.heatmapMode === 'stipa');
    });
  }

  const isoBtn = document.getElementById('toggle-isobars');
  if (isoBtn) {
    isoBtn.addEventListener('click', () => {
      toggleIsobars();
      isoBtn.classList.toggle('active', state.display.showIsobars);
    });
  }

  const probeBtn = document.getElementById('toggle-probe');
  if (probeBtn) {
    probeBtn.addEventListener('click', () => {
      toggleProbe();
      probeBtn.classList.toggle('active');
    });
  }

  const reverbBtn = document.getElementById('toggle-reverb');
  if (reverbBtn) {
    reverbBtn.addEventListener('click', () => {
      toggleReverbField();
      reverbBtn.classList.toggle('active', state.physics.reverberantField);
    });
  }

  // Help overlay — opens via ? key or the ? button in the viewport toolbar.
  const helpOverlay = document.getElementById('help-overlay');
  const openHelp = () => { if (helpOverlay) helpOverlay.hidden = false; };
  const closeHelp = () => { if (helpOverlay) helpOverlay.hidden = true; };
  document.getElementById('btn-show-help')?.addEventListener('click', openHelp);
  document.getElementById('btn-close-help')?.addEventListener('click', closeHelp);
  document.getElementById('btn-show-welcome')?.addEventListener('click', () => {
    closeHelp();
    mountWelcomeCard({ force: true });
  });
  helpOverlay?.addEventListener('click', e => { if (e.target === helpOverlay) closeHelp(); });

  // Derived helpers — also let Esc dismiss any transient state.
  const closeTransient = () => {
    closeHelp();
    // Draw-zone / draw-polygon modes cancel on Esc; room-2d owns that logic
    // and listens for the "draw:cancel" DOM event if the user emits one.
    document.dispatchEvent(new CustomEvent('ui:cancel'));
  };

  // Global keyboard shortcuts. Skip while the user is typing in an input —
  // modern pro-tool convention (Figma / Blender / DaVinci all do this).
  const isTypingTarget = (el) => {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  };

  // Priority: view-tab switches use the *tab* .click(); toggles use the
  // same .click() path so visual active state + logic stay in one place.
  const click = (id) => document.getElementById(id)?.click();
  const clickTab = (v) => document.querySelector(`.vp-tab[data-view="${v}"]`)?.click();

  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    // Ignore modifier-combined keys (except plain Shift, which some shortcuts
    // need to stay neutral on) so Ctrl/Cmd+L / browser shortcuts still work.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // While walkthrough mode owns WASD/Space/Shift/C/Z, the key handler in
    // third-person-controller.js processes them FIRST on keydown. We only
    // act on the keys that don't conflict: digits, toggle letters, ? / Esc.
    switch (e.key) {
      case '1': clickTab('2d'); e.preventDefault(); break;
      case '2': clickTab('3d'); e.preventDefault(); break;
      case '3': clickTab('walk'); e.preventDefault(); break;
      case 'h': case 'H': click('toggle-heatmaps'); e.preventDefault(); break;
      case 'i': case 'I': click('toggle-isobars'); e.preventDefault(); break;
      case 'm': case 'M': click('toggle-stipa-mode'); e.preventDefault(); break;
      case 'r': case 'R': click('toggle-reverb'); e.preventDefault(); break;
      case 'a': case 'A': click('toggle-aim-lines'); e.preventDefault(); break;
      case 'p': case 'P': click('toggle-probe'); e.preventDefault(); break;
      case '?':           openHelp(); e.preventDefault(); break;
      case 'Escape':      closeTransient(); break;
    }
  });
}

async function boot() {
  const materials = await loadMaterials();
  await Promise.all(SPEAKER_CATALOG.map(c => loadLoudspeaker(c.url)));

  // Pristine state → apply default preset
  if (state.sources.length === 0 && state.listeners.length === 0 && state.zones.length === 0) {
    applyPresetToState(DEFAULT_PRESET_KEY);
  }

  setupTabs();
  mountRoomPanel({ materials });
  mountSourcesPanel({ speakerCatalog: SPEAKER_CATALOG });
  mountListenersPanel();
  mountZonesPanel({ materials });
  mountAmbientPanel();
  mountResultsPanel({ materials });
  mountPrecisionPanel({ materials });
  mountSpeakerView();

  // "View specs" buttons on Source cards dispatch this synthetic event —
  // switch to the Speaker viewport tab so the user sees the detail view.
  document.addEventListener('viewport:show-speaker', () => {
    document.querySelector('.vp-tab[data-view="speaker"]')?.click();
  });
  mount2DViewport({ materials });

  try {
    await mount3DViewport({ materials });
  } catch (err) {
    console.error('3D viewport failed to mount:', err);
    const v3 = document.getElementById('view-3d');
    if (v3) v3.innerHTML = `<div class="viewport-2d"><div class="vp-header">3D view unavailable: ${err.message}</div></div>`;
  }

  // First-run onboarding — sticky-dismissed via localStorage so it appears
  // once and never again for returning users.
  mountWelcomeCard();
}

boot().catch(err => {
  console.error('RoomLAB boot failed', err);
  // Write the error to the VISIBLE viewport — if we wrote to the first
  // one we found (view-2d) when the user was on the 3D tab, the
  // "Loading 3D view…" placeholder would sit there forever while the
  // real error hid inside the unseen 2D tab. Check the visible one
  // first; fall back to anything we can find.
  const visible = [...document.querySelectorAll('.viewport-view')].find(el => !el.hidden);
  const vp = visible
    || document.getElementById('view-3d')
    || document.getElementById('view-2d');
  if (vp) vp.innerHTML = `<div class="viewport-2d"><div class="vp-header">Startup error: ${err.message}</div></div>`;
});

// Dev hook — Phase A5 worker-plumbing smoke test.
// Two ways to run:
//   (1) URL param:  …/RoomLab/?smoketest       (results shown in banner)
//   (2) Console:    await window.__roomlabWorkerSmoke()
// Driver lazy-loaded — zero bytes on default page load. See
// docs/DUAL-ENGINE-BLUEPRINT.md §6 Phase A5.
if (typeof window !== 'undefined') {
  window.__roomlabWorkerSmoke = async (opts) => {
    const mod = await import('./physics/precision/worker-smoke-driver.js');
    return mod.runWorkerSmokeTest(opts);
  };
  // Auto-run + visible banner when ?smoketest is present.
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

  // Phase B3b demo hook — real precision render on the current state.
  // URL: …/RoomLab/?precision-demo (auto-runs + visible banner)
  // Console: await window.__roomlabPrecisionRender()
  window.__roomlabPrecisionRender = async (opts) => {
    const { SPEAKER_CATALOG, applyPresetToState, DEFAULT_PRESET_KEY } = await import('./app-state.js');
    const { loadMaterials } = await import('./physics/materials.js');
    const { loadLoudspeaker, getCachedLoudspeaker } = await import('./physics/loudspeaker.js');
    const { runPrecisionRender } = await import('./physics/precision/precision-engine.js');
    // Ensure materials + speakers are loaded. `boot()` does this already
    // during normal page load but the demo may be invoked on a pristine
    // tab before the boot sequence completes.
    const materials = await loadMaterials();
    await Promise.all(SPEAKER_CATALOG.map(c => loadLoudspeaker(c.url)));
    // Apply auditorium preset if state is pristine.
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
        const { shape, bucketDtMs, maxTimeMs, hitCount, raysTraced, terminations, workerCount, elapsedMs } = render;
        // Phase C: derive time-domain metrics from the histogram.
        const { deriveMetrics } = await import('./physics/precision/derive-metrics.js');
        const allMetrics = deriveMetrics(render);
        const m0 = allMetrics[0];
        const fmt = (v, decimals = 2, unit = '') =>
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
          `  EDT:           ${fmt(m0.broadband.edt_s, 2, ' s')}   <span style="color:#89929d">(early decay time, 0 to −10 dB)</span>`,
          `  T20:           ${fmt(m0.broadband.t20_s, 2, ' s')}   <span style="color:#89929d">(reverb time, −5 to −25 dB × 3)</span>`,
          `  T30:           ${fmt(m0.broadband.t30_s, 2, ' s')}   <span style="color:#89929d">(reverb time, −5 to −35 dB × 2)</span>`,
          `  C80:           ${fmt(m0.broadband.c80_db, 1, ' dB')}  <span style="color:#89929d">(music clarity; 0 is neutral)</span>`,
          `  C50:           ${fmt(m0.broadband.c50_db, 1, ' dB')}  <span style="color:#89929d">(speech clarity; +0 dB good)</span>`,
          `  D/R:           ${fmt(m0.broadband.dr_db, 1, ' dB')}  <span style="color:#89929d">(direct-to-reverb, 10 ms window)</span>`,
          `  STI:           ${fmt(m0.sti.sti, 3)}    <span style="color:#89929d">(full IR, 14 × 7 MTF; ≥0.60 good)</span>`,
          '',
          `<strong style="color:#89c0ff">T30 per band</strong>`,
          `  125 Hz: ${fmt(m0.perBand[0].t30_s, 2, ' s')}   250 Hz: ${fmt(m0.perBand[1].t30_s, 2, ' s')}   500 Hz: ${fmt(m0.perBand[2].t30_s, 2, ' s')}   1 kHz: ${fmt(m0.perBand[3].t30_s, 2, ' s')}`,
          `  2 kHz: ${fmt(m0.perBand[4].t30_s, 2, ' s')}   4 kHz: ${fmt(m0.perBand[5].t30_s, 2, ' s')}   8 kHz: ${fmt(m0.perBand[6].t30_s, 2, ' s')}`,
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
