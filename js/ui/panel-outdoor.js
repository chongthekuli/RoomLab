import { state } from '../app-state.js';
import { emit, on } from './events.js';

// Outdoor field panel — enable long-throw exterior coverage over an open
// field, set its size, and the ISO 9613-1 air-absorption inputs (T/RH).
//
// Emits `outdoor:changed` (Viktor's Phase-3 contract): the scene handler
// reads state.outdoor.{enabled, field_size_m, temperature_C, humidity_pct}
// and rebuilds the heatmap + swaps the camera. The field render is
// VIEWPORT-ONLY — it never enters the print report (Phase-4 guard).
//
// Field-size slider rebuilds on RELEASE only (change), not during drag
// (input) — a full field grid is ~arena-class cost, so per Mehmet we
// avoid the rebuild-per-pixel storm. The number readout updates live.
//
// Honest labelling per Dr. Chen: ISO 9613-1 free-field; ground effect
// (A_gr) is NOT modelled — the field reads up to 3–10 dB hot at 250–500 Hz
// over soft ground. Stated in the panel so it's never mistaken for 9613-2.

const MIN_M = 50, MAX_M = 1000;
const clampSize = v => Math.max(MIN_M, Math.min(MAX_M, Math.round(v)));

export function mountOutdoorPanel() {
  const root = document.getElementById('panel-outdoor');
  if (!root) return;

  root.innerHTML = `
    <h2>Outdoor field</h2>
    <div class="field-group">
      <label class="outdoor-toggle">
        <input type="checkbox" id="outdoor-enabled" />
        Show outdoor field
      </label>
    </div>
    <div id="outdoor-controls">
      <div class="field-group">
        <label>Field size
          <input type="range" id="outdoor-size-range" min="${MIN_M}" max="${MAX_M}" step="10" />
        </label>
        <div class="outdoor-size-row">
          <input type="number" id="outdoor-size-num" min="${MIN_M}" max="${MAX_M}" step="10" />
          <span class="sub">m across (room centred)</span>
        </div>
      </div>
      <div class="field-group outdoor-airrow">
        <label>Temperature
          <span class="outdoor-inline"><input type="number" id="outdoor-temp" min="-20" max="50" step="1" /><span class="sub">°C</span></span>
        </label>
        <label>Humidity
          <span class="outdoor-inline"><input type="number" id="outdoor-rh" min="0" max="100" step="1" /><span class="sub">% RH</span></span>
        </label>
      </div>
      <p class="sub outdoor-note">Free-field, ISO 9613-1 (distance + air absorption).
        Ground effect is not modelled — at long range over soft ground the
        250–500 Hz band may read a few dB high. Map &amp; shape controls coming next.</p>
    </div>
  `;

  const enabledEl = root.querySelector('#outdoor-enabled');
  const rangeEl   = root.querySelector('#outdoor-size-range');
  const numEl     = root.querySelector('#outdoor-size-num');
  const tempEl    = root.querySelector('#outdoor-temp');
  const rhEl      = root.querySelector('#outdoor-rh');

  enabledEl.addEventListener('change', e => {
    state.outdoor.enabled = !!e.target.checked;
    syncDisabledState();
    emit('outdoor:changed');
  });

  // Field size: live number readout while dragging (input), heavy rebuild
  // only on release (change). Both controls stay in sync.
  rangeEl.addEventListener('input', e => {
    const v = clampSize(Number(e.target.value));
    numEl.value = v;
  });
  rangeEl.addEventListener('change', e => {
    const v = clampSize(Number(e.target.value));
    state.outdoor.field_size_m = v;
    numEl.value = v;
    if (state.outdoor.enabled) emit('outdoor:changed');
  });
  numEl.addEventListener('change', e => {
    const v = clampSize(Number(e.target.value));
    state.outdoor.field_size_m = v;
    numEl.value = v;
    rangeEl.value = v;
    if (state.outdoor.enabled) emit('outdoor:changed');
  });

  tempEl.addEventListener('change', e => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) { tempEl.value = state.outdoor.temperature_C; return; }
    state.outdoor.temperature_C = Math.max(-20, Math.min(50, v));
    tempEl.value = state.outdoor.temperature_C;
    if (state.outdoor.enabled) emit('outdoor:changed');
  });
  rhEl.addEventListener('change', e => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) { rhEl.value = state.outdoor.humidity_pct; return; }
    state.outdoor.humidity_pct = Math.max(0, Math.min(100, v));
    rhEl.value = state.outdoor.humidity_pct;
    if (state.outdoor.enabled) emit('outdoor:changed');
  });

  render();
  // Outdoor resets to disabled on preset/template/project swap — re-sync
  // the controls so a stale "enabled" checkbox never lingers.
  on('scene:reset', render);
}

// Grey out the field controls when outdoor is off (they still hold their
// values; they just don't drive anything until the field is shown).
function syncDisabledState() {
  const root = document.getElementById('panel-outdoor');
  if (!root) return;
  const controls = root.querySelector('#outdoor-controls');
  if (controls) controls.classList.toggle('is-disabled', !state.outdoor.enabled);
}

function render() {
  const root = document.getElementById('panel-outdoor');
  if (!root) return;
  const o = state.outdoor;
  root.querySelector('#outdoor-enabled').checked = !!o.enabled;
  root.querySelector('#outdoor-size-range').value = o.field_size_m;
  root.querySelector('#outdoor-size-num').value   = o.field_size_m;
  root.querySelector('#outdoor-temp').value       = o.temperature_C;
  root.querySelector('#outdoor-rh').value         = o.humidity_pct;
  syncDisabledState();
}
