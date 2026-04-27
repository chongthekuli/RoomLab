// Ray-path visualisation tracer.
//
// Runs a small (N ≈ 200 total) ray sampling pass against the current
// scene geometry, records each ray's bounce sequence as a polyline,
// and returns interleaved Float32Arrays ready to feed a Three.js
// LineSegments BufferGeometry. NEVER imports `tracer-core.js`'s inner
// loop — Martina's CRITICAL rule: the precision-tracer hot path stays
// recording-free. We reuse the BVH builder + intersectRay only.
//
// Why a separate, simpler tracer:
//  - debug viz doesn't need per-band energy or air absorption
//  - main-thread is fine; 200 rays × 30 bounces ≈ 6 k intersections
//    runs in <100 ms even on pavilion-class scenes
//  - no worker plumbing → no transferable serialisation, no merge
//
// What it returns (for direct consumption by Three.js):
//   {
//     pathData:    Float32Array,  // interleaved x,y,z,x,y,z,…
//     pathOffsets: Uint32Array,   // start vertex of each path; length = N+1
//     colorData:   Float32Array,  // per-vertex r,g,b (0..1) — energy fade × source-group hue
//     stats:       { totalPaths, avgBounces, scenes: 'pavilion'|'…' }
//   }
// Caller turns this into a LineSegments mesh.

import { buildPhysicsScene } from './scene-snapshot.js';
import { triangulateScene } from './precision/triangulate-scene.js';
import { buildBVH, intersectRay } from './precision/bvh.js';
import { colorForGroup } from '../app-state.js';

const DEFAULT_TOTAL_PATHS = 200;
const DEFAULT_MAX_BOUNCES = 24;
const DEFAULT_SEED = 0x6F6D7261;        // "rmoa" — fixed for repro across toggles
const EPS = 1e-4;

// Mulberry32 — same PRNG as tracer-core. Deterministic so toggling
// Rays off/on twice draws the same lines, which is what users expect
// for "did my fix change anything?" debugging.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleUnitSphere(rng, out) {
  // Marsaglia method — 2 rng calls, no trig.
  while (true) {
    const u = rng() * 2 - 1;
    const v = rng() * 2 - 1;
    const s = u * u + v * v;
    if (s >= 1 || s === 0) continue;
    const f = 2 * Math.sqrt(1 - s);
    out[0] = u * f;
    out[1] = v * f;
    out[2] = 1 - 2 * s;
    return;
  }
}

// Convert a hex colour like '#ef4444' to [r, g, b] in 0..1.
function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

const DEFAULT_RAY_RGB = [0.55, 0.78, 1.0]; // soft blue when no source group

// Ray-segment vs sphere entry test. Returns the parameter t (in
// world-distance units, same as `intersectRay`) at which a unit-
// direction ray first enters the sphere, or -1 if it doesn't enter
// within [0, tMax]. Used by listener-biased mode to test whether a
// ray segment crosses any receiver sphere on its way to the next
// surface hit.
function raySphereEntry(ox, oy, oz, dx, dy, dz, sx, sy, sz, sr, tMax) {
  const fx = ox - sx;
  const fy = oy - sy;
  const fz = oz - sz;
  const b = fx * dx + fy * dy + fz * dz;
  const c = fx * fx + fy * fy + fz * fz - sr * sr;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > tMax) return -1;
  return t;
}

// Trace ray paths from every source in the scene, distributing N total
// paths proportional to source count (so a 1-source hi-fi gets all
// N=200, but pavilion's 88 ceiling speakers get ~2 paths each — Viktor's
// rule: budget total, not per-source).
//
// `bias` ('auto' | 'listeners' | 'uniform'):
//   'auto' (default) → listener-biased when at least one listener
//     exists, else falls back to uniform sampling.
//   'listeners' → reject paths that don't cross a receiver sphere.
//     Up to ~50 sample candidates per requested path; if none
//     hits a listener after that budget, accept whatever was sampled
//     so the user sees something rather than nothing.
//   'uniform' → keep every sampled path regardless of listener
//     intersection. Faster (1× cost). Useful when no listeners are
//     placed yet.
//
// Returns the interleaved buffers described in the module header, plus
// `stats` for caller diagnostics. Throws if the scene has no sources
// (toggle UI should prevent that, but handle gracefully).
export function recordRayPaths({
  state,
  materials,
  getLoudspeakerDef,
  totalPaths = DEFAULT_TOTAL_PATHS,
  maxBounces = DEFAULT_MAX_BOUNCES,
  seed = DEFAULT_SEED,
  bias = 'auto',
} = {}) {
  if (!state || !materials) throw new Error('recordRayPaths: state + materials are required');

  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef });
  const sourcePositions = scene.sources?.positions; // Float32Array [x,y,z, x,y,z, …]
  const S = sourcePositions ? Math.floor(sourcePositions.length / 3) : 0;
  if (S === 0) {
    return {
      pathData: new Float32Array(0),
      pathOffsets: new Uint32Array([0]),
      colorData: new Float32Array(0),
      stats: { totalPaths: 0, avgBounces: 0, sources: 0 },
    };
  }

  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);

  // Distribute N across sources — at least 1 per source if S < N, else
  // round-down with the remainder going to the first sources. Avoids
  // "1 source got 0 rays" edge case.
  const perSource = new Uint32Array(S);
  const base = Math.max(1, Math.floor(totalPaths / S));
  let remaining = Math.max(totalPaths, S) - base * S;
  for (let i = 0; i < S; i++) {
    perSource[i] = base + (i < remaining ? 1 : 0);
  }

  // Per-source colour — try to pull from the user's group assignments.
  // state.sources may contain line-array entries that expand to multiple
  // physical sources in scene-snapshot. We reuse the first matching
  // group colour we find for sources at the same position; if none,
  // use the soft-blue default.
  const sourceColors = new Array(S);
  const flatSrc = scene.sources;
  for (let i = 0; i < S; i++) {
    const groupId = flatSrc.groupIds?.[i] ?? null;
    if (groupId) {
      const hex = colorForGroup(groupId);
      sourceColors[i] = hexToRgb(hex);
    } else {
      sourceColors[i] = DEFAULT_RAY_RGB;
    }
  }

  // Pre-size the buffers conservatively. Worst case = N paths × (maxBounces + 1)
  // vertices each. We trim the unused tail at the end.
  const maxVerts = totalPaths * (maxBounces + 1);
  const pathData = new Float32Array(maxVerts * 3);
  const colorData = new Float32Array(maxVerts * 3);
  const pathOffsets = new Uint32Array(totalPaths + 1);

  // Listener bias: rejection-sample so committed paths actually cross
  // a receiver. Most random rays from a small source don't go anywhere
  // near a listener; without this, ~95 % of viz lines are uninformative.
  const recPositions = scene.receivers?.positions;
  const recRadii = scene.receivers?.radii;
  const R = scene.receivers?.count ?? 0;
  const useListenerBias = (bias === 'listeners' || (bias === 'auto' && R > 0));
  // Per-source candidate budget — over-sample when biased so we can
  // afford rejections. Capped to avoid pathological scenes (e.g.
  // listener placed in a sealed cavity) chewing seconds.
  const CANDIDATE_MULTIPLIER = useListenerBias ? 50 : 1;

  const rng = mulberry32(seed);
  const dir = new Float32Array(3);
  // Scratch buffers for one candidate path. We trace into these, and
  // copy into the main pathData/colorData buffers ONLY if the path
  // qualifies (crossed a listener, or bias='uniform').
  const candXYZ = new Float32Array((maxBounces + 1) * 3);
  const candRGB = new Float32Array((maxBounces + 1) * 3);
  let writeVert = 0;
  let pathCount = 0;
  let totalBouncesRecorded = 0;
  let totalCandidates = 0;
  let totalListenerHits = 0;

  for (let sIdx = 0; sIdx < S; sIdx++) {
    const sx = sourcePositions[sIdx * 3 + 0];
    const sy = sourcePositions[sIdx * 3 + 1];
    const sz = sourcePositions[sIdx * 3 + 2];
    const [r0, g0, b0] = sourceColors[sIdx];
    const N = perSource[sIdx];
    const maxAttempts = N * CANDIDATE_MULTIPLIER;
    let recorded = 0;
    let attempts = 0;

    while (recorded < N && attempts < maxAttempts && pathCount < totalPaths) {
      attempts++;
      totalCandidates++;

      // Initialise candidate scratch with the source vertex.
      candXYZ[0] = sx; candXYZ[1] = sy; candXYZ[2] = sz;
      candRGB[0] = r0; candRGB[1] = g0; candRGB[2] = b0;
      let candVerts = 1;

      sampleUnitSphere(rng, dir);
      let dx = dir[0], dy = dir[1], dz = dir[2];
      let ox = sx, oy = sy, oz = sz;
      let energy = 1.0;
      let hitListener = !useListenerBias; // uniform mode → "always commit"

      for (let bounce = 0; bounce < maxBounces; bounce++) {
        const hit = intersectRay(bvh, ox, oy, oz, dx, dy, dz);
        if (!hit) break;

        // Listener-bias check: did this segment [origin → hit] cross
        // any receiver sphere? Only test until we find one — we just
        // need a yes/no for the commit decision.
        if (useListenerBias && !hitListener) {
          for (let recIdx = 0; recIdx < R; recIdx++) {
            const tRec = raySphereEntry(
              ox, oy, oz, dx, dy, dz,
              recPositions[recIdx * 3 + 0],
              recPositions[recIdx * 3 + 1],
              recPositions[recIdx * 3 + 2],
              recRadii[recIdx],
              hit.t,
            );
            if (tRec >= 0) { hitListener = true; break; }
          }
        }

        // Advance to surface hit + apply mid-band absorption.
        ox += dx * hit.t;
        oy += dy * hit.t;
        oz += dz * hit.t;
        const mat = scene.materials?.[hit.materialIdx];
        const alphaMid = mat?.absorption?.[3] ?? 0.1;
        energy *= Math.max(0.05, 1 - alphaMid);

        // Record vertex with energy-faded colour.
        const fade = Math.max(0.15, 0.15 + 0.85 * (Math.log10(energy + 0.01) + 2) / 2);
        candXYZ[candVerts * 3 + 0] = ox;
        candXYZ[candVerts * 3 + 1] = oy;
        candXYZ[candVerts * 3 + 2] = oz;
        candRGB[candVerts * 3 + 0] = r0 * fade;
        candRGB[candVerts * 3 + 1] = g0 * fade;
        candRGB[candVerts * 3 + 2] = b0 * fade;
        candVerts++;

        if (energy < 0.01) break;

        // Specular reflection.
        const nx = hit.normal[0], ny = hit.normal[1], nz = hit.normal[2];
        const dDotN = dx * nx + dy * ny + dz * nz;
        dx -= 2 * dDotN * nx;
        dy -= 2 * dDotN * ny;
        dz -= 2 * dDotN * nz;
        const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dLen > EPS) { dx /= dLen; dy /= dLen; dz /= dLen; }
        ox += dx * EPS;
        oy += dy * EPS;
        oz += dz * EPS;
      }

      // Commit decision. Listener bias: keep only paths that crossed.
      // Last-resort fallback: if we exhaust the candidate budget for
      // this source without any listener hits, commit whatever we got
      // so the user sees something instead of an empty toggle.
      const isLastResort = useListenerBias
        && (attempts >= maxAttempts) && (recorded === 0);
      if (hitListener || isLastResort) {
        if (hitListener) totalListenerHits++;
        pathOffsets[pathCount] = writeVert;
        for (let v = 0; v < candVerts; v++) {
          pathData[writeVert * 3 + 0] = candXYZ[v * 3 + 0];
          pathData[writeVert * 3 + 1] = candXYZ[v * 3 + 1];
          pathData[writeVert * 3 + 2] = candXYZ[v * 3 + 2];
          colorData[writeVert * 3 + 0] = candRGB[v * 3 + 0];
          colorData[writeVert * 3 + 1] = candRGB[v * 3 + 1];
          colorData[writeVert * 3 + 2] = candRGB[v * 3 + 2];
          writeVert++;
        }
        pathCount++;
        recorded++;
        totalBouncesRecorded += Math.max(0, candVerts - 1);
      }
    }
  }
  pathOffsets[pathCount] = writeVert;

  // Trim. Slicing a TypedArray copies — cheap and avoids carrying the
  // empty tail through every Three.js BufferAttribute upload.
  const finalVerts = writeVert;
  return {
    pathData: pathData.slice(0, finalVerts * 3),
    pathOffsets: pathOffsets.slice(0, pathCount + 1),
    colorData: colorData.slice(0, finalVerts * 3),
    stats: {
      totalPaths: pathCount,
      avgBounces: pathCount > 0 ? totalBouncesRecorded / pathCount : 0,
      sources: S,
      receivers: R,
      bias: useListenerBias ? 'listeners' : 'uniform',
      candidatesTraced: totalCandidates,
      listenerHits: totalListenerHits,
      vertices: finalVerts,
    },
  };
}

// Build a Three.js-ready index buffer that turns the recorded paths
// into LineSegments-compatible pairs (each segment = two indices).
// Single LineSegments draw call. Indices kept as Uint32 because pavilion
// can produce 200 paths × 24 bounces ≈ 5,000 verts → fits Uint16, but
// give headroom for future N bumps.
export function buildLineSegmentIndex(pathOffsets) {
  let segCount = 0;
  for (let i = 0; i < pathOffsets.length - 1; i++) {
    const len = pathOffsets[i + 1] - pathOffsets[i];
    if (len >= 2) segCount += (len - 1);
  }
  const idx = new Uint32Array(segCount * 2);
  let w = 0;
  for (let i = 0; i < pathOffsets.length - 1; i++) {
    const start = pathOffsets[i];
    const end = pathOffsets[i + 1];
    for (let v = start; v < end - 1; v++) {
      idx[w++] = v;
      idx[w++] = v + 1;
    }
  }
  return idx;
}
