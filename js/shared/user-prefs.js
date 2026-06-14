// js/shared/user-prefs.js
// ---------------------------------------------------------------------------
// Per-user preferences, persisted in localStorage and KEYED BY the signed-in
// account uid so two accounts on the same browser keep separate settings — the
// preference "follows the user". Surfaced in the Account → Preferences view
// (js/ui/account-modal.js) reached from the header user menu.
//
// The only preference today is the OPTIONAL marketing opt-in. Per product
// decision (2026-06-13) it DEFAULTS ON: a user who has never touched the toggle
// is treated as opted-in, and must actively switch it off to withdraw.
//
// IMPORTANT — this is NOT the legal acceptance attestation.
//   • The acceptance ATTESTATION (what the user agreed to AT SIGN-IN, with the
//     UTC timestamp + fingerprint printed on every PDF report) lives in the
//     session record — js/shared/terms-record.js. That is a point-in-time legal
//     trail and is never rewritten by this store.
//   • The SIGN-IN marketing checkbox stays opt-in / default-unchecked (GDPR /
//     Malaysia PDPA — no pre-ticked consent at the point of collection). It is
//     deliberately separate from this account-level preference.
//   • This store is the user's CURRENT, changeable marketing preference. It
//     defaults ON and can be withdrawn at any time from the Account page.
// ---------------------------------------------------------------------------

const PREFIX = 'roomlab.user.';
const MARKETING_KEY = 'marketingConsent';

// Resolve the uid to key against. Falls back to the live auth snapshot, then to
// a shared 'anon' bucket (e.g. if read before auth publishes — should not
// happen in the booted app, but keeps reads total).
function resolveUid(uid) {
  if (uid) return uid;
  try { return globalThis.__auralabAuth?.user?.uid || 'anon'; } catch (_) { return 'anon'; }
}

function prefKey(uid, name) {
  return `${PREFIX}${resolveUid(uid)}.${name}`;
}

function readRaw(uid, name) {
  try { return localStorage.getItem(prefKey(uid, name)); } catch (_) { return null; }
}
function writeRaw(uid, name, value) {
  try { localStorage.setItem(prefKey(uid, name), value); return true; } catch (_) { return false; }
}

/**
 * Current marketing-consent preference for the (signed-in) user.
 * DEFAULTS TO true when the user has never set it — opt-out, not opt-in.
 * @param {string} [uid] explicit uid; omit to use the live signed-in user.
 * @returns {boolean}
 */
export function getMarketingConsent(uid) {
  const v = readRaw(uid, MARKETING_KEY);
  if (v === null) return true;   // never chosen → default accepted
  return v === '1';
}

/**
 * Persist the marketing-consent preference for the (signed-in) user.
 * @param {boolean} on
 * @param {string} [uid] explicit uid; omit to use the live signed-in user.
 * @returns {boolean} whether the write succeeded.
 */
export function setMarketingConsent(on, uid) {
  return writeRaw(uid, MARKETING_KEY, on ? '1' : '0');
}

/**
 * Whether the user has ever made an explicit marketing-consent choice
 * (vs. sitting on the default). Useful for analytics / report wording.
 * @param {string} [uid]
 * @returns {boolean}
 */
export function hasSetMarketingConsent(uid) {
  return readRaw(uid, MARKETING_KEY) !== null;
}

// Transient (~5s) confirmation messages shown when the marketing toggle is
// flipped — drafted by Carmen (market-strategist): declarative, mirrors the
// product's Terms-of-Use register, no guilt-trip on opt-out, points back to the
// same control. Shown in the Account → Preferences view AND on the sign-up page.
export const MARKETING_OPT_OUT_MSG =
  "Marketing preferences updated. You won't receive promotions from AuraLAB or our partners. Turn this back on anytime here.";
export const MARKETING_OPT_IN_MSG =
  "Marketing preferences updated. You'll now receive product news and promotions from AuraLAB and our partners.";
