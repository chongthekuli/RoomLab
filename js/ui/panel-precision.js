// Panel: Precision Render
//
// Primary UI for the dual-engine's "precision" path. Draft acoustics run
// continuously; the precision engine runs only when the user clicks the
// Render button here. Produces time-domain metrics (EDT, T20, T30, C80,
// C50, D/R, STI from full IR) plus an echogram canvas for the selected
// listener.
//
// State integration:
//   • writes into state.results.precision on success
//   • marks state.results.engines.precision.staleAt when scene edits
//     invalidate the cached render (stale banner + re-render button)
//   • listener:selected re-renders the display against the new receiver
//     without re-running the trace

import { state, getSelectedListener } from '../app-state.js';
import { on, emit } from './events.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { runPrecisionRender } from '../physics/precision/precision-engine.js';
import { deriveMetrics } from '../physics/precision/derive-metrics.js';
import { applyGlossary } from './glossary.js';

let materialsRef;
let currentAbort = null;
const BAND_LABELS = ['125', '250', '500', '1k', '2k', '4k', '8k'];

export function mountPrecisionPanel({ materials }) {
  materialsRef = materials;
  const root = document.getElementById('panel-precision');
  if (!root) return;
  root.innerHTML = `
    <h2>Precision Render</h2>
    <div id="precision-body">
      <div class="precision-intro">
        Time-domain ray tracing. Computes EDT · T20/T30 · C80/C50 · D/R · STI plus the impulse-response echogram at the selected listener. Typical render 1–10 s on 8+ cores.
      </div>
      <div class="precision-controls">
        <label class="rays-label">Rays/source
          <input type="number" id="precision-rays" value="50000" min="1000" max="500000" step="5000" />
        </label>
        <button id="precision-render-btn" class="btn-render">Render</button>
        <button id="precision-cancel-btn" class="btn-cancel" hidden>Cancel</button>
      </div>
      <div id="precision-progress" class="precision-progress" hidden>
        <div class="progress-bar"><div class="progress-fill"></div></div>
        <div class="progress-text">Starting…</div>
      </div>
      <div id="precision-stale" class="precision-stale" hidden>
        <span>● Results are stale — scene changed since the last render.</span>
        <button id="precision-rerender-btn" class="btn-link">Re-render</button>
      </div>
      <div id="precision-results" class="precision-results" hidden></div>
      <canvas id="precision-echogram" class="precision-echogram" width="300" height="140" hidden></canvas>
      <div id="precision-error" class="precision-error" hidden></div>
    </div>
  `;

  root.querySelector('#precision-render-btn').addEventListener('click', runRender);
  root.querySelector('#precision-cancel-btn').addEventListener('click', cancelRender);
  root.querySelector('#precision-rerender-btn').addEventListener('click', runRender);

  // Any scene edit invalidates a cached render.
  on('room:changed', markStale);
  on('source:changed', markStale);
  on('source:model_changed', markStale);
  on('listener:changed', markStale);
  on('physics:eq_changed', markStale);
  // Ambient noise only changes derived STI, not the impulse response —
  // so the raw histogram stays valid, but the displayed metrics need to
  // re-derive. Re-render without marking stale.
  on('ambient:changed', () => { if (state.results.precision) renderResults(); });
  on('scene:reset', () => {
    state.results.precision = null;
    state.results.engines.precision.lastRun = null;
    state.results.engines.precision.staleAt = null;
    updateUI();
    emit('precision:changed');
  });
  // Listener selection changes only the displayed receiver, not the trace.
  on('listener:selected', () => {
    if (state.results.precision) renderResults();
  });
  updateUI();
}

async function runRender() {
  if (currentAbort) return;
  const raysInput = document.getElementById('precision-rays');
  const raysPerSource = Math.max(1000, Math.min(500000, parseInt(raysInput.value, 10) || 50000));
  raysInput.value = String(raysPerSource);

  currentAbort = new AbortController();
  const startedAt = performance.now();
  const progressMap = new Map();
  const errorEl = document.getElementById('precision-error');
  if (errorEl) errorEl.hidden = true;
  updateUI();

  try {
    const result = await runPrecisionRender({
      state,
      materials: materialsRef,
      getLoudspeakerDef: (url) => getCachedLoudspeaker(url),
      opts: {
        raysPerSource,
        maxBounces: 100,
        bucketDtMs: 2,
        maxTimeMs: 2000,
        airAbsorption: true,
        signal: currentAbort.signal,
        onProgress: (workerIdx, done, total) => {
          progressMap.set(workerIdx, { done, total });
          updateProgressBar(progressMap, startedAt);
        },
      },
    });
    if (currentAbort?.signal.aborted) return;
    state.results.precision = result;
    state.results.engines.precision.lastRun = result.generatedAt;
    state.results.engines.precision.staleAt = null;
    renderResults();
    emit('precision:changed');
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (!/cancel/i.test(msg)) {
      showError(msg);
      console.error('Precision render failed:', err);
    }
  } finally {
    currentAbort = null;
    updateUI();
  }
}

function cancelRender() {
  if (currentAbort) currentAbort.abort();
}

function markStale() {
  if (!state.results.precision) return;
  state.results.engines.precision.staleAt = Date.now();
  updateUI();
  emit('precision:changed');
}

function updateProgressBar(progressMap, startedAt) {
  const progressEl = document.getElementById('precision-progress');
  if (!progressEl) return;
  const fill = progressEl.querySelector('.progress-fill');
  const text = progressEl.querySelector('.progress-text');
  let totalDone = 0, totalRays = 0;
  for (const p of progressMap.values()) { totalDone += p.done; totalRays += p.total; }
  const pct = totalRays > 0 ? (totalDone / totalRays) * 100 : 0;
  const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
  if (fill) fill.style.width = `${pct.toFixed(1)}%`;
  if (text) text.textContent = `${pct.toFixed(0)}% · ${totalDone.toLocaleString()} / ${totalRays.toLocaleString()} rays · ${elapsed}s`;
}

function renderResults() {
  const result = state.results.precision;
  if (!result) return;
  const container = document.getElementById('precision-results');
  if (!container) return;

  // Which listener to show? Use the currently-selected one, fall back
  // to the first listener.
  const selected = getSelectedListener();
  const selectedIdx = selected ? state.listeners.findIndex(l => l.id === selected.id) : 0;
  if (selectedIdx < 0 || selectedIdx >= state.listeners.length) {
    container.innerHTML = `<div class="precision-hint">Select a listener to view its precision metrics.</div>`;
    return;
  }

  const allMetrics = deriveMetrics(result, {
    ambientNoise_per_band: state.physics.ambientNoise?.per_band,
  });
  const m = allMetrics[selectedIdx];
  if (!m) {
    container.innerHTML = `<div class="precision-hint">No metrics available — render has ${result.receivers?.count ?? state.listeners.length} receivers.</div>`;
    return;
  }

  const fmt = (v, d = 2, u = '') => Number.isFinite(v) ? `${v.toFixed(d)}${u}` : '—';
  const stiRating = stiRatingLabel(m.sti.sti);

  container.innerHTML = `
    <div class="precision-summary">
      <div class="precision-listener-line">
        For <strong>${escapeHtml(state.listeners[selectedIdx].label)}</strong>
      </div>
      <div class="precision-big-row">
        <div class="big-metric">
          <div class="big-val">${fmt(m.broadband.t30_s, 2)}</div>
          <div class="big-sub">s · <span data-gloss="t30">T30</span></div>
        </div>
        <div class="big-metric">
          <div class="big-val sti-${stiRating.klass}" data-gloss="sti">${fmt(m.sti.sti, 2)}</div>
          <div class="big-sub"><span data-gloss="sti">STI</span> · <span class="sti-${stiRating.klass}">${stiRating.label}</span></div>
        </div>
      </div>
      <table class="precision-table">
        <tr><th data-gloss="edt">EDT</th><td>${fmt(m.broadband.edt_s, 2, ' s')}</td>
            <th data-gloss="t20">T20</th><td>${fmt(m.broadband.t20_s, 2, ' s')}</td></tr>
        <tr><th data-gloss="c80">C80</th><td>${fmt(m.broadband.c80_db, 1, ' dB')}</td>
            <th data-gloss="c50">C50</th><td>${fmt(m.broadband.c50_db, 1, ' dB')}</td></tr>
        <tr><th data-gloss="dr">D/R</th><td>${fmt(m.broadband.dr_db, 1, ' dB')}</td>
            <th title="Expected direct-path arrival at this listener (closest source / c). C50 is ISO-defined on the [0, 50 ms] window — if direct > 50 ms, the metric is undefined by standard.">Direct</th><td>${fmt(m.broadband.directArrivalMs, 1, ' ms')}</td></tr>
      </table>
      <details class="precision-per-band">
        <summary>T30 per band · STI per band</summary>
        <table class="band-table">
          <thead><tr><th>Hz</th>${m.perBand.map((_, i) => `<th>${BAND_LABELS[i] ?? i}</th>`).join('')}</tr></thead>
          <tbody>
            <tr><th data-gloss="t30">T30</th>${m.perBand.map(b => `<td>${fmt(b.t30_s, 2)}</td>`).join('')}</tr>
            <tr><th data-gloss="c80">C80</th>${m.perBand.map(b => `<td>${fmt(b.c80_db, 1)}</td>`).join('')}</tr>
            <tr><th title="TI — per-band transmission index, weighted sum → STI">TI</th>${m.sti.tiPerBand.map(v => `<td>${fmt(v, 2)}</td>`).join('')}</tr>
          </tbody>
        </table>
      </details>
      <div class="precision-meta">
        ${result.raysTraced.toLocaleString()} rays · ${result.hitCount.toLocaleString()} hits · ${result.elapsedMs.toFixed(0)} ms · ${result.workerCount} workers · ${result.soup.count} tris
      </div>
    </div>
  `;
  drawEchogram(result, selectedIdx);
  applyGlossary(container);
}

function drawEchogram(result, receiverIdx) {
  const canvas = document.getElementById('precision-echogram');
  if (!canvas) return;
  canvas.hidden = false;
  const ctx = canvas.getContext('2d');
  // Match CSS dimensions if any future resize changes them.
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#0a0d12';
  ctx.fillRect(0, 0, W, H);

  const { histogram, shape, bucketDtMs } = result;
  const { bands: B, buckets: T } = shape;
  // Broadband = sum over bands for this receiver.
  const bb = new Float32Array(T);
  const base = receiverIdx * B * T;
  for (let b = 0; b < B; b++) {
    const bOff = base + b * T;
    for (let t = 0; t < T; t++) bb[t] += histogram[bOff + t];
  }

  // Peak for dB normalization.
  let peak = 0;
  for (let t = 0; t < T; t++) if (bb[t] > peak) peak = bb[t];
  if (peak <= 0) {
    ctx.fillStyle = '#89929d';
    ctx.font = '11px monospace';
    ctx.fillText('No receiver hits — increase ray count', 10, H / 2);
    return;
  }

  // Draw grid.
  const dbRange = 60;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(90, 122, 176, 0.15)';
  ctx.fillStyle = '#5a616a';
  ctx.font = '9px monospace';
  ctx.textBaseline = 'bottom';
  for (const db of [-10, -20, -30, -40, -50]) {
    const y = H - (1 + db / dbRange) * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText(`${db}`, 2, y - 1);
  }
  ctx.textBaseline = 'alphabetic';
  for (const ms of [200, 500, 1000, 1500]) {
    const bucket = ms / bucketDtMs;
    if (bucket >= T) continue;
    const x = (bucket / T) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(`${ms}ms`, x + 2, H - 2);
  }

  // Plot IR in dB, clipped to [-60, 0].
  ctx.strokeStyle = '#4aa3ff';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  let started = false;
  for (let t = 0; t < T; t++) {
    const v = bb[t];
    if (v <= 0) continue;
    const db = 10 * Math.log10(v / peak);
    if (db < -dbRange) continue;
    const x = (t / T) * W;
    const y = H - (1 + db / dbRange) * H;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Peak marker.
  ctx.fillStyle = '#e9c46a';
  ctx.font = '9px monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(`peak 0 dB · ${((bb.indexOf(peak) * bucketDtMs)).toFixed(0)}ms`, W - 100, 2);
}

function updateUI() {
  const progressEl = document.getElementById('precision-progress');
  const resultsEl = document.getElementById('precision-results');
  const echogramEl = document.getElementById('precision-echogram');
  const staleEl = document.getElementById('precision-stale');
  const renderBtn = document.getElementById('precision-render-btn');
  const cancelBtn = document.getElementById('precision-cancel-btn');

  const inProgress = !!currentAbort;
  const hasResult = !!state.results.precision;
  const isStale = hasResult && !!state.results.engines.precision.staleAt;

  if (progressEl) progressEl.hidden = !inProgress;
  if (renderBtn) renderBtn.hidden = inProgress;
  if (cancelBtn) cancelBtn.hidden = !inProgress;
  if (resultsEl) resultsEl.hidden = !hasResult || inProgress;
  if (echogramEl) echogramEl.hidden = !hasResult || inProgress;
  if (staleEl) staleEl.hidden = !isStale || inProgress;
}

function showError(msg) {
  const err = document.getElementById('precision-error');
  if (!err) return;
  err.textContent = `Render failed: ${msg}`;
  err.hidden = false;
  setTimeout(() => { err.hidden = true; }, 10_000);
}

function stiRatingLabel(sti) {
  if (sti >= 0.75) return { klass: 'excellent', label: 'excellent' };
  if (sti >= 0.60) return { klass: 'good',      label: 'good' };
  if (sti >= 0.45) return { klass: 'fair',      label: 'fair' };
  if (sti >= 0.30) return { klass: 'poor',      label: 'poor' };
  return { klass: 'bad', label: 'bad' };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
