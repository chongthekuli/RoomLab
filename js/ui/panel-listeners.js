import { state, POSTURE_LABELS, earHeightFor } from '../app-state.js';
import { emit, on } from './events.js';

let nextIdNum = 2;

export function mountListenersPanel() {
  const root = document.getElementById('panel-listeners');
  root.innerHTML = `
    <h2>Listeners</h2>
    <div id="listeners-list"></div>
    <button id="add-listener-btn" class="btn-add">+ Add listener</button>
  `;
  root.querySelector('#add-listener-btn').addEventListener('click', addListener);
  // Pre-compute next id number from existing defaults
  const nums = state.listeners
    .map(l => parseInt(String(l.id).replace(/\D/g, ''), 10))
    .filter(Number.isFinite);
  if (nums.length) nextIdNum = Math.max(...nums) + 1;
  render();
  on('scene:reset', render);
}

function addListener() {
  const id = `L${nextIdNum++}`;
  state.listeners.push({
    id,
    label: `Listener ${state.listeners.length + 1}`,
    position: {
      x: state.room.width_m / 2,
      y: state.room.depth_m / 2 + state.listeners.length * 0.6,
    },
    posture: 'sitting_chair',
    custom_ear_height_m: null,
  });
  if (state.selectedListenerId == null) state.selectedListenerId = id;
  render();
  emit('listener:changed');
}

function removeListener(id) {
  const i = state.listeners.findIndex(l => l.id === id);
  if (i < 0) return;
  state.listeners.splice(i, 1);
  if (state.selectedListenerId === id) {
    state.selectedListenerId = state.listeners[0]?.id ?? null;
  }
  render();
  emit('listener:changed');
}

function selectListener(id) {
  state.selectedListenerId = id;
  render();
  emit('listener:selected');
}

function render() {
  const listRoot = document.getElementById('listeners-list');
  if (!listRoot) return;

  if (state.listeners.length === 0) {
    listRoot.innerHTML = '<div class="phase-placeholder">No listeners yet — click "+ Add listener" below.</div>';
    return;
  }

  listRoot.innerHTML = state.listeners.map((lst) => {
    const isSelected = lst.id === state.selectedListenerId;
    const earH = earHeightFor(lst);
    return `
      <div class="listener-card ${isSelected ? 'selected' : ''}" data-listener-id="${lst.id}">
        <div class="source-header">
          <span>${lst.label}</span>
          <button class="btn-remove" data-remove-id="${lst.id}" title="Remove" aria-label="Remove ${lst.label}">×</button>
        </div>
        <div class="field-group">
          <label>Label <input type="text" data-f="label" value="${lst.label}" /></label>
        </div>
        <div class="source-row triplet">
          <label>X <input type="number" data-f="x" value="${lst.position.x.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
          <label>Y <input type="number" data-f="y" value="${lst.position.y.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
          <label>Elev <input type="number" data-f="elevation_m" value="${(lst.elevation_m ?? 0).toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
        </div>
        <div class="field-group">
          <label>Posture
            <select data-f="posture">
              ${Object.entries(POSTURE_LABELS).map(([k, label]) =>
                `<option value="${k}" ${k === lst.posture ? 'selected' : ''}>${label}</option>`
              ).join('')}
            </select>
          </label>
        </div>
        ${lst.posture === 'custom' ? `
          <div class="field-group">
            <label>Ear height <input type="number" data-f="custom_ear_height_m" value="${lst.custom_ear_height_m ?? 1.2}" step="0.05" min="0.1" /><span class="unit">m</span></label>
          </div>
        ` : `
          <div class="listener-derived">Ear height: <strong>${earH.toFixed(2)} m</strong></div>
        `}
        <button class="btn-select ${isSelected ? 'active' : ''}" data-select-id="${lst.id}">${isSelected ? '● Selected' : '○ Select'}</button>
      </div>
    `;
  }).join('');

  listRoot.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeListener(btn.dataset.removeId);
    });
  });
  listRoot.querySelectorAll('.btn-select').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      selectListener(btn.dataset.selectId);
    });
  });
  listRoot.querySelectorAll('.listener-card').forEach(card => {
    const id = card.dataset.listenerId;
    card.querySelectorAll('[data-f]').forEach(input => {
      const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(eventName, e => {
        updateListener(id, e.target.dataset.f, e.target.value);
      });
    });
  });
}

function updateListener(id, field, value) {
  const lst = state.listeners.find(l => l.id === id);
  if (!lst) return;
  const prevPosture = lst.posture;
  switch (field) {
    case 'label': lst.label = value; break;
    case 'x': lst.position.x = parseFloat(value); break;
    case 'y': lst.position.y = parseFloat(value); break;
    case 'elevation_m': lst.elevation_m = parseFloat(value) || 0; break;
    case 'posture':
      lst.posture = value;
      if (value === 'custom' && lst.custom_ear_height_m == null) {
        lst.custom_ear_height_m = 1.2;
      }
      break;
    case 'custom_ear_height_m': lst.custom_ear_height_m = parseFloat(value); break;
  }
  // Re-render card if posture changed (to show/hide custom height field)
  if (field === 'posture' && prevPosture !== value) render();
  emit('listener:changed');
}
