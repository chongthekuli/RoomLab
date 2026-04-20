import { state } from '../app-state.js';
import { emit, on } from './events.js';
import { AMBIENT_PRESETS, STIPA_BANDS_HZ, bandsToDBA } from '../../data/ambient-presets.js';

export function mountAmbientPanel() {
  const root = document.getElementById('panel-ambient');
  if (!root) return;

  const options = Object.entries(AMBIENT_PRESETS)
    .map(([k, p]) => `<option value="${k}">${p.label}</option>`)
    .join('');

  root.innerHTML = `
    <h2>Environment noise</h2>
    <div class="field-group">
      <label>Scenario
        <select id="ambient-preset">${options}</select>
      </label>
    </div>
    <div id="ambient-summary" class="ambient-summary"></div>
    <details id="ambient-custom">
      <summary>Per-band (dB SPL)</summary>
      <div id="ambient-bands" class="ambient-bands"></div>
    </details>
    <div id="ambient-desc" class="ambient-desc"></div>
  `;

  root.querySelector('#ambient-preset').addEventListener('change', e => {
    const key = e.target.value;
    const preset = AMBIENT_PRESETS[key];
    if (!preset) return;
    state.physics.ambientNoise.preset = key;
    state.physics.ambientNoise.per_band = preset.per_band.slice();
    render();
    emit('ambient:changed');
  });

  render();
  on('scene:reset', render);
}

function render() {
  const root = document.getElementById('panel-ambient');
  if (!root) return;
  const a = state.physics.ambientNoise;
  root.querySelector('#ambient-preset').value = a.preset;
  root.querySelector('#ambient-desc').textContent = AMBIENT_PRESETS[a.preset]?.description ?? '';
  renderBands(a.per_band);
  renderSummary(a.per_band);
}

function renderBands(per_band) {
  const host = document.getElementById('ambient-bands');
  if (!host) return;
  host.innerHTML = STIPA_BANDS_HZ.map((hz, k) => {
    const label = hz >= 1000 ? `${hz / 1000}k` : hz;
    return `
      <div class="ambient-band">
        <span class="ambient-band-hz">${label}</span>
        <input type="number" step="1" min="0" max="120" data-band="${k}" value="${per_band[k]}" />
        <span class="sub">dB</span>
      </div>
    `;
  }).join('');
  for (const input of host.querySelectorAll('input[data-band]')) {
    input.addEventListener('input', e => {
      const k = Number(e.target.dataset.band);
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      state.physics.ambientNoise.per_band[k] = v;
      state.physics.ambientNoise.preset = 'custom';
      const sel = document.getElementById('ambient-preset');
      if (sel) sel.value = 'custom';
      renderSummary(state.physics.ambientNoise.per_band);
      emit('ambient:changed');
    });
  }
}

function renderSummary(per_band) {
  const host = document.getElementById('ambient-summary');
  if (!host) return;
  const dba = bandsToDBA(per_band);
  const klass = dba < 40 ? 'good' : dba < 60 ? 'ok' : dba < 75 ? 'warn' : 'bad';
  host.innerHTML = `
    <div class="ambient-dba ${klass}">${dba.toFixed(1)}<span class="unit"> dBA</span></div>
    <div class="sub">Background SPL at listener ear</div>
  `;
}
