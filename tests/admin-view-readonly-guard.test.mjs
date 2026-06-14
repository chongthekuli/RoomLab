// Admin read-only viewer — enforcement + no-leak regression (v=835, 2026-06-14).
//
// Guards two of Hannes's sharp edges:
//   SE-3: read-only must NOT leak when the admin leaves RoomLAB by clicking a
//         header tab instead of the Exit button (the "why did my room vanish"
//         roach-motel). The route:change auto-exit is the defence.
//   SE-4: nothing passively writes the admin's (or the foreign user's) data to
//         Firestore during a read-only session.
//
// Mixed strategy: behavioural where the code is pure (scene-dirty + admin-view),
// source-grep where it's DOM-coupled (the Save guard + the route:change wiring
// live in browser-only modules that can't import in Node).
//
// Run: node tests/admin-view-readonly-guard.test.mjs

import { serializeProject, deserializeProject } from '../js/app-state.js';
import { isReadOnly, isDirty, markDirty, markClean } from '../js/state/scene-dirty.js';
import { configureAdminView, beginAdminView, endAdminView, isAdminViewing } from '../js/state/admin-view.js';
import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; };

let roomId = 'cr-own';
configureAdminView({ getRoomId: () => roomId, setRoomId: (v) => { roomId = v; } });

const PHYS = { reverberantField: true, coherent: false, airAbsorption: true, freq_hz: 1000, ambientNoise: { preset: 'nc-35', per_band: [60, 52, 45, 40, 36, 34, 33] }, eq: { enabled: false, bands: [] } };
const own = serializeProject({ projectName: 'Mine', room: { name: 'A', shape: 'rectangular', width_m: 8, depth_m: 6, height_m: 3, surfaces: {} }, sources: [], listeners: [], zones: [], treatments: [], physics: PHYS });
const foreign = serializeProject({ projectName: 'Theirs', room: { name: 'B', shape: 'rectangular', width_m: 20, depth_m: 15, height_m: 6, surfaces: {} }, sources: [{ modelUrl: 'x', position: { x: 1, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0, roll: 0 }, kind: 'point' }], listeners: [], zones: [], treatments: [], physics: PHYS });

markClean();
deserializeProject(own);

// --- behavioural: read-only suppresses dirty (no foreign-scene mutation sticks) ---
beginAdminView({ viewedEmail: 'u@x.com', viewedRoomName: 'B', scene: foreign });
ok(isReadOnly() === true && isAdminViewing() === true, 'entering a view turns read-only ON');
markDirty(); markDirty();
ok(isDirty() === false, 'read-only: scene mutations cannot dirty the foreign scene (markDirty no-op)');
endAdminView();
ok(isReadOnly() === false && isAdminViewing() === false, 'exiting clears read-only (no leak after Exit)');

// --- source guard: Save is blocked BEFORE any write while read-only ----------
const panel = readFileSync('js/ui/panel-room.js', 'utf8');
const saveFn = panel.match(/async function saveActiveRoom[\s\S]*?\n}/)?.[0] || '';
ok(/isReadOnly\(\)/.test(saveFn)
   && saveFn.indexOf('isReadOnly()') >= 0
   && saveFn.indexOf('isReadOnly()') < saveFn.indexOf('saveRoomForUser'),
   'panel-room: saveActiveRoom early-returns on isReadOnly() BEFORE any saveRoomForUser write');

// --- source guard: leaving #/room while viewing auto-exits (SE-3) ------------
const roomMain = readFileSync('js/labs/roomlab/main.js', 'utf8');
ok(/from === 'room' && isAdminViewing\(\)/.test(roomMain) && /exitAdminView\(\)/.test(roomMain),
   'roomlab/main: leaving #/room while viewing auto-exits — read-only can’t leak via a header tab (SE-3)');
ok(/takePendingAdminView\(\)/.test(roomMain) && /enterAdminView\(/.test(roomMain),
   'roomlab/main: entering #/room consumes the pending admin view (atomic, once)');

// --- source guard: editing rails are inert while viewing ---------------------
const session = readFileSync('js/ui/admin-view-session.js', 'utf8');
ok(/setAttribute\('inert'/.test(session),
   'admin-view-session: editing rail is inert (focus + pointer + keyboard blocked) while viewing');

// --- source guard: admin can only READ foreign rooms (rules) -----------------
const rules = readFileSync('firestore.rules', 'utf8');
const roomsRule = rules.match(/match \/rooms\/\{roomId\}\s*{[\s\S]*?\n      }/)?.[0] || '';
ok(/allow read:\s*if isOwner\(uid\) \|\| isAdmin\(\)/.test(roomsRule)
   && !/isAdmin\(\)/.test((roomsRule.split('allow write')[1] || '')),
   'firestore.rules: admin may READ a user’s rooms but never write/delete (read-only is structural)');

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nAll admin-view read-only guard assertions passed.');
