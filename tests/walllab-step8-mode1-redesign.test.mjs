// Phase 5 Step 8a + 8b — WallLAB Mode 1 redesign regression (v=620).
//
// Maya's UX sign-off 2026-05-23 locked seven decisions:
//   1. Sub-mode routing unified + silent reshape (no separate mode tabs).
//   2. Formula slider layout: Construction group (leaf masses + cavity
//      depth + fill segment) + Stud system group (4-button segment;
//      rc1 omitted because it's catalogue-only).
//   3. Rw (C; Ctr) chip replaces "mass-law mean TL" in the summary block.
//   4. ISO 717-1 reference contour overlay on the TL plot (dotted line
//      + 45° hatching over unfavourable bands + Σ_unfav annotation).
//      No toggle — "hiding the contour is hiding the method."
//   5. Phase 6 disabled rows — deferred to Step 8d.
//   6. Standards & method right-panel restructure — deferred to Step 8c.
//   7. Composite stretch — deferred to Step 9.
//
// This test text-greps against wall-sim.js + css/main.css to pin the
// Step 8a+8b structural commitments. Future refactors that drop the
// model pill, the formula sliders, or the contour overlay trip the
// relevant assertion with a specific failure name.

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
const cat = read('js/labs/walllab/wall-catalogue.js');

// =============================================================================
// (1) Module imports — wall-rating + double-leaf + third-octave wired in
// =============================================================================

check('wall-sim imports computeRw, computeC, computeCtr from wall-rating.js',
  /from\s+['"][^'"]*wall-rating\.js['"]/.test(sim) &&
  /computeRw/.test(sim) && /computeC\b/.test(sim) && /computeCtr/.test(sim));
check('wall-sim imports doubleLeafTL from wall-tl-double-leaf.js',
  /from\s+['"][^'"]*wall-tl-double-leaf\.js['"]/.test(sim) &&
  /doubleLeafTL/.test(sim));
check('wall-sim imports ISO_THIRD_OCTAVE_HZ + octaveToThirdOctave',
  /ISO_THIRD_OCTAVE_HZ/.test(sim) && /octaveToThirdOctave/.test(sim));
check('wall-sim imports ISO_717_1_RW_CONTOUR_DB (for plot overlay)',
  /ISO_717_1_RW_CONTOUR_DB/.test(sim));

// =============================================================================
// (2) Sub-mode routing — model pill on every dropdown option
// =============================================================================

check('renderIsolation has dispatched material dropdown with model pill',
  /modelPillLabel\(cat\.model\)/.test(sim) &&
  /pill\s*\?\s*` · \$\{pill\}`\s*:\s*''/.test(sim));
check("modelPillLabel returns 'double-leaf' for formula rows",
  /if \(model === 'formula'\) return 'double-leaf'/.test(sim));
check("modelPillLabel returns 'measured' for catalogue rows",
  /if \(model === 'catalogue'\) return 'measured'/.test(sim));
check('renderParamRail branches on cat.model into formula / catalogue / mass-law',
  /cat\.model === 'formula'/.test(sim) &&
  /cat\.model === 'catalogue'/.test(sim) &&
  /params\.innerHTML\s*=\s*massLawControlsHTML/.test(sim));

// =============================================================================
// (3) Formula control rail — Construction + Stud system groups (Maya §2)
// =============================================================================

check('formulaControlsHTML defines Construction group',
  /<span class="wall-param-group-label">Construction<\/span>/.test(sim));
check('formulaControlsHTML defines Stud system group',
  /<span class="wall-param-group-label">Stud system<\/span>/.test(sim));
check('Construction group has leaf1 mass slider with value bubble',
  /id="wall-m1"/.test(sim) && /id="wall-m1-val"/.test(sim) && /kg\/m²/.test(sim));
check('Construction group has leaf2 mass slider',
  /id="wall-m2"/.test(sim) && /id="wall-m2-val"/.test(sim));
check('Construction group has cavity depth slider (mm-based)',
  /id="wall-d"/.test(sim) && /id="wall-d-val"/.test(sim));
check('Cavity fill segment has none / fibrous_50mm / reflective (Dr. Chen enum)',
  /'none'\s*,/.test(sim) &&
  /'fibrous_50mm'\s*,/.test(sim) &&
  /'reflective'\s*,/.test(sim) &&
  /data-fill="\$\{v\}"/.test(sim));
check('Stud system segment has wood / steel / staggered / double',
  /'wood'\s*,/.test(sim) &&
  /'steel'\s*,/.test(sim) &&
  /'staggered'\s*,/.test(sim) &&
  /'double'\s*,/.test(sim) &&
  /data-stud="\$\{v\}"/.test(sim));
check("Stud system OMITS rc1 (catalogue-only per Dr. Chen — no 'rc1' in studOpts)",
  // Look specifically inside the studOpts array context, not anywhere in source
  !/'rc1'\s*,\s*'/.test(sim));

// =============================================================================
// (4) Catalogue defaults prefill (Maya §2 — never start engineering control blank)
// =============================================================================

check('syncIsoStateForMaterial prefills assembly fields for formula rows',
  /if \(cat\.model === 'formula' && cat\.assembly\)/.test(sim) &&
  /st\.leaf1_mass_kg_m2\s*=\s*cat\.assembly\.leaf1_mass_kg_m2/.test(sim) &&
  /st\.cavity_fill\s*=\s*cat\.assembly\.cavity_fill/.test(sim));
check('syncIsoStateForMaterial resets st.modified on material change',
  /st\.modified\s*=\s*false/.test(sim));
check('formula sliders set st.modified = true on input',
  /st\.modified\s*=\s*true/.test(sim));

// =============================================================================
// (5) Rw (C; Ctr) chip — Maya §3
// =============================================================================

check('renderSummary outputs wall-rw-chip element',
  /class="wall-rw-chip/.test(sim));
check("Rw chip shows 'Rw (C; Ctr)' label per ISO 717-1 §5",
  /Rw \(C; Ctr\)/.test(sim));
check("Rw chip caption cites 'single-number rating · ISO 717-1'",
  /single-number rating · ISO 717-1/.test(sim));
check('Rw chip has unavailable state with reason',
  /wall-rw-chip-unavailable/.test(sim) &&
  /not available/.test(sim));
check('computeRating returns computable flag + Rw + C + Ctr + STC + shift',
  /computeRating/.test(sim) &&
  /computable: true, Rw, STC, C, Ctr, shift/.test(sim));

// =============================================================================
// (6) Plot — reference contour overlay + hatching + Σ_unfav (Maya §4)
// =============================================================================

check('plotSVG branches on 1/3-oct (formula/catalogue) vs octave (mass-law)',
  /isThirdOct/.test(sim) &&
  /ISO_THIRD_OCTAVE_HZ/.test(sim));
check('plotSVG computes shifted reference contour from rating.shift',
  /rating\.computable/.test(sim) &&
  /ISO_717_1_RW_CONTOUR_DB\[rwIdx\]\s*\+\s*rating\.shift/.test(sim));
check('plotSVG draws wp-contour layer (dotted reference line)',
  /class="wp-contour"/.test(sim));
check('plotSVG draws hatching via fill="url\\(#wp-hatch-pattern\\)"',
  /fill="url\(#wp-hatch-pattern\)"/.test(sim));
check('plotSVG defines wp-hatch-pattern in defs (45° diagonal)',
  /<pattern id="wp-hatch-pattern"/.test(sim) &&
  /rotate\(45\)/.test(sim));
check("plotSVG renders Σ_unfav + shift annotation (top-right)",
  /Σ unfav/.test(sim) &&
  /shift /.test(sim));
check("plotSVG legend includes 'ISO 717-1 contour' when computable",
  /ISO 717-1 contour/.test(sim));

// =============================================================================
// (7) computeCompareReason — branches on model
// =============================================================================

check("compareReason: catalogue rows return 'mode'",
  /cat\.model === 'catalogue'\)\s*return\s*'mode'/.test(sim));
check("compareReason: formula rows gate on st.modified",
  /cat\.model === 'formula'\)\s*return\s*st\.modified\s*\?\s*'modified'\s*:\s*null/.test(sim));
check("tableHTML handles 'mode' and 'modified' compareReasons",
  /compareReason === 'modified'/.test(sim) &&
  /compareReason === 'mode'/.test(sim));

// =============================================================================
// (8) wall-catalogue.js extended with the 7 new rows from Step 7
// =============================================================================

const PHASE5_IDS = [
  'wall_2x4_sg_2x_each_air',
  'wall_2x4_sg_2x_each_mf50',
  'wall_2x4_dg_each_mf90',
  'wall_double_stud_dg_mf140',
  'wall_staggered_2x6_2x_mf90',
  'cmu_200_hollow',
  'cmu_200_grouted',
];
for (const id of PHASE5_IDS) {
  check(`wall-catalogue.js lists '${id}' (Step 7 row)`,
    new RegExp(`id: '${id}'`).test(cat));
}

// =============================================================================
// (9) CSS — new classes for the redesign
// =============================================================================

const cssClasses = [
  ['.wall-rw-chip', 'Rw chip container'],
  ['.wall-rw-chip-label', 'Rw chip label (small caps)'],
  ['.wall-rw-chip-value', 'Rw chip value (large)'],
  ['.wall-rw-chip-cap', 'Rw chip caption (ISO 717-1)'],
  ['.wall-rw-chip-unavailable', 'Rw chip greyed-out state'],
  ['.wall-param-group', 'Construction / Stud system group container'],
  ['.wall-param-group-label', 'Group label (small caps)'],
  ['.wall-param-grid', '2-column grid inside Construction group'],
  ['.wall-mode-seg-tight', 'compact segment variant for cavity fill'],
  ['.wall-catalogue-note', 'no-parametric-controls placeholder'],
  ['.wp-contour', 'dotted reference contour line'],
  ['.wp-hatch-stroke', 'hatch-pattern stroke'],
  ['.wp-sum-unfav', 'Σ_unfav annotation text'],
];
for (const [cls, label] of cssClasses) {
  check(`CSS defines ${cls} (${label})`,
    new RegExp(cls.replace('.', '\\.') + '\\b').test(css));
}

// =============================================================================
// (10) Cache bump
// =============================================================================

const html = read('index.html');
check('index.html cache-bust is past v=619 (Step 8a+b shipped at v=620+)',
  !/\?v=61[0-9]\b/.test(html) && /\?v=6[2-9][0-9]\b/.test(html));

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
