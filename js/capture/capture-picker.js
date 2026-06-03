// Room Capture — entry-point orchestrator + mode picker (DOM).
//
// beginCapture() is what the "Capture / Draw custom room" button calls. It
// probes which modes are offerable right now (offerableModes), shows a small
// chooser if there's more than one, lazy-loads the chosen mode, and starts it.
// Each mode then drives its own UI and commits through the single writer
// (commitCapturedRoom) — so the picker stays a thin router and the sim is
// agnostic to how the room was produced. See docs/ROOM_CAPTURE_PLAN.md §4–§5.
//
// Kept SEPARATE from capture-flow.js so that module stays DOM-free / Node-
// testable; this one owns the only DOM in the capture spine besides the modes.
// Visual polish (final panel placement, copy) is Maya's to refine.

import { offerableModes } from './capture-modes.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Modal chooser. Resolves the chosen mode descriptor, or null on cancel/Esc.
// Mirrors the existing .rl-modal pattern (see panel-room.js showCustomRoomDialog)
// so it inherits the app's modal styling.
function chooseCaptureMode(modes) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'rl-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'rl-modal rl-capture-picker';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Capture room');

    const buttons = modes.map((m, i) => `
      <button type="button" class="rl-capture-mode" data-idx="${i}">
        <span class="rl-capture-mode-label">${escapeHtml(m.label)}</span>
        <span class="rl-capture-mode-hint">${escapeHtml(m.hint || '')}</span>
      </button>`).join('');

    modal.innerHTML = `
      <h3>Capture your room</h3>
      <p class="rl-modal-sub">Rough shape — you'll drag corners to correct it after.</p>
      <div class="rl-capture-modes">${buttons}</div>
      <div class="rl-modal-actions">
        <button type="button" class="rl-modal-cancel">Cancel</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let done = false;
    const close = (result) => {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    modal.querySelector('.rl-modal-cancel').addEventListener('click', () => close(null));
    modal.querySelectorAll('.rl-capture-mode').forEach(btn => {
      btn.addEventListener('click', () => close(modes[Number(btn.dataset.idx)]));
    });
  });
}

let activeSession = null;   // so a second begin() cancels the first

/**
 * Entry point: choose + start a capture mode. Returns the started CaptureSession
 * (or null if cancelled / nothing offerable). The chosen mode commits the room
 * itself via commitCapturedRoom; the caller doesn't need to await `done` unless
 * it wants to react to completion.
 */
let beginInFlight = false;   // re-entrancy guard — a double-tap must not start two camera sessions

export async function beginCapture(ctx = {}) {
  // Re-entrancy guard (Martina P0-3): beginCapture is async and `activeSession`
  // isn't assigned until AFTER `await chosen.load()`. A double-tap on a phone
  // (no instant feedback while the camera permission spins up) would re-enter,
  // see activeSession===null, and start a SECOND getUserMedia session whose
  // stream then leaks with no handle to stop it (camera LED stays on). Guard
  // the whole async span, not just activeSession.
  if (beginInFlight) return null;
  beginInFlight = true;
  try {
    // Cancel any in-flight capture (e.g. user re-clicks after a session is open).
    if (activeSession && typeof activeSession.cancel === 'function') {
      try { activeSession.cancel(); } catch { /* ignore */ }
      activeSession = null;
    }

    const modes = await offerableModes();
    if (modes.length === 0) return null;           // manual is always implemented, so this is defensive

    const chosen = modes.length === 1 ? modes[0] : await chooseCaptureMode(modes);
    if (!chosen) return null;                       // user cancelled the picker

    let mod;
    try {
      mod = await chosen.load();
    } catch (err) {
      console.warn(`[capture] mode '${chosen.id}' failed to load:`, err);
      return null;
    }
    // Resolve the CaptureMode: prefer the default export, else any named export
    // that looks like a CaptureMode (has start()). Robust to a renamed export
    // (Martina P3: the old `mod[`${id}Mode`]` only worked via the default).
    const modeImpl = (mod.default && typeof mod.default.start === 'function')
      ? mod.default
      : Object.values(mod).find(v => v && typeof v.start === 'function');
    if (!modeImpl || typeof modeImpl.start !== 'function') {
      console.warn(`[capture] mode '${chosen.id}' has no start()`);
      return null;
    }

    const session = modeImpl.start(document.body, ctx);
    activeSession = session;
    // Clear the active-session handle when the mode finishes/cancels so a later
    // begin() doesn't try to cancel a dead session.
    if (session && session.done && typeof session.done.then === 'function') {
      session.done.finally(() => { if (activeSession === session) activeSession = null; });
    }
    return session;
  } finally {
    beginInFlight = false;
  }
}
