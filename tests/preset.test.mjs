import {
  state, applyPresetToState, applyTemplateToState,
  PRESETS, TEMPLATES,
} from '../js/app-state.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// PRESETS = signature pre-built scenes (auditorium + pavilion). TEMPLATES =
// parametric shape generators. The split was introduced when the eight
// smaller rooms (hi-fi, studio, classroom, etc.) became user-scalable.
assert(Object.keys(PRESETS).length === 2, 'PRESETS has exactly 2 entries (auditorium, pavilion)');
assert('auditorium' in PRESETS && 'pavilion' in PRESETS, 'PRESETS contains auditorium + pavilion');
assert(Object.keys(TEMPLATES).length === 8, 'TEMPLATES has exactly 8 entries');
for (const k of ['hifi','studio','classroom','livevenue','recitalhall','chamber','octagon','rotunda']) {
  assert(k in TEMPLATES, `TEMPLATES contains ${k}`);
}

// Every PRESET must define sources + listeners (preset swaps fully replace
// the scene).
for (const [key, p] of Object.entries(PRESETS)) {
  assert(Array.isArray(p.sources) && p.sources.length > 0, `Preset "${key}" defines sources`);
  assert(Array.isArray(p.listeners) && p.listeners.length > 0, `Preset "${key}" defines listeners`);
  assert(p.shape != null, `Preset "${key}" defines a shape`);
  assert(typeof p.width_m === 'number' && typeof p.height_m === 'number' && typeof p.depth_m === 'number',
    `Preset "${key}" defines room dimensions`);
}

// Every TEMPLATE must declare label, shape, defaultDims, and a generator
// that returns sources + listeners. The generator is what makes them
// rescaleable — calling it twice with different dims must produce two
// different layouts.
for (const [key, t] of Object.entries(TEMPLATES)) {
  assert(typeof t.label === 'string' && t.label.length > 0, `Template "${key}" has a label`);
  assert(typeof t.shape === 'string', `Template "${key}" declares a shape`);
  assert(t.defaultDims && typeof t.defaultDims === 'object', `Template "${key}" has defaultDims`);
  assert(typeof t.generate === 'function', `Template "${key}" exposes generate()`);
  const out = t.generate(t.defaultDims);
  assert(Array.isArray(out.sources) && out.sources.length > 0, `Template "${key}" generator produces sources`);
  assert(Array.isArray(out.listeners) && out.listeners.length > 0, `Template "${key}" generator produces listeners`);
}

// Auditorium → hi-fi (template) must fully swap sources and listeners.
applyPresetToState('auditorium');
const arenaPower = state.sources[0].power_watts;
const arenaListenerLabel = state.listeners[0].label;
assert(state.sources.length === PRESETS.auditorium.sources.length, 'Auditorium: source count matches');
assert(state.listeners.length === PRESETS.auditorium.listeners.length, 'Auditorium: listener count matches');

applyTemplateToState('hifi');
const hifiOut = TEMPLATES.hifi.generate(TEMPLATES.hifi.defaultDims);
assert(state.sources.length === hifiOut.sources.length, 'Hi-fi (template): source count replaced');
assert(state.listeners.length === hifiOut.listeners.length, 'Hi-fi (template): listener count replaced');
assert(state.sources[0].power_watts === hifiOut.sources[0].power_watts,
  `Hi-fi: source power is hi-fi value (${hifiOut.sources[0].power_watts}), not arena (${arenaPower})`);
assert(state.zones.length === 0, 'Hi-fi: zones cleared');
assert(state.listeners[0].position.x === hifiOut.listeners[0].position.x, 'Hi-fi: listener X is hi-fi position');

// Switch through several scenes in sequence to verify no cross-contamination.
applyTemplateToState('studio');
assert(state.sources[0].power_watts === TEMPLATES.studio.generate(TEMPLATES.studio.defaultDims).sources[0].power_watts,
  'Studio: source power correct');
applyTemplateToState('livevenue');
assert(state.sources.length === TEMPLATES.livevenue.generate(TEMPLATES.livevenue.defaultDims).sources.length,
  'Live venue: source count correct');
applyPresetToState('auditorium');
assert(state.listeners[0].label !== arenaListenerLabel || state.listeners.length === PRESETS.auditorium.listeners.length,
  'Auditorium: restored after round-trip (state lands on arena layout)');

// Deep-cloning: mutating state.sources must not mutate the preset's template.
applyTemplateToState('hifi');
state.sources[0].power_watts = 999;
applyTemplateToState('hifi');
const hifiFresh = TEMPLATES.hifi.generate(TEMPLATES.hifi.defaultDims);
assert(state.sources[0].power_watts === hifiFresh.sources[0].power_watts,
  'Template re-apply gives a fresh layout (no leftover state mutations)');

// Apply with dimsOverride scales the room AND the speakers.
applyTemplateToState('hifi', { width_m: 8, depth_m: 10, height_m: 3 });
assert(state.room.width_m === 8 && state.room.depth_m === 10 && state.room.height_m === 3,
  'Hi-fi with dimsOverride: room dims set');
const xL = state.sources[0].position.x;
const xR = state.sources[1].position.x;
assert(xL > 1 && xR > 5 && xR > xL,
  'Hi-fi with dimsOverride: speaker positions scaled with room width');

// stadiumStructure / multiLevelStructure must be cleared by template apply.
applyPresetToState('auditorium');
assert(state.room.stadiumStructure != null, 'Auditorium: stadiumStructure copied to state.room');
applyTemplateToState('hifi');
assert(state.room.stadiumStructure === null, 'Hi-fi (template): stadiumStructure cleared to null');
applyTemplateToState('hifi');
state.room.stadiumStructure = { catwalkHeight_m: -999 }; // forced corruption
applyTemplateToState('hifi');
assert(state.room.stadiumStructure === null, 'Template re-apply scrubs corrupted stadiumStructure');

// Pavilion preset's multiLevelStructure round-trips cleanly through templates.
applyPresetToState('pavilion');
assert(state.room.multiLevelStructure != null, 'Pavilion: multiLevelStructure copied');
applyTemplateToState('octagon');
assert(state.room.multiLevelStructure === null, 'Octagon (template): multiLevelStructure cleared');
applyPresetToState('pavilion');
assert(state.room.multiLevelStructure != null, 'Pavilion re-applied: multiLevelStructure restored');

// Auditorium ↔ Pavilion swap (the historic crossover bug).
applyPresetToState('auditorium');
assert(state.zones.length > 0, 'Auditorium: zones populated (baseline)');
applyPresetToState('pavilion');
assert(state.room.stadiumStructure === null, 'Pavilion: auditorium stadiumStructure cleared');
assert(state.zones.length === PRESETS.pavilion.zones.length,
  'Pavilion: arena zones replaced with pavilion zones');
assert(state.zones.every(z => !z.id.startsWith('Z_')),
  'Pavilion: none of arena Z_-prefixed zone ids survived');
assert(state.sources.length === PRESETS.pavilion.sources.length,
  'Pavilion: sources match preset (no leftover arena PA)');
applyPresetToState('auditorium');
assert(state.room.multiLevelStructure === null, 'Auditorium (after Pavilion): multiLevelStructure cleared');
assert(state.room.stadiumStructure != null, 'Auditorium (after Pavilion): stadiumStructure restored');

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll preset/template tests passed.');
