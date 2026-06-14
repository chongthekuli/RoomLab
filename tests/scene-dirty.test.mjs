// Scene dirty-tracker regression test (v=831, 2026-06-14, Phase 1).
//
// The dirty flag is the safety net for the "no browser storage, explicit Save"
// model — if it misbehaves, a user either loses work silently (false-clean) or
// is nagged forever (stuck-dirty). Pins the core behaviours; the WIRING (which
// events mark dirty) is grep-guarded in tests/scene-persistence.test.mjs.
//
// Run: node tests/scene-dirty.test.mjs

import {
  markDirty, markClean, isDirty, loadSceneQuietly,
  setReadOnly, isReadOnly, setLoadFailed, didLoadFail,
} from '../js/state/scene-dirty.js';
import { on } from '../js/shared/events.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// Capture scene:dirty-changed events.
let lastEvent;
on('scene:dirty-changed', (e) => { lastEvent = e; });

// Start clean.
ok(isDirty() === false, 'starts clean');

// markDirty → dirty + event.
lastEvent = undefined;
markDirty();
ok(isDirty() === true, 'markDirty sets dirty');
ok(lastEvent?.dirty === true, 'markDirty emits scene:dirty-changed {dirty:true}');

// markDirty again → no duplicate event (already dirty).
lastEvent = undefined;
markDirty();
ok(lastEvent === undefined, 'markDirty is idempotent (no event when already dirty)');

// markClean → clean + event.
lastEvent = undefined;
markClean();
ok(isDirty() === false, 'markClean clears dirty');
ok(lastEvent?.dirty === false, 'markClean emits scene:dirty-changed {dirty:false}');

// loadSceneQuietly suppresses dirty during the (synchronous) load + ends clean.
markDirty();                       // pretend the user had edits
loadSceneQuietly(() => { markDirty(); markDirty(); });  // a load that emits mutations
ok(isDirty() === false, 'loadSceneQuietly ends CLEAN even though the load emitted mutations');

// Read-only mode: mutations can never dirty (admin viewer).
setReadOnly(true);
markClean();
markDirty();
ok(isDirty() === false, 'read-only mode: markDirty is a no-op (admin viewer can\'t dirty/save)');
ok(isReadOnly() === true, 'isReadOnly reflects the flag');
setReadOnly(false);
markDirty();
ok(isDirty() === true, 'leaving read-only mode restores normal dirty tracking');
markClean();

// loadFailed flag round-trips (gates the Save-over-real-scene confirm).
ok(didLoadFail() === false, 'loadFailed defaults false');
setLoadFailed(true);
ok(didLoadFail() === true, 'setLoadFailed(true) round-trips');
setLoadFailed(false);
ok(didLoadFail() === false, 'setLoadFailed(false) round-trips');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll scene-dirty assertions passed.');
