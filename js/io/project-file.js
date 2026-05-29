// Project save/load — single `.roomlab.json` file containing the entire
// editable scene (room geometry, speakers, listeners, audience zones,
// ambient noise, master EQ, current selections). Versioned via
// `formatVersion` so future schema changes can migrate older files.
//
// What's saved:           room + sources + listeners + zones + ambient + EQ
//                         + physics toggles + current selection ids
// What's NOT saved:       results.* (recomputed), display.* (UI toggles),
//                         walkthrough camera state, viewport tab.
//
// File handling stays browser-only — no upload to any server. "Save As"
// uses the File System Access API (Chrome/Edge, top-level page) so the
// user picks folder + filename + overwrite; everywhere it's unavailable
// (Firefox/Safari, and inside a cross-origin iframe such as the Google
// Site embed) it degrades to a filename prompt + Blob anchor download.
// Load uses a hidden <input type=file> driven by the panel-room toolbar.

import { state, serializeProject, deserializeProject } from '../app-state.js';
import { emit } from '../ui/events.js';

const FILE_EXTENSION = '.roomlab.json';
const MIME_TYPE = 'application/json';

// --- Pure helpers (Node-testable; no DOM / browser API) ---------------

// Auto-suggested name when the user hasn't typed one: `<base>_<stamp>`.
// `date` is injectable so tests are deterministic; defaults to now.
export function defaultSaveFilename(filenameHint, date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
  const base = (filenameHint && String(filenameHint).trim()) || 'roomlab';
  return `${base}_${stamp}${FILE_EXTENSION}`;
}

// Normalise a user-typed filename: trim, fall back to `fallback` when
// blank, and guarantee a recognised extension so Load's filter sees it.
export function normalizeSaveFilename(typed, fallback) {
  let name = (typed == null ? '' : String(typed)).trim();
  if (!name) name = fallback;
  const lower = name.toLowerCase();
  if (!lower.endsWith(FILE_EXTENSION) && !lower.endsWith('.json')) {
    name += FILE_EXTENSION;
  }
  return name;
}

// --- Browser-side save -------------------------------------------------

// The native folder+name dialog only exists in Chromium and is blocked
// in cross-origin iframes. Probe defensively; the SecurityError catch in
// saveProjectAs is the real safety net when this guess is wrong.
function canUseFilePicker() {
  if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
    return false;
  }
  try {
    if (window.self === window.top) return true;
    // Same-origin iframe → readable; cross-origin → this throws.
    return window.location.origin === window.top.location.origin;
  } catch {
    return false; // cross-origin iframe (the Google Site embed)
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "Save As" — lets the user choose name (and, where supported, folder).
// Resolves with { filename } on success or { cancelled: true } if the
// user dismissed the dialog/prompt; throws only on a genuine write error.
export async function saveProjectAs(filenameHint) {
  const payload = serializeProject(state);
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: MIME_TYPE });
  const suggestedName = defaultSaveFilename(filenameHint);

  // Path A — native Save As dialog (choose folder + name + overwrite).
  if (canUseFilePicker()) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'RoomLAB project', accept: { [MIME_TYPE]: ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { filename: handle.name };
    } catch (err) {
      // User pressed Cancel → not an error.
      if (err && err.name === 'AbortError') return { cancelled: true };
      // SecurityError / NotAllowedError (iframe / permissions-policy) →
      // fall through to the prompt+download path. Re-throw anything else.
      if (!(err && (err.name === 'SecurityError' || err.name === 'NotAllowedError'))) {
        throw err;
      }
    }
  }

  // Path B — filename prompt + Blob download (works everywhere).
  const typed = window.prompt('Save project as (filename):', suggestedName);
  if (typed === null) return { cancelled: true }; // user hit Cancel
  const filename = normalizeSaveFilename(typed, suggestedName);
  downloadBlob(blob, filename);
  return { filename };
}

// Back-compat: silent auto-named download (no prompt). Retained for any
// programmatic callers; the Save As button uses saveProjectAs above.
export function saveProjectToDownload(filenameHint) {
  const payload = serializeProject(state);
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: MIME_TYPE });
  const filename = defaultSaveFilename(filenameHint);
  downloadBlob(blob, filename);
  return filename;
}

// Read a File (from <input type=file>) and apply it to state. Resolves
// with { warnings: string[] } on success, rejects with an Error whose
// message is user-presentable on failure (file not JSON, version too new,
// schema mismatch).
export function loadProjectFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('No file selected.')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (e) {
        reject(new Error('Not a valid RoomLAB project file (JSON parse failed).'));
        return;
      }
      try {
        const result = deserializeProject(parsed);
        // Broadcast just like a preset swap so every panel + the 3D viewport
        // rebuilds against the freshly loaded state.
        emit('scene:reset');
        emit('room:changed');
        resolve(result);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    reader.readAsText(file);
  });
}
