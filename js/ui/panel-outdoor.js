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
// avoid the rebuild-per-pixel storm. The number + radius readout update
// live during the drag; the heatmap only rebuilds on release.
//
// Honest labelling per Dr. Chen: ISO 9613-1 free-field; ground effect
// (A_gr) is NOT modelled — the field reads up to 3–10 dB hot at 250–500 Hz
// over soft ground. Stated in the panel so it's never mistaken for 9613-2.

const MIN_M = 50, MAX_M = 1000;
const MIN_T = -20, MAX_T = 50;
const MIN_RH = 0, MAX_RH = 100;
const clampSize = v => Math.max(MIN_M, Math.min(MAX_M, Math.round(v)));

export function mountOutdoorPanel() {
  const root = document.getElementById('panel-outdoor');
  if (!root) return;

  root.innerHTML = `
    <h2>Outdoor field</h2>

    <div class="field-group">
      <label class="outdoor-toggle">
        <input type="checkbox" id="outdoor-enabled" />
        <span>Show outdoor field</span>
      </label>
      <p class="sub outdoor-lede">Coverage over open ground around the room — for
        long-throw exterior PA such as rooftop azan horns.</p>
    </div>

    <div id="outdoor-controls" aria-describedby="outdoor-note">
      <div class="field-group outdoor-size-group">
        <label for="outdoor-size-range">Field size</label>
        <input type="range" id="outdoor-size-range" class="outdoor-size-range"
               min="${MIN_M}" max="${MAX_M}" step="10"
               aria-describedby="outdoor-size-readout" />
        <div class="outdoor-size-row">
          <span class="outdoor-inline">
            <input type="number" id="outdoor-size-num" min="${MIN_M}" max="${MAX_M}" step="10"
                   aria-label="Field size in metres" />
            <span class="unit">m</span>
          </span>
          <span class="sub" id="outdoor-size-readout"></span>
        </div>
      </div>

      <div class="field-group outdoor-airrow">
        <span class="outdoor-section-label">Air absorption (ISO 9613-1)</span>
        <div class="outdoor-air-pair">
          <label for="outdoor-temp">Temperature
            <span class="outdoor-inline"><input type="number" id="outdoor-temp"
              min="${MIN_T}" max="${MAX_T}" step="1" /><span class="unit">°C</span></span>
          </label>
          <label for="outdoor-rh">Humidity
            <span class="outdoor-inline"><input type="number" id="outdoor-rh"
              min="${MIN_RH}" max="${MAX_RH}" step="1" /><span class="unit">% RH</span></span>
          </label>
        </div>
        <p class="sub outdoor-air-hint">Warmer, drier air carries high frequencies
          further; cold or humid air absorbs them sooner.</p>
      </div>

      <p class="sub outdoor-note" id="outdoor-note">
        <span class="outdoor-note-head">Free-field estimate (ISO 9613-1)</span>
        Models distance spreading and air absorption only. Ground effect is not
        modelled, so over soft ground at long range the 250–500 Hz band can read
        several dB high (up to ~10 dB). Use it for reach and relative coverage,
        not for an absolute SPL guarantee at the field edge.
      </p>
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

  // Field size: live number + radius readout while dragging (input), heavy
  // rebuild only on release (change). Both controls stay in sync.
  rangeEl.addEventListener('input', e => {
    const v = clampSize(Number(e.target.value));
    numEl.value = v;
    updateSizeReadout(v);
  });
  rangeEl.addEventListener('change', e => {
    const v = clampSize(Number(e.target.value));
    state.outdoor.field_size_m = v;
    numEl.value = v;
    updateSizeReadout(v);
    if (state.outdoor.enabled) emit('outdoor:changed');
  });
  numEl.addEventListener('change', e => {
    const v = clampSize(Number(e.target.value));
    state.outdoor.field_size_m = v;
    numEl.value = v;
    rangeEl.value = v;
    updateSizeReadout(v);
    if (state.outdoor.enabled) emit('outdoor:changed');
  });

  tempEl.addEventListener('change', e => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) { tempEl.value = state.outdoor.temperature_C; return; }
    state.outdoor.temperature_C = Math.max(MIN_T, Math.min(MAX_T, v));
    tempEl.value = state.outdoor.temperature_C;
    if (state.outdoor.enabled) emit('outdoor:changed');
  });
  rhEl.addEventListener('change', e => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) { rhEl.value = state.outdoor.humidity_pct; return; }
    state.outdoor.humidity_pct = Math.max(MIN_RH, Math.min(MAX_RH, v));
    rhEl.value = state.outdoor.humidity_pct;
    if (state.outdoor.enabled) emit('outdoor:changed');
  });

  render();
  // Outdoor resets to disabled on preset/template/project swap — re-sync
  // the controls so a stale "enabled" checkbox never lingers.
  on('scene:reset', render);
}

// Live "N m across · ~N m from the room centre" caption. The field is a
// square N m on a side centred on the room, so the centre-to-edge reach is
// half the side. Helps the user reason about the 600 m azan demo: a 1000 m
// field reaches ~500 m from the minaret.
function updateSizeReadout(v) {
  const host = document.getElementById('outdoor-size-readout');
  if (!host) return;
  const reach = Math.round(v / 2);
  host.textContent = `${v} m across · ~${reach} m from room centre`;
}

// Enable/disable the field controls when outdoor is off. They keep their
// values, but `disabled` (not just dimming) takes them out of the tab order
// and marks them inert to screen readers — no keyboard trap, correct AT
// state. The wrapper still carries .is-disabled for the dimmed look.
function syncDisabledState() {
  const root = document.getElementById('panel-outdoor');
  if (!root) return;
  const off = !state.outdoor.enabled;
  const controls = root.querySelector('#outdoor-controls');
  if (controls) controls.classList.toggle('is-disabled', off);
  for (const el of root.querySelectorAll('#outdoor-controls input')) {
    el.disabled = off;
  }
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
  updateSizeReadout(o.field_size_m);
  syncDisabledState();
}
