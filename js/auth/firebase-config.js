// js/auth/firebase-config.js
// ---------------------------------------------------------------------------
// Your Firebase project's web config. SAFE to commit — these are public client
// identifiers, NOT secrets (Google designs them to ship in the browser). Access
// is controlled by Authentication + your authorized-domain list, not by hiding
// these strings.
//
// HOW TO FILL THIS IN:
//   Firebase Console → Project settings (gear) → "Your apps" → Web app (</>)
//   → "SDK setup and configuration" → Config. Copy each value below.
//   See FIREBASE_SETUP.md step 2.
// ---------------------------------------------------------------------------

export const firebaseConfig = {
  apiKey: 'AIzaSyCAxPuxNi_ndX-UQeXrWQQ2HGR9KyFrD58',
  authDomain: 'auralabsuite.firebaseapp.com',
  projectId: 'auralabsuite',
  storageBucket: 'auralabsuite.firebasestorage.app',
  messagingSenderId: '306335156615',
  appId: '1:306335156615:web:68532de75fcf2e5951eb22',
};

// Loud console warning if the placeholders were never replaced, so a broken
// deploy is obvious instead of failing with a cryptic Firebase error.
export const isConfigured = !firebaseConfig.apiKey.startsWith('YOUR_');

// Corporate-email-only login. When true, sign-ins from public/disposable
// providers (Gmail, Outlook, Yahoo, QQ, etc.) are rejected at the gate.
// Currently OFF — Gmail and personal logins are allowed for this stage.
// Flip to true (and bump ?v=) to enforce business-domain-only access.
export const RESTRICT_TO_BUSINESS_EMAIL = false;
