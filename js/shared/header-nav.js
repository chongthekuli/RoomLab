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
import { on } from './events.js';

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
      <span class="project-name" id="header-project-name" hidden></span>
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

  syncProjectName();
  on('scene:reset', syncProjectName);
  on('room:changed', syncProjectName);
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

function syncProjectName() {
  const el = document.getElementById('header-project-name');
  if (!el) return;
  const name = (typeof state.projectName === 'string' && state.projectName.trim())
    ? state.projectName.trim()
    : null;
  if (name) {
    el.textContent = name;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}
