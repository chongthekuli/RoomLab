// panel-structure.js — RoomLAB left-rail "Building structure" panel.
//
// Lets the user place STRUCTURAL OBSTRUCTIONS inside the room — pillars/columns,
// half-wall partitions, full-height interior partitions, overhead beams/soffits,
// and raised platforms. Unlike Furniture (a catalogue of fixed objects) these
// are PARAMETRIC primitives: pick a type, then tune shape / size / height /
// material in place. They affect the acoustic result on three paths (diffraction
// + transmission + absorption) — see js/physics/building-structures.js.
//
// Flow (Maya's spec): type chips → click in the 2D plan to drop one with sane
// defaults → edit-in-place in an expandable card. Material reuses the SurfaceLAB
// construction-material catalogue; the physics resolves the raw materials.json
// row (TL + α) by id via the structure-material provider.

import { state, nextStructureId, duplicateStructure } from '../app-state.js';
import { on, emit } from './events.js';
import { loadSurfaceCatalogue } from '../labs/surfacelab/catalog.js';
import { getStructureMaterialCatalogue } from '../physics/providers.js';
import { applyGlossary } from './glossary.js';

let _mounted = false;

// Construction-material id filter — bulk building materials only (concrete,
// gypsum, glass, plaster, brick, CMU, stud-wall assemblies, wood, stone, metal).
// Excludes finish absorbers / furnishings / rack doors from the picker. The
// physics still accepts ANY materialId; this just curates the dropdown.
const CONSTRUCTION_RE = /concrete|gypsum|glass|plaster|brick|cmu|wall_|wood|stone|metal|steel|block|masonry|tile|drywall/i;

// Default material per type — must exist in materials.json.
const DEFAULT_MATERIAL = {
  pillar: 'concrete-painted',
  half_wall: 'gypsum-board',
  partition: 'gypsum-board',
  beam: 'concrete-painted',
  platform: 'wood-floor',
};

// Type metadata: chip label + the factory that builds a default placed entry.
const TYPES = {
  pillar:    { label: 'Pillar',    glyph: '<rect x="9" y="3" width="6" height="18" rx="1"/>' },
  half_wall: { label: 'Half-wall', glyph: '<rect x="3" y="11" width="18" height="9"/>' },
  partition: { label: 'Partition', glyph: '<rect x="3" y="3" width="18" height="17"/>' },
  beam:      { label: 'Beam',      glyph: '<rect x="3" y="4" width="18" height="4"/>' },
  platform:  { label: 'Platform',  glyph: '<rect x="3" y="14" width="18" height="6"/>' },
};

// Build a default structure of `type` at plan position {x,y}.
export function makeStructure(type, x, y) {
  const base = {
    id: nextStructureId(),
    type,
    label: TYPES[type]?.label ?? 'Structure',
    position: { x, y },
    rotation_deg: 0,
    materialId: DEFAULT_MATERIAL[type] ?? 'concrete-painted',
    elev_m: 0,
  };
  switch (type) {
    case 'pillar':
      return { ...base, crossSection: 'round', diameter_m: 0.4, width_m: 0.4, depth_m: 0.4, sides: 6, fullHeight: true, height_m: state.room?.height_m ?? 3 };
    case 'half_wall':
      return { ...base, length_m: 3, height_m: 1.1, thickness_m: 0.12, fullHeight: false, openings: [] };
    case 'partition':
      return { ...base, length_m: 4, height_m: state.room?.height_m ?? 3, thickness_m: 0.12, fullHeight: true, openings: [] };
    case 'beam':
      return { ...base, length_m: 5, width_m: 0.3, depth_m: 0.4, soffitDrop_m: 0.4 };
    case 'platform':
      return { ...base, width_m: 3, depth_m: 2, height_m: 0.3 };
    default:
      return base;
  }
}

// Arm the next 2D click to place a structure of `type`. Mirrors furniture's
// arm protocol: set a transient flag, broadcast, flip to the 2D view.
export function armStructurePlacement(type) {
  state.structureArmed = { type };
  emit('structure:arm_placement', { type });
  if (location.hash !== '#/room') location.hash = '#/room';
  setTimeout(() => {
    const tab2d = document.querySelector('#route-room .vp-tab[data-view="2d"]');
    if (tab2d && !tab2d.classList.contains('active')) tab2d.click();
  }, 0);
}

export function cancelStructurePlacement() {
  if (!state.structureArmed) return;
  state.structureArmed = null;
  emit('structure:cancel_placement', {});
}

export async function mountStructurePanel() {
  if (_mounted) return;
  _mounted = true;
  const root = document.getElementById('panel-structure');
  if (!root) return;

  root.innerHTML = `<h2>Building structure <span class="fl-rail-beta">beta</span></h2>
    <div class="ps-body"><div class="phase-placeholder">Loading…</div></div>`;

  try {
    await loadSurfaceCatalogue();   // registers the structure-material provider
  } catch (_) { /* dropdown falls back to the default id below */ }

  render(root);
  on('structure:changed', () => render(root));
  on('structure:selected', () => render(root));
  on('structure:placement_armed', () => render(root));
  on('structure:arm_placement', () => render(root));
  on('structure:cancel_placement', () => render(root));
  on('scene:reset', () => render(root));
}

// Construction materials for the picker: {id, name}, sorted by name.
function constructionMaterials() {
  const cat = getStructureMaterialCatalogue();
  const out = [];
  if (cat && typeof cat.forEach === 'function') {
    cat.forEach((row, id) => {
      if (CONSTRUCTION_RE.test(id) || CONSTRUCTION_RE.test(row?.name ?? '')) {
        out.push({ id, name: row?.name ?? id });
      }
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function render(root) {
  const placed = Array.isArray(state.structures) ? state.structures : [];
  const armed = state.structureArmed;
  const selId = state.selectedStructureId;

  const chips = Object.entries(TYPES).map(([t, def]) => `
    <button type="button" class="ps-chip ${armed?.type === t ? 'armed' : ''}" data-type="${t}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${def.glyph}</svg>
      <span>${def.label}</span>
    </button>`).join('');

  const armedBanner = armed ? `
    <div class="ps-armed" role="status" aria-live="polite">
      <span>⊕ Click in the floor plan to place a ${escapeHtml(TYPES[armed.type]?.label ?? 'structure')}.</span>
      <button type="button" class="ps-armed-cancel">Cancel</button>
    </div>` : '';

  const placedRows = placed.length === 0
    ? `<div class="ps-empty">No structures yet. Pick a type above, then click in the floor plan to place it.</div>`
    : placed.map(s => renderRow(s, s.id === selId)).join('');

  root.innerHTML = `
    <h2>Building structure <span class="fl-rail-beta">beta</span></h2>
    <div class="ps-body">
      <p class="ps-intro">Pillars, half-walls and beams inside the room. They block and scatter sound — the acoustic result updates live.</p>
      <div class="ps-add">
        <div class="ps-add-head">Add</div>
        <div class="ps-chips">${chips}</div>
      </div>
      ${armedBanner}
      <div class="ps-placed">
        <div class="ps-placed-head">Placed in this room <span class="ps-count">${placed.length}</span></div>
        <div class="ps-placed-list">${placedRows}</div>
      </div>
      <p class="ps-note">Diffraction shadows are approximate (±3 dB) and a thin column only shadows higher frequencies — bass wraps around it. Transmission loss shown is a lab value.</p>
    </div>`;

  wire(root);
  applyGlossary(root);
}

// One placed row, collapsed or (when selected) expanded with the editor.
function renderRow(s, selected) {
  const meta = rowMeta(s);
  const editor = selected ? renderEditor(s) : '';
  return `
    <div class="ps-row ${selected ? 'selected' : ''}" data-id="${escapeAttr(s.id)}">
      <button type="button" class="ps-row-head">
        <span class="ps-row-id">${escapeHtml(s.id)}</span>
        <span class="ps-row-name">${escapeHtml(s.label || TYPES[s.type]?.label || s.type)}</span>
        <span class="ps-row-meta">${escapeHtml(meta)}</span>
      </button>
      <button type="button" class="ps-row-remove" title="Remove" aria-label="Remove ${escapeAttr(s.label || s.type)}">×</button>
      ${editor}
    </div>`;
}

// Compact one-line summary so the list scans without expanding.
function rowMeta(s) {
  const mm = (m) => `${Math.round((Number(m) || 0) * 1000)}`;
  switch (s.type) {
    case 'pillar': {
      const shape = s.crossSection === 'round' ? `round Ø${mm(s.diameter_m)}` : s.crossSection === 'polygon' ? `${s.sides}-gon Ø${mm(s.diameter_m)}` : `square ${mm(s.width_m)}`;
      return `${shape} · ${s.fullHeight ? 'full-ht' : (Number(s.height_m) || 0).toFixed(2) + ' m'}`;
    }
    case 'half_wall': return `${(Number(s.length_m) || 0).toFixed(1)} m · ${(Number(s.height_m) || 0).toFixed(2)} m high`;
    case 'partition': return `${(Number(s.length_m) || 0).toFixed(1)} m · full height`;
    case 'beam': return `${(Number(s.length_m) || 0).toFixed(1)} m · drop ${(Number(s.soffitDrop_m) || 0).toFixed(2)} m`;
    case 'platform': return `${(Number(s.width_m) || 0).toFixed(1)}×${(Number(s.depth_m) || 0).toFixed(1)} m · ${(Number(s.height_m) || 0).toFixed(2)} m high`;
    default: return '';
  }
}

// --- Per-type editor -------------------------------------------------------
// num(): a labelled number field. unit 'm' stores metres directly; unit 'mm'
// displays/edits millimetres but stores metres.
function num(key, label, val, unit, { step = unit === 'mm' ? 10 : 0.1, min = 0, max = 1e4 } = {}) {
  const display = unit === 'mm' ? Math.round((Number(val) || 0) * 1000) : (Number(val) || 0);
  return `<label class="ps-field">
    <span>${label}</span>
    <input type="number" data-key="${key}" data-unit="${unit}" value="${display}" step="${step}" min="${min}" max="${max}" />
    <span class="ps-unit">${unit === 'deg' ? '°' : unit}</span>
  </label>`;
}

function materialSelect(s) {
  const opts = constructionMaterials();
  const list = opts.length ? opts : [{ id: s.materialId, name: s.materialId }];
  const options = list.map(o => `<option value="${escapeAttr(o.id)}" ${o.id === s.materialId ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('');
  // If the current material isn't in the construction list, surface it anyway.
  const extra = list.some(o => o.id === s.materialId) ? '' : `<option value="${escapeAttr(s.materialId)}" selected>${escapeHtml(s.materialId)}</option>`;
  return `<label class="ps-field ps-field-wide">
    <span>Material</span>
    <select data-key="materialId">${extra}${options}</select>
  </label>`;
}

function renderEditor(s) {
  let fields = `<label class="ps-field ps-field-wide"><span>Label</span><input type="text" data-key="label" value="${escapeAttr(s.label || '')}" /></label>`;

  if (s.type === 'pillar') {
    fields += `<div class="ps-seg" role="radiogroup" aria-label="Cross-section">
      ${['round', 'square', 'polygon'].map(cs => `<button type="button" class="ps-seg-btn ${s.crossSection === cs ? 'on' : ''}" role="radio" aria-checked="${s.crossSection === cs}" data-shape="${cs}">${cs[0].toUpperCase() + cs.slice(1)}</button>`).join('')}
    </div>`;
    if (s.crossSection === 'square') {
      fields += `<div class="ps-row2">${num('width_m', 'Width', s.width_m, 'mm')}${num('depth_m', 'Depth', s.depth_m, 'mm')}</div>`;
    } else {
      fields += num('diameter_m', 'Diameter', s.diameter_m, 'mm');
      if (s.crossSection === 'polygon') fields += num('sides', 'Sides', s.sides, 'count', { step: 1, min: 3, max: 12 });
    }
    fields += `<label class="ps-check"><input type="checkbox" data-key="fullHeight" ${s.fullHeight ? 'checked' : ''} /> Full height (floor→ceiling)</label>`;
    if (!s.fullHeight) fields += num('height_m', 'Height', s.height_m, 'm');
    fields += materialSelect(s);
    if (s.crossSection !== 'round') fields += num('rotation_deg', 'Rotation', s.rotation_deg, 'deg', { step: 5, min: -360, max: 360 });
    fields += num('elev_m', 'Elevation', s.elev_m, 'm');
  } else if (s.type === 'half_wall') {
    fields += `<div class="ps-row2">${num('length_m', 'Length', s.length_m, 'm')}${num('thickness_m', 'Thickness', s.thickness_m, 'mm')}</div>`;
    fields += `<label class="ps-check"><input type="checkbox" data-key="fullHeight" ${s.fullHeight ? 'checked' : ''} /> Full height (floor→ceiling)</label>`;
    if (!s.fullHeight) fields += num('height_m', 'Height', s.height_m, 'm');
    fields += materialSelect(s);
    fields += `<div class="ps-row2">${num('rotation_deg', 'Rotation', s.rotation_deg, 'deg', { step: 5, min: -360, max: 360 })}${num('elev_m', 'Elevation', s.elev_m, 'm')}</div>`;
  } else if (s.type === 'partition') {
    fields += `<div class="ps-row2">${num('length_m', 'Length', s.length_m, 'm')}${num('thickness_m', 'Thickness', s.thickness_m, 'mm')}</div>`;
    fields += materialSelect(s);
    fields += num('rotation_deg', 'Rotation', s.rotation_deg, 'deg', { step: 5, min: -360, max: 360 });
  } else if (s.type === 'beam') {
    fields += num('length_m', 'Length', s.length_m, 'm');
    fields += `<div class="ps-row2">${num('width_m', 'Width', s.width_m, 'mm')}${num('depth_m', 'Depth', s.depth_m, 'mm')}</div>`;
    fields += num('soffitDrop_m', 'Soffit drop', s.soffitDrop_m, 'm');
    fields += materialSelect(s);
    fields += num('rotation_deg', 'Rotation', s.rotation_deg, 'deg', { step: 5, min: -360, max: 360 });
  } else if (s.type === 'platform') {
    fields += `<div class="ps-row2">${num('width_m', 'Width', s.width_m, 'm')}${num('depth_m', 'Depth', s.depth_m, 'm')}</div>`;
    fields += num('height_m', 'Height (riser)', s.height_m, 'm');
    fields += materialSelect(s);
    fields += num('rotation_deg', 'Rotation', s.rotation_deg, 'deg', { step: 5, min: -360, max: 360 });
  }

  return `<div class="ps-editor">${fields}
    <div class="ps-editor-actions">
      <button type="button" class="ps-dup">Duplicate</button>
    </div>
  </div>`;
}

// --- Wiring ----------------------------------------------------------------
function wire(root) {
  // Type chips → arm placement.
  root.querySelectorAll('.ps-chip').forEach(el => {
    el.addEventListener('click', () => armStructurePlacement(el.dataset.type));
  });
  root.querySelector('.ps-armed-cancel')?.addEventListener('click', cancelStructurePlacement);

  root.querySelectorAll('.ps-row').forEach(rowEl => {
    const id = rowEl.dataset.id;
    if (!id) return;
    const s = state.structures.find(x => x.id === id);
    if (!s) return;

    rowEl.querySelector('.ps-row-head')?.addEventListener('click', () => {
      state.selectedStructureId = state.selectedStructureId === id ? null : id;
      emit('structure:selected', { id: state.selectedStructureId });
    });
    rowEl.querySelector('.ps-row-remove')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = state.structures.findIndex(x => x.id === id);
      if (idx >= 0) {
        state.structures.splice(idx, 1);
        if (state.selectedStructureId === id) state.selectedStructureId = null;
        emit('structure:changed', { removed: id });
      }
    });

    // Editor controls (only present when this row is selected/expanded).
    rowEl.querySelectorAll('.ps-editor input, .ps-editor select').forEach(inp => {
      const evName = inp.tagName === 'SELECT' || inp.type === 'checkbox' ? 'change' : 'input';
      inp.addEventListener(evName, () => {
        const key = inp.dataset.key;
        if (!key) return;
        if (inp.type === 'checkbox') {
          s[key] = inp.checked;
          // fullHeight on → snap height to ceiling for display consistency.
          if (key === 'fullHeight' && inp.checked) s.height_m = state.room?.height_m ?? 3;
          emit('structure:changed', { id, key });
          // checkbox toggles a sub-control's visibility → re-render this panel.
          render(root);
          return;
        }
        if (inp.tagName === 'SELECT') { s[key] = inp.value; emit('structure:changed', { id, key }); return; }
        if (inp.dataset.key === 'label') { s.label = inp.value; emit('structure:changed', { id, key }); return; }
        // numeric
        let v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return;
        const unit = inp.dataset.unit;
        if (unit === 'mm') v = v / 1000;
        if (key === 'sides') v = Math.max(3, Math.min(12, Math.round(v)));
        s[key] = v;
        if (s._cachedSpec) delete s._cachedSpec;
        emit('structure:changed', { id, key });
      });
    });

    // Shape segmented control (pillar).
    rowEl.querySelectorAll('.ps-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        s.crossSection = btn.dataset.shape;
        emit('structure:changed', { id, key: 'crossSection' });
        render(root);   // shape change swaps which size fields show
      });
    });

    rowEl.querySelector('.ps-dup')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const newId = duplicateStructure(id);
      if (newId) {
        state.selectedStructureId = newId;
        emit('structure:changed', { id: newId });
        emit('structure:selected', { id: newId });
      }
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
