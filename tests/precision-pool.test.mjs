import { mergePartialHistograms } from '../js/physics/precision/worker-pool.js';
import { traceRays } from '../js/physics/precision/tracer-core.js';
import { triangulateScene } from '../js/physics/precision/triangulate-scene.js';
import { buildBVH } from '../js/physics/precision/bvh.js';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';
import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

function makeShoebox() {
  return buildPhysicsScene({
    state: {
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
      listeners: [{ id: 'L1', label: 'Rec', position: { x: 8, y: 5 }, elevation_m: 0.3 }],
      physics: {},
    },
    materials,
    getLoudspeakerDef: () => ({ acoustic: { sensitivity_db_1w_1m: 120, directivity_index_db: 0 } }),
  });
}

// ---- mergePartialHistograms: element-wise sum -------------------------

{
  // Three fake "worker results" with tiny histograms.
  const shape = { receivers: 2, bands: 3, buckets: 4 };
  const mk = (fill, hits, rays) => ({
    histogram: new Float32Array(shape.receivers * shape.bands * shape.buckets).fill(fill),
    shape, bucketDtMs: 2, maxTimeMs: 8,
    hitCount: hits, raysTraced: rays,
    terminations: { escaped: 1, energy: rays - 1, bounce: 0, timeOut: 0 },
  });
  const merged = mergePartialHistograms([mk(1, 10, 100), mk(2, 20, 200), mk(3, 30, 300)]);
  ok(merged.histogram.length === 2 * 3 * 4, 'merged histogram length preserved');
  // Every cell: 1+2+3 = 6.
  let allSix = true;
  for (let i = 0; i < merged.histogram.length; i++) if (merged.histogram[i] !== 6) { allSix = false; break; }
  ok(allSix, 'merged histogram is element-wise sum (every cell = 1+2+3 = 6)');
  ok(merged.hitCount === 60, `hitCount summed = 60 (got ${merged.hitCount})`);
  ok(merged.raysTraced === 600, `raysTraced summed = 600 (got ${merged.raysTraced})`);
  ok(merged.terminations.escaped === 3, 'termination counters summed');
  ok(merged.terminations.energy === 597, 'energy terminations summed');
  ok(merged.shape.receivers === 2 && merged.shape.bands === 3 && merged.shape.buckets === 4,
    'shape preserved from first partial');
}

// ---- Shape mismatch: reject -------------------------------------------

{
  const a = { histogram: new Float32Array(12), shape: { receivers: 1, bands: 3, buckets: 4 },
              bucketDtMs: 2, maxTimeMs: 8, hitCount: 0, raysTraced: 0, terminations: {} };
  const b = { histogram: new Float32Array(8),  shape: { receivers: 1, bands: 2, buckets: 4 },
              bucketDtMs: 2, maxTimeMs: 8, hitCount: 0, raysTraced: 0, terminations: {} };
  let threw = false;
  try { mergePartialHistograms([a, b]); } catch { threw = true; }
  ok(threw, 'mergePartialHistograms rejects mismatched shapes');
}

// ---- Statistical invariant: N partials ≈ 1 big trace ------------------
//
// The split-and-merge protocol: running traceRays N times with
// (raysPerSource / N) + different seeds and summing the histograms
// should give a histogram whose TOTAL energy matches running traceRays
// once with raysPerSource + original seed (within Monte Carlo noise).
//
// Why this works: each ray carries energy = E_source / raysPerSource.
// A partial with (raysPerSource / N) emits fewer rays each carrying
// (E_source / (raysPerSource/N)) = N × more energy each. But we ALSO
// want the partial to represent only (1/N) of the total energy budget
// — otherwise the merged result over-counts. This is handled in the
// worker-pool by passing raysPerSource/N to each worker individually;
// each worker's `initialEnergy = Lw_linear / (raysPerSource/N)`.
//
// So merging N partials sums energy proportional to N × (1/N) = 1 —
// correct.

{
  const scene = makeShoebox();
  const bvh = buildBVH(triangulateScene(scene));
  const N = 4;
  const raysTotal = 4000;
  const perWorker = raysTotal / N;

  // Single-shot trace.
  const big = traceRays(scene, bvh, {
    raysPerSource: raysTotal, maxBounces: 30, maxTimeMs: 300, seed: 42, bucketDtMs: 2,
  });

  // Split into N partials with distinct seeds. Each partial traces
  // `perWorker` rays but normalizes energy by the FULL budget so the sum
  // equals what a single `raysTotal`-ray trace would produce.
  const partials = [];
  for (let i = 0; i < N; i++) {
    partials.push(traceRays(scene, bvh, {
      raysPerSource: perWorker, normalizationRays: raysTotal,
      maxBounces: 30, maxTimeMs: 300,
      seed: 42 + i * 1_000_003, bucketDtMs: 2,
    }));
  }
  const merged = mergePartialHistograms(partials);

  // Total energy in histogram — should be SAME-ORDER-OF-MAGNITUDE between
  // big and merged. They will NOT be bit-equal because different seeds
  // produce different Monte-Carlo samples, but the integral should
  // converge to the same expected value. Assert the ratio stays inside
  // [0.5, 2.0] — a very loose check that guards against
  // "we normalized one thing wrong and got 10× mismatch".
  let bigSum = 0, mergedSum = 0;
  for (let i = 0; i < big.histogram.length; i++) {
    bigSum += big.histogram[i];
    mergedSum += merged.histogram[i];
  }
  const ratio = mergedSum / Math.max(bigSum, 1e-30);
  console.log(`    bigSum=${bigSum.toExponential(3)}  mergedSum=${mergedSum.toExponential(3)}  ratio=${ratio.toFixed(3)}`);
  ok(ratio > 0.5 && ratio < 2.0,
    `Split ${N}-worker histogram total ≈ single-shot total (ratio within [0.5, 2.0])`);
  ok(big.hitCount > 0 && merged.hitCount > 0, 'Both traces logged hits');

  // Hit counts should also be similar order of magnitude — same
  // underlying physics, just different sample paths.
  const hitRatio = merged.hitCount / Math.max(big.hitCount, 1);
  ok(hitRatio > 0.5 && hitRatio < 2.0,
    `Split ${N}-worker hit count ≈ single-shot (ratio=${hitRatio.toFixed(3)})`);
}

// ---- Determinism across workers: same base seed + N → bit-exact --------

{
  const scene = makeShoebox();
  const bvh = buildBVH(triangulateScene(scene));
  const N = 3;
  const runOnce = () => {
    const partials = [];
    for (let i = 0; i < N; i++) {
      partials.push(traceRays(scene, bvh, {
        raysPerSource: 200, maxBounces: 10, maxTimeMs: 100,
        seed: 7 + i * 1_000_003, bucketDtMs: 2,
      }));
    }
    return mergePartialHistograms(partials);
  };
  const a = runOnce();
  const b = runOnce();
  let identical = a.histogram.length === b.histogram.length;
  for (let i = 0; i < a.histogram.length && identical; i++) {
    if (a.histogram[i] !== b.histogram[i]) identical = false;
  }
  ok(identical, 'Merged histogram bit-exact reproducible across runs with same base seed');
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll precision pool tests passed.');
