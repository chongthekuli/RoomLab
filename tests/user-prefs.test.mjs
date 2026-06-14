// Per-user preference store regression test (v=815, 2026-06-13).
//
// Guards js/shared/user-prefs.js — the account-level marketing-consent
// preference surfaced in the header user menu's Account → Preferences view.
//
// Pins the behaviours the feature rests on:
//   1. Marketing consent DEFAULTS ON when never set (product decision: opt-out,
//      not opt-in — the user must actively withdraw). This is intentionally the
//      OPPOSITE default from the sign-in attestation checkbox, which stays
//      opt-in / unchecked (GDPR / Malaysia PDPA at the point of collection,
//      pinned by tests/terms-privacy-marketing.test.mjs). The two must not be
//      conflated — see js/shared/user-prefs.js header.
//   2. set → get round-trips, on and off.
//   3. Preference is keyed by uid: two accounts on the same browser stay
//      isolated ("follows the user").
//   4. Falls back to the live auth snapshot (window.__auralabAuth.user.uid)
//      when no explicit uid is passed.
//
// Run: node tests/user-prefs.test.mjs

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// --- stub localStorage + window (read-only getters on modern globalThis) ----
const store = new Map();
function stub(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
stub('localStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
});

const { getMarketingConsent, setMarketingConsent, hasSetMarketingConsent } =
  await import('../js/shared/user-prefs.js');

// 1. Default ON when never set.
store.clear();
ok(getMarketingConsent('userA') === true,
   'getMarketingConsent(uid) DEFAULTS to true when never set (opt-out model)');
ok(hasSetMarketingConsent('userA') === false,
   'hasSetMarketingConsent(uid) is false before any explicit choice');

// 2. Round-trip off, then on.
setMarketingConsent(false, 'userA');
ok(getMarketingConsent('userA') === false,
   'setMarketingConsent(false) → getMarketingConsent returns false');
ok(hasSetMarketingConsent('userA') === true,
   'hasSetMarketingConsent(uid) is true after an explicit choice');
setMarketingConsent(true, 'userA');
ok(getMarketingConsent('userA') === true,
   'setMarketingConsent(true) → getMarketingConsent returns true');

// 3. Per-uid isolation.
store.clear();
setMarketingConsent(false, 'userA');
ok(getMarketingConsent('userA') === false,
   'userA explicitly off');
ok(getMarketingConsent('userB') === true,
   'userB unaffected by userA — still defaults ON (preference follows the user)');

// 4. Falls back to the live auth snapshot uid when none passed.
store.clear();
stub('__auralabAuth', { user: { uid: 'liveUser' } });
ok(getMarketingConsent() === true,
   'no-arg getMarketingConsent defaults ON for the live signed-in user');
setMarketingConsent(false);
ok(getMarketingConsent() === false,
   'no-arg set/get round-trips against the live signed-in uid');
ok(store.has('roomlab.user.liveUser.marketingConsent'),
   'no-arg write keys against window.__auralabAuth.user.uid');
ok(getMarketingConsent('userB') === true,
   'a different explicit uid is still isolated from the live user');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll user-prefs assertions passed.');
