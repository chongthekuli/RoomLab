// js/ui/admin-view-session.js
// ---------------------------------------------------------------------------
// DOM half of the admin read-only scene viewer. The pure state core lives in
// js/state/admin-view.js (snapshot/restore, read-only flag); THIS module owns
// the browser side: the read-only banner, the editing-rail lock (inert +
// scrim), the viewport re-render emits, and the AccountLAB ↔ RoomLAB navigation.
//
// Flow:
//   AccountLAB → requestAdminView({uid,email,roomName,scene}) + hash='#/room'
//   RoomLAB route:change(to:'room') → enterAdminView() consumes it
//   Exit / route away from #/room → exitAdminView() restores the admin's scene
//
// Maya spec (2026-06-14): amber MODE colour (not error-red), full-width banner
// pinned to the viewport top, rail-level inert+scrim so the 2D/3D viewport stays
// fully inspectable while every edit control is locked.
// ---------------------------------------------------------------------------

import { emit } from './events.js';
import { beginAdminView, endAdminView, getActiveAdminView, isAdminViewing } from '../state/admin-view.js';

// The left rail holds every editing panel (room dims / sources / listeners /
// zones / treatments / …). The right rail mixes editing (author-note) with
// read-only readouts (results), so we lock only the left rail — the viewport +
// results stay live for inspection. The header Save button is gated separately
// (panel-room.saveActiveRoom checks isReadOnly()).
const LOCK_PANEL_IDS = ['panel-left'];

function reRenderViewport() {
  // Same emit set loadCustomRoomById uses — rebuilds 2D/3D + re-renders panels.
  emit('scene:reset');
  emit('room:changed');
  emit('rack:changed');
}

/** Enter a read-only view of a foreign room. `req` = {viewedUid, viewedEmail,
 *  viewedRoomName, scene}. Snapshots the admin's own scene, loads the foreign
 *  one, locks editing, shows the banner. No-op if a session is already active. */
export function enterAdminView(req) {
  if (isAdminViewing() || !req?.scene) return;
  // Drop focus before locking, so inert can't strand the caret on a now-inert
  // input (the "keyboard goes dead" failure Maya flagged).
  try { document.activeElement?.blur?.(); } catch (_) {}
  const ok = beginAdminView(req, reRenderViewport);
  if (!ok) return;
  lockEditingRails(true);
  mountBanner(getActiveAdminView());
}

/** Exit the read-only view: restore the admin's own scene + editing context,
 *  unlock, remove the banner. Optionally navigate back to AccountLAB. No-op if
 *  not viewing. */
export function exitAdminView({ returnToAccount = false } = {}) {
  if (!isAdminViewing()) return;
  endAdminView(reRenderViewport);
  lockEditingRails(false);
  unmountBanner();
  if (returnToAccount) window.location.hash = '#/account';
}

// ---- banner ----------------------------------------------------------------

function mountBanner(ctx) {
  unmountBanner();
  const viewport = document.getElementById('viewport');
  if (!viewport || !ctx) return;
  const bar = document.createElement('div');
  bar.className = 'ro-banner';
  bar.id = 'ro-banner';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  bar.innerHTML = `
    <span class="ro-tag">👁 READ-ONLY</span>
    <span class="ro-who"><span class="ro-email">${escapeHtml(ctx.viewedEmail || 'user')}</span>` +
      `<span class="ro-sep"> · </span><span class="ro-room">${escapeHtml(ctx.viewedRoomName || 'room')}</span></span>
    <span class="ro-note">Edits won’t be saved.</span>
    <button class="ro-exit" type="button" title="Close this room and return to AccountLAB. Your own scene is restored.">Exit view</button>`;
  // Pinned to the top of the viewport column, pushing the canvas down (scene.js
  // ResizeObserver re-sizes the renderer). First child = above the vp-tabs.
  viewport.insertBefore(bar, viewport.firstChild);
  bar.querySelector('.ro-exit')?.addEventListener('click', () => exitAdminView({ returnToAccount: true }));
}

function unmountBanner() {
  document.getElementById('ro-banner')?.remove();
}

// ---- editing-rail lock (inert + scrim) -------------------------------------

// `inert` does the real enforcement (blocks focus + pointer + keyboard + a11y
// tree in one attribute — no per-control bookkeeping). The .ro-locked class is
// the VISUAL cue (dim + amber edge + not-allowed cursor) so the dimmed rail
// reads as "intentionally locked", not "frozen/broken" — the banner above
// carries the words. We deliberately don't append a positioned scrim: the rail
// panel is position:fixed, and an absolute scrim child would fight that layout.
function lockEditingRails(on) {
  for (const id of LOCK_PANEL_IDS) {
    const panel = document.getElementById(id);
    if (!panel) continue;
    if (on) {
      panel.classList.add('ro-locked');
      panel.setAttribute('inert', '');
    } else {
      panel.classList.remove('ro-locked');
      panel.removeAttribute('inert');
    }
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
