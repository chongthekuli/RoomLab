// RoomLAB Suite — Terms-of-use acceptance modal.
//
// Shows on every app load. Blocks the workbench with a glass scrim +
// glass card until the user explicitly accepts. No close, no Esc,
// no "remember me." Copy by Lin (docs-writer), visual + motion spec
// by Sofia (proposal-designer). On accept the UTC timestamp is
// captured in sessionStorage and read by the PDF report generator so
// every exported document carries the acceptance attestation.
//
// State machine:
//   idle → counting (4 s) → enabled → accepting (1.8 s) → dismissed
// No back-edges. Esc + overlay-click are no-ops in every state.

const ACCEPT_TIMESTAMP_KEY = 'roomlab.terms.acceptedAt.utc';
const COUNTDOWN_SECONDS = 4;
const ACCEPT_ANIMATION_MS = 1800;

/**
 * Read the timestamp the user accepted the terms at (this session).
 * Returns null if they haven't accepted yet — callers should treat
 * that as "modal hasn't completed," not "user declined" (no decline
 * path exists). Format: "YYYY-MM-DD HH:MM:SS UTC".
 */
export function getAcceptanceTimestamp() {
  try {
    return sessionStorage.getItem(ACCEPT_TIMESTAMP_KEY);
  } catch (_) {
    return null;
  }
}

/**
 * Mount the terms-of-use modal. Resolves the returned Promise when
 * the user accepts (after the post-acceptance animation completes,
 * so callers can rely on the workbench being fully revealed).
 */
export function mountTermsModal() {
  return new Promise((resolve) => {
    // Defensive — don't stack two modals if mountTermsModal is called
    // twice (e.g. router race).
    const existing = document.getElementById('terms-modal-scrim');
    if (existing) { existing.remove(); }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scrim = buildScrim();
    document.body.appendChild(scrim);

    // Focus trap — store the element that had focus before so we can
    // restore on dismiss (matters for screen readers).
    const previouslyFocused = document.activeElement;
    const card = scrim.querySelector('.terms-card');
    const btn = scrim.querySelector('#terms-accept-btn');
    const btnCounter = scrim.querySelector('.terms-btn-counter');

    // Focus trap: keep Tab inside the modal.
    const trapFocus = (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      btn.focus();
    };
    scrim.addEventListener('keydown', trapFocus);

    // Esc + scrim-click do nothing — defensive `stopPropagation` on
    // the card, no listener on the scrim itself.
    scrim.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') e.preventDefault();
    });

    // ---- Countdown phase (4 s) -------------------------------------
    let secondsLeft = COUNTDOWN_SECONDS;
    let enabled = false;
    if (reducedMotion) {
      // No progress underline transition — show numeric only.
      btn.classList.add('terms-btn-no-anim');
    }
    btnCounter.textContent = `(${secondsLeft})`;
    const tick = () => {
      secondsLeft--;
      if (secondsLeft <= 0) {
        enabled = true;
        btn.disabled = false;
        btn.classList.add('terms-btn-enabled');
        btnCounter.textContent = '';
        btn.querySelector('.terms-btn-label').textContent = 'I accept and continue';
        btn.focus();
        clearInterval(intervalId);
      } else {
        btnCounter.textContent = `(${secondsLeft})`;
      }
    };
    const intervalId = setInterval(tick, 1000);

    // Initial focus on the button (so even disabled, screen readers
    // announce its disabled label + countdown).
    requestAnimationFrame(() => { btn.focus(); });

    // ---- Accept phase ----------------------------------------------
    let accepting = false;
    const accept = () => {
      if (!enabled || accepting) return;
      accepting = true;
      clearInterval(intervalId);
      // Capture acceptance timestamp.
      const nowISO = new Date().toISOString();          // "2026-05-12T14:32:08.123Z"
      const utcText = formatUTC(new Date(nowISO));      // "2026-05-12 14:32:08 UTC"
      try { sessionStorage.setItem(ACCEPT_TIMESTAMP_KEY, utcText); } catch (_) {}

      // Block further input during the animation.
      card.style.pointerEvents = 'none';
      runAcceptanceAnimation(card, scrim, utcText, reducedMotion, () => {
        // Cleanup + restore previously-focused element.
        scrim.remove();
        try { previouslyFocused?.focus?.(); } catch (_) {}
        resolve(utcText);
      });
    };
    btn.addEventListener('click', accept);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (enabled) {
          e.preventDefault();
          accept();
        }
      }
    });
  });
}

// ---------------------------------------------------------------------
// DOM builders
// ---------------------------------------------------------------------

function buildScrim() {
  const scrim = document.createElement('div');
  scrim.id = 'terms-modal-scrim';
  scrim.className = 'terms-modal-scrim';
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-labelledby', 'terms-modal-heading');
  scrim.innerHTML = `
    <div class="terms-card" id="terms-card">
      <h2 id="terms-modal-heading" class="terms-heading">Terms of use — RoomLAB Suite</h2>
      <div class="terms-divider"></div>
      <ul class="terms-bullets">
        <li>
          <strong>Predictions are simulations, not measurements.</strong>
          RoomLAB computes RT60, STIPA, SPL coverage and related metrics from a browser-side physics engine.
          Any application involving safety of life or regulatory compliance — including voice-alarm and emergency PA under
          BS 5839-8, EN 54-16, IEC 60849 and MS IEC 60849 — requires independent on-site verification with calibrated instruments before sign-off.
          <div class="terms-callout">BS 5839-8 · EN 54-16 · IEC 60849 · MS IEC 60849</div>
        </li>
        <li>
          <strong>Standards are referenced, not certified.</strong>
          The engine implements published methods (ISO 3382-1, ISO 9613-1, IEC 60268-16:2020, Sabine, Eyring, Schroeder, Beranek) with documented simplifications — including diffuse-field assumptions in draft mode and flat directivity indices for unspecified sources.
          Full methodology is printed in every generated report. RoomLAB itself is not certified against any of the standards it cites.
          <div class="terms-callout">ISO 3382-1 · ISO 9613-1 · IEC 60268-16:2020 · Sabine · Beranek</div>
        </li>
        <li>
          <strong>No warranty; engineering judgement remains with you.</strong>
          The operator of this service provides RoomLAB on an as-is basis, without warranty of fitness for any purpose, and accepts no liability for design decisions made using its output.
          By continuing, you affirm that you are a competent acoustics, AV, architectural or engineering professional, or are working under the supervision of one, and will not present these predictions as commissioning-grade measurements.
        </li>
        <li>
          <strong>Acceptance is recorded and travels with your work.</strong>
          This acknowledgement is timestamped in UTC in your browser and is referenced on the methodology page of every PDF report, share-link and screenshot generated in this session.
        </li>
      </ul>
      <button id="terms-accept-btn" class="terms-btn" type="button" disabled aria-label="I accept and continue">
        <span class="terms-btn-label">I accept and continue</span>
        <span class="terms-btn-counter" aria-hidden="true">(${COUNTDOWN_SECONDS})</span>
        <span class="terms-btn-underline" aria-hidden="true"></span>
      </button>
    </div>
  `;
  return scrim;
}

// ---------------------------------------------------------------------
// Acceptance animation — Sofia's 1.8 s sequence
// ---------------------------------------------------------------------

function runAcceptanceAnimation(card, scrim, utcText, reducedMotion, done) {
  if (reducedMotion) {
    // Reduced motion: instant content swap + 120 ms fade.
    card.innerHTML = renderAckHtml(utcText, /* staggered = */ false);
    setTimeout(() => {
      scrim.classList.add('terms-modal-exit');
      setTimeout(done, 200);
    }, 600);
    return;
  }

  // t=0: fade content out + translate -6px (280 ms)
  card.classList.add('terms-card-fade-out');
  setTimeout(() => {
    // t=280: replace content + relax card height (no explicit anim — content reflow)
    card.classList.remove('terms-card-fade-out');
    card.classList.add('terms-card-relax');
    card.innerHTML = renderAckHtml(utcText, /* staggered = */ true);
    // After content swap, the .terms-ack-line elements auto-animate
    // via CSS animation-delay (stagger 0/200/460 ms from t=280).
    // Total: line 1 starts at 520 ms, line 3 ends ~1300 ms.
    setTimeout(() => {
      // t=1500ms total (520 + ~980 of stagger end + buffer)
      scrim.classList.add('terms-modal-exit');
      setTimeout(done, 300);
    }, ACCEPT_ANIMATION_MS - 280 - 20);
  }, 280);
}

function renderAckHtml(utcText, staggered) {
  const cls = staggered ? 'terms-ack-line terms-ack-stagger' : 'terms-ack-line';
  return `
    <div class="terms-ack-block">
      <div class="terms-ack-row">
        <span class="terms-ack-dot" aria-hidden="true"></span>
        <span class="${cls}" style="--terms-ack-delay: 0ms;">Acknowledgement recorded — <span class="terms-ack-ts">${escapeHtml(utcText)}</span>.</span>
      </div>
      <div class="${cls}" style="--terms-ack-delay: 200ms;">This acceptance will appear on every report generated in this session.</div>
      <div class="${cls}" style="--terms-ack-delay: 460ms;">Loading workbench.</div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function formatUTC(d) {
  // "YYYY-MM-DD HH:MM:SS UTC"
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------
// Back-compat shim — keep the old mountWelcomeCard export so callers
// that still reference it work. Mounts the new terms modal but does
// NOT block on acceptance (returns immediately; the modal completes
// its lifecycle async).
// ---------------------------------------------------------------------
export function mountWelcomeCard() {
  mountTermsModal();
}
