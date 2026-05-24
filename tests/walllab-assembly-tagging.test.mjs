// WallLAB assembly-tagging regression guard (v=609, 2026-05-23).
//
// Locks the Dr. Chen audit fix: WallLAB's Mode-1 computed-vs-measured Δ
// table is honest ONLY for single-leaf rows. Drywall-on-studs (gypsum-
// board) is a DOUBLE-LEAF assembly — mass-spring-mass + cavity + stud
// bridging. Sealed doors, hollow-core doors, floor-on-joists, LED-glass
// panels are COMPOSITES. A mass-law line drawn against an assembly TL
// shows "divergence" the user reads as a coincidence dip; it isn't.
//
// The fix tags every wall-catalogue row with `assembly_type` and the
// workbench hides the measured curve + Δ row + replaces with an honest
// note for anything that isn't 'single_leaf' (and also for tl_estimated
// rows, where the measured value IS itself a mass-law estimate).
//
// This test pins:
//   1. Every row in WALL_MATERIALS has an explicit assembly_type.
//   2. The four catalogue rows Dr. Chen called out by name carry the
//      correct tag (gypsum-board = double_leaf; doors / wood-floor /
//      led-glass = composite; concrete-painted / glass-window /
//      plaster-smooth = single_leaf).
//   3. isSingleLeafAssembly() is consistent with the tag.
//   4. The workbench gate (wall-sim.js) routes the assembly + estimated
//      cases away from the measured comparison path — text-grep, like
//      the existing scene-x-mirror / walllab-phase1 tests.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`PASS  ${name}`);
  passed++;
}

const cat = await import('../js/labs/walllab/wall-catalogue.js');

// 1. Every SHIPPED row carries an explicit assembly_type — no silent defaults.
// Step 8d added `deferred: true` Phase 6 rows (Lin refused to fabricate
// measured data); those don't have assembly_type yet — they get it when
// their measured 1/3-octave curves land in materials.json.
for (const row of cat.WALL_MATERIALS) {
  if (row.deferred) continue;
  check(`row '${row.id}' has explicit assembly_type`, typeof row.assembly_type === 'string');
  check(`row '${row.id}' assembly_type is a known kind`,
    ['single_leaf', 'double_leaf', 'composite'].includes(row.assembly_type));
}

// 2. The named rows from Dr. Chen's audit.
const tagOf = (id) => cat.WALL_MATERIALS.find(m => m.id === id)?.assembly_type;
check("gypsum-board is double_leaf (drywall on steel studs, Cavanaugh & Wilkes 24-6)",
  tagOf('gypsum-board') === 'double_leaf');
check("door-solid-wood is composite (sealed perimeter assembly)",
  tagOf('door-solid-wood') === 'composite');
check("door-hollow-core is composite (paper honeycomb sandwich)",
  tagOf('door-hollow-core') === 'composite');
check("wood-floor is composite (joist floor-ceiling assembly)",
  tagOf('wood-floor') === 'composite');
check("led-glass is composite (panel + steel chassis)",
  tagOf('led-glass') === 'composite');
check("concrete-painted is single_leaf (150 mm dense reinforced concrete)",
  tagOf('concrete-painted') === 'single_leaf');
check("glass-window is single_leaf (6 mm float glass, single pane)",
  tagOf('glass-window') === 'single_leaf');
check("plaster-smooth is single_leaf (single plaster skim)",
  tagOf('plaster-smooth') === 'single_leaf');

// 3. Helper agrees with the tag.
check("isSingleLeafAssembly('concrete-painted') === true",
  cat.isSingleLeafAssembly('concrete-painted') === true);
check("isSingleLeafAssembly('gypsum-board') === false (double_leaf)",
  cat.isSingleLeafAssembly('gypsum-board') === false);
check("isSingleLeafAssembly('door-solid-wood') === false (composite)",
  cat.isSingleLeafAssembly('door-solid-wood') === false);
check("isSingleLeafAssembly('unknown-id') === true (defensive default)",
  cat.isSingleLeafAssembly('not-a-real-material') === true);

// 4. Workbench gate is wired — text-grep against wall-sim.js. The render
// path computes a `compareReason` from the catalogue tags + tl_estimated
// + thickness-at-reference, and the table / plot / method-panel all gate
// on `showCompare` derived from it. Updated v=620 (Step 8a) — the gate
// moved from inline ternary into a named `computeCompareReason` function
// so the regex matches the function body's three sequential returns.
const sim = read('js/labs/walllab/wall-sim.js');
check('wall-sim imports isSingleLeafAssembly',
  /isSingleLeafAssembly/.test(sim) && /from '\.\/wall-catalogue\.js'/.test(sim));
check('wall-sim defines computeCompareReason with v=609 gate logic',
  /function computeCompareReason\(/.test(sim) &&
  /if \(!singleLeaf\) return 'assembly'/.test(sim) &&
  /if \(estimated\) return 'estimated'/.test(sim) &&
  /if \(!atRef\) return 'thickness'/.test(sim));
check('wall-sim plotSVG receives showCompare gate (not just atRef)',
  /plotSVG\([^)]*showCompare[^)]*\)/.test(sim));
check('wall-sim tableHTML receives showCompare + compareReason',
  /tableHTML\([^)]*showCompare,\s*compareReason\)/.test(sim));
check('wall-sim table note distinguishes assembly vs estimated vs thickness',
  /assembly\b/.test(sim) && /estimated\b/.test(sim) && /reference thickness/.test(sim));
check('isolationMethodHTML accepts a ctx with compareReason + assembly_type',
  /isolationMethodHTML\([^)]*\bctx\b\s*=\s*\{\}\)/.test(sim));
check('isolationMethodHTML shows wall-asm-chip when assembly',
  /wall-asm-chip/.test(sim));
check('isolationMethodHTML cites ISO 12354 flanking caveat (lab vs field)',
  /ISO 12354/.test(sim) && /flanking/.test(sim));

console.log(`\nOK  ${passed} assertions passed`);
