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
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  firebaseConfig, isConfigured,
  RESTRICT_TO_BUSINESS_EMAIL, REQUIRE_EMAIL_VERIFICATION,
} from './firebase-config.js';
import { isBusinessEmail } from './free-email-domains.js';
import { recordAcceptance, hasAcceptedThisSession } from '../shared/terms-record.js';

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
const acceptBtn  = document.getElementById('terms-accept-btn');
const accountEl  = document.getElementById('auth-account-email');

const $ = (id) => document.getElementById(id);
const emailVal = (id) => ($(id)?.value || '').trim();
const passVal  = (id) => $(id)?.value || '';

// ---- shared state ----------------------------------------------------------
let currentView = 'signin';
let termsChecked = false;     // in-memory; the persisted record is the legal trail
let pendingUser = null;       // a signed-in user awaiting terms acceptance

// ---- messaging -------------------------------------------------------------
function showError(msg) { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } if (infoEl) infoEl.hidden = true; }
function showInfo(msg)  { if (infoEl) { infoEl.textContent = msg; infoEl.hidden = false; } if (errEl) errEl.hidden = true; }
function clearMessages() {
  if (errEl)  { errEl.hidden = true;  errEl.textContent = ''; }
  if (infoEl) { infoEl.hidden = true; infoEl.textContent = ''; }
}
function setBusy(busy) {
  gate?.classList.toggle('auth-busy', busy);
  gate?.querySelectorAll('button').forEach((b) => { b.disabled = busy; });
  if (!busy) refreshTermsGate();
}

// Auth actions are disabled until the terms checkbox is ticked (sign-in /
// create-account views only). Reset + terms views are never terms-gated here.
function refreshTermsGate() {
  const need = currentView === 'signin' || currentView === 'signup';
  const blocked = need && !termsChecked;
  if (googleBtn) googleBtn.disabled = blocked;
  const submit = gate?.querySelector(`.auth-view[data-view="${currentView}"] .auth-submit`);
  if (submit) submit.disabled = blocked;
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
async function bootApp() {
  if (booted) return;
  booted = true;
  document.documentElement.classList.remove('pre-auth');
  gate?.remove();
  injectSignOut();
  await import('../main.js');
}

// Record the Terms acceptance against the signed-in account, then boot.
function authorLabel(user) {
  const name = (user.displayName || '').trim();
  return name ? `${name} (${user.email})` : (user.email || 'Authenticated user');
}
async function recordAndBoot(user) {
  try { await recordAcceptance({ operatorName: authorLabel(user) }); }
  catch (e) { console.warn('[auth-gate] recordAcceptance failed:', e); }
  bootApp();
}

function injectSignOut() {
  // Minimal, unobtrusive sign-out affordance. TODO(Maya): fold into the header
  // nav for a polished placement — this is the functional v1.
  const btn = document.createElement('button');
  btn.id = 'auth-signout';
  btn.type = 'button';
  btn.textContent = 'Sign out';
  btn.title = 'Sign out of AuraLAB';
  btn.addEventListener('click', () => signOut(auth).catch((e) => console.warn('[auth-gate] signOut:', e)));
  document.body.appendChild(btn);
}

// ---- terms checkbox --------------------------------------------------------
termsCheck?.addEventListener('change', (e) => {
  termsChecked = !!e.target.checked;
  refreshTermsGate();
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

  setBusy(true);
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    try { await sendEmailVerification(cred.user); } catch (e) { console.warn('[auth-gate] verification email:', e); }
    // onAuthStateChanged decides whether to boot now or require verification.
  } catch (e) {
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

onAuthStateChanged(auth, async (user) => {
  if (user) {
    // Corporate-only gate (flag-controlled).
    if (RESTRICT_TO_BUSINESS_EMAIL && !isBusinessEmail(user.email)) {
      showError('Please use your company email address. Public providers (Gmail, Outlook, Yahoo, QQ, etc.) are not permitted.');
      signOut(auth);
      return;
    }
    // Email-verification gate (flag-controlled, password accounts only).
    const usesPassword = user.providerData.some((p) => p.providerId === 'password');
    if (REQUIRE_EMAIL_VERIFICATION && usesPassword && !user.emailVerified) {
      showInfo('Almost there — verify your email. We sent a link to ' + user.email + '. Click it, then sign in.');
      signOut(auth);
      return;
    }
    // Terms gate: already accepted this session → boot; just ticked + signed
    // in → record then boot; otherwise (persisted login) → ask on this page.
    if (hasAcceptedThisSession()) { clearMessages(); bootApp(); return; }
    if (termsChecked)             { clearMessages(); await recordAndBoot(user); return; }
    showAccountTermsGate(user);
  } else {
    pendingUser = null;
    if (booted) {
      // Signed out after using the app — reload to a clean locked state.
      window.location.reload();
    } else if (currentView === 'terms') {
      // Signed out from the terms step — return to the login view.
      if (termsCheck) termsCheck.checked = false;
      termsChecked = false;
      setView('signin');
    }
  }
});

// Initial view.
setView('signin');
