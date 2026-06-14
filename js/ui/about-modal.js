// js/ui/about-modal.js
// ---------------------------------------------------------------------------
// The "About AuraLAB" modal, opened from the header user menu. A professional
// product page: logo + name + tagline + version, a short "what it is"
// paragraph, the standards it references (as reference chips), a compressed
// not-certified disclaimer, and a footer.
//
// Copy mirrors the Terms-of-Use voice (declarative, engineer-tone). The
// disclaimer reuses the load-bearing phrases already accepted on the sign-in
// Terms ("simulations, not measurements"; "engineering judgement remains with
// you"; "calibrated instruments") — a deliberate compression, not new claims.
// ---------------------------------------------------------------------------

import { openModal } from './modal-shell.js';

const STANDARDS = [
  'ISO 3382-1', 'ISO 9613-1', 'IEC 60268-16:2020', 'ISO 17497-2',
  'Sabine', 'Eyring', 'Schroeder', 'Beranek',
];

// Read the deployed cache-bust version off the live main.css <link>. The JS
// module graph is imported without a ?v= param, so import.meta.url has none —
// the stylesheet link is the reliable source of the shipped version.
function cacheVersion() {
  try {
    const link = document.querySelector('link[rel="stylesheet"][href*="main.css"]');
    const v = link && new URL(link.href, location.href).searchParams.get('v');
    return v || null;
  } catch (_) { return null; }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function buildBodyHtml() {
  const v = cacheVersion();
  const versionLine = v ? `Version ${escapeHtml(v)}` : 'Version —';
  const chips = STANDARDS
    .map((s) => `<li class="about-chip">${escapeHtml(s)}</li>`)
    .join('');
  return `
    <div class="about-modal">
      <div class="about-hero">
        <img class="about-logo" src="assets/logo/AuraLAB-logo-1024.png" alt="AuraLAB" width="56" height="56" />
        <div class="about-hero-text">
          <h2 class="about-name" id="about-title">AuraLAB</h2>
          <p class="about-tagline">Acoustic prediction for rooms and PA systems, in the browser.</p>
          <p class="about-version">${versionLine}</p>
        </div>
      </div>

      <p class="about-body">
        AuraLAB models how sound behaves in a space — reverberation time, speech
        intelligibility, and sound-pressure coverage — from a geometry, materials,
        and loudspeaker description you build in the browser. It is a design and
        teaching instrument for acousticians, AV designers, and architects,
        intended to inform decisions early, before measurement.
      </p>

      <h3 class="about-subhead">Standards referenced</h3>
      <ul class="about-chips" aria-label="Referenced standards and methods">${chips}</ul>

      <p class="about-disclaimer">
        AuraLAB implements these published methods with documented simplifications;
        it is not certified against any of them. Predictions are simulations, not
        measurements — engineering judgement remains with you, and safety-of-life
        or regulatory work requires independent on-site verification with
        calibrated instruments.
      </p>

      <footer class="about-footer">
        <span>© 2026 AuraLAB</span>
      </footer>
    </div>`;
}

/** Open the About AuraLAB modal. */
export function openAboutModal() {
  openModal({
    id: 'about-modal-scrim',
    ariaLabel: 'About AuraLAB',
    className: 'about-modal-card',
    bodyHtml: buildBodyHtml(),
  });
}
