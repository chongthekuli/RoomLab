// js/ui/modal-shell.js
// ---------------------------------------------------------------------------
// Shared closeable glass-card modal chrome for the Account and About modals
// reached from the header user menu. Provides: scrim + glass card, an X close
// button, Esc-to-close, scrim-click-to-close, a focus trap, and focus
// restoration to whatever was focused before the modal opened.
//
// This is NOT used by the Terms modal (js/ui/welcome-card.js): Terms is
// intentionally non-closeable (no Esc, no scrim-click, no X). This is a new,
// separate helper for the closeable account-area modals — do not fold the
// Terms modal into it.
// ---------------------------------------------------------------------------

const EXIT_MS = 140;

/**
 * Open a closeable glass modal.
 * @param {object}   opts
 * @param {string}   opts.id          unique DOM id for the scrim (re-open safe)
 * @param {string}   opts.ariaLabel   accessible name for the dialog
 * @param {string}   [opts.className] extra class on the card (per-modal styling)
 * @param {string}   opts.bodyHtml    inner HTML of the card (after the X button)
 * @param {Function} [opts.onMount]   ({ scrim, card, close }) => void — wire
 *                                     events + set initial focus. If omitted,
 *                                     the close button receives focus.
 * @returns {{ scrim: HTMLElement, card: HTMLElement, close: Function }}
 */
export function openModal({ id, ariaLabel, className = '', bodyHtml = '', onMount } = {}) {
  // Defensive — never stack the same modal twice (double-click / router race).
  document.getElementById(id)?.remove();

  const previouslyFocused = document.activeElement;

  const scrim = document.createElement('div');
  scrim.id = id;
  scrim.className = 'app-modal-scrim';
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-label', ariaLabel || 'Dialog');
  scrim.innerHTML = `
    <div class="app-modal-card ${className}" role="document">
      <button type="button" class="app-modal-close" aria-label="Close">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M3 3 L13 13 M13 3 L3 13" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" fill="none"/>
        </svg>
      </button>
      ${bodyHtml}
    </div>`;
  document.body.appendChild(scrim);

  const card = scrim.querySelector('.app-modal-card');

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.classList.add('app-modal-exit');
    scrim.classList.remove('app-modal-visible');
    setTimeout(() => {
      scrim.remove();
      try { previouslyFocused?.focus?.(); } catch (_) {}
    }, EXIT_MS);
  };

  // Esc closes; scrim-click closes only when the click lands on the scrim
  // itself (the backdrop), never when it bubbles up from inside the card.
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  scrim.querySelector('.app-modal-close').addEventListener('click', close);

  // Focus trap — query focusables LIVE on each Tab so view/tab switching inside
  // the modal keeps the trap correct.
  scrim.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = [...card.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Entrance — force a reflow so the opacity/transform transition fires.
  void scrim.offsetHeight;
  scrim.classList.add('app-modal-visible');

  requestAnimationFrame(() => {
    if (onMount) onMount({ scrim, card, close });
    else card.querySelector('.app-modal-close')?.focus();
  });

  return { scrim, card, close };
}
