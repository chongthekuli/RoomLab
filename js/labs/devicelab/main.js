// DeviceLAB mount module. Lazy-mounted by the SPA router the first
// time the user clicks the DeviceLAB pill.
//
// In the SPA shell DeviceLAB and RoomLAB share `state` directly, so
// rack edits propagate to the live 3D scene without any localStorage
// patching. Click "Place in room", flip back to RoomLAB, the rack is
// already in the scene — no page reload, no autosave round-trip.

import { mountRackPanel } from './panel-rack.js';
import { mountRailSystem } from '../../ui/rail-system.js';

let _mounted = false;

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.json();
}

export async function mountDeviceLab() {
  if (_mounted) return;
  _mounted = true;

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
  // P4 — viewport-first rails for DeviceLAB. Auto-open removed in
  // P4.6 — clear stale auto-open from prior sessions so the centre
  // rack editor is unobstructed by default.
  try {
    sessionStorage.removeItem('roomlab.rail.device.left');
    sessionStorage.removeItem('roomlab.rail.device.right');
  } catch (_) { /* private mode */ }
  mountRailSystem({ routeId: 'device' });
}
