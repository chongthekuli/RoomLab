// Surau arcade roof click-to-material-picker regression.
//
// Bug (user-reported 2026-05-24): in the surau preset, clicking any of
// the 3 corridor arcade roofs in 3D was a no-op — the material panel
// row never got the auto-scroll + dropdown focus, so the user couldn't
// change the corridor roof material.
//
// Root cause: scene.js's surface-pick raycaster reads
//   userData.surface_id = `surau_arcade_roof_${sideName}`
// (per-side: `_south`, `_east`, `_west`), so the panel listener
// receives one of those three suffixed IDs. The panel's lookup
//   root.querySelector(`label[data-surface-id="${surface_id}"]`)
// returns null because the panel exposes ONE shared row keyed
// `surau_arcade_roof` (no suffix). Without a fallback the handler
// returns early.
//
// Arcade COLUMNS had the same problem and got a fallback in
// panel-room.js (line 2303-2305): if the surface_id starts with
// 'surau_arcade_column_', collapse to the shared 'surau_arcade_column'
// row. Arcade ROOFS were missing the parallel fallback. Fix adds it.
//
// What this test pins:
//   (1) scene.js still emits surau_arcade_roof_${sideName} (per-side
//       surface_id) for the 3 corridor roofs.
//   (2) panel-room.js exposes ONE shared row keyed 'surau_arcade_roof'
//       (not per-side — the user-facing model is "all 3 roofs share
//       one material").
//   (3) panel-room.js has the fallback so the click-to-pick lookup
//       collapses 'surau_arcade_roof_${sideName}' → 'surau_arcade_roof'.
//   (4) The fallback for the arcade COLUMNS (the precedent) still
//       exists (no regression on the original case).

import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

const scene = readFileSync('./js/graphics/scene.js', 'utf8');
const panel = readFileSync('./js/ui/panel-room.js', 'utf8');

// =============================================================================
// (1) scene.js still tags arcade roofs with per-side surface_id
// =============================================================================
check('scene.js emits per-side arcade roof surface_id (surau_arcade_roof_${sideName})',
  /roof\.userData\.surface_id\s*=\s*`surau_arcade_roof_\$\{sideName\}`/.test(scene));
check('scene.js gives the arcade roof the surau_arcade_roof tag',
  /roof\.userData\.tag\s*=\s*['"`]surau_arcade_roof['"`]/.test(scene));

// =============================================================================
// (2) panel-room.js exposes ONE shared row 'surau_arcade_roof'
// =============================================================================
check('panel-room.js row tuple uses surface_id "surau_arcade_roof" (shared, no _side suffix)',
  /\[\s*['"]arcade_roof['"]\s*,\s*['"]surau_arcade_roof['"]\s*,/.test(panel));

// =============================================================================
// (3) panel-room.js has the fallback collapsing the per-side ID to the
//     shared row (THE FIX for this bug)
// =============================================================================
check('panel-room.js has surau_arcade_roof_ fallback (this bug fix)',
  /if \(!wrap && surface_id\.startsWith\(['"`]surau_arcade_roof_['"`]\)\)\s*\{[\s\S]*?wrap\s*=\s*root\.querySelector\(['"`]label\[data-surface-id="surau_arcade_roof"\]['"`]\)/.test(panel));
check('arcade roof fallback comment cites the 2026-05-24 user report',
  /2026-05-24/.test(panel) && /arcade roof/i.test(panel));

// =============================================================================
// (4) Arcade COLUMNS fallback still in place (precedent unchanged)
// =============================================================================
check('panel-room.js arcade-column fallback still exists (no regression on original case)',
  /if \(!wrap && surface_id\.startsWith\(['"`]surau_arcade_column_['"`]\)\)\s*\{[\s\S]*?wrap\s*=\s*root\.querySelector\(['"`]label\[data-surface-id="surau_arcade_column"\]['"`]\)/.test(panel));

// =============================================================================
// (5) The shared row's material setter writes to mats.arcade_roof (the
//     shared key) so changing the material updates all 3 corridor roofs
//     at once. This is the user-visible value of the shared row.
// =============================================================================
check('shared arcade_roof setter writes mats.arcade_roof (all 3 roofs share one material)',
  /matKey === ['"`]arcade_roof['"`]|['"`]arcade_roof['"`].*'surau_arcade_roof'|matKey,\s*surfaceId,\s*label/.test(panel));

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
