// panel-furniture.js — RoomLAB left-rail Furniture panel.
//
// A pared-down version of the FurnitureLAB grid embedded inside
// RoomLAB so the user can arm a placement without leaving the room
// (avoids the "tab → click → tab back" round-trip the user flagged in
// the Phase 0 follow-up). Same catalogue, same arming protocol —
// state.furnitureArmed + emit('furniture:armed') + auto-flip to 2D.
//
// Also lists currently-placed furniture with select + remove controls
// so the user has a single panel covering browse → place → manage.

import { state } from '../app-state.js';
import { on, emit } from './events.js';
import { loadFurnitureCatalogue, getFurnitureCatalogue } from '../labs/furniturelab/catalog.js';
import { armFurniturePlacement } from '../labs/furniturelab/main.js';
import { buildGlyph, glyphViewBox } from '../labs/furniturelab/glyphs.js';

let _mounted = false;

export async function mountFurniturePanel() {
  if (_mounted) return;
  _mounted = true;

  const root = document.getElementById('panel-furniture');
  if (!root) return;

  // Initial skeleton; replaced after the catalogue resolves.
  root.innerHTML = `
    <h2>Furniture <span class="fl-rail-beta">beta</span></h2>
    <div class="pf-body">
      <div class="phase-placeholder">Loading catalogue…</div>
    </div>
  `;

  try {
    await loadFurnitureCatalogue();
  } catch (err) {
    root.querySelector('.pf-body').innerHTML =
      `<div class="phase-placeholder">Couldn't load the furniture catalogue. Refresh to retry.</div>`;
    return;
  }

  render(root);

  // Re-render on placement / removal / selection so the placed-list
  // and selection highlight stay in sync.
  on('furniture:changed', () => render(root));
  on('furniture:selected', () => render(root));
  on('scene:reset', () => render(root));
}

function render(root) {
  const catalogue = getFurnitureCatalogue();
  const items = Array.from(catalogue.values());
  const placed = Array.isArray(state.furniture) ? state.furniture : [];

  const cards = items.map(item => renderMiniCard(item)).join('');
  const placedRows = placed.length === 0
    ? `<div class="pf-placed-empty">No furniture placed yet. Pick from the catalogue above, then click in the 2D plan.</div>`
    : placed.map((f, i) => renderPlacedRow(f, i, catalogue)).join('');

  root.innerHTML = `
    <h2>Furniture <span class="fl-rail-beta">beta</span></h2>
    <div class="pf-body">
      <p class="pf-intro">Pick an item, then click in the floor plan to place. Click a placed item to select; <kbd>Del</kbd> removes it.</p>
      <div class="pf-grid">${cards}</div>
      <div class="pf-placed">
        <div class="pf-placed-head">Placed in this room <span class="pf-placed-count">${placed.length}</span></div>
        <div class="pf-placed-list">${placedRows}</div>
      </div>
    </div>
  `;

  // Click-to-arm on catalogue cards.
  root.querySelectorAll('.pf-card').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (!id) return;
      armFurniturePlacement(id);
    });
  });

  // Click-to-select / remove on placed rows.
  root.querySelectorAll('.pf-placed-row').forEach(rowEl => {
    const id = rowEl.dataset.id;
    if (!id) return;
    rowEl.querySelector('.pf-row-pick')?.addEventListener('click', () => {
      state.selectedFurnitureId = id;
      emit('furniture:selected', { id });
    });
    rowEl.querySelector('.pf-row-remove')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = state.furniture.findIndex(f => f.id === id);
      if (idx >= 0) {
        state.furniture.splice(idx, 1);
        if (state.selectedFurnitureId === id) state.selectedFurnitureId = null;
        emit('furniture:changed', { removed: id });
      }
    });
  });
}

function renderMiniCard(item) {
  const A = item?.acoustics?.A_obj_m2_sab_per_band ?? {};
  const A1k = Number.isFinite(A['1000']) ? A['1000'].toFixed(2) : '—';
  return `
    <button type="button" class="pf-card" data-id="${escapeAttr(item.id)}" title="Click to arm placement — next 2D click drops one">
      <div class="pf-card-art">
        <svg viewBox="${glyphViewBox()}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${buildGlyph(item)}</svg>
      </div>
      <div class="pf-card-info">
        <div class="pf-card-name">${escapeHtml(item.name)}</div>
        <div class="pf-card-A">A<sub>1k</sub> ${A1k} m²&nbsp;Sa</div>
      </div>
    </button>`;
}

function renderPlacedRow(f, idx, catalogue) {
  const row = catalogue.get(f.catalogueId);
  const name = f.label || row?.name || f.catalogueId;
  const broken = !row;
  const isSel = state.selectedFurnitureId === f.id;
  return `
    <div class="pf-placed-row ${isSel ? 'selected' : ''} ${broken ? 'broken' : ''}" data-id="${escapeAttr(f.id)}">
      <button type="button" class="pf-row-pick" title="Select in viewport">
        <span class="pf-row-id">${escapeHtml(f.id)}</span>
        <span class="pf-row-name">${escapeHtml(name)}${broken ? ' <em>(broken link)</em>' : ''}</span>
      </button>
      <button type="button" class="pf-row-remove" title="Remove this item (or press Del while selected)" aria-label="Remove ${escapeAttr(name)}">×</button>
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
