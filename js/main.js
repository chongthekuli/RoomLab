import { state, SPEAKER_CATALOG, DEFAULT_PRESET_KEY, applyPresetToState } from './app-state.js';
import { loadMaterials } from './physics/materials.js';
import { loadLoudspeaker } from './physics/loudspeaker.js';
import { mountRoomPanel } from './ui/panel-room.js';
import { mountSourcesPanel } from './ui/panel-sources.js';
import { mountListenersPanel } from './ui/panel-listeners.js';
import { mountZonesPanel } from './ui/panel-zones.js';
import { mountResultsPanel } from './ui/panel-results.js';
import { mount2DViewport } from './graphics/room-2d.js';
import { mount3DViewport, toggleHeatmaps, toggleAimLines, toggleIsobars, toggleProbe, toggleReverbField, setWalkthroughMode } from './graphics/scene.js';

function setupTabs() {
  const tabs = document.querySelectorAll('.vp-tab');
  const views = document.querySelectorAll('.viewport-view');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.view;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      // Walkthrough shares the 3D viewport container — it just swaps the
      // camera. Any view other than "walk" exits walkthrough mode.
      const visibleViewId = target === 'walk' ? 'view-3d' : `view-${target}`;
      views.forEach(v => { v.hidden = v.id !== visibleViewId; });
      setWalkthroughMode(target === 'walk');
      document.dispatchEvent(new CustomEvent('viewport:tab-changed', { detail: { view: target } }));
    });
  });

  const heatBtn = document.getElementById('toggle-heatmaps');
  if (heatBtn) {
    heatBtn.addEventListener('click', () => {
      toggleHeatmaps();
      heatBtn.classList.toggle('active', state.display.showHeatmaps);
    });
  }

  const aimBtn = document.getElementById('toggle-aim-lines');
  if (aimBtn) {
    aimBtn.addEventListener('click', () => {
      toggleAimLines();
      aimBtn.classList.toggle('active', state.display.showAimLines);
    });
  }

  const isoBtn = document.getElementById('toggle-isobars');
  if (isoBtn) {
    isoBtn.addEventListener('click', () => {
      toggleIsobars();
      isoBtn.classList.toggle('active', state.display.showIsobars);
    });
  }

  const probeBtn = document.getElementById('toggle-probe');
  if (probeBtn) {
    probeBtn.addEventListener('click', () => {
      toggleProbe();
      probeBtn.classList.toggle('active');
    });
  }

  const reverbBtn = document.getElementById('toggle-reverb');
  if (reverbBtn) {
    reverbBtn.addEventListener('click', () => {
      toggleReverbField();
      reverbBtn.classList.toggle('active', state.physics.reverberantField);
    });
  }
}

async function boot() {
  const materials = await loadMaterials();
  await Promise.all(SPEAKER_CATALOG.map(c => loadLoudspeaker(c.url)));

  // Pristine state → apply default preset
  if (state.sources.length === 0 && state.listeners.length === 0 && state.zones.length === 0) {
    applyPresetToState(DEFAULT_PRESET_KEY);
  }

  setupTabs();
  mountRoomPanel({ materials });
  mountSourcesPanel({ speakerCatalog: SPEAKER_CATALOG });
  mountListenersPanel();
  mountZonesPanel({ materials });
  mountResultsPanel({ materials });
  mount2DViewport({ materials });

  try {
    await mount3DViewport({ materials });
  } catch (err) {
    console.error('3D viewport failed to mount:', err);
    const v3 = document.getElementById('view-3d');
    if (v3) v3.innerHTML = `<div class="viewport-2d"><div class="vp-header">3D view unavailable: ${err.message}</div></div>`;
  }
}

boot().catch(err => {
  console.error('RoomLAB boot failed', err);
  const vp = document.getElementById('view-2d') || document.getElementById('view-3d');
  if (vp) vp.innerHTML = `<div class="viewport-2d"><div class="vp-header">Startup error: ${err.message}</div></div>`;
});
