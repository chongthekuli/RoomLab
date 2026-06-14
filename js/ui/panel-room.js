import { state, PRESETS, TEMPLATES, SHAPE_LABELS, CEILING_LABELS, applyPresetToState, applyTemplateToState, applyBlankCustomRoom, serializeProject, deserializeProject } from '../app-state.js';
import { emit, on } from './events.js';
import { startDrawCustomShape } from '../graphics/room-2d.js';
import { beginCapture } from '../capture/capture-picker.js';
import { saveLastRoomPointer, saveRoomForUser } from '../auth/firebase-db.js';
import { markClean, isDirty, didLoadFail, setLoadFailed, isReadOnly } from '../state/scene-dirty.js';
import { triggerPrint } from './print-report.js';
import { listCustomRooms, listProjects, latestRoomInProject, saveCustomRoom, getCustomRoomById, deleteCustomRoom, updateCustomRoom, upsertRoomCache, renameProject } from '../state/cloud-rooms.js';
import { getPlacementBindings } from '../graphics/scene.js';
import { PlaceRoomController } from '../graphics/place-room-controller.js';
import { splitParentVsEnclosure } from '../physics/wall-overlap.js';
import { roomPlanVertices } from '../physics/room-shape.js';
import { placeOpeningX } from './opening-placement.js';

// Identity of the saved-custom-room entry the user is currently
// editing (or null when working on a preset / template / freshly-
// loaded scene). Set when the user starts drawing a new custom
// room or clicks an existing chip; cleared when they switch to a
// preset/template/load.
let activeCustomRoomId = null;
// Set by the boot loader (roomlab/main.js) to restore the last-opened room as
// the active one, so edits + Save target the right library entry.
export function setActiveCustomRoomId(id) { activeCustomRoomId = id ?? null; }
// Read the active room id — used by the admin read-only viewer to snapshot the
// admin's editing context before viewing a foreign room, and restore it on exit.
export function getActiveCustomRoomId() { return activeCustomRoomId; }
// Guard that blocks the debounced active-room auto-sync from firing while
// the scene is being swapped wholesale (preset / template / draw-new /
// load). Without it, widening the sync to source/listener/treatment
// events lets a preset's content overwrite the saved custom room the
// instant applyPresetToState mutates the arrays. Set true → swap → false,
// synchronously, and clear any pending sync timer in the same block.
// (Martina review 2026-05-21 — the data-loss path this fix must not open.)
let _suppressSync = false;

// Run a wholesale scene swap (preset / template / draw-new / load) with
// the active-room auto-sync suppressed, and kill any sync the previous
// scene had pending. All the emits inside swapFn are synchronous, so a
// plain try/finally fully brackets the swap — no setTimeout callback can
// run mid-block, so nothing can capture the half-swapped state.
function runSceneSwap(swapFn) {
  _suppressSync = true;
  try { swapFn(); }
  finally {
    if (_autoSyncTimer) { clearTimeout(_autoSyncTimer); _autoSyncTimer = null; }
    _suppressSync = false;
  }
}

// Force the document back to the top after the soft keyboard dismisses.
// On Android Chrome the keyboard raised for the custom-room name inputs
// pans the page up; with the fixed / overflow:hidden app shell that
// offset sticks, hiding the top tab-bar + left rail. Which element holds
// the residual scroll is browser-dependent, so reset every candidate.
// Each line is a harmless no-op when there's nothing scrolled (desktop).
function resetShellScroll() {
  try {
    window.scrollTo(0, 0);
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  } catch { /* defensive — never let a scroll reset break the draw flow */ }
}
// Names captured from the two-prompt flow, held until the polygon
// closes (roomshape:closed) so the new entry gets the right labels.
let pendingProjectName = null;
let pendingRoomName = null;

// Author's note (state.room.authorComments) was moved out of this panel
// at v=552 into its own dedicated panel — see js/ui/panel-author-note.js.
// AUTHOR_NOTE_MAX lives there now; this panel no longer touches that
// field. State plumbing in applyPresetToState / applyTemplateToState /
// deserializeProject is unchanged.

const RECT_SURFACE_LABELS = [
  ['floor',      'Floor'],
  ['ceiling',    'Ceiling'],
  ['wall_north', 'Wall — Front'],
  ['wall_south', 'Wall — Back'],
  ['wall_east',  'Wall — Right'],
  ['wall_west',  'Wall — Left'],
];

const NONRECT_SURFACE_LABELS = [
  ['floor',   'Floor'],
  ['ceiling', 'Ceiling'],
  ['walls',   'Walls (all)'],
];

let materialsRef;

// Prompt before any preset / template change that would silently destroy
// the user's current work. Returns true when the scene is empty (nothing
// to lose, no prompt needed) OR the user accepts the prompt; false on
// cancel. Caller must revert the dropdown's value on false so the UI
// doesn't show the new selection while keeping the old scene. Counts
// scene-mutating fields the resetSceneState path wipes: sources,
// listeners, zones, treatments, sub-structures, standalone enclosures,
// shared wall segments. Priya UAT v=467 item #3.
function confirmDestructiveSceneChange(newSceneLabel) {
  const sourceCount    = state.sources?.length ?? 0;
  const listenerCount  = state.listeners?.length ?? 0;
  const zoneCount      = state.zones?.length ?? 0;
  const treatmentCount = state.treatments?.length ?? 0;
  const subCount       = state.room?.subStructures?.length ?? 0;
  const encCount       = state.room?.standaloneEnclosures?.length ?? 0;
  const segCount       = state.room?.wallSegments?.length ?? 0;
  const total = sourceCount + listenerCount + zoneCount + treatmentCount
              + subCount + encCount + segCount;
  if (total === 0) return true;
  const parts = [];
  if (sourceCount)    parts.push(`${sourceCount} source${sourceCount > 1 ? 's' : ''}`);
  if (listenerCount)  parts.push(`${listenerCount} listener${listenerCount > 1 ? 's' : ''}`);
  if (zoneCount)      parts.push(`${zoneCount} zone${zoneCount > 1 ? 's' : ''}`);
  if (treatmentCount) parts.push(`${treatmentCount} treatment${treatmentCount > 1 ? 's' : ''}`);
  if (subCount + encCount + segCount > 0) parts.push('custom geometry');
  const msg = `Loading "${newSceneLabel}" will replace your current scene `
            + `(${parts.join(', ')}). Continue?`;
  return window.confirm(msg);
}

export function mountRoomPanel({ materials }) {
  materialsRef = materials;
  const root = document.getElementById('panel-room');
  root.innerHTML = `
    <h2>Room</h2>
    <div class="field-group room-name-row">
      <span class="room-eyebrow">Active room</span>
      <label title="Free-text label for this room — shows on the print-report cover under the project name. Distinct from the project name (one project can hold several rooms).">Name
        <input type="text" id="room-name-input" placeholder="e.g. Lobby, Atrium 3F, Main hall" value="${escapeAttr(state.room.name ?? '')}" maxlength="80" />
      </label>
    </div>
    <div class="picker-row">
      <span class="picker-label" title="Signature pre-built scenes that load with their full geometry, audience, and PA system as authored.">Presets</span>
      <select class="picker-dropdown" id="preset-dropdown" title="Choose a signature pre-built scene to load verbatim.">
        <option value="">— Choose a preset —</option>
      </select>
    </div>
    <div class="picker-row">
      <span class="picker-label" title="Parametric room shapes — pick a starting layout and edit the dimensions below to whatever size you need. The speakers and listener auto-scale with the room.">Templates</span>
      <select class="picker-dropdown" id="template-dropdown" title="Choose a parametric room template — dimensions are editable after loading.">
        <option value="">— Choose a template —</option>
      </select>
    </div>
    <div class="picker-row">
      <span class="picker-label" title="Draw your own room outline on the 2D floor plan — click to place vertices, click point 1 to close the loop. Snap is 0.5 m.">Custom</span>
      <div class="picker-buttons">
        <button id="btn-draw-custom-room" class="btn-custom-draw" title="Open the 2D floor plan in draw mode. Click to place vertices, click point 1 to close.">✎ Draw custom room</button>
        <button id="btn-place-saved-room" class="btn-custom-draw" title="Embed a saved room as a sub-structure inside THIS room — a hut in a park, a kiosk, a balcony. Does not switch which room you're editing.">⊕ Place</button>
      </div>
    </div>
    <div id="saved-rooms-tree" class="saved-rooms-tree"></div>
    <div id="sub-structures-row" class="custom-saved-row"></div>
    <div id="sub-structure-detail" class="sub-structure-detail" hidden></div>
    <div id="import-status" class="import-status" hidden></div>
    <h3>Shape</h3>
    <div class="field-group">
      <label>Plan shape
        <select data-f="shape">
          ${Object.entries(SHAPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
      </label>
      <label title="Indoor: enclosed room, Sabine reverberation. Outdoor: no roof, energy escapes upward — RT60 falls toward zero. Use Outdoor for parks, plazas, courtyards.">Type
        <select data-f="enclosure">
          <option value="indoor">Indoor (with roof)</option>
          <option value="outdoor">Outdoor (no roof)</option>
        </select>
      </label>
    </div>
    <div id="shape-params"></div>
    <h3>Surfaces</h3>
    <div id="treatment-preset-row" class="treatment-preset-row"></div>
    <div id="surface-materials"></div>
  `;

  // Presets dropdown — signature scenes (Arena, Pavilion, Surau) load
  // verbatim. Refactored from a button row to a dropdown 2026-05-17 so
  // adding presets doesn't visually clutter the panel. Picking '' (the
  // placeholder) is a no-op; only real keys fire applyPreset.
  const presetDropdown = root.querySelector('#preset-dropdown');
  for (const [key, p] of Object.entries(PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    presetDropdown.appendChild(opt);
  }
  presetDropdown.addEventListener('change', (e) => {
    const key = e.target.value;
    if (!key) return;
    const label = PRESETS[key]?.label ?? key;
    if (!confirmDestructiveSceneChange(label)) {
      e.target.value = '';   // revert dropdown so the UI doesn't lie about state
      return;
    }
    applyPreset(key);
    // Reset the OTHER dropdown so the UI shows one active selection at a time.
    const td = root.querySelector('#template-dropdown');
    if (td) td.value = '';
  });

  // Templates dropdown — parametric rooms regenerate when the user
  // changes dimensions. Tracks which template was last applied so
  // dimension edits can re-call generate(dims) with the user's overrides.
  const templateDropdown = root.querySelector('#template-dropdown');
  for (const [key, t] of Object.entries(TEMPLATES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = t.label;
    templateDropdown.appendChild(opt);
  }
  templateDropdown.addEventListener('change', (e) => {
    const key = e.target.value;
    if (!key) return;
    const label = TEMPLATES[key]?.label ?? key;
    if (!confirmDestructiveSceneChange(label)) {
      e.target.value = '';   // revert dropdown so the UI doesn't lie about state
      return;
    }
    applyTemplate(key);
    // Reset the OTHER dropdown so the UI shows one active selection at a time.
    const pd = root.querySelector('#preset-dropdown');
    if (pd) pd.value = '';
  });

  // Saved-rooms library is now a TREE below the Custom row
  // (#saved-rooms-tree), rendered + wired by renderSavedRoomsTree() on every
  // render(). It reads listProjects() and NEVER filters by state.projectName,
  // so a saved room is always reachable regardless of the active scene — the
  // fix for the 2026-05-21 "unreachable after switching to a preset" bug.
  // Its rows attach their own listeners on each render (the tree is rebuilt
  // wholesale), so there's no persistent <select> listener to bind here.

  // Custom row — entry to the draw-custom-room flow.
  //
  // Full state reset (sources / listeners / zones / structures all gone)
  // so a custom room never overlays the previous preset's geometry.
  // Then ask for an optional project name (Hospital Serdang, Theatre A —
  // concept 3 …) before drawing — the name flows through save/share/
  // print exports.
  root.querySelector('#btn-place-saved-room').addEventListener('click', () => {
    startPlaceSavedRoomFlow();
  });

  root.querySelector('#btn-draw-custom-room').addEventListener('click', () => {
    // Project picker — when at least one project already exists, show a
    // modal so the user can either (a) attach the new room to an existing
    // project or (b) create a new project. On the first ever custom room
    // (no projects yet), skip the picker and go straight to a single
    // "Project + room name" prompt — no point picking from an empty list.
    showCustomRoomDialog().then(result => {
      if (!result) return;
      const { projectName, roomName } = result;
      pendingProjectName = projectName;
      pendingRoomName = roomName;
      // Mobile keyboard-shift fix (v=769): on Android Chrome the soft
      // keyboard raised for the name inputs pans the page up; in a
      // position:fixed / overflow:hidden shell that scroll offset STICKS
      // after the modal closes, leaving the top tab-bar + left rail above
      // the visible edge. The viewport meta `interactive-widget=
      // resizes-content` is the primary cure; this is defense-in-depth for
      // engines that still leave residual scroll. Reset every candidate
      // scroller (which one moved is browser-dependent) immediately and
      // once more after the keyboard-dismiss settles (async). No-op on
      // desktop where there's nothing scrolled.
      resetShellScroll();
      runSceneSwap(() => {
        activeCustomRoomId = null;     // a fresh draw starts a new entry
        applyBlankCustomRoom({ projectName });
        activeTemplateKey = null;
        render();
        emit('scene:reset');     // panels rebuild — the previous scene's data is gone
        emit('room:changed');
      });
      document.querySelector('.vp-tab[data-view="2d"]')?.click();
      setTimeout(() => startDrawCustomShape(), 50);
      // Second pass — the keyboard dismiss + scroll settle is async, so a
      // single synchronous reset can be undone by the late pan.
      setTimeout(resetShellScroll, 250);
    });
  });

  // Save / Load / Share / Print buttons live in the top header now
  // (rendered by js/shared/header-nav.js so they're visible on every
  // Lab route). Handlers are still bound here because RoomLAB owns
  // the scene state these actions operate on; the click bindings
  // attach when RoomLAB mounts.
  document.getElementById('btn-save-project')?.addEventListener('click', saveActiveRoom);
  // Reflect unsaved-changes state on the Save button, and set the initial label.
  on('scene:dirty-changed', updateSaveButton);
  updateSaveButton();

  document.getElementById('btn-print-report')?.addEventListener('click', async () => {
    // Gate: report generation requires a FRESH precision render. The
    // precision tab caches state.results.precision when the user clicks
    // Render; any scene edit (room / source / listener / zone /
    // treatment / EQ) sets state.results.engines.precision.staleAt so
    // the user must re-render before generating a report.
    const hasPrecision = !!state.results?.precision;
    const isStale = hasPrecision && !!state.results?.engines?.precision?.staleAt;
    if (!hasPrecision) {
      showStatus('Run a Precision Render first (right rail · precision icon) — Print is disabled until then.', 'err');
      return;
    }
    if (isStale) {
      showStatus('Scene has changed since the last precision render. Re-render before printing — open the Precision panel and click Render.', 'err');
      return;
    }
    try {
      // triggerPrint is now async — it awaits the 3D viewport capture
      // for the cover hero before invoking window.print(). Awaiting
      // here means showStatus on the error path catches both sync and
      // async failures.
      await triggerPrint();
    } catch (err) {
      showStatus(`Print failed: ${err.message || err}`, 'err');
    }
  });

  // Reflect the precision freshness in the button's appearance + title
  // so the user sees Print is gated BEFORE clicking. Driven by every
  // event that markStale subscribes to plus the precision:changed event
  // that fires after a successful render or reset.
  const printBtn = document.getElementById('btn-print-report');
  if (printBtn) {
    const syncPrintBtnState = () => {
      const hasPrecision = !!state.results?.precision;
      const isStale = hasPrecision && !!state.results?.engines?.precision?.staleAt;
      const blocked = !hasPrecision || isStale;
      printBtn.classList.toggle('btn-print-blocked', blocked);
      printBtn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
      // Two channels: native `title` for OS tooltip + a custom CSS tooltip
      // driven by data-block-reason that appears IMMEDIATELY on hover when
      // blocked (the native title takes ~1 s to appear, which feels slow
      // when the user clicks Print and gets nothing). The CSS tooltip is
      // styled in main.css `.btn-print-blocked:hover::after`.
      let reason = '';
      if (!hasPrecision) {
        reason = 'Run Precision Render first. Open the Precision panel (right rail · target icon) and click Render. Print enables when the render finishes.';
      } else if (isStale) {
        reason = 'Scene has changed since the last render. Open the Precision panel (right rail · target icon) and click Render again to refresh. Print enables when the new render finishes.';
      }
      if (blocked) {
        printBtn.setAttribute('data-block-reason', reason);
        printBtn.title = reason;
      } else {
        printBtn.removeAttribute('data-block-reason');
        printBtn.title = 'Print a multi-page proposal of the current scene.';
      }
    };
    syncPrintBtnState();
    on('precision:changed', syncPrintBtnState);
    on('room:changed', syncPrintBtnState);
    on('source:changed', syncPrintBtnState);
    on('source:model_changed', syncPrintBtnState);
    on('listener:changed', syncPrintBtnState);
    on('zone:changed', syncPrintBtnState);
    on('treatment:changed', syncPrintBtnState);
    on('physics:eq_changed', syncPrintBtnState);
    on('scene:reset', syncPrintBtnState);
  }

  // Room name — text input at the top of the panel. 'input' fires per
  // keystroke (cheap — only mutates a string field). We don't emit
  // 'room:changed' because the renderer doesn't care about the label;
  // the print-report reads it directly when the user prints. Trim on
  // commit (blur) so trailing whitespace doesn't sneak into the cover.
  const roomNameInput = root.querySelector('#room-name-input');
  if (roomNameInput) {
    roomNameInput.addEventListener('input', e => {
      state.room.name = e.target.value;
    });
    roomNameInput.addEventListener('blur', e => {
      const trimmed = e.target.value.trim();
      if (trimmed !== e.target.value) {
        e.target.value = trimmed;
        state.room.name = trimmed;
      }
    });
  }

  // (Author's note input handlers moved to js/ui/panel-author-note.js
  // at v=552 along with the UI extraction.)

  // After a custom-shape draw closes:
  //   1. Persist the custom room to localStorage so the user can come
  //      back to it later via the chip in the CUSTOM row (the names
  //      come from the two prompts captured in pendingProjectName /
  //      pendingRoomName when they clicked Draw custom room).
  //   2. Scroll the height input into view and focus + select-all so
  //      the user can replace it with one keystroke. Per Maya's §7:
  //      refused a modal "set room height" dialog — modal would block
  //      the user from looking at the floor plan they just drew.
  document.addEventListener('roomshape:closed', () => {
    try {
      // Bake the captured room name into state.room BEFORE snapshotting,
      // so the saved entry's scene blob itself carries the label and the
      // print-report cover renders it on first load.
      if (typeof pendingRoomName === 'string' && pendingRoomName.trim()) {
        state.room.name = pendingRoomName.trim();
      }
      // Store a FULL scene snapshot (same serializer as 💾 Save →
      // .roomlab.json) so sources / listeners / zones / treatments /
      // physics / author notes all persist with the room — not just
      // geometry. At draw-complete the scene is mostly the new room; the
      // debounced auto-sync (scheduleActiveRoomSync) keeps it current as
      // the user then adds speakers/listeners. See custom-rooms.js.
      const entry = saveCustomRoom({
        projectName: pendingProjectName,
        roomName: pendingRoomName,
        scene: serializeProject(),
      });
      activeCustomRoomId = entry.id;
      // Re-render the room panel so the new chip appears immediately.
      render();
      // Notify the header (and any other listeners) that the saved-rooms
      // library changed — the project list may have grown so the header
      // dropdown needs to re-evaluate.
      emit('projects:changed');
    } catch (err) {
      console.warn('failed to persist custom room', err);
    }
    pendingProjectName = null;
    pendingRoomName = null;

    setTimeout(() => {
      const heightInput = document.querySelector('#shape-params input[data-sf="height_m"]');
      if (heightInput) {
        heightInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        heightInput.focus();
        heightInput.select?.();
      }
    }, 100);
  });

  // File-based "Load" retired (v=830) — scenes live in the user's account now,
  // loaded automatically on sign-in. The inbound #R… share-link hash loader
  // still works (js/io/share-link.js) so existing share URLs open.

  // (DXF import removed 2026-06-14 — feature not ready for release.)

  root.querySelector('[data-f="shape"]').addEventListener('change', e => {
    state.room.shape = e.target.value;
    if (e.target.value === 'custom' && (!state.room.custom_vertices || state.room.custom_vertices.length < 3)) {
      // Seed with a default L-shape so user sees something before drawing
      state.room.custom_vertices = [
        { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }, { x: 2.5, y: 3 }, { x: 2.5, y: 5 }, { x: 0, y: 5 },
      ];
      state.room.width_m = 5;
      state.room.depth_m = 5;
      // Deep-clone the seed per edge — `.map(() => surfaces.walls)` would
      // alias ONE object reference into every edge, so a later door add on
      // one wall leaked to all (2026-06-04). cloneSlotSeed keeps strings
      // as-is, deep-copies objects.
      state.room.surfaces.edges = state.room.custom_vertices.map(() => cloneSlotSeed(state.room.surfaces.walls));
    }
    syncBoundingBoxToShape();
    // Manual shape change drops any active template association — the
    // user is hand-editing the room, so dimension changes shouldn't
    // re-run a template generator.
    activeTemplateKey = null;
    render();
    emit('room:changed');
  });
  // NOTE: the ceiling_type <select> is no longer in the static template —
  // it now lives inside the Ceiling group rendered by renderSurfaceMaterials()
  // (so ceiling SHAPE + ceiling MATERIAL read as one surface, not two
  // disconnected "Ceiling" controls). Its change handler is wired per-render
  // in renderCeilingTypeRow(); don't query it here at mount.
  root.querySelector('[data-f="enclosure"]').addEventListener('change', e => {
    state.room.enclosure = e.target.value;
    render();
    emit('room:changed');
  });

  render();
}

// Tracks which template (if any) is the live "source" of the current
// room. While set, dimension edits in the Shape section regenerate the
// template's sources/listeners so the layout stays consistent. Cleared
// when the user applies a Preset, draws a custom shape, or loads a saved room.
let activeTemplateKey = null;

function showStatus(text, kind) {
  const status = document.getElementById('import-status');
  if (!status) return;
  status.hidden = false;
  status.className = 'import-status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
  status.textContent = text;
}

// Cloud Save — persist the current scene to the user's account (Firestore).
// Explicit only (no autosave). Confirms first if the boot scene-load failed
// (offline), so we don't overwrite the user's real cloud scene with edits made
// on top of a fallback default.
// Explicit, DEFINITIVE Save — writes the active room to the user's cloud
// library and awaits the result (no optimistic "maybe saved"). If there's no
// active room yet (a preset/template the user hasn't named), it acts as
// "Save As": prompts for a project + room name first.
async function saveActiveRoom() {
  // Read-only admin viewer: Save is structurally blocked. The scene loaded is
  // another user's room (the Firestore rules also deny an admin write); editing
  // + Save are disabled so the admin can't believe they changed the user's work.
  if (isReadOnly()) { showStatus('Read-only view — you can’t save changes to another user’s room.', 'err'); return; }
  const btn = document.getElementById('btn-save-project');
  const uid = (typeof window !== 'undefined' && window.__auralabAuth?.user?.uid) || null;
  if (!uid) { showStatus('Not signed in — can’t save.', 'err'); return; }

  // Build the entry to write: update the active room, or create+name a new one.
  let entry = activeCustomRoomId ? getCustomRoomById(activeCustomRoomId) : null;
  if (entry) {
    entry = {
      ...entry,
      scene: serializeProject(),
      projectName: state.projectName ?? entry.projectName ?? null,
      roomName: (state.room?.name && state.room.name.trim()) ? state.room.name.trim() : entry.roomName,
      savedAt: new Date().toISOString(),
    };
  } else {
    const dlg = await showCustomRoomDialog();   // { projectName, roomName } | null
    if (!dlg || dlg.roomName == null) return;   // cancelled
    entry = {
      id: 'cr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      projectName: (dlg.projectName && dlg.projectName.trim()) || null,
      roomName: (dlg.roomName && dlg.roomName.trim()) || `Untitled · ${new Date().toLocaleString()}`,
      scene: serializeProject(),
      savedAt: new Date().toISOString(),
    };
    state.projectName = entry.projectName;
    if (entry.roomName && !state.room.name) state.room.name = entry.roomName;
  }

  if (btn) { btn.disabled = true; btn.textContent = '💾 Saving…'; }
  let res;
  try { res = await saveRoomForUser(uid, entry); }
  catch (err) { res = { ok: false, code: 'write-failed' }; }
  if (btn) btn.disabled = false;

  if (res.ok) {
    activeCustomRoomId = entry.id;
    upsertRoomCache(entry);                 // reflect in the cache (already written) — emits projects:changed
    saveLastRoomPointer(uid, entry.id);     // boot restores this room next time
    setLoadFailed(false);
    markClean();
    _ensureProjectExpanded(entry.projectName);  // keep the just-saved room visible
    renderSavedRoomsTree();                 // active marking + new row
    showStatus('Saved to your account.', 'ok');
  } else if (res.code === 'too-large') {
    showStatus('Scene too large to save — reduce sub-structures, treatments or furniture.', 'err');
  } else if (res.code === 'permission-denied') {
    showStatus('Save was DENIED by the database. The Firestore rules are not published yet — paste firestore.rules into Firebase console → Firestore → Rules → Publish, then try again.', 'err');
    console.error('[save] permission-denied — re-publish firestore.rules (the accounts/{uid}/rooms rule).');
  } else if (res.code === 'no-db') {
    showStatus('Database unavailable — is Firestore enabled in the Firebase console?', 'err');
  } else {
    showStatus(`Couldn’t save (${res.code || 'error'}) — check your connection and try again.`, 'err');
    console.error('[save] failed:', res);
  }
  updateSaveButton();
}

// Reflect unsaved-changes state on the header Save button.
function updateSaveButton() {
  const btn = document.getElementById('btn-save-project');
  if (!btn || btn.disabled) return;   // skip mid-save (label is "Saving…")
  const dirty = isDirty();
  btn.textContent = dirty ? '💾 Save •' : '💾 Save';
  btn.classList.toggle('btn-save-dirty', dirty);
}

// Transient bottom-of-viewport toast — used for success acks where the
// import-status banner would be too sticky / formal (link copied,
// shared scene loaded). Replaces any prior toast so rapid clicks don't
// stack messages.
export function showToast(text, kind = 'ok', durationMs = 2500) {
  document.querySelectorAll('.rl-toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = `rl-toast rl-toast-${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  // Force a reflow so the .show class triggers a transition rather than
  // applying instantly — no fade-in otherwise.
  void el.offsetHeight;
  el.classList.add('show');
  const dismiss = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  };
  const t = setTimeout(dismiss, durationMs);
  el.addEventListener('click', () => { clearTimeout(t); dismiss(); });
}

// Modal for "Draw custom room" — picks the parent project (existing or
// new) and the new room's name. Replaces the back-to-back window.prompt
// calls so:
//   1. Repeat customers can attach a new room to an existing project
//      with one click instead of retyping the project name exactly.
//   2. The whole flow is one focus-trapped step the user can Esc out of
//      cleanly, instead of two sequential alerts.
// Returns a Promise<{ projectName: string|null, roomName: string|null } | null>.
// Null result === user cancelled.
function showCustomRoomDialog() {
  return new Promise(resolve => {
    const projects = listProjects();
    const hasExisting = projects.length > 0;

    const overlay = document.createElement('div');
    overlay.className = 'rl-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'rl-modal rl-custom-room-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'New custom room');

    const projectsList = projects.map(p => {
      const display = p.name === '(Unfiled)' ? '(Unfiled)' : escapeHtml(p.name);
      const count = p.rooms.length;
      const suffix = ` <span class="rl-modal-count">${count} room${count === 1 ? '' : 's'}</span>`;
      return `
        <label class="rl-modal-radio-row">
          <input type="radio" name="rl-proj-pick" value="${escapeAttr(p.name)}" />
          <span class="rl-modal-radio-text">${display}${suffix}</span>
        </label>`;
    }).join('');

    modal.innerHTML = `
      <h3>New custom room</h3>
      <div class="rl-modal-section">
        <label class="rl-modal-label">Project</label>
        ${hasExisting ? `
          <div class="rl-modal-projects">${projectsList}
            <label class="rl-modal-radio-row">
              <input type="radio" name="rl-proj-pick" value="__new__" checked />
              <span class="rl-modal-radio-text"><strong>+ New project</strong></span>
            </label>
          </div>
          <input type="text" id="rl-modal-new-proj" class="rl-modal-input" placeholder="Project name — e.g. Hospital Serdang" />
        ` : `
          <input type="text" id="rl-modal-new-proj" class="rl-modal-input" placeholder="Project name — e.g. Hospital Serdang" autofocus />
        `}
      </div>
      <div class="rl-modal-section">
        <label class="rl-modal-label" for="rl-modal-room-name">Room name</label>
        <input type="text" id="rl-modal-room-name" class="rl-modal-input" placeholder="e.g. Lobby, Atrium 3F, Main hall" />
      </div>
      <div class="rl-modal-actions">
        <button type="button" class="rl-modal-cancel">Cancel</button>
        <button type="button" class="rl-modal-confirm">Draw room</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const newProjInput = modal.querySelector('#rl-modal-new-proj');
    const roomInput = modal.querySelector('#rl-modal-room-name');
    const radios = modal.querySelectorAll('input[name="rl-proj-pick"]');

    // When the user clicks an existing-project radio, the new-project
    // text field becomes irrelevant — visually dim it. When they click
    // back to "+ New project", focus the text field for typing.
    const updateRadioState = () => {
      const sel = modal.querySelector('input[name="rl-proj-pick"]:checked');
      const isNew = !sel || sel.value === '__new__';
      newProjInput.disabled = !isNew;
      newProjInput.style.opacity = isNew ? '1' : '0.45';
      if (isNew) newProjInput.focus();
    };
    radios.forEach(r => r.addEventListener('change', updateRadioState));
    updateRadioState();
    if (!hasExisting) newProjInput.focus();

    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && (e.target === newProjInput || e.target === roomInput)) {
        e.preventDefault();
        confirm();
      }
    };
    const confirm = () => {
      const sel = modal.querySelector('input[name="rl-proj-pick"]:checked');
      let projectName = null;
      if (sel && sel.value !== '__new__') {
        // Existing project — '(Unfiled)' bucket maps back to null on save.
        projectName = (sel.value === '(Unfiled)') ? null : sel.value;
      } else {
        const v = newProjInput.value.trim();
        projectName = v.length > 0 ? v : null;
      }
      const roomName = roomInput.value.trim() || null;
      close({ projectName, roomName });
    };
    modal.querySelector('.rl-modal-cancel').addEventListener('click', () => close(null));
    modal.querySelector('.rl-modal-confirm').addEventListener('click', confirm);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);
  });
}

function syncBoundingBoxToShape() {
  const s = state.room.shape;
  if (s === 'polygon') {
    const r = state.room.polygon_radius_m;
    state.room.width_m = 2 * r;
    state.room.depth_m = 2 * r;
  } else if (s === 'round') {
    const r = state.room.round_radius_m;
    state.room.width_m = 2 * r;
    state.room.depth_m = 2 * r;
  }
}

function render() {
  const root = document.getElementById('panel-room');
  // Room name — sync the input from state in case a preset / template /
  // load just updated it. The input is uncontrolled between renders.
  const nameIn = root.querySelector('#room-name-input');
  if (nameIn) nameIn.value = state.room.name ?? '';
  // (Author's note sync moved to js/ui/panel-author-note.js at v=552 —
  // it subscribes to scene:reset and re-syncs its textarea + counter.)
  root.querySelector('[data-f="shape"]').value = state.room.shape;
  root.querySelector('[data-f="enclosure"]').value = state.room.enclosure ?? 'indoor';
  // Outdoor (no roof) is handled inside renderSurfaceMaterials(): the whole
  // Ceiling group (shape + material) is skipped, and Floor is relabelled
  // "Ground". Ceiling shape/material no longer live in the static template,
  // so there's no separate header/field-group to toggle here.
  renderShapeParams();
  renderSurfaceMaterials();
  renderSavedRoomsTree();
  renderPlacedSubStructures();
}

// List the sub-structures placed inside the current room with delete
// chips. Click × removes the sub from state.room.subStructures and
// emits room:changed so the 3D + 2D viewports drop it.
//
// The chip for the currently-selected sub gets the .active class
// (mirrors the saved-rooms chip pattern) AND surfaces an extra
// "Break" button that converts the sub into editable parent walls
// (see breakSubStructureToEnclosure below).
function renderPlacedSubStructures() {
  const host = document.getElementById('sub-structures-row');
  if (!host) return;
  const subs = Array.isArray(state.room.subStructures) ? state.room.subStructures : [];
  if (subs.length === 0) {
    host.innerHTML = '';
    renderSubStructureDetail();   // hides the detail panel too
    return;
  }
  const selId = state.selectedSubStructureId ?? null;
  host.innerHTML = `<span class="custom-saved-banner" title="Saved rooms placed inside this room (visual only — Phase 2 will add acoustic merging)">Placed:</span>` + subs.map(s => {
    const lbl = escapeHtml(s.sourceRoomName || 'Sub-room');
    const tip = `at (${(s.position?.x_m ?? 0).toFixed(1)}, ${(s.position?.y_m ?? 0).toFixed(1)}) m · elev ${(s.elevation_m ?? 0).toFixed(2)} m · rot ${(s.rotation_deg ?? 0)|0}°`;
    const isSel = s.id === selId;
    // Break button is only shown on the selected chip — keeps the row
    // compact when many subs are placed and signals the action follows
    // the selection in 3D.
    const breakBtn = isSel
      ? `<button class="custom-chip-break" type="button" title="Convert to editable walls — you won't be able to move it as one piece anymore" aria-label="Break to merge">⇪</button>`
      : '';
    return `
      <span class="custom-chip${isSel ? ' active' : ''}" data-sub-id="${escapeAttr(s.id)}" title="${escapeAttr(tip)}">
        <button class="custom-chip-load" type="button">${lbl}</button>
        ${breakBtn}
        <button class="custom-chip-delete" type="button" title="Remove this placement" aria-label="Remove">×</button>
      </span>`;
  }).join('');
  host.querySelectorAll('.custom-chip-delete').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.parentElement?.dataset.subId;
      if (!id) return;
      state.room.subStructures = (state.room.subStructures ?? []).filter(s => s.id !== id);
      if (state.selectedSubStructureId === id) state.selectedSubStructureId = null;
      emit('room:changed');
      renderPlacedSubStructures();
    });
  });
  // Click the chip's load button to select-from-sidebar (mirror of the
  // 3D click-to-select). Also scrolls 3D focus around it implicitly
  // because the highlight follows state.selectedSubStructureId.
  host.querySelectorAll('.custom-chip-load').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.parentElement?.dataset.subId;
      if (!id) return;
      const next = state.selectedSubStructureId === id ? null : id;
      state.selectedSubStructureId = next;
      emit('sub_structure:selected', { id: next });
      renderPlacedSubStructures();
    });
  });
  host.querySelectorAll('.custom-chip-break').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.parentElement?.dataset.subId;
      if (!id) return;
      const sub = (state.room.subStructures ?? []).find(s => s.id === id);
      if (!sub) return;
      showBreakConfirm(sub.sourceRoomName).then(yes => {
        if (!yes) return;
        breakSubStructureToEnclosure(id);
      });
    });
  });
  // Auto-scroll the active chip into view so a fresh 3D selection
  // surfaces in the sidebar.
  if (selId) {
    const activeEl = host.querySelector(`.custom-chip.active`);
    activeEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
  renderSubStructureDetail();
}

// Detail panel for the currently-selected sub-structure. Appears under the
// chip row when something is selected and gives the user numeric edit
// controls — drag-placement is good for rough positioning, but for the
// exact 'put it 5.5 m east of the parent's south wall' use case the user
// needs to type the value. Hidden when nothing is selected.
//
// Snap is 0.5 m for X / Y / Z (matches the placement controller and the
// custom-room drawing tool); rotation snaps to 1 degree.
function renderSubStructureDetail() {
  const host = document.getElementById('sub-structure-detail');
  if (!host) return;
  const selId = state.selectedSubStructureId ?? null;
  if (!selId) { host.hidden = true; host.innerHTML = ''; return; }
  const subs = Array.isArray(state.room.subStructures) ? state.room.subStructures : [];
  const sub = subs.find(s => s.id === selId);
  if (!sub) { host.hidden = true; host.innerHTML = ''; return; }

  const px = (sub.position?.x_m ?? 0).toFixed(2);
  const py = (sub.position?.y_m ?? 0).toFixed(2);
  const pz = (sub.elevation_m ?? 0).toFixed(2);
  const pr = (sub.rotation_deg ?? 0).toFixed(0);
  const lbl = escapeHtml(sub.sourceRoomName || 'Sub-room');

  host.hidden = false;
  host.innerHTML = `
    <div class="sub-detail-head">
      <span class="sub-detail-title">Selected: ${lbl}</span>
      <button type="button" class="sub-detail-close" title="Deselect (click empty space in 3D also works)" aria-label="Deselect">×</button>
    </div>
    <div class="sub-detail-grid">
      <label>X <input type="number" step="0.5" value="${px}" data-sub-field="x_m" /> <span class="unit">m</span></label>
      <label>Y <input type="number" step="0.5" value="${py}" data-sub-field="y_m" /> <span class="unit">m</span></label>
      <label>Z <input type="number" step="0.5" value="${pz}" data-sub-field="elevation_m" /> <span class="unit">m</span></label>
      <label>Rotation <input type="number" step="1" value="${pr}" data-sub-field="rotation_deg" /> <span class="unit">°</span></label>
    </div>
    <div class="sub-detail-actions">
      <button type="button" class="sub-detail-break" title="Convert to editable walls — you won't be able to move it as one piece anymore">⇪ Break to merge</button>
      <button type="button" class="sub-detail-delete" title="Remove this placement entirely">× Delete</button>
    </div>
    <div class="sub-detail-hint">Tip: snap is 0.5 m. Type a value or use the spinner.</div>
  `;

  // Wire numeric edits — 0.5 m snap on positional fields keeps the
  // detail panel consistent with drag-placement. Rotation rounds to 1°.
  const SNAP = 0.5;
  const roundXY = v => Math.round(v / SNAP) * SNAP;
  host.querySelectorAll('input[data-sub-field]').forEach(input => {
    input.addEventListener('input', (e) => {
      const field = e.target.dataset.subField;
      let v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      if (field === 'x_m')         { sub.position.x_m   = roundXY(v); }
      else if (field === 'y_m')    { sub.position.y_m   = roundXY(v); }
      else if (field === 'elevation_m') { sub.elevation_m = roundXY(v); }
      else if (field === 'rotation_deg') {
        sub.rotation_deg = ((Math.round(v) % 360) + 360) % 360;
      }
      emit('room:changed');
      // Re-render the chip tooltip + this panel so the new values reflect
      // back into the inputs (in case snap rounded their typing).
      renderPlacedSubStructures();
    });
  });

  host.querySelector('.sub-detail-close').addEventListener('click', () => {
    state.selectedSubStructureId = null;
    emit('sub_structure:selected', { id: null });
    renderPlacedSubStructures();
  });
  host.querySelector('.sub-detail-break').addEventListener('click', () => {
    showBreakConfirm(sub.sourceRoomName).then(yes => {
      if (!yes) return;
      breakSubStructureToEnclosure(sub.id);
    });
  });
  host.querySelector('.sub-detail-delete').addEventListener('click', () => {
    state.room.subStructures = (state.room.subStructures ?? []).filter(s => s.id !== sub.id);
    state.selectedSubStructureId = null;
    emit('room:changed');
    renderPlacedSubStructures();
  });
}

// Break-to-merge: convert the sub-structure with `subId` into a new
// entry in state.room.standaloneEnclosures. The transform (position +
// rotation) is BAKED into the enclosure's polygon vertices so the
// resulting enclosure sits at world coords directly — the user can then
// edit each wall material independently exactly like a parent custom
// edge.
//
// Source-room materials are copied verbatim into enc.surfaces so the
// user gets the same look they had in the source. Floor elevation is
// preserved on the enclosure entry so it can be edited later (matches
// how zones already do it).
//
// PHASE 1 (Dr. Chen audit gate): the new enclosure is VISUAL ONLY —
// roomSurfaces() does not include it yet. Phase 2 lives in
// physics/room-shape.js next to the multi-level interior surfaces.
// One-way migration: promote a rectangular / regular-polygon / round
// parent to 'custom' shape so the wall-overlap split has a polygon-edge
// ring to crop. No-op when the parent is already custom and self-
// consistent. The acoustic engine treats all four shapes identically via
// roomSurfaces() — switching to custom doesn't change RT60 / SPL / heatmap
// behaviour, only opens up per-edge editability that the user is asking
// for as part of break-to-merge.
function ensureParentIsCustom(room) {
  const isCustom = room.shape === 'custom'
    && Array.isArray(room.custom_vertices)
    && room.custom_vertices.length >= 3
    && Array.isArray(room.surfaces?.edges)
    && room.surfaces.edges.length === room.custom_vertices.length;
  if (isCustom) return;
  // Polygon vertices in state-plane coords. roomPlanVertices is THE source
  // of truth for every consumer (3D walls, 2D plan, isInsideRoom etc.) so
  // this guarantees the converted polygon traces exactly the room the user
  // already sees.
  const verts = roomPlanVertices(room);
  if (!Array.isArray(verts) || verts.length < 3) return;   // defensive
  // Seed the edges[] from whichever per-shape slot best matches each edge.
  // Rect parents map north/south/east/west by polygon edge order:
  //   roomPlanVertices for rect returns (0,0)(w,0)(w,d)(0,d) →
  //   edges 0..3 = south(or whatever convention) east north west. We use
  //   wall_north for the (0,0)→(w,0) edge to match the rest of the engine.
  const s = room.surfaces || {};
  let edges;
  if (room.shape === 'rectangular') {
    edges = [
      s.wall_north ?? 'gypsum-board',
      s.wall_east  ?? 'gypsum-board',
      s.wall_south ?? 'gypsum-board',
      s.wall_west  ?? 'gypsum-board',
    ];
  } else {
    // Regular polygon / round — every edge shares the same 'walls' slot.
    const fallback = (typeof s.walls === 'string') ? s.walls
      : (typeof s.wall_north === 'string') ? s.wall_north : 'gypsum-board';
    edges = verts.map(() => fallback);
  }
  // Mutate in place — break is one-way (no undo), so the conversion is
  // permanent for this scene. Re-rendering picks up the new shape.
  room.shape = 'custom';
  room.custom_vertices = verts.map(v => ({ x: v.x, y: v.y }));
  room.surfaces.edges = edges;
}

function breakSubStructureToEnclosure(subId) {
  const subs = Array.isArray(state.room.subStructures) ? state.room.subStructures : [];
  const sub = subs.find(s => s.id === subId);
  if (!sub || !sub.sourceRoom) return;
  const src = sub.sourceRoom;
  // Footprint in source-local coords. Custom polygons walk their vertex
  // list; non-custom shapes fall through to the bbox four-corner. (Same
  // simplification rebuildSubStructures uses for non-custom sources —
  // a placed bbox renders as a bbox in the parent.)
  let local;
  if (src.shape === 'custom' && Array.isArray(src.custom_vertices) && src.custom_vertices.length >= 3) {
    local = src.custom_vertices.map(v => ({ x: v.x, y: v.y }));
  } else {
    const w = src.width_m ?? 5;
    const d = src.depth_m ?? 5;
    local = [
      { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d },
    ];
  }
  // Bake transform: rotate around source-local origin (0,0) then
  // translate by (sub.position.x_m, sub.position.y_m). This is the SAME
  // formula renderSubStructures in room-2d.js uses, so the broken-out
  // polygon visually replaces the sub at the exact same location.
  const rotRad = ((sub.rotation_deg ?? 0) * Math.PI) / 180;
  const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
  const px = sub.position?.x_m ?? 0;
  const py = sub.position?.y_m ?? 0;
  const polygon = local.map(p => ({
    x: p.x * cosR - p.y * sinR + px,
    y: p.x * sinR + p.y * cosR + py,
  }));

  // Edge materials — pull from the source's surfaces.edges if it was a
  // custom polygon; otherwise synthesize 4 entries from the source's
  // wall slots in N/S/E/W order (matches the bbox vertex ordering above).
  let edges;
  if (src.shape === 'custom' && Array.isArray(src.surfaces?.edges)
      && src.surfaces.edges.length === local.length) {
    edges = src.surfaces.edges.map(slot =>
      typeof slot === 'string' ? slot : JSON.parse(JSON.stringify(slot)));
  } else {
    // Bbox order is [SW(0,0), SE(w,0), NE(w,d), NW(0,d)] — edges are
    // (SW→SE) south, (SE→NE) east, (NE→NW) north, (NW→SW) west.
    const s = src.surfaces || {};
    const cloneSlot = slot => typeof slot === 'string'
      ? slot
      : (slot ? JSON.parse(JSON.stringify(slot)) : 'gypsum-board');
    edges = [
      cloneSlot(s.wall_south ?? s.walls ?? 'gypsum-board'),
      cloneSlot(s.wall_east  ?? s.walls ?? 'gypsum-board'),
      cloneSlot(s.wall_north ?? s.walls ?? 'gypsum-board'),
      cloneSlot(s.wall_west  ?? s.walls ?? 'gypsum-board'),
    ];
  }

  const enc = {
    id: 'enc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label: sub.sourceRoomName || 'Enclosure',
    polygon,
    height_m: src.height_m ?? 3,
    elevation_m: sub.elevation_m ?? 0,
    surfaces: {
      floor:   src.surfaces?.floor   ?? 'wood-floor',
      ceiling: src.surfaces?.ceiling ?? 'gypsum-board',
      edges,
    },
  };

  if (!Array.isArray(state.room.standaloneEnclosures)) state.room.standaloneEnclosures = [];
  if (!Array.isArray(state.room.wallSegments)) state.room.wallSegments = [];

  // Wall-overlap split — when the parent is a custom polygon, split BOTH
  // the parent's edge ring and this enclosure's edge ring at every
  // collinear-overlap segment + transverse intersection point. Overlapped
  // sub-edges become 'open-air' (so they don't double-render); the
  // canonical surface goes into state.room.wallSegments[]. See
  // js/physics/wall-overlap.js for the geometric design.
  //
  // PARENT SHAPE CONVERSION: the split helper only operates on a polygon-
  // edge ring. If the parent is rectangular / round / regular-polygon, we
  // promote it to 'custom' shape FIRST (one-way migration during break)
  // so the split has something to crop. The polygon comes from
  // roomPlanVertices() — the same function the rest of the engine uses,
  // so the geometry is identical to what the user already had.
  ensureParentIsCustom(state.room);
  if (Array.isArray(state.room.custom_vertices)
      && state.room.custom_vertices.length >= 3
      && Array.isArray(state.room.surfaces?.edges)
      && state.room.surfaces.edges.length === state.room.custom_vertices.length) {
    const split = splitParentVsEnclosure(
      state.room.custom_vertices,
      state.room.surfaces.edges,
      enc.polygon,
      enc.surfaces.edges,
      {
        parentHeight_m: state.room.height_m ?? 3,
        parentElevation_m: 0,
        encElevation_m: enc.elevation_m ?? 0,
        encHeight_m: enc.height_m ?? 3,
      },
    );
    state.room.custom_vertices = split.parentPolygon;
    state.room.surfaces.edges = split.parentEdges;
    enc.polygon = split.encPolygon;
    enc.surfaces.edges = split.encEdges;
    if (split.wallSegments.length > 0) {
      state.room.wallSegments.push(...split.wallSegments);
    }
  }

  // ENCLOSURE-vs-ENCLOSURE split — when the user breaks a SECOND hut whose
  // walls touch a first hut already broken into the parent room, the
  // overlap between the two enclosures must also resolve to a single
  // shared wall (and crop both originals). The split function is
  // polygon-symmetric — `parent` / `enc` are just labels. We loop every
  // existing enclosure and run the same split with the new enc on the
  // `enc` side. The new enc's polygon may grow vertices on each pass,
  // which is fine — the next iteration sees the latest polygon.
  const existingEncs = state.room.standaloneEnclosures;
  for (const other of existingEncs) {
    if (!other || !Array.isArray(other.polygon) || other.polygon.length < 3) continue;
    if (!Array.isArray(other.surfaces?.edges)
        || other.surfaces.edges.length !== other.polygon.length) continue;
    const split2 = splitParentVsEnclosure(
      other.polygon,
      other.surfaces.edges,
      enc.polygon,
      enc.surfaces.edges,
      {
        parentHeight_m: other.height_m ?? 3,
        parentElevation_m: other.elevation_m ?? 0,
        encElevation_m: enc.elevation_m ?? 0,
        encHeight_m: enc.height_m ?? 3,
      },
    );
    other.polygon = split2.parentPolygon;
    other.surfaces.edges = split2.parentEdges;
    enc.polygon = split2.encPolygon;
    enc.surfaces.edges = split2.encEdges;
    if (split2.wallSegments.length > 0) {
      state.room.wallSegments.push(...split2.wallSegments);
    }
  }

  state.room.standaloneEnclosures.push(enc);
  // Drop the original sub-structure — break is one-way (no undo).
  state.room.subStructures = subs.filter(s => s.id !== subId);
  if (state.selectedSubStructureId === subId) state.selectedSubStructureId = null;

  // Re-render Room panel + viewports. room:changed triggers the 3D
  // rebuild; renderSubStructuresChips and renderSurfaceMaterials are
  // both called by render() so the side-panel reflects the new state.
  render();
  emit('room:changed');
  showToast(`Broke "${enc.label}" into editable walls`, 'ok');
}

// Confirm dialog for break-to-merge. Yes/No Promise (Promise<bool>).
function showBreakConfirm(sourceRoomName) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'rl-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'rl-modal rl-place-confirm-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Confirm break-to-merge');
    modal.innerHTML = `
      <h3>Break to editable walls</h3>
      <div class="rl-modal-section">
        Break <strong>${escapeHtml(sourceRoomName || 'this sub-room')}</strong> into editable walls? You won't be able to move or delete it as one piece anymore.
      </div>
      <div class="rl-modal-actions">
        <button type="button" class="rl-modal-cancel">Cancel</button>
        <button type="button" class="rl-modal-confirm">Break</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };
    modal.querySelector('.rl-modal-cancel').addEventListener('click', () => close(false));
    modal.querySelector('.rl-modal-confirm').addEventListener('click', () => close(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => modal.querySelector('.rl-modal-confirm')?.focus(), 0);
  });
}

// Render one chip per saved custom room next to the "Draw custom
// room" button. Click loads the entry; the × button deletes it.
// Chips are filtered to only show rooms belonging to the ACTIVE project
// (state.projectName) — when the user switches project via the header
// dropdown, this row should narrow to that project's rooms only. A
// project banner above the chip row makes the active filter visible.
// Populate the "Open a saved room" dropdown from ALL saved custom rooms,
// grouped by project (one <optgroup> each), newest project first — the
// same grouping listProjects() drives in the New-custom-room dialog and
// the header switcher. Crucially this reads listProjects() and NEVER
// filters by state.projectName: that independence is the fix for the
// 2026-05-21 bug where saved rooms were unreachable after switching to a
// preset. (Maya spec 2026-06-14 — replaces the old dropdown + recents chip
// row with one full-library tree.)
//
// Layout: project groups (collapsible) → room rows. The ACTIVE room (the one
// 💾 Save overwrites) is marked four ways — filled cyan ● glyph, left-border,
// bold name, tinted row — so it survives a dim display. (Unfiled) sorts last
// and has no project ⋯ menu. Collapse state is per-session view-state (a Set),
// NOT persisted to Firestore; the active room's project starts expanded.

// Which project groups are collapsed this session (by project name). Pure
// view-state — never persisted to Firestore. Seeded once (collapse all but the
// active room's group) on the first tree render.
const _collapsedProjects = new Set();
let _treeSeeded = false;

function _projKey(name) {
  return (typeof name === 'string' && name.trim()) ? name.trim() : '(Unfiled)';
}

// Make sure a project group is expanded (used when a room in it becomes the
// active room — load / Save As — so the just-opened room is never hidden).
function _ensureProjectExpanded(name) {
  _collapsedProjects.delete(_projKey(name));
}

function renderSavedRoomsTree() {
  const host = document.getElementById('saved-rooms-tree');
  if (!host) return;
  let projects = listProjects();   // [{ name, rooms, lastSavedAt }], newest-first
  // (Unfiled) always sorts LAST, overriding the API's newest-first order, so
  // the system bucket never floats above the user's named projects.
  projects = projects.slice().sort((a, b) => {
    const au = a.name === '(Unfiled)', bu = b.name === '(Unfiled)';
    if (au !== bu) return au ? 1 : -1;
    return 0;   // otherwise keep listProjects' newest-first order
  });
  const total = projects.reduce((n, p) => n + p.rooms.length, 0);

  // Header line: "SAVED ROOMS    4 rooms in 2 projects"
  const projCount = projects.length;
  let countText = '';
  if (total > 0) {
    countText = projCount > 1
      ? `${total} room${total === 1 ? '' : 's'} in ${projCount} projects`
      : `${total} room${total === 1 ? '' : 's'}`;
  }
  let html = `<div class="srt-head"><span class="srt-title">SAVED ROOMS</span>`
           + `<span class="srt-count">${escapeHtml(countText)}</span></div>`;

  if (total === 0) {
    // Empty state — present, never hidden (discoverability). The 💾 glyph ties
    // it to the header Save button without a tooltip.
    html += `<div class="srt-empty">No rooms saved yet.<br>Draw a room, then 💾 Save to keep it here.</div>`;
    host.innerHTML = html;
    return;
  }

  // The project that holds the active room starts expanded; the rest follow
  // the session collapse Set (default = expanded for the active project's
  // group, collapsed for others on first paint).
  const activeEntry = activeCustomRoomId ? getCustomRoomById(activeCustomRoomId) : null;
  const activeProjKey = activeEntry ? _projKey(activeEntry.projectName) : null;
  // Seed the collapse Set ONCE: collapse every project except the one to keep
  // open — the active room's project, or (when nothing's active) the newest.
  // A lone project is always left open (a single collapsed group is just a
  // pointless extra click, no decluttering benefit).
  if (!_treeSeeded) {
    const expandKey = activeProjKey ?? (projects[0]?.name ?? null);
    if (projects.length > 1) {
      for (const p of projects) if (p.name !== expandKey) _collapsedProjects.add(p.name);
    }
    _treeSeeded = true;
  }
  const dirty = isDirty();

  html += '<div class="srt-body">';
  for (const proj of projects) {
    const collapsed = _collapsedProjects.has(proj.name);
    const unfiled = proj.name === '(Unfiled)';
    const n = proj.rooms.length;
    html += `<div class="srt-project${collapsed ? ' collapsed' : ''}" data-proj="${escapeAttr(proj.name)}">`;
    html += `<div class="srt-proj-head" role="button" tabindex="0" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeAttr(proj.name)}">`
          +   `<span class="srt-chevron">▾</span>`
          +   `<span class="srt-proj-name${unfiled ? ' unfiled' : ''}" title="${escapeAttr(proj.name)}">${escapeHtml(proj.name)}</span>`
          +   (collapsed ? `<span class="srt-proj-count">· ${n}</span>` : '')
          +   (unfiled ? '' : `<button class="srt-proj-menu" type="button" aria-label="Project actions" title="Project actions">⋯</button>`)
          + `</div>`;
    html += `<div class="srt-rooms">`;
    for (const r of proj.rooms) {
      const isActive = r.id === activeCustomRoomId;
      const isDirtyRow = isActive && dirty;
      const label = escapeHtml(r.roomName || 'Untitled');
      const glyph = isActive ? (isDirtyRow ? '◌' : '●') : '';
      const glyphTip = isActive ? 'Save writes to this room' : '';
      html += `<div class="srt-room${isActive ? ' active' : ''}${isDirtyRow ? ' dirty' : ''}" role="button" tabindex="0" data-cr-id="${escapeAttr(r.id)}" title="${escapeAttr(proj.name + ' · ' + (r.roomName || 'Untitled'))}">`
            +   `<span class="srt-glyph"${glyphTip ? ` title="${escapeAttr(glyphTip)}"` : ''}>${glyph}</span>`
            +   `<span class="srt-room-name">${label}</span>`
            +   (isDirtyRow ? `<span class="srt-dirty" title="unsaved changes">*</span>` : '')
            +   `<button class="srt-room-del" type="button" aria-label="Delete room" title="Delete room">×</button>`
            + `</div>`;
    }
    html += `</div></div>`;
  }
  html += '</div>';
  host.innerHTML = html;
  _wireSavedRoomsTree(host);
}

// Bind the freshly-rendered tree's row/chevron/menu/delete handlers. Called
// every render because the tree is rebuilt wholesale (no persistent listeners).
function _wireSavedRoomsTree(host) {
  // Toggle a project group (chevron / header body — but not the ⋯ menu).
  host.querySelectorAll('.srt-proj-head').forEach(head => {
    const toggle = () => {
      const key = head.parentElement?.dataset.proj;
      if (!key) return;
      if (_collapsedProjects.has(key)) _collapsedProjects.delete(key);
      else _collapsedProjects.add(key);
      renderSavedRoomsTree();
    };
    head.addEventListener('click', (e) => {
      if (e.target.closest('.srt-proj-menu')) return;   // menu handles itself
      toggle();
    });
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowRight') { const k = head.parentElement?.dataset.proj; if (k && _collapsedProjects.delete(k)) renderSavedRoomsTree(); }
      else if (e.key === 'ArrowLeft')  { const k = head.parentElement?.dataset.proj; if (k && !_collapsedProjects.has(k)) { _collapsedProjects.add(k); renderSavedRoomsTree(); } }
    });
  });

  // Project ⋯ menu — Rename project / Delete project.
  host.querySelectorAll('.srt-proj-menu').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.closest('.srt-project')?.dataset.proj;
      if (key) _openProjectMenu(btn, key);
    });
  });

  // Open a room — confirm destructive swap, then load.
  host.querySelectorAll('.srt-room').forEach(row => {
    const open = () => {
      const id = row.dataset.crId;
      if (!id) return;
      if (id === activeCustomRoomId && !isDirty()) return;   // already open + clean — no-op
      const entry = getCustomRoomById(id);
      if (!confirmDestructiveSceneChange(entry?.roomName || 'this saved room')) return;
      loadCustomRoomById(id);
      // Reset the preset/template pickers so one selection reads as active.
      const pd = document.getElementById('preset-dropdown'); if (pd) pd.value = '';
      const td = document.getElementById('template-dropdown'); if (td) td.value = '';
    };
    row.addEventListener('click', (e) => {
      if (e.target.closest('.srt-room-del')) return;   // delete handles itself
      open();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      else if (e.key === 'Delete') { e.preventDefault(); row.querySelector('.srt-room-del')?.click(); }
    });
  });

  // Delete a room.
  host.querySelectorAll('.srt-room-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.srt-room');
      const id = row?.dataset.crId;
      if (!id) return;
      const entry = getCustomRoomById(id);
      const name = entry?.roomName || 'this room';
      if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
      deleteCustomRoom(id);
      if (activeCustomRoomId === id) activeCustomRoomId = null;   // deleted the open room
      renderSavedRoomsTree();
    });
  });
}

// Anchored 2-item popover for a project group's ⋯ menu. Closes on outside
// click or Esc. Rename = inline header edit; Delete = confirm + remove all.
function _openProjectMenu(anchor, projKey) {
  document.querySelectorAll('.srt-menu').forEach(m => m.remove());   // one menu at a time
  const proj = listProjects().find(p => _projKey(p.name) === projKey);
  const n = proj ? proj.rooms.length : 0;
  const menu = document.createElement('div');
  menu.className = 'srt-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button class="srt-menu-item" data-act="rename" role="menuitem">Rename project</button>
    <button class="srt-menu-item srt-menu-danger" data-act="delete" role="menuitem">Delete project · ${n} room${n === 1 ? '' : 's'}</button>
  `;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 200)}px`;
  menu.style.top  = `${r.bottom + 4}px`;

  const close = () => { menu.remove(); document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onOut, true); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const onOut = (e) => { if (!menu.contains(e.target)) close(); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousedown', onOut, true);

  menu.querySelector('[data-act="rename"]').addEventListener('click', () => {
    close();
    _renameProjectInline(projKey);
  });
  menu.querySelector('[data-act="delete"]').addEventListener('click', () => {
    close();
    if (projKey === '(Unfiled)') return;   // bucket isn't deletable as a unit
    if (!window.confirm(`Delete project "${projKey}" and its ${n} room${n === 1 ? '' : 's'}? This can't be undone.`)) return;
    const group = listProjects().find(p => _projKey(p.name) === projKey);
    (group?.rooms ?? []).forEach(r => {
      deleteCustomRoom(r.id);
      if (activeCustomRoomId === r.id) activeCustomRoomId = null;   // deleted the open room
    });
    renderSavedRoomsTree();
  });
}

// Inline-edit a project name in its header row. Enter / blur commits via
// renameProject (fan-out across the group); Esc reverts.
function _renameProjectInline(projKey) {
  if (projKey === '(Unfiled)') return;
  const head = document.querySelector(`.srt-project[data-proj="${CSS.escape(projKey)}"] .srt-proj-head`);
  const nameEl = head?.querySelector('.srt-proj-name');
  if (!nameEl) return;
  const input = document.createElement('input');
  input.className = 'srt-rename-input';
  input.type = 'text';
  input.value = projKey;
  input.placeholder = 'Project name';
  input.maxLength = 80;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const next = input.value.trim();
    if (next && next !== projKey) {
      // Carry the collapse state across the rename so the group doesn't jump.
      if (_collapsedProjects.delete(projKey)) _collapsedProjects.add(next);
      renameProject(projKey, next);
    }
    renderSavedRoomsTree();
  };
  const revert = () => { if (done) return; done = true; renderSavedRoomsTree(); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); revert(); }
  });
  input.addEventListener('blur', commit);
}

// Restore a legacy library entry (geometry + rackSystem only — saved
// before full-scene snapshots existed 2026-05-21). Resets the scene,
// overlays the saved room geometry, restores racks. Sources / listeners
// / zones were never captured in these old entries, so they stay empty.
function loadLegacyCustomRoomGeometry(entry) {
  applyBlankCustomRoom({ projectName: entry.projectName ?? null });
  if (entry.room && typeof entry.room === 'object') {
    Object.assign(state.room, JSON.parse(JSON.stringify(entry.room)));
  }
  state.rackSystem = entry.rackSystem
    ? JSON.parse(JSON.stringify(entry.rackSystem))
    : { racks: [] };
}

function loadCustomRoomById(id) {
  const entry = getCustomRoomById(id);
  if (!entry) return;
  // Suppressed swap — loading sets activeCustomRoomId, and the scene:reset
  // / room:changed emits below would otherwise schedule an immediate
  // auto-sync that re-writes the just-loaded entry (bumping savedAt and
  // reordering the project list on every open). The guard also kills any
  // sync the PREVIOUS scene had pending. (Martina review 2026-05-21.)
  runSceneSwap(() => {
    // New entries carry a full scene blob (serializeProject output) —
    // restore it through the canonical deserializer so sources / listeners
    // / zones / treatments / physics / author notes all come back exactly
    // as .roomlab.json would load them. Legacy entries (geometry only)
    // fall back to the old overlay path. A corrupt blob also falls back
    // rather than leaving a half-reset scene.
    if (entry.scene && typeof entry.scene === 'object') {
      try {
        deserializeProject(entry.scene);
      } catch (err) {
        console.warn('saved-room scene blob failed to load — falling back to geometry-only', err);
        loadLegacyCustomRoomGeometry(entry);
      }
    } else {
      loadLegacyCustomRoomGeometry(entry);
    }
    // Backfill room.name from the library label when the blob lacked one
    // (older entries). Keeps the print-report cover stable.
    if (!state.room.name && typeof entry.roomName === 'string' && entry.roomName.trim()) {
      state.room.name = entry.roomName.trim();
    }
    // Library metadata is authoritative for the project name — the user
    // may have renamed the project after this snapshot was taken, and the
    // header dropdown groups by entry.projectName.
    state.projectName = entry.projectName ?? state.projectName;
    activeCustomRoomId = entry.id;
    // A loaded custom room is NOT a live template — clear the key so a
    // later dimension edit can't trigger a template regen that nukes the
    // restored geometry.
    activeTemplateKey = null;
    render();
    emit('scene:reset');
    emit('room:changed');
    emit('rack:changed');   // 3D scene rebuilds racksGroup with the loaded set
  });
  // A freshly-loaded room is CLEAN (matches its saved blob); and remember it as
  // the last-opened so boot restores it. (markClean after the emits settle.)
  markClean();
  // Make the just-opened room visible in the tree (expand its group) + refresh
  // so its row gets the active marking.
  _ensureProjectExpanded(entry.projectName);
  renderSavedRoomsTree();
  const uid = (typeof window !== 'undefined' && window.__auralabAuth?.user?.uid) || null;
  if (uid) saveLastRoomPointer(uid, id);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function renderShapeParams() {
  const root = document.getElementById('shape-params');
  const r = state.room;
  if (r.shape === 'rectangular') {
    root.innerHTML = `
      <div class="field-group">
        <label>Width <input type="number" data-sf="width_m" value="${r.width_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
        <label>Depth <input type="number" data-sf="depth_m" value="${r.depth_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
        <label>Height <input type="number" data-sf="height_m" value="${r.height_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
      </div>
    `;
  } else if (r.shape === 'polygon') {
    root.innerHTML = `
      <div class="field-group">
        <label>Sides <input type="number" data-sf="polygon_sides" value="${r.polygon_sides}" min="3" max="24" step="1" /></label>
        <label>Radius <input type="number" data-sf="polygon_radius_m" value="${r.polygon_radius_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
        <label>Height <input type="number" data-sf="height_m" value="${r.height_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
      </div>
      <div class="note-small">Regular ${r.polygon_sides}-gon inscribed in circle of radius ${r.polygon_radius_m} m</div>
    `;
  } else if (r.shape === 'round') {
    root.innerHTML = `
      <div class="field-group">
        <label>Radius <input type="number" data-sf="round_radius_m" value="${r.round_radius_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
        <label>Height <input type="number" data-sf="height_m" value="${r.height_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
      </div>
    `;
  } else if (r.shape === 'custom') {
    const vcount = (r.custom_vertices || []).length;
    root.innerHTML = `
      <div class="field-group">
        <label>Height <input type="number" data-sf="height_m" value="${r.height_m}" min="0.5" step="0.1" /> <span class="unit">m</span></label>
      </div>
      <button class="btn-draw" id="btn-draw-custom" title="${vcount >= 3 ? 'Re-capture the floor shape — replaces the current vertices' : 'Capture a rough floor shape, then fine-tune it'}">${vcount >= 3 ? '📐 Re-capture room shape' : '📐 Capture room shape'}</button>
      ${vcount >= 3 ? `<div class="note-small">${vcount} vertices · bbox ${r.width_m.toFixed(1)} × ${r.depth_m.toFixed(1)} m</div>` : '<div class="note-small">Draw it on a grid or scan it with your camera — then drag corners to fine-tune.</div>'}
      <div id="vertex-list"></div>
    `;
    // Capture entry point — opens the mode picker (Draw it / From a photo).
    // With one offerable mode it starts directly; the chosen mode commits the
    // room itself via the single commit path (commitCapturedRoom).
    root.querySelector('#btn-draw-custom').addEventListener('click', () => { beginCapture(); });
    renderVertexList();
  }
  wireShapeInputs();
}

function renderVertexList() {
  const root = document.getElementById('vertex-list');
  if (!root) return;
  const verts = state.room.custom_vertices || [];
  if (verts.length === 0) { root.innerHTML = ''; return; }
  root.innerHTML = `
    <h4>Vertices</h4>
    <div class="vertex-list">
      ${verts.map((v, i) => `
        <div class="vertex-row">
          <span class="vertex-idx">${i + 1}</span>
          <label>X <input type="number" data-vf="x" data-vi="${i}" value="${v.x.toFixed(2)}" step="0.1" /></label>
          <label>Y <input type="number" data-vf="y" data-vi="${i}" value="${v.y.toFixed(2)}" step="0.1" /></label>
          ${verts.length > 3 ? `<button class="btn-remove" data-vdel="${i}" title="Remove vertex">×</button>` : '<span></span>'}
        </div>
      `).join('')}
    </div>
  `;
  root.querySelectorAll('[data-vf]').forEach(input => {
    input.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.vi, 10);
      const field = e.target.dataset.vf;
      const v = parseFloat(e.target.value);
      if (isNaN(v)) return;
      state.room.custom_vertices[idx][field] = v;
      updateCustomBoundingBox();
      emit('room:changed');
    });
  });
  root.querySelectorAll('[data-vdel]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.vdel, 10);
      state.room.custom_vertices.splice(idx, 1);
      if (state.room.surfaces.edges) state.room.surfaces.edges.splice(idx, 1);
      updateCustomBoundingBox();
      renderVertexList();
      renderSurfaceMaterials();
      emit('room:changed');
    });
  });
}

function updateCustomBoundingBox() {
  const v = state.room.custom_vertices;
  if (!v || v.length === 0) return;
  const minX = Math.min(...v.map(p => p.x));
  const minY = Math.min(...v.map(p => p.y));
  const maxX = Math.max(...v.map(p => p.x));
  const maxY = Math.max(...v.map(p => p.y));
  state.room.width_m = Math.max(maxX - minX, 0.5);
  state.room.depth_m = Math.max(maxY - minY, 0.5);
}

function renderCeilingParams() {
  // Host only exists while the Ceiling group is mounted (indoor rooms).
  // Outdoor rooms skip the group, so bail rather than throw.
  const root = document.getElementById('ceiling-params');
  if (!root) return;
  const r = state.room;
  if (r.ceiling_type === 'dome') {
    root.innerHTML = `
      <div class="field-group">
        <label>Dome rise <input type="number" data-sf="ceiling_dome_rise_m" value="${r.ceiling_dome_rise_m}" min="0.05" step="0.05" /> <span class="unit">m</span></label>
      </div>
      <div class="note-small">Apex rises ${r.ceiling_dome_rise_m} m above the flat ceiling level</div>
    `;
  } else {
    root.innerHTML = '';
  }
  wireShapeInputs();
}

function wireShapeInputs() {
  document.querySelectorAll('#shape-params [data-sf], #ceiling-params [data-sf]').forEach(input => {
    if (input.dataset.wired) return;
    input.dataset.wired = '1';
    input.addEventListener('input', e => {
      const key = e.target.dataset.sf;
      const v = parseFloat(e.target.value);
      if (isNaN(v) || v <= 0) return;
      state.room[key] = (key === 'polygon_sides') ? Math.round(v) : v;
      if (key === 'polygon_radius_m' || key === 'round_radius_m') {
        syncBoundingBoxToShape();
      }
      // If a template is the live source for the current room, re-run
      // its generator with the updated dimensions so sources/listeners
      // scale to match. Skip when the user has already started hand-
      // editing (no activeTemplateKey).
      if (activeTemplateKey) {
        regenerateActiveTemplate();
      }
      emit('room:changed');
    });
  });
}

function regenerateActiveTemplate() {
  if (!activeTemplateKey || !TEMPLATES[activeTemplateKey]) return;
  // Pull the dimension fields the template cares about straight from
  // state — the user just typed them. Untouched fields fall back to
  // the template's defaultDims via applyTemplateToState merging.
  const dims = {
    width_m: state.room.width_m,
    depth_m: state.room.depth_m,
    height_m: state.room.height_m,
    polygon_sides: state.room.polygon_sides,
    polygon_radius_m: state.room.polygon_radius_m,
    round_radius_m: state.room.round_radius_m,
    ceiling_dome_rise_m: state.room.ceiling_dome_rise_m,
  };
  applyTemplateToState(activeTemplateKey, dims);
  emit('scene:reset');
}

// Wall slots accept three forms: a bare string (legacy: material id only),
// { materialId, openings } (PR2), or { materialId, openings, thickness_m }
// (Phase 7 — per-wall thickness). These helpers read/write all three forms
// transparently — the panel always shows the user the same controls
// regardless of which form storage is currently in.
//
// DEFAULT_WALL_THICKNESS_M = 0.10 (lives in js/physics/room-shape.js); kept
// numerically inline here to avoid a circular import — Phase 7 C3.
const DEFAULT_WALL_THICKNESS_M_UI = 0.10;

function readSlotMatId(slot, fallback = 'gypsum-board') {
  if (typeof slot === 'string') return slot;
  if (slot && typeof slot === 'object' && typeof slot.materialId === 'string') return slot.materialId;
  return fallback;
}
function readSlotOpenings(slot) {
  if (slot && typeof slot === 'object' && Array.isArray(slot.openings)) return slot.openings;
  return [];
}
// Clone a wall-slot SEED for assigning into multiple edge slots. Strings
// are immutable so pass through; objects are deep-copied so the edges
// don't share one reference (the door-leaks-to-all-walls aliasing bug,
// 2026-06-04). Mirrors the local cloneSlot idiom in convertToCustom.
function cloneSlotSeed(slot) {
  if (typeof slot === 'string') return slot;
  return slot ? JSON.parse(JSON.stringify(slot)) : 'gypsum-board';
}
function readSlotThickness(slot) {
  if (slot && typeof slot === 'object') {
    const t = Number(slot.thickness_m);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return DEFAULT_WALL_THICKNESS_M_UI;
}
// Always returns an object — caller may freely mutate it. If the original
// was a string, returns a fresh object that the caller should write back.
//
// CRITICAL: the openings array AND each opening object are deep-cloned
// (shallow per-entry is enough — openings are flat primitive objects).
// Without this, readSlotOpenings() handed back the live slot array by
// reference, so an add/edit on one wall mutated any OTHER wall slot that
// happened to share the same array reference (born at the polygon-"walls"
// → custom-edge convert seam, panel-room.js convertToCustom sites). That
// was the "add a door to one wall, it appears on ALL walls" bug
// (2026-06-04). Cloning here also HEALS an already-aliased scene on the
// first mutation of any kind. Exported for tests/openings-no-leak.test.mjs.
export function readSlotAsObject(slot, fallback = 'gypsum-board') {
  return {
    materialId: readSlotMatId(slot, fallback),
    thickness_m: readSlotThickness(slot),
    openings: readSlotOpenings(slot).map(o => ({ ...o })),
  };
}
// If the slot has no openings AND thickness is the default, write back the
// bare string form (preserves legacy save shape). Otherwise write the
// object form, but DROP the thickness_m field when it equals the default
// so the saved scene stays compact when the user never touched thickness.
function compactSlot(slot) {
  if (!slot || typeof slot !== 'object') return slot;
  const noOpenings = Array.isArray(slot.openings) && slot.openings.length === 0;
  const t = Number(slot.thickness_m);
  const isDefaultThickness = !Number.isFinite(t) || Math.abs(t - DEFAULT_WALL_THICKNESS_M_UI) < 1e-6;
  if (noOpenings && isDefaultThickness) return slot.materialId;
  if (isDefaultThickness) {
    // Drop the thickness field to keep the save shape minimal.
    const { thickness_m: _drop, ...rest } = slot;
    return rest;
  }
  return slot;
}

// thickness_m (depth) defaults to 50 mm — door leaf / window+frame depth,
// rendered as a real slab in the 3D preview (scene.js attachOpeningMesh).
const DEFAULT_DOOR    = { kind: 'door',   width_m: 0.9, height_m: 2.1, x_m: 0.5, z_m: 0,   thickness_m: 0.05, materialId: 'door-solid-wood', state: 'closed' };
const DEFAULT_WINDOW  = { kind: 'window', width_m: 1.5, height_m: 1.2, x_m: 0.5, z_m: 1.0, thickness_m: 0.05, materialId: 'glass-window',    state: 'closed' };

// An opening's render depth follows its MATERIAL's real thickness
// (reference_thickness_m) — so "Glass window 6mm" reads as 6 mm, not the old
// flat 50 mm. Auto-filled when an opening is added and whenever its material
// changes; the depth field stays editable afterward for special cases (a deep
// frame / reveal). Falls back to 50 mm for any material without a reference
// thickness. (Depth is render-only — the opening's acoustics come entirely
// from the material's transmission-loss data, never its depth.)
function refThicknessForMaterial(matId) {
  const m = materialsRef?.list?.find(x => x.id === matId);
  const t = Number(m?.reference_thickness_m);
  return (Number.isFinite(t) && t > 0) ? t : 0.05;
}

let _opIdCounter = 1;
function newOpeningId() { return 'op-' + (_opIdCounter++).toString(36) + Math.random().toString(36).slice(2, 5); }

// Along-wall length (m) for a surface id, so a newly-added opening can be
// placed without running off the end of the wall. Returns null when the
// length can't be resolved (wall segments / enclosure walls) → caller skips
// the right-edge clamp but still places the opening next to existing ones.
function wallLengthFor(surfaceId) {
  const room = state.room;
  if (!room) return null;
  if (surfaceId === 'wall_north' || surfaceId === 'wall_south') return Number(room.width_m) || null;
  if (surfaceId === 'wall_east'  || surfaceId === 'wall_west')  return Number(room.depth_m) || null;
  if (surfaceId === 'walls') return Math.max(Number(room.width_m) || 0, Number(room.depth_m) || 0) || null;
  const em = /^edge_(\d+)$/.exec(surfaceId);
  if (em) {
    const verts = roomPlanVertices(room);
    if (Array.isArray(verts) && verts.length >= 2) {
      const i = parseInt(em[1], 10);
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if (a && b) return Math.hypot(b.x - a.x, b.y - a.y) || null;
    }
  }
  return null;
}

// placeOpeningX (non-overlapping left-edge x for a new opening) lives in the
// pure, Node-testable js/ui/opening-placement.js — imported at the top.

// Room Treatment preset — sets all surfaces (floor, ceiling, walls/edges)
// to a sensible material combination representing common acoustic
// realities. Per Dr. Chen's audit, the user expectation that "carpet =
// quiet room" is wrong; bass treatment is needed too. Five presets span
// untreated → studio → anechoic so users can hit physically-correct
// references and learn the relationship between treatment and decay
// without picking individual materials.
const TREATMENT_PRESETS = {
  untreated: {
    label: 'Untreated (bare)',
    desc: 'Painted concrete walls + ceiling, wood floor — typical empty domestic space. T60(125) ≈ 1–2 s.',
    floor: 'wood-floor', ceiling: 'concrete-painted', walls: 'concrete-painted',
  },
  'soft-furnished': {
    label: 'Soft-furnished domestic',
    desc: 'Plasterboard walls + ceiling, carpet on underlay — typical lived-in lounge. T60(125) ≈ 0.6–1.0 s.',
    floor: 'carpet-heavy-underlay', ceiling: 'gypsum-board', walls: 'gypsum-board',
  },
  'hifi-treated': {
    label: 'HiFi listening room (carpet + corner traps)',
    desc: 'Plasterboard walls with broadband corner bass traps, acoustic-tile ceiling, carpet floor. T60(125) ≈ 0.4–0.6 s.',
    floor: 'carpet-heavy-underlay', ceiling: 'acoustic-tile', walls: 'bass-trap-broadband-corner',
  },
  'studio-control-room': {
    label: 'Studio control room',
    desc: 'Broadband bass traps on walls, 200 mm ceiling cloud, carpet floor. T60(125) ≈ 0.2–0.3 s — canonical pro mixing room.',
    floor: 'carpet-heavy-underlay', ceiling: 'ceiling-cloud-200mm', walls: 'bass-trap-broadband-corner',
  },
  'anechoic-approximation': {
    label: 'Anechoic approximation',
    desc: 'Open-air on five surfaces, carpet floor. T60 → 0 — for reference only; not physically achievable in a real room.',
    floor: 'carpet-heavy-underlay', ceiling: 'open-air', walls: 'open-air',
  },
};

function applyTreatmentPreset(presetKey) {
  const p = TREATMENT_PRESETS[presetKey];
  if (!p) return;
  state.room.surfaces.floor = p.floor;
  state.room.surfaces.ceiling = p.ceiling;
  // Walls — handle every shape variant.
  if (state.room.shape === 'rectangular') {
    state.room.surfaces.wall_north = p.walls;
    state.room.surfaces.wall_south = p.walls;
    state.room.surfaces.wall_east = p.walls;
    state.room.surfaces.wall_west = p.walls;
  } else if (state.room.shape === 'custom') {
    const n = (state.room.custom_vertices || []).length;
    state.room.surfaces.edges = Array.from({ length: n }, () => p.walls);
  } else {
    state.room.surfaces.walls = p.walls;
  }
  emit('room:changed');
  renderSurfaceMaterials();
}

function renderTreatmentPresetRow() {
  const root = document.getElementById('treatment-preset-row');
  if (!root) return;
  root.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'treatment-preset-label';
  label.textContent = 'Treatment preset:';
  const sel = document.createElement('select');
  sel.className = 'treatment-preset-select';
  // Custom = no preset matches the current state, just placeholder.
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '— pick one (overrides every surface) —';
  sel.appendChild(opt0);
  for (const [k, p] of Object.entries(TREATMENT_PRESETS)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = p.label;
    o.title = p.desc;
    sel.appendChild(o);
  }
  sel.addEventListener('change', e => {
    if (e.target.value) {
      applyTreatmentPreset(e.target.value);
      sel.value = '';
    }
  });
  root.append(label, sel);
}

function renderSurfaceMaterials() {
  renderTreatmentPresetRow();
  const root = document.getElementById('surface-materials');
  root.innerHTML = '';

  // Helper bound to the current state — renders ONE wall row with material
  // select + openings sub-section. Floor / ceiling rows skip the openings
  // part (those surfaces don't host doors or windows).
  const renderWallRow = (parent, surfaceId, label, getSlot, setSlot, withOpenings, tooltip) => {
    const wrap = document.createElement('div');
    wrap.className = 'wall-row';
    wrap.dataset.surfaceId = surfaceId;
    const matRow = document.createElement('label');
    matRow.dataset.surfaceId = surfaceId;
    matRow.className = 'wall-mat-row';
    if (tooltip) matRow.title = tooltip;
    const sel = buildMatSelect(surfaceId, readSlotMatId(getSlot()));
    sel.dataset.surfaceId = surfaceId;
    // Ceiling + open-air gotcha hint. The roof's transmission loss vanishes
    // when ceiling is set to open-air, so any source mounted above the
    // ceiling height (gallery horns, flown PA on a minaret, tower-mounted
    // emergency speakers) gains direct line-of-sight into the room and
    // interior SPL can RISE despite the absorption increase. Surfaced under
    // the picker (not as a title=) so users see it without hovering.
    // Triggered for the parent room's ceiling and every broken-out
    // enclosure's ceiling; wall and floor slots are unaffected.
    const isCeilingSlot = surfaceId === 'ceiling'
      || /^enclosure_\d+_ceiling$/.test(surfaceId);
    let openAirHint = null;
    if (isCeilingSlot) {
      openAirHint = document.createElement('div');
      openAirHint.className = 'mat-row-hint mat-row-hint-warn';
      openAirHint.textContent = 'Removes the roof — sources above this height (gallery horns, flown PA) hit the room directly, so interior SPL may rise.';
      openAirHint.hidden = readSlotMatId(getSlot()) !== 'open-air';
    }
    sel.addEventListener('change', e => {
      const slot = readSlotAsObject(getSlot());
      slot.materialId = e.target.value;
      setSlot(compactSlot(slot));
      if (openAirHint) openAirHint.hidden = e.target.value !== 'open-air';
      emit('room:changed');
    });
    matRow.append(label + ' ', sel);
    attachSurfaceHover(matRow, surfaceId);
    wrap.appendChild(matRow);
    if (openAirHint) wrap.appendChild(openAirHint);
    if (withOpenings) {
      // Per-wall thickness control — Phase 7 C3. Walls only (floor / ceiling
      // skip this — they don't carry a polygon-edge thickness). Input is in
      // millimetres for usability (matches the WallLAB workbench slider);
      // state stores metres. Range 25-600 mm covers studwall through heavy
      // double-leaf masonry.
      wrap.appendChild(renderThicknessRow(surfaceId, getSlot, setSlot));
      wrap.appendChild(renderOpeningsBlock(surfaceId, getSlot, setSlot));
    }
    parent.appendChild(wrap);
  };

  // Render the unified Ceiling group: the ceiling SHAPE control (Flat /
  // Domed + the dome-rise field when domed) and the ceiling MATERIAL row,
  // together under one "Ceiling" heading. Before v=806 these lived in two
  // disconnected places (a "Ceiling" shape dropdown at the top of the
  // panel, and a "Ceiling" material row buried between Floor and Walls) —
  // two controls both labelled "Ceiling" with the whole Surfaces section
  // between them. Now both read as one surface. Skipped entirely for
  // outdoor rooms (no roof). The shape select + dome host are rebuilt and
  // re-wired on every render (they're no longer in the static template),
  // so a re-render can't orphan their handlers.
  const renderCeilingGroup = (parent) => {
    const h4 = document.createElement('h4');
    h4.textContent = 'Ceiling';
    parent.appendChild(h4);

    const group = document.createElement('div');
    group.className = 'field-group';

    // Ceiling SHAPE — Flat vs Domed. Labelled "Shape" (not "Ceiling") so it
    // doesn't read as a second ceiling control; the group heading already
    // says Ceiling.
    const shapeLabel = document.createElement('label');
    shapeLabel.title = 'Ceiling form. Flat is a level soffit; Domed is a spherical cap that focuses reflections toward the room centre.';
    shapeLabel.append('Shape ');
    const shapeSel = document.createElement('select');
    shapeSel.dataset.f = 'ceiling_type';
    for (const [k, v] of Object.entries(CEILING_LABELS)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = v;
      shapeSel.appendChild(o);
    }
    shapeSel.value = state.room.ceiling_type;
    shapeSel.addEventListener('change', e => {
      state.room.ceiling_type = e.target.value;
      render();
      emit('room:changed');
    });
    shapeLabel.appendChild(shapeSel);
    group.appendChild(shapeLabel);
    parent.appendChild(group);

    // Dome-rise host — renderCeilingParams() fills this with the rise field
    // only when ceiling_type === 'dome'. Same #ceiling-params id wireShapeInputs()
    // queries, so the rise input wires through the existing shape-input path.
    const ceilParams = document.createElement('div');
    ceilParams.id = 'ceiling-params';
    parent.appendChild(ceilParams);
    renderCeilingParams();

    // Ceiling MATERIAL — the absorptive surface itself.
    const matGroup = document.createElement('div');
    matGroup.className = 'field-group';
    renderWallRow(
      matGroup, 'ceiling', 'Material',
      () => state.room.surfaces.ceiling,
      v => { state.room.surfaces.ceiling = v; },
      false,
      'Acoustic finish of the ceiling soffit. Set to open-air to remove the roof.',
    );
    parent.appendChild(matGroup);
  };

  // Outdoor mode keeps walls user-controlled — just rename the floor row to
  // "Ground" and skip the ceiling group (no roof). Walls can be set to
  // 'open-air' individually if the user wants a fully open footprint.
  const isOutdoor = state.room.enclosure === 'outdoor';

  // Surface order is the same everywhere: Floor → Walls → Ceiling. Each
  // surface's controls sit together under one heading; surfaces are never
  // interleaved. Guarded by tests/room-surface-grouping.test.mjs.
  if (state.room.shape === 'custom') {
    // Floor
    const floorHead = document.createElement('h4');
    floorHead.textContent = isOutdoor ? 'Ground' : 'Floor';
    root.appendChild(floorHead);
    const floorGroup = document.createElement('div');
    floorGroup.className = 'field-group';
    renderWallRow(
      floorGroup, 'floor', isOutdoor ? 'Ground' : 'Floor',
      () => state.room.surfaces.floor,
      v => { state.room.surfaces.floor = v; },
      false,
    );
    root.appendChild(floorGroup);

    // Walls — per-edge for custom rooms.
    const wallHead = document.createElement('h4');
    wallHead.textContent = 'Walls';
    root.appendChild(wallHead);

    const nEdges = (state.room.custom_vertices || []).length;
    if (!state.room.surfaces.edges || state.room.surfaces.edges.length !== nEdges) {
      state.room.surfaces.edges = Array.from({ length: nEdges }, (_, i) => state.room.surfaces.edges?.[i] ?? 'gypsum-board');
    }
    const edgeGroup = document.createElement('div');
    edgeGroup.className = 'field-group';
    for (let i = 0; i < nEdges; i++) {
      const surfaceId = `edge_${i}`;
      renderWallRow(
        edgeGroup, surfaceId, `Wall ${i + 1}`,
        () => state.room.surfaces.edges[i],
        v => { state.room.surfaces.edges[i] = v; },
        true,
      );
    }
    root.appendChild(edgeGroup);

    // Ceiling (shape + material) — skipped outdoors.
    if (!isOutdoor) renderCeilingGroup(root);

    // FALL THROUGH to renderEnclosureMaterialSections at the bottom so
    // a custom-shape parent ALSO gets per-enclosure rows. Without this,
    // clicking an enclosure face in 3D would emit surface:picked but
    // the panel listener couldn't find a matching row → silent failure.
    renderEnclosureMaterialSections(root, renderWallRow);
    renderSharedWallSegmentSection(root, renderWallRow);
    return;
  }

  // Rectangular / non-rect (polygon, round): split the flat surface list
  // into Floor → Walls → Ceiling groups so each surface reads as a unit.
  const labelsAll = state.room.shape === 'rectangular' ? RECT_SURFACE_LABELS : NONRECT_SURFACE_LABELS;
  const wallLabels = labelsAll.filter(([id]) => id !== 'floor' && id !== 'ceiling');

  // Floor
  const floorHead = document.createElement('h4');
  floorHead.textContent = isOutdoor ? 'Ground' : 'Floor';
  root.appendChild(floorHead);
  const floorGroup = document.createElement('div');
  floorGroup.className = 'field-group';
  renderWallRow(
    floorGroup, 'floor', isOutdoor ? 'Ground' : 'Floor',
    () => state.room.surfaces.floor,
    v => { state.room.surfaces.floor = v; },
    false,
  );
  root.appendChild(floorGroup);

  // Walls
  const wallHead = document.createElement('h4');
  wallHead.textContent = 'Walls';
  root.appendChild(wallHead);
  const wallGroup = document.createElement('div');
  wallGroup.className = 'field-group';
  for (const [id, label] of wallLabels) {
    renderWallRow(
      wallGroup, id, label,
      () => state.room.surfaces[id],
      v => { state.room.surfaces[id] = v; },
      true,
    );
  }
  root.appendChild(wallGroup);

  // Ceiling (shape + material) — skipped outdoors.
  if (!isOutdoor) renderCeilingGroup(root);

  // Per-enclosure sections — broken-out sub-rooms get their own Floor /
  // Ceiling / Wall N material rows + a × button to drop the whole
  // enclosure if the user regrets breaking it. Re-uses renderWallRow so
  // openings (doors, windows) work identically.
  renderEnclosureMaterialSections(root, renderWallRow);
  renderSharedWallSegmentSection(root, renderWallRow);
  renderSurauMaterialSection(root, renderWallRow);
}

// Surau preset's six exterior acoustic surfaces — podium top, arcade
// columns, arcade roof underside, portico walls + roof, and the
// south-wall partition between doors. Added 2026-05-17 to close the
// UI gap from v=444 (Viktor added these as triangulated BVH surfaces
// with proper surface_id + acoustic_material tagging, but the side
// panel never rendered editable material rows for them — user could
// click a column in the 3D viewport but the picker popped up with no
// way to change the material).
//
// surface_id strings here MUST match the IDs set in scene.js
// rebuildSurauStructure() + triangulate-scene.js triangulateSurauStructure()
// so the surface-picker click handler can find the matching row.
function renderSurauMaterialSection(root, renderWallRow) {
  const s = state.room?.surauStructure;
  if (!s || typeof s !== 'object') return;
  const mats = s.materials;
  if (!mats || typeof mats !== 'object') return;

  const headerWrap = document.createElement('div');
  headerWrap.className = 'enclosure-section-header';
  const h4 = document.createElement('h4');
  h4.textContent = 'Surau exterior surfaces';
  h4.style.display = 'inline-block';
  h4.title = 'Acoustic materials for the surau podium, arcade columns + roof, portico, south-wall partition, and minaret shaft. These are real BVH surfaces — rays bounce off them, RT60 includes their absorption.';
  headerWrap.appendChild(h4);
  root.appendChild(headerWrap);

  const group = document.createElement('div');
  group.className = 'field-group';

  // Tuples: [materials-key, surface_id, label, tooltip].
  const rows = [
    ['podium_top',      'surau_podium_top',     'Podium top',        'Raised concrete plinth extending past the building footprint. Walked on by the avatar; rays bounce off it.'],
    ['arcade_columns',  'surau_arcade_column',  'Arcade columns',    'Square pillars supporting the arcade roof on the south + east + west sides.'],
    ['arcade_roof',     'surau_arcade_roof',    'Arcade roof (underside)', 'Flat soffit above the arcade walkway. Faces down into the corridor.'],
    ['portico_walls',   'surau_portico_walls',  'Portico walls',     'Three solid walls of the projecting entrance pavilion (front + two sides).'],
    ['portico_roof',    'surau_portico_roof',   'Portico roof (underside)', 'Underside of the pyramid cap above the entrance pavilion.'],
    ['south_partition', 'south_partition',      'South-wall partition', 'Thin interior partition between the three south doors. Wraps the doorways with lintels.'],
    ['minaret',         'surau_minaret',        'Minaret',           'Tall slender tower with crescent / mustaka finial, set just outside the building corner. Acoustic surface = shaft only (cap pieces are visual).'],
  ];
  for (const [matKey, surfaceId, label, tooltip] of rows) {
    renderWallRow(
      group, surfaceId, label,
      () => mats[matKey] || 'concrete-painted',
      v => {
        const matId = (typeof v === 'string') ? v : (v?.materialId ?? 'concrete-painted');
        mats[matKey] = matId;
      },
      false,   // isWall=false — no openings UI for these material-only rows
      tooltip,
    );
  }
  root.appendChild(group);
}

// Render the "Shared walls" group — one row per state.room.wallSegments
// entry (a wall created by break-to-merge overlap split, owned by no
// polygon). Each row uses the standard renderWallRow so openings + the
// click-pulse hover flow work identically. Surface id is `wseg_${id}`,
// matching the userData.surface_id set by rebuildWallSegments in scene.js.
function renderSharedWallSegmentSection(root, renderWallRow) {
  const list = Array.isArray(state.room.wallSegments) ? state.room.wallSegments : [];
  if (list.length === 0) return;
  const headerWrap = document.createElement('div');
  headerWrap.className = 'enclosure-section-header';
  const h4 = document.createElement('h4');
  h4.textContent = 'Shared walls';
  h4.style.display = 'inline-block';
  h4.style.marginRight = '0.5em';
  h4.title = 'Walls produced by overlap-split during break-to-merge — owned by neither the parent nor any single enclosure.';
  headerWrap.appendChild(h4);
  root.appendChild(headerWrap);

  const group = document.createElement('div');
  group.className = 'field-group';
  for (let i = 0; i < list.length; i++) {
    const seg = list[i];
    if (!seg || typeof seg !== 'object') continue;
    const dx = (seg.x2 ?? 0) - (seg.x1 ?? 0);
    const dy = (seg.y2 ?? 0) - (seg.y1 ?? 0);
    const len = Math.sqrt(dx * dx + dy * dy);
    const lbl = `Shared ${i + 1} (${len.toFixed(1)} m)`;
    // Wrap the seg's bare-string slot fields in the slot-object schema
    // so renderWallRow's openings sub-section works. Setter writes back
    // to materialId + openings on the seg object directly.
    const surfaceId = `wseg_${seg.id}`;
    renderWallRow(
      group, surfaceId, lbl,
      () => ({ materialId: seg.materialId, openings: Array.isArray(seg.openings) ? seg.openings : [] }),
      v => {
        const slot = (v && typeof v === 'object') ? v : { materialId: v, openings: [] };
        seg.materialId = typeof slot.materialId === 'string' ? slot.materialId : 'gypsum-board';
        seg.openings = Array.isArray(slot.openings) ? slot.openings : [];
      },
      true,
    );
  }
  root.appendChild(group);
}

// Render one section per state.room.standaloneEnclosures entry. Each
// section has a header with the enclosure label + a × delete button,
// then per-surface rows: Floor, Ceiling, then Wall 1..N matching the
// enclosure's polygon edge count. Setters write back through the
// standaloneEnclosures[i] slot, preserving openings via compactSlot.
function renderEnclosureMaterialSections(root, renderWallRow) {
  const list = Array.isArray(state.room.standaloneEnclosures) ? state.room.standaloneEnclosures : [];
  if (list.length === 0) return;
  for (let i = 0; i < list.length; i++) {
    const enc = list[i];
    if (!enc || !Array.isArray(enc.polygon)) continue;
    // Section header
    const headerWrap = document.createElement('div');
    headerWrap.className = 'enclosure-section-header';
    const h4 = document.createElement('h4');
    h4.textContent = `Enclosure: ${enc.label || 'Untitled'}`;
    h4.style.display = 'inline-block';
    h4.style.marginRight = '0.5em';
    headerWrap.appendChild(h4);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-delete-opening';
    delBtn.textContent = '×';
    delBtn.title = 'Delete this enclosure';
    delBtn.setAttribute('aria-label', `Delete enclosure ${enc.label || ''}`);
    delBtn.addEventListener('click', () => {
      if (!window.confirm(`Delete enclosure "${enc.label || 'Untitled'}"? This cannot be undone.`)) return;
      state.room.standaloneEnclosures = list.filter((_, j) => j !== i);
      emit('room:changed');
      renderSurfaceMaterials();
    });
    headerWrap.appendChild(delBtn);
    root.appendChild(headerWrap);

    // Floor + Ceiling rows
    const fcGroup = document.createElement('div');
    fcGroup.className = 'field-group';
    if (!enc.surfaces || typeof enc.surfaces !== 'object') {
      enc.surfaces = { floor: 'wood-floor', ceiling: 'gypsum-board', edges: [] };
    }
    renderWallRow(
      fcGroup, `enclosure_${i}_floor`, 'Floor',
      () => enc.surfaces.floor,
      v => { enc.surfaces.floor = v; },
      false,
    );
    renderWallRow(
      fcGroup, `enclosure_${i}_ceiling`, 'Ceiling',
      () => enc.surfaces.ceiling,
      v => { enc.surfaces.ceiling = v; },
      false,
    );
    root.appendChild(fcGroup);

    // Per-edge wall rows. Match length to polygon size — defensive
    // against a hand-edited file with a mismatched edges[] length, same
    // pattern the parent custom-edge code uses.
    const nEdges = enc.polygon.length;
    if (!Array.isArray(enc.surfaces.edges) || enc.surfaces.edges.length !== nEdges) {
      enc.surfaces.edges = Array.from({ length: nEdges }, (_, k) => enc.surfaces.edges?.[k] ?? 'gypsum-board');
    }
    const edgeGroup = document.createElement('div');
    edgeGroup.className = 'field-group';
    for (let k = 0; k < nEdges; k++) {
      const surfaceId = `enclosure_${i}_edge_${k}`;
      renderWallRow(
        edgeGroup, surfaceId, `Wall ${k + 1}`,
        () => enc.surfaces.edges[k],
        v => { enc.surfaces.edges[k] = v; },
        true,
      );
    }
    root.appendChild(edgeGroup);
  }
}

// Per-wall openings editor. Renders a compact list of doors/windows on
// this wall plus "+ Door" / "+ Window" buttons. Each opening row has all
// fields inline (kind/state/material/x/z/w/h) + a delete button. Adding
// or deleting an opening rebuilds just this block via the parent's setter.
// Per-wall thickness input. Sits between the material select and the
// openings sub-section so it's right next to "+ Door" / "+ Window". The
// input takes millimetres (whole numbers) — matches the WallLAB workbench
// thickness slider convention; state writeback converts to metres.
//
// Sensible range 25-600 mm: 25 mm = thin partition skin; 600 mm = heavy
// double-leaf concrete. Outside this range we clamp on commit, so a typo
// can't break the inset geometry (wall-inset.js degenerate-case fallback
// would catch it, but the user shouldn't have to discover that).
function renderThicknessRow(surfaceId, getSlot, setSlot) {
  const row = document.createElement('div');
  row.className = 'wall-thickness-row';
  row.dataset.surfaceId = surfaceId;
  const label = document.createElement('span');
  label.className = 'wall-thickness-label';
  label.textContent = 'Thickness:';
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'wall-thickness-input';
  input.min = '25';
  input.max = '600';
  input.step = '5';
  const currentMm = Math.round(readSlotThickness(getSlot()) * 1000);
  input.value = String(currentMm);
  input.title = 'Wall thickness in millimetres. Affects 3D rendering today; will feed inter-zone SPL math in Phase 8 (ISO 12354-2).';
  const unit = document.createElement('span');
  unit.className = 'wall-thickness-unit';
  unit.textContent = 'mm';
  const commit = () => {
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) {
      input.value = String(Math.round(readSlotThickness(getSlot()) * 1000));
      return;
    }
    const clamped = Math.max(25, Math.min(600, Math.round(raw)));
    if (clamped !== raw) input.value = String(clamped);
    const slot = readSlotAsObject(getSlot());
    slot.thickness_m = clamped / 1000;
    setSlot(compactSlot(slot));
    emit('room:changed');
  };
  input.addEventListener('change', commit);
  // Blur also commits — covers the user editing then clicking outside
  // without pressing Enter.
  input.addEventListener('blur', commit);
  row.append(label, input, unit);
  return row;
}

function renderOpeningsBlock(surfaceId, getSlot, setSlot) {
  const block = document.createElement('div');
  block.className = 'openings-block';
  const slot = readSlotAsObject(getSlot());
  // Filter out SYSTEM openings (e.g. merge_cut auto-added by break-to-merge
  // when two rooms share a wall). The user didn't add them and shouldn't
  // be tempted to delete or resize them — they're part of the geometric
  // split. We still render them in 3D as wall holes, but hide from the
  // door/window editor in the panel. Track the original-array index for
  // each visible opening so the row's edit / delete handlers still write
  // back to the correct entry in slot.openings.
  const allOpenings = slot.openings;
  const visible = [];           // [{ op, origIdx }, ...]
  for (let i = 0; i < allOpenings.length; i++) {
    if (!allOpenings[i]?.system) visible.push({ op: allOpenings[i], origIdx: i });
  }
  const openings = visible.map(v => v.op);

  // Header row — summary text only. The "+ Door" / "+ Window" buttons live
  // on their own row below so a long material dropdown can't push them off
  // the right edge of the sidebar (sidebar is overflow-x: hidden, so anything
  // wider than the column was getting clipped before this split).
  const hdr = document.createElement('div');
  hdr.className = 'openings-hdr';
  const summary = document.createElement('span');
  summary.className = 'openings-summary';
  const nDoor = openings.filter(o => o.kind === 'door').length;
  const nWin  = openings.filter(o => o.kind === 'window').length;
  const summaryText = (nDoor || nWin)
    ? `Openings: ${nDoor} door${nDoor === 1 ? '' : 's'}, ${nWin} window${nWin === 1 ? '' : 's'}`
    : 'No openings';
  summary.textContent = summaryText;
  hdr.appendChild(summary);
  block.appendChild(hdr);

  // Actions row — add buttons sit below the summary so they stay reachable
  // on a narrow sidebar. Compact, left-aligned, same visual weight as before.
  const actions = document.createElement('div');
  actions.className = 'openings-actions';
  const addDoor = document.createElement('button');
  addDoor.type = 'button';
  addDoor.className = 'btn-add-opening';
  addDoor.textContent = '+ Door';
  addDoor.title = 'Add a door to this wall';
  addDoor.addEventListener('click', () => {
    const next = readSlotAsObject(getSlot());
    const x_m = placeOpeningX(next.openings, DEFAULT_DOOR.width_m, wallLengthFor(surfaceId));
    next.openings.push({ ...DEFAULT_DOOR, x_m, thickness_m: refThicknessForMaterial(DEFAULT_DOOR.materialId), id: newOpeningId() });
    setSlot(next);
    emit('room:changed');
    renderSurfaceMaterials();
  });
  actions.appendChild(addDoor);
  const addWin = document.createElement('button');
  addWin.type = 'button';
  addWin.className = 'btn-add-opening';
  addWin.textContent = '+ Window';
  addWin.title = 'Add a window to this wall';
  addWin.addEventListener('click', () => {
    const next = readSlotAsObject(getSlot());
    const x_m = placeOpeningX(next.openings, DEFAULT_WINDOW.width_m, wallLengthFor(surfaceId));
    next.openings.push({ ...DEFAULT_WINDOW, x_m, thickness_m: refThicknessForMaterial(DEFAULT_WINDOW.materialId), id: newOpeningId() });
    setSlot(next);
    emit('room:changed');
    renderSurfaceMaterials();
  });
  actions.appendChild(addWin);
  block.appendChild(actions);

  // One row per VISIBLE opening — the row's idx points at the entry's
  // index in the underlying slot.openings (not the filtered list) so
  // edits / deletes write back to the right slot.
  for (let v = 0; v < visible.length; v++) {
    block.appendChild(renderOpeningRow(surfaceId, visible[v].op, visible[v].origIdx, getSlot, setSlot));
  }
  return block;
}

function renderOpeningRow(surfaceId, op, idx, getSlot, setSlot) {
  const row = document.createElement('div');
  row.className = 'opening-row';
  row.dataset.openingId = op.id || `idx-${idx}`;

  // Kind label (icon-ish + name)
  const kindLbl = document.createElement('span');
  kindLbl.className = 'opening-kind';
  kindLbl.textContent = op.kind === 'door' ? 'Door' : 'Window';
  row.appendChild(kindLbl);

  // State toggle (open/closed). Drives whether the opening reads as α=1
  // boundary or as its solid material's absorption.
  const stateSel = document.createElement('select');
  stateSel.className = 'opening-state';
  stateSel.title = 'Open: opening acts as α=1 (no boundary). Closed: solid material applies.';
  for (const v of ['closed', 'open']) {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    stateSel.appendChild(opt);
  }
  stateSel.value = op.state || 'closed';
  stateSel.addEventListener('change', e => {
    const next = readSlotAsObject(getSlot());
    next.openings[idx].state = e.target.value;
    setSlot(next);
    emit('room:changed');
  });
  row.appendChild(stateSel);

  // Material select — filtered by the OPENING'S kind (door vs window), not
  // the host wall's kind, so a door offers only door leaves and a window only
  // glazing. op.kind is 'door' | 'window'; anything else falls back to door.
  const opKind = op.kind === 'window' ? 'window' : 'door';
  const matSel = buildMatSelect(`${surfaceId}-op-${idx}`, op.materialId, opKind);
  matSel.className = 'opening-mat';
  matSel.addEventListener('change', e => {
    const next = readSlotAsObject(getSlot());
    next.openings[idx].materialId = e.target.value;
    // Depth follows the material's real thickness (6 mm glass → 6 mm, etc.).
    next.openings[idx].thickness_m = refThicknessForMaterial(e.target.value);
    setSlot(next);
    emit('room:changed');
    renderSurfaceMaterials();   // refresh the depth field to the new thickness
  });
  row.appendChild(matSel);

  // Delete
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn-delete-opening';
  del.title = 'Delete this opening';
  del.textContent = '×';
  del.addEventListener('click', () => {
    const next = readSlotAsObject(getSlot());
    next.openings.splice(idx, 1);
    setSlot(compactSlot(next));
    emit('room:changed');
    renderSurfaceMaterials();
  });
  row.appendChild(del);

  // Dimension + position fields, second line.
  const dims = document.createElement('div');
  dims.className = 'opening-dims';
  const fields = [
    ['x_m', 'x', 'Distance along wall from its first vertex'],
    ['z_m', 'z', 'Height from floor to bottom edge'],
    ['width_m', 'w', 'Opening width'],
    ['height_m', 'h', 'Opening height'],
  ];
  for (const [key, label, tip] of fields) {
    const fieldLabel = document.createElement('label');
    fieldLabel.title = tip;
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.min = '0';
    input.value = String(op[key] ?? 0);
    input.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      const next = readSlotAsObject(getSlot());
      next.openings[idx][key] = v;
      setSlot(next);
      emit('room:changed');
    });
    fieldLabel.append(span, input);
    dims.appendChild(fieldLabel);
  }

  // Opening depth (thickness) — its OWN handler, in millimetres (matches
  // the per-wall thickness control convention; the generic loop above
  // writes raw metres at step 0.1, too coarse for a 50 mm door). Stored as
  // metres. Clamped 10–300 mm: thin glazing through a deep framed window.
  // Drives the 3D slab depth in attachOpeningMesh; legacy openings with no
  // field fall back to 50 mm there.
  {
    const tLabel = document.createElement('label');
    tLabel.title = 'Opening depth (leaf / pane thickness), shown in the 3D preview. Auto-set from the chosen material (e.g. Glass window 6mm → 6 mm); edit for a deep frame / reveal.';
    const tSpan = document.createElement('span');
    tSpan.textContent = 'depth (mm)';
    const tInput = document.createElement('input');
    tInput.type = 'number';
    tInput.step = '1';
    tInput.min = '3';
    tInput.max = '300';
    tInput.value = String(Math.round((Number(op.thickness_m) || 0.05) * 1000));
    tInput.addEventListener('input', e => {
      const mm = parseFloat(e.target.value);
      if (!Number.isFinite(mm)) return;
      const clamped = Math.min(300, Math.max(3, mm));
      const next = readSlotAsObject(getSlot());
      next.openings[idx].thickness_m = clamped / 1000;
      setSlot(next);
      emit('room:changed');
    });
    tLabel.append(tSpan, tInput);
    dims.appendChild(tLabel);
  }
  row.appendChild(dims);

  return row;
}

// Hover on a surface row tells the 3D scene to emissive-highlight the
// matching mesh, so the user can scan a long wall list and see which
// wall each row maps to. Mirror of the click-to-pulse direction.
function attachSurfaceHover(rowEl, surfaceId) {
  rowEl.addEventListener('pointerenter', () => {
    emit('surface:hover', { surface_id: surfaceId });
  });
  rowEl.addEventListener('pointerleave', () => {
    emit('surface:hover', { surface_id: null });
  });
}

// Map a surface slot id to the boundary kind it represents, so the picker
// can offer only materials classified for that kind (materials.json
// `applicableTo`). Floor / ceiling are matched explicitly (incl. broken-out
// enclosure_N_* and the surau podium / roof undersides); everything else
// that hosts a material — rectangular walls, custom edges, enclosure walls,
// surau columns / partition / minaret, shared segments — is a vertical
// wall-like surface.
function surfaceKindFor(surfaceId) {
  if (!surfaceId) return null;
  if (surfaceId === 'floor' || /_floor$/.test(surfaceId) || surfaceId === 'surau_podium_top') return 'floor';
  if (surfaceId === 'ceiling' || /_ceiling$/.test(surfaceId)
      || surfaceId === 'surau_arcade_roof' || surfaceId === 'surau_portico_roof') return 'ceiling';
  return 'wall';
}

// A material is offered on a surface when its `applicableTo` list includes
// the surface kind. An empty array means "not a room-boundary finish" (rack
// panels, seat zone-coverage) → never offered. A MISSING list (legacy data /
// adopter catalogue without the field) falls back to "show everywhere" so we
// never hide a material we failed to classify.
function materialAllowedOn(mat, kind) {
  if (!kind) return true;
  const allow = mat.applicableTo;
  if (!Array.isArray(allow)) return true;
  return allow.includes(kind);
}

// kindOverride: when set ('door' | 'window'), the picker filters by that
// opening kind instead of deriving 'wall' from the dataKey via surfaceKindFor.
// A door slot then offers only door leaves (incl. glass/steel/acoustic doors),
// a window slot only glazing — never a solid wall finish. Wall / floor /
// ceiling selects pass no override and keep their surfaceKindFor behaviour.
function buildMatSelect(dataKey, currentValue, kindOverride) {
  const sel = document.createElement('select');
  sel.dataset.key = dataKey;
  const kind = kindOverride || surfaceKindFor(dataKey);
  const curId = (currentValue && typeof currentValue === 'object')
    ? currentValue.materialId : currentValue;
  let opts = materialsRef.list.filter(m => m.id !== 'audience-seated' && materialAllowedOn(m, kind));
  // Back-compat safety net: if the saved material isn't classified for this
  // surface (old scene, preset edge case), keep it selectable so loading a
  // project never silently swaps the material out from under the user.
  if (curId && !opts.some(m => m.id === curId)) {
    const cur = materialsRef.list.find(m => m.id === curId);
    if (cur) opts = [cur, ...opts];
  }
  sel.innerHTML = opts.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  sel.value = curId ?? opts[0]?.id ?? materialsRef.list[0].id;
  return sel;
}

function applyPreset(key) {
  // Suppressed swap: clearing activeCustomRoomId mid-block + the pending-
  // timer kill prevents the preset's content from being auto-synced over
  // the custom room the user was just editing.
  runSceneSwap(() => {
    applyPresetToState(key);
    // Presets have fixed geometry — no template regen on dim changes.
    activeTemplateKey = null;
    activeCustomRoomId = null;
    render();
    // scene:reset tells every panel/viewport that state arrays were replaced wholesale.
    // room:changed kept for listeners that only care about room geometry.
    emit('scene:reset');
    emit('room:changed');
  });
}

function applyTemplate(key) {
  runSceneSwap(() => {
    applyTemplateToState(key);
    activeTemplateKey = key;
    activeCustomRoomId = null;
    render();
    emit('scene:reset');
    emit('room:changed');
  });
}


// Listen for room:changed to re-render panel when draw mode finishes
// (`on` is imported at the top of the file alongside `emit`).
import { openPanel, getOpenPanel } from './rail-system.js';
on('room:changed', () => {
  const root = document.getElementById('panel-room');
  if (!root) return;
  const shapeSel = root.querySelector('[data-f="shape"]');
  if (shapeSel && shapeSel.value !== state.room.shape) {
    shapeSel.value = state.room.shape;
    render();
  } else if (state.room.shape === 'custom') {
    // Don't rebuild the custom-shape panel while the user is typing in a
    // vertex X/Y field OR the dome-rise field. renderShapeParams() replaces
    // #vertex-list and renderSurfaceMaterials() replaces #ceiling-params via
    // innerHTML, which would destroy the focused input and drop the caret
    // after the first digit (the vertex manual-entry focus bug — the
    // dome-rise field, now inside the Ceiling group, has the same shape).
    // The 2D/3D viewports still update live — they listen to room:changed
    // separately. The fields re-render on the next room:changed once focus
    // has left. Guarded by tests/vertex-edit-focus.test.mjs.
    const ae = document.activeElement;
    const hasClosest = ae && typeof ae.closest === 'function';
    if (hasClosest && ae.closest('#vertex-list')) return;
    // Same caret-drop guard for the dome-rise field — it now lives inside
    // #ceiling-params, which renderSurfaceMaterials() replaces via innerHTML.
    if (hasClosest && ae.closest('#ceiling-params')) return;
    renderShapeParams();
    renderSurfaceMaterials();
  }
});

// Project file load drops the activeTemplateKey association — the loaded
// scene is whatever was saved, and dimension edits should not re-run a
// template generator on top of it.
on('scene:reset', () => {
  // Note: don't reset activeTemplateKey if WE just set it via applyTemplate
  // — scene:reset is emitted both from us and from a cloud-scene/share-link load.
  // Distinguishing requires a payload; for v1 we accept that loading a
  // scene dropped from a template still loses the regen behaviour,
  // which is the conservative default.
});

// Keep the saved-rooms tree current without a full panel render: structural
// library changes (save / delete / rename emit projects:changed) and the dirty
// marker on the active row (scene:dirty-changed is edge-triggered, so this
// fires only on clean↔dirty transitions, not per drag-frame). A re-render
// rebuilds the tree wholesale, so skip it while an inline project rename is in
// progress — it would destroy the focused <input> and drop the user's typing.
function _refreshSavedRoomsTree() {
  if (document.querySelector('.srt-rename-input')) return;
  renderSavedRoomsTree();
}
on('projects:changed', _refreshSavedRoomsTree);
on('scene:dirty-changed', _refreshSavedRoomsTree);

// Auto-sync the active saved-custom-room entry when the user mutates the
// live scene. Captures a FULL scene snapshot (serializeProject) so
// speakers / listeners / zones / treatments / physics / author notes the
// user adds AFTER drawing the room persist with it — not just geometry
// and racks (the 2026-05-21 "everything gone on reopen" bug). Debounced
// 300 ms to coalesce bursts. The _suppressSync guard + the inner
// activeCustomRoomId re-check stop a wholesale scene swap (preset /
// template / load) from clobbering the saved room with transient state.
let _autoSyncTimer = null;
// Cloud auto-sync is intentionally DISABLED (v=834) — saving is EXPLICIT now:
// the 💾 Save button (saveActiveRoom) writes the active room to the account, and
// the dirty flag (markDirty, wired in roomlab/main.js) tracks unsaved changes +
// warns before a refresh. No silent background writes to the server.
function scheduleActiveRoomSync() { /* no-op — explicit Save only */ }

// Click on a wall / floor / ceiling in the 3D viewport pulses the matching
// material <select> in this panel — Maya's spec: the picker already exists
// where the user expects it, so teach the user where it is by pulsing rather
// than duplicating into a popover. Per-row outline highlight + scroll-into-
// view + native dropdown open via .focus()+.click().
on('surface:picked', ({ surface_id } = {}) => {
  if (!surface_id) return;
  const root = document.getElementById('panel-room');
  if (!root) return;

  // P1-overhaul rail-panel system: the Room panel only renders when
  // <html data-rail-left="room">. If the user is on a different panel
  // (or has no panel open), the wall row is display:none and
  // scrollIntoView is a no-op. Open the Room panel first; if it's
  // already open, openPanel is a cheap a11y refresh.
  const railWasOpen = (getOpenPanel('left') === 'room');
  if (!railWasOpen) openPanel('left', 'room');

  // Legacy collapsibles fallback (in case any older route wraps
  // panel-room in a collapsible section).
  if (root.classList.contains('collapsed')) {
    root.classList.remove('collapsed');
    const h2 = root.querySelector(':scope > h2, :scope > * > h2');
    h2?.setAttribute('aria-expanded', 'true');
  }

  // Wait for the rail-panel slide-in animation before measuring +
  // scrolling. ANIM_WINDOW_MS in rail-system.js is 380ms; we use 400
  // to give layout one frame past the transition end. When the panel
  // is already open we just defer one rAF so any pending re-render
  // settles before we scroll.
  const delayMs = railWasOpen ? 0 : 400;
  setTimeout(() => {
    let wrap = root.querySelector(`label[data-surface-id="${cssEscape(surface_id)}"]`);
    // Surau arcade columns carry per-column unique surface_ids
    // (surau_arcade_column_S_3 etc.) but the UI exposes ONE material
    // row covering all columns. Collapse the lookup so clicking any
    // column highlights the shared row.
    if (!wrap && surface_id.startsWith('surau_arcade_column_')) {
      wrap = root.querySelector(`label[data-surface-id="surau_arcade_column"]`);
    }
    // Same shape for the arcade roofs — each side carries a per-side
    // surface_id (surau_arcade_roof_south / _east / _west) but the UI
    // exposes ONE shared row 'surau_arcade_roof'. Without this fallback,
    // clicking any of the three corridor roofs in 3D was a no-op
    // (user-reported 2026-05-24).
    if (!wrap && surface_id.startsWith('surau_arcade_roof_')) {
      wrap = root.querySelector(`label[data-surface-id="surau_arcade_roof"]`);
    }
    if (!wrap) return;
    wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    wrap.classList.remove('surface-pulse');
    // Force reflow so re-adding the class restarts the animation when
    // the user clicks the same wall twice in a row.
    void wrap.offsetWidth;
    wrap.classList.add('surface-pulse');
    setTimeout(() => wrap.classList.remove('surface-pulse'), 1400);
    const sel = wrap.querySelector('select');
    if (sel) {
      try { sel.focus({ preventScroll: true }); } catch {}
    }
  }, delayMs);
});

// CSS.escape isn't available on IE / older WebViews; this is a safe subset
// for the only character class we ever produce ('edge_0', 'wall_north').
function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_\-]/g, ch => '\\' + ch);
}

// Sub-structure selection mirroring: when scene.js's onSubStructureClick
// updates state.selectedSubStructureId, re-render the chip row so the
// matching chip gets .active + the auto-scroll fires. Also re-render
// surface materials in case the user broke-to-merged via the keyboard
// path later (no state shape change yet, but cheap to keep coherent).
on('sub_structure:selected', () => {
  const root = document.getElementById('panel-room');
  if (!root) return;
  // Mirror the surface:picked flow — open the rail Room panel so the
  // chip row is actually visible to scroll to.
  if (getOpenPanel('left') !== 'room') openPanel('left', 'room');
  if (root.classList.contains('collapsed')) {
    root.classList.remove('collapsed');
    const h2 = root.querySelector(':scope > h2, :scope > * > h2');
    h2?.setAttribute('aria-expanded', 'true');
  }
  renderPlacedSubStructures();
});

// ---------------------------------------------------------------------------
// Place-Saved-Room flow — user clicks ⊕ Place, picks a saved room from any
// project, then drags the ghost into position with mouse + Y-key for height.
// On click → confirmation modal → commit pushes a sub-structure entry into
// state.room.subStructures and emits room:changed so the 3D viewport
// rebuilds with the placed sub-room visible.
//
// PHASE 1 — VISUAL ONLY. The placed sub-room is NOT folded into the
// acoustic surfaces list. See the Phase-2 comment on rebuildSubStructures
// in js/graphics/scene.js for the deferred work.
// ---------------------------------------------------------------------------

// Currently-active placement controller (one at a time). Held at module
// scope so a second click on the Place button while one is already in
// flight is a no-op (we surface a toast instead of stacking sessions).
let activePlacementController = null;
let placementHudEl = null;

function ensurePlacementHud() {
  if (placementHudEl && placementHudEl.isConnected) return placementHudEl;
  const el = document.createElement('div');
  el.id = 'placement-hud';
  el.className = 'rl-placement-hud';
  document.body.appendChild(el);
  placementHudEl = el;
  return el;
}

function setPlacementHud(text) {
  const el = ensurePlacementHud();
  if (!text) {
    el.classList.remove('show');
    return;
  }
  el.textContent = text;
  el.classList.add('show');
}

async function startPlaceSavedRoomFlow() {
  if (activePlacementController) {
    showToast('A placement is already in progress', 'err');
    return;
  }
  const all = listCustomRooms();
  if (all.length === 0) {
    showToast('No saved rooms yet — draw one first via ✎ Draw custom room', 'err');
    return;
  }
  const bindings = getPlacementBindings();
  if (!bindings) {
    showToast('3D viewport is still initialising — try again in a moment', 'err');
    return;
  }
  // Switch to 3D view so the user can see the ghost — placement only
  // makes sense in the 3D scene since it's the move surface.
  document.querySelector('.vp-tab[data-view="3d"]')?.click();
  const picked = await showPlaceRoomPicker(all);
  if (!picked) return;
  const sourceRoomName = picked.roomName || 'Untitled';
  const controller = new PlaceRoomController({
    domElement: bindings.domElement,
    camera: bindings.camera,
    scene: bindings.scene,
    parentRoom: state.room,
    sourceRoom: picked.room,
    sourceRoomId: picked.id,
    sourceRoomName,
    onPreviewMove: (transform) => {
      bindings.setGhost(picked.room, sourceRoomName, transform);
    },
    onCommit: (entry) => {
      // Phase 1: append to state.room.subStructures, emit room:changed so
      // the 3D + 2D rebuild paths pick it up. Auto-sync (rack:changed-style)
      // is already wired for room:changed (scheduleActiveRoomSync below)
      // so the active library entry is updated too.
      if (!Array.isArray(state.room.subStructures)) state.room.subStructures = [];
      state.room.subStructures.push(entry);
      bindings.clearGhost();
      bindings.setOrbitEnabled?.(true);
      activePlacementController = null;
      setPlacementHud(null);
      emit('room:changed');
      showToast(`Placed "${entry.sourceRoomName}"`, 'ok');
    },
    onCancel: () => {
      bindings.clearGhost();
      bindings.setOrbitEnabled?.(true);
      activePlacementController = null;
      setPlacementHud(null);
      showToast('Placement cancelled', 'ok');
    },
    onHud: setPlacementHud,
    onConfirmRequest: ({ sourceRoomName: name, onYes, onNo }) => {
      showPlacementConfirm(name).then(yes => {
        if (yes) onYes(); else onNo();
      });
    },
  });
  activePlacementController = controller;
  // Disable OrbitControls so cursor drag moves the ghost, not the camera.
  bindings.setOrbitEnabled?.(false);
  controller.enable();
}

// Picker modal: lists every saved room across every project, grouped by
// project name. Returns Promise<{ id, room, roomName, projectName } | null>.
// Reuses the .rl-modal-overlay / .rl-modal CSS so the look matches the
// "New custom room" picker.
function showPlaceRoomPicker(allRooms) {
  return new Promise(resolve => {
    // Group by project name (null projects bucket as '(Unfiled)').
    const byProj = new Map();
    for (const e of allRooms) {
      const key = (typeof e.projectName === 'string' && e.projectName.trim())
        ? e.projectName.trim()
        : '(Unfiled)';
      if (!byProj.has(key)) byProj.set(key, []);
      byProj.get(key).push(e);
    }
    // Newest project first by latest savedAt within the bucket.
    const groups = [...byProj.entries()].map(([name, rooms]) => {
      rooms.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
      return { name, rooms };
    });
    groups.sort((a, b) => {
      const aT = a.rooms[0]?.savedAt ?? '';
      const bT = b.rooms[0]?.savedAt ?? '';
      return bT.localeCompare(aT);
    });

    const overlay = document.createElement('div');
    overlay.className = 'rl-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'rl-modal rl-place-room-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Place saved room');

    const groupsHtml = groups.map(group => {
      const header = group.name === '(Unfiled)' ? '(Unfiled)' : escapeHtml(group.name);
      const roomsHtml = group.rooms.map(r => {
        const dim = r.room ? `${(r.room.width_m ?? 0).toFixed(1)} × ${(r.room.depth_m ?? 0).toFixed(1)} × ${(r.room.height_m ?? 0).toFixed(1)} m` : '';
        const shape = r.room?.shape ? escapeHtml(r.room.shape) : '';
        return `
          <label class="rl-modal-radio-row">
            <input type="radio" name="rl-place-pick" value="${escapeAttr(r.id)}" />
            <span class="rl-modal-radio-text">${escapeHtml(r.roomName || 'Untitled')}<span class="rl-modal-count">${shape} · ${dim}</span></span>
          </label>`;
      }).join('');
      return `
        <div class="rl-modal-section">
          <div class="rl-modal-label">${header}</div>
          <div class="rl-modal-projects">${roomsHtml}</div>
        </div>`;
    }).join('');

    modal.innerHTML = `
      <h3>Place saved room</h3>
      <div class="rl-modal-section" style="max-height: 320px; overflow-y: auto;">
        ${groupsHtml}
      </div>
      <div class="rl-modal-actions">
        <button type="button" class="rl-modal-cancel">Cancel</button>
        <button type="button" class="rl-modal-confirm" disabled>Pick room to place</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const confirmBtn = modal.querySelector('.rl-modal-confirm');
    const radios = modal.querySelectorAll('input[name="rl-place-pick"]');
    radios.forEach(r => r.addEventListener('change', () => {
      const sel = modal.querySelector('input[name="rl-place-pick"]:checked');
      if (sel) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Place this room';
      }
    }));

    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    const confirm = () => {
      const sel = modal.querySelector('input[name="rl-place-pick"]:checked');
      if (!sel) return;
      const entry = allRooms.find(r => r.id === sel.value);
      if (!entry) { close(null); return; }
      close({ id: entry.id, room: entry.room, roomName: entry.roomName, projectName: entry.projectName });
    };
    modal.querySelector('.rl-modal-cancel').addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', confirm);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);
  });
}

// Confirmation dialog ("Place [Room name] here? You can still move it
// later.") — yes/no Promise.
function showPlacementConfirm(sourceRoomName) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'rl-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'rl-modal rl-place-confirm-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Confirm placement');
    modal.innerHTML = `
      <h3>Confirm placement</h3>
      <div class="rl-modal-section">
        Place <strong>${escapeHtml(sourceRoomName || 'this room')}</strong> here? You can still move it later.
      </div>
      <div class="rl-modal-actions">
        <button type="button" class="rl-modal-cancel">Cancel</button>
        <button type="button" class="rl-modal-confirm">Place</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };
    modal.querySelector('.rl-modal-cancel').addEventListener('click', () => close(false));
    modal.querySelector('.rl-modal-confirm').addEventListener('click', () => close(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);
    // Focus the confirm so Enter commits.
    setTimeout(() => modal.querySelector('.rl-modal-confirm')?.focus(), 0);
  });
}
