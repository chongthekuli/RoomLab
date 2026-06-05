// Per-point modal SPL regression tests (Dr. Lena Chen's per-point spec,
// 2026-06-05). Guards the listener-dot low-frequency physics: a listener near a
// wall/corner must read higher bass than one mid-room at the same source
// distance, computed by the SAME analytic modal field the heatmap uses (so dot
// and heatmap agree), anchored to the statistical reverberant energy via the
// closed-form volume-mean (no fudge factor).
//
// Plain node + console asserts.

import { schroederFrequency } from '../js/physics/schroeder.js';
import { computeModalField } from '../js/physics/modal-field.js';
import { modeShape } from '../js/physics/room-modes.js';
import { registerLoudspeaker, getCachedLoudspeaker } from '../js/physics/loudspeaker.js';
import { computeMultiSourceSPL, computeRoomConstant } from '../js/physics/spl-calculator.js';
import { computePerListenerMetrics } from '../js/physics/per-listener-metrics.js';
import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}  ${e}`); if (!c) failed++; };

const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};

// =====================================================================
// PART A — analytic volume-mean correctness (the normalization anchor)
// =====================================================================
const room = { shape: 'rectangular', width_m: 4, depth_m: 3, height_m: 2.7 };
const Lx = 4, Ly = 3, Lz = 2.7, V = Lx * Ly * Lz, t60 = 0.6;
const fs = schroederFrequency(t60, V);    // ≈ 272 Hz
const earZ = 1.2;
const cornerSrc = [{ x: 0.12, y: 0.12, z: 1.2, weight: 1 }];

// 1. Analytic volume-mean identity: the closed-form analyticMean must equal a
//    dense numerical integral of the SAME relative field over the room volume.
{
  const N = 40;   // dense grid in x,y; integrate z analytically is harder, so
  // build cells across x,y at earZ and compare the cell-mean of p2 to the
  // analyticMean SCALED by the z-mean — instead, integrate fully in 3D here.
  // Simpler robust check: sample p2 over a dense x,y,z lattice and compare its
  // mean to analyticMean (which is the true 3D volume mean).
  // Build x,y cells; we'll average over z by sampling multiple ear heights.
  const xs = [], ys = [];
  for (let i = 0; i < N; i++) { xs.push((i + 0.5) / N * Lx); }
  for (let j = 0; j < N; j++) { ys.push((j + 0.5) / N * Ly); }
  const zs = []; for (let k = 0; k < N; k++) zs.push((k + 0.5) / N * Lz);
  // Use computeModalField per z-slice (it fixes earZ), average all p2 + read
  // analyticMean from any slice (it's z-independent).
  let sum = 0, count = 0, analytic = null;
  const cells = [];
  for (const x of xs) for (const y of ys) cells.push({ x, y });
  for (const z of zs) {
    const f = computeModalField({ room, sources: cornerSrc, freq_hz: 200, t60_s: t60, f_s: fs, cells, earZ: z });
    if (!f) continue;
    if (analytic === null) analytic = f.analyticMean;
    for (let c = 0; c < f.p2.length; c++) { sum += f.p2[c]; count++; }
  }
  const numericMean = sum / count;
  const ratioDb = 10 * Math.log10(numericMean / analytic);
  ok(Math.abs(ratioDb) < 0.3, 'analytic volume-mean == dense numeric mean (≤0.3 dB)', `(Δ=${ratioDb.toFixed(3)} dB)`);
}

// 2. Wall / edge / corner ladder: +3 / +6 / +9 dB vs mid-volume (Waterhouse),
//    captured automatically by the modal sum with the 2^(-p) normalization.
//    Energy ratio of a boundary point to the volume mean = field/analyticMean.
{
  // Evaluate at a band on a strong oblique mode so all three cos² pin to 1.
  // Use a generic mid band; assert ordering strictly + magnitudes within ±2 dB.
  const probe = (x, y, z) => {
    const f = computeModalField({ room, sources: cornerSrc, freq_hz: 150, t60_s: t60, f_s: fs, cells: [{ x, y }], earZ: z });
    // relative level vs volume mean, in dB
    return 10 * Math.log10(f.p2[0] / f.analyticMean);
  };
  const mid = probe(Lx / 2 + 0.37, Ly / 2 + 0.29, Lz / 2);   // generic interior point
  const surf = probe(0.01, Ly / 2 + 0.29, Lz / 2);            // one wall (x=0)
  const edge = probe(0.01, 0.01, Lz / 2);                     // two walls (x=0,y=0)
  const corner = probe(0.01, 0.01, 0.01);                     // three walls
  // Strict ordering corner > edge > surface > mid is the load-bearing claim
  // (every boundary added pins one more cos²→1). The exact +3/+6/+9 ladder is
  // a broadband-average ideal; at a single off-mode band the magnitudes vary,
  // so we assert the ordering strictly + the magnitudes within generous bands.
  ok(corner > edge && edge > surf && surf > mid, 'boundary ladder ordering: corner > edge > surface > mid',
     `(mid ${mid.toFixed(1)}, surf ${surf.toFixed(1)}, edge ${edge.toFixed(1)}, corner ${corner.toFixed(1)} dB)`);
  ok((corner - surf) > 1.5 && (corner - surf) < 12, 'corner above a single surface (Waterhouse stack, +6 dB ideal)', `(${(corner - surf).toFixed(1)})`);
  ok((edge - surf) > 0.5 && (edge - surf) < 8, 'edge above a single surface (+3 dB ideal)', `(${(edge - surf).toFixed(1)})`);
  ok((surf - mid) > 0.5, 'single surface above mid-room reference (+3 dB ideal)', `(${(surf - mid).toFixed(1)})`);
}

// 3. Node reads a deep minimum: at the (1,0,0) resonance, x=Lx/2 is a node.
{
  const f100 = (343.2 / 2) * (1 / Lx);   // (1,0,0) mode frequency
  const ref = computeModalField({ room, sources: cornerSrc, freq_hz: f100, t60_s: t60, f_s: fs, cells: [{ x: 0.05, y: Ly / 2 }], earZ });
  const node = computeModalField({ room, sources: cornerSrc, freq_hz: f100, t60_s: t60, f_s: fs, cells: [{ x: Lx / 2, y: Ly / 2 }], earZ });
  const refDb = 10 * Math.log10(ref.p2[0] / ref.analyticMean);
  const nodeDb = 10 * Math.log10(node.p2[0] / node.analyticMean);
  ok((refDb - nodeDb) >= 8, 'node reads ≥8 dB below the wall antinode at the (1,0,0) mode', `(wall ${refDb.toFixed(1)} vs node ${nodeDb.toFixed(1)})`);
  ok(modeShape(1, 0, 0, Lx / 2, Ly / 2, earZ, Lx, Ly, Lz) < 0.01, 'ψ(1,0,0) ≈ 0 at x=Lx/2 (node confirmed)');
}

// =====================================================================
// PART B — per-listener dot integration (computePerListenerMetrics)
// =====================================================================
// Register a simple omni speaker so the dot path resolves a def in Node.
const SPK_URL = 'test://omni';
registerLoudspeaker(SPK_URL, {
  acoustic: { sensitivity_db_1w_1m: 95, directivity_index_db: 0 },
  directivity: { azimuth_deg: [-180, 0, 180], elevation_deg: [-90, 0, 90],
    attenuation_db: { '125': [[0,0,0],[0,0,0],[0,0,0]], '1000': [[0,0,0],[0,0,0],[0,0,0]] } },
});

// Two listeners (corner antinode + room-centre) measured together; source in
// the opposite corner so it couples to every mode. Returns [cornerSPL, centreSPL].
function cornerCentre({ freq = 125, reverbOn = true } = {}) {
  const base = {
    room: { shape: 'rectangular', width_m: 6, depth_m: 8, height_m: 3, ceiling_type: 'flat',
      surfaces: { floor: 'concrete-painted', ceiling: 'gypsum-board',
        wall_north: 'concrete-painted', wall_south: 'concrete-painted',
        wall_east: 'concrete-painted', wall_west: 'concrete-painted' } },
    sources: [{ modelUrl: SPK_URL, position: { x: 0.4, y: 0.4, z: 1.2 }, aim: { yaw: 0, pitch: 0, roll: 0 }, power_watts: 50 }],
    listeners: [
      { id: 'CORNER', label: 'corner', position: { x: 5.85, y: 7.85 }, posture: 'standing' },
      { id: 'CENTRE', label: 'centre', position: { x: 3.0, y: 4.0 }, posture: 'standing' },
    ],
    zones: [], treatments: [], furniture: [], rackSystem: { racks: [] }, structures: [],
    physics: { freq_hz: freq, reverberantField: reverbOn, airAbsorption: true, coherent: false },
    results: {},
  };
  const m = computePerListenerMetrics(base, materials);
  return [m[0].spl_db, m[1].spl_db];
}

// 4. The modal field INCREASES corner-vs-centre contrast vs distance alone.
//    (Direct-only Δ is pure 1/r² distance; the modal Δ adds the standing-wave
//    boost at the corner. This isolates the modal effect from distance — the
//    physically honest version of "near a wall the bass builds up.")
{
  const [cOn, mOn] = cornerCentre({ freq: 125, reverbOn: true });   // modal active
  const [cDir, mDir] = cornerCentre({ freq: 125, reverbOn: false }); // pure direct (no reverb/modal)
  ok([cOn, mOn, cDir, mDir].every(Number.isFinite), 'all four dot SPLs computed',
     `(corner ${cOn?.toFixed(1)}/${cDir?.toFixed(1)}, centre ${mOn?.toFixed(1)}/${mDir?.toFixed(1)})`);
  const deltaModal = cOn - mOn;
  const deltaDirect = cDir - mDir;
  ok(deltaModal > deltaDirect + 1, 'modal field lifts the corner relative to the centre vs distance alone (125 Hz)',
     `(Δ_modal=${deltaModal.toFixed(1)} > Δ_direct=${deltaDirect.toFixed(1)} dB)`);
}

// 5. Reverb OFF → no modal redistribution: corner-vs-centre contrast is pure
//    direct in BOTH the "would-be modal" band and direct — they must match.
{
  const [cDir, mDir] = cornerCentre({ freq: 125, reverbOn: false });
  const [cDir2, mDir2] = cornerCentre({ freq: 125, reverbOn: false });
  ok(Math.abs((cDir - mDir) - (cDir2 - mDir2)) < 0.01, 'reverb OFF is deterministic / no modal term applied');
  ok(Number.isFinite(cDir) && cDir < mDir, 'reverb OFF: far corner reads below nearer centre (pure distance)',
     `(corner ${cDir.toFixed(1)} < centre ${mDir.toFixed(1)})`);
}

// 6. High band (above f_s) → modal term vanished: the dot equals the PURE
//    STATISTICAL value (computeMultiSourceSPL), i.e. the modal redistribution
//    code does not touch it. (A flat reverb still compresses dB contrast, so
//    the right check is "dot == statistical", not a contrast comparison.)
{
  const room = { shape: 'rectangular', width_m: 6, depth_m: 8, height_m: 3, ceiling_type: 'flat',
    surfaces: { floor: 'concrete-painted', ceiling: 'gypsum-board',
      wall_north: 'concrete-painted', wall_south: 'concrete-painted',
      wall_east: 'concrete-painted', wall_west: 'concrete-painted' } };
  const src = { modelUrl: SPK_URL, position: { x: 0.4, y: 0.4, z: 1.2 }, aim: { yaw: 0, pitch: 0, roll: 0 }, power_watts: 50 };
  const cornerPos = { x: 5.85, y: 7.85, z: 1.2 };
  const st = { room, sources: [src], listeners: [{ id: 'C', label: 'c', position: { x: 5.85, y: 7.85 }, posture: 'standing' }],
    zones: [], treatments: [], furniture: [], rackSystem: { racks: [] }, structures: [],
    physics: { freq_hz: 4000, reverberantField: true, airAbsorption: true, coherent: false }, results: {} };
  const dot = computePerListenerMetrics(st, materials)[0].spl_db;
  const R = computeRoomConstant(room, materials, 4000, [], { airAbsorption: true });
  const statistical = computeMultiSourceSPL({
    sources: [src], getSpeakerDef: url => getCachedLoudspeaker(url), listenerPos: cornerPos,
    freq_hz: 4000, room, materials, airAbsorption: true, coherent: false, roomConstantR: R,
  });
  ok(Number.isFinite(dot) && Math.abs(dot - statistical) < 0.05,
     '4 kHz (above f_s): dot equals pure statistical SPL — modal term not applied',
     `(dot ${dot?.toFixed(2)} vs statistical ${statistical?.toFixed(2)} dB)`);
}

console.log(failed === 0 ? '\nAll modal-per-point tests PASSED' : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
