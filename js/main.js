import { loadMaterials } from './physics/materials.js';
import { mountRoomPanel } from './ui/panel-room.js';
import { mountResultsPanel } from './ui/panel-results.js';

async function boot() {
  const materials = await loadMaterials();
  mountRoomPanel({ materials });
  mountResultsPanel({ materials });

  document.getElementById('viewport').innerHTML = `
    <div class="viewport-empty">
      <div class="title">3D viewport — Phase 3</div>
      <div class="sub">Change room dimensions or a surface material on the left.<br>
      Reverberation time updates live on the right.</div>
    </div>
  `;
}

boot().catch(err => {
  console.error('RoomLAB boot failed', err);
  const vp = document.getElementById('viewport');
  if (vp) vp.innerHTML = `<div class="viewport-empty"><div class="title">Startup error</div><div class="sub">${err.message}</div></div>`;
});
