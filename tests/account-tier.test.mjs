// Account-tier (entitlement) regression test (v=816, 2026-06-13).
//
// Guards js/auth/account-tier.js — the ordered four-tier scheme
// (free < pro < max < admin) layered on top of the admin role. Pins:
//   1. Tier ranking + validation.
//   2. resolveTier precedence: admin allowlist > token claim > per-email
//      override > default 'free'.
//   3. markTier / getCurrentTier round-trip, including the cumulative
//      `tier-allows-*` classes used for declarative CSS gating.
//   4. The admin-only simulation override (only a real admin may preview a
//      lower tier — a non-admin cannot self-upgrade via localStorage).
//   5. hasAtLeast + can(): the capability matrix is EMPTY today, so every
//      capability is allowed for everyone (nothing locked yet).
//
// resolveTier's admin path keys off ADMIN_EMAILS in firebase-config.js, which
// ships with 'admin@admin.com'.
//
// Run: node tests/account-tier.test.mjs

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// --- stub browser globals ---------------------------------------------------
const ss = new Map();
const ls = new Map();
function stub(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
stub('sessionStorage', {
  getItem: (k) => (ss.has(k) ? ss.get(k) : null),
  setItem: (k, v) => { ss.set(k, String(v)); },
  removeItem: (k) => { ss.delete(k); },
});
stub('localStorage', {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => { ls.set(k, String(v)); },
  removeItem: (k) => { ls.delete(k); },
});
// Minimal documentElement whose classList tracks state so we can assert.
const htmlClasses = new Set();
const htmlDataset = {};
stub('document', {
  documentElement: {
    dataset: htmlDataset,
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !htmlClasses.has(name) : !!force;
        if (on) htmlClasses.add(name); else htmlClasses.delete(name);
        return on;
      },
      contains: (n) => htmlClasses.has(n),
    },
  },
});

const {
  TIERS, tierRank, tierLabel, isValidTier, resolveTier,
  markTier, getCurrentTier, hasAtLeast, can, CAPABILITY_MIN_TIER,
} = await import('../js/auth/account-tier.js');

// 1. Ranking + validation.
ok(JSON.stringify(TIERS) === JSON.stringify(['free', 'pro', 'max', 'admin']),
   'TIERS are ordered free < pro < max < admin');
ok(tierRank('free') < tierRank('pro') && tierRank('pro') < tierRank('max') && tierRank('max') < tierRank('admin'),
   'tierRank strictly increases free → pro → max → admin');
ok(tierRank('bogus') === 0, 'tierRank of an unknown tier is 0 (treated as free)');
ok(isValidTier('pro') && !isValidTier('platinum') && !isValidTier(undefined),
   'isValidTier accepts the four tiers, rejects anything else');
ok(tierLabel('max') === 'Max' && tierLabel('bogus') === 'Free',
   'tierLabel maps keys to display labels, defaulting to Free');

// 2. resolveTier precedence.
ok(resolveTier({ email: 'admin@admin.com' }) === 'admin',
   'resolveTier: an ADMIN_EMAILS address → admin');
ok(resolveTier({ email: 'ADMIN@ADMIN.COM' }) === 'admin',
   'resolveTier: admin match is case-insensitive');
ok(resolveTier({ email: 'someone@x.com' }, 'pro') === 'pro',
   'resolveTier: a valid token claim sets the tier for a non-admin');
ok(resolveTier({ email: 'someone@x.com' }, 'platinum') === 'free',
   'resolveTier: an invalid claim falls through to free');
ok(resolveTier({ email: 'admin@admin.com' }, 'pro') === 'admin',
   'resolveTier: admin allowlist OUTRANKS a claim');
ok(resolveTier({ email: 'nobody@x.com' }) === 'free',
   'resolveTier: an unknown user defaults to free');
ok(resolveTier(null) === 'free' && resolveTier({}) === 'free',
   'resolveTier: missing user / email defaults to free (no throw)');

// 3. markTier / getCurrentTier + declarative classes.
ls.clear(); htmlClasses.clear();
const applied = markTier('pro');
ok(applied === 'pro' && getCurrentTier() === 'pro',
   'markTier(pro) applies pro and getCurrentTier reflects it');
ok(htmlClasses.has('tier-pro') && !htmlClasses.has('tier-free') && !htmlClasses.has('tier-max'),
   'markTier sets the exact tier-<t> class only for the active tier');
ok(htmlClasses.has('tier-allows-free') && htmlClasses.has('tier-allows-pro') && !htmlClasses.has('tier-allows-max'),
   'markTier sets cumulative tier-allows-<t> for every tier at/below rank');
ok(htmlDataset.tier === 'pro', 'markTier sets <html data-tier>');

// 4. Admin-only simulation override.
ls.clear(); ss.clear(); htmlClasses.clear();
ls.set('auralab.tierSimulate', 'free');
ok(markTier('admin') === 'free' && getCurrentTier() === 'free',
   'markTier(admin) with sim=free → an admin previews the free tier');
ls.clear();
ls.set('auralab.tierSimulate', 'max');
ok(markTier('pro') === 'pro',
   'markTier(pro) IGNORES the sim override — a non-admin cannot self-upgrade');

// 5. hasAtLeast + can (empty matrix → nothing locked).
ok(hasAtLeast('free', 'pro') && hasAtLeast('pro', 'pro') && !hasAtLeast('max', 'pro'),
   'hasAtLeast compares ranks correctly');
ok(Object.keys(CAPABILITY_MIN_TIER).length === 0,
   'CAPABILITY_MIN_TIER is empty — no feature is locked yet (locks TBD)');
ok(can('anyFeature', 'free') === true && can('anyFeature', 'admin') === true,
   'can(): an ungated capability is allowed for every tier');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll account-tier assertions passed.');
