// Phase 7 heatmap regression — wall-thickness annulus classification.
//
// Dr. Chen audit 2026-05-23 (surau preset): user observed a non-physical
// "yellow → red → yellow" radial pattern outside the west wall in 3D top.
// Diagnosis: cells inside the parent footprint's OUTER polygon but in the
// WALL-THICKNESS annulus (between outer + inner polygons) were classified
// `isInsideRoom3D = true` → ctxInside → full 4/R reverberant lift → a hot
// ring of cells at wall-thickness-distance from the outer face.
//
// Fix (spl-calculator.js, this commit): compute the parent inner polygon
// ONCE via wallInsetPolygon; cells inside outer ∧ NOT inside inner →
// -Infinity (transparent, "in wall"). Other paths (enclosure, podium,
// outdoor open field) unchanged.
//
// What this test pins:
//   (A) Cells in the wall annulus return -Infinity in INDOOR mode.
//   (B) Cells in the wall annulus return -Infinity in OUTDOOR mode too
//       (the wall is wall regardless of indoor/outdoor classification).
//   (C) Cells inside the inner polygon return finite, same as before.
//   (D) Cells outside the outer polygon: -Infinity indoor, finite outdoor
//       (unchanged behaviour).
//   (E) With DEFAULT 100 mm walls on a typical room + 0.5 m cells, no cell
//       center falls in the annulus → no regression on existing scenes.
//   (F) For a single source inside the room, the radial SPL slice across
//       a wall (interior → annulus → exterior) is monotonically
//       decreasing in r past the outer face (no anomaly hotspot).

import { readFileSync } from 'node:fs';
import { computeSPLGrid, computeMultiSourceSPL, computeListenerBreakdown } from '../js/physics/spl-calculator.js';

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

const speaker = {
  acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 6 },
  directivity: {
    azimuth_deg: [-180, -90, 0, 90, 180],
    elevation_deg: [-90, 0, 90],
    attenuation_db: {
      "125":  [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
      "500":  [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
      "1000": [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
      "2000": [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
      "4000": [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
      "8000": [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
    },
  },
};
const getDef = () => speaker;

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// =============================================================================
// Helper — locate the cell whose center is closest to (x_m, y_m) in a grid.
// =============================================================================
function cellAt(g, x_m, y_m) {
  const i = Math.floor((x_m - g.originX_m) / g.cellW_m);
  const j = Math.floor((y_m - g.originY_m) / g.cellD_m);
  if (i < 0 || j < 0 || i >= g.cellsX || j >= g.cellsY) return null;
  return g.grid[j][i];
}

// =============================================================================
// (A, B, C) — thick walls (500 mm) on every side; sample annulus + interior.
// =============================================================================
{
  // 10 × 10 m room, 500 mm walls on every side. Inner footprint: 0.5..9.5
  // m in both x and y. With 0.5 m cells (gridSize 25), the cell-center at
  // (0.25, 5.0) is in the WEST wall annulus (x < 0.5). The cell at
  // (1.25, 5.0) is inside the inner polygon (x ≥ 0.5).
  const room = {
    shape: 'rectangular', width_m: 10, height_m: 4, depth_m: 10,
    ceiling_type: 'flat',
    surfaces: {
      floor: 'concrete-painted', ceiling: 'concrete-painted', walls: 'concrete-painted',
      wall_north: { materialId: 'concrete-painted', thickness_m: 0.5, openings: [] },
      wall_south: { materialId: 'concrete-painted', thickness_m: 0.5, openings: [] },
      wall_east:  { materialId: 'concrete-painted', thickness_m: 0.5, openings: [] },
      wall_west:  { materialId: 'concrete-painted', thickness_m: 0.5, openings: [] },
    },
  };
  const sources = [
    { modelUrl: 'x', position: { x: 5, y: 5, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 },
  ];

  const gIndoor = computeSPLGrid({
    sources, getSpeakerDef: getDef, room, materials,
    freq_hz: 1000, roomConstantR: 80, earHeight_m: 1.2,
  });

  // (A) Cell inside annulus (west wall, x=0.25) → -Infinity.
  const annulusW = cellAt(gIndoor, 0.25, 5.0);
  check('(A) west-wall annulus cell (x=0.25, 500 mm walls) → -Infinity (indoor)',
    annulusW === -Infinity, `value = ${annulusW}`);

  const annulusN = cellAt(gIndoor, 5.0, 0.25);
  check('(A) north-wall annulus cell (y=0.25) → -Infinity (indoor)',
    annulusN === -Infinity, `value = ${annulusN}`);

  // (C) Cell strictly inside inner polygon → finite.
  const interior = cellAt(gIndoor, 5.0, 5.0);
  check('(C) interior cell (x=5, y=5) → finite SPL',
    Number.isFinite(interior), `value = ${interior}`);

  // (D-indoor) Cell strictly outside outer polygon → -Infinity (existing
  // indoor behaviour: no measurement points outside footprint).
  const exteriorIndoor = cellAt(gIndoor, -0.5, 5.0);
  check('(D-indoor) cell outside outer (x=-0.5) → -Infinity in indoor mode',
    exteriorIndoor === -Infinity || exteriorIndoor === null,
    `value = ${exteriorIndoor}`);

  // ---- Outdoor mode: same room, opt into outdoor + extended field bounds.
  const gOutdoor = computeSPLGrid({
    sources, getSpeakerDef: getDef, room: { ...room, enclosure: 'outdoor' }, materials,
    freq_hz: 1000, roomConstantR: 80, earHeight_m: 1.2,
    outdoor: true,
    fieldBounds: { minX: -5, minY: -5, maxX: 15, maxY: 15 },
  });

  // (B) Annulus cell stays -Infinity in outdoor mode — the wall is wall,
  //     irrespective of "outside footprint = field" logic.
  const annulusW_outdoor = cellAt(gOutdoor, 0.25, 5.0);
  check('(B) west-wall annulus cell → -Infinity in OUTDOOR mode too',
    annulusW_outdoor === -Infinity, `value = ${annulusW_outdoor}`);

  // (D-outdoor) Cell strictly outside outer polygon in outdoor mode → finite
  // (free-field, R=0). Verifies the open-field path is unchanged by the
  // inWall guard.
  const exteriorOutdoor = cellAt(gOutdoor, -2, 5.0);
  check('(D-outdoor) cell outside outer (x=-2) → finite in OUTDOOR mode (free-field)',
    Number.isFinite(exteriorOutdoor), `value = ${exteriorOutdoor}`);
}

// =============================================================================
// (E) — default 100 mm walls + 0.5 m cells → no annulus cells, no regression.
// =============================================================================
{
  // 10 × 10 m room with DEFAULT thickness (no explicit override → 100 mm).
  // Inner footprint: 0.1..9.9 m. With 0.5 m cells, the first cell center is
  // at (0.25, 0.25) which is INSIDE the inner polygon (x ≥ 0.1). So no cell
  // center should fall in the annulus → no -Infinity from the inWall guard.
  const room = {
    shape: 'rectangular', width_m: 10, height_m: 4, depth_m: 10,
    ceiling_type: 'flat',
    surfaces: {
      floor: 'concrete-painted', ceiling: 'concrete-painted', walls: 'concrete-painted',
      // Legacy string slots — thickness defaults to 0.10 m via normalizeWallSlot.
      wall_north: 'concrete-painted', wall_south: 'concrete-painted',
      wall_east:  'concrete-painted', wall_west:  'concrete-painted',
    },
  };
  const sources = [
    { modelUrl: 'x', position: { x: 5, y: 5, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 },
  ];

  const g = computeSPLGrid({
    sources, getSpeakerDef: getDef, room, materials,
    freq_hz: 1000, roomConstantR: 80, earHeight_m: 1.2,
  });

  // All cell centers fall inside the inner 9.8 × 9.8 footprint, so none
  // should be classified inWall. Count finite cells; with 0.5 m cells and a
  // 10 × 10 room there are 20 × 20 = 400 cells, all interior, all finite.
  let finiteCells = 0, infCells = 0;
  for (let j = 0; j < g.cellsY; j++) {
    for (let i = 0; i < g.cellsX; i++) {
      const v = g.grid[j][i];
      if (Number.isFinite(v)) finiteCells++;
      else infCells++;
    }
  }
  check('(E) default 100 mm walls + 0.5 m cells: ≥ 95 % of cells finite (no false inWall regression)',
    finiteCells >= 0.95 * (g.cellsX * g.cellsY),
    `${finiteCells} finite / ${g.cellsX * g.cellsY} total`);
}

// =============================================================================
// (F) — radial slice across a thick west wall, single source in room.
//      Interior → annulus → exterior must be monotonically decreasing in r
//      past the outer face (no Dr. Chen "yellow → red → yellow" anomaly).
// =============================================================================
{
  // 10 × 10 m room, 500 mm thick west wall (to make the annulus a
  // sample-grade band on a 0.5 m grid). Other walls default.
  const room = {
    shape: 'rectangular', width_m: 10, height_m: 4, depth_m: 10,
    ceiling_type: 'flat', enclosure: 'outdoor',
    surfaces: {
      floor: 'concrete-painted', ceiling: 'concrete-painted', walls: 'concrete-painted',
      wall_north: 'concrete-painted',
      wall_south: 'concrete-painted',
      wall_east:  'concrete-painted',
      wall_west:  { materialId: 'concrete-painted', thickness_m: 0.5, openings: [] },
    },
  };
  // One source near the east wall (state +x), aimed west.
  const sources = [
    { modelUrl: 'x', position: { x: 9.0, y: 5, z: 1.5 }, aim: { yaw: 180, pitch: 0 }, power_watts: 100 },
  ];

  const g = computeSPLGrid({
    sources, getSpeakerDef: getDef, room, materials,
    freq_hz: 1000, roomConstantR: 80, earHeight_m: 1.2,
    outdoor: true,
    fieldBounds: { minX: -10, minY: -5, maxX: 15, maxY: 15 },
  });

  // Walk a row along y = 5.0 from interior (x ≈ 9 — near source) westward
  // to deep exterior (x ≈ -8). The radial expectation:
  //   x ∈ (0.5, 9.0]   interior — finite, decreasing as we move away from source
  //   x ∈ (0.0, 0.5)   in west-wall annulus → -Infinity (transparent)
  //   x ∈ (-∞, 0.0)    exterior — finite, MUST decrease monotonically with
  //                                       distance from outer face (x = 0)
  // We assert the exterior slice is monotonic-decreasing in -x (deeper into
  // the field = lower SPL). 0.5 dB tolerance per step accommodates the
  // diffraction/re-radiation cliff smoother.
  const ys = 5.0;
  // First, the annulus band itself: every cell whose center is in
  // x ∈ (0, 0.5) should be -Infinity. With 0.5 m cells originating at
  // x = -10, the first annulus cell is x ≈ 0.25.
  const annulusCells = [];
  const exteriorCells = [];
  for (let i = 0; i < g.cellsX; i++) {
    const cx = g.originX_m + (i + 0.5) * g.cellW_m;
    const j = Math.floor((ys - g.originY_m) / g.cellD_m);
    const v = g.grid[j][i];
    if (cx > 0 && cx < 0.5) annulusCells.push({ x: cx, v });
    if (cx < 0) exteriorCells.push({ x: cx, v });
  }

  check('(F) west-wall annulus row contains at least 1 cell (sanity)',
    annulusCells.length >= 1, `${annulusCells.length} cells`);
  check('(F) every annulus cell is -Infinity (transparent)',
    annulusCells.every(c => c.v === -Infinity),
    annulusCells.map(c => `x=${c.x.toFixed(2)}:${c.v}`).join(', '));

  // Exterior monotonicity: walk from x=0⁻ outward (decreasing x) and assert
  // SPL is non-increasing. Allow a 0.5 dB tolerance for diffraction/re-rad.
  exteriorCells.sort((a, b) => b.x - a.x);   // closest-to-wall first
  let monoBreak = null;
  for (let i = 1; i < exteriorCells.length; i++) {
    const prev = exteriorCells[i - 1];
    const cur = exteriorCells[i];
    if (!Number.isFinite(prev.v) || !Number.isFinite(cur.v)) continue;
    // Allow a 0.5 dB up-tick (interference / re-radiation near-field).
    if (cur.v - prev.v > 0.5) {
      monoBreak = { prev, cur, gain: cur.v - prev.v };
      break;
    }
  }
  check('(F) exterior radial slice is monotonically decreasing past outer face (no inWall hotspot)',
    monoBreak === null,
    monoBreak ? `bump at x=${monoBreak.cur.x.toFixed(2)} — ${monoBreak.prev.v.toFixed(2)} → ${monoBreak.cur.v.toFixed(2)} dB (+${monoBreak.gain.toFixed(2)})` : '');
}

// =============================================================================
// (G) — surau-podium classification: cells on the podium (isInsideRoom3D = true
//       via the podium branch in room-shape.js) MUST use ctxOutside, NOT
//       ctxInside. Otherwise the outdoor porch inherits the building's
//       interior 4/R reverberant lift — user-reported 2026-05-24 where the
//       covered arcade corridor read ~6 dB HIGHER than the uncovered corridor
//       next to it. The roof material is irrelevant; the heatmap doesn't
//       trace reflections off the arcade roof.
// =============================================================================
{
  // Synthetic surau-like preset: rectangular 10 × 10 room with a 3 m
  // podium extending outward on every side. With non-zero roomConstantR,
  // ctxInside applies a substantial 4/R lift; ctxOutside does NOT.
  const room = {
    shape: 'rectangular', width_m: 10, height_m: 4, depth_m: 10,
    ceiling_type: 'flat',
    surauStructure: {
      podium: { extension_m: 3.0 },
    },
    surfaces: {
      floor: 'concrete-painted', ceiling: 'concrete-painted', walls: 'concrete-painted',
      wall_north: 'concrete-painted', wall_south: 'concrete-painted',
      wall_east:  'concrete-painted', wall_west:  'concrete-painted',
    },
  };
  // Two sources inside the building near the south wall (will drive a
  // detectable interior reverberant aggregate so the bug, if present,
  // would inflate podium cells noticeably).
  const sources = [
    { modelUrl: 'x', position: { x: 3, y: 1, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 },
    { modelUrl: 'x', position: { x: 7, y: 1, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 },
  ];

  // Build TWO grids:
  //   gReverb — with roomConstantR > 0 (interior reverb active)
  //   gFree   — with roomConstantR = 0 (no interior reverb)
  // A podium cell that incorrectly inherits the interior reverb will show
  // a large delta between the two; a correctly-classified outdoor podium
  // cell will be near-identical.
  const optsCommon = {
    sources, getSpeakerDef: getDef, room, materials,
    freq_hz: 1000, earHeight_m: 1.2,
  };
  const gReverb = computeSPLGrid({ ...optsCommon, roomConstantR: 60 });
  const gFree   = computeSPLGrid({ ...optsCommon, roomConstantR: 0 });

  // Probe a cell well inside the podium but OUTSIDE the building footprint —
  // (-1.5, 5.0) is 1.5 m west of the building's west wall, in the porch band.
  const podiumProbeX = -1.5;
  const podiumProbeY = 5.0;
  const vReverb = cellAt(gReverb, podiumProbeX, podiumProbeY);
  const vFree   = cellAt(gFree,   podiumProbeX, podiumProbeY);
  const dPodium = (Number.isFinite(vReverb) && Number.isFinite(vFree))
    ? Math.abs(vReverb - vFree)
    : Infinity;
  check('(G) podium cell is finite (covered by extended bounds, not -Infinity)',
    Number.isFinite(vReverb) && Number.isFinite(vFree),
    `reverb=${vReverb}, free=${vFree}`);
  check('(G) podium cell value is INDEPENDENT of interior roomConstantR (no 4/R lift attribution)',
    dPodium < 0.5,
    `Δ = ${dPodium.toFixed(2)} dB (must be < 0.5)`);

  // Cross-check: a TRUE interior cell (5, 5) MUST track roomConstantR (i.e.
  // the cell DOES depend on the interior reverb — that's the correct ctx).
  // Without this cross-check, "0 dB delta everywhere" could be a degenerate
  // fix that broke the interior path.
  const interiorReverb = cellAt(gReverb, 5.0, 5.0);
  const interiorFree   = cellAt(gFree, 5.0, 5.0);
  const dInterior = Math.abs(interiorReverb - interiorFree);
  check('(G) interior cell DOES vary with roomConstantR (sanity — fix did not flatten interior)',
    dInterior > 1.0,
    `Δ = ${dInterior.toFixed(2)} dB (must be > 1.0)`);
}

// =============================================================================
// (H) — live listener-probe path: walk-mode SPL + per-listener label use
//       computeMultiSourceSPL (one-shot), not the grid. Must apply the SAME
//       inside-building-interior gate so a podium listener doesn't read the
//       interior 4/R lift. Without this, the user's walk-mode probe at the
//       arcade corridor would read ~6 dB higher than reality even after the
//       heatmap grid was fixed (user report 2026-05-24).
// =============================================================================
{
  const room = {
    shape: 'rectangular', width_m: 10, height_m: 4, depth_m: 10,
    ceiling_type: 'flat',
    surauStructure: { podium: { extension_m: 3.0 } },
    surfaces: {
      floor: 'concrete-painted', ceiling: 'concrete-painted', walls: 'concrete-painted',
      wall_north: 'concrete-painted', wall_south: 'concrete-painted',
      wall_east:  'concrete-painted', wall_west:  'concrete-painted',
    },
  };
  const sources = [
    { modelUrl: 'x', position: { x: 3, y: 1, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 },
    { modelUrl: 'x', position: { x: 7, y: 1, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 },
  ];
  const podiumListener = { x: -1.5, y: 5.0, z: 1.68 };  // matches the user's walk-mode probe
  const interiorListener = { x: 5.0, y: 5.0, z: 1.68 };

  const vPodiumR60 = computeMultiSourceSPL({
    sources, getSpeakerDef: getDef, listenerPos: podiumListener,
    freq_hz: 1000, room, materials, roomConstantR: 60,
  });
  const vPodiumR0 = computeMultiSourceSPL({
    sources, getSpeakerDef: getDef, listenerPos: podiumListener,
    freq_hz: 1000, room, materials, roomConstantR: 0,
  });
  const dPodium = Math.abs(vPodiumR60 - vPodiumR0);
  check('(H) computeMultiSourceSPL on podium listener is INDEPENDENT of R (no 4/R lift)',
    Number.isFinite(vPodiumR60) && Number.isFinite(vPodiumR0) && dPodium < 0.5,
    `R=60 → ${vPodiumR60?.toFixed(2)}, R=0 → ${vPodiumR0?.toFixed(2)}, Δ = ${dPodium.toFixed(2)}`);

  const vInteriorR60 = computeMultiSourceSPL({
    sources, getSpeakerDef: getDef, listenerPos: interiorListener,
    freq_hz: 1000, room, materials, roomConstantR: 60,
  });
  const vInteriorR0 = computeMultiSourceSPL({
    sources, getSpeakerDef: getDef, listenerPos: interiorListener,
    freq_hz: 1000, room, materials, roomConstantR: 0,
  });
  const dInterior = Math.abs(vInteriorR60 - vInteriorR0);
  check('(H) computeMultiSourceSPL on interior listener DOES depend on R (sanity)',
    dInterior > 1.0, `R=60 → ${vInteriorR60?.toFixed(2)}, R=0 → ${vInteriorR0?.toFixed(2)}, Δ = ${dInterior.toFixed(2)}`);

  // computeListenerBreakdown — used by panel-results.js for the selected
  // listener's per-source breakdown table. Same gate must apply.
  const bPodiumR60 = computeListenerBreakdown({
    sources, getSpeakerDef: getDef, listenerPos: podiumListener,
    freq_hz: 1000, room, materials, roomConstantR: 60,
  });
  const bPodiumR0 = computeListenerBreakdown({
    sources, getSpeakerDef: getDef, listenerPos: podiumListener,
    freq_hz: 1000, room, materials, roomConstantR: 0,
  });
  const bDelta = Math.abs(bPodiumR60.total_spl_db - bPodiumR0.total_spl_db);
  check('(H) computeListenerBreakdown on podium listener is INDEPENDENT of R',
    bDelta < 0.5,
    `R=60 → ${bPodiumR60.total_spl_db?.toFixed(2)}, R=0 → ${bPodiumR0.total_spl_db?.toFixed(2)}, Δ = ${bDelta.toFixed(2)}`);

  // The reverb_db field should be -Infinity for outdoor listener (no contribution).
  check('(H) computeListenerBreakdown.reverb_db = -Infinity for podium listener',
    bPodiumR60.reverb_db === -Infinity,
    `reverb_db = ${bPodiumR60.reverb_db}`);
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
