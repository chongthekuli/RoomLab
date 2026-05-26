// Hand-rolled SAH Bounding Volume Hierarchy — Phase B.1.
//
// Why hand-rolled: keeps the physics layer Node-testable without pulling
// `three` into dev deps. ~250 lines, readable, regression-testable. If
// ray-tracing perf ever becomes the bottleneck (and it won't at our
// scene sizes — 200–5,000 triangles typical), this file can be swapped
// for `three-mesh-bvh` with no API surface change beyond the import.
//
// Algorithm:
//   Build (one-shot):
//     • Compute each triangle's centroid + AABB.
//     • Recursive top-down split using the Surface-Area Heuristic (SAH):
//       at each node try a few candidate split positions along the
//       longest axis of the node's centroid-AABB; pick the one that
//       minimises  (L.area × L.count + R.area × R.count).
//     • Stop recursion at MAX_TRIS_PER_LEAF or MAX_DEPTH.
//   Query (hot path):
//     • Ray-AABB slab test (branch-free, amortized ~10 FLOPs).
//     • Möller-Trumbore ray-triangle test at leaves (~30 FLOPs).
//     • Stack-based traversal with early rejection on tmax.
//
// Output is a *flat-buffer* layout ready for structured clone /
// transferable to a worker (Phase B.3). Inner nodes are encoded as
// triangleStart = 0xFFFFFFFF so a leaf-check is a single integer
// comparison in the inner loop.

const MAX_TRIS_PER_LEAF = 4;
const MAX_DEPTH = 32;
const SAH_CANDIDATES = 12;           // split positions tried per build node
const EPS = 1e-6;

/**
 * Build a BVH from a triangle soup produced by triangulateScene().
 * @param {TriangleSoup} soup
 * @returns {BVH} — opaque handle; pass to intersectRay.
 */
export function buildBVH(soup) {
  const N = soup.count;
  if (N === 0) return { nodes: new Float32Array(0), triIndex: new Uint32Array(0), soup, nodeCount: 0 };

  // One AABB + centroid per triangle.
  const triMin = new Float32Array(N * 3);
  const triMax = new Float32Array(N * 3);
  const triCentroid = new Float32Array(N * 3);
  const pos = soup.positions;
  for (let i = 0; i < N; i++) {
    const p = i * 9;
    const xs = [pos[p], pos[p + 3], pos[p + 6]];
    const ys = [pos[p + 1], pos[p + 4], pos[p + 7]];
    const zs = [pos[p + 2], pos[p + 5], pos[p + 8]];
    triMin[i * 3 + 0] = Math.min(xs[0], xs[1], xs[2]);
    triMin[i * 3 + 1] = Math.min(ys[0], ys[1], ys[2]);
    triMin[i * 3 + 2] = Math.min(zs[0], zs[1], zs[2]);
    triMax[i * 3 + 0] = Math.max(xs[0], xs[1], xs[2]);
    triMax[i * 3 + 1] = Math.max(ys[0], ys[1], ys[2]);
    triMax[i * 3 + 2] = Math.max(zs[0], zs[1], zs[2]);
    triCentroid[i * 3 + 0] = (triMin[i * 3 + 0] + triMax[i * 3 + 0]) * 0.5;
    triCentroid[i * 3 + 1] = (triMin[i * 3 + 1] + triMax[i * 3 + 1]) * 0.5;
    triCentroid[i * 3 + 2] = (triMin[i * 3 + 2] + triMax[i * 3 + 2]) * 0.5;
  }

  // Working index array that gets partitioned in-place during build.
  const triIndex = new Uint32Array(N);
  for (let i = 0; i < N; i++) triIndex[i] = i;

  // Nodes stored in a growing JS array during build, flattened at the
  // end. Each node is { minX,minY,minZ, maxX,maxY,maxZ, triStart, triCount, leftIdx, rightIdx }
  // where leftIdx/rightIdx are indices into the same array (or -1 for
  // leaves); triStart/triCount refer to positions in triIndex.
  const nodes = [];

  function buildRecursive(start, count, depth) {
    const nodeIdx = nodes.length;
    const node = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], triStart: 0, triCount: 0, left: -1, right: -1 };
    nodes.push(node);
    for (let i = 0; i < count; i++) {
      const t = triIndex[start + i];
      for (let a = 0; a < 3; a++) {
        if (triMin[t * 3 + a] < node.min[a]) node.min[a] = triMin[t * 3 + a];
        if (triMax[t * 3 + a] > node.max[a]) node.max[a] = triMax[t * 3 + a];
      }
    }
    if (count <= MAX_TRIS_PER_LEAF || depth >= MAX_DEPTH) {
      node.triStart = start; node.triCount = count;
      return nodeIdx;
    }
    // Pick split axis: longest axis of CENTROID bounds.
    let cMin = [Infinity, Infinity, Infinity], cMax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      const t = triIndex[start + i];
      for (let a = 0; a < 3; a++) {
        if (triCentroid[t * 3 + a] < cMin[a]) cMin[a] = triCentroid[t * 3 + a];
        if (triCentroid[t * 3 + a] > cMax[a]) cMax[a] = triCentroid[t * 3 + a];
      }
    }
    const extents = [cMax[0] - cMin[0], cMax[1] - cMin[1], cMax[2] - cMin[2]];
    let axis = 0;
    if (extents[1] > extents[axis]) axis = 1;
    if (extents[2] > extents[axis]) axis = 2;
    if (extents[axis] < EPS) {
      node.triStart = start; node.triCount = count;
      return nodeIdx;
    }
    // SAH: try SAH_CANDIDATES equally-spaced splits, pick the one with
    // lowest cost. Cost = left.count·area(left) + right.count·area(right).
    let bestCost = Infinity;
    let bestPos = cMin[axis] + extents[axis] / 2;   // fallback: middle
    for (let k = 1; k < SAH_CANDIDATES; k++) {
      const pos = cMin[axis] + (extents[axis] * k) / SAH_CANDIDATES;
      let lMin = [Infinity, Infinity, Infinity], lMax = [-Infinity, -Infinity, -Infinity];
      let rMin = [Infinity, Infinity, Infinity], rMax = [-Infinity, -Infinity, -Infinity];
      let lCount = 0, rCount = 0;
      for (let i = 0; i < count; i++) {
        const t = triIndex[start + i];
        if (triCentroid[t * 3 + axis] < pos) {
          lCount++;
          for (let a = 0; a < 3; a++) {
            if (triMin[t * 3 + a] < lMin[a]) lMin[a] = triMin[t * 3 + a];
            if (triMax[t * 3 + a] > lMax[a]) lMax[a] = triMax[t * 3 + a];
          }
        } else {
          rCount++;
          for (let a = 0; a < 3; a++) {
            if (triMin[t * 3 + a] < rMin[a]) rMin[a] = triMin[t * 3 + a];
            if (triMax[t * 3 + a] > rMax[a]) rMax[a] = triMax[t * 3 + a];
          }
        }
      }
      if (lCount === 0 || rCount === 0) continue;
      const lArea = boxSurfaceArea(lMin, lMax);
      const rArea = boxSurfaceArea(rMin, rMax);
      const cost = lArea * lCount + rArea * rCount;
      if (cost < bestCost) { bestCost = cost; bestPos = pos; }
    }
    // Partition triIndex in place around bestPos on `axis`.
    let i = start, j = start + count - 1;
    while (i <= j) {
      if (triCentroid[triIndex[i] * 3 + axis] < bestPos) i++;
      else { const tmp = triIndex[i]; triIndex[i] = triIndex[j]; triIndex[j] = tmp; j--; }
    }
    const leftCount = i - start;
    const rightCount = count - leftCount;
    if (leftCount === 0 || rightCount === 0) {
      // Degenerate split — keep as leaf.
      node.triStart = start; node.triCount = count;
      return nodeIdx;
    }
    node.left = buildRecursive(start, leftCount, depth + 1);
    node.right = buildRecursive(start + leftCount, rightCount, depth + 1);
    return nodeIdx;
  }

  buildRecursive(0, N, 0);

  // Flatten to Float32Array for transferability + cache-friendly traversal.
  // Layout per node (10 floats): minX minY minZ maxX maxY maxZ triStart triCount leftIdx rightIdx
  // Leaves: leftIdx = rightIdx = -1 (stored as -1 → 0xFFFFFFFF when reinterpreted).
  const FLOATS_PER_NODE = 10;
  const flat = new Float32Array(nodes.length * FLOATS_PER_NODE);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const o = i * FLOATS_PER_NODE;
    flat[o + 0] = n.min[0]; flat[o + 1] = n.min[1]; flat[o + 2] = n.min[2];
    flat[o + 3] = n.max[0]; flat[o + 4] = n.max[1]; flat[o + 5] = n.max[2];
    flat[o + 6] = n.triStart;
    flat[o + 7] = n.triCount;
    flat[o + 8] = n.left;
    flat[o + 9] = n.right;
  }
  return {
    nodes: flat,
    triIndex,                   // permuted indices into soup positions/normals
    nodeCount: nodes.length,
    FLOATS_PER_NODE,
    soup,                       // kept for convenience; workers can drop this ref
  };
}

function boxSurfaceArea(min, max) {
  const x = max[0] - min[0];
  const y = max[1] - min[1];
  const z = max[2] - min[2];
  return 2 * (x * y + y * z + z * x);
}

/**
 * Ray-first-hit query.
 * @param {BVH} bvh
 * @param {number} ox origin x
 * @param {number} oy
 * @param {number} oz
 * @param {number} dx direction (need not be normalized)
 * @param {number} dy
 * @param {number} dz
 * @param {number} [tMax=Infinity]
 * @returns {HitInfo|null} closest hit within (EPS, tMax], or null.
 *   HitInfo = { t, triIndex, point: [x,y,z], normal: [x,y,z], materialIdx, surfaceTag, sourceKey }
 */
export function intersectRay(bvh, ox, oy, oz, dx, dy, dz, tMax = Infinity) {
  if (bvh.nodeCount === 0) return null;
  const invDx = 1 / (Math.abs(dx) > EPS ? dx : EPS);
  const invDy = 1 / (Math.abs(dy) > EPS ? dy : EPS);
  const invDz = 1 / (Math.abs(dz) > EPS ? dz : EPS);
  const nodes = bvh.nodes;
  const STRIDE = bvh.FLOATS_PER_NODE;
  const triIndex = bvh.triIndex;
  const pos = bvh.soup.positions;

  let closestT = tMax;
  let closestTri = -1;

  // Iterative traversal with a small stack (depth ≤ MAX_DEPTH).
  const stack = new Int32Array(MAX_DEPTH * 2);
  let sp = 0;
  stack[sp++] = 0;      // root node

  while (sp > 0) {
    const nodeIdx = stack[--sp];
    const o = nodeIdx * STRIDE;
    if (!rayAABB(ox, oy, oz, invDx, invDy, invDz,
                 nodes[o], nodes[o + 1], nodes[o + 2],
                 nodes[o + 3], nodes[o + 4], nodes[o + 5], closestT)) continue;
    const left = nodes[o + 8];
    const right = nodes[o + 9];
    if (left < 0) {
      // Leaf — test all triangles.
      const start = nodes[o + 6];
      const cnt = nodes[o + 7];
      for (let i = 0; i < cnt; i++) {
        const ti = triIndex[start + i];
        const t = rayTriangle(ox, oy, oz, dx, dy, dz,
                              pos, ti * 9, closestT);
        if (t > EPS && t < closestT) {
          closestT = t;
          closestTri = ti;
        }
      }
    } else {
      // Inner node — push children. Push farther first so we process
      // nearer one first (cheap traversal-order optimization).
      stack[sp++] = left;
      stack[sp++] = right;
    }
  }

  if (closestTri < 0) return null;
  const soup = bvh.soup;
  return {
    t: closestT,
    triIndex: closestTri,
    point: [ox + dx * closestT, oy + dy * closestT, oz + dz * closestT],
    normal: [
      soup.normals[closestTri * 3 + 0],
      soup.normals[closestTri * 3 + 1],
      soup.normals[closestTri * 3 + 2],
    ],
    materialIdx: soup.materialIdx[closestTri],
    surfaceTag: soup.surfaceTag[closestTri],
    sourceKey: soup.sourceKey[closestTri],
  };
}

// Branch-minimal slab test. Returns true if the ray intersects the AABB
// within [EPS, tMax].
function rayAABB(ox, oy, oz, invDx, invDy, invDz, minX, minY, minZ, maxX, maxY, maxZ, tMax) {
  let t1 = (minX - ox) * invDx;
  let t2 = (maxX - ox) * invDx;
  let tmin = Math.min(t1, t2);
  let tmaxCur = Math.max(t1, t2);
  t1 = (minY - oy) * invDy;
  t2 = (maxY - oy) * invDy;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmaxCur = Math.min(tmaxCur, Math.max(t1, t2));
  t1 = (minZ - oz) * invDz;
  t2 = (maxZ - oz) * invDz;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmaxCur = Math.min(tmaxCur, Math.max(t1, t2));
  return tmaxCur >= Math.max(tmin, 0) && tmin <= tMax;
}

// Möller–Trumbore ray-triangle. Reads vertex data directly out of the
// triangle soup's flat positions array via offset `o`. Returns t on hit,
// -1 on miss. Ray direction is NOT normalised (caller supplies tMax
// matching their distance units).
function rayTriangle(ox, oy, oz, dx, dy, dz, pos, o, tMax) {
  const v0x = pos[o + 0], v0y = pos[o + 1], v0z = pos[o + 2];
  const v1x = pos[o + 3], v1y = pos[o + 4], v1z = pos[o + 5];
  const v2x = pos[o + 6], v2y = pos[o + 7], v2z = pos[o + 8];
  const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
  const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < EPS) return -1;
  const invDet = 1 / det;
  const tx = ox - v0x, ty = oy - v0y, tz = oz - v0z;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (t < EPS || t > tMax) return -1;
  return t;
}

// =====================================================================
// AABB-only BVH — for the FurnitureLAB Beer-Lambert absorber sink.
//
// Same node layout as the triangle BVH (10 floats), but each leaf
// "triangle" is an axis-aligned bounding box. Build is cheaper (no
// Möller-Trumbore at leaves), and the query is "collect ALL crossings
// along the segment with their entry/exit t-values" — NOT closest-hit.
// The collected list lets the tracer compute Σ μ·L_in for the
// Beer-Lambert sink (Dr. Chen brief 2026-05-26 / Kuttruff §4.1).
//
// Architectural choice (Mehmet's perf brief 2026-05-26): a SEPARATE BVH
// for furniture rather than mixing AABB-leaves into the wall BVH. Two
// reasons: (1) wall intersect wants closest-hit; furniture intersect
// wants collect-all — two different traversals; (2) skip-when-empty is
// trivially free at the query call site when the furniture BVH count
// is zero (no branch in the hot loop, just an early-return guard).
// =====================================================================

/**
 * Build an AABB-only BVH from the per-instance bbox array on the scene
 * snapshot (`scene.furniture.bboxes`, Float32Array(N*6) layout —
 * minX,minY,minZ,maxX,maxY,maxZ per instance).
 *
 * @param {Float32Array} bboxes  flat AABB array, length = N*6
 * @returns {AabbBVH} opaque handle for intersectRay_collectAabbs.
 */
export function buildAabbBVH(bboxes) {
  const N = bboxes.length / 6;
  if (N === 0) {
    return Object.freeze({
      nodes: new Float32Array(0),
      aabbIndex: new Uint32Array(0),
      nodeCount: 0,
      FLOATS_PER_NODE: 10,
      bboxes,
    });
  }

  const centroid = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const o = i * 6;
    centroid[i * 3 + 0] = (bboxes[o + 0] + bboxes[o + 3]) * 0.5;
    centroid[i * 3 + 1] = (bboxes[o + 1] + bboxes[o + 4]) * 0.5;
    centroid[i * 3 + 2] = (bboxes[o + 2] + bboxes[o + 5]) * 0.5;
  }
  const aabbIndex = new Uint32Array(N);
  for (let i = 0; i < N; i++) aabbIndex[i] = i;

  const nodes = [];

  function nodeBounds(start, count) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const a = aabbIndex[start + i];
      const o = a * 6;
      if (bboxes[o + 0] < minX) minX = bboxes[o + 0];
      if (bboxes[o + 1] < minY) minY = bboxes[o + 1];
      if (bboxes[o + 2] < minZ) minZ = bboxes[o + 2];
      if (bboxes[o + 3] > maxX) maxX = bboxes[o + 3];
      if (bboxes[o + 4] > maxY) maxY = bboxes[o + 4];
      if (bboxes[o + 5] > maxZ) maxZ = bboxes[o + 5];
    }
    return [minX, minY, minZ, maxX, maxY, maxZ];
  }

  function buildRecursive(start, count, depth) {
    const nodeIdx = nodes.length;
    const [minX, minY, minZ, maxX, maxY, maxZ] = nodeBounds(start, count);
    const node = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], aabbStart: 0, aabbCount: 0, left: -1, right: -1 };
    nodes.push(node);
    if (count <= MAX_TRIS_PER_LEAF || depth >= MAX_DEPTH) {
      node.aabbStart = start; node.aabbCount = count;
      return nodeIdx;
    }
    let cMin = [Infinity, Infinity, Infinity], cMax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      const a = aabbIndex[start + i];
      for (let ax = 0; ax < 3; ax++) {
        const v = centroid[a * 3 + ax];
        if (v < cMin[ax]) cMin[ax] = v;
        if (v > cMax[ax]) cMax[ax] = v;
      }
    }
    let axis = 0, extent = cMax[0] - cMin[0];
    if (cMax[1] - cMin[1] > extent) { axis = 1; extent = cMax[1] - cMin[1]; }
    if (cMax[2] - cMin[2] > extent) { axis = 2; extent = cMax[2] - cMin[2]; }
    if (extent < EPS) {
      node.aabbStart = start; node.aabbCount = count;
      return nodeIdx;
    }
    const splitPos = (cMin[axis] + cMax[axis]) * 0.5;
    let i = start, j = start + count - 1;
    while (i <= j) {
      if (centroid[aabbIndex[i] * 3 + axis] < splitPos) i++;
      else { const tmp = aabbIndex[i]; aabbIndex[i] = aabbIndex[j]; aabbIndex[j] = tmp; j--; }
    }
    const leftCount = i - start;
    const rightCount = count - leftCount;
    if (leftCount === 0 || rightCount === 0) {
      node.aabbStart = start; node.aabbCount = count;
      return nodeIdx;
    }
    node.left  = buildRecursive(start, leftCount, depth + 1);
    node.right = buildRecursive(start + leftCount, rightCount, depth + 1);
    return nodeIdx;
  }

  buildRecursive(0, N, 0);

  const FLOATS_PER_NODE = 10;
  const flat = new Float32Array(nodes.length * FLOATS_PER_NODE);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const o = i * FLOATS_PER_NODE;
    flat[o + 0] = n.min[0]; flat[o + 1] = n.min[1]; flat[o + 2] = n.min[2];
    flat[o + 3] = n.max[0]; flat[o + 4] = n.max[1]; flat[o + 5] = n.max[2];
    flat[o + 6] = n.aabbStart;
    flat[o + 7] = n.aabbCount;
    flat[o + 8] = n.left;
    flat[o + 9] = n.right;
  }
  return {
    nodes: flat,
    aabbIndex,
    nodeCount: nodes.length,
    FLOATS_PER_NODE,
    bboxes,
  };
}

/**
 * Collect ALL AABB crossings on a finite ray segment [0, tMax].
 *
 * For each AABB the ray segment overlaps, writes { idx, tEnter, tExit }
 * with both clamped to [0, tMax]. Pathlength inside the bbox is
 * (tExit - tEnter) * |dir|; the caller supplies the scaling.
 *
 * `out` is a caller-supplied scratch array; written stride-3 (idx,
 * tEnter, tExit per crossing). Returns the number of crossings.
 *
 * Sign-bug guard: tEnter clamps to Math.max(tEnter, 0) NOT abs(tEnter)
 * — a grazing ray with tEnter slightly negative is INSIDE the bbox at
 * the ray origin, so the in-bbox path starts at t=0, not at |tEnter|.
 */
export function intersectRay_collectAabbs(bvh, ox, oy, oz, dx, dy, dz, tMax, out) {
  if (!bvh || bvh.nodeCount === 0) { out.length = 0; return 0; }
  const invDx = 1 / (Math.abs(dx) > EPS ? dx : (dx >= 0 ? EPS : -EPS));
  const invDy = 1 / (Math.abs(dy) > EPS ? dy : (dy >= 0 ? EPS : -EPS));
  const invDz = 1 / (Math.abs(dz) > EPS ? dz : (dz >= 0 ? EPS : -EPS));
  const nodes = bvh.nodes;
  const STRIDE = bvh.FLOATS_PER_NODE;
  const aabbIndex = bvh.aabbIndex;
  const bboxes = bvh.bboxes;

  let written = 0;
  const stack = new Int32Array(MAX_DEPTH * 2);
  let sp = 0;
  stack[sp++] = 0;

  while (sp > 0) {
    const nodeIdx = stack[--sp];
    const o = nodeIdx * STRIDE;
    if (!rayAABB(ox, oy, oz, invDx, invDy, invDz,
                 nodes[o], nodes[o + 1], nodes[o + 2],
                 nodes[o + 3], nodes[o + 4], nodes[o + 5], tMax)) continue;
    const left = nodes[o + 8];
    if (left < 0) {
      const start = nodes[o + 6];
      const cnt = nodes[o + 7];
      for (let i = 0; i < cnt; i++) {
        const a = aabbIndex[start + i];
        const ao = a * 6;
        let t1 = (bboxes[ao + 0] - ox) * invDx;
        let t2 = (bboxes[ao + 3] - ox) * invDx;
        let tEnter = Math.min(t1, t2);
        let tExit  = Math.max(t1, t2);
        t1 = (bboxes[ao + 1] - oy) * invDy;
        t2 = (bboxes[ao + 4] - oy) * invDy;
        tEnter = Math.max(tEnter, Math.min(t1, t2));
        tExit  = Math.min(tExit,  Math.max(t1, t2));
        t1 = (bboxes[ao + 2] - oz) * invDz;
        t2 = (bboxes[ao + 5] - oz) * invDz;
        tEnter = Math.max(tEnter, Math.min(t1, t2));
        tExit  = Math.min(tExit,  Math.max(t1, t2));
        if (tEnter < 0) tEnter = 0;
        if (tExit > tMax) tExit = tMax;
        if (tExit <= tEnter) continue;
        out[written * 3 + 0] = a;
        out[written * 3 + 1] = tEnter;
        out[written * 3 + 2] = tExit;
        written++;
      }
    } else {
      const right = nodes[o + 9];
      stack[sp++] = left;
      stack[sp++] = right;
    }
  }
  out.length = written * 3;
  return written;
}

// --- Naive brute-force intersector — for testing + sanity. -------------
// Iterates every triangle; O(N). Used in tests to verify BVH agreement.
export function intersectRayBrute(soup, ox, oy, oz, dx, dy, dz, tMax = Infinity) {
  let closestT = tMax;
  let closestTri = -1;
  for (let ti = 0; ti < soup.count; ti++) {
    const t = rayTriangle(ox, oy, oz, dx, dy, dz, soup.positions, ti * 9, closestT);
    if (t > EPS && t < closestT) { closestT = t; closestTri = ti; }
  }
  if (closestTri < 0) return null;
  return {
    t: closestT,
    triIndex: closestTri,
    point: [ox + dx * closestT, oy + dy * closestT, oz + dz * closestT],
    normal: [
      soup.normals[closestTri * 3 + 0],
      soup.normals[closestTri * 3 + 1],
      soup.normals[closestTri * 3 + 2],
    ],
    materialIdx: soup.materialIdx[closestTri],
    surfaceTag: soup.surfaceTag[closestTri],
    sourceKey: soup.sourceKey[closestTri],
  };
}
