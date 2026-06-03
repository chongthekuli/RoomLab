// Room Capture — picker / orchestrator guards.
//
// beginCapture() is DOM-coupled (loads a mode that touches the canvas/camera),
// so the critical re-entrancy guard can't be exercised end-to-end in Node. This
// is a source-grep tripwire (same pattern as tests/scene-x-mirror.test.mjs for
// DOM-coupled invariants) so a refactor can't silently delete the guard.
//
// Guards: the double-tap → two-camera-streams leak (Martina P0-3). beginCapture
// must hold a re-entrancy flag across its whole async span (offerableModes +
// dynamic import), not just the activeSession handle — otherwise a second tap
// during the camera-permission spin-up starts a SECOND getUserMedia session
// whose stream leaks with no handle to stop it.
//
// Run: node tests/capture-picker.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CAPTURE_MODES } from '../js/capture/capture-modes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let failed = 0;
function assert(c, l) { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failed++; }

const src = readFileSync(join(__dirname, '..', 'js', 'capture', 'capture-picker.js'), 'utf8');
const fn = src.slice(src.indexOf('export async function beginCapture'));

// 1. Re-entrancy guard present + reset in finally.
assert(/beginInFlight\s*=\s*false/.test(src) && /if\s*\(\s*beginInFlight\s*\)\s*return/.test(fn),
  'beginCapture has a beginInFlight re-entrancy guard (double-tap → one session)');
assert(/finally\s*\{\s*\n?\s*beginInFlight\s*=\s*false/.test(fn),
  'beginInFlight is reset in a finally (covers every return path)');

// 2. Mode resolution is robust to a renamed export (not coupled to `${id}Mode`).
assert(/typeof\s+v\.start\s*===\s*'function'/.test(fn),
  'mode impl resolved by finding an export with start() (robust to a renamed export)');

// 3. Each registered mode still resolves to a real impl via its module shape:
//    every load()-able mode module must export a CaptureMode (default or named
//    with start()). Only manual is loadable in Node (photo/live touches DOM at
//    import); check manual concretely.
{
  const manual = CAPTURE_MODES.find(m => m.id === 'manual');
  const mod = await manual.load();
  const impl = (mod.default && typeof mod.default.start === 'function')
    ? mod.default
    : Object.values(mod).find(v => v && typeof v.start === 'function');
  assert(impl && typeof impl.start === 'function', 'manual mode module exports a startable CaptureMode');
}

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll capture-picker tests passed.');
