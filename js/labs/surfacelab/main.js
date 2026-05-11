// SurfaceLAB mount module — Lab #4. Lazy-mounted by the SPA router on
// the first #/surface visit. Catalogue spans plain materials (gypsum,
// brick, wood, carpet…) AND engineered acoustic-treatment products
// (RPG, Auralex, GIK, Vicoustic — diffusers, broadband absorbers,
// bass traps, ceiling tiles).
//
// Same architectural pattern as SpeakerLAB: mount the centre workbench
// + the rail-system; rail-panels show/hide via the shared rail-system
// data attributes; selection state lives in surface-detail.js.

import { mountSurfaceView } from './surface-detail.js';
import { mountRailSystem } from '../../ui/rail-system.js';

let _mounted = false;

export async function mountSurfaceLab() {
  if (_mounted) return;
  _mounted = true;

  await mountSurfaceView();

  // Clear stale rail-state from earlier sessions so the centre 3D
  // preview is unobstructed by default — same defensiveness as
  // SpeakerLAB.
  try {
    sessionStorage.removeItem('roomlab.rail.surface.left');
    sessionStorage.removeItem('roomlab.rail.surface.right');
  } catch (_) { /* private mode */ }

  mountRailSystem({ routeId: 'surface' });
}
