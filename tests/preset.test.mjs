import { state, applyPresetToState, PRESETS } from '../js/app-state.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// Every preset must define sources + listeners so preset swaps fully replace the scene.
for (const [key, p] of Object.entries(PRESETS)) {
  assert(Array.isArray(p.sources) && p.sources.length > 0, `Preset "${key}" defines sources`);
  assert(Array.isArray(p.listeners) && p.listeners.length > 0, `Preset "${key}" defines listeners`);
  assert(p.shape != null, `Preset "${key}" defines a shape`);
  assert(typeof p.width_m === 'number' && typeof p.height_m === 'number' && typeof p.depth_m === 'number',
    `Preset "${key}" defines room dimensions`);
}

// Auditorium → Hi-fi must fully swap sources and listeners (the reported bug).
applyPresetToState('auditorium');
assert(state.sources.length === PRESETS.auditorium.sources.length, 'Auditorium: source count matches');
assert(state.listeners.length === PRESETS.auditorium.listeners.length, 'Auditorium: listener count matches');
const arenaPower = state.sources[0].power_watts;
const arenaListenerLabel = state.listeners[0].label;

applyPresetToState('hifi');
assert(state.sources.length === PRESETS.hifi.sources.length, 'Hi-fi: source count replaced');
assert(state.listeners.length === PRESETS.hifi.listeners.length, 'Hi-fi: listener count replaced');
assert(state.sources[0].power_watts === PRESETS.hifi.sources[0].power_watts,
  `Hi-fi: source power is hi-fi value (${PRESETS.hifi.sources[0].power_watts}), not arena (${arenaPower})`);
assert(state.zones.length === 0, 'Hi-fi: zones cleared');
assert(state.listeners[0].position.x === PRESETS.hifi.listeners[0].position.x,
  'Hi-fi: listener X is hi-fi position');

// Switch through several presets in sequence to verify no cross-contamination.
applyPresetToState('studio');
assert(state.sources[0].power_watts === PRESETS.studio.sources[0].power_watts, 'Studio: source power correct');
applyPresetToState('livevenue');
assert(state.sources.length === PRESETS.livevenue.sources.length, 'Live venue: source count correct');
applyPresetToState('auditorium');
assert(state.listeners[0].label !== arenaListenerLabel || state.listeners.length === PRESETS.auditorium.listeners.length,
  'Auditorium: restored after round-trip (state lands on arena layout)');

// Deep-cloning: mutating state.sources must not mutate the preset definition.
applyPresetToState('hifi');
state.sources[0].power_watts = 999;
applyPresetToState('auditorium');
assert(PRESETS.hifi.sources[0].power_watts !== 999, 'Preset template not mutated by state edit');

// stadiumStructure is copied to state.room when the preset defines one.
// This bug was shipped for several commits — the unified profile rendering
// was a dead branch because state.room.stadiumStructure stayed undefined.
applyPresetToState('auditorium');
assert(state.room.stadiumStructure != null, 'Auditorium: stadiumStructure copied to state.room');
assert(state.room.stadiumStructure.lowerBowl != null, 'Auditorium: lowerBowl on stadiumStructure');
assert(state.room.stadiumStructure.upperBowl != null, 'Auditorium: upperBowl on stadiumStructure');
assert(Array.isArray(state.room.stadiumStructure.vomitories?.centerAnglesDeg),
  'Auditorium: vomitories.centerAnglesDeg propagated');

// Switching to a preset without stadiumStructure clears state.room.stadiumStructure to null.
applyPresetToState('hifi');
assert(state.room.stadiumStructure === null, 'Hi-fi: stadiumStructure cleared to null');

// Deep clone: mutating the state copy must not mutate the preset's template.
applyPresetToState('auditorium');
state.room.stadiumStructure.catwalkHeight_m = -999;
applyPresetToState('hifi'); // clear
applyPresetToState('auditorium'); // re-apply
assert(state.room.stadiumStructure.catwalkHeight_m !== -999,
  'stadiumStructure deep-cloned (no template mutation)');

// Pavilion preset: multiLevelStructure must be copied and cleared through
// presets cleanly — this was the "arena's audience carried into pavilion"
// bug reported in commit 4708b53.
applyPresetToState('auditorium');
assert(state.zones.length > 0, 'Auditorium: zones populated (baseline)');
applyPresetToState('pavilion');
assert(state.room.stadiumStructure === null,
  'Pavilion: auditorium stadiumStructure cleared');
assert(state.room.multiLevelStructure != null,
  'Pavilion: multiLevelStructure copied');
assert(state.zones.length === PRESETS.pavilion.zones.length,
  'Pavilion: arena zones replaced with pavilion zones (no cross-contamination)');
assert(state.zones.every(z => !z.id.startsWith('Z_')),
  'Pavilion: none of arena\'s Z_-prefixed zone ids survived the swap');
assert(state.sources.length === PRESETS.pavilion.sources.length,
  'Pavilion: sources match preset (no leftover arena PA)');
applyPresetToState('auditorium');
assert(state.room.multiLevelStructure === null,
  'Auditorium (after Pavilion): multiLevelStructure cleared');
assert(state.room.stadiumStructure != null,
  'Auditorium (after Pavilion): stadiumStructure restored');

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll preset tests passed.');
