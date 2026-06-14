// Email-verification gate regression test (v=826, 2026-06-14).
//
// New password sign-ups must verify their email (Firebase verification LINK,
// free / no backend) before the app boots. Pins:
//   1. REQUIRE_EMAIL_VERIFICATION is ON.
//   2. The gate parks unverified PASSWORD users on the verify view (does NOT
//      sign them out) and EXEMPTS admins (the admin test address has no inbox)
//      and Google accounts (always pre-verified).
//   3. The verify link is sent ONCE per gate entry (verifyEmailSent guard);
//      "I've verified" reloads + re-checks; Resend re-sends with a cooldown.
//   4. The verify view exists in the markup.
//
// Run: node tests/email-verification.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
const read = (p) => readFileSync(p, 'utf8');

const cfg       = read('./js/auth/firebase-config.js');
const authGate  = read('./js/auth/auth-gate.js');
const indexHtml = read('./index.html');

// 1. Flag on.
ok(/export const REQUIRE_EMAIL_VERIFICATION = true;/.test(cfg),
   'firebase-config.js: REQUIRE_EMAIL_VERIFICATION is enabled');

// 2. Gate: park (not sign out) + admin/password conditions.
ok(/REQUIRE_EMAIL_VERIFICATION && usesPassword && !user\.emailVerified && !isAdminEmail\(user\.email\)/.test(authGate),
   'auth-gate.js: verification gate is password-only AND exempts admins');
ok(/!user\.emailVerified[^]*?\)\s*{\s*await showVerifyGate\(user\);\s*return;/.test(authGate),
   'auth-gate.js: an unverified user is parked on the verify gate (no signOut)');
// The gate must NOT sign the user out (the old crude behaviour).
const gateBlock = authGate.match(/REQUIRE_EMAIL_VERIFICATION[\s\S]{0,260}/)?.[0] || '';
ok(!/signOut\(auth\)/.test(gateBlock),
   'auth-gate.js: verification gate does not sign the user out');

// 3. Send-once + re-check + resend.
ok(/if \(!verifyEmailSent\)/.test(authGate) && /sendEmailVerification\(user\)/.test(authGate),
   'auth-gate.js: sends the verification link once per gate entry (verifyEmailSent guard)');
ok(/await u\.reload\(\)/.test(authGate) && /auth\.currentUser\?\.emailVerified/.test(authGate)
   && /proceedAfterAuth\(auth\.currentUser\)/.test(authGate),
   'auth-gate.js: "I\'ve verified" reloads + re-checks emailVerified, then proceeds');
ok(/function startResendCooldown/.test(authGate) && /verify-resend/.test(authGate),
   'auth-gate.js: Resend has a cooldown');
// The sign-up handler no longer double-sends (the gate owns sending).
const signupBlock = authGate.match(/createUserWithEmailAndPassword\(auth, email, pass\)[\s\S]{0,200}/)?.[0] || '';
ok(!/sendEmailVerification/.test(signupBlock),
   'auth-gate.js: the sign-up handler does not also send (no double email)');

// 4. Markup.
ok(/id="form-verify"[^>]*data-view="verify"/.test(indexHtml),
   'index.html: the verify view exists');
ok(/id="verify-continue"/.test(indexHtml) && /id="verify-resend"/.test(indexHtml),
   'index.html: verify view has continue + resend controls');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll email-verification assertions passed.');
