// Self-service account-deletion regression test (v=827, 2026-06-14).
//
// Soft-delete: the account doc is flipped to status:'deleted' + deletedAt (the
// admin RETAINS it + sees the date); the Auth credential is removed best-effort;
// the user is signed out and bounced from the app. Pins the SECURITY-critical
// rule predicate + the flow + the honest verb-split copy.
//
// The rule predicate can only be FULLY tested with the Firestore emulator
// (unavailable in this no-package.json project — Martina/Sam review it by hand);
// this is the structural tripwire so a careless edit can't open the escalation.
//
// Run: node tests/account-delete.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
const read = (p) => readFileSync(p, 'utf8');

const rules     = read('./firestore.rules');
const db        = read('./js/auth/firebase-db.js');
const authGate  = read('./js/auth/auth-gate.js');
const modal     = read('./js/ui/account-modal.js');
const lab        = read('./js/labs/accountlab/main.js');

// ---------------------------------------------------------------------------
// 1. Rules — the self-delete branch is tightly scoped (escalation surface).
// ---------------------------------------------------------------------------
const selfDel = rules.match(/function onlySelfDelete\(\)\s*{[\s\S]*?\n    }/)?.[0] || '';
ok(selfDel.length > 0, 'firestore.rules: onlySelfDelete() exists');
ok(/resource\.data\.status != 'deleted'/.test(selfDel),
   'firestore.rules: self-delete only FROM a non-deleted state (terminal — no self-resurrection)');
ok(/request\.resource\.data\.status == 'deleted'/.test(selfDel),
   "firestore.rules: the only status an owner may write is 'deleted'");
ok(/request\.resource\.data\.deletedAt == request\.time/.test(selfDel),
   'firestore.rules: deletedAt must be server time (no forged deletion date)');
ok(/hasOnly\(\['status', 'deletedAt', 'updatedAt'\]\)/.test(selfDel),
   'firestore.rules: self-delete touches ONLY status/deletedAt/updatedAt');
ok(/request\.resource\.data\.tier == resource\.data\.tier/.test(selfDel),
   'firestore.rules: tier is provably unchanged in a self-delete (no escalation)');
// Profile edits are frozen once deleted.
ok(/\(isOwner\(uid\) && resource\.data\.status != 'deleted' && ownerWritableOnly\(\)\)/.test(rules),
   'firestore.rules: owner profile edits are frozen once the account is deleted');

// ---------------------------------------------------------------------------
// 2. Data layer.
// ---------------------------------------------------------------------------
const delFn = db.match(/export async function deleteOwnAccount[\s\S]*?\n}/)?.[0] || '';
ok(/status: 'deleted'/.test(delFn) && /deletedAt: serverTimestamp\(\)/.test(delFn),
   'firebase-db.js: deleteOwnAccount soft-deletes (status:deleted + deletedAt)');
ok(delFn.length > 0 && !/\btier\b/.test(delFn),
   'firebase-db.js: deleteOwnAccount never writes tier');
ok(/if \(data\?\.status === 'deleted'\) return data;/.test(db),
   'firebase-db.js: the sign-in upsert SKIPS the write for a deleted doc (rules would deny it)');

// ---------------------------------------------------------------------------
// 3. Auth-gate flow.
// ---------------------------------------------------------------------------
const delFlow = authGate.match(/async function deleteCurrentAccount\(\)[\s\S]*?\n}/)?.[0] || '';
ok(/await deleteOwnAccount\(user\.uid\)/.test(delFlow),
   'auth-gate.js: deleteCurrentAccount does the mandatory soft-delete first');
ok(/try \{ await deleteUser\(user\); \}/.test(delFlow),
   'auth-gate.js: Auth-credential removal is best-effort (wrapped, never blocks)');
ok(/sessionStorage\.setItem\('auralab\.justDeleted', '1'\)/.test(delFlow) && /signOut\(auth\)/.test(delFlow),
   'auth-gate.js: flags the post-delete notice + signs out');
ok(/reauthenticate: \(opts\) => reauthenticateCurrentUser\(opts\)/.test(authGate)
   && /deleteAccount: \(\) => deleteCurrentAccount\(\)/.test(authGate),
   'auth-gate.js: exposes reauthenticate + deleteAccount thunks to the app');
ok(/if \(acc && acc\.status === 'deleted'\) \{ showDeletedGate\(\); return; \}/.test(authGate),
   'auth-gate.js: a deleted account is bounced at boot (never re-enters the app)');
ok(/function maybeShowDeletedNotice/.test(authGate) && /auralab\.justDeleted/.test(authGate),
   'auth-gate.js: one-time "account closed" notice after the post-delete reload');

// ---------------------------------------------------------------------------
// 4. UI — honest verb-split copy + a gated destructive button.
// ---------------------------------------------------------------------------
ok(/id="acct-delete-start"/.test(modal) && />Delete account</.test(modal),
   'account-modal.js: a Delete account starter button exists');
ok(/Delete account permanently/.test(modal),
   'account-modal.js: the final destructive button is explicit');
ok(/cannot be restored/.test(modal) && /keeps a record/.test(modal),
   'account-modal.js: prose is honest (access cannot be restored; operator keeps a record)');
ok(/finalBtn\.disabled = busy \|\| \(isPassword && reauthShown && !pwInput\.value\.trim\(\)\)/.test(modal),
   'account-modal.js: the destructive button is gated-disabled on an empty re-auth password');
ok(/window\.__auralabAuth\?\.reauthenticate\?\.\(/.test(modal)
   && /window\.__auralabAuth\?\.deleteAccount\?\.\(\)/.test(modal),
   'account-modal.js: delete flow re-auths THEN deletes via the auth thunks');

// ---------------------------------------------------------------------------
// 5. AccountLAB shows deleted accounts + the date.
// ---------------------------------------------------------------------------
ok(/deleted: 'Deleted'/.test(lab) && /<dt>Deleted<\/dt>/.test(lab) && /al-row-deleted/.test(lab),
   'accountlab/main.js: deleted accounts get a Deleted pill + deletion-date detail + de-emphasis');
ok(/\.al-status-deleted/.test(read('./css/main.css')),
   'main.css: the Deleted status pill is styled');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll account-delete assertions passed.');
