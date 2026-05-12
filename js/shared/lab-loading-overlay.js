// Lab loading overlay — fires on every route transition in router.js.
// Mounts a full-viewport scrim with a glass card that names the target
// Lab and shows an animated indicator while the lazy import + mount fn
// resolves. Reuses the glass / palette grammar from terms-modal-scrim
// (css/main.css) so it reads as one product, not a bolt-on.
//
// Flicker policy: warm tab swaps usually settle in <80 ms. The overlay
// is created hidden and only fades in after PRESHOW_MS. If hide() runs
// before then, the user never sees a paint — no flash for fast swaps.
//
// Click pile-on policy: QUEUE + snap to final. The scrim has
// pointer-events:auto so stray clicks on the underlying (stale) lab UI
// are absorbed, but the header tabs sit at z-index 30 and the scrim is
// z-index 9500 (BELOW the header at 30? — no, 9500 is far above; we
// punch the header through with pointer-events:none on the scrim's
// header cutout). User can still click another lab tab; hashchange
// fires; router.show() runs again; we update the label in-place. No
// queue data structure needed — the last hashchange wins naturally.
//
// Initial-load policy: DEFERRED while the terms modal is mounted —
// not suppressed. The terms scrim is its own hold-screen so we don't
// stack a second one underneath, but if the initial RoomLAB mount is
// still in flight when the user clicks Accept, the overlay takes
// over until mount resolves. A MutationObserver watches for the
// terms scrim leaving the DOM and runs the deferred show.
//
// Accessibility: role="status" + aria-live="polite" on the label,
// aria-busy on <body>, prefers-reduced-motion drops the spin + scale
// and uses opacity-only fade.

const PRESHOW_MS = 150;        // Don't paint before this — warm swaps stay invisible.
const FADE_OUT_MS = 180;       // Match terms-scrim-out timing family.

let scrimEl = null;
let labelEl = null;
let showTimer = null;          // rAF / setTimeout id for the deferred paint
let visible = false;           // true once the scrim has been promoted to .is-visible
let pendingLabel = null;       // non-null = "overlay is wanted." Cleared by hideLoadingOverlay.
let termsObserver = null;      // MutationObserver watching for the terms scrim to leave the DOM

/**
 * Show the overlay for `labLabel`. Idempotent — repeat calls update
 * the label text in place (handy when the user pile-clicks a third tab
 * while the second is still mounting).
 *
 * Deferred case: if the terms modal is up, the request is remembered
 * (pendingLabel) and a one-shot observer waits for the terms scrim to
 * leave the DOM. If hideLoadingOverlay runs first, pendingLabel is
 * cleared and the observer self-cancels — no paint ever happens.
 */
export function showLoadingOverlay(labLabel = 'lab') {
  pendingLabel = labLabel;

  if (document.getElementById('terms-modal-scrim')) {
    // Terms modal is on screen. Don't paint, but remember the request
    // and arm a one-shot watcher for the terms scrim's removal.
    armTermsWatcher();
    return;
  }

  ensureMounted();
  setLabel(labLabel);
  document.body.setAttribute('aria-busy', 'true');

  if (visible) return;          // already painted; just updated label
  if (showTimer) return;        // pre-show timer already armed

  showTimer = window.setTimeout(() => {
    showTimer = null;
    if (!scrimEl || pendingLabel === null) return;
    scrimEl.classList.add('is-visible');
    visible = true;
  }, PRESHOW_MS);
}

/**
 * Hide the overlay. If hide() runs before PRESHOW_MS elapsed, the
 * pre-show timer is cancelled and no paint ever happened — that's the
 * mechanism that keeps warm swaps flicker-free.
 */
export function hideLoadingOverlay() {
  pendingLabel = null;
  disarmTermsWatcher();
  document.body.removeAttribute('aria-busy');

  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (!scrimEl || !visible) {
    // Pre-show was cancelled. Nothing to fade out.
    return;
  }
  visible = false;
  scrimEl.classList.add('is-exiting');
  scrimEl.classList.remove('is-visible');
  // Hold the node so subsequent shows reuse the same element (cheaper
  // than tear-down + rebuild). Just strip the exit class once the fade
  // completes so a re-show starts from a clean slate.
  window.setTimeout(() => {
    if (scrimEl && !visible) scrimEl.classList.remove('is-exiting');
  }, FADE_OUT_MS + 20);
}

// One-shot observer for the terms scrim leaving the DOM. When it goes,
// we replay the most recent showLoadingOverlay call — picking up the
// latest pendingLabel in case multiple show() calls stacked during the
// terms gate (in practice only one does, but cheap to be correct).
function armTermsWatcher() {
  if (termsObserver) return;
  termsObserver = new MutationObserver(() => {
    if (document.getElementById('terms-modal-scrim')) return;
    // Terms gone. Stop watching, and if the overlay is still wanted,
    // run the normal show path.
    disarmTermsWatcher();
    const label = pendingLabel;
    if (label !== null) {
      // Reset pending so the recursive call doesn't re-arm the watcher
      // (terms is gone) — showLoadingOverlay sets pendingLabel again
      // before painting.
      pendingLabel = null;
      showLoadingOverlay(label);
    }
  });
  termsObserver.observe(document.body, { childList: true, subtree: false });
}

function disarmTermsWatcher() {
  if (!termsObserver) return;
  termsObserver.disconnect();
  termsObserver = null;
}

function ensureMounted() {
  if (scrimEl && document.body.contains(scrimEl)) return;
  const scrim = document.createElement('div');
  scrim.className = 'lab-loading-scrim';
  scrim.setAttribute('aria-hidden', 'true');   // role="status" sits on the inner label, not the scrim
  scrim.innerHTML = `
    <div class="lab-loading-card">
      <div class="lab-loading-indicator" aria-hidden="true">
        <span class="lab-loading-ring"></span>
        <span class="lab-loading-ring lab-loading-ring-2"></span>
      </div>
      <div class="lab-loading-label" role="status" aria-live="polite">Loading…</div>
    </div>
  `;
  document.body.appendChild(scrim);
  scrimEl = scrim;
  labelEl = scrim.querySelector('.lab-loading-label');
}

function setLabel(labLabel) {
  if (!labelEl) return;
  // Terse, accurate. "Loading SpeakerLAB…" — not "Please wait while we
  // load SpeakerLAB for you!"
  labelEl.textContent = `Loading ${labLabel}…`;
}
