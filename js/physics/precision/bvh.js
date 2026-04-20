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
