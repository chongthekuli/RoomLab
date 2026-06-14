// Header account menu + Account/About modal regression test (v=815, 2026-06-13).
//
// Structural (text-grep) guard for the user-identity surface that replaced the
// fixed bottom-right sign-out button. Pairs with tests/user-prefs.test.mjs
// (which exercises the consent-store BEHAVIOUR); this file pins the WIRING so a
// refactor can't silently sever it.
//
// What it guards:
//   1. The old #auth-signout bottom-right button is gone, and auth-gate.js
//      publishes window.__auralabAuth (user + signOut) BEFORE importing main.js
//      — otherwise the header mounts before the identity exists and the chip
//      never renders.
//   2. header-nav.js imports and mounts the account menu.
//   3. The dropdown carries exactly Profile / Settings / About / Sign out, with
//      Profile→account view and Settings→preferences view.
//   4. The Preferences consent toggle uses the EXACT locked consent string and
//      carries NO `checked` attribute in markup — the getMarketingConsent()
//      getter (default ON) is the single source of truth, so a getter that ever
//      returns false can't be masked by a hard-coded checked box. This is the
//      legal-sensitive bit: the account preference defaults ON (opt-out) and is
//      deliberately SEPARATE from the sign-in attestation checkbox, which stays
//      opt-in / unchecked (guarded by tests/terms-privacy-marketing.test.mjs).
//   5. The modal shell is closeable (Esc + scrim-click) — it must NOT be the
//      non-closeable Terms modal pattern.
//
// Run: node tests/account-menu.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
const read = (p) => readFileSync(p, 'utf8');

const authGate   = read('./js/auth/auth-gate.js');
const headerNav  = read('./js/shared/header-nav.js');
const menu       = read('./js/ui/account-menu.js');
const acctModal  = read('./js/ui/account-modal.js');
const aboutModal = read('./js/ui/about-modal.js');
const shell      = read('./js/ui/modal-shell.js');
const indexHtml  = read('./index.html');

// ---------------------------------------------------------------------------
// 1. Old sign-out retired; auth context published before the app boots.
// ---------------------------------------------------------------------------
ok(!/id\s*=\s*['"]auth-signout['"]/.test(authGate),
   'auth-gate.js: the fixed bottom-right #auth-signout button is gone');
ok(!/#auth-signout\s*\{/.test(indexHtml),
   'index.html: the #auth-signout CSS rule is removed');
ok(/function publishAuthContext\b/.test(authGate),
   'auth-gate.js: defines publishAuthContext()');
ok(/window\.__auralabAuth\s*=/.test(authGate),
   'auth-gate.js: publishes window.__auralabAuth');
ok(/signOut:\s*\(\)\s*=>\s*signOut\(auth\)/.test(authGate),
   'auth-gate.js: exposes a signOut thunk on the published context');

// Ordering: publishAuthContext() must run BEFORE the dynamic import of main.js,
// or the header mounts before the identity exists.
const pubIdx  = authGate.indexOf('publishAuthContext();');
const bootImp = authGate.indexOf("import('../main.js')");
ok(pubIdx !== -1 && bootImp !== -1 && pubIdx < bootImp,
   'auth-gate.js: publishAuthContext() is called BEFORE import(../main.js)');

// ---------------------------------------------------------------------------
// 2. Header mounts the menu.
// ---------------------------------------------------------------------------
ok(/import\s*\{\s*mountAccountMenu\s*\}\s*from\s*['"]\.\.\/ui\/account-menu\.js['"]/.test(headerNav),
   'header-nav.js: imports mountAccountMenu');
ok(/mountAccountMenu\(\s*header\.querySelector\(['"]\.header-actions['"]\)\s*\)/.test(headerNav),
   'header-nav.js: mounts the account menu into .header-actions');

// ---------------------------------------------------------------------------
// 3. Menu items + their routing.
// ---------------------------------------------------------------------------
for (const act of ['profile', 'settings', 'about', 'signout']) {
  ok(new RegExp(`data-act="${act}"`).test(menu), `account-menu.js: menu has a "${act}" item`);
}
ok(/case 'profile':\s*openAccountModal\(\{\s*view:\s*'account'\s*\}\)/.test(menu),
   'account-menu.js: Profile opens the Account modal on the account view');
ok(/case 'settings':\s*openAccountModal\(\{\s*view:\s*'preferences'\s*\}\)/.test(menu),
   'account-menu.js: Settings opens the Account modal on the preferences view');
ok(/case 'about':\s*openAboutModal\(\)/.test(menu),
   'account-menu.js: About opens the About modal');
ok(/case 'signout':\s*auth\.signOut/.test(menu),
   'account-menu.js: Sign out calls the published signOut');

// ---------------------------------------------------------------------------
// 4. Consent toggle — exact string, no pre-checked markup, getter is truth.
// ---------------------------------------------------------------------------
const CONSENT =
  'I agree to receive product and promotional information from AuraLAB and its ' +
  'hardware manufacturer partners, and for my contact details to be shared with ' +
  'those partners for this purpose.';
ok(acctModal.includes(CONSENT),
   'account-modal.js: uses the exact locked marketing-consent string');
ok(!/withdraw at any time/i.test(acctModal),
   'account-modal.js: the "Optional — withdraw at any time" wording was removed');
// Toggling the preference shows a brief (~5s) opt-out / opt-in confirmation.
ok(/MARKETING_OPT_IN_MSG\s*:\s*MARKETING_OPT_OUT_MSG/.test(acctModal) && /pref-marketing-msg/.test(acctModal),
   'account-modal.js: shows a transient opt-out / opt-in message on toggle');

const consentInput =
  acctModal.match(/<input[^>]*id="pref-marketing-consent"[^>]*>/)?.[0] || '';
ok(consentInput.length > 0 && !/\bchecked\b/.test(consentInput),
   'account-modal.js: consent <input> carries NO checked attribute in markup');
ok(/cb\.checked\s*=\s*getMarketingConsent\(user\.uid\)/.test(acctModal),
   'account-modal.js: the getMarketingConsent() getter sets the toggle state (source of truth)');
ok(/cb\.addEventListener\(\s*['"]change['"][\s\S]*?setMarketingConsent\(cb\.checked,\s*user\.uid\)/.test(acctModal),
   'account-modal.js: toggling persists via setMarketingConsent (per-user)');

// The account modal must only READ the attestation, never rewrite it.
ok(/getAcceptanceRecord/.test(acctModal) && !/recordAcceptance/.test(acctModal),
   'account-modal.js: reads the acceptance record but never rewrites the attestation');

// Account-level strip — compact one-row display of all tiers, current marked.
ok(/function tierStripHtml/.test(acctModal) && /tier-strip/.test(acctModal),
   'account-modal.js: renders a compact account-level strip');
ok(/\['free',\s*'pro',\s*'max',\s*'admin'\]/.test(acctModal),
   'account-modal.js: strip covers all four tiers (cheapest → premium)');
ok(/is-current/.test(acctModal) && /aria-current/.test(acctModal),
   'account-modal.js: strip highlights the current tier (no redundant "Your level" label)');
ok(!/Your level/.test(acctModal),
   'account-modal.js: the verbose "Your level" label was removed');

// ---------------------------------------------------------------------------
// 5. Modal shell is closeable (NOT the non-closeable Terms pattern).
// ---------------------------------------------------------------------------
ok(/Escape/.test(shell) && /close\(\)/.test(shell),
   'modal-shell.js: Esc closes the modal');
ok(/e\.target === scrim\)\s*close\(\)/.test(shell),
   'modal-shell.js: clicking the scrim backdrop closes the modal');
ok(/app-modal-close/.test(shell),
   'modal-shell.js: renders an X close button');

// About modal sanity — it exists and references the version + standards.
ok(/openAboutModal/.test(aboutModal) && /about-chip/.test(aboutModal) && /cacheVersion/.test(aboutModal),
   'about-modal.js: exports openAboutModal with version line + standards chips');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll account-menu wiring assertions passed.');
