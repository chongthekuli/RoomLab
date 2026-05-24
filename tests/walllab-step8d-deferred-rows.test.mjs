// Phase 5 Step 8d — Phase 6 deferred rows in the material dropdown (v=622).
//
// Maya's UX Decision 5 (2026-05-23): 4 rows that Lin refused to seed
// without measured data (paywalled NRC IR-761 / Saint-Gobain Acoustic
// Guide) appear in the material dropdown DISABLED with a sublabel
// "· measured data pending". Plus an ambient caption below the dropdown
// noting the count.
//
//   "Hide them entirely → kills discoverability; the engineer asking
//    'where's the RC-1 wall?' can't see the answer.  Show enabled with
//    a workbench state → wastes a click. (B) — rows visible, disabled,
//    with sublabel — is the correct affordance."
//
// Forward-compat: when Lin lands real data in materials.json the
// `deferred: true` flag drops from the wall-catalogue row and the UI
// auto-promotes — no second commit needed.

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

const cat = await import('../js/labs/walllab/wall-catalogue.js');
const sim = read('js/labs/walllab/wall-sim.js');
const css = read('css/main.css');

// =============================================================================
// (1) The 4 deferred rows are present in wall-catalogue.js
// =============================================================================

const DEFERRED_IDS = [
  'wall_steel_25_dg_mf65_rc',
  'glaz_igu_4_12_4_air',
  'glaz_igu_6_16_8_air',
  'glaz_lam_88_argon_lam_66',
];
const deferredRows = cat.WALL_MATERIALS.filter(m => m.deferred);
check(`wall-catalogue lists exactly ${DEFERRED_IDS.length} deferred rows`,
  deferredRows.length === DEFERRED_IDS.length,
  `got ${deferredRows.length}`);
for (const id of DEFERRED_IDS) {
  const row = cat.WALL_MATERIALS.find(m => m.id === id);
  check(`deferred row '${id}' has deferred: true`,
    row?.deferred === true);
  check(`deferred row '${id}' carries a name (for the dropdown label)`,
    typeof row?.name === 'string' && row.name.length > 0);
  check(`deferred row '${id}' carries a wallType (for type-filter routing)`,
    typeof row?.wallType === 'string');
}

// =============================================================================
// (2) Deferred rows route to the correct wallType (so they appear under
//     the right group when the user changes Wall type).
// =============================================================================

check("RC-1 wall is in the 'partition' wallType group",
  cat.WALL_MATERIALS.find(m => m.id === 'wall_steel_25_dg_mf65_rc')?.wallType === 'partition');
check("all 3 IGU glazing rows are in the 'glazing' wallType group",
  ['glaz_igu_4_12_4_air', 'glaz_igu_6_16_8_air', 'glaz_lam_88_argon_lam_66'].every(
    id => cat.WALL_MATERIALS.find(m => m.id === id)?.wallType === 'glazing',
  ));

// =============================================================================
// (3) Render path: dropdownRows includes deferred; disabled <option> + caption
// =============================================================================

check('renderIsolation builds dropdownRows = present ∪ deferred',
  /dropdownRows\s*=\s*WALL_MATERIALS\.filter\(m\s*=>\s*m\.deferred\s*\|\|\s*present\.includes\(m\)\)/.test(sim));
check('refreshMaterialOptions splits options into selectable + deferred',
  /const selectable = allMats\.filter\(m => !m\.deferred\)/.test(sim) &&
  /const deferred = allMats\.filter\(m => m\.deferred\)/.test(sim));
check('deferred options render with <option ... disabled>',
  /<option value="\$\{m\.id\}" disabled>/.test(sim));
check('deferred option label appends "· measured data pending"',
  /m\.name \|\| m\.id\} · measured data pending/.test(sim));
check('selectable options sorted ABOVE deferred (disabled options at bottom)',
  /optsSelectable\.join\(''\) \+ optsDeferred\.join\(''\)/.test(sim));
check('default-selected material falls back to first SELECTABLE row',
  /st\.matId = selectable\[0\]\?\.id/.test(sim));

// =============================================================================
// (4) Ambient caption below the dropdown
// =============================================================================

check('caption element rendered with id="wall-deferred-caption" and hidden default',
  /id="wall-deferred-caption" hidden/.test(sim));
check('caption text mentions "N rows pending measured data"',
  /\$\{totalDeferred\} rows pending measured data/.test(sim));
check("caption is shown ambient — hidden when totalDeferred is 0 (forward-compat)",
  /totalDeferred > 0/.test(sim) &&
  /deferredCaption\.hidden = true/.test(sim));

// =============================================================================
// (5) CSS
// =============================================================================

check('CSS defines .wall-deferred-caption styling',
  /\.wall-deferred-caption\b/.test(css));

// =============================================================================
// (6) Existing assembly-tagging test SKIPS deferred rows (they don't have
//     assembly_type until they ship with real data)
// =============================================================================

const assemblyTaggingTest = read('tests/walllab-assembly-tagging.test.mjs');
check('walllab-assembly-tagging.test.mjs skips deferred rows in iteration',
  /if \(row\.deferred\) continue/.test(assemblyTaggingTest));

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
