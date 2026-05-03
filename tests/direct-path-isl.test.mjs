// W.1 — direct-path inverse-square-law sanity test.
//
// Per the auralization architecture spec (Hannes / Dr. Chen, 2026-05-03)
// gate criterion: "Step through 1 m, 2 m, 4 m, 8 m from a single source.
// Direct-path SPL must drop 6 dB per doubling within 0.2 dB."
//
// Plus two complementary checks:
//   • subtractAnalyticalDirect → the bucket the tracer injected into is
//     zero after subtraction, OTHER buckets are untouched, and other
//     receivers are untouched.
//   • Source directivity (raised-cosine lobe) — moving off-axis drops
//     SPL by exactly 10·log10(D(θ)) compared to on-axis.
//
// Run: node tests/direct-path-isl.test.mjs

import {
  computeAnalyticalDirectEnergy, computeDirectPathSPL,
  subtractAnalyticalDirect, sourceCentroid, broadbandSourceLwDb,
  computeBroadbandDirectSPL,
} from '../js/audio/direct-path.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const SPEED_OF_SOUND = 343.2;

// --- 1. Inverse-square law: 6 dB per doubling within 0.2 dB ---------
{
  // Single omni source, L_w = 100 dB broadband, no air absorption (so
  // we test the geometric law in isolation; HF absorption is checked
  // separately below).
  const sourcePos = { x: 0, y: 0, z: 0 };
  const sourceAim = { x: 0, y: 1, z: 0 };
  const lobeN = 0;            // omnidirectional
  const lwDb = 100;
  const distances = [1, 2, 4, 8];
  const splValues = distances.map(d =>
    computeDirectPathSPL({
      sourcePos, sourceAim, sourceLobeN: lobeN,
      sourceLwBroadband_db: lwDb,
      receiverPos: { x: 0, y: d, z: 0 },
      airAbsorption: false,
    })
  );
  for (let i = 1; i < distances.length; i++) {
    const drop = splValues[i - 1] - splValues[i];
    const expected = 6.02;     // 20·log10(2)
    const within = Math.abs(drop - expected) < 0.2;
    assert(within,
      `ISL: ${distances[i - 1]} m → ${distances[i]} m drops ${drop.toFixed(3)} dB ` +
      `(expected ${expected.toFixed(2)} ± 0.2)`);
  }
}

// --- 2. Air absorption is monotonic with distance --------------------
{
  const sourcePos = { x: 0, y: 0, z: 0 };
  const sourceAim = { x: 0, y: 1, z: 0 };
  const lwDb = 100;
  const splWith = (d, withAir) => computeDirectPathSPL({
    sourcePos, sourceAim, sourceLobeN: 0,
    sourceLwBroadband_db: lwDb,
    receiverPos: { x: 0, y: d, z: 0 },
    airAbsorption: withAir,
  });
  // At 10 m, 1 kHz air absorption ≈ 0.013 dB/m → 0.13 dB total. Small
  // but non-zero. Sanity: with-air strictly less than without-air.
  const dry = splWith(10, false);
  const damp = splWith(10, true);
  assert(damp < dry, `air abs reduces SPL at 10 m (dry ${dry.toFixed(2)} > damp ${damp.toFixed(2)})`);
  assert(Math.abs((dry - damp) - 0.13) < 0.05,
    `air abs at 10 m ≈ 0.13 dB (got ${(dry - damp).toFixed(3)})`);
}

// --- 3. Directivity lobe — on-axis vs 90° off-axis -------------------
{
  // Source aimed +y; receiver at (1, 0, 0) is 90° off-axis.
  // For a cardioid lobe (n=1): D(θ) = 2·((1+cosθ)/2)¹.
  // At θ=0: D=2 → 10·log10(2) = 3.01 dB on-axis gain over omni.
  // At θ=90°: D=2·0.5 = 1 → 0 dB (cardioid is omni at 90°).
  // At θ=180°: D=0 → -∞ dB (cardioid null).
  const sourcePos = { x: 0, y: 0, z: 0 };
  const sourceAim = { x: 0, y: 1, z: 0 };
  const lwDb = 100;
  const onAxis = computeDirectPathSPL({
    sourcePos, sourceAim, sourceLobeN: 1, sourceLwBroadband_db: lwDb,
    receiverPos: { x: 0, y: 1, z: 0 }, airAbsorption: false,
  });
  const offAxis90 = computeDirectPathSPL({
    sourcePos, sourceAim, sourceLobeN: 1, sourceLwBroadband_db: lwDb,
    receiverPos: { x: 1, y: 0, z: 0 }, airAbsorption: false,
  });
  assert(Math.abs((onAxis - offAxis90) - 3.01) < 0.05,
    `cardioid: on-axis +3.01 dB over 90° off-axis (got ${(onAxis - offAxis90).toFixed(3)})`);

  // Aim-flip sanity (per project memory feedback_directivity_aim_flip):
  // flipping the aim 180° must drop on-axis SPL noticeably. n=2 lobe.
  const aim_back = { x: 0, y: -1, z: 0 };
  const onAxisOriginalAim = computeDirectPathSPL({
    sourcePos, sourceAim, sourceLobeN: 2, sourceLwBroadband_db: lwDb,
    receiverPos: { x: 0, y: 1, z: 0 }, airAbsorption: false,
  });
  const onAxisFlippedAim = computeDirectPathSPL({
    sourcePos, sourceAim: aim_back, sourceLobeN: 2, sourceLwBroadband_db: lwDb,
    receiverPos: { x: 0, y: 1, z: 0 }, airAbsorption: false,
  });
  assert(onAxisOriginalAim - onAxisFlippedAim > 10,
    `aim-flip on n=2 lobe: aim-towards listener > 10 dB louder than aim-away ` +
    `(got Δ ${(onAxisOriginalAim - onAxisFlippedAim).toFixed(2)} dB)`);
}

// --- 4. subtractAnalyticalDirect — single source, single receiver ----
{
  const B = 7;             // bands
  const T = 800;           // buckets
  const R = 1;             // receivers
  const bucketDtMs = 2;
  // Source 5 m from receiver → arrival t = 5 / 343.2 ≈ 14.57 ms → bucket 7.
  const sourcePos = [0, 0, 0];
  const recPos = [0, 5, 0];
  const sourceLw = new Float32Array(B);
  for (let k = 0; k < B; k++) sourceLw[k] = 100;
  const aim = new Float32Array([0, 1, 0]);
  const dirN = new Float32Array([0]);
  const recRadii = new Float32Array([0.1]);
  const histogram = new Float32Array(R * B * T);
  // Inject a known analytical direct value (mimicking the tracer's
  // Phase 11.A behaviour, but at 1.0 worker share for test simplicity).
  const expected = computeAnalyticalDirectEnergy({
    sourcePos: { x: sourcePos[0], y: sourcePos[1], z: sourcePos[2] },
    sourceAim: { x: aim[0], y: aim[1], z: aim[2] },
    sourceLobeN: dirN[0],
    sourceLwPerBand: sourceLw,
    receiverPos: { x: recPos[0], y: recPos[1], z: recPos[2] },
    receiverRadius_m: recRadii[0],
    bands_count: B,
    airAbsorption: false,
  });
  const arrival_s = 5 / SPEED_OF_SOUND;
  const directBucket = Math.floor((arrival_s * 1000) / bucketDtMs);
  for (let k = 0; k < B; k++) {
    histogram[0 * B * T + k * T + directBucket] = expected[k];
  }
  // Also put noise in OTHER buckets so we can verify they're untouched.
  histogram[0 * B * T + 0 * T + 50] = 1e-6;       // band 0 bucket 50
  histogram[0 * B * T + 3 * T + 200] = 5e-7;      // band 3 bucket 200

  const cleaned = subtractAnalyticalDirect({
    histogram, shape: { receivers: R, bands: B, buckets: T },
    bucketDtMs,
    scene: {
      sources: { count: 1, positions: sourcePos, L_w: sourceLw, aims: aim, dirN },
      receivers: { count: R, positions: recPos, radii: recRadii },
      bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000],
    },
    receiverIdx: 0,
    airAbsorption: false,
  });

  // Direct buckets should now be zero.
  let directZeroed = true;
  for (let k = 0; k < B; k++) {
    if (cleaned[0 * B * T + k * T + directBucket] > 1e-10) directZeroed = false;
  }
  assert(directZeroed, 'subtract: direct-arrival buckets are zero after subtraction');

  // Other buckets should be untouched.
  assert(Math.abs(cleaned[0 * B * T + 0 * T + 50] - 1e-6) < 1e-12,
    'subtract: unrelated bucket band 0 t 50 untouched');
  assert(Math.abs(cleaned[0 * B * T + 3 * T + 200] - 5e-7) < 1e-12,
    'subtract: unrelated bucket band 3 t 200 untouched');
}

// --- 5. subtractAnalyticalDirect — multi-receiver isolation ----------
{
  // Two receivers, only receiverIdx=1 should be touched.
  const B = 7, T = 400, R = 2;
  const bucketDtMs = 2;
  const sourcePos = [0, 0, 0];
  const recPos = [
    0, 3, 0,        // r0 — 3 m
    0, 6, 0,        // r1 — 6 m
  ];
  const sourceLw = new Float32Array(B);
  for (let k = 0; k < B; k++) sourceLw[k] = 100;
  const aim = new Float32Array([0, 1, 0]);
  const dirN = new Float32Array([0]);
  const recRadii = new Float32Array([0.1, 0.1]);
  const histogram = new Float32Array(R * B * T);
  for (let r = 0; r < R; r++) {
    for (let k = 0; k < B; k++) {
      for (let b = 0; b < T; b++) histogram[r * B * T + k * T + b] = 1e-9;
    }
  }
  const cleaned = subtractAnalyticalDirect({
    histogram, shape: { receivers: R, bands: B, buckets: T },
    bucketDtMs,
    scene: {
      sources: { count: 1, positions: sourcePos, L_w: sourceLw, aims: aim, dirN },
      receivers: { count: R, positions: recPos, radii: recRadii },
      bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000],
    },
    receiverIdx: 1,
    airAbsorption: false,
  });

  // r0 should be EXACTLY equal to the input (untouched).
  let r0Untouched = true;
  for (let k = 0; k < B; k++) {
    for (let b = 0; b < T; b++) {
      if (Math.abs(cleaned[0 * B * T + k * T + b] - histogram[0 * B * T + k * T + b]) > 1e-15) {
        r0Untouched = false;
        break;
      }
    }
    if (!r0Untouched) break;
  }
  assert(r0Untouched, 'subtract: r0 untouched when subtracting from r1');

  // r1 direct bucket should be lower than its input.
  const arrival_s = 6 / SPEED_OF_SOUND;
  const directBucket = Math.floor((arrival_s * 1000) / bucketDtMs);
  let r1DirectReduced = true;
  for (let k = 0; k < B; k++) {
    if (cleaned[1 * B * T + k * T + directBucket] >= histogram[1 * B * T + k * T + directBucket]) {
      r1DirectReduced = false;
      break;
    }
  }
  assert(r1DirectReduced, 'subtract: r1 direct bucket reduced after subtraction');
}

// --- 6. sourceCentroid + broadbandSourceLwDb sanity ------------------
{
  // Two equally-loud omni sources at (0,0,0) and (10,0,0). Centroid
  // should be (5,0,0) and broadband L_w should be ≈ 100 dB (each
  // contributes 100 dB; 2 sources sum to 100 + 10·log10(2) = 103 dB
  // total ACROSS BANDS, but broadbandSourceLwDb averages back across
  // bands — so we expect 103 dB).
  const B = 7;
  const Lw = new Float32Array(2 * B);
  for (let i = 0; i < 2 * B; i++) Lw[i] = 100;
  const scene = {
    bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000],
    sources: {
      count: 2,
      positions: [0, 0, 0,  10, 0, 0],
      L_w: Lw,
      aims: new Float32Array([0, 1, 0,  0, 1, 0]),
      dirN: new Float32Array([0, 0]),
    },
  };
  const c = sourceCentroid(scene);
  assert(Math.abs(c.x - 5) < 1e-9, `centroid x ≈ 5 (got ${c.x})`);
  assert(Math.abs(c.y) < 1e-9, `centroid y ≈ 0 (got ${c.y})`);
  assert(Math.abs(c.z) < 1e-9, `centroid z ≈ 0 (got ${c.z})`);
  const bb = broadbandSourceLwDb(scene);
  // Two sources × 7 bands × 100 dB each = 14 × 1e10 lin / 7 bands = 2 × 1e10 → 103.01 dB
  assert(Math.abs(bb - 103.01) < 0.05, `broadband Lw ≈ 103 dB (got ${bb.toFixed(2)})`);
}

// --- 7. computeBroadbandDirectSPL — single source ISL --------------
{
  // Single omni source at origin, 100 dB L_w per band. SPL at 1m, 2m,
  // 4m, 8m must drop 6 dB per doubling (this is what the audition's
  // master SPL-trim feeds on).
  const B = 7;
  const Lw = new Float32Array(B);
  for (let k = 0; k < B; k++) Lw[k] = 100;
  const scene = {
    bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000],
    sources: {
      count: 1,
      positions: [0, 0, 0],
      L_w: Lw,
      aims: new Float32Array([0, 1, 0]),
      dirN: new Float32Array([0]),
    },
  };
  const distances = [1, 2, 4, 8];
  const splValues = distances.map(d =>
    computeBroadbandDirectSPL({
      scene, pos: { x: 0, y: d, z: 0 }, airAbsorption: false,
    })
  );
  for (let i = 1; i < distances.length; i++) {
    const drop = splValues[i - 1] - splValues[i];
    assert(Math.abs(drop - 6.02) < 0.2,
      `broadband SPL: ${distances[i - 1]} m → ${distances[i]} m drops ${drop.toFixed(3)} dB ` +
      `(expected 6.02 ± 0.2)`);
  }
  // Sanity: absolute level. Per the project's L_w convention (see
  // memory feedback_sound_power_needs_DI), L_w already bakes in the
  // +11 dB sens→Lw boost, so Lp = Lw - 20·log10(d) directly. At
  // d=1 m omni, per-band Lp = 100 dB. Total across 7 bands
  // incoherent = 100 + 10·log10(7) ≈ 108.45 dB.
  assert(Math.abs(splValues[0] - 108.45) < 0.2,
    `broadband SPL at 1 m, 7 bands × 100 dB Lw, omni: ${splValues[0].toFixed(2)} dB (expected ≈ 108.45)`);
}

// --- 8. computeBroadbandDirectSPL — incoherent multi-source sum ----
{
  // Two equal-power omni sources, listener equidistant from both.
  // Total SPL must be 3 dB louder than a single-source case (incoherent
  // power sum: 2 sources → 2× energy → +3 dB).
  const B = 7;
  const Lw = new Float32Array(2 * B);
  for (let i = 0; i < 2 * B; i++) Lw[i] = 100;
  const scene2 = {
    bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000],
    sources: {
      count: 2,
      positions: [-1, 5, 0,  +1, 5, 0],     // ±1 m off-axis at 5 m
      L_w: Lw,
      aims: new Float32Array([0, 1, 0,  0, 1, 0]),
      dirN: new Float32Array([0, 0]),
    },
  };
  const Lw1 = new Float32Array(B);
  for (let k = 0; k < B; k++) Lw1[k] = 100;
  const scene1 = {
    bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000],
    sources: {
      count: 1,
      positions: [-1, 5, 0],
      L_w: Lw1,
      aims: new Float32Array([0, 1, 0]),
      dirN: new Float32Array([0]),
    },
  };
  // Listener at (0, 0, 0): symmetric — distances to both sources of
  // scene2 are equal (sqrt(1+25) ≈ 5.099 m); distance to scene1's
  // sole source same. So scene2's total - scene1's total ≈ 3 dB.
  const sp2 = computeBroadbandDirectSPL({ scene: scene2, pos: { x: 0, y: 0, z: 0 }, airAbsorption: false });
  const sp1 = computeBroadbandDirectSPL({ scene: scene1, pos: { x: 0, y: 0, z: 0 }, airAbsorption: false });
  assert(Math.abs((sp2 - sp1) - 3.01) < 0.05,
    `incoherent 2-source sum: ${(sp2 - sp1).toFixed(3)} dB louder than 1 source (expected 3.01 ± 0.05)`);
}

// --- 9. computeBroadbandDirectSPL — air absorption shifts SPL down --
{
  const B = 7;
  const Lw = new Float32Array(B);
  for (let k = 0; k < B; k++) Lw[k] = 100;
  // Air abs coefficient table (1/m, natural log) — typical 20 °C, 50 % RH.
  // 125 → 0.0001, 250 → 0.0003, 500 → 0.0008, 1k → 0.0026, 2k → 0.0086,
  // 4k → 0.0247, 8k → 0.077  (ISO 9613-1 tabulated values, approx).
  const airBands = new Float32Array([0.0001, 0.0003, 0.0008, 0.0026, 0.0086, 0.0247, 0.077]);
  const scene = {
    bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000],
    sources: {
      count: 1,
      positions: [0, 0, 0],
      L_w: Lw,
      aims: new Float32Array([0, 1, 0]),
      dirN: new Float32Array([0]),
    },
  };
  const dry = computeBroadbandDirectSPL({ scene, pos: { x: 0, y: 30, z: 0 }, airAbsorption: false });
  const damp = computeBroadbandDirectSPL({ scene, pos: { x: 0, y: 30, z: 0 }, airAbsorption: true, airAbsCoefPerBand: airBands });
  assert(damp < dry, `air abs at 30 m: damp ${damp.toFixed(2)} < dry ${dry.toFixed(2)}`);
  // 8 kHz absorbs 0.077 × 30 = 2.31 nepers ≈ 10 dB. Broadband sum is
  // pulled down by maybe 0.5–1.5 dB depending on the ratio of HF to
  // LF energy. Sanity: drop is between 0.3 and 3 dB.
  const drop = dry - damp;
  assert(drop > 0.3 && drop < 3,
    `air abs drop at 30 m broadband: ${drop.toFixed(2)} dB (expected 0.3–3 dB)`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll direct-path tests passed.');
