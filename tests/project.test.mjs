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

// 5a. Project name round-trip — user-set label survives serialise +
//     restore + re-serialise, and a preset/template apply clears it.
applyTemplateToState('hifi');
state.projectName = 'Hospital Serdang';
{
  const { ok } = roundTripSnapshot('hifi + projectName');
  assert(ok, 'Round-trip clean: projectName="Hospital Serdang" survives');
}
applyPresetToState('auditorium');
assert(state.projectName === null, 'applyPresetToState clears projectName');
applyTemplateToState('hifi');
assert(state.projectName === null, 'applyTemplateToState clears projectName');

// 5b. PA equipment rack round-trip — populate state.rackSystem with a
//     33U rack holding 4 amps and verify byte-equal restore.
applyTemplateToState('hifi');
state.rackSystem = {
  racks: [{
    id: 'R1',
    label: 'Main rack',
    rackModelKey: 'open-frame-33u',
    position: { x: 1.0, y: 0.6, z: 0 },
    yaw_deg: 0,
    slots: [
      { uStart: 2, uHeight: 1, amplifierId: 'qd2050',  label: 'Zone A', channelAssignments: [{ ch: 1, zoneId: 'Z1', tap_w: 100 }] },
      { uStart: 3, uHeight: 1, amplifierId: 'qd2050',  label: 'Zone B', channelAssignments: [{ ch: 1, zoneId: 'Z2', tap_w: 100 }] },
      { uStart: 5, uHeight: 1, amplifierId: 'pa2240',  label: 'BGM',    channelAssignments: [
        { ch: 1, zoneId: 'Z3', tap_w: 60 },
        { ch: 2, zoneId: 'Z4', tap_w: 60 },
        { ch: 3, zoneId: null, tap_w: 0 },
        { ch: 4, zoneId: null, tap_w: 0 },
      ]},
      { uStart: 7, uHeight: 1, amplifierId: 'evm8810', label: 'Voice-alarm controller', channelAssignments: [] },
    ],
  }],
};
{
  const { ok } = roundTripSnapshot('hifi + populated 33U rack');
  assert(ok, 'Round-trip clean: hifi + populated 33U rack (4 amps, channel-to-zone assigned)');
}

// 5c. Reset on preset/template swap — applying a fresh preset clears
//     the rack so the previous scene's rack doesn't leak.
state.rackSystem = { racks: [{ id: 'R1', rackModelKey: 'open-frame-12u', slots: [] }] };
applyTemplateToState('studio');
assert(state.rackSystem.racks.length === 0,
  `applyTemplateToState resets rackSystem.racks to [] (got ${state.rackSystem.racks.length})`);

state.rackSystem = { racks: [{ id: 'R1', rackModelKey: 'open-frame-12u', slots: [] }] };
applyPresetToState('auditorium');
assert(state.rackSystem.racks.length === 0,
  `applyPresetToState resets rackSystem.racks to [] (got ${state.rackSystem.racks.length})`);

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
