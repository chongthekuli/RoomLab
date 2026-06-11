// js/auth/admin.js
// ---------------------------------------------------------------------------
// Lightweight, client-side super-admin role check.
//
// Any signed-in user whose email is in ADMIN_EMAILS (firebase-config.js) is
// treated as an admin: auth-gate.js calls markAdmin() on sign-in, which adds
// an `is-admin` class to <html> and records the flag in sessionStorage.
//
// Gating features:
//   • Declarative (CSS): mark any element `data-admin-only`. css/main.css hides
//     it for non-admins:  html:not(.is-admin) [data-admin-only] { display:none }
//   • Programmatic (JS):  import { isCurrentUserAdmin } and branch on it.
//
// NOT cryptographically secure — a determined user could flip the flag in
// devtools. Appropriate for a trusted internal tool; for tamper-proof roles,
// move to Firebase custom claims (admin:true token claim via the Admin SDK).
// ---------------------------------------------------------------------------

import { ADMIN_EMAILS } from './firebase-config.js';

const ADMIN_SET = new Set((ADMIN_EMAILS || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));
const ADMIN_SESSION_KEY = 'auralab.isAdmin';

// True if the given email is on the admin allowlist.
export function isAdminEmail(email) {
  return !!email && ADMIN_SET.has(String(email).trim().toLowerCase());
}

// Apply (or clear) admin state: <html class="is-admin"> + sessionStorage flag.
// Called by auth-gate.js whenever auth state resolves.
export function markAdmin(isAdmin) {
  try { sessionStorage.setItem(ADMIN_SESSION_KEY, isAdmin ? '1' : '0'); } catch (_) {}
  try { document.documentElement.classList.toggle('is-admin', !!isAdmin); } catch (_) {}
}

// Read the current admin flag (set at sign-in, survives reloads in-session).
export function isCurrentUserAdmin() {
  try { return sessionStorage.getItem(ADMIN_SESSION_KEY) === '1'; } catch (_) { return false; }
}
