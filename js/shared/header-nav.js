// Shared header navigation. Three sections rendered into
// <header id="app-header">:
//   1. Brand + active project name
//   2. Lab nav pills (RoomLAB / SpeakerLAB / DeviceLAB)
//   3. Action buttons (Save / Load / Share / Print) + hidden file input
//
// The action-button MARKUP lives here so it sits in the top bar
// across every Lab, but the click HANDLERS are still bound by
// panel-room.js when RoomLAB mounts. That means: until the user
// has visited #/room at least once in this session, the header
// buttons render but don't react. Once RoomLAB has mounted, the
// handlers stick for the rest of the session.
//
// The project-name slot updates reactively on `scene:reset` (which
// fires when a preset / template / custom-room / project-load
// changes the scene) — pulls from `state.projectName`.

import { state } from '../app-state.js';
import { on, emit } from './events.js';
import { listProjects, latestRoomInProject } from './custom-rooms.js';

const LABS = [
  { id: 'room',    label: 'RoomLAB',    href: '#/room',    sublabel: 'Acoustic simulator' },
  { id: 'speaker', label: 'SpeakerLAB', href: '#/speaker', sublabel: 'Speaker library' },
  { id: 'device',  label: 'DeviceLAB',  href: '#/device',  sublabel: 'PA equipment' },
];

export function mountHeaderNav({ activeLab } = {}) {
  const header = document.getElementById('app-header');
  if (!header) return;

  const tabs = LABS.map(lab => {
    const isActive = lab.id === activeLab;
    const classes = ['lab-tab'];
    if (isActive) classes.push('active');
    const aria = isActive ? ' aria-current="page"' : '';
    return `
      <a class="${classes.join(' ')}" data-lab="${lab.id}" href="${lab.href}"${aria}>
        <span class="lab-tab-label">${lab.label}</span>
        <span class="lab-tab-sub">${lab.sublabel}</span>
      </a>`;
  }).join('');

  header.innerHTML = `
    <div class="app-brand">
      <span class="brand-text">RoomLAB Suite</span>
      <span class="project-slot" id="header-project-slot" hidden></span>
    </div>
    <nav class="lab-nav" aria-label="Lab navigation">${tabs}</nav>
    <div class="header-actions">
      <button id="btn-reset-data" class="btn-reset" aria-label="Reset all RoomLAB data" title="Reset all RoomLAB data — saved scene, custom rooms, panel state, Lab preferences. Asks for confirmation; cannot be undone.">↻</button>
      <button id="btn-save-project" class="btn-save" title="Save the entire project (room, speakers, listeners, zones, EQ, ambient noise) to a .roomlab.json file">💾 Save</button>
      <button id="btn-load-project" class="btn-load" title="Load a previously saved .roomlab.json project file">📂 Load</button>
      <button id="btn-share-link" class="btn-share" aria-label="share scene as link" title="Copy a URL that opens this exact scene — paste into Slack or email">🔗 Share</button>
      <button id="btn-print-report" class="btn-print" aria-label="print scene report" title="Open the browser print dialog with a one-page design summary (also Ctrl/Cmd-P)">🖨 Print</button>
      <input type="file" id="file-roomlab" accept=".json,.roomlab.json,application/json" hidden />
    </div>
  `;

  // Reset is a global action — no Lab needs to be mounted for it to
  // work, so we wire it here in the header module rather than in
  // panel-room.js (which only mounts when RoomLAB is visited).
  document.getElementById('btn-reset-data')?.addEventListener('click', resetAllData);

  syncProjectSlot();
  on('scene:reset', syncProjectSlot);
  on('room:changed', syncProjectSlot);
  // Saved-room library mutates → projects list changes → header may need
  // to add or drop the dropdown.
  on('projects:changed', syncProjectSlot);
}

// Wipe every `roomlab.*` localStorage key and reload. Other site
// data (cookies, unrelated storage from other apps on the same
// origin) is left alone. The confirm() dialog spells out what gets
// cleared so the user can't trip over it accidentally.
function resetAllData() {
  const ok = window.confirm(
    'Reset all RoomLAB data?\n\n' +
    'This permanently deletes:\n' +
    '  • Your current scene (autosaved)\n' +
    '  • All saved custom rooms\n' +
    '  • Sidebar collapse state\n' +
    '  • SpeakerLAB / DeviceLAB preferences\n\n' +
    'Cannot be undone. Save your work first via 💾 Save if needed.'
  );
  if (!ok) return;
  try {
    const keys = Object.keys(localStorage);
    for (const k of keys) {
      if (k.startsWith('roomlab.')) localStorage.removeItem(k);
    }
  } catch (err) {
    console.warn('reset: localStorage clear failed', err);
  }
  // Reload to a clean #/room route. replaceState first so we don't
  // pile a stale share-link blob (#R…) onto a freshly-reset state.
  if (history.replaceState) history.replaceState(null, '', location.pathname + '#/room');
  location.reload();
}

// Render the project slot in the brand area. Three modes:
//   0 projects  → slot hidden entirely (just shows "RoomLAB Suite")
//   1 project   → static label showing the project name (current behaviour)
//   2+ projects → dropdown button; click reveals the project list, picking
//                 one loads its most recent saved room into the live scene.
function syncProjectSlot() {
  const slot = document.getElementById('header-project-slot');
  if (!slot) return;
  const projects = listProjects();
  const activeName = (typeof state.projectName === 'string' && state.projectName.trim())
    ? state.projectName.trim()
    : null;

  // Filter "(Unfiled)" out of the dropdown count — it's the catch-all for
  // rooms saved without a project, not a real project the user picked.
  const realProjects = projects.filter(p => p.name !== '(Unfiled)');

  if (realProjects.length === 0 && !activeName) {
    slot.hidden = true; slot.innerHTML = '';
    return;
  }
  slot.hidden = false;

  if (realProjects.length < 2) {
    // Single (or zero with active live name) → static pill, no dropdown.
    slot.innerHTML = `<span class="project-name">${escapeHtml(activeName ?? realProjects[0].name)}</span>`;
    return;
  }

  // 2+ projects → dropdown. The active one is highlighted, others
  // selectable. Native <details><summary> gives us click-toggle + Esc-
  // close + outside-click-close for free without bringing in a popover
  // library, and is keyboard-accessible by default.
  const itemsHtml = realProjects.map(p => {
    const isActive = (p.name === activeName);
    const cls = 'project-dd-item' + (isActive ? ' active' : '');
    return `
      <button type="button" class="${cls}" data-proj="${escapeAttr(p.name)}">
        <span class="project-dd-name">${escapeHtml(p.name)}</span>
        <span class="project-dd-count">${p.rooms.length} room${p.rooms.length === 1 ? '' : 's'}</span>
      </button>`;
  }).join('');
  slot.innerHTML = `
    <details class="project-dd">
      <summary class="project-dd-summary">
        <span class="project-name">${escapeHtml(activeName ?? realProjects[0].name)}</span>
        <span class="project-dd-arrow" aria-hidden="true">▾</span>
      </summary>
      <div class="project-dd-menu" role="menu">${itemsHtml}</div>
    </details>
  `;

  // Project switch — load the latest saved room of the picked project
  // into the live scene. We delegate the actual load to RoomLAB by
  // emitting an event panel-room.js listens to (it already owns the
  // load-from-saved-id path). Falls back gracefully when RoomLAB hasn't
  // mounted yet — the event listener simply doesn't exist.
  slot.querySelectorAll('.project-dd-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const projName = btn.dataset.proj;
      const entry = latestRoomInProject(projName);
      if (!entry) return;
      slot.querySelector('details')?.removeAttribute('open');
      emit('project:switch', { projectName: projName, customRoomId: entry.id });
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
