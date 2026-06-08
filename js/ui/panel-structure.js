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

import { state, nextStructureId, duplicateStructure, removeToiletListeners } from '../app-state.js';
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

// Toilet cubicle partitions are a narrow, realistic material set — drywall
// partitions, plastered / ceramic-tiled hard walls, painted blockwork, and
// glass vision panels. The full bulk-construction list (double-stud isolation
// assemblies, stone, perforated metal deck, LED panels…) is unrealistic for a
// WC cubicle, so the toilet picker is curated down to these. Order = sensible
// default first. Each id MUST exist in materials.json.
export const TOILET_MATERIAL_IDS = [
  'gypsum-board',     // drywall / plasterboard partition (default)
  'plaster-smooth',   // plastered or ceramic-tiled hard wall (also HPL-board proxy)
  'concrete-painted', // painted concrete / tiled blockwork
  'cmu_200_hollow',   // concrete-block partition wall
  'glass-window',     // glass partition / above-door vision panel
];

// Default material per type — must exist in materials.json.
const DEFAULT_MATERIAL = {
  pillar: 'concrete-painted',
  half_wall: 'gypsum-board',
  partition: 'gypsum-board',
  beam: 'concrete-painted',
  platform: 'wood-floor',
  toilet: 'gypsum-board',
};

// Type metadata: chip label + the factory that builds a default placed entry.
const TYPES = {
  pillar:    { label: 'Pillar',    glyph: '<rect x="9" y="3" width="6" height="18" rx="1"/>' },
  half_wall: { label: 'Half-wall', glyph: '<rect x="3" y="11" width="18" height="9"/>' },
  partition: { label: 'Partition', glyph: '<rect x="3" y="3" width="18" height="17"/>' },
  beam:      { label: 'Beam',      glyph: '<rect x="3" y="4" width="18" height="4"/>' },
  platform:  { label: 'Platform',  glyph: '<rect x="3" y="14" width="18" height="6"/>' },
  toilet:    { label: 'Toilet',    glyph: '<rect x="3" y="4" width="5" height="16"/><rect x="9.5" y="4" width="5" height="16"/><rect x="16" y="4" width="5" height="16"/>' },
};

// Auto-number a per-type label: count existing structures of this `type` and
// append the next ordinal, e.g. "Toilet block 1", "Toilet block 2". Keeps
// each type's human-readable base name from TYPES (toilet → "Toilet block").
function nextStructureLabel(type) {
  const baseName = type === 'toilet' ? 'Toilet block' : (TYPES[type]?.label ?? 'Structure');
  const n = (state.structures ?? []).filter(s => s.type === type).length + 1;
  return `${baseName} ${n}`;
}

// Build a default structure of `type` at plan position {x,y}.
export function makeStructure(type, x, y) {
  const base = {
    id: nextStructureId(type),
    type,
    label: nextStructureLabel(type),
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
    case 'toilet':
      // Composite cubicle bank. ALL acoustic-relevant fields are present so
      // Phase 2 (the open/closed-top dB loss model) just consumes them; Phase 1
      // wires only geometry + walk-mode door + bowls. User-confirmed defaults:
      // 3 cubicles, single row, 0.30 m door undercut. backToBack reserved so
      // save-files round-trip (back-to-back layout is a later phase).
      return {
        ...base,
        cubicles: 3, pitch_m: 0.95, clearWidth_m: 0.90, clearDepth_m: 1.50, partitionThickness_m: 0.05,
        backToBack: false,
        topType: 'open',
        openTopBoardH_m: 2.00, scuffGap_m: 0.15,
        // v=773: closed-top boards run floor→real ceiling (no closedTopBoardH_m /
        // ceilingThk_m slab). doorLeafH_m is now COMPUTED, not stored. The closed
        // door top stops at doorClearH_m; the front latch reveal is frontLatchGap_m.
        doorClearH_m: 2.10,
        // v=774: leaf now fills the opening (≈0.88 m) so the avatar walks through.
        // doorLeafW_m left UNSET → expandToiletSurfaces computes leafW = clearWidth
        // − latchGap − hingeReveal = 0.88; hingeReveal_m is the 10 mm hinge-jamb gap
        // (replaces the old 0.29 m fixed filler). A smaller custom doorLeafW_m still
        // re-emits the filler for back-compat.
        doorSide: '+y', hingeSide: 'left', frontLatchGap_m: 0.010, hingeReveal_m: 0.010, doorThk_m: 0.04,
        undercut_m: 0.30,
        doorsOpen: [false, false, false],
        showBowls: true, seatHeight_m: 0.42,
      };
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

// Candidate materials for a structure type's picker. Toilet cubicles get the
// curated realistic subset; every other structure type uses the full
// bulk-construction list. Returns [{id, name}] preserving curated order for
// the toilet (default first), alphabetical for the rest.
function materialsForType(type) {
  if (type !== 'toilet') return constructionMaterials();
  const cat = getStructureMaterialCatalogue();
  return TOILET_MATERIAL_IDS.map(id => {
    const row = cat && typeof cat.get === 'function' ? cat.get(id) : null;
    return { id, name: row?.name ?? id };
  });
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
    case 'toilet': {
      const n = Math.max(1, Math.round(Number(s.cubicles) || 3));
      return `${n} cubicle${n === 1 ? '' : 's'} · ${s.topType === 'closed' ? 'closed-top' : 'open-top'}`;
    }
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

// Generic segmented control bound to an arbitrary string key. options is an
// array of [value, label]. Reuses the .ps-seg styling; wired via data-segkey.
function seg(key, label, current, options) {
  const btns = options.map(([val, lbl]) =>
    `<button type="button" class="ps-seg-btn ${current === val ? 'on' : ''}" role="radio" aria-checked="${current === val}" data-segkey="${escapeAttr(key)}" data-segval="${escapeAttr(val)}">${escapeHtml(lbl)}</button>`
  ).join('');
  return `<label class="ps-field ps-field-wide"><span>${escapeHtml(label)}</span></label>
    <div class="ps-seg" role="radiogroup" aria-label="${escapeAttr(label)}">${btns}</div>`;
}

function materialSelect(s) {
  const opts = materialsForType(s.type);
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
  } else if (s.type === 'toilet') {
    fields += num('cubicles', 'Cubicles', s.cubicles, 'count', { step: 1, min: 1, max: 12 });
    // Per-cubicle clear dimensions — ALL cubicles share these (the bank pitch =
    // clearWidth + partitionThickness, so widening one widens the whole bank).
    fields += `<div class="ps-row2">${num('clearWidth_m', 'Cubicle width', s.clearWidth_m ?? 0.90, 'm', { step: 0.05, min: 0.6, max: 2.0 })}${num('clearDepth_m', 'Cubicle depth/length', s.clearDepth_m ?? 1.50, 'm', { step: 0.05, min: 1.0, max: 2.5 })}</div>`;
    // Top type — open (boards stop short of the ceiling, room shares air) vs
    // closed (boards floor→real ceiling; no slab; the front above the door is
    // OPEN — v=781, no transom, like a real cubicle you can see over).
    fields += seg('topType', 'Top', s.topType ?? 'open', [['open', 'Open-top'], ['closed', 'Closed-top']]);
    // Floor gap (scuff gap) — only meaningful for OPEN-top boards. Open-top
    // boards float this far above the floor on pilaster feet (the realistic
    // commercial "scuff gap"). 0 = boards meet the floor (no gap, no feet). The
    // expander renders chrome feet under the floating boards when this is > 0.
    // Closed-top boards run floor→ceiling, so the gap is N/A and hidden.
    if ((s.topType ?? 'open') !== 'closed') {
      fields += num('scuffGap_m', 'Floor gap', s.scuffGap_m ?? 0.15, 'm', { step: 0.01, min: 0, max: 0.30 });
      fields += `<p class="ps-note" style="margin:.2rem 0 .3rem">Open-top partition clearance above the floor; 0 = meets floor. Floating boards stand on pilaster feet.</p>`;
    }
    // Hinge side (viewed from outside) — which front jamb the door pivots on.
    fields += seg('hingeSide', 'Hinge', s.hingeSide ?? 'left', [['left', 'Left'], ['right', 'Right']]);
    fields += num('undercut_m', 'Door undercut', s.undercut_m, 'm');
    // Door height (closed-top only): sets the door-leaf TOP; the space above the
    // door (door top → ceiling) stays OPEN like a real cubicle (v=781 — no
    // transom). Clamped 1.8 m up to the CEILING (room height − elevation) — set
    // it to the ceiling for a full-height door with no gap above. For OPEN-top
    // the leaf top tracks the partition height instead, so this field is hidden.
    if ((s.topType ?? 'open') === 'closed') {
      const ceilH = Number(state.room?.height_m) || 3;
      const elevH = Number(s.elev_m) || 0;
      const maxDoorH = Math.max(1.8, ceilH - elevH);
      fields += num('doorClearH_m', 'Door height', s.doorClearH_m ?? 2.10, 'm', { step: 0.05, min: 1.8, max: maxDoorH });
      fields += `<p class="ps-note" style="margin:.2rem 0 .3rem">Closed-top door-leaf top, up to the ceiling. Below the ceiling, the space above the door stays open (see over the door, like a real cubicle); at the ceiling it becomes a full-height door.</p>`;
    }
    fields += `<label class="ps-check"><input type="checkbox" data-key="showBowls" ${s.showBowls !== false ? 'checked' : ''} /> Show toilet bowls</label>`;
    fields += materialSelect(s);
    fields += num('rotation_deg', 'Rotation', s.rotation_deg, 'deg', { step: 5, min: -360, max: 360 });
    fields += `<p class="ps-note" style="margin:.4rem 0 0">Bank of ${Math.max(1, Math.round(Number(s.cubicles) || 3))} cubicles, single row. In walk-mode, stand at a door and press <strong>E</strong> to open/close it. Acoustic isolation is modelled in a later phase.</p>`;
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
        const wasToilet = state.structures[idx].type === 'toilet';
        state.structures.splice(idx, 1);
        if (state.selectedStructureId === id) state.selectedStructureId = null;
        // Cascade-delete the toilet's round cubicle listeners.
        if (wasToilet && removeToiletListeners(id)) emit('listener:changed');
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
        // Toilet per-cubicle clear dimensions — clamp to sane ranges. All
        // cubicles share these; the bank pitch (clearWidth + partitionThickness)
        // + lx/ly + the door leaf width (clearWidth − latchGap − hingeReveal) all
        // recompute downstream in toiletGeom / toiletFrontLayout, so a wider/
        // longer cubicle re-fans the doors + redraws 2D/3D on the emit below.
        if (key === 'clearWidth_m') v = Math.max(0.6, Math.min(2.0, v));
        if (key === 'clearDepth_m') v = Math.max(1.0, Math.min(2.5, v));
        // Floor gap (scuff gap) for open-top toilet partitions: 0–0.30 m. 0 =
        // boards meet the floor (no feet); >0 = boards float on pilaster feet.
        if (key === 'scuffGap_m') v = Math.max(0, Math.min(0.30, v));
        // Door height (closed-top): clamp to [1.8 m, ceiling] (room.height_m −
        // elev) so the door top never exceeds board.top (= ceiling). At the
        // ceiling it's a full-height door; below it the front stays open above
        // the leaf (v=781 — no transom). The expander also re-clamps
        // doorTop = min(elev+doorClearH, board.top), so this is belt-and-braces.
        if (key === 'doorClearH_m') {
          const ceilH = Number(state.room?.height_m) || 3;
          const elevH = Number(s.elev_m) || 0;
          v = Math.max(1.8, Math.min(ceilH - elevH, v));
        }
        if (key === 'cubicles') {
          v = Math.max(1, Math.min(12, Math.round(v)));
          s.cubicles = v;
          // Keep doorsOpen length in sync with the cubicle count (pad/truncate
          // with false) so the renderer + walk-mode never index out of range.
          const src = Array.isArray(s.doorsOpen) ? s.doorsOpen : [];
          s.doorsOpen = Array.from({ length: v }, (_, i) => src[i] === true);
          if (s._cachedSpec) delete s._cachedSpec;
          emit('structure:changed', { id, key });
          render(root);   // note copy mentions the count
          return;
        }
        s[key] = v;
        if (s._cachedSpec) delete s._cachedSpec;
        emit('structure:changed', { id, key });
      });
    });

    // Segmented controls. Shape (pillar) uses data-shape → crossSection; the
    // generic ones use data-segkey/data-segval (toilet topType / hingeSide).
    rowEl.querySelectorAll('.ps-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.segkey) {
          s[btn.dataset.segkey] = btn.dataset.segval;
          emit('structure:changed', { id, key: btn.dataset.segkey });
          render(root);   // open↔closed swaps note copy; re-render to reflect on-state
          return;
        }
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
