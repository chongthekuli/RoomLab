import { state } from './app-state.js';
import { loadMaterials } from './physics/materials.js';
import { loadLoudspeaker } from './physics/loudspeaker.js';
import { mountRoomPanel } from './ui/panel-room.js';
import { mountSourcesPanel } from './ui/panel-sources.js';
import { mountResultsPanel } from './ui/panel-results.js';
import { mount2DViewport } from './graphics/room-2d.js';
import { mount3DViewport } from './graphics/scene.js';

const SPEAKER_CATALOG = [
  { url: 'data/loudspeakers/generic-12inch.json',       label: 'Generic 12" 2-way' },
  { url: 'data/loudspeakers/compact-6inch.json',        label: 'Compact 6" monitor' },
  { url: 'data/loudspeakers/line-array-element.json',   label: 'Line-array element' },
];

function setupTabs() {
  const tabs = document.querySelectorAll('.vp-tab');
  const views = document.querySelectorAll('.viewport-view');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.view;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      views.forEach(v => {
        v.hidden = v.id !== `view-${target}`;
      });
      document.dispatchEvent(new CustomEvent('viewport:tab-changed', { detail: { view: target } }));
    });
  });
}

async function boot() {
  const materials = await loadMaterials();
  await Promise.all(SPEAKER_CATALOG.map(c => loadLoudspeaker(c.url)));

  if (state.sources.length === 0) {
    state.sources.push({
      modelUrl: SPEAKER_CATALOG[0].url,
      position: {
        x: state.room.width_m / 2,
        y: 1.5,
        z: Math.min(state.room.height_m - 0.3, 2.5),
      },
      aim: { yaw: 0, pitch: -15, roll: 0 },
      power_watts: 100,
    });
  }

  setupTabs();
  mountRoomPanel({ materials });
  mountSourcesPanel({ speakerCatalog: SPEAKER_CATALOG });
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
