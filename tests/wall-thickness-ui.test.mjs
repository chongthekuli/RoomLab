// Phase 7 Commit 3 — per-wall thickness adjustment UI.
//
// Hannes plan 2026-05-23: visual sub-phase. Commit 2 made walls render
// with real thickness; Commit 3 adds the per-wall input control alongside
// "+ Door" / "+ Window" in panel-room.js so the user can dial each wall's
// thickness 25-600 mm and watch the 3D rebuild.
//
// This test is grep-based — the slot helpers in panel-room.js are
// module-private (no exports) and the DOM rendering needs a browser. We
// pin the wiring (helpers + render call + range + state writeback) so a
// future refactor can't silently break the schema round-trip. The visual
// correctness is the user's hard-refresh-accept gate.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  normalizeWallSlot,
  DEFAULT_WALL_THICKNESS_M,
} from '../js/physics/room-shape.js';
import { wallInsetPolygon } from '../js/physics/wall-inset.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

const panel = readFileSync('./js/ui/panel-room.js', 'utf8');
const css = readFileSync('./css/main.css', 'utf8');

// =============================================================================
// (1) Slot helpers — read + write thickness_m
// =============================================================================

check('readSlotThickness function exists',
  /function readSlotThickness\s*\(\s*slot\s*\)/.test(panel));
check('readSlotThickness falls back to DEFAULT_WALL_THICKNESS_M_UI',
  /function readSlotThickness[\s\S]*?return DEFAULT_WALL_THICKNESS_M_UI/.test(panel));
check('DEFAULT_WALL_THICKNESS_M_UI = 0.10 (matches room-shape.js)',
  /const DEFAULT_WALL_THICKNESS_M_UI\s*=\s*0\.10\b/.test(panel));
check('readSlotAsObject includes thickness_m in the returned shape',
  /function readSlotAsObject[\s\S]*?thickness_m:\s*readSlotThickness/.test(panel));
check('compactSlot preserves slot.thickness_m when non-default (keeps object form)',
  /function compactSlot[\s\S]*?isDefaultThickness[\s\S]*?if \(noOpenings && isDefaultThickness\) return slot\.materialId/.test(panel));
check('compactSlot drops thickness_m field when default (keeps save shape minimal)',
  /function compactSlot[\s\S]*?if \(isDefaultThickness\)[\s\S]*?const \{ thickness_m: _drop, \.\.\.rest \}/.test(panel));

// =============================================================================
// (2) Render function — renderThicknessRow exists with the right contract
// =============================================================================

check('renderThicknessRow function defined',
  /function renderThicknessRow\(surfaceId, getSlot, setSlot\)/.test(panel));
check('thickness input min = 25 mm (thin partition skin)',
  /renderThicknessRow[\s\S]*?input\.min\s*=\s*['"]25['"]/.test(panel));
check('thickness input max = 600 mm (heavy double-leaf concrete)',
  /renderThicknessRow[\s\S]*?input\.max\s*=\s*['"]600['"]/.test(panel));
check('thickness input step = 5 mm',
  /renderThicknessRow[\s\S]*?input\.step\s*=\s*['"]5['"]/.test(panel));
check('thickness input is type=number',
  /renderThicknessRow[\s\S]*?input\.type\s*=\s*['"]number['"]/.test(panel));
check('thickness shows current value in mm (× 1000 conversion)',
  /renderThicknessRow[\s\S]*?Math\.round\(readSlotThickness\(getSlot\(\)\) \* 1000\)/.test(panel));
check('thickness commit clamps to [25, 600] mm',
  /renderThicknessRow[\s\S]*?Math\.max\(25,\s*Math\.min\(600/.test(panel));
check('thickness commit writes mm/1000 to slot.thickness_m',
  /renderThicknessRow[\s\S]*?slot\.thickness_m\s*=\s*clamped\s*\/\s*1000/.test(panel));
check('thickness commit goes through compactSlot before setSlot',
  /renderThicknessRow[\s\S]*?setSlot\(compactSlot\(slot\)\)/.test(panel));
check('thickness commit emits "room:changed" to trigger 3D rebuild',
  /renderThicknessRow[\s\S]*?emit\(['"]room:changed['"]\)/.test(panel));
check('thickness input commits on both change and blur (user clicks away)',
  /renderThicknessRow[\s\S]*?input\.addEventListener\(['"]change['"], commit\)[\s\S]*?input\.addEventListener\(['"]blur['"], commit\)/.test(panel));
check('tooltip mentions Phase 8 ISO 12354-2 (forward-looking)',
  /renderThicknessRow[\s\S]*?ISO 12354-2/.test(panel));

// =============================================================================
// (3) renderWallRow wires the thickness row in BETWEEN material select and openings
// =============================================================================

check('renderWallRow calls renderThicknessRow inside the withOpenings branch',
  /if \(withOpenings\)\s*\{\s*[\s\S]*?renderThicknessRow\(surfaceId, getSlot, setSlot\)[\s\S]*?renderOpeningsBlock\(surfaceId, getSlot, setSlot\)/.test(panel));
check('thickness row appears BEFORE openings block in renderWallRow',
  (() => {
    const m = panel.match(/if \(withOpenings\)\s*\{\s*([\s\S]*?)\s*\}\s*parent\.appendChild\(wrap\)/);
    if (!m) return false;
    const block = m[1];
    const ti = block.indexOf('renderThicknessRow');
    const oi = block.indexOf('renderOpeningsBlock');
    return ti >= 0 && oi >= 0 && ti < oi;
  })());

// =============================================================================
// (4) CSS — thickness row styled
// =============================================================================

check('CSS defines .wall-thickness-row',
  /\.wall-thickness-row\s*\{/.test(css));
check('CSS defines .wall-thickness-input with fixed width (avoid sidebar overflow)',
  /\.wall-thickness-input\s*\{[\s\S]*?width:\s*\d+px/.test(css));
check('CSS defines .wall-thickness-label (muted text)',
  /\.wall-thickness-label\s*\{[\s\S]*?color:\s*var\(--text-muted/.test(css));
check('CSS defines .wall-thickness-unit (mm suffix)',
  /\.wall-thickness-unit\s*\{[\s\S]*?color:\s*var\(--text-muted/.test(css));
check('thickness input uses tabular-nums for column alignment',
  /\.wall-thickness-input[\s\S]*?font-variant-numeric:\s*tabular-nums/.test(css));

// =============================================================================
// (5) Behavioral round-trip — slot with thickness_m flows through normalizer
// =============================================================================
//
// This part of the test is REAL execution, not text-grep. It pins that the
// panel's writeback (slot object with thickness_m) survives the wall-slot
// normalizer + flows into wallInsetPolygon's per-edge thickness resolution.

{
  // Simulate the panel writing a per-wall thickness slot. The shape matches
  // what `readSlotAsObject` returns after the user edits the input.
  const slot = { materialId: 'gypsum-board', thickness_m: 0.200, openings: [] };
  const norm = normalizeWallSlot(slot);
  check('normalizer preserves panel-written thickness_m (200 mm)',
    norm.thickness_m === 0.200);
  check('normalizer preserves materialId',
    norm.materialId === 'gypsum-board');
}

// wallInsetPolygon must consume the new thickness from a CARDINAL SLOT.
{
  // Rectangular 6 × 8 room with north wall thick (300 mm), others default.
  // Match the rectEdgeSlotKey mapping in wall-inset.js:
  //   edge 0 = wall_north (y=0 face)
  //   edge 1 = wall_east
  //   edge 2 = wall_south
  //   edge 3 = wall_west
  const room = {
    shape: 'rectangular',
    width_m: 6,
    depth_m: 8,
    surfaces: {
      wall_north: { materialId: 'gypsum-board', thickness_m: 0.300, openings: [] },
      wall_east:  'gypsum-board',
      wall_south: 'gypsum-board',
      wall_west:  'gypsum-board',
    },
  };
  const { outer, inner, thicknesses } = wallInsetPolygon(room);
  check('wallInsetPolygon outer.length === 4 for rectangular',
    outer.length === 4);
  check('wallInsetPolygon picks up per-wall thickness from the cardinal slot — N edge = 300 mm',
    Math.abs(thicknesses[0] - 0.300) < 1e-9, `thicknesses[0] = ${thicknesses[0]}`);
  check('wallInsetPolygon defaults the other walls to 100 mm',
    Math.abs(thicknesses[1] - 0.100) < 1e-9 &&
    Math.abs(thicknesses[2] - 0.100) < 1e-9 &&
    Math.abs(thicknesses[3] - 0.100) < 1e-9);
  // Corner intersection sanity — top-right corner (outer at (6,0)) should
  // be inset by 100 mm in x (east wall) and 300 mm in y (north wall).
  // wall-inset.js intersects offset edges, so this is the right math for a
  // rectangular room with non-uniform thicknesses.
  const ne = inner[1]; // outer[1] = (6, 0); inner vertex at the NE corner
  check('NE inner corner inset 100 mm in x, 300 mm in y (non-uniform corner closes)',
    Math.abs(ne.x - (6 - 0.100)) < 1e-9 && Math.abs(ne.y - 0.300) < 1e-9,
    `inner[1] = (${ne.x}, ${ne.y})`);
}

// =============================================================================
// (6) compactSlot round-trip — default thickness collapses, non-default persists
// =============================================================================
//
// This is grepped (not executed) because compactSlot is module-private.
// We assert the LOGIC PATHS exist; behavioral correctness comes through the
// shape-pinning regexes in section (1).

check('compactSlot path: default thickness + no openings → string materialId',
  /if \(noOpenings && isDefaultThickness\) return slot\.materialId/.test(panel));
check('compactSlot path: non-default thickness → keeps object form (preserves thickness)',
  /function compactSlot[\s\S]*?return slot;\s*\}/.test(panel));

// =============================================================================
// (7) Cache bump
// =============================================================================

const html = readFileSync('./index.html', 'utf8');
const _vAll = [...html.matchAll(/\?v=(\d+)\b/g)].map(m => Number(m[1]));
check('index.html cache-bust is past v=632 (Commit 3 shipped at v=633+)',
  _vAll.length > 0 && _vAll.every(v => v >= 633));

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
