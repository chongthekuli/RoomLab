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
// 2026-05-20 v=557 revision (Maya): user flagged the room-geometry KV
// table on this page (Shape · W×D×H · Floor area · Volume · Total
// surface · Mean α @ 1 kHz · Ceiling · r_c · f_s) as fully redundant
// with the cover measurements card and Drawing 01 tile grid. KV
// dropped; chart promoted to full-row hero; STI headline bumped 28pt
// → 40pt with hairline rules above/below; two paired band tables
// collapsed into one 5-col consolidated table (Band · Mean α · Sabine
// · Eyring · Ray-traced T30 mean (min–max)). Asserts updated below to
// match — the OLD KV-row + paired-table strings are now blacklisted.
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
const css = readFileSync('css/print.css', 'utf8');

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

function present(needle, why) {
  assert(src.includes(needle), `merged-page preserves "${needle}" (${why})`);
}
function presentCss(needle, why) {
  assert(css.includes(needle), `print.css carries "${needle}" (${why})`);
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
present('pr-sti-rt60-row',
  'STI + RT60 side-by-side row container (v=559 compression — '
  + 'replaced the v=557 pr-sti-frame stacked-with-pr-rt60-hero pair)');
present('pr-sti-cell',
  'STI cell (~30% / 60 mm wide) — vertical stack inside the narrow column');
present('pr-rt60-cell',
  'RT60 chart cell (~70% / ~134 mm wide) — chart on top, caption below');
presentCss('font-size: 40pt',
  'STI accent number promoted to 40 pt (v=557, was 28 pt) — page-opening statement');
presentCss('pr-sti-rt60-row',
  'STI+RT60 row CSS rule (v=559 — replaces pr-sti-frame + pr-rt60-hero)');
presentCss('pr-sti-cell',
  'STI cell CSS rule (carries --paper-2 bar background)');
presentCss('pr-rt60-cell',
  'RT60 cell CSS rule (chart + caption stacked)');
presentCss('pr-band-consolidated',
  'consolidated 5-col band-table CSS rule');

// v=559 retired classes — must NOT come back in a refactor without
// reviewer thought. pr-sti-frame stacked over pr-rt60-hero was the
// v=557 layout; user explicitly asked to compress them into one row.
assert(!src.includes('pr-sti-frame'),
  'v=557 stand-alone STI frame class removed (now inside pr-sti-rt60-row)');
assert(!src.includes('pr-rt60-hero'),
  'v=557 stand-alone RT60 hero class removed (now inside pr-sti-rt60-row)');
// Match the SELECTOR (class followed by space + `{` or `,`), not the
// prose mentions of the name inside header comments — the change log
// references both classes by name and that's allowed.
assert(!/\.pr-sti-frame\s*[,{]/.test(css),
  'pr-sti-frame CSS selector removed (rule body gone)');
assert(!/\.pr-rt60-hero\s*[,{]/.test(css),
  'pr-rt60-hero CSS selector removed (rule body gone)');

// ---- Block 3: RT60 chart full-row hero (v=557 — KV column dropped) ----
present('Fig. 02.1 — Octave-band reverberation time per ISO 3382-1',
  'RT60 chart caption — ISO 3382-1 standard cited');
present('ISO 9613-1 air absorption',
  'ISO 9613-1 air-absorption citation in chart caption');
present('Beranek volume heuristic',
  'Beranek target-band citation in chart caption');
present('Eyring solid, Sabine dotted',
  'chart legend cue (which series is which)');
present('Geometric metadata (Volume, Surface area, r_c, f_s) carried on the cover and Drawing 01',
  'caption signposts where the dropped KV-table figures live now');
// (Note: pr-rt60-hero was the v=557 class for the full-row chart block;
//  in v=559 it was absorbed into pr-sti-rt60-row alongside the STI cell.
//  The pr-rt60-cell + pr-sti-cell presence asserts above cover the new
//  class graph.)

// KV-table redundancy guard (v=557): these rows MUST NOT come back on
// the merged page — they already live on the cover + Drawing 01 tile
// grid, and the user flagged them as duplication. If a future refactor
// re-introduces the .pr-kv table inside the merged page, these asserts
// fail and force the reviewer to think about it.
function absent(needle, why) {
  assert(!new RegExp(
    `acousticResultsPage[\\s\\S]*?${needle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[\\s\\S]*?<\\/div>\\\`;`
  ).test(src), `merged page does NOT carry "${needle}" (${why})`);
}
absent('<tr><th>Shape</th>',
  'KV row "Shape" duplicates cover measurements card');
absent('<tr><th>W × D × H</th>',
  'KV row "W × D × H" duplicates cover measurements card');
absent('<tr><th>Volume</th>',
  'KV row "Volume" duplicates cover + Drawing 01 tile grid');
absent('<tr><th>Total surface</th>',
  'KV row "Total surface" duplicates cover + Drawing 01 tile grid');
absent('<tr><th>Floor area</th>',
  'KV row "Floor area" duplicates cover + Drawing 01 tile grid');
absent('<tr><th>Mean α (1 kHz)</th>',
  'KV row "Mean α (1 kHz)" duplicates Drawing 01 tile grid');
absent('<tr><th>r_c (critical)</th>',
  'KV row "r_c (critical)" duplicates Drawing 01 tile grid');
absent('<tr><th>f_s (Schroeder)</th>',
  'KV row "f_s (Schroeder)" duplicates Drawing 01 tile grid');
absent('<tr><th>Ceiling</th>',
  'KV row "Ceiling" not load-bearing on this page (ceiling absorption '
  + 'lives in the methodology α matrix)');

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

// ---- Block 5: consolidated band table (v=557) ------------------------
// Collapsed from the two paired side-by-side tables (per Maya: the
// per-receiver × per-band T30 matrix was power-user detail that the
// broadband T30 column in the joined table already covers for 90% of
// reading). Now ONE row per band with Sabine + Eyring as theoretical
// bounds bracketing the ray-traced ground truth (mean (min–max)).
present('Per-band reverberation — diffuse-field bounds versus ray-traced ground truth',
  'consolidated band-table h3 (replaces "RT60 per band" + "T30 per band" pair)');
present('<th>Band</th><th>Mean α</th><th>Sabine RT60</th><th>Eyring RT60</th><th>Ray-traced T30 — mean (min–max)</th>',
  'consolidated band-table 5-col header');
present('pr-band-consolidated',
  'consolidated band-table class hook');
present('pr-band-range',
  '(min–max) span class — muted secondary read, surfaces per-listener spread');
present('Sabine assumes a diffuse field; Eyring corrects for high mean absorption',
  'Sabine/Eyring caveat paragraph preserved');
present('Σαᵢ Sᵢ',
  'Σαᵢ Sᵢ notation preserved in S-caption (Dr. Chen: S is the methodology trace)');
present('supersedes Sabine/Eyring for sign-off when present',
  'precision-supersedes-draft note preserved (provenance per Dr. Chen)');

// v=557 retired classes — must NOT come back without reviewer thought.
assert(!src.includes('pr-band-pair-grid'),
  'old paired-band-tables grid class removed (collapsed to one consolidated table)');
assert(!src.includes('pr-band-pair-cell'),
  'old paired-band cell class removed');
assert(!src.includes('pr-rt60-grid'),
  'old RT60-chart+KV 2-col grid class removed (chart is full-row hero now)');
assert(!src.includes('pr-rt60-kv-wrap'),
  'old RT60-chart KV wrapper class removed');

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
