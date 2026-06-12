// Adjustable heatmap resolution regression test (v=805, 2026-06-12).
//
// Pins the user-selectable heatmap resolution: state.display.heatmapRes
// ('standard' | 'high' | 'ultra') maps (via heatmapResParams) to a finer cell
// target + higher per-axis cap, threaded into computeSPLGrid by the 2D viewport
// and the print report (3D keeps its smooth shader). Standard is byte-identical
// to the historical 0.5 m / 120-cap default.
//
// Behavioural where possible: squareCellCounts + heatmapResParams are pure, so
// we assert real cell-count monotonicity. The wiring (state default, callers,
// cache key, UI) is text-grep — needs the DOM/app it can't load in Node.
//
// Run: node tests/heatmap-resolution.test.mjs

import { readFileSync } from 'node:fs';
import { squareCellCounts, heatmapResParams, HEATMAP_RES_LEVELS } from '../js/physics/spl-calculator.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// ---- Behavioural: resolution levels ---------------------------------------
ok(HEATMAP_RES_LEVELS.standard.cellTarget_m === 0.5 && HEATMAP_RES_LEVELS.standard.maxCells === 120,
   'standard level is the historical 0.5 m / 120-cap default');
ok(heatmapResParams(undefined).cellTarget_m === 0.5 && heatmapResParams('nonsense').cellTarget_m === 0.5,
   'heatmapResParams falls back to standard for unknown/undefined');
ok(heatmapResParams('high').cellTarget_m < 0.5 && heatmapResParams('ultra').cellTarget_m < heatmapResParams('high').cellTarget_m,
   'high < standard and ultra < high in cell target size');

// Same room, finer level → at least as many cells per axis, strictly more for a
// room large enough to exceed the standard floor/cap.
const big = { w: 20, d: 14 };
const std = squareCellCounts(big.w, big.d, heatmapResParams('standard').cellTarget_m, heatmapResParams('standard').maxCells);
const hi  = squareCellCounts(big.w, big.d, heatmapResParams('high').cellTarget_m,     heatmapResParams('high').maxCells);
const ult = squareCellCounts(big.w, big.d, heatmapResParams('ultra').cellTarget_m,    heatmapResParams('ultra').maxCells);
ok(hi.cellsX > std.cellsX && ult.cellsX > hi.cellsX,
   `more cells at finer res (20m axis: std ${std.cellsX} < high ${hi.cellsX} < ultra ${ult.cellsX})`);

// Small room previously floored at 8 cells → higher res lifts it off the floor.
const smallStd = squareCellCounts(4, 4, 0.5, 120);
const smallUlt = squareCellCounts(4, 4, heatmapResParams('ultra').cellTarget_m, heatmapResParams('ultra').maxCells);
ok(smallStd.cellsX === 8 && smallUlt.cellsX > 8,
   `small 4m room: standard floors at 8, ultra gives ${smallUlt.cellsX}`);

// Default args unchanged → byte-identical to before (legacy callers safe).
const legacy = squareCellCounts(10, 7);
ok(legacy.cellsX === 20 && legacy.cellsY === 14,
   'squareCellCounts default args = historical 0.5 m cells (10×7 → 20×14)');

// ---- Wiring (text-grep) ----------------------------------------------------
const appState = readFileSync('./js/app-state.js', 'utf8');
const room2d   = readFileSync('./js/graphics/room-2d.js', 'utf8');
const printRep = readFileSync('./js/ui/print-report.js', 'utf8');
const indexHtml = readFileSync('./index.html', 'utf8');
const roomMain = readFileSync('./js/labs/roomlab/main.js', 'utf8');
const spl      = readFileSync('./js/physics/spl-calculator.js', 'utf8');

ok(/heatmapRes:\s*'standard'/.test(appState),
   "app-state.js: state.display.heatmapRes defaults to 'standard'");
ok(/cellTarget_m = HEATMAP_CELL_TARGET_M/.test(spl) && /maxCells = HEATMAP_CELL_MAX/.test(spl),
   'computeSPLGrid accepts cellTarget_m / maxCells (defaulting to the historical values)');
ok(/\.\.\.heatmapResParams\(state\.display\?\.heatmapRes\)/.test(room2d),
   'room-2d.js: 2D viewport passes the resolution into computeSPLGrid');
ok(/on\('heatmap-res:changed', render\)/.test(room2d),
   "room-2d.js: re-renders on 'heatmap-res:changed'");
ok(/\.\.\.resParams/.test(printRep) && /\(cached\.cellTarget_m \?\? 0\.5\) === resParams\.cellTarget_m/.test(printRep),
   'print-report.js: passes resolution AND makes the grid cache resolution-aware');
ok(/data-res="standard"/.test(indexHtml) && /data-res="high"/.test(indexHtml) && /data-res="ultra"/.test(indexHtml),
   'index.html: more-panel has Standard / High / Ultra detail pills');
ok(/state\.display\.heatmapRes = level/.test(roomMain) && /emit\('heatmap-res:changed'\)/.test(roomMain),
   'main.js: selecting a level sets heatmapRes and emits heatmap-res:changed');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll heatmap-resolution assertions passed.');
