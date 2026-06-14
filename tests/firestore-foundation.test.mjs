// Firestore accounts-DB foundation tripwire (v=821, 2026-06-14, Phase 0).
//
// The security rules are the load-bearing safety boundary. They can only be
// FULLY tested with the Firebase emulator (needs firebase-tools — a build
// dependency this no-package.json project doesn't carry), so Martina reviews
// + Sam round-trips them manually. This text-grep tripwire guards the
// STRUCTURE so a careless edit can't silently open the barn door:
//   1. firestore.rules: a user can never write tier/status on their own doc;
//      admins read all; default-deny catch-all; activity is append-only.
//   2. firebase-db.js: seeds safe defaults; the returning-user update path
//      never writes tier/status; one shared app (getFirestore(app)).
//   3. auth-gate.js: initialises the DB on the shared app + seeds the account
//      doc on boot.
//
// Run: node tests/firestore-foundation.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
const read = (p) => readFileSync(p, 'utf8');

const rules    = read('./firestore.rules');
const db       = read('./js/auth/firebase-db.js');
const authGate = read('./js/auth/auth-gate.js');

// ---------------------------------------------------------------------------
// 1. Security rules — the boundary.
// ---------------------------------------------------------------------------
// The owner-writable allow-list must NOT contain tier/status/adminLog (a user
// PATCHing those is the canonical privilege-escalation bug).
const ownerBlock = rules.match(/function ownerWritableOnly\(\)\s*{[\s\S]*?}/)?.[0] || '';
ok(ownerBlock.length > 0, 'firestore.rules: ownerWritableOnly() exists');
ok(!/\btier\b/.test(ownerBlock) && !/\bstatus\b/.test(ownerBlock) && !/\badminLog\b/.test(ownerBlock),
   'firestore.rules: a user CANNOT write tier / status / adminLog on their own doc');
ok(/affectedKeys\(\)\.hasOnly\(/.test(ownerBlock),
   'firestore.rules: owner writes are restricted via hasOnly(allow-list)');

ok(/allow read:\s*if isOwner\(uid\) \|\| isAdmin\(\)/.test(rules),
   'firestore.rules: account docs are readable only by the owner or an admin');
ok(/allow update:\s*if isAdmin\(\)/.test(rules)
   && /\(isOwner\(uid\) && resource\.data\.status != 'deleted' && ownerWritableOnly\(\)\)/.test(rules)
   && /\(isOwner\(uid\) && onlySelfDelete\(\)\)/.test(rules),
   'firestore.rules: updates require admin OR owner-profile-edit (frozen once deleted) OR owner-self-delete');
ok(/createHasSafeDefaults/.test(rules)
   && /tier == 'free'/.test(rules) && /status == 'active'/.test(rules),
   'firestore.rules: a self-created doc must carry safe defaults (no self-upgrade at create)');
// Hardening (Martina review 2026-06-14): email pinned to the token + create
// restricts the field set, so a user can't forge their email (admin record) or
// inject adminLog / a forged deletedAt at birth.
ok(/request\.resource\.data\.email\.lower\(\) == request\.auth\.token\.email\.lower\(\)/.test(rules),
   'firestore.rules: email is pinned to the auth token (no forged email on create/update)');
ok(/request\.resource\.data\.keys\(\)\.hasOnly\(\[/.test(rules),
   'firestore.rules: create restricts the field set (no injected fields / forged deletedAt at birth)');
// Default-deny catch-all.
ok(/match \/\{document=\*\*\}\s*{\s*allow read, write:\s*if false;/.test(rules),
   'firestore.rules: default-deny catch-all for unmatched paths');
// Activity append-only.
const activityBlock = rules.match(/match \/activity\/\{eventId\}\s*{[\s\S]*?}/)?.[0] || '';
ok(/allow update, delete:\s*if false;/.test(activityBlock),
   'firestore.rules: activity log is append-only (no update/delete)');

// ---------------------------------------------------------------------------
// 2. DB module — client stays within the rules.
// ---------------------------------------------------------------------------
ok(/getFirestore\(app\)/.test(db),
   'firebase-db.js: Firestore is bound to the passed-in (shared) app');
ok(/tier: 'free'/.test(db) && /status: 'active'/.test(db)
   && /profileComplete: isProfileComplete\(profile\)/.test(db),
   'firebase-db.js: new account seeds safe defaults (free / active) + computed profileComplete');
// The returning-user update path must NOT write tier or status.
const updateCall = db.match(/await updateDoc\(ref,\s*{[\s\S]*?}\);/)?.[0] || '';
ok(updateCall.length > 0 && !/\btier\b/.test(updateCall) && !/\bstatus\b/.test(updateCall),
   'firebase-db.js: the sign-in refresh never rewrites tier / status');

// saveProfileFields (Profile editor + completion gate) writes ONLY the owner-
// writable profile fields + profileComplete — never tier/status.
const saveFn = db.match(/export async function saveProfileFields[\s\S]*?\n}/)?.[0] || '';
ok(saveFn.length > 0 && /company:/.test(saveFn) && /position:/.test(saveFn)
   && /contactNumber:/.test(saveFn) && /profileComplete: isProfileComplete\(fields\)/.test(saveFn),
   'firebase-db.js: saveProfileFields writes the profile fields + recomputed profileComplete');
ok(saveFn.length > 0 && !/\btier\b/.test(saveFn) && !/\bstatus\b/.test(saveFn),
   'firebase-db.js: saveProfileFields never writes tier / status (owner-write boundary)');

// ---------------------------------------------------------------------------
// 3. auth-gate wiring.
// ---------------------------------------------------------------------------
ok(/import \{[^}]*\binitDb\b[^}]*\bupsertAccountOnSignIn\b[^}]*\} from '\.\/firebase-db\.js'/.test(authGate),
   'auth-gate.js: imports the DB foundation');
ok(/initDb\(app\)/.test(authGate),
   'auth-gate.js: initialises Firestore on the shared app instance');
ok(/upsertAccountOnSignIn\(user, pendingSignupProfile\)/.test(authGate),
   'auth-gate.js: seeds / refreshes the account doc in the boot funnel (afterTerms)');
// The sign-up profile must be captured BEFORE createUserWithEmailAndPassword —
// otherwise onAuthStateChanged → afterTerms can run first, see an empty profile,
// and ask for the fields a second time on the completion gate.
const seedIdx = authGate.indexOf('pendingSignupProfile = prof.values;');
const createIdx = authGate.indexOf('createUserWithEmailAndPassword(auth, email, pass)');
ok(seedIdx !== -1 && createIdx !== -1 && seedIdx < createIdx,
   'auth-gate.js: sign-up profile is captured BEFORE account creation (no double-ask race)');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll Firestore-foundation tripwire assertions passed.');
