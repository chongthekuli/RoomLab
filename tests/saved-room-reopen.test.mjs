// Regression — bug 2026-05-21 (user-reported):
//
//   "I switch to another preset room, then when I want to switch back to
//    the custom room, I can't find my custom room in the list. But when I
//    create a new custom room, I can see I have 2 rooms in the system."
//
// A saved custom room became UNREACHABLE once the user switched to a
// preset. Root cause: the room panel's saved-room chip row filters to
// `state.projectName`, and applying a preset drops that context, so the
// chips vanish; the header project switcher only appears with 2+
// projects (the user had 1 project with 2 rooms). The fix (Maya / Direction
// A) adds a third "Open a saved room" dropdown to the room panel,
// populated from listProjects() — ALL saved rooms grouped by project,
// INDEPENDENT of state.projectName.
//
// This test guards two things:
//   (1) the data layer (listProjects) surfaces every saved room grouped
//       by project, regardless of any active-project notion;
//   (2) panel-room.js wires the dropdown to that unfiltered source and
//       routes a pick to loadCustomRoomById — and the dropdown population
//       never re-introduces a state.projectName filter.
//
// Run: node tests/saved-room-reopen.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
const pass = (l) => console.log(`PASS  ${l}`);
const fail = (l, e = '') => { console.log(`FAIL  ${l}${e ? '  — ' + e : ''}`); failed++; };
const ok = (c, l, e = '') => (c ? pass(l) : fail(l, e));

// --- localStorage shim (custom-rooms.js reads it at call time) ----------
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
};

const { saveCustomRoom, listProjects, listCustomRooms, getCustomRoomById } =
  await import('../js/shared/custom-rooms.js');

// --- (1) data layer surfaces all rooms grouped, project-independent -----

// Seed two rooms in project "sdff" plus one unfiled room — mirrors the
// "sdff · 2 rooms" the user saw in the New-custom-room dialog.
saveCustomRoom({ projectName: 'sdff', roomName: 'Hall A', room: { width_m: 10, depth_m: 8 } });
saveCustomRoom({ projectName: 'sdff', roomName: 'Hall B', room: { width_m: 12, depth_m: 9 } });
saveCustomRoom({ projectName: '', roomName: 'Scratch', room: { width_m: 5, depth_m: 5 } });

const projects = listProjects();
const sdff = projects.find(p => p.name === 'sdff');
ok(!!sdff && sdff.rooms.length === 2,
   'listProjects: project "sdff" surfaces both saved rooms (the "2 rooms" the user could not reach)',
   sdff ? `got ${sdff.rooms.length}` : 'project sdff not found');
ok(projects.some(p => p.name === '(Unfiled)'),
   'listProjects: unfiled room is surfaced under "(Unfiled)" — no project context required');

// The whole point: rooms are reachable WITHOUT any active-project filter.
// listProjects takes no projectName argument and returns every entry.
ok(listCustomRooms().length === 3 && listProjects().reduce((n, p) => n + p.rooms.length, 0) === 3,
   'listProjects: returns ALL saved rooms (3) independent of any active project');

// A picked id round-trips to a loadable entry.
const pickId = sdff.rooms[0].id;
ok(!!getCustomRoomById(pickId),
   'getCustomRoomById: a dropdown-picked room id resolves to a loadable entry');

// --- (2) panel-room.js wires the dropdown to the unfiltered source ------

const src = readFileSync('js/ui/panel-room.js', 'utf8');

ok(/id="saved-room-dropdown"/.test(src),
   'panel-room: the "Open a saved room" dropdown exists in the Custom row markup');

ok(/function renderSavedRoomDropdown\s*\(\)/.test(src),
   'panel-room: renderSavedRoomDropdown() is defined');

// Extract the renderSavedRoomDropdown body to assert it uses listProjects()
// and — the load-bearing guard — does NOT filter by state.projectName.
const bodyMatch = src.match(/function renderSavedRoomDropdown\s*\(\)\s*\{([\s\S]*?)\n\}/);
const body = bodyMatch ? bodyMatch[1] : '';
ok(/listProjects\s*\(\)/.test(body),
   'panel-room: renderSavedRoomDropdown reads listProjects() (the unfiltered, all-projects source)');
ok(body.length > 0 && !/state\.projectName/.test(body),
   'panel-room: renderSavedRoomDropdown does NOT filter by state.projectName (the exact bug — rooms must show regardless of active project)');

// The dropdown's change handler must route a pick to loadCustomRoomById.
ok(/#saved-room-dropdown[\s\S]{0,600}loadCustomRoomById\(id\)/.test(src),
   'panel-room: the saved-room dropdown change handler calls loadCustomRoomById(id)');

// And it must be repopulated on every render() (so saves/deletes/loads
// keep it current), alongside the project-filtered chip row.
ok(/renderSavedRoomDropdown\(\);\s*\n\s*renderSavedCustomRooms\(\);/.test(src),
   'panel-room: renderSavedRoomDropdown() runs in render() next to renderSavedCustomRooms()');

console.log(failed === 0
  ? '\nAll saved-room-reopen tests passed.'
  : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
