// Ray-viz tracer — data-shape tests.
//
// We can't render LineSegments in Node without a headless GL context,
// so this test covers the buffer shapes and invariants only:
//   - returns Float32Array buffers shaped for Three.js consumption
//   - vertex count aligns with offset table
//   - no NaN / Infinity in path data
//   - empty-scene edge case
//   - deterministic output (same seed → same buffers)
//
// Run: node tests/ray-viz.test.mjs

import { readFileSync } from 'node:fs';
import {
  state, applyPresetToState, applyTemplateToState, PRESETS, TEMPLATES,
} from '../js/app-state.js';
import { recordRayPaths, buildLineSegmentIndex } from '../js/physics/ray-viz.js';

const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};

// Speaker resolver — returns null when uncached (BVH/tracer don't need
// the def for ray viz; sensitivity/DI affect L_w which viz ignores).
const getLoudspeakerDef = () => null;

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

function isFiniteFloat32(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return false;
  }
  return true;
}

// 1. Hi-fi template — small rectangular scene, 2 sources, easy to verify shape.
applyTemplateToState('hifi');
{
  const out = recordRayPaths({ state, materials, getLoudspeakerDef, totalPaths: 100 });
  assert(out.pathData instanceof Float32Array, 'pathData is Float32Array');
  assert(out.colorData instanceof Float32Array, 'colorData is Float32Array');
  assert(out.pathOffsets instanceof Uint32Array, 'pathOffsets is Uint32Array');
  assert(out.pathData.length === out.colorData.length,
    `pathData and colorData same length (${out.pathData.length})`);
  assert(out.pathData.length % 3 === 0, 'pathData length is multiple of 3 (xyz triples)');
  assert(out.pathOffsets.length === out.stats.totalPaths + 1,
    `pathOffsets has N+1 entries (${out.pathOffsets.length} = ${out.stats.totalPaths} + 1)`);
  assert(out.pathOffsets[0] === 0, 'pathOffsets[0] === 0');
  assert(out.pathOffsets[out.pathOffsets.length - 1] * 3 === out.pathData.length,
    'last pathOffset × 3 === pathData.length');
  assert(isFiniteFloat32(out.pathData), 'pathData contains no NaN / Infinity');
  assert(isFiniteFloat32(out.colorData), 'colorData contains no NaN / Infinity');
  assert(out.stats.totalPaths > 0 && out.stats.totalPaths <= 100,
    `totalPaths in [1, 100]: got ${out.stats.totalPaths}`);
  assert(out.stats.sources === 2, `sources count matches scene (got ${out.stats.sources})`);

  // Color values must be in 0..1.
  let cMax = 0;
  for (let i = 0; i < out.colorData.length; i++) {
    if (out.colorData[i] > cMax) cMax = out.colorData[i];
  }
  assert(cMax <= 1.0001, `colorData values clamped to <= 1.0 (max = ${cMax.toFixed(4)})`);

  // Each path must have at least 1 vertex (the source position).
  let minLen = Infinity;
  for (let i = 0; i < out.stats.totalPaths; i++) {
    const len = out.pathOffsets[i + 1] - out.pathOffsets[i];
    if (len < minLen) minLen = len;
  }
  assert(minLen >= 1, `every path has ≥ 1 vertex (min = ${minLen})`);
}

// 2. Determinism — same seed produces byte-identical buffers.
applyTemplateToState('hifi');
{
  const a = recordRayPaths({ state, materials, getLoudspeakerDef, totalPaths: 50, seed: 42 });
  const b = recordRayPaths({ state, materials, getLoudspeakerDef, totalPaths: 50, seed: 42 });
  let identical = a.pathData.length === b.pathData.length;
  if (identical) {
    for (let i = 0; i < a.pathData.length; i++) {
      if (a.pathData[i] !== b.pathData[i]) { identical = false; break; }
    }
  }
  assert(identical, 'same seed → identical pathData (deterministic)');
}

// 3. Different seeds produce different output.
applyTemplateToState('hifi');
{
  const a = recordRayPaths({ state, materials, getLoudspeakerDef, totalPaths: 50, seed: 1 });
  const b = recordRayPaths({ state, materials, getLoudspeakerDef, totalPaths: 50, seed: 2 });
  let same = a.pathData.length === b.pathData.length;
  if (same) {
    same = false;
    for (let i = 0; i < a.pathData.length; i++) {
      if (a.pathData[i] !== b.pathData[i]) { same = true; break; }
    }
    same = !same;
  }
  assert(!same, 'different seeds → different pathData');
}

// 4. Empty scene (no sources) returns empty buffers, no crash.
applyTemplateToState('hifi');
state.sources = [];
{
  const out = recordRayPaths({ state, materials, getLoudspeakerDef, totalPaths: 100 });
  assert(out.pathData.length === 0, 'no sources: pathData is empty');
  assert(out.pathOffsets.length === 1 && out.pathOffsets[0] === 0,
    'no sources: pathOffsets is [0]');
  assert(out.stats.totalPaths === 0 && out.stats.sources === 0,
    'no sources: stats reflect empty scene');
}

// 5. buildLineSegmentIndex produces correct pair count.
applyTemplateToState('hifi');
{
  const out = recordRayPaths({ state, materials, getLoudspeakerDef, totalPaths: 80 });
  const idx = buildLineSegmentIndex(out.pathOffsets);
  assert(idx instanceof Uint32Array, 'index is Uint32Array');
  assert(idx.length % 2 === 0, 'index length is even (segment pairs)');
  // Total segments across all paths
  let expectedSegs = 0;
  for (let i = 0; i < out.stats.totalPaths; i++) {
    const len = out.pathOffsets[i + 1] - out.pathOffsets[i];
    if (len >= 2) expectedSegs += (len - 1);
  }
  assert(idx.length === expectedSegs * 2,
    `index has expected pair count (${idx.length / 2} segments == ${expectedSegs})`);
  // No index out-of-range
  let maxIdx = 0;
  for (let i = 0; i < idx.length; i++) if (idx[i] > maxIdx) maxIdx = idx[i];
  assert(maxIdx < out.pathData.length / 3,
    `index values within vertex range (max=${maxIdx} < verts=${out.pathData.length / 3})`);
}

// 6. Bigger scene — auditorium preset — finishes in reasonable time and
//    distributes paths across multiple sources.
applyPresetToState('auditorium');
{
  const t0 = Date.now();
  const out = recordRayPaths({ state, materials, getLoudspeakerDef, totalPaths: 200 });
  const elapsed = Date.now() - t0;
  assert(elapsed < 5000, `auditorium recordRayPaths < 5 s (took ${elapsed} ms)`);
  assert(out.stats.totalPaths > 0, `auditorium: ${out.stats.totalPaths} paths recorded`);
  assert(out.stats.avgBounces > 0, `auditorium avg bounces > 0 (${out.stats.avgBounces.toFixed(1)})`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll ray-viz tests passed.');
