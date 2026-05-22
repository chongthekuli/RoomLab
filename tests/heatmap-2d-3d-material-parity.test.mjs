// 2D/3D heatmap material-aware wall-TL parity regression (v=595, 2026-05-22).
//
// Bug: the 2D SVG viewport (room-2d.js renderNormal) called computeSPLGrid
// WITHOUT threading `materials`, so per-band wall transmission loss fell
// back to the legacy flat 30 dB (spl-calculator.js pathWallLossDb, the
// `if (!materials)` branch). The 3D top-down plane (scene.js
// currentPhysicsOpts) DID pass materials and used the real per-band TL
// (e.g. painted concrete 53 dB @ 1 kHz). Result: the same through-wall
// path read ~23 dB louder in 2D than 3D — the surau azan horn appeared
// to flood the prayer-hall interior in the 2D view. Dr. Chen diagnosis
// 2026-05-22.
//
// Why text-grep instead of behavioural: room-2d.js imports browser/SVG
// surfaces and is not cleanly Node-importable (same constraint as
// scene-x-mirror.test.mjs). The regression surface is "someone removes
// the materials arg from one of the two grid call sites and the
// surfaces silently diverge." A static audit pins both sites.
//
// Run: node tests/heatmap-2d-3d-material-parity.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const room2d = readFileSync('./js/graphics/room-2d.js', 'utf8');
const scene  = readFileSync('./js/graphics/scene.js', 'utf8');
const spl    = readFileSync('./js/physics/spl-calculator.js', 'utf8');

// ---- 1. The 2D viewport's computeSPLGrid call threads materials ------
// Isolate the renderNormal computeSPLGrid({...}) argument object and
// assert `materials:` is present inside it.
const grid2d = room2d.match(/computeSPLGrid\(\{[\s\S]*?\}\)/);
ok(!!grid2d, '2D renderNormal calls computeSPLGrid({...})');
if (grid2d) {
  ok(/\bmaterials\s*:/.test(grid2d[0]),
     '2D computeSPLGrid passes `materials` (material-aware wall TL, not flat 30 dB)');
}

// ---- 2. The 3D path still threads materials (parity, no regression) --
const opts3d = scene.match(/function currentPhysicsOpts[\s\S]*?\n\}/);
ok(!!opts3d, '3D currentPhysicsOpts helper exists');
if (opts3d) {
  ok(/\bmaterials\s*:\s*materialsRef/.test(opts3d[0]),
     '3D currentPhysicsOpts passes `materials: materialsRef`');
}

// ---- 3. computeSPLGrid actually accepts + forwards materials ---------
// Guards that the physics signature the wiring depends on still exists,
// so the threaded arg can't become a silent no-op.
const sig = spl.match(/export function computeSPLGrid\(\{[\s\S]*?\}\)/);
ok(!!sig, 'computeSPLGrid export exists');
if (sig) {
  ok(/\bmaterials\s*=/.test(sig[0]),
     'computeSPLGrid signature accepts `materials`');
}
ok(/function pathWallLossDb\([^)]*materials[^)]*\)/.test(spl),
   'pathWallLossDb consumes `materials` for per-band wall TL');

// ---- summary ---------------------------------------------------------
if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll 2D/3D material-parity tests passed.');
