// Regression guard for surface applicability classification.
//
// Feature (2026-06-08): every material in data/materials.json carries an
// `applicableTo` list restricting which room boundary it can finish —
// floor / wall / ceiling. The room-panel material picker (buildMatSelect in
// js/ui/panel-room.js) filters by this so you can never pick e.g. a stud
// partition wall as a FLOOR, and SurfaceLAB shows the badge.
//
// Locked invariants this test defends:
//   * every material has an `applicableTo` array
//   * values are a subset of {floor, wall, ceiling}, no duplicates
//   * a non-empty material is reachable on at least one surface (so it's
//     never silently dropped from ALL three pickers by a typo)
//   * the canonical examples stay classified the way the picker depends on:
//       - wall stud / masonry assemblies are wall-only (never floorable —
//         the user's "partition board can never be a floor" requirement)
//       - floor finishes (carpet, wood floor) are floor-only
//       - ceiling-only treatments stay off walls/floors
//       - concrete-painted stays universal (used by every surau surface row)
//       - rack panels + seat zone-coverage are [] (not room boundaries)

import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const byId = Object.fromEntries(data.materials.map(m => [m.id, m]));
const KINDS = ['floor', 'wall', 'ceiling'];

let failed = 0;
function ok(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
}

// --- Structural invariants over the whole catalogue -----------------------
for (const m of data.materials) {
  ok(Array.isArray(m.applicableTo), `${m.id}: has applicableTo array`);
  if (!Array.isArray(m.applicableTo)) continue;
  ok(m.applicableTo.every(k => KINDS.includes(k)),
    `${m.id}: applicableTo values are all floor/wall/ceiling`,
    JSON.stringify(m.applicableTo));
  ok(new Set(m.applicableTo).size === m.applicableTo.length,
    `${m.id}: applicableTo has no duplicates`);
}

// --- Canonical classification assertions the picker depends on ------------
function expectApply(id, expected) {
  const m = byId[id];
  if (!m) { ok(false, `${id}: present in catalogue`); return; }
  const got = m.applicableTo || [];
  const same = got.length === expected.length && expected.every(k => got.includes(k));
  ok(same, `${id}: usable on [${expected.join(', ')}]`, `got [${got.join(', ')}]`);
}

// Wall-only — partition / masonry assemblies must NEVER be floorable.
for (const id of [
  'wall_2x4_sg_2x_each_air', 'wall_2x4_sg_2x_each_mf50', 'wall_2x4_dg_each_mf90',
  'wall_double_stud_dg_mf140', 'wall_staggered_2x6_2x_mf90',
  'cmu_200_hollow', 'cmu_200_grouted', 'arena-wall-mixed',
  'glass-window', 'led-glass', 'door-solid-wood', 'door-hollow-core',
]) {
  expectApply(id, ['wall']);
  ok(!(byId[id]?.applicableTo || []).includes('floor'),
    `${id}: NOT offered as a floor`);
}

// Floor-only finishes.
expectApply('carpet-heavy', ['floor']);
expectApply('carpet-heavy-underlay', ['floor']);
expectApply('wood-floor', ['floor']);

// Ceiling-only treatments.
expectApply('ceiling-cloud-200mm', ['ceiling']);
expectApply('acoustic-tile', ['ceiling']);
expectApply('metal-deck-acoustic', ['ceiling']);

// Wall + ceiling treatments / finishes.
expectApply('gypsum-board', ['wall', 'ceiling']);
expectApply('bass-trap-broadband-corner', ['wall', 'ceiling']);
expectApply('diffuser-qrd', ['wall', 'ceiling']);
expectApply('plaster-smooth', ['wall', 'ceiling']);
expectApply('open-air', ['wall', 'ceiling']);

// Universal structural — surau podium/roof/wall rows all use this.
expectApply('concrete-painted', ['floor', 'wall', 'ceiling']);

// Not a room boundary — never offered in any surface picker.
for (const id of [
  'upholstered-seat-empty', 'audience-seated',
  'rack_metal_painted_panel', 'rack_door_mesh_glass_empty',
  'rack_door_mesh_glass_loaded', 'rack_door_perforated_rear',
  'rack_chassis_array_loaded', 'rack_top_vented',
]) {
  ok((byId[id]?.applicableTo || ['x']).length === 0,
    `${id}: applicableTo is [] (not a room surface)`,
    JSON.stringify(byId[id]?.applicableTo));
}

// --- Coverage sanity: every surface kind has at least one default-safe
// material, so a freshly-built room can always populate all three pickers.
for (const kind of KINDS) {
  const n = data.materials.filter(m => (m.applicableTo || []).includes(kind)).length;
  ok(n > 0, `at least one material is usable on ${kind}`, `count=${n}`);
}

if (failed > 0) { console.log(`\n${failed} material-applicability test(s) FAILED`); process.exit(1); }
console.log('\nAll material-applicability tests passed.');
