// WallLAB workbench view. Rail-system layout (viewport-bound, no page
// scroll), matching the other labs:
//   • Left "Physics mode" panel (#panel-physics) — the over-wall-acoustics
//     BETA toggle (gates PHYSICS_P1_5 / Tier 1a).
//   • Centre #view-wall — the wall-isolation simulator: wall-type + material
//     + thickness → per-octave transmission loss, COMPUTED (field mass law)
//     overlaid on the MEASURED catalogue data. The computed↔measured
//     divergence near the coincidence dip is the teaching point, labelled.
//   • Right "Standards & method" panel (#panel-method) — the live equation
//     with the user's numbers substituted + the standard cited.
//
// Toggle model (tri-state, see js/physics/feature-flags.js): an explicit
// On/Off OVERRIDES the localhost auto-enable; the flag is read once at load,
// so applying a change needs a reload (explicit "Reload now" affordance).

import {
  PHYSICS_P1_5_ENABLED,
  isPhysicsP15AutoOrigin,
  getStoredPhysicsP15,
  getEffectivePhysicsP15,
  setStoredPhysicsP15,
} from '../../physics/feature-flags.js';
import { loadMaterials } from '../../physics/materials.js';
import { massLawTLBandsAtThickness, densityFromCatalogue, surfaceDensity, massLawTL } from '../../physics/wall-tl.js';
import { WALL_TYPES, WALL_MATERIALS, wallMaterialsByType, wallMaterialMeta } from './wall-catalogue.js';

export function mountWallSim() {
  const view = document.getElementById('view-wall');
  if (!view) return;
  const physicsBody = document.getElementById('wall-physics-body');

  // Centre — the simulator workbench.
  view.innerHTML = `
    <div class="wall-workbench">
      <header class="wall-head">
        <h1>WallLAB <span class="wall-beta-chip">BETA</span></h1>
        <p class="wall-sub">Wall sound isolation &amp; transmission loss — the real physics and the standard, shown.</p>
      </header>
      <section class="wall-card wall-sim" aria-labelledby="wall-sim-h">
        <h2 id="wall-sim-h">Wall isolation simulator</h2>
        <div id="wall-sim-body"><p class="phase-placeholder">Loading material catalogue…</p></div>
      </section>
    </div>
  `;

  // Left panel — the over-wall-acoustics BETA toggle.
  if (physicsBody) {
    const autoOrigin = isPhysicsP15AutoOrigin();
    const sessionState = PHYSICS_P1_5_ENABLED;
    const effectiveIntent = getEffectivePhysicsP15();
    const stored = getStoredPhysicsP15();
    physicsBody.innerHTML = toggleHTML(stored, sessionState, effectiveIntent, autoOrigin);
    wireToggle(physicsBody, { sessionState, autoOrigin });
  }

  buildSimulator(view).catch(err => {
    const body = view.querySelector('#wall-sim-body');
    if (body) body.innerHTML = `<p class="wall-status-warn">Couldn't load the material catalogue: ${err?.message ?? err}</p>`;
  });
}

// ---------------------------------------------------------------------------
// BETA toggle (rendered into the left Physics panel)
// ---------------------------------------------------------------------------
function toggleHTML(stored, sessionState, effectiveIntent, autoOrigin) {
  return `
    <div class="wall-toggle-head">
      <span class="wall-toggle-name">Over-wall acoustics <span class="wall-beta-chip">BETA</span></span>
      <button id="wall-p15-toggle" class="wall-switch" type="button" role="switch"
        aria-checked="${effectiveIntent ? 'true' : 'false'}" aria-describedby="wall-toggle-status"
        aria-label="Enable over-wall acoustics (Tier 1a physics)">
        <span class="wall-switch-track"><span class="wall-switch-thumb"></span></span>
        <span class="wall-switch-state">${effectiveIntent ? 'On' : 'Off'}</span>
      </button>
    </div>
    <p class="wall-toggle-desc">
      Models sound bending <em>over</em> and re-radiating <em>through</em> walls
      (edge diffraction + wall re-radiation). With this off, a wall is treated as
      a hard acoustic shadow — which under-predicts the level near walls below
      high-mounted exterior sources (e.g. azan horns above a parapet).
      <span class="wall-validation">Beta — physics under validation.</span>
    </p>
    <div class="wall-toggle-status" id="wall-toggle-status">
      ${statusLine(stored, sessionState, effectiveIntent, autoOrigin)}
    </div>
    <div class="wall-reload-banner" id="wall-reload-banner" ${effectiveIntent === sessionState ? 'hidden' : ''}>
      <span>Reload to apply the new physics mode.</span>
      <button id="wall-reload-btn" type="button" class="wall-reload-btn">Reload now</button>
    </div>
  `;
}

function wireToggle(scope, { sessionState, autoOrigin }) {
  const toggle = scope.querySelector('#wall-p15-toggle');
  const stateLabel = scope.querySelector('.wall-switch-state');
  const statusEl = scope.querySelector('#wall-toggle-status');
  const banner = scope.querySelector('#wall-reload-banner');
  if (!toggle) return;

  function applyToggle() {
    const next = toggle.getAttribute('aria-checked') !== 'true';
    if (!setStoredPhysicsP15(next)) {
      statusEl.innerHTML = `<span class="wall-status-warn">Couldn't save the setting — storage is blocked (private window?).</span>`;
      return;
    }
    toggle.setAttribute('aria-checked', next ? 'true' : 'false');
    stateLabel.textContent = next ? 'On' : 'Off';
    statusEl.innerHTML = statusLine(next, sessionState, next, autoOrigin);
    banner.hidden = (next === sessionState);
  }
  toggle.addEventListener('click', applyToggle);
  toggle.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); applyToggle(); }
  });
  scope.querySelector('#wall-reload-btn')?.addEventListener('click', () => location.reload());
}

function statusLine(stored, sessionState, effectiveIntent, autoOrigin) {
  const prefLabel = stored === true ? 'On'
    : stored === false ? 'Off'
    : (autoOrigin ? 'Default — on (localhost dev)' : 'Default — off (public deploy)');
  let s = `Currently <strong>${sessionState ? 'active' : 'off'}</strong> this session.
    Saved preference: <strong>${prefLabel}</strong>.`;
  if (effectiveIntent !== sessionState) s += ` <span class="wall-status-auto">Reload to apply.</span>`;
  return s;
}

// ---------------------------------------------------------------------------
// Simulator (centre) + Standards/method (right panel)
// ---------------------------------------------------------------------------
async function buildSimulator(view) {
  const materials = await loadMaterials();
  const bands = materials.frequency_bands_hz;
  const body = view.querySelector('#wall-sim-body');
  const methodBody = document.getElementById('wall-method-body');

  const present = WALL_MATERIALS.filter(m => materials.byId[m.id]?.transmission_loss_db);
  if (present.length === 0) {
    body.innerHTML = `<p class="phase-placeholder">No wall materials available in the catalogue.</p>`;
    return;
  }

  let typeId = WALL_TYPES.find(t => wallMaterialsByType(t.id).some(m => present.includes(m)))?.id || WALL_TYPES[0].id;
  let matId = wallMaterialsByType(typeId).find(m => present.includes(m))?.id || present[0].id;
  let thickness_mm = wallMaterialMeta(matId).thickness_mm.default;

  body.innerHTML = `
    <div class="wall-sim-controls">
      <label class="wall-ctrl">Wall type
        <select id="wall-type"></select>
      </label>
      <label class="wall-ctrl">Material
        <select id="wall-mat"></select>
      </label>
      <label class="wall-ctrl wall-ctrl-slider">Thickness (mm)
        <input type="range" id="wall-thick" min="50" max="400" step="1" value="${thickness_mm}" aria-describedby="wall-thick-val" />
        <output id="wall-thick-val" class="wall-thick-val">${thickness_mm} mm</output>
      </label>
    </div>
    <div class="wall-sim-results">
      <div class="wall-summary">
        <span class="wall-summary-num" id="wall-summary-num">—</span>
        <span class="wall-summary-unit">dB</span>
        <span class="wall-summary-cap">mass-law mean TL<br>250&nbsp;Hz – 4&nbsp;kHz</span>
      </div>
      <div class="wall-plot" id="wall-plot" role="img" aria-label="Transmission loss versus frequency"></div>
    </div>
    <div class="wall-table-wrap"><table class="wall-tl-table" id="wall-table"></table></div>
    <p class="wall-method-hint">Open <strong>Standards &amp; method</strong> (right) for the live equation and the cited standard.</p>
  `;

  const typeSel = body.querySelector('#wall-type');
  const matSel = body.querySelector('#wall-mat');
  const thickInput = body.querySelector('#wall-thick');
  const thickVal = body.querySelector('#wall-thick-val');

  typeSel.innerHTML = WALL_TYPES
    .filter(t => wallMaterialsByType(t.id).some(m => present.includes(m)))
    .map(t => `<option value="${t.id}">${t.label}</option>`).join('');

  function refreshMaterialOptions() {
    const mats = wallMaterialsByType(typeId).filter(m => present.includes(m));
    matSel.innerHTML = mats.map(m => {
      const cat = materials.byId[m.id];
      const est = cat.tl_estimated ? ' ≈' : '';
      return `<option value="${m.id}">${cat.name || m.id}${est}</option>`;
    }).join('');
    if (!mats.some(m => m.id === matId)) matId = mats[0].id;
    matSel.value = matId;
  }

  function syncThicknessSlider() {
    const meta = wallMaterialMeta(matId);
    thickInput.min = meta.thickness_mm.min;
    thickInput.max = meta.thickness_mm.max;
    if (thickness_mm > meta.thickness_mm.max || thickness_mm < meta.thickness_mm.min) {
      thickness_mm = meta.thickness_mm.default;
    }
    thickInput.value = thickness_mm;
    thickVal.textContent = `${thickness_mm} mm`;
  }

  function render() {
    const meta = wallMaterialMeta(matId);
    const cat = materials.byId[matId];
    const thickness_m = thickness_mm / 1000;
    const computed = massLawTLBandsAtThickness(cat.surface_density_kg_m2, meta.reference_thickness_m, thickness_m, bands);
    const measured = cat.transmission_loss_db;
    const measuredRefMm = Math.round(meta.reference_thickness_m * 1000);
    const atRef = Math.abs(thickness_mm - measuredRefMm) <= 0.5;

    const midIdx = [1, 2, 3, 4, 5];
    const mean = midIdx.reduce((a, i) => a + computed[i], 0) / midIdx.length;
    body.querySelector('#wall-summary-num').textContent = Math.round(mean);

    body.querySelector('#wall-plot').innerHTML = plotSVG(bands, computed, measured, meta.coincidence_band_hz, atRef);
    body.querySelector('#wall-table').innerHTML = tableHTML(bands, computed, measured, atRef);

    if (methodBody) methodBody.innerHTML = methodHTML(cat, meta, thickness_m);
  }

  typeSel.addEventListener('change', () => { typeId = typeSel.value; refreshMaterialOptions(); syncThicknessSlider(); render(); });
  matSel.addEventListener('change', () => { matId = matSel.value; syncThicknessSlider(); render(); });
  thickInput.addEventListener('input', () => { thickness_mm = Number(thickInput.value); thickVal.textContent = `${thickness_mm} mm`; render(); });

  typeSel.value = typeId;
  refreshMaterialOptions();
  syncThicknessSlider();
  render();
}

// --- SVG plot: computed (solid) + measured (dashed + markers) --------------
function plotSVG(bands, computed, measured, coincidenceHz, showMeasured) {
  const W = 460, H = 220, mL = 38, mR = 12, mT = 14, mB = 30;
  const plotW = W - mL - mR, plotH = H - mT - mB;
  const yMin = 0, yMax = 70;
  const x = (i) => mL + (i / (bands.length - 1)) * plotW;
  const y = (db) => mT + plotH - ((db - yMin) / (yMax - yMin)) * plotH;

  let grid = '';
  for (let db = yMin; db <= yMax; db += 10) {
    grid += `<line x1="${mL}" y1="${y(db)}" x2="${W - mR}" y2="${y(db)}" class="wp-grid"/>`;
    grid += `<text x="${mL - 6}" y="${y(db) + 3}" class="wp-ytick">${db}</text>`;
  }
  const fmt = (f) => f >= 1000 ? `${f / 1000}k` : `${f}`;
  let xlabs = '';
  bands.forEach((f, i) => { xlabs += `<text x="${x(i)}" y="${H - 10}" class="wp-xtick">${fmt(f)}</text>`; });

  const path = (arr) => arr.map((db, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(db).toFixed(1)}`).join(' ');

  let measuredLayer = '';
  if (showMeasured) {
    measuredLayer = `<path d="${path(measured)}" class="wp-measured"/>` +
      measured.map((db, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(db).toFixed(1)}" r="3" class="wp-measured-pt"/>`).join('');
  }
  const computedLayer = `<path d="${path(computed)}" class="wp-computed"/>`;

  let dip = '';
  if (coincidenceHz != null) {
    const di = bands.indexOf(coincidenceHz);
    if (di >= 0 && showMeasured) {
      const dx = x(di), dyTop = mT + 2;
      dip = `<line x1="${dx}" y1="${dyTop}" x2="${dx}" y2="${y(measured[di])}" class="wp-dip-leader"/>` +
        `<text x="${dx}" y="${dyTop + 9}" class="wp-dip-label" text-anchor="${di > bands.length / 2 ? 'end' : 'start'}">coincidence dip</text>`;
    }
  }

  const lx = W - mR - 150, ly = mT + 4;
  const legend = `
    <line x1="${lx}" y1="${ly}" x2="${lx + 20}" y2="${ly}" class="wp-computed"/>
    <text x="${lx + 26}" y="${ly + 3}" class="wp-legend">computed (mass law)</text>
    ${showMeasured ? `
      <line x1="${lx}" y1="${ly + 14}" x2="${lx + 20}" y2="${ly + 14}" class="wp-measured"/>
      <circle cx="${lx + 10}" cy="${ly + 14}" r="3" class="wp-measured-pt"/>
      <text x="${lx + 26}" y="${ly + 17}" class="wp-legend">measured</text>` : ''}
  `;

  return `<svg viewBox="0 0 ${W} ${H}" class="wall-plot-svg" preserveAspectRatio="xMidYMid meet">
    <text x="10" y="${mT + plotH / 2}" class="wp-axis-title" transform="rotate(-90 10 ${mT + plotH / 2})">TL (dB)</text>
    ${grid}${xlabs}${dip}${measuredLayer}${computedLayer}${legend}
  </svg>`;
}

// --- Per-band table: computed / measured / Δ -------------------------------
function tableHTML(bands, computed, measured, showMeasured) {
  const fmt = (f) => f >= 1000 ? `${f / 1000}k` : `${f}`;
  const head = `<tr><th>Hz</th>${bands.map(f => `<th>${fmt(f)}</th>`).join('')}</tr>`;
  const compRow = `<tr><th>Computed</th>${computed.map(v => `<td>${Math.round(v)}</td>`).join('')}</tr>`;
  if (!showMeasured) {
    return `<thead>${head}</thead><tbody>${compRow}
      <tr class="wall-tl-note"><td colspan="${bands.length + 1}">Measured data is at the reference thickness — set the slider to it to compare.</td></tr></tbody>`;
  }
  const measRow = `<tr><th>Measured</th>${measured.map(v => `<td>${Math.round(v)}</td>`).join('')}</tr>`;
  const dRow = `<tr class="wall-tl-delta"><th>Δ</th>${computed.map((v, i) => {
    const d = Math.round(v - measured[i]);
    return `<td>${d > 0 ? '+' : ''}${d}</td>`;
  }).join('')}</tr>`;
  return `<thead>${head}</thead><tbody>${compRow}${measRow}${dRow}</tbody>`;
}

// --- Standards & method (right panel) --------------------------------------
function methodHTML(cat, meta, thickness_m) {
  const density = densityFromCatalogue(cat.surface_density_kg_m2, meta.reference_thickness_m);
  const m = surfaceDensity(thickness_m, density);
  const f = 500;
  const tl500 = massLawTL(m, f);
  const source = cat._tl_source || cat._source || cat._tl_note || '—';
  const measuredLine = cat.tl_estimated
    ? `<span class="wall-est-chip">≈ estimated</span> This material's catalogue TL is itself a mass-law estimate — no independent measured data, so the two curves coincide by construction. Source: ${escapeHtml(source)}`
    : `<strong>Measured:</strong> ${escapeHtml(source)}`;

  return `
    <div class="wall-eq">
      <div class="wall-eq-line">TL = 20·log₁₀(m·f) − 47</div>
      <div class="wall-eq-sub">m = ${m.toFixed(0)} kg/m² (at ${(thickness_m * 1000).toFixed(0)} mm) · f = ${f} Hz</div>
      <div class="wall-eq-line wall-eq-result">= 20·log₁₀(${(m * f).toFixed(0)}) − 47 = <strong>${tl500.toFixed(0)} dB</strong></div>
    </div>
    <p class="wall-method-plain">
      Mass law predicts isolation from a wall's weight and the frequency: every
      doubling of mass — or of frequency — adds about 6&nbsp;dB. Real walls dip
      below this near the <em>coincidence frequency</em>, where the panel flexes
      in sympathy with the sound and leaks more. Heavy, stiff masonry pushes that
      frequency above the audible range, so concrete tracks the line; thin glass
      and gypsum do not.
    </p>
    <ul class="wall-cites">
      <li><strong>Computed line:</strong> field-incidence mass law, TL = 20·log₁₀(m·f) − 47 dB. Beranek &amp; Vér, <em>Noise and Vibration Control Engineering</em> 2nd ed. §10.3; Sharp 1973. Valid below the coincidence frequency.</li>
      <li><strong>Measured anchor:</strong> ${measuredLine}</li>
      <li class="wall-cite-sep"><strong>Separate model:</strong> sound bending <em>over</em> a wall is edge diffraction (Maekawa, ISO&nbsp;9613-2 §7.4) — the "over-wall acoustics" toggle (left), not partition transmission loss.</li>
    </ul>
  `;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
