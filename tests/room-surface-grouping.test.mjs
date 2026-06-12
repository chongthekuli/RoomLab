// Room-panel surface grouping regression test (v=806, 2026-06-12).
//
// Pins the "surfaces grouped by surface, not interleaved" layout in the
// Room panel. Before v=806 the panel read:
//   <h3>Ceiling</h3>  -> ceiling SHAPE dropdown (Flat/dome)   <- "Ceiling" #1
//   <h3>Surface materials</h3>
//     Treatment preset
//     Floor  ->  Ceiling MATERIAL  ->  Wall materials / Wall 1..N
//                       ^ "Ceiling" #2, buried between Floor and Walls
// i.e. the word "Ceiling" appeared twice in two disconnected places and
// Floor / Ceiling-material / Walls were interleaved.
//
// v=806 regroups each surface into one block under one heading, in a single
// consistent order everywhere: Floor -> Walls -> Ceiling. The Ceiling group
// unifies BOTH the ceiling shape (Flat/dome + dome-rise) AND the ceiling
// material, so "Ceiling" is one place. The Treatment preset stays a global
// control (it overrides every surface) above the per-surface groups.
//
// Text-grep (not behavioural): the rendered grouping needs the live DOM +
// the rail panel mounted. The regressable surface is "someone re-introduces
// the standalone <h3>Ceiling> shape block, moves the ceiling material back
// between Floor and Walls, drops a data hook the change handlers depend on,
// or lets the surface order drift between the custom and rectangular code
// paths." A static audit pins all of those.
//
// Hard constraint from the task: the DATA MODEL is unchanged. This test also
// asserts every data-f / state hook the moved controls still depend on is
// present, so a regrouping refactor can't silently orphan a control.
//
// Run: node tests/room-surface-grouping.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const panel = readFileSync('./js/ui/panel-room.js', 'utf8');
const css   = readFileSync('./css/main.css', 'utf8');

// ---- 1. The standalone top-of-panel "Ceiling" SHAPE block is gone ----
// The static template must no longer carry its own <h3>Ceiling</h3> +
// ceiling_type <select>. That block is what produced the first (and now
// removed) duplicate "Ceiling" label.
ok(!/<h3>Ceiling<\/h3>/.test(panel),
   'no standalone <h3>Ceiling</h3> heading in the static template');
ok(!/<h3>Surface materials<\/h3>/.test(panel),
   'old "<h3>Surface materials</h3>" heading replaced');
ok(/<h3>Surfaces<\/h3>/.test(panel),
   'Surfaces section heading present (intro for the treatment preset + groups)');

// The treatment-preset row (global "overrides every surface") still sits
// directly under the Surfaces heading, not inside one surface group.
ok(/<h3>Surfaces<\/h3>\s*<div id="treatment-preset-row"/.test(panel),
   'treatment preset stays a global control under the Surfaces heading');

// ---- 2. One unified Ceiling group renderer ---------------------------
// renderCeilingGroup must exist and contain BOTH the ceiling SHAPE control
// (ceiling_type) AND the ceiling MATERIAL (surfaces.ceiling) — proving the
// two are now in one place.
const cg = panel.match(/const renderCeilingGroup = \(parent\) => \{[\s\S]*?\r?\n {2}\};/);
ok(!!cg, 'renderCeilingGroup helper exists');
if (cg) {
  const body = cg[0];
  ok(/dataset\.f = 'ceiling_type'/.test(body),
     'Ceiling group renders the ceiling SHAPE select (data-f="ceiling_type")');
  ok(/state\.room\.ceiling_type = e\.target\.value/.test(body),
     'ceiling_type change handler is re-wired inside the Ceiling group');
  ok(/state\.room\.surfaces\.ceiling/.test(body),
     'Ceiling group renders the ceiling MATERIAL row (surfaces.ceiling)');
  ok(/id = 'ceiling-params'/.test(body) || /id='ceiling-params'/.test(body),
     'Ceiling group hosts #ceiling-params for the dome-rise field');
  ok(/renderCeilingParams\(\)/.test(body),
     'Ceiling group calls renderCeilingParams() to fill the dome-rise field');
  // The shape control must NOT be labelled "Ceiling" again (the group
  // heading already says Ceiling) — it's "Shape" so there's no second
  // "Ceiling" label inside the group.
  ok(/append\('Shape '\)/.test(body),
     'ceiling shape control is labelled "Shape", not a second "Ceiling"');
}

// ---- 3. Surface order is Floor -> Walls -> Ceiling, NOT interleaved --
// In the renderSurfaceMaterials body, the Floor heading must appear before
// the Walls heading, which must appear before the Ceiling group call — in
// BOTH the custom-room branch and the rectangular/non-rect branch.
// (CRLF-tolerant end anchor: panel-room.js uses Windows line endings.)
const rsm = panel.match(/function renderSurfaceMaterials\(\)[\s\S]*?\r?\n}\r?\n/);
ok(!!rsm, 'renderSurfaceMaterials body found');
if (rsm) {
  const body = rsm[0];

  // Custom branch and rect branch each emit a Floor heading, a Walls
  // heading, and a renderCeilingGroup(root) call. There must be exactly
  // two of each (custom + rect), and never a "Wall materials" h4 with the
  // ceiling material wedged before it.
  const floorHeads   = (body.match(/textContent = isOutdoor \? 'Ground' : 'Floor'/g) || []).length;
  ok(floorHeads >= 2, 'a Floor (or Ground) group heading in both the custom and rect paths');

  const wallHeads = (body.match(/wallHead\.textContent = 'Walls'|\.textContent = 'Walls'/g) || []).length;
  ok(wallHeads >= 2, 'a Walls group heading in both the custom and rect paths');

  // The OLD interleaving signature must be gone: a Floor+Ceiling row pair
  // rendered together BEFORE the walls. The pre-v=806 code built fcRows =
  // [['floor',...],['ceiling',...]] then the wall list. Assert that tuple
  // array is gone.
  ok(!/\['floor', 'Floor'\], \['ceiling', 'Ceiling'\]/.test(body),
     'no Floor+Ceiling-material pair rendered together before the walls (de-interleaved)');
  ok(!/h4\.textContent = 'Wall materials'/.test(body),
     'old "Wall materials" h4 replaced by the "Walls" group heading');

  // Ordering check (custom branch): the FIRST Floor heading must precede
  // the FIRST Walls heading, which must precede the FIRST renderCeilingGroup.
  const iFloor   = body.indexOf("'Ground' : 'Floor'");
  const iWalls   = body.indexOf("'Walls'");
  const iCeiling = body.indexOf('renderCeilingGroup(root)');
  ok(iFloor > -1 && iWalls > -1 && iCeiling > -1 && iFloor < iWalls && iWalls < iCeiling,
     'surface order is Floor -> Walls -> Ceiling (groups not interleaved)');

  // Ceiling group is skipped outdoors (no roof).
  ok(/if \(!isOutdoor\) renderCeilingGroup\(root\)/.test(body),
     'Ceiling group is skipped for outdoor rooms (no roof)');
}

// ---- 4. Data model unchanged — every moved control keeps its hook ----
// These are the state hooks the change handlers + value-sync + tests
// depend on. A regrouping must not rename or drop any of them.
ok(/data-f="ceiling_type"|dataset\.f = 'ceiling_type'/.test(panel),
   'ceiling_type hook preserved');
ok(/data-sf="ceiling_dome_rise_m"/.test(panel),
   'ceiling_dome_rise_m hook preserved (dome-rise field)');
ok(/state\.room\.surfaces\.floor/.test(panel),
   'surfaces.floor hook preserved');
ok(/state\.room\.surfaces\.ceiling/.test(panel),
   'surfaces.ceiling hook preserved');
ok(/state\.room\.surfaces\.edges\[i\]/.test(panel),
   'per-edge wall hook (surfaces.edges) preserved for custom rooms');

// ---- 5. Re-render safety: focus guard covers the moved dome-rise -----
// The dome-rise field now lives inside #ceiling-params, which
// renderSurfaceMaterials() rebuilds via innerHTML on room:changed. The
// custom-room re-render guard must bail when focus is in #ceiling-params
// (same caret-drop bug class as #vertex-list).
ok(/closest\('#ceiling-params'\)/.test(panel),
   'custom-room re-render guard protects the focused dome-rise field (#ceiling-params)');

// ---- 6. CSS: surface-group headings are styled as group labels -------
ok(/#surface-materials > h4 \{/.test(css),
   'css: surface-group headings (#surface-materials > h4) have a dedicated style');

// ---- summary ---------------------------------------------------------
if (failed > 0) {
  console.log(`\nFAIL  ${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll room-surface-grouping assertions passed.');
}
