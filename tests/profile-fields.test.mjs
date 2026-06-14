// Profile-field validation regression test (v=822, 2026-06-14, Phase 1).
//
// Guards js/auth/profile-fields.js — the SINGLE validator shared by the sign-up
// form, the completion gate, and the in-app Profile editor. If these drift,
// the three surfaces disagree on what "valid" means.
//
// Pins: company/position need ≥2 chars; contact number is LOOSE (strip
// spaces/-/()/. then require optional + and ≥6 digits — no country format);
// validateProfileGroup aggregates with field keys matching the Firestore doc
// (company / position / contactNumber).
//
// Run: node tests/profile-fields.test.mjs

import { validateProfileField, validateProfileGroup, PROFILE_FIELDS, PROFILE_LIMITS }
  from '../js/auth/profile-fields.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// Keys match the Firestore account-doc fields (no renaming at the data layer).
ok(JSON.stringify(PROFILE_FIELDS) === JSON.stringify(['company', 'position', 'contactNumber']),
   'PROFILE_FIELDS are company / position / contactNumber (match the account doc)');
ok(PROFILE_LIMITS.company === 120 && PROFILE_LIMITS.position === 80 && PROFILE_LIMITS.contactNumber === 32,
   'PROFILE_LIMITS set per field');

// company / position — ≥2 trimmed chars.
ok(validateProfileField('company', '') !== null, 'company: empty is invalid');
ok(validateProfileField('company', ' a ') !== null, 'company: 1 char is invalid');
ok(validateProfileField('company', 'Arup') === null, 'company: valid name passes');
ok(validateProfileField('position', '') !== null, 'position: empty is invalid');
ok(validateProfileField('position', 'Acoustic consultant') === null, 'position: valid title passes');

// contact number — loose phone.
ok(validateProfileField('contactNumber', '') !== null, 'contact: empty is invalid');
ok(validateProfileField('contactNumber', '+60 12-345 6789') === null, 'contact: +country with spaces/dashes passes');
ok(validateProfileField('contactNumber', '(03) 1234 5678') === null, 'contact: parens + spaces passes');
ok(validateProfileField('contactNumber', '0123456') === null, 'contact: 7 plain digits passes');
ok(validateProfileField('contactNumber', '12345') !== null, 'contact: <6 digits is invalid');
ok(validateProfileField('contactNumber', 'call me') !== null, 'contact: non-numeric is invalid');
ok(validateProfileField('contactNumber', '+12 34x 567') !== null, 'contact: a stray letter is invalid');

// Aggregate.
const good = validateProfileGroup((n) => ({ company: 'Arup', position: 'Consultant', contactNumber: '+60123456789' }[n]));
ok(good.ok === true && good.values.contactNumber === '+60123456789',
   'validateProfileGroup: all-valid → ok with trimmed values');
const bad = validateProfileGroup((n) => ({ company: 'A', position: '', contactNumber: 'x' }[n]));
ok(bad.ok === false && bad.errors.company && bad.errors.position && bad.errors.contactNumber,
   'validateProfileGroup: reports an error per invalid field');
// Trimming.
const trimmed = validateProfileGroup((n) => ({ company: '  Müller-BBM  ', position: ' Engineer ', contactNumber: ' 0123456 ' }[n]));
ok(trimmed.values.company === 'Müller-BBM' && trimmed.values.position === 'Engineer',
   'validateProfileGroup: trims surrounding whitespace');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll profile-field assertions passed.');
