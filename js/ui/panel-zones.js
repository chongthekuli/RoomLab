import { state, colorForZone } from '../app-state.js';
import { emit, on } from './events.js';
import { startDrawZone } from '../graphics/room-2d.js';

let materialsRef;

export function mountZonesPanel({ materials }) {
  materialsRef = materials;
  const root = document.getElementById('panel-zones');
  root.innerHTML = `
    <h2>Audience zones</h2>
    <div id="zones-list"></div>
    <button id="add-zone-btn" class="btn-add">+ Add audience zone</button>
  `;
  root.querySelector('#add-zone-btn').addEventListener('click', () => startDrawZone({}));
  render();
  on('room:changed', render);
  on('scene:reset', render);
}

function removeZone(id) {
  const i = state.zones.findIndex(z => z.id === id);
  if (i < 0) return;
  state.zones.splice(i, 1);
  if (state.selectedZoneId === id) state.selectedZoneId = state.zones[0]?.id ?? null;
  render();
  emit('room:changed');
}

function selectZone(id) {
  state.selectedZoneId = id;
  render();
  emit('room:changed');
}

function render() {
  const listRoot = document.getElementById('zones-list');
  if (!listRoot) return;

  if (state.zones.length === 0) {
    listRoot.innerHTML = '<div class="phase-placeholder">No audience zones yet — click "+ Add audience zone" and draw a polygon inside the room.</div>';
    return;
  }

  listRoot.innerHTML = state.zones.map((z, i) => {
    const color = colorForZone(i);
    const isSel = z.id === state.selectedZoneId;
    return `
      <div class="zone-card ${isSel ? 'selected' : ''}" data-zone-id="${z.id}" style="border-left: 4px solid ${color}">
        <div class="source-header">
          <span style="color: ${color}; font-weight: 600;">● ${z.label}</span>
          <button class="btn-remove" data-remove-id="${z.id}" title="Remove">×</button>
        </div>
        <div class="field-group">
          <label>Label <input type="text" data-f="label" value="${z.label}" /></label>
        </div>
        <div class="source-row duo">
          <label>Elevation <input type="number" data-f="elevation_m" value="${z.elevation_m}" step="0.1" /><span class="unit">m</span></label>
          <label>Vertices <span class="derived">${z.vertices.length}</span></label>
        </div>
        <div class="field-group">
          <label>Surface material
            <select data-f="material_id">
              ${materialsRef.list.filter(m => m.id !== 'audience-seated').map(m => `<option value="${m.id}" ${m.id === z.material_id ? 'selected' : ''}>${m.name}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="field-group">
          <label title="Fraction of seats occupied. Blends surface α with audience α per ISO 3382-1.">Audience occupancy
            <input type="range" data-f="occupancy_percent" min="0" max="100" step="5" value="${z.occupancy_percent ?? 0}" />
            <span class="derived" data-readout="occ">${z.occupancy_percent ?? 0}%</span>
          </label>
        </div>
        <div class="zone-actions">
          <button class="btn-select ${isSel ? 'active' : ''}" data-select-id="${z.id}">${isSel ? '● Selected' : '○ Select'}</button>
          <button class="btn-redraw" data-redraw-id="${z.id}">Redraw</button>
        </div>
      </div>
    `;
  }).join('');

  listRoot.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); removeZone(btn.dataset.removeId); });
  });
  listRoot.querySelectorAll('.btn-select').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); selectZone(btn.dataset.selectId); });
  });
  listRoot.querySelectorAll('.btn-redraw').forEach(btn => {
    btn.addEventListener('click', () => startDrawZone({ existingId: btn.dataset.redrawId }));
  });
  listRoot.querySelectorAll('.zone-card').forEach(card => {
    const id = card.dataset.zoneId;
    card.querySelectorAll('[data-f]').forEach(input => {
      const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(eventName, e => {
        const f = e.target.dataset.f;
        updateZone(id, f, e.target.value);
        if (f === 'occupancy_percent') {
          const readout = card.querySelector('[data-readout="occ"]');
          if (readout) readout.textContent = `${e.target.value}%`;
        }
      });
    });
  });
}

function updateZone(id, field, value) {
  const z = state.zones.find(z => z.id === id);
  if (!z) return;
  switch (field) {
    case 'label': z.label = value; break;
    case 'elevation_m': z.elevation_m = parseFloat(value) || 0; break;
    case 'material_id': z.material_id = value; break;
    case 'occupancy_percent': {
      const v = parseFloat(value);
      z.occupancy_percent = Math.max(0, Math.min(100, isFinite(v) ? v : 0));
      break;
    }
  }
  emit('room:changed');
}
