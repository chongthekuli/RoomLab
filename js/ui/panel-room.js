import { state, PRESETS, TEMPLATES, SHAPE_LABELS, CEILING_LABELS, applyPresetToState, applyTemplateToState, applyBlankCustomRoom } from '../app-state.js';
import { emit, on } from './events.js';
import { startDrawCustomShape } from '../graphics/room-2d.js';
import { importDxfFile } from '../physics/dxf-import.js';
import { saveProjectToDownload, loadProjectFromFile } from '../io/project-file.js';
import { encodeShareLink, buildShareUrl } from '../io/share-link.js';
import { triggerPrint } from './print-report.js';
import { listCustomRooms, listProjects, latestRoomInProject, saveCustomRoom, getCustomRoomById, deleteCustomRoom, updateCustomRoom } from '../shared/custom-rooms.js';
import { getPlacementBindings } from '../graphics/scene.js';
import { PlaceRoomController } from '../graphics/place-room-controller.js';
import { splitParentVsEnclosure } from '../physics/wall-overlap.js';
import { roomPlanVertices } from '../physics/room-shape.js';

// Identity of the saved-custom-room entry the user is currently
// editing (or null when working on a preset / template / freshly-
// loaded scene). Set when the user starts drawing a new custom
// room or clicks an existing chip; cleared when they switch to a
// preset/template/load.
let activeCustomRoomId = null;
// Names captured from the two-prompt flow, held until the polygon
// closes (roomshape:closed) so the new entry gets the right labels.
let pendingProjectName = null;
let pendingRoomName = null;

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

export function mountRoomPanel({ materials }) {
  materialsRef = materials;
  const root = document.getElementById('panel-room');
  root.innerHTML = `
    <h2>Room</h2>
    <div class="field-group room-name-row">
      <label title="Free-text label for this room — shows on the print-report cover under the project name. Distinct from the project name (one project can hold several rooms).">Room name
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
        <button id="btn-place-saved-room" class="btn-custom-draw" title="Place a saved room from any project as a sub-structure inside this room. Useful for huts in a park, balconies, kiosks.">⊕ Place</button>
        <div id="custom-saved-row" class="custom-saved-row"></div>
      </div>
    </div>
    <div id="sub-structures-row" class="custom-saved-row"></div>
    <div id="sub-structure-detail" class="sub-structure-detail" hidden></div>
    <div class="import-row">
      <button id="btn-import-dxf" class="btn-import" title="Import room outline from a DXF file (DWG must be converted first)">⇪ Import DXF…</button>
      <input type="file" id="file-dxf" accept=".dxf,.dwg" hidden />
    </div>
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
    <h3>Ceiling</h3>
    <div class="field-group">
      <label>Ceiling
        <select data-f="ceiling_type">
          ${Object.entries(CEILING_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="ceiling-params"></div>
    <h3>Surface materials</h3>
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
    applyTemplate(key);
    // Reset the OTHER dropdown so the UI shows one active selection at a time.
    const pd = root.querySelector('#preset-dropdown');
    if (pd) pd.value = '';
  });

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
      activeCustomRoomId = null;     // a fresh draw starts a new entry
      applyBlankCustomRoom({ projectName });
      activeTemplateKey = null;
      render();
      emit('scene:reset');     // panels rebuild — the previous scene's data is gone
      emit('room:changed');
      document.querySelector('.vp-tab[data-view="2d"]')?.click();
      setTimeout(() => startDrawCustomShape(), 50);
    });
  });

  // Save / Load / Share / Print buttons live in the top header now
  // (rendered by js/shared/header-nav.js so they're visible on every
  // Lab route). Handlers are still bound here because RoomLAB owns
  // the scene state these actions operate on; the click bindings
  // attach when RoomLAB mounts.
  document.getElementById('btn-save-project')?.addEventListener('click', () => {
    try {
      const filename = saveProjectToDownload();
      showStatus(`Saved as ${filename}`, 'ok');
    } catch (err) {
      showStatus(`Save failed: ${err.message || err}`, 'err');
    }
  });

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
      // so the saved entry's geometry blob itself carries the label and
      // the print-report cover renders it on first load.
      if (typeof pendingRoomName === 'string' && pendingRoomName.trim()) {
        state.room.name = pendingRoomName.trim();
      }
      // Deep-clone so the saved entry is independent of further edits.
      const roomSnapshot = JSON.parse(JSON.stringify(state.room));
      const rackSnapshot = JSON.parse(JSON.stringify(state.rackSystem ?? { racks: [] }));
      const entry = saveCustomRoom({
        projectName: pendingProjectName,
        roomName: pendingRoomName,
        room: roomSnapshot,
        rackSystem: rackSnapshot,
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

  // Share — encode current state into a URL fragment, copy it. Oversize
  // scenes (pavilion-class, ~70 KB encoded) get a "use Save instead"
  // banner. Clipboard write may silently fail on Safari outside a user
  // gesture chain — surface the URL inline as the fallback.
  document.getElementById('btn-share-link')?.addEventListener('click', async () => {
    const { hash, chars, tooLarge, bytes } = encodeShareLink();
    if (tooLarge) {
      showStatus(`scene too large for a link (${(bytes / 1024).toFixed(1)} KB) — use 💾 Save instead`, 'err');
      return;
    }
    const url = buildShareUrl(hash);
    try {
      await navigator.clipboard.writeText(url);
      showToast(`link copied — ${(bytes / 1024).toFixed(1)} KB`, 'ok');
    } catch {
      // Clipboard rejected (Safari without user gesture, or insecure
      // context). Show the URL inline so the user can copy by hand.
      showStatus(`couldn't auto-copy — copy this URL manually:\n${url}`, 'err');
    }
  });
  const projectFileInput = document.getElementById('file-roomlab');
  document.getElementById('btn-load-project')?.addEventListener('click', () => projectFileInput?.click());
  projectFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    projectFileInput.value = ''; // allow reloading the same file
    if (!file) return;
    try {
      const { warnings } = await loadProjectFromFile(file);
      const warnSuffix = warnings?.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : '';
      showStatus(`Loaded ${file.name}${warnSuffix}`, 'ok');
      // Re-render the room panel itself so the shape select etc. reflect
      // the loaded state. scene:reset already woke every other panel.
      render();
    } catch (err) {
      showStatus(err.message || String(err), 'err');
    }
  });

  // DXF import — converts largest closed polyline in the file into the
  // current room's custom_vertices. Height and surface materials are
  // preserved; user edits them after.
  const fileInput = root.querySelector('#file-dxf');
  root.querySelector('#btn-import-dxf').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleDxfImport(file);
    fileInput.value = ''; // allow re-selecting the same file
  });

  root.querySelector('[data-f="shape"]').addEventListener('change', e => {
    state.room.shape = e.target.value;
    if (e.target.value === 'custom' && (!state.room.custom_vertices || state.room.custom_vertices.length < 3)) {
      // Seed with a default L-shape so user sees something before drawing
      state.room.custom_vertices = [
        { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }, { x: 2.5, y: 3 }, { x: 2.5, y: 5 }, { x: 0, y: 5 },
      ];
      state.room.width_m = 5;
      state.room.depth_m = 5;
      state.room.surfaces.edges = state.room.custom_vertices.map(() => state.room.surfaces.walls || 'gypsum-board');
    }
    syncBoundingBoxToShape();
    // Manual shape change drops any active template association — the
    // user is hand-editing the room, so dimension changes shouldn't
    // re-run a template generator.
    activeTemplateKey = null;
    render();
    emit('room:changed');
  });
  root.querySelector('[data-f="ceiling_type"]').addEventListener('change', e => {
    state.room.ceiling_type = e.target.value;
    render();
    emit('room:changed');
  });
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
// when the user applies a Preset, draws a custom shape, loads a project
// file, or hits Import DXF.
let activeTemplateKey = null;

function showStatus(text, kind) {
  const status = document.getElementById('import-status');
  if (!status) return;
  status.hidden = false;
  status.className = 'import-status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
  status.textContent = text;
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
  root.querySelector('[data-f="shape"]').value = state.room.shape;
  root.querySelector('[data-f="ceiling_type"]').value = state.room.ceiling_type;
  root.querySelector('[data-f="enclosure"]').value = state.room.enclosure ?? 'indoor';
  // Outdoor mode hides the entire Ceiling section since there's no roof
  // — only Plan-shape, Type, Shape params (without height), and the floor
  // material remain meaningful. The DOM nodes stay so flipping back to
  // Indoor doesn't have to re-mount; we just toggle their hidden state.
  const isOutdoor = state.room.enclosure === 'outdoor';
  const ceilingHeader = Array.from(root.querySelectorAll('h3')).find(el => el.textContent === 'Ceiling');
  if (ceilingHeader) ceilingHeader.hidden = isOutdoor;
  const ceilGroup = root.querySelector('[data-f="ceiling_type"]')?.closest('.field-group');
  if (ceilGroup) ceilGroup.hidden = isOutdoor;
  const ceilParamsHost = root.querySelector('#ceiling-params');
  if (ceilParamsHost) ceilParamsHost.hidden = isOutdoor;
  renderShapeParams();
  renderCeilingParams();
  renderSurfaceMaterials();
  renderSavedCustomRooms();
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
function renderSavedCustomRooms() {
  const host = document.getElementById('custom-saved-row');
  if (!host) return;
  const all = listCustomRooms();
  const activeProj = (typeof state.projectName === 'string' && state.projectName.trim())
    ? state.projectName.trim()
    : null;
  // entry.projectName === null OR '' is the "(Unfiled)" bucket. Filter
  // the chip list to entries whose project matches the active project,
  // treating null === null as a match for unfiled rooms.
  const entries = all.filter(e => {
    const en = (typeof e.projectName === 'string' && e.projectName.trim())
      ? e.projectName.trim()
      : null;
    return en === activeProj;
  });
  if (entries.length === 0) { host.innerHTML = ''; return; }
  const projBanner = activeProj
    ? `<span class="custom-saved-banner" title="Showing rooms in this project only">${escapeHtml(activeProj)}:</span>`
    : `<span class="custom-saved-banner" title="Rooms saved without a project">Unfiled:</span>`;
  host.innerHTML = projBanner + entries.map(e => {
    const isActive = e.id === activeCustomRoomId;
    const label = escapeHtml(e.roomName || 'Untitled');
    const proj = e.projectName ? escapeHtml(e.projectName) : '';
    const tooltip = proj ? `${proj} · ${label}` : label;
    return `
      <span class="custom-chip${isActive ? ' active' : ''}" data-cr-id="${e.id}" title="${escapeAttr(tooltip)}">
        <button class="custom-chip-load" type="button">${label}</button>
        <button class="custom-chip-delete" type="button" title="Delete this saved custom room" aria-label="Delete">×</button>
      </span>
    `;
  }).join('');

  host.querySelectorAll('.custom-chip-load').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.parentElement?.dataset.crId;
      if (id) loadCustomRoomById(id);
    });
  });
  host.querySelectorAll('.custom-chip-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.parentElement?.dataset.crId;
      if (!id) return;
      if (!window.confirm('Delete this saved custom room?')) return;
      deleteCustomRoom(id);
      if (activeCustomRoomId === id) activeCustomRoomId = null;
      renderSavedCustomRooms();
      emit('projects:changed');   // header dropdown may need to drop a project
    });
  });
}

function loadCustomRoomById(id) {
  const entry = getCustomRoomById(id);
  if (!entry) return;
  // Reset the scene first so the previous preset's sources / listeners /
  // zones don't survive the swap (same discipline as preset / template
  // switching — see js/state/scene-lifecycle.js).
  applyBlankCustomRoom({ projectName: entry.projectName ?? null });
  // Overlay the saved geometry on top of the freshly-blanked room.
  Object.assign(state.room, JSON.parse(JSON.stringify(entry.room)));
  // Backfill room.name from the saved-rooms library entry's roomName
  // when the snapshot itself didn't carry one (saved before room.name
  // existed as a state field). Keeps the print-report cover stable.
  if (!state.room.name && typeof entry.roomName === 'string' && entry.roomName.trim()) {
    state.room.name = entry.roomName.trim();
  }
  // Restore the saved-room's rackSystem so racks placed via DeviceLAB
  // into this saved entry land in the live scene now. Empty default
  // when the entry pre-dates the rackSystem-on-saved-rooms feature.
  state.rackSystem = entry.rackSystem
    ? JSON.parse(JSON.stringify(entry.rackSystem))
    : { racks: [] };
  activeCustomRoomId = entry.id;
  activeTemplateKey = null;
  render();
  emit('scene:reset');
  emit('room:changed');
  emit('rack:changed');   // 3D scene rebuilds racksGroup with the loaded set
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
      <button class="btn-draw" id="btn-draw-custom">${vcount >= 3 ? '✎ Redraw custom shape' : '✎ Draw custom shape'}</button>
      ${vcount >= 3 ? `<div class="note-small">${vcount} vertices · bbox ${r.width_m.toFixed(1)} × ${r.depth_m.toFixed(1)} m</div>` : '<div class="note-small">Click the button above to draw a polygon by placing vertices.</div>'}
      <div id="vertex-list"></div>
    `;
    root.querySelector('#btn-draw-custom').addEventListener('click', () => startDrawCustomShape());
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
  const root = document.getElementById('ceiling-params');
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

// Wall slots accept two forms: a bare string (legacy: material id only)
// or { materialId, openings } (PR2). These helpers read/write either form
// transparently — the panel always shows the user the same controls
// regardless of which form storage is currently in.
function readSlotMatId(slot, fallback = 'gypsum-board') {
  if (typeof slot === 'string') return slot;
  if (slot && typeof slot === 'object' && typeof slot.materialId === 'string') return slot.materialId;
  return fallback;
}
function readSlotOpenings(slot) {
  if (slot && typeof slot === 'object' && Array.isArray(slot.openings)) return slot.openings;
  return [];
}
// Always returns an object — caller may freely mutate it. If the original
// was a string, returns a fresh object that the caller should write back.
function readSlotAsObject(slot, fallback = 'gypsum-board') {
  return { materialId: readSlotMatId(slot, fallback), openings: readSlotOpenings(slot) };
}
// If the slot has no openings, write back the bare string form (preserves
// legacy save shape). Otherwise write the object form.
function compactSlot(slot) {
  if (slot && typeof slot === 'object' && Array.isArray(slot.openings) && slot.openings.length === 0) {
    return slot.materialId;
  }
  return slot;
}

const DEFAULT_DOOR    = { kind: 'door',   width_m: 0.9, height_m: 2.1, x_m: 0.5, z_m: 0,   materialId: 'door-solid-wood', state: 'closed' };
const DEFAULT_WINDOW  = { kind: 'window', width_m: 1.5, height_m: 1.2, x_m: 0.5, z_m: 1.0, materialId: 'glass-window',    state: 'closed' };

let _opIdCounter = 1;
function newOpeningId() { return 'op-' + (_opIdCounter++).toString(36) + Math.random().toString(36).slice(2, 5); }

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
  const renderWallRow = (parent, surfaceId, label, getSlot, setSlot, withOpenings) => {
    const wrap = document.createElement('div');
    wrap.className = 'wall-row';
    wrap.dataset.surfaceId = surfaceId;
    const matRow = document.createElement('label');
    matRow.dataset.surfaceId = surfaceId;
    matRow.className = 'wall-mat-row';
    const sel = buildMatSelect(surfaceId, readSlotMatId(getSlot()));
    sel.dataset.surfaceId = surfaceId;
    sel.addEventListener('change', e => {
      const slot = readSlotAsObject(getSlot());
      slot.materialId = e.target.value;
      setSlot(compactSlot(slot));
      emit('room:changed');
    });
    matRow.append(label + ' ', sel);
    attachSurfaceHover(matRow, surfaceId);
    wrap.appendChild(matRow);
    if (withOpenings) {
      wrap.appendChild(renderOpeningsBlock(surfaceId, getSlot, setSlot));
    }
    parent.appendChild(wrap);
  };

  // Outdoor mode keeps walls user-controlled — just rename the floor row to
  // "Ground" and skip the ceiling row (no roof). Walls can be set to
  // 'open-air' individually if the user wants a fully open footprint.
  const isOutdoor = state.room.enclosure === 'outdoor';

  if (state.room.shape === 'custom') {
    const group1 = document.createElement('div');
    group1.className = 'field-group';
    const fcRows = isOutdoor
      ? [['floor', 'Ground']]
      : [['floor', 'Floor'], ['ceiling', 'Ceiling']];
    for (const [id, lbl] of fcRows) {
      renderWallRow(
        group1, id, lbl,
        () => state.room.surfaces[id],
        v => { state.room.surfaces[id] = v; },
        false,
      );
    }
    root.appendChild(group1);

    const h4 = document.createElement('h4');
    h4.textContent = 'Wall materials';
    root.appendChild(h4);

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
    // FALL THROUGH to renderEnclosureMaterialSections at the bottom so
    // a custom-shape parent ALSO gets per-enclosure rows. Without this,
    // clicking an enclosure face in 3D would emit surface:picked but
    // the panel listener couldn't find a matching row → silent failure.
    renderEnclosureMaterialSections(root, renderWallRow);
    renderSharedWallSegmentSection(root, renderWallRow);
    return;
  }

  const labelsAll = state.room.shape === 'rectangular' ? RECT_SURFACE_LABELS : NONRECT_SURFACE_LABELS;
  const labels = isOutdoor
    ? labelsAll.filter(([id]) => id !== 'ceiling').map(
        ([id, lbl]) => [id, id === 'floor' ? 'Ground' : lbl],
      )
    : labelsAll;
  const group = document.createElement('div');
  group.className = 'field-group';
  for (const [id, label] of labels) {
    const isWall = id !== 'floor' && id !== 'ceiling';
    renderWallRow(
      group, id, label,
      () => state.room.surfaces[id],
      v => { state.room.surfaces[id] = v; },
      isWall,
    );
  }
  root.appendChild(group);

  // Per-enclosure sections — broken-out sub-rooms get their own Floor /
  // Ceiling / Wall N material rows + a × button to drop the whole
  // enclosure if the user regrets breaking it. Re-uses renderWallRow so
  // openings (doors, windows) work identically.
  renderEnclosureMaterialSections(root, renderWallRow);
  renderSharedWallSegmentSection(root, renderWallRow);
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
    next.openings.push({ ...DEFAULT_DOOR, id: newOpeningId() });
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
    next.openings.push({ ...DEFAULT_WINDOW, id: newOpeningId() });
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

  // Material select — reuses the same list as walls but defaults differ
  // by kind. Hidden when state === 'open' since it's irrelevant.
  const matSel = buildMatSelect(`${surfaceId}-op-${idx}`, op.materialId);
  matSel.className = 'opening-mat';
  matSel.addEventListener('change', e => {
    const next = readSlotAsObject(getSlot());
    next.openings[idx].materialId = e.target.value;
    setSlot(next);
    emit('room:changed');
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

function buildMatSelect(dataKey, currentValue) {
  const sel = document.createElement('select');
  sel.dataset.key = dataKey;
  sel.innerHTML = materialsRef.list.filter(m => m.id !== 'audience-seated').map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  sel.value = currentValue ?? materialsRef.list[0].id;
  return sel;
}

function applyPreset(key) {
  applyPresetToState(key);
  // Presets have fixed geometry — no template regen on dim changes.
  activeTemplateKey = null;
  activeCustomRoomId = null;
  render();
  // scene:reset tells every panel/viewport that state arrays were replaced wholesale.
  // room:changed kept for listeners that only care about room geometry.
  emit('scene:reset');
  emit('room:changed');
}

function applyTemplate(key) {
  applyTemplateToState(key);
  activeTemplateKey = key;
  activeCustomRoomId = null;
  render();
  emit('scene:reset');
  emit('room:changed');
}

async function handleDxfImport(file) {
  const status = document.getElementById('import-status');
  status.hidden = false;
  status.className = 'import-status';
  status.textContent = `Reading ${file.name}…`;
  try {
    const { polygons, bestIndex, source_units } = await importDxfFile(file);
    const best = polygons[bestIndex];
    // Translate so the polygon's bbox starts at the origin (consistent with
    // the draw-custom convention — the 2D viewport expects x/y >= 0).
    const minX = Math.min(...best.vertices.map(v => v.x));
    const minY = Math.min(...best.vertices.map(v => v.y));
    const verts = best.vertices.map(v => ({ x: v.x - minX, y: v.y - minY }));
    const w = Math.max(...verts.map(v => v.x));
    const d = Math.max(...verts.map(v => v.y));

    state.room.shape = 'custom';
    state.room.custom_vertices = verts;
    state.room.width_m = w;
    state.room.depth_m = d;
    state.room.surfaces.edges = verts.map(() => state.room.surfaces.walls || 'gypsum-board');
    activeTemplateKey = null;

    render();
    emit('room:changed');

    const more = polygons.length > 1 ? ` (${polygons.length - 1} other closed polylines in file, largest used)` : '';
    status.textContent = `Imported ${verts.length}-vertex room · ${best.area_m2.toFixed(1)} m² · bbox ${w.toFixed(1)} × ${d.toFixed(1)} m · units ${source_units}${more}`;
    status.classList.add('ok');
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('err');
  }
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
    renderShapeParams();
    renderSurfaceMaterials();
  }
});

// Project file load drops the activeTemplateKey association — the loaded
// scene is whatever was saved, and dimension edits should not re-run a
// template generator on top of it.
on('scene:reset', () => {
  // Note: don't reset activeTemplateKey if WE just set it via applyTemplate
  // — scene:reset is emitted both from us and from project-file load.
  // Distinguishing requires a payload; for v1 we accept that loading a
  // project file dropped from a template still loses the regen behaviour,
  // which is the conservative default.
});

// Auto-sync the active saved-custom-room entry when the user mutates
// the live scene. Without this, racks placed via DeviceLAB into the
// "Current scene" while editing room A would be lost the moment the
// user clicked another chip — the saved entry's rackSystem would
// override what's in state. Debounced 300 ms to coalesce bursts.
let _autoSyncTimer = null;
function scheduleActiveRoomSync() {
  if (!activeCustomRoomId) return;
  if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
  _autoSyncTimer = setTimeout(() => {
    _autoSyncTimer = null;
    if (!activeCustomRoomId) return;
    try {
      updateCustomRoom(activeCustomRoomId, {
        room: JSON.parse(JSON.stringify(state.room)),
        rackSystem: JSON.parse(JSON.stringify(state.rackSystem ?? { racks: [] })),
        projectName: state.projectName ?? null,
      });
    } catch (err) {
      console.warn('failed to sync active custom room', err);
    }
  }, 300);
}
on('rack:changed', scheduleActiveRoomSync);

// Header project dropdown → load that project's most recent saved room.
// header-nav.js emits with the saved-room id already resolved, so we just
// hand off to the existing loader.
on('project:switch', ({ customRoomId } = {}) => {
  if (typeof customRoomId === 'string' && customRoomId) {
    loadCustomRoomById(customRoomId);
  }
});
on('room:changed', scheduleActiveRoomSync);

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
    const wrap = root.querySelector(`label[data-surface-id="${cssEscape(surface_id)}"]`);
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
