// Author's note panel — per-room engineer commentary that renders on the
// print-report cover after the proposal paragraph.
//
// Originally embedded inside panel-room.js (v=550); extracted to its own
// rail-icon at v=552 per user request so the note has a dedicated panel
// and stops competing for vertical space with the room geometry controls.
//
// Toggle: click the rail-icon (data-panel="author-note") below the
// Results icon in the right rail. Content syncs from state.room.
// authorComments — same field as before; preset/template apply seeds
// it via applyPresetToState/applyTemplateToState (CLAUDE.md §3 preset-
// plumbing invariant).

import { state } from '../app-state.js';
import { on } from './events.js';

// Hard cap. v=555: raised 240 → 480 per user request. 480 chars ≈
// 6 justified lines of the proposal-paragraph type on the cover
// column — DOUBLE the previous cap. Trade-off: if the user fills
// the full 480 chars on the densest preset (surau / pavilion) the
// cover MAY spill to page 2. Existing preset/template defaults are
// all under 240 chars so they stay within the safe range; this
// only changes the ceiling for user-typed content.
//
// Enforced by:
//   1. <textarea maxlength=AUTHOR_NOTE_MAX> — keystroke-level cap
//   2. JS trim guard on input — paste from localised keyboard / IME
//      modes can defeat maxlength in some browsers
//   3. Defensive .slice(0, AUTHOR_NOTE_MAX) in buildPrintModel
//      (print-report.js) — schema-bump guard
//   4. .slice(0, 480) in deserializeProject (app-state.js) — clip
//      hand-edited project files that exceed the cap
//   5. tests/preset.test.mjs asserts every preset/template default fits
export const AUTHOR_NOTE_MAX = 480;
const AUTHOR_NOTE_WARN_AT = AUTHOR_NOTE_MAX - 30;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function mountAuthorNotePanel() {
  const root = document.getElementById('panel-author-note');
  if (!root) return;

  root.innerHTML = `
    <h2>Author's note</h2>
    <div class="field-group author-note-row">
      <label class="author-note-label" for="author-note-textarea">Cover commentary
        <textarea id="author-note-textarea"
          class="author-note-textarea"
          maxlength="${AUTHOR_NOTE_MAX}"
          rows="6"
          placeholder="Add a per-room note from the acoustician — appears on the report cover."
          aria-describedby="author-note-counter">${escapeHtml(state.room.authorComments ?? '')}</textarea>
      </label>
      <div class="author-note-meta">
        <span class="author-note-hint">Prints on the report cover.</span>
        <span id="author-note-counter" class="author-note-counter" aria-live="polite">0 / ${AUTHOR_NOTE_MAX}</span>
      </div>
    </div>
  `;

  const ta = root.querySelector('#author-note-textarea');
  const counter = root.querySelector('#author-note-counter');

  const updateCounter = (len) => {
    counter.textContent = `${len} / ${AUTHOR_NOTE_MAX}`;
    counter.classList.toggle('is-warn', len >= AUTHOR_NOTE_WARN_AT && len < AUTHOR_NOTE_MAX);
    counter.classList.toggle('is-over', len >= AUTHOR_NOTE_MAX);
  };

  updateCounter((state.room.authorComments ?? '').length);

  // Debounced write to state.room.authorComments on input + immediate
  // commit on blur so a Print right after typing doesn't race the
  // 250ms debounce timer.
  let debounce = null;
  ta.addEventListener('input', (e) => {
    let v = e.target.value;
    if (v.length > AUTHOR_NOTE_MAX) {
      v = v.slice(0, AUTHOR_NOTE_MAX);
      e.target.value = v;
    }
    updateCounter(v.length);
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.room.authorComments = v;
      debounce = null;
    }, 250);
  });
  ta.addEventListener('blur', (e) => {
    if (debounce) { clearTimeout(debounce); debounce = null; }
    const trimmed = e.target.value.trim().slice(0, AUTHOR_NOTE_MAX);
    e.target.value = trimmed;
    state.room.authorComments = trimmed;
    updateCounter(trimmed.length);
  });

  // Re-sync from state on scene:reset (preset apply, template apply,
  // project file load, blank-custom apply). Per CLAUDE.md §3 invariant:
  // every panel subscribes to scene:reset on mount.
  on('scene:reset', () => {
    const v = (state.room.authorComments ?? '').slice(0, AUTHOR_NOTE_MAX);
    ta.value = v;
    updateCounter(v.length);
  });
}
