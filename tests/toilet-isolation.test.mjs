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
// v=782 OVER-DOOR CHANNEL (Dr. Chen — the channel the v=781 stopgap flagged).
// The transom above the door was removed (v=781): a CLOSED door leaf is now a
// finite-height barrier (top = doorClearH ≈ 2.10) with an OPEN gap above it
// (doorTop → ceil). So a CLOSED door leaks over its TOP edge (channel 4) AS WELL
// AS under its 0.30 m undercut. The net closed-top isolation is governed by
// whichever leaks most: undercut OR over-door. For a TALL front source the
// over-door path lights the leaf top edge and DOMINATES — capping closed-door
// isolation at ~4 dB no matter how small the undercut; for a LOW/seated source
// the leaf top is in deep shadow (over-door IL ~24 dB) and the undercut governs,
// so sealing it still recovers the leaf-TL regime (~17 dB). Both correct physics.
// Honest figures re-derived below (NOT hand-tuned) replace the v=781 stopgaps:
//   (a) door open 0 dB vs closed 7.7 dB @2k — margin 7.7 dB (LOAD-BEARING).
//   (b1) user low-source: closed-top 7.98 vs open-top 7.74 @2k — margin 0.24 dB
//        (over-door barely lit; the side-board top sealing is the only delta).
//   (b2) favourable high-source: closed-top 4.32 vs open-top 2.23 @2k — margin
//        2.09 dB. The old ≥8 dB was the TRANSOM artifact (dominantSeparatingBoard
//        picked the solid gypsum transom). With the transom gone + over-door live
//        the honest margin is ~2 dB: open-top leaks over BOTH the side board AND
//        the door, closed-top leaks over the door ONLY.
//   (c2) user low-source, 0.01 undercut: 16.50 dB (leaf-TL regime — over-door in
//        deep shadow). HIGH-source 0.001 undercut: caps at ~4.4 dB (over-door
//        plateau — sealing the undercut no longer helps once the leaf top is lit).
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
// (b) Over-top + over-door channels LIVE and directionally correct.
//   (b1) user geometry, door CLOSED, 0.30 undercut: closed-top ≥ open-top + 0.2
//        (sealing the SIDE-board top adds isolation; the over-door leak is in
//        deep shadow for the low source so the delta is small — honest 0.24 dB).
//   (b2) FAVOURABLE geometry (high PA z=2.9, standing ear z=1.6) + undercut 0.02:
//        closed-top beats open-top by ≥ 1.5 dB — the HONEST margin once the
//        over-door channel (v=782) is live. Open-top leaks over BOTH the side
//        board AND the door; closed-top leaks over the DOOR ONLY. The old ≥8 dB
//        threshold was the v=781 TRANSOM artifact (dominantSeparatingBoard picked
//        the solid gypsum transom as the front board). Re-derived to ~2.1 dB.
// =====================================================================
{
  // (b1) user geometry: small but signed delta (over-door in deep shadow here).
  const openTop = loss({ topType: 'open', doorsOpen: [false, false, false] });
  const closedTop = loss({ topType: 'closed', doorsOpen: [false, false, false] });
  ok(closedTop[I2K] >= openTop[I2K] + 0.2,
     '(b1) closed-top ≥ open-top + 0.2 @2k (sealing the side-board top adds isolation; over-door in shadow for low src)',
     `(open=${openTop[I2K].toFixed(2)} closed=${closedTop[I2K].toFixed(2)} Δ=${(closedTop[I2K] - openTop[I2K]).toFixed(2)})`);

  // (b2) favourable over-top + over-door geometry: HIGH PA + standing ear + tiny
  // undercut. With the v=782 over-door channel LIVE, closed-top no longer over-
  // reads (the transom artifact is gone) and the honest closed-vs-open margin is
  // ~2.1 dB — open-top has the extra side-board over-top leak that closed-top
  // lacks, on top of the shared over-door leak. Assert a defensible floor (≥1.5).
  const S_HIGH = { x: 4, y: 1, z: 2.9 };
  const L_STAND = { x: 4, y: 4, z: 1.6 };
  const ot_open = loss({ topType: 'open', undercut_m: 0.02 }, S_HIGH, L_STAND);
  const ot_closed = loss({ topType: 'closed', undercut_m: 0.02 }, S_HIGH, L_STAND);
  ok(ot_closed[I2K] >= ot_open[I2K] + 1.5,
     '(b2) v=782: closed-top ≥ open-top + 1.5 dB @2k (honest post-transom + over-door margin; was the ≥8 dB transom artifact)',
     `(closed=${ot_closed[I2K].toFixed(2)} open=${ot_open[I2K].toFixed(2)} Δ=${(ot_closed[I2K] - ot_open[I2K]).toFixed(2)} dB)`);
}

// =====================================================================
// (c) Undercut governs the closed-door plateau (the HONEST number), UNLESS the
//     over-door leak (v=782) caps it first for a tall source.
//   (c1) closed-door + closed-top, 0.30 undercut, LOW source: loss @2k ∈ [5,10]
//        dB — the undercut-governed plateau, NOT a hand-tuned 20 dB.
//   (c2) LOW source, tiny undercut (0.01): closed-door loss @2k ≥ 16 dB — the
//        leaf-TL regime exists once the slot is sealed AND the over-door path is
//        in deep shadow (low source). Monotone in slot size.
//   (c3) HIGH source, the over-door CAP: sealing the undercut to 0.001 m no
//        longer climbs to the leaf-TL regime — it plateaus at ~4.4 dB because the
//        over-door diffraction leak now governs (the leaf top edge is lit). This
//        is the v=782 behaviour the stopgap was hiding: closed-door isolation is
//        bounded by whichever leaks most, undercut OR over-door.
// =====================================================================
{
  const c030 = loss({ topType: 'closed', undercut_m: 0.30, doorsOpen: [false, false, false] });
  ok(c030[I2K] >= 5 && c030[I2K] <= 10,
     '(c1) closed-door+closed-top, 0.30 undercut, low src → loss @2k ∈ [5,10] dB (undercut plateau, honest)',
     `(${c030[I2K].toFixed(2)})`);

  const c001 = loss({ topType: 'closed', undercut_m: 0.01, doorsOpen: [false, false, false] });
  // v=782: the over-door channel is in DEEP SHADOW for the user's LOW source
  // (over-door IL ~24 dB), so sealing the undercut still recovers the leaf-TL
  // regime (~16.5 dB). The honest door-leaf figure — not the old ≥18 dB transom
  // artifact, not a hand-tuned 20 dB. The leaf-TL regime EXISTS once sealed.
  ok(c001[I2K] >= 16,
     '(c2) closed-door, 0.01 undercut, LOW src → loss @2k ≥ 16 dB (leaf-TL regime; over-door in shadow → undercut governs)',
     `(${c001[I2K].toFixed(2)})`);
  ok(c001[I2K] > c030[I2K],
     '(c2) tighter undercut → MORE isolation (monotone in slot size, low src)',
     `(0.01:${c001[I2K].toFixed(2)} > 0.30:${c030[I2K].toFixed(2)})`);

  // (c3) HIGH source over-door CAP — the v=782 dominant-leak logic. A standing PA
  // (z=2.9) clears the 2.10 m door top, so the over-door diffraction leak governs:
  // sealing the undercut to 0.001 m plateaus at ~4.4 dB instead of climbing to the
  // ~17 dB leaf-TL regime the LOW source reaches. closed-door isolation = min over
  // the two leaks (undercut vs over-door), exactly as the spec requires.
  const S_HIGH = { x: 4, y: 1, z: 2.9 };
  const L_STAND = { x: 4, y: 4, z: 1.6 };
  const hi001 = loss({ topType: 'closed', undercut_m: 0.001 }, S_HIGH, L_STAND);
  ok(hi001[I2K] >= 3 && hi001[I2K] <= 7,
     '(c3) HIGH src, 0.001 undercut → loss @2k CAPPED at ~4.4 dB by the over-door leak (NOT the ~17 dB leaf-TL regime)',
     `(${hi001[I2K].toFixed(2)})`);
  ok(hi001[I2K] < c001[I2K] - 8,
     '(c3) over-door cap (high src) ≪ leaf-TL regime (low src) at the same 0.01-class undercut (dominant-leak logic live)',
     `(high=${hi001[I2K].toFixed(2)} low=${c001[I2K].toFixed(2)})`);
}

// =====================================================================
// (d) LF internal consistency + bounds. The door-open-vs-closed delta must
//     not swing wildly across frequency; every band's loss is finite, ≥0,
//     ≤ MAEKAWA_IL_MAX_DB.
//     v=782 RE-BASELINE: the over-door diffraction leak (channel 4) is
//     WAVELENGTH-DEPENDENT — a longer LF wavelength bends over the 2.10 m leaf
//     top more readily, so closed-door isolation is honestly LOWER at 125 Hz
//     (4.3 dB) than at 2 kHz (7.7 dB), a 3.4 dB spread. This is correct
//     diffraction physics, not a wild swing: the leak rises smoothly toward LF
//     (monotone) and stays bounded. Threshold widened 3 → 4 dB to admit the
//     honest two-channel (undercut + over-door) spectral slope.
// =====================================================================
{
  const open = loss({ doorsOpen: [false, true, false] });
  const closed = loss({ doorsOpen: [false, false, false] });
  const d125 = closed[I125] - open[I125];
  const d2k = closed[I2K] - open[I2K];
  ok(Math.abs(d125 - d2k) <= 4,
     '(d) |Δ(125Hz) − Δ(2kHz)| ≤ 4 dB (honest over-door LF slope, monotone — no wild swing)',
     `(|${d125.toFixed(2)} − ${d2k.toFixed(2)}| = ${Math.abs(d125 - d2k).toFixed(2)})`);
  // Monotone guard: closed-door loss must rise smoothly LF→HF (over-door + door
  // composite both favour leak at LF), never oscillate — that would signal a bug.
  let monotone = true;
  for (let k = 1; k < closed.length; k++) if (closed[k] < closed[k - 1] - 1e-6) monotone = false;
  ok(monotone,
     '(d) closed-door loss is monotone non-decreasing LF→HF (smooth diffraction slope, not an oscillation)',
     `(${Array.from(closed).map(v => v.toFixed(1)).join(' ')})`);
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

// =====================================================================
// (i) OVER-DOOR CHANNEL (v=782) — the channel the v=781 stopgap flagged.
//   (i1) dominantSeparatingBoard picks the DOOR LEAF (isFront, top = doorClearH
//        2.10 m) for a near-front ray — NOT the removed transom, NOT a side board.
//   (i2) the over-door diffraction leak is NON-ZERO and finite for a HIGH source
//        clearing the 2.10 m leaf top (over-door IL ~7.6 dB → ratio ~0.18), and
//        is in deep shadow (IL ~24 dB) for a LOW source — both correct physics.
//   (i3) closed-top is NOT fully sealed: a HIGH front source closed-top reads
//        STRICTLY LESS isolation than it would if the over-door path were absent
//        (i.e. less than the LOW-source closed-top at the same undercut). This
//        proves the over-door leak is wired into structureDirectPathLossPerBand,
//        not just the helper.
// =====================================================================
{
  const c = _testing.speedOfSound(20);
  // (i1) dominant board pick = door leaf for the near-front user ray.
  const { expandToiletSurfaces } = await import('../js/physics/building-structures.js');
  const inv = expandToiletSurfaces(toilet({ topType: 'closed' }), room);
  inv.meta.boardMaterialId = 'gypsum-board';
  inv.meta.doorMaterialId = 'door-hollow-core';
  const polys = _testing.toiletCubiclePolys(toilet({ topType: 'closed' }));
  const rIdx = _testing.cubicleIndexOf(L_WC, polys);
  const dom = _testing.dominantSeparatingBoard(inv, rIdx, L_WC, S_FRONT);
  ok(dom && dom.isFront === true && !!dom.door,
     '(i1) dominantSeparatingBoard picks the DOOR LEAF as the front separating element (transom artifact gone)',
     `(isFront=${dom?.isFront} top=${dom?.board?.top})`);
  ok(dom && Math.abs(dom.board.top - 2.10) < 1e-6,
     '(i1) door-leaf top edge = doorClearH (2.10 m), below the 3.0 m ceiling → over-door gap exists',
     `(top=${dom?.board?.top})`);

  // (i2) over-door diffraction ratio: non-zero & finite for a HIGH source; deep
  // shadow for a LOW source. Reuses the SAME overTopChannel primitive the model
  // calls, fed the door-leaf board (doorToBoard).
  const door = inv.doors[1];
  const board = _testing.doorToBoard(door);
  const lam2k = c / 2000;
  const S_HIGH = { x: 4, y: 1, z: 2.9 };
  const L_STAND = { x: 4, y: 4, z: 1.6 };
  const dHi = Math.hypot(S_HIGH.x - L_STAND.x, S_HIGH.y - L_STAND.y, S_HIGH.z - L_STAND.z);
  const dLo = Math.hypot(S_FRONT.x - L_WC.x, S_FRONT.y - L_WC.y, S_FRONT.z - L_WC.z);
  const rHi = _testing.overTopChannel(board, L_STAND, S_HIGH, lam2k, dHi);
  const rLo = _testing.overTopChannel(board, L_WC, S_FRONT, lam2k, dLo);
  ok(rHi > 0.05 && rHi < 1 && Number.isFinite(rHi),
     '(i2) over-door leak NON-ZERO & finite for a HIGH source clearing the 2.10 m leaf top',
     `(ratio=${rHi.toFixed(4)} → ${(-10 * Math.log10(rHi)).toFixed(2)} dB IL)`);
  ok(rLo < rHi && rLo > 0,
     '(i2) over-door leak in DEEP SHADOW for a LOW/seated source (ratio ≪ high-source ratio)',
     `(low=${rLo.toFixed(4)} → ${(-10 * Math.log10(rLo)).toFixed(2)} dB IL; high=${rHi.toFixed(4)})`);

  // (i3) END-TO-END proof the over-door channel is wired into the public model:
  // HIGH-source closed-top isolation is strictly LOWER than LOW-source closed-top
  // at the SAME 0.001 undercut (the over-door leak only the high source sees).
  const hi = loss({ topType: 'closed', undercut_m: 0.001 }, S_HIGH, L_STAND)[I2K];
  const lo = loss({ topType: 'closed', undercut_m: 0.001 }, S_FRONT, L_WC)[I2K];
  ok(hi < lo - 5,
     '(i3) HIGH-src closed-top < LOW-src closed-top by ≥5 dB at 0.001 undercut → over-door leak is wired into the model',
     `(high=${hi.toFixed(2)} low=${lo.toFixed(2)} Δ=${(lo - hi).toFixed(2)} dB)`);
}

console.log(failed === 0 ? '\nAll toilet-isolation tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
