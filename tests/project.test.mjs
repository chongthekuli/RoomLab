// Round-trip tests for the .roomlab.json project file format.
// Every preset's state must survive serialize → JSON → parse → deserialize
// → re-serialize without changing field-by-field. Catches silent data loss
// when a future state field gets added but isn't wired into the schema.

import {
  state, applyPresetToState, applyTemplateToState, PRESETS, TEMPLATES,
  serializeProject, deserializeProject, PROJECT_FORMAT_VERSION,
} from '../js/app-state.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

function deepEqual(a, b, path = '') {
  if (a === b) return true;
  if (typeof a !== typeof b) { console.log('  type mismatch at', path, typeof a, 'vs', typeof b); return false; }
  if (a === null || b === null) { console.log('  null mismatch at', path); return false; }
  if (Array.isArray(a) !== Array.isArray(b)) { console.log('  array vs object at', path); return false; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) { console.log('  length mismatch at', path, a.length, 'vs', b.length); return false; }
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], `${path}[${i}]`)) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
      console.log('  key set differs at', path, ka, 'vs', kb);
      return false;
    }
    for (const k of ka) if (!deepEqual(a[k], b[k], `${path}.${k}`)) return false;
    return true;
  }
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  console.log('  value differs at', path, JSON.stringify(a).slice(0, 80), 'vs', JSON.stringify(b).slice(0, 80));
  return false;
}

function roundTripSnapshot(label) {
  // savedAt is non-deterministic — strip from both sides.
  const dump1 = JSON.parse(JSON.stringify(serializeProject()));
  delete dump1.meta;
  const text = JSON.stringify(serializeProject());
  const parsed = JSON.parse(text);
  const result = deserializeProject(parsed);
  const dump2 = JSON.parse(JSON.stringify(serializeProject()));
  delete dump2.meta;
  return { ok: deepEqual(dump1, dump2), warnings: result.warnings, before: dump1, after: dump2 };
}

// 1. Schema version is exposed and 1.
assert(PROJECT_FORMAT_VERSION === 1, 'PROJECT_FORMAT_VERSION === 1');

// 2. Every preset round-trips byte-for-byte.
for (const key of Object.keys(PRESETS)) {
  applyPresetToState(key);
  const { ok } = roundTripSnapshot(key);
  assert(ok, `Round-trip clean: ${key}`);
}

// Templates round-trip too — apply each, serialize, restore, compare.
for (const key of Object.keys(TEMPLATES)) {
  applyTemplateToState(key);
  const { ok } = roundTripSnapshot(`template:${key}`);
  assert(ok, `Round-trip clean: template ${key}`);
}

// 3. Hand-edited custom scene round-trips: line-array source + EQ-on +
//    custom ambient noise + selected listener.
applyTemplateToState('hifi');
state.sources.push({
  kind: 'line-array',
  id: 'LA_TEST',
  modelUrl: 'data/loudspeakers/line-array-element.json',
  groupId: 'B',
  origin: { x: 2, y: 1, z: 4 },
  baseYaw_deg: 5,
  topTilt_deg: -3,
  splayAnglesDeg: [2, 3, 5, 8],
  elementSpacing_m: 0.42,
  power_watts_each: 500,
});
state.physics.eq.enabled = true;
state.physics.eq.bands[3].gain_db = 2.5;
state.physics.ambientNoise = { preset: 'mosque', per_band: [55, 50, 47, 44, 41, 38, 36] };
state.selectedSpeakerUrl = 'data/loudspeakers/generic-12inch.json';
state.selectedListenerId = state.listeners[0]?.id ?? null;
{
  const { ok } = roundTripSnapshot('hand-edited custom scene');
  assert(ok, 'Round-trip clean: hi-fi + line-array + EQ + ambient + selection');
}

// 4. Version-mismatch — future-version files must throw a clear error.
try {
  deserializeProject({ formatVersion: 99 });
  assert(false, 'Future-version file should throw');
} catch (err) {
  assert(/Unsupported file version/.test(err.message), 'Future-version file rejected with clear error');
}

// 5. Garbage file — must throw, not silently corrupt state.
try {
  deserializeProject('not an object');
  assert(false, 'Non-object payload should throw');
} catch (err) {
  assert(/valid RoomLAB/.test(err.message), 'Non-object payload rejected');
}
try {
  deserializeProject({});
  assert(false, 'Missing formatVersion should throw');
} catch (err) {
  assert(/formatVersion/.test(err.message), 'Missing formatVersion rejected');
}

// 6. Empty arrays serialize as arrays, not undefined.
applyTemplateToState('hifi');
state.zones = [];
state.sources = [];
state.listeners = [];
{
  const text = JSON.stringify(serializeProject());
  const obj = JSON.parse(text);
  assert(Array.isArray(obj.zones) && obj.zones.length === 0, 'Empty zones serialize as []');
  assert(Array.isArray(obj.sources) && obj.sources.length === 0, 'Empty sources serialize as []');
  assert(Array.isArray(obj.listeners) && obj.listeners.length === 0, 'Empty listeners serialize as []');
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll project round-trip tests passed.');
