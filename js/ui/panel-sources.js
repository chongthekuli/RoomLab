import { state } from '../app-state.js';
import { emit } from './events.js';

let catalogRef;

export function mountSourcesPanel({ speakerCatalog }) {
  catalogRef = speakerCatalog;
  const root = document.getElementById('panel-sources');
  root.innerHTML = `
    <h2>Sources</h2>
    <div id="sources-list"></div>
  `;
  render();
}

function render() {
  const listRoot = document.getElementById('sources-list');
  if (!listRoot) return;

  if (state.sources.length === 0) {
    listRoot.innerHTML = '<div class="phase-placeholder">No loudspeaker added.</div>';
    return;
  }

  listRoot.innerHTML = state.sources.map((src, i) => `
    <div class="source-card" data-source-idx="${i}">
      <div class="source-header">Speaker ${i + 1}</div>
      <div class="field-group">
        <label>Model
          <select data-f="model">
            ${catalogRef.map(c => `<option value="${c.url}" ${c.url === src.modelUrl ? 'selected' : ''}>${c.label}</option>`).join('')}
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
  `).join('');

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
  }
  emit('source:changed');
}
