// SpeakerLAB — boot script for speakers.html.
//
// SpeakerLAB is a standalone Lab focused on the loudspeaker library
// alone — browse, inspect, compare. No room context, no SPL math, no
// 3D viewport. The cold-start cost is bounded by what this page needs
// (catalogue + spec viewer + polar/waterfall chart), not RoomLAB's
// full simulation stack.
//
// URL deep-link: `speakers.html?model=<modelUrl>` opens with that
// speaker pre-selected. RoomLAB's "View specs" buttons on each Source
// card use this convention.

import { mountHeaderNav } from '../../shared/header-nav.js';
import { SPEAKER_CATALOG, findCatalogEntry } from '../../shared/speaker-catalog.js';
import { loadLoudspeaker } from '../../physics/loudspeaker.js';
import { emit } from '../../shared/events.js';
import { mountSpeakerView, state as speakerState } from './speaker-detail.js';

async function boot() {
  mountHeaderNav({ activeLab: 'speaker' });

  // Pre-warm every catalogue speaker so the catalogue cards on the
  // left can show summary specs (sensitivity / max SPL / DI) without
  // waiting for individual fetches as the user clicks each card.
  // Quiet failures keep one missing JSON from blocking the rest.
  await Promise.all(SPEAKER_CATALOG.map(c =>
    loadLoudspeaker(c.url).catch(err => {
      console.warn(`SpeakerLAB: could not preload ${c.url}`, err);
      return null;
    }),
  ));

  // Resolve the deep-link target (?model=<url>). Two forms allowed:
  //   ?model=data/loudspeakers/amperes-cs610.json   (literal path)
  //   ?model=amperes-cs610                          (catalog-id shorthand — future)
  // For Phase 1 we only honour the literal form.
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('model');
  if (requested && findCatalogEntry(requested)) {
    speakerState.selectedSpeakerUrl = requested;
  }

  mountSpeakerView();
  // mountSpeakerView() calls render() once. If the deep-link picked a
  // model, the catalogue card highlights and the body paints the spec
  // view. If no deep-link, the empty-state copy invites the user to
  // pick one.
  if (speakerState.selectedSpeakerUrl) emit('speaker:selected');
}

boot().catch(err => {
  console.error('SpeakerLAB boot failed:', err);
  const root = document.getElementById('view-speaker');
  if (root) {
    root.innerHTML = `<div class="sv-empty"><h3>Boot failed</h3><pre>${String(err?.stack ?? err)}</pre></div>`;
  }
});
