// Golden Maekawa-Tachibana IL test. Pure physics — no room geometry.
// Verifies the formula + clamps + smooth-handoff zone match Dr. Chen's
// Tier 1a spec. If any IL value here drifts, the heatmap behind every
// wall will look different — every regression downstream traces back
// to this primitive.
//
// Owned by Sam (QA) + Theo (regression-curator). Dr. Chen ratifies any
// drift in expected values.

import {
  maekawaIL, diffractionPointOnEdge,
  MAEKAWA_IL_MAX_DB, MAEKAWA_IL_GRAZE_DB,
} from '../js/physics/diffraction.js';

let failed = 0;
function pass(label) { console.log(`PASS  ${label}`); }
function fail(label, extra = '') {
  console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`);
  failed++;
}
function assertClose(actual, expected, tol, label) {
  if (Math.abs(actual - expected) < tol) pass(label);
  else fail(label, `actual=${actual.toFixed(3)} expected=${expected.toFixed(3)} tol=${tol}`);
}
function assertEq(actual, expected, label) {
  if (actual === expected) pass(label);
  else fail(label, `actual=${actual} expected=${expected}`);
}
function assertTrue(cond, label, extra = '') {
  cond ? pass(label) : fail(label, extra);
}

// ---- Maekawa formula at known Fresnel numbers ------------------------
// Reference: Maekawa 1968 fig 4 (the canonical "design curve").
// Hand-evaluated values from the closed-form formula
//   IL = 5 + 20·log10(sqrt(2π·N) / tanh(sqrt(2π·N)))
//
// Use lambda = 1 m so N = 2·delta.

{
  const lambda = 1;

  // N = 0 → IL = 5 dB exactly (formula's grazing limit; tanh(0)/0 → 1).
  // Implementation note: maekawaIL(δ=0, λ) falls into the "delta <= 0"
  // branch and returns the linear-handoff endpoint = 5 dB.
  assertClose(maekawaIL(0, lambda), 5, 0.01, 'IL @ N=0 (delta=0) = 5 dB (graze boundary)');

  // N = 0.1 → x = sqrt(0.628) = 0.793, tanh(0.793) = 0.660 → IL = 5 + 20·log10(1.201) = 6.59
  assertClose(maekawaIL(0.05, lambda), 6.59, 0.05, 'IL @ N=0.1 ≈ 6.59 dB');

  // N = 1 → x = sqrt(6.283) = 2.507, tanh(2.507) = 0.987 → IL = 5 + 20·log10(2.540) = 13.10
  assertClose(maekawaIL(0.5, lambda), 13.10, 0.05, 'IL @ N=1 ≈ 13.1 dB');

  // N = 10 → x = sqrt(62.83) = 7.927, tanh(7.927) ≈ 1.000 → IL = 5 + 20·log10(7.929) = 22.99
  assertClose(maekawaIL(5, lambda), 22.99, 0.05, 'IL @ N=10 ≈ 23.0 dB');

  // N = 100 → x = 25.07, tanh→1, IL = 5 + 20·log10(25.07) = 32.98 → CLAMPED to 24.
  assertEq(maekawaIL(50, lambda), MAEKAWA_IL_MAX_DB, 'IL @ N=100 clamped to 24 dB');

  // Very large N → still clamped to 24.
  assertEq(maekawaIL(1000, lambda), MAEKAWA_IL_MAX_DB, 'IL @ N=2000 clamped to 24 dB');
}

// ---- Smooth grazing handoff: δ ∈ (−λ/8, 0] linearly 0 → 5 dB ---------
{
  const lambda = 0.343;   // 1 kHz at 20 °C
  const window = lambda / 8;   // ~0.043 m

  // δ exactly at the deep edge of the handoff window → IL ≈ 0
  assertClose(maekawaIL(-window, lambda), 0, 0.01, 'IL at δ=−λ/8 (window deep edge) ≈ 0 dB');

  // δ slightly past the deep edge into the lit zone → IL = 0
  assertEq(maekawaIL(-window * 2, lambda), 0, 'IL deeper than −λ/8 = 0 dB (lit zone)');

  // δ at the boundary into shadow → IL ≈ 5 dB (handoff endpoint)
  assertClose(maekawaIL(0, lambda), 5, 0.01, 'IL at δ=0 = 5 dB (shadow boundary)');

  // δ at midpoint of handoff → IL ≈ 2.5 dB
  assertClose(maekawaIL(-window / 2, lambda), 2.5, 0.01, 'IL at δ=−λ/16 = 2.5 dB (mid handoff)');
}

// ---- Frequency dependence: same δ, different bands ------------------
// Per Dr. Chen's sanity-check (spec section A6): for the surau listener
// at (9, 12.30, 1.70) with the top-edge detour producing δ ≈ 0.79 m,
// the per-band IL should vary from ~11 dB at 125 Hz to clamped 24 dB
// at 4 kHz+.
{
  const delta = 0.788;
  const c = 343.2;
  // 125 Hz → λ=2.746 → N=0.574 → x=1.899 → tanh(1.899)=0.956 → IL = 5 + 20·log10(1.988) = 10.97
  assertClose(maekawaIL(delta, c / 125), 10.97, 0.10, 'Surau IL @ 125 Hz ≈ 11 dB (re-radiation dominates LF)');
  // 1 kHz → λ=0.3432 → N=4.59 → x=5.37 → tanh≈1 → IL = 5 + 20·log10(5.37) = 19.60
  assertClose(maekawaIL(delta, c / 1000), 19.60, 0.10, 'Surau IL @ 1 kHz ≈ 19.6 dB');
  // 4 kHz → λ=0.0858 → N=18.4 → x=10.75 → IL = 5 + 20·log10(10.75) = 25.6 → clamp to 24
  assertEq(maekawaIL(delta, c / 4000), MAEKAWA_IL_MAX_DB, 'Surau IL @ 4 kHz clamped to 24 dB');
  // 8 kHz → λ=0.0429 → N=36.7 → x=15.2 → IL > 24 → clamp
  assertEq(maekawaIL(delta, c / 8000), MAEKAWA_IL_MAX_DB, 'Surau IL @ 8 kHz clamped to 24 dB');
}

// ---- diffractionPointOnEdge: Fermat optimum on a finite edge -------
// Symmetric case: S and R equidistant from a horizontal edge through
// the origin. Optimum should land at the edge midpoint perpendicular
// to the SR line.
{
  // Edge along X axis at y=0, z=0, from x=0 to x=10.
  const E1 = { x: 0, y: 0, z: 0 };
  const E2 = { x: 10, y: 0, z: 0 };
  // Source above-and-behind the edge at (5, -2, 1); listener below-and-
  // ahead at (5, 2, -1). Direct line passes through (5, 0, 0).
  const S = { x: 5, y: -2, z: 1 };
  const R = { x: 5, y: 2, z: -1 };
  const opt = diffractionPointOnEdge(S, R, E1, E2);
  assertTrue(opt !== null, 'diffractionPointOnEdge returns non-null for finite edge');
  assertClose(opt.E.x, 5, 0.01, 'Optimum x lands at edge midpoint for symmetric S/R');
  assertClose(opt.E.y, 0, 0.01, 'Optimum y stays on the edge line');
  assertClose(opt.E.z, 0, 0.01, 'Optimum z stays on the edge line');
  // Detour vs direct: S→R direct is sqrt(0 + 16 + 4) = 4.47.
  // S→E→R = sqrt(0+4+1) + sqrt(0+4+1) = 2.236 + 2.236 = 4.47.
  // δ should be 0 because the direct path actually passes through the
  // edge point — this is the symmetric grazing case.
  assertClose(opt.delta, 0, 0.01, 'Symmetric grazing case: δ = 0');
}

// ---- Clamping the optimum to the finite segment --------------------
// Source and receiver positioned so the unconstrained optimum lies
// past the edge endpoint — must clamp to [0, edgeLength].
{
  const E1 = { x: 0, y: 0, z: 0 };
  const E2 = { x: 10, y: 0, z: 0 };
  // Source at (15, -2, 0), receiver at (15, 2, 0) — both well past
  // the right end of the edge. Unconstrained optimum would be at x=15,
  // but clamped to x=10.
  const S = { x: 15, y: -2, z: 0 };
  const R = { x: 15, y: 2, z: 0 };
  const opt = diffractionPointOnEdge(S, R, E1, E2);
  assertClose(opt.E.x, 10, 0.01, 'Clamped to edge right endpoint (x=10) when optimum past edge');
}

// ---- Degenerate inputs ----------------------------------------------
{
  // Zero-length edge → returns null.
  const opt = diffractionPointOnEdge({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 }, { x: 1, y: 1, z: 0 });
  assertEq(opt, null, 'Zero-length edge returns null');
}
{
  // NaN delta or lambda → IL = 0 (defensive — don't propagate NaN to heatmap).
  assertEq(maekawaIL(NaN, 1), 0, 'IL with NaN delta = 0');
  assertEq(maekawaIL(0.5, NaN), 0, 'IL with NaN lambda = 0');
  assertEq(maekawaIL(0.5, 0), 0, 'IL with zero lambda = 0');
  assertEq(maekawaIL(0.5, -1), 0, 'IL with negative lambda = 0');
}

if (failed > 0) { console.log(`\n${failed} diffraction test(s) FAILED`); process.exit(1); }
console.log('\nAll Maekawa diffraction tests passed.');
