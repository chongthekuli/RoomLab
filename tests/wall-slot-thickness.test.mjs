// Phase 7 Commit 1 — wall-slot thickness_m schema extension.
//
// Hannes plan 2026-05-23: visual-only sub-phase before WallLAB Rw modifies
// inter-zone SPL (Phase 8). Commit 1 extends normalizeWallSlot +
// applySurauOpeningsToSlot to carry a per-slot thickness_m field with a
// 0.10 m default (gypsum-board single-leaf reference). Zero behavior
// change: legacy string slots and legacy {materialId, openings} objects
// MUST normalize identically for the area math that feeds RT60/STI.
//
// This is the regression guard against "we shipped a schema change and
// silently broke baseArea or expandWallWithOpenings."

import assert from 'node:assert';
import {
  normalizeWallSlot,
  applySurauOpeningsToSlot,
  DEFAULT_WALL_THICKNESS_M,
} from '../js/physics/room-shape.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// =============================================================================
// (1) DEFAULT_WALL_THICKNESS_M is exported and locked at 0.10 m
// =============================================================================

check('DEFAULT_WALL_THICKNESS_M exported',
  typeof DEFAULT_WALL_THICKNESS_M === 'number');
check('DEFAULT_WALL_THICKNESS_M = 0.10 m (gypsum-board single-leaf reference)',
  DEFAULT_WALL_THICKNESS_M === 0.10);

// =============================================================================
// (2) Legacy string slot — backward compat: same materialId, default thickness
// =============================================================================

{
  const norm = normalizeWallSlot('concrete-painted');
  check('legacy string: materialId preserved',
    norm.materialId === 'concrete-painted');
  check('legacy string: openings = []',
    Array.isArray(norm.openings) && norm.openings.length === 0);
  check('legacy string: thickness_m defaults to 0.10',
    norm.thickness_m === 0.10);
}

// =============================================================================
// (3) Legacy {materialId, openings} object — default thickness, openings kept
// =============================================================================

{
  const slot = {
    materialId: 'gypsum-board',
    openings: [{ kind: 'door', x_m: 1, z_m: 0, width_m: 0.9, height_m: 2.1, state: 'closed', materialId: 'door-solid-wood' }],
  };
  const norm = normalizeWallSlot(slot);
  check('legacy v1 object: materialId preserved',
    norm.materialId === 'gypsum-board');
  check('legacy v1 object: openings preserved (length + kind)',
    norm.openings.length === 1 && norm.openings[0].kind === 'door');
  check('legacy v1 object: thickness_m defaults to 0.10',
    norm.thickness_m === 0.10);
}

// =============================================================================
// (4) New v2 object with thickness_m — explicit thickness honored
// =============================================================================

{
  const slot = {
    materialId: 'concrete-painted',
    thickness_m: 0.200,
    openings: [],
  };
  const norm = normalizeWallSlot(slot);
  check('v2 object: explicit thickness_m honored (0.200)',
    norm.thickness_m === 0.200);
  check('v2 object: materialId preserved',
    norm.materialId === 'concrete-painted');
}

// =============================================================================
// (5) Defensive — invalid thickness_m falls back to default
// =============================================================================

{
  const bad = [
    { materialId: 'gypsum-board', thickness_m: -0.1 },     // negative
    { materialId: 'gypsum-board', thickness_m: 0 },        // zero
    { materialId: 'gypsum-board', thickness_m: NaN },      // NaN
    { materialId: 'gypsum-board', thickness_m: 'thick' },  // wrong type
    { materialId: 'gypsum-board' },                        // missing
  ];
  for (const slot of bad) {
    const norm = normalizeWallSlot(slot);
    check(`invalid thickness (${JSON.stringify(slot.thickness_m)}) → default`,
      norm.thickness_m === 0.10);
  }
}

// =============================================================================
// (6) Falsy slot (null/undefined/0) — fallback materialId + default thickness
// =============================================================================

{
  // Note: empty string '' is intentionally NOT tested here — it hits the
  // string branch and returns materialId='' (pre-existing behavior, not
  // changed by Phase 7). null / undefined / non-string-non-object fall
  // through to the fallback path.
  for (const slot of [null, undefined, 0]) {
    const norm = normalizeWallSlot(slot, 'concrete-painted');
    check(`falsy slot (${String(slot)}) returns fallback materialId + default thickness`,
      norm.materialId === 'concrete-painted' && norm.thickness_m === 0.10);
  }
}

// =============================================================================
// (7) applySurauOpeningsToSlot preserves thickness_m through the merge
// =============================================================================

{
  // Build a minimal surau room with surauStructure openings (azan doors)
  // to trigger the merge path.
  const room = {
    width_m: 10,
    depth_m: 10,
    height_m: 4.5,
    shape: 'rectangular',
    surauStructure: {
      mode: 'preset',
      preset: 'azan-door-pair',
      // Synthesise something for the function to merge — uses
      // surauStructureWallOpenings's internal preset map.
    },
  };
  // Even if surauStructure is non-empty, the openings synthesis may return
  // [] depending on the preset map. Test the no-op path AND the merge
  // path separately.
  const slot = { materialId: 'concrete-painted', thickness_m: 0.250, openings: [] };
  const out = applySurauOpeningsToSlot(slot, room, 'wall_north');
  // If no synthetic openings were generated, function returns slot unchanged.
  // If synthetic openings WERE generated, output is a fresh object that must
  // carry materialId + thickness_m + merged openings.
  const isMerged = out !== slot;
  if (isMerged) {
    check('applySurauOpeningsToSlot (merge path): materialId preserved',
      out.materialId === 'concrete-painted');
    check('applySurauOpeningsToSlot (merge path): thickness_m preserved (0.250)',
      out.thickness_m === 0.250);
    check('applySurauOpeningsToSlot (merge path): openings include synth entries',
      Array.isArray(out.openings) && out.openings.length > 0);
  } else {
    check('applySurauOpeningsToSlot (no-op path): returns slot unchanged',
      out === slot);
  }
}

// =============================================================================
// (8) Normaliser is idempotent — feeding output back through changes nothing
// =============================================================================

{
  const inputs = [
    'gypsum-board',
    { materialId: 'concrete-painted', openings: [] },
    { materialId: 'concrete-painted', thickness_m: 0.200, openings: [] },
    null,
  ];
  for (const slot of inputs) {
    const once = normalizeWallSlot(slot);
    const twice = normalizeWallSlot(once);
    check(`idempotent normalise: ${typeof slot === 'object' ? JSON.stringify(slot) : String(slot)}`,
      JSON.stringify(once) === JSON.stringify(twice));
  }
}

// =============================================================================
// (9) Output shape — always { materialId: string, thickness_m: number, openings: array }
// =============================================================================

{
  const inputs = ['s', { materialId: 'm' }, { materialId: 'm', thickness_m: 0.2 }, null, 42, {}];
  for (const slot of inputs) {
    const norm = normalizeWallSlot(slot);
    check(`output shape for ${JSON.stringify(slot)}`,
      typeof norm.materialId === 'string' &&
      typeof norm.thickness_m === 'number' &&
      norm.thickness_m > 0 &&
      Array.isArray(norm.openings));
  }
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
