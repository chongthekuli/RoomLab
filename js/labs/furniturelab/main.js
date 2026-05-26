// FurnitureLAB mount module — Lab #6 (Phase 0, 2026-05-26).
//
// Browses the catalogue at data/furniture/catalogue.json, shows each
// row as an isometric-ink card, opens a citation-first detail pane on
// click, and offers a "Place into room" affordance that arms the
// RoomLAB 2D viewport for the next click. Phase 0 ships skeleton +
// one reference object (theater seat, upholstered, occupied) wired
// end-to-end through Sabine + Eyring with parallel-A physics per
// Dr. Chen's brief.
//
// Architectural pattern mirrors SurfaceLAB + SpeakerLAB:
//   - Lazy mount on first #/furniture visit (routed by main.js).
//   - Catalogue cached in catalog.js so panel-results.js can read the
//     same Map without paying a second fetch.
//   - No external dependencies beyond app-state + shared/events.

import { state } from '../../app-state.js';
import { emit } from '../../shared/events.js';
import { loadFurnitureCatalogue } from './catalog.js';
import { buildGlyph, glyphViewBox } from './glyphs.js';

let _mounted = false;

export async function mountFurnitureLab() {
  if (_mounted) return;
  _mounted = true;

  const grid   = document.getElementById('fl-catalogue-grid');
  const detail = document.getElementById('fl-detail-pane');
  if (!grid || !detail) {
    console.warn('[FurnitureLAB] DOM hooks missing; skipping mount.');
    return;
  }

  let catalogue;
  try {
    catalogue = await loadFurnitureCatalogue();
  } catch (err) {
    console.error('[FurnitureLAB] catalogue load failed', err);
    grid.innerHTML = `<div class="fl-grid-error">Catalogue failed to load: ${escapeHtml(err.message ?? String(err))}</div>`;
    return;
  }

  renderGrid(grid, catalogue.json, detail);
}

function renderGrid(grid, catalogueJson, detailPane) {
  const items = catalogueJson?.items ?? [];
  if (items.length === 0) {
    grid.innerHTML = '<div class="fl-grid-empty">Catalogue is empty.</div>';
    return;
  }
  grid.innerHTML = items.map(item => renderCard(item)).join('');
  // Click delegation — one listener for the whole grid.
  grid.addEventListener('click', (ev) => {
    const cardEl = ev.target.closest('.fl-card');
    if (!cardEl) return;
    const id = cardEl.dataset.id;
    const item = items.find(x => x.id === id);
    if (!item) return;
    grid.querySelectorAll('.fl-card').forEach(el => el.classList.toggle('selected', el === cardEl));
    renderDetail(detailPane, item);
  });
}

function renderCard(item) {
  const A = item?.acoustics?.A_obj_m2_sab_per_band ?? {};
  const A1k = Number.isFinite(A['1000']) ? A['1000'].toFixed(2) : '—';
  const reliability = item.reliability || 'estimated';
  const fp = item.footprint || {};
  const fpText = `${(fp.width_m ?? 0).toFixed(2)} × ${(fp.depth_m ?? 0).toFixed(2)} m`;
  return `
    <article class="fl-card" data-id="${escapeAttr(item.id)}" role="button" tabindex="0" aria-label="${escapeAttr(item.name)} — show details">
      <div class="fl-card-art">
        <svg viewBox="${glyphViewBox()}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          ${buildGlyph(item)}
        </svg>
      </div>
      <div class="fl-card-body">
        <h3 class="fl-card-name">${escapeHtml(item.name)}</h3>
        <div class="fl-card-meta">
          <span class="fl-card-cat">${escapeHtml(item.category)}</span>
          <span class="fl-card-fp">${escapeHtml(fpText)}</span>
          <span class="fl-card-A1k">A<sub>1k</sub> = ${A1k} m²&nbsp;Sa</span>
        </div>
        ${renderSparkline(A)}
        <div class="fl-card-rel fl-rel-${escapeAttr(reliability)}">${escapeHtml(reliabilityLabel(reliability))}</div>
      </div>
    </article>`;
}

// Tiny per-band absorption sparkline embedded in each card. Six bars
// (125 Hz → 4 kHz) drawn at fixed pixel height, fill proportional to
// A_obj. The first card the user sees is the visual identity of this
// lab — terracotta accent on the bar with the largest A_obj, ink for
// the rest. (Maya's "card signature" — same sparkline reappears in the
// BoM section of the print report so the catalogue ↔ report parity is
// visible at a glance.)
function renderSparkline(A_per_band) {
  const BANDS = ['125', '250', '500', '1000', '2000', '4000'];
  const values = BANDS.map(b => Number.isFinite(A_per_band?.[b]) ? A_per_band[b] : 0);
  const peak = Math.max(0.001, ...values);
  const maxIdx = values.indexOf(peak);
  const W = 60, H = 16, GAP = 1.5, BAR_W = (W - GAP * (values.length - 1)) / values.length;
  const bars = values.map((v, i) => {
    const h = (v / peak) * (H - 2);
    const x = i * (BAR_W + GAP);
    const y = H - h;
    const fill = i === maxIdx ? '#9A3F2A' : '#1A1A1A';
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${BAR_W.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" />`;
  }).join('');
  return `<svg class="fl-card-spark" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-label="Per-band equivalent absorption area, 125 Hz to 4 kHz, peak at ${BANDS[maxIdx]} Hz">${bars}</svg>`;
}

function reliabilityLabel(tag) {
  if (tag === 'measured') return 'Measured · ISO 354';
  if (tag === 'derived')  return 'Derived';
  return 'Estimated · low confidence';
}

function renderDetail(pane, item) {
  const A = item?.acoustics?.A_obj_m2_sab_per_band ?? {};
  const bands = [['125', '125 Hz'], ['250', '250 Hz'], ['500', '500 Hz'], ['1000', '1 kHz'], ['2000', '2 kHz'], ['4000', '4 kHz']];
  const bandRows = bands.map(([k, label]) => {
    const v = Number.isFinite(A[k]) ? A[k].toFixed(2) : '—';
    return `<tr><th scope="row">${label}</th><td>${v} m² Sa</td></tr>`;
  }).join('');

  const c = item.citation || {};
  const fp = item.footprint || {};
  const occ = item?.acoustics?.occupancy_state;

  pane.innerHTML = `
    <header class="fl-detail-head">
      <h2 class="fl-detail-name">${escapeHtml(item.name)}</h2>
      <div class="fl-detail-rel fl-rel-${escapeAttr(item.reliability || 'estimated')}">${escapeHtml(reliabilityLabel(item.reliability || 'estimated'))}</div>
    </header>

    <section class="fl-detail-section">
      <h3>Equivalent absorption area, ISO 354 reverb-room (A<sub>obj</sub>)</h3>
      <table class="fl-detail-A">
        <tbody>${bandRows}</tbody>
      </table>
      <p class="fl-detail-note">Per-octave A<sub>obj</sub> is summed as a parallel term into the room's Sabine + Eyring RT60 (outside the log per Kuttruff &sect;5.3 and Beranek &sect;7.3). Bands with no measured value contribute zero &mdash; never extrapolated.</p>
    </section>

    <section class="fl-detail-section">
      <h3>Specification</h3>
      <dl class="fl-detail-spec">
        <dt>Category</dt>      <dd>${escapeHtml(item.category)}${item.subcategory ? ' / ' + escapeHtml(item.subcategory) : ''}</dd>
        <dt>Footprint</dt>     <dd>${(fp.width_m ?? 0).toFixed(2)} m wide &times; ${(fp.depth_m ?? 0).toFixed(2)} m deep &times; ${(fp.height_m ?? 0).toFixed(2)} m tall</dd>
        <dt>Mounting</dt>      <dd>${escapeHtml(item.placement?.mounts_on ?? '—')}</dd>
        ${occ ? `<dt>Occupancy</dt><dd>${escapeHtml(occ)}</dd>` : ''}
      </dl>
    </section>

    <section class="fl-detail-section fl-citation">
      <h3>Citation</h3>
      <p class="fl-cite-source"><strong>${escapeHtml(c.source ?? '—')}</strong>${c.doi ? ` &middot; DOI <a href="https://doi.org/${escapeAttr(c.doi)}" target="_blank" rel="noopener">${escapeHtml(c.doi)}</a>` : ''}</p>
      <p class="fl-cite-ref">${escapeHtml(c.reference ?? '')}</p>
      <p class="fl-cite-method"><em>Method:</em> ${escapeHtml(c.measurement_method ?? '—')}</p>
      ${c.notes ? `<p class="fl-cite-notes"><em>Notes:</em> ${escapeHtml(c.notes)}</p>` : ''}
    </section>

    <footer class="fl-detail-foot">
      <button type="button" class="fl-place-btn" data-id="${escapeAttr(item.id)}">Place into room &rarr;</button>
    </footer>
  `;

  pane.querySelector('.fl-place-btn')?.addEventListener('click', () => armForPlacement(item.id));
}

/**
 * Arm the next viewport click to place an instance of `catalogueId`.
 * Mutates a small flag on global state, emits `furniture:armed`, and
 * navigates back to RoomLAB (#/room) so the user can click in the 2D
 * viewport. room-2d.js handles the actual placement on the next click.
 *
 * Cancel: ESC, or clicking outside the 2D viewport.
 */
// Exported for reuse by the in-RoomLAB sidebar panel (panel-furniture.js).
// Same protocol either way: set state.furnitureArmed, broadcast the event,
// flip RoomLAB to 2D, route to #/room if not already there.
export function armFurniturePlacement(catalogueId) {
  return armForPlacement(catalogueId);
}

function armForPlacement(catalogueId) {
  state.furnitureArmed = { catalogueId };
  emit('furniture:armed', { catalogueId });
  // Hop back to RoomLAB so the user can click in the viewport.
  if (location.hash !== '#/room') {
    location.hash = '#/room';
  }
  // Force the 2D top-down view — placement only resolves in 2D for
  // Phase 0 (3D raycaster placement is Phase 1). Without this flip,
  // a user landing on the 3D tab gets a crosshair cursor with nothing
  // to click. Run after the hash change settles so #route-room is
  // visible and the click hits a mounted .vp-tab.
  setTimeout(() => {
    const tab2d = document.querySelector('#route-room .vp-tab[data-view="2d"]');
    if (tab2d && !tab2d.classList.contains('active')) tab2d.click();
  }, 0);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
