// Room Capture — live-capture-mode lifecycle/CV guards (source tripwires).
//
// live-capture-mode.js is camera/DOM/getUserMedia-coupled and can't run in
// Node, so — like tests/scene-x-mirror.test.mjs — these are source-grep
// tripwires guarding the fixes from Martina's pre-ship review so a refactor
// can't silently reintroduce them.
//
// Run: node tests/capture-live-guards.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'js', 'capture', 'modes', 'live-capture-mode.js'), 'utf8');

let failed = 0;
function assert(c, l) { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; }
const has = (re) => re.test(src);
const count = (re) => (src.match(re) || []).length;

// P0-1 — phase-scoped disposers so rescan (Lock→reject→rescan / "↺ Rescan")
// doesn't leak a window 'resize' handler every cycle.
assert(has(/this\.phaseDisposers\s*=\s*\[\]/), 'P0-1: phaseDisposers array declared');
assert(has(/_onPhase\s*\(/) && has(/_clearPhase\s*\(\)/), 'P0-1: _onPhase + _clearPhase present');
assert(has(/_onPhase\(\s*window\s*,\s*['"]resize['"]/), 'P0-1: window resize is bound via _onPhase (phase-scoped, not session)');
assert(count(/_clearPhase\(\)/g) >= 4,
  'P0-1: _clearPhase() drained at phase exits + teardown (≥4 call sites)');

// P1-1 — a triangle (MIN_CORNERS=3) does NOT route through the 4-point
// homography (which isDegenerateQuad-rejected many valid triangles).
assert(has(/if\s*\(\s*this\.refCorners\.length\s*===\s*3\s*\)/),
  'P1-1: 3-corner case is special-cased');
{
  // In the === 3 branch, before the next `} else`, there must be NO
  // rectifyFloorQuad call (the triangle is passed raw).
  const m = src.match(/if\s*\(\s*this\.refCorners\.length\s*===\s*3\s*\)[\s\S]*?\}\s*else/);
  assert(m && !/rectifyFloorQuad/.test(m[0]),
    'P1-1: the 3-corner branch passes the raw triangle (no rectifyFloorQuad)');
}

// P2-1 / P2-5 — off-screen markers are bounded AND dimmed (not flying to
// x=50000 at full opacity).
assert(has(/clampEnvelope\s*\(/), 'P2-1: clampEnvelope used to bound off-screen marker carry');
assert(has(/\.valid\s*=\s*false/), 'P2-5: off-screen-carried markers flagged valid=false (dimmed)');

// Teardown still stops the camera (the one bug that must never regress).
assert(has(/getTracks\(\)/) && has(/\.stop\(\)/), 'teardown stops MediaStream tracks (camera LED off)');

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll live-capture guard tests passed.');
