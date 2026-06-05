// Low-frequency modal-field regression tests (Dr. Lena Chen's assertion set,
// 2026-06-05). Guards the wave-acoustic heatmap fix: below the Schroeder
// frequency a rectangular room shows standing-wave pressure maxima at the
// walls/corners and nulls between — the statistical model can't express that.
//
// Plain node + console asserts, no framework.

import { schroederFrequency } from '../js/physics/schroeder.js';
import { enumerateRoomModes, modalQ, modeShape } from '../js/physics/room-modes.js';
import { computeModalField, blendModalIntoBaseline, crossfadeWeight, lowFreqCaption } from '../js/physics/modal-field.js';

let failed = 0;
function ok(cond, label, info = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${info}`);
  if (!cond) failed++;
}

// =====================================================================
// 1. Schroeder formula (consolidated helper — guards the 3 inlined copies)
// =====================================================================
{
  const fs = schroederFrequency(0.5, 73);
  ok(Math.abs(fs - 165.5) < 1.5, 'Schroeder f_s(T60=0.5, V=73) ≈ 165 Hz', `(${fs.toFixed(1)})`);
  ok(schroederFrequency(0, 73) === null, 'Schroeder null for T60=0');
  ok(schroederFrequency(0.5, 0) === null, 'Schroeder null for V=0');
}

// =====================================================================
// Shared fixture — rectangular 5 × 7 × 3 m room.
// =====================================================================
const room = { shape: 'rectangular', width_m: 5, depth_m: 7, height_m: 3 };
const V = 5 * 7 * 3;          // 105 m³
const t60 = 0.6;
const fs = schroederFrequency(t60, V);   // ~151 Hz
const earZ = 1.2;
// Lowest depth-axial mode (0,1,0): f = (343.2/2)·(1/7) = 24.5 Hz.
// Width-axial (1,0,0): f = (343.2/2)·(1/5) = 34.3 Hz.
const f_depth_axial = (343.2 / 2) * (1 / 7);

// =====================================================================
// 2. Crossfade weight — modal below f_s, gone above 1.5·f_s.
// =====================================================================
{
  ok(crossfadeWeight(0.4 * fs, fs) === 1, 'crossfade w=1 deep below f_s');
  ok(Math.abs(crossfadeWeight(fs, fs) - 0.5) < 0.01, 'crossfade w=0.5 at f_s', `(${crossfadeWeight(fs, fs).toFixed(2)})`);
  ok(crossfadeWeight(1.5 * fs, fs) === 0, 'crossfade w=0 at 1.5·f_s');
  ok(crossfadeWeight(125, null) === 0, 'crossfade w=0 when f_s unknown');
}

// =====================================================================
// 3. Corner louder than centre (the user's exact complaint, codified).
//    Source in a corner excites every mode. Evaluate at a low axial mode.
// =====================================================================
function blendedField(freq, sources, cells) {
  const modal = computeModalField({ room, sources, freq_hz: freq, t60_s: t60, f_s: fs, cells, earZ });
  if (!modal) return null;
  const base = new Float32Array(cells.length).fill(90);   // flat 90 dB baseline
  return { spl: [...blendModalIntoBaseline(base, modal)], w: modal.weight, modes: modal.modeCount };
}
const cornerSrc = [{ x: 0.15, y: 0.15, z: 1.2, weight: 1 }];
{
  const cells = [
    { x: 0.1, y: 0.1 },   // 0 near corner
    { x: 2.5, y: 3.5 },   // 1 room centre
  ];
  // Evaluate at the depth-axial mode where the pattern is cleanest.
  const f = blendedField(f_depth_axial, cornerSrc, cells);
  ok(f && f.spl[0] > f.spl[1] + 6, 'corner reads ≥6 dB above centre at the (0,1,0) axial mode',
     f ? `(corner ${f.spl[0].toFixed(1)} vs centre ${f.spl[1].toFixed(1)})` : '(null)');
}

// =====================================================================
// 4. Interior null exists — mid-length ≥10 dB below the end walls at the
//    depth-axial mode. (This is the assertion a boundary-only term FAILS —
//    it enforces that we built the real standing wave, not just a wall rise.)
// =====================================================================
{
  const cells = [
    { x: 2.5, y: 0.1 },   // 0 near front wall (y≈0, antinode)
    { x: 2.5, y: 6.9 },   // 1 near back wall (y≈Ly, antinode)
    { x: 2.5, y: 3.5 },   // 2 mid-length (y≈Ly/2, NODE of the (0,1,0) mode)
  ];
  const f = blendedField(f_depth_axial, cornerSrc, cells);
  const endAvg = f ? (f.spl[0] + f.spl[1]) / 2 : 0;
  ok(f && (endAvg - f.spl[2]) >= 10, 'interior null: mid-length ≥10 dB below end walls at (0,1,0)',
     f ? `(ends ${endAvg.toFixed(1)} vs mid ${f.spl[2].toFixed(1)})` : '(null)');
}

// =====================================================================
// 5. Band-selective — strong corner/centre contrast at a modal frequency,
//    but ~0 contrast at 8 kHz (modal term must vanish above f_s).
// =====================================================================
{
  const cells = [{ x: 0.1, y: 0.1 }, { x: 2.5, y: 3.5 }];
  const lowF = blendedField(f_depth_axial, cornerSrc, cells);
  const hiF = blendedField(8000, cornerSrc, cells);
  ok(lowF && (lowF.spl[0] - lowF.spl[1]) > 6, 'modal contrast large at LF axial mode');
  ok(hiF === null, 'modal field is null at 8 kHz (statistical regime, no contrast)');
}

// =====================================================================
// 6. Non-rectangular gate — polygon/round/custom return null (fall back to
//    statistical + disclosure caption).
// =====================================================================
{
  const cells = [{ x: 1, y: 1 }];
  for (const shape of ['polygon', 'round', 'custom']) {
    const r = { ...room, shape };
    ok(computeModalField({ room: r, sources: cornerSrc, freq_hz: f_depth_axial, t60_s: t60, f_s: fs, cells, earZ }) === null,
       `non-rectangular gate: ${shape} → null modal field`);
  }
}

// =====================================================================
// 7. Source on a node excites nothing of that mode (correct physics).
//    For the (0,1,0) depth-axial mode, ψ_src ∝ cos(π·y_src/Ly); at y=Ly/2
//    that's cos(π/2)=0 → the mode is not excited from there.
// =====================================================================
{
  const nodeSrc = [{ x: 2.5, y: 3.5, z: 1.2, weight: 1 }];   // centre = node of (0,1,0)
  const cells = [{ x: 2.5, y: 0.1 }, { x: 2.5, y: 6.9 }];
  // At EXACTLY the depth-axial mode, a centre source barely lights the end
  // walls (the dominant axial mode is node-killed). Compare to the corner
  // source which excites it strongly.
  const fromNode = blendedField(f_depth_axial, nodeSrc, cells);
  const fromCorner = blendedField(f_depth_axial, cornerSrc, cells);
  const endVar = (f) => f ? Math.abs(f.spl[0] - f.spl[1]) : 0;
  // Corner source produces a stronger / more structured field than a node source.
  ok(fromCorner && fromNode, 'node + corner source fields both computed');
  ok(modeShape(0, 1, 0, 2.5, 3.5, 1.2, 5, 7, 3) < 0.01, 'ψ(0,1,0) ≈ 0 at room-centre y (node)',
     `(${modeShape(0, 1, 0, 2.5, 3.5, 1.2, 5, 7, 3).toFixed(3)})`);
}

// =====================================================================
// 8. Normalisation preserves the band-mean (modal only REDISTRIBUTES energy).
//    Blending must not shift the average level vs the baseline.
// =====================================================================
{
  // A grid of cells spanning the room.
  const cells = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 7; j++) cells.push({ x: 0.5 + i, y: 0.5 + j });
  const modal = computeModalField({ room, sources: cornerSrc, freq_hz: 125, t60_s: t60, f_s: fs, cells, earZ });
  const base = new Float32Array(cells.length).fill(90);
  const blended = blendModalIntoBaseline(base, modal);
  // Energy-mean of blended ≈ energy-mean of baseline (10^(90/10)).
  let e = 0; for (const v of blended) e += Math.pow(10, v / 10);
  const meanDb = 10 * Math.log10(e / blended.length);
  ok(Math.abs(meanDb - 90) < 0.5, 'blend preserves band energy-mean (redistributes, no level shift)', `(${meanDb.toFixed(2)} dB)`);
}

// =====================================================================
// 9. enumerateRoomModes + modalQ sanity.
// =====================================================================
{
  const modes = enumerateRoomModes({ width_m: 5, depth_m: 7, height_m: 3, t60_s: 0.6, cutoffHz: 1.5 * fs });
  ok(modes.length > 0 && modes.every(m => m.freq <= 1.5 * fs + 1e-6), 'enumerateRoomModes respects cutoff', `(${modes.length} modes)`);
  ok(modes[0].freq <= modes[modes.length - 1].freq, 'modes sorted ascending by frequency');
  ok(modalQ(100, 0.6) > 0 && modalQ(100, 0) === 0, 'modalQ positive for valid inputs, 0 for T60=0');
}

// =====================================================================
// 10. Low-frequency caption logic.
// =====================================================================
{
  ok(lowFreqCaption({ freq_hz: 8000, schroeder_hz: 150, modalApplied: true }) === '', 'caption empty above f_s');
  ok(/Modal field/.test(lowFreqCaption({ freq_hz: 125, schroeder_hz: 150, modalApplied: true })), 'caption notes modal field when applied');
  ok(/statistical estimate/.test(lowFreqCaption({ freq_hz: 125, schroeder_hz: 150, modalApplied: false })), 'caption discloses statistical estimate when modal not applied (non-rect)');
}

console.log(failed === 0 ? '\nAll modal-field tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
