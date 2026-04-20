// Speaker detail view — full-specs + polar patterns + expert flags for a
// single loudspeaker. Lives in the viewport area (toggled via the
// "Speaker" tab). Driven by state.selectedSpeakerUrl.

import { state, SPEAKER_CATALOG } from '../app-state.js';
import { on, emit } from './events.js';
import { getCachedLoudspeaker, loadLoudspeaker, interpolateAttenuation, registerLoudspeaker } from '../physics/loudspeaker.js';
import { analyseSpeaker, estimateNominalDispersion, onAxisResponseDb } from '../physics/speaker-expert.js';
import { importSpeakerFile, GLL_GUIDE } from '../physics/speaker-import.js';

// Imported speakers live here. URL of each imported file is a synthetic
// `imported:<id>` token; the in-memory cache of loudspeaker.js stores the
// actual definition under that key so interpolateAttenuation keeps working.
const importedCatalog = new Map();

const BAND_KEYS = ['125', '250', '500', '1000', '2000', '4000', '8000'];
const BAND_LABELS = ['125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz'];
const DB_RINGS = [0, -6, -10, -15, -20];  // polar chart concentric rings

let currentFreqIdx = 3;  // 1 kHz default

export function mountSpeakerView() {
  const root = document.getElementById('view-speaker');
  if (!root) return;
  root.innerHTML = `
    <div class="speaker-view">
      <aside class="sv-catalog" id="sv-catalog"></aside>
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
            <p>Pick a speaker from the catalogue on the left, or click a speaker in the 3D view to see its full spec sheet, on-axis frequency response, and polar patterns here.</p>
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

  on('speaker:selected', render);
  on('source:changed', render);   // in case the user changes the selected cabinet's model
  on('room:changed', render);     // expert flags depend on room
  on('scene:reset', render);

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

  const flags = analyseSpeaker(def, { room: state.room });
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

    ${def.note ? `<div class="sv-designer-note">${escapeHtml(def.note)}</div>` : ''}

    <section class="sv-section">
      <h4>On-axis frequency response</h4>
      <canvas id="sv-fr" width="720" height="180"></canvas>
      <div class="sub sv-caption">Relative response at (az 0°, el 0°) across the measured octave bands.</div>
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
      render();
    });
  }

  drawFrCanvas(body.querySelector('#sv-fr'), onAxis, def);
  drawPolarCanvas(body.querySelector('#sv-polar-h'), def, BAND_KEYS[currentFreqIdx], 'h');
  drawPolarCanvas(body.querySelector('#sv-polar-v'), def, BAND_KEYS[currentFreqIdx], 'v');
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
  const host = document.getElementById('sv-catalog');
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
    <div class="sv-cat-head">Catalogue <span class="sv-cat-count">${SPEAKER_CATALOG.length}</span></div>
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
  const w = canvas.width, h = canvas.height;
  const padL = 40, padR = 18, padT = 18, padB = 28;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  ctx.clearRect(0, 0, w, h);

  // Sensitivity baseline
  const sens = def.acoustic?.sensitivity_db_1w_1m ?? 90;
  const yMin = sens - 20, yMax = sens + 10;
  const xMin = Math.log10(100), xMax = Math.log10(20000);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let db = Math.ceil(yMin / 5) * 5; db <= yMax; db += 5) {
    const y = padT + plotH - ((db - yMin) / (yMax - yMin)) * plotH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = 'rgba(200,210,220,0.55)'; ctx.font = '11px sans-serif';
    ctx.fillText(`${db}`, 4, y + 4);
  }
  for (const hz of [100, 500, 1000, 5000, 10000]) {
    const x = padL + ((Math.log10(hz) - xMin) / (xMax - xMin)) * plotW;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.fillStyle = 'rgba(200,210,220,0.55)';
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x - 8, h - 10);
  }

  // curve: sens + onAxis.db (on-axis correction is typically 0 dB, which
  // shows as a flat line at sensitivity — still useful as sanity check).
  ctx.strokeStyle = 'var(--data-cyan, #74d0ff)';
  ctx.strokeStyle = '#74d0ff';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  onAxis.forEach((p, i) => {
    const x = padL + ((Math.log10(p.hz) - xMin) / (xMax - xMin)) * plotW;
    const y = padT + plotH - ((sens + p.db - yMin) / (yMax - yMin)) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // dots at each band
  ctx.fillStyle = '#74d0ff';
  for (const p of onAxis) {
    const x = padL + ((Math.log10(p.hz) - xMin) / (xMax - xMin)) * plotW;
    const y = padT + plotH - ((sens + p.db - yMin) / (yMax - yMin)) * plotH;
    ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fill();
  }

  // axis label
  ctx.fillStyle = 'rgba(200,210,220,0.7)';
  ctx.fillText('dB SPL', 4, padT);
  ctx.fillText('Hz', w - 22, h - 10);
}

function drawPolarCanvas(canvas, def, bandKey, plane) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  const maxR = Math.min(cx, cy) - 22;
  ctx.clearRect(0, 0, w, h);

  // Rings
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (const db of DB_RINGS) {
    const r = maxR * (1 - db / -20);
    if (r <= 0) continue;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillStyle = 'rgba(200,210,220,0.45)';
    ctx.font = '10px sans-serif';
    ctx.fillText(`${db}`, cx + r + 2, cy + 3);
  }
  // Cross-hairs every 30°
  for (let a = 0; a < 360; a += 30) {
    const rad = a * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * maxR, cy + Math.sin(rad) * maxR);
    ctx.stroke();
  }

  // Cardinal labels
  ctx.fillStyle = 'rgba(200,210,220,0.6)';
  ctx.font = '11px sans-serif';
  ctx.fillText('0°', cx - 8, cy - maxR - 6);
  ctx.fillText('90°', cx + maxR + 4, cy + 4);
  ctx.fillText('180°', cx - 14, cy + maxR + 14);
  ctx.fillText('-90°', cx - maxR - 30, cy + 4);

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

  // Frequency badge
  ctx.fillStyle = 'rgba(200,210,220,0.85)';
  ctx.font = 'bold 12px sans-serif';
  const label = bandKey >= 1000 ? `${bandKey / 1000} kHz` : `${bandKey} Hz`;
  ctx.fillText(label, 8, h - 8);
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
