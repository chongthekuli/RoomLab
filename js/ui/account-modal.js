// js/ui/account-modal.js
// ---------------------------------------------------------------------------
// The Account modal, opened from the header user menu. Two views switched by a
// segmented tab control:
//   • Account     — identity (avatar / name / email), sign-in method, and a
//                   read-only summary of this session's Terms acceptance.
//   • Preferences — the optional marketing-consent toggle. Per-user, persisted,
//                   DEFAULTS ON, withdrawable anytime (js/shared/user-prefs.js).
//
// "Profile" in the menu opens view:'account'; "Settings" opens
// view:'preferences'. Both are the same modal.
//
// This view never rewrites the legal acceptance attestation — it only READS the
// session record (terms-record.js) for display. The marketing toggle writes the
// separate per-user preference (user-prefs.js). See user-prefs.js header for why
// those are deliberately distinct.
// ---------------------------------------------------------------------------

import { openModal } from './modal-shell.js';
import { buildAvatar, displayNameOf } from './avatar.js';
import { getAcceptanceRecord } from '../shared/terms-record.js';
import {
  getMarketingConsent, setMarketingConsent,
  MARKETING_OPT_OUT_MSG, MARKETING_OPT_IN_MSG,
} from '../shared/user-prefs.js';
import { tierLabel } from '../auth/account-tier.js';
import { fetchAccount, saveProfileFields } from '../auth/firebase-db.js';
import { validateProfileGroup, validateProfileField, PROFILE_FIELDS } from '../auth/profile-fields.js';

// Single-line literal on purpose — kept verbatim-identical to the sign-in
// Terms consent string (index.html) and grep-pinned by tests/account-menu.test.mjs.
const MARKETING_LABEL = 'I agree to receive product and promotional information from AuraLAB and its hardware manufacturer partners, and for my contact details to be shared with those partners for this purpose.';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Sign-in method → human label + a small monochrome glyph.
function providerInfo(providerId) {
  if (providerId === 'google.com') {
    return {
      label: 'Google',
      glyph: '<svg class="acct-provider-glyph" viewBox="0 0 16 16" aria-hidden="true">' +
        '<path d="M15.2 8.18c0-.57-.05-1.12-.15-1.64H8v3.1h4.05a3.46 3.46 0 0 1-1.5 2.27v1.89h2.43c1.42-1.31 2.24-3.24 2.24-5.62z" fill="currentColor"/>' +
        '<path d="M8 15.5c2.03 0 3.73-.67 4.98-1.82l-2.43-1.89c-.67.45-1.54.72-2.55.72-1.96 0-3.62-1.32-4.21-3.1H1.27v1.95A7.5 7.5 0 0 0 8 15.5z" fill="currentColor" opacity="0.75"/>' +
        '<path d="M3.79 9.41a4.5 4.5 0 0 1 0-2.87V4.59H1.27a7.5 7.5 0 0 0 0 6.77z" fill="currentColor" opacity="0.5"/>' +
        '<path d="M8 3.44c1.1 0 2.09.38 2.87 1.13l2.15-2.15A7.5 7.5 0 0 0 8 .5 7.5 7.5 0 0 0 1.27 4.59l2.52 1.95C4.38 4.76 6.04 3.44 8 3.44z" fill="currentColor" opacity="0.9"/>' +
        '</svg>',
    };
  }
  if (providerId === 'password') {
    return {
      label: 'Email & password',
      glyph: '<svg class="acct-provider-glyph" viewBox="0 0 16 16" aria-hidden="true">' +
        '<circle cx="5" cy="8" r="3" stroke="currentColor" stroke-width="1.3" fill="none"/>' +
        '<path d="M7.8 8H14 M12 8v2.2 M14 8v2.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
        '</svg>',
    };
  }
  return { label: providerId || 'Account', glyph: '' };
}

// Build the read-only Terms-acceptance rows from the session record, or a
// benign empty state if none was captured this session.
function acceptanceRowsHtml() {
  const rec = getAcceptanceRecord();
  if (!rec) {
    return '<dl class="acct-rows acct-rows-mono"><div class="acct-row">' +
      '<dd class="acct-empty">No acceptance recorded this session.</dd></div></dl>';
  }
  const rows = [
    ['Accepted',  rec.acceptedAt],
    ['Device',    rec.browser],
    ['Timezone',  rec.timezone],
    ['Public IP', rec.publicIp],
  ].filter(([, v]) => v != null && String(v).trim() !== '');
  const body = rows.map(([k, v]) =>
    `<div class="acct-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`
  ).join('');
  return `<dl class="acct-rows acct-rows-mono">${body}</dl>`;
}

// A compact one-row strip of all account levels with the user's current level
// highlighted (tinted + bordered in its tier hue — no label needed). Colours run
// cheapest → premium (Free grey → Pro blue → Max gold) so hue alone signals
// value; Admin (violet) is the operator role, shown only to admins. Customers
// see the three plans; an admin also sees the Admin pill (their own level).
function tierStripHtml(currentTier) {
  const order = ['free', 'pro', 'max', 'admin'];
  const tiers = order.filter((t) => t !== 'admin' || currentTier === 'admin');
  const items = tiers.map((t) => {
    const cur = t === currentTier;
    return `<span class="tier-pill tier-pill-${t}${cur ? ' is-current' : ''}"${cur ? ' aria-current="true"' : ''} role="listitem">` +
      `<span class="tier-pill-dot" aria-hidden="true"></span>${escapeHtml(tierLabel(t))}</span>`;
  }).join('');
  return `<div class="tier-strip" role="list" aria-label="Account level">${items}</div>`;
}

function buildBodyHtml(user) {
  const prov = providerInfo(user.providerId);
  const name = displayNameOf(user);
  const tier = user.tier || 'free';
  return `
    <div class="acct-modal">
      <header class="acct-head">
        <h2 class="app-modal-title" id="acct-title">Account</h2>
      </header>

      <div class="seg-tabs" role="tablist" aria-label="Account views">
        <button type="button" class="seg-tab" role="tab" id="seg-account"
                aria-selected="true"  aria-controls="view-account" data-view="account">Account</button>
        <button type="button" class="seg-tab" role="tab" id="seg-prefs"
                aria-selected="false" aria-controls="view-prefs"   data-view="preferences">Preferences</button>
      </div>

      <section class="acct-view" id="view-account" role="tabpanel" aria-labelledby="seg-account">
        <div class="acct-identity">
          <span class="acct-avatar-slot"></span>
          <div class="acct-identity-text">
            <div class="acct-name">${escapeHtml(name)}</div>
            <div class="acct-email">${escapeHtml(user.email || '')}</div>
          </div>
        </div>

        <dl class="acct-rows">
          <div class="acct-row">
            <dt>Sign-in method</dt>
            <dd class="acct-provider">${prov.glyph}${escapeHtml(prov.label)}</dd>
          </div>
        </dl>

        <div class="acct-subhead-row">
          <h3 class="acct-subhead">Profile</h3>
          <button type="button" class="acct-edit-btn" id="acct-profile-edit">Edit</button>
        </div>
        <div id="acct-profile-body">
          <dl class="acct-rows">
            <div class="acct-row"><dt>Company</dt><dd id="acct-company" class="acct-loading">Loading…</dd></div>
            <div class="acct-row"><dt>Position</dt><dd id="acct-position" class="acct-loading">Loading…</dd></div>
            <div class="acct-row"><dt>Contact number</dt><dd id="acct-contactNumber" class="acct-loading">Loading…</dd></div>
          </dl>
        </div>
        <p class="pref-toast" id="acct-profile-msg" role="status" aria-live="polite" hidden></p>

        <h3 class="acct-subhead">Account level</h3>
        ${tierStripHtml(tier)}

        <h3 class="acct-subhead">Terms acceptance — this session</h3>
        ${acceptanceRowsHtml()}
        <p class="acct-note">This acknowledgement is referenced on the methodology page of every PDF report generated in this session.</p>

        <div class="acct-danger" data-provider="${escapeHtml(user.providerId || '')}">
          <h3 class="acct-subhead acct-subhead-danger">Delete account</h3>
          <div id="acct-danger-intro">
            <p class="acct-danger-note">Closing your account ends your access and signs you out. The operator keeps a record of the closure. Your access cannot be restored.</p>
            <div class="acct-danger-actions">
              <button type="button" class="acct-btn-danger-ghost" id="acct-delete-start" aria-expanded="false" aria-controls="acct-delete-confirm">Delete account</button>
            </div>
          </div>
          <div class="acct-danger-confirm" id="acct-delete-confirm" hidden>
            <p class="acct-danger-warn" id="acct-delete-warn" role="alert">This closes your account and signs you out immediately. Your access cannot be restored. The operator keeps a record that the account existed and the date it was deleted.</p>
            <div class="acct-reauth" id="acct-reauth" hidden>
              <div class="acct-reauth-head">
                <svg class="acct-reauth-lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>
                <span class="acct-reauth-title">Confirm it's you</span>
              </div>
              <label class="acct-edit-label acct-reauth-pw" id="acct-reauth-pw" hidden>
                <span>Re-enter your password to continue.</span>
                <input type="password" id="acct-reauth-password" name="reauth-password" autocomplete="current-password" autocapitalize="off" spellcheck="false" aria-describedby="acct-reauth-err" />
                <span class="acct-field-err" id="acct-reauth-err" role="alert" hidden></span>
              </label>
              <div class="acct-reauth-google" id="acct-reauth-google" hidden>
                <p class="acct-reauth-help">Confirm with Google to continue.</p>
              </div>
            </div>
            <p class="acct-danger-error" id="acct-delete-error" role="alert" hidden></p>
            <div class="acct-danger-actions">
              <button type="button" class="acct-btn-ghost" id="acct-delete-cancel">Cancel</button>
              <button type="button" class="acct-btn-danger" id="acct-delete-confirm-btn">Delete account permanently</button>
            </div>
          </div>
        </div>
      </section>

      <section class="acct-view" id="view-prefs" role="tabpanel" aria-labelledby="seg-prefs" hidden>
        <div class="pref-row">
          <label class="switch">
            <input type="checkbox" id="pref-marketing-consent" class="switch-input" />
            <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
          </label>
          <div class="pref-copy">
            <label for="pref-marketing-consent" class="pref-label">${escapeHtml(MARKETING_LABEL)}</label>
            <p class="pref-help">Saved to your account. Change it here anytime.</p>
          </div>
        </div>
        <p class="pref-toast" id="pref-marketing-msg" role="status" aria-live="polite" hidden></p>
      </section>
    </div>`;
}

/**
 * Open the Account modal.
 * @param {object} [opts]
 * @param {'account'|'preferences'} [opts.view='account'] which view to land on.
 */
export function openAccountModal({ view = 'account' } = {}) {
  const user = (typeof window !== 'undefined' && window.__auralabAuth?.user) || null;
  if (!user) { console.warn('[account-modal] no signed-in user; nothing to show'); return; }

  openModal({
    id: 'account-modal-scrim',
    ariaLabel: 'Account',
    className: 'account-modal-card',
    bodyHtml: buildBodyHtml(user),
    onMount: ({ card, close }) => {
      // Inject the large avatar (built in JS so the photo/initial fallback works).
      card.querySelector('.acct-avatar-slot')?.replaceWith(buildAvatar(user, 'acct-avatar'));

      const tabs = [...card.querySelectorAll('.seg-tab')];
      const viewAccount = card.querySelector('#view-account');
      const viewPrefs = card.querySelector('#view-prefs');
      const title = card.querySelector('#acct-title');

      const show = (v) => {
        tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === v)));
        viewAccount.hidden = v !== 'account';
        viewPrefs.hidden = v !== 'preferences';
        title.textContent = v === 'preferences' ? 'Preferences' : 'Account';
      };

      tabs.forEach((t) => t.addEventListener('click', () => { show(t.dataset.view); t.focus(); }));
      // Arrow-key roving between tabs (WAI-ARIA tabs pattern).
      tabs.forEach((t, i) => t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const next = tabs[(i + dir + tabs.length) % tabs.length];
        next.focus(); next.click();
      }));

      // Consent toggle — the GETTER is the source of truth (defaults ON when
      // never set). The painted markup carries no `checked` attribute on
      // purpose so a getter that ever returns false can't be masked by the DOM.
      const cb = card.querySelector('#pref-marketing-consent');
      cb.checked = getMarketingConsent(user.uid);
      const prefMsg = card.querySelector('#pref-marketing-msg');
      let prefMsgTimer = null;
      cb.addEventListener('change', () => {
        setMarketingConsent(cb.checked, user.uid);
        // Brief (~5s) confirmation — opt-out gets the graceful copy, opt-in a
        // simple ack (Carmen / market-strategist).
        if (prefMsg) {
          prefMsg.textContent = cb.checked ? MARKETING_OPT_IN_MSG : MARKETING_OPT_OUT_MSG;
          prefMsg.hidden = false;
          clearTimeout(prefMsgTimer);
          prefMsgTimer = setTimeout(() => { prefMsg.hidden = true; }, 5000);
        }
      });

      wireProfileEditor(card, user);
      wireDeleteAccount(card, user, close);

      show(view);
      // Land focus on content (the active tab), not the X exit button.
      card.querySelector(`.seg-tab[data-view="${view}"]`)?.focus();
    },
  });
}

// Profile subsection: load the current values from Firestore, then offer an
// Edit → Save/Cancel toggle. Save writes via saveProfileFields (owner-only,
// rules-gated) and confirms with the shared ~5s pref-toast.
function wireProfileEditor(card, user) {
  const body = card.querySelector('#acct-profile-body');
  const editBtn = card.querySelector('#acct-profile-edit');
  const msg = card.querySelector('#acct-profile-msg');
  if (!body || !editBtn) return;

  let profile = { company: '', position: '', contactNumber: '' };
  let msgTimer = null;

  const toast = (text) => {
    if (!msg) return;
    msg.textContent = text;
    msg.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { msg.hidden = true; }, 5000);
  };

  const ROWS = [['company', 'Company'], ['position', 'Position'], ['contactNumber', 'Contact number']];

  const renderRead = () => {
    body.innerHTML = `<dl class="acct-rows">${ROWS.map(([k, label]) =>
      `<div class="acct-row"><dt>${label}</dt><dd>${escapeHtml(profile[k]) || '—'}</dd></div>`
    ).join('')}</dl>`;
    editBtn.hidden = false;
  };

  const fieldHtml = ([k, label]) => {
    const isTel = k === 'contactNumber';
    const max = k === 'company' ? 120 : (k === 'position' ? 80 : 32);
    return `<label class="acct-edit-label"><span>${label}</span>
      <input type="${isTel ? 'tel' : 'text'}"${isTel ? ' inputmode="tel"' : ''} id="acct-edit-${k}" name="${k}"
             maxlength="${max}" value="${escapeHtml(profile[k])}" aria-describedby="acct-edit-${k}-err" />
      <span class="acct-field-err" id="acct-edit-${k}-err" role="alert" hidden></span>
    </label>`;
  };

  const fieldError = (k) => {
    const el = body.querySelector(`#acct-edit-${k}`);
    if (!el) return;
    const err = validateProfileField(k, el.value);
    const errEl = body.querySelector(`#acct-edit-${k}-err`);
    el.classList.toggle('is-invalid', !!err);
    if (errEl) { errEl.textContent = err || ''; errEl.hidden = !err; }
  };

  const enterEdit = () => {
    editBtn.hidden = true;
    body.innerHTML = `<div class="acct-profile-form" data-profile-group>
      ${ROWS.map(fieldHtml).join('')}
      <div class="acct-edit-actions">
        <button type="button" class="acct-btn-ghost" id="acct-profile-cancel">Cancel</button>
        <button type="button" class="acct-btn-primary" id="acct-profile-save">Save</button>
      </div>
    </div>`;
    body.querySelectorAll('[data-profile-group] input').forEach((el) => {
      el.addEventListener('blur', () => fieldError(el.name));
      el.addEventListener('input', () => { if (el.classList.contains('is-invalid')) fieldError(el.name); });
    });
    body.querySelector('#acct-profile-cancel').addEventListener('click', renderRead);
    body.querySelector('#acct-profile-save').addEventListener('click', onSave);
    body.querySelector('#acct-edit-company')?.focus();
  };

  const onSave = async () => {
    const { ok, values } = validateProfileGroup((n) => body.querySelector(`#acct-edit-${n}`)?.value);
    if (!ok) { ROWS.forEach(([k]) => fieldError(k)); return; }
    const saveBtn = body.querySelector('#acct-profile-save');
    if (saveBtn) saveBtn.disabled = true;
    const saved = await saveProfileFields(user.uid, values);
    if (saved) {
      profile = values;
      renderRead();
      toast('Profile updated.');
    } else {
      if (saveBtn) saveBtn.disabled = false;
      toast('Couldn’t save — check your connection and try again.');
    }
  };

  editBtn.addEventListener('click', enterEdit);

  // Load current values; on failure leave the "Loading…" rows replaced by dashes.
  // Bail if the modal was closed before the read resolves (don't render into a
  // detached card).
  fetchAccount(user.uid).then((acc) => {
    if (!body.isConnected) return;
    if (acc) {
      profile = {
        company: acc.company || '',
        position: acc.position || '',
        contactNumber: acc.contactNumber || '',
      };
    }
    renderRead();
  }).catch(() => { if (body.isConnected) renderRead(); });
}

// Danger zone: self-service account deletion. Inline two-step (calm button →
// red confirm block with a security re-auth checkpoint → destructive final
// button). Delegates the Firebase work to the published auth thunks
// (reauthenticate / deleteAccount) — the SDK stays encapsulated in auth-gate.
function wireDeleteAccount(card, user, close) {
  const zone = card.querySelector('.acct-danger');
  if (!zone) return;
  const intro = card.querySelector('#acct-danger-intro');
  const startBtn = card.querySelector('#acct-delete-start');
  const confirmEl = card.querySelector('#acct-delete-confirm');
  const cancelBtn = card.querySelector('#acct-delete-cancel');
  const finalBtn = card.querySelector('#acct-delete-confirm-btn');
  const reauth = card.querySelector('#acct-reauth');
  const pwWrap = card.querySelector('#acct-reauth-pw');
  const pwInput = card.querySelector('#acct-reauth-password');
  const pwErr = card.querySelector('#acct-reauth-err');
  const googleWrap = card.querySelector('#acct-reauth-google');
  const errBanner = card.querySelector('#acct-delete-error');
  const warn = card.querySelector('#acct-delete-warn');
  const isPassword = user.providerId !== 'google.com';

  let reauthShown = false;
  let busy = false;

  const showErr = (t) => { errBanner.textContent = t; errBanner.hidden = false; };
  const clearErr = () => { errBanner.hidden = true; errBanner.textContent = ''; };
  const updateFinalDisabled = () => {
    finalBtn.disabled = busy || (isPassword && reauthShown && !pwInput.value.trim());
  };
  const setBusy = (b) => {
    busy = b;
    finalBtn.textContent = b ? 'Deleting…' : 'Delete account permanently';
    cancelBtn.disabled = b;
    if (pwInput) pwInput.disabled = b;
    updateFinalDisabled();
  };

  const revealReauth = (message) => {
    reauth.hidden = false;
    reauthShown = true;
    if (isPassword) {
      pwWrap.hidden = false;
      if (message && pwErr) { pwErr.textContent = message; pwErr.hidden = false; }
      pwInput.focus();
    } else {
      googleWrap.hidden = false;
      if (message) showErr(message);
    }
    updateFinalDisabled();
  };

  const collapse = () => {
    confirmEl.hidden = true;
    intro.hidden = false;
    startBtn.setAttribute('aria-expanded', 'false');
    reauth.hidden = true; reauthShown = false;
    if (pwWrap) pwWrap.hidden = true;
    if (googleWrap) googleWrap.hidden = true;
    if (pwInput) { pwInput.value = ''; pwInput.disabled = false; pwInput.classList.remove('is-invalid'); }
    if (pwErr) pwErr.hidden = true;
    clearErr();
    setBusy(false);
    startBtn.focus();
  };

  const expand = () => {
    intro.hidden = true;
    confirmEl.hidden = false;
    startBtn.setAttribute('aria-expanded', 'true');
    clearErr();
    // Password accounts see the re-auth checkpoint up-front (honest + gates the
    // destructive button on a typed password). Google re-auth is a popup
    // summoned only on the final click.
    if (isPassword) revealReauth();
    updateFinalDisabled();
    warn.setAttribute('tabindex', '-1');
    warn.focus();   // SR users hear the stakes before reaching the destructive button
  };

  startBtn.addEventListener('click', expand);
  cancelBtn.addEventListener('click', collapse);
  // Esc inside an open confirm collapses to the calm state — it does NOT close
  // the whole Account modal mid-deletion.
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !confirmEl.hidden) { e.stopPropagation(); e.preventDefault(); collapse(); }
  });
  if (pwInput) {
    pwInput.addEventListener('input', () => {
      pwErr.hidden = true; pwInput.classList.remove('is-invalid');
      updateFinalDisabled();
    });
    pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !finalBtn.disabled) onDelete(); });
  }
  finalBtn.addEventListener('click', onDelete);

  async function onDelete() {
    if (busy) return;
    clearErr();
    setBusy(true);
    try {
      // Security checkpoint, then the closure. Both delegate to auth-gate thunks.
      await window.__auralabAuth?.reauthenticate?.({ password: pwInput?.value });
      await window.__auralabAuth?.deleteAccount?.();
      // deleteAccount signs out → reload → login screen shows the closure notice.
      close?.();
    } catch (err) {
      setBusy(false);
      const code = err?.code || '';
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        if (!reauthShown) revealReauth();
        pwInput?.classList.add('is-invalid');
        if (pwErr) { pwErr.textContent = 'Incorrect password. Try again.'; pwErr.hidden = false; }
        pwInput?.focus();
      } else if (code === 'auth/requires-recent-login' || code === 'auth/missing-password') {
        revealReauth('For security, confirm it’s you to continue.');
      } else if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        showErr('Confirmation cancelled. Try again to delete your account.');
      } else if (code === 'firestore/write-failed') {
        showErr('Couldn’t close your account just now — check your connection and try again.');
      } else {
        showErr('Couldn’t complete deletion — please try again.');
      }
    }
  }
}
