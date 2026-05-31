// Room Capture — orchestration + single commit path.
//
// Guards: the CaptureResult → commitCapturedRoom → state.room.custom_vertices
// contract (closes the long-untested custom-draw flow, CLAUDE.md §6 #1); the
// self-intersection reject; that a committed CONCAVE room still yields an
// interior walk-spawn point (defaultInsidePosition — the free-fall bug class);
// and the mode-registry shape.
//
// Run: node tests/capture-flow.test.mjs

import { state } from '../js/app-state.js';
import { on } from '../js/ui/events.js';
import { buildRoomFields, validateCaptureResult, commitCapturedRoom } from '../js/capture/capture-flow.js';
import { CAPTURE_MODES, isManualAvailable, offerableModes } from '../js/capture/capture-modes.js';
import { defaultInsidePosition, isInsideRoom } from '../js/physics/room-shape.js';

let failed = 0;
function assert(c, l) { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; }
const approx = (a, b, t = 1e-9) => Math.abs(a - b) <= t;

// --- validateCaptureResult ------------------------------------------------
assert(validateCaptureResult({ vertices: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }], scaleResolved: true }).ok,
  'validate: 3 finite scale-resolved vertices → ok');
assert(!validateCaptureResult({ vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }], scaleResolved: true }).ok,
  'validate: <3 vertices → rejected');
assert(!validateCaptureResult({ vertices: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }], scaleResolved: false }).ok,
  'validate: scale not resolved → rejected (must anchor first)');
assert(!validateCaptureResult({ vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }, { x: 4, y: 3 }], scaleResolved: true }).ok,
  'validate: self-intersecting bowtie → rejected');

// --- buildRoomFields (pure) ----------------------------------------------
{
  const patch = buildRoomFields({ vertices: [{ x: 5, y: 5 }, { x: 11, y: 5 }, { x: 11, y: 9 }, { x: 5, y: 9 }], scaleResolved: true, heightHint_m: 3.2 });
  assert(patch.shape === 'custom', 'buildRoomFields: shape=custom');
  assert(patch.custom_vertices[0].x === 0 && patch.custom_vertices[0].y === 0, 'buildRoomFields: origin-shifted');
  assert(approx(patch.width_m, 6) && approx(patch.depth_m, 4), 'buildRoomFields: bbox 6×4');
  assert(approx(patch.height_m, 3.2), 'buildRoomFields: heightHint applied');
}

// --- commitCapturedRoom: roundtrip + events -------------------------------
{
  let sawReset = false, sawRoomChanged = false;
  const offA = on('scene:reset', () => { sawReset = true; });
  const offB = on('room:changed', () => { sawRoomChanged = true; });
  const verts = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 6 }, { x: 2, y: 6 }];
  const ok = commitCapturedRoom({ vertices: verts, scaleResolved: true, provenance: 'manual' });
  if (typeof offA === 'function') offA(); if (typeof offB === 'function') offB();
  assert(ok === true, 'commit: returns true on valid result');
  assert(state.room.shape === 'custom', 'commit: state.room.shape = custom');
  assert(state.room.custom_vertices.length === 4 && state.room.custom_vertices[0].x === 0,
    'commit: custom_vertices set + origin-shifted');
  assert(Array.isArray(state.room.surfaces.edges) && state.room.surfaces.edges.length === 4,
    'commit: surfaces.edges rebuilt (one slot per wall)');
  assert(sawReset, 'commit: emits scene:reset (whole-array geometry swap)');
  assert(sawRoomChanged, 'commit: emits room:changed');
}
{
  const ok = commitCapturedRoom({ vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }], scaleResolved: true });
  assert(ok === false, 'commit: refuses an invalid (<3) result');
}

// --- CONCAVE room → walk-spawn still interior (free-fall bug class) --------
{
  // L-shaped captured room. Commit, then assert the spawn anchor is inside.
  const L = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 8 }, { x: 0, y: 8 }];
  commitCapturedRoom({ vertices: L, scaleResolved: true, provenance: 'manual' });
  const spawn = defaultInsidePosition(state.room);
  assert(isInsideRoom(spawn.x, spawn.y, state.room),
    `commit: concave captured room → defaultInsidePosition ${JSON.stringify(spawn)} is INSIDE (no walk free-fall)`);
}

// --- mode registry contract ----------------------------------------------
{
  const ids = CAPTURE_MODES.map(m => m.id);
  assert(ids.includes('manual') && ids.includes('photo') && ids.includes('imu') && ids.includes('webxr'),
    'registry lists manual + photo + imu + webxr');
  for (const m of CAPTURE_MODES) {
    assert(typeof m.id === 'string' && typeof m.label === 'string'
      && typeof m.isAvailable === 'function' && typeof m.load === 'function',
      `mode '${m.id}' has id/label/isAvailable/load`);
  }
  assert(isManualAvailable() === true, 'manual mode is ALWAYS available (the baseline)');
  // implemented flags gate the picker: manual + photo ship; imu + webxr don't yet.
  const impl = Object.fromEntries(CAPTURE_MODES.map(m => [m.id, m.implemented]));
  assert(impl.manual === true && impl.photo === true, 'manual + photo are implemented (offered)');
  assert(impl.imu === false && impl.webxr === false, 'imu + webxr not yet implemented (not offered)');
}
{
  // offerableModes = implemented AND runtime-available. In Node (no DOM) photo's
  // probe is false, so only manual offers — but unimplemented modes are NEVER
  // offered regardless of their probe.
  const ids = (await offerableModes()).map(m => m.id);
  assert(ids.includes('manual'), 'offerableModes always includes manual');
  assert(!ids.includes('imu') && !ids.includes('webxr'),
    'offerableModes never includes unimplemented modes (imu/webxr)');
}

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll capture-flow tests passed.');
