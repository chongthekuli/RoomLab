// Vertex manual-entry focus regression test (v=799, 2026-06-11).
//
// Pins the fix for the custom-room vertex editor losing input focus on
// every keystroke. Typing a digit in a vertex X/Y field fired
// emit('room:changed'), whose panel-room.js subscriber re-rendered the
// custom-shape panel via renderShapeParams() — which replaces #vertex-list
// with innerHTML, destroying the focused input and dropping the caret after
// the first digit. The user had to re-click the box for each digit.
//
// The fix: the room:changed subscriber skips the panel rebuild while the
// active element is inside #vertex-list, so the focused input survives. The
// 2D/3D viewports still update live (they listen to room:changed separately).
//
// Why text-grep instead of behavioural: focus / caret behaviour needs a real
// DOM + layout (document.activeElement, innerHTML teardown) which the plain
// Node + assert harness has no access to. The regressable surface is "someone
// removes the focus guard and the rebuild clobbers the input again" — a static
// audit pins that the guard is present.
//
// Run: node tests/vertex-edit-focus.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const panel = readFileSync('./js/ui/panel-room.js', 'utf8');

// Isolate the room:changed subscriber that re-renders the panel when draw mode
// finishes — its custom-shape branch is the rebuild path that would clobber
// focus. Anchor on the subscriber's unique comment, then take its body.
const subIdx = panel.indexOf('draw mode finishes');
ok(subIdx !== -1, "panel-room.js has the room:changed re-render subscriber");
const sub = subIdx === -1 ? '' : panel.slice(subIdx, subIdx + 1600);

// 1. The custom-shape branch still rebuilds via renderShapeParams (the surface
//    that would clobber focus) — so the guard below is load-bearing.
ok(/renderShapeParams\(\)/.test(sub),
   'custom-shape branch calls renderShapeParams() (the rebuild that needs guarding)');

// 2. The rebuild is guarded by an activeElement / #vertex-list focus check that
//    returns early — this is the actual fix.
ok(/document\.activeElement/.test(sub),
   'subscriber reads document.activeElement to detect an in-progress edit');
ok(/closest\(\s*['"]#vertex-list['"]\s*\)/.test(sub),
   'subscriber checks .closest("#vertex-list") to skip the rebuild while typing');
ok(/#vertex-list['"]\s*\)\s*\)\s*return/.test(sub.replace(/\s+/g, ' ')) ||
   /closest\(['"]#vertex-list['"]\)\)\s*return/.test(sub.replace(/\s+/g, ' ')),
   'the #vertex-list focus check short-circuits (return) before renderShapeParams');

// 3. The vertex inputs still write state on input (live edit preserved).
ok(/data-vf=.x./.test(panel) && /data-vf=.y./.test(panel),
   'vertex rows still render X (data-vf="x") and Y (data-vf="y") inputs');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll vertex-edit-focus assertions passed.');
