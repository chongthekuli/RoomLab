// js/labs/accountlab/main.js
// ---------------------------------------------------------------------------
// AccountLAB — admin-only user-account console (Phase 3, read-only MVP).
// Lazy-mounted by the SPA router on the first #/account visit; the router guards
// the route for non-admins and the header tab is data-admin-only.
//
// Reads every account document (Firestore rules only permit this for an admin)
// and renders a monitor table sorted by last-active, with tier + status + the
// profile fields. Click a row to expand its full detail.
//
// Scope today: READ-ONLY. The per-account activity graph needs the activity
// subcollection (Phase 2); admin actions — suspend / resume / change tier —
// land in Phase 4. Both are flagged in the UI so it doesn't read as finished.
// ---------------------------------------------------------------------------

import { listAccounts, listRoomsForUser } from '../../auth/firebase-db.js';
import { buildAvatar, displayNameOf } from '../../ui/avatar.js';
import { tierLabel, isValidTier } from '../../auth/account-tier.js';
import { isAdminEmail } from '../../auth/admin.js';
import { requestAdminView } from '../../state/admin-view.js';
import { isDirty } from '../../state/scene-dirty.js';

// The EFFECTIVE account level shown to the admin — matches the Profile's
// "Account level" resolution: an admin email resolves to 'admin' (a role
// overlay), everyone else shows their stored plan (free/pro/max). The doc's
// `tier` field stays 'free' for admins by design (admin is a role, not a plan,
// and the rules force tier:'free' at creation).
function effectiveTier(a) {
  if (isAdminEmail(a.email)) return 'admin';
  return isValidTier(a.tier) ? a.tier : 'free';
}

let _mounted = false;

export async function mountAccountLab() {
  if (_mounted) return;
  _mounted = true;
  const root = document.getElementById('accountlab-root');
  if (!root) return;
  root.innerHTML = shellHtml();
  document.getElementById('al-refresh')?.addEventListener('click', () => loadAndRender(root));
  await loadAndRender(root);
}

function shellHtml() {
  return `
    <header class="al-header">
      <div class="al-head-text">
        <h1 class="al-title">AccountLAB</h1>
        <p class="al-tagline">All AuraLAB accounts — last active, plan, and status. Admin only.</p>
      </div>
      <div class="al-head-actions">
        <div class="al-stats" id="al-stats"></div>
        <button type="button" id="al-refresh" class="al-refresh" title="Reload from the database">↻ Refresh</button>
      </div>
    </header>
    <div class="al-body" id="al-body"><div class="al-loading">Loading accounts…</div></div>`;
}

async function loadAndRender(root) {
  const body = root.querySelector('#al-body');
  const stats = root.querySelector('#al-stats');
  if (body) body.innerHTML = '<div class="al-loading">Loading accounts…</div>';
  let accounts;
  try {
    accounts = await listAccounts(500);
  } catch (e) {
    if (stats) stats.innerHTML = '';
    if (body) {
      const denied = e?.code === 'permission-denied';
      body.innerHTML = `<div class="al-error">${escapeHtml(
        denied
          ? 'Permission denied reading accounts. Confirm your email is in the admin list in firestore.rules and that the rules are published.'
          : 'Couldn’t load accounts. Check Firestore is enabled and you’re online, then Refresh.'
      )}</div>`;
    }
    return;
  }
  if (stats) stats.innerHTML = statsHtml(accounts);
  if (body) renderTable(body, accounts);
}

function statsHtml(accounts) {
  const now = Date.now();
  const WEEK = 7 * 24 * 3600 * 1000;
  const active7 = accounts.filter((a) => {
    const t = toDate(a.lastActiveAt);
    return t && (now - t.getTime()) < WEEK;
  }).length;
  const suspended = accounts.filter((a) => a.status === 'suspended').length;
  const deleted = accounts.filter((a) => a.status === 'deleted').length;
  return `
    <span class="al-stat"><strong>${accounts.length}</strong> account${accounts.length === 1 ? '' : 's'}</span>
    <span class="al-stat"><strong>${active7}</strong> active this week</span>
    ${suspended ? `<span class="al-stat al-stat-warn"><strong>${suspended}</strong> suspended</span>` : ''}
    ${deleted ? `<span class="al-stat"><strong>${deleted}</strong> deleted</span>` : ''}`;
}

function renderTable(body, accounts) {
  if (!accounts.length) {
    body.innerHTML = '<div class="al-empty">No accounts yet.</div>';
    return;
  }
  const rows = accounts.map((a, i) => accountRowHtml(a, i)).join('');
  body.innerHTML = `
    <table class="al-table">
      <thead>
        <tr>
          <th>Account</th><th>Company</th><th>Level</th><th>Status</th><th class="al-num">Last active</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="al-foot-note">Activity graph (per-account session history) arrives with activity tracking; suspend / resume / change-plan controls arrive in the next phase.</p>`;

  // Inject avatars (JS-built so the photo/initial fallback works) + wire row expand.
  accounts.forEach((a, i) => {
    const slot = body.querySelector(`#al-av-${i}`);
    if (slot) slot.replaceWith(buildAvatar(a, 'al-avatar'));
    const row = body.querySelector(`#al-row-${i}`);
    const detail = body.querySelector(`#al-detail-${i}`);
    row?.addEventListener('click', () => {
      const open = detail.hasAttribute('hidden');
      if (open) detail.removeAttribute('hidden'); else detail.setAttribute('hidden', '');
      row.classList.toggle('is-open', open);
      row.setAttribute('aria-expanded', String(open));
      // Lazy-load the user's saved room library on first expand (one Firestore
      // read per user, only when an admin actually looks — keeps the table cheap).
      if (open) loadSavedWork(i, a);
    });
  });
}

// Fetch + render a user's saved room library inside their expanded detail row.
// Cached: re-expanding doesn't re-fetch (data-loaded flag).
async function loadSavedWork(i, account) {
  const host = document.getElementById(`al-saved-${i}`);
  if (!host || host.dataset.loaded === '1') return;
  host.dataset.loaded = '1';
  host.innerHTML = `<div class="srt-head"><span class="srt-title">Saved work</span></div>`
                 + `<div class="srt-empty">Loading saved rooms…</div>`;
  let rooms;
  try {
    rooms = await listRoomsForUser(account.uid);
  } catch (e) {
    host.dataset.loaded = '0';   // allow a retry by re-expanding
    const denied = e?.code === 'permission-denied';
    host.innerHTML = `<div class="srt-head"><span class="srt-title">Saved work</span></div>`
      + `<div class="srt-empty srt-error">${escapeHtml(denied
          ? 'Couldn’t load this user’s rooms — your admin access may have expired. Reload AuraLAB.'
          : 'Couldn’t load this user’s rooms. Check your connection and re-open the row.')}</div>`;
    return;
  }
  renderSavedWork(host, rooms, account);
}

// Group → sort → render the saved-work tree (reuses the .srt-* grammar), with a
// [View] button per room that opens it read-only in RoomLAB.
function renderSavedWork(host, rooms, account) {
  const list = Array.isArray(rooms) ? rooms : [];
  if (!list.length) {
    host.innerHTML = `<div class="srt-head"><span class="srt-title">Saved work</span></div>`
      + `<div class="srt-empty">No saved rooms. This user hasn’t saved any work yet.</div>`;
    return;
  }
  // Group by project; (Unfiled) bucket last; rooms newest-first within a project.
  const byProj = new Map();
  for (const r of list) {
    const key = (typeof r.projectName === 'string' && r.projectName.trim()) ? r.projectName.trim() : '(Unfiled)';
    if (!byProj.has(key)) byProj.set(key, []);
    byProj.get(key).push(r);
  }
  const projects = [...byProj.entries()]
    .map(([name, rs]) => ({ name, rooms: rs.slice().sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? '')) }))
    .sort((a, b) => (a.name === '(Unfiled)') - (b.name === '(Unfiled)') || a.name.localeCompare(b.name));
  const total = list.length;
  const multiProj = projects.length > 1;
  const count = multiProj ? `${total} rooms · ${projects.length} projects` : `${total} room${total === 1 ? '' : 's'}`;

  let html = `<div class="srt-head"><span class="srt-title">Saved work</span><span class="srt-count">${escapeHtml(count)}</span></div>`;
  for (const proj of projects) {
    if (multiProj) {
      const unf = proj.name === '(Unfiled)';
      html += `<div class="al-saved-proj-head${unf ? ' unfiled' : ''}">${escapeHtml(proj.name)}</div>`;
    }
    for (const r of proj.rooms) {
      const s = summarizeScene(r.scene);
      const meta = [s.size, `${s.ns} source${s.ns === 1 ? '' : 's'}`, `${s.nl} listener${s.nl === 1 ? '' : 's'}`]
        .filter(Boolean).join(' · ');
      html += `
        <div class="al-saved-room" data-room-id="${escapeHtml(r.id)}">
          <span class="srt-glyph">◧</span>
          <span class="al-saved-name" title="${escapeHtml(r.roomName || 'Untitled')}">${escapeHtml(r.roomName || 'Untitled')}</span>
          <span class="al-saved-meta">${escapeHtml(meta)}</span>
          <span class="al-saved-date al-num">${escapeHtml(relativeTime(r.savedAt))}</span>
          <button class="al-saved-view" type="button"
                  title="Open this room read-only in the editor. Your own scene is kept and restored when you exit.">View</button>
        </div>`;
    }
  }
  host.innerHTML = html;

  // Wire [View]: confirm if the admin has unsaved work, then hand off to RoomLAB.
  const roomById = new Map(list.map((r) => [r.id, r]));
  host.querySelectorAll('.al-saved-view').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();   // don't toggle the row's expand
      const id = btn.closest('.al-saved-room')?.dataset.roomId;
      const room = id && roomById.get(id);
      if (!room) return;
      if (isDirty() && !window.confirm(
        'You have unsaved changes in your own scene. Viewing this room sets them aside and restores them when you exit. Continue?')) return;
      requestAdminView({
        viewedUid: account.uid,
        viewedEmail: account.email || '',
        viewedRoomName: room.roomName || 'room',
        scene: room.scene,
      });
      window.location.hash = '#/room';
    });
  });
}

// Lazy per-room scene summary (only computed when a row is expanded). Guards the
// optional chains so a partial/old blob renders 0s instead of crashing the cell.
function summarizeScene(scene) {
  const r = (scene && scene.room) || {};
  const w = Math.round(Number(r.width_m) || 0);
  const d = Math.round(Number(r.depth_m) || 0);
  return {
    size: (w && d) ? `${w}×${d} m` : '',
    ns: scene?.sources?.length ?? 0,
    nl: scene?.listeners?.length ?? 0,
  };
}

const STATUS_LABELS = { active: 'Active', suspended: 'Suspended', deleted: 'Deleted' };

function accountRowHtml(a, i) {
  const name = displayNameOf(a);
  const tier = effectiveTier(a);
  const status = (a.status === 'suspended' || a.status === 'deleted') ? a.status : 'active';
  const rowCls = 'al-row' + (status === 'deleted' ? ' al-row-deleted' : '');
  const deletedDetail = a.deletedAt
    ? `<div><dt>Deleted</dt><dd>${escapeHtml(formatDate(a.deletedAt))}</dd></div>`
    : '';
  return `
    <tr class="${rowCls}" id="al-row-${i}" tabindex="0" role="button" aria-expanded="false">
      <td class="al-acct">
        <span id="al-av-${i}"></span>
        <span class="al-acct-text">
          <span class="al-name">${escapeHtml(name)}</span>
          <span class="al-email">${escapeHtml(a.email || '')}</span>
        </span>
      </td>
      <td>${escapeHtml(a.company) || '<span class="al-dash">—</span>'}</td>
      <td><span class="al-pill al-tier-${escapeHtml(tier)}">${escapeHtml(tierLabel(tier))}</span></td>
      <td><span class="al-pill al-status-${status}">${STATUS_LABELS[status]}</span></td>
      <td class="al-num">${escapeHtml(relativeTime(a.lastActiveAt))}</td>
    </tr>
    <tr class="al-detail-row" id="al-detail-${i}" hidden>
      <td colspan="5">
        <dl class="al-detail">
          <div><dt>Position</dt><dd>${escapeHtml(a.position) || '—'}</dd></div>
          <div><dt>Contact</dt><dd>${escapeHtml(a.contactNumber) || '—'}</dd></div>
          <div><dt>Profile complete</dt><dd>${a.profileComplete ? 'Yes' : 'No'}</dd></div>
          <div><dt>Created</dt><dd>${escapeHtml(formatDate(a.createdAt))}</dd></div>
          <div><dt>Last sign-in</dt><dd>${escapeHtml(formatDate(a.lastActiveAt))}</dd></div>
          ${deletedDetail}
          <div><dt>UID</dt><dd class="al-uid">${escapeHtml(a.uid || '')}</dd></div>
        </dl>
        <section class="al-saved" id="al-saved-${i}" data-loaded="0" aria-label="Saved work"></section>
      </td>
    </tr>`;
}

// ---- helpers ---------------------------------------------------------------

function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') { try { return ts.toDate(); } catch (_) { return null; } }
  if (ts instanceof Date) return ts;
  return null;
}

function relativeTime(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(ts);
}

function formatDate(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
