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
// File handling stays browser-only — no upload to any server. Save uses
// a Blob + temporary anchor download; Load uses a hidden <input type=file>
// driven by the panel-room toolbar.

import { state, serializeProject, deserializeProject } from '../app-state.js';
import { emit } from '../ui/events.js';

const FILE_EXTENSION = '.roomlab.json';
const MIME_TYPE = 'application/json';

export function saveProjectToDownload(filenameHint) {
  const payload = serializeProject(state);
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
  const base = filenameHint || 'roomlab';
  a.download = `${base}_${stamp}${FILE_EXTENSION}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return a.download;
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
