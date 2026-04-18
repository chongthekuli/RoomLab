import { loadMaterials } from './physics/materials.js';
import { mountRoomPanel } from './ui/panel-room.js';
import { mountResultsPanel } from './ui/panel-results.js';
import { mount2DViewport } from './graphics/room-2d.js';

async function boot() {
  const materials = await loadMaterials();
  mountRoomPanel({ materials });
  mountResultsPanel({ materials });
  mount2DViewport({ materials });
}

boot().catch(err => {
  console.error('RoomLAB boot failed', err);
  const vp = document.getElementById('viewport');
  if (vp) vp.innerHTML = `<div class="viewport-2d"><div class="vp-header">Startup error: ${err.message}</div></div>`;
});
