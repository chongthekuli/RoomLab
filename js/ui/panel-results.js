import { state, earHeightFor, getSelectedListener, POSTURE_LABELS, groupById, SPEAKER_GROUPS, expandSources } from '../app-state.js';
import { on } from './events.js';
import { computeAllBands } from '../physics/rt60.js';
import { computeListenerBreakdown, computeRoomConstant } from '../physics/spl-calculator.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';

let materialsRef;

export function mountResultsPanel({ materials }) {
  materialsRef = materials;
  const root = document.getElementById('panel-results');
  root.innerHTML = `
    <h2>Results</h2>
    <div id="listener-section"></div>
    <div id="rt60-summary" class="summary"></div>
    <h3>RT60 per band</h3>
    <table id="rt60-table">
      <thead><tr><th>Hz</th><th>Sabine</th><th>Eyring</th></tr></thead>
      <tbody></tbody>
    </table>
    <div id="spl-section"></div>
    <div id="zones-section"></div>
    <div class="hint">
      <strong>Target ranges:</strong><br>
      Speech / meetings: 0.4–0.8 s<br>
      Classrooms: 0.5–0.7 s<br>
      Live music: 1.2–2.0 s<br>
      Concert halls: 1.8–2.4 s<br>
      <br>
      <em>Sabine</em> assumes a reverberant room. <em>Eyring</em> is more
      accurate when average absorption exceeds ~0.2 (dead rooms, studios).
    </div>
  `;
  render();
  on('room:changed', render);
  on('source:changed', render);
  on('source:model_changed', render);
  on('listener:changed', render);
  on('listener:selected', render);
  on('scene:reset', render);
}

function render() {
  renderListenerSection();
  renderRT60();
  renderSPLStats();
  renderZoneStats();
}

function renderZoneStats() {
  const root = document.getElementById('zones-section');
  if (!root) return;
  const grids = state.results.zoneGrids || [];
  if (grids.length === 0 || state.sources.length === 0) {
    root.innerHTML = '';
    return;
  }
  root.innerHTML = `
    <h3>Audience zone coverage</h3>
    <table id="zones-table">
      <thead><tr><th>Zone</th><th>Max</th><th>Avg</th><th>Uniformity</th></tr></thead>
      <tbody>
        ${grids.map(g => `
          <tr>
            <td><strong>${escapeHtml(g.label)}</strong><br><span class="sub">elev ${g.elevation_m.toFixed(2)} m</span></td>
            <td>${g.maxSPL_db.toFixed(1)} dB</td>
            <td>${g.avgSPL_db.toFixed(1)} dB</td>
            <td>${g.uniformity_db.toFixed(1)} dB</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderListenerSection() {
  const root = document.getElementById('listener-section');
  if (!root) return;
  const lst = getSelectedListener();
  if (!lst) {
    root.innerHTML = state.listeners.length === 0
      ? '<div class="phase-placeholder">Add a listener in the Listeners panel to see per-position SPL.</div>'
      : '<div class="phase-placeholder">Select a listener to see per-position SPL.</div>';
    return;
  }

  const ear = earHeightFor(lst);
  const pos = { x: lst.position.x, y: lst.position.y, z: ear };
  // Physics sees each line-array element as its own directional source, so
  // the breakdown row count can be much larger than state.sources.length
  // (e.g., 4 line arrays × 4 elements = 16 rows).
  const flatSources = expandSources(state.sources);
  const phys = state.physics ?? {};
  const freq = phys.freq_hz ?? 1000;
  const breakdown = computeListenerBreakdown({
    sources: flatSources,
    getSpeakerDef: url => getCachedLoudspeaker(url),
    listenerPos: pos,
    freq_hz: freq,
    room: state.room,
    airAbsorption: phys.airAbsorption !== false,
    roomConstantR: phys.reverberantField && materialsRef
      ? computeRoomConstant(state.room, materialsRef, freq, state.zones) : 0,
  });

  const postureLabel = POSTURE_LABELS[lst.posture] ?? lst.posture;
  const totalStr = isFinite(breakdown.total_spl_db) ? breakdown.total_spl_db.toFixed(1) + ' dB' : '—';

  const rows = breakdown.perSpeaker.map(p => {
    const splStr = isFinite(p.spl_db) ? `${p.spl_db.toFixed(1)} dB` : '—';
    const rStr = p.r != null ? `${p.r.toFixed(2)} m` : '—';
    const src = flatSources[p.idx];
    const grp = src ? groupById(src.groupId) : null;
    const grpBadge = grp ? ` <span class="group-badge" style="background:${grp.color}">${grp.id}</span>` : '';
    const arrayLabel = src?.arrayId ? ` <span class="sub">${src.arrayId}·e${src.elementIndex + 1}</span>` : '';
    const badge = p.outsideRoom
      ? ' <span class="badge-warn" title="Speaker is outside the room — SPL reduced by 30 dB for wall transmission loss">outside</span>'
      : (p.through_wall ? ' <span class="badge-warn" title="Path crosses a wall — SPL reduced by 30 dB">through wall</span>' : '');
    return `<tr><td>Speaker ${p.idx + 1}${arrayLabel}${grpBadge}${badge}</td><td>${splStr}</td><td>${rStr}</td></tr>`;
  }).join('');
  const anyOutside = breakdown.perSpeaker.some(p => p.outsideRoom);
  const outsideNote = anyOutside
    ? `<div class="lr-note">One or more speakers are outside the room. A 30 dB wall transmission loss is applied to their contribution.</div>`
    : '';
  // Per-group totals
  const groupTotals = {};
  for (const p of breakdown.perSpeaker) {
    const src = flatSources[p.idx];
    if (!src?.groupId || !isFinite(p.spl_db)) continue;
    groupTotals[src.groupId] = (groupTotals[src.groupId] || 0) + Math.pow(10, p.spl_db / 10);
  }
  const groupRows = Object.entries(groupTotals).map(([gid, press]) => {
    const grp = groupById(gid);
    const spl = 10 * Math.log10(press);
    return `<tr class="group-row"><td><span class="group-badge" style="background:${grp.color}">${grp.id}</span> ${grp.label}</td><td colspan="2"><strong>${spl.toFixed(1)} dB</strong></td></tr>`;
  }).join('');

  root.innerHTML = `
    <div class="listener-results">
      <div class="lr-title">Selected listener: <strong>${escapeHtml(lst.label)}</strong></div>
      <div class="lr-sub">${postureLabel} · ear ${ear.toFixed(2)} m · at (${lst.position.x.toFixed(2)}, ${lst.position.y.toFixed(2)})</div>
      <div class="lr-total"><span class="big-num">${totalStr}</span><span class="sub"> Total SPL @ 1 kHz</span></div>
      ${state.sources.length > 0 ? `
        <table class="lr-breakdown">
          <thead><tr><th>Source</th><th>SPL</th><th>Distance</th></tr></thead>
          <tbody>${rows}${groupRows}</tbody>
        </table>
        ${outsideNote}
      ` : ''}
    </div>
  `;
}

function renderRT60() {
  const bands = computeAllBands({ room: state.room, materials: materialsRef, zones: state.zones });
  const f500 = bands.find(b => b.frequency_hz === 500);
  const f1k  = bands.find(b => b.frequency_hz === 1000);
  const mid = ((f500?.sabine_s ?? 0) + (f1k?.sabine_s ?? 0)) / 2;
  const rating = ratingFor(mid);
  const first = bands[0];

  document.getElementById('rt60-summary').innerHTML = `
    <div class="big ${rating.klass}">${isFinite(mid) ? mid.toFixed(2) : '∞'}<span class="unit"> s</span></div>
    <div class="sub">Mid-band average RT60 (500 Hz + 1 kHz, Sabine)</div>
    <div class="rating ${rating.klass}">${rating.label}</div>
    <div class="sub meta">Volume ${first.volume_m3.toFixed(1)} m³ · Surface ${first.totalArea_m2.toFixed(1)} m² · Mean α ${first.meanAbsorption.toFixed(2)}</div>
  `;

  document.querySelector('#rt60-table tbody').innerHTML = bands.map(b => `
    <tr>
      <td>${b.frequency_hz}</td>
      <td>${fmtRT(b.sabine_s)}</td>
      <td>${fmtRT(b.eyring_s)}</td>
    </tr>
  `).join('');
}

function renderSPLStats() {
  const root = document.getElementById('spl-section');
  if (!root) return;
  const splGrid = state.results.splGrid;
  if (splGrid) {
    const ear = splGrid.earHeight_m.toFixed(2);
    root.innerHTML = `
      <h3>SPL coverage @ ${ear} m ear height</h3>
      <table id="spl-table">
        <tr><th>Max</th><td>${splGrid.maxSPL_db.toFixed(1)} dB</td></tr>
        <tr><th>Average</th><td>${splGrid.avgSPL_db.toFixed(1)} dB</td></tr>
        <tr><th>Min</th><td>${splGrid.minSPL_db.toFixed(1)} dB</td></tr>
        <tr><th>Uniformity</th><td>${splGrid.uniformity_db.toFixed(1)} dB range</td></tr>
      </table>
    `;
  } else {
    root.innerHTML = '';
  }
}

function fmtRT(v) {
  if (!isFinite(v)) return '∞';
  if (v === 0) return '0.00 s';
  return v.toFixed(2) + ' s';
}

function ratingFor(t) {
  if (!isFinite(t)) return { klass: 'bad', label: 'Effectively anechoic or no absorption' };
  if (t < 0.3) return { klass: 'good', label: 'Very dry — studio / treated space' };
  if (t < 0.8) return { klass: 'good', label: 'Good for speech & intelligibility' };
  if (t < 1.6) return { klass: 'ok',   label: 'Balanced — mixed-use' };
  if (t < 2.5) return { klass: 'warn', label: 'Live / reverberant — good for music' };
  return { klass: 'bad', label: 'Excessively reverberant' };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
