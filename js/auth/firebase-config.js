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
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

// Loud console warning if the placeholders were never replaced, so a broken
// deploy is obvious instead of failing with a cryptic Firebase error.
export const isConfigured = !firebaseConfig.apiKey.startsWith('YOUR_');
