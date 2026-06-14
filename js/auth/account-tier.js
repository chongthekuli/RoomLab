// js/auth/account-tier.js
// ---------------------------------------------------------------------------
// Account-tier (entitlement) model — extends the super-admin role in admin.js
// into an ordered four-tier scheme:
//
//     free  <  pro  <  max  <  admin
//
// `admin` is the operator role (full access, from the ADMIN_EMAILS allowlist);
// free / pro / max are customer plans. This module owns tier RESOLUTION (who is
// what), tier DISPLAY helpers, and the PERMISSION API (can() / hasAtLeast())
// that features will gate on. The capability matrix is intentionally EMPTY for
// now — nothing is locked yet; we'll decide feature-by-feature which tier each
// capability needs (user, 2026-06-13).
//
// Trust model — SAME as admin.js: this is a client-side check, appropriate for
// a trusted tool, NOT cryptographically secure. A determined user can flip the
// flag in devtools. When tiers must be tamper-proof, issue them as Firebase
// custom claims (token claim `tier`) via the Admin SDK; resolveTier() already
// honours a claim value when one is passed in.
//
// Declarative gating (CSS) — markTier() adds to <html>:
//   • `tier-<t>`         exactly the active tier (tier-free / tier-pro / …)
//   • `tier-allows-<t>`  cumulative: present for every tier at or below the
//                        active rank, so CSS can do rank-based hiding:
//        html:not(.tier-allows-pro) [data-needs-pro] { display:none }
// Programmatic gating (JS): import { can, hasAtLeast } and branch.
// ---------------------------------------------------------------------------

import { isAdminEmail } from './admin.js';
import { TIER_OVERRIDES } from './firebase-config.js';

// Lowest → highest privilege. Order is the source of truth for ranking.
export const TIERS = ['free', 'pro', 'max', 'admin'];
const RANK = { free: 0, pro: 1, max: 2, admin: 3 };
export const TIER_LABELS = { free: 'Free', pro: 'Pro', max: 'Max', admin: 'Admin' };

const TIER_SESSION_KEY = 'auralab.tier';
// Admin-only testing override: an admin may preview a lower tier while building
// feature gates. Set localStorage['auralab.tierSimulate'] = 'free'|'pro'|'max'.
// Ignored for everyone who isn't actually an admin (can't self-upgrade).
const TIER_SIM_KEY = 'auralab.tierSimulate';

export function isValidTier(t) { return Object.prototype.hasOwnProperty.call(RANK, t); }
export function tierRank(tier) { return RANK[tier] ?? 0; }
export function tierLabel(tier) { return TIER_LABELS[tier] || TIER_LABELS.free; }

/**
 * Resolve a user's tier. Precedence:
 *   1. admin email allowlist (ADMIN_EMAILS)        → 'admin'
 *   2. token custom claim `tier` (if valid)        → that tier  (future/backend)
 *   3. per-email override (TIER_OVERRIDES config)  → that tier
 *   4. default                                     → 'free'
 * @param {object} user        the signed-in user ({ email })
 * @param {string} [claimTier] tier from the ID token's custom claims, if any
 * @returns {'free'|'pro'|'max'|'admin'}
 */
export function resolveTier(user, claimTier) {
  const email = (user?.email || '').trim().toLowerCase();
  if (isAdminEmail(email)) return 'admin';
  if (isValidTier(claimTier)) return claimTier;
  const override = TIER_OVERRIDES && TIER_OVERRIDES[email];
  if (isValidTier(override)) return override;
  return 'free';
}

/**
 * Apply the resolved tier to <html> (classes + data-tier) and sessionStorage,
 * mirroring admin.js's markAdmin(). Honours the admin-only sim override.
 * @returns {string} the EFFECTIVE tier actually applied (may differ from the
 *                   argument if an admin is simulating a lower tier).
 */
export function markTier(tier) {
  let effective = isValidTier(tier) ? tier : 'free';
  // Only a real admin may simulate another tier (test feature gates safely).
  if (effective === 'admin') {
    try {
      const sim = localStorage.getItem(TIER_SIM_KEY);
      if (isValidTier(sim)) effective = sim;
    } catch (_) { /* ignore */ }
  }
  try { sessionStorage.setItem(TIER_SESSION_KEY, effective); } catch (_) {}
  try {
    const el = document.documentElement;
    const rank = tierRank(effective);
    TIERS.forEach((t) => {
      el.classList.toggle(`tier-${t}`, t === effective);
      el.classList.toggle(`tier-allows-${t}`, rank >= tierRank(t));
    });
    el.dataset.tier = effective;
  } catch (_) { /* no DOM (tests) — sessionStorage still holds the tier */ }
  return effective;
}

/** Current effective tier for this session (set by markTier at sign-in). */
export function getCurrentTier() {
  try {
    const t = sessionStorage.getItem(TIER_SESSION_KEY);
    return isValidTier(t) ? t : 'free';
  } catch (_) { return 'free'; }
}

/** True if `tier` (default: current) is at or above `minTier`. */
export function hasAtLeast(minTier, tier = getCurrentTier()) {
  return tierRank(tier) >= tierRank(minTier);
}

// ---------------------------------------------------------------------------
// Capability matrix — capability key → MINIMUM tier required to use it.
// EMPTY for now: every capability is ungated (allowed for everyone) until we
// decide the locks. To gate a feature later, add an entry, e.g.:
//     precisionEngine: 'pro',
//     walkMode:        'max',
//     exportReport:    'pro',
// then guard the feature with `can('precisionEngine')` (JS) and/or mark its UI
// element `data-needs-pro` (CSS). Keep this the single place feature locks live.
// ---------------------------------------------------------------------------
export const CAPABILITY_MIN_TIER = {};

/**
 * Whether the (current or given) tier may use a capability. Ungated
 * capabilities (not in the matrix) are allowed for everyone.
 * @param {string} capability
 * @param {string} [tier] default: current session tier
 * @returns {boolean}
 */
export function can(capability, tier = getCurrentTier()) {
  const min = CAPABILITY_MIN_TIER[capability];
  if (!min) return true;             // ungated → everyone
  return tierRank(tier) >= tierRank(min);
}
