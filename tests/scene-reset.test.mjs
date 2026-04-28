// Regression: every scene-replacement entry point produces a clean slate.
//
// The bug class: applying a preset / template / blank-custom-room or
// loading a project file leaves residue from the previous scene
// (sources, listeners, zones, audience, racks, project name, results
// caches). Has bitten THREE times in this codebase:
//   1. auditorium → pavilion crossover (arena's zones + sources survived)
//   2. pavilion zones bleeding into a hifi-template-applied scene
//   3. custom-room showing arena's leftover audience + speakers
//
// Each fix was a band-aid on the specific symptom. This test enforces
// the structural fix: js/state/scene-lifecycle.js's resetSceneState
// MUST be called by every entry point, and the post-state MUST contain
// no fields from the prior scene.
//
// Run: node tests/scene-reset.test.mjs

import {
  state, applyPresetToState, applyTemplateToState, applyBlankCustomRoom,
  PRESETS, TEMPLATES,
  serializeProject, deserializeProject,
} from '../js/app-state.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// Polluter: load a fully-populated arena scene with custom additions
// the next entry point would NOT install on its own. If any of these
// leak past the next reset, the test fails.
function pollute() {
  applyPresetToState('auditorium');
  state.projectName = 'POLLUTANT';
  state.rackSystem = { racks: [{ id: 'R1', label: 'pollutant', rackModelKey: 'open-frame-12u', position: { x: 0, y: 0, z: 0 }, yaw_deg: 0, slots: [] }] };
  state.results.splGrid = { polluted: true };
  state.results.zoneGrids = [{ polluted: true }];
  state.results.precision = { polluted: true };
}

function isClean(label) {
  // After a reset, these MUST hold (regardless of what the entry point
  // overlays on top — the reset is the floor).
  let ok = true;
  if (state.projectName === 'POLLUTANT')        { console.log(`  ${label}: projectName leaked`); ok = false; }
  if (state.results.splGrid?.polluted)          { console.log(`  ${label}: splGrid leaked`);     ok = false; }
  if (state.results.zoneGrids?.[0]?.polluted)   { console.log(`  ${label}: zoneGrids leaked`);   ok = false; }
  if (state.results.precision?.polluted)        { console.log(`  ${label}: precision leaked`);   ok = false; }
  // rackSystem.racks must NOT contain the pollutant rack id 'R1' with
  // label 'pollutant' (presets / templates may legitimately add their
  // own racks down the line, hence checking the specific pollutant only)
  const pollutedRack = (state.rackSystem?.racks ?? []).find(r => r.label === 'pollutant');
  if (pollutedRack)                              { console.log(`  ${label}: rack pollutant leaked`); ok = false; }
  return ok;
}

// 1. applyPresetToState wipes the prior scene clean.
pollute();
applyPresetToState('pavilion');
assert(isClean('preset:pavilion'), 'applyPresetToState clears all prior-scene residue');

// 2. applyTemplateToState wipes the prior scene clean.
pollute();
applyTemplateToState('hifi');
assert(isClean('template:hifi'), 'applyTemplateToState clears all prior-scene residue');

// 3. applyBlankCustomRoom wipes the prior scene clean.
pollute();
applyBlankCustomRoom();
assert(isClean('custom (blank)'), 'applyBlankCustomRoom clears all prior-scene residue');

// 3a. applyBlankCustomRoom also clears state.zones / sources / listeners.
//     The historic bug: arena's audience / sources survived because
//     applyBlankCustomRoom only touched state.room.
pollute();
applyBlankCustomRoom();
assert(state.zones.length === 0,     'custom: zones cleared');
assert(state.sources.length === 0,   'custom: sources cleared');
assert(state.listeners.length === 0, 'custom: listeners cleared');
assert(state.room.stadiumStructure === null,    'custom: stadiumStructure cleared');
assert(state.room.multiLevelStructure === null, 'custom: multiLevelStructure cleared');

// 4. applyBlankCustomRoom preserves projectName when explicitly passed.
pollute();
applyBlankCustomRoom({ projectName: 'Hospital Serdang' });
assert(state.projectName === 'Hospital Serdang', 'custom with projectName: name preserved');

// 5. deserializeProject wipes the prior scene clean before overlay.
pollute();
const arenaSerialized = (() => {
  applyPresetToState('auditorium');
  state.projectName = 'Arena Serialized';
  return JSON.parse(JSON.stringify(serializeProject()));
})();
pollute();
deserializeProject(arenaSerialized);
assert(state.projectName === 'Arena Serialized',
  'deserialize: projectName from saved file overlays cleanly');
assert(state.zones.length === PRESETS.auditorium.zones.length,
  'deserialize: zones from saved file (no leftover pollutant zones)');
// `pollutant` rack id should be gone.
assert(!(state.rackSystem.racks ?? []).find(r => r.label === 'pollutant'),
  'deserialize: pollutant rack purged');

// 6. Round-trip on each entry preserves clean state.
for (const k of Object.keys(PRESETS)) {
  pollute();
  applyPresetToState(k);
  assert(isClean(`preset:${k}`), `applyPresetToState(${k}) clean after pollute`);
}
for (const k of Object.keys(TEMPLATES)) {
  pollute();
  applyTemplateToState(k);
  assert(isClean(`template:${k}`), `applyTemplateToState(${k}) clean after pollute`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll scene-reset regression tests passed.');
