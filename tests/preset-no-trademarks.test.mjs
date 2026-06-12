// Preset trademark / real-venue scrub regression test (v=813, 2026-06-12).
//
// The four full-build presets once carried real company trademarks and real
// venue names in user-visible strings (3D storefront signs, listener labels)
// and in source comments — legal exposure in a PUBLIC repo. They were
// genericised at v=813:
//   • pavilion.js  — ~34 real retail brands → invented generic store names;
//                    listener labels (Food Republic / Parkson / Tokyo Town /
//                    TGV / Harvey Norman) → generic equivalents.
//   • google-datacenter.js — display label "Google Data Center" → "Hyperscale
//                    Data Center" (the internal registry key `googleDataCenter`
//                    and filename stay — source-only, never displayed).
//   • auditorium.js — "University of Wyoming Arena-Auditorium" → generic dome.
//   • surau.js      — real military camp / regiment / consultancy / drawing
//                    numbers / two named mosques → generic community surau.
// Code comments naming the same trademarks (app-state.js, scene.js) and the
// arena design doc were scrubbed too.
//
// Text-grep (not behavioural): the regressable surface is "someone re-adds a
// real brand to BRANDS, restores a real venue name in a comment, or copies an
// old preset back in." A static audit pins it.
//
// Allowed exceptions (NOT flagged): the internal registry key
// `googleDataCenter` and the `google-datacenter.js` filename (source-only);
// real Google-Sites-embed / Google-sign-in / Firebase infrastructure
// references in js/auth, js/io, js/capture (functional, not flavour);
// the catalogue product/model names Amperes / QD2100 / CS520 / CS610B / HS880
// (legitimate vendor catalogue items the app actually uses).
//
// Run: node tests/preset-no-trademarks.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const pavilion   = readFileSync('./js/presets/pavilion.js', 'utf8');
const dataCenter = readFileSync('./js/presets/google-datacenter.js', 'utf8');
const auditorium = readFileSync('./js/presets/auditorium.js', 'utf8');
const surau      = readFileSync('./js/presets/surau.js', 'utf8');
const appState   = readFileSync('./js/app-state.js', 'utf8');
const scene      = readFileSync('./js/graphics/scene.js', 'utf8');

const PRESET_SOURCES = [
  ['pavilion.js', pavilion],
  ['google-datacenter.js', dataCenter],
  ['auditorium.js', auditorium],
  ['surau.js', surau],
];

// ---- 1. Banned real trademarks / venues must NOT appear in preset sources ----
// Word-boundary-anchored so a banned token can't hide inside a generic name.
// '&'-bearing brands matched literally (word boundaries don't help around '&').
const BANNED = [
  // Retail brands (former pavilion.js BRANDS list)
  'H&M', 'Uniqlo', 'Zara', 'Starbucks', 'Apple', 'Samsung', 'Nike', 'Adidas',
  'Charles & Keith', 'Pomelo', 'Sephora', 'Chatime', 'Coach',
  'Michael Kors', 'Timberland', 'Padini', 'Watsons',
  'Guardian', 'Sushi King', 'KFC', 'Pizza Hut', 'Secret Recipe',
  'Kinokuniya', 'Toys R Us', 'Pandora', 'Swatch',
  // Real venue / tenant labels (former pavilion.js listeners)
  'Food Republic', 'Parkson', 'Tokyo Town', 'TGV', 'Harvey Norman',
  // Real company used as preset flavour (data-center)
  'Google Data Center', 'Google Data Centre',
  // Real arena (auditorium.js)
  'University of Wyoming', 'Wyoming', 'Arena-Auditorium',
  // Real military camp / regiment / consultancy / mosques (surau.js)
  'Askar Wataniah', 'Sri Tembila', 'Rejimen', 'Perunding NZZ',
  'Pavilion 2 Bukit Jalil', 'Bukit Jalil',
  'Al-Firdaus', 'Al-Wataniah', 'Pasir Panjang',
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Word-boundary where the token starts/ends with a word char; '&' tokens go literal.
function bannedRe(token) {
  const esc = escapeRe(token);
  const lead  = /^[A-Za-z0-9]/.test(token) ? '\\b' : '';
  const trail = /[A-Za-z0-9]$/.test(token) ? '\\b' : '';
  return new RegExp(`${lead}${esc}${trail}`);
}

for (const [file, src] of PRESET_SOURCES) {
  for (const token of BANNED) {
    ok(!bannedRe(token).test(src), `${file}: does not contain "${token}"`);
  }
}

// ---- 2. Code comments scrubbed of the two trademark proper nouns ------------
ok(!/Pavilion 2/.test(appState) && !/Bukit Jalil/.test(appState),
   'app-state.js comments: no "Pavilion 2 Bukit Jalil"');
ok(!/Google Data Cent(?:er|re)/.test(appState),
   'app-state.js comments: no "Google Data Center"');
ok(!/Pavilion 2/.test(scene) && !/Bukit Jalil/.test(scene),
   'scene.js comments: no "Pavilion 2"');
ok(!/Google Data Cent(?:er|re)/.test(scene),
   'scene.js comments: no "Google Data Center"');

// ---- 3. Positive checks: the generic replacements are actually present ------
// (Guards against an over-zealous revert that empties the scene instead of
// genericising it.)
ok(/const BRANDS = \[/.test(pavilion) && /'Fashion Hub'/.test(pavilion),
   'pavilion.js: BRANDS array still present, populated with generic names');
ok((pavilion.match(/'[^']+'/g) || []).length > 0,
   'pavilion.js: BRANDS is a non-empty string array (render rotates BRANDS[idx % len])');
ok(/'GF — Food court'/.test(pavilion),
   'pavilion.js: L3 listener relabelled to generic "GF — Food court"');
ok(/'GF — Department store entrance'/.test(pavilion),
   'pavilion.js: L4 listener relabelled to generic department-store entrance');
ok(/'L1 — Themed dining precinct'/.test(pavilion),
   'pavilion.js: L7 listener relabelled to generic themed-dining precinct');
ok(/'L2 — Cinema lobby'/.test(pavilion),
   'pavilion.js: L8 listener relabelled to generic cinema lobby');
ok(/'L3 — Electronics store'/.test(pavilion),
   'pavilion.js: L10 listener relabelled to generic electronics store');

// ---- 4. Internal registry key / display label invariants --------------------
// The internal key + filename keep "google" (source-only, never shown); the
// DISPLAY label must be the generic one.
ok(/label:\s*'Hyperscale Data Center'/.test(dataCenter),
   'google-datacenter.js: display label is the generic "Hyperscale Data Center"');
ok(/label:\s*'Shopping Mall \(4-level\)'/.test(pavilion),
   'pavilion.js: display label is the generic "Shopping Mall (4-level)"');
ok(/label:\s*'Sports arena \(dome\)'/.test(auditorium),
   'auditorium.js: display label is the generic "Sports arena (dome)"');

// ---- 5. Listener id stability — only labels changed, ids untouched ----------
// (Changing an id would break saved scenes / per-listener report references.)
for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11']) {
  ok(new RegExp(`id:\\s*'${id}'`).test(pavilion), `pavilion.js: listener id '${id}' preserved`);
}

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll preset trademark-scrub assertions passed.');
