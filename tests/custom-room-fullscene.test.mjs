// Regression — bug 2026-05-21 (user-reported):
//
//   "In my custom room I placed speaker and listener; later when I switch
//    to another preset room and switch back to my custom room, all the
//    speaker and listener gone, maybe audience too. Please keep things,
//    including all the author notes, everything."
//
// The saved-rooms library only persisted room GEOMETRY (+ rackSystem) —
// sources / listeners / zones / treatments / physics / author notes were
// dropped on reopen. Fix: each entry now stores a full serializeProject()
// scene snapshot, and loadCustomRoomById restores it via
// deserializeProject() — the same lossless round-trip as 💾 Save →
// .roomlab.json. This is the round-trip assertion Martina flagged would
// have caught every bug in this feature.
//
// Run: node tests/custom-room-fullscene.test.mjs

import { readFileSync } from 'node:fs';

// localStorage shim BEFORE importing custom-rooms (read at call time).
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
};

const { state, serializeProject, deserializeProject } = await import('../js/app-state.js');
const { saveCustomRoom, updateCustomRoom, getCustomRoomById } = await import('../js/shared/custom-rooms.js');

let failed = 0;
const pass = (l) => console.log(`PASS  ${l}`);
const fail = (l, e = '') => { console.log(`FAIL  ${l}${e ? '  — ' + e : ''}`); failed++; };
const ok = (c, l, e = '') => (c ? pass(l) : fail(l, e));

// A fully-populated custom scene: two speakers, two listeners, an
// audience zone, a treatment, an author note, a physics tweak, a rack.
const seeded = {
  projectName: 'sdff',
  room: {
    name: 'Hall A',
    authorComments: 'Qibla wall is north; client wants STI >= 0.5 in rear rows.',
    shape: 'custom',
    width_m: 12, depth_m: 9, height_m: 4,
    custom_vertices: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 9 }, { x: 0, y: 9 }],
    surfaces: { floor: 'concrete', ceiling: 'gypsum-board', walls: 'gypsum-board' },
  },
  sources: [
    { modelUrl: 'data/loudspeakers/generic-12inch.json', position: { x: 2, y: 8, z: 3 }, aim: { yaw: 180, pitch: 0, roll: 0 }, kind: 'point', groupId: 'A' },
    { modelUrl: 'data/loudspeakers/generic-12inch.json', position: { x: 10, y: 8, z: 3 }, aim: { yaw: 180, pitch: 0, roll: 0 }, kind: 'point', groupId: 'A' },
  ],
  listeners: [
    { id: 'L1', label: 'Front', position: { x: 6, y: 6, z: 1.2 }, posture: 'standing' },
    { id: 'L2', label: 'Rear', position: { x: 6, y: 2, z: 1.2 }, posture: 'standing' },
  ],
  zones: [
    { id: 'Z1', label: 'Congregation', vertices: [{ x: 1, y: 1 }, { x: 11, y: 1 }, { x: 11, y: 7 }, { x: 1, y: 7 }] },
  ],
  treatments: [
    { id: 'T1', productId: 'panel-50mm', position: { x: 0, y: 4, z: 2 }, wall: 'west' },
  ],
  physics: {
    reverberantField: true, coherent: false, airAbsorption: true, freq_hz: 1000,
    ambientNoise: { preset: 'nc-35', per_band: [60, 52, 45, 40, 36, 34, 33] },
    eq: { enabled: false, bands: [] },
  },
  rackSystem: { racks: [{ id: 'R1', name: 'Amp rack', units: [] }] },
};

// --- (1) full-scene round-trip via serialize → deserialize -------------
deserializeProject(serializeProject(seeded));   // applies to global `state`
ok(state.sources.length === 2, 'round-trip: both speakers survive (the reported loss)');
ok(state.listeners.length === 2, 'round-trip: both listeners survive');
ok(state.zones.length === 1, 'round-trip: audience zone survives');
ok(state.treatments.length === 1, 'round-trip: treatment survives');
ok(state.room.authorComments === seeded.room.authorComments, 'round-trip: author notes survive verbatim');
ok(state.room.name === 'Hall A', 'round-trip: room name survives');
ok(state.projectName === 'sdff', 'round-trip: project name survives');
ok(state.physics.reverberantField === true, 'round-trip: physics tweak survives');
ok(state.rackSystem.racks.length === 1, 'round-trip: rack survives');

// --- (2) custom-rooms library persists + reopens the scene blob --------
const entry = saveCustomRoom({ projectName: 'sdff', roomName: 'Hall A', scene: serializeProject(seeded) });
ok(!!entry.scene && entry.room === undefined,
   'library: new entry stores a scene blob, no legacy room field');

// Simulate switching to a blank scene, then reopening the saved room.
deserializeProject(serializeProject({
  projectName: null,
  room: { name: 'blank', shape: 'rectangular', width_m: 10, depth_m: 10, height_m: 3, surfaces: {} },
  sources: [], listeners: [], zones: [], treatments: [],
  physics: seeded.physics, rackSystem: { racks: [] },
}));
ok(state.sources.length === 0 && state.listeners.length === 0,
   'library: scene cleared after switching to a blank scene (the "switch to preset" step)');

const reopened = getCustomRoomById(entry.id);
deserializeProject(reopened.scene);
ok(state.sources.length === 2 && state.listeners.length === 2 && state.zones.length === 1,
   'library: reopening the saved room restores speakers + listeners + zone');
ok(state.room.authorComments === seeded.room.authorComments,
   'library: reopening restores author notes');

// --- (3) updateCustomRoom EITHER/OR invariant --------------------------
const legacy = saveCustomRoom({ projectName: 'old', roomName: 'Legacy', room: { name: 'Legacy', shape: 'custom' }, rackSystem: { racks: [] } });
ok(!!legacy.room && legacy.scene === undefined,
   'library: legacy save (no scene) keeps the geometry-only shape');
updateCustomRoom(legacy.id, { scene: serializeProject(seeded) });
const migrated = getCustomRoomById(legacy.id);
ok(!!migrated.scene && migrated.room === undefined && migrated.rackSystem === undefined,
   'library: migrating a legacy entry to a scene blob strips stale room/rackSystem (EITHER/OR invariant)');

// --- (4) wiring guards in panel-room.js --------------------------------
const panel = readFileSync('js/ui/panel-room.js', 'utf8');
ok(/on\('source:changed',\s*scheduleActiveRoomSync\)/.test(panel)
   && /on\('listener:changed',\s*scheduleActiveRoomSync\)/.test(panel)
   && /on\('treatment:changed',\s*scheduleActiveRoomSync\)/.test(panel),
   'panel-room: auto-sync now also fires on source/listener/treatment changes (was the gap)');
ok(/scene:\s*serializeProject\(\)/.test(panel),
   'panel-room: auto-sync captures a full serializeProject() snapshot');
ok(/deserializeProject\(entry\.scene\)/.test(panel),
   'panel-room: loadCustomRoomById restores the scene blob via deserializeProject');
ok(/_suppressSync/.test(panel),
   'panel-room: _suppressSync guard exists (preset/load swaps cannot clobber the saved room)');

console.log(failed === 0
  ? '\nAll custom-room full-scene tests passed.'
  : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
