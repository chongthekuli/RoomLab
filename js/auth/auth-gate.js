// js/auth/auth-gate.js
// ---------------------------------------------------------------------------
// Client-side login wall for AuraLAB on Firebase Hosting.
//
// This module is loaded INSTEAD of js/main.js. It shows a sign-in screen and
// boots the actual app (dynamic import of ../main.js) only after Firebase
// reports an authenticated user.
//
// IMPORTANT — what this does and does NOT do:
//   • It gates the UI: unauthenticated visitors see only the login card.
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
  signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { firebaseConfig, isConfigured } from './firebase-config.js';

const gate = document.getElementById('auth-gate');
const errEl = document.getElementById('auth-error');
const googleBtn = document.getElementById('auth-google');
const emailForm = document.getElementById('auth-email-form');
const emailInput = document.getElementById('auth-email');
const passInput = document.getElementById('auth-pass');

function showError(msg) {
  if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
}
function clearError() {
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
}
function setBusy(busy) {
  gate?.classList.toggle('auth-busy', busy);
  [googleBtn, emailInput, passInput].forEach((el) => { if (el) el.disabled = busy; });
}

if (!isConfigured) {
  showError('Firebase is not configured yet. Fill in js/auth/firebase-config.js (see FIREBASE_SETUP.md).');
  console.error('[auth-gate] firebase-config.js still has placeholder values.');
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Keep the user signed in across reloads/tabs on this device.
setPersistence(auth, browserLocalPersistence).catch((e) => console.warn('[auth-gate] persistence:', e));

// Friendlier copy than raw Firebase error codes.
function humanize(code) {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':       return 'Email or password is incorrect.';
    case 'auth/invalid-email':        return 'That doesn’t look like a valid email.';
    case 'auth/too-many-requests':    return 'Too many attempts. Try again in a few minutes.';
    case 'auth/popup-blocked':
    case 'auth/popup-closed-by-user': return 'Sign-in popup was blocked. Retrying in this window…';
    case 'auth/unauthorized-domain':  return 'This domain is not authorized for sign-in. Add it in Firebase Console → Authentication → Settings → Authorized domains.';
    default:                          return 'Sign-in failed (' + code + ').';
  }
}

let booted = false;
async function bootApp() {
  if (booted) return;
  booted = true;
  // Reveal the app shell and tear down the login wall.
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

// Google sign-in: try popup first (best UX standalone), fall back to redirect
// if the browser blocks it (common inside cross-origin iframes).
const provider = new GoogleAuthProvider();
googleBtn?.addEventListener('click', async () => {
  clearError(); setBusy(true);
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/popup-closed-by-user' ||
        e?.code === 'auth/cancelled-popup-request' || e?.code === 'auth/operation-not-supported-in-this-environment') {
      try { await signInWithRedirect(auth, provider); return; }
      catch (e2) { showError(humanize(e2?.code || 'auth/redirect-failed')); }
    } else {
      showError(humanize(e?.code || 'unknown'));
    }
  } finally {
    setBusy(false);
  }
});

// Email/password sign-in (no public sign-up form — accounts are provisioned by
// you in the Firebase Console, keeping access invite-only).
emailForm?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clearError(); setBusy(true);
  try {
    await signInWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value);
  } catch (e) {
    showError(humanize(e?.code || 'unknown'));
  } finally {
    setBusy(false);
  }
});

// Complete any redirect-based sign-in that bounced back to this page.
getRedirectResult(auth).catch((e) => { if (e?.code) showError(humanize(e.code)); });

// Single source of truth: whenever auth state resolves to a user, boot.
onAuthStateChanged(auth, (user) => {
  if (user) {
    clearError();
    bootApp();
  } else if (booted) {
    // Signed out after using the app — reload to a clean locked state.
    window.location.reload();
  }
});
