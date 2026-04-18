import { state, SPEAKER_GROUPS, groupById } from '../app-state.js';
import { emit } from './events.js';

let catalogRef;

export function mountSourcesPanel({ speakerCatalog }) {
  catalogRef = speakerCatalog;
  const root = document.getElementById('panel-sources');
  root.innerHTML = `
    <h2>Sources</h2>
    <div id="sources-list"></div>
    <button id="add-source-btn" class="btn-add">+ Add speaker</button>
  `;
  root.querySelector('#add-source-btn').addEventListener('click', addSource);
  render();
}

function addSource() {
  const defaultModel = catalogRef[0].url;
  state.sources.push({
    modelUrl: defaultModel,
    position: {
      x: state.room.width_m / 2,
      y: Math.min(1.5 + state.sources.length * 0.8, state.room.depth_m - 0.5),
      z: Math.min(state.room.height_m - 0.3, 2.5),
    },
    aim: { yaw: 0, pitch: -15, roll: 0 },
    power_watts: 100,
  });
  render();
  emit('source:changed');
}

function removeSource(idx) {
  state.sources.splice(idx, 1);
  render();
  emit('source:changed');
}

function render() {
  const listRoot = document.getElementById('sources-list');
  if (!listRoot) return;

  if (state.sources.length === 0) {
    listRoot.innerHTML = '<div class="phase-placeholder">No loudspeakers yet — click "+ Add speaker" below.</div>';
    return;
  }

  listRoot.innerHTML = state.sources.map((src, i) => {
    const grp = groupById(src.groupId);
    const groupBadge = grp
      ? `<span class="group-badge" style="background:${grp.color}">${grp.id}</span>`
      : '';
    return `
    <div class="source-card" data-source-idx="${i}" ${grp ? `style="border-left: 4px solid ${grp.color}"` : ''}>
      <div class="source-header">
        <span>Speaker ${i + 1} ${groupBadge}</span>
        <button class="btn-remove" data-remove-idx="${i}" title="Remove this speaker" aria-label="Remove speaker ${i + 1}">×</button>
      </div>
      <div class="field-group">
        <label>Model
          <select data-f="model">
            ${catalogRef.map(c => `<option value="${c.url}" ${c.url === src.modelUrl ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
        </label>
        <label>Group
          <select data-f="groupId">
            <option value="">— None —</option>
            ${SPEAKER_GROUPS.map(g => `<option value="${g.id}" ${g.id === src.groupId ? 'selected' : ''}>${g.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="source-row triplet">
        <label>X <input type="number" data-f="x" value="${src.position.x.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
        <label>Y <input type="number" data-f="y" value="${src.position.y.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
        <label>Z <input type="number" data-f="z" value="${src.position.z.toFixed(2)}" step="0.1" /><span class="unit">m</span></label>
      </div>
      <div class="source-row duo">
        <label>Yaw <input type="number" data-f="yaw" value="${src.aim.yaw}" step="5" /><span class="unit">°</span></label>
        <label>Pitch <input type="number" data-f="pitch" value="${src.aim.pitch}" step="5" /><span class="unit">°</span></label>
      </div>
      <div class="field-group">
        <label>Input power <input type="number" data-f="watts" value="${src.power_watts}" min="0.1" step="10" /><span class="unit">W</span></label>
      </div>
    </div>
  `;
  }).join('');

  listRoot.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => removeSource(parseInt(btn.dataset.removeIdx, 10)));
  });

  listRoot.querySelectorAll('.source-card').forEach(card => {
    const idx = parseInt(card.dataset.sourceIdx, 10);
    card.querySelectorAll('[data-f]').forEach(input => {
      const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(eventName, e => {
        updateSource(idx, e.target.dataset.f, e.target.value);
      });
    });
  });
}

function updateSource(idx, field, value) {
  const src = state.sources[idx];
  if (!src) return;
  switch (field) {
    case 'x': src.position.x = parseFloat(value); break;
    case 'y': src.position.y = parseFloat(value); break;
    case 'z': src.position.z = parseFloat(value); break;
    case 'yaw': src.aim.yaw = parseFloat(value); break;
    case 'pitch': src.aim.pitch = parseFloat(value); break;
    case 'watts': src.power_watts = parseFloat(value); break;
    case 'model':
      src.modelUrl = value;
      emit('source:model_changed', { idx, url: value });
      return;
    case 'groupId':
      src.groupId = value || null;
      render();
      emit('source:changed');
      return;
  }
  emit('source:changed');
}
