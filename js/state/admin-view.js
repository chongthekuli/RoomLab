// js/state/admin-view.js
// ---------------------------------------------------------------------------
// Read-only ADMIN scene viewer — the pure state core (no DOM, no Three.js, so
// it's Node-testable). An admin in AccountLAB opens another user's saved room;
// it renders in the real RoomLAB viewport in READ-ONLY mode, then the admin
// Exits and their OWN scene is restored exactly as it was.
//
// Two slots:
//   _pending — a view REQUEST handed off from AccountLAB just before it sets
//              location.hash = '#/room'. RoomLAB consumes it once on the next
//              route:change. Atomic read-and-null guards the mount/route-change
//              double-fire (whoever reads first wins; the second gets null).
//   _active  — the live read-only SESSION. Crucially it carries the admin's OWN
//              scene SNAPSHOT (+ their active room id + dirty flag) captured at
//              entry, so Exit restores their in-progress work — NOT a re-read of
//              their last *saved* room (which would silently destroy unsaved
//              edits — the data-loss trap Hannes flagged as SE-1).
//
// The DOM half (banner, rail scrim, navigation) lives in
// js/ui/admin-view-session.js; this file only owns the state + the
// snapshot/restore so the contract is unit-testable without a browser.
// ---------------------------------------------------------------------------

import { serializeProject, deserializeProject } from '../app-state.js';
import { isDirty, markDirty, loadSceneQuietly, setReadOnly } from './scene-dirty.js';

let _pending = null;
let _active = null;

// The "active custom room id" lives in panel-room (module-private). Inject a
// getter/setter so this pure module can snapshot + restore it without importing
// panel-room (which pulls in Three.js and breaks Node tests). roomlab/main.js
// wires the real hooks at boot via configureAdminView().
let _roomId = { get: () => null, set: () => {} };
export function configureAdminView({ getRoomId, setRoomId } = {}) {
  if (typeof getRoomId === 'function') _roomId.get = getRoomId;
  if (typeof setRoomId === 'function') _roomId.set = setRoomId;
}

// ---- AccountLAB → RoomLAB handoff ------------------------------------------

/** Queue a foreign room to view, then the caller sets location.hash='#/room'. */
export function requestAdminView(req) { _pending = req || null; }

/** Consume the queued request EXACTLY once (atomic read-and-null). */
export function takePendingAdminView() { const v = _pending; _pending = null; return v; }

export function hasPendingAdminView() { return _pending !== null; }

// ---- read-only session lifecycle -------------------------------------------

/**
 * Begin a read-only viewing session: snapshot the admin's OWN scene + editing
 * context, then load the foreign scene read-only. Idempotent — a second call
 * while already viewing is ignored (so the route/mount double-fire can't double
 * snapshot and lose the real own-scene under a foreign one).
 * @param {{viewedUid?,viewedEmail?,viewedRoomName?,scene:object}} req
 */
export function beginAdminView(req, afterLoad) {
  if (_active || !req || !req.scene) return false;
  _active = {
    ownSnapshot: serializeProject(),   // the admin's live scene, verbatim
    ownRoomId: _roomId.get(),
    wasDirty: isDirty(),
    viewedUid: req.viewedUid ?? null,
    viewedEmail: req.viewedEmail ?? '',
    viewedRoomName: req.viewedRoomName ?? '',
  };
  // Deserialize + the viewport re-render emits both run INSIDE loadSceneQuietly,
  // so the scene:reset emit (a dirty trigger) can't dirty the foreign scene.
  loadSceneQuietly(() => { deserializeProject(req.scene); if (afterLoad) afterLoad(); });
  setReadOnly(true);          // markDirty becomes a no-op; Save is gated on this
  _roomId.set(null);          // Save can't target the admin's own library
  return true;
}

/**
 * End the session: restore the admin's own scene + active-room id + dirty flag
 * exactly as they were at entry. Order matters — clear read-only BEFORE the
 * final markDirty (else it's a no-op), and restore dirty AFTER loadSceneQuietly
 * (which marks clean at the end). Idempotent.
 */
export function endAdminView(afterLoad) {
  if (!_active) return false;
  const { ownSnapshot, ownRoomId, wasDirty } = _active;
  _active = null;             // clear first so a re-entrant call is a no-op
  setReadOnly(false);
  loadSceneQuietly(() => { deserializeProject(ownSnapshot); if (afterLoad) afterLoad(); });
  _roomId.set(ownRoomId);
  if (wasDirty) markDirty();  // AFTER loadSceneQuietly (it marks clean) + read-only cleared
  return true;
}

export function getActiveAdminView() { return _active; }
export function isAdminViewing() { return _active !== null; }

/** Hard reset (sign-out) — drop any session/request WITHOUT restoring a scene
 *  (sign-out tears the whole app down anyway). Just clears read-only + state. */
export function resetAdminView() {
  _pending = null;
  _active = null;
  setReadOnly(false);
}
