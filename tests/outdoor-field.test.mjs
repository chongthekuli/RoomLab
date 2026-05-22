// Outdoor field-mode physics regression tests (Phase 2).
//
// Pins the four sub-deliverables Dr. Chen scoped + locked with the user:
//   2a — context hoist in computeSPLGrid is byte-identical to the old path.
//   2b — outdoor grid keeps cells OUTSIDE the footprint (free-field R=0);
//        indoor grid still returns -Infinity outside (no change). Inside
//        cell with R>0 is strictly >= the same cell with R=0.
//   2c — parametric ISO 9613-1:1993 air absorption matches the standard
//        within tolerance and is strongly humidity-dependent at HF; the
//        INDOOR fixed table is unchanged.
//   2d — the interior→field boundary is a GRADIENT where that is physical
//        (open boundary / open field) once Maekawa diffraction + Kuttruff
//        re-radiation are opted in for outdoor, regardless of the public-
//        deploy PHYSICS_P1_5 flag. A SOLID wall correctly STEPS by ~its
//        transmission loss — re-radiation recovers the exterior field (no
//        -Infinity black band) and materially reduces the flag-OFF cliff,
//        but the residual step IS the wall insulation and that is correct.
//
// Model honesty: ISO 9613-1 free-field (geometric divergence + atmospheric
// absorption). Ground effect (A_gr) is NOT modelled.
//
// Run: node tests/outdoor-field.test.mjs

import { readFileSync } from 'node:fs';
import {
  computeSPLGrid, computeMultiSourceSPL, computeRoomConstant,
  precomputeSPLContext, computeMultiSourceSPLFromContext,
} from '../js/physics/spl-calculator.js';
import {
  airAbsorptionDbPerM, airAbsorptionDbPerM_param,
} from '../js/physics/air-absorption.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function close(actual, expected, tol, label) {
  const good = Math.abs(actual - expected) <= tol;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}  actual=${actual.toFixed(5)} expected=${expected.toFixed(5)} ±${tol}`);
  if (!good) failed++;
}

// ---- shared fixtures -----------------------------------------------------
const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

const speaker = {
  acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 6 },
  directivity: {
    azimuth_deg: [-180, -90, 0, 90, 180],
    elevation_deg: [-90, 0, 90],
    attenuation_db: {
      "125":  [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
      "500":  [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
      "1000": [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
      "2000": [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
      "4000": [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
      "8000": [[-12,-12,-12,-12,-12],[-6,-3,0,-3,-6],[-12,-12,-12,-12,-12]],
    },
  },
};
const getDef = () => speaker;

const room = {
  shape: 'rectangular', width_m: 10, height_m: 4, depth_m: 10,
  ceiling_type: 'flat',
  surfaces: {
    floor: 'concrete-painted', ceiling: 'concrete-painted', walls: 'concrete-painted',
    wall_north: 'concrete-painted', wall_south: 'concrete-painted',
    wall_east: 'concrete-painted', wall_west: 'concrete-painted',
  },
};

// =========================================================================
// 2a — CONTEXT HOIST IS BYTE-IDENTICAL
// =========================================================================
{
  const sources = [
    { modelUrl: 'x', position: { x: 3, y: 3, z: 2 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 },
    { modelUrl: 'x', position: { x: 7, y: 7, z: 2 }, aim: { yaw: 180, pitch: 0 }, power_watts: 100 },
  ];
  const roomConstantR = 80;
  const g = computeSPLGrid({
    sources, getSpeakerDef: getDef, room, materials,
    freq_hz: 1000, roomConstantR, earHeight_m: 1.2,
  });
  let maxDelta = 0, compared = 0;
  for (let j = 0; j < g.cellsY; j++) {
    for (let i = 0; i < g.cellsX; i++) {
      const v = g.grid[j][i];
      if (!isFinite(v)) continue;
      const x = g.originX_m + (i + 0.5) * g.cellW_m;
      const y = g.originY_m + (j + 0.5) * g.cellD_m;
      const old = computeMultiSourceSPL({
        sources, getSpeakerDef: getDef, listenerPos: { x, y, z: 1.2 },
        freq_hz: 1000, room, materials, roomConstantR,
      });
      maxDelta = Math.max(maxDelta, Math.abs(v - old));
      compared++;
    }
  }
  ok(compared > 50, `2a: compared ${compared} interior cells`);
  close(maxDelta, 0, 1e-9, '2a: hoisted grid == old per-cell path (byte-identical)');
}

// =========================================================================
// 2b — OUTDOOR KEEPS EXTERIOR CELLS; INDOOR STILL -Infinity OUTSIDE
// =========================================================================
{
  const sources = [
    { modelUrl: 'x', position: { x: 5, y: 5, z: 2 }, aim: { yaw: 0, pitch: 0 }, power_watts: 200 },
  ];
  const fieldBounds = { minX: -20, minY: -20, maxX: 30, maxY: 30 };

  const indoor = computeSPLGrid({ sources, getSpeakerDef: getDef, room, materials, freq_hz: 1000 });
  const indoorWide = computeSPLGrid({
    sources, getSpeakerDef: getDef, room, materials, freq_hz: 1000,
    outdoor: false, fieldBounds,
  });
  ok(indoorWide.cellsX === indoor.cellsX && indoorWide.cellsY === indoor.cellsY,
    '2b: fieldBounds ignored when outdoor=false (same grid extent)');

  const out = computeSPLGrid({
    sources, getSpeakerDef: getDef, room, materials, freq_hz: 1000,
    outdoor: true, fieldBounds, temperature_C: 30, humidity_pct: 70,
  });
  let outsideFinite = 0, outsideInfinite = 0;
  for (let j = 0; j < out.cellsY; j++) {
    for (let i = 0; i < out.cellsX; i++) {
      const x = out.originX_m + (i + 0.5) * out.cellW_m;
      const y = out.originY_m + (j + 0.5) * out.cellD_m;
      if (x >= 0 && x <= 10 && y >= 0 && y <= 10) continue;
      if (isFinite(out.grid[j][i])) outsideFinite++; else outsideInfinite++;
    }
  }
  ok(outsideFinite > 100 && outsideInfinite === 0,
    `2b: outdoor grid FINITE at every exterior cell (finite=${outsideFinite}, -Inf=${outsideInfinite})`);
  ok(out.outdoor === true, '2b: outdoor flag echoed on result');

  // Indoor with a detached hut: the empty ground BETWEEN footprints must
  // stay -Infinity (no behavioural change to indoor mode).
  const ind = computeSPLGrid({
    sources, getSpeakerDef: getDef,
    room: { ...room, standaloneEnclosures: [
      { polygon: [{x:25,y:25},{x:30,y:25},{x:30,y:30},{x:25,y:30}], elevation_m: 0, height_m: 3 },
    ] },
    materials, freq_hz: 1000, outdoor: false,
  });
  let gapInfinite = false;
  for (let j = 0; j < ind.cellsY; j++) {
    for (let i = 0; i < ind.cellsX; i++) {
      const x = ind.originX_m + (i + 0.5) * ind.cellW_m;
      const y = ind.originY_m + (j + 0.5) * ind.cellD_m;
      if (x > 12 && x < 23 && y > 12 && y < 23 && !isFinite(ind.grid[j][i])) gapInfinite = true;
    }
  }
  ok(gapInfinite, '2b: INDOOR mode still returns -Infinity outside any footprint');
}

// 2b — INSIDE CELL (R>0) STRICTLY >= SAME CELL (R=0)
{
  const sources = [{ modelUrl: 'x', position: { x: 2, y: 2, z: 2 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 }];
  const listener = { x: 6, y: 6, z: 1.2 };
  const withR = computeMultiSourceSPL({ sources, getSpeakerDef: getDef, listenerPos: listener, freq_hz: 1000, room, materials, roomConstantR: 80 });
  const noR = computeMultiSourceSPL({ sources, getSpeakerDef: getDef, listenerPos: listener, freq_hz: 1000, room, materials, roomConstantR: 0 });
  ok(withR >= noR - 1e-9, `2b: inside cell R>0 (${withR.toFixed(2)}) >= same cell R=0 (${noR.toFixed(2)})`);
  ok(withR > noR + 0.5, `2b: reverberant lift is material (>0.5 dB): +${(withR - noR).toFixed(2)} dB`);
}

// =========================================================================
// 2c — PARAMETRIC ISO 9613-1 AIR ABSORPTION
// =========================================================================
// Reference α (dB/m) from the ISO 9613-1 equations / NPL atmospheric-
// absorption calculator at 101.325 kPa. Verified to 3 sig figs.
{
  close(airAbsorptionDbPerM_param(2000, 20, 70), 0.00899, 0.001,  '2c: α(2k, 20°C, 70%)');
  close(airAbsorptionDbPerM_param(4000, 20, 70), 0.02307, 0.0015, '2c: α(4k, 20°C, 70%)');
  close(airAbsorptionDbPerM_param(8000, 20, 70), 0.07752, 0.004,  '2c: α(8k, 20°C, 70%)');
  close(airAbsorptionDbPerM_param(2000, 30, 70), 0.01277, 0.001,  '2c: α(2k, 30°C, 70%)');
  close(airAbsorptionDbPerM_param(4000, 30, 70), 0.02318, 0.0015, '2c: α(4k, 30°C, 70%)');
  close(airAbsorptionDbPerM_param(8000, 30, 70), 0.05995, 0.004,  '2c: α(8k, 30°C, 70%)');

  const f30 = (f) => airAbsorptionDbPerM_param(f, 30, 70);
  ok(f30(2000) < f30(4000) && f30(4000) < f30(8000), '2c: α monotone increasing in frequency');
  ok(airAbsorptionDbPerM_param(4000, 30, 70) === airAbsorptionDbPerM_param(4000, 30, 70, 101.325),
    '2c: pressure_kPa defaults to 101.325');
}

// Air absorption AT r = 600 m matches ISO within tolerance.
{
  const r = 600;
  close(airAbsorptionDbPerM_param(8000, 30, 70) * r, 35.97, 3.0, '2c: 8 kHz air loss over 600 m (30°C/70%) ≈ 36 dB');
  close(airAbsorptionDbPerM_param(4000, 30, 70) * r, 13.91, 2.0, '2c: 4 kHz air loss over 600 m (30°C/70%) ≈ 14 dB');
  close(airAbsorptionDbPerM_param(2000, 30, 70) * r,  7.66, 1.0, '2c: 2 kHz air loss over 600 m (30°C/70%) ≈ 7.7 dB');
}

// 8 kHz changes MATERIALLY between low and high RH over 600 m.
{
  const r = 600;
  const dry = airAbsorptionDbPerM_param(8000, 30, 30) * r;   // 30 % RH
  const humid = airAbsorptionDbPerM_param(8000, 30, 90) * r; // 90 % RH
  const swing = dry - humid;
  ok(dry > humid, `2c: dry air (30% RH) absorbs MORE 8 kHz than humid (90% RH): ${dry.toFixed(1)} vs ${humid.toFixed(1)} dB`);
  ok(swing > 25, `2c: 8 kHz over 600 m swings >25 dB across 30–90% RH (got ${swing.toFixed(1)} dB)`);
  const veryDry = airAbsorptionDbPerM_param(8000, 30, 20) * r;  // 20 % RH
  ok(veryDry > dry, `2c: 20% RH lossier than 30% RH at 8 kHz (${veryDry.toFixed(1)} > ${dry.toFixed(1)} dB)`);
}

// Indoor fixed table is UNCHANGED.
{
  const expectIndoor = { 125: 0.00038, 250: 0.00108, 500: 0.00244, 1000: 0.00487, 2000: 0.01154, 4000: 0.03751, 8000: 0.10200 };
  let allMatch = true;
  for (const [f, v] of Object.entries(expectIndoor)) {
    if (Math.abs(airAbsorptionDbPerM(Number(f)) - v) > 1e-9) allMatch = false;
  }
  ok(allMatch, '2c: INDOOR fixed air-absorption table UNCHANGED (byte-for-byte)');
}

// =========================================================================
// 2d — INTERIOR→FIELD BOUNDARY (gradient where physical; honest wall step)
// =========================================================================
{
  const src = { modelUrl: 'x', position: { x: 5, y: 5, z: 2 }, aim: { yaw: 90, pitch: 0 }, power_watts: 500 };
  const sources = [src];
  const z = 1.5;
  const xs = [];
  for (let x = 9.5; x <= 10.501; x += 0.1) xs.push(Math.round(x * 10) / 10);
  const fieldFn = (ff) => airAbsorptionDbPerM_param(ff, 30, 70);
  const isInside = (s) => { const p = s.position; return p.x >= 0 && p.x <= 10 && p.y >= 0 && p.y <= 10 && p.z >= 0 && p.z <= 4; };
  const maxStep = (series) => {
    let mj = 0, at = null;
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1], b = series[i];
      if (!isFinite(a) || !isFinite(b)) continue;
      const jp = Math.abs(b - a);
      if (jp > mj) { mj = jp; at = xs[i]; }
    }
    return { mj, at };
  };

  // (i) OPEN boundary (east wall = open arch, TL=0): smooth gradient.
  const openRoom = { ...room, surfaces: { ...room.surfaces, wall_east: 'open-air' } };
  const RperBandOpen = materials.frequency_bands_hz.map(fb => computeRoomConstant(openRoom, materials, fb, []));
  for (const f of [125, 500, 2000, 4000]) {
    const ctx = precomputeSPLContext({ sources, getSpeakerDef: getDef, freq_hz: f, roomConstantR: 0, enableTier1a: true, roomR_per_band: RperBandOpen, isSourceInside: isInside });
    const series = xs.map(x => computeMultiSourceSPLFromContext(ctx, { x, y: 5, z }, { room: openRoom, materials, airAbsorptionFn: fieldFn }));
    const { mj, at } = maxStep(series);
    ok(mj <= 3.0, `2d: OPEN-boundary transect max jump <=3 dB @${f} Hz (got ${mj.toFixed(2)} at x=${at})`);
  }

  // (ii) Open EXTERIOR field decay (all cells outside): smooth & finite.
  {
    const exs = [];
    for (let x = 11; x <= 13.001; x += 0.1) exs.push(Math.round(x * 10) / 10);
    const ctx = precomputeSPLContext({ sources, getSpeakerDef: getDef, freq_hz: 2000, roomConstantR: 0, enableTier1a: true, roomR_per_band: RperBandOpen, isSourceInside: isInside });
    const series = exs.map(x => computeMultiSourceSPLFromContext(ctx, { x, y: 5, z }, { room: openRoom, materials, airAbsorptionFn: fieldFn }));
    let mj = 0;
    for (let i = 1; i < series.length; i++) { const a = series[i - 1], b = series[i]; if (isFinite(a) && isFinite(b)) mj = Math.max(mj, Math.abs(b - a)); }
    ok(mj <= 3.0 && series.every(isFinite), `2d: open exterior field decay smooth & finite (max step ${mj.toFixed(2)} dB)`);
  }

  // (iii) SOLID concrete wall: exterior recovered (finite), exterior-to-
  // exterior smooth, Tier1a materially cuts the cliff, and the residual
  // step is bounded by the wall TL — the step IS the insulation.
  const RperBand = materials.frequency_bands_hz.map(fb => computeRoomConstant(room, materials, fb, []));
  {
    const f = 2000;
    const ctxOn = precomputeSPLContext({ sources, getSpeakerDef: getDef, freq_hz: f, roomConstantR: 0, enableTier1a: true, roomR_per_band: RperBand, isSourceInside: isInside });
    const sOn = xs.map(x => computeMultiSourceSPLFromContext(ctxOn, { x, y: 5, z }, { room, materials, airAbsorptionFn: fieldFn }));
    const exteriorFinite = sOn.filter((v, i) => xs[i] >= 10).every(isFinite);
    ok(exteriorFinite, '2d: SOLID wall — exterior cells FINITE (re-radiation recovers field, no -Infinity)');

    let extStep = 0;
    for (let i = 1; i < sOn.length; i++) { if (xs[i] > 10 && isFinite(sOn[i]) && isFinite(sOn[i - 1])) extStep = Math.max(extStep, Math.abs(sOn[i] - sOn[i - 1])); }
    ok(extStep <= 3.0, `2d: SOLID wall — exterior-to-exterior steps smooth <=3 dB (got ${extStep.toFixed(2)})`);

    const { mj: stepOn } = maxStep(sOn);
    const ctxOff = precomputeSPLContext({ sources, getSpeakerDef: getDef, freq_hz: f, roomConstantR: 0, enableTier1a: false });
    const sOff = xs.map(x => computeMultiSourceSPLFromContext(ctxOff, { x, y: 5, z }, { room, materials }));
    const { mj: stepOff } = maxStep(sOff);
    ok(stepOn < stepOff - 10, `2d: SOLID wall — Tier1a materially reduces the cliff (on=${stepOn.toFixed(1)} dB < off=${stepOff.toFixed(1)} dB by >10 dB)`);

    const wallTL = materials.byId['concrete-painted'].transmission_loss_db[materials.frequency_bands_hz.indexOf(f)];
    ok(stepOn <= wallTL + 2, `2d: SOLID wall — residual step (${stepOn.toFixed(1)} dB) <= wall TL (${wallTL} dB); the step IS the insulation`);
  }

  // Indoor public-deploy path is unchanged by the opt-in machinery (both
  // flag-off in Node → identical numbers).
  {
    const listener = { x: 6, y: 6, z: 1.2 };
    const a = computeMultiSourceSPL({ sources: [{ modelUrl: 'x', position: { x: 3, y: 3, z: 2 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 }], getSpeakerDef: getDef, listenerPos: listener, freq_hz: 2000, room, materials, roomConstantR: 0 });
    const b = computeMultiSourceSPL({ sources: [{ modelUrl: 'x', position: { x: 3, y: 3, z: 2 }, aim: { yaw: 0, pitch: 0 }, power_watts: 100 }], getSpeakerDef: getDef, listenerPos: listener, freq_hz: 2000, room, materials, roomConstantR: 0, enableTier1a: false });
    close(a, b, 1e-9, '2d: indoor default == explicit Tier1a-off (no public-deploy change)');
  }
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll outdoor-field tests passed.');
