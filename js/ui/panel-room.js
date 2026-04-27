import { state, PRESETS, TEMPLATES, SHAPE_LABELS, CEILING_LABELS, applyPresetToState, applyTemplateToState } from '../app-state.js';
import { emit } from './events.js';
import { startDrawCustomShape } from '../graphics/room-2d.js';
import { importDxfFile } from '../physics/dxf-import.js';
import { saveProjectToDownload, loadProjectFromFile } from '../io/project-file.js';
import { encodeShareLink, buildShareUrl } from '../io/share-link.js';

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
    <div class="room-head">
      <h2>Room</h2>
      <div class="room-head-actions">
        <button id="btn-save-project" class="btn-save" title="Save the entire project (room, speakers, listeners, zones, EQ, ambient noise) to a .roomlab.json file">💾 Save</button>
        <button id="btn-load-project" class="btn-load" title="Load a previously saved .roomlab.json project file">📂 Load</button>
        <button id="btn-share-link" class="btn-share" aria-label="share scene as link" title="copy a URL that opens this exact scene — paste into Slack or email">🔗 Share</button>
        <input type="file" id="file-roomlab" accept=".json,.roomlab.json,application/json" hidden />
      </div>
    </div>
    <div class="picker-row">
      <span class="picker-label" title="Signature pre-built scenes that load with their full geometry, audience, and PA system as authored.">Presets</span>
      <div class="picker-buttons" id="preset-row"></div>
    </div>
    <div class="picker-row">
      <span class="picker-label" title="Parametric room shapes — pick a starting layout and edit the dimensions below to whatever size you need. The speakers and listener auto-scale with the room.">Templates</span>
      <div class="picker-buttons" id="template-row"></div>
    </div>
    <div class="import-row">
      <button id="btn-import-dxf" class="btn-import" title="Import room outline from a DXF file (DWG must be converted first)">⇪ Import DXF…</button>
      <input type="file" id="file-dxf" accept=".dxf,.dwg" hidden />
    </div>
    <div id="import-status" class="import-status" hidden></div>
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

  // Presets row — signature scenes (Arena, Pavilion) load verbatim.
  const presetRow = root.querySelector('#preset-row');
  for (const [key, p] of Object.entries(PRESETS)) {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.dataset.preset = key;
    btn.addEventListener('click', () => applyPreset(key));
    presetRow.appendChild(btn);
  }

  // Templates row — parametric rooms regenerate when the user changes
  // dimensions. Tracks which template was last applied so dimension
  // edits can re-call generate(dims) with the user's overrides.
  const templateRow = root.querySelector('#template-row');
  for (const [key, t] of Object.entries(TEMPLATES)) {
    const btn = document.createElement('button');
    btn.textContent = t.label;
    btn.dataset.template = key;
    btn.addEventListener('click', () => applyTemplate(key));
    templateRow.appendChild(btn);
  }

  // Save / Load — save dumps state to a .roomlab.json file via Blob
  // download; load reads a file back through deserializeProject and
  // emits scene:reset so every panel rebuilds against the new state.
  root.querySelector('#btn-save-project').addEventListener('click', () => {
    try {
      const filename = saveProjectToDownload();
      showStatus(`Saved as ${filename}`, 'ok');
    } catch (err) {
      showStatus(`Save failed: ${err.message || err}`, 'err');
    }
  });

  // Share — encode current state into a URL fragment, copy it. Oversize
  // scenes (pavilion-class, ~70 KB encoded) get a "use Save instead"
  // banner. Clipboard write may silently fail on Safari outside a user
  // gesture chain — surface the URL inline as the fallback.
  root.querySelector('#btn-share-link').addEventListener('click', async () => {
    const { hash, chars, tooLarge, bytes } = encodeShareLink();
    if (tooLarge) {
      showStatus(`scene too large for a link (${(bytes / 1024).toFixed(1)} KB) — use 💾 Save instead`, 'err');
      return;
    }
    const url = buildShareUrl(hash);
    try {
      await navigator.clipboard.writeText(url);
      showToast(`link copied — ${(bytes / 1024).toFixed(1)} KB`, 'ok');
    } catch {
      // Clipboard rejected (Safari without user gesture, or insecure
      // context). Show the URL inline so the user can copy by hand.
      showStatus(`couldn't auto-copy — copy this URL manually:\n${url}`, 'err');
    }
  });
  const projectFileInput = root.querySelector('#file-roomlab');
  root.querySelector('#btn-load-project').addEventListener('click', () => projectFileInput.click());
  projectFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    projectFileInput.value = ''; // allow reloading the same file
    if (!file) return;
    try {
      const { warnings } = await loadProjectFromFile(file);
      const warnSuffix = warnings?.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : '';
      showStatus(`Loaded ${file.name}${warnSuffix}`, 'ok');
      // Re-render the room panel itself so the shape select etc. reflect
      // the loaded state. scene:reset already woke every other panel.
      render();
    } catch (err) {
      showStatus(err.message || String(err), 'err');
    }
  });

  // DXF import — converts largest closed polyline in the file into the
  // current room's custom_vertices. Height and surface materials are
  // preserved; user edits them after.
  const fileInput = root.querySelector('#file-dxf');
  root.querySelector('#btn-import-dxf').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleDxfImport(file);
    fileInput.value = ''; // allow re-selecting the same file
  });

  root.querySelector('[data-f="shape"]').addEventListener('change', e => {
    state.room.shape = e.target.value;
    if (e.target.value === 'custom' && (!state.room.custom_vertices || state.room.custom_vertices.length < 3)) {
      // Seed with a default L-shape so user sees something before drawing
      state.room.custom_vertices = [
        { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }, { x: 2.5, y: 3 }, { x: 2.5, y: 5 }, { x: 0, y: 5 },
      ];
      state.room.width_m = 5;
      state.room.depth_m = 5;
      state.room.surfaces.edges = state.room.custom_vertices.map(() => state.room.surfaces.walls || 'gypsum-board');
    }
    syncBoundingBoxToShape();
    // Manual shape change drops any active template association — the
    // user is hand-editing the room, so dimension changes shouldn't
    // re-run a template generator.
    activeTemplateKey = null;
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

// Tracks which template (if any) is the live "source" of the current
// room. While set, dimension edits in the Shape section regenerate the
// template's sources/listeners so the layout stays consistent. Cleared
// when the user applies a Preset, draws a custom shape, loads a project
// file, or hits Import DXF.
let activeTemplateKey = null;

function showStatus(text, kind) {
  const status = document.getElementById('import-status');
  if (!status) return;
  status.hidden = false;
  status.className = 'import-status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
  status.textContent = text;
}

// Transient bottom-of-viewport toast — used for success acks where the
// import-status banner would be too sticky / formal (link copied,
// shared scene loaded). Replaces any prior toast so rapid clicks don't
// stack messages.
export function showToast(text, kind = 'ok', durationMs = 2500) {
  document.querySelectorAll('.rl-toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = `rl-toast rl-toast-${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  // Force a reflow so the .show class triggers a transition rather than
  // applying instantly — no fade-in otherwise.
  void el.offsetHeight;
  el.classList.add('show');
  const dismiss = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  };
  const t = setTimeout(dismiss, durationMs);
  el.addEventListener('click', () => { clearTimeout(t); dismiss(); });
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
  } else if (r.shape === 'custom') {
    const vcount = (r.custom_vertices || []).length;
    root.innerHTML = `
      <div class="field-group">
        <label>Height <input type="number" data-sf="height_m" value="${r.height_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
      </div>
      <button class="btn-draw" id="btn-draw-custom">${vcount >= 3 ? '✎ Redraw custom shape' : '✎ Draw custom shape'}</button>
      ${vcount >= 3 ? `<div class="note-small">${vcount} vertices · bbox ${r.width_m.toFixed(1)} × ${r.depth_m.toFixed(1)} m</div>` : '<div class="note-small">Click the button above to draw a polygon by placing vertices.</div>'}
      <div id="vertex-list"></div>
    `;
    root.querySelector('#btn-draw-custom').addEventListener('click', () => startDrawCustomShape());
    renderVertexList();
  }
  wireShapeInputs();
}

function renderVertexList() {
  const root = document.getElementById('vertex-list');
  if (!root) return;
  const verts = state.room.custom_vertices || [];
  if (verts.length === 0) { root.innerHTML = ''; return; }
  root.innerHTML = `
    <h4>Vertices</h4>
    <div class="vertex-list">
      ${verts.map((v, i) => `
        <div class="vertex-row">
          <span class="vertex-idx">${i + 1}</span>
          <label>X <input type="number" data-vf="x" data-vi="${i}" value="${v.x.toFixed(2)}" step="0.1" /></label>
          <label>Y <input type="number" data-vf="y" data-vi="${i}" value="${v.y.toFixed(2)}" step="0.1" /></label>
          ${verts.length > 3 ? `<button class="btn-remove" data-vdel="${i}" title="Remove vertex">×</button>` : '<span></span>'}
        </div>
      `).join('')}
    </div>
  `;
  root.querySelectorAll('[data-vf]').forEach(input => {
    input.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.vi, 10);
      const field = e.target.dataset.vf;
      const v = parseFloat(e.target.value);
      if (isNaN(v)) return;
      state.room.custom_vertices[idx][field] = v;
      updateCustomBoundingBox();
      emit('room:changed');
    });
  });
  root.querySelectorAll('[data-vdel]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.vdel, 10);
      state.room.custom_vertices.splice(idx, 1);
      if (state.room.surfaces.edges) state.room.surfaces.edges.splice(idx, 1);
      updateCustomBoundingBox();
      renderVertexList();
      renderSurfaceMaterials();
      emit('room:changed');
    });
  });
}

function updateCustomBoundingBox() {
  const v = state.room.custom_vertices;
  if (!v || v.length === 0) return;
  const minX = Math.min(...v.map(p => p.x));
  const minY = Math.min(...v.map(p => p.y));
  const maxX = Math.max(...v.map(p => p.x));
  const maxY = Math.max(...v.map(p => p.y));
  state.room.width_m = Math.max(maxX - minX, 0.5);
  state.room.depth_m = Math.max(maxY - minY, 0.5);
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
      // If a template is the live source for the current room, re-run
      // its generator with the updated dimensions so sources/listeners
      // scale to match. Skip when the user has already started hand-
      // editing (no activeTemplateKey).
      if (activeTemplateKey) {
        regenerateActiveTemplate();
      }
      emit('room:changed');
    });
  });
}

function regenerateActiveTemplate() {
  if (!activeTemplateKey || !TEMPLATES[activeTemplateKey]) return;
  // Pull the dimension fields the template cares about straight from
  // state — the user just typed them. Untouched fields fall back to
  // the template's defaultDims via applyTemplateToState merging.
  const dims = {
    width_m: state.room.width_m,
    depth_m: state.room.depth_m,
    height_m: state.room.height_m,
    polygon_sides: state.room.polygon_sides,
    polygon_radius_m: state.room.polygon_radius_m,
    round_radius_m: state.room.round_radius_m,
    ceiling_dome_rise_m: state.room.ceiling_dome_rise_m,
  };
  applyTemplateToState(activeTemplateKey, dims);
  emit('scene:reset');
}

function renderSurfaceMaterials() {
  const root = document.getElementById('surface-materials');
  root.innerHTML = '';

  if (state.room.shape === 'custom') {
    const group1 = document.createElement('div');
    group1.className = 'field-group';
    for (const [id, label] of [['floor', 'Floor'], ['ceiling', 'Ceiling']]) {
      const wrap = document.createElement('label');
      const sel = buildMatSelect(id, state.room.surfaces[id]);
      sel.addEventListener('change', e => {
        state.room.surfaces[id] = e.target.value;
        emit('room:changed');
      });
      wrap.append(label + ' ', sel);
      group1.appendChild(wrap);
    }
    root.appendChild(group1);

    const h4 = document.createElement('h4');
    h4.textContent = 'Edge materials';
    root.appendChild(h4);

    const nEdges = (state.room.custom_vertices || []).length;
    if (!state.room.surfaces.edges || state.room.surfaces.edges.length !== nEdges) {
      state.room.surfaces.edges = Array.from({ length: nEdges }, (_, i) => state.room.surfaces.edges?.[i] ?? 'gypsum-board');
    }
    const edgeGroup = document.createElement('div');
    edgeGroup.className = 'field-group';
    for (let i = 0; i < nEdges; i++) {
      const wrap = document.createElement('label');
      const sel = buildMatSelect(`edge-${i}`, state.room.surfaces.edges[i]);
      sel.addEventListener('change', e => {
        state.room.surfaces.edges[i] = e.target.value;
        emit('room:changed');
      });
      wrap.append(`Edge ${i + 1} `, sel);
      edgeGroup.appendChild(wrap);
    }
    root.appendChild(edgeGroup);
    return;
  }

  const labels = state.room.shape === 'rectangular' ? RECT_SURFACE_LABELS : NONRECT_SURFACE_LABELS;
  const group = document.createElement('div');
  group.className = 'field-group';
  for (const [id, label] of labels) {
    const wrap = document.createElement('label');
    const sel = buildMatSelect(id, state.room.surfaces[id]);
    sel.addEventListener('change', e => {
      state.room.surfaces[id] = e.target.value;
      emit('room:changed');
    });
    wrap.append(label + ' ', sel);
    group.appendChild(wrap);
  }
  root.appendChild(group);
}

function buildMatSelect(dataKey, currentValue) {
  const sel = document.createElement('select');
  sel.dataset.key = dataKey;
  sel.innerHTML = materialsRef.list.filter(m => m.id !== 'audience-seated').map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  sel.value = currentValue ?? materialsRef.list[0].id;
  return sel;
}

function applyPreset(key) {
  applyPresetToState(key);
  // Presets have fixed geometry — no template regen on dim changes.
  activeTemplateKey = null;
  render();
  // scene:reset tells every panel/viewport that state arrays were replaced wholesale.
  // room:changed kept for listeners that only care about room geometry.
  emit('scene:reset');
  emit('room:changed');
}

function applyTemplate(key) {
  applyTemplateToState(key);
  activeTemplateKey = key;
  render();
  emit('scene:reset');
  emit('room:changed');
}

async function handleDxfImport(file) {
  const status = document.getElementById('import-status');
  status.hidden = false;
  status.className = 'import-status';
  status.textContent = `Reading ${file.name}…`;
  try {
    const { polygons, bestIndex, source_units } = await importDxfFile(file);
    const best = polygons[bestIndex];
    // Translate so the polygon's bbox starts at the origin (consistent with
    // the draw-custom convention — the 2D viewport expects x/y >= 0).
    const minX = Math.min(...best.vertices.map(v => v.x));
    const minY = Math.min(...best.vertices.map(v => v.y));
    const verts = best.vertices.map(v => ({ x: v.x - minX, y: v.y - minY }));
    const w = Math.max(...verts.map(v => v.x));
    const d = Math.max(...verts.map(v => v.y));

    state.room.shape = 'custom';
    state.room.custom_vertices = verts;
    state.room.width_m = w;
    state.room.depth_m = d;
    state.room.surfaces.edges = verts.map(() => state.room.surfaces.walls || 'gypsum-board');
    activeTemplateKey = null;

    render();
    emit('room:changed');

    const more = polygons.length > 1 ? ` (${polygons.length - 1} other closed polylines in file, largest used)` : '';
    status.textContent = `Imported ${verts.length}-vertex room · ${best.area_m2.toFixed(1)} m² · bbox ${w.toFixed(1)} × ${d.toFixed(1)} m · units ${source_units}${more}`;
    status.classList.add('ok');
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('err');
  }
}

// Listen for room:changed to re-render panel when draw mode finishes
import { on } from './events.js';
on('room:changed', () => {
  const root = document.getElementById('panel-room');
  if (!root) return;
  const shapeSel = root.querySelector('[data-f="shape"]');
  if (shapeSel && shapeSel.value !== state.room.shape) {
    shapeSel.value = state.room.shape;
    render();
  } else if (state.room.shape === 'custom') {
    renderShapeParams();
    renderSurfaceMaterials();
  }
});

// Project file load drops the activeTemplateKey association — the loaded
// scene is whatever was saved, and dimension edits should not re-run a
// template generator on top of it.
on('scene:reset', () => {
  // Note: don't reset activeTemplateKey if WE just set it via applyTemplate
  // — scene:reset is emitted both from us and from project-file load.
  // Distinguishing requires a payload; for v1 we accept that loading a
  // project file dropped from a template still loses the regen behaviour,
  // which is the conservative default.
});
