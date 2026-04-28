// PA Rack Builder panel — minimal first-cut UI.
//
// Three-column layout per Felix Brandt's spec (RACK_BUILDER_DESIGN.md
// §3) — but rendered as columns inside the new "PA Rack" viewport tab,
// not in the left side panel. The user picks a rack frame, picks an
// amplifier from a filtered catalogue, adds amps to slots, then "Place
// in room" puts the rack into state.rackSystem.racks. Any state change
// emits 'rack:changed' and the main 3D viewport rebuilds the rack via
// scene.js's racksGroup.
//
// Out-of-scope for v1 (deferred to C4 / C5):
//   - drag-drop placement (current = click-to-add into next free slot)
//   - per-channel zone assignment (current = no zone wiring)
//   - validation banner (channels unused, thermal budget etc.)
//   - 3D preview INSIDE this tab — for v1 the user clicks "Place in
//     room" then switches to 3D View. C3 of the original spec adds the
//     isolated rack-scene preview here.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state } from '../app-state.js';
import { emit } from './events.js';
import { buildRackGroup } from '../graphics/rack-render.js';

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
  const root = document.getElementById('view-rack');
  if (!root) return;
  root.innerHTML = `
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

  renderFrameList();
  renderAmpList('');
  renderRackMid();
  renderSystemOverview();
  mountPreview();

  document.getElementById('rack-amp-search').addEventListener('input', (e) => {
    renderAmpList(e.target.value);
  });
  document.getElementById('rack-action-place').addEventListener('click', placeCurrentRack);
  document.getElementById('rack-action-discard').addEventListener('click', discardCurrentRack);

  // Re-render the preview when the user switches into the PA Rack tab —
  // it may have been hidden while the canvas was created so the
  // initial sizing was zero. document-level event broadcasts from
  // setupTabs in main.js.
  document.addEventListener('viewport:tab-changed', (e) => {
    if (e.detail?.view === 'rack') {
      // Defer one frame so the view is visible before resizing.
      requestAnimationFrame(() => { resizePreview(); updatePreview(); });
    }
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
  const host = document.getElementById('rack-preview');
  if (!host) return;
  // Renderer
  _previewRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  _previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(_previewRenderer.domElement);

  // Scene + camera
  _previewScene = new THREE.Scene();
  _previewScene.background = new THREE.Color(0x14171b);
  _previewCamera = new THREE.PerspectiveCamera(35, 1, 0.05, 30);
  _previewCamera.position.set(1.6, 1.2, 2.0);

  // Lighting — three-light archviz, scaled small for the rack preview
  const hemi = new THREE.HemisphereLight(0xb8c8e0, 0x2a2620, 0.55);
  _previewScene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff4e0, 0.95);
  key.position.set(2.5, 4, 2.5);
  _previewScene.add(key);
  const fill = new THREE.DirectionalLight(0xa8c0d8, 0.30);
  fill.position.set(-2, 2.5, -1.5);
  _previewScene.add(fill);
  const ambient = new THREE.AmbientLight(0xffffff, 0.18);
  _previewScene.add(ambient);

  // Floor — subtle so the rack reads grounded
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshStandardMaterial({ color: 0x1c2026, roughness: 0.85, metalness: 0.05 }),
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

// In-progress rack the user is currently building. Lives outside state
// until "Place in room" commits it. This means switching presets while
// building doesn't lose the user's work — they just need to remember
// to commit it. (The reverse — committing then switching presets —
// drops the rack as part of applyPresetToState's reset flow.)
let _currentRack = null;

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
  _currentRack = {
    id: 'R' + Date.now().toString(36),
    label: `${def.u}U rack`,
    rackModelKey: rackKey,
    position: { x: 0.6, y: 0.6, z: 0 },     // sensible corner default
    yaw_deg: 0,
    slots: [],
  };
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
  renderRackMid();
}

function removeSlot(slotIdx) {
  if (!_currentRack) return;
  _currentRack.slots.splice(slotIdx, 1);
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

function placeCurrentRack() {
  if (!_currentRack || _currentRack.slots.length === 0) return;
  if (!Array.isArray(state.rackSystem?.racks)) state.rackSystem = { racks: [] };
  state.rackSystem.racks.push(JSON.parse(JSON.stringify(_currentRack)));
  _currentRack = null;
  renderRackMid();
  renderAmpList(document.getElementById('rack-amp-search').value);
  updatePreview();
  renderSystemOverview();
  emit('rack:changed');
  // Switch viewport to 3D View so the user sees the placed rack.
  document.querySelector('.vp-tab[data-view="3d"]')?.click();
  showToast('Rack placed in room.');
}

function discardCurrentRack() {
  _currentRack = null;
  renderRackMid();
  renderAmpList(document.getElementById('rack-amp-search').value);
  updatePreview();
}

function renderSystemOverview() {
  const root = document.getElementById('rack-system-list');
  if (!root) return;
  const racks = state.rackSystem?.racks ?? [];
  if (racks.length === 0) {
    root.innerHTML = '<p class="rack-empty">No racks placed in this room yet.</p>';
    return;
  }
  root.innerHTML = racks.map((r, i) => {
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
      state.rackSystem.racks.splice(idx, 1);
      renderSystemOverview();
      emit('rack:changed');
    });
  });
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
