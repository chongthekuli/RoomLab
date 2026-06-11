// js/auth/auth-gate.js
// ---------------------------------------------------------------------------
// Client-side login wall for AuraLAB on Firebase Hosting.
//
// Loaded INSTEAD of js/main.js. Shows a sign-in / create-account / reset
// screen and boots the actual app (dynamic import of ../main.js) only after
// Firebase reports an authenticated (and, if required, verified) user.
//
// IMPORTANT — what this does and does NOT do:
//   • It gates the UI: unauthenticated visitors see only the auth card.
//   • It does NOT make the raw static files private. Firebase Hosting serves
//     js/, css/, data/ publicly; a technical user could fetch them directly.
//     The app holds no secrets, so this is the standard, accepted trade-off
//     for a static tool. For true file-level protection you need a server
//     gate (Cloud Run + IAP) — see FIREBASE_SETUP.md, "Hardening".
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

// ---- element refs ----------------------------------------------------------
const gate      = document.getElementById('auth-gate');
const titleEl   = document.getElementById('auth-title');
const subEl     = document.getElementById('auth-subtitle');
const switchEl  = document.getElementById('auth-switch');
const errEl     = document.getElementById('auth-error');
const infoEl    = document.getElementById('auth-info');
const googleBtn = document.getElementById('auth-google');
const googleLbl = document.getElementById('auth-google-label');

const $ = (id) => document.getElementById(id);
const emailVal = (id) => ($(id)?.value || '').trim();
const passVal  = (id) => $(id)?.value || '';

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
}

// ---- view switching --------------------------------------------------------
const VIEWS = {
  signin: {
    title: 'Sign in to AuraLAB',
    sub:   'Welcome back — sign in to continue.',
    sw:    'New to AuraLAB? <a data-action="view:signup" role="button" tabindex="0">Create an account</a>',
  },
  signup: {
    title: 'Create your account',
    sub:   'Set up your AuraLAB Suite access.',
    sw:    'Already have an account? <a data-action="view:signin" role="button" tabindex="0">Sign in</a>',
  },
  reset: {
    title: 'Reset your password',
    sub:   'Enter your email and we’ll send a reset link.',
    sw:    '<a data-action="view:signin" role="button" tabindex="0">← Back to sign in</a>',
  },
};

let currentView = 'signin';
function setView(view) {
  if (!VIEWS[view]) return;
  currentView = view;
  clearMessages();
  // Forms
  gate?.querySelectorAll('.auth-view').forEach((f) => { f.hidden = f.dataset.view !== view; });
  // Google button + separator only on signin/signup
  gate?.querySelectorAll('[data-views]').forEach((el) => {
    el.hidden = !el.dataset.views.split(' ').includes(view);
  });
  if (googleLbl) googleLbl.textContent = view === 'signup' ? 'Sign up with Google' : 'Continue with Google';
  // Texts
  if (titleEl)  titleEl.textContent = VIEWS[view].title;
  if (subEl)    subEl.textContent   = VIEWS[view].sub;
  if (switchEl) switchEl.innerHTML  = VIEWS[view].sw;
  // Focus the first field (deferred so the unhide has applied)
  const first = gate?.querySelector(`.auth-view[data-view="${view}"] input`);
  setTimeout(() => first?.focus(), 30);
}

// ---- config sanity ---------------------------------------------------------
if (!isConfigured) {
  showError('Firebase is not configured yet. Fill in js/auth/firebase-config.js (see FIREBASE_SETUP.md).');
  console.error('[auth-gate] firebase-config.js still has placeholder values.');
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Keep the user signed in across reloads/tabs on this device.
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

// ---- delegated UI events (view links + password toggles) -------------------
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
  if (link && link.dataset.action.startsWith('view:')) {
    ev.preventDefault();
    setView(link.dataset.action.slice(5));
  }
});
// Keyboard activation for the anchor-style view links.
gate?.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('a[data-action]')) {
    ev.preventDefault();
    setView(ev.target.dataset.action.slice(5));
  }
});

// ---- Google sign-in (popup → redirect fallback for iframes) ----------------
const provider = new GoogleAuthProvider();
googleBtn?.addEventListener('click', async () => {
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
    // Don't reveal whether an account exists, except for a malformed address.
    if (e?.code === 'auth/invalid-email') { showError('That doesn’t look like a valid email address.'); setBusy(false); return; }
    console.warn('[auth-gate] reset:', e);
  }
  // Privacy-preserving generic confirmation regardless of account existence.
  showInfo('If an account exists for that email, a password-reset link is on its way. Check your inbox and spam folder.');
  setBusy(false);
});

// ---- complete any redirect-based sign-in -----------------------------------
getRedirectResult(auth).catch((e) => { if (e?.code) showError(humanize(e.code)); });

// ---- single source of truth: auth state → boot / reject -------------------
onAuthStateChanged(auth, (user) => {
  if (user) {
    // Corporate-only gate (flag-controlled). Account exists, but we sign it
    // straight back out and never boot.
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
    clearMessages();
    bootApp();
  } else if (booted) {
    // Signed out after using the app — reload to a clean locked state.
    window.location.reload();
  }
});

// Initial view.
setView('signin');
