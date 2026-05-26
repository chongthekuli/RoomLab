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
present('Limiting listener · IEC 60268-16',
  'STI headline eyebrow (the sign-off number a reviewer scans for first)');
present('<div class="pr-precision-sti-metric">STI</div>',
  'v=560 "STI" metric tag — names the 54 pt number so a reader knows it is the Speech Transmission Index');
presentCss('pr-precision-sti-metric',
  'STI metric-tag CSS rule (uppercase, bold, white on accent)');
presentCss('font-size: 54pt',
  'STI number enlarged 40 pt → 54 pt (v=560, user: "enlarge the STI number")');

// v=561 print-bug guard: the STI cell carries an --accent background
// with WHITE text. Chromium strips background fills on print by default
// ("save ink") — so .pr-sti-cell MUST be in the print-color-adjust:exact
// opt-in list, or the white text reverses to white-on-white and the STI
// number vanishes (exactly the v=560 → v=561 regression the user hit).
// This assert pins the cell INTO that list.
{
  // .pr-sti-cell must sit in SOME print-color-adjust:exact selector list.
  // (v=562: there are now several exact blocks — the running-header logo
  // and cover nameplate added their own — so scan ALL occurrences, not
  // just the first, and pass if the cell precedes any of them.)
  let inExactList = false;
  let from = 0;
  for (;;) {
    const idx = css.indexOf('print-color-adjust: exact', from);
    if (idx < 0) break;
    const preceding = css.slice(Math.max(0, idx - 900), idx);
    if (/\.pr-sti-cell\s*[,{]/.test(preceding)) { inExactList = true; break; }
    from = idx + 1;
  }
  assert(inExactList,
    'pr-sti-cell is in the print-color-adjust:exact opt-in list '
    + '(else its --accent background is stripped on print → white STI text on white = invisible)');
}
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
  'RT60 chart cell (~70% / ~134 mm wide) — title + chart + caption');
present('Reverberation · RT60 per octave band',
  'v=560 chart title — names the curves so a reader knows they are RT60');
presentCss('pr-rt60-title',
  'RT60 chart-title CSS rule (v=560)');
presentCss('pr-sti-rt60-row',
  'STI+RT60 row CSS rule (v=559 — replaces pr-sti-frame + pr-rt60-hero)');
presentCss('pr-sti-cell',
  'STI cell CSS rule (v=560 — brand accent background, white reverse)');
presentCss('pr-rt60-cell',
  'RT60 cell CSS rule (title + chart + caption stacked)');
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
present('Fig. 02.1 — Octave-band reverberation per ISO 3382-1',
  'RT60 chart caption — ISO 3382-1 standard cited');
present('ISO 9613-1 air absorption',
  'ISO 9613-1 air-absorption citation in chart caption');
present('Beranek volume heuristic',
  'Beranek target-band citation in chart caption');
present('Eyring solid, Sabine dotted, T30 ochre; plotted numeric values label',
  'chart legend cue in caption (which series is which, + which series the value labels ride) — v=568 T30-labelled');
present('Geometric metadata (Volume, Surface area, r_c, f_s) carried on the cover and Drawing 01',
  'caption signposts where the dropped KV-table figures live now');
// v=562 — RT60 chart gained two series (ray-traced T30 mean + Mean α on a
// secondary right axis) and an HTML legend moved out of the plot interior.
present('pr-rt60-legend',
  'RT60 chart HTML legend block (moved out of the plot for the 4-series version)');
present('Mean α (right axis)',
  'legend names the secondary-axis α series (Dr. Chen: α must read as the other axis)');
present('Ray-traced T30',
  'legend names the ray-traced T30 series');
present('ISO 3382-1 §A.2.2',
  'caption cites the Schroeder T30 method for the ray-traced series (Dr. Chen condition 2)');
present('the ray-traced T30 mean supersedes both for sign-off when present',
  'v=562 — sign-off-supersedes message relocated from the now-hidden band table into the caption');
presentCss('pr-band-section',
  'v=562 — per-band consolidated table hidden (display:none); messages folded into Fig. 02.1 caption');
present('Area-weighted mean absorption α̅ (surface-only — the dominant term in, not sole driver of',
  'caption qualifies α̅ as dominant-term-not-sole-driver (Dr. Chen condition 5: α̅ excludes the air term)');
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
// v=563 — ambient NC strip relocated from the footer's right cell INTO
// the red STI accent card (pinned to its bottom edge), restyled
// white-on-accent. The footer collapses to a single full-width zones
// cell. Assert the new composition, not the old footer eyebrow.
present('Ambient · ',
  'ambient eyebrow inside STI card (NC preset + dB/oct unit interpolated)');
present('pr-sti-ambient',
  'ambient block lives inside the STI accent card (v=563)');
present('pr-bandstrip-onaccent',
  'on-accent band-strip variant (white-on-red, no label cell)');
assert(/\.pr-bandstrip-onaccent\s+\.pr-bandstrip-cell-band\s*\{[^}]*white-space:\s*nowrap/.test(css),
  'on-accent band labels are single-line (white-space:nowrap) so "125 HZ" does not wrap and all 7 values sit on one horizontal baseline (v=570)');
present('pr-bandstrip',
  'ambient band-strip "fingerprint" element preserved (the N term in STIPA)');
assert(!src.includes('class="pr-bandstrip-label"'),
  'footer NC-preset label cell dropped (no room across the 60 mm card column)');
present('pr-footer-grid',
  'footer grid layout class retained (now single-column zones)');

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

// ---- Running-header de-duplication (v=571, user: "repeating the title
// is weird") — the page title lives ONCE, in the running header, not
// echoed by an in-content eyebrow/h2 just below it. ------------------
present('data-running-title="Appendix A · Equipment schedule"',
  'equipment page carries the full appendix title in the running header');
assert(!src.includes('<span class="pr-eyebrow">Appendix A · Equipment schedule</span>'),
  'duplicate "Appendix A · Equipment schedule" eyebrow removed (was echoing the running header)');
present('data-running-title="Methodology, Standards & Disclaimers"',
  'methodology page carries its full title in the running header');
assert(!src.includes('<h2 class="pg-page-title">Methodology, Standards'),
  'duplicate methodology page-title h2 removed (was echoing the running header)');
// The running-header eyebrow selector must carry .pr-running-header-rule
// (specificity 1,3,0) so page-scoped `.pr-page-appendix .pr-eyebrow` /
// `.pr-page-plan .pr-eyebrow` (1,2,0) can't lift the title off the rule —
// the running title sits flush on the line on EVERY page (v=572).
presentCss('.pr-running-header .pr-running-header-rule .pr-eyebrow',
  'running-header eyebrow rule out-specifies page-scoped eyebrow rules (title flush to rule on all pages)');
// Comfort gap below the rule on the opener-less pages (appendix +
// methodology) so their first content isn't cramped against the line.
// Appendix uses the running-header sibling rule; methodology sets it on
// .pg-intro directly (the .pg-prose shorthand would otherwise zero it).
presentCss('.pr-page-appendix > .pr-running-header + *',
  'comfort spacing below the running-header rule on the appendix page (BILL OF MATERIALS not cramped against the line, v=572)');
assert(/\.pg-methodology\s+\.pg-intro\s*\{[^}]*margin-top:\s*7mm/.test(css),
  'methodology intro carries margin-top so it clears the running-header rule (v=573 — beats the .pg-prose margin:0 reset)');
// Methodology page prose is fully justified end-to-end (v=656, user
// request): wide blocks (intro / disclaimers / acceptance / reviewer)
// AND the narrow 4-col method-grid entry bodies all justify. The
// narrow columns can show some word-space gaps; hyphens:auto on
// .pg-prose (inherited) softens that.
assert(/\.pg-methodology\s+\.pg-prose\s*\{[^}]*text-align:\s*justify/.test(css),
  'methodology wide prose is justified (neat block edge)');
assert(/\.pg-methodology\s+\.pg-method-entry\s+\.pg-prose\s*\{[^}]*text-align:\s*justify/.test(css),
  'narrow 4-col method-grid bodies are also justified (v=656 user request — full-justify body prose across the report)');

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll merged-page label-preservation tests passed.');
