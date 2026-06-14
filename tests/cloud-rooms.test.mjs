// Cloud room-library cache regression test (v=834, 2026-06-14).
//
// js/state/cloud-rooms.js is the in-memory cache that backs the projects/rooms
// library. It exposes a SYNCHRONOUS read API (drop-in for the retired
// custom-rooms.js) and OPTIMISTIC mutators (mutate cache + return sync, then
// write async). The Firestore functions are injected, so the cache logic is
// fully testable in Node. Pins:
//   1. hydrate fills the cache; reads are synchronous + grouped by project.
//   2. mutators are OPTIMISTIC — the cache reflects the change BEFORE the async
//      write resolves, and the write is dispatched to the injected DB.
//   3. a write FAILURE keeps the optimistic state (no rollback) + emits
//      cloud-rooms:write-failed.
//   4. the 30-room cap + project rename fan-out.
//
// Run: node tests/cloud-rooms.test.mjs

import {
  configureCloudRooms, hydrateRooms, roomsLoaded, resetRoomsCache,
  listCustomRooms, listProjects, latestRoomInProject, getCustomRoomById,
  saveCustomRoom, updateCustomRoom, deleteCustomRoom, renameProject,
} from '../js/state/cloud-rooms.js';
import { on } from '../js/shared/events.js';

let failed = 0;
function ok(cond, label) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; }
const tick = () => new Promise((r) => setTimeout(r, 0));   // flush async write .then

// --- injected DB stubs -------------------------------------------------------
let saveCalls = [], removeCalls = [], saveResult = { ok: true };
configureCloudRooms({
  list:   async () => [
    { id: 'a', projectName: 'Hall', roomName: 'A', scene: { formatVersion: 1 }, savedAt: '2026-06-10T00:00:00Z' },
    { id: 'b', projectName: 'Hall', roomName: 'B', scene: { formatVersion: 1 }, savedAt: '2026-06-12T00:00:00Z' },
    { id: 'c', projectName: null,   roomName: 'Loose', scene: { formatVersion: 1 }, savedAt: '2026-06-11T00:00:00Z' },
  ],
  save:   async (uid, entry) => { saveCalls.push(entry); return saveResult; },
  remove: async (uid, id) => { removeCalls.push(id); return { ok: true }; },
});

let lastFail;
on('cloud-rooms:write-failed', (e) => { lastFail = e; });

// 1. Hydrate + synchronous grouped reads.
await hydrateRooms('u1');
ok(roomsLoaded() === true, 'hydrateRooms marks loaded');
ok(listCustomRooms().length === 3, 'cache holds the hydrated rooms');
const projs = listProjects();
ok(projs[0].name === 'Hall' && projs[0].rooms.length === 2, 'listProjects groups rooms under their project');
ok(projs.some((p) => p.name === '(Unfiled)'), 'a room without a project lands in (Unfiled)');
ok(latestRoomInProject('Hall').id === 'b', 'latestRoomInProject returns the newest room (b > a)');
ok(getCustomRoomById('c').roomName === 'Loose', 'getCustomRoomById finds by id');

// 2. Optimistic save — cache reflects it BEFORE the async write resolves.
saveCalls = [];
const entry = saveCustomRoom({ projectName: 'New', roomName: 'Studio', scene: { formatVersion: 1, marker: 7 } });
ok(getCustomRoomById(entry.id)?.roomName === 'Studio', 'saveCustomRoom updates the cache synchronously (optimistic)');
ok(listProjects().some((p) => p.name === 'New'), 'the new project appears immediately (no async wait to render)');
await tick();
ok(saveCalls.length === 1 && saveCalls[0].id === entry.id, 'the room is dispatched to the Firestore write');

// updateCustomRoom + deleteCustomRoom.
saveCalls = [];
updateCustomRoom(entry.id, { roomName: 'Studio v2' });
ok(getCustomRoomById(entry.id).roomName === 'Studio v2', 'updateCustomRoom patches the cache');
await tick();
ok(saveCalls.length === 1, 'update is persisted');
deleteCustomRoom(entry.id);
ok(getCustomRoomById(entry.id) === null, 'deleteCustomRoom removes from the cache');
await tick();
ok(removeCalls.includes(entry.id), 'delete is persisted');

// 3. Write FAILURE → keep optimistic state + emit.
saveResult = { ok: false, code: 'permission-denied' };
lastFail = undefined;
const e2 = saveCustomRoom({ projectName: 'Z', roomName: 'Keep', scene: { formatVersion: 1 } });
await tick();
ok(getCustomRoomById(e2.id) !== null, 'a failed write does NOT roll back the cache (no silent loss)');
ok(lastFail?.op === 'save' && lastFail?.code === 'permission-denied',
   'a failed write emits cloud-rooms:write-failed with the code');
saveResult = { ok: true };

// 4. Cap + rename fan-out.
resetRoomsCache();
configureCloudRooms({ list: async () => [], save: async () => ({ ok: true }), remove: async () => ({ ok: true }) });
await hydrateRooms('u1');
for (let i = 0; i < 35; i++) saveCustomRoom({ projectName: 'Big', roomName: 'r' + i, scene: { formatVersion: 1 } });
ok(listCustomRooms().length === 30, '30-room cap is enforced client-side');
renameProject('Big', 'Bigger');
ok(listProjects().some((p) => p.name === 'Bigger') && !listProjects().some((p) => p.name === 'Big'),
   'renameProject moves every room to the new project name (fan-out)');

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nAll cloud-rooms cache assertions passed.');
