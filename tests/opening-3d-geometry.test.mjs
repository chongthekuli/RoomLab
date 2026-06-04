// 3D wall-opening rendering tripwire (2026-06-04).
//
// Two user-requested 3D features for doors/windows that live inside
// Three.js closures (not Node-importable), so guarded by source grep —
// the same pattern as tests/scene-x-mirror.test.mjs:
//
//   1. Doors render as solid-wood dark-brown VENEER: a 'door-solid-wood'
//      texture case + a palette carrying clearcoat, and buildSurfaceMat
//      upgrading to MeshPhysicalMaterial when clearcoat is present.
//   2. Openings have ADJUSTABLE THICKNESS (default 50 mm) shown in 3D:
//      attachOpeningMesh builds a BoxGeometry slab of depth op.thickness_m,
//      and DEFAULT_DOOR / DEFAULT_WINDOW carry thickness_m: 0.05.
//
// If a refactor drops any of these, the 3D door silently reverts to a
// flat off-white drywall plane — the exact regression this pins.

import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${!c && e ? '  — ' + e : ''}`); if (!c) failed++; };

const SCENE = readFileSync('./js/graphics/scene.js', 'utf8');
const TEX   = readFileSync('./js/graphics/textures.js', 'utf8');
const PANEL = readFileSync('./js/ui/panel-room.js', 'utf8');

// ---- 1. Door veneer material ----

ok(/case 'door-solid-wood':\s*paintSolidWoodDoor\(ctx\);/.test(TEX),
   'textures: paintMaterial routes door-solid-wood to its own painter');
ok(/function paintSolidWoodDoor\(/.test(TEX),
   'textures: paintSolidWoodDoor exists');
ok(/paletteCache\.set\('door-solid-wood',\s*\{[\s\S]*?clearcoat:/.test(TEX),
   'textures: door-solid-wood palette carries a clearcoat (veneer sheen)');
ok(/'door-solid-wood':\s*1\.0/.test(TEX),
   'textures: door-solid-wood has a METERS_PER_TILE entry (one grain panel, not tiled drywall)');
ok(/if\s*\(palette\.clearcoat\)\s*\{[\s\S]*?MeshPhysicalMaterial/.test(SCENE),
   'scene: buildSurfaceMat upgrades to MeshPhysicalMaterial when the palette has clearcoat');

// ---- 2. Adjustable opening thickness, default 50 mm, real slab in 3D ----

ok(/const depth = Number\(op\?\.thickness_m\) \|\| 0\.05;/.test(SCENE),
   'scene: attachOpeningMesh reads op.thickness_m with a 0.05 m (50 mm) fallback');
ok(/new THREE\.BoxGeometry\(ow, oh, depth\)/.test(SCENE),
   'scene: opening renders as a real-depth BoxGeometry slab (not a zero-depth plane)');
ok(/opMesh\.position\.set\(offsetX, offsetY, 0\)/.test(SCENE),
   'scene: slab centered on the wall face plane (z=0) — sidesteps inward-normal sign ambiguity');
ok(/matId === 'glass-window' \? 0\.85 : 1\.0/.test(SCENE),
   'scene: solid doors render opaque, glass stays translucent');

ok(/DEFAULT_DOOR\s*=\s*\{[^}]*thickness_m:\s*0\.05/.test(PANEL),
   'panel: DEFAULT_DOOR carries thickness_m: 0.05');
ok(/DEFAULT_WINDOW\s*=\s*\{[^}]*thickness_m:\s*0\.05/.test(PANEL),
   'panel: DEFAULT_WINDOW carries thickness_m: 0.05');
ok(/next\.openings\[idx\]\.thickness_m = clamped \/ 1000/.test(PANEL),
   'panel: opening-depth (mm) control writes thickness_m in metres');

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll 3D opening-geometry tripwire tests passed.');
