// Rack acoustic contribution regression test (Slice 5, 2026-05-27).
//
// User intent: placed AV/server racks must shift room acoustics, and
// empty rack vs fully-loaded rack must differ "totally" (verbatim).
//
// Locks in Dr. Chen's spec:
//   - material-swap on the front face (empty ↔ loaded), linear blend
//     on fillRatio
//   - side panels do NOT blend with fill (steel impedance same hot/cold)
//   - rear door uses single-α (no blend)
//   - fillRatio clamped to [0, 1] (oversubscribed file doesn't drive α
//     past loaded)
//   - open-frame rack at fillRatio=0 returns zero sub-volumes (below
//     precision floor)
//   - 1U blank covers count toward fillRatio (front-face mechanical
//     coverage matters regardless of device activity)

import {
  rackFillRatio,
  getRackSubVolumes,
  rackAbsorptionAt,
  sumRackAbsorption,
} from '../js/physics/rack-absorption.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function near(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

// --- Fixtures ----------------------------------------------------------

// Enclosed 42U: 600 × 1000 × 2076 mm, 100 mm castors (acoustic-active
// height = 1976 mm).
const ENCLOSED_42U = {
  u: 42,
  outer_w_mm: 600, outer_d_mm: 1000, outer_h_mm: 2076,
  castor_h_mm: 100, castors: true,
  style: 'enclosed',
  front_door: { type: 'mesh-glass', perforation_pct: 63, glass: true },
  rear_door:  { type: 'perforated-steel', perforation_pct: 50, glass: false },
  side_panels: true, vent_top_pct: 40, vent_bottom_pct: 0,
  legacy: false,
};

// Open-frame 42U: same outer dims, no doors/sides.
const OPEN_42U = {
  u: 42,
  outer_w_mm: 600, outer_d_mm: 1000, outer_h_mm: 2049,
  castor_h_mm: 0, castors: false,
  style: 'open-frame',
  front_door: { type: 'none', perforation_pct: 100, glass: false },
  rear_door:  { type: 'none', perforation_pct: 100, glass: false },
  side_panels: false, vent_top_pct: 100, vent_bottom_pct: 100,
  legacy: true,
};

// Stub material α lookup — matches Dr. Chen's spec values at 1 kHz.
const ALPHA_1K = {
  rack_metal_painted_panel:    0.05,
  rack_door_mesh_glass_empty:  0.45,
  rack_door_mesh_glass_loaded: 0.30,
  rack_door_perforated_rear:   0.65,
  rack_chassis_array_loaded:   0.25,
  rack_top_vented:             0.30,
};
const alphaAt = (id, _f) => ALPHA_1K[id] ?? 0;

// =====================================================================
// Block 1 — fillRatio basics and clamp.
// =====================================================================
{
  const empty = { rackModelKey: 'enclosed-42u', slots: [] };
  ok(rackFillRatio(empty, ENCLOSED_42U) === 0, 'empty rack → fillRatio = 0');

  const half = {
    rackModelKey: 'enclosed-42u',
    slots: [{ uHeight: 7 }, { uHeight: 7 }, { uHeight: 7 }],   // 21/42
  };
  ok(near(rackFillRatio(half, ENCLOSED_42U), 0.5),
    `half-loaded rack → fillRatio = 0.5 (got ${rackFillRatio(half, ENCLOSED_42U)})`);

  const full = {
    rackModelKey: 'enclosed-42u',
    slots: Array.from({ length: 42 }, () => ({ uHeight: 1 })),
  };
  ok(rackFillRatio(full, ENCLOSED_42U) === 1, 'fully loaded → fillRatio = 1');

  const over = {
    rackModelKey: 'enclosed-42u',
    slots: [{ uHeight: 50 }],   // oversubscribed (data-entry mistake)
  };
  ok(rackFillRatio(over, ENCLOSED_42U) === 1,
    'oversubscribed rack → fillRatio clamps to 1 (does NOT drive α past loaded)');

  const blankCovers = {
    rackModelKey: 'enclosed-42u',
    slots: [
      { uHeight: 1 }, { uHeight: 1 }, { uHeight: 1 }, { uHeight: 1 },
      { uHeight: 1 }, { uHeight: 1 }, { uHeight: 1 }, { uHeight: 1 },
    ],   // 8U of blank covers
  };
  ok(near(rackFillRatio(blankCovers, ENCLOSED_42U), 8/42, 1e-9),
    '1U blank covers count toward fillRatio (front-face coverage matters)');
}

// =====================================================================
// Block 2 — open-frame empty short-circuit.
// =====================================================================
{
  const empty = { rackModelKey: 'open-frame-42u', slots: [] };
  const subs = getRackSubVolumes(empty, OPEN_42U);
  ok(subs.length === 0,
    `open-frame empty: returns zero sub-volumes (got ${subs.length})`);
  ok(rackAbsorptionAt(empty, OPEN_42U, alphaAt, 1000) === 0,
    'open-frame empty: 0 m² Sabine contribution at 1 kHz');
}

// =====================================================================
// Block 3 — open-frame loaded → chassis array on front.
// =====================================================================
{
  const loaded = {
    rackModelKey: 'open-frame-42u',
    slots: [{ uHeight: 42 }],   // full
  };
  const subs = getRackSubVolumes(loaded, OPEN_42U);
  ok(subs.length === 1, `open-frame loaded: one sub-volume (front only)`);
  ok(subs[0].face === 'front', 'open-frame loaded: front face only');
  // 0.6 m wide × ~2.049 m tall (no castor subtraction since castors_h_mm = 0)
  const expectedArea = 0.6 * 2.049;
  ok(near(subs[0].area_m2, expectedArea, 0.01),
    `front area ≈ ${expectedArea.toFixed(2)} m² (got ${subs[0].area_m2.toFixed(2)})`);
  const A = rackAbsorptionAt(loaded, OPEN_42U, alphaAt, 1000);
  // fillRatio=1 → α = α_loaded = 0.25 → A = 0.6×2.049×0.25 ≈ 0.307
  ok(near(A, expectedArea * 0.25, 0.01),
    `loaded open-frame A@1k ≈ 0.31 m² Sabine (got ${A.toFixed(2)})`);
}

// =====================================================================
// Block 4 — enclosed rack: 5 sub-volumes present, areas sane.
// =====================================================================
{
  const empty = { rackModelKey: 'enclosed-42u', slots: [] };
  const subs = getRackSubVolumes(empty, ENCLOSED_42U);
  ok(subs.length === 5,
    `enclosed: 5 sub-volumes (front, rear, 2× side, top) — got ${subs.length}`);
  const faces = subs.map(s => s.face).sort();
  ok(JSON.stringify(faces) === JSON.stringify(['front', 'rear', 'side_left', 'side_right', 'top']),
    'enclosed: face tags match {front, rear, side_left, side_right, top}');

  // Sanity: front face area = 0.6 × (2.076 - 0.100) = 0.6 × 1.976 = 1.1856
  const front = subs.find(s => s.face === 'front');
  ok(near(front.area_m2, 0.6 * 1.976, 0.001),
    `enclosed front area = 0.6 × 1.976 m² (got ${front.area_m2.toFixed(3)})`);

  // Side face area = 1.0 × 1.976 = 1.976
  const sideL = subs.find(s => s.face === 'side_left');
  ok(near(sideL.area_m2, 1.0 * 1.976, 0.001),
    `enclosed side area = 1.0 × 1.976 m² (got ${sideL.area_m2.toFixed(3)})`);

  // Top area = 0.6 × 1.0 = 0.6
  const top = subs.find(s => s.face === 'top');
  ok(near(top.area_m2, 0.6 * 1.0, 0.001),
    `enclosed top area = 0.6 × 1.0 m² (got ${top.area_m2.toFixed(3)})`);
}

// =====================================================================
// Block 5 — enclosed empty vs fully-loaded: front material swaps, sides
// unchanged. (Dr. Chen's "totally different" requirement at 1 kHz.)
// =====================================================================
{
  const empty  = { rackModelKey: 'enclosed-42u', slots: [] };
  const full   = { rackModelKey: 'enclosed-42u',
    slots: Array.from({ length: 42 }, () => ({ uHeight: 1 })) };

  const A_empty = rackAbsorptionAt(empty, ENCLOSED_42U, alphaAt, 1000);
  const A_full  = rackAbsorptionAt(full,  ENCLOSED_42U, alphaAt, 1000);

  // Front: 1.1856 m² × (0.45 → 0.30) = 0.534 → 0.356 → Δ ≈ −0.178
  // Rear:  1.1856 m² × 0.65          = 0.770  (unchanged)
  // Sides: 2 × 1.976 m² × 0.05       = 0.198  (unchanged)
  // Top:   0.6 m²    × 0.30          = 0.180  (unchanged)
  // Empty total: 0.534 + 0.770 + 0.198 + 0.180 ≈ 1.682
  // Full  total: 0.356 + 0.770 + 0.198 + 0.180 ≈ 1.504
  ok(near(A_empty, 1.682, 0.01),
    `enclosed empty A@1k ≈ 1.68 m² Sabine (got ${A_empty.toFixed(2)})`);
  ok(near(A_full,  1.504, 0.01),
    `enclosed full  A@1k ≈ 1.50 m² Sabine (got ${A_full.toFixed(2)})`);
  ok(A_empty > A_full,
    `empty > loaded at 1 kHz (perforated-panel-over-large-cavity wins; got ${A_empty.toFixed(2)} > ${A_full.toFixed(2)})`);

  // Half-loaded: front α blends to 0.5×(0.45+0.30) = 0.375.
  const half = { rackModelKey: 'enclosed-42u',
    slots: [{ uHeight: 21 }] };
  const A_half = rackAbsorptionAt(half, ENCLOSED_42U, alphaAt, 1000);
  // Front: 1.1856 × 0.375 = 0.445; rest unchanged at 1.148.
  ok(near(A_half, 0.445 + 0.770 + 0.198 + 0.180, 0.01),
    `enclosed half-loaded A@1k between empty and full (got ${A_half.toFixed(2)})`);
  ok(A_half < A_empty && A_half > A_full,
    `half-loaded falls between empty and full monotonically`);
}

// =====================================================================
// Block 6 — sumRackAbsorption sums across multiple racks.
// =====================================================================
{
  const racks = [
    { rackModelKey: 'enclosed-42u', slots: [] },
    { rackModelKey: 'enclosed-42u', slots: [] },
    { rackModelKey: 'enclosed-42u', slots: [] },
  ];
  const catalogue = { racks: { 'enclosed-42u': ENCLOSED_42U } };
  const A = sumRackAbsorption(racks, catalogue, alphaAt, 1000);
  // 3 × 1.682
  ok(near(A, 3 * 1.682, 0.05),
    `3 enclosed empty racks: A@1k = 3 × single (got ${A.toFixed(2)})`);

  // Mixed: 1 enclosed empty + 1 enclosed full + 1 open-frame empty
  // (open-frame empty contributes 0).
  const mixed = [
    { rackModelKey: 'enclosed-42u', slots: [] },
    { rackModelKey: 'enclosed-42u', slots: Array.from({length: 42}, () => ({ uHeight: 1 })) },
    { rackModelKey: 'open-frame-42u', slots: [] },
  ];
  const mixedCat = { racks: { 'enclosed-42u': ENCLOSED_42U, 'open-frame-42u': OPEN_42U } };
  const A_mixed = sumRackAbsorption(mixed, mixedCat, alphaAt, 1000);
  ok(near(A_mixed, 1.682 + 1.504 + 0, 0.02),
    `mixed: enclosed-empty + enclosed-full + open-empty (got ${A_mixed.toFixed(2)})`);
}

// =====================================================================
// Block 7 — null / missing-catalogue / null-material guards.
// =====================================================================
{
  ok(sumRackAbsorption([], {}, alphaAt, 1000) === 0, 'empty racks array → 0');
  ok(sumRackAbsorption(null, {}, alphaAt, 1000) === 0, 'null racks → 0');
  ok(sumRackAbsorption([{ rackModelKey: 'enclosed-42u' }], null, alphaAt, 1000) === 0,
    'null catalogue → 0');
  ok(sumRackAbsorption([{ rackModelKey: 'enclosed-42u', slots: [] }],
        { racks: { 'enclosed-42u': ENCLOSED_42U } }, null, 1000) === 0,
    'null materialAlphaAt → 0');
  ok(sumRackAbsorption([{ rackModelKey: 'does-not-exist', slots: [] }],
        { racks: { 'enclosed-42u': ENCLOSED_42U } }, alphaAt, 1000) === 0,
    'unknown rackModelKey → 0');
}

// =====================================================================
// Block 8 — order-of-magnitude check against Dr. Chen's sanity case:
// 1 enclosed 42U rack in a ~100 m³ room with Σ(αS) ≈ 25 m² → ΔT60 ≈ 0.01 s.
// =====================================================================
{
  const empty = { rackModelKey: 'enclosed-42u', slots: [] };
  const full  = { rackModelKey: 'enclosed-42u',
    slots: Array.from({length: 42}, () => ({ uHeight: 1 })) };
  const A_empty = rackAbsorptionAt(empty, ENCLOSED_42U, alphaAt, 1000);
  const A_full  = rackAbsorptionAt(full,  ENCLOSED_42U, alphaAt, 1000);
  const V = 100, baseA = 25;
  const T_no   = 0.161 * V / baseA;
  const T_e    = 0.161 * V / (baseA + A_empty);
  const T_f    = 0.161 * V / (baseA + A_full);
  const dT_ef  = T_e - T_f;   // empty rack has LOWER T60 than loaded (more absorption)
  ok(Math.abs(dT_ef) > 0,
    `ΔT60(empty − loaded) ≠ 0 (got ${dT_ef.toFixed(4)} s — empty rack absorbs more so T60 drops)`);
  ok(Math.abs(T_no - T_e) < 0.1,
    `1 rack ΔT60 from no-rack baseline < 0.1 s (Dr. Chen's order-of-magnitude check; got ${(T_no - T_e).toFixed(4)})`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll rack-acoustic-contribution tests passed.');
