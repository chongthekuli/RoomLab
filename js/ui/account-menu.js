// js/ui/account-menu.js
// ---------------------------------------------------------------------------
// The header user chip + account dropdown. Mounted into the header's
// .header-actions group (after the Print button) by header-nav.js.
//
// The chip shows the signed-in identity (avatar + display name). Clicking it
// opens a native <details> popover — same idiom as the project-name dropdown
// (.project-dd) so it inherits outside-click / Esc / keyboard activation for
// free — with: Profile, Settings, About, ──, Sign out.
//
//   Profile  → Account modal, identity view
//   Settings → Account modal, preferences view (the marketing toggle)
//   About    → About modal
//   Sign out → window.__auralabAuth.signOut()  (auth-gate reloads to login)
//
// Reads the signed-in user from the snapshot auth-gate.js publishes
// (window.__auralabAuth) before it imports main.js, so it's present by the time
// header-nav mounts. If no user is published (e.g. opened outside the auth
// flow), the chip is not rendered.
// ---------------------------------------------------------------------------

import { buildAvatar, displayNameOf } from './avatar.js';
import { openAccountModal } from './account-modal.js';
import { openAboutModal } from './about-modal.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const MENU_HTML = `
  <div class="user-chip-menu" role="menu">
    <button type="button" class="user-chip-item" data-act="profile" role="menuitem">
      <svg class="uc-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="3" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M2.5 14 a5.5 5.5 0 0 1 11 0" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>
      <span>Profile</span>
    </button>
    <button type="button" class="user-chip-item" data-act="settings" role="menuitem">
      <svg class="uc-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.3" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 1.5v2 M8 12.5v2 M1.5 8h2 M12.5 8h2 M3.5 3.5l1.4 1.4 M11.1 11.1l1.4 1.4 M12.5 3.5l-1.4 1.4 M4.9 11.1l-1.4 1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      <span>Settings</span>
    </button>
    <button type="button" class="user-chip-item" data-act="about" role="menuitem">
      <svg class="uc-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 7v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="4.7" r="0.9" fill="currentColor"/></svg>
      <span>About</span>
    </button>
    <div class="user-chip-divider" role="separator"></div>
    <button type="button" class="user-chip-item user-chip-item-signout" data-act="signout" role="menuitem">
      <svg class="uc-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 2.5H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/><path d="M9 5l3 3-3 3 M12 8H6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Sign out</span>
    </button>
  </div>`;

/**
 * Build and mount the user chip into a container (the header .header-actions).
 * No-op (returns null) if no signed-in user has been published.
 * @param {HTMLElement} container
 * @returns {HTMLElement|null} the mounted <details> element, or null
 */
export function mountAccountMenu(container) {
  if (!container) return null;
  const auth = (typeof window !== 'undefined' && window.__auralabAuth) || null;
  const user = auth?.user || null;
  if (!user) return null;

  // Avoid duplicates if header re-mounts — and remove the PREVIOUS instance's
  // document click listener so it doesn't leak (it captures the detached node).
  const prev = container.querySelector('#user-chip-dd');
  if (prev?._onDocClick) document.removeEventListener('click', prev._onDocClick);
  prev?.remove();

  const dd = document.createElement('details');
  dd.className = 'user-chip-dd';
  dd.id = 'user-chip-dd';

  const name = displayNameOf(user);
  dd.innerHTML = `
    <summary class="user-chip" aria-label="Account menu" title="${escapeHtml(name)} — account menu">
      <span class="user-chip-avatar-slot"></span>
      <span class="user-chip-name">${escapeHtml(name)}</span>
      <svg class="user-chip-caret" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1 L5 5 L9 1" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>
    </summary>
    ${MENU_HTML}`;

  // Inject the avatar (JS-built so the photo/initial fallback works).
  dd.querySelector('.user-chip-avatar-slot')?.replaceWith(buildAvatar(user, 'user-chip-avatar'));

  // Sit at the far right of the action group, after the visible buttons but
  // before the hidden file input (so it's the last visible control).
  const fileInput = container.querySelector('input[type="file"]');
  if (fileInput) container.insertBefore(dd, fileInput);
  else container.appendChild(dd);

  // Menu actions. Close the popover first, then act.
  dd.querySelectorAll('.user-chip-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      dd.removeAttribute('open');
      switch (btn.dataset.act) {
        case 'profile':  openAccountModal({ view: 'account' }); break;
        case 'settings': openAccountModal({ view: 'preferences' }); break;
        case 'about':    openAboutModal(); break;
        case 'signout':  auth.signOut?.(); break;
      }
    });
  });

  // Close on outside click (native <details> toggles on summary click but does
  // NOT close on an outside click on its own).
  const onDocClick = (e) => { if (dd.open && !dd.contains(e.target)) dd.removeAttribute('open'); };
  dd._onDocClick = onDocClick;   // so a re-mount can remove it (see dedupe above)
  document.addEventListener('click', onDocClick);

  // Esc closes the popover and returns focus to the chip (native <details>
  // does not handle Esc — that's <dialog>/popover behaviour).
  dd.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dd.open) {
      e.preventDefault();
      dd.removeAttribute('open');
      dd.querySelector('.user-chip')?.focus();
    }
  });

  return dd;
}
