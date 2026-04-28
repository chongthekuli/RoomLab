// DeviceLAB — boot script for devices.html.
//
// DeviceLAB is the standalone PA equipment workbench: rack frames,
// amplifiers, signal-chain. Phase 2 ships the rack builder feature
// that previously lived inside RoomLAB's viewport. The rack data is
// shared with RoomLAB through the cross-Lab autosave so a rack the
// user assembles here renders in the room next time they open it.
//
// What's NOT here yet:
//   - Saved-assembly LIBRARY (templates independent of any scene) —
//     planned for Phase 2.5 once IndexedDB is wired.
//   - Speaker-on-rack mapping for the signal chain.
//   - DSP/EQ blocks ahead of amplifiers.

import { mountHeaderNav } from '../../shared/header-nav.js';
import { mountRackPanel } from './panel-rack.js';

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.json();
}

async function boot() {
  mountHeaderNav({ activeLab: 'device' });

  const [rackCatalogue, ampCatalog] = await Promise.all([
    loadJSON('data/racks/catalogue.json').catch(err => {
      console.warn('rack catalogue missing', err);
      return null;
    }),
    loadJSON('data/amplifiers/catalog.json').catch(err => {
      console.warn('amp catalogue missing', err);
      return null;
    }),
  ]);

  mountRackPanel({ rackCatalogue, ampCatalog });
}

boot().catch(err => {
  console.error('DeviceLAB boot failed:', err);
  const root = document.getElementById('view-rack');
  if (root) {
    root.innerHTML = `<div class="rack-empty"><h3>Boot failed</h3><pre>${String(err?.stack ?? err)}</pre></div>`;
  }
});
