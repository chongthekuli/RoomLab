import { state, PRESETS } from '../app-state.js';
import { emit } from './events.js';

const SURFACE_LABELS = [
  ['floor',      'Floor'],
  ['ceiling',    'Ceiling'],
  ['wall_north', 'Wall — Front'],
  ['wall_south', 'Wall — Back'],
  ['wall_east',  'Wall — Right'],
  ['wall_west',  'Wall — Left'],
];

export function mountRoomPanel({ materials }) {
  const root = document.getElementById('panel-room');
  root.innerHTML = `
    <h2>Room</h2>
    <div class="preset-row" id="preset-row"></div>
    <div class="field-group">
      <label>Width <input type="number" data-dim="width_m" min="0.5" step="0.1" /> <span class="unit">m</span></label>
      <label>Depth <input type="number" data-dim="depth_m" min="0.5" step="0.1" /> <span class="unit">m</span></label>
      <label>Height <input type="number" data-dim="height_m" min="0.5" step="0.1" /> <span class="unit">m</span></label>
    </div>
    <h3>Surface materials</h3>
    <div class="field-group" id="room-surfaces"></div>
  `;

  const presetRow = root.querySelector('#preset-row');
  for (const [key, p] of Object.entries(PRESETS)) {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.dataset.preset = key;
    btn.addEventListener('click', () => applyPreset(key, refs));
    presetRow.appendChild(btn);
  }

  const refs = { dims: {}, surfaces: {} };

  for (const input of root.querySelectorAll('[data-dim]')) {
    const key = input.dataset.dim;
    refs.dims[key] = input;
    input.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v) && v > 0) {
        state.room[key] = v;
        emit('room:changed');
      }
    });
  }

  const surfRoot = root.querySelector('#room-surfaces');
  for (const [id, label] of SURFACE_LABELS) {
    const wrap = document.createElement('label');
    const sel = document.createElement('select');
    sel.innerHTML = materials.list
      .map(m => `<option value="${m.id}">${m.name}</option>`)
      .join('');
    wrap.append(label + ' ', sel);
    surfRoot.appendChild(wrap);
    refs.surfaces[id] = sel;
    sel.addEventListener('change', e => {
      state.room.surfaces[id] = e.target.value;
      emit('room:changed');
    });
  }

  syncFromState(refs);
}

function syncFromState(refs) {
  for (const [key, input] of Object.entries(refs.dims)) input.value = state.room[key];
  for (const [id, sel] of Object.entries(refs.surfaces)) sel.value = state.room.surfaces[id];
}

function applyPreset(key, refs) {
  const p = PRESETS[key];
  if (!p) return;
  state.room.width_m = p.width_m;
  state.room.height_m = p.height_m;
  state.room.depth_m = p.depth_m;
  Object.assign(state.room.surfaces, p.surfaces);
  syncFromState(refs);
  emit('room:changed');
}
