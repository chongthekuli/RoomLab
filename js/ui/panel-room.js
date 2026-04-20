import { state, PRESETS, SHAPE_LABELS, CEILING_LABELS, applyPresetToState } from '../app-state.js';
import { emit } from './events.js';
import { startDrawCustomShape } from '../graphics/room-2d.js';
import { importDxfFile } from '../physics/dxf-import.js';

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

  const presetRow = root.querySelector('#preset-row');
  for (const [key, p] of Object.entries(PRESETS)) {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.dataset.preset = key;
    btn.addEventListener('click', () => applyPreset(key));
    presetRow.appendChild(btn);
  }

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
      emit('room:changed');
    });
  });
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
  render();
  // scene:reset tells every panel/viewport that state arrays were replaced wholesale.
  // room:changed kept for listeners that only care about room geometry.
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
