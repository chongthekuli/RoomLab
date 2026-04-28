// PA Rack Builder — DeviceLAB main content.
//
// Three-column layout per Felix Brandt's spec (RACK_BUILDER_DESIGN.md
// §3): frame + amp picker on the left, builder + 3D preview in the
// middle, "system overview" of placed racks on the right. The user
// picks a rack frame, picks an amplifier from a filtered catalogue,
// adds amps to slots, then "Place in room" pushes the rack into the
// shared scene autosave so RoomLAB renders it on next visit.
//
// State coupling: writes directly to the shared scene state
// (js/app-state.js — `state.rackSystem.racks`). emit('rack:changed')
// fires; RoomLAB's 3D scene rebuilds racksGroup live, so flipping
// to #/room shows the placed rack without a reload.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { state } from '../../app-state.js';
import { emit } from '../../shared/events.js';
import { buildRackGroup } from '../../graphics/rack-render.js';
import { bindLab } from '../../shared/lab-storage.js';
import { listCustomRooms, updateCustomRoom } from '../../shared/custom-rooms.js';

// DeviceLAB-namespaced localStorage. Persists in-progress UI state
// across browser-close → reopen: the half-built _currentRack and
// the amp search filter. (In-session navigation in the SPA shell no
// longer wipes anything because the DOM stays in memory.)
const lab = bindLab('devicelab');

// In the SPA shell DeviceLAB and RoomLAB share the live `state`
// object directly — no localStorage merge dance, no autosave
// round-trip. Edits land on state.rackSystem.racks; emit('rack:changed')
// fires; RoomLAB's scene listens and rebuilds racksGroup so flipping
// to #/room shows the placed rack instantly.
function ensureRackSystem() {
  if (!state.rackSystem || !Array.isArray(state.rackSystem.racks)) {
    state.rackSystem = { racks: [] };
  }
  return state.rackSystem;
}

// Human-readable context for the banner: "Editing racks for: <room>".
// Reads from the live shared state. Returns a "no scene yet" hint
// only when RoomLAB hasn't been mounted yet (user hit #/device first
// in the SPA — possible if a deep link points there).
function describeSceneContext() {
  const r = state.room ?? {};
  const hasScene = (state.sources?.length ?? 0) > 0
    || (state.listeners?.length ?? 0) > 0
    || (state.zones?.length ?? 0) > 0
    || Number.isFinite(r.width_m);
  if (!hasScene) {
    return {
      name: 'No room scene yet',
      meta: 'Click RoomLAB to start a scene — racks are tied to the active room.',
    };
  }
  const proj = (typeof state.projectName === 'string' && state.projectName.trim())
    ? state.projectName.trim()
    : null;
  let name = proj;
  if (!name) {
    if (r.shape === 'rectangular' && Number.isFinite(r.width_m) && Number.isFinite(r.depth_m)) {
      name = `Rectangular · ${r.width_m.toFixed(1)} × ${r.depth_m.toFixed(1)} m`;
    } else if (r.shape === 'polygon' && Number.isFinite(r.polygon_radius_m)) {
      name = `${r.polygon_sides ?? 8}-gon · radius ${r.polygon_radius_m.toFixed(1)} m`;
    } else if (r.shape === 'round' && Number.isFinite(r.round_radius_m)) {
      name = `Round · radius ${r.round_radius_m.toFixed(1)} m`;
    } else {
      name = 'Custom room';
    }
  }
  const counts = [
    `${(state.sources ?? []).length} sources`,
    `${(state.listeners ?? []).length} listeners`,
    `${(state.zones ?? []).length} zones`,
  ].join(' · ');
  return { name, meta: counts };
}

let _rackCatalogue = null;
let _ampCatalog = null;

const U_HEIGHT_M = 0.04445;

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function mountRackPanel({ rackCatalogue, ampCatalog }) {
  _rackCatalogue = rackCatalogue;
  _ampCatalog = ampCatalog;
  // Make sure state.rackSystem exists before anyone reads from it.
  // RoomLAB sets this up in its mount, but the user may have hit
  // #/device first — keep DeviceLAB self-sufficient.
  ensureRackSystem();
  const root = document.getElementById('view-rack');
  if (!root) return;

  // Context banner: show which RoomLAB scene these racks belong to.
  // Without this DeviceLAB feels disconnected — user can't tell whether
  // they're editing for the hifi room they were just in, or a stale
  // scene from yesterday.
  const ctx = describeSceneContext();
  root.innerHTML = `
    <div class="rack-builder-ctx">
      <span class="rack-ctx-label">Editing racks for</span>
      <span class="rack-ctx-name">${escapeHtml(ctx.name)}</span>
      <span class="rack-ctx-meta">${escapeHtml(ctx.meta)}</span>
      <a class="rack-ctx-back" href="#/room" title="Open RoomLAB">View room →</a>
    </div>
    <div class="rack-builder">
      <aside class="rack-col-left">
        <h3>Rack frames</h3>
        <div class="rack-frame-list" id="rack-frame-list"></div>
        <h3>Amplifiers</h3>
        <div class="rack-amp-filter">
          <input id="rack-amp-search" placeholder="Search models / categories…" />
        </div>
        <div class="rack-amp-list" id="rack-amp-list"></div>
      </aside>
      <section class="rack-col-mid">
        <div class="rack-mid-header">
          <span class="rack-mid-title" id="rack-mid-title">No rack selected</span>
          <span class="rack-mid-summary" id="rack-mid-summary"></span>
        </div>
        <div class="rack-preview" id="rack-preview"></div>
        <div class="rack-slot-list" id="rack-slot-list"></div>
        <div class="rack-mid-actions">
          <label class="rack-target-label" for="rack-target-room">Place in:</label>
          <select id="rack-target-room" class="rack-target-room"
                  title="Pick which room receives this rack. The current scene shows it live in 3D the moment you click Place. A saved custom room stores the rack inside that room's saved entry — it appears in 3D when you click that room's chip in RoomLAB.">
            <option value="__current__">Current scene</option>
          </select>
          <button class="rack-action rack-action-place" id="rack-action-place" disabled>Place in room</button>
          <button class="rack-action rack-action-discard" id="rack-action-discard" disabled>Discard rack</button>
        </div>
      </section>
      <aside class="rack-col-right">
        <h3>System overview</h3>
        <div class="rack-system-list" id="rack-system-list"></div>
      </aside>
    </div>
  `;

  // Restore in-progress rack and search filter from lab storage so the
  // user picks up exactly where they left off after navigating away.
  // Validate against the rack catalogue — if the saved frame key has
  // disappeared (catalogue update), drop the stale entry rather than
  // crashing later.
  const savedRack = lab.read('currentRack');
  if (savedRack?.rackModelKey && _rackCatalogue?.racks?.[savedRack.rackModelKey]) {
    _currentRack = savedRack;
  } else if (savedRack) {
    lab.clear('currentRack');
  }
  const savedSearch = lab.read('ampSearch') ?? '';

  renderFrameList();
  renderAmpList(savedSearch);
  renderRackMid();
  renderSystemOverview();
  renderTargetRoomSelect();
  mountPreview();

  const searchInput = document.getElementById('rack-amp-search');
  searchInput.value = savedSearch;
  searchInput.addEventListener('input', (e) => {
    lab.write('ampSearch', e.target.value);
    renderAmpList(e.target.value);
  });
  document.getElementById('rack-action-place').addEventListener('click', placeCurrentRack);
  document.getElementById('rack-action-discard').addEventListener('click', discardCurrentRack);

  // DeviceLAB is the whole page — no viewport-tab visibility flicker
  // to compensate for. Resize the preview once layout settles, plus
  // on any window resize so the canvas fills its column cleanly.
  requestAnimationFrame(() => { resizePreview(); updatePreview(); });
  window.addEventListener('resize', () => {
    resizePreview();
    updatePreview();
  });
  // The router lazy-mounts DeviceLAB while its container is still
  // display:none, so the initial mountPreview() reads clientWidth=0
  // and the WebGL renderer comes up mis-sized → the preview ends up
  // blank. Force a resize + re-render every time the device route
  // becomes visible. Also refresh the place-target dropdown so saved
  // rooms created while the user was on RoomLAB show up here.
  document.addEventListener('route:change', (e) => {
    if (e.detail?.to !== 'device') return;
    requestAnimationFrame(() => {
      resizePreview();
      updatePreview();
      renderTargetRoomSelect();
      renderSystemOverview();
    });
  });
}

// ---- 3D preview (isolated Three.js scene) ------------------------------
let _previewScene = null;
let _previewCamera = null;
let _previewRenderer = null;
let _previewControls = null;
let _previewRackGroup = null;
let _previewRAF = 0;

function mountPreview() {
  console.info('[devicelab] mountPreview — build 2026-04-29a');
  const host = document.getElementById('rack-preview');
  if (!host) return;
  // Renderer with tone mapping so the metallic frame can pick up
  // highlights from the IBL environment without clipping to white.
  _previewRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  _previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
  _previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  _previewRenderer.toneMappingExposure = 1.15;
  host.appendChild(_previewRenderer.domElement);

  // Scene + camera. Lighter background — the previous #14171b was
  // near-black and high-metalness materials had nothing to reflect, so
  // the rack appeared as a black silhouette.
  _previewScene = new THREE.Scene();
  _previewScene.background = new THREE.Color(0x222934);
  _previewCamera = new THREE.PerspectiveCamera(35, 1, 0.05, 30);
  _previewCamera.position.set(1.6, 1.2, 2.0);

  // IBL — RoomEnvironment baked once into a PMREM texture. Without
  // this, MeshStandardMaterials with metalness > 0.5 (our brushed
  // steel) read as black because direct lights only contribute a
  // fraction of the BRDF in metallic regimes. Same approach as
  // scene.js for the main viewport.
  const pmrem = new THREE.PMREMGenerator(_previewRenderer);
  _previewScene.environment = pmrem.fromScene(new RoomEnvironment(_previewRenderer), 0.04).texture;

  // Three-light archviz on top of IBL — IBL handles ambient fill;
  // the directional key gives the rack a clear shadow side.
  const hemi = new THREE.HemisphereLight(0xc4d2e6, 0x2c2924, 0.55);
  _previewScene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff4e0, 1.20);
  key.position.set(2.5, 4, 2.5);
  _previewScene.add(key);
  const fill = new THREE.DirectionalLight(0xa8c0d8, 0.45);
  fill.position.set(-2, 2.5, -1.5);
  _previewScene.add(fill);
  // Subtle uplight from below so the castors and base plate aren't
  // lost in self-shadow. Real install racks live on a polished floor;
  // the bounce light is part of how they read.
  const uplight = new THREE.DirectionalLight(0xfae3c0, 0.18);
  uplight.position.set(0, -2, 1);
  _previewScene.add(uplight);

  // Floor — slightly more reflective than before so the rack picks
  // up a faint contact reflection at the castors.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshStandardMaterial({ color: 0x252c36, roughness: 0.62, metalness: 0.18 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  _previewScene.add(floor);

  // Controls
  _previewControls = new OrbitControls(_previewCamera, _previewRenderer.domElement);
  _previewControls.enableDamping = true;
  _previewControls.dampingFactor = 0.08;
  _previewControls.minDistance = 0.5;
  _previewControls.maxDistance = 6;
  _previewControls.target.set(0, 0.8, 0);

  resizePreview();
  window.addEventListener('resize', resizePreview);
  // ResizeObserver picks up panel-column resize from CSS too
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resizePreview).observe(host);
  }

  // Animation loop — only ticks while the tab is visible to save cycles
  const tick = () => {
    _previewRAF = requestAnimationFrame(tick);
    if (!host.offsetParent) return; // hidden tab
    _previewControls?.update();
    _previewRenderer?.render(_previewScene, _previewCamera);
  };
  tick();

  // Initial empty placeholder — render the floor on its own
  updatePreview();
}

function resizePreview() {
  const host = document.getElementById('rack-preview');
  if (!host || !_previewRenderer || !_previewCamera) return;
  const w = host.clientWidth || 1;
  const h = host.clientHeight || 1;
  if (w <= 1 || h <= 1) return;
  _previewRenderer.setSize(w, h, false);
  _previewCamera.aspect = w / h;
  _previewCamera.updateProjectionMatrix();
}

function disposeRackGroup(group) {
  group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.map && !m.map.userData?.shared) m.map.dispose?.();
        m.dispose?.();
      }
    }
  });
}

function updatePreview() {
  if (!_previewScene) return;
  // Dispose old group
  if (_previewRackGroup) {
    _previewScene.remove(_previewRackGroup);
    disposeRackGroup(_previewRackGroup);
    _previewRackGroup = null;
  }
  if (!_currentRack || !_rackCatalogue) return;
  _previewRackGroup = buildRackGroup(_currentRack, _ampCatalog || [], _rackCatalogue);
  _previewScene.add(_previewRackGroup);
  // Frame the camera to the rack height
  const def = _rackCatalogue.racks[_currentRack.rackModelKey];
  const outerH = (def?.outer_h_mm ?? 1248) / 1000;
  _previewControls.target.set(0, outerH * 0.4, 0);
  // Position camera at a slight 3/4 angle, distance proportional to height
  const dist = Math.max(2.0, outerH * 1.5);
  _previewCamera.position.set(dist * 0.7, outerH * 0.65, dist * 0.85);
  _previewControls.update();
}

// In-progress rack the user is currently building. Lives outside the
// shared scene autosave until "Place in room" commits it, but is
// persisted to DeviceLAB-local storage on every mutation so toggling
// to RoomLAB / SpeakerLAB and back doesn't wipe the work-in-progress.
let _currentRack = null;

// Persist _currentRack to lab storage. Called after every mutation
// (startNewRack / addAmpToRack / removeSlot / discard / place). Passing
// null clears the saved entry — done after place/discard so a fresh
// page boot starts on the empty workbench instead of resurrecting a
// just-placed rack.
function persistCurrentRack() {
  lab.write('currentRack', _currentRack);
}

function renderFrameList() {
  const root = document.getElementById('rack-frame-list');
  if (!root || !_rackCatalogue?.racks) {
    root.innerHTML = '<p class="rack-empty">Rack catalogue unavailable.</p>';
    return;
  }
  const html = Object.entries(_rackCatalogue.racks).map(([key, def]) => `
    <button class="rack-frame-tile" data-rack-key="${escapeHtml(key)}" title="${escapeHtml(def.label)}">
      <strong>${def.u} U</strong>
      <span>${(def.outer_h_mm / 10).toFixed(0)} cm tall</span>
      <span>${def.weight_kg} kg</span>
    </button>
  `).join('');
  root.innerHTML = html;
  root.querySelectorAll('.rack-frame-tile').forEach(btn => {
    btn.addEventListener('click', () => startNewRack(btn.dataset.rackKey));
  });
}

function renderAmpList(filterText) {
  const root = document.getElementById('rack-amp-list');
  if (!root) return;
  if (!Array.isArray(_ampCatalog) || _ampCatalog.length === 0) {
    root.innerHTML = '<p class="rack-empty">Amplifier catalogue unavailable.</p>';
    return;
  }
  const q = (filterText || '').toLowerCase().trim();
  const filtered = q.length === 0
    ? _ampCatalog
    : _ampCatalog.filter(a => {
      const hay = [
        a.id, a.model, ...(a.category || []),
        a.intendedUse,
        a.electrical?.outputType,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  if (filtered.length === 0) {
    root.innerHTML = '<p class="rack-empty">No matches.</p>';
    return;
  }
  root.innerHTML = filtered.slice(0, 60).map(a => `
    <button class="rack-amp-tile" data-amp-id="${escapeHtml(a.id)}"
            ${_currentRack ? '' : 'disabled title="Pick a rack frame first"'}>
      <strong>${escapeHtml(a.model)}</strong>
      <span class="rack-amp-tile-spec">${a.electrical?.channelCount ?? '?'}-ch · ${a.electrical?.ratedPower_w_per_ch ?? '?'} W · ${escapeHtml(a.electrical?.outputType ?? '')} · Class-${escapeHtml(a.electrical?.class ?? '?')}</span>
      <span class="rack-amp-tile-cat">${(a.category || []).slice(0, 2).map(escapeHtml).join(' · ')}</span>
    </button>
  `).join('');
  root.querySelectorAll('.rack-amp-tile').forEach(btn => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => addAmpToRack(btn.dataset.ampId));
  });
}

function startNewRack(rackKey) {
  const def = _rackCatalogue?.racks?.[rackKey];
  if (!def) return;
  // Ask the user for a name up front — pros usually have a labelling
  // convention (Lobby Amp Rack, FOH Main, BoH Backup) and want it set
  // before they start dropping amps in. Empty input falls back to a
  // generic "<U>U rack" label so the workflow isn't blocked.
  let userLabel = window.prompt(
    `Name this rack (optional) — e.g. Lobby Amp Rack, FOH Main, BoH Backup`,
    ''
  ) || null;
  if (typeof userLabel === 'string') {
    userLabel = userLabel.trim();
    if (userLabel.length === 0) userLabel = null;
  }
  _currentRack = {
    id: 'R' + Date.now().toString(36),
    label: userLabel || `${def.u}U rack`,
    rackModelKey: rackKey,
    position: { x: 0.6, y: 0.6, z: 0 },     // sensible corner default
    yaw_deg: 0,
    slots: [],
  };
  persistCurrentRack();
  renderRackMid();
  renderAmpList(document.getElementById('rack-amp-search').value);
  updatePreview();
}

function findFreeSlot(uHeight) {
  if (!_currentRack) return null;
  const def = _rackCatalogue.racks[_currentRack.rackModelKey];
  const totalU = def?.u ?? 0;
  // Track which U positions are occupied
  const occupied = new Set();
  for (const s of _currentRack.slots) {
    for (let u = s.uStart; u < s.uStart + s.uHeight; u++) occupied.add(u);
  }
  // Find first uStart with uHeight contiguous free slots
  for (let u = 1; u + uHeight - 1 <= totalU; u++) {
    let ok = true;
    for (let k = 0; k < uHeight; k++) {
      if (occupied.has(u + k)) { ok = false; break; }
    }
    if (ok) return u;
  }
  return null;
}

function addAmpToRack(ampId) {
  if (!_currentRack) return;
  const amp = _ampCatalog.find(a => a.id === ampId);
  if (!amp) return;
  const uH = amp.formFactor?.rackUnits ?? 1;
  const uStart = findFreeSlot(uH);
  if (uStart === null) {
    showToast(`Rack full — no contiguous ${uH}U slot free.`);
    return;
  }
  const channelCount = amp.electrical?.channelCount ?? 0;
  _currentRack.slots.push({
    uStart, uHeight: uH,
    amplifierId: ampId,
    label: amp.model,
    channelAssignments: Array.from({ length: channelCount }, (_, i) => ({
      ch: i + 1, zoneId: null, tap_w: 0,
    })),
  });
  persistCurrentRack();
  renderRackMid();
}

function removeSlot(slotIdx) {
  if (!_currentRack) return;
  _currentRack.slots.splice(slotIdx, 1);
  persistCurrentRack();
  renderRackMid();
}

function renderRackMid() {
  const titleEl = document.getElementById('rack-mid-title');
  const summaryEl = document.getElementById('rack-mid-summary');
  const listEl = document.getElementById('rack-slot-list');
  const placeBtn = document.getElementById('rack-action-place');
  const discardBtn = document.getElementById('rack-action-discard');
  if (!_currentRack) {
    titleEl.textContent = 'No rack selected';
    summaryEl.textContent = 'Pick a rack frame from the left to start building.';
    listEl.innerHTML = '';
    placeBtn.disabled = true;
    discardBtn.disabled = true;
    return;
  }
  const def = _rackCatalogue.racks[_currentRack.rackModelKey];
  const totalU = def?.u ?? 0;
  const usedU = _currentRack.slots.reduce((a, s) => a + s.uHeight, 0);
  const totalPower = _currentRack.slots.reduce((a, s) => {
    const amp = _ampCatalog.find(x => x.id === s.amplifierId);
    const p = (amp?.electrical?.ratedPower_w_per_ch ?? 0) * (amp?.electrical?.channelCount ?? 0);
    return a + p;
  }, 0);
  titleEl.textContent = `${_currentRack.label} (${_currentRack.rackModelKey})`;
  summaryEl.textContent = `${usedU} / ${totalU} U used · ${totalPower} W rated · ${_currentRack.slots.length} amp${_currentRack.slots.length === 1 ? '' : 's'}`;
  // Render slot list, top-down so it reads like a rack from the front.
  // Highest U at the top of the list.
  const sorted = [..._currentRack.slots]
    .map((s, i) => ({ ...s, originalIdx: i }))
    .sort((a, b) => b.uStart - a.uStart);
  listEl.innerHTML = sorted.map(s => {
    const amp = _ampCatalog.find(x => x.id === s.amplifierId);
    return `
      <div class="rack-slot">
        <div class="rack-slot-u">U${s.uStart}${s.uHeight > 1 ? `–${s.uStart + s.uHeight - 1}` : ''}</div>
        <div class="rack-slot-body">
          <strong>${escapeHtml(s.label)}</strong>
          <span>${amp?.electrical?.channelCount ?? '?'}-ch · ${amp?.electrical?.ratedPower_w_per_ch ?? '?'} W · ${escapeHtml(amp?.electrical?.outputType ?? '')}</span>
        </div>
        <button class="rack-slot-remove" data-slot-idx="${s.originalIdx}" title="Remove from rack">×</button>
      </div>
    `;
  }).join('') || '<p class="rack-empty">Rack empty. Pick an amplifier from the left.</p>';
  listEl.querySelectorAll('.rack-slot-remove').forEach(btn => {
    btn.addEventListener('click', () => removeSlot(parseInt(btn.dataset.slotIdx, 10)));
  });
  placeBtn.disabled = _currentRack.slots.length === 0;
  discardBtn.disabled = false;

  // Keep the 3D preview in sync — every renderRackMid call follows a
  // state mutation (addAmpToRack, removeSlot, startNewRack, place, discard).
  updatePreview();
}

// Populate the place-target dropdown with "Current scene" + every
// saved custom room. Called on mount and after each save mutates the
// list (place to a saved room → rebuild so its rack count reflects).
function renderTargetRoomSelect() {
  const sel = document.getElementById('rack-target-room');
  if (!sel) return;
  const previous = sel.value || '__current__';
  const sceneLabel = (typeof state.projectName === 'string' && state.projectName.trim())
    ? state.projectName.trim()
    : 'Untitled scene';
  const sceneRackCount = (state.rackSystem?.racks ?? []).length;
  const opts = [
    `<option value="__current__">Current scene · ${escapeHtml(sceneLabel)} (${sceneRackCount} rack${sceneRackCount === 1 ? '' : 's'})</option>`,
  ];
  const savedRooms = listCustomRooms();
  // Diagnostic — if the dropdown looks empty after creating a custom
  // room, this log tells you whether the localStorage read came back
  // empty (storage issue) or returned entries (rendering issue).
  console.info('[devicelab] dropdown refresh — saved rooms:',
    savedRooms.length, savedRooms.map(e => e.roomName));
  for (const entry of savedRooms) {
    const n = (entry.rackSystem?.racks ?? []).length;
    const label = entry.roomName || 'Untitled';
    const proj = entry.projectName ? ` · ${entry.projectName}` : '';
    opts.push(
      `<option value="${escapeAttr(entry.id)}">Saved: ${escapeHtml(label)}${escapeHtml(proj)} (${n} rack${n === 1 ? '' : 's'})</option>`
    );
  }
  sel.innerHTML = opts.join('');
  // Restore previous selection if it still exists, else fall back to current.
  if ([...sel.options].some(o => o.value === previous)) sel.value = previous;
  else sel.value = '__current__';
}

function placeCurrentRack() {
  if (!_currentRack || _currentRack.slots.length === 0) return;
  const targetEl = document.getElementById('rack-target-room');
  const target = targetEl?.value || '__current__';
  const rackCopy = JSON.parse(JSON.stringify(_currentRack));

  if (target === '__current__') {
    // Live placement: into state.rackSystem so RoomLAB renders it
    // immediately when the user flips back.
    ensureRackSystem().racks.push(rackCopy);
    emit('rack:changed');
  } else {
    // Saved-room placement: append to that entry's rackSystem in
    // localStorage. The rack only appears in 3D once the user clicks
    // that room's chip in RoomLAB (which loads its rackSystem into
    // state). No live emit because state.rackSystem isn't touched.
    const entry = listCustomRooms().find(e => e.id === target);
    if (entry) {
      const existingRacks = Array.isArray(entry.rackSystem?.racks) ? entry.rackSystem.racks : [];
      updateCustomRoom(target, {
        rackSystem: { racks: [...existingRacks, rackCopy] },
      });
    }
  }

  _currentRack = null;
  persistCurrentRack();   // clear the in-progress slot in lab storage
  renderRackMid();
  renderAmpList(document.getElementById('rack-amp-search').value);
  updatePreview();
  renderSystemOverview();
  renderTargetRoomSelect();
  // emit('rack:changed') already fired inside the __current__ branch.
  // No event for saved-room placements — state.rackSystem wasn't
  // touched, so no live re-render is needed.
  showHandoffToast(target);
}

function discardCurrentRack() {
  _currentRack = null;
  persistCurrentRack();
  renderRackMid();
  renderAmpList(document.getElementById('rack-amp-search').value);
  updatePreview();
}

function renderSystemOverview() {
  const root = document.getElementById('rack-system-list');
  if (!root) return;
  const racks = ensureRackSystem().racks;
  if (racks.length === 0) {
    root.innerHTML = `
      <p class="rack-empty">No racks placed in this room yet.</p>
      <a class="rack-go-roomlab" href="#/room" title="Open RoomLAB to see the room you're designing for">
        Open RoomLAB →
      </a>
    `;
    return;
  }
  // With placed racks: prepend a clear handoff CTA so the user knows
  // exactly where to look at the rack in 3D context.
  root.innerHTML = `
    <a class="rack-go-roomlab" href="#/room" title="Open RoomLAB to see these racks placed in the 3D room">
      View in RoomLAB →
    </a>
  ` + racks.map((r, i) => {
    const def = _rackCatalogue?.racks?.[r.rackModelKey];
    const totalU = def?.u ?? 0;
    const usedU = (r.slots ?? []).reduce((a, s) => a + (s.uHeight ?? 1), 0);
    return `
      <div class="rack-system-item">
        <div><strong>${escapeHtml(r.label || `Rack ${i + 1}`)}</strong></div>
        <div class="pr-mute">${r.rackModelKey} · ${usedU} / ${totalU} U · ${(r.slots || []).length} amps</div>
        <button class="rack-system-remove" data-rack-idx="${i}" title="Remove rack from room">remove</button>
      </div>
    `;
  }).join('');
  root.querySelectorAll('.rack-system-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.rackIdx, 10);
      ensureRackSystem().racks.splice(idx, 1);
      renderSystemOverview();
      emit('rack:changed');
    });
  });
}

// Action-toast shown right after "Place in room" — primary CTA is to
// jump to RoomLAB so the user actually sees the rack land in the
// scene. Secondary path is "Stay" which auto-dismisses after 6 s so
// nothing clutters the UI permanently if they want to keep building.
function showHandoffToast(target = '__current__') {
  document.querySelectorAll('.rl-toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'rl-toast rl-toast-ok rl-toast-handoff';
  if (target === '__current__') {
    // Live placement: rack is already in state, prompt user to view it.
    el.innerHTML = `
      <span class="rl-toast-msg">Rack placed in current scene.</span>
      <a class="rl-toast-action" href="#/room">View in RoomLAB →</a>
    `;
  } else {
    // Saved-room placement: rack lives in that room's saved entry,
    // user needs to click the chip in RoomLAB to load it.
    const entry = listCustomRooms().find(e => e.id === target);
    const name = entry?.roomName || 'Saved room';
    el.innerHTML = `
      <span class="rl-toast-msg">Rack saved to <strong>${escapeHtml(name)}</strong>. Click that room's chip in RoomLAB to load it.</span>
      <a class="rl-toast-action" href="#/room">Open RoomLAB →</a>
    `;
  }
  document.body.appendChild(el);
  void el.offsetHeight;
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 6000);
}

// Lightweight toast (separate from panel-room's showToast — that's
// inside panel-room module scope).
function showToast(text) {
  document.querySelectorAll('.rl-toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'rl-toast rl-toast-ok';
  el.textContent = text;
  document.body.appendChild(el);
  void el.offsetHeight;
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 2500);
}
