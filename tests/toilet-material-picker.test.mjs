// Regression guard for the toilet-cubicle material picker.
//
// Bug (2026-06-08): the toilet building-structure picker reused the full
// bulk-construction material list (constructionMaterials), so it offered
// ~16 options including double-stud isolation walls, stone, perforated metal
// deck, LED panels — unrealistic for a WC cubicle. Fix: panel-structure.js
// curates a small realistic TOILET_MATERIAL_IDS list for type === 'toilet'.
//
// panel-structure.js is DOM-coupled (imports the surfacelab catalogue + app
// state), so this guard reads its SOURCE — same pattern as
// tests/scene-x-mirror.test.mjs — and cross-checks against materials.json.
//
// Locked invariants:
//   * TOILET_MATERIAL_IDS exists and every id resolves in materials.json
//     (catches a material rename silently emptying the toilet picker)
//   * the curated list is meaningfully SMALLER than the full construction set
//     (so the "too many / unrealistic" regression can't creep back)
//   * the toilet DEFAULT_MATERIAL is one of the curated ids
//   * materialSelect routes through per-type candidates, not the raw full list

import { readFileSync } from 'node:fs';

const src = readFileSync('./js/ui/panel-structure.js', 'utf8');
const mats = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const matIds = new Set(mats.materials.map(m => m.id));

let failed = 0;
function ok(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
}

// Extract the TOILET_MATERIAL_IDS array literal from source.
const blockMatch = src.match(/TOILET_MATERIAL_IDS\s*=\s*\[([\s\S]*?)\]/);
ok(!!blockMatch, 'TOILET_MATERIAL_IDS array is defined');
const toiletIds = blockMatch
  ? [...blockMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  : [];

ok(toiletIds.length >= 2, 'toilet picker offers a few realistic options', `count=${toiletIds.length}`);
ok(toiletIds.length <= 8, 'toilet picker is curated, not the full catalogue', `count=${toiletIds.length}`);

for (const id of toiletIds) {
  ok(matIds.has(id), `toilet material "${id}" exists in materials.json`);
}

// Default toilet material must be selectable in the curated list.
const defMatch = src.match(/DEFAULT_MATERIAL\s*=\s*\{[\s\S]*?toilet:\s*'([^']+)'/);
ok(!!defMatch, 'DEFAULT_MATERIAL.toilet is defined');
if (defMatch) {
  ok(toiletIds.includes(defMatch[1]),
    `default toilet material "${defMatch[1]}" is in the curated picker list`);
}

// The realistic set must EXCLUDE the obviously-unrealistic WC materials that
// the old full list pulled in — this is the core of the "not realistic" fix.
for (const banned of [
  'wall_double_stud_dg_mf140', 'wall_staggered_2x6_2x_mf90',
  'metal-deck-acoustic', 'led-glass', 'wood-floor',
]) {
  ok(!toiletIds.includes(banned), `toilet picker excludes "${banned}"`);
}

// materialSelect must use the per-type chooser, not the raw full list, so the
// curation actually reaches the dropdown.
ok(/function materialSelect\([^)]*\)\s*\{[\s\S]*?materialsForType\(/.test(src),
  'materialSelect() routes through materialsForType()');
ok(/materialsForType[\s\S]*?type !== 'toilet'[\s\S]*?constructionMaterials\(\)/.test(src),
  'non-toilet types still use the full construction list');

if (failed > 0) { console.log(`\n${failed} toilet-material-picker test(s) FAILED`); process.exit(1); }
console.log('\nAll toilet-material-picker tests passed.');
