// Building-structures STATE lifecycle tests — serialize/deserialize round-trip,
// malformed-entry filtering, scene-reset clearing (state-swap invariant), and
// preset propagation (preset-plumbing invariant, CLAUDE.md §3).

import {
  state, serializeProject, deserializeProject, applyPresetToState,
  duplicateStructure, getSelectedStructure, nextStructureId,
} from '../js/app-state.js';

let failed = 0;
function ok(cond, label, info = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${info}`);
  if (!cond) failed++;
}

function sampleStructures() {
  return [
    { id: 'S1', type: 'pillar', crossSection: 'round', diameter_m: 0.4, materialId: 'concrete-painted', position: { x: 2, y: 3 }, rotation_deg: 0, fullHeight: true, _cachedSpec: { junk: true } },
    { id: 'S2', type: 'half_wall', length_m: 3, height_m: 1.1, thickness_m: 0.12, materialId: 'gypsum-board', position: { x: 5, y: 4 }, rotation_deg: 90, fullHeight: false },
  ];
}

// 1. Round-trip — structures survive serialize → deserialize, _cachedSpec stripped.
{
  state.structures = sampleStructures();
  state.selectedStructureId = 'S2';
  const json = JSON.parse(JSON.stringify(serializeProject(state)));
  ok(Array.isArray(json.structures) && json.structures.length === 2, 'serialize emits structures[]', `(${json.structures?.length})`);
  ok(json.structures[0]._cachedSpec === undefined, 'serialize strips _cachedSpec');
  ok(json.selectedStructureId === 'S2', 'serialize emits selectedStructureId');

  // Wipe then restore.
  state.structures = [];
  state.selectedStructureId = null;
  deserializeProject(json);
  ok(state.structures.length === 2, 'deserialize restores structures', `(${state.structures.length})`);
  ok(state.structures[1].type === 'half_wall' && state.structures[1].height_m === 1.1, 'deserialize preserves parametric fields');
  ok(state.structures[0]._cachedSpec === undefined, 'deserialize does not rehydrate _cachedSpec');
  ok(state.selectedStructureId === 'S2', 'deserialize restores selection (survived filter)');
}

// 2. Malformed entries filtered defensively (id + valid type + materialId + position).
{
  const bad = {
    formatVersion: 1,
    structures: [
      { id: 'OK', type: 'pillar', materialId: 'concrete-painted', position: { x: 1, y: 1 } },
      { type: 'pillar', materialId: 'concrete-painted', position: { x: 1, y: 1 } },  // no id
      { id: 'X', type: 'banana', materialId: 'concrete-painted', position: { x: 1, y: 1 } }, // bad type
      { id: 'Y', type: 'pillar', position: { x: 1, y: 1 } },                          // no materialId
      { id: 'Z', type: 'pillar', materialId: 'concrete-painted', position: { x: 'nope', y: 1 } }, // bad pos
      null,
    ],
  };
  deserializeProject(bad);
  ok(state.structures.length === 1 && state.structures[0].id === 'OK', 'malformed structures filtered → only valid survive', `(kept ${state.structures.length})`);
}

// 3. scene:reset / preset apply clears structures (state-swap invariant).
{
  state.structures = sampleStructures();
  state.selectedStructureId = 'S1';
  const presetKey = Object.keys(applyPresetToState ? {} : {}); // noop; we call a real preset below
  void presetKey;
  // Apply any real preset — resetSceneState must blow away structures first.
  // Use the first available preset key.
  // (applyPresetToState clears via scene-lifecycle.resetSceneState.)
  const { PRESETS } = await import('../js/app-state.js');
  const firstKey = Object.keys(PRESETS)[0];
  applyPresetToState(firstKey);
  ok(Array.isArray(state.structures) && state.structures.length === 0, 'preset apply clears prior structures', `(${state.structures.length})`);
  ok(state.selectedStructureId === null, 'preset apply clears selectedStructureId');
}

// 4. Preset propagation — a preset that ships structures lands them in state
//    (preset-plumbing pattern; mirrors tests/preset.test.mjs).
{
  const { PRESETS } = await import('../js/app-state.js');
  const firstKey = Object.keys(PRESETS)[0];
  const preset = PRESETS[firstKey];
  const hadStructures = preset.structures;
  preset.structures = [{ id: 'PS1', type: 'pillar', crossSection: 'square', width_m: 0.5, depth_m: 0.5, materialId: 'concrete-painted', position: { x: 4, y: 4 }, rotation_deg: 0, fullHeight: true }];
  applyPresetToState(firstKey);
  ok(state.structures.length === 1 && state.structures[0].id === 'PS1', 'preset structures propagate to state.structures', `(${state.structures.length})`);
  // restore preset so we don't pollute other tests in the same process
  if (hadStructures === undefined) delete preset.structures; else preset.structures = hadStructures;
}

// 5. Helpers — nextStructureId uniqueness, duplicateStructure, getSelectedStructure.
{
  state.structures = [{ id: 'S1', type: 'pillar', crossSection: 'round', diameter_m: 0.4, materialId: 'concrete-painted', position: { x: 1, y: 1 }, rotation_deg: 0, label: 'Pillar 1' }];
  ok(nextStructureId() === 'S2', 'nextStructureId returns first free id', `(${nextStructureId()})`);
  const newId = duplicateStructure('S1');
  ok(newId === 'S2' && state.structures.length === 2, 'duplicateStructure adds a copy with fresh id', `(${newId})`);
  ok(state.structures[1].position.x === 1.5, 'duplicate nudged +0.5 m on x');
  ok(state.structures[1]._cachedSpec === undefined, 'duplicate strips _cachedSpec');
  state.selectedStructureId = 'S2';
  ok(getSelectedStructure()?.id === 'S2', 'getSelectedStructure resolves selection');
}

console.log(failed === 0 ? '\nAll structures-state tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
