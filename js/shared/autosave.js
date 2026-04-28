// Cross-Lab scene autosave. The RoomLAB scene is the single source of
// truth for "what room is currently being designed" — its rackSystem
// is what DeviceLAB edits, its sources are what SpeakerLAB references,
// and navigation between Labs must NOT lose the user's work.
//
// Mechanism: every state-mutating event in RoomLAB triggers a debounced
// write of serializeProject(state) to a single localStorage key. On
// boot, every Lab can read the autosave to restore the relevant slice.
//
// Storage budget: a typical mid-density scene serializes to ~3-8 KB
// after JSON.stringify. localStorage's 5 MB ceiling holds ~600 such
// scenes; for a single autoslot we have plenty of headroom. If a user
// loads a project bigger than that, the catch silently no-ops — they
// can still Save manually to disk.
//
// What's autosaved: the full output of serializeProject. What's NOT:
// per-Lab UI state (selected speaker URL, panel collapse, etc) — those
// have their own keys with their own scopes.

export const AUTOSAVE_KEY = 'roomlab.scene.autosave';

let pending = null;
let timer = null;
const DEBOUNCE_MS = 400;

// Read the autosave payload synchronously. Returns null if absent or
// corrupt — callers should fall back to a default scene.
export function readAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Reject obvious corruption — must be an object with the
    // `formatVersion` field that serializeProject emits. (An earlier
    // version of this check looked for `version` and silently rejected
    // every autosave — RoomLAB always booted to the default preset
    // and DeviceLAB's patchAutosave never merged because there was
    // "no existing autosave" to merge into. Single-letter field-name
    // bug, hours of "the autosave doesn't work" pain.)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.formatVersion !== 'number') return null;
    return parsed;
  } catch (err) {
    console.warn('autosave: read failed', err);
    return null;
  }
}

// Patch the autosave with a partial top-level update — used by
// DeviceLAB to overwrite just `rackSystem` without re-serializing the
// whole scene. Caller passes the keys to overwrite; everything else in
// the existing payload is preserved. Returns the merged payload (or
// null if no existing autosave + no fallback to merge into).
export function patchAutosave(patch) {
  const existing = readAutosave();
  if (!existing) {
    // No scene to patch into — DeviceLAB writing rack data when there's
    // no RoomLAB scene yet should not silently create a fake project.
    // Caller decides what to do (typically: do nothing until user
    // visits RoomLAB and an autosave appears).
    return null;
  }
  const merged = { ...existing, ...patch };
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(merged));
    return merged;
  } catch (err) {
    console.warn('autosave: patch write failed', err);
    return null;
  }
}

// Schedule a debounced full-scene write. Coalesces rapid bursts (e.g.
// dragging a slider) so localStorage gets one write per quiet period.
// `serializerFn` is called at flush time to produce the payload, so
// state mutations after the schedule still get captured.
export function scheduleAutosave(serializerFn) {
  pending = serializerFn;
  if (timer) return;
  timer = setTimeout(() => {
    const fn = pending;
    pending = null;
    timer = null;
    if (!fn) return;
    try {
      const payload = fn();
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.warn('autosave: write failed', err);
    }
  }, DEBOUNCE_MS);
}

// Flush a pending write immediately. Useful before navigation to make
// sure the next page sees the latest state. Falls back to a no-op if
// nothing is pending.
export function flushAutosave() {
  if (!timer) return;
  clearTimeout(timer);
  const fn = pending;
  pending = null;
  timer = null;
  if (!fn) return;
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(fn()));
  } catch (err) {
    console.warn('autosave: flush failed', err);
  }
}

// Wipe the autosave — called when the user explicitly loads a project
// file or applies a preset/template (those entry points already reset
// the scene; we don't want a stale autosave to come back next reload).
export function clearAutosave() {
  try { localStorage.removeItem(AUTOSAVE_KEY); }
  catch (err) { console.warn('autosave: clear failed', err); }
}
