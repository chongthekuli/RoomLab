// Toilet-cubicle direct-path isolation — Phase 2 acoustic loss (Dr. Lena Chen,
// 2026-06-07). Guards toiletDirectPathLossPerBand inside
// structureDirectPathLossPerBand (js/physics/building-structures.js): the
// door-open/closed + open/closed-top + undercut-governed leak model a listener
// INSIDE a cubicle now responds to.
//
// The LOAD-BEARING test is (a): the user placed a listener on the WC, toggled
// the door, and the SPL didn't move — because the toilet branch used to skip the
// direct-path loss entirely. (a) asserts door-OPEN reads measurably louder
// (lower loss) than door-CLOSED.
//
// Geometry note (Dr. Chen — honesty over a tuned number): the over-top channel
// (channel 3) genuinely DOMINATES the leak only when the over-top diffraction
// path is favourable (a HIGH source clearing the board top into a STANDING-ear
// listener). For the user's exact low-PA / seated-listener case the over-top is
// in deep shadow and the undercut aperture governs — both are correct physics,
// not a bug. (b) therefore demonstrates the over-top channel on the favourable
// geometry where it is NOT swamped; (a)/(c) use the user's literal geometry.
//
// Run: node tests/toilet-isolation.test.mjs

import { readFileSync } from 'node:fs';
import {
  structureDirectPathLossPerBand, _testing,
} from '../js/physics/building-structures.js';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}  ${e}`); if (!c) failed++; };

const room = { width_m: 8, depth_m: 8, height_m: 3 };
const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];
const I2K = 4, I125 = 0;          // band indices
const MAX_IL = 24;

const md = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const matMap = new Map(md.materials.map(m => [m.id, m]));

// Bank centre at (4,4), rotation 0 → door front faces local −y (world y < 4);
// rear wall at world y ≈ 4.8. Middle cubicle (i=1) interior ≈ (4, 4).
function toilet(over = {}) {
  return {
    id: 'T1', type: 'toilet', position: { x: 4, y: 4 }, rotation_deg: 0,
    materialId: 'gypsum-board', doorMaterialId: 'door-hollow-core', elev_m: 0,
    cubicles: 3, clearWidth_m: 0.90, clearDepth_m: 1.50, partitionThickness_m: 0.05,
    topType: 'open', openTopBoardH_m: 2.00, scuffGap_m: 0.15, doorClearH_m: 2.10,
    hingeSide: 'left', frontLatchGap_m: 0.010, hingeReveal_m: 0.010, doorThk_m: 0.04,
    undercut_m: 0.30, doorsOpen: [false, false, false], showBowls: true, seatHeight_m: 0.42,
    ...over,
  };
}

// User's literal case: PA outside in front (low), listener on the WC (seated ear).
const S_FRONT = { x: 4, y: 1, z: 1.2 };
const L_WC    = { x: 4, y: 4, z: 1.0 };
const loss = (over, src = S_FRONT, lst = L_WC) =>
  structureDirectPathLossPerBand(src, lst, [toilet(over)], matMap, BANDS, room);

// =====================================================================
// Pre-flight — membership: the WC listener IS inside the middle cubicle,
// the front source is OUTSIDE. (Proves the topology classifier fires.)
// =====================================================================
{
  const polys = _testing.toiletCubiclePolys(toilet());
  ok(_testing.cubicleIndexOf(L_WC, polys) === 1, 'listener on the WC is inside the MIDDLE cubicle (idx 1)');
  ok(_testing.cubicleIndexOf(S_FRONT, polys) === -1, 'front source is OUTSIDE every cubicle (idx -1)');
}

// =====================================================================
// (a) LOAD-BEARING — door OPEN ≥ 5 dB LOWER loss than door CLOSED at 2 kHz.
//     This is the user's exact complaint: the WC listener must hear MORE
//     SPL with the door open.
// =====================================================================
{
  const open = loss({ doorsOpen: [false, true, false] });   // middle door OPEN
  const closed = loss({ doorsOpen: [false, false, false] }); // middle door CLOSED
  ok(open[I2K] === 0, 'door OPEN → front aperture → 0 dB direct-path loss @2k', `(${open[I2K].toFixed(2)})`);
  ok(closed[I2K] >= 5, 'door CLOSED → ≥5 dB loss @2k (cubicle isolates)', `(${closed[I2K].toFixed(2)})`);
  ok(closed[I2K] - open[I2K] >= 5,
     'door CLOSED loss ≥ door OPEN loss + 5 dB @2k (LOAD-BEARING — listener hears the toggle)',
     `(Δ=${(closed[I2K] - open[I2K]).toFixed(2)} dB)`);
}

// =====================================================================
// (b) Over-top channel is LIVE and directionally correct.
//   (b1) user geometry, door CLOSED, 0.30 undercut: closed-top ≥ open-top + ~0.3
//        (the over-top channel exists but is undercut-swamped at low source).
//   (b2) FAVOURABLE geometry (high PA z=2.9, standing ear z=1.6) + undercut 0.02:
//        closed-top beats open-top by ≥ 8 dB — proves the over-top channel is
//        NOT swamped when the diffraction path is favourable.
// =====================================================================
{
  // (b1) user geometry: directional sign only (over-top is genuinely small here).
  const openTop = loss({ topType: 'open', doorsOpen: [false, false, false] });
  const closedTop = loss({ topType: 'closed', doorsOpen: [false, false, false] });
  ok(closedTop[I2K] >= openTop[I2K] + 0.2,
     '(b1) closed-top ≥ open-top @2k (sealing the top adds isolation — directionally correct)',
     `(open=${openTop[I2K].toFixed(2)} closed=${closedTop[I2K].toFixed(2)})`);

  // (b2) favourable over-top geometry: HIGH PA + standing ear + tiny undercut.
  const S_HIGH = { x: 4, y: 1, z: 2.9 };
  const L_STAND = { x: 4, y: 4, z: 1.6 };
  const ot_open = loss({ topType: 'open', undercut_m: 0.02 }, S_HIGH, L_STAND);
  const ot_closed = loss({ topType: 'closed', undercut_m: 0.02 }, S_HIGH, L_STAND);
  ok(ot_closed[I2K] - ot_open[I2K] >= 8,
     '(b2) high-PA + standing ear + 0.02 undercut → closed-top beats open-top by ≥8 dB @2k (over-top NOT swamped)',
     `(Δ=${(ot_closed[I2K] - ot_open[I2K]).toFixed(2)} dB)`);
}

// =====================================================================
// (c) Undercut governs the closed-door plateau (the HONEST number).
//   (c1) closed-door + closed-top, 0.30 undercut: loss @2k ∈ [5,10] dB —
//        the undercut-governed plateau, NOT a hand-tuned 20 dB.
//   (c2) tiny undercut (0.01): closed-door loss @2k ≥ 18 dB — the leaf-TL
//        regime exists once the slot is sealed. (0.02 caps at ~17 because a
//        20 mm slot on a 0.88 m door still leaks ~1.2% open area — correct.)
// =====================================================================
{
  const c030 = loss({ topType: 'closed', undercut_m: 0.30, doorsOpen: [false, false, false] });
  ok(c030[I2K] >= 5 && c030[I2K] <= 10,
     '(c1) closed-door+closed-top, 0.30 undercut → loss @2k ∈ [5,10] dB (undercut plateau, honest)',
     `(${c030[I2K].toFixed(2)})`);

  const c001 = loss({ topType: 'closed', undercut_m: 0.01, doorsOpen: [false, false, false] });
  ok(c001[I2K] >= 18,
     '(c2) closed-door, 0.01 undercut → loss @2k ≥ 18 dB (leaf-TL regime exists once sealed)',
     `(${c001[I2K].toFixed(2)})`);
  ok(c001[I2K] > c030[I2K],
     '(c2) tighter undercut → MORE isolation (monotone in slot size)',
     `(0.01:${c001[I2K].toFixed(2)} > 0.30:${c030[I2K].toFixed(2)})`);
}

// =====================================================================
// (d) LF internal consistency + bounds. The door-open-vs-closed delta must
//     not swing wildly across frequency (|Δ125 − Δ2k| ≤ 3 dB); every band's
//     loss is finite, ≥0, ≤ MAEKAWA_IL_MAX_DB.
// =====================================================================
{
  const open = loss({ doorsOpen: [false, true, false] });
  const closed = loss({ doorsOpen: [false, false, false] });
  const d125 = closed[I125] - open[I125];
  const d2k = closed[I2K] - open[I2K];
  ok(Math.abs(d125 - d2k) <= 3,
     '(d) |Δ(125Hz) − Δ(2kHz)| ≤ 3 dB (no wild spectral swing)',
     `(|${d125.toFixed(2)} − ${d2k.toFixed(2)}| = ${Math.abs(d125 - d2k).toFixed(2)})`);
  for (const arr of [open, closed]) {
    ok(Array.from(arr).every(v => Number.isFinite(v) && v >= 0 && v <= MAX_IL),
       '(d) all bands finite, ≥0, ≤ MAEKAWA_IL_MAX_DB (24)',
       `(${Array.from(arr).map(v => v.toFixed(1))})`);
  }
}

// =====================================================================
// (e) RECIPROCITY — swap source ↔ listener → loss array identical to 1e-6.
//     Every channel quantity (TL, aperture area, diffraction detour) is
//     S↔L symmetric; Topology B is implemented ONCE and called role-swapped.
// =====================================================================
{
  const fwd = structureDirectPathLossPerBand(S_FRONT, L_WC, [toilet()], matMap, BANDS, room);
  const rev = structureDirectPathLossPerBand(L_WC, S_FRONT, [toilet()], matMap, BANDS, room);
  let maxDiff = 0;
  for (let k = 0; k < BANDS.length; k++) maxDiff = Math.max(maxDiff, Math.abs(fwd[k] - rev[k]));
  ok(maxDiff <= 1e-6, '(e) reciprocity: source-inside vs listener-inside loss identical (≤1e-6)',
     `(maxΔ=${maxDiff.toExponential(2)})`);
}

// =====================================================================
// (f) TOPOLOGY A — S and L both OUTSIDE, the bank between them (S in front,
//     L behind the rear wall) → non-zero series-added through-board loss.
// =====================================================================
{
  const A = structureDirectPathLossPerBand(
    { x: 4, y: 1, z: 1.2 }, { x: 4, y: 7, z: 1.2 }, [toilet()], matMap, BANDS, room,
  );
  ok(Array.from(A).some(v => v > 0),
     '(f) Topology A: bank between two outside points → non-zero loss', `(${Array.from(A).map(v => v.toFixed(1))})`);
  ok(Array.from(A).every(v => Number.isFinite(v) && v >= 0),
     '(f) Topology A loss finite + ≥0 at every band');
}

// =====================================================================
// (g) Both inside the SAME cubicle → 0 loss (no separating board).
// =====================================================================
{
  const same = structureDirectPathLossPerBand(
    { x: 3.9, y: 4, z: 1.0 }, { x: 4.1, y: 4, z: 1.1 }, [toilet()], matMap, BANDS, room,
  );
  ok(Array.from(same).every(v => v === 0), '(g) both inside the SAME cubicle → 0 loss');
}

// =====================================================================
// (h) Door composite — closedDoorTau caps isolation at the undercut floor,
//     NOT the leaf TL. A 0.30 m undercut on a 1.70 m leaf with a 33 dB leaf
//     gives ~8 dB, not 33 dB (the honest area-weighted cap).
// =====================================================================
{
  const door = { leafW: 0.88, leafH: 1.70, undercut_m: 0.30 };
  const tau = _testing.closedDoorTau(door, 33);   // very high leaf TL
  const lossDb = -10 * Math.log10(tau);
  ok(lossDb >= 5 && lossDb <= 10,
     '(h) closedDoorTau: 0.30 m undercut caps a 33 dB leaf at ~8 dB (undercut floor, honest)',
     `(${lossDb.toFixed(2)} dB)`);
  // Aperture (open door) → τ handled by caller as 1; here verify the undercut
  // term alone (leaf TL → ∞) still leaks the geometric open-area fraction.
  const tauSealed = _testing.closedDoorTau(door, Infinity);
  const expected = (0.88 * 0.30) / (0.88 * 1.70 + 0.88 * 0.30);   // A_gap / (A_leaf + A_gap)
  ok(Math.abs(tauSealed - expected) < 1e-9,
     '(h) leaf TL→∞ → τ_door = undercut open-area fraction (geometric floor)',
     `(${tauSealed.toFixed(4)} vs ${expected.toFixed(4)})`);
}

console.log(failed === 0 ? '\nAll toilet-isolation tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
