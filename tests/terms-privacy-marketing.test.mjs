// Terms-of-Use privacy clause + optional marketing-consent regression test
// (v=814, 2026-06-12).
//
// Pins three things that must not silently regress:
//   1. The login Terms of Use carries a Privacy clause (left red column).
//   2. A SEPARATE optional marketing-consent checkbox exists, is default
//      UNCHECKED, and does NOT gate sign-in (only #terms-accept-check gates
//      the auth buttons — GDPR / Malaysia PDPA: optional consent must never
//      block account creation, and a consent box must never be pre-ticked).
//   3. recordAcceptance() captures the marketingConsent boolean (default
//      false) without dropping any existing field — the PDF report reader
//      keys off named fields, so the addition must be purely additive.
//
// Parts 1-2 are text-grep: the gate is HTML + DOM event wiring that needs a
// browser to exercise. Part 3 is behavioural: terms-record.js's recordAcceptance
// is invoked here against stubbed sessionStorage / navigator / fetch globals,
// and the persisted record is asserted directly.
//
// The bug surface this guards: someone deletes the privacy point, pre-ticks
// the consent box, adds #marketing-consent-check to the terms gate (blocking
// sign-in), or drops marketingConsent from the record (losing the legal basis
// for the privacy clause's data-sharing exception).
//
// Run: node tests/terms-privacy-marketing.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const indexHtml = readFileSync('./index.html', 'utf8');
const authGate  = readFileSync('./js/auth/auth-gate.js', 'utf8');

// ---------------------------------------------------------------------------
// 1. Privacy clause in the Terms of Use (left column).
// ---------------------------------------------------------------------------
ok(/<strong>Privacy\.<\/strong>/.test(indexHtml),
   'index.html: Terms of Use carries a <strong>Privacy.</strong> point');
ok(/Personal data is not sold/.test(indexHtml),
   'index.html: privacy clause states personal data is not sold');
// Precise sharing exception — NOT a flat "never shared" that the marketing
// opt-in would contradict.
ok(/not shared with third parties except/.test(indexHtml),
   'index.html: privacy clause states a precise sharing EXCEPTION (not a flat never-shared)');
ok(/Firebase/.test(indexHtml),
   'index.html: privacy clause names the auth provider (Firebase) as the service-operation exception');
ok(/show or delete your account data/.test(indexHtml),
   'index.html: privacy clause offers access / deletion of account data');
// Operator-terms disclaimer — not a certified legal opinion.
ok(/not a certified legal opinion/.test(indexHtml),
   'index.html: copy clarifies these are the operator’s terms, not a certified legal opinion');

// ---------------------------------------------------------------------------
// 2. Optional marketing-consent checkbox — exists, optional, NOT pre-ticked,
//    NOT in the terms gate.
// ---------------------------------------------------------------------------
ok(/id="marketing-consent-check"/.test(indexHtml),
   'index.html: #marketing-consent-check exists');

// Default UNCHECKED: the input must NOT carry a `checked` attribute.
const consentInput =
  indexHtml.match(/<input[^>]*id="marketing-consent-check"[^>]*>/)?.[0] || '';
ok(consentInput.length > 0 && !/\bchecked\b/.test(consentInput),
   'index.html: #marketing-consent-check is NOT pre-ticked (no checked attribute)');

// Withdrawable + optional wording.
ok(/withdraw at any time/i.test(indexHtml),
   'index.html: consent label states it is withdrawable at any time');
ok(/Optional/.test(indexHtml),
   'index.html: consent label is marked Optional');
// Shares contact details with manufacturer partners (the lawful basis for the
// privacy clause's sharing exception — the two must stay consistent).
ok(/contact details to be shared with those partners/i.test(indexHtml),
   'index.html: consent label says contact details are shared with manufacturer partners');

// Same view-visibility pattern as the required checkbox (signin signup only).
ok(/class="auth-consent-check" data-views="signin signup"/.test(indexHtml),
   'index.html: consent checkbox uses data-views="signin signup" (shown on the same views as .auth-terms-check)');

// CRITICAL: the marketing checkbox must NOT gate sign-in. Only termsChecked
// (driven by #terms-accept-check) is allowed in the auth-button gate.
ok(/const need = currentView === 'signin' \|\| currentView === 'signup';/.test(authGate)
   && /const blocked = need && !termsChecked;/.test(authGate),
   'auth-gate.js: refreshTermsGate() blocks ONLY on termsChecked');
ok(!/marketing-consent-check[^]*?(disabled|blocked|termsBlocked)/.test(
      authGate.match(/function refreshTermsGate[\s\S]*?\n}/)?.[0] || ''),
   'auth-gate.js: refreshTermsGate() does NOT reference the marketing checkbox');
ok(!/marketing-consent-check/.test(
      authGate.match(/function termsBlocked[\s\S]*?\n}/)?.[0] || ''),
   'auth-gate.js: termsBlocked() does NOT reference the marketing checkbox');

// The marketing consent is READ at acceptance time and passed to record.
ok(/getElementById\('marketing-consent-check'\)\?\.checked === true/.test(authGate),
   'auth-gate.js: reads #marketing-consent-check state (default false if absent)');
ok(/marketingConsent: marketingConsentChecked\(\)/.test(authGate),
   'auth-gate.js: recordAndBoot passes marketingConsent into recordAcceptance');

// ---------------------------------------------------------------------------
// 3. Behavioural: recordAcceptance() carries marketingConsent, additively.
// ---------------------------------------------------------------------------
// Stub the browser globals recordAcceptance touches, then import the real
// module and exercise it.
const store = new Map();
// defineProperty (not plain assignment) — in modern Node `navigator`/`window`
// are read-only getters on globalThis, so a bare `globalThis.navigator = …`
// throws. Force-define them for the duration of the test.
function stub(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
stub('sessionStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
});
stub('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' });
stub('window', { screen: { width: 1920, height: 1080 } });
// Force the public-IP lookup to degrade fast (offline path), no network in CI.
stub('fetch', async () => { throw new Error('no network in test'); });

const { recordAcceptance, getAcceptanceRecord } =
  await import('../js/shared/terms-record.js');

// (a) consent opted IN.
store.clear();
const recIn = await recordAcceptance({ operatorName: 'Test User', marketingConsent: true });
ok(recIn.marketingConsent === true,
   'recordAcceptance({marketingConsent:true}) stores marketingConsent === true');
ok(recIn.operatorName === 'Test User' && recIn.acceptedAt && 'publicIp' in recIn
   && 'browser' in recIn && 'timezone' in recIn && 'screen' in recIn,
   'recordAcceptance: all existing fields preserved alongside marketingConsent');
ok(getAcceptanceRecord()?.marketingConsent === true,
   'getAcceptanceRecord() round-trips marketingConsent === true');

// (b) consent omitted → default false (never undefined / truthy by accident).
store.clear();
const recDefault = await recordAcceptance({ operatorName: 'Test User' });
ok(recDefault.marketingConsent === false,
   'recordAcceptance() with no marketingConsent arg defaults to false');

// (c) explicit false stays false.
store.clear();
const recOut = await recordAcceptance({ operatorName: 'Test User', marketingConsent: false });
ok(recOut.marketingConsent === false,
   'recordAcceptance({marketingConsent:false}) stores false');

// (d) non-boolean truthy values are coerced to a real boolean false (only
//     an explicit === true opts in — defensive against a stray string/1).
store.clear();
const recCoerce = await recordAcceptance({ operatorName: 'Test User', marketingConsent: 'yes' });
ok(recCoerce.marketingConsent === false,
   'recordAcceptance: non-true value ("yes") is coerced to false (only === true opts in)');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll terms privacy + marketing-consent assertions passed.');
