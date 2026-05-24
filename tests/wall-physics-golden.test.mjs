// WallLAB physics golden fixtures (v=611, 2026-05-23).
//
// Dr. Chen second-pass audit delivered 18 NUMERICAL fixtures with hand-
// computed expected outputs and arithmetic shown in each comment. Each
// fixture is one of:
//   • a single-formula call (massLawTL, maekawaIL, overBarrierPathDifference,
//     airAbsorptionDbPerM × distance, massLawTLBandsAtThickness)
//   • a derived identity (mass-law +6 dB/doubling, Maekawa wavelength scaling)
//   • the v=610 Net IL energy-sum (Maekawa + air abs + hard/soft ground)
//   • the worked surau-default broadband end-to-end
//
// Sign-convention note (Dr. Chen explicitly called this out, I had it
// inverted in my v=610 handoff): Net IL is the POSITIVE dB of insertion
// loss vs the no-wall reference. Hard ground (G=0) adds a coherent ground-
// reflected path → MORE energy at the receiver → LOWER Net IL. Soft ground
// (G=1) removes that path → HIGHER Net IL. Therefore `soft Net IL ≥ hard
// Net IL` always. The symmetric S=R deep-shadow geometry produces the
// canonical "+3 dB lift" on hard ground; the surau-default lit-graze case
// has the differential collapse to ~0.04 dB.

import assert from 'node:assert';
import { massLawTL, massLawTLBandsAtThickness, TL_FLOOR_DB, TL_CEIL_DB, MASS_LAW_CONST_DB } from '../js/physics/wall-tl.js';
import { maekawaIL, overBarrierPathDifference, MAEKAWA_IL_MAX_DB } from '../js/physics/diffraction.js';
import { airAbsorptionDbPerM } from '../js/physics/air-absorption.js';

const C = 343;          // SPEED_OF_SOUND, demo constant in wall-sim.js

// Local replica of the v=612 renderDiffraction Net IL math (post-Martina
// MEDIUM #2 fix). Mirror exactly so the goldens track wall-sim.js's
// actual behaviour. If wall-sim.js ever exports this as a pure helper,
// drop the local copy and import it.
//   G ∈ [0, 1]: 0 = hard, 1 = soft (ISO 9613-2 §7.3.1 convention)
//   Direct path air-abs is EXTRA over the direct sightline (Martina
//   MEDIUM #2): α × (detour - direct). Ground-reflected path air-abs is
//   the full ground-bounce detour (no equivalent no-wall reference).
function netIL(sourceH, barrierH, sourceToBarrier, barrierToReceiver, receiverH, G, band_hz) {
  const dir = overBarrierPathDifference({ sourceH, barrierH, sourceToBarrier, barrierToReceiver, receiverH });
  const grd = overBarrierPathDifference({ sourceH: -sourceH, barrierH, sourceToBarrier, barrierToReceiver, receiverH });
  const det_dir = Math.hypot(sourceToBarrier, barrierH - sourceH) + Math.hypot(barrierToReceiver, receiverH - barrierH);
  const det_grd = Math.hypot(sourceToBarrier, barrierH + sourceH) + Math.hypot(barrierToReceiver, receiverH - barrierH);
  const direct_sightline = Math.hypot(sourceToBarrier + barrierToReceiver, receiverH - sourceH);
  const lambda = C / band_hz;
  const il_dir = maekawaIL(dir, lambda);
  const il_grd = maekawaIL(grd, lambda);
  const aa_dir = airAbsorptionDbPerM(band_hz) * (det_dir - direct_sightline);    // EXTRA over the top
  const aa_grd = airAbsorptionDbPerM(band_hz) * det_grd;
  const loss_dir = il_dir + aa_dir;
  const loss_grd = il_grd + aa_grd;
  const p = Math.pow(10, -loss_dir / 10) + (1 - G) * Math.pow(10, -loss_grd / 10);
  return p > 0 ? -10 * Math.log10(p) : 60;
}

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}
function within(actual, expected, tol) {
  return Math.abs(actual - expected) <= tol;
}

// =====================================================================
// 1–4. Mass law: floor clamp, mid-band, ceiling clamp, slope identity.
// =====================================================================

// (1) Mass law floor clamp: m=2 kg/m², 125 Hz.
//     20·log10(2·125) − 47 = 20·log10(250) − 47 = 47.96 − 47 = 0.96 → clamp to 5.
{
  const v = massLawTL(2, 125);
  check('mass law floor clamp: m=2, 125 Hz → 5 dB',
    within(v, TL_FLOOR_DB, 0.001), `got ${v.toFixed(3)}`);
}

// (2) Mass law mid-band: m=15 (6 mm glass), 500 Hz.
//     20·log10(15·500) − 47 = 20·log10(7500) − 47 = 77.501 − 47 = 30.501.
{
  const v = massLawTL(15, 500);
  check('mass law mid-band: 6 mm glass @ 500 Hz → 30.50 dB',
    within(v, 30.501, 0.01), `got ${v.toFixed(3)}`);
}

// (3) Mass law ceiling clamp: m=345 (150 mm concrete), 1 kHz.
//     20·log10(345·1000) − 47 = 110.756 − 47 = 63.76 → clamp to 60.
{
  const v = massLawTL(345, 1000);
  check('mass law ceiling clamp: 150 mm concrete @ 1 kHz → 60 dB',
    within(v, TL_CEIL_DB, 0.001), `got ${v.toFixed(3)}`);
}

// (4) Mass law slope identity: doubling m at fixed f → +6.0206 dB.
//     m=15→30 at 500 Hz: both unclamped, identity is exact.
{
  const diff = massLawTL(30, 500) - massLawTL(15, 500);
  check('mass law +6 dB / mass-doubling identity: 15→30 kg/m² @ 500 Hz',
    within(diff, 6.0206, 0.005), `Δ = ${diff.toFixed(4)} dB`);
}

// (5) Mass law +6 dB / octave: glass m=15, 500 → 1000 Hz.
{
  const diff = massLawTL(15, 1000) - massLawTL(15, 500);
  check('mass law +6 dB / octave identity: m=15 kg/m², 500→1000 Hz',
    within(diff, 6.0206, 0.005), `Δ = ${diff.toFixed(4)} dB`);
}

// (6) Bands at thickness: concrete at 300 mm @ 500 Hz.
//     density = 345/0.150 = 2300 kg/m³. m_new = 0.300·2300 = 690 kg/m².
//     20·log10(690·500) − 47 = 110.756 − 47 = 63.76 → clamp to 60.
{
  const arr = massLawTLBandsAtThickness(345, 0.150, 0.300, [500]);
  check('massLawTLBandsAtThickness: concrete at 300 mm @ 500 Hz → 60 dB',
    within(arr[0], TL_CEIL_DB, 0.001), `got [${arr[0].toFixed(3)}]`);
}

// (7) MASS_LAW_CONST_DB is the field-incidence 47, NOT the normal-incidence
//     trap 42. Sanity-pin the exported constant.
{
  check('MASS_LAW_CONST_DB = 47 (field-incidence, not 42 normal-incidence)',
    MASS_LAW_CONST_DB === 47, `got ${MASS_LAW_CONST_DB}`);
}

// =====================================================================
// 8–13. Maekawa IL — all four regimes + wavelength scaling + cap.
// =====================================================================
// c = 343 m/s. λ@1k = 0.343, λ/8 = 0.042875. λ@500 = 0.686.

// (8) Deeply lit: δ = −0.5 m, 1 kHz. δ ≤ −λ/8 → return 0.
{
  const v = maekawaIL(-0.5, C / 1000);
  check('Maekawa deeply lit: δ = −0.5 m @ 1 kHz → 0 dB',
    within(v, 0, 1e-9), `got ${v}`);
}

// (9) Graze midpoint: δ = −λ/16 @ 1 kHz. Smoother window: t = 0.5 → IL = 2.5.
{
  const v = maekawaIL(-(C / 1000) / 16, C / 1000);
  check('Maekawa graze midpoint: δ = −λ/16 @ 1 kHz → 2.5 dB (smoother)',
    within(v, 2.5, 0.001), `got ${v.toFixed(4)}`);
}

// (10) Transitional small N: δ = 0.001715 m (N≈0.01) @ 1 kHz → 5.180 dB.
//      Maekawa graze plateau (5 dB) plus small log term.
{
  const v = maekawaIL(0.001715, C / 1000);
  check('Maekawa transitional: δ ≈ 0.00172 m, N ≈ 0.01 @ 1 kHz → 5.18 dB',
    within(v, 5.180, 0.02), `got ${v.toFixed(3)}`);
}

// (11) Maekawa N=1 (textbook reference): δ = λ/2 = 0.1715 m @ 1 kHz.
//      x = √(2π) = 2.5066; tanh(x) = 0.9866; x/tanh = 2.5407;
//      20·log10(2.5407) = 8.097; IL = 5 + 8.097 = 13.097 dB.
{
  const v = maekawaIL(0.1715, C / 1000);
  check('Maekawa N=1 (textbook reference): δ = λ/2 @ 1 kHz → 13.10 dB',
    within(v, 13.097, 0.05), `got ${v.toFixed(3)}`);
}

// (12) Wavelength-scaling identity: same N, different f → same IL.
//      Maekawa IL is f(N) alone, not f(δ, λ) separately.
{
  const v1 = maekawaIL(0.1715, C / 1000);            // N=1 at 1 kHz
  const v2 = maekawaIL(0.343, C / 500);              // N=1 at 500 Hz
  check('Maekawa wavelength scaling: same N → same IL across bands',
    within(v1, v2, 0.001), `1 kHz: ${v1.toFixed(4)}  500 Hz: ${v2.toFixed(4)}`);
}

// (13) Maekawa 24 dB ceiling: large N saturates at MAEKAWA_IL_MAX_DB.
//      δ = 8.575 m → N = 50 → x ≈ 17.7; tanh(x) ≈ 1; 20·log10(17.7) = 24.97;
//      raw IL = 29.97 → clamp to 24.
{
  const v = maekawaIL(8.575, C / 1000);
  check('Maekawa 24 dB ceiling: huge N saturates',
    within(v, MAEKAWA_IL_MAX_DB, 0.001), `got ${v.toFixed(3)} (cap = ${MAEKAWA_IL_MAX_DB})`);
}

// =====================================================================
// 14–16. overBarrierPathDifference signed geometry.
// =====================================================================

// (14) Surau-like (high source, lit). Sightline at wall plane = 4.80 m;
//      wall top = 4.5 m → LIT → δ negative. dST=3.2016, dTR=4.2426,
//      dSR=7.4330, detour−direct = 0.01117 → δ = −0.01117 m.
{
  const v = overBarrierPathDifference({ sourceH: 7.0, barrierH: 4.5, sourceToBarrier: 2, barrierToReceiver: 3, receiverH: 1.5 });
  check('overBarrierPathDifference: surau-like (high source, lit) → δ ≈ −0.011 m',
    within(v, -0.01117, 0.0005), `got ${v.toFixed(5)} m`);
}

// (15) Tall barrier (deep shadow). S=R=1.5, W=6, d1=2, d2=5.
//      Sightline at wall = 1.5; wall top = 6 → SHADOWED → δ positive.
//      dST = √(4+20.25) = √24.25 = 4.9244; dTR = √(25+20.25) = √45.25 = 6.7268;
//      dSR = √49 = 7. Detour − direct = 4.6512.
{
  const v = overBarrierPathDifference({ sourceH: 1.5, barrierH: 6, sourceToBarrier: 2, barrierToReceiver: 5, receiverH: 1.5 });
  check('overBarrierPathDifference: tall barrier (deep shadow) → δ ≈ +4.65 m',
    within(v, 4.6512, 0.001), `got ${v.toFixed(4)} m`);
}

// (16) Co-linear degenerate: S, T (wall top), R all at z=3 → detour = 0.
{
  const v = overBarrierPathDifference({ sourceH: 3, barrierH: 3, sourceToBarrier: 5, barrierToReceiver: 5, receiverH: 3 });
  check('overBarrierPathDifference: sightline at barrier top → δ ≈ 0',
    within(v, 0, 0.0005), `got ${v.toFixed(5)} m`);
}

// =====================================================================
// 17–18. Air absorption — units + magnitudes.
// =====================================================================

// (17) Air abs cumulative @ 1 kHz, 30 m: α(1k)·30 = 0.00487·30 = 0.1461 dB.
{
  const v = airAbsorptionDbPerM(1000) * 30;
  check('air absorption: 1 kHz × 30 m → 0.146 dB (small, by design indoor)',
    within(v, 0.1461, 0.001), `got ${v.toFixed(4)}`);
}

// (18) Air abs cumulative @ 4 kHz, 30 m: 0.03751·30 = 1.1253 dB. Just audible.
{
  const v = airAbsorptionDbPerM(4000) * 30;
  check('air absorption: 4 kHz × 30 m → 1.13 dB',
    within(v, 1.1253, 0.001), `got ${v.toFixed(4)}`);
}

// =====================================================================
// 19–20. Net IL combination (v=610 power-sum logic).
// =====================================================================

// (19) Symmetric shadowed, SOFT ground @ 1 kHz. S=R=1.5, W=3, d1=d2=5.
//      direct = √(100+0) = 10.0; detour = 10.440; δ = 0.4403 m (shadowed).
//      λ@1k = 0.343. N = 2.566. x = √(2π·N) = 4.0152. tanh = 0.99938.
//      x/tanh = 4.0177. Maekawa = 5 + 20·log10(4.0177) = 17.083 dB.
//      Air abs (EXTRA over the top, Martina MEDIUM #2):
//        α × (detour − direct) = 0.00487 × 0.440 = 0.00214 dB.
//      loss_dir = 17.083 + 0.00214 = 17.085. Soft → p_grd term = 0.
//      Net IL = 17.085 dB.
{
  const v = netIL(1.5, 3, 5, 5, 1.5, /*G=*/1, 1000);
  check('Net IL symmetric shadowed, SOFT ground @ 1 kHz → 17.08 dB',
    within(v, 17.085, 0.1), `got ${v.toFixed(3)}`);
}

// (20) Symmetric shadowed, HARD < SOFT, with lift @ 4 kHz.
//      direct=10, detour=10.440, detour_grd=11.947, direct_image=10.4403.
//      δ_dir=0.4403→Maekawa 23.099; δ_grd=1.5067→capped 24.
//      α(4k)=0.03751. EXTRA on direct: 0.03751·0.440 = 0.01651.
//      Full on ground: 0.03751·11.947 = 0.4481.
//      loss_dir=23.116, loss_grd=24.448.
//      p_dir=10^-2.3116=0.004876, p_grd=10^-2.4448=0.003594.
//      Hard: p_total=0.008470→Net IL=20.722.
//      Soft: p_total=0.004876→Net IL=23.116.
//      Lift = 23.116 − 20.722 = 2.39 dB. Within [2.0, 3.1] range
//      Dr. Chen specified (asymptotic +3 requires loss_dir == loss_grd,
//      doesn't quite hit here because the detour difference splits them).
{
  const hard = netIL(1.5, 3, 5, 5, 1.5, /*G=*/0, 4000);
  const soft = netIL(1.5, 3, 5, 5, 1.5, /*G=*/1, 4000);
  const lift = soft - hard;
  check('Net IL @ 4 kHz: hard < soft AND lift ∈ [2.0, 3.1] dB',
    hard < soft && lift > 2.0 && lift < 3.1,
    `hard=${hard.toFixed(2)} soft=${soft.toFixed(2)} lift=${lift.toFixed(2)} dB`);
}

// =====================================================================
// 21. End-to-end: surau-default broadband Net IL (the teaching number).
// =====================================================================
// S=7, W=4.5, d1=2, d2=3, R=1.5, hard ground. direct=7.443, detour=7.444,
// detour-direct=0.011 m → Martina MEDIUM #2 fix makes the direct-path
// air-abs invisible at this geometry (it WAS visible at large recv
// distances pre-fix). Geometry is LIT (sightline just clears the wall)
// and inside the graze window at every band ≤ 2 kHz; at 4 kHz the
// direct path returns 0 dB Maekawa (deeply beyond the smoother).
// Per-band Net IL hand-calc (Martina-fixed math):
//   250: 4.62, 500: 4.30, 1k: 3.66, 2k: 2.37, 4k: -0.02 → mean 2.99 dB
// This is the "wall does NOT meaningfully attenuate a high horn"
// teaching number that anchors the surau leak-over investigation.
{
  const bandsBB = [250, 500, 1000, 2000, 4000];
  const vals = bandsBB.map(f => netIL(7, 4.5, 2, 3, 1.5, /*G=*/0, f));
  const broadband = vals.reduce((a, b) => a + b, 0) / vals.length;
  check('Net IL broadband (250–4k mean): surau-default hard ground → 2.99 dB',
    within(broadband, 2.985, 0.1), `got ${broadband.toFixed(3)} dB`);
}

// =====================================================================
console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
