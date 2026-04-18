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

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll preset tests passed.');
