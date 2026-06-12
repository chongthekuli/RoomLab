// Regression guard for the wall-opening (door / window) material picker.
//
// Bug (2026-06-12, user report + screenshot): a wall opening's material
// <select> showed EVERY wall material, so a Door could be set to "Glass
// window 6mm" and a Window could be set to a solid wall finish. The opening
// picker was deriving its filter kind from the host wall (surfaceKindFor →
// 'wall') instead of from the opening's own kind.
//
// Root cause: materials carried applicableTo ∈ {floor, wall, ceiling} only —
// there was no door / window category, so buildMatSelect(`${id}-op-${idx}`,
// …) filtered as 'wall' and offered all wall materials.
//
// Fix (three parts):
//   1. data/materials.json — applicableTo gained 'door' and 'window'. Door
//      leaves (solid/hollow/glass/steel/acoustic) are door-only; glazing
//      (single/IGU/laminated) is window-only. Neither is a wall finish.
//   2. js/ui/panel-room.js — buildMatSelect gained an optional kindOverride;
//      renderOpeningRow passes op.kind ('door' | 'window'), so the picker
//      filters by the opening's kind, not the wall's.
//   3. js/labs/surfacelab/catalog.js + surface-detail.js — door/window
//      materials categorise to the Openings rail and show D / Gl chips.
//
// panel-room.js imports Three.js / DOM at load, so it can't run in Node. Per
// the repo convention (tests/openings-no-leak.test.mjs, scene-x-mirror) this
// guard has TWO halves:
//   (A) a BEHAVIORAL replica of the exact filter (materialAllowedOn +
//       buildMatSelect option-building) over the REAL materials.json, proving
//       a door offers only door leaves and a window only glazing — and that
//       the EXCLUSIONS the user reported (glass-window on a door, a solid wall
//       finish on a window) are gone; plus the back-compat net.
//   (B) GREP TRIPWIRES over the real source so removing the wiring fails the
//       build.

import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${!c && e ? '  — ' + e : ''}`); if (!c) failed++; };

const mats = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const list = mats.materials;
const byId = Object.fromEntries(list.map(m => [m.id, m]));
const SRC = readFileSync('./js/ui/panel-room.js', 'utf8');

// --------------------------------------------------------------------
// (A) Behavioral replica of the panel-room.js filter.
//     Verbatim mirror of materialAllowedOn (~2325) + the buildMatSelect
//     option set (~2345) WITH the kindOverride applied.
// --------------------------------------------------------------------

function materialAllowedOn(mat, kind) {
  if (!kind) return true;
  const allow = mat.applicableTo;
  if (!Array.isArray(allow)) return true;       // missing list → show everywhere
  return allow.includes(kind);
}

// Mirror of buildMatSelect's option set: filter by kind, drop audience-seated,
// then the back-compat net prepends a saved-but-unfiltered current material.
function optionsFor(kind, currentId) {
  let opts = list.filter(m => m.id !== 'audience-seated' && materialAllowedOn(m, kind));
  if (currentId && !opts.some(m => m.id === currentId)) {
    const cur = byId[currentId];
    if (cur) opts = [cur, ...opts];
  }
  return opts.map(m => m.id);
}

// --- DOOR picker -----------------------------------------------------
{
  const doorOpts = optionsFor('door');
  ok(doorOpts.includes('door-solid-wood'),  'door picker offers Solid wood door');
  ok(doorOpts.includes('door-hollow-core'), 'door picker offers Hollow core door');
  ok(doorOpts.includes('door-glass-toughened'), 'door picker offers the glass door (a glass DOOR is valid)');
  ok(doorOpts.includes('door-steel-insulated'), 'door picker offers the steel door');
  ok(doorOpts.includes('door-acoustic-stc45'),  'door picker offers the acoustic door');

  // The user's exact complaint: a 6 mm WINDOW pane must NOT be a door option.
  ok(!doorOpts.includes('glass-window'),
     'door picker EXCLUDES "Glass window 6mm" (the reported bug)',
     `got [${doorOpts.join(', ')}]`);
  ok(!doorOpts.includes('window-double-glazed-igu'), 'door picker excludes double glazing IGU');
  ok(!doorOpts.includes('window-laminated-acoustic'), 'door picker excludes laminated glazing');

  // No solid WALL finishes on a door.
  for (const wall of ['gypsum-board', 'concrete-painted', 'cmu_200_hollow', 'plaster-smooth',
                       'wall_2x4_sg_2x_each_air', 'led-glass']) {
    ok(!doorOpts.includes(wall), `door picker excludes wall finish "${wall}"`);
  }
  // No floor / ceiling / seat / rack materials either.
  for (const other of ['carpet-heavy', 'acoustic-tile', 'audience-seated', 'rack_metal_painted_panel']) {
    ok(!doorOpts.includes(other), `door picker excludes non-door material "${other}"`);
  }
  // Every door option is genuinely a door leaf.
  ok(doorOpts.every(id => (byId[id]?.applicableTo || []).includes('door')),
     'every door-picker option is applicableTo door');
}

// --- WINDOW picker ---------------------------------------------------
{
  const winOpts = optionsFor('window');
  ok(winOpts.includes('glass-window'), 'window picker offers Glass window 6mm');
  ok(winOpts.includes('window-double-glazed-igu'), 'window picker offers double glazing IGU');
  ok(winOpts.includes('window-laminated-acoustic'), 'window picker offers laminated acoustic glazing');

  // A window must only offer glazing — no solid doors, no wall finishes.
  for (const door of ['door-solid-wood', 'door-hollow-core', 'door-steel-insulated', 'door-acoustic-stc45']) {
    ok(!winOpts.includes(door), `window picker excludes solid door "${door}"`);
  }
  // The glass DOOR is a door leaf, not glazing — must not appear as a window.
  ok(!winOpts.includes('door-glass-toughened'),
     'window picker excludes the glass DOOR (door-glass-toughened is a leaf, not a window pane)');
  for (const wall of ['gypsum-board', 'concrete-painted', 'led-glass']) {
    ok(!winOpts.includes(wall), `window picker excludes wall finish "${wall}"`);
  }
  ok(winOpts.every(id => (byId[id]?.applicableTo || []).includes('window')),
     'every window-picker option is applicableTo window');
}

// --- WALL picker is unchanged: door / window materials must NOT leak in -----
{
  // Mirror of surfaceKindFor for a wall id → 'wall'.
  const wallOpts = optionsFor('wall');
  for (const opening of ['door-solid-wood', 'door-hollow-core', 'door-glass-toughened',
                         'door-steel-insulated', 'door-acoustic-stc45',
                         'glass-window', 'window-double-glazed-igu', 'window-laminated-acoustic']) {
    ok(!wallOpts.includes(opening),
       `wall picker excludes opening leaf "${opening}" (no longer a wall finish)`);
  }
  // …but normal wall finishes still appear.
  ok(wallOpts.includes('gypsum-board') && wallOpts.includes('concrete-painted'),
     'wall picker still offers ordinary wall finishes');
}

// --- Back-compat net: a saved opening referencing an off-filter material
//     must stay selectable so loading never silently swaps it. ----------
{
  // Hypothetical legacy door that somehow saved a wall finish.
  const legacyDoor = optionsFor('door', 'gypsum-board');
  ok(legacyDoor[0] === 'gypsum-board',
     'back-compat: a door saved as gypsum-board keeps it selectable (prepended)');
  ok(legacyDoor.filter(id => id === 'gypsum-board').length === 1,
     'back-compat: the saved material is prepended exactly once');
  // The default door/window materials pass their own filter (no net needed).
  ok(optionsFor('door', 'door-solid-wood')[0] === 'door-solid-wood',
     'default door material needs no back-compat prepend');
  ok(optionsFor('window', 'glass-window').includes('glass-window'),
     'default window material needs no back-compat prepend');
}

// --------------------------------------------------------------------
// (B) Grep tripwires over the real source — the actual regression guard.
// --------------------------------------------------------------------

ok(/function\s+buildMatSelect\s*\(\s*dataKey\s*,\s*currentValue\s*,\s*kindOverride\s*\)/.test(SRC),
   'source: buildMatSelect accepts a kindOverride param',
   'the opening kind override was removed — openings would filter as wall again');

ok(/const\s+kind\s*=\s*kindOverride\s*\|\|\s*surfaceKindFor\(dataKey\)/.test(SRC),
   'source: buildMatSelect prefers kindOverride over surfaceKindFor',
   'kindOverride is ignored — door/window filtering is dead');

// renderOpeningRow must pass the opening's kind into buildMatSelect.
ok(/op\.kind\s*===\s*'window'\s*\?\s*'window'\s*:\s*'door'/.test(SRC),
   'source: opening row derives the filter kind from op.kind');
ok(/buildMatSelect\(`\$\{surfaceId\}-op-\$\{idx\}`,\s*op\.materialId,\s*opKind\)/.test(SRC),
   'source: opening row passes opKind into buildMatSelect',
   'the opening select no longer receives its kind — bug would return');

if (failed > 0) { console.log(`\n${failed} opening-material-filter test(s) FAILED`); process.exit(1); }
console.log('\nAll opening-material-filter regression tests passed.');
