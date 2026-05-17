// Pierce-Hadden wedge diffraction tests (Tier 1a commit (e), P9 fix).
// Verifies:
//   * wedgeIL formula values + grazing-zone correction scaling
//   * enumerateRoomCorners returns 4 rectangular corners with β = π/2
//   * cornerIsInShadowPath correctly gates lit-zone vs shadow-zone
//   * Lit-zone listeners get zero corner contribution (no indoor lift)

import {
  wedgeIL, maekawaIL, enumerateRoomCorners, cornerIsInShadowPath,
  computeCornerDiffractionContributions,
  MAEKAWA_IL_MAX_DB, MAEKAWA_IL_GRAZE_DB,
} from '../js/physics/diffraction.js';

let failed = 0;
const pass = l => console.log(`PASS  ${l}`);
const fail = (l, e = '') => { console.log(`FAIL  ${l}${e ? '  ' + e : ''}`); failed++; };
const assertEq = (a, b, l) => (a === b) ? pass(l) : fail(l, `actual=${a} expected=${b}`);
const assertClose = (a, b, tol, l) => {
  if (Math.abs(a - b) < tol) pass(l);
  else fail(l, `actual=${a.toFixed(3)} expected=${b.toFixed(3)} tol=${tol}`);
};
const assertTrue = (c, l, e = '') => c ? pass(l) : fail(l, e);

// ---- Golden 1: wedgeIL formula values ----
{
  const lambda = 1;
  const beta_90  = Math.PI / 2;        // 90° outdoor corner → ΔIL = +1.249 dB
  const beta_270 = 3 * Math.PI / 2;    // 270° re-entrant   → ΔIL = +6.021 dB

  // δ=0 (graze boundary): base = 5 dB, scale = 1, full wedge correction
  assertClose(wedgeIL(0, lambda, beta_90),  5 + 1.249, 0.01, 'Wedge IL at graze + 90° = 6.25 dB');
  assertClose(wedgeIL(0, lambda, beta_270), 5 + 6.021, 0.01, 'Wedge IL at graze + 270° = 11.02 dB');

  // δ=0.5 (N=1, base IL ≈ 13.10): base + 1.25 = 14.35
  assertClose(wedgeIL(0.5, lambda, beta_90), 13.10 + 1.249, 0.05, 'Wedge IL at N=1 + 90° ≈ 14.35 dB');

  // Lit zone (δ = −λ/4): base = 0, short-circuit to 0 regardless of β.
  assertEq(wedgeIL(-0.25, lambda, beta_90), 0, 'Wedge IL in lit zone = 0 dB');

  // Smooth handoff (δ = −λ/16, base = 2.5): scale = 0.5 → correction = 0.625
  assertClose(wedgeIL(-1/16, lambda, beta_90), 2.5 + 1.249 * 0.5, 0.01,
    'Wedge IL mid-handoff scales correction proportionally (no step at shadow boundary)');

  // Clamp: huge δ pushes base to 24 (already clamped); adding ΔIL must NOT exceed 24.
  assertEq(wedgeIL(50, lambda, beta_90), MAEKAWA_IL_MAX_DB, 'Wedge IL above ceiling clamps to 24 dB');

  // Defensive: β → 2π (closed-solid degenerate) — defensive clamp keeps formula finite.
  const closedResult = wedgeIL(0.5, lambda, 2 * Math.PI - 0.005);
  assertTrue(Number.isFinite(closedResult), '(defensive) β → 2π produces finite IL (no NaN/Infinity)');

  // Degenerate inputs: NaN / 0 / negative wavelength → 0.
  assertEq(wedgeIL(NaN, 1, beta_90), 0, 'NaN delta → 0');
  assertEq(wedgeIL(0.5, NaN, beta_90), 0, 'NaN lambda → 0');
  assertEq(wedgeIL(0.5, 1, NaN), maekawaIL(0.5, 1), 'NaN beta → base Maekawa (no correction)');
}

// ---- Golden 2: enumerateRoomCorners on a rectangular room ----
{
  const room = { shape: 'rectangular', width_m: 9, depth_m: 12, height_m: 4.5 };
  const corners = enumerateRoomCorners(room);
  assertEq(corners.length, 4, 'Rect room returns 4 corners');
  const ids = corners.map(c => c.id).sort();
  assertTrue(ids.includes('corner_NW') && ids.includes('corner_NE')
          && ids.includes('corner_SE') && ids.includes('corner_SW'),
    'All four canonical corner ids present');
  const NE = corners.find(c => c.id === 'corner_NE');
  assertClose(NE.x, 9, 0.001, 'NE corner x = W');
  assertClose(NE.y, 0, 0.001, 'NE corner y = 0');
  assertClose(NE.edge_top.z, 4.5, 0.001, 'NE corner top edge at z = H');
  assertClose(NE.edge_bottom.z, 0, 0.001, 'NE corner bottom edge at z = 0');
  assertClose(NE.beta_solid, Math.PI / 2, 0.001, 'Rect corner β_solid = π/2');
  assertTrue(NE.faces.includes('parent_wall_north') && NE.faces.includes('parent_wall_east'),
    'NE corner shares north + east faces');

  // Polygon room → empty (P14 deferred)
  const polyRoom = { shape: 'custom', custom_vertices: [
    { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 },
  ], width_m: 5, height_m: 3, depth_m: 5 };
  assertEq(enumerateRoomCorners(polyRoom).length, 0,
    'Polygon room returns empty corner list (P14 deferred)');

  // Degenerate room (W=0) → empty
  assertEq(enumerateRoomCorners({ shape: 'rectangular', width_m: 0, depth_m: 5, height_m: 3 }).length, 0,
    'Degenerate room (W=0) returns empty corners');
}

// ---- Golden 3: cornerIsInShadowPath gating ----
{
  // Polyfill localStorage so PHYSICS_P1_5 read at module load doesn't crash
  // — gating tests don't depend on the flag, only the corner enumerator.
  const room = { shape: 'rectangular', width_m: 9, depth_m: 12, height_m: 4.5 };
  const corners = enumerateRoomCorners(room);

  // S inside the hall, near center.
  const S = { x: 4.5, y: 6, z: 1.7 };

  // R inside the hall, near the east wall: no corner shadows.
  const R_inside = { x: 8, y: 5, z: 1.7 };
  const shadowsInside = corners.filter(c => cornerIsInShadowPath(c, S, R_inside, room));
  assertEq(shadowsInside.length, 0, 'Listener inside room: no corner shadows fire');

  // R just past the NE corner (outside east wall AND outside north wall).
  // S has to be on opposite side of AT LEAST one of {north, east} → corner_NE shadows.
  const R_NE = { x: 9.5, y: -0.5, z: 1.7 };
  const shadowsNE = corners.filter(c => cornerIsInShadowPath(c, S, R_NE, room));
  assertTrue(shadowsNE.some(c => c.id === 'corner_NE'),
    'Listener past NE corner: corner_NE shadows');

  // R deep behind the north wall (y far negative). Both NE and NW are
  // candidates (opposite side of north wall from S).
  const R_deep = { x: 4.5, y: -5, z: 1.7 };
  const shadowsDeep = corners.filter(c => cornerIsInShadowPath(c, S, R_deep, room));
  assertTrue(shadowsDeep.length >= 2,
    'Deep-shadow listener behind north wall: ≥2 north-side corners candidate');
}

// ---- Integration: computeCornerDiffractionContributions ----
// With the flag off (default in this test process), the function must
// return zero contribution regardless of geometry — flag-off parity.
{
  const room = { shape: 'rectangular', width_m: 9, depth_m: 12, height_m: 4.5 };
  const result = computeCornerDiffractionContributions({
    src: { position: { x: 4.5, y: 6, z: 1.7 } },
    listener: { x: 9.5, y: -0.5, z: 1.7 },
    room, materials: { frequency_bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000] },
    freq_hz: 1000, sourceLpFreeField_db: 80,
  });
  assertEq(result.totalPower, 0, '(flag OFF) corner contribution totalPower = 0');
  assertEq(result.paths.length, 0, '(flag OFF) corner paths empty');
}

if (failed > 0) { console.log(`\n${failed} wedge test(s) FAILED`); process.exit(1); }
console.log('\nAll wedge diffraction tests passed.');
