import { state, colorForZone } from '../app-state.js';
import { emit, on } from './events.js';
import { startDrawZone } from '../graphics/room-2d.js';

let materialsRef;

// Priya audit: arena preset has 48+ zone cards which is unusable as a flat
// scrollable list. Zones are now grouped by label prefix (first word) into
// collapsible sections with bulk-edit controls on the group header.
// Individual zone cards are collapsed to a one-line summary by default and
// expand on click. Per-group defaults: open the group containing the
// currently-selected zone; collapse everything else.

const groupCollapsed = new Map();   // groupName → bool (true = collapsed)
const zoneExpanded = new Set();     // zone IDs that are expanded for editing

function groupLabelOf(zone) {
  return (zone.label || 'Zones').split(/\s/)[0] || 'Zones';
}

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
  on('scene:reset', () => { groupCollapsed.clear(); zoneExpanded.clear(); render(); });
  on('listener:selected', render);
}

function removeZone(id) {
  const i = state.zones.findIndex(z => z.id === id);
  if (i < 0) return;
  state.zones.splice(i, 1);
  if (state.selectedZoneId === id) state.selectedZoneId = state.zones[0]?.id ?? null;
  zoneExpanded.delete(id);
  emit('room:changed');
}

function selectZone(id) {
  state.selectedZoneId = id;
  zoneExpanded.add(id);  // selecting a zone should reveal its editor
  emit('room:changed');
}

function render() {
  const listRoot = document.getElementById('zones-list');
  if (!listRoot) return;

  if (state.zones.length === 0) {
    listRoot.innerHTML = '<div class="phase-placeholder">No audience zones yet — click "+ Add audience zone" and draw a polygon inside the room.</div>';
    return;
  }

  // Group zones by label prefix, preserving creation order within each group.
  const groups = new Map();
  state.zones.forEach((z, i) => {
    const key = groupLabelOf(z);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ zone: z, index: i });
  });

  // Auto-expand the group containing the currently-selected zone the first
  // time we see it (so selection from another panel reveals the zone).
  const selectedGroup = state.selectedZoneId
    ? groupLabelOf(state.zones.find(z => z.id === state.selectedZoneId) ?? {})
    : null;
  if (selectedGroup && !groupCollapsed.has(selectedGroup)) {
    groupCollapsed.set(selectedGroup, false);
  }
  // Default: all groups collapsed EXCEPT the selected one.
  for (const g of groups.keys()) {
    if (!groupCollapsed.has(g)) groupCollapsed.set(g, g !== selectedGroup);
  }

  listRoot.innerHTML = [...groups.entries()].map(([name, entries]) => {
    const collapsed = groupCollapsed.get(name);
    const count = entries.length;
    // Group-level stats — average occupancy across zones in the group.
    const occVals = entries.map(e => e.zone.occupancy_percent ?? 0);
    const avgOcc = occVals.length ? Math.round(occVals.reduce((a, b) => a + b, 0) / occVals.length) : 0;
    // Single representative material (if all zones agree) else "mixed".
    const mats = new Set(entries.map(e => e.zone.material_id));
    const matSummary = mats.size === 1
      ? (materialsRef.list.find(m => m.id === [...mats][0])?.name ?? [...mats][0])
      : 'mixed';

    const cardsHtml = collapsed ? '' : entries.map(({ zone, index }) =>
      renderZoneCard(zone, index)).join('');

    const singleton = count === 1;

    return `
      <div class="zone-group${collapsed ? ' collapsed' : ''}" data-group="${escapeAttr(name)}">
        <div class="zone-group-head" data-toggle-group="${escapeAttr(name)}">
          <span class="zg-caret">${collapsed ? '▶' : '▼'}</span>
          <strong class="zg-name">${escapeHtml(name)}</strong>
          <span class="zg-count">${count}</span>
          <span class="zg-summary">${escapeHtml(matSummary)} · avg ${avgOcc}% occ</span>
        </div>
        ${collapsed || singleton ? '' : `
          <div class="zone-group-bulk">
            <label>Set occupancy for all ${count}
              <input type="range" class="bulk-occ" min="0" max="100" step="5" value="${avgOcc}" />
              <span class="derived bulk-occ-readout">${avgOcc}%</span>
            </label>
            <label>Set material for all
              <select class="bulk-mat">
                <option value="">— choose —</option>
                ${materialsRef.list.filter(m => m.id !== 'audience-seated').map(m =>
                  `<option value="${m.id}">${m.name}</option>`).join('')}
              </select>
            </label>
          </div>
        `}
        <div class="zone-group-body">${cardsHtml}</div>
      </div>
    `;
  }).join('');

  // Bind group-level events.
  listRoot.querySelectorAll('[data-toggle-group]').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const g = hdr.dataset.toggleGroup;
      groupCollapsed.set(g, !groupCollapsed.get(g));
      render();
    });
  });
  listRoot.querySelectorAll('.zone-group').forEach(grp => {
    const groupName = grp.dataset.group;
    const occInput = grp.querySelector('.bulk-occ');
    const occReadout = grp.querySelector('.bulk-occ-readout');
    if (occInput) {
      occInput.addEventListener('input', () => {
        if (occReadout) occReadout.textContent = `${occInput.value}%`;
      });
      occInput.addEventListener('change', () => {
        applyBulkOccupancy(groupName, parseFloat(occInput.value));
      });
    }
    const matSelect = grp.querySelector('.bulk-mat');
    if (matSelect) {
      matSelect.addEventListener('change', () => {
        const v = matSelect.value;
        if (v) applyBulkMaterial(groupName, v);
        matSelect.value = '';
      });
    }
  });

  // Bind card-level events (only for expanded cards).
  listRoot.querySelectorAll('[data-toggle-zone]').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('.btn-remove, .btn-select, .btn-redraw, [data-f]')) return;
      const id = hdr.dataset.toggleZone;
      if (zoneExpanded.has(id)) zoneExpanded.delete(id); else zoneExpanded.add(id);
      render();
    });
  });
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

function renderZoneCard(z, i) {
  const color = colorForZone(i);
  const isSel = z.id === state.selectedZoneId;
  const expanded = zoneExpanded.has(z.id);
  const occ = z.occupancy_percent ?? 0;

  if (!expanded) {
    // Compact one-line summary: colored swatch · label · occ% · elev.
    return `
      <div class="zone-card compact${isSel ? ' selected' : ''}" data-zone-id="${z.id}"
           data-toggle-zone="${z.id}" style="border-left: 4px solid ${color}">
        <span class="zc-label">${escapeHtml(z.label)}</span>
        <span class="zc-meta">${occ}% · ${(z.elevation_m ?? 0).toFixed(1)}m</span>
        <button class="btn-select ${isSel ? 'active' : ''}" data-select-id="${z.id}" title="${isSel ? 'Selected' : 'Select this zone'}">${isSel ? '●' : '○'}</button>
      </div>
    `;
  }

  return `
    <div class="zone-card expanded${isSel ? ' selected' : ''}" data-zone-id="${z.id}"
         data-toggle-zone="${z.id}" style="border-left: 4px solid ${color}">
      <div class="source-header">
        <span style="color: ${color}; font-weight: 600;">● ${escapeHtml(z.label)}</span>
        <button class="btn-remove" data-remove-id="${z.id}" title="Remove">×</button>
      </div>
      <div class="field-group">
        <label>Label <input type="text" data-f="label" value="${escapeAttr(z.label)}" /></label>
      </div>
      <div class="source-row duo">
        <label>Elevation <input type="number" data-f="elevation_m" value="${z.elevation_m}" step="0.1" /><span class="unit">m</span></label>
        <label>Vertices <span class="derived">${z.vertices.length}</span></label>
      </div>
      <div class="field-group">
        <label>Surface material
          <select data-f="material_id">
            ${materialsRef.list.filter(m => m.id !== 'audience-seated').map(m => `<option value="${m.id}" ${m.id === z.material_id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="field-group">
        <label title="Fraction of seats occupied. Blends surface α with audience α per ISO 3382-1.">Audience occupancy
          <input type="range" data-f="occupancy_percent" min="0" max="100" step="5" value="${occ}" />
          <span class="derived" data-readout="occ">${occ}%</span>
        </label>
      </div>
      <div class="zone-actions">
        <button class="btn-select ${isSel ? 'active' : ''}" data-select-id="${z.id}">${isSel ? '● Selected' : '○ Select'}</button>
        <button class="btn-redraw" data-redraw-id="${z.id}">Redraw</button>
      </div>
    </div>
  `;
}

function applyBulkOccupancy(groupName, percent) {
  const clamped = Math.max(0, Math.min(100, isFinite(percent) ? percent : 0));
  let changed = 0;
  for (const z of state.zones) {
    if (groupLabelOf(z) !== groupName) continue;
    z.occupancy_percent = clamped;
    changed++;
  }
  if (changed > 0) emit('room:changed');
}

function applyBulkMaterial(groupName, materialId) {
  let changed = 0;
  for (const z of state.zones) {
    if (groupLabelOf(z) !== groupName) continue;
    z.material_id = materialId;
    changed++;
  }
  if (changed > 0) emit('room:changed');
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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
