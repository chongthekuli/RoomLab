import { state } from '../app-state.js';
import { on } from './events.js';
import { computeAllBands } from '../physics/rt60.js';

let materialsRef;

export function mountResultsPanel({ materials }) {
  materialsRef = materials;
  const root = document.getElementById('panel-results');
  root.innerHTML = `
    <h2>Results</h2>
    <div id="rt60-summary" class="summary"></div>
    <h3>RT60 per band</h3>
    <table id="rt60-table">
      <thead><tr><th>Hz</th><th>Sabine</th><th>Eyring</th></tr></thead>
      <tbody></tbody>
    </table>
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
}

function render() {
  const bands = computeAllBands({ room: state.room, materials: materialsRef });
  const f500 = bands.find(b => b.frequency_hz === 500);
  const f1k  = bands.find(b => b.frequency_hz === 1000);
  const mid = ((f500?.sabine_s ?? 0) + (f1k?.sabine_s ?? 0)) / 2;
  const rating = ratingFor(mid);
  const first = bands[0];

  document.getElementById('rt60-summary').innerHTML = `
    <div class="big ${rating.klass}">${isFinite(mid) ? mid.toFixed(2) : '∞'}<span class="unit"> s</span></div>
    <div class="sub">Mid-band average (500 Hz + 1 kHz, Sabine)</div>
    <div class="rating ${rating.klass}">${rating.label}</div>
    <div class="sub meta">Volume ${first.volume_m3.toFixed(1)} m³ · Surface ${first.totalArea_m2.toFixed(1)} m² · Mean α ${first.meanAbsorption.toFixed(2)}</div>
  `;

  const tbody = document.querySelector('#rt60-table tbody');
  tbody.innerHTML = bands.map(b => `
    <tr>
      <td>${b.frequency_hz}</td>
      <td>${fmt(b.sabine_s)}</td>
      <td>${fmt(b.eyring_s)}</td>
    </tr>
  `).join('');
}

function fmt(v) {
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
