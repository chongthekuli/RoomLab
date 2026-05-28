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
  // v=694 layout: full-bleed 3D preview as the main view (like RoomLAB).
  // Left rail splits into "Rack frames" and "Amplifiers" as separate
  // panels. The currently-edited rack's slot list + place/discard
  // actions move to the right rail "System overview" panel. The
  // editing-context banner ("Editing racks for …") becomes a small
  // floating overlay so it doesn't eat vertical space.
  root.innerHTML = `
    <div class="rack-builder">
      <section class="rack-col-mid">
        <div class="rack-preview" id="rack-preview">
          <div class="rack-vp-overlay-top">
            <div class="rack-vp-ctx" title="${escapeHtml(ctx.name)} — ${escapeHtml(ctx.meta)}">
              <span class="rack-vp-ctx-label">Editing racks for</span>
              <span class="rack-vp-ctx-name">${escapeHtml(ctx.name)}</span>
              <a class="rack-vp-ctx-back" href="#/room" title="Open RoomLAB">View room →</a>
            </div>
            <div class="rack-vp-door-segment">
              <button class="rack-vp-door-tab" id="rack-mid-door-toggle" style="display:none" title="Open or close the FRONT door (mesh-glass)">Open front</button>
              <button class="rack-vp-door-tab" id="rack-mid-rear-door-toggle" style="display:none" title="Open or close the REAR door (perforated steel)">Open rear</button>
            </div>
            <div class="rack-vp-title">
              <span class="rack-mid-title" id="rack-mid-title">No rack selected</span>
              <span class="rack-mid-summary" id="rack-mid-summary"></span>
            </div>
          </div>
        </div>
      </section>
      <!-- Hidden detached panels — moved into rails by the mount logic
           below. Keeping them inside .rack-builder before the move keeps
           the HTML self-contained and easy to read. -->
      <aside class="rack-col-frames" hidden>
        <h3>Rack frames</h3>
        <div class="rack-frame-list" id="rack-frame-list"></div>
      </aside>
      <aside class="rack-col-amps" hidden>
        <h3>Amplifiers</h3>
        <div class="rack-amp-filter">
          <input id="rack-amp-search" placeholder="Search models / categories…" />
        </div>
        <div class="rack-amp-list" id="rack-amp-list"></div>
      </aside>
      <aside class="rack-col-right" hidden>
        <h3>System overview</h3>
        <div class="rack-system-list" id="rack-system-list"></div>
        <div class="rack-slot-list-wrap">
          <h3>Current rack contents</h3>
          <div class="rack-slot-list" id="rack-slot-list"></div>
        </div>
        <div class="rack-mid-actions">
          <label class="rack-target-label" for="rack-target-room">Place in:</label>
          <select id="rack-target-room" class="rack-target-room"
                  title="Pick which room receives this rack. The current scene shows it live in 3D the moment you click Place. A saved custom room stores the rack inside that room's saved entry — it appears in 3D when you click that room's chip in RoomLAB.">
            <option value="__current__">Current scene</option>
          </select>
          <button class="rack-action rack-action-place" id="rack-action-place" disabled>Place in room</button>
          <button class="rack-action rack-action-discard" id="rack-action-discard" disabled>Discard rack</button>
        </div>
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

  // v=694 — relocate detached panels into rails. The centre column
  // now hosts JUST the 3D preview + the floating-overlay top bar. The
  // three side panels (rack frames, amps, system overview + slot
  // editor) move into their respective rail panels.
  const colFrames = root.querySelector('.rack-col-frames');
  const colAmps   = root.querySelector('.rack-col-amps');
  const colRight  = root.querySelector('.rack-col-right');
  const railRackBrowser = document.getElementById('panel-rackbrowser');
  const railAmplifiers  = document.getElementById('panel-amplifiers');
  const railBom         = document.getElementById('panel-bom');
  if (colFrames && railRackBrowser) {
    railRackBrowser.innerHTML = '<h2>Rack frames</h2>';
    colFrames.hidden = false;
    railRackBrowser.appendChild(colFrames);
  }
  if (colAmps && railAmplifiers) {
    railAmplifiers.innerHTML = '<h2>Amplifiers</h2>';
    colAmps.hidden = false;
    railAmplifiers.appendChild(colAmps);
  }
  if (colRight && railBom) {
    railBom.innerHTML = '<h2>System overview</h2>';
    colRight.hidden = false;
    railBom.appendChild(colRight);
  }
}

// ---- 3D preview (isolated Three.js scene) ------------------------------
let _previewScene = null;
let _previewCamera = null;
let _previewRenderer = null;
let _previewControls = null;
let _previewRackGroup = null;
let _previewRAF = 0;

// Camera tween — drives the front/rear viewpoint swap when the user
// clicks Open-front / Open-rear. Lerps camera.position + controls.target
// over ~500 ms with smoothstep ease so the swing animation on the
// chosen door is visible from the corresponding side.
let _camTween = null;     // { p0, p1, t0, t1, dur, ts0 }
const PREVIEW_CAM_VIEWS = {
  // Rack-render coord frame: front face at -Z, rear at +Z.
  front: { pos: [+0.9, +1.6, -2.4], target: [0, 1.0,  0] },
  rear:  { pos: [-0.9, +1.6, +2.4], target: [0, 1.0,  0] },
};
function _setPreviewCameraView(viewKey, animate = true) {
  if (!_previewCamera || !_previewControls) return;
  const view = PREVIEW_CAM_VIEWS[viewKey];
  if (!view) return;
  // v=707 design: no skip-detection. The function does exactly what it
  // says — tween (or snap) to the named preset. Skip logic is the
  // caller's responsibility (door buttons always tween; amp-add never
  // calls this function). v=702/703/705/706 all tried to "be smart"
  // about whether the camera was already at the right view; the smart
  // checks all had corner cases (zoom, damping, orbit angle,
  // OrbitControls events firing on stray clicks). A predictable
  // unconditional tween is preferable to clever-but-flaky.
  if (!animate) {
    _previewCamera.position.set(view.pos[0], view.pos[1], view.pos[2]);
    _previewControls.target.set(view.target[0], view.target[1], view.target[2]);
    _previewControls.update();
    _camTween = null;
    return;
  }
  _camTween = {
    p0: _previewCamera.position.clone(),
    p1: { x: view.pos[0], y: view.pos[1], z: view.pos[2] },
    t0: _previewControls.target.clone(),
    t1: { x: view.target[0], y: view.target[1], z: view.target[2] },
    dur: 500,
    ts0: performance.now(),
  };
}
function _tickCameraTween() {
  if (!_camTween) return;
  const t = Math.min(1, (performance.now() - _camTween.ts0) / _camTween.dur);
  const e = t * t * (3 - 2 * t);   // smoothstep
  _previewCamera.position.set(
    _camTween.p0.x + (_camTween.p1.x - _camTween.p0.x) * e,
    _camTween.p0.y + (_camTween.p1.y - _camTween.p0.y) * e,
    _camTween.p0.z + (_camTween.p1.z - _camTween.p0.z) * e,
  );
  _previewControls.target.set(
    _camTween.t0.x + (_camTween.t1.x - _camTween.t0.x) * e,
    _camTween.t0.y + (_camTween.t1.y - _camTween.t0.y) * e,
    _camTween.t0.z + (_camTween.t1.z - _camTween.t0.z) * e,
  );
  if (t >= 1) _camTween = null;
}

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
  // Initial camera position pulled from PREVIEW_CAM_VIEWS.front so the
  // Open-front / Open-rear tween (v=693) shares one set of view
  // presets with the default-load view.
  _previewCamera.position.set(
    PREVIEW_CAM_VIEWS.front.pos[0],
    PREVIEW_CAM_VIEWS.front.pos[1],
    PREVIEW_CAM_VIEWS.front.pos[2],
  );

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
  _previewControls.target.set(
    PREVIEW_CAM_VIEWS.front.target[0],
    PREVIEW_CAM_VIEWS.front.target[1],
    PREVIEW_CAM_VIEWS.front.target[2],
  );

  resizePreview();
  window.addEventListener('resize', resizePreview);
  // ResizeObserver picks up panel-column resize from CSS too
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resizePreview).observe(host);
  }

  // Animation loop — only ticks while the tab is visible to save cycles.
  // Also drives the camera-tween used by Open-front / Open-rear so the
  // user is repositioned to face whichever door they're opening.
  const tick = () => {
    _previewRAF = requestAnimationFrame(tick);
    if (!host.offsetParent) return; // hidden tab
    _tickCameraTween();
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
  // v=708 — auto-tween to the FRONT view on amp-add so the user can
  // see the just-added amp's labels / knobs / mounting ears (all on
  // the -Z face per the v=691 panel flip). User's latest UAT confirmed
  // door-button front/rear identities are correct, so PREVIEW_CAM
  // _VIEWS.front IS the side with the amp panel visible.
  // No skip-detection: always tween. The earlier skip-detection
  // attempts (v=702/703/705/706) all had corner cases that produced
  // worse UX than the unconditional tween. Predictable beats clever.
  _setPreviewCameraView('front', true);
}

function removeSlot(slotIdx) {
  if (!_currentRack) return;
  _currentRack.slots.splice(slotIdx, 1);
  persistCurrentRack();
  renderRackMid();
  _setPreviewCameraView('front', true);
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
  // Door-toggle buttons in the rack editor — only relevant on enclosed
  // racks. Live-sync to the preview's 3D mesh. Two independent buttons
  // (front + rear) since the user wanted both doors open/closable.
  const doorBtnEl = document.getElementById('rack-mid-door-toggle');
  const rearBtnEl = document.getElementById('rack-mid-rear-door-toggle');
  const isEnclosed = (def?.style ?? 'open-frame') === 'enclosed';
  // Hide the whole floating pill when no enclosed rack is selected
  // (otherwise an empty 8 px box hangs at the top-centre of the viewport).
  const doorSegEl = doorBtnEl?.parentElement;
  if (doorSegEl) doorSegEl.hidden = !isEnclosed;
  if (doorBtnEl) {
    if (isEnclosed) {
      doorBtnEl.style.display = '';
      doorBtnEl.textContent = _currentRack.doorOpen ? 'Close front' : 'Open front';
      doorBtnEl.onclick = () => {
        _currentRack.doorOpen = !_currentRack.doorOpen;
        // Tween camera to the FRONT view whenever the user touches the
        // front door — they want to SEE the swing happen, not have to
        // orbit the camera manually first. Tween fires whether opening
        // or closing so the affected side is on-screen either way.
        _setPreviewCameraView('front', true);
        persistCurrentRack();
        renderRackMid();
      };
    } else {
      doorBtnEl.style.display = 'none';
    }
  }
  if (rearBtnEl) {
    if (isEnclosed) {
      rearBtnEl.style.display = '';
      rearBtnEl.textContent = _currentRack.rearDoorOpen ? 'Close rear' : 'Open rear';
      rearBtnEl.onclick = () => {
        _currentRack.rearDoorOpen = !_currentRack.rearDoorOpen;
        // Same idea — opening the rear door swings on the +Z side, so
        // we put the camera over there too.
        _setPreviewCameraView('rear', true);
        persistCurrentRack();
        renderRackMid();
      };
    } else {
      rearBtnEl.style.display = 'none';
    }
  }
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
  // Default position = room centre (state.x, state.y) if the editor
  // didn't carry one. This fires on a fresh Place (rack was just
  // built in DeviceLAB) where the user never picked a 2D location
  // before. Edit-in-place flow (below) preserves the existing
  // position because the rack was loaded WITH it.
  if (!rackCopy.position) {
    const cx = (state.room?.width_m ?? 8) / 2;
    const cy = (state.room?.depth_m ?? 8) / 2;
    rackCopy.position = { x: cx, y: cy, z: 0 };
  }
  if (!Number.isFinite(rackCopy.yaw_deg)) rackCopy.yaw_deg = 0;

  if (target === '__current__') {
    // Live placement: into state.rackSystem so RoomLAB renders it
    // immediately when the user flips back. Edit-in-place semantics:
    // when the rack already exists in the system (we loaded it from
    // there via Edit), REPLACE that entry by id instead of pushing
    // a new one. Without this, every "Place in room" would duplicate
    // the rack the user thought they were just editing.
    const racks = ensureRackSystem().racks;
    const existingIdx = racks.findIndex(r => r?.id && r.id === rackCopy.id);
    if (existingIdx >= 0) racks[existingIdx] = rackCopy;
    else racks.push(rackCopy);
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
    // Door open/close buttons — only meaningful on enclosed racks. Two
    // independent buttons so the user can open front, rear, or both.
    const isEnclosed = (def?.style ?? 'open-frame') === 'enclosed';
    const doorBtns = isEnclosed
      ? `<button class="rack-door-toggle" data-rack-idx="${i}" data-door="front" title="Open or close the FRONT door (mesh-glass)">${r.doorOpen ? 'Close front' : 'Open front'}</button>
         <button class="rack-door-toggle" data-rack-idx="${i}" data-door="rear" title="Open or close the REAR door (perforated steel)">${r.rearDoorOpen ? 'Close rear' : 'Open rear'}</button>`
      : '';
    return `
      <div class="rack-system-item">
        <div><strong>${escapeHtml(r.label || `Rack ${i + 1}`)}</strong></div>
        <div class="pr-mute">${r.rackModelKey} · ${usedU} / ${totalU} U · ${(r.slots || []).length} amps</div>
        ${doorBtns}
        <button class="rack-system-edit" data-rack-idx="${i}" title="Load this placed rack back into the editor — change amps, rotate, then Place to update in place">edit</button>
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
  root.querySelectorAll('.rack-door-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.rackIdx, 10);
      const rack = ensureRackSystem().racks[idx];
      if (!rack) return;
      const which = btn.dataset.door;     // 'front' | 'rear'
      if (which === 'rear') rack.rearDoorOpen = !rack.rearDoorOpen;
      else                  rack.doorOpen     = !rack.doorOpen;
      renderSystemOverview();
      emit('rack:changed');
    });
  });
  // "Edit" button — load a placed rack back into the editor (deep-clone
  // so accidental edits don't leak into the placed copy until the user
  // hits Place again). placeCurrentRack() will UPDATE the original by
  // matching id rather than appending a new one.
  root.querySelectorAll('.rack-system-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.rackIdx, 10);
      const placed = ensureRackSystem().racks[idx];
      if (!placed) return;
      _currentRack = JSON.parse(JSON.stringify(placed));
      // Strip ephemeral viewer state so the editor doesn't carry it
      // back when re-placing. Door-open is an inspection toggle on
      // the placed rack; the editor preview rebuilds with its own
      // doorOpen state from scratch.
      delete _currentRack.doorOpen;
      delete _currentRack.rearDoorOpen;
      persistCurrentRack();
      renderRackMid();
      renderAmpList(document.getElementById('rack-amp-search').value);
      updatePreview();
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
