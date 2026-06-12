// Adjustable 2D grid/snap regression test (v=803, 2026-06-12).
//
// Pins the user-adjustable 2D grid feature: the draw-mode grid, the custom-
// room vertex snap, and the 2D drag snap all read state.display.gridSize_m
// (0.5 default / 0.25 / 0.1 m), set via the green ▾ dropdown on the 2D tab or
// the 'G' key while drawing. Single source of truth + a shared 'grid:changed'
// event so room-2d.js re-renders and the dropdown UI stays in sync.
//
// Text-grep (not behavioural): the snap/render output needs the live SVG
// viewport + DOM. The regressable surface is "someone hardcodes 0.5 back into
// the snap/grid, or drops the G key / event wiring" — a static audit pins it.
//
// Run: node tests/grid-size.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const appState = readFileSync('./js/app-state.js', 'utf8');
const room2d   = readFileSync('./js/graphics/room-2d.js', 'utf8');
const indexHtml = readFileSync('./index.html', 'utf8');
const roomMain = readFileSync('./js/labs/roomlab/main.js', 'utf8');

// 1. State default.
ok(/gridSize_m:\s*0\.5/.test(appState),
   'app-state.js: state.display.gridSize_m defaults to 0.5');

// 2. room-2d helper + selectable sizes.
ok(/export const GRID_SIZES_M\s*=\s*\[\s*0\.5\s*,\s*0\.25\s*,\s*0\.1\s*\]/.test(room2d),
   'room-2d.js: GRID_SIZES_M = [0.5, 0.25, 0.1]');
ok(/function gridSize\(\)/.test(room2d) && /state\.display\?\.gridSize_m/.test(room2d),
   'room-2d.js: gridSize() reads state.display.gridSize_m');

// 3. Snap + visual grid use gridSize() (not a hardcoded 0.5).
ok(/const minor = CUSTOM_SCALE \* gridSize\(\)/.test(room2d),
   'room-2d.js: minor grid spacing uses gridSize()');
ok(/const g = gridSize\(\);[\s\S]{0,80}Math\.round\(v \/ g\) \* g/.test(room2d),
   'room-2d.js: custom-draw vertex snap uses gridSize()');
ok(/function snapToGrid\(v\)\s*\{\s*const g = gridSize\(\);\s*return Math\.round\(v \/ g\) \* g/.test(room2d),
   'room-2d.js: 2D drag snapToGrid uses gridSize()');

// 4. 'G' key cycles the grid while drawing.
ok(/k === 'g' \|\| k === 'G'/.test(room2d) && /GRID_SIZES_M\[\(idx \+ 1\) % GRID_SIZES_M\.length\]/.test(room2d),
   "room-2d.js: 'G' key cycles gridSize via GRID_SIZES_M");

// 5. Re-render on the shared event.
ok(/on\('grid:changed', render\)/.test(room2d),
   "room-2d.js: subscribes on('grid:changed', render)");

// 5b. The 'G' cycle is shared (handleDrawKey AND the float-coord input), so it
//     works while focus is in the coord field during drawing.
ok(/function cycleGridSize\(\)/.test(room2d),
   'room-2d.js: cycleGridSize() helper exists');
ok((room2d.match(/cycleGridSize\(\)/g) || []).length >= 3,
   "room-2d.js: cycleGridSize() called from both the draw-key handler and the coord-input handler");

// 5c. Main 2D view draws a floor grid at the snap spacing (so the visible grid
//     changes — not just the snap).
ok(/function renderFloorGrid\(/.test(room2d),
   'room-2d.js: renderFloorGrid() helper exists');
ok(/renderFloorGrid\(state\.room, x0, y0, pxW, pxD\)/.test(room2d),
   'room-2d.js: renderNormal composes the floor grid into the SVG');
ok(/const stepX = g \* \(pxW \/ room\.width_m\)/.test(room2d),
   'room-2d.js: floor grid spacing scales with gridSize()');

// 6. UI: green arrow + dropdown markup on the 2D tab.
ok(/id="vp-grid-arrow"/.test(indexHtml),
   'index.html: green ▾ grid arrow exists');
ok(/data-view="2d"[\s\S]*?vp-grid-arrow/.test(indexHtml),
   'index.html: grid arrow nested inside the 2D tab button');
ok(/id="vp-grid-menu"/.test(indexHtml)
   && /data-grid="0\.5"/.test(indexHtml)
   && /data-grid="0\.25"/.test(indexHtml)
   && /data-grid="0\.1"/.test(indexHtml),
   'index.html: grid menu has 0.5 / 0.25 / 0.1 options');

// 7. main.js wiring: sets state + emits grid:changed, stops propagation.
ok(/getElementById\('vp-grid-arrow'\)/.test(roomMain),
   'main.js: grid selector is wired');
ok(/state\.display\.gridSize_m = m;[\s\S]{0,60}emit\('grid:changed'\)/.test(roomMain),
   'main.js: selecting an option sets gridSize_m and emits grid:changed');
ok(/ev\.stopPropagation\(\)/.test(roomMain) && /toggleGridMenu/.test(roomMain),
   'main.js: arrow toggle stops propagation (no 2D-tab view switch)');

// 8. Grid VISIBILITY toggle (default off) under the green-arrow dropdown.
ok(/gridVisible:\s*false/.test(appState),
   'app-state.js: state.display.gridVisible defaults to false (grid hidden)');
ok(/if \(!state\.display\?\.gridVisible\) return '';/.test(room2d),
   'room-2d.js: renderFloorGrid is gated on gridVisible (hidden unless enabled)');
ok(/id="vp-grid-toggle"/.test(indexHtml),
   'index.html: grid menu has a Show-grid toggle');
ok(/state\.display\.gridVisible = !state\.display\.gridVisible/.test(roomMain)
   && /getElementById\('vp-grid-toggle'\)/.test(roomMain),
   'main.js: the toggle flips gridVisible');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll grid-size assertions passed.');
