import { state } from './app-state.js';
import { loadMaterials } from './physics/materials.js';
import { loadLoudspeaker } from './physics/loudspeaker.js';
import { mountRoomPanel } from './ui/panel-room.js';
import { mountSourcesPanel } from './ui/panel-sources.js';
import { mountResultsPanel } from './ui/panel-results.js';
import { mount2DViewport } from './graphics/room-2d.js';

const SPEAKER_CATALOG = [
  { url: 'data/loudspeakers/generic-12inch.json', label: 'Generic 12" 2-way' },
];

async function boot() {
  const materials = await loadMaterials();
  await loadLoudspeaker(SPEAKER_CATALOG[0].url);

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

  mountRoomPanel({ materials });
  mountSourcesPanel({ speakerCatalog: SPEAKER_CATALOG });
  mountResultsPanel({ materials });
  mount2DViewport({ materials });
}

boot().catch(err => {
  console.error('RoomLAB boot failed', err);
  const vp = document.getElementById('viewport');
  if (vp) vp.innerHTML = `<div class="viewport-2d"><div class="vp-header">Startup error: ${err.message}</div></div>`;
});
