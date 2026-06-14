// js/state/scene-dirty.js
// ---------------------------------------------------------------------------
// Cloud-scene session meta — deliberately NOT part of `state` (it must never
// round-trip through serializeProject or get wiped by scene:reset). Tracks:
//   • dirty   — the current scene has unsaved changes vs the user's CLOUD scene.
//   • readOnly — admin read-only viewer mode (Phase 3): mutations can't save.
//   • loadFailed — the boot scene-load THREW (offline/denied), so Save must
//     confirm before overwriting the user's real cloud scene with edits made
//     on top of a fallback/default scene.
//
// Emits `scene:dirty-changed` { dirty } so the Save button can reflect state.
// ---------------------------------------------------------------------------

import { emit } from '../ui/events.js';

let _dirty = false;
let _readOnly = false;
let _loadFailed = false;
let _suppress = 0;

/** Mark the scene as having unsaved changes (no-op while suppressing / read-only). */
export function markDirty() {
  if (_suppress > 0 || _readOnly || _dirty) return;
  _dirty = true;
  emit('scene:dirty-changed', { dirty: true });
}

/** Mark the scene as saved/clean (after a successful Save or a fresh load). */
export function markClean() {
  if (!_dirty) return;
  _dirty = false;
  emit('scene:dirty-changed', { dirty: false });
}

export function isDirty() { return _dirty; }

/**
 * Run a programmatic scene load (deserializeProject / preset apply) with dirty
 * tracking suppressed, then mark clean. Emits are SYNCHRONOUS (see
 * js/shared/events.js + panel-room runSceneSwap), so a plain try/finally fully
 * brackets the load — the mutation events fired inside loadFn can't dirty it.
 */
export function loadSceneQuietly(loadFn) {
  _suppress++;
  try { loadFn(); }
  finally { _suppress--; }
  markClean();
}

// Admin read-only viewer mode (Phase 3).
export function setReadOnly(on) { _readOnly = !!on; }
export function isReadOnly() { return _readOnly; }

// Boot scene-load failure → Save confirms before overwriting the cloud scene.
export function setLoadFailed(on) { _loadFailed = !!on; }
export function didLoadFail() { return _loadFailed; }
