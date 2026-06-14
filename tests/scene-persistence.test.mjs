// Cloud room-LIBRARY persistence tripwire (v=834, 2026-06-14).
//
// A user's work now lives in Firestore as a MULTI-project / multi-room library:
// each saved room is one doc at accounts/{uid}/rooms/{roomId} holding a full
// serializeProject() blob, and accounts/{uid}/scene/current is a tiny POINTER
// ({ lastRoomId }) so boot restores the last-opened room. Explicit Save only
// (no browser autosave). This guards the DB-layer + rules + boot/Save wiring.
// The cache logic itself is covered by tests/cloud-rooms.test.mjs; the
// serialize↔deserialize blob round-trip by tests/project.test.mjs.
//
// Run: node tests/scene-persistence.test.mjs

import { readFileSync, existsSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
const read = (p) => readFileSync(p, 'utf8');

const db    = read('./js/auth/firebase-db.js');
const rules = read('./firestore.rules');

// --- DB layer: rooms collection ----------------------------------------------
// Each room is a doc under accounts/{uid}/rooms (off the account doc so the
// AccountLAB listAccounts() table stays cheap).
ok(/doc\(_db, ACCOUNTS, uid, ROOMS, entry\.id\)/.test(db),
   'firebase-db.js: a room lives at accounts/{uid}/rooms/{roomId} (off the account doc)');

const saveFn = db.match(/export async function saveRoomForUser[\s\S]*?\n}/)?.[0] || '';
ok(/size > SCENE_SOFT_LIMIT_BYTES/.test(saveFn) && /code: 'too-large'/.test(saveFn),
   'firebase-db.js: saveRoomForUser guards the 700 KB soft cap (never silently truncates)');
ok(/setDoc\(/.test(saveFn) && /return \{ ok: false/.test(saveFn) && !/\bthrow\b/.test(saveFn),
   'firebase-db.js: saveRoomForUser returns a result, never throws');

const listFn = db.match(/export async function listRoomsForUser[\s\S]*?\n}/)?.[0] || '';
ok(/getDocs\(collection\(_db, ACCOUNTS, uid, ROOMS\)\)/.test(listFn) && !/\btry\b/.test(listFn),
   'firebase-db.js: listRoomsForUser lets getDocs THROW on offline/denied (boot tells new-user from offline)');

ok(/export async function deleteRoomForUser/.test(db),
   'firebase-db.js: deleteRoomForUser exists (room removal)');
ok(/export async function saveLastRoomPointer/.test(db) && /export async function loadLastRoomPointer/.test(db),
   'firebase-db.js: last-opened-room POINTER read/write (scene/current) exists');
ok(/legacyBlob: d\.blob/.test(db),
   'firebase-db.js: loadLastRoomPointer surfaces a legacy Phase-1 blob for the one-time migration shim');
ok(/export const SCENE_SOFT_LIMIT_BYTES/.test(db) && /export function sceneBlobSize/.test(db),
   'firebase-db.js: exports the size cap + size helper for the caller');

// --- Rules: rooms subcollection + scene/current pointer ----------------------
const roomsRule = rules.match(/match \/rooms\/\{roomId\}\s*{[\s\S]*?\n      }/)?.[0] || '';
ok(roomsRule.length > 0, 'firestore.rules: a rooms subcollection rule exists');
ok(/allow read:\s*if isOwner\(uid\) \|\| isAdmin\(\)/.test(roomsRule),
   'firestore.rules: owner OR admin may READ rooms (admin = read-only viewer)');
ok(/allow write:\s*if isOwner\(uid\)/.test(roomsRule),
   'firestore.rules: only the OWNER may WRITE rooms');
// The write/delete clauses must NOT grant admins — read-only is structural.
// (Split on 'allow write' so the isAdmin() in the READ line above isn't counted.)
const writeDelete = roomsRule.split('allow write')[1] || '';
ok(writeDelete.length > 0 && !/isAdmin\(\)/.test(writeDelete),
   'firestore.rules: rooms WRITE/DELETE never grant admins (read-only is structural)');
ok(/status == 'active'/.test(roomsRule),
   'firestore.rules: room Save requires the account be active (suspended/deleted can\'t mutate)');

const sceneRule = rules.match(/match \/scene\/\{sceneId\}\s*{[\s\S]*?}/)?.[0] || '';
ok(/sceneId == 'current'/.test(sceneRule),
   'firestore.rules: the scene POINTER is the single "current" doc id (no unmetered storage)');
ok(/allow read:\s*if \(isOwner\(uid\) \|\| isAdmin\(\)\)/.test(sceneRule),
   'firestore.rules: owner OR admin may READ the last-room pointer');

// --- Phase 1 wiring: cloud boot, dirty coverage, file-io removed -------------
const roomMain  = read('./js/labs/roomlab/main.js');
const panelRoom = read('./js/ui/panel-room.js');

// The retired browser-storage modules are GONE.
ok(!existsSync('./js/io/project-file.js'), 'js/io/project-file.js (file Save/Load) is deleted');
ok(!existsSync('./js/shared/autosave.js'), 'js/shared/autosave.js (localStorage autosave) is deleted');
ok(!existsSync('./js/shared/custom-rooms.js'), 'js/shared/custom-rooms.js (localStorage library) is deleted — replaced by cloud-rooms');

// Boot wires the cache to Firestore, hydrates it, and restores the last room
// inside loadSceneQuietly (so the restore doesn't mark the scene dirty).
ok(/configureCloudRooms\(\{ list: listRoomsForUser, save: saveRoomForUser, remove: deleteRoomForUser \}\)/.test(roomMain),
   'roomlab/main.js: wires the cloud-rooms cache to the Firestore functions at boot');
ok(/await hydrateRooms\(uid\)/.test(roomMain) && /loadSceneQuietly\(/.test(roomMain),
   'roomlab/main.js: hydrates the room library + restores the scene quietly');
ok(/loadLastRoomPointer\(uid\)/.test(roomMain) && /setActiveCustomRoomId\(/.test(roomMain),
   'roomlab/main.js: restores + activates the last-opened room from the pointer');
ok(/setLoadFailed\(roomsLoadFailed\(\)\)/.test(roomMain),
   'roomlab/main.js: flags a FAILED library load so Save can confirm before overwriting');
ok(/window\.addEventListener\('beforeunload'/.test(roomMain) && /isDirty\(\)/.test(roomMain),
   'roomlab/main.js: warns before refresh/close with unsaved changes');

// Dirty-event coverage MUST include the events the old autosave list MISSED —
// a gap here = silent data loss on refresh. (The complete audited set.)
const triggerBlock = roomMain.match(/const trigger = \(\) => markDirty\(\);[\s\S]*?on\(ev, trigger\);/)?.[0] || '';
for (const ev of [
  'scene:reset', 'source:changed', 'source:position', 'listener:changed', 'listener:position',
  'room:changed', 'rack:changed', 'physics:eq_changed', 'treatment:changed',
  'structure:changed', 'furniture:changed', 'outdoor:changed', 'ambient:changed',
]) {
  ok(triggerBlock.includes(`'${ev}'`), `roomlab/main.js: dirty trigger covers ${ev}`);
}

// Cloud Save on the Save button: serialize → saveRoomForUser → markClean.
ok(/await saveRoomForUser\(uid, entry\)/.test(panelRoom),
   'panel-room.js: Save persists the active room via saveRoomForUser');
ok(/serializeProject\(\)/.test(panelRoom),
   'panel-room.js: Save serializes the live scene into the room entry');
ok(/markClean\(\)/.test(panelRoom) && !/from ['"]\.\.\/io\/project-file/.test(panelRoom),
   'panel-room.js: marks clean on save + no longer imports the deleted file-io');
ok(/saveLastRoomPointer\(uid, entry\.id\)/.test(panelRoom),
   'panel-room.js: Save updates the last-opened-room pointer so boot restores it');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll cloud room-library persistence assertions passed.');
