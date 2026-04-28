// Lab-local persistence helper. Each Lab can stash its in-memory UI
// state under a namespaced localStorage key so navigating away and
// back doesn't lose work-in-progress (DeviceLAB's half-built rack,
// SpeakerLAB's selected band, etc).
//
// Distinct from js/shared/autosave.js — that bridge is for the SHARED
// scene state every Lab can read/write. This helper is per-Lab UI
// state that doesn't belong in the cross-Lab payload.
//
// Storage convention: every key is prefixed `roomlab.<labId>.<sub>`,
// e.g. `roomlab.devicelab.currentRack`. Values are JSON-encoded.
// Failures (private mode, quota) are caught and logged, never thrown
// — losing autosave shouldn't crash the page.

function makeKey(labId, sub) {
  return `roomlab.${labId}.${sub}`;
}

export function readLab(labId, sub) {
  try {
    const raw = localStorage.getItem(makeKey(labId, sub));
    return raw == null ? null : JSON.parse(raw);
  } catch (err) {
    console.warn(`lab-storage[${labId}.${sub}]: read failed`, err);
    return null;
  }
}

export function writeLab(labId, sub, value) {
  try {
    if (value == null) {
      localStorage.removeItem(makeKey(labId, sub));
    } else {
      localStorage.setItem(makeKey(labId, sub), JSON.stringify(value));
    }
  } catch (err) {
    console.warn(`lab-storage[${labId}.${sub}]: write failed`, err);
  }
}

export function clearLab(labId, sub) {
  try { localStorage.removeItem(makeKey(labId, sub)); }
  catch (err) { console.warn(`lab-storage[${labId}.${sub}]: clear failed`, err); }
}

// Helper: returns a bound { read, write, clear } trio for one Lab so
// callers don't have to repeat the labId everywhere.
export function bindLab(labId) {
  return {
    read:  (sub) => readLab(labId, sub),
    write: (sub, value) => writeLab(labId, sub, value),
    clear: (sub) => clearLab(labId, sub),
  };
}
