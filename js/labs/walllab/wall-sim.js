// WallLAB workbench view. Rail-system layout (viewport-bound, no page
// scroll), matching the other labs:
//   • Left "Physics mode" panel (#panel-physics) — the over-wall-acoustics
//     BETA toggle (gates PHYSICS_P1_5 / Tier 1a).
//   • Centre #view-wall — a two-mode simulator:
//       1. THROUGH-WALL ISOLATION — material + thickness → per-octave
//          transmission loss, COMPUTED (field mass law) overlaid on the
//          MEASURED catalogue data; the coincidence-dip divergence labelled.
//       2. OVER-WALL DIFFRACTION — a cross-section of source / wall /
//          receiver showing how sound bends OVER a wall (Maekawa edge
//          diffraction). Directly visualises the surau insight: a source
//          mounted above a wall has a near-clear sightline → it leaks over.
//   • Right "Standards & method" panel (#panel-method) — the live equation
//     + standard, switching with the mode.
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
  isTier1aOutdoorOverrideDisabled,
  setTier1aOutdoorOverrideDisabled,
} from '../../physics/feature-flags.js';
import { loadMaterials } from '../../physics/materials.js';
import { massLawTLBandsAtThickness, densityFromCatalogue, surfaceDensity, massLawTL, massLawTLBands } from '../../physics/wall-tl.js';
import { overBarrierPathDifference, maekawaIL } from '../../physics/diffraction.js';
import { airAbsorptionDbPerM } from '../../physics/air-absorption.js';
import {
  ISO_THIRD_OCTAVE_HZ,
  ISO_RW_BANDS_HZ,
  octaveToThirdOctave,
} from '../../physics/third-octave-bands.js';
import {
  computeRw,
  computeSTC,
  computeC,
  computeCtr,
  ISO_717_1_RW_CONTOUR_DB,
} from '../../physics/wall-rating.js';
import {
  doubleLeafTL,
  massAirMassFreq,
  cavityCutoffFreq,
} from '../../physics/wall-tl-double-leaf.js';
import { compositeTL as compositeTLFn } from '../../physics/wall-composite.js';
import { WALL_TYPES, WALL_MATERIALS, wallMaterialsByType, wallMaterialMeta, isSingleLeafAssembly } from './wall-catalogue.js';

const SPEED_OF_SOUND = 343;          // m/s @ 20 °C (demo)
const DEMO_SRC_TO_WALL_M = 2;        // source horizontal offset from the wall
const DEMO_RECEIVER_H_M = 1.5;       // listener ear height

export function mountWallSim() {
  const view = document.getElementById('view-wall');
  if (!view) return;
  const physicsBody = document.getElementById('wall-physics-body');

  view.innerHTML = `
    <div class="wall-workbench">
      <header class="wall-head">
        <h1>WallLAB <span class="wall-beta-chip">BETA</span></h1>
        <p class="wall-sub">Wall sound isolation &amp; over-wall acoustics — the real physics and the standard, shown.</p>
      </header>
      <section class="wall-card wall-sim" aria-labelledby="wall-sim-h">
        <div class="wall-mode-seg" role="tablist" aria-label="Simulator mode">
          <button class="wall-seg-btn is-active" role="tab" aria-selected="true" data-mode="isolation" type="button">Through-wall isolation</button>
          <button class="wall-seg-btn" role="tab" aria-selected="false" data-mode="diffraction" type="button">Over-wall diffraction</button>
        </div>
        <div id="wall-sim-body"><p class="phase-placeholder">Loading material catalogue…</p></div>
      </section>
    </div>
  `;

  if (physicsBody) {
    const autoOrigin = isPhysicsP15AutoOrigin();
    const sessionState = PHYSICS_P1_5_ENABLED;
    const effectiveIntent = getEffectivePhysicsP15();
    const stored = getStoredPhysicsP15();
    const outdoorOverrideOn = isTier1aOutdoorOverrideDisabled();
    physicsBody.innerHTML = toggleHTML(stored, sessionState, effectiveIntent, autoOrigin)
      + outdoorOverrideHTML(outdoorOverrideOn);
    wireToggle(physicsBody, { sessionState, autoOrigin });
    wireOutdoorOverride(physicsBody);
  }

  buildSimulator(view).catch(err => {
    const body = view.querySelector('#wall-sim-body');
    if (body) body.innerHTML = `<p class="wall-status-warn">Couldn't load the material catalogue: ${err?.message ?? err}</p>`;
  });
}

// ---------------------------------------------------------------------------
// BETA toggle (left Physics panel)
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

// ---------------------------------------------------------------------------
// INTERIM SAFETY OVERRIDE (2026-05-24) — outdoor-mode Tier 1a disable.
//
// See `js/physics/feature-flags.js` for the why. This toggle is LIVE: no
// reload required. Flipping it ON forces enableTier1a=false in outdoor mode
// on the NEXT heatmap render; indoor path is unaffected. The whole block
// gets deleted in the Phase B commit that fixes the underlying physics.
// ---------------------------------------------------------------------------
function outdoorOverrideHTML(on) {
  return `
    <div class="wall-toggle-head wall-toggle-divider">
      <span class="wall-toggle-name">Outdoor diffraction override <span class="wall-beta-chip" style="background:#a44;">SAFETY</span></span>
      <button id="wall-tier1a-outdoor-toggle" class="wall-switch" type="button" role="switch"
        aria-checked="${on ? 'true' : 'false'}" aria-describedby="wall-outdoor-override-status"
        aria-label="Disable Tier 1a contributions in outdoor mode (interim safety override)">
        <span class="wall-switch-track"><span class="wall-switch-thumb"></span></span>
        <span class="wall-switch-state">${on ? 'On' : 'Off'}</span>
      </button>
    </div>
    <p class="wall-toggle-desc">
      <strong>Temporary.</strong> When ON, disables Tier 1a contributions
      (Maekawa diffraction, Kuttruff wall re-radiation, image-source overhead,
      porch enclosure) for outdoor presets — surau, auditorium-outdoor, etc.
      The heatmap falls back to direct field + diffuse reverb only.
      Use this when previewing the PA system to stakeholders while the
      Phase B physics rework is in flight (estimated 5-6 days from 2026-05-24).
      Indoor heatmap is unaffected by this toggle.
      <span class="wall-validation">Override removed after Phase B physics rework lands.</span>
    </p>
    <div class="wall-toggle-status" id="wall-outdoor-override-status">
      ${on
        ? 'Currently <strong>active</strong> — outdoor Tier 1a is disabled, heatmap shows direct + reverb only.'
        : 'Currently <strong>off</strong> — outdoor heatmap uses Tier 1a (may over-predict shadowed cells).'}
    </div>
  `;
}

function wireOutdoorOverride(scope) {
  const toggle = scope.querySelector('#wall-tier1a-outdoor-toggle');
  if (!toggle) return;
  const stateLabel = toggle.querySelector('.wall-switch-state');
  const statusEl = scope.querySelector('#wall-outdoor-override-status');

  function applyOverride() {
    const next = toggle.getAttribute('aria-checked') !== 'true';
    if (!setTier1aOutdoorOverrideDisabled(next)) {
      statusEl.innerHTML = `<span class="wall-status-warn">Couldn't save the setting — storage is blocked (private window?).</span>`;
      return;
    }
    toggle.setAttribute('aria-checked', next ? 'true' : 'false');
    stateLabel.textContent = next ? 'On' : 'Off';
    statusEl.innerHTML = next
      ? 'Currently <strong>active</strong> — outdoor Tier 1a is disabled, heatmap shows direct + reverb only. <span class="wall-status-auto">Rebuild the heatmap (move a source, change a material, or re-open the room) to see the change.</span>'
      : 'Currently <strong>off</strong> — outdoor heatmap uses Tier 1a (may over-predict shadowed cells). <span class="wall-status-auto">Rebuild the heatmap to see the change.</span>';
  }
  toggle.addEventListener('click', applyOverride);
  toggle.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); applyOverride(); }
  });
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
// Simulator — two modes sharing the centre + the right method panel
// ---------------------------------------------------------------------------
async function buildSimulator(view) {
  const materials = await loadMaterials('data/materials.json');
  const bands = materials.frequency_bands_hz;
  const body = view.querySelector('#wall-sim-body');
  const methodBody = document.getElementById('wall-method-body');

  const present = WALL_MATERIALS.filter(m => materials.byId[m.id]?.transmission_loss_db);
  if (present.length === 0) {
    body.innerHTML = `<p class="phase-placeholder">No wall materials available in the catalogue.</p>`;
    return;
  }

  // --- Persistent state for each mode (survives mode switches) ---
  let mode = 'isolation';
  const iso = {
    typeId: WALL_TYPES.find(t => wallMaterialsByType(t.id).some(m => present.includes(m)))?.id || WALL_TYPES[0].id,
    matId: null,
    thickness_mm: 0,
  };
  iso.matId = wallMaterialsByType(iso.typeId).find(m => present.includes(m))?.id || present[0].id;
  syncIsoStateForMaterial(iso, materials.byId[iso.matId]);
  // Step 9 (Maya 2026-05-23): composite inset state — door / window / vent
  // in a primary wall. Default-disabled; defaults follow Maya §6 (canonical
  // "door in wall" — door-solid-wood at 5% area). Session-persistent: when
  // the user toggles inset off then back on, their last-used material +
  // percentage return.
  iso.inset = iso.inset || { enabled: false, matId: 'door-solid-wood', area_percent: 5 };
  const diff = { sourceH: 7, wallH: 4.5, recvDist: 3, groundType: 'hard' };   // surau-like default

  // Segment control.
  view.querySelectorAll('.wall-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === mode) return;
      mode = btn.dataset.mode;
      view.querySelectorAll('.wall-seg-btn').forEach(b => {
        const on = b.dataset.mode === mode;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderMode();
    });
  });

  function renderMode() {
    if (mode === 'isolation') renderIsolation(body, methodBody, materials, bands, iso);
    else renderDiffraction(body, methodBody, bands, diff);
  }
  renderMode();
}

// --- Mode 1: through-wall isolation ----------------------------------------
// Step 8 (Maya 2026-05-23) — three sub-modes share one workbench surface,
// silently reshaping the control rail when the selected material's `model`
// field changes:
//   mass-law:   today's thickness slider UI (single-leaf catalogue rows).
//   formula:    Sharp three-region — two leaf-mass sliders, cavity depth,
//               cavity-fill segment, stud-system segment. Prefilled from
//               row.assembly so the user starts at the catalogue point and
//               sees the formula consequence of any tweak.
//   catalogue:  no parametric controls — the measured curve speaks for
//               itself. Unreachable in v=620 (Lin deferred all 4 catalogue
//               rows to Phase 6 pending digitised 1/3-oct data).
//
// The reshape transitions in opacity only (no height animation) so the
// controls grid keeps width and the eye doesn't jump. Material dropdown
// gains a model pill in each option label per Maya §1.

function renderIsolation(body, methodBody, materials, bands, st) {
  const present = WALL_MATERIALS.filter(m => materials.byId[m.id]?.transmission_loss_db);
  // Step 8d (Maya §5): deferred rows are visible in the dropdown DISABLED
  // with a "· measured data pending" sublabel. `dropdownRows` = present
  // (selectable) ∪ deferred (greyed out). The wall-type filter still
  // requires at least one PRESENT row per type — types with only deferred
  // rows would be a dead end.
  const dropdownRows = WALL_MATERIALS.filter(m => m.deferred || present.includes(m));
  body.innerHTML = `
    <div class="wall-sim-controls">
      <label class="wall-ctrl">Wall type <select id="wall-type"></select></label>
      <label class="wall-ctrl">Material <select id="wall-mat"></select></label>
      <div class="wall-ctrl-fluid" id="wall-params"></div>
    </div>
    <p class="wall-deferred-caption" id="wall-deferred-caption" hidden></p>
    <div class="wall-inset-container" id="wall-inset-container"></div>
    <div class="wall-sim-results">
      <div class="wall-summary" id="wall-summary">
        <!-- chip injected by renderSummary -->
      </div>
      <div class="wall-plot" id="wall-plot" role="img" aria-label="Transmission loss versus frequency"></div>
    </div>
    <div class="wall-table-wrap"><table class="wall-tl-table" id="wall-table"></table></div>
    <p class="wall-method-hint">Open <strong>Standards &amp; method</strong> (right) for the live equation and the cited standard.</p>
  `;
  const typeSel = body.querySelector('#wall-type');
  const matSel = body.querySelector('#wall-mat');
  const deferredCaption = body.querySelector('#wall-deferred-caption');

  typeSel.innerHTML = WALL_TYPES
    .filter(t => wallMaterialsByType(t.id).some(m => present.includes(m)))
    .map(t => `<option value="${t.id}">${t.label}</option>`).join('');

  function refreshMaterialOptions() {
    // Show every row of the active wallType — selectable rows first, then
    // deferred (visible-but-disabled) at the bottom.
    const allMats = dropdownRows.filter(m => m.wallType === st.typeId);
    const selectable = allMats.filter(m => !m.deferred);
    const deferred = allMats.filter(m => m.deferred);
    const optsSelectable = selectable.map(m => {
      const cat = materials.byId[m.id];
      const pill = modelPillLabel(cat.model);
      return `<option value="${m.id}">${cat.name || m.id}${cat.tl_estimated ? ' ≈' : ''}${pill ? ` · ${pill}` : ''}</option>`;
    });
    const optsDeferred = deferred.map(m => {
      // Disabled per Maya §5 — keyboard Tab skips these, screen readers
      // announce "dimmed". The pill is the same "· measured data pending"
      // sublabel Maya specified.
      return `<option value="${m.id}" disabled>${m.name || m.id} · measured data pending</option>`;
    });
    matSel.innerHTML = optsSelectable.join('') + optsDeferred.join('');
    if (!selectable.some(m => m.id === st.matId)) {
      st.matId = selectable[0]?.id;
      syncIsoStateForMaterial(st, materials.byId[st.matId]);
    }
    matSel.value = st.matId;
    // Caption — total deferred count across ALL wall types, ambient info
    // not a banner. Hide entirely when no deferred rows exist (forward-
    // compat: when Lin lands real data the caption auto-disappears).
    const totalDeferred = dropdownRows.filter(m => m.deferred).length;
    if (totalDeferred > 0 && deferredCaption) {
      deferredCaption.textContent = `${totalDeferred} rows pending measured data — picks marked “measured data pending” can't be computed yet.`;
      deferredCaption.hidden = false;
    } else if (deferredCaption) {
      deferredCaption.hidden = true;
    }
  }

  function renderParamRail() {
    const cat = materials.byId[st.matId];
    const params = body.querySelector('#wall-params');
    if (cat.model === 'formula') {
      params.innerHTML = formulaControlsHTML(st);
      wireFormulaControls(params, st, render);
    } else if (cat.model === 'catalogue') {
      params.innerHTML = `<p class="wall-catalogue-note">Measured row — no parametric controls. The curve below is the published 1/3-octave data.</p>`;
    } else {
      // mass-law (default)
      params.innerHTML = massLawControlsHTML(st);
      wireMassLawControls(params, st, render);
    }
  }

  function render() {
    const cat = materials.byId[st.matId];
    const meta = wallMaterialMeta(st.matId);
    const primaryTL = computeWallTL(cat, meta, st);

    // Step 9 (Maya 2026-05-23): composite inset — when active, replace the
    // primary chip + curve + Rw computation with the COMPOSITE (per ISO
    // 12354-3 §17 area-weighted τ-bar). Primary + inset curves still
    // overlay on the plot as muted dashed/dotted lines so the user sees
    // how the inset dragged the answer down.
    let insetTL = null, compositeTL = null, breakdown = null, insetCat = null;
    if (st.inset.enabled) {
      insetCat = materials.byId[st.inset.matId];
      if (insetCat) {
        insetTL = computeInsetTL(insetCat);
        compositeTL = computeCompositeFromInset(primaryTL, insetTL, st.inset.area_percent);
        breakdown = computeCompositeBreakdown(primaryTL, insetTL, st.inset.area_percent);
      }
    }
    const ratingTL = compositeTL || primaryTL;
    const rating = computeRating(ratingTL);
    const compareReason = computeCompareReason(cat, meta, st);
    // When composite active, suppress the v=609 mass-law Δ table — the
    // "answer" is now the composite, not a comparison against measured.
    const showCompare = compareReason === null && !st.inset.enabled;

    renderSummary(body.querySelector('#wall-summary'), rating, cat, meta);

    const plotExtras = (st.inset.enabled && primaryTL && insetTL) ? [
      { tl: primaryTL, label: 'primary', className: 'wp-primary-overlay' },
      { tl: insetTL, label: 'inset', className: 'wp-inset-overlay' },
    ] : null;
    body.querySelector('#wall-plot').innerHTML = plotSVG(ratingTL, rating, meta.coincidence_band_hz, showCompare, cat, { extras: plotExtras });

    if (st.inset.enabled && primaryTL && insetTL && compositeTL) {
      body.querySelector('#wall-table').innerHTML = compositeTableHTML(
        bands, primaryTL.tl_octave, insetTL.tl_octave, compositeTL.tl_octave, insetCat,
      );
    } else {
      body.querySelector('#wall-table').innerHTML = tableHTML(
        bands, primaryTL.tl_octave, cat.transmission_loss_db, showCompare, compareReason,
      );
    }

    if (methodBody) {
      methodBody.innerHTML = isolationMethodHTML(cat, meta, st, ratingTL, rating, {
        compareReason,
        assembly_type: meta.assembly_type,
        breakdown,
        insetCat,
        insetEnabled: st.inset.enabled,
        primaryTL,
        insetTL,
      });
    }
  }

  function renderInsetUI() {
    const container = body.querySelector('#wall-inset-container');
    if (!container) return;
    if (st.inset.enabled) {
      container.innerHTML = insetRowHTML(materials, present, st);
    } else {
      container.innerHTML = insetButtonHTML();
    }
    wireInset(container, st, () => { renderInsetUI(); render(); });
  }

  typeSel.addEventListener('change', () => {
    st.typeId = typeSel.value;
    refreshMaterialOptions();
    syncIsoStateForMaterial(st, materials.byId[st.matId]);
    renderParamRail();
    render();
  });
  matSel.addEventListener('change', () => {
    st.matId = matSel.value;
    syncIsoStateForMaterial(st, materials.byId[st.matId]);
    renderParamRail();
    render();
  });

  typeSel.value = st.typeId;
  refreshMaterialOptions();
  renderParamRail();
  renderInsetUI();
  render();
}

// ---------------------------------------------------------------------------
// Step 9 — Composite-wall inset UI gesture (Maya 2026-05-23 spec).
// ---------------------------------------------------------------------------

function insetButtonHTML() {
  // Maya §1: "+ add inset (door, window, vent…)" — parenthetical does the
  // explaining; no tooltip needed.
  return `<button class="wall-inset-add-btn" id="wall-inset-add" type="button">+ add inset (door, window, vent…)</button>`;
}

function insetRowHTML(materials, present, st) {
  const matOpts = composeInsetMaterialOptions(materials.byId, present, st.inset.matId);
  const primaryPct = 100 - st.inset.area_percent;
  return `
    <div class="wall-inset-row" data-inset-index="0">
      <label class="wall-ctrl">Inset material
        <select id="wall-inset-mat">${matOpts}</select>
      </label>
      <label class="wall-ctrl wall-ctrl-slider">Area fraction
        <input type="range" id="wall-inset-pct" min="0" max="100" step="1" value="${st.inset.area_percent}" aria-describedby="wall-inset-pct-num" />
        <span class="wall-inset-pct-pair">
          <input type="number" id="wall-inset-pct-num" class="wall-inset-pct-input" min="0" max="100" step="1" value="${st.inset.area_percent}" />
          <span class="wall-inset-pct-unit">%</span>
        </span>
      </label>
      <button class="wall-inset-remove" id="wall-inset-remove" type="button" aria-label="Remove inset" title="Remove inset">×</button>
    </div>
    <p class="wall-inset-fraction-summary">primary: ${primaryPct}% · inset: ${st.inset.area_percent}%</p>
  `;
}

function composeInsetMaterialOptions(byId, present, selectedId) {
  // Maya §4: doors/windows/vents grouped at top under a subheading, then
  // everything else alphabetically. <optgroup> gives the visual subheading.
  const INSET_PRIORITY = ['door', 'glazing'];
  const allMats = WALL_MATERIALS.filter(m => present.includes(m));
  const priority = allMats.filter(m => INSET_PRIORITY.includes(m.wallType));
  const rest = allMats.filter(m => !INSET_PRIORITY.includes(m.wallType));
  const nameOf = (m) => byId[m.id]?.name || m.id;
  priority.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  rest.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const opt = (m) => `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${nameOf(m)}</option>`;
  let html = '';
  if (priority.length) {
    html += `<optgroup label="Doors, windows &amp; vents">${priority.map(opt).join('')}</optgroup>`;
  }
  if (rest.length) {
    html += `<optgroup label="All other materials">${rest.map(opt).join('')}</optgroup>`;
  }
  return html;
}

function wireInset(scope, st, rerender) {
  const addBtn = scope.querySelector('#wall-inset-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      st.inset.enabled = true;
      rerender();
    });
    return;
  }
  // Inset row mode.
  const matSel = scope.querySelector('#wall-inset-mat');
  const pctRange = scope.querySelector('#wall-inset-pct');
  const pctNum = scope.querySelector('#wall-inset-pct-num');
  const removeBtn = scope.querySelector('#wall-inset-remove');
  const summary = scope.querySelector('.wall-inset-fraction-summary');

  function syncPct(v) {
    let n = Number(v);
    if (!Number.isFinite(n)) n = 0;
    n = Math.max(0, Math.min(100, Math.round(n)));
    st.inset.area_percent = n;
    if (pctRange.value !== String(n)) pctRange.value = n;
    if (pctNum.value !== String(n)) pctNum.value = n;
    if (summary) summary.textContent = `primary: ${100 - n}% · inset: ${n}%`;
    rerender();
  }
  if (pctRange) pctRange.addEventListener('input', () => syncPct(pctRange.value));
  if (pctNum) pctNum.addEventListener('input', () => syncPct(pctNum.value));
  if (matSel) matSel.addEventListener('change', () => {
    st.inset.matId = matSel.value;
    rerender();
  });
  if (removeBtn) removeBtn.addEventListener('click', () => {
    st.inset.enabled = false;
    rerender();
  });
}

// Compute the inset row's TL using catalogue defaults (no user-tweaked
// sliders for the inset — the inset is the catalogue point, period).
function computeInsetTL(cat) {
  if (!cat) return null;
  if (cat.model === 'formula' && cat.assembly) {
    const tl_third = doubleLeafTL(cat.assembly, ISO_THIRD_OCTAVE_HZ);
    if (!tl_third) return null;
    const tl_octave = [125, 250, 500, 1000, 2000, 4000, 8000].map(f => {
      const idx = ISO_THIRD_OCTAVE_HZ.indexOf(f);
      return idx >= 0 ? tl_third[idx] : 0;
    });
    return { tl_third_oct: tl_third, tl_octave, source_label: 'inset · ' + (cat.name || cat.id) };
  }
  if (cat.model === 'catalogue' && Array.isArray(cat.tl_third_oct)) {
    return {
      tl_third_oct: cat.tl_third_oct.slice(),
      tl_octave: cat.transmission_loss_db.slice(),
      source_label: 'inset · ' + (cat.name || cat.id),
    };
  }
  // mass-law default — at the catalogue's reference thickness if known.
  const meta = wallMaterialMeta(cat.id);
  const ref_t = meta?.reference_thickness_m || 0.013;
  const tl_octave = massLawTLBandsAtThickness(
    cat.surface_density_kg_m2, ref_t, ref_t, [125, 250, 500, 1000, 2000, 4000, 8000],
  );
  const tl_third = octaveToThirdOctave(tl_octave);
  return { tl_third_oct: tl_third, tl_octave, source_label: 'inset · ' + (cat.name || cat.id) };
}

// Apply ISO 12354-3 §17 area-weighted τ-bar to the primary + inset.
// At fractions of 0% or 100% the function short-circuits to the
// non-degenerate side — avoids the log10(0) and rounding fuzz at the limits.
function computeCompositeFromInset(primaryTL, insetTL, area_percent) {
  if (!primaryTL || !insetTL) return null;
  const fraction = Math.max(0, Math.min(100, area_percent)) / 100;
  if (fraction <= 1e-6) return { ...primaryTL, source_label: 'composite (inset → 0%)' };
  if (fraction >= 1 - 1e-6) return { ...insetTL, source_label: 'composite (inset → 100%)' };
  const tl_third = compositeTLFn({
    elements: [
      { tl_bands: primaryTL.tl_third_oct, area_m2: 1 - fraction },
      { tl_bands: insetTL.tl_third_oct, area_m2: fraction },
    ],
  });
  const tl_octave = compositeTLFn({
    elements: [
      { tl_bands: primaryTL.tl_octave, area_m2: 1 - fraction },
      { tl_bands: insetTL.tl_octave, area_m2: fraction },
    ],
  });
  if (!tl_third || !tl_octave) return null;
  return {
    tl_third_oct: tl_third,
    tl_octave,
    source_label: 'composite (ISO 12354-3)',
  };
}

// "What's killing my Rw?" — share of the τ·S transmission budget per
// element, averaged across the Rw evaluation bands (100-3150 Hz). The
// "leaky-door-dominates" diagnostic.
function computeCompositeBreakdown(primaryTL, insetTL, area_percent) {
  if (!primaryTL || !insetTL) return null;
  const fraction = Math.max(0, Math.min(100, area_percent)) / 100;
  if (fraction <= 1e-6) return { primary_pct: 100, inset_pct: 0 };
  if (fraction >= 1 - 1e-6) return { primary_pct: 0, inset_pct: 100 };
  const rwIdxs = ISO_RW_BANDS_HZ.map(f => ISO_THIRD_OCTAVE_HZ.indexOf(f)).filter(i => i >= 0);
  let primary_taus = 0, inset_taus = 0;
  for (const i of rwIdxs) {
    primary_taus += Math.pow(10, -primaryTL.tl_third_oct[i] / 10) * (1 - fraction);
    inset_taus += Math.pow(10, -insetTL.tl_third_oct[i] / 10) * fraction;
  }
  const total = primary_taus + inset_taus;
  if (!(total > 0)) return null;
  return {
    primary_pct: Math.round(100 * primary_taus / total),
    inset_pct: Math.round(100 * inset_taus / total),
  };
}

// Per-band table when composite is active. Three rows: primary (muted),
// inset (muted), composite (accent). Maya §5 — engineers want both the
// inputs AND the answer in the same table.
function compositeTableHTML(bands, primaryOct, insetOct, compositeOct, insetCat) {
  const fmt = (f) => f >= 1000 ? `${f / 1000}k` : `${f}`;
  const head = `<tr><th>Hz</th>${bands.map(f => `<th>${fmt(f)}</th>`).join('')}</tr>`;
  const primaryRow = `<tr class="wall-tl-overlay"><th>Primary</th>${primaryOct.map(v => `<td>${Math.round(v)}</td>`).join('')}</tr>`;
  const insetName = escapeHtml(insetCat.name || insetCat.id);
  const insetRow = `<tr class="wall-tl-overlay"><th>Inset (${insetName})</th>${insetOct.map(v => `<td>${Math.round(v)}</td>`).join('')}</tr>`;
  const compositeRow = `<tr class="wall-tl-net"><th>Composite</th>${compositeOct.map(v => `<td>${Math.round(v)}</td>`).join('')}</tr>`;
  return `<thead>${head}</thead><tbody>${primaryRow}${insetRow}${compositeRow}</tbody>`;
}

// ---------------------------------------------------------------------------
// State helpers — keep `iso` in sync with the currently-selected material.
// ---------------------------------------------------------------------------
function syncIsoStateForMaterial(st, cat) {
  if (!cat) return;
  const meta = wallMaterialMeta(st.matId);
  st.modified = false;
  if (cat.model === 'formula' && cat.assembly) {
    st.leaf1_mass_kg_m2 = cat.assembly.leaf1_mass_kg_m2;
    st.leaf2_mass_kg_m2 = cat.assembly.leaf2_mass_kg_m2;
    st.cavity_depth_m = cat.assembly.cavity_depth_m;
    st.cavity_fill = cat.assembly.cavity_fill;
    st.stud_type = cat.assembly.stud_type;
  } else if (meta?.thickness_mm) {
    st.thickness_mm = meta.thickness_mm.default;
  }
}

function modelPillLabel(model) {
  if (model === 'formula') return 'double-leaf';
  if (model === 'catalogue') return 'measured';
  return null;     // mass-law is the default — no pill needed
}

// ---------------------------------------------------------------------------
// Control-rail HTML + wiring — one variant per model.
// ---------------------------------------------------------------------------
function massLawControlsHTML(st) {
  const meta = wallMaterialMeta(st.matId);
  const min = meta?.thickness_mm?.min ?? 50;
  const max = meta?.thickness_mm?.max ?? 400;
  return `
    <label class="wall-ctrl wall-ctrl-slider">Thickness (mm)
      <input type="range" id="wall-thick" min="${min}" max="${max}" step="1" value="${st.thickness_mm}" aria-describedby="wall-thick-val" />
      <output id="wall-thick-val" class="wall-thick-val">${st.thickness_mm}&nbsp;mm</output>
    </label>
  `;
}

function wireMassLawControls(scope, st, render) {
  const thickInput = scope.querySelector('#wall-thick');
  const thickVal = scope.querySelector('#wall-thick-val');
  if (!thickInput) return;
  thickInput.addEventListener('input', () => {
    st.thickness_mm = Number(thickInput.value);
    st.modified = true;
    thickVal.textContent = `${st.thickness_mm} mm`;
    render();
  });
}

function formulaControlsHTML(st) {
  // Construction group: two leaf masses, cavity depth, fill segment.
  // Stud system group: 4-button segment (rc1 is catalogue-only, omitted).
  const m1 = st.leaf1_mass_kg_m2, m2 = st.leaf2_mass_kg_m2;
  const d_mm = Math.round(st.cavity_depth_m * 1000);
  const fillOpts = [
    ['none',         'Air (no fill)'],
    ['fibrous_50mm', '≥ 50 mm fibre'],
    ['reflective',   'Reflective'],
  ];
  const studOpts = [
    ['wood',      'Rigid (wood)'],
    ['steel',     'Resilient (steel)'],
    ['staggered', 'Staggered'],
    ['double',    'Double stud'],
  ];
  return `
    <div class="wall-param-group" data-group="construction">
      <span class="wall-param-group-label">Construction</span>
      <div class="wall-param-grid">
        <label class="wall-ctrl wall-ctrl-slider">Leaf 1 mass
          <input type="range" id="wall-m1" min="3" max="80" step="0.5" value="${m1}" />
          <output id="wall-m1-val" class="wall-thick-val">${m1.toFixed(1)}&nbsp;kg/m²</output>
        </label>
        <label class="wall-ctrl wall-ctrl-slider">Cavity depth
          <input type="range" id="wall-d" min="25" max="500" step="1" value="${d_mm}" />
          <output id="wall-d-val" class="wall-thick-val">${d_mm}&nbsp;mm</output>
        </label>
        <label class="wall-ctrl wall-ctrl-slider">Leaf 2 mass
          <input type="range" id="wall-m2" min="3" max="80" step="0.5" value="${m2}" />
          <output id="wall-m2-val" class="wall-thick-val">${m2.toFixed(1)}&nbsp;kg/m²</output>
        </label>
        <div class="wall-ctrl">Cavity fill
          <div class="wall-mode-seg wall-mode-seg-tight" role="tablist" aria-label="Cavity fill">
            ${fillOpts.map(([v, label]) => `<button class="wall-seg-btn ${st.cavity_fill === v ? 'is-active' : ''}" role="tab" aria-selected="${st.cavity_fill === v ? 'true' : 'false'}" data-fill="${v}" type="button">${label}</button>`).join('')}
          </div>
        </div>
      </div>
    </div>
    <div class="wall-param-group" data-group="stud-system">
      <span class="wall-param-group-label">Stud system</span>
      <div class="wall-mode-seg" role="tablist" aria-label="Stud system">
        ${studOpts.map(([v, label]) => `<button class="wall-seg-btn ${st.stud_type === v ? 'is-active' : ''}" role="tab" aria-selected="${st.stud_type === v ? 'true' : 'false'}" data-stud="${v}" type="button">${label}</button>`).join('')}
      </div>
    </div>
  `;
}

function wireFormulaControls(scope, st, render) {
  const bind = (sel, key, fmt) => {
    const input = scope.querySelector(sel);
    const out = scope.querySelector(sel + '-val');
    if (!input) return;
    input.addEventListener('input', () => {
      st[key] = Number(input.value);
      if (key === 'cavity_depth_m') {
        // slider is mm, state is m — convert here
        st[key] = Number(input.value) / 1000;
      }
      st.modified = true;
      out.textContent = fmt(input.value);
      render();
    });
  };
  bind('#wall-m1', 'leaf1_mass_kg_m2', v => `${Number(v).toFixed(1)} kg/m²`);
  bind('#wall-m2', 'leaf2_mass_kg_m2', v => `${Number(v).toFixed(1)} kg/m²`);
  bind('#wall-d', 'cavity_depth_m', v => `${v} mm`);
  scope.querySelectorAll('[data-fill]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.fill === st.cavity_fill) return;
      st.cavity_fill = btn.dataset.fill;
      st.modified = true;
      scope.querySelectorAll('[data-fill]').forEach(b => {
        const on = b.dataset.fill === st.cavity_fill;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      render();
    });
  });
  scope.querySelectorAll('[data-stud]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.stud === st.stud_type) return;
      st.stud_type = btn.dataset.stud;
      st.modified = true;
      scope.querySelectorAll('[data-stud]').forEach(b => {
        const on = b.dataset.stud === st.stud_type;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      render();
    });
  });
}

// ---------------------------------------------------------------------------
// TL + rating computation — branches on model.
// ---------------------------------------------------------------------------
function computeWallTL(cat, meta, st) {
  if (cat.model === 'formula') {
    // Sharp three-region in 1/3-oct.
    const tl_third = doubleLeafTL({
      leaf1_mass_kg_m2: st.leaf1_mass_kg_m2,
      leaf2_mass_kg_m2: st.leaf2_mass_kg_m2,
      cavity_depth_m: st.cavity_depth_m,
      cavity_fill: st.cavity_fill,
      stud_type: st.stud_type,
    }, ISO_THIRD_OCTAVE_HZ);
    // Downsample to 7-band octave for the legacy comparison table.
    const tl_octave = tl_third ? [125, 250, 500, 1000, 2000, 4000, 8000].map(f => {
      const idx = ISO_THIRD_OCTAVE_HZ.indexOf(f);
      return idx >= 0 ? tl_third[idx] : 0;
    }) : [];
    return { tl_third_oct: tl_third, tl_octave, bands_used: ISO_THIRD_OCTAVE_HZ, source_label: 'Sharp 1973' };
  }
  if (cat.model === 'catalogue' && Array.isArray(cat.tl_third_oct)) {
    const tl_third = cat.tl_third_oct.slice();
    const tl_octave = cat.transmission_loss_db.slice();
    return { tl_third_oct: tl_third, tl_octave, bands_used: ISO_THIRD_OCTAVE_HZ, source_label: 'measured' };
  }
  // mass-law default — 7-band octave from mass law at slider thickness,
  // log-linear interpolated to 1/3-oct so the rating engine has 18 bands.
  const thickness_m = st.thickness_mm / 1000;
  const tl_octave = massLawTLBandsAtThickness(
    cat.surface_density_kg_m2, meta.reference_thickness_m, thickness_m,
    [125, 250, 500, 1000, 2000, 4000, 8000],
  );
  const tl_third = octaveToThirdOctave(tl_octave);
  return { tl_third_oct: tl_third, tl_octave, bands_used: ISO_THIRD_OCTAVE_HZ, source_label: 'mass law' };
}

function computeRating(tl) {
  if (!tl || !Array.isArray(tl.tl_third_oct) || tl.tl_third_oct.length === 0) {
    return { computable: false, reason: 'no 1/3-octave data' };
  }
  const Rw = computeRw(tl.tl_third_oct, ISO_THIRD_OCTAVE_HZ);
  if (Rw === null) return { computable: false, reason: 'contour fit failed' };
  const STC = computeSTC(tl.tl_third_oct, ISO_THIRD_OCTAVE_HZ);
  const C = computeC(tl.tl_third_oct, ISO_THIRD_OCTAVE_HZ);
  const Ctr = computeCtr(tl.tl_third_oct, ISO_THIRD_OCTAVE_HZ);
  // Recover the shift so the plot can draw the shifted reference contour.
  const shift = Rw - 52;     // RW_500HZ_VALUE = 52
  return { computable: true, Rw, STC, C, Ctr, shift };
}

function computeCompareReason(cat, meta, st) {
  if (cat.model === 'catalogue') return 'mode';
  if (cat.model === 'formula') return st.modified ? 'modified' : null;
  // mass-law: legacy v=609 gate (single-leaf + at-reference + not estimated).
  const atRef = meta.reference_thickness_m == null
    ? true
    : Math.abs(st.thickness_mm - Math.round(meta.reference_thickness_m * 1000)) <= 0.5;
  const singleLeaf = isSingleLeafAssembly(st.matId);
  const estimated = cat.tl_estimated === true;
  if (!singleLeaf) return 'assembly';
  if (estimated) return 'estimated';
  if (!atRef) return 'thickness';
  return null;
}

// ---------------------------------------------------------------------------
// Summary chip — Rw (C; Ctr) per ISO 717-1 §5 reporting format. Maya §3.
// ---------------------------------------------------------------------------
function renderSummary(scope, rating, cat, meta) {
  if (!rating.computable) {
    scope.innerHTML = `
      <div class="wall-rw-chip wall-rw-chip-unavailable">
        <span class="wall-rw-chip-label">Rw (C; Ctr)</span>
        <span class="wall-rw-chip-value">— not available</span>
        <span class="wall-rw-chip-cap">${escapeHtml(rating.reason || '')}</span>
      </div>
    `;
    return;
  }
  const fmt = (v) => (v < 0 ? v : `+${v}`);   // C and Ctr are typically ≤ 0; sign always shown
  // Phase 6 Step 4 (Dr. Chen 2026-05-23): field-derated DnT,w line per
  // Hopkins 2007 Table 6.3. Construction family derived from existing
  // schema fields — no schema 1.6 needed.
  const derating = computeFieldDerating(cat, meta);
  const fieldLine = derating
    ? `<span class="wall-rw-chip-field">DnT,w ≈ ${rating.Rw - derating.N}&nbsp;dB field<span class="wall-rw-chip-field-cite"> (Hopkins 2007, ${derating.familyLabel})</span></span>`
    : '';
  scope.innerHTML = `
    <div class="wall-rw-chip">
      <span class="wall-rw-chip-label">Rw (C; Ctr)</span>
      <span class="wall-rw-chip-value">${rating.Rw}&nbsp;<span class="wall-rw-chip-paren">(${fmt(rating.C)};&nbsp;${fmt(rating.Ctr)})</span></span>
      ${fieldLine}
      <span class="wall-rw-chip-cap">single-number rating · ISO 717-1</span>
    </div>
  `;
}

// Phase 6 Step 4 (Dr. Chen 2026-05-23): map a catalogue row to its construction
// family + Hopkins 2007 Table 6.3 derating constant N. Lab Rw → field DnT,w
// approximation is Rw − N where N depends only on construction family
// (not per-band fit, not measured-row-dependent — single calibration).
//
// Hopkins 2007 Table 6.3 + §6.4.2 (signed Dr. Chen 2026-05-23):
//   masonry           N = 3 dB    (concrete, CMU, brick — tight flanking band)
//   lightweight_stud  N = 5 dB    (gypsum on wood/steel studs — wide field scatter)
//   decoupled         N = 6 dB    (staggered / double / RC-1 — higher Rw → larger
//                                  absolute flanking deficit; range 5-7 in Hopkins)
//   glazing           N = 4 dB    (IGUs + single panes — perimeter seal dominates)
//   door              N = 3 dB    (own family — lab Rw already includes some
//                                  perimeter losses)
const HOPKINS_DERATING_N = Object.freeze({
  masonry:          { N: 3, familyLabel: 'masonry' },
  lightweight_stud: { N: 5, familyLabel: 'lightweight stud' },
  decoupled:        { N: 6, familyLabel: 'decoupled' },
  glazing:          { N: 4, familyLabel: 'glazing' },
  door:             { N: 3, familyLabel: 'door' },
});

function computeFieldDerating(cat, meta) {
  if (!cat || !meta) return null;
  // Map UI-layer wallType + physics model to a Hopkins family. Dr. Chen
  // confirmed:
  //   - mass-law + double_leaf (gypsum-board v=609) → lightweight_stud
  //     (no decoupling physics in mass-law; flanking behaves as bridged).
  //   - laminated vs symmetric IGU → both glazing midpoint 4 (Rw already
  //     encodes leaf asymmetry; N is about perimeter seal).
  //   - doors → own family door, NOT composite.
  let family;
  if (meta.wallType === 'masonry') family = 'masonry';
  else if (meta.wallType === 'glazing') family = 'glazing';
  else if (meta.wallType === 'door') family = 'door';
  else if (cat.model === 'formula' && cat.assembly) {
    const stud = cat.assembly.stud_type;
    family = (stud === 'staggered' || stud === 'double') ? 'decoupled' : 'lightweight_stud';
  } else {
    // mass-law partition or catalogue-only partition — treat as
    // lightweight_stud per Dr. Chen (the v=609 gypsum-board ruling).
    family = 'lightweight_stud';
  }
  return HOPKINS_DERATING_N[family] ? { family, ...HOPKINS_DERATING_N[family] } : null;
}

// --- Mode 2: over-wall diffraction (cross-section + Maekawa IL) -------------
// PSC v=610 (2026-05-23): wires `groundReflectedDiffraction`-equivalent (image
// source through ground plane) + `airAbsorptionDbPerM` into the demo. Per
// Maya's UX call:
//   • three rays — direct sightline, over-top diffracted, ground-reflected
//     over-top. Ground-reflected drawn from a stroke-only image-source marker
//     on the ground line (no below-ground drawing); hidden entirely on soft
//     ground.
//   • per-band table extends to three rows (Maekawa / Air abs / Net IL).
//   • summary block switches from "IL @ 1 kHz" to broadband mean (250 Hz –
//     4 kHz) so toggling Mode 1 ↔ Mode 2 doesn't covertly redefine the
//     headline number.
//   • ground-type segmented control (Hard / Soft) below the geometry sliders
//     as a discrete two-state choice.
//   • source/listener label-anchor bug fixed in the same touch — labels now
//     sit OUTSIDE the scene (source label LEFT of source circle, listener
//     label RIGHT of receiver circle) and carry their heights for symmetry.
function renderDiffraction(body, methodBody, bands, st) {
  body.innerHTML = `
    <div class="wall-sim-controls">
      <label class="wall-ctrl wall-ctrl-slider">Source height (m)
        <input type="range" id="d-src" min="1" max="10" step="0.1" value="${st.sourceH}" />
        <output id="d-src-val" class="wall-thick-val">${st.sourceH.toFixed(1)} m</output>
      </label>
      <label class="wall-ctrl wall-ctrl-slider">Wall height (m)
        <input type="range" id="d-wall" min="2" max="8" step="0.1" value="${st.wallH}" />
        <output id="d-wall-val" class="wall-thick-val">${st.wallH.toFixed(1)} m</output>
      </label>
      <label class="wall-ctrl wall-ctrl-slider">Receiver behind wall (m)
        <input type="range" id="d-recv" min="1" max="20" step="0.5" value="${st.recvDist}" />
        <output id="d-recv-val" class="wall-thick-val">${st.recvDist.toFixed(1)} m</output>
      </label>
    </div>
    <div class="wall-ground-row">
      <span class="wall-ground-label">Ground</span>
      <div class="wall-mode-seg" role="tablist" aria-label="Ground type">
        <button class="wall-seg-btn ${st.groundType === 'hard' ? 'is-active' : ''}" role="tab"
          aria-selected="${st.groundType === 'hard' ? 'true' : 'false'}" data-ground="hard" type="button">Hard (concrete)</button>
        <button class="wall-seg-btn ${st.groundType === 'soft' ? 'is-active' : ''}" role="tab"
          aria-selected="${st.groundType === 'soft' ? 'true' : 'false'}" data-ground="soft" type="button">Soft (grass)</button>
      </div>
    </div>
    <div class="wall-sim-results">
      <div class="wall-summary">
        <span class="wall-summary-num" id="d-il-num">—</span>
        <span class="wall-summary-unit">dB</span>
        <span class="wall-summary-cap">net insertion loss<br>250&nbsp;Hz – 4&nbsp;kHz</span>
      </div>
      <div class="wall-plot" id="d-section" role="img" aria-label="Over-wall cross section"></div>
    </div>
    <div class="wall-diff-status" id="d-status"></div>
    <div class="wall-table-wrap"><table class="wall-tl-table" id="d-table"></table></div>
    <p class="wall-method-hint">Open <strong>Standards &amp; method</strong> (right) for the Maekawa equation and the cited standard.</p>
  `;
  const srcI = body.querySelector('#d-src');
  const wallI = body.querySelector('#d-wall');
  const recvI = body.querySelector('#d-recv');

  function render() {
    const d1 = DEMO_SRC_TO_WALL_M;
    const d2 = st.recvDist;
    const sH = st.sourceH, wH = st.wallH, rH = DEMO_RECEIVER_H_M;
    // DEMO ground-plane assumption — flat at z = 0. All heights (sourceH,
    // wallH, receiverH) are in metres ABOVE this plane. The image-source
    // mirror below uses `-sH` because that's the reflection through z = 0;
    // for terrain elevation or non-flat ground, route through the engine's
    // `groundReflectedDiffraction(... groundPlaneZ ...)` in diffraction.js
    // instead of mirroring inline. (Martina audit 2026-05-23.)
    const GROUND_Z_M = 0;
    const groundIsHard = st.groundType !== 'soft';
    const G = groundIsHard ? 0 : 1;          // ISO 9613-2 §7.3.1 single-value G

    // Direct over-top path — signed δ from overBarrierPathDifference.
    const geom = { sourceH: sH, barrierH: wH, sourceToBarrier: d1, barrierToReceiver: d2, receiverH: rH };
    const delta = overBarrierPathDifference(geom);
    const shadowed = delta > 0;
    const detour_overtop = Math.hypot(d1, wH - sH) + Math.hypot(d2, rH - wH);
    // Direct sightline length — used to express the air-abs ROW as EXTRA
    // absorption attributable to the wall (going over the top), rather
    // than the absolute absorption on the over-top path. Without this
    // subtraction, the air-abs row reads as if the wall added 1 dB at
    // 8 kHz even when the wall is fully lit and not actually attenuating
    // anything — the over-top path is just 0.76 m longer than the direct
    // sightline at large recv distances. Subtracting `direct_sightline_m`
    // makes the row honestly "extra over the top" and pushes Net IL
    // toward 0 at the lit-zone limit. (Martina audit MEDIUM #2.)
    const direct_sightline_m = Math.hypot(d1 + d2, rH - sH);

    // Ground-reflected over-top path — mirror the source through GROUND_Z_M.
    // The image source sits at z=−sH; same wall-top diffraction geometry;
    // δ is always ≥ 0 for any positive sH (the image-source-to-receiver
    // sightline goes from below ground up and is always blocked by a wall
    // on the ground). Standard image-source / Maekawa decomposition;
    // mirrors `groundReflectedDiffraction` in diffraction.js but adapted
    // to the demo's scalar 2D geometry with GROUND_Z_M = 0.
    const geomGround = { sourceH: -sH, barrierH: wH, sourceToBarrier: d1, barrierToReceiver: d2, receiverH: rH };
    const deltaGround = overBarrierPathDifference(geomGround);
    const detour_overtop_ground = Math.hypot(d1, wH + sH) + Math.hypot(d2, rH - wH);

    // Per-band physics. `air_abs[i]` is the EXTRA air absorption on the
    // over-top detour vs the direct sightline, signed negative for fast
    // visual parsing of the contribution (Maya §2, Martina MEDIUM #2).
    // The ground-reflected path's air-abs uses its full detour — its
    // reference is "no arrival at all without the wall" (a no-wall
    // scenario has no ground-bounce-over-top arrival), so the full
    // detour IS the path the energy travelled. Net IL is the energy-sum
    // of the two diffracted-path powers vs the no-wall direct reference,
    // weighted by (1 − G) for the ground path.
    const maekawa = bands.map(f => maekawaIL(delta, SPEED_OF_SOUND / f));
    const maekawa_ground = bands.map(f => maekawaIL(deltaGround, SPEED_OF_SOUND / f));
    const air_abs = bands.map(f => -airAbsorptionDbPerM(f) * (detour_overtop - direct_sightline_m));
    const air_abs_ground = bands.map(f => -airAbsorptionDbPerM(f) * detour_overtop_ground);
    const net_il = bands.map((_, i) => {
      // Total positive dB loss per path = Maekawa_IL − air_abs (air_abs ≤ 0).
      const loss_direct = maekawa[i] - air_abs[i];
      const loss_ground = maekawa_ground[i] - air_abs_ground[i];
      const p_direct = Math.pow(10, -loss_direct / 10);
      const p_ground = (1 - G) * Math.pow(10, -loss_ground / 10);
      const p_total = p_direct + p_ground;
      return p_total > 0 ? -10 * Math.log10(p_total) : 60;     // floor at 60 dB
    });

    // Broadband mean over 250 Hz – 4 kHz (Mode 1 parity per Maya §4).
    // bands = [125, 250, 500, 1k, 2k, 4k, 8k] → indices [1..5].
    const broadbandIdx = [1, 2, 3, 4, 5];
    const broadband = broadbandIdx.reduce((a, i) => a + net_il[i], 0) / broadbandIdx.length;
    body.querySelector('#d-il-num').textContent = Math.round(broadband);

    body.querySelector('#d-section').innerHTML = crossSectionSVG(sH, wH, d1, d2, rH, shadowed, groundIsHard);
    const deltaTxt = shadowed ? `+${delta.toFixed(2)} m` : `${delta.toFixed(2)} m`;
    const detourTxt = `detour ${detour_overtop.toFixed(1)} m`;
    const groundLine = groundIsHard
      ? ` Hard ground adds a second diffracted path (image source below the ground line).`
      : ` Soft ground absorbs the reflected path — only the over-the-top arrival reaches the receiver.`;
    body.querySelector('#d-status').innerHTML = shadowed
      ? `<span class="wall-status-shadow">● Receiver in shadow</span> — the wall blocks the direct sightline (δ = ${deltaTxt} · ${detourTxt}). Sound bends over the top with real loss.${groundLine}`
      : `<span class="wall-status-lit">● Receiver lit</span> — the source clears the wall top (δ = ${deltaTxt} · ${detourTxt}). The wall barely attenuates it — this is why high-mounted horns "leak over".${groundLine}`;

    body.querySelector('#d-table').innerHTML = diffractionTableHTML(bands, maekawa, air_abs, net_il);

    if (methodBody) methodBody.innerHTML = diffractionMethodHTML(delta, shadowed, groundIsHard);
  }

  srcI.addEventListener('input', () => { st.sourceH = Number(srcI.value); body.querySelector('#d-src-val').textContent = `${st.sourceH.toFixed(1)} m`; render(); });
  wallI.addEventListener('input', () => { st.wallH = Number(wallI.value); body.querySelector('#d-wall-val').textContent = `${st.wallH.toFixed(1)} m`; render(); });
  recvI.addEventListener('input', () => { st.recvDist = Number(recvI.value); body.querySelector('#d-recv-val').textContent = `${st.recvDist.toFixed(1)} m`; render(); });
  body.querySelectorAll('.wall-mode-seg [data-ground]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.ground === st.groundType) return;
      st.groundType = btn.dataset.ground;
      body.querySelectorAll('.wall-mode-seg [data-ground]').forEach(b => {
        const on = b.dataset.ground === st.groundType;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      render();
    });
  });
  render();
}

// Per-band diffraction table — three rows (Maya §2): Maekawa IL of the
// over-top path, air-abs penalty on the same detour (signed negative for
// fast visual parsing of the contribution), and the bolded Net IL row
// that feeds the summary block.
function diffractionTableHTML(bands, maekawa, air_abs, net_il) {
  const fmt = (f) => f >= 1000 ? `${f / 1000}k` : `${f}`;
  const head = `<tr><th>Hz</th>${bands.map(f => `<th>${fmt(f)}</th>`).join('')}</tr>`;
  const maekawaRow = `<tr><th>Maekawa</th>${maekawa.map(v => `<td>${Math.round(v)}</td>`).join('')}</tr>`;
  // Air-abs is rendered as signed dB; the `v >= -0.5` threshold collapses
  // sub-half-dB cells to "0" rather than "-0.1" / "-0.3" for visual calm.
  // The threshold is ASYMMETRIC (a positive 0.49 would also render as "0"
  // if it ever appeared, but air_abs is always ≤ 0 by construction so
  // this branch is unreachable in practice). Do not switch to symmetric
  // `Math.abs(v) < 0.5` — losing the signed-half-dB rendering surrenders
  // the "is this a real penalty or just rounding noise" signal at low
  // recv distances. (Martina audit MEDIUM #12.)
  const airRow = `<tr class="wall-tl-airabs"><th>Air abs</th>${air_abs.map(v => `<td>${v >= -0.5 ? '0' : v.toFixed(1)}</td>`).join('')}</tr>`;
  const netRow = `<tr class="wall-tl-net"><th>Net IL</th>${net_il.map(v => `<td>${Math.round(v)}</td>`).join('')}</tr>`;
  return `<thead>${head}</thead><tbody>${maekawaRow}${airRow}${netRow}</tbody>`;
}

// --- SVG: TL plot ----------------------------------------------------------
// Step 8b (Maya 2026-05-23): the plot now branches on whether 1/3-oct data
// is available and whether Rw is computable.
//
//   mass-law row + Rw computable: 18-band 1/3-oct (formula's resolution),
//                                 computed curve + (optionally) measured
//                                 7-band overlay + ISO 717-1 reference
//                                 contour overlay with diagonal hatching
//                                 over unfavourable-deviation bands +
//                                 Σ unfav / shift annotation top-right.
//   formula row:                  18-band 1/3-oct, same overlays.
//   catalogue row:                18-band 1/3-oct from row.tl_third_oct,
//                                 no formula curve, measured-only.
//
// Per Maya §4: "Hiding the contour is hiding the method." No toggle.
function plotSVG(tl, rating, coincidenceHz, showCompare, cat, opts = {}) {
  // v=626 (user-reported 2026-05-23): legend moved OUT of the data area to
  // a horizontal strip below the x-axis labels. Earlier in-plot legend
  // (with or without an opaque background) crashed visually with the
  // high-frequency end of the data curves (50-60 dB). Adding 25 px to the
  // SVG height for the legend strip — data area Y positions are unchanged
  // (mB grew, plotH stayed).
  const W = 460, H = 245, mL = 38, mR = 12, mT = 14, mB = 55;
  const plotW = W - mL - mR, plotH = H - mT - mB;
  const yMin = 0, yMax = 70;
  // Y position constants: x-ticks just below data area; legend strip at the
  // bottom of the SVG. Kept as named constants so the layout intent is
  // explicit instead of magic offsets.
  const X_TICK_Y = mT + plotH + 20;     // below the data bottom edge
  const LEGEND_STRIP_Y = H - 14;        // bottom strip baseline

  const isThirdOct = Array.isArray(tl.tl_third_oct) && tl.tl_third_oct.length === ISO_THIRD_OCTAVE_HZ.length;
  const bands = isThirdOct ? ISO_THIRD_OCTAVE_HZ : [125, 250, 500, 1000, 2000, 4000, 8000];
  const computed = isThirdOct ? tl.tl_third_oct : tl.tl_octave;
  const measuredOctave = cat.transmission_loss_db;

  const x = (i) => mL + (i / (bands.length - 1)) * plotW;
  const y = (db) => mT + plotH - ((db - yMin) / (yMax - yMin)) * plotH;

  // Y grid + ticks
  let grid = '';
  for (let db = yMin; db <= yMax; db += 10) {
    grid += `<line x1="${mL}" y1="${y(db)}" x2="${W - mR}" y2="${y(db)}" class="wp-grid"/><text x="${mL - 6}" y="${y(db) + 3}" class="wp-ytick">${db}</text>`;
  }
  // X ticks — show octave centres only (skip the in-between 1/3-oct labels).
  const octaveSet = new Set([125, 250, 500, 1000, 2000, 4000, 8000]);
  const fmt = (f) => f >= 1000 ? `${f / 1000}k` : `${f}`;
  let xlabs = '';
  bands.forEach((f, i) => {
    if (octaveSet.has(f)) {
      xlabs += `<text x="${x(i)}" y="${X_TICK_Y}" class="wp-xtick">${fmt(f)}</text>`;
    }
  });

  const path = (arr) => arr.map((db, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(db).toFixed(1)}`).join(' ');

  // --- Reference contour + hatching (Maya §4) -------------------------------
  let contourLayer = '';
  let hatchLayer = '';
  let sumUnfavLabel = '';
  if (rating.computable && Array.isArray(computed)) {
    // Build shifted-contour values at the displayed band positions; null
    // outside the Rw evaluation range (100–3150 Hz).
    const shifted = bands.map(f => {
      const rwIdx = ISO_RW_BANDS_HZ.indexOf(f);
      return rwIdx >= 0 ? ISO_717_1_RW_CONTOUR_DB[rwIdx] + rating.shift : null;
    });
    // Dotted contour line, broken across the band gaps.
    let cp = '';
    let started = false;
    shifted.forEach((v, i) => {
      if (v === null) { started = false; return; }
      cp += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      started = true;
    });
    contourLayer = `<path d="${cp.trim()}" class="wp-contour"/>`;
    // Hatching across unfavourable-deviation bands (computed < contour).
    let rects = '';
    let sumUnfav = 0;
    const bandWidth = (plotW / (bands.length - 1)) * 0.6;
    shifted.forEach((cv, i) => {
      if (cv === null) return;
      const dv = computed[i];
      if (dv < cv) {
        sumUnfav += (cv - dv);
        rects += `<rect x="${(x(i) - bandWidth / 2).toFixed(1)}" y="${y(cv).toFixed(1)}" width="${bandWidth.toFixed(1)}" height="${(y(dv) - y(cv)).toFixed(1)}" fill="url(#wp-hatch-pattern)" />`;
      }
    });
    hatchLayer = rects;
    // Top-LEFT corner of the plot area — keep clear of the right-anchored
    // legend cluster (computed / measured / ISO 717-1 contour / extras).
    // The two used to share the top-right and the labels stacked on top
    // of each other (v=623 layout bug, user-reported 2026-05-23).
    sumUnfavLabel = `<text x="${mL + 4}" y="${mT + 12}" class="wp-sum-unfav" text-anchor="start">Σ unfav = ${sumUnfav.toFixed(1)} dB · shift ${rating.shift >= 0 ? '+' : ''}${rating.shift} dB</text>`;
  }

  // --- Measured curve (legacy octave-band overlay) --------------------------
  let measuredLayer = '';
  if (showCompare && Array.isArray(measuredOctave)) {
    const octaveBands = [125, 250, 500, 1000, 2000, 4000, 8000];
    const pts = [];
    measuredOctave.forEach((v, oi) => {
      const idx = bands.indexOf(octaveBands[oi]);
      if (idx >= 0) pts.push({ x: x(idx), y: y(v) });
    });
    const mp = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    measuredLayer = `<path d="${mp}" class="wp-measured"/>` +
      pts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" class="wp-measured-pt"/>`).join('');
  }

  // --- Coincidence-dip annotation (existing, optional) ---------------------
  let dip = '';
  if (coincidenceHz != null && showCompare) {
    const di = bands.indexOf(coincidenceHz);
    if (di >= 0) {
      const dx = x(di), dyTop = mT + 2;
      const yAnchor = isThirdOct ? y(computed[di] ?? 30) : y(measuredOctave[di] ?? 30);
      dip = `<line x1="${dx}" y1="${dyTop}" x2="${dx}" y2="${yAnchor}" class="wp-dip-leader"/><text x="${dx}" y="${dyTop + 9}" class="wp-dip-label" text-anchor="${di > bands.length / 2 ? 'end' : 'start'}">coincidence dip</text>`;
    }
  }

  // --- Step 9 extras (Maya 2026-05-23): composite overlay curves ----------
  // When inset is active, draw the primary + inset curves under the composite
  // as dashed/dotted muted overlays. Maya §5: "The visual story 'the inset
  // pulled the composite down toward the inset curve' is the whole
  // intuition — show it."
  let extrasLayer = '';
  if (Array.isArray(opts.extras) && isThirdOct) {
    for (const ex of opts.extras) {
      const exComp = Array.isArray(ex.tl?.tl_third_oct) ? ex.tl.tl_third_oct : null;
      if (!exComp || exComp.length !== bands.length) continue;
      extrasLayer += `<path d="${path(exComp)}" class="${escapeHtml(ex.className || 'wp-extra')}"/>`;
    }
  }

  // --- Legend (horizontal strip below the plot, v=626) --------------------
  // Lives in the dedicated strip at LEGEND_STRIP_Y, OUTSIDE the data area
  // entirely. Earlier attempts (v=623 in-plot right-anchored, v=625 with
  // opaque background) both crashed with the data curves at HF where the
  // curves rise into the legend region. Bottom-strip placement is clean —
  // no curves there to crash with.
  //
  // Labels are short by design — the parenthetical standards citations
  // (ISO 12354-3, etc) live in the right-rail "Standards & method" panel,
  // not on the chart. The legend names what the line IS; the cite explains
  // why.
  const shortLabel = (raw) => {
    if (!raw) return 'computed';
    const r = String(raw);
    // Drop parenthetical standards refs in the legend (they live in the
    // right rail). "Sharp 1973" stays as-is — it's a primary identifier.
    return r.replace(/\s*\(ISO[^)]*\)\s*$/i, '').replace(/\s*\(measured\)\s*$/i, '');
  };
  const lineEntries = [
    { className: 'wp-computed', label: shortLabel(tl.source_label || 'computed'), circle: false },
  ];
  if (showCompare) lineEntries.push({ className: 'wp-measured', label: 'measured', circle: true });
  if (rating.computable) lineEntries.push({ className: 'wp-contour', label: 'contour (ISO 717-1)', circle: false });
  if (Array.isArray(opts.extras)) {
    for (const ex of opts.extras) lineEntries.push({ className: ex.className || 'wp-extra', label: shortLabel(ex.label || 'overlay'), circle: false });
  }
  // Distribute entries horizontally across the data-area width. Each entry
  // gets equal share so labels stay readable as the count grows from 1 to 5.
  const entryW = plotW / lineEntries.length;
  let legend = '';
  lineEntries.forEach((entry, i) => {
    const cx = mL + entryW * i + 10;          // line start
    const tx = cx + 24;                        // text start (line + gap)
    legend += `<line x1="${cx}" y1="${LEGEND_STRIP_Y}" x2="${cx + 18}" y2="${LEGEND_STRIP_Y}" class="${escapeHtml(entry.className)}"/>`;
    if (entry.circle) legend += `<circle cx="${cx + 9}" cy="${LEGEND_STRIP_Y}" r="3" class="wp-measured-pt"/>`;
    legend += `<text x="${tx}" y="${LEGEND_STRIP_Y + 3}" class="wp-legend">${escapeHtml(entry.label)}</text>`;
  });

  // --- SVG <defs> for the hatch pattern ------------------------------------
  // 45° diagonal hatch, 6 px period, single 1px stroke per cell. Maya §4.
  const defs = `<defs>
    <pattern id="wp-hatch-pattern" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" class="wp-hatch-stroke"/>
    </pattern>
  </defs>`;

  return `<svg viewBox="0 0 ${W} ${H}" class="wall-plot-svg" preserveAspectRatio="xMidYMid meet">
    ${defs}
    <text x="10" y="${mT + plotH / 2}" class="wp-axis-title" transform="rotate(-90 10 ${mT + plotH / 2})">TL (dB)</text>
    ${grid}${xlabs}${hatchLayer}${dip}${measuredLayer}${extrasLayer}${Array.isArray(computed) ? `<path d="${path(computed)}" class="wp-computed"/>` : ''}${contourLayer}${legend}${sumUnfavLabel}
  </svg>`;
}

// --- SVG: over-wall cross section ------------------------------------------
// Three rays (PSC v=610, Maya §1):
//   • sight        — direct sightline, dashed muted-dim (the no-wall reference).
//   • over-top     — primary diffracted path, solid amber (in shadow) or
//                    green (lit). Goes source → wall top → receiver.
//   • over-top-gnd — ground-reflected diffracted path. Drawn ONLY on hard
//                    ground, from a stroke-only image-source marker on the
//                    ground line directly below the source. No below-ground
//                    line drawing — a marker + small vertical leader is the
//                    geometrically honest abstraction. Soft ground hides the
//                    marker, leader, and ray entirely (silence = correct
//                    signal when contribution is zero).
// Source / listener labels sit OUTSIDE the scene (label-anchor bug Maya §5
// caught — old code anchored the label inside the circle's pixel column,
// causing overlap once the receiver was far enough right). Heights show on
// both labels for symmetry, even though receiver height is locked.
function crossSectionSVG(sourceH, wallH, srcToWall, recvDist, recvH, shadowed, groundIsHard) {
  const W = 460, H = 220, pad = 22, ground = H - 26;
  const worldW = srcToWall + recvDist + 2;          // +2 m margin past receiver
  const worldH = Math.max(sourceH, wallH, recvH) + 1.5;
  const sx = (W - 2 * pad) / worldW;
  const sy = (ground - 16) / worldH;
  // World x: 0 = source. Place source a little in from the left.
  const X = (wx) => pad + wx * sx;
  const Y = (wy) => ground - wy * sy;

  const xSrc = X(0), xWall = X(srcToWall), xRecv = X(srcToWall + recvDist);
  const ySrc = Y(sourceH), yWallTop = Y(wallH), yRecv = Y(recvH);

  const wallW = Math.max(4, 0.25 * sx);
  const sight = `<line x1="${xSrc}" y1="${ySrc}" x2="${xRecv}" y2="${yRecv}" class="xs-sight"/>`;
  const overTop = `<path d="M${xSrc},${ySrc} L${xWall},${yWallTop} L${xRecv},${yRecv}" class="xs-path ${shadowed ? 'xs-path-shadow' : 'xs-path-lit'}"/>`;

  // Ground-reflected over-top — image source on the ground line directly
  // below the real source. Render only on hard ground.
  let groundLayer = '';
  if (groundIsHard) {
    const xImage = xSrc, yImage = ground;
    const leader = `<line x1="${xSrc}" y1="${ySrc + 5}" x2="${xImage}" y2="${yImage - 4}" class="xs-image-leader"/>`;
    const reflected = `<path d="M${xImage},${yImage} L${xWall},${yWallTop} L${xRecv},${yRecv}" class="xs-path-ground"/>`;
    const imageMarker = `<circle cx="${xImage}" cy="${yImage}" r="4" class="xs-src-image"><title>image source (ground reflection)</title></circle>`;
    groundLayer = `${leader}${reflected}${imageMarker}`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" class="wall-plot-svg" role="img" preserveAspectRatio="xMidYMid meet">
    <line x1="${pad - 6}" y1="${ground}" x2="${W - pad + 6}" y2="${ground}" class="xs-ground"/>
    <rect x="${xWall - wallW / 2}" y="${yWallTop}" width="${wallW}" height="${ground - yWallTop}" class="xs-wall"/>
    ${sight}${groundLayer}${overTop}
    <circle cx="${xSrc}" cy="${ySrc}" r="5" class="xs-src"/>
    <circle cx="${xRecv}" cy="${yRecv}" r="4" class="xs-recv"/>
    <text x="${xSrc + 8}" y="${Math.max(11, ySrc - 11)}" class="xs-label" text-anchor="start">source · ${sourceH.toFixed(1)} m</text>
    <text x="${xWall}" y="${yWallTop - 5}" class="xs-label" text-anchor="middle">wall · ${wallH.toFixed(1)} m</text>
    <text x="${xRecv - 8}" y="${Math.max(11, yRecv - 9)}" class="xs-label" text-anchor="end">listener · ${recvH.toFixed(1)} m</text>
  </svg>`;
}

// --- Per-band TL table ------------------------------------------------------
function tableHTML(bands, computed, measured, showCompare, compareReason) {
  const fmt = (f) => f >= 1000 ? `${f / 1000}k` : `${f}`;
  const head = `<tr><th>Hz</th>${bands.map(f => `<th>${fmt(f)}</th>`).join('')}</tr>`;
  if (!Array.isArray(computed) || computed.length === 0) {
    return `<thead>${head}</thead><tbody><tr class="wall-tl-note"><td colspan="${bands.length + 1}">Measured row — the catalogue's 1/3-octave data is shown on the plot above. No formula prediction to compare.</td></tr></tbody>`;
  }
  const compRow = `<tr><th>Computed</th>${computed.map(v => `<td>${Math.round(v)}</td>`).join('')}</tr>`;
  if (!showCompare) {
    const note = compareReason === 'assembly'
      ? 'Catalogue value is an <em>assembly</em> rating (double-leaf, sealed, or composite). Single-leaf mass law is the wrong comparator here — pick a <em>double-leaf</em> material to use the Sharp predictor.'
      : compareReason === 'estimated'
      ? 'Catalogue value is itself a mass-law estimate — no independent measurement to compare against.'
      : compareReason === 'modified'
      ? 'Formula parameters tweaked — the measured curve below is for the catalogue defaults, not these settings. Reset the sliders to compare on an apples-to-apples basis.'
      : compareReason === 'mode'
      ? 'Measured row — the catalogue value IS the prediction.'
      : 'Measured data is at the reference thickness — set the slider to it to compare.';
    return `<thead>${head}</thead><tbody>${compRow}<tr class="wall-tl-note"><td colspan="${bands.length + 1}">${note}</td></tr></tbody>`;
  }
  const measRow = `<tr><th>Measured</th>${measured.map(v => `<td>${Math.round(v)}</td>`).join('')}</tr>`;
  const dRow = `<tr class="wall-tl-delta"><th>Δ</th>${computed.map((v, i) => { const d = Math.round(v - measured[i]); return `<td>${d > 0 ? '+' : ''}${d}</td>`; }).join('')}</tr>`;
  return `<thead>${head}</thead><tbody>${compRow}${measRow}${dRow}</tbody>`;
}

// --- Standards & method (right panel), per mode ----------------------------
// Step 8c (Maya 2026-05-23): two-section stack — EQUATION & METHOD on top
// (branches by cat.model) + RATING (always shown when Rw is computable, or
// one-line "why not" when not). Both sections always visible, separated by
// a thin rule. No accordion — Maya §6.
// Step 9 (Maya 2026-05-23): when composite inset is active, append a THIRD
// section "COMPOSITE BREAKDOWN" showing the τ·S contribution per element,
// and the EQUATION & METHOD section switches to the ISO 12354-3 §17 τ-bar
// formula.
function isolationMethodHTML(cat, meta, st, tl, rating, ctx = {}) {
  return `
    <section class="wall-method-section">
      <span class="wall-method-section-label">Equation &amp; method</span>
      ${equationMethodHTML(cat, meta, st, tl, ctx)}
    </section>
    <section class="wall-method-section wall-method-section-rating">
      <span class="wall-method-section-label">Rating (Rw)</span>
      ${ratingSectionHTML(rating, cat)}
    </section>
    ${(ctx.insetEnabled && ctx.breakdown && ctx.insetCat) ? `
    <section class="wall-method-section wall-method-section-breakdown">
      <span class="wall-method-section-label">Composite breakdown</span>
      ${breakdownSectionHTML(ctx.breakdown, ctx.insetCat, st.inset)}
    </section>
    ` : ''}
    <section class="wall-method-section wall-method-section-leaks">
      <span class="wall-method-section-label">Perimeter &amp; leaks</span>
      ${leakDisclosureSectionHTML()}
    </section>
    <section class="wall-method-section wall-method-section-flanking">
      <span class="wall-method-section-label">Flanking transmission</span>
      ${flankingDisclosureSectionHTML()}
    </section>
  `;
}

// Mode-specific EQUATION & METHOD content — branches on cat.model + the
// composite-active flag. When inset is active, the τ-bar formula takes
// precedence because that's the actual computation feeding the chip.
function equationMethodHTML(cat, meta, st, tl, ctx) {
  if (ctx.insetEnabled && ctx.insetCat) return compositeEquationHTML(cat, ctx.insetCat, st);
  if (cat.model === 'formula') return formulaEquationHTML(cat, st, tl);
  if (cat.model === 'catalogue') return catalogueEquationHTML(cat);
  return massLawEquationHTML(cat, meta, st, ctx);    // default
}

function compositeEquationHTML(primaryCat, insetCat, st) {
  const primaryName = escapeHtml(primaryCat.name || primaryCat.id);
  const insetName = escapeHtml(insetCat.name || insetCat.id);
  const insetPct = st.inset.area_percent;
  const primaryModelLabel = primaryCat.model === 'formula' ? 'Sharp three-region (double-leaf)'
    : primaryCat.model === 'catalogue' ? 'measured 1/3-octave'
    : 'field-incidence mass law';
  const insetModelLabel = insetCat.model === 'formula' ? 'Sharp three-region (double-leaf)'
    : insetCat.model === 'catalogue' ? 'measured 1/3-octave'
    : 'field-incidence mass law';
  return `
    <div class="wall-eq">
      <div class="wall-eq-line">R<sub>composite</sub>(f) = −10·log₁₀( Σ τᵢ(f)·Sᵢ / Σ Sᵢ )</div>
      <div class="wall-eq-sub">τᵢ(f) = 10<sup>−Rᵢ(f)/10</sup> · Sᵢ = area fraction of element <em>i</em></div>
      <div class="wall-eq-line wall-eq-result">primary <strong>${100 - insetPct}%</strong> ${primaryName} · inset <strong>${insetPct}%</strong> ${insetName}</div>
    </div>
    <p class="wall-method-plain">
      A composite wall's TL is the area-weighted sum of transmission
      coefficients, not of TLs. Because the weak element transmits much
      more sound per unit area, even a small fraction of low-TL material
      (a door, a vent) dominates the composite Rw. Doubling the door area
      from 1% to 2% costs more dB than going from 50% to 100% of a
      uniform wall.
    </p>
    <ul class="wall-cites">
      <li><strong>Formula:</strong> ISO 12354-3:2017 §17 (Eq. 17) — area-weighted τ-bar. Reproduced Bies &amp; Hansen 4th ed. Eq. 8.27.</li>
      <li><strong>Primary TL:</strong> ${primaryModelLabel}.</li>
      <li><strong>Inset TL:</strong> ${insetModelLabel} — catalogue defaults (no slider tweaks on the inset row).</li>
      <li class="wall-cite-sep"><strong>Field vs lab:</strong> the catalogue ratings are from lab partitions. Real installations typically lose 5–15&nbsp;dB through flanking transmission via floor/ceiling/junction paths (ISO 12354). AuraLAB does not model flanking — treat the displayed TL as an upper bound.</li>
    </ul>
  `;
}

// Phase 6 Step 3 (v=629, Dr. Chen sign-off 2026-05-23): perimeter-leak
// disclosure card. The mass-law / Sharp / catalogue TL paths all assume a
// perfectly sealed perimeter. Real installations always have some leakage —
// a 1 mm crack along a door perimeter drops TL by 13 dB on a 50 dB wall.
// Engineers know this; the workbench was silent on it until v=629.
//
// Formula is the same area-weighted τ-bar as wall-composite.js (ISO 12354-3
// Eq. 17 / Bies & Hansen Eq. 8.46): TL_actual = -10·log10(Σ τᵢ·Sᵢ / Σ Sᵢ),
// with the leak's TL ≈ 0 dB (τ ≈ 1).
//
// Worked numbers — 10 m² wall, 50 dB measured TL, varied leak area S_leak:
//   S_leak < 10⁻⁴ m² (pinhole):       TL = 49.96   loss < 0.1
//   S_leak = 0.002 m² (1 mm × 2 m):   TL = 37.0    loss = 13
//   S_leak = 0.02 m²  (10 mm gap):    TL = 27.0    loss = 23
function leakDisclosureSectionHTML() {
  return `
    <div class="wall-eq">
      <div class="wall-eq-line">TL<sub>actual</sub> = −10·log₁₀(&nbsp;Σ τᵢ·Sᵢ&nbsp;/&nbsp;Σ Sᵢ&nbsp;)</div>
      <div class="wall-eq-sub">τ<sub>leak</sub> ≈ 1 (a 1&nbsp;mm crack has TL ≈ 0 dB). Leak in parallel with wall.</div>
    </div>
    <p class="wall-method-plain">
      Every TL prediction above assumes a <em>perfectly sealed perimeter</em>.
      Any unsealed edge — door gap, electrical box, pipe penetration, junction
      crack — opens a parallel air path that bypasses the wall and dominates
      the composite TL fast. A 50&nbsp;dB wall with one badly-sealed door
      transmits like a 27&nbsp;dB wall. The worked examples below assume a
      10&nbsp;m² wall with the displayed Rw used as TL<sub>wall</sub>:
    </p>
    <table class="wall-leak-table">
      <thead><tr><th>Leak condition</th><th>S<sub>leak</sub></th><th>TL<sub>actual</sub></th><th>Loss</th></tr></thead>
      <tbody>
        <tr><td>Properly sealed (pinhole)</td><td>&lt; 10⁻⁴ m²</td><td><strong>49.96 dB</strong></td><td>&lt; 0.04</td></tr>
        <tr><td>1 mm × 2 m perimeter crack</td><td>0.002 m²</td><td><strong>37 dB</strong></td><td>−13</td></tr>
        <tr><td>10 mm under-door gap (no threshold seal)</td><td>0.02 m²</td><td><strong>27 dB</strong></td><td>−23</td></tr>
      </tbody>
    </table>
    <ul class="wall-cites">
      <li><strong>Formula:</strong> Bies &amp; Hansen, <em>Engineering Noise Control</em> 4th ed. §8.3.2 Eq. 8.46 — two-path composite TL with leak as a parallel τ = 1 element.</li>
      <li><strong>Field reality:</strong> Hopkins, <em>Sound Insulation</em> (2007) §3.3.4 "Air paths and flanking" — perimeter leaks are the most common reason an installed wall under-performs its lab rating.</li>
      <li><strong>Lab definition:</strong> ISO 10140-2 Annex A — the laboratory TL measurement explicitly excludes leakage and flanking by construction. The displayed TL is the partition's intrinsic isolation; the installation must seal.</li>
    </ul>
  `;
}

// Phase 6 Step 5 (v=631, Dr. Chen sign-off 2026-05-23): flanking-transmission
// disclosure card. Twin of leakDisclosureSectionHTML — same disclosure pattern,
// different physical mechanism. Step 3 (perimeter leaks) explains why a sealed
// wall still under-performs through *airborne* parallel paths. This card
// explains the other half: *structure-borne* vibration travelling through
// junctions (floor + ceiling + side walls) and re-radiating into the
// receiving room.
//
// Formula is ISO 12354-1:2017 §4.2 Eq. (24) — apparent sound reduction R'_w
// from partition + flanking path sum. R_ij per Hopkins 2007 §4.4.4 Eq. 4.52,
// equivalent to ISO 12354-1 Eq. (25):
//   R'_w = −10·log₁₀( 10^(−Rw/10) + Σᵢ 10^(−R_ij/10) )
//   R_ij = (R_i + R_j)/2 + K_ij + 10·log₁₀(S_s / (l_0·l_ij))
//
// Worked numbers — Rw 50 dB partition, 4 flanking paths (floor + ceiling +
// 2 side walls), R_flank ≈ R_partition, area-correction lumped into K_ij:
//   K_ij = 10 dB rigid masonry: R'_w = 48.5 dB (loss 1.5)
//   K_ij = 5  dB lightweight stud T:  R'_w = 46.5 dB (loss 3.5)
//   K_ij = 20 dB decoupled / resilient: R'_w = 49.8 dB (loss 0.2)
//
// Disclosure-only (Dr. Chen Q6 sign-off): NOT shown as a chip line, because
// we have no per-construction K_ij data — computing R'_w on a real assembly
// would be dishonest. The card teaches the form; the chip stays Rw/DnT,w.
function flankingDisclosureSectionHTML() {
  return `
    <div class="wall-eq">
      <div class="wall-eq-line">R'<sub>w</sub> = −10·log₁₀(&nbsp;10<sup>−Rw/10</sup> + Σᵢ 10<sup>−R<sub>ij</sub>/10</sup>&nbsp;)</div>
      <div class="wall-eq-sub">R<sub>ij</sub> = (R<sub>i</sub> + R<sub>j</sub>)/2 + K<sub>ij</sub> + 10·log₁₀(S<sub>s</sub>&nbsp;/&nbsp;(l₀·l<sub>ij</sub>))</div>
      <div class="wall-eq-sub">K<sub>ij</sub> = junction vibration-reduction index — characterises how much structure-borne vibration the junction blocks per path.</div>
    </div>
    <p class="wall-method-plain">
      Even with a perfectly sealed perimeter, real walls lose energy through
      <em>structure-borne flanking</em>: vibration travels up the partition,
      across the floor/ceiling/side-wall junctions, and re-radiates into the
      receiving room. ISO 12354-1 models this with the junction
      vibration-reduction index K<sub>ij</sub> — heavy concrete-block junctions
      block structure-borne energy well; lightweight stud T-junctions with
      full-height drywall do not; a resilient floating layer at the junction
      can almost eliminate it. The worked examples below assume a 50&nbsp;dB
      partition with 4 flanking paths (floor + ceiling + 2 side walls), each
      flanking element of similar mass to the partition (R<sub>flank</sub> ≈ R<sub>partition</sub>,
      area term lumped into K<sub>ij</sub> per Hopkins §4.4.5):
    </p>
    <table class="wall-flanking-table">
      <thead><tr><th>Junction type</th><th>K<sub>ij</sub></th><th>R'<sub>w</sub></th><th>Loss</th></tr></thead>
      <tbody>
        <tr><td>Rigid masonry T-junction</td><td>10 dB</td><td><strong>48.5 dB</strong></td><td>−1.5</td></tr>
        <tr><td>Lightweight stud T-junction</td><td>5 dB</td><td><strong>46.5 dB</strong></td><td>−3.5</td></tr>
        <tr><td>Decoupled / resilient layer (well-detailed)</td><td>20 dB</td><td><strong>49.8 dB</strong></td><td>−0.2</td></tr>
      </tbody>
    </table>
    <ul class="wall-cites">
      <li><strong>Formula:</strong> Hopkins, <em>Sound Insulation</em> (2007) §4.4.4 Eq. 4.52 — first-order R<sub>ij</sub> path model; ISO 12354-1:2017 §4.2 Eq. (24) (R'<sub>w</sub> path sum) and Eq. (25) (R<sub>ij</sub> per path).</li>
      <li><strong>Field reality:</strong> Hopkins 2007 §4.6 Table 4.4 — typical K<sub>ij</sub> ranges by junction class. K<sub>ij</sub>≈20 is the optimistic edge and requires the resilient detail to be well-executed; a poorly-installed resilient layer collapses to the rigid-junction case.</li>
      <li><strong>Measurement context:</strong> EN ISO 10848-1:2017 — laboratory protocol for measuring junction K<sub>ij</sub>. WallLAB does not compute R'<sub>w</sub> on the displayed assembly because per-junction K<sub>ij</sub> data is not in the catalogue; the table above is illustrative, not prescriptive.</li>
    </ul>
  `;
}

function breakdownSectionHTML(breakdown, insetCat, insetState) {
  const insetLabel = escapeHtml(insetCat.name || insetCat.id);
  const insetArea = insetState.area_percent;
  const dominant = breakdown.inset_pct > breakdown.primary_pct ? 'inset' : 'primary';
  const dominantPct = dominant === 'inset' ? breakdown.inset_pct : breakdown.primary_pct;
  const narrative = dominant === 'inset'
    ? `The <strong>${insetLabel}</strong> dominates transmission — it carries <strong>${breakdown.inset_pct}%</strong> of the τ·S budget despite being <strong>${insetArea}%</strong> of the area. This is the "leaky element dominates fast" effect: a low-TL element bounds the wall's effective isolation no matter how heavy the primary is.`
    : `The primary material dominates transmission (<strong>${breakdown.primary_pct}%</strong> of the τ·S budget). The inset has minimal effect on the composite Rw at this area fraction.`;
  // Render a horizontal proportion bar. Each segment is sized to its
  // percent contribution. The bar shows which element is "killing the Rw".
  const primaryFlex = Math.max(breakdown.primary_pct, 4);    // min 4% width so even tiny shares are visible
  const insetFlex = Math.max(breakdown.inset_pct, 4);
  return `
    <p class="wall-method-plain">${narrative}</p>
    <div class="wall-breakdown-bar" role="img" aria-label="Element contribution to τ·S budget">
      <div class="wall-breakdown-bar-primary" style="flex: ${primaryFlex} 1 0">primary ${breakdown.primary_pct}%</div>
      <div class="wall-breakdown-bar-inset" style="flex: ${insetFlex} 1 0">inset ${breakdown.inset_pct}%</div>
    </div>
    <ul class="wall-cites">
      <li><strong>What's "τ·S budget"?</strong> Transmission coefficient τ times area S — the share of sound power each element passes. Average across the Rw evaluation bands (100&nbsp;Hz – 3.15&nbsp;kHz). Higher share = element transmits more energy.</li>
      <li class="wall-cite-sep"><strong>Engineering takeaway:</strong> the dominant element (<strong>${dominantPct}%</strong> of the budget) is the one to fix. Reinforcing the other element gives diminishing returns until you address the dominator first.</li>
    </ul>
  `;
}

function massLawEquationHTML(cat, meta, st, ctx) {
  const thickness_m = st.thickness_mm / 1000;
  const density = densityFromCatalogue(cat.surface_density_kg_m2, meta.reference_thickness_m);
  const m = surfaceDensity(thickness_m, density);
  const f = 500;
  const tl500 = massLawTL(m, f);
  const source = cat._tl_source || cat._source || cat._tl_note || '—';
  const isAssembly = ctx.compareReason === 'assembly';
  const isEstimated = ctx.compareReason === 'estimated' || cat.tl_estimated;
  const measuredLine = isAssembly
    ? `<span class="wall-asm-chip">${escapeHtml(assemblyLabel(ctx.assembly_type))}</span> The catalogue value is an assembly rating, not a single-leaf measurement. Mass law (the computed line above) is the wrong comparator — sound goes through this construction by a different mechanism (mass-spring-mass resonance, cavity coupling, stud bridging, or perimeter leak). Pick a <em>double-leaf</em> material to use the Sharp predictor. Source: ${escapeHtml(source)}`
    : isEstimated
    ? `<span class="wall-est-chip">≈ estimated</span> This material's catalogue TL is itself a mass-law estimate — no independent measured data, so a Δ comparison would be circular. Source: ${escapeHtml(source)}`
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
      in sympathy with the sound and leaks more. Heavy stiff masonry pushes that
      frequency above the audible range, so concrete tracks the line; thin glass
      and gypsum do not.
    </p>
    <ul class="wall-cites">
      <li><strong>Computed line:</strong> field-incidence mass law, TL = 20·log₁₀(m·f) − 47 dB. Beranek &amp; Vér, <em>Noise and Vibration Control Engineering</em> 2nd ed. §10.3; Sharp 1973. Valid for single-leaf panels below the coincidence frequency.</li>
      <li><strong>Catalogue anchor:</strong> ${measuredLine}</li>
      <li class="wall-cite-sep"><strong>Field vs lab:</strong> the catalogue rating is from a lab partition. Real installations typically lose 5–15&nbsp;dB through flanking transmission via floor/ceiling/junction paths (ISO 12354). AuraLAB does not model flanking — treat the displayed TL as an upper bound.</li>
      <li class="wall-cite-sep"><strong>Separate model:</strong> sound bending <em>over</em> a wall is edge diffraction — see the over-wall mode.</li>
    </ul>
  `;
}

function formulaEquationHTML(cat, st, tl) {
  // Current frequencies for the user's slider state.
  const f_mam = massAirMassFreq(st.leaf1_mass_kg_m2, st.leaf2_mass_kg_m2, st.cavity_depth_m);
  const f_d = cavityCutoffFreq(st.cavity_depth_m);
  const fillBonusDb = st.cavity_fill === 'fibrous_50mm' ? '+5' : st.cavity_fill === 'reflective' ? '−3' : '0';
  const studLabel = ({ wood: 'wood', steel: 'steel', staggered: 'staggered', double: 'double' })[st.stud_type] || st.stud_type;
  const studCapNote = (st.stud_type === 'wood' || st.stud_type === 'steel')
    ? `${studLabel}-stud bridging caps TL at <strong>mass-law(m₁+m₂) + ${st.stud_type === 'steel' ? '8' : '5'}&nbsp;dB</strong> above 250&nbsp;Hz; below 250&nbsp;Hz the cap relaxes to mass-law of total mass.`
    : `${studLabel}-stud system removes mechanical bridging — Sharp formula uncapped (real construction has residual coupling not modelled; predictions tend to over-estimate Rw by ~3-4&nbsp;dB on this stud type).`;
  const modifiedNote = st.modified ? ` <em>(modified from catalogue defaults)</em>` : '';
  const source = cat._tl_source || cat._tl_note || '—';
  return `
    <div class="wall-eq">
      <div class="wall-eq-line">Sharp three-region (1973)</div>
      <div class="wall-eq-sub">Region&nbsp;I: TL = 20·log₁₀((m₁+m₂)·f) − 47&nbsp;dB&nbsp;&nbsp;(f &lt; f_mam)</div>
      <div class="wall-eq-sub">Region&nbsp;II: TL = TL_M₁ + TL_M₂ + 20·log₁₀(f·d) − 29&nbsp;&nbsp;(f_mam &lt; f &lt; f_d)</div>
      <div class="wall-eq-sub">Region&nbsp;III: TL = TL_M₁ + TL_M₂ + 6&nbsp;dB&nbsp;&nbsp;(f &gt; f_d)</div>
      <div class="wall-eq-line wall-eq-result">f_mam = <strong>${f_mam ? Math.round(f_mam) : '—'}&nbsp;Hz</strong> · f_d = <strong>${f_d ? Math.round(f_d) : '—'}&nbsp;Hz</strong></div>
      <div class="wall-eq-sub">Cavity-fill bonus (II/III only): <strong>${fillBonusDb}&nbsp;dB</strong>${modifiedNote}</div>
    </div>
    <p class="wall-method-plain">
      A double-leaf wall is a mass-spring-mass system. Below f_mam the two leaves
      move in phase and the wall acts like a single panel of combined mass.
      Above f_mam, cavity coupling kicks in and TL rises &asymp; 18&nbsp;dB/oct
      (Region&nbsp;II plateau). Above f_d the cavity is acoustically "large" and
      the leaves decouple. ${studCapNote}
    </p>
    <ul class="wall-cites">
      <li><strong>Sharp three-region:</strong> Sharp 1973; reproduced Bies &amp; Hansen, <em>Engineering Noise Control</em> 4th ed. Eq.&nbsp;8.41a/b. The constant 60 in f_mam absorbs ρ₀&nbsp;=&nbsp;1.21&nbsp;kg/m³, c&nbsp;=&nbsp;343&nbsp;m/s, factor 1/(2π·√(ρ₀c²)) for normal-incidence air cavities (Eq.&nbsp;8.40).</li>
      <li><strong>Stud bridging:</strong> Sharp 1973 Fig.&nbsp;6; Cremer-Heckl-Müller §11.4; Gypsum Association GA-600. The +5 / +8&nbsp;dB caps are empirical and cap predicted TL above 250&nbsp;Hz; below that the cap relaxes to mass-law of total mass.</li>
      <li><strong>Catalogue anchor:</strong> ${escapeHtml(source)}</li>
      <li class="wall-cite-sep"><strong>Field vs lab:</strong> the catalogue rating is from a lab partition. Real installations typically lose 5–15&nbsp;dB through flanking transmission via floor/ceiling/junction paths (ISO 12354). AuraLAB does not model flanking — treat the displayed TL as an upper bound.</li>
    </ul>
  `;
}

function catalogueEquationHTML(cat) {
  const source = cat._tl_source || cat._tl_note || '—';
  return `
    <div class="wall-eq">
      <div class="wall-eq-line">Measured row — no closed-form prediction</div>
      <div class="wall-eq-sub">The curve on the plot is the catalogue's 1/3-octave measured data.</div>
    </div>
    <p class="wall-method-plain">
      Some wall systems (resilient channel, laminated/IGU glazing, proprietary
      acoustic doors) have no closed-form predictor at engineering precision —
      their isolation depends on installation details the formula can't see
      (fastener length, panel overlap, gasket condition). AuraLAB treats these
      as catalogue-only: the user picks the row, the engine reads the measured
      curve.
    </p>
    <ul class="wall-cites">
      <li><strong>Measured anchor:</strong> ${escapeHtml(source)}</li>
      <li class="wall-cite-sep"><strong>Field vs lab:</strong> the catalogue rating is from a lab partition. Real installations typically lose 5–15&nbsp;dB through flanking transmission via floor/ceiling/junction paths (ISO 12354). AuraLAB does not model flanking — treat the displayed TL as an upper bound.</li>
    </ul>
  `;
}

// RATING section — always shown. Explains the ISO 717-1 contour-shift procedure
// and surfaces the current shift / Σ_unfav / Rw + spectrum adaptation terms.
// When Rw is not computable, single-sentence "why not" replaces the procedure
// block. Maya §6 — never hide the section.
function ratingSectionHTML(rating, cat) {
  if (!rating || !rating.computable) {
    const reason = rating?.reason || 'no 1/3-octave data';
    const why = cat.model === 'catalogue'
      ? `Rw not computable — this catalogue row is missing its 1/3-octave measured data (Phase 6 deferred). Pick another row to see a rating.`
      : `Rw not computable — ${reason}.`;
    return `
      <div class="wall-rating-unavailable">${why}</div>
      <ul class="wall-cites">
        <li><strong>Standard:</strong> ISO 717-1:2020 §3.1 (Rw, contour-shift) + §5 (display format).</li>
      </ul>
    `;
  }
  // Sum of unfavourable deviations for the final shift (recomputed locally
  // for display — keeps the method panel self-explanatory without coupling
  // to an internal helper).
  // We don't have the per-band breakdown handy here, so we display the rating
  // numbers directly and explain the procedure in plain text.
  return `
    <div class="wall-eq">
      <div class="wall-eq-line">Rw = ${rating.Rw}&nbsp;dB · STC = ${rating.STC}&nbsp;dB</div>
      <div class="wall-eq-sub">C = ${rating.C >= 0 ? '+' : ''}${rating.C}&nbsp;dB (pink/A-weighted) · Ctr = ${rating.Ctr >= 0 ? '+' : ''}${rating.Ctr}&nbsp;dB (traffic)</div>
      <div class="wall-eq-line wall-eq-result">contour shift = <strong>${rating.shift >= 0 ? '+' : ''}${rating.shift}&nbsp;dB</strong></div>
    </div>
    <p class="wall-method-plain">
      Slide the reference contour up or down in 1&nbsp;dB integer steps. At
      each shift, sum the bands where the contour exceeds the measured TL
      (the &ldquo;unfavourable deviations&rdquo;). The largest shift where the
      sum stays at or below 32.0&nbsp;dB is the answer. Rw is the value of
      the shifted contour at 500&nbsp;Hz. STC follows the same procedure with
      a different contour shape (ASTM&nbsp;E413) and an extra single-band
      ≤&nbsp;8&nbsp;dB rule — that's why Rw and STC can diverge on walls with
      a deep narrow dip (mass-air-mass resonance is the usual culprit).
      The plot's hatched bands show where the unfavourable deviations land.
    </p>
    <ul class="wall-cites">
      <li><strong>Rw:</strong> ISO 717-1:2020 §3.1 — Σ unfavourable ≤ 32.0&nbsp;dB; single-band limit dropped in the 2013 revision.</li>
      <li><strong>STC:</strong> ASTM E413-22 §5 — same Σ rule plus single-band ≤ 8&nbsp;dB. Typically lands within ±1&nbsp;dB of Rw.</li>
      <li><strong>C / Ctr:</strong> ISO 717-1:2020 Table&nbsp;2 — added to Rw to predict performance against pink-noise (C) or traffic (Ctr) sources. Display per §5: <code>Rw (C; Ctr)</code>.</li>
    </ul>
  `;
}

function assemblyLabel(t) {
  if (t === 'double_leaf') return 'double-leaf assembly';
  if (t === 'composite') return 'composite / sealed assembly';
  return 'assembly rating';
}

function diffractionMethodHTML(delta, shadowed, groundIsHard) {
  const lambda1k = (SPEED_OF_SOUND / 1000).toFixed(3);
  const N = (2 * delta / (SPEED_OF_SOUND / 1000));
  const groundLine = groundIsHard
    ? `<li><strong>Ground reflection:</strong> hard ground (G = 0) adds a second diffracted path from the image source (real source mirrored through the ground plane). The two arrivals sum incoherently — up to +3&nbsp;dB extra level at the receiver in symmetric geometries. ISO 9613-2 §7.3.1 single-value engineering approximation.</li>`
    : `<li><strong>Ground reflection:</strong> soft ground (G = 1, grass / snow) absorbs the reflected path — only the over-the-top arrival reaches the receiver. ISO 9613-2 §7.3.1.</li>`;
  return `
    <div class="wall-eq">
      <div class="wall-eq-line">N = 2δ / λ ,&nbsp; IL = f(N)</div>
      <div class="wall-eq-sub">δ = ${delta.toFixed(3)} m (path detour over the top) · λ = ${lambda1k} m @ 1 kHz</div>
      <div class="wall-eq-line wall-eq-result">N = <strong>${N.toFixed(2)}</strong> → ${shadowed ? 'shadow (loss)' : 'lit (≈ no loss)'}</div>
    </div>
    <p class="wall-method-plain">
      A wall casts an acoustic "shadow", but sound bends over the top edge into
      it. The <em>path detour</em> δ — how much longer the over-the-top route is
      than the straight line — sets the loss: a deep shadow has a big detour and
      a big loss; a receiver near the sightline has δ ≈ 0 and almost none.
      A source mounted <em>above</em> a wall has a near-clear sightline, so δ is
      tiny and the wall barely attenuates it — the azan-horn-over-the-parapet case.
    </p>
    <ul class="wall-cites">
      <li><strong>Insertion loss:</strong> Maekawa single-screen diffraction, IL = f(Fresnel number N = 2δ/λ), capped ~24 dB. Maekawa 1968; adopted by ISO&nbsp;9613-2 §7.4 ("Screening").</li>
      ${groundLine}
      <li><strong>Air absorption:</strong> per-band attenuation along the detour path. ISO 9613-1 standard atmosphere — small at low frequencies, dominant above ~2 kHz on detours of 20 m+.</li>
      <li class="wall-cite-sep"><strong>Net IL</strong> in the table below is the energy-sum of both diffracted paths after their respective air-absorption losses, expressed as level reduction vs the no-wall direct reference.</li>
      <li class="wall-cite-sep"><strong>Note:</strong> a schematic two-path model (one source, one straight wall, one receiver, single ground bounce). The full AuraLAB engine adds finite-wall edges, re-radiation, and meteorological correction — that's the "over-wall acoustics" toggle (left).</li>
    </ul>
  `;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
