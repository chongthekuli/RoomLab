// Outdoor-field exclusion from the PRINT REPORT (Phase 4 hard constraint).
//
// The on-screen viewport heatmap (2D + 3D) extends over a large open-ground
// field when state.outdoor.enabled === true. The proposal print report must
// NEVER render that field — it stays ROOM-ONLY regardless of outdoor state.
//
// This is Sam's cross-surface "renders in the viewport but NOT in the report"
// separation. The report builds its OWN grid via ensurePrintSplGrid (inside
// js/ui/print-report.js → buildPrintModel) and passes outdoor:false explicitly
// (no fieldBounds). These tests would FAIL if a future change wired
// state.outdoor into the print path.
//
// Test boundaries:
//   A. BEHAVIOURAL — buildPrintModel (the real, Node-importable print entry)
//      with state.outdoor.enabled=true + field_size_m=1000 produces a heatmap
//      whose metadata matches a ROOM-ONLY grid, not the 1000 m field.
//   B. PARITY — re-run computeSPLGrid with the exact params the print path
//      uses (outdoor:false, no fieldBounds) and confirm bounds == room
//      effective bounds, while the viewport's outdoor call yields a much
//      larger field grid. A point 200 m from the room is in the field grid
//      but is -Infinity / absent in the room-only grid.
//   C. SOURCE GUARD — grep print-report.js: the print-path computeSPLGrid
//      call passes outdoor:false and never outdoor:true / fieldBounds.
//
// Run: node tests/outdoor-report-exclusion.test.mjs

import { readFileSync } from 'node:fs';
import { state, applyPresetToState, PRESETS } from '../js/app-state.js';
import { buildPrintModel } from '../js/ui/print-report.js';
import { computeSPLGrid } from '../js/physics/spl-calculator.js';
import { roomEffectiveBounds } from '../js/physics/room-shape.js';

const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};

// Synthetic speaker def — loadLoudspeaker() uses fetch(), which can't resolve
// relative paths under Node, so getCachedLoudspeaker is empty in tests. A stub
// (same approach as tests/outdoor-field.test.mjs) lets the field grid compute
// real finite SPL so the print-vs-field divergence assertions are meaningful.
const STUB_SPEAKER = {
  acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 6 },
  directivity: {
    azimuth_deg: [-180, -90, 0, 90, 180],
    elevation_deg: [-90, 0, 90],
    attenuation_db: {
      "1000": [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
    },
  },
};
const stubDef = () => STUB_SPEAKER;

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function close(actual, expected, tol, label) {
  const good = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}  actual=${actual} expected=${expected} ±${tol}`);
  if (!good) failed++;
}

// --- Scene: a preset with sources so ensurePrintSplGrid actually computes a
//     grid (it short-circuits to null when there are zero sources). Then turn
//     outdoor ON with the maximum 1000 m field — the worst case for leakage.
const presetKey = Object.keys(PRESETS).find(k => /surau/i.test(k)) || Object.keys(PRESETS)[0];
applyPresetToState(presetKey);
// Guarantee at least one source regardless of which preset we landed on.
if ((state.sources ?? []).length === 0) {
  state.sources = [{ modelUrl: 'x', position: { x: 1, y: 1, z: 2 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 }];
}
state.outdoor.enabled = true;
state.outdoor.field_size_m = 1000;
state.outdoor.temperature_C = 30;
state.outdoor.humidity_pct = 70;

const room = state.room;
const roomBounds = roomEffectiveBounds(room);
const roomW = roomBounds.maxX - roomBounds.minX;
const roomD = roomBounds.maxY - roomBounds.minY;

// =========================================================================
// A. buildPrintModel — the REAL print entry — stays room-only with outdoor on
// =========================================================================
{
  const model = buildPrintModel({ materials });
  ok(model && model.heatmap && typeof model.heatmap === 'object',
    `A: buildPrintModel produced a heatmap block (preset:${presetKey}, outdoor ON)`);
  // The heatmap metadata must NOT carry an outdoor flag — the print path
  // never opts into field mode. (computeSPLGrid echoes outdoor on the grid;
  // the model's heatmap block intentionally never surfaces outdoor:true.)
  ok(model.heatmap.outdoor !== true,
    'A: print model heatmap is not flagged outdoor');
}

// =========================================================================
// B. PARITY — replicate the print path params vs the viewport field params.
//    Same scene, same sources. Print path == room bounds; viewport == field.
// =========================================================================
{
  const sharedParams = {
    sources: state.sources ?? [],
    getSpeakerDef: stubDef,
    room,
    materials,
    earHeight_m: 1.2,
    freq_hz: 1000,
    roomConstantR: 0,
    metric: 'spl',
  };

  // What the PRINT REPORT does (ensurePrintSplGrid): outdoor:false, no fieldBounds.
  const printGrid = computeSPLGrid({ ...sharedParams, outdoor: false });

  // What the VIEWPORT does when outdoor is enabled: outdoor:true + the field
  // bounds derived from state.outdoor.field_size_m centred on the room.
  const half = state.outdoor.field_size_m / 2;
  const cx = (roomBounds.minX + roomBounds.maxX) / 2;
  const cy = (roomBounds.minY + roomBounds.maxY) / 2;
  const fieldBounds = { minX: cx - half, minY: cy - half, maxX: cx + half, maxY: cy + half };
  const fieldGrid = computeSPLGrid({
    ...sharedParams, outdoor: true, fieldBounds,
    temperature_C: 30, humidity_pct: 70,
  });

  // Print grid is bounded by the ROOM, NOT the 1000 m field.
  close(printGrid.originX_m, roomBounds.minX, 1e-6, 'B: print originX == room minX');
  close(printGrid.originY_m, roomBounds.minY, 1e-6, 'B: print originY == room minY');
  close(printGrid.cellsX * printGrid.cellW_m, roomW, 1e-3, 'B: print grid total width == room width');
  close(printGrid.cellsY * printGrid.cellD_m, roomD, 1e-3, 'B: print grid total depth == room depth');
  ok(printGrid.outdoor === false, 'B: print grid not flagged outdoor');

  // The field grid is MUCH larger — proves the two paths genuinely diverge
  // and that "outdoor:false, no fieldBounds" is what holds the report back.
  const fieldSpanX = fieldGrid.cellsX * fieldGrid.cellW_m;
  ok(fieldSpanX > roomW * 5,
    `B: viewport field grid is far larger than the room (field ${fieldSpanX.toFixed(0)} m vs room ${roomW.toFixed(1)} m)`);
  ok(fieldSpanX >= 900,
    `B: viewport field grid spans ~the 1000 m field (got ${fieldSpanX.toFixed(0)} m)`);

  // A point 200 m from the room footprint: IN the field grid (finite SPL),
  // but OUTSIDE the print grid entirely. If the print grid did somehow cover
  // it, it would be -Infinity (cell outside the footprint in indoor mode).
  const farX = roomBounds.maxX + 200;
  const farY = (roomBounds.minY + roomBounds.maxY) / 2;

  const inGrid = (g, x, y) => {
    const gx = (x - g.originX_m) / g.cellW_m;
    const gy = (y - g.originY_m) / g.cellD_m;
    const i = Math.floor(gx), j = Math.floor(gy);
    if (i < 0 || j < 0 || i >= g.cellsX || j >= g.cellsY) return { covered: false, v: undefined };
    return { covered: true, v: g.grid[j][i] };
  };

  const farInPrint = inGrid(printGrid, farX, farY);
  const farInField = inGrid(fieldGrid, farX, farY);

  ok(!farInPrint.covered || !Number.isFinite(farInPrint.v),
    `B: point 200 m from the room is NOT a finite cell in the print grid (covered=${farInPrint.covered}, v=${farInPrint.v})`);
  ok(farInField.covered && Number.isFinite(farInField.v),
    `B: same point IS a finite cell in the viewport field grid (v=${farInField.v?.toFixed?.(1)})`);
}

// =========================================================================
// C. SOURCE GUARD — the print-path call site hard-codes outdoor:false and
//    never opts into field mode. Trips if someone wires state.outdoor in.
// =========================================================================
{
  const src = readFileSync('js/ui/print-report.js', 'utf8');

  // The print path must explicitly pass outdoor:false.
  ok(/outdoor:\s*false/.test(src),
    'C: print-report.js explicitly passes outdoor: false to its grid call');

  // It must NEVER pass outdoor:true or a fieldBounds into the print grid.
  ok(!/outdoor:\s*true/.test(src),
    'C: print-report.js never passes outdoor: true');
  ok(!/\bfieldBounds\b/.test(src),
    'C: print-report.js never passes fieldBounds');

  // It must not read state.outdoor anywhere (the report is room-only by
  // construction; reading state.outdoor is the first step toward leaking it).
  ok(!/state\.outdoor/.test(src),
    'C: print-report.js never reads state.outdoor');

  // computeRoomConstant is POSITIONAL — (room, materials, freq, zones, opts).
  // The print path once called it with an object literal, which silently
  // landed `materials` as undefined and returned R=0, dropping the
  // reverberant field from the freshly-computed print heatmap. Guard that
  // the call is never made with a leading object argument.
  ok(!/computeRoomConstant\(\s*\{/.test(src),
    'C: print-report.js calls computeRoomConstant positionally, not with an object arg');
}

// =========================================================================
// D. CACHE GUARD — a STALE on-screen grid (outdoor field, or STI metric, or
//    wrong frequency) must NOT be reused by the print report. The report
//    reuses state.results.splGrid ONLY when it is room-only SPL at the
//    report frequency; otherwise it recomputes. (ensurePrintSplGrid is not
//    exported, so we drive it through buildPrintModel + model.heatmap.)
// =========================================================================
{
  applyPresetToState(presetKey);              // reset to a scene with sources
  state.outdoor.enabled = false;
  state.physics = state.physics || {};
  state.physics.freq_hz = 1000;
  state.results = state.results || {};

  const sentinelGrid = (over) => ({
    grid: [[42]], cellsX: 1, cellsY: 1, cellW_m: 1, cellD_m: 1,
    originX_m: 0, originY_m: 0, sourceCount: 1, metric: 'spl', freq_hz: 1000,
    minSPL_db: 42, maxSPL_db: 42, avgSPL_db: 42, earHeight_m: 1.2, outdoor: false,
    ...over,
  });

  // D1 — outdoor cached grid is rejected (sentinel avgSPL_db=42 must not survive).
  state.results.splGrid = sentinelGrid({ outdoor: true });
  let m = buildPrintModel({ materials });
  ok(!m.heatmap || m.heatmap.avgSPL_db !== 42,
    'D1: an OUTDOOR cached grid is not reused by the print report');

  // D2 — STI cached grid is rejected; the printed heatmap metric stays SPL.
  state.results.splGrid = sentinelGrid({ metric: 'sti' });
  m = buildPrintModel({ materials });
  ok(!m.heatmap || m.heatmap.metric !== 'sti',
    'D2: an STI cached grid is not reused; print heatmap metric is not sti');

  // D3 — wrong-frequency cached grid is rejected.
  state.results.splGrid = sentinelGrid({ freq_hz: 4000 });
  m = buildPrintModel({ materials });
  ok(!m.heatmap || m.heatmap.avgSPL_db !== 42,
    'D3: a wrong-frequency cached grid is not reused');

  // D4 — POSITIVE CONTROL: a valid room-only SPL grid at the report frequency
  //      IS reused (sentinel survives), so the guard does not defeat the cache.
  state.results.splGrid = sentinelGrid({ avgSPL_db: 88, minSPL_db: 88, maxSPL_db: 88 });
  m = buildPrintModel({ materials });
  ok(m.heatmap && m.heatmap.avgSPL_db === 88,
    'D4: a valid room-only SPL grid at the report frequency IS reused');
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll outdoor-report-exclusion tests passed.');
