// Phase 5 Step 8c — Standards & method right-panel two-section stack (v=621).
//
// Maya's UX Decision 6 (2026-05-23) locked the right-panel restructure:
//
//   ─── EQUATION & METHOD ───  (mode-specific)
//     Mass-law eq + cite                            (mass-law mode)
//     Sharp three-region eq + f_mam/f_d + cite      (formula mode)
//     Measured-row note + source                    (catalogue mode)
//
//   ─── RATING (Rw) ───        (always shown when computable)
//     ISO 717-1 contour-shift explanation
//     Current shift value + Σ unfavourable
//     Rw + STC + C + Ctr inline
//     Cite: ISO 717-1:2020 §3.1 / §5 + ASTM E413-22 §5
//
// Both sections always visible (no accordion — Maya: "accordions hide
// load-bearing info"). When Rw is not computable, the second section
// surfaces the WHY in one sentence.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

const sim = read('js/labs/walllab/wall-sim.js');
const css = read('css/main.css');

// =============================================================================
// (1) Two-section stack — both sections always rendered, no accordion
// =============================================================================

check('isolationMethodHTML renders two <section class="wall-method-section">',
  /<section class="wall-method-section">/.test(sim) &&
  /<section class="wall-method-section wall-method-section-rating">/.test(sim));
check("section labels: 'Equation & method' and 'Rating (Rw)'",
  /Equation &amp; method/.test(sim) && /Rating \(Rw\)/.test(sim));
check('isolationMethodHTML signature carries tl + rating',
  /function isolationMethodHTML\(cat, meta, st, tl, rating, ctx/.test(sim));
check('renderIsolation passes tl + rating to isolationMethodHTML',
  /isolationMethodHTML\(cat, meta, st, tl, rating,/.test(sim));

// =============================================================================
// (2) Mode-specific EQUATION & METHOD branching
// =============================================================================

check('equationMethodHTML branches on cat.model',
  /function equationMethodHTML/.test(sim) &&
  /cat\.model === 'formula'.*formulaEquationHTML/s.test(sim) &&
  /cat\.model === 'catalogue'.*catalogueEquationHTML/s.test(sim));
check('massLawEquationHTML preserves the v=619 mass-law content',
  /function massLawEquationHTML/.test(sim) &&
  /TL = 20·log₁₀\(m·f\) − 47/.test(sim) &&
  /Beranek/.test(sim));
check('formulaEquationHTML shows Sharp three-region piecewise',
  /function formulaEquationHTML/.test(sim) &&
  /Sharp three-region/.test(sim) &&
  /Region&nbsp;I/.test(sim) && /Region&nbsp;II/.test(sim) && /Region&nbsp;III/.test(sim));
check('formulaEquationHTML shows current f_mam + f_d numerically',
  /f_mam\s*=\s*<strong>\$\{f_mam/.test(sim) &&
  /f_d\s*=\s*<strong>\$\{f_d/.test(sim));
check('formulaEquationHTML shows cavity-fill bonus dB based on st.cavity_fill',
  /st\.cavity_fill === 'fibrous_50mm'.*'\+5'/.test(sim) &&
  /st\.cavity_fill === 'reflective'.*'−3'/.test(sim));
check('formulaEquationHTML cites Sharp 1973 + Bies & Hansen Eq. 8.40/8.41a',
  /Sharp 1973/.test(sim) &&
  /Bies\b/.test(sim) &&
  /Eq\.&nbsp;8\.41a/.test(sim));
check('formulaEquationHTML notes staggered/double over-prediction limitation',
  /staggered.*over-estimate Rw by ~3-4&nbsp;dB|removes mechanical bridging/.test(sim));
check('catalogueEquationHTML renders the no-closed-form note',
  /function catalogueEquationHTML/.test(sim) &&
  /no closed-form prediction/.test(sim));

// =============================================================================
// (3) ISO 12354 flanking caveat preserved in EQUATION & METHOD (Maya note)
// =============================================================================

check('mass-law equation cites ISO 12354 flanking caveat',
  /ISO 12354/.test(sim) && /flanking/.test(sim));
// Verify it's preserved in all three modes (mass-law / formula / catalogue).
const massLawSection = sim.split('function massLawEquationHTML')[1]?.split('function formulaEquationHTML')[0] || '';
const formulaSection = sim.split('function formulaEquationHTML')[1]?.split('function catalogueEquationHTML')[0] || '';
const catalogueSection = sim.split('function catalogueEquationHTML')[1]?.split('function ratingSectionHTML')[0] || '';
check('flanking caveat present in formula equation block',
  /ISO 12354/.test(formulaSection) && /flanking/.test(formulaSection));
check('flanking caveat present in catalogue equation block',
  /ISO 12354/.test(catalogueSection) && /flanking/.test(catalogueSection));
check('flanking caveat present in mass-law equation block',
  /ISO 12354/.test(massLawSection) && /flanking/.test(massLawSection));

// =============================================================================
// (4) RATING section — always shown
// =============================================================================

check('ratingSectionHTML exists',
  /function ratingSectionHTML/.test(sim));
check('rating section shows Rw + STC inline',
  /Rw = \$\{rating\.Rw\}/.test(sim) &&
  /STC = \$\{rating\.STC\}/.test(sim));
check('rating section shows C + Ctr with signed display',
  /rating\.C >= 0 \? '\+' : ''/.test(sim) &&
  /rating\.Ctr >= 0 \? '\+' : ''/.test(sim));
check('rating section shows current contour shift value',
  /contour shift = <strong>\$\{rating\.shift >= 0 \? '\+' : ''\}\$\{rating\.shift\}/.test(sim));
check('rating section explains the contour-shift procedure in plain text',
  /unfavourable deviations/.test(sim) &&
  /largest shift where the\s*sum stays at or below 32\.0/.test(sim));
check('rating section cites ISO 717-1:2020 §3.1 + ASTM E413-22 §5',
  /ISO 717-1:2020 §3\.1/.test(sim) && /ASTM E413-22 §5/.test(sim));
check('rating section explains why Rw and STC can diverge (deep narrow dip)',
  /Rw and STC can diverge/.test(sim) && /mass-air-mass resonance is the usual culprit/.test(sim));

// =============================================================================
// (5) Rw not computable — single-sentence "why" (Maya: don't hide the section)
// =============================================================================

check('rating section handles !rating.computable case',
  /!rating\.computable/.test(sim));
check("not-computable shows wall-rating-unavailable container",
  /wall-rating-unavailable/.test(sim));
check('catalogue-row missing tl_third_oct gets a specific "why"',
  /cat\.model === 'catalogue'/.test(sim) &&
  /missing its 1\/3-octave measured data/.test(sim));
check('not-computable still cites the standard',
  /ISO 717-1:2020 §3\.1/.test(sim));

// =============================================================================
// (6) CSS — two-section stack styling
// =============================================================================

check('CSS defines .wall-method-section (section container)',
  /\.wall-method-section\b/.test(css));
check('CSS defines section-rule (border-top on adjacent sections)',
  /\.wall-method-section\s*\+\s*\.wall-method-section/.test(css) &&
  /border-top:\s*1px solid var\(--border\)/.test(css));
check('CSS defines .wall-method-section-label (small-caps section label)',
  /\.wall-method-section-label\b/.test(css) &&
  /text-transform:\s*uppercase/.test(css));
check('CSS defines .wall-rating-unavailable (greyed-out state)',
  /\.wall-rating-unavailable\b/.test(css));

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
