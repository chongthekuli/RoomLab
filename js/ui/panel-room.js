import { state, PRESETS, SHAPE_LABELS, CEILING_LABELS } from '../app-state.js';
import { emit } from './events.js';

const RECT_SURFACE_LABELS = [
  ['floor',      'Floor'],
  ['ceiling',    'Ceiling'],
  ['wall_north', 'Wall — Front'],
  ['wall_south', 'Wall — Back'],
  ['wall_east',  'Wall — Right'],
  ['wall_west',  'Wall — Left'],
];

const NONRECT_SURFACE_LABELS = [
  ['floor',   'Floor'],
  ['ceiling', 'Ceiling'],
  ['walls',   'Walls (all)'],
];

let materialsRef;

export function mountRoomPanel({ materials }) {
  materialsRef = materials;
  const root = document.getElementById('panel-room');
  root.innerHTML = `
    <h2>Room</h2>
    <div class="preset-row" id="preset-row"></div>
    <h3>Shape</h3>
    <div class="field-group">
      <label>Plan shape
        <select data-f="shape">
          ${Object.entries(SHAPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="shape-params"></div>
    <h3>Ceiling</h3>
    <div class="field-group">
      <label>Ceiling
        <select data-f="ceiling_type">
          ${Object.entries(CEILING_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="ceiling-params"></div>
    <h3>Surface materials</h3>
    <div id="surface-materials"></div>
  `;

  const presetRow = root.querySelector('#preset-row');
  for (const [key, p] of Object.entries(PRESETS)) {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.dataset.preset = key;
    btn.addEventListener('click', () => applyPreset(key));
    presetRow.appendChild(btn);
  }

  root.querySelector('[data-f="shape"]').addEventListener('change', e => {
    state.room.shape = e.target.value;
    syncBoundingBoxToShape();
    render();
    emit('room:changed');
  });
  root.querySelector('[data-f="ceiling_type"]').addEventListener('change', e => {
    state.room.ceiling_type = e.target.value;
    render();
    emit('room:changed');
  });

  render();
}

function syncBoundingBoxToShape() {
  const s = state.room.shape;
  if (s === 'polygon') {
    const r = state.room.polygon_radius_m;
    state.room.width_m = 2 * r;
    state.room.depth_m = 2 * r;
  } else if (s === 'round') {
    const r = state.room.round_radius_m;
    state.room.width_m = 2 * r;
    state.room.depth_m = 2 * r;
  }
}

function render() {
  const root = document.getElementById('panel-room');
  root.querySelector('[data-f="shape"]').value = state.room.shape;
  root.querySelector('[data-f="ceiling_type"]').value = state.room.ceiling_type;
  renderShapeParams();
  renderCeilingParams();
  renderSurfaceMaterials();
}

function renderShapeParams() {
  const root = document.getElementById('shape-params');
  const r = state.room;
  if (r.shape === 'rectangular') {
    root.innerHTML = `
      <div class="field-group">
        <label>Width <input type="number" data-sf="width_m" value="${r.width_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
        <label>Depth <input type="number" data-sf="depth_m" value="${r.depth_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
        <label>Height <input type="number" data-sf="height_m" value="${r.height_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
      </div>
    `;
  } else if (r.shape === 'polygon') {
    root.innerHTML = `
      <div class="field-group">
        <label>Sides <input type="number" data-sf="polygon_sides" value="${r.polygon_sides}" min="3" max="24" step="1" /></label>
        <label>Radius <input type="number" data-sf="polygon_radius_m" value="${r.polygon_radius_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
        <label>Height <input type="number" data-sf="height_m" value="${r.height_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
      </div>
      <div class="note-small">Regular ${r.polygon_sides}-gon inscribed in circle of radius ${r.polygon_radius_m} m</div>
    `;
  } else if (r.shape === 'round') {
    root.innerHTML = `
      <div class="field-group">
        <label>Radius <input type="number" data-sf="round_radius_m" value="${r.round_radius_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
        <label>Height <input type="number" data-sf="height_m" value="${r.height_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
      </div>
    `;
  }
  wireShapeInputs();
}

function renderCeilingParams() {
  const root = document.getElementById('ceiling-params');
  const r = state.room;
  if (r.ceiling_type === 'dome') {
    root.innerHTML = `
      <div class="field-group">
        <label>Dome rise <input type="number" data-sf="ceiling_dome_rise_m" value="${r.ceiling_dome_rise_m}" min="0.05" step="0.05" /> <span class="unit">m</span></label>
      </div>
      <div class="note-small">Apex rises ${r.ceiling_dome_rise_m} m above the flat ceiling level</div>
    `;
  } else {
    root.innerHTML = '';
  }
  wireShapeInputs();
}

function wireShapeInputs() {
  document.querySelectorAll('#shape-params [data-sf], #ceiling-params [data-sf]').forEach(input => {
    if (input.dataset.wired) return;
    input.dataset.wired = '1';
    input.addEventListener('input', e => {
      const key = e.target.dataset.sf;
      const v = parseFloat(e.target.value);
      if (isNaN(v) || v <= 0) return;
      state.room[key] = (key === 'polygon_sides') ? Math.round(v) : v;
      if (key === 'polygon_radius_m' || key === 'round_radius_m') {
        syncBoundingBoxToShape();
      }
      emit('room:changed');
    });
  });
}

function renderSurfaceMaterials() {
  const root = document.getElementById('surface-materials');
  const labels = state.room.shape === 'rectangular' ? RECT_SURFACE_LABELS : NONRECT_SURFACE_LABELS;
  root.innerHTML = '';
  const group = document.createElement('div');
  group.className = 'field-group';
  for (const [id, label] of labels) {
    const wrap = document.createElement('label');
    const sel = document.createElement('select');
    sel.dataset.surf = id;
    sel.innerHTML = materialsRef.list
      .map(m => `<option value="${m.id}">${m.name}</option>`)
      .join('');
    sel.value = state.room.surfaces[id] ?? materialsRef.list[0].id;
    sel.addEventListener('change', e => {
      state.room.surfaces[id] = e.target.value;
      emit('room:changed');
    });
    wrap.append(label + ' ', sel);
    group.appendChild(wrap);
  }
  root.appendChild(group);
}

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  state.room.shape = p.shape ?? 'rectangular';
  state.room.ceiling_type = p.ceiling_type ?? 'flat';
  state.room.width_m = p.width_m;
  state.room.height_m = p.height_m;
  state.room.depth_m = p.depth_m;
  if (p.polygon_sides != null) state.room.polygon_sides = p.polygon_sides;
  if (p.polygon_radius_m != null) state.room.polygon_radius_m = p.polygon_radius_m;
  if (p.round_radius_m != null) state.room.round_radius_m = p.round_radius_m;
  if (p.ceiling_dome_rise_m != null) state.room.ceiling_dome_rise_m = p.ceiling_dome_rise_m;
  Object.assign(state.room.surfaces, p.surfaces);
  syncBoundingBoxToShape();
  render();
  emit('room:changed');
}
