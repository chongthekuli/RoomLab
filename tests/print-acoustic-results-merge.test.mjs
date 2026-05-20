// Print-report merged-page label guard.
//
// 2026-05-20: the three pages "Chapter 02 Reverberation",
// "Appendix B Listener and zone schedule", and "Chapter 03 Precision
// results" were merged into a single A4 portrait page "Chapter 02
// Acoustic results" (js/ui/print-report.js — search for
// `acousticResultsPage`). The merge had to preserve every
// physics-meaningful label across the three source pages — Dr. Chen's
// "no data thrown" floor — and Maya's joined listener × precision
// table demands em-dash for missing precision cells (NOT 0; STI = 0 is
// undefined per IEC 60268-16, ambiguous with "ray missed receiver").
//
// This test text-greps print-report.js to assert every label that
// must appear in the merged page survives a future refactor. Style
// matches tests/scene-x-mirror.test.mjs (also a text-grep regression
// guard, sanctioned in CLAUDE.md §6 "Open bugs / convention mismatches"
// — the empirical-fix-with-grep pattern). When a label dies in a
// refactor the grep fails fast at PR time instead of in a print job
// the user only notices at submission day.
//
// Add a new entry when adding new content to acousticResultsPage that
// must not be silently dropped; remove an entry only when intentionally
// deprecating the label and Dr. Chen has signed off.

import { readFileSync } from 'node:fs';

const src = readFileSync('js/ui/print-report.js', 'utf8');

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

function present(needle, why) {
  assert(src.includes(needle), `merged-page preserves "${needle}" (${why})`);
}

// ---- Block 1: chapter opener (replaces 2 of the old 3 openers) -----
present('<span class="pr-chapter-number-ghost">02</span>',
  'ghost number 02 on merged page (was on Reverberation page)');
present('<h2>Acoustic results</h2>',
  'h2 title is "Acoustic results" (merges Reverberation + Precision results)');

// Renumbering: Chapter 04 Acoustic treatment became Chapter 03.
present('<span class="pr-chapter-number-ghost">03</span>',
  'treatment chapter renumbered 04 → 03 (ghost)');
present('<span class="pr-eyebrow">Chapter 03</span>',
  'treatment chapter renumbered 04 → 03 (eyebrow)');
present('Fig. 03.1',
  'treatment compare-chart caption renumbered Fig. 04.1 → Fig. 03.1');

// Make sure the OLD chapter openers do not linger.
assert(!src.includes('<h2>Reverberation</h2>'),
  'old "Reverberation" h2 deleted (was Chapter 02 standalone)');
assert(!src.includes('<h2>Precision results</h2>'),
  'old "Precision results" h2 deleted (was Chapter 03 standalone)');
assert(!src.includes('Appendix B · Listener and zone schedule'),
  'old "Appendix B · Listener and zone schedule" eyebrow deleted');

// ---- Block 2: STI headline + tier strip (lifted from Precision page) ----
present('Limiting listener — STI · IEC 60268-16',
  'STI headline label (the sign-off number a reviewer scans for first)');
present('< 0.45 fail',     'STI tier strip — BS 5839-8 floor band');
present('0.45 – 0.50 marginal', 'STI tier strip — marginal band');
present('≥ 0.50 pass',     'STI tier strip — IEC 60849 emergency-PA threshold');
present('IEC 60849 emergency-PA threshold',
  'standards-citation advisory (regulatory, not opinion)');
present('BS 5839-8 floor (0.45)',
  'BS 5839-8 advisory wording for marginal tier');

// ---- Block 3: RT60 chart + room KV (verbatim from old Reverberation) ----
present('Fig. 02.1 — Octave-band reverberation time per ISO 3382-1',
  'RT60 chart caption — ISO 3382-1 standard cited');
present('ISO 9613-1 air absorption',
  'ISO 9613-1 air-absorption citation in chart caption');
present('Beranek volume heuristic',
  'Beranek target-band citation in chart caption');
present('Eyring solid, Sabine dotted',
  'chart legend cue (which series is which)');
present('<tr><th>Volume</th>',
  'KV row: Volume (load-bearing for Sabine + Eyring denominators)');
present('<tr><th>Total surface</th>',
  'KV row: Total surface S (load-bearing for Σαᵢ Sᵢ)');
present('<tr><th>Mean α (1 kHz)</th>',
  'KV row: mean α at 1 kHz (triggers Sabine-vs-Eyring divergence above 0.2)');
present('<tr><th>r_c (critical)</th>',
  'KV row: critical distance r_c (Dr. Chen top-3 must-stay-prominent)');
present('<tr><th>f_s (Schroeder)</th>',
  'KV row: Schroeder cutoff f_s (modal-region boundary)');
present('<tr><th>Ceiling</th>',
  'KV row: ceiling type (informs absorption assumptions)');

// ---- Block 4: joined listener × precision table -----------------------
present('Listener positions × ray-traced results',
  'joined-table heading (the user-flagged consolidation)');
present('<th>Listener</th><th>X</th><th>Y</th><th>Elev</th><th>T30</th><th>C50</th><th>C80</th><th>D/R</th><th>STI</th>',
  'joined-table 9-column header — Maya spec (dropped ID, posture, ear-height)');
present('pr-listener-precision',
  'joined-table class hook for CSS targeting');
present('pr-listener-posture',
  'posture parenthetical span — Maya: posture is a label qualifier, not its own column');
present(`Ear height = elev + 1.60 m standing / 1.15 m sitting in chair / 0.85 m sitting on floor`,
  'ear-height formula footnote (matches POSTURE_EAR_HEIGHTS_M in app-state.js)');
present('Em-dash "—" indicates the precision render did not cover this listener',
  'Dr. Chen empty-cell semantics: — never 0 (STI = 0 is undefined per IEC 60268-16)');
// Em-dash must appear as an actual character — used both for KV r_c/f_s
// fallback and for joined-table broadband cells when precision is null.
present(`'—'`, 'em-dash literal present for missing-data sentinel');

// Empty listener fallback (when no listeners are placed at all).
present('No listeners placed. Listener positions drive the per-receiver STI calculation.',
  'empty-listener guidance copy preserved');

// ---- Block 5: paired band tables -----------------------------------
present('RT60 per band — diffuse-field draft',
  'left paired-table heading (Sabine/Eyring draft)');
present('T30 per band — ray-traced',
  'right paired-table heading (precision ground truth)');
present('<th>Band</th><th>Sabine</th><th>Eyring</th><th>Mean α</th>',
  'RT60-per-band 4-col header (unchanged)');
present('pr-band-pair-grid',
  'paired-table grid container — Maya: visual rhyme between Eyring & ray-traced T30');
present('Sabine assumes a diffuse field; Eyring corrects for high mean absorption',
  'Sabine/Eyring caveat paragraph preserved');
present('Σαᵢ Sᵢ',
  'Σαᵢ Sᵢ notation in S-caption (Dr. Chen: S is the intermediate, methodology trace)');
present('supersedes the diffuse-field draft for sign-off',
  'precision-supersedes-draft note (provenance per Dr. Chen)');

// ---- Block 6: footer (zones + ambient strip) -----------------------
present('Audience zones (', 'zones footer eyebrow (n count interpolated)');
present('No audience zones defined. Add a zone via the Zones panel',
  'empty-zones guidance preserved');
present('Ambient noise · ',
  'ambient-noise footer eyebrow (NC preset interpolated)');
present('pr-bandstrip',
  'ambient band-strip "fingerprint" element preserved (the N term in STIPA)');
present('pr-footer-grid',
  'footer 2-col grid layout class');

// ---- Test 3: Treatment chapter (renumbered 04 → 03) ----------------
// Already covered above; no additional asserts needed.

// ---- Removed-functions guard ---------------------------------------
// Old standalone renderPrecisionSection is replaced by inline logic in
// the merged page; the function declaration must be gone (its STI
// finite-guard at the OLD line 2070 is now in acousticResultsPage's
// stiHeadline IIFE).
assert(!src.includes('function renderPrecisionSection'),
  'old renderPrecisionSection function removed (inlined into merged page)');

// ---- STI finite-guard (Dr. Chen: must not regress) -----------------
// The limiting-listener calculation MUST filter out non-finite STI
// values so a listener with no precision coverage cannot contaminate
// the limiting-STI calculation.
present('.filter(v => Number.isFinite(v))',
  'finite-STI filter present (was at old line 2070, now in stiHeadline IIFE)');

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll merged-page label-preservation tests passed.');
