// Wall re-radiation tests. Verifies:
//   * Sound power formula (Kuttruff §5.4 / ISO 12354)
//   * Conservation clamp activates when TL is low + absorption is high
//   * Near-field / far-field / smoothstep blend regimes correct
//   * Flag OFF returns zero contribution (Tier 1 back-compat)
//   * Sanity: surau-style listener behind a qibla wall reads in [30, 70] dB
//
// NOTE: this test deliberately toggles localStorage.PHYSICS_P1_5 BEFORE
// import — Node's localStorage shim must be set first so the module-level
// read in feature-flags.js sees the flag at load time.

import { readFileSync } from 'node:fs';

// Polyfill localStorage in Node and set the flag BEFORE importing the
// physics modules so PHYSICS_P1_5_ENABLED reads truthy at load.
const _store = { PHYSICS_P1_5: '1' };
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
};

const {
  computeReradiationContributions,
  computeReverberantInsideSPL,
  wallReradiationContribution,
  _testing,
} = await import('../js/physics/reradiation.js');
const { PHYSICS_P1_5_ENABLED } = await import('../js/physics/feature-flags.js');

// Load real materials catalogue for TL + absorption values.
const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

let failed = 0;
function pass(label) { console.log(`PASS  ${label}`); }
function fail(label, extra = '') { console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); failed++; }
function assertTrue(cond, label, extra = '') { cond ? pass(label) : fail(label, extra); }
function assertEq(a, b, label) { (a === b) ? pass(label) : fail(label, `actual=${a} expected=${b}`); }
function assertClose(a, b, tol, label) {
  if (Math.abs(a - b) < tol) pass(label);
  else fail(label, `actual=${a.toFixed(3)} expected=${b.toFixed(3)} tol=${tol}`);
}
function assertBetween(v, lo, hi, label) {
  (v >= lo && v <= hi) ? pass(label) : fail(label, `actual=${v.toFixed(2)} expected ${lo}..${hi}`);
}

// ---- Sanity: flag is on (so the contribution functions actually fire) ----
assertEq(PHYSICS_P1_5_ENABLED, true, 'PHYSICS_P1_5 flag is ON for this test');

// ---- Helpers: wall area + closest point ----
{
  const wall = {
    v1: { x: 0, y: 12 }, v2: { x: 5, y: 12 },
    elev_m: 0, height_m: 3,
  };
  assertClose(_testing.wallArea(wall), 15, 1e-9, 'wallArea(5×3) = 15 m²');

  // Listener directly perpendicular to wall midpoint.
  const cp1 = _testing.closestPointOnFiniteWall({ x: 2.5, y: 13, z: 1.5 }, wall);
  assertClose(cp1.x, 2.5, 1e-6, 'closestPoint x = listener x (perpendicular)');
  assertClose(cp1.y, 12, 1e-6, 'closestPoint y = wall y');
  assertClose(cp1.z, 1.5, 1e-6, 'closestPoint z = listener z (within wall height)');

  // Listener past the right end of the wall — must clamp along-wall to wallLen.
  const cp2 = _testing.closestPointOnFiniteWall({ x: 10, y: 13, z: 1.5 }, wall);
  assertClose(cp2.x, 5, 1e-6, 'closestPoint x clamped to wall end (x=5)');

  // Listener above the ceiling — clamp z to elev+height.
  const cp3 = _testing.closestPointOnFiniteWall({ x: 2.5, y: 13, z: 5 }, wall);
  assertClose(cp3.z, 3, 1e-6, 'closestPoint z clamped to wall top (z=3)');
}

// ---- smoothstep is well-behaved at the endpoints + monotone -----
{
  assertEq(_testing.smoothstep(0, 1, -0.5), 0, 'smoothstep below edge0 = 0');
  assertEq(_testing.smoothstep(0, 1, 0), 0, 'smoothstep at edge0 = 0');
  assertClose(_testing.smoothstep(0, 1, 0.5), 0.5, 1e-9, 'smoothstep at midpoint = 0.5');
  assertEq(_testing.smoothstep(0, 1, 1), 1, 'smoothstep at edge1 = 1');
  assertEq(_testing.smoothstep(0, 1, 1.5), 1, 'smoothstep above edge1 = 1');
}

// ---- Conservation clamp activates when TL is low + α is high -----
// Synthetic: 10×4 = 40 m² wall, TL = 10 dB at 1 kHz (very leaky),
// absorption α = 0.95 at 1 kHz (carpet-covered). Reverb inside = 100 dB.
// Without clamp: L_w_rerad_raw = 100 - 6 - 10 + 10·log10(40) = 100 - 6 - 10 + 16.02 = 100.02 dB
// Conservation cap: L_w_rerad_cap = 100 - 6 + 10·log10(40·0.05) = 100 - 6 + 10·log10(2) = 97.01 dB
// Cap < raw → must clamp.
{
  const wall = {
    v1: { x: 0, y: 0 }, v2: { x: 10, y: 0 },
    elev_m: 0, height_m: 4,
  };
  const res = wallReradiationContribution({
    wall,
    listener: { x: 5, y: 2, z: 1.5 },
    L_p_rev_inside_db: 100,
    TL_band_db: 10,
    alpha_band: 0.95,
    freq_hz: 1000,
    airAbsorption: false,
  });
  assertTrue(res.clampedByConservation, '(conservation) clamp activates when TL low + α high');
}

// ---- Conservation does NOT activate for a realistic wall (high TL, low α) ----
// 150 mm concrete, TL = 53 dB at 1 kHz, α = 0.02. Raw and cap should
// differ enough that cap is well above raw → no clamp.
{
  const wall = {
    v1: { x: 0, y: 0 }, v2: { x: 5, y: 0 },
    elev_m: 0, height_m: 3,
  };
  const res = wallReradiationContribution({
    wall,
    listener: { x: 2.5, y: 1, z: 1.5 },
    L_p_rev_inside_db: 80,
    TL_band_db: 53,
    alpha_band: 0.02,
    freq_hz: 1000,
    airAbsorption: false,
  });
  assertTrue(!res.clampedByConservation, '(conservation) no clamp on high-TL low-α wall');
}

// ---- Near-field flat, far-field falls off, blend zone smooth -----
// 5×3 = 15 m² wall, r_t = sqrt(15/π) = 2.18 m.
// Near (r ≤ r_t/2 = 1.09): flat at L_w - 10·log10(15) - 3 = L_w - 14.76
// Far  (r ≥ 2·r_t = 4.37): drops at 20·log10(r) per doubling
{
  const wall = {
    v1: { x: 0, y: 0 }, v2: { x: 5, y: 0 },
    elev_m: 0, height_m: 3,
  };
  const baseArgs = {
    wall, L_p_rev_inside_db: 80, TL_band_db: 30, alpha_band: 0.1,
    freq_hz: 1000, airAbsorption: false,
  };
  // Near: listener at perpendicular distance 0.5 m (well below r_t/2 = 1.09)
  const near = wallReradiationContribution({ ...baseArgs, listener: { x: 2.5, y: 0.5, z: 1.5 } });
  assertEq(near.regime, 'near', 'r=0.5 → near regime');

  // Far: listener at perpendicular distance 10 m (well above 2·r_t = 4.37)
  const far = wallReradiationContribution({ ...baseArgs, listener: { x: 2.5, y: 10, z: 1.5 } });
  assertEq(far.regime, 'far', 'r=10 → far regime');

  // Blend: listener at r = 2 m (inside blend zone [1.09, 4.37])
  const blend = wallReradiationContribution({ ...baseArgs, listener: { x: 2.5, y: 2, z: 1.5 } });
  assertEq(blend.regime, 'blend', 'r=2 → blend regime');

  // Near should be louder than far (closer + flat plateau).
  assertTrue(near.spl_db > far.spl_db,
    'Near-field SPL > far-field SPL (planar source dominates close-in)',
    `near=${near.spl_db.toFixed(2)} far=${far.spl_db.toFixed(2)}`);

  // Difference between near (~0.5 m) and very far (~50 m) is dominated by 1/r²
  // in the far regime. Less than the free-space 20·log10(50/0.5) = 40 dB because
  // the near-field is flat (no drop) below r_t/2.
  const veryFar = wallReradiationContribution({ ...baseArgs, listener: { x: 2.5, y: 50, z: 1.5 } });
  const delta = near.spl_db - veryFar.spl_db;
  assertBetween(delta, 20, 40,
    'Δ(near, very-far) ∈ [20, 40] dB (flat near + 1/r² far, not pure 1/r²)');
}

// ---- Surau sanity: listener behind qibla wall reads sanely ------------
// Mimic the surau geometry: 18 × 4.5 × 12 m room with painted concrete
// walls. Reverberant SPL inside ≈ 80 dB (typical PA in a small hall).
// Listener at (9, 12.3, 1.5) — just outside the south wall, ear height.
// Expected: meaningful but moderate SPL contribution.
{
  const wall = {
    v1: { x: 0, y: 12 }, v2: { x: 18, y: 12 },
    elev_m: 0, height_m: 4.5,
  };
  const concrete = materials.byId['concrete-painted'];
  const bandIdx_1k = materials.frequency_bands_hz.indexOf(1000);
  const TL_1k = concrete.transmission_loss_db[bandIdx_1k];   // 53 dB
  const alpha_1k = concrete.absorption[bandIdx_1k];          // 0.02
  const res = wallReradiationContribution({
    wall,
    listener: { x: 9, y: 12.3, z: 1.5 },
    L_p_rev_inside_db: 80,
    TL_band_db: TL_1k,
    alpha_band: alpha_1k,
    freq_hz: 1000,
    airAbsorption: true,
  });
  // Expected: ~80 - 6 - 53 + 10·log10(81) - 10·log10(81) - 3 + small air = ~15 dB
  // Note the closest-point z=1.5 is inside wall vertical extent [0, 4.5] so
  // the perpendicular distance is just |12.3 - 12| = 0.3 m → very near-field.
  assertBetween(res.spl_db, 10, 30,
    'Surau qibla-wall rerad at 1 kHz ≈ 10-30 dB (concrete is heavy, kills outside)');
}

// ---- computeReverberantInsideSPL: aggregate per-band scalar ----------
{
  // Synthetic: 2 sources, each L_w = 100 dB at 1 kHz, R = 50 m².
  // L_rev = 100 + 10·log10(4/50) = 100 - 10.97 = 89.03 dB per source.
  // 2 incoherent sources → +3 dB → 92.04 dB total reverberant.
  const sourceLwPerBand = [
    { src: { id: 'a' }, Lw_per_band: new Float64Array([100, 100, 100, 100, 100, 100, 100]) },
    { src: { id: 'b' }, Lw_per_band: new Float64Array([100, 100, 100, 100, 100, 100, 100]) },
  ];
  const roomR = [50, 50, 50, 50, 50, 50, 50];
  const Lp = computeReverberantInsideSPL({
    sourceLwPerBand, roomR_per_band: roomR, isSourceInside: () => true,
  });
  assertClose(Lp[3], 92.04, 0.1, 'computeReverberantInsideSPL: 2× L_w=100, R=50 → 92.0 dB at 1 kHz');
}

// ---- Outside sources excluded from the reverberant aggregate --------
{
  const sourceLwPerBand = [
    { src: { id: 'inside',  isOutside: false }, Lw_per_band: new Float64Array(7).fill(100) },
    { src: { id: 'outside', isOutside: true  }, Lw_per_band: new Float64Array(7).fill(100) },
  ];
  const Lp = computeReverberantInsideSPL({
    sourceLwPerBand,
    roomR_per_band: new Array(7).fill(50),
    isSourceInside: (s) => !s.isOutside,
  });
  // Only the inside source contributes → 89.03 dB, not 92.04.
  assertClose(Lp[3], 89.03, 0.1, 'Outside sources excluded from reverberant aggregate');
}

// ---- computeReradiationContributions: end-to-end with realistic inputs ---
{
  const room = {
    shape: 'rectangular',
    width_m: 18, height_m: 4.5, depth_m: 12,
    surfaces: {
      floor: 'concrete-painted', ceiling: 'concrete-painted',
      wall_north: 'concrete-painted', wall_south: 'concrete-painted',
      wall_east: 'concrete-painted', wall_west: 'concrete-painted',
    },
  };
  // Pretend the wallsCrossedByPath result for src→listener crosses one
  // solid concrete wall (wall_south at y=12). Build the shape inline.
  const wallsCrossed = [{
    wallId: 'parent_wall_south',
    materialId: 'concrete-painted',
    throughOpening: false,
    hitPoint: { x: 9, y: 12, z: 3.0 },
  }];
  const res = computeReradiationContributions({
    src: { position: { x: 9, y: 6, z: 4.3 } },
    listener: { x: 9, y: 12.3, z: 1.5 },
    room, wallsCrossed, materials,
    freq_hz: 1000,
    L_p_rev_inside_band_db: 80,
    airAbsorption: true,
  });
  assertTrue(res.perWall.length === 1, 'rerad: one wall in perWall breakdown');
  assertTrue(res.totalPower > 0, 'rerad: totalPower > 0');
  assertBetween(10 * Math.log10(res.totalPower), 5, 30,
    'rerad: total contribution at qibla wall ≈ 5-30 dB (concrete kills outside)');
}

// ---- Flag-OFF parity ------------------------------------------------
// Re-import the module under a fresh flag setting to verify OFF behaviour.
{
  delete _store.PHYSICS_P1_5;
  // Force a fresh module load by using a cache-busting query — Node's
  // import cache keys on the URL, so changing the query is enough.
  const flagsModule = await import('../js/physics/feature-flags.js?flagoff=1');
  const reradModule = await import('../js/physics/reradiation.js?flagoff=1');
  assertEq(flagsModule.PHYSICS_P1_5_ENABLED, false, 'PHYSICS_P1_5 OFF after removeItem + fresh import');
  const res = reradModule.computeReradiationContributions({
    src: { position: { x: 9, y: 6, z: 4.3 } },
    listener: { x: 9, y: 12.3, z: 1.5 },
    room: {}, wallsCrossed: [{ wallId: 'parent_wall_south', materialId: 'concrete-painted', throughOpening: false }],
    materials, freq_hz: 1000, L_p_rev_inside_band_db: 80,
  });
  assertEq(res.totalPower, 0, '(flag OFF) rerad totalPower = 0');
  assertEq(res.perWall.length, 0, '(flag OFF) rerad perWall = []');
  // Restore flag for any downstream tests.
  _store.PHYSICS_P1_5 = '1';
}

if (failed > 0) { console.log(`\n${failed} reradiation test(s) FAILED`); process.exit(1); }
console.log('\nAll wall-reradiation tests passed.');
