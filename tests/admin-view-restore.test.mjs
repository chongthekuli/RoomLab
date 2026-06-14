// Admin read-only viewer — own-scene restore regression (v=835, 2026-06-14).
//
// THE failure mode this guards (Hannes SE-1): an admin opens another user's
// room read-only, then Exits — and their OWN in-progress scene must come back
// EXACTLY as it was, including unsaved edits and which room Save targets. The
// naive "re-run the boot restore on exit" silently destroys unsaved work; the
// correct model snapshots the admin's live scene at entry and restores THAT.
//
// This is pure (admin-view.js imports only app-state + scene-dirty, both
// Node-safe; the panel-room room-id is injected). Pins:
//   1. begin → read-only ON, foreign scene loaded, Save can't target own library.
//   2. end → own scene byte-for-byte restored, active room id + dirty flag back,
//      read-only OFF, session cleared.
//   3. begin/end are idempotent (route/mount double-fire safe).
//   4. while viewing, markDirty is a no-op (no accidental dirty on the foreign scene).
//
// Run: node tests/admin-view-restore.test.mjs

import { state, serializeProject, deserializeProject } from '../js/app-state.js';
import { isDirty, markDirty, markClean, isReadOnly } from '../js/state/scene-dirty.js';
import {
  configureAdminView, beginAdminView, endAdminView,
  getActiveAdminView, isAdminViewing,
} from '../js/state/admin-view.js';

let failed = 0;
const ok = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; };

// serializeProject() stamps a fresh meta.savedAt timestamp every call, so a raw
// byte compare always differs on that one volatile field. Canonicalize it out —
// we're asserting the SCENE DATA round-trips, not the export timestamp.
const canon = () => { const o = serializeProject(); if (o.meta) o.meta.savedAt = '<t>'; return JSON.stringify(o); };

// Injected room-id hook (stands in for panel-room's activeCustomRoomId).
let roomId = 'cr-own-123';
configureAdminView({ getRoomId: () => roomId, setRoomId: (v) => { roomId = v; } });

// --- the admin's OWN scene (with an unsaved edit) ---------------------------
const ownBlob = {
  projectName: 'My Project',
  room: { name: 'Admin Hall', shape: 'rectangular', width_m: 10, depth_m: 8, height_m: 4, surfaces: {} },
  sources: [{ modelUrl: 'data/loudspeakers/generic-12inch.json', position: { x: 3, y: 7, z: 3 }, aim: { yaw: 180, pitch: 0, roll: 0 }, kind: 'point' }],
  listeners: [{ id: 'L1', label: 'A', position: { x: 5, y: 4, z: 1.2 }, posture: 'standing' }],
  zones: [],
  treatments: [],
  physics: { reverberantField: true, coherent: false, airAbsorption: true, freq_hz: 1000, ambientNoise: { preset: 'nc-35', per_band: [60, 52, 45, 40, 36, 34, 33] }, eq: { enabled: false, bands: [] } },
};
// A DIFFERENT foreign scene (the user being inspected).
const foreignBlob = {
  projectName: 'Client X',
  room: { name: 'Their Auditorium', shape: 'custom', width_m: 20, depth_m: 15, height_m: 6, custom_vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 15 }, { x: 0, y: 15 }], surfaces: {} },
  sources: [
    { modelUrl: 'data/loudspeakers/generic-12inch.json', position: { x: 5, y: 14, z: 4 }, aim: { yaw: 180, pitch: 0, roll: 0 }, kind: 'point' },
    { modelUrl: 'data/loudspeakers/generic-12inch.json', position: { x: 15, y: 14, z: 4 }, aim: { yaw: 180, pitch: 0, roll: 0 }, kind: 'point' },
  ],
  listeners: [
    { id: 'L1', label: 'Front', position: { x: 10, y: 10, z: 1.2 }, posture: 'standing' },
    { id: 'L2', label: 'Rear', position: { x: 10, y: 3, z: 1.2 }, posture: 'standing' },
  ],
  zones: [{ id: 'Z1', label: 'Stalls', vertices: [{ x: 2, y: 2 }, { x: 18, y: 2 }, { x: 18, y: 12 }, { x: 2, y: 12 }] }],
  treatments: [],
  physics: { reverberantField: true, coherent: false, airAbsorption: true, freq_hz: 1000, ambientNoise: { preset: 'nc-35', per_band: [60, 52, 45, 40, 36, 34, 33] }, eq: { enabled: false, bands: [] } },
};

// Load the admin's own scene + make an "unsaved edit" (dirty). Real scenes are
// serializeProject() blobs (carry formatVersion); wrap the raw fixtures the
// same way the cloud library stores them.
const foreignScene = serializeProject(foreignBlob);
markClean();
deserializeProject(serializeProject(ownBlob));
markDirty();
const ownCanonical = canon();   // the data-truth to restore to (timestamp ignored)
ok(isDirty() === true, 'precondition: admin has an unsaved (dirty) scene');
ok(roomId === 'cr-own-123', 'precondition: admin has an active room id');

// --- 1. begin a read-only view of the foreign room --------------------------
const began = beginAdminView({ viewedUid: 'u-other', viewedEmail: 'client@x.com', viewedRoomName: 'Their Auditorium', scene: foreignScene });
ok(began === true, 'beginAdminView returns true on entry');
ok(isReadOnly() === true, 'begin → read-only mode ON');
ok(isAdminViewing() === true, 'begin → a session is active');
ok(roomId === null, 'begin → active room id nulled (Save cannot target the admin’s own library)');
ok(state.sources.length === 2 && state.room.name === 'Their Auditorium', 'begin → the FOREIGN scene is loaded into state');
const av = getActiveAdminView();
ok(av && av.ownRoomId === 'cr-own-123' && av.wasDirty === true, 'begin → snapshot captured the admin’s own room id + dirty flag');

// --- 4. while viewing, markDirty is a no-op (foreign scene can't go dirty) ---
markDirty();
ok(isDirty() === false, 'read-only: markDirty is a no-op (no accidental dirty on the foreign scene)');

// --- 3a. begin is idempotent (route/mount double-fire) ----------------------
const beganAgain = beginAdminView({ scene: serializeProject(ownBlob) });
ok(beganAgain === false && state.room.name === 'Their Auditorium', 'beginAdminView is idempotent — a second call does NOT re-snapshot / swap scenes');

// --- 2. EXIT — the admin's own scene must come back EXACTLY ------------------
const ended = endAdminView();
ok(ended === true, 'endAdminView returns true on exit');
ok(isReadOnly() === false, 'exit → read-only mode OFF');
ok(isAdminViewing() === false, 'exit → session cleared');
ok(getActiveAdminView() === null, 'exit → getActiveAdminView() is null');
ok(roomId === 'cr-own-123', 'exit → active room id restored (Save targets the right room again)');
ok(isDirty() === true, 'exit → the admin’s UNSAVED-edit (dirty) flag is restored — work not lost');
ok(canon() === ownCanonical,
   'exit → the admin’s own scene is restored exactly (no serialize round-trip field drop)');

// --- 3b. end is idempotent --------------------------------------------------
const endedAgain = endAdminView();
ok(endedAgain === false, 'endAdminView is idempotent — a second call is a no-op');

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nAll admin-view restore assertions passed.');
