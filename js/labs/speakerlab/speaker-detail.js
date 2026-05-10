// Speaker detail view — full-specs + polar patterns + expert flags for
// a single loudspeaker. The main content of SpeakerLAB. Driven by a
// SpeakerLAB-local `state.selectedSpeakerUrl` so the module stays free
// of RoomLAB scene-state coupling.

import { SPEAKER_CATALOG } from '../../shared/speaker-catalog.js';
import { on, emit } from '../../shared/events.js';
import { getCachedLoudspeaker, loadLoudspeaker, interpolateAttenuation, registerLoudspeaker } from '../../physics/loudspeaker.js';
import { analyseSpeaker, estimateNominalDispersion, onAxisResponseDb, csdPerBand } from '../../physics/speaker-expert.js';
import { importSpeakerFile, GLL_GUIDE } from '../../physics/speaker-import.js';
import { mountSpeaker3DPreview } from './speaker-3d-preview.js';
import { bindLab } from '../../shared/lab-storage.js';

// SpeakerLAB-namespaced lab storage. Persists `selectedSpeakerUrl` and
// the polar-band tab index so navigating to RoomLAB and back lands
// the user back on the speaker they were studying. The boot script
// can override selectedSpeakerUrl with a ?model= URL param.
const lab = bindLab('speakerlab');

// SpeakerLAB-local state. Currently just the active speaker URL —
// future iterations can add comparison pins, library tags, custom
// collections etc. Exported so the boot script (main.js) can seed
// selectedSpeakerUrl from the URL's ?model= query param before the
// first render().
export const state = { selectedSpeakerUrl: null };

// Imported speakers live here. URL of each imported file is a synthetic
// `imported:<id>` token; the in-memory cache of loudspeaker.js stores the
// actual definition under that key so interpolateAttenuation keeps working.
const importedCatalog = new Map();

const BAND_KEYS = ['125', '250', '500', '1000', '2000', '4000', '8000'];
const BAND_LABELS = ['125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz'];
const DB_RINGS = [0, -6, -10, -15, -20];  // polar chart concentric rings

// Default 1 kHz; restored from lab storage at mount time below.
let currentFreqIdx = 3;

export function mountSpeakerView() {
  const root = document.getElementById('view-speaker');
  if (!root) return;
  // P4.7 — centre view is just the workbench head + body. Catalogue
  // renders directly into the left-rail #panel-catalogue (renderCatalog
  // targets that element), no #sv-catalog wrapper needed in the centre.
  root.innerHTML = `
    <div class="speaker-view">
      <div class="sv-main">
        <div class="sv-head">
          <div class="sv-title" id="sv-title"></div>
          <div class="sv-actions">
            <button id="sv-import" class="btn-import-spec" title="Import a CLF / JSON / EASE XML speaker file">⇪ Import speaker file…</button>
            <input type="file" id="sv-file" accept=".json,.clf,.xhn,.xml,.gll" hidden />
          </div>
        </div>
        <div id="sv-import-status" class="sv-import-status" hidden></div>
        <div id="sv-body" class="sv-body">
          <div class="sv-empty">
            <h3>Loudspeaker workbench</h3>
            <p>Open the <strong>Catalogue</strong> rail icon on the left to pick a speaker, or click a speaker in the 3D view of RoomLAB to deep-link here.</p>
            <p>Or <strong>import a file</strong> (top-right) to add a new model to the catalogue:</p>
            <ul>
              <li><strong>.json</strong> — RoomLAB / EASE-JSON</li>
              <li><strong>.clf</strong> — Common Loudspeaker Format (AES CLF TC)</li>
              <li><strong>.xhn</strong> / <strong>.xml</strong> — EASE SpeakerLab text export</li>
              <li><strong>.gll</strong> — not browser-parseable; see the prompt on import.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  `;

  root.querySelector('#sv-import').addEventListener('click', () => {
    root.querySelector('#sv-file').click();
  });
  root.querySelector('#sv-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleImport(file);
    e.target.value = '';
  });

  // Restore selection + freq tab from lab storage UNLESS main.js has
  // already seeded selectedSpeakerUrl from the ?model= URL param (a
  // deep-link from RoomLAB's "View specs" buttons should always win).
  if (!state.selectedSpeakerUrl) {
    const savedUrl = lab.read('selectedSpeakerUrl');
    if (typeof savedUrl === 'string' && savedUrl.length > 0) {
      state.selectedSpeakerUrl = savedUrl;
    }
  }
  const savedFreq = lab.read('freqIdx');
  if (Number.isInteger(savedFreq) && savedFreq >= 0 && savedFreq < BAND_KEYS.length) {
    currentFreqIdx = savedFreq;
  }

  // The only event SpeakerLAB needs to react to is its own selection
  // change (catalogue card click → state.selectedSpeakerUrl = ... →
  // emit('speaker:selected') → re-render). RoomLAB's source:changed /
  // room:changed / scene:reset events don't exist in this Lab.
  on('speaker:selected', () => {
    lab.write('selectedSpeakerUrl', state.selectedSpeakerUrl);
    render();
  });

  render();
}

async function render() {
  const root = document.getElementById('view-speaker');
  if (!root) return;
  const body = root.querySelector('#sv-body');
  const title = root.querySelector('#sv-title');

  renderCatalog();

  const url = state.selectedSpeakerUrl;
  if (!url) {
    title.textContent = 'No speaker selected';
    // Leave the empty-state HTML in place.
    return;
  }

  // Resolve the def — might be in cache, might be imported, might need loading.
  let def = getCachedLoudspeaker(url) || importedCatalog.get(url);
  if (!def) {
    try { def = await loadLoudspeaker(url); } catch (_) { /* fallthrough */ }
  }
  if (!def) {
    title.textContent = 'Speaker not found';
    body.innerHTML = `<div class="sv-empty"><h3>Definition missing</h3><p>Could not load <code>${escapeHtml(url)}</code>.</p></div>`;
    return;
  }

  title.innerHTML = `
    <div class="sv-brand">${escapeHtml(def.manufacturer ?? 'Unknown')}</div>
    <div class="sv-model">${escapeHtml(def.model ?? 'Imported speaker')}</div>
    ${def.note ? `<div class="sv-note">${escapeHtml(def.note)}</div>` : ''}
  `;

  // No room context in SpeakerLAB — the analysis function gracefully
  // omits room-dependent flags when room is undefined.
  const flags = analyseSpeaker(def, {});
  const dispersion = estimateNominalDispersion(def);
  const onAxis = onAxisResponseDb(def);

  const dim = def.physical?.dimensions_m || {};
  const dimVol = (dim.w && dim.h && dim.d) ? (dim.w * dim.h * dim.d * 1000) : null;
  const bandsMeasured = def.directivity?.attenuation_db ? Object.keys(def.directivity.attenuation_db).map(Number).sort((a,b)=>a-b) : [];
  const azs = def.directivity?.azimuth_deg || [];
  const els = def.directivity?.elevation_deg || [];
  const sampleCount = bandsMeasured.length * azs.length * els.length;

  body.innerHTML = `
    <div class="sv-grid">
      <section class="sv-card">
        <h4>Metadata</h4>
        ${specRow('Model ID', def.id ?? '—')}
        ${specRow('Manufacturer', def.manufacturer ?? '—')}
        ${specRow('Model', def.model ?? '—')}
        ${specRow('Schema', def.schema_version ? `v${def.schema_version}` : '—')}
        ${specRow('License', def.license ?? '—')}
        ${def.importedFrom ? specRow('Imported from', def.importedFrom) : ''}
      </section>
      <section class="sv-card">
        <h4>Physical</h4>
        ${specRow('Width', dim.w != null ? `${numFmt(dim.w, 3)} m` : '—')}
        ${specRow('Height', dim.h != null ? `${numFmt(dim.h, 3)} m` : '—')}
        ${specRow('Depth', dim.d != null ? `${numFmt(dim.d, 3)} m` : '—')}
        ${specRow('Volume', dimVol != null ? `${numFmt(dimVol, 1)} L` : '—')}
        ${specRow('Weight', def.physical?.weight_kg != null ? `${numFmt(def.physical.weight_kg, 1)} kg` : '—')}
      </section>
      <section class="sv-card">
        <h4>Electrical</h4>
        ${specRow('Nominal Z', def.electrical?.nominal_impedance_ohm != null ? `${def.electrical.nominal_impedance_ohm} Ω` : '—')}
        ${specRow('Max input (RMS)', def.electrical?.max_input_watts != null ? `${def.electrical.max_input_watts} W` : '—')}
        ${specRow('Max SPL @ 1 m', def.electrical?.max_spl_db != null ? `${def.electrical.max_spl_db.toFixed(0)} dB` : '—')}
        ${specRow('Headroom vs 1 W', def.acoustic?.sensitivity_db_1w_1m != null && def.electrical?.max_spl_db != null
          ? `${(def.electrical.max_spl_db - def.acoustic.sensitivity_db_1w_1m).toFixed(1)} dB` : '—')}
      </section>
      <section class="sv-card">
        <h4>Acoustic</h4>
        ${specRow('Sensitivity', def.acoustic?.sensitivity_db_1w_1m != null ? `${def.acoustic.sensitivity_db_1w_1m.toFixed(1)} dB @ 1 W / 1 m` : '—')}
        ${specRow('Directivity Index', def.acoustic?.directivity_index_db != null ? `${def.acoustic.directivity_index_db.toFixed(1)} dB` : '—')}
        ${specRow('LF limit', def.acoustic?.frequency_range_hz ? `${def.acoustic.frequency_range_hz[0]} Hz` : '—')}
        ${specRow('HF limit', def.acoustic?.frequency_range_hz ? `${def.acoustic.frequency_range_hz[1]} Hz` : '—')}
        ${specRow('H dispersion', dispersion ? `${dispersion.h.toFixed(0)}° (−6 dB @ 1 kHz)` : '—')}
        ${specRow('V dispersion', dispersion ? `${dispersion.v.toFixed(0)}° (−6 dB @ 1 kHz)` : '—')}
      </section>
      <section class="sv-card">
        <h4>Directivity data</h4>
        ${specRow('Bands measured', bandsMeasured.length ? bandsMeasured.map(f => f >= 1000 ? `${f/1000}k` : `${f}`).join(' · ') : '—')}
        ${specRow('Azimuth grid', azs.length ? `${azs.length} pts (${azs[0]}° → ${azs[azs.length-1]}°)` : '—')}
        ${specRow('Elevation grid', els.length ? `${els.length} pts (${els[0]}° → ${els[els.length-1]}°)` : '—')}
        ${specRow('Angular resolution', def.directivity?.angular_resolution_deg != null ? `${def.directivity.angular_resolution_deg}°` : '—')}
        ${specRow('Total samples', sampleCount > 0 ? sampleCount.toLocaleString() : '—')}
      </section>
      <section class="sv-card">
        <h4>Default placement</h4>
        ${specRow('Position', def.placement?.position_m
          ? `(${numFmt(def.placement.position_m.x, 2)}, ${numFmt(def.placement.position_m.y, 2)}, ${numFmt(def.placement.position_m.z, 2)}) m` : '—')}
        ${specRow('Aim', def.placement?.aim_deg
          ? `yaw ${def.placement.aim_deg.yaw}° · pitch ${def.placement.aim_deg.pitch}° · roll ${def.placement.aim_deg.roll}°` : '—')}
      </section>
    </div>

    <section class="sv-3d-stage">
      <canvas id="sv-3d-canvas" width="640" height="360"></canvas>
      <div class="sv-3d-caption">Drag to rotate · right-drag to pan · scroll to zoom · drivers pulse at representative speed for their passband. Auto-rotates when idle.</div>
    </section>

    ${def.note ? `<div class="sv-designer-note">${escapeHtml(def.note)}</div>` : ''}

    <section class="sv-section">
      <h4>On-axis frequency response</h4>
      <canvas id="sv-fr" width="960" height="240"></canvas>
      <div class="sub sv-caption">dB SPL @ 1 W / 1 m, log-frequency 20 Hz – 20 kHz, on-axis (az 0°, el 0°). Markers = measured octave bands.</div>
    </section>

    <section class="sv-section">
      <div class="sv-polar-head">
        <h4>Polar patterns</h4>
        <div class="sv-polar-freqs">
          ${BAND_LABELS.map((lab, i) =>
            `<button class="sv-freq-btn${i === currentFreqIdx ? ' active' : ''}" data-freq-idx="${i}">${lab}</button>`
          ).join('')}
        </div>
      </div>
      <div class="sv-polar-pair">
        <div class="sv-polar-col">
          <div class="sv-polar-label">Horizontal (H plane)</div>
          <canvas id="sv-polar-h" width="320" height="320"></canvas>
        </div>
        <div class="sv-polar-col">
          <div class="sv-polar-label">Vertical (V plane)</div>
          <canvas id="sv-polar-v" width="320" height="320"></canvas>
        </div>
      </div>
      <div class="sub sv-caption">Grid rings mark 0 / −6 / −10 / −15 / −20 dB. Centre = on-axis.</div>
    </section>

    <section class="sv-section">
      <h4>Directivity waterfall (amplitude × frequency × angle)</h4>
      <canvas id="sv-waterfall" width="760" height="420"></canvas>
      <div class="sub sv-caption">3D surface plot of the horizontal polar response: X = frequency (log, 125 Hz → 20 kHz), depth = azimuth angle (−110° at back, +110° at front, on-axis in the middle), Z = SPL in dB. A warm-red ridge running along the middle depth is the on-axis response; the surface tapers toward cool blue at ±110°. A wide ridge = wide pattern; a narrow ridge concentrated at 0° = directive cabinet.</div>
    </section>

    <section class="sv-section">
      <h4>Expert review</h4>
      <div class="sv-flags">
        ${flags.map(f => `<div class="sv-flag sv-flag-${f.kind}">${escapeHtml(f.text)}</div>`).join('')}
      </div>
    </section>
  `;

  // Wire frequency selector.
  for (const btn of body.querySelectorAll('.sv-freq-btn')) {
    btn.addEventListener('click', () => {
      currentFreqIdx = Number(btn.dataset.freqIdx);
      lab.write('freqIdx', currentFreqIdx);
      render();
    });
  }

  drawFrCanvas(body.querySelector('#sv-fr'), onAxis, def);
  drawPolarCanvas(body.querySelector('#sv-polar-h'), def, BAND_KEYS[currentFreqIdx], 'h');
  drawPolarCanvas(body.querySelector('#sv-polar-v'), def, BAND_KEYS[currentFreqIdx], 'v');
  drawWaterfall(body.querySelector('#sv-waterfall'), def, onAxis);

  // Animated 3D preview — mounts after the HTML is committed so the
  // canvas has its layout-resolved dimensions. We don't remount on
  // freq-selector clicks (same def), only when the speaker changes.
  const stageCanvas = body.querySelector('#sv-3d-canvas');
  if (stageCanvas) mountSpeaker3DPreview(stageCanvas, def);

  // P4.6 — relocate the spec sections out of the centre #sv-body into
  // their dedicated right-rail panels. The centre keeps ONLY the 3D
  // preview (#sv-3d-stage) so the speaker rendering is the headline
  // visual, full-bleed. Each section moves to its own rail panel —
  // user clicks the rail icon to slide it out as a glass overlay.
  // Order in #sv-body after render:
  //   .sv-grid                         → panel-specs
  //   .sv-3d-stage                     → STAYS in #sv-body (centre)
  //   .sv-designer-note (optional)     → STAYS (small, with preview)
  //   .sv-section "On-axis frequency"  → panel-frequency
  //   .sv-section "Polar patterns"     → panel-polar
  //   .sv-section "Directivity waterfall" → panel-waterfall
  //   .sv-section "Expert review"      → panel-specs (appended)
  relocateSpecSections(body);
}

function relocateSpecSections(body) {
  const grid = body.querySelector('.sv-grid');
  const sections = body.querySelectorAll('.sv-section');
  // Sections are rendered in fixed order; index-based mapping is safe.
  // [0] frequency, [1] polar, [2] waterfall, [3] expert review
  const [secFreq, secPolar, secWaterfall, secReview] = sections;
  const targets = {
    specs: document.getElementById('panel-specs'),
    frequency: document.getElementById('panel-frequency'),
    polar: document.getElementById('panel-polar'),
    waterfall: document.getElementById('panel-waterfall'),
  };
  if (targets.specs) {
    targets.specs.innerHTML = '<h2>Specs</h2>';
    if (grid) targets.specs.appendChild(grid);
    if (secReview) targets.specs.appendChild(secReview);
  }
  if (targets.frequency) {
    targets.frequency.innerHTML = '<h2>Frequency response</h2>';
    if (secFreq) targets.frequency.appendChild(secFreq);
  }
  if (targets.polar) {
    targets.polar.innerHTML = '<h2>Polar plots</h2>';
    if (secPolar) targets.polar.appendChild(secPolar);
  }
  if (targets.waterfall) {
    targets.waterfall.innerHTML = '<h2>Directivity waterfall</h2>';
    if (secWaterfall) targets.waterfall.appendChild(secWaterfall);
  }
}

async function handleImport(file) {
  const status = document.getElementById('sv-import-status');
  status.hidden = false;
  status.className = 'sv-import-status';
  status.textContent = `Reading ${file.name}…`;
  try {
    const def = await importSpeakerFile(file);
    const url = `imported:${def.id || file.name}`;
    importedCatalog.set(url, def);
    // Shared physics cache — so heatmap + STIPA + precision all resolve
    // the imported def by URL, identical to catalogue entries.
    registerLoudspeaker(url, def);
    // Runtime catalogue extension — surfaces in every Sources panel
    // "Model" dropdown.
    if (!SPEAKER_CATALOG.some(c => c.url === url)) {
      SPEAKER_CATALOG.push({ url, label: `${def.manufacturer ?? 'Imported'} — ${def.model ?? file.name}` });
    }
    state.selectedSpeakerUrl = url;
    emit('speaker:selected');
    emit('source:model_changed');   // Sources panel re-renders with the new entry
    status.classList.add('ok');
    status.textContent = `Loaded ${def.manufacturer ?? ''} ${def.model ?? file.name}. Select it from the Sources panel "Model" dropdown to use it.`;
  } catch (err) {
    status.classList.add(err.kind === 'gll' ? 'info' : 'err');
    // Preserve whitespace so the GLL guide reads well.
    status.innerHTML = `<pre class="sv-err-pre">${escapeHtml(err.message)}</pre>`;
  }
}

// Render the left-side catalogue listing every available model. Clicking
// an entry swaps state.selectedSpeakerUrl; we rerender, which paints
// the workbench body and highlights the active card in the catalogue.
function renderCatalog() {
  // P4.7 — render DIRECTLY into the rail panel. Eliminates the
  // relocation-dependency that the previous P4.5/P4.6 had — a stale
  // ES-module-cached speaker-detail.js could skip the relocation
  // step and leave the catalogue empty.
  const host = document.getElementById('panel-catalogue');
  if (!host) return;
  const active = state.selectedSpeakerUrl;

  // Synchronous summary — read from the already-loaded cache; anything
  // not yet loaded shows a "—" until its card is clicked and resolved.
  const cards = SPEAKER_CATALOG.map(entry => {
    const def = getCachedLoudspeaker(entry.url);
    const summary = def ? [
      def.acoustic?.sensitivity_db_1w_1m != null ? `${def.acoustic.sensitivity_db_1w_1m.toFixed(0)} dB/W` : null,
      def.electrical?.max_spl_db != null ? `${def.electrical.max_spl_db.toFixed(0)} dB max` : null,
      def.acoustic?.directivity_index_db != null ? `DI ${def.acoustic.directivity_index_db.toFixed(1)}` : null,
    ].filter(Boolean).join(' · ') : 'loading…';
    const label = def?.model ?? entry.label ?? entry.url;
    const brand = def?.manufacturer ?? '';
    const isActive = entry.url === active;
    return `
      <div class="sv-cat-card${isActive ? ' active' : ''}" data-cat-url="${escapeHtml(entry.url)}" tabindex="0">
        <div class="sv-cat-brand">${escapeHtml(brand)}</div>
        <div class="sv-cat-model">${escapeHtml(label)}</div>
        <div class="sv-cat-summary">${escapeHtml(summary)}</div>
      </div>
    `;
  }).join('');

  host.innerHTML = `
    <h2>Catalogue</h2>
    <div class="sv-cat-head">Models <span class="sv-cat-count">${SPEAKER_CATALOG.length}</span></div>
    ${cards || '<div class="sv-cat-empty">No speakers yet — import one above.</div>'}
  `;
  for (const card of host.querySelectorAll('.sv-cat-card')) {
    card.addEventListener('click', () => {
      state.selectedSpeakerUrl = card.dataset.catUrl;
      emit('speaker:selected');
    });
  }
}

// ---------- canvas helpers ----------

function drawFrCanvas(canvas, onAxis, def) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // DPR-aware crisp rendering. The canvas's CSS width is 100% of the
  // section column (often 1300+ px on a wide viewport); without this
  // scaling step the browser would blit the 960-px bitmap up 1.5–2×
  // with bilinear interpolation, hence the user's "low resolution"
  // complaint. Resize the bitmap to match displayed pixels exactly.
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  const w = cssW, h = cssH;
  const padL = 44, padR = 20, padT = 18, padB = 32;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  ctx.clearRect(0, 0, w, h);

  const sens = def.acoustic?.sensitivity_db_1w_1m ?? 90;

  // Adaptive Y range — bound to the actual data plus a sensible
  // baseline reference (sens-20 to sens+10) so a flat speaker still
  // shows breathing room while a real driver with -25 dB rolloff
  // doesn't get clipped off the bottom. Round outward to nearest
  // 5 dB for clean grid labels.
  const dbValues = onAxis.map(p => sens + p.db).filter(Number.isFinite);
  const dataMin = Math.min(sens - 20, ...dbValues);
  const dataMax = Math.max(sens + 10, ...dbValues);
  const yMin = Math.floor((dataMin - 3) / 5) * 5;
  const yMax = Math.ceil((dataMax + 3) / 5) * 5;

  // Full audio band 20 Hz – 20 kHz on a log axis.
  const xMin = Math.log10(20), xMax = Math.log10(20000);
  const xOf = (hz) => padL + ((Math.log10(hz) - xMin) / (xMax - xMin)) * plotW;
  const yOf = (db) => padT + plotH - ((db - yMin) / (yMax - yMin)) * plotH;

  // Y grid (5 dB rows). Right-aligned labels in the left gutter so
  // 2-digit and 3-digit values (e.g. 65 vs 105) align cleanly and
  // don't crowd the leftmost gridline.
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let db = Math.ceil(yMin / 5) * 5; db <= yMax; db += 5) {
    const y = yOf(db);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = 'rgba(200,210,220,0.6)';
    ctx.fillText(`${db}`, padL - 6, y);
  }
  // X grid — every octave from 20 Hz to 20 kHz. Labels only on key
  // anchors so the axis row doesn't crowd. The first / last ticks
  // are pulled inward (textAlign start/end) so "20" doesn't slip
  // past the chart's left edge and "20k" stays inside the right
  // edge — fixes the "20" running into the "Hz" unit.
  ctx.textBaseline = 'top';
  const octaves = [20, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 20000];
  const labelHz = new Set([20, 50, 100, 500, 1000, 5000, 10000, 20000]);
  const allTicks = [...octaves, 50, 100];
  for (const hz of allTicks) {
    if (hz < 20 || hz > 20000) continue;
    const x = xOf(hz);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    if (labelHz.has(hz)) {
      ctx.fillStyle = 'rgba(200,210,220,0.7)';
      const txt = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
      // Anchor the first/last labels to the chart edge so the
      // string doesn't bleed past the plot area.
      if (hz === 20)        ctx.textAlign = 'left';
      else if (hz === 20000) ctx.textAlign = 'right';
      else                   ctx.textAlign = 'center';
      ctx.fillText(txt, x, padT + plotH + 8);
    }
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';

  // Plot border
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.strokeRect(padL, padT, plotW, plotH);

  // Clip to plot area so any out-of-range data point doesn't ink
  // outside the chart.
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, plotW, plotH);
  ctx.clip();

  // Curve.
  ctx.strokeStyle = '#74d0ff';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  let started = false;
  for (const p of onAxis) {
    const db = sens + p.db;
    if (!Number.isFinite(p.hz) || !Number.isFinite(db)) continue;
    const x = xOf(p.hz);
    const y = yOf(db);
    if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
  }
  ctx.stroke();

  // Marker dots at each measured band.
  ctx.fillStyle = '#74d0ff';
  for (const p of onAxis) {
    const db = sens + p.db;
    if (!Number.isFinite(p.hz) || !Number.isFinite(db)) continue;
    ctx.beginPath();
    ctx.arc(xOf(p.hz), yOf(db), 3, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.restore();
  // Axis units are conveyed by the section heading + the .sv-caption
  // subtitle below the canvas — no inline labels to fight tick text.
}

function drawPolarCanvas(canvas, def, bandKey, plane) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // DPR-aware crisp rendering — same fix as the FR chart.
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  const w = cssW, h = cssH;
  const cx = w / 2, cy = h / 2;
  // Reserve more margin on the right (dB ring labels live there) and
  // top (the "0°" cardinal label lives there). Without this padding
  // the right-edge ring labels (-6 / -10 / -15 / -20) collide with
  // the chart border and the "180°" label dives off the bottom.
  const maxR = Math.min(cx, cy) - 28;
  ctx.clearRect(0, 0, w, h);

  // Rings — pull dB labels into the right-edge gutter at one fixed
  // y per label, vertically separated, so they don't all stack on
  // the cy line.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const db of DB_RINGS) {
    const r = maxR * (1 - db / -20);
    if (r <= 0) continue;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillStyle = 'rgba(200,210,220,0.55)';
    // Label sits just inside the ring, slightly above the centre line
    // so 0 / -6 / -10 / -15 / -20 stack down vertically (one per ring).
    ctx.fillText(`${db}`, cx + r - 14, cy - 6);
  }
  // Cross-hairs every 30°
  for (let a = 0; a < 360; a += 30) {
    const rad = a * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * maxR, cy + Math.sin(rad) * maxR);
    ctx.stroke();
  }

  // Cardinal labels — placed precisely outside the outer ring with
  // proper text-align/baseline so "−90°" and "180°" don't clip the
  // canvas edge or overlap the ring labels.
  ctx.fillStyle = 'rgba(200,210,220,0.7)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';   ctx.textBaseline = 'bottom';
  ctx.fillText('0°', cx, cy - maxR - 4);
  ctx.textAlign = 'center';   ctx.textBaseline = 'top';
  ctx.fillText('180°', cx, cy + maxR + 4);
  ctx.textAlign = 'left';     ctx.textBaseline = 'middle';
  ctx.fillText('90°', cx + maxR + 4, cy);
  ctx.textAlign = 'right';    ctx.textBaseline = 'middle';
  ctx.fillText('−90°', cx - maxR - 4, cy);
  ctx.textAlign = 'start';    ctx.textBaseline = 'alphabetic';

  // Sample directivity every 2° and draw the pattern
  const grid = def.directivity?.attenuation_db?.[bandKey] || def.directivity?.attenuation_db?.['1000'];
  if (!grid) return;

  ctx.strokeStyle = '#ffcc5a';
  ctx.fillStyle = 'rgba(255,204,90,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let first = true;
  for (let deg = 0; deg < 360; deg += 2) {
    // In the pattern's local frame, 0° points forward (+Y in state coords,
    // equivalent to azimuth 0°). We wrap deg into the ±180 convention of
    // the grid.
    const rel = deg <= 180 ? deg : deg - 360;
    // H plane: elevation=0, azimuth sweeps. V plane: azimuth=0, elevation
    // sweeps (with nose at 0° elevation).
    const az = plane === 'h' ? rel : 0;
    const el = plane === 'v' ? rel : 0;
    const att_db = interpolateAttenuation(def.directivity, az, el, Number(bandKey));
    // r maps 0 dB → maxR, −20 dB → 0; clamp.
    const clamped = Math.max(-20, att_db);
    const r = maxR * (1 - clamped / -20);
    // Screen angle: 0° = straight up (forward). Clockwise.
    const screenRad = (deg - 90) * Math.PI / 180;
    const x = cx + Math.cos(screenRad) * r;
    const y = cy + Math.sin(screenRad) * r;
    if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Frequency badge — top-right of the canvas. Was bottom-left, but
  // that line was where "180°" sits, so the two collided every time.
  ctx.fillStyle = 'rgba(200,210,220,0.9)';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  const label = bandKey >= 1000 ? `${bandKey / 1000} kHz` : `${bandKey} Hz`;
  ctx.fillText(label, w - 4, 4);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

// Waterfall (cumulative spectral decay) — heatmap with frequency on X
// (log), time on Y (ms down), colour = energy in dB. Built from the FR
// curve as initial levels at t=0 and per-band exponential decay rates
// from csd_ms (20 dB decay time). Interpolation between octave band
// centres along the frequency axis so the display reads continuous.
// Directivity waterfall — classic 3D surface showing SPL as a function
// of horizontal angle AND frequency simultaneously. The axes match the
// measurement-lab convention (see docs/WATERFALL.md and the reference
// screenshot):
//   X:     azimuth in degrees, −110 → +110
//   depth: frequency (log scale), 20 kHz at front → 125 Hz at back
//   Z:     SPL (dB)
// On-axis energy reads as a warm-red ridge along the centre line;
// off-axis cones roll off into deep blue. Narrowing of the ridge at
// the front of the plot = HF beaming.
function drawWaterfall(canvas, def, onAxis) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const sens = def.acoustic?.sensitivity_db_1w_1m ?? 90;
  const dir = def?.directivity;
  if (!dir?.attenuation_db) {
    ctx.fillStyle = 'rgba(200, 210, 220, 0.55)';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No directivity data — cannot render waterfall.', W / 2, H / 2);
    ctx.textAlign = 'start';
    return;
  }

  // On-axis FR at a given frequency (log-space linear interpolation).
  const frAt = (hz) => {
    if (hz <= onAxis[0].hz) return onAxis[0].db;
    if (hz >= onAxis[onAxis.length - 1].hz) return onAxis[onAxis.length - 1].db;
    for (let i = 0; i < onAxis.length - 1; i++) {
      const lo = onAxis[i], hi = onAxis[i + 1];
      if (hz >= lo.hz && hz <= hi.hz) {
        const t = (Math.log2(hz) - Math.log2(lo.hz)) / (Math.log2(hi.hz) - Math.log2(lo.hz));
        return lo.db + t * (hi.db - lo.db);
      }
    }
    return 0;
  };
  // Off-axis attenuation at (angle, freq). `interpolateAttenuation` only
  // accepts an exact band centre (it key-lookups attenuation_db[freq_hz]
  // and returns 0 on miss), so frequencies between bands would otherwise
  // show zero beaming. Here we find the two nearest available bands and
  // log-blend the attenuations between them — the fix that finally made
  // the HF end of the waterfall taper the way it should.
  const bandHz = Object.keys(dir.attenuation_db).map(Number).sort((a, b) => a - b);
  const attAt = (angle_deg, hz) => {
    if (bandHz.length === 0) return 0;
    if (hz <= bandHz[0]) return interpolateAttenuation(dir, angle_deg, 0, bandHz[0]);
    if (hz >= bandHz[bandHz.length - 1]) {
      return interpolateAttenuation(dir, angle_deg, 0, bandHz[bandHz.length - 1]);
    }
    for (let i = 0; i < bandHz.length - 1; i++) {
      const lo = bandHz[i], hi = bandHz[i + 1];
      if (hz >= lo && hz <= hi) {
        const a = interpolateAttenuation(dir, angle_deg, 0, lo);
        const b = interpolateAttenuation(dir, angle_deg, 0, hi);
        const t = (Math.log2(hz) - Math.log2(lo)) / (Math.log2(hi) - Math.log2(lo));
        return a + t * (b - a);
      }
    }
    return 0;
  };

  // Oblique projection — stronger tilt than the earlier draft so the
  // mesh reads as a proper 3D surface rather than a stacked-ribbon plot.
  // Back slices shift RIGHT + UP on the canvas (the viewer is above,
  // looking down-right at the mesh).
  const padL = 60, padR = 36, padT = 24, padB = 48;
  const nSlices = 23;                 // angle depth slices — 10° step, 0° lands exactly on the middle slice
  const skewX = 2.6;                  // per slice horizontal pixels (+right)
  const skewY = -7.0;                 // per slice vertical pixels (−up)
  const bkX = skewX * (nSlices - 1);  // ≈ 57 px
  const bkY = skewY * (nSlices - 1);  // ≈ −154 px
  const plotW = W - padL - padR - bkX;
  const plotH = H - padT - padB - Math.abs(bkY);

  // Axes: frequency × dB SPL. Depth axis is angle (linear), with the
  // front slice at +110° and the back slice at −110°. On-axis (0°) is
  // exactly the middle slice (index 11 of 0..22) — that's the peak of
  // the mesh, so a warm-red ridge runs along the middle depth.
  const fMin = 125, fMax = 20000;
  const angleFront = 110, angleBack = -110;
  const peakDb = sens + 5;
  const floorDb = sens - 45;

  const xOfHz = (hz) => padL + ((Math.log2(hz) - Math.log2(fMin)) / (Math.log2(fMax) - Math.log2(fMin))) * plotW;
  const frontBase = padT + plotH - bkY;
  const yOfDb = (db) => frontBase - ((db - floorDb) / (peakDb - floorDb)) * plotH;

  // Slice index s → angle. s=0 is FRONT (+110°), s=nSlices-1 is BACK (−110°).
  const angleAt = (s) => angleFront + (s / (nSlices - 1)) * (angleBack - angleFront);
  const sOfAngle = (deg) => (nSlices - 1) * (deg - angleFront) / (angleBack - angleFront);

  const nFreq = 96;                   // frequency samples per slice

  const rightX = padL + plotW;
  const frontTopY = padT - bkY;
  const backTopY = padT;
  const backBotY = frontBase + bkY;
  const tickFreqs = [125, 250, 500, 1000, 2000, 5000, 10000, 20000];
  const tickDbs = [sens, sens - 10, sens - 20, sens - 30, sens - 40];
  const tickAngles = [110, 70, 30, 0, -30, -70, -110];   // for the depth-edge labels

  // ---------- Back-plane grid (painted first, behind everything) ----
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  for (const hz of tickFreqs) {
    if (hz < fMin || hz > fMax) continue;
    const x = xOfHz(hz) + bkX;
    ctx.beginPath();
    ctx.moveTo(x, backTopY);
    ctx.lineTo(x, backBotY);
    ctx.stroke();
  }
  for (const db of tickDbs) {
    const y = yOfDb(db) + bkY;
    ctx.beginPath();
    ctx.moveTo(padL + bkX, y);
    ctx.lineTo(rightX + bkX, y);
    ctx.stroke();
  }
  ctx.strokeRect(padL + bkX, backTopY, plotW, backBotY - backTopY);

  // ---------- Pre-compute slice path geometry + amplitude ----------
  // Slice s is a constant-ANGLE trace along the frequency axis. The
  // FRONT slice (s=0) is +110°, the middle slice is 0° (on-axis, peak),
  // and the BACK slice is −110°.
  const slicePaths = new Array(nSlices);
  for (let s = 0; s < nSlices; s++) {
    const angle = angleAt(s);
    const ox = s * skewX;
    const oy = s * skewY;
    const pts = new Array(nFreq + 1);
    for (let i = 0; i <= nFreq; i++) {
      const u = i / nFreq;
      const hz = fMin * Math.pow(fMax / fMin, u);
      const frDb = frAt(hz);
      const att = attAt(angle, hz);
      const lvl = Math.max(floorDb, sens + frDb + att);
      pts[i] = { x: xOfHz(hz) + ox, y: yOfDb(lvl) + oy, db: lvl };
    }
    slicePaths[s] = pts;
  }

  // ---------- Filled surface (jet colormap, back-to-front quads) ----
  for (let s = nSlices - 2; s >= 0; s--) {
    const front = slicePaths[s];
    const back = slicePaths[s + 1];
    for (let i = 0; i < nFreq; i++) {
      const a = front[i], b = front[i + 1];
      const c = back[i + 1], d = back[i];
      const avgDb = (a.db + b.db + c.db + d.db) * 0.25;
      const t = (avgDb - floorDb) / (peakDb - floorDb);
      ctx.fillStyle = jetColor(Math.max(0, Math.min(1, t)));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---------- Slice outlines on top of the surface ----
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.38)';
  ctx.lineWidth = 1;
  for (let s = nSlices - 1; s >= 0; s--) {
    const pts = slicePaths[s];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  // Front slice accent — white so the FR curve reads clearly against
  // the rainbow-coloured surface.
  const front0 = slicePaths[0];
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(front0[0].x, front0[0].y);
  for (let i = 1; i < front0.length; i++) ctx.lineTo(front0[i].x, front0[i].y);
  ctx.stroke();

  // ---------- Front-plane grid + frame (overlays the surface faintly) ----
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = 1;
  for (const db of tickDbs) {
    const y = yOfDb(db);
    if (y < frontTopY || y > frontBase) continue;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(rightX, y);
    ctx.stroke();
  }
  // Depth edges connecting the four corners of the front frame to the
  // back frame.
  ctx.beginPath();
  ctx.moveTo(padL, frontTopY);     ctx.lineTo(padL + bkX, backTopY);
  ctx.moveTo(padL, frontBase);     ctx.lineTo(padL + bkX, backBotY);
  ctx.moveTo(rightX, frontTopY);   ctx.lineTo(rightX + bkX, backTopY);
  ctx.moveTo(rightX, frontBase);   ctx.lineTo(rightX + bkX, backBotY);
  ctx.stroke();
  ctx.strokeRect(padL, frontTopY, plotW, frontBase - frontTopY);

  // ---------- Labels ----------
  ctx.fillStyle = 'rgba(220, 226, 232, 0.85)';
  ctx.font = '10px sans-serif';

  // dB axis (left of front plane).
  ctx.textAlign = 'right';
  for (const db of [peakDb, sens, sens - 10, sens - 20, sens - 30, sens - 40]) {
    const y = yOfDb(db);
    if (y < frontTopY - 2 || y > frontBase + 2) continue;
    ctx.fillText(`${Math.round(db)}`, padL - 6, y + 3);
  }
  ctx.textAlign = 'start';
  ctx.fillText('dB', 4, frontTopY + 10);

  // Frequency axis — labels under the front baseline (log scale).
  ctx.textAlign = 'center';
  for (const hz of tickFreqs) {
    if (hz < fMin || hz > fMax) continue;
    const x = xOfHz(hz);
    const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
    ctx.fillText(label, x, frontBase + 16);
  }
  ctx.textAlign = 'start';
  ctx.fillText('Hz', rightX + 6, frontBase + 16);

  // Angle depth-axis — right-depth edge from (rightX, frontBase) to
  // (rightX + bkX, backBotY). +110° sits at the front (close), −110°
  // at the back (far). Ticks at ±110 / ±70 / ±30 / 0 with the tick
  // pointing outward from the mesh.
  ctx.strokeStyle = 'rgba(220, 226, 232, 0.55)';
  ctx.lineWidth = 1;
  for (const ang of tickAngles) {
    const s = sOfAngle(ang);
    if (s < -0.5 || s > nSlices - 0.5) continue;
    const x = rightX + s * skewX;
    const y = frontBase + s * skewY;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 5, y);
    ctx.stroke();
    ctx.fillText(`${ang}°`, x + 8, y + 3);
  }
  ctx.fillText('angle', rightX + bkX + 16, backBotY - 4);
}

// Classic MATLAB 'jet' colormap — dark blue (low) → cyan → green → yellow
// → red (high). The convention used by REW, ARTA, Klippel, and the
// reference image in docs/WATERFALL.md.
function jetColor(t) {
  const clamped = Math.max(0, Math.min(1, t));
  const stops = [
    [  0,   0, 128],
    [  0,   0, 255],
    [  0, 128, 255],
    [  0, 255, 255],
    [128, 255, 128],
    [255, 255,   0],
    [255, 128,   0],
    [200,   0,   0],
  ];
  const seg = Math.min(stops.length - 2, Math.floor(clamped * (stops.length - 1)));
  const localT = (clamped * (stops.length - 1)) - seg;
  const a = stops[seg], b = stops[seg + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * localT);
  const g = Math.round(a[1] + (b[1] - a[1]) * localT);
  const bl = Math.round(a[2] + (b[2] - a[2]) * localT);
  return `rgb(${r},${g},${bl})`;
}

// Viridis-ish gradient for waterfall — dark purple (cold / late decay)
// through green / yellow (hot / initial energy).
function waterfallColor(t, alpha = 1) {
  // Breakpoints: [r, g, b] at t = 0.00, 0.25, 0.50, 0.75, 1.00
  const stops = [
    [ 60,  40, 120],
    [ 70,  90, 180],
    [ 80, 200, 200],
    [230, 220,  70],
    [255, 230, 150],
  ];
  const clamped = Math.max(0, Math.min(1, t));
  const seg = Math.min(stops.length - 2, Math.floor(clamped * (stops.length - 1)));
  const localT = (clamped * (stops.length - 1)) - seg;
  const a = stops[seg], b = stops[seg + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * localT);
  const g = Math.round(a[1] + (b[1] - a[1]) * localT);
  const bl = Math.round(a[2] + (b[2] - a[2]) * localT);
  return `rgba(${r},${g},${bl},${alpha})`;
}

function specRow(label, value) {
  return `<div class="sv-spec-row"><span class="sv-spec-label">${escapeHtml(label)}</span><span class="sv-spec-val">${escapeHtml(String(value))}</span></div>`;
}
function numFmt(v, d = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(d);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
