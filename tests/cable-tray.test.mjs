// Cable-tray row layout — pure geometry math (no Three.js).
// Guards js/graphics/cable-tray.js computeCableTrayRows: the rows the 3D
// rebuildCableTrays() turns into overhead ladder trays for the Google Data
// Center preset.
import { computeCableTrayRows, rowAxisForYaw, CABLE_TRAY_DEFAULTS } from '../js/graphics/cable-tray.js';
import googleDataCenter from '../js/presets/google-datacenter.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const CAT = { racks: { 'enclosed-42u': { outer_w_mm: 600, outer_h_mm: 2000, outer_d_mm: 1000 } } };
const mk = (x, y, yaw) => ({ position: { x, y, z: 0 }, yaw_deg: yaw, rackModelKey: 'enclosed-42u' });

// --- yaw → row axis --------------------------------------------------------
assert(rowAxisForYaw(0) === 'x' && rowAxisForYaw(180) === 'x', 'yaw 0/180 → row runs along x');
assert(rowAxisForYaw(90) === 'y' && rowAxisForYaw(270) === 'y', 'yaw 90/270 → row runs along y');
assert(rowAxisForYaw(179) === 'x' && rowAxisForYaw(91) === 'y', 'yaw snaps to nearest 90°');

// --- empty input -----------------------------------------------------------
assert(computeCableTrayRows([], CAT).length === 0, 'no racks → no tray rows');
assert(computeCableTrayRows(null, CAT).length === 0, 'null racks → no tray rows');

// --- one row of 20 racks along x at y=-24, yaw 0 ---------------------------
const oneRow = [];
for (let i = 0; i < 20; i++) oneRow.push(mk(-5.7 + i * 0.6, -24, 0));
const r1 = computeCableTrayRows(oneRow, CAT);
assert(r1.length === 1, 'single rack line → exactly 1 tray row');
const row = r1[0];
assert(row.axis === 'x', 'row axis is x');
assert(near(row.cx, 0) && near(row.cy, -24), 'tray centred on the row (cx=0, cy=-24)');
assert(near(row.topY, 2.0), 'topY = rack outer height (2.0 m)');
// length = span + rackW + 2·overhang = 11.4 + 0.6 + 0.30 = 12.3
assert(near(row.length, 12.3), `tray length = span + rackW + 2·overhang (got ${row.length})`);
assert(near(row.depth, 1.0 * CABLE_TRAY_DEFAULTS.depthFrac), 'tray depth = depthFrac × rack depth');
// rungCount = round(length/pitch)+1 = round(12.3/0.3)+1 = 42
assert(row.rungCount === 42, `rung count = round(L/pitch)+1 (got ${row.rungCount})`);
assert(row.rackCount === 20, 'row reports its 20 racks');

// --- back-to-back pair (yaw 0 at y, yaw 180 at y+2.1) → 2 distinct rows ----
const pair = [mk(0, -24, 0), mk(0.6, -24, 0), mk(0, -21.9, 180), mk(0.6, -21.9, 180)];
const r2 = computeCableTrayRows(pair, CAT);
assert(r2.length === 2, 'back-to-back rows stay distinct (2 trays, one per cabinet line)');
assert(r2.every(r => r.axis === 'x'), 'both back-to-back rows run along x');

// --- a column of racks along y, yaw 90 → axis y ---------------------------
const col = [mk(10, 0, 90), mk(10, 1.2, 90), mk(10, 2.4, 90)];
const r3 = computeCableTrayRows(col, CAT);
assert(r3.length === 1 && r3[0].axis === 'y', 'yaw-90 column → 1 tray run along y');
assert(near(r3[0].cx, 10), 'y-axis tray sits at the column x (10)');

// --- against the real preset: 10 rack lines → 10 tray rows ----------------
const dcRows = computeCableTrayRows(googleDataCenter.rackSystem.racks, CAT);
assert(dcRows.length === 10, `Google DC preset → 10 tray rows (got ${dcRows.length})`);
assert(dcRows.every(r => r.rackCount === 20), 'each DC tray row spans its 20 racks');
assert(dcRows.every(r => r.axis === 'x'), 'all DC rows run E-W (along x)');

// --- missing catalogue falls back, still produces a finite tray -----------
const rFallback = computeCableTrayRows([mk(0, 0, 0), mk(0.6, 0, 0)], {});
assert(rFallback.length === 1 && Number.isFinite(rFallback[0].length) && rFallback[0].length > 0,
  'missing rack catalogue → fallback dims keep the math total');

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll cable-tray tests passed.');
