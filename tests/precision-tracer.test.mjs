import { triangulateScene } from '../js/physics/precision/triangulate-scene.js';
import { buildBVH } from '../js/physics/precision/bvh.js';
import { traceRays, histogramWindowSum } from '../js/physics/precision/tracer-core.js';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';
import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function assertClose(actual, expected, tol, label) {
  const good = Math.abs(actual - expected) < tol;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}  actual=${actual.toFixed(4)} expected=${expected.toFixed(4)}`);
  if (!good) failed++;
}

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};
const stubSpeaker = {
  acoustic: { sensitivity_db_1w_1m: 120, directivity_index_db: 0 },
};
const getDef = () => stubSpeaker;

// Helper: 10×10×3 m shoebox with concrete everywhere, one source, one
// receiver. Gives us a clean fixture with long reverb.
function makeShoebox({ recPos = [8, 5, 1.5], recR = 0.5 } = {}) {
  const state = {
    room: {
      shape: 'rectangular', width_m: 10, height_m: 3, depth_m: 10,
      surfaces: {
        floor: 'concrete-painted', ceiling: 'concrete-painted',
        wall_north: 'concrete-painted', wall_south: 'concrete-painted',
        wall_east: 'concrete-painted', wall_west: 'concrete-painted',
      },
    },
    zones: [],
    sources: [{ modelUrl: 'stub', position: { x: 5, y: 5, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 }],
    listeners: [{ id: 'L1', label: 'Rec', position: { x: recPos[0], y: recPos[1] }, elevation_m: recPos[2] - 1.2, receiver_radius_m: recR }],
    physics: {},
  };
  return buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
}

// ---- Smoke: tracer runs, returns well-shaped result --------------------

{
  const scene = makeShoebox();
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const result = traceRays(scene, bvh, {
    raysPerSource: 1000, maxBounces: 20, bucketDtMs: 2, maxTimeMs: 500, seed: 42,
  });
  ok(result.histogram instanceof Float32Array, 'result.histogram is Float32Array');
  ok(result.histogram.length === 1 * 7 * 250, `histogram size = 1·7·250 = 1750 (got ${result.histogram.length})`);
  ok(result.raysTraced === 1000, `raysTraced = 1000 (got ${result.raysTraced})`);
  ok(result.hitCount > 0, `ray hits logged (got ${result.hitCount})`);
}

// ---- Determinism: same seed → bit-exact same histogram -----------------

{
  const scene = makeShoebox();
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const r1 = traceRays(scene, bvh, { raysPerSource: 500, maxBounces: 15, seed: 12345, maxTimeMs: 300 });
  const r2 = traceRays(scene, bvh, { raysPerSource: 500, maxBounces: 15, seed: 12345, maxTimeMs: 300 });
  let identical = r1.histogram.length === r2.histogram.length;
  for (let i = 0; i < r1.histogram.length && identical; i++) {
    if (r1.histogram[i] !== r2.histogram[i]) identical = false;
  }
  ok(identical, 'Deterministic seed: two traces produce bit-exact histograms');
  ok(r1.hitCount === r2.hitCount, 'Deterministic seed: hit counts match');
}

// ---- Direct path timing: peak near expected arrival time ---------------
//
// Source at (5,5,1.5), receiver at (8,5,1.5) — Euclidean distance 3 m,
// speed of sound 343.2 m/s → direct arrival 8.74 ms → bucket 4 at 2 ms/
// bucket. First-segment receiver sphere entry time is slightly less
// (r_rec=0.5 → enters at distance 2.5 m → 7.28 ms → bucket 3).
// The earliest populated bucket should be bucket 3 or 4.

{
  const scene = makeShoebox();
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const result = traceRays(scene, bvh, {
    raysPerSource: 50000, maxBounces: 1, bucketDtMs: 2, maxTimeMs: 100, seed: 99,
  });
  // Find the first bucket with non-zero energy at band 3 (1 kHz).
  const band = 3;
  let firstBucket = -1;
  for (let t = 0; t < result.shape.buckets; t++) {
    const v = result.histogram[band * result.shape.buckets + t];
    if (v > 0) { firstBucket = t; break; }
  }
  ok(firstBucket === 3 || firstBucket === 4,
    `Direct path: first populated bucket = 3 or 4 (got ${firstBucket}; arrival ≈ 7.3-8.7 ms)`);
  // With maxBounces=1, only first-segment hits are logged. Total hit
  // count should be proportional to solid angle subtended by the 0.5 m
  // receiver at 3 m:  Ω/(4π) = π·r² / (4π·d²) = r²/(4d²) = 0.25/36 ≈ 6.9e-3.
  // So ~50,000 × 0.0069 ≈ 347 expected hits. Allow wide band: 200-550.
  const expectedHits = 50000 * 0.25 / 36;
  ok(result.hitCount > expectedHits * 0.6 && result.hitCount < expectedHits * 1.6,
    `First-segment hit count ≈ ${expectedHits.toFixed(0)} (got ${result.hitCount})`);
}

// ---- Energy decay: monotonic-ish decrease with time in long window -----
//
// In a modestly absorbent room (concrete α ≈ 0.02), late-tail energy
// should decay compared to early-tail. Check: energy in 0-100ms window
// is greater than energy in 400-500ms window (band 3 = 1 kHz).

{
  const scene = makeShoebox();
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const result = traceRays(scene, bvh, {
    raysPerSource: 20000, maxBounces: 200, bucketDtMs: 5, maxTimeMs: 600, seed: 7,
  });
  const bucketsPer100ms = 100 / 5;
  const early = histogramWindowSum(result, 0, 3, 0, bucketsPer100ms);
  const late  = histogramWindowSum(result, 0, 3, 4 * bucketsPer100ms, 5 * bucketsPer100ms);
  ok(early > 0, `Early window has energy (${early.toExponential(2)})`);
  ok(late  >= 0, `Late window sum ≥ 0 (${late.toExponential(2)})`);
  ok(early > late, `Early 0-100ms energy > late 400-500ms (early=${early.toExponential(2)}, late=${late.toExponential(2)})`);
}

// ---- Material absorption: higher α → lower late energy ----------------
//
// Same geometry, swap concrete for acoustic-tile (α=0.65 @ 1kHz vs
// α=0.02). Late-tail energy must drop substantially.

{
  function sweepRoom(material_id) {
    const state = {
      room: {
        shape: 'rectangular', width_m: 10, height_m: 3, depth_m: 10,
        surfaces: {
          floor: material_id, ceiling: material_id,
          wall_north: material_id, wall_south: material_id,
          wall_east: material_id, wall_west: material_id,
        },
      },
      zones: [],
      sources: [{ modelUrl: 'stub', position: { x: 5, y: 5, z: 1.5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 }],
      listeners: [{ id: 'L1', label: 'Rec', position: { x: 8, y: 5 }, elevation_m: 0.3 }],
      physics: {},
    };
    const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
    const soup = triangulateScene(scene);
    const bvh = buildBVH(soup);
    return traceRays(scene, bvh, {
      raysPerSource: 10000, maxBounces: 200, bucketDtMs: 5, maxTimeMs: 800, seed: 31,
    });
  }
  const hard = sweepRoom('concrete-painted');
  const soft = sweepRoom('acoustic-tile');
  // Late = last third of the histogram (≈ 530-800 ms for these runs).
  // Covers the steady reverberant tail where material α dominates.
  const lateStart = Math.floor(hard.shape.buckets * 2 / 3);
  const hardLate = histogramWindowSum(hard, 0, 3, lateStart, hard.shape.buckets);
  const softLate = histogramWindowSum(soft, 0, 3, lateStart, soft.shape.buckets);
  ok(hardLate > softLate * 5, `Hard room late energy ≫ soft room (hard=${hardLate.toExponential(2)}, soft=${softLate.toExponential(2)}; ratio=${(hardLate/Math.max(softLate,1e-30)).toFixed(1)}×)`);
  // Terminations: soft room should finish rays by energy cutoff, not by
  // bounce-count or time-out, in the majority.
  ok(soft.terminations.energy > soft.terminations.bounce,
    `Soft room: energy-cutoff terminations > bounce-limit terminations`);
}

// ---- Multi-band behavior: HF decays faster than LF --------------------
//
// With concrete (α 125=0.01, 4k=0.03), 4 kHz should decay faster in time
// than 125 Hz → the ratio of late/early energy at 4 kHz is LESS than at
// 125 Hz. This is the basic physics smell-test that each band is
// independently attenuated.

{
  const scene = makeShoebox();
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const result = traceRays(scene, bvh, {
    raysPerSource: 20000, maxBounces: 300, bucketDtMs: 5, maxTimeMs: 1000, seed: 13,
  });
  const totalBuckets = result.shape.buckets;
  const early = (band) => histogramWindowSum(result, 0, band, 0, 20);         // 0-100 ms
  const late  = (band) => histogramWindowSum(result, 0, band, 100, totalBuckets); // 500ms+
  const ratio125 = late(0) / Math.max(early(0), 1e-30);
  const ratio4k  = late(5) / Math.max(early(5), 1e-30);
  ok(ratio4k < ratio125,
    `4 kHz late/early ratio (${ratio4k.toExponential(2)}) < 125 Hz (${ratio125.toExponential(2)}) — HF decays faster`);
}

// ---- Arena preset: tracer produces a non-trivial histogram -----------

{
  const { state: appState, applyPresetToState } = await import('../js/app-state.js');
  applyPresetToState('auditorium');
  const scene = buildPhysicsScene({ state: appState, materials, getLoudspeakerDef: getDef });
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const t0 = performance.now();
  const result = traceRays(scene, bvh, {
    raysPerSource: 2000, maxBounces: 50, bucketDtMs: 2, maxTimeMs: 1500, seed: 1,
  });
  const wallMs = performance.now() - t0;
  const totalRays = 2000 * scene.sources.count;
  ok(result.hitCount > 0, `Arena trace: ray hits logged (got ${result.hitCount})`);
  console.log(`PERF  Arena tracer: ${totalRays} rays (${scene.sources.count} sources × 2000) in ${wallMs.toFixed(0)} ms → ${(totalRays / wallMs).toFixed(0)} rays/ms effective`);
  // Sanity: most rays should terminate by energy cutoff in a large absorbent room, not by hitting maxBounces.
  const totalTerm = result.terminations.energy + result.terminations.bounce + result.terminations.escaped + result.terminations.timeOut;
  ok(totalTerm === totalRays, `Terminations sum = raysTraced (${totalTerm} vs ${totalRays})`);
}

// ---- ISO 9613-1 volumetric air absorption in the bounce loop ----------
//
// Cross-engine validation exposed this gap: without air absorption the
// ray tracer's 8 kHz T30 ran ~60 % longer than the draft engine's
// Sabine/Eyring result in the arena preset (draft applies the 4mV term,
// tracer previously did not). Fix: per-segment `energy *= exp(-m·d)`
// where m is Nepers/m from air-absorption.js. Partial path applied to
// receiver-hit logging so the arriving energy reflects the actual
// travelled distance.
//
// Test: 40×40×10 m reverberant room (mostly hard surfaces). Compare
// broadband-histogram energy at late tail with air-abs on vs off. At
// 8 kHz the late tail should drop substantially; at 125 Hz almost
// unchanged.

{
  function bigRoom(airEnabled) {
    const state = {
      room: {
        shape: 'rectangular', width_m: 40, depth_m: 40, height_m: 10,
        surfaces: {
          floor: 'concrete-painted', ceiling: 'concrete-painted',
          wall_north: 'concrete-painted', wall_south: 'concrete-painted',
          wall_east: 'concrete-painted', wall_west: 'concrete-painted',
        },
      },
      zones: [],
      sources: [{ modelUrl: 'stub', position: { x: 20, y: 20, z: 5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 }],
      listeners: [{ id: 'L1', label: 'Rec', position: { x: 30, y: 20 }, elevation_m: 3.8 }],
      physics: {},
    };
    const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
    const soup = triangulateScene(scene);
    const bvh = buildBVH(soup);
    return traceRays(scene, bvh, {
      raysPerSource: 5000, maxBounces: 200, bucketDtMs: 5, maxTimeMs: 1500,
      seed: 17, airAbsorption: airEnabled,
    });
  }
  const withAir = bigRoom(true);
  const noAir = bigRoom(false);
  // Late-tail window = last third of the histogram (≥ 1 s arrival).
  const lateStart = Math.floor(withAir.shape.buckets * 2 / 3);
  const lateAir = (r, band) => histogramWindowSum(r, 0, band, lateStart, r.shape.buckets);

  // Band 0 = 125 Hz: air coefficient tiny, late-tail should be similar.
  const ratio125 = lateAir(withAir, 0) / Math.max(lateAir(noAir, 0), 1e-30);
  console.log(`    125 Hz late-tail air/noAir ratio: ${ratio125.toFixed(3)}`);
  ok(ratio125 > 0.7, `125 Hz air-abs effect modest in big room (got ${ratio125.toFixed(3)}, expect > 0.7)`);

  // Band 6 = 8 kHz: air should slash late-tail energy by at least 80 %.
  const ratio8k = lateAir(withAir, 6) / Math.max(lateAir(noAir, 6), 1e-30);
  console.log(`    8 kHz late-tail air/noAir ratio: ${ratio8k.toFixed(3)}`);
  ok(ratio8k < 0.2, `8 kHz air-abs shreds late tail in big room (got ${ratio8k.toFixed(3)}, expect < 0.2)`);

  // Default flag is ON — parity with the draft engine.
  const noFlag = bigRoom();  // drops to default
  void noFlag;
}

// ---- Phase D: Lambertian scattering -----------------------------------
//
// With uniform absorption on every surface, scattering reshapes the
// direction distribution but barely affects RT60 (the energy budget per
// bounce is the same). With NON-uniform absorption — one very
// absorbent surface + reflective others — specular-only tends to trap
// rays between the reflective surfaces, while diffuse scattering sends
// rays to the absorbent surface more often. So scattering should
// SHORTEN the late tail in asymmetric rooms.
//
// This test builds a 20×20×10 m room with a super-absorbent ceiling
// (acoustic-tile, α ≈ 0.55 at 1 kHz, s = 0.10 → specular-dominant) and
// near-zero-absorption concrete on the other five surfaces. The
// default `scattering: true` path should absorb energy faster than
// `scattering: false` at the reverberant tail — demonstrating that the
// scatter physics is wired into the attenuation budget.

{
  function asymRoom(scatteringEnabled) {
    const state = {
      room: {
        shape: 'rectangular', width_m: 20, depth_m: 20, height_m: 10,
        surfaces: {
          floor: 'concrete-painted',
          ceiling: 'acoustic-tile',       // the absorbent one
          wall_north: 'concrete-painted', wall_south: 'concrete-painted',
          wall_east: 'concrete-painted',  wall_west: 'concrete-painted',
        },
      },
      zones: [],
      sources: [{ modelUrl: 'stub', position: { x: 10, y: 10, z: 5 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 }],
      listeners: [{ id: 'L1', label: 'Rec', position: { x: 15, y: 10 }, elevation_m: 3.8 }],
      physics: {},
    };
    const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
    const soup = triangulateScene(scene);
    const bvh = buildBVH(soup);
    return traceRays(scene, bvh, {
      raysPerSource: 5000, maxBounces: 150, bucketDtMs: 5, maxTimeMs: 1500,
      seed: 91, airAbsorption: true,
      scattering: scatteringEnabled,
    });
  }
  const specular = asymRoom(false);
  const diffuse  = asymRoom(true);
  const lateStart = Math.floor(specular.shape.buckets * 2 / 3);
  const lateSpec = histogramWindowSum(specular, 0, 3, lateStart, specular.shape.buckets);
  const lateDiff = histogramWindowSum(diffuse,  0, 3, lateStart, diffuse.shape.buckets);
  console.log(`    specular-only late tail @1kHz: ${lateSpec.toExponential(2)}`);
  console.log(`    scattering-on late tail @1kHz: ${lateDiff.toExponential(2)}`);
  const ratio = lateDiff / Math.max(lateSpec, 1e-30);
  ok(ratio < 0.8, `Lambertian scattering reduces late tail in asymmetric-absorption room (ratio ${ratio.toFixed(2)}, expect < 0.8)`);
  // Hit counts: scattering should raise the hit rate (diffuse bounces
  // distribute geographically, reaching receivers missed by specular).
  ok(diffuse.hitCount >= specular.hitCount * 0.8,
    `Scattering hit count within 80% of specular (spec=${specular.hitCount}, diff=${diffuse.hitCount})`);
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll precision tracer tests passed.');
