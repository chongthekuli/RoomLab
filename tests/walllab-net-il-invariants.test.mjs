// WallLAB Net IL invariants (v=611, 2026-05-23).
//
// Sam's pre-merge fixtures — the bugs the existing text-grep PSC test
// (walllab-psc-overwall.test.mjs) cannot catch. Five invariants:
//   (A) G inversion guard — hard < soft for Net IL in shadowed geometry.
//   (B) Symmetric +3 dB lift — sH==rH equal-detour deep-shadow case.
//   (C) Net IL non-negative — pow(10, -loss/10) sign convention.
//   (D) Maekawa 24 dB cap actually engaged at large N.
//   (E) Air-abs dB/m → Np/m conversion factor (the / 4.343 direction).
//
// These pin the directional invariants; tests/wall-physics-golden.test.mjs
// pins the absolute numerical values. Both together close the gap between
// "the formula is right on paper" and "the implementation produces the
// right number under refactor."

import assert from 'node:assert';
import { maekawaIL, overBarrierPathDifference, MAEKAWA_IL_MAX_DB } from '../js/physics/diffraction.js';
import { airAbsorptionDbPerM, airAbsorptionCoefficient_m } from '../js/physics/air-absorption.js';

const C = 343;

// Local replica of wall-sim.js renderDiffraction Net IL math (v=612,
// post-Martina MEDIUM #2). Identical to the helper in
// tests/wall-physics-golden.test.mjs. Direct path air-abs is EXTRA over
// the direct sightline; ground path uses full detour.
function netIL(sH, wH, d1, d2, rH, G, freq) {
  const dir = overBarrierPathDifference({ sourceH: sH, barrierH: wH, sourceToBarrier: d1, barrierToReceiver: d2, receiverH: rH });
  const grd = overBarrierPathDifference({ sourceH: -sH, barrierH: wH, sourceToBarrier: d1, barrierToReceiver: d2, receiverH: rH });
  const det_dir = Math.hypot(d1, wH - sH) + Math.hypot(d2, rH - wH);
  const det_grd = Math.hypot(d1, wH + sH) + Math.hypot(d2, rH - wH);
  const direct = Math.hypot(d1 + d2, rH - sH);
  const il_dir = maekawaIL(dir, C / freq);
  const il_grd = maekawaIL(grd, C / freq);
  const aa_dir = airAbsorptionDbPerM(freq) * (det_dir - direct);
  const aa_grd = airAbsorptionDbPerM(freq) * det_grd;
  const loss_dir = il_dir + aa_dir;
  const loss_grd = il_grd + aa_grd;
  const p = Math.pow(10, -loss_dir / 10) + (1 - G) * Math.pow(10, -loss_grd / 10);
  return -10 * Math.log10(p);
}

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// (A) Ground-G inversion guard. Hard ground (G=0) adds a second arrival
//     via the image-source path → MORE energy at receiver → LOWER Net IL.
//     If the (1−G) factor is flipped to G anywhere in the energy sum,
//     hard and soft swap and this inequality reverses.
{
  const hard = netIL(1.5, 4, 3, 5, 1.5, /*G=*/0, 1000);
  const soft = netIL(1.5, 4, 3, 5, 1.5, /*G=*/1, 1000);
  check('(A) hard ground produces LOWER Net IL than soft (shadowed, 1 kHz)',
    hard < soft - 0.5, `hard=${hard.toFixed(2)} soft=${soft.toFixed(2)}`);
}

// (B) Ground-reflection lift in the +2 to +3 dB range. The asymptotic
//     +3.01 dB lift requires loss_dir == loss_grd, which only happens
//     when both diffracted paths reach the Maekawa 24 dB cap (the
//     detour-difference air-abs term then becomes the only delta). At
//     bands / geometries where one path is below the cap, the path with
//     the shorter detour dominates and lift is reduced. The realistic
//     range across physically plausible WallLAB geometries is +2 to +3
//     dB (Dr. Chen confirmed 2.56 dB in golden #20 at the same kind of
//     geometry). Driving the test with a deep-shadow geometry at 2 kHz
//     where both Maekawa values saturate ⇒ +3 dB exactly. Catches a
//     sign error in pow(10, -loss/10) or a swap of `loss_dir`/`loss_grd`.
{
  const hard = netIL(1.5, 5, 4, 4, 1.5, /*G=*/0, 2000);
  const soft = netIL(1.5, 5, 4, 4, 1.5, /*G=*/1, 2000);
  const lift = soft - hard;
  check('(B) deep-shadow lift soft − hard ≈ +3 dB (both paths Maekawa-capped)',
    lift > 2.5 && lift < 3.2, `lift = ${lift.toFixed(3)} dB`);
}

// (C) Net IL non-negative in shadowed geometry. The pow(10, -loss/10) sign
//     convention: positive loss → p < 1 → Net IL > 0. If the exponent
//     sign flips on the conversion, p > 1 and Net IL goes NEGATIVE.
{
  const il = netIL(1.5, 6, 3, 8, 1.5, /*G=*/0, 2000);
  check('(C) shadowed-geometry Net IL is positive (sign convention guard)',
    il > 0, `got ${il.toFixed(3)} dB`);
}

// (D) Maekawa 24 dB ceiling actually engaged. Drive δ enormous; IL must
//     asymptote at MAEKAWA_IL_MAX_DB. Guards an accidental removal of the
//     Math.min(MAEKAWA_IL_MAX_DB, ...) cap.
{
  const il = maekawaIL(50, C / 4000);
  check('(D) Maekawa IL clamps at the 24 dB ceiling for huge N',
    il <= MAEKAWA_IL_MAX_DB + 1e-9 && il > MAEKAWA_IL_MAX_DB - 0.1,
    `got ${il.toFixed(3)} (cap = ${MAEKAWA_IL_MAX_DB})`);
}

// (E) Np/m vs dB/m conversion direction. Energy attenuation in Nepers/m
//     is dB/m ÷ (10·log10 e) ≈ dB/m / 4.3429, NOT × 4.3429. If anyone
//     swaps the direction the Sabine 4mV term silently changes by ×18.86.
{
  const dbm = airAbsorptionDbPerM(1000);
  const npm = airAbsorptionCoefficient_m(1000);
  const ratio = dbm / npm;
  check('(E) air-abs dB/m ÷ Np/m = 10·log10(e) ≈ 4.343 (conversion direction)',
    Math.abs(ratio - 4.3429) < 0.001, `ratio = ${ratio.toFixed(4)}`);
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
