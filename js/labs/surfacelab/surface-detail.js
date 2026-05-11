// SurfaceLAB workbench — renders the centre 3D preview, the floating
// glass title bar, the catalogue (in #panel-library on the left rail),
// and four right-rail panels: Specs, Absorption α(f), Polar diffusion,
// Cross-section. Everything is data-driven from the unified catalogue
// returned by ./catalog.js.
//
// State is module-scoped; SurfaceLAB is a single-selection lab (one
// active surface at a time, like SpeakerLAB).

import { loadSurfaceCatalogue, findCatalogueEntry } from './catalog.js';
import { mountSurfacePreview, disposePreview } from './surface-3d-preview.js';

export const state = {
  selectedId: null,
  catalogue: null,
  filter: { manufacturer: null, kind: null, mounting: null, search: '' },
};

// All SurfaceLAB DOM queries are scoped to #route-surface — multiple
// Labs share generic panel IDs (#panel-library exists in RoomLAB,
// #panel-specs / #panel-filter exist in SpeakerLAB), so an unscoped
// getElementById would write into whichever Lab's DOM came first.
function $(id) {
  return document.querySelector(`#route-surface #${id}`);
}
function $$(sel) {
  return document.querySelectorAll(`#route-surface ${sel}`);
}

// ---------------------------------------------------------------------
// Mount — called once on first SurfaceLAB visit
// ---------------------------------------------------------------------

export async function mountSurfaceView() {
  const root = $('view-surface');
  if (!root) return;

  // Centre column scaffolding — same idiom as SpeakerLAB.
  root.innerHTML = `
    <div class="speaker-view">
      <div class="sv-main">
        <div class="sv-head">
          <div class="sv-title" id="surface-title"></div>
          <div class="sv-actions">
            <span class="surface-trust-chips" id="surface-trust-chips"></span>
          </div>
        </div>
        <div id="sv-body" class="sv-body">
          <section class="sv-3d-stage" id="surface-3d-stage">
            <canvas id="surface-3d-canvas"></canvas>
            <div class="sv-3d-caption">Drag to rotate · scroll to zoom · auto-rotates when idle.</div>
          </section>
        </div>
      </div>
    </div>
  `;

  // Load catalogue and render each rail panel independently.
  state.catalogue = await loadSurfaceCatalogue();
  renderAllRailPanels();
  renderTitleBar();        // initial empty state
  renderRightRailPanels();

  // Auto-select the first entry so the workbench isn't empty on first
  // visit. The user can pick anything else from the rail panels.
  if (!state.selectedId && state.catalogue.all.length > 0) {
    selectSurface(state.catalogue.all[0].id);
  }
}

// ---------------------------------------------------------------------
// Per-rail catalogue panels — one panel per rail icon, each with its
// own in-panel filter (search + manufacturer chips) so the user can
// narrow within a category without leaving it.
// ---------------------------------------------------------------------

const SEGMENT_TO_PANEL = {
  absorber: 'panel-absorbers',
  bass:     'panel-bass',
  diffuser: 'panel-diffusers',
  ceiling:  'panel-ceiling',
  surface:  'panel-surfaces',
  opening:  'panel-openings',
  system:   'panel-systems',
};

function panelFilterState(segment) {
  if (!state.panelFilters) state.panelFilters = {};
  if (!state.panelFilters[segment]) state.panelFilters[segment] = { search: '', manufacturer: null };
  return state.panelFilters[segment];
}

function visibleEntriesForPanel(group) {
  const f = panelFilterState(group.id);
  const q = (f.search || '').trim().toLowerCase();
  return group.entries.filter(e => {
    if (f.manufacturer && e.manufacturer !== f.manufacturer) return false;
    if (q) {
      const hay = `${e.name} ${e.manufacturer} ${e.category}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderAllRailPanels() {
  if (!state.catalogue) return;
  for (const group of state.catalogue.groups) {
    renderRailPanel(group);
  }
}

function renderRailPanel(group) {
  const panel = $(SEGMENT_TO_PANEL[group.id]);
  if (!panel) return;

  const visible = visibleEntriesForPanel(group);
  const manufacturers = [...new Set(group.entries.map(e => e.manufacturer).filter(Boolean))].sort();
  const f = panelFilterState(group.id);

  // Ceiling is a VIEW alias over other categories — show a note so the
  // user understands these products are stored under absorber.* / system.*
  const ceilingNote = group.id === 'ceiling'
    ? `<p class="surface-note">Ceiling is a view — entries here are absorbers and systems mounted overhead, filtered by mounting.</p>`
    : '';

  // Empty-state placeholder for branches without seed products yet
  // (Openings, Systems day-one). Keeps the rail icon visible so the
  // taxonomy is discoverable.
  const emptyState = group.entries.length === 0
    ? `<div class="surface-empty">
         <p>No ${group.label.toLowerCase()} in the catalogue yet.</p>
         <p class="surface-empty-sub">Future products in this branch will appear here as they're added.</p>
       </div>`
    : '';

  const mfrChips = manufacturers.length > 1 ? `
    <div class="surface-filter-chips">
      ${manufacturers.map(m => `
        <button type="button" class="surface-filter-chip${f.manufacturer === m ? ' active' : ''}"
                data-segment="${group.id}" data-mfr="${escapeAttr(m)}">${escapeHtml(m)}</button>
      `).join('')}
    </div>
  ` : '';

  const rowsHtml = visible.map(e => renderCatalogueRow(e)).join('');
  const noMatchEmpty = group.entries.length > 0 && visible.length === 0
    ? `<div class="phase-placeholder">No products match the current filter.</div>`
    : '';

  panel.innerHTML = `
    <h2>${escapeHtml(group.label)} <span class="surface-panel-count">${group.entries.length}</span></h2>
    ${ceilingNote}
    ${group.entries.length > 1 ? `
      <div class="surface-search-wrap">
        <input class="surface-search-input" type="search"
               data-segment="${group.id}"
               placeholder="Search ${escapeAttr(group.label.toLowerCase())}…"
               value="${escapeAttr(f.search)}" />
      </div>
      ${mfrChips}
    ` : ''}
    ${emptyState}
    ${noMatchEmpty}
    <div class="surface-cat-list">${rowsHtml}</div>
  `;

  // Wire row clicks
  panel.querySelectorAll('.surface-cat-row').forEach(btn => {
    btn.addEventListener('click', () => selectSurface(btn.dataset.id));
  });
  // Wire search input
  const searchEl = panel.querySelector('.surface-search-input');
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      const seg = e.target.dataset.segment;
      panelFilterState(seg).search = e.target.value;
      renderRailPanel(group);
      // Restore focus + caret to the same input across re-render
      const next = $(SEGMENT_TO_PANEL[seg])?.querySelector('.surface-search-input');
      if (next) { next.focus(); const len = next.value.length; next.setSelectionRange(len, len); }
    });
  }
  // Wire manufacturer chips
  panel.querySelectorAll('.surface-filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const seg = btn.dataset.segment;
      const mfr = btn.dataset.mfr;
      const fs = panelFilterState(seg);
      fs.manufacturer = (fs.manufacturer === mfr) ? null : mfr;
      renderRailPanel(group);
    });
  });
}

function renderCatalogueRow(entry) {
  const headline = formatHeadlineNumber(entry);
  const flagCount = (entry.trust_flags || []).length;
  const hasHighFlag = (entry.trust_flags || []).some(f => f.severity === 'high');
  const flagChip = flagCount > 0
    ? `<span class="surface-cat-flag${hasHighFlag ? ' surface-cat-flag-high' : ''}" title="${flagCount} caution flag${flagCount === 1 ? '' : 's'}">⚠</span>`
    : '';
  const isActive = state.selectedId === entry.id;
  return `
    <button type="button" class="surface-cat-row${isActive ? ' active' : ''}" data-id="${entry.id}">
      <span class="surface-cat-mfr">${escapeHtml(entry.manufacturer)}</span>
      <span class="surface-cat-name">${escapeHtml(entry.name)}</span>
      <span class="surface-cat-headline">${headline}</span>
      ${flagChip}
    </button>
  `;
}

// ---------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------

function selectSurface(id) {
  const entry = findCatalogueEntry(id);
  if (!entry) return;
  state.selectedId = id;
  renderTitleBar();
  renderRightRailPanels();
  // Update active marker on rows (within SurfaceLAB only).
  $$('.surface-cat-row').forEach(r => {
    r.classList.toggle('active', r.dataset.id === id);
  });
  // Mount the 3D preview.
  const canvas = $('surface-3d-canvas');
  if (canvas) mountSurfacePreview(canvas, entry);
}

// ---------------------------------------------------------------------
// Title bar (floating glass overlay over the 3D canvas)
// ---------------------------------------------------------------------

function renderTitleBar() {
  const titleEl = $('surface-title');
  const chipsEl = $('surface-trust-chips');
  if (!titleEl) return;
  const entry = findCatalogueEntry(state.selectedId);
  if (!entry) {
    titleEl.innerHTML = `<div class="sv-brand">SURFACELAB</div><div class="sv-model">Pick a surface from the library</div>`;
    if (chipsEl) chipsEl.innerHTML = '';
    return;
  }
  const headline = formatHeadlineNumber(entry, true);
  titleEl.innerHTML = `
    <div class="sv-brand">${escapeHtml(entry.manufacturer || 'GENERIC').toUpperCase()}</div>
    <div class="sv-model">${escapeHtml(entry.name)}</div>
    <div class="sv-note">${escapeHtml(entry.description || '')}</div>
    <div class="surface-headline">${headline}</div>
  `;
  if (chipsEl) {
    chipsEl.innerHTML = (entry.trust_flags || [])
      .map(f => `<span class="surface-flag-chip surface-flag-${f.severity}" title="${escapeAttr(f.message)}">⚠ ${f.id.replace(/_/g, ' ')}</span>`)
      .join('');
  }
}

// ---------------------------------------------------------------------
// Right-rail panels — rendered into the existing <section> elements
// in index.html so the rail-system show/hide rules apply.
// ---------------------------------------------------------------------

function renderRightRailPanels() {
  const entry = findCatalogueEntry(state.selectedId);
  renderSpecsPanel(entry);
  renderAbsorptionPanel(entry);
  renderPolarPanel(entry);
  renderConstructionPanel(entry);
}

function renderSpecsPanel(entry) {
  const root = $('panel-specs');
  if (!root) return;
  if (!entry) {
    root.innerHTML = `<h2>Specs</h2><div class="phase-placeholder">Pick a surface from the library to see specs here.</div>`;
    return;
  }
  const headline = formatHeadlineNumber(entry, true);
  const isDiffuser = entry.category === 'diffuser';
  const isTrap = entry.category === 'trap';
  const isMembrane = entry.kind === 'trap_membrane' || entry.kind === 'trap_helmholtz';

  const flagsHtml = (entry.trust_flags || []).map(f => `
    <div class="surface-flag-row surface-flag-${f.severity}">
      <span class="surface-flag-icon">⚠</span>
      <span class="surface-flag-msg">${escapeHtml(f.message)}</span>
    </div>
  `).join('');

  const geomRows = [
    rowKv('Dimensions',
      entry.geometry?.width_mm ? `${entry.geometry.width_mm} × ${entry.geometry.height_mm} × ${entry.geometry.depth_mm} mm` : '—'),
    rowKv('Weight', entry.geometry?.weight_kg_m2 ? `${entry.geometry.weight_kg_m2} kg/m²` : '—'),
    rowKv('Mounting', humanMounting(entry.mounting)),
    rowKv('Fire rating', entry.fire_rating || '—'),
    entry.price_tier ? rowKv('Price tier', entry.price_tier) : '',
  ];
  const diffuserRows = isDiffuser ? [
    rowKv('Prime root N', entry.geometry?.prime_N ?? '—'),
    rowKv('Wells', entry.geometry?.well_count ?? '—'),
    rowKv('Max well depth', entry.geometry?.max_well_depth_mm ? `${entry.geometry.max_well_depth_mm} mm` : '—'),
    rowKv('Period width', entry.geometry?.period_width_mm ? `${entry.geometry.period_width_mm} mm` : '—'),
    entry.operating_range_hz ? rowKv('Operating range', `${entry.operating_range_hz[0]} – ${entry.operating_range_hz[1]} Hz`) : '',
  ] : [];
  const trapRows = isTrap ? [
    isMembrane ? rowKv('f₀', entry.trap?.f0_hz ? `${entry.trap.f0_hz} Hz` : '—') : '',
    entry.trap?.bandwidth_alpha05_hz ? rowKv('α≥0.5 bandwidth', `${entry.trap.bandwidth_alpha05_hz[0]} – ${entry.trap.bandwidth_alpha05_hz[1]} Hz`) : '',
    rowKv('Trap type', entry.trap?.type || '—'),
    entry.trap?.porous_depth_mm ? rowKv('Porous depth', `${entry.trap.porous_depth_mm} mm`) : '',
  ] : [];

  const citation = entry.test_standard ? `
    <div class="surface-cite">
      Tested per <strong>${escapeHtml(entry.test_standard)}</strong>${entry.test_lab ? ` · ${escapeHtml(entry.test_lab)}` : ''}${entry.test_report_id ? ` · report ${escapeHtml(entry.test_report_id)}` : ''}.
    </div>
  ` : '';

  root.innerHTML = `
    <h2>Specs</h2>
    <div class="surface-headline-block">
      <div class="surface-headline-value">${headline}</div>
    </div>
    ${flagsHtml ? `<div class="surface-flag-block">${flagsHtml}</div>` : ''}
    <table class="surface-spec-table">
      ${[...geomRows, ...diffuserRows, ...trapRows].filter(Boolean).join('')}
    </table>
    ${citation}
  `;
}

function renderAbsorptionPanel(entry) {
  const root = $('panel-absorption');
  if (!root) return;
  if (!entry?.absorption) {
    root.innerHTML = `<h2>Absorption α(f)</h2><div class="phase-placeholder">No absorption data for this surface.</div>`;
    return;
  }
  root.innerHTML = `
    <h2>Absorption α(f)</h2>
    <p class="surface-note">Octave-band absorption coefficient per ASTM C423 / ISO 354. Mounting: ${escapeHtml(humanMounting(entry.mounting))}.</p>
    ${renderAlphaChartSVG(entry.absorption)}
    ${renderNRCStripe(entry)}
  `;
}

function renderPolarPanel(entry) {
  const root = $('panel-polardiffusion');
  if (!root) return;
  if (entry?.category !== 'diffuser' || !entry.diffusion_d) {
    root.innerHTML = `<h2>Polar diffusion</h2><div class="phase-placeholder">${entry?.category === 'diffuser' ? 'No polar diffusion data measured for this product.' : 'Diffusers only — pick one to see the polar dispersion plot.'}</div>`;
    return;
  }
  root.innerHTML = `
    <h2>Polar diffusion</h2>
    <p class="surface-note">Diffusion coefficient d(f) per ISO 17497-2. Higher = more uniform polar response. Operating range ${entry.operating_range_hz ? `${entry.operating_range_hz[0]} – ${entry.operating_range_hz[1]} Hz.` : 'not specified.'}</p>
    ${renderDiffusionChartSVG(entry.diffusion_d)}
    ${renderPolarRoseSVG(entry)}
  `;
}

function renderConstructionPanel(entry) {
  const root = $('panel-construction');
  if (!root) return;
  if (!entry) {
    root.innerHTML = `<h2>Cross-section</h2><div class="phase-placeholder">Pick a surface to see its construction layers.</div>`;
    return;
  }
  const layers = layersFor(entry);
  root.innerHTML = `
    <h2>Cross-section</h2>
    <p class="surface-note">Construction layers (front to back) and the role each plays acoustically.</p>
    <ol class="surface-layers">
      ${layers.map(l => `
        <li class="surface-layer">
          <div class="surface-layer-color" style="background:${l.color}"></div>
          <div class="surface-layer-text">
            <div class="surface-layer-name">${escapeHtml(l.name)}</div>
            <div class="surface-layer-role">${escapeHtml(l.role)}</div>
          </div>
        </li>
      `).join('')}
    </ol>
  `;
}

// ---------------------------------------------------------------------
// Charts (inline SVG so no library dependency)
// ---------------------------------------------------------------------

const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];
const BAND_LABELS = ['125', '250', '500', '1k', '2k', '4k', '8k'];

function renderAlphaChartSVG(absorption) {
  const W = 320, H = 160, padL = 28, padR = 8, padT = 12, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const yMax = 1.2;          // include the >1.0 edge-effect zone
  const xOf = i => padL + (i / (BANDS.length - 1)) * plotW;
  const yOf = v => padT + plotH - (v / yMax) * plotH;

  const grid = [];
  for (let v = 0; v <= 1.2 + 1e-6; v += 0.2) {
    const y = yOf(v);
    grid.push(`<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="#3a3f47" stroke-width="0.5" />`);
    grid.push(`<text x="${padL - 4}" y="${y + 3}" text-anchor="end" font-size="9" fill="#9aa0a8">${v.toFixed(1)}</text>`);
  }
  const xLabels = BANDS.map((_, i) => `<text x="${xOf(i)}" y="${padT + plotH + 12}" text-anchor="middle" font-size="9" fill="#9aa0a8">${BAND_LABELS[i]}</text>`).join('');

  const points = absorption.map((v, i) => Number.isFinite(v) ? { x: xOf(i), y: yOf(Math.min(v, yMax)) } : null).filter(Boolean);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const dots = points.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="#74d0ff" />`).join('');
  const labels = absorption.map((v, i) => Number.isFinite(v) ? `<text x="${xOf(i)}" y="${yOf(Math.min(v, yMax)) - 6}" text-anchor="middle" font-size="8" fill="#cfd3d9">${v.toFixed(2)}</text>` : '').join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="surface-alpha-chart" xmlns="http://www.w3.org/2000/svg">
    ${grid.join('')}
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#5a6068" stroke-width="0.8" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#5a6068" stroke-width="0.8" />
    <path d="${path}" stroke="#74d0ff" stroke-width="1.5" fill="none" stroke-linejoin="round" />
    ${dots}
    ${labels}
    ${xLabels}
    <text x="${W / 2}" y="${H - 4}" text-anchor="middle" font-size="9" fill="#9aa0a8">Frequency (Hz)</text>
  </svg>`;
}

function renderDiffusionChartSVG(diffusion) {
  const W = 320, H = 140, padL = 28, padR = 8, padT = 12, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xOf = i => padL + (i / (BANDS.length - 1)) * plotW;
  const yOf = v => padT + plotH - (v / 1.0) * plotH;

  const grid = [];
  for (let v = 0; v <= 1 + 1e-6; v += 0.2) {
    const y = yOf(v);
    grid.push(`<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="#3a3f47" stroke-width="0.5" />`);
    grid.push(`<text x="${padL - 4}" y="${y + 3}" text-anchor="end" font-size="9" fill="#9aa0a8">${v.toFixed(1)}</text>`);
  }
  const xLabels = BANDS.map((_, i) => `<text x="${xOf(i)}" y="${padT + plotH + 12}" text-anchor="middle" font-size="9" fill="#9aa0a8">${BAND_LABELS[i]}</text>`).join('');
  const pts = diffusion.map((v, i) => Number.isFinite(v) ? { x: xOf(i), y: yOf(v), v } : null).filter(Boolean);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const dots = pts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="#ffaa55" />`).join('');
  const labels = pts.map(p => `<text x="${p.x.toFixed(1)}" y="${(p.y - 5).toFixed(1)}" text-anchor="middle" font-size="8" fill="#cfd3d9">${p.v.toFixed(2)}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="surface-diff-chart" xmlns="http://www.w3.org/2000/svg">
    ${grid.join('')}
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#5a6068" stroke-width="0.8" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#5a6068" stroke-width="0.8" />
    <path d="${path}" stroke="#ffaa55" stroke-width="1.5" fill="none" stroke-linejoin="round" />
    ${dots}
    ${labels}
    ${xLabels}
  </svg>`;
}

function renderPolarRoseSVG(entry) {
  // Synthesize a polar pattern from the diffusion coefficient.
  // Higher d → more uniform lobe; lower d → narrower specular peak.
  // Real test data would come from `entry.diffusion.polar_db`; we
  // synthesize a visually-credible pattern here so the user has a
  // visual to read even when polar measurements aren't published.
  const W = 320, H = 240;
  const cx = W / 2, cy = H * 0.78, R = 90;
  const d1k = entry.diffusion_d?.[3] ?? 0.5;        // 1 kHz index
  const d2k = entry.diffusion_d?.[4] ?? d1k;
  const d4k = entry.diffusion_d?.[5] ?? d2k * 0.8;

  function lobePath(d, scale) {
    const pts = [];
    for (let a = -90; a <= 90; a += 5) {
      const rad = a * Math.PI / 180;
      const lobe = (1 - d) * Math.cos(rad) ** 16 + d;        // ranges d…1 across angle
      const r = scale * R * lobe;
      const x = cx + r * Math.cos(rad - Math.PI / 2);
      const y = cy + r * Math.sin(rad - Math.PI / 2);
      pts.push(`${pts.length === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    return pts.join(' ');
  }

  const grid = [];
  for (const r of [R * 0.25, R * 0.5, R * 0.75, R]) {
    grid.push(`<path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="#3a3f47" stroke-width="0.5" />`);
  }
  for (const a of [-90, -60, -30, 0, 30, 60, 90]) {
    const rad = a * Math.PI / 180;
    const x = cx + R * Math.cos(rad - Math.PI / 2);
    const y = cy + R * Math.sin(rad - Math.PI / 2);
    grid.push(`<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#3a3f47" stroke-width="0.5" />`);
    grid.push(`<text x="${x.toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="8" fill="#9aa0a8">${a}°</text>`);
  }

  return `<svg viewBox="0 0 ${W} ${H}" class="surface-polar-chart" xmlns="http://www.w3.org/2000/svg">
    ${grid.join('')}
    <path d="${lobePath(d4k, 1.0)}" stroke="#ff7a55" stroke-width="1.2" fill="none" stroke-dasharray="2 2" opacity="0.7" />
    <path d="${lobePath(d2k, 1.0)}" stroke="#ffaa55" stroke-width="1.4" fill="none" />
    <path d="${lobePath(d1k, 1.0)}" stroke="#74d0ff" stroke-width="1.6" fill="none" />
    <text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="9" fill="#cfd3d9">— 1 kHz   — 2 kHz   ⋯ 4 kHz</text>
  </svg>`;
}

function renderNRCStripe(entry) {
  if (entry.nrc == null && entry.category !== 'finish' && entry.category !== 'absorber' && entry.category !== 'ceiling') return '';
  if (entry.nrc == null) return '';
  return `<div class="surface-nrc-stripe">
    <span class="surface-nrc-label">NRC</span>
    <span class="surface-nrc-value">${entry.nrc.toFixed(2)}</span>
    <span class="surface-nrc-note">avg α at 250 / 500 / 1k / 2k Hz</span>
  </div>`;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function formatHeadlineNumber(entry, big = false) {
  if (!entry) return '';
  if (entry.category === 'diffuser') {
    const d1k = entry.diffusion_d?.[3];
    if (Number.isFinite(d1k)) {
      return big ? `<span class="surface-h-big">${d1k.toFixed(2)}</span><span class="surface-h-unit">D(1 kHz)</span>` : `D ${d1k.toFixed(2)}`;
    }
    return big ? `<span class="surface-h-unit">No diffusion data</span>` : '—';
  }
  if (entry.category === 'trap') {
    const a125 = entry.absorption?.[0];
    if (Number.isFinite(a125)) {
      return big ? `<span class="surface-h-big">${a125.toFixed(2)}</span><span class="surface-h-unit">α(125 Hz)</span>` : `α₁₂₅ ${a125.toFixed(2)}`;
    }
    return '—';
  }
  if (Number.isFinite(entry.nrc)) {
    return big ? `<span class="surface-h-big">${entry.nrc.toFixed(2)}</span><span class="surface-h-unit">NRC</span>` : `NRC ${entry.nrc.toFixed(2)}`;
  }
  if (Array.isArray(entry.absorption)) {
    const vals = [entry.absorption[1], entry.absorption[2], entry.absorption[3], entry.absorption[4]].filter(Number.isFinite);
    if (vals.length === 4) {
      const nrc = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length / 0.05) * 0.05;
      return big ? `<span class="surface-h-big">${nrc.toFixed(2)}</span><span class="surface-h-unit">NRC (calc)</span>` : `NRC ${nrc.toFixed(2)}`;
    }
  }
  return '—';
}

export function humanMounting(m) {
  if (!m) return 'unspecified';
  return ({
    'ASTM_C423_TypeA': 'Type A (against rigid wall)',
    'ASTM_C423_TypeE400': 'Type E-400 (400 mm air gap)',
    'E-400': 'E-400 (400 mm air gap)',
    'E-405': 'E-405 (405 mm air gap)',
    'corner_2D': '2-corner (wall–wall)',
    'corner_3D': '3-corner (wall–wall–floor)',
    'ISO354_A': 'ISO 354 Type A',
    'reference': 'reference (textbook)',
  })[m] || m;
}

function humaniseKind(k) {
  return ({
    'finish': 'Plain finish',
    'absorber_legacy': 'Absorber (legacy data)',
    'diffuser_qrd_1d': 'QRD 1D',
    'diffuser_skyline': 'Skyline 2D',
    'diffuser_poly': 'Polycylindrical',
    'hybrid_diffsorber': 'Hybrid diffsorber',
    'absorber_foam_wedge': 'Foam wedge',
    'absorber_foam_pyramid': 'Foam pyramid',
    'absorber_panel': 'Broadband panel',
    'trap_corner_porous': 'Corner trap',
    'trap_membrane': 'Membrane trap',
    'trap_helmholtz': 'Helmholtz trap',
    'ceiling_tile': 'Ceiling tile',
  })[k] || k;
}

function rowKv(label, value) {
  if (value === '' || value == null) return '';
  return `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
}

function layersFor(entry) {
  const kind = entry.kind;
  const c = entry.visual?.color || '#999';
  if (kind === 'diffuser_qrd_1d' || kind === 'diffuser_skyline') {
    return [
      { name: 'Wood face (varies depth per well)', role: 'Phase-shifts incoming waves to scatter energy', color: c },
      { name: 'Side walls (fins)', role: 'Confine each well so depths produce distinct phase shifts', color: '#222' },
      { name: 'Backer plate', role: 'Reflective floor of every well', color: '#333' },
    ];
  }
  if (kind === 'diffuser_poly') {
    return [
      { name: 'Curved wood face', role: 'Geometric scattering — angle of incidence ≠ angle of reflection across the arc', color: c },
      { name: 'Backer plate', role: 'Stiffens the curved face', color: '#333' },
    ];
  }
  if (kind === 'hybrid_diffsorber') {
    return [
      { name: 'Binary perforation mask', role: 'Diffuses MF/HF via amplitude-grating physics', color: c },
      { name: 'Fibreglass core', role: 'Absorbs LF/MF energy that passes through the mask', color: '#3a322c' },
      { name: 'Rigid backer', role: 'Reflective boundary', color: '#222' },
    ];
  }
  if (kind === 'absorber_foam_wedge' || kind === 'absorber_foam_pyramid') {
    return [
      { name: 'Melamine foam profile', role: 'Increases surface area; wedge/pyramid shape extends MF/HF dissipation path', color: c },
      { name: 'Foam base', role: 'Adhesive surface for wall mount', color: '#1a1a1a' },
    ];
  }
  if (kind === 'absorber_panel') {
    return [
      { name: 'Acoustic fabric', role: 'Acoustically transparent skin', color: '#322f2c' },
      { name: 'Mineral fibre / fibreglass core', role: 'Primary energy dissipator (porous absorber)', color: '#a8a08c' },
      { name: 'Edge-stiffened frame', role: 'Holds geometry; usually sealed back to limit air-gap variability', color: '#1a1a1a' },
    ];
  }
  if (kind === 'trap_corner_porous') {
    return [
      { name: 'Acoustic fabric skin', role: 'Acoustically transparent', color: '#322f2c' },
      { name: 'Porous fill (full depth)', role: 'LF dissipation via long path-length through low-density fibres', color: '#a8a08c' },
      { name: 'Corner geometry', role: 'Places the absorber where modal pressure is highest — corners excite all axial / tangential modes', color: '#3a322c' },
    ];
  }
  if (kind === 'trap_membrane') {
    return [
      { name: 'Tuned membrane (plywood / MDF / metal)', role: 'Resonates at f₀ — converts incident pressure to mechanical motion', color: c },
      { name: 'Air cavity', role: 'Spring of the resonant system; depth + density set f₀', color: '#161512' },
      { name: 'Damping fill', role: 'Broadens the resonance peak (lowers Q)', color: '#a8a08c' },
      { name: 'Sealed cabinet', role: 'Confines air mass so it acts as a spring', color: '#222' },
    ];
  }
  if (kind === 'ceiling_tile') {
    return [
      { name: 'Mineral-fibre tile face', role: 'Porous absorber; performance scales with plenum depth', color: c },
      { name: 'Suspension grid', role: 'Holds the tile; introduces an air gap that boosts LF α', color: '#9aa0a8' },
    ];
  }
  return [{ name: entry.name, role: 'Surface finish', color: c }];
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
