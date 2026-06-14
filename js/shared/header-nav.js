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

import { mountAccountMenu } from '../ui/account-menu.js';

const LABS = [
  { id: 'room',      label: 'AuraLAB',      href: '#/room',      sublabel: 'Acoustic simulator' },
  { id: 'speaker',   label: 'SpeakerLAB',   href: '#/speaker',   sublabel: 'Speaker library' },
  { id: 'device',    label: 'DeviceLAB',    href: '#/device',    sublabel: 'PA equipment' },
  { id: 'surface',   label: 'SurfaceLAB',   href: '#/surface',   sublabel: 'Treatment & finishes' },
  { id: 'wall',      label: 'WallLAB',      href: '#/wall',      sublabel: 'Wall isolation (beta)' },
  { id: 'furniture', label: 'FurnitureLAB', href: '#/furniture', sublabel: 'Room contents (beta)' },
  { id: 'account',   label: 'AccountLAB',   href: '#/account',   sublabel: 'User accounts', adminOnly: true },
];

export function mountHeaderNav({ activeLab } = {}) {
  const header = document.getElementById('app-header');
  if (!header) return;

  const tabs = LABS.map(lab => {
    const isActive = lab.id === activeLab;
    const classes = ['lab-tab'];
    if (isActive) classes.push('active');
    const aria = isActive ? ' aria-current="page"' : '';
    const adminAttr = lab.adminOnly ? ' data-admin-only' : '';
    return `
      <a class="${classes.join(' ')}" data-lab="${lab.id}" href="${lab.href}"${aria}${adminAttr}>
        <span class="lab-tab-label">${lab.label}</span>
        <span class="lab-tab-sub">${lab.sublabel}</span>
      </a>`;
  }).join('');

  header.innerHTML = `
    <div class="app-brand">
      <span class="brand-text">AuraLAB Suite</span>
    </div>
    <nav class="lab-nav" aria-label="Lab navigation">${tabs}</nav>
    <div class="header-actions">
      <button id="btn-reset-data" class="btn-reset" aria-label="Reset all AuraLAB data" title="Reset all AuraLAB data — saved scene, custom rooms, panel state, Lab preferences. Asks for confirmation; cannot be undone.">↻</button>
      <button id="btn-save-project" class="btn-save" title="Save the current scene (room, speakers, listeners, zones, EQ, ambient noise) to your account. It loads automatically next time you sign in. A dot means you have unsaved changes.">💾 Save</button>
      <button id="btn-print-report" class="btn-print" aria-label="print proposal" title="Print a multi-page proposal of the current scene. Use the print dialog's 'Save as PDF' destination on desktop. On mobile: choose 'Save as PDF' (Android) or pinch-and-share-to-Files (iOS).">🖨 Print</button>
    </div>
  `;

  // Reset is a global action — no Lab needs to be mounted for it to
  // work, so we wire it here in the header module rather than in
  // panel-room.js (which only mounts when RoomLAB is visited).
  document.getElementById('btn-reset-data')?.addEventListener('click', resetAllData);

  // User chip + account menu (Profile / Settings / About / Sign out). Reads the
  // signed-in identity auth-gate.js published on window.__auralabAuth before
  // booting; renders nothing if there's no signed-in user.
  mountAccountMenu(header.querySelector('.header-actions'));
  // The header no longer shows the project name (moved into the room panel,
  // below "Custom" — v=833). Projects + rooms are a cloud-backed library now.
}

// Wipe every `roomlab.*` localStorage key and reload. Other site
// data (cookies, unrelated storage from other apps on the same
// origin) is left alone. The confirm() dialog spells out what gets
// cleared so the user can't trip over it accidentally.
function resetAllData() {
  const ok = window.confirm(
    'Reset all AuraLAB data?\n\n' +
    'This permanently deletes:\n' +
    '  • Your current scene (autosaved)\n' +
    '  • All saved custom rooms\n' +
    '  • Sidebar collapse state\n' +
    '  • SpeakerLAB / DeviceLAB preferences\n\n' +
    'Cannot be undone. Save your work first via 💾 Save As if needed.'
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

// (The header project slot + project dropdown were removed at v=833 — the
// projects/rooms library lives in the room panel below "Custom" and is
// cloud-backed. See js/ui/panel-room.js.)
