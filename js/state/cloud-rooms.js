// js/state/cloud-rooms.js
// ---------------------------------------------------------------------------
// In-memory cache of the user's cloud ROOM LIBRARY (multi-project / multi-room),
// exposing a SYNCHRONOUS read API that is a DROP-IN for the retired
// js/shared/custom-rooms.js — so panel-room's synchronous renders work unchanged.
//
// The async happens ONCE: hydrateRooms(uid) loads the library before the room
// panel mounts. After that, reads are synchronous (off _cache) and mutators are
// OPTIMISTIC: they mutate the cache + return synchronously (so the immediate
// re-render shows the change), then fire-and-forget the Firestore write. A write
// FAILURE keeps the optimistic cache state (no silent rollback — the user's
// visible work is the truth) and emits `cloud-rooms:write-failed` so the UI can
// toast "couldn't sync". Same explicit-error philosophy as the rest of the app.
//
// Entry shape (mirrors the old localStorage shape): { id, projectName, roomName,
// scene (serializeProject blob), savedAt }. The grouping/latest logic is copied
// verbatim from custom-rooms.js (proven).
// ---------------------------------------------------------------------------

import { emit } from '../shared/events.js';

const MAX_ENTRIES = 30;   // soft, client-side cap (rules can't count a collection cheaply)

// The Firestore room functions are INJECTED (not imported) so this module stays
// free of the remote Firebase SDK import — keeping the cache logic unit-testable
// in Node. roomlab/main.js calls configureCloudRooms() at boot with the real
// firebase-db functions; tests inject synchronous stubs.
let _db = {
  list:   async () => [],
  save:   async () => ({ ok: true }),
  remove: async () => ({ ok: true }),
};
export function configureCloudRooms({ list, save, remove } = {}) {
  if (list) _db.list = list;
  if (save) _db.save = save;
  if (remove) _db.remove = remove;
}

let _cache = [];
let _loaded = false;
let _loadFailed = false;
let _uid = null;
const _inflight = new Map();   // id → latest write token (stale-write supersede guard)

function currentUid() {
  try { return _uid || (globalThis.__auralabAuth?.user?.uid ?? null); } catch (_) { return _uid; }
}
function sortNewest(rooms) {
  return (Array.isArray(rooms) ? rooms.slice() : [])
    .sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
}

// ---- async lifecycle (boot / sign-in / sign-out) ---------------------------

/** Load the user's room library into the cache. Call ONCE before the room panel
 *  mounts. Sets loadFailed (not throws) if the read fails (offline/denied). */
export async function hydrateRooms(uid) {
  _uid = uid || currentUid();
  _loaded = false; _loadFailed = false;
  if (!_uid) { _cache = []; _loaded = true; return; }
  try {
    _cache = sortNewest(await _db.list(_uid));
    _loaded = true;
  } catch (err) {
    console.warn('[cloud-rooms] hydrate failed — empty library, offline guard set', err);
    _cache = []; _loaded = true; _loadFailed = true;
  }
}
export function roomsLoaded() { return _loaded; }
export function roomsLoadFailed() { return _loadFailed; }
export function resetRoomsCache() {
  _cache = []; _loaded = false; _loadFailed = false; _uid = null; _inflight.clear();
}

// ---- synchronous read API (drop-in for custom-rooms.js) --------------------

export function listCustomRooms() { return _cache.slice(); }

export function listProjects() {
  const byName = new Map();
  for (const e of _cache) {
    const key = (typeof e.projectName === 'string' && e.projectName.trim()) ? e.projectName.trim() : '(Unfiled)';
    if (!byName.has(key)) byName.set(key, { name: key, rooms: [], lastSavedAt: e.savedAt });
    const proj = byName.get(key);
    proj.rooms.push(e);
    if ((e.savedAt ?? '') > (proj.lastSavedAt ?? '')) proj.lastSavedAt = e.savedAt;
  }
  return [...byName.values()].sort((a, b) => (b.lastSavedAt ?? '').localeCompare(a.lastSavedAt ?? ''));
}

export function latestRoomInProject(projectName) {
  const target = (typeof projectName === 'string' && projectName.trim()) ? projectName.trim() : null;
  const matches = _cache.filter((e) => {
    const en = (typeof e.projectName === 'string' && e.projectName.trim()) ? e.projectName.trim() : null;
    return en === target;
  });
  if (!matches.length) return null;
  matches.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
  return matches[0];
}

export function getCustomRoomById(id) { return _cache.find((e) => e.id === id) ?? null; }

// Insert-or-replace a room in the cache WITHOUT writing (the explicit Save did a
// definitive awaitable write already, so we just reflect it in the cache).
export function upsertRoomCache(entry) {
  if (!entry?.id) return;
  const idx = _cache.findIndex((e) => e.id === entry.id);
  if (idx >= 0) _cache[idx] = entry; else _cache = [entry, ..._cache].slice(0, MAX_ENTRIES);
  emit('projects:changed');
}

// ---- optimistic mutators (sync return, async write) ------------------------

export function saveCustomRoom({ projectName, roomName, scene = null } = {}) {
  const trimmedRoom = (typeof roomName === 'string') ? roomName.trim() : '';
  const trimmedProj = (typeof projectName === 'string') ? projectName.trim() : '';
  const label = trimmedRoom || `Untitled · ${new Date().toLocaleString()}`;
  const entry = {
    id: 'cr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectName: trimmedProj || null,
    roomName: label,
    scene,
    savedAt: new Date().toISOString(),
  };
  _cache = [entry, ..._cache].slice(0, MAX_ENTRIES);
  _persist(entry);
  emit('projects:changed');
  return entry;
}

export function updateCustomRoom(id, patch) {
  const idx = _cache.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  const merged = { ..._cache[idx], ...patch, savedAt: new Date().toISOString() };
  _cache[idx] = merged;
  _persist(merged);
  emit('projects:changed');
  return merged;
}

export function deleteCustomRoom(id) {
  _cache = _cache.filter((e) => e.id !== id);
  const uid = currentUid();
  if (uid) {
    Promise.resolve(_db.remove(uid, id)).then((res) => {
      if (res && !res.ok) emit('cloud-rooms:write-failed', { op: 'delete', id, code: res.code });
    });
  }
  emit('projects:changed');
}

/** Rename a project across every room in its group (fan-out). Optimistic. */
export function renameProject(oldName, newName) {
  const from = (typeof oldName === 'string' && oldName.trim()) ? oldName.trim() : null;
  const to = (typeof newName === 'string' && newName.trim()) ? newName.trim() : null;
  if (from === to) return;
  for (let i = 0; i < _cache.length; i++) {
    const en = (typeof _cache[i].projectName === 'string' && _cache[i].projectName.trim()) ? _cache[i].projectName.trim() : null;
    if (en === from) {
      const merged = { ..._cache[i], projectName: to, savedAt: new Date().toISOString() };
      _cache[i] = merged;
      _persist(merged);
    }
  }
  emit('projects:changed');
}

// ---- private ---------------------------------------------------------------

function _persist(entry) {
  const uid = currentUid();
  if (!uid) return;
  const token = Symbol(entry.id);
  _inflight.set(entry.id, token);
  Promise.resolve(_db.save(uid, entry)).then((res) => {
    const stale = _inflight.get(entry.id) !== token;   // a newer write for this id superseded us
    if (!stale) _inflight.delete(entry.id);
    if (res && !res.ok && !stale) emit('cloud-rooms:write-failed', { op: 'save', id: entry.id, code: res.code });
  });
}
