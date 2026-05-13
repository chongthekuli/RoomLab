// Acoustic-treatment panel — left-rail tool that lets the user drop
// pre-engineered absorbers / bass traps / diffusers / ceiling tiles
// from data/treatment-products.json onto the room walls and ceiling.
//
// v1 (this file): VISUAL-ONLY placement. The 3D viewport renders each
// treatment as a textured rectangle aligned to its anchor surface; the
// 2D viewport shows its footprint on the appropriate wall edge; the
// print-report BOM appendix aggregates them by productId. RT60 / STIPA
// math is UNCHANGED — the panel's absorption coefficients are NOT
// folded into roomSurfaces() until Dr. Chen's audit gates v2.
//
// Why visual-only first: Dr. Chen flagged that naive "add α·area to
// total surface absorption" double-counts the wall area the panel
// covers, biasing Sabine high. v2 will subtract the covered wall α
// and add the panel α with placement-aware diffuse-field corrections.
//
// Architecture:
//   * `state.treatments` is the source of truth (see app-state.js).
//   * The catalogue is loaded once from data/treatment-products.json
//     via the SurfaceLAB reader (js/labs/surfacelab/catalog.js), then
//     filtered to the four rail tabs (Absorbers / Bass / Diffusers /
//     Ceiling) mirroring SurfaceLAB's grouping.
//   * "Place" mode arms the 3D viewport's pointer to drop the next
//     click as a new treatment on the clicked wall / ceiling.
//   * Drag is constrained to the anchored surface plane (3D scene.js
//     handles the math; 2D room-2d.js handles the wall-edge case).
//
// Maya UX call: catalogue cards inline (no modal), single Place
// button per card, no separate confirm step. Pros want one-click drop.

import { state, duplicateTreatment } from '../app-state.js';
import { emit, on } from './events.js';
import { loadSurfaceCatalogue, findCatalogueEntry } from '../labs/surfacelab/catalog.js';
// NOTE: We avoid a direct import of scene.js to keep panel-treatments.js
// loadable from a non-DOM test environment (tests/treatments.test.mjs
// imports this module without Three.js). Placement arming is signalled
// via an event the scene subscribes to.

// Tab grouping — mirrors SurfaceLAB's first-segment rail order, minus
// 'surface' / 'opening' / 'system' (those aren't placeable treatments).
// Ceiling is a VIEW that filters in entries whose mounting starts with
// 'ceiling_' (same convention as SurfaceLAB).
const TABS = [
  { id: 'absorber', label: 'Absorbers',  segMatch: 'absorber' },
  { id: 'bass',     label: 'Bass traps', segMatch: 'bass' },
  { id: 'diffuser', label: 'Diffusers',  segMatch: 'diffuser' },
  { id: 'ceiling',  label: 'Ceiling',    segMatch: '__ceiling_view__' },
];

let _activeTab = 'absorber';
let _catalogueCache = null;   // resolved loadSurfaceCatalogue() result
let _expandedTreatments = new Set();  // treatment ids whose detail card is expanded
let _armedProductId = null;   // non-null while a + Place is awaiting a wall click in 3D

export async function mountTreatmentsPanel() {
  const root = document.getElementById('panel-treatments');
  if (!root) return;

  // Initial skeleton — replaced in render() once the catalogue resolves.
  root.innerHTML = `
    <h2>Treatments</h2>
    <div class="treatments-panel-body">
      <div class="phase-placeholder">Loading catalogue…</div>
    </div>
  `;

  // Kick off catalogue load. It's idempotent and cached across calls,
  // so a SurfaceLAB visit before/after RoomLAB shares the same fetch.
  try {
    _catalogueCache = await loadSurfaceCatalogue();
  } catch (err) {
    console.warn('[panel-treatments] catalogue load failed:', err);
    root.querySelector('.treatments-panel-body').innerHTML =
      `<div class="phase-placeholder">Couldn't load the treatment catalogue. Refresh the page to retry.</div>`;
    return;
  }

  render();

  on('scene:reset', () => {
    _expandedTreatments.clear();
    _armedProductId = null;
    render();
  });
  on('treatment:changed', () => { _armedProductId = null; render(); });
  on('treatment:selected', render);
  on('treatment:placement_armed', ({ productId } = {}) => {
    _armedProductId = productId || null;
    render();
  });
  on('treatment:placement_cancelled', () => {
    _armedProductId = null;
    render();
  });
}

function render() {
  const body = document.querySelector('#panel-treatments .treatments-panel-body');
  if (!body) return;
  const armedSpec = _armedProductId ? findCatalogueEntry(_armedProductId) : null;
  const armedBanner = armedSpec ? `
    <div class="treatments-armed" role="status" aria-live="polite">
      <span class="treatments-armed-icon" aria-hidden="true">⊕</span>
      <span class="treatments-armed-text">
        Click a wall or the ceiling in the 3D view to place
        <strong>${escapeHtml(armedSpec.name)}</strong>.
      </span>
      <button class="treatments-armed-cancel" type="button" data-armed-cancel>Cancel</button>
    </div>
  ` : '';
  body.innerHTML = `
    <div class="phase-placeholder treatments-disclaimer" role="note">
      <strong>Visual placement only.</strong> RT60 / STI unchanged in v1.
    </div>
    ${armedBanner}
    ${renderPlacedList()}
    <h3 class="treatments-h3">Catalogue</h3>
    <div class="treatments-tabs" role="tablist">
      ${TABS.map(t => `
        <button class="treatments-tab ${_activeTab === t.id ? 'is-active' : ''}"
                role="tab" aria-selected="${_activeTab === t.id ? 'true' : 'false'}"
                data-tab="${t.id}">${t.label}</button>
      `).join('')}
    </div>
    <div class="treatments-catalogue">${renderCatalogue()}</div>
  `;

  // Armed-state cancel
  body.querySelector('[data-armed-cancel]')?.addEventListener('click', () => {
    try { emit('treatment:cancel_placement'); } catch (_) {}
    _armedProductId = null;
    render();
  });

  // Tab clicks
  body.querySelectorAll('.treatments-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      render();
    });
  });

  // Placement buttons (one per product card)
  body.querySelectorAll('[data-place-product]').forEach(btn => {
    btn.addEventListener('click', () => {
      const productId = btn.dataset.placeProduct;
      // Signal the 3D scene to arm placement mode. The scene listens
      // for this event and switches its surface-click handler to drop
      // a new treatment instead of selecting a wall.
      try {
        emit('treatment:arm_placement', { productId });
      } catch (err) {
        console.warn('[panel-treatments] arm placement failed:', err);
      }
    });
  });

  // Selected-treatment list interactions
  body.querySelectorAll('[data-toggle-treatment]').forEach(card => {
    card.addEventListener('click', e => {
      // Buttons inside the card have their own handlers — skip header-toggle for them.
      if (e.target.closest('button, input, select')) return;
      const id = card.dataset.toggleTreatment;
      if (_expandedTreatments.has(id)) _expandedTreatments.delete(id);
      else _expandedTreatments.add(id);
      // Also select it (mirrors zones panel behaviour).
      state.selectedTreatmentId = id;
      emit('treatment:selected', { id });
    });
  });
  body.querySelectorAll('[data-treatment-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeTreatment(btn.dataset.treatmentRemove);
    });
  });
  body.querySelectorAll('[data-treatment-duplicate]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const newId = duplicateTreatment(btn.dataset.treatmentDuplicate);
      if (newId) {
        state.selectedTreatmentId = newId;
        emit('treatment:changed');
      }
    });
  });
  body.querySelectorAll('[data-treatment-select]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      state.selectedTreatmentId = btn.dataset.treatmentSelect;
      emit('treatment:selected', { id: btn.dataset.treatmentSelect });
    });
  });
  body.querySelectorAll('[data-treatment-label]').forEach(input => {
    input.addEventListener('input', e => {
      const id = input.dataset.treatmentLabel;
      const t = state.treatments.find(x => x.id === id);
      if (!t) return;
      t.label = e.target.value;
      // Don't re-render on every keystroke — let it flow.
    });
    input.addEventListener('change', e => {
      emit('treatment:changed');
    });
  });
  body.querySelectorAll('[data-treatment-rotation]').forEach(input => {
    input.addEventListener('change', e => {
      const id = input.dataset.treatmentRotation;
      const t = state.treatments.find(x => x.id === id);
      if (!t) return;
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) t.rotation_deg = v;
      emit('treatment:changed');
    });
  });
}

function renderPlacedList() {
  const placed = state.treatments || [];
  if (placed.length === 0) {
    return `
      <div class="phase-placeholder treatments-empty">
        Pick a product below, then click a wall in 3D to place it.
      </div>
    `;
  }
  return `
    <h3 class="treatments-h3">Placed (${placed.length})</h3>
    <div class="treatments-placed-list">
      ${placed.map(t => renderPlacedCard(t)).join('')}
    </div>
  `;
}

function renderPlacedCard(t) {
  const spec = resolveSpec(t);
  const isSel = t.id === state.selectedTreatmentId;
  const expanded = _expandedTreatments.has(t.id);
  const surfaceLbl = t.anchor?.surface === 'ceiling'
    ? 'ceiling'
    : (t.anchor?.wallIndex != null ? `wall ${t.anchor.wallIndex + 1}` : 'wall');
  const productName = spec?.name ?? t.productId;
  const dim = t.dimensions || {};
  const areaM2 = (dim.width_m ?? 0) * (dim.height_m ?? 0);

  if (!expanded) {
    return `
      <div class="treatment-card compact${isSel ? ' selected' : ''}"
           data-toggle-treatment="${t.id}">
        <span class="tc-label">${escapeHtml(t.label || productName)}</span>
        <span class="tc-meta">${surfaceLbl} · ${areaM2.toFixed(2)} m²</span>
        <button class="btn-select ${isSel ? 'active' : ''}"
                data-treatment-select="${t.id}"
                title="${isSel ? 'Selected' : 'Select'}">${isSel ? '●' : '○'}</button>
      </div>
    `;
  }

  return `
    <div class="treatment-card expanded${isSel ? ' selected' : ''}"
         data-toggle-treatment="${t.id}">
      <div class="source-header">
        <span style="font-weight:600;">${escapeHtml(t.id)} · ${escapeHtml(productName)}</span>
        <button class="btn-remove" data-treatment-remove="${t.id}" title="Remove">×</button>
      </div>
      <div class="field-group">
        <label>Label
          <input type="text" data-treatment-label="${t.id}"
                 value="${escapeAttr(t.label || productName)}" />
        </label>
      </div>
      <div class="source-row duo">
        <label>Rotation
          <input type="number" data-treatment-rotation="${t.id}"
                 value="${t.rotation_deg ?? 0}" step="5" />
          <span class="unit">°</span>
        </label>
        <label>Anchor <span class="derived">${surfaceLbl}</span></label>
      </div>
      <div class="source-row duo">
        <label>Size <span class="derived">${(dim.width_m ?? 0).toFixed(2)} × ${(dim.height_m ?? 0).toFixed(2)} m</span></label>
        <label>Manufacturer <span class="derived">${escapeHtml(spec?.manufacturer ?? '—')}</span></label>
      </div>
      <div class="zone-actions">
        <button data-treatment-duplicate="${t.id}">Duplicate</button>
        <button class="btn-select ${isSel ? 'active' : ''}"
                data-treatment-select="${t.id}">${isSel ? '● Selected' : '○ Select'}</button>
      </div>
    </div>
  `;
}

function renderCatalogue() {
  if (!_catalogueCache) return '<div class="phase-placeholder">Loading…</div>';
  const entries = entriesForActiveTab();
  if (entries.length === 0) {
    return `<div class="phase-placeholder">No products in this category yet.</div>`;
  }
  // Group by manufacturer for scannability — pros recognise brand
  // before they recognise model.
  const byMfr = new Map();
  for (const e of entries) {
    const mfr = e.manufacturer || 'Generic';
    if (!byMfr.has(mfr)) byMfr.set(mfr, []);
    byMfr.get(mfr).push(e);
  }
  return Array.from(byMfr.entries()).map(([mfr, list]) => `
    <div class="treatments-mfr-group">
      <h4 class="treatments-mfr">${escapeHtml(mfr)}</h4>
      <div class="treatments-products">
        ${list.map(renderProductCard).join('')}
      </div>
    </div>
  `).join('');
}

function renderProductCard(p) {
  const g = p.geometry || {};
  const w = (g.width_mm ?? 0) / 1000;
  const h = (g.height_mm ?? 0) / 1000;
  const d = (g.depth_mm ?? 0) / 1000;
  const weight = g.weight_kg_m2 != null ? `${g.weight_kg_m2} kg/m²` : '—';
  return `
    <div class="treatment-product-card" data-product-id="${escapeAttr(p.id)}">
      <div class="tp-head">
        <strong class="tp-name">${escapeHtml(p.name)}</strong>
        <span class="tp-tier">${escapeHtml(p.price_tier || '')}</span>
      </div>
      <div class="tp-meta">
        <span>${w.toFixed(2)} × ${h.toFixed(2)} × ${d.toFixed(2)} m</span>
        <span>${weight}</span>
        ${p.fire_rating ? `<span title="Fire rating">${escapeHtml(p.fire_rating)}</span>` : ''}
      </div>
      ${p.description ? `<p class="tp-desc">${escapeHtml(p.description)}</p>` : ''}
      <button class="btn-add tp-place" data-place-product="${escapeAttr(p.id)}">+ Place</button>
    </div>
  `;
}

function entriesForActiveTab() {
  if (!_catalogueCache) return [];
  if (_activeTab === 'ceiling') {
    // Match SurfaceLAB's ceiling-view convention: any entry whose
    // mounting field starts with 'ceiling_'.
    return _catalogueCache.all.filter(e =>
      typeof e.mounting === 'string' && /^ceiling/i.test(e.mounting)
    );
  }
  return _catalogueCache.all.filter(e => e.railSegment === _activeTab);
}

function resolveSpec(t) {
  if (t._cachedSpec) return t._cachedSpec;
  if (!_catalogueCache) return null;
  const spec = findCatalogueEntry(t.productId);
  if (spec) t._cachedSpec = spec;
  return spec;
}

function removeTreatment(id) {
  if (!Array.isArray(state.treatments)) return;
  const i = state.treatments.findIndex(t => t.id === id);
  if (i < 0) return;
  state.treatments.splice(i, 1);
  if (state.selectedTreatmentId === id) state.selectedTreatmentId = null;
  _expandedTreatments.delete(id);
  emit('treatment:changed');
}

// ---------------------------------------------------------------------------
// Public helpers used by scene.js (3D picking) and room-2d.js (2D drag).
// Putting these here keeps the treatment math co-located with the panel.
// ---------------------------------------------------------------------------

// Generate the next unique id for a new treatment, given the current
// state.treatments array. Format: "T1", "T2", … — chosen to mirror
// "Z1" zones and "L1" listeners.
export function nextTreatmentId() {
  const used = new Set((state.treatments || []).map(t => t.id));
  let n = (state.treatments?.length ?? 0) + 1;
  while (used.has(`T${n}`)) n++;
  return `T${n}`;
}

// Build a treatment entity from a catalogue spec + anchor location.
// Returns the new entry; caller pushes onto state.treatments and emits.
//
// `anchor`:
//   { surface: 'wall', wallIndex: N }
//   { surface: 'ceiling' }
// `position`: world metres { x, y, z }.
//
// Dimensions are taken from the catalogue (locked in v1 — Phase 2 will
// add a scale handle). Depth is always the panel's protrusion into the
// room. width/height are world-aligned to the surface in the renderer.
export function makeTreatmentEntry(spec, anchor, position, rotation_deg = 0) {
  if (!spec) throw new Error('makeTreatmentEntry: spec is required');
  const g = spec.geometry || {};
  const dim = {
    width_m:  (g.width_mm  ?? 600) / 1000,
    height_m: (g.height_mm ?? 600) / 1000,
    depth_m:  (g.depth_mm  ?? 50)  / 1000,
  };
  return {
    id: nextTreatmentId(),
    productId: spec.id,
    label: spec.name || spec.id,
    anchor: { ...anchor },
    position: { x: position.x, y: position.y, z: position.z },
    rotation_deg,
    dimensions: dim,
    _cachedSpec: spec,
  };
}

// Project a world-XY point onto the room polygon's nearest wall edge.
// Returns { wallIndex, position: { x, y, z }, edge: { ax, ay, bx, by } }
// where position is the closest point on the segment AT THE GIVEN
// height z. Used by:
//   * 3D scene.js: when a click hits a wall, classify which polygon
//     edge it landed on so the treatment is anchored to a stable
//     index (vertices may move; the index does, too, if the room is
//     re-vertexed — see the orphan handling in scene.js).
//   * 2D room-2d.js: dragging a treatment on the plan re-projects
//     onto the same wall segment so it can't fly off.
//
// `room` — state.room. `polygonVertices` — pre-resolved vertex list
// from roomPlanVertices(room); passing it avoids a re-import.
export function projectOntoNearestWall(room, polygonVertices, worldXY, height_m) {
  const verts = polygonVertices;
  if (!Array.isArray(verts) || verts.length < 2) return null;
  let best = null;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const proj = projectPointOntoSegment(worldXY.x, worldXY.y, a.x, a.y, b.x, b.y);
    if (!best || proj.dist < best.dist) {
      best = {
        wallIndex: i,
        dist: proj.dist,
        position: { x: proj.x, y: proj.y, z: height_m },
        edge: { ax: a.x, ay: a.y, bx: b.x, by: b.y },
      };
    }
  }
  return best;
}

// Project a world-XY point onto a SPECIFIC wall (used by drag — we
// don't want the panel to hop walls mid-drag). Same return shape as
// projectOntoNearestWall but only inspects the given wallIndex.
export function projectOntoWall(polygonVertices, wallIndex, worldXY, height_m) {
  const verts = polygonVertices;
  if (!Array.isArray(verts) || verts.length < 2) return null;
  const a = verts[wallIndex % verts.length];
  const b = verts[(wallIndex + 1) % verts.length];
  const proj = projectPointOntoSegment(worldXY.x, worldXY.y, a.x, a.y, b.x, b.y);
  return {
    wallIndex,
    dist: proj.dist,
    position: { x: proj.x, y: proj.y, z: height_m },
    edge: { ax: a.x, ay: a.y, bx: b.x, by: b.y },
  };
}

// Yaw (in degrees, world frame) for a treatment anchored on the given
// polygon edge. The panel's face points INTO the room (the inward
// normal of the edge). Returns 0 when the edge is degenerate.
export function wallYawDeg(edge) {
  const dx = edge.bx - edge.ax;
  const dy = edge.by - edge.ay;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return 0;
  // Inward normal: for a CCW polygon the right-hand of (b-a) faces
  // inward. We compute the angle of THAT vector (the direction the
  // panel's face normal points). Caller uses this as the yaw for
  // the rectangle in world XY plane (the renderer rotates the long
  // edge along (b-a)).
  // tangent vector = (dx, dy); the angle of the tangent in XY is
  // atan2(dy, dx). The renderer aligns the rectangle's long edge
  // with that tangent.
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

// Helper: project point P onto segment A-B; returns closest point + distance.
function projectPointOntoSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-12) return { x: ax, y: ay, dist: Math.hypot(px - ax, py - ay), t: 0 };
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return { x: cx, y: cy, dist: Math.hypot(px - cx, py - cy), t };
}

// Orphan handling — called by scene.js after a wall is removed
// (vertex collapsed, room re-shaped to fewer edges, etc.). Treatments
// whose wallIndex no longer exists get their anchor re-projected onto
// the nearest surviving wall and `orphanRescued: true` flagged so the
// UI can surface "panel moved to wall N" if we ever want a toast.
//
// `polygonVertices` is the CURRENT vertex list. Returns the count of
// treatments rescued (0 if nothing needed rescuing).
export function rescueOrphanedTreatments(polygonVertices) {
  if (!Array.isArray(state.treatments) || state.treatments.length === 0) return 0;
  if (!Array.isArray(polygonVertices) || polygonVertices.length < 3) return 0;
  let rescued = 0;
  const maxIdx = polygonVertices.length - 1;
  for (const t of state.treatments) {
    if (t.anchor?.surface !== 'wall') continue;
    const idx = t.anchor.wallIndex;
    if (!Number.isFinite(idx) || idx < 0 || idx > maxIdx) {
      // Re-project the existing world position onto the nearest
      // surviving wall.
      const proj = projectOntoNearestWall(
        state.room, polygonVertices,
        { x: t.position.x, y: t.position.y },
        t.position.z,
      );
      if (proj) {
        t.anchor.wallIndex = proj.wallIndex;
        t.position.x = proj.position.x;
        t.position.y = proj.position.y;
        rescued++;
      }
    }
  }
  return rescued;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
