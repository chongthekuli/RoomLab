// AccountLAB route-guard + wiring tripwire (v=823, 2026-06-14, Phase 3).
//
// AccountLAB is admin-only. The header tab is hidden for non-admins via
// data-admin-only CSS, but that's cosmetic — the REAL gate is the router guard
// (a non-admin typing #/account must be bounced). This pins both, plus the
// mount + data-layer wiring.
//
// Run: node tests/accountlab-route-guard.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
const read = (p) => readFileSync(p, 'utf8');

const router    = read('./js/shared/router.js');
const headerNav = read('./js/shared/header-nav.js');
const mainJs    = read('./js/main.js');
const db        = read('./js/auth/firebase-db.js');
const lab       = read('./js/labs/accountlab/main.js');

// --- Router: route registered + admin guard ---------------------------------
ok(/const ROUTES = \[[^\]]*'account'[^\]]*\]/.test(router),
   'router.js: "account" is a registered route');
ok(/ADMIN_ROUTES = new Set\(\[\s*'account'\s*\]\)/.test(router),
   'router.js: "account" is marked admin-only');
ok(/import \{ isCurrentUserAdmin \} from '\.\.\/auth\/admin\.js'/.test(router),
   'router.js: imports the admin check');
ok(/ADMIN_ROUTES\.has\(target\) && !isAdminNow\(\)/.test(router),
   'router.js: guards admin routes against non-admins (redirect)');
// The guard must trust the SAME signal that shows the tab (the is-admin class),
// so the tab and the guard can never disagree (the bounce-while-admin bug).
ok(/function isAdminNow\(\)/.test(router)
   && /classList\.contains\('is-admin'\)/.test(router),
   'router.js: admin check trusts the is-admin class (consistent with tab visibility)');

// --- Header tab: admin-only ---------------------------------------------------
ok(/id: 'account',[^}]*adminOnly: true/.test(headerNav),
   'header-nav.js: AccountLAB tab is flagged adminOnly');
ok(/lab\.adminOnly \? ' data-admin-only' : ''/.test(headerNav),
   'header-nav.js: adminOnly tabs render data-admin-only (CSS-hidden for non-admins)');

// --- Mount registered ---------------------------------------------------------
ok(/account:\s*\(\) => import\(`\.\/labs\/accountlab\/main\.js/.test(mainJs),
   'main.js: AccountLAB mount registered in the router');

// --- Data layer + module ------------------------------------------------------
ok(/export async function listAccounts/.test(db)
   && /orderBy\('lastActiveAt', 'desc'\)/.test(db),
   'firebase-db.js: listAccounts queries accounts by last-active (admin read)');
ok(/export async function mountAccountLab/.test(lab),
   'accountlab/main.js: exports mountAccountLab');
// Read-only MVP — must NOT yet write tier/status from the dashboard (Phase 4).
ok(!/setMarketingConsent|saveProfileFields|updateDoc|setDoc/.test(lab),
   'accountlab/main.js: read-only MVP performs no writes (admin actions are Phase 4)');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll AccountLAB route-guard assertions passed.');
