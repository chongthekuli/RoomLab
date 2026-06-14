// js/auth/auth-gate.js
// ---------------------------------------------------------------------------
// Combined sign-in + Terms-of-Use gate for AuraLAB on Firebase Hosting.
//
// Loaded INSTEAD of js/main.js. Presents one pre-app page that handles BOTH
// authentication and Terms-of-Use acceptance, then boots the app (dynamic
// import of ../main.js). The legacy post-boot terms modal is retired — terms
// acceptance now lives on the sign-in page and is recorded against the
// signed-in account for the PDF report's attestation page.
//
// Flow:
//   • Not signed in → sign-in / create-account page WITH the terms text and a
//     required "I accept" checkbox gating the auth buttons. On auth, the
//     acceptance is recorded and the app boots.
//   • Already signed in (persisted) but no acceptance this session → a terms
//     acceptance step on the same page (account shown), then boot.
//
// IMPORTANT — what this does and does NOT do:
//   • It gates the UI: unauthenticated visitors see only the auth card.
//   • It does NOT make the raw static files private. See FIREBASE_SETUP.md.
// ---------------------------------------------------------------------------

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, setPersistence, browserLocalPersistence,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, sendEmailVerification, signOut,
  deleteUser, reauthenticateWithCredential, reauthenticateWithPopup, EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  firebaseConfig, isConfigured,
  RESTRICT_TO_BUSINESS_EMAIL, REQUIRE_EMAIL_VERIFICATION,
} from './firebase-config.js';
import { isBusinessEmail } from './free-email-domains.js';
import { isAdminEmail, markAdmin } from './admin.js';
import { resolveTier, markTier, getCurrentTier } from './account-tier.js';
import { recordAcceptance, hasAcceptedThisSession } from '../shared/terms-record.js';
import {
  getMarketingConsent, setMarketingConsent, hasSetMarketingConsent,
  MARKETING_OPT_OUT_MSG, MARKETING_OPT_IN_MSG,
} from '../shared/user-prefs.js';
import { initDb, upsertAccountOnSignIn, saveProfileFields, isProfileComplete, deleteOwnAccount } from './firebase-db.js';
import { validateProfileGroup, validateProfileField, PROFILE_FIELDS } from './profile-fields.js';

// ---- element refs ----------------------------------------------------------
const gate      = document.getElementById('auth-gate');
const titleEl   = document.getElementById('auth-title');
const subEl     = document.getElementById('auth-subtitle');
const switchEl  = document.getElementById('auth-switch');
const errEl     = document.getElementById('auth-error');
const infoEl    = document.getElementById('auth-info');
const googleBtn = document.getElementById('auth-google');
const googleLbl = document.getElementById('auth-google-label');
const termsCheck = document.getElementById('terms-accept-check');
const marketingCheck = document.getElementById('marketing-consent-check');
const acceptBtn  = document.getElementById('terms-accept-btn');
const accountEl  = document.getElementById('auth-account-email');

const $ = (id) => document.getElementById(id);
const emailVal = (id) => ($(id)?.value || '').trim();
const passVal  = (id) => $(id)?.value || '';

// ---- shared state ----------------------------------------------------------
let currentView = 'signin';
let termsChecked = false;     // in-memory; the persisted record is the legal trail
let pendingUser = null;       // a signed-in user awaiting terms acceptance
let pendingSignupProfile = null;  // profile values typed on the create-account view, latched to a NEW account doc
let verifyEmailSent = false;      // email a fresh verification link only once per verify-gate entry
let resendTimer = null;           // resend-cooldown interval handle

// ---- messaging -------------------------------------------------------------
function showError(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } if (infoEl) infoEl.hidden = true; }
function showInfo(msg)  { if (infoEl) { infoEl.textContent = msg; infoEl.hidden = false; } if (errEl) errEl.hidden = true; }
function clearMessages() {
  if (errEl)  { errEl.hidden = true;  errEl.textContent = ''; }
  if (infoEl) { infoEl.hidden = true; infoEl.textContent = ''; }
}
function setBusy(busy) {
  gate?.classList.toggle('auth-busy', busy);
  // Exclude the verify Resend button — it owns its own cooldown disabled-state;
  // letting setBusy(false) re-enable it opens a window to bypass the cooldown.
  gate?.querySelectorAll('button:not(#verify-resend)').forEach((b) => { b.disabled = busy; });
  if (!busy) refreshTermsGate();
}

// Auth actions are disabled until the terms checkbox is ticked (sign-in /
// create-account views only). Reset + terms views are never terms-gated here.
function refreshTermsGate() {
  const needTerms = currentView === 'signin' || currentView === 'signup';
  const termsBlock = needTerms && !termsChecked;
  // Google button: gated by terms only (profile is collected via the sign-up
  // submit or the completion gate). It's hidden on the profile view anyway.
  if (googleBtn) googleBtn.disabled = termsBlock;
  // The current view's submit ALSO needs the profile group valid on the
  // create-account view and the completion gate.
  let blocked = termsBlock;
  if (currentView === 'signup' || currentView === 'profile') {
    const { ok } = validateProfileGroup((n) => $(`${currentView}-${n}`)?.value);
    if (!ok) blocked = true;
  }
  const submit = gate?.querySelector(`.auth-view[data-view="${currentView}"] .auth-submit`);
  if (submit) submit.disabled = blocked;
}

// Per-field inline validation for the profile group (company / position /
// contact number). Shown on blur + submit attempt — never per keystroke.
function showFieldError(el) {
  if (!el) return;
  const err = validateProfileField(el.name, el.value);
  const errEl = document.getElementById(`${el.id}-err`);
  el.classList.toggle('is-invalid', !!err);
  if (errEl) { errEl.textContent = err || ''; errEl.hidden = !err; }
}

// ---- view switching --------------------------------------------------------
const VIEWS = {
  signin: {
    title: 'Sign in to AuraLAB',
    sub:   'Review the terms, then sign in to continue.',
    sw:    'New to AuraLAB? <a data-action="view:signup" role="button" tabindex="0">Create an account</a>',
  },
  signup: {
    title: 'Create your account',
    sub:   'Review the terms, then create your account.',
    sw:    'Already have an account? <a data-action="view:signin" role="button" tabindex="0">Sign in</a>',
  },
  reset: {
    title: 'Reset your password',
    sub:   'Enter your email and we’ll send a reset link.',
    sw:    '<a data-action="view:signin" role="button" tabindex="0">← Back to sign in</a>',
  },
  terms: {
    title: 'Review & accept',
    sub:   'Please accept the Terms of Use to continue.',
    sw:    'Not you? <a data-action="signout" role="button" tabindex="0">Sign out</a>',
  },
  profile: {
    title: 'Complete your profile',
    sub:   'Three details before you start — required to set up your account.',
    sw:    'Not you? <a data-action="signout" role="button" tabindex="0">Sign out</a>',
  },
  verify: {
    title: 'Verify your email',
    sub:   'One more step — confirm your email address to finish setting up.',
    sw:    'Wrong account? <a data-action="signout" role="button" tabindex="0">Sign out</a>',
  },
};

function setView(view) {
  if (!VIEWS[view]) return;
  currentView = view;
  clearMessages();
  // Forms (single data-view)
  gate?.querySelectorAll('.auth-view').forEach((f) => { f.hidden = f.dataset.view !== view; });
  // Shared chrome (multi data-views: google, separator, terms box, checkbox,
  // account chip, accept button)
  gate?.querySelectorAll('[data-views]').forEach((el) => {
    el.hidden = !el.dataset.views.split(' ').includes(view);
  });
  if (googleLbl) googleLbl.textContent = view === 'signup' ? 'Sign up with Google' : 'Continue with Google';
  if (titleEl)  titleEl.textContent = VIEWS[view].title;
  if (subEl)    subEl.textContent   = VIEWS[view].sub;
  if (switchEl) switchEl.innerHTML  = VIEWS[view].sw;
  refreshTermsGate();
  // Focus the most relevant control once the unhide has applied.
  const focusTarget = view === 'terms'
    ? acceptBtn
    : view === 'verify'
      ? document.getElementById('verify-continue')
      : gate?.querySelector(`.auth-view[data-view="${view}"] input`);
  setTimeout(() => focusTarget?.focus(), 30);
}

// ---- config sanity ---------------------------------------------------------
if (!isConfigured) {
  showError('Firebase is not configured yet. Fill in js/auth/firebase-config.js (see FIREBASE_SETUP.md).');
  console.error('[auth-gate] firebase-config.js still has placeholder values.');
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
initDb(app);   // Firestore on the SAME app instance (accounts database, Phase 0)

// Keep the user signed in across reloads/tabs on this device. (Terms are still
// re-accepted each session — acceptance lives in sessionStorage.)
setPersistence(auth, browserLocalPersistence).catch((e) => console.warn('[auth-gate] persistence:', e));

// ---- friendly error copy ---------------------------------------------------
function humanize(code) {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':        return 'Email or password is incorrect.';
    case 'auth/invalid-email':         return 'That doesn’t look like a valid email address.';
    case 'auth/missing-password':      return 'Please enter your password.';
    case 'auth/email-already-in-use':  return 'An account with this email already exists. Try signing in instead.';
    case 'auth/weak-password':         return 'Password is too weak — use at least 6 characters.';
    case 'auth/too-many-requests':     return 'Too many attempts. Please wait a few minutes and try again.';
    case 'auth/network-request-failed':return 'Network error. Check your connection and try again.';
    case 'auth/operation-not-allowed': return 'This sign-in method isn’t enabled yet. Enable it in Firebase Console → Authentication → Sign-in method.';
    case 'auth/popup-blocked':
    case 'auth/popup-closed-by-user':  return 'Sign-in popup was blocked. Retrying in this window…';
    case 'auth/unauthorized-domain':   return 'This domain isn’t authorized for sign-in. Add it in Firebase Console → Authentication → Settings → Authorized domains.';
    default:                           return 'Something went wrong (' + code + '). Please try again.';
  }
}

// ---- boot ------------------------------------------------------------------
let booted = false;
let gateRemoved = false;

function removeGate() {
  if (gateRemoved) return;
  gateRemoved = true;
  document.getElementById('auth-gate')?.remove();
}

// Swap the auth card for a loading animation but KEEP the gate in the DOM — it
// sits above the app (z-index 100000), so it covers the screen from sign-in
// until the first lab mounts. Without this cover the user sees a blank page
// while main.js + Three.js download and the scene builds.
function showGateLoading() {
  if (!gate) return;
  gate.classList.add('auth-booting-mode');
  gate.innerHTML =
    '<div class="auth-booting">' +
      '<img class="auth-logo" src="assets/logo/AuraLAB-logo-1024.png" alt="" />' +
      '<div class="auth-spinner" role="status" aria-label="Loading AuraLAB"></div>' +
      '<p class="auth-booting-text">Loading AuraLAB…</p>' +
    '</div>';
}

function showGateError() {
  if (!gate || gateRemoved) return;
  gate.classList.add('auth-booting-mode');
  gate.innerHTML =
    '<div class="auth-booting">' +
      '<p class="auth-booting-text">AuraLAB couldn’t finish loading. Please reload.</p>' +
      '<button type="button" id="auth-reload" class="auth-submit auth-reload-btn">Reload</button>' +
    '</div>';
  document.getElementById('auth-reload')?.addEventListener('click', () => window.location.reload());
}

// Re-authenticate the signed-in user. Password accounts need their password
// re-entered; Google accounts re-confirm via popup. Throws on failure (wrong
// password → auth/wrong-password|invalid-credential; popup closed, etc.) so the
// account modal can show the right inline error.
async function reauthenticateCurrentUser({ password } = {}) {
  const user = auth.currentUser;
  if (!user) { const e = new Error('not signed in'); e.code = 'auth/no-current-user'; throw e; }
  const providerId = user.providerData?.[0]?.providerId || 'password';
  if (providerId === 'google.com') {
    await reauthenticateWithPopup(user, new GoogleAuthProvider());
  } else {
    if (!password) { const e = new Error('password required'); e.code = 'auth/missing-password'; throw e; }
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  }
}

// Self-service deletion. Re-auth must already have succeeded (the modal calls
// reauthenticate() first). Order: soft-delete the record (mandatory; admin keeps
// it) → best-effort remove the Auth credential → flag the notice → sign out. A
// failed credential removal is swallowed: the account is already closed and the
// boot gate (afterTerms) locks out the lingering login. Throws only if the
// MANDATORY soft-delete write fails.
async function deleteCurrentAccount() {
  const user = auth.currentUser;
  if (!user) { const e = new Error('not signed in'); e.code = 'auth/no-current-user'; throw e; }
  const ok = await deleteOwnAccount(user.uid);
  if (!ok) { const e = new Error('soft-delete failed'); e.code = 'firestore/write-failed'; throw e; }
  // Flag the notice BEFORE any credential teardown — deleteUser/signOut trigger
  // onAuthStateChanged(null) → reload, and the flag must already be set so the
  // reloaded login screen can surface the one-time "account closed" notice.
  try { sessionStorage.setItem('auralab.justDeleted', '1'); } catch (_) {}
  try { await deleteUser(user); } catch (e) { console.warn('[auth-gate] deleteUser (best-effort):', e?.code || e); }
  try { await signOut(auth); } catch (_) {}
}

async function bootApp() {
  if (booted) return;
  booted = true;
  document.documentElement.classList.remove('pre-auth');
  showGateLoading();              // instant loading cover (gate is already painted)
  publishAuthContext();           // expose user + signOut to the app BEFORE main.js mounts the header
  // (The account doc is seeded/refreshed in afterTerms() before bootApp runs.)
  // Lift the cover once the initial route has mounted and is visible.
  const reveal = () => removeGate();
  document.addEventListener('route:change', reveal, { once: true });
  // Safety net so a failed/slow mount can't trap the user behind the spinner.
  const safety = setTimeout(removeGate, 30000);
  try {
    await import('../main.js');
  } catch (e) {
    clearTimeout(safety);
    document.removeEventListener('route:change', reveal);
    console.error('[auth-gate] app failed to load:', e);
    showGateError();
  }
}

// Record the Terms acceptance against the signed-in account, then boot.
function authorLabel(user) {
  const name = (user.displayName || '').trim();
  return name ? `${name} (${user.email})` : (user.email || 'Authenticated user');
}
// Optional marketing opt-in — read at acceptance time, default false if the
// checkbox is absent (e.g. the already-signed-in terms step). Never gates auth.
function marketingConsentChecked() {
  return document.getElementById('marketing-consent-check')?.checked === true;
}
async function recordAndBoot(user) {
  // Latch the sign-up marketing choice to the per-user preference the FIRST time
  // this account is seen on this device. The consent checkbox is shown only on
  // the create-account view and defaults ON; for returning sign-ins it is
  // hidden, so its (pre-ticked) state must NOT overwrite a stored preference —
  // hence the hasSetMarketingConsent guard. The attestation then records the
  // ACTUAL preference, so a returning user's report reflects their real choice.
  try {
    if (!hasSetMarketingConsent(user.uid)) {
      setMarketingConsent(marketingConsentChecked(), user.uid);
    }
  } catch (_) { /* storage blocked — pref read falls back to default ON */ }
  try {
    await recordAcceptance({
      operatorName: authorLabel(user),
      marketingConsent: getMarketingConsent(user.uid),
    });
  }
  catch (e) { console.warn('[auth-gate] recordAcceptance failed:', e); }
  await afterTerms(user);
}

// Single boot funnel for every signed-in + terms-accepted path: seed/refresh the
// Firestore account doc, then gate on profile completeness before booting. If
// the profile is incomplete (e.g. a Google sign-up with no create-account form),
// show the completion gate; otherwise boot. NEVER traps the user if Firestore is
// unreachable — a DB error boots anyway.
async function afterTerms(user) {
  let acc;
  try {
    acc = await upsertAccountOnSignIn(user, pendingSignupProfile);
  } catch (e) {
    console.warn('[auth-gate] account upsert failed — booting without profile gate:', e);
    pendingSignupProfile = null;
    bootApp();
    return;
  }
  pendingSignupProfile = null;
  // A deleted account can still re-authenticate (the credential may linger if
  // deleteUser didn't run) — it must NEVER re-enter the app.
  if (acc && acc.status === 'deleted') { showDeletedGate(); return; }
  // acc === null means Firestore isn't enabled → don't gate. acc with an
  // incomplete profile → collect it first.
  if (acc && !isProfileComplete(acc)) { showProfileGate(user); return; }
  bootApp();
}

// A deleted account is bounced to the login view with a one-time notice, and
// signed out so its lingering credential (if any) can't be used.
function showDeletedGate() {
  setView('signin');
  showDeletedNotice();
  signOut(auth).catch(() => {});
}

// Show (and clear) the one-time "account deleted" notice, set just before a
// self-delete sign-out (survives the reload) or by showDeletedGate directly.
function showDeletedNotice() {
  showInfo('Your account has been closed. You’ve been signed out — contact the operator if this was a mistake.');
}
function maybeShowDeletedNotice() {
  try {
    if (sessionStorage.getItem('auralab.justDeleted') === '1') {
      sessionStorage.removeItem('auralab.justDeleted');
      showDeletedNotice();
    }
  } catch (_) { /* storage blocked */ }
}

function showProfileGate(user) {
  pendingUser = user;
  const chip = document.getElementById('profile-account-email');
  if (chip) chip.textContent = user.email || 'your account';
  setView('profile');
}

// Expose a minimal, plain-object auth context to the booted app so the header
// user menu, Account modal and per-user prefs can read the signed-in identity
// and sign out — WITHOUT importing firebase-auth a second time (a second
// initializeApp/getAuth would be a separate instance). The Firebase SDK stays
// encapsulated in this module; the app sees only a snapshot + a signOut thunk.
//
// Published BEFORE the dynamic import of ../main.js (see bootApp) so it's in
// place by the time header-nav.js's mountHeaderNav() runs synchronously.
function publishAuthContext() {
  const u = auth.currentUser;
  const user = u ? {
    uid:           u.uid,
    email:         u.email || '',
    displayName:   (u.displayName || '').trim(),
    photoURL:      u.photoURL || '',
    providerId:    u.providerData?.[0]?.providerId || 'password',
    emailVerified: !!u.emailVerified,
    createdAt:     u.metadata?.creationTime || '',
    lastLoginAt:   u.metadata?.lastSignInTime || '',
    tier:          getCurrentTier(),   // 'free' | 'pro' | 'max' | 'admin'
  } : null;
  window.__auralabAuth = {
    user,
    signOut: () => signOut(auth).catch((e) => console.warn('[auth-gate] signOut:', e)),
    // Re-authenticate the current user (security checkpoint before deletion).
    // Throws on wrong password / cancelled popup so the caller can show an error.
    reauthenticate: (opts) => reauthenticateCurrentUser(opts),
    // Self-service account deletion: soft-delete the record (admin retains it),
    // best-effort remove the credential, then sign out. Re-auth must precede this.
    deleteAccount: () => deleteCurrentAccount(),
  };
  try {
    window.dispatchEvent(new CustomEvent('auralab:auth', { detail: { user } }));
  } catch (_) { /* CustomEvent unsupported — the snapshot is still on window */ }
}

// ---- terms checkbox --------------------------------------------------------
termsCheck?.addEventListener('change', (e) => {
  termsChecked = !!e.target.checked;
  refreshTermsGate();
});

// Marketing-consent toggle (create-account view only) — show a brief (~5s)
// message on change: graceful opt-out copy / simple opt-in ack (Carmen,
// market-strategist). Never gates auth. The choice is latched to the per-user
// preference in recordAndBoot().
let consentMsgTimer = null;
function showTimedInfo(msg) {
  showInfo(msg);
  clearTimeout(consentMsgTimer);
  consentMsgTimer = setTimeout(() => {
    if (infoEl && !infoEl.hidden && infoEl.textContent === msg) infoEl.hidden = true;
  }, 5000);
}
marketingCheck?.addEventListener('change', (e) => {
  showTimedInfo(e.target.checked ? MARKETING_OPT_IN_MSG : MARKETING_OPT_OUT_MSG);
});

// Profile-group fields (sign-up form + completion gate): live-revalidate the
// submit button on input, clear a shown error as the user fixes it, and surface
// the inline error on blur.
gate?.querySelectorAll('[data-profile-group] input').forEach((el) => {
  el.addEventListener('input', () => {
    if (el.classList.contains('is-invalid')) showFieldError(el);
    refreshTermsGate();
  });
  el.addEventListener('blur', () => showFieldError(el));
});

// ---- delegated UI events (view links, sign-out link, password toggles) -----
function handleAction(action, ev) {
  if (action.startsWith('view:')) { ev.preventDefault(); setView(action.slice(5)); }
  else if (action === 'signout')  { ev.preventDefault(); signOut(auth).catch((e) => console.warn('[auth-gate] signOut:', e)); }
}
gate?.addEventListener('click', (ev) => {
  const toggle = ev.target.closest('.auth-toggle-pass');
  if (toggle) {
    ev.preventDefault();
    const input = $(toggle.dataset.target);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    toggle.textContent = reveal ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    input.focus();
    return;
  }
  const link = ev.target.closest('[data-action]');
  if (link) handleAction(link.dataset.action, ev);
});
gate?.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('a[data-action]')) {
    handleAction(ev.target.dataset.action, ev);
  }
});

// Guard helper for terms-gated auth actions.
function termsBlocked() {
  if ((currentView === 'signin' || currentView === 'signup') && !termsChecked) {
    showError('Please read and accept the Terms of Use to continue.');
    return true;
  }
  return false;
}

// ---- Google sign-in (popup → redirect fallback for iframes) ----------------
const provider = new GoogleAuthProvider();
googleBtn?.addEventListener('click', async () => {
  if (termsBlocked()) return;
  // On the create-account view, capture any typed profile so a NEW Google
  // account is seeded with it (ignored for existing accounts; an incomplete
  // Google account still hits the completion gate). Best-effort, never blocks.
  if (currentView === 'signup') {
    const prof = validateProfileGroup((n) => $(`signup-${n}`)?.value);
    pendingSignupProfile = prof.ok ? prof.values : null;
  }
  clearMessages(); setBusy(true);
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request',
         'auth/operation-not-supported-in-this-environment'].includes(e?.code)) {
      try { await signInWithRedirect(auth, provider); return; }
      catch (e2) { showError(humanize(e2?.code || 'auth/redirect-failed')); }
    } else {
      showError(humanize(e?.code || 'unknown'));
    }
  } finally {
    setBusy(false);
  }
});

// ---- email/password sign-in ------------------------------------------------
$('form-signin')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (termsBlocked()) return;
  clearMessages(); setBusy(true);
  try {
    await signInWithEmailAndPassword(auth, emailVal('signin-email'), passVal('signin-pass'));
  } catch (e) {
    showError(humanize(e?.code || 'unknown'));
  } finally {
    setBusy(false);
  }
});

// ---- create account --------------------------------------------------------
$('form-signup')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (termsBlocked()) return;
  clearMessages();
  const email = emailVal('signup-email');
  const pass  = passVal('signup-pass');
  const pass2 = passVal('signup-pass2');

  if (pass.length < 6)  { showError('Password must be at least 6 characters.'); return; }
  if (pass !== pass2)   { showError('Passwords don’t match.'); return; }
  if (RESTRICT_TO_BUSINESS_EMAIL && !isBusinessEmail(email)) {
    showError('Please register with your company email address. Public providers (Gmail, Outlook, etc.) are not permitted.');
    return;
  }
  // Required profile fields — block creation until valid, and capture them so
  // afterTerms() seeds the new account doc with them (profileComplete:true).
  const prof = validateProfileGroup((n) => $(`signup-${n}`)?.value);
  if (!prof.ok) {
    PROFILE_FIELDS.forEach((n) => showFieldError($(`signup-${n}`)));
    showError('Please complete your company, position and contact number.');
    return;
  }

  setBusy(true);
  // Capture BEFORE creating the account: createUserWithEmailAndPassword signs the
  // user in, which fires onAuthStateChanged → afterTerms() — and that can run
  // before the line after the await. If the seed isn't already set, afterTerms
  // creates an empty-profile doc and shows the completion gate, asking for the
  // same fields twice. Setting it first closes that race.
  pendingSignupProfile = prof.values;
  try {
    await createUserWithEmailAndPassword(auth, email, pass);
    // onAuthStateChanged routes to the verify gate (which sends the link) or,
    // if verification is off, to the terms gate / boot.
  } catch (e) {
    pendingSignupProfile = null;   // creation failed — don't leak the seed into a later sign-in
    showError(humanize(e?.code || 'unknown'));
  } finally {
    setBusy(false);
  }
});

// ---- terms acceptance (already-signed-in returning user) -------------------
acceptBtn?.addEventListener('click', async () => {
  if (!pendingUser) return;
  setBusy(true);
  await recordAndBoot(pendingUser);   // boot removes the gate
});

// ---- complete-profile gate (post-auth) -------------------------------------
// Terms are already recorded by the time this gate shows, so on success we save
// the profile and boot directly (no re-record).
$('form-profile')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { ok, values } = validateProfileGroup((n) => $(`profile-${n}`)?.value);
  if (!ok) { PROFILE_FIELDS.forEach((n) => showFieldError($(`profile-${n}`))); return; }
  // Re-derive from the LIVE user, not the latched pendingUser — guards against a
  // fast account switch between gate-entry and submit writing the wrong uid.
  const u = auth.currentUser;
  if (!u || (pendingUser && u.uid !== pendingUser.uid)) return;
  setBusy(true);
  const saved = await saveProfileFields(u.uid, values);
  if (!saved) {
    setBusy(false);
    showError('Couldn’t save your profile. Check your connection and try again.');
    return;
  }
  bootApp();
});

// ---- forgot password -------------------------------------------------------
$('form-reset')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clearMessages();
  const email = emailVal('reset-email');
  if (!email) { showError('Please enter your email address.'); return; }

  setBusy(true);
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (e) {
    if (e?.code === 'auth/invalid-email') { showError('That doesn’t look like a valid email address.'); setBusy(false); return; }
    console.warn('[auth-gate] reset:', e);   // don't reveal whether the account exists
  }
  showInfo('If an account exists for that email, a password-reset link is on its way. Check your inbox and spam folder.');
  setBusy(false);
});

// ---- complete any redirect-based sign-in -----------------------------------
getRedirectResult(auth).catch((e) => { if (e?.code) showError(humanize(e.code)); });

// ---- single source of truth: auth state → accept → boot -------------------
function showAccountTermsGate(user) {
  pendingUser = user;
  if (accountEl) accountEl.textContent = user.email || 'your account';
  setView('terms');
}

// ---- email-verification gate -----------------------------------------------
// Park an unverified password account on the verify view and send ONE fresh
// verification link per gate entry. The user clicks the link (in this or
// another tab), then "I've verified" reloads + re-checks.
async function showVerifyGate(user) {
  pendingUser = user;
  const email = user.email || 'your account';
  const chip = document.getElementById('verify-account-email');
  const echo = document.getElementById('verify-email-echo');
  if (chip) chip.textContent = email;
  if (echo) echo.textContent = email;
  setView('verify');
  if (!verifyEmailSent) {
    verifyEmailSent = true;
    startResendCooldown();                 // optimistic — disable resend immediately
    try { await sendEmailVerification(user); }
    catch (e) { showInfo('Check your inbox — and your spam or junk folder — for the verification link. You can resend in a moment.'); }
  }
}

// Cooldown the Resend button. The per-second tick re-asserts `disabled` from the
// remaining count, so a transient setBusy(false) elsewhere self-heals within 1s.
function startResendCooldown(seconds = 45) {
  const btn = document.getElementById('verify-resend');
  if (!btn) return;
  clearInterval(resendTimer);
  let left = seconds;
  const tick = () => {
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Resend email (${left})` : 'Resend email';
    if (left <= 0) { clearInterval(resendTimer); return; }
    left -= 1;
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

// "I've verified — continue": reload the user and re-check emailVerified. Manage
// only the continue button's disabled state (NOT setBusy) so the resend cooldown
// is untouched.
$('form-verify')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const u = auth.currentUser;
  if (!u) return;
  const btn = $('verify-continue');
  if (btn) btn.disabled = true;
  clearMessages();
  try {
    await u.reload();
    if (auth.currentUser?.emailVerified) {
      await proceedAfterAuth(auth.currentUser);
      return;   // booting / advancing to the next gate
    }
    showInfo('Not verified yet — open the link in the email we sent, then tap “I’ve verified”. Be sure to check your spam and junk folders too.');
  } catch (e) {
    showError('Couldn’t check verification just now. Please try again.');
  }
  if (btn) btn.disabled = false;
});

// Resend the verification link.
document.getElementById('verify-resend')?.addEventListener('click', async () => {
  const u = auth.currentUser;
  if (!u) return;
  clearMessages();
  try {
    await sendEmailVerification(u);
    showInfo('Verification link re-sent. Check your inbox, then your spam and junk folders.');
    startResendCooldown();
  } catch (e) {
    showError(humanize(e?.code || 'unknown'));
  }
});

// onAuthStateChanged fires on sign-in AND on token refresh (~hourly) and on
// reload(). Guard against re-entry so a refresh can't (a) re-run the gates over
// the already-running app, or (b) double-process a user parked on a gate
// (double recordAcceptance, re-stamped timestamp). The flow after the first
// fire is driven by the gate's own handlers (accept / verify-continue /
// profile-submit), which call proceedAfterAuth directly — never via this
// listener — so bailing subsequent same-uid fires is safe. Reset on sign-out.
let lastHandledUid = null;
onAuthStateChanged(auth, async (user) => {
  if (user) {
    if (booted) return;                        // app already running — ignore refreshes
    if (lastHandledUid === user.uid) return;   // already processing / parked this user
    lastHandledUid = user.uid;
    // Corporate-only gate (flag-controlled). Admins are always exempt.
    if (RESTRICT_TO_BUSINESS_EMAIL && !isBusinessEmail(user.email) && !isAdminEmail(user.email)) {
      showError('Please use your company email address. Public providers (Gmail, Outlook, Yahoo, QQ, etc.) are not permitted.');
      signOut(auth);
      return;
    }
    // Email-verification gate (flag-controlled, password accounts only; admins
    // exempt — they're provisioned and the admin test address has no inbox).
    // Park the user on the verify gate (do NOT sign them out) so they can click
    // the emailed link and continue without re-entering credentials.
    const usesPassword = user.providerData.some((p) => p.providerId === 'password');
    if (REQUIRE_EMAIL_VERIFICATION && usesPassword && !user.emailVerified && !isAdminEmail(user.email)) {
      await showVerifyGate(user);
      return;
    }
    await proceedAfterAuth(user);
  } else {
    pendingUser = null;
    lastHandledUid = null;
    verifyEmailSent = false;
    clearInterval(resendTimer);
    markAdmin(false);
    markTier('free');
    if (booted) {
      // Signed out after using the app — reload to a clean locked state.
      window.location.reload();
    } else if (currentView === 'terms' || currentView === 'verify' || currentView === 'profile') {
      // Signed out from a post-auth gate — return to the login view.
      if (termsCheck) termsCheck.checked = false;
      termsChecked = false;
      setView('signin');
    }
  }
});

// Post-verification continuation (also the verified / Google / admin path): tag
// role + tier, then run the terms gate. Extracted so the "I've verified" handler
// can re-enter it once the email is confirmed.
async function proceedAfterAuth(user) {
  markAdmin(isAdminEmail(user.email));
  markTier(resolveTier(user));
  if (hasAcceptedThisSession()) { clearMessages(); await afterTerms(user); return; }
  if (termsChecked)             { clearMessages(); await recordAndBoot(user); return; }
  showAccountTermsGate(user);
}

// Initial view.
setView('signin');
// After a self-delete + reload, surface the one-time "account closed" notice.
maybeShowDeletedNotice();
