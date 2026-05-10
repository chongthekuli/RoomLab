// SpeakerLAB mount module. Lazy-mounted by the SPA router the first
// time the user clicks the SpeakerLAB pill.
//
// SpeakerLAB is the loudspeaker-library Lab — browse, inspect,
// compare. No room context, no SPL math beyond directivity charts.
// The catalogue is preloaded on first mount so cards can show
// summary specs synchronously; subsequent route visits are instant
// because the DOM stays in place.

import { SPEAKER_CATALOG, findCatalogEntry } from '../../shared/speaker-catalog.js';
import { loadLoudspeaker } from '../../physics/loudspeaker.js';
import { emit } from '../../shared/events.js';
import { mountSpeakerView, state as speakerState } from './speaker-detail.js';
import { mountRailSystem } from '../../ui/rail-system.js';

let _mounted = false;

export async function mountSpeakerLab() {
  if (_mounted) return;
  _mounted = true;

  await Promise.all(SPEAKER_CATALOG.map(c =>
    loadLoudspeaker(c.url).catch(err => {
      console.warn(`SpeakerLAB: could not preload ${c.url}`, err);
      return null;
    }),
  ));

  // Deep-link via ?model=<url>. The query string survives hash routing
  // (#/speaker?model=foo doesn't put model into search, so we read
  // from window.location.search directly — set by the back-compat
  // redirect from the legacy speakers.html?model=... URL too).
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('model');
  if (requested && findCatalogEntry(requested) && !speakerState.selectedSpeakerUrl) {
    speakerState.selectedSpeakerUrl = requested;
  }

  mountSpeakerView();
  // P4 — viewport-first rails for SpeakerLAB. Same mechanism as
  // RoomLAB; per-lab manifest determines which icons/panels appear.
  // P4.6 — auto-open removed per user feedback. Clear any stale
  // auto-open value left from a prior session before mounting the
  // rail system so the centre 3D preview is unobstructed by default.
  // Maps to the now-deleted rail IDs from earlier iterations too
  // (speakerspec → specs; if a user has the old key, drop it.)
  try {
    sessionStorage.removeItem('roomlab.rail.speaker.left');
    sessionStorage.removeItem('roomlab.rail.speaker.right');
  } catch (_) { /* private mode */ }
  mountRailSystem({ routeId: 'speaker' });
  if (speakerState.selectedSpeakerUrl) emit('speaker:selected');
}
