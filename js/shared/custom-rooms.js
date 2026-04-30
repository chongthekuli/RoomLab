// Saved custom rooms — localStorage-backed library of user-drawn room
// geometries so the user doesn't lose a custom room the moment they
// click another preset. Each entry stores the full state.room object
// plus the project / room labels, so reloading a saved entry restores
// the geometry exactly. Sources / listeners / zones are NOT saved here
// (they get reset by scene:reset, same as preset switching). For full
// scene persistence the user still has 💾 Save → .roomlab.json.
//
// Storage shape:
//   localStorage["roomlab.customRooms"] =
//     [ { id, projectName, roomName, room, savedAt }, ... ]
// Newest entries first. ID is millisecond-timestamp + small random
// suffix so duplicate-named rooms don't collide.

const STORAGE_KEY = 'roomlab.customRooms';
const MAX_ENTRIES = 30;   // cap so a runaway user doesn't fill localStorage

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('custom-rooms: read failed', err);
    return [];
  }
}

function writeAll(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }
  catch (err) { console.warn('custom-rooms: write failed', err); }
}

export function listCustomRooms() {
  return readAll();
}

// Group saved custom rooms by their projectName. Rooms without a project
// name are bucketed under '(Unfiled)' so the user can still see them in
// the project picker. Returned newest-project-first based on the most
// recent room's savedAt timestamp.
//   [ { name, rooms: [entry...], lastSavedAt } ]
export function listProjects() {
  const all = readAll();
  const byName = new Map();
  for (const e of all) {
    const key = (typeof e.projectName === 'string' && e.projectName.trim())
      ? e.projectName.trim()
      : '(Unfiled)';
    if (!byName.has(key)) byName.set(key, { name: key, rooms: [], lastSavedAt: e.savedAt });
    const proj = byName.get(key);
    proj.rooms.push(e);
    if ((e.savedAt ?? '') > (proj.lastSavedAt ?? '')) proj.lastSavedAt = e.savedAt;
  }
  return [...byName.values()].sort((a, b) => (b.lastSavedAt ?? '').localeCompare(a.lastSavedAt ?? ''));
}

// Most recent saved room for a given projectName. Used by the header
// project dropdown to pick which room to load when switching projects.
// Pass '(Unfiled)' to fetch the latest no-project room. Returns null if
// no rooms match.
export function latestRoomInProject(projectName) {
  const all = readAll();
  const target = (typeof projectName === 'string' && projectName.trim())
    ? projectName.trim()
    : null;
  const matches = all.filter(e => {
    const en = (typeof e.projectName === 'string' && e.projectName.trim())
      ? e.projectName.trim()
      : null;
    return en === target;
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
  return matches[0];
}

// Save a new entry to the front of the list. `room` is a deep-clone
// of state.room (caller's responsibility to clone — we don't want to
// pull deepClone in here). Returns the saved entry.
export function saveCustomRoom({ projectName, roomName, room, rackSystem }) {
  const trimmedRoom = (typeof roomName === 'string') ? roomName.trim() : '';
  const trimmedProj = (typeof projectName === 'string') ? projectName.trim() : '';
  // A room with no name is still saved — falls back to a timestamped
  // label so the chip has SOMETHING to show. The user can clear via the
  // chip's × button if it clutters.
  const label = trimmedRoom || `Untitled · ${new Date().toLocaleString()}`;
  const entry = {
    id: 'cr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectName: trimmedProj || null,
    roomName: label,
    room,
    // rackSystem is optional but always serialised — the saved entry is
    // self-contained, so loading the chip later restores both geometry
    // and any racks DeviceLAB placed into this room.
    rackSystem: rackSystem ?? { racks: [] },
    savedAt: new Date().toISOString(),
  };
  const list = [entry, ...readAll()].slice(0, MAX_ENTRIES);
  writeAll(list);
  return entry;
}

export function getCustomRoomById(id) {
  return readAll().find(e => e.id === id) ?? null;
}

export function deleteCustomRoom(id) {
  writeAll(readAll().filter(e => e.id !== id));
}

// Update an existing entry in place — used when the user re-saves the
// same custom room after edits. Returns the updated entry, or null if
// the id wasn't found.
export function updateCustomRoom(id, patch) {
  const list = readAll();
  const idx = list.findIndex(e => e.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch, savedAt: new Date().toISOString() };
  writeAll(list);
  return list[idx];
}
