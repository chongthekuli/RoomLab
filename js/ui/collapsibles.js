// Sidebar accordion — wraps each <section> in #panel-left so its body
// can be collapsed via the heading. Solves the "every panel expanded all
// the time → endless scroll to find a parameter" problem reported by the
// user.
//
// Approach: wrap-after-mount. Each panel's mount function still writes
// `<h2>Title</h2> + body` via innerHTML. After all panels mount, we run
// installCollapsibles() once to:
//   1. Mark the section .panel-collapsible.
//   2. Bind a click handler on the <h2> that toggles .collapsed.
//   3. Wrap every sibling AFTER the heading row into <div class="panel-body">.
// The chevron + collapsed visual treatment are pure CSS (.panel-collapsible
// .panel-body display:none in collapsed state).
//
// Persistence: open/closed state is stored in localStorage keyed by
// section id, so reloads restore the user's mental layout.
//
// Why not refactor each panel to render heading-vs-body separately?
// That's 5 files of churn. The wrap-after-mount survives every observed
// re-render path (panels write to inner divs like #sources-list, never
// the section root after initial mount), so once installed it stays.

import { on } from './events.js';

const STORAGE_KEY = 'roomlab.panel.collapsed';

// Per-section default expansion state. Room + Sources are open because
// they cover ~80% of session-1 work (preset / model / power / position).
// The rest are closed to keep the sidebar within one viewport on boot.
const DEFAULT_EXPANDED = {
  'panel-room':      true,
  'panel-sources':   true,
  'panel-listeners': false,
  'panel-zones':     false,
  'panel-ambient':   false,
  'panel-library':   false,
};

function readState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}
function writeState(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
  catch { /* private mode — silently ignore */ }
}

function isExpanded(id, persisted) {
  if (id in persisted) return !!persisted[id];
  return DEFAULT_EXPANDED[id] ?? true;
}

// Find the first <h2> in the section. Its parent (if it's wrapped, e.g.
// panel-room's `<div class="room-head"><h2>Room</h2><buttons/></div>`)
// is the heading row; all subsequent siblings of that heading row are
// the body. Returns { headRow, headH2 } or null if no h2 found.
function locateHeading(section) {
  const h2 = section.querySelector(':scope > h2, :scope > * > h2');
  if (!h2) return null;
  const headRow = h2.parentElement === section ? h2 : h2.parentElement;
  return { headRow, headH2: h2 };
}

function wrapSection(section, persisted) {
  if (section.classList.contains('panel-collapsible')) return false;   // idempotent
  const located = locateHeading(section);
  if (!located) return false;
  const { headRow, headH2 } = located;

  section.classList.add('panel-collapsible');

  // Sweep every node AFTER the heading row into a panel-body wrapper.
  const body = document.createElement('div');
  body.className = 'panel-body';
  body.id = `${section.id}-body`;
  let cursor = headRow.nextSibling;
  while (cursor) {
    const next = cursor.nextSibling;
    body.appendChild(cursor);
    cursor = next;
  }
  section.appendChild(body);

  // Apply persisted (or default) state.
  const expanded = isExpanded(section.id, persisted);
  section.classList.toggle('collapsed', !expanded);

  // Click on the h2 toggles. We bind on the H2 itself, not the heading
  // row — the room-head row also contains action buttons (Save / Load /
  // Share / Print) whose own click handlers must not be hijacked.
  headH2.classList.add('panel-toggle-h2');
  headH2.setAttribute('role', 'button');
  headH2.setAttribute('tabindex', '0');
  headH2.setAttribute('aria-controls', body.id);
  headH2.setAttribute('aria-expanded', String(expanded));
  headH2.style.cursor = 'pointer';

  const toggle = () => {
    const nowCollapsed = !section.classList.contains('collapsed');
    section.classList.toggle('collapsed', nowCollapsed);
    headH2.setAttribute('aria-expanded', String(!nowCollapsed));
    const s = readState();
    s[section.id] = !nowCollapsed;   // store EXPANDED state
    writeState(s);
  };

  headH2.addEventListener('click', toggle);
  headH2.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  return true;
}

export function installCollapsibles() {
  const persisted = readState();
  const sections = document.querySelectorAll('#panel-left > section');
  for (const section of sections) wrapSection(section, persisted);
}

// Public re-entry — call this if a panel ever does outer innerHTML
// re-mount (none currently do, but keeps the contract robust). The
// install pass is idempotent so calling it repeatedly is safe.
export function reinstallCollapsibles() {
  installCollapsibles();
}

// Auto-rebind on scene:reset as a safety net — none of the current
// panels blow away their root innerHTML on reset, but if that ever
// changes the wrapping is restored cheaply.
on('scene:reset', () => reinstallCollapsibles());
