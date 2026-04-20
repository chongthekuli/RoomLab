// Scene → triangle soup — Phase B.1 + B.2.
//
// Given a PhysicsScene snapshot (from scene-snapshot.js), produce a flat
// triangle list suitable for BVH construction and ray tracing. Output is
// pure typed arrays so it can be transferred to a worker without copies.
//
// Coverage:
//   B.1 (prior)
//     • rectangular room shell — floor, ceiling, 4 walls
//     • audience zones — flat convex polygons at zone.elevation_m
//     • stadium scoreboard — 6-face box
//   B.2 (this commit)
//     • polygon-shaped rooms (auditorium, chamber, recitalhall, octagon)
//     • round rooms (rotunda) — approximated as 32-sided polygon
//     • dome ceilings — spherical-cap tessellation (lat × lon grid)
//     • custom-vertex rooms
//
// Deferred:
//   • stadium bowl risers / retaining walls / concourse ring (B.2.5 —
//     needs a physics-side reconstruction of the scene.js lathe geometry
//     or an extractor that pulls triangles out of the built Three.js
//     meshes). Zone tops (where audience sits) ARE already triangulated
//     via the zones path, so the most acoustically-significant surfaces
//     are covered.
//   • concave zone polygons (would need ear clipping; no current preset
//     uses them).
//
// Output shape:
//   TriangleSoup = {
//     positions: Float32Array(N*9)         // 3 verts × xyz per triangle
//     normals:   Float32Array(N*3)         // face normal per triangle
//     materialIdx: Int16Array(N)           // index into scene.materials (-1 = no material)
//     surfaceTag:  Uint16Array(N)          // debug tag (floor=1, ceiling=2, wall=3, zone=4, scoreboard=5)
//     sourceKey:   string[]                // human-readable "floor" / "zone_Z_lb1_1" etc.
//     count: number                        // triangle count
//     aabb: { min: [x,y,z], max: [x,y,z] } // scene bounding box for BVH root
//   }
//
// Coordinate convention matches the rest of the physics layer:
//   +x right, +y depth-into-room, +z up.
// Every triangle's vertices are ordered so its outward-facing normal
// points INTO the room interior (the side sound waves reflect from).

const TAG_FLOOR = 1;
const TAG_CEILING = 2;
const TAG_WALL = 3;
const TAG_ZONE = 4;
const TAG_SCOREBOARD = 5;

export const SURFACE_TAGS = {
  FLOOR: TAG_FLOOR,
  CEILING: TAG_CEILING,
  WALL: TAG_WALL,
  ZONE: TAG_ZONE,
  SCOREBOARD: TAG_SCOREBOARD,
};

// Subdivisions for curved geometry. Too low → faceting visible in early
// reflections; too high → BVH overhead. 32 sides for a round room and
// (8 lat × 24 lon) for a dome is a reasonable default for real-sized
// venues. Tuneable via the top-level options param.
const DEFAULT_ROUND_SIDES = 32;
const DEFAULT_DOME_LATITUDES = 8;
const DEFAULT_DOME_LONGITUDES = 24;

export function triangulateScene(scene, opts = {}) {
  if (!scene) throw new Error('triangulateScene: scene is required');
  const tris = [];
  const roundSides    = opts.roundSides    ?? DEFAULT_ROUND_SIDES;
  const domeLatitudes = opts.domeLatitudes ?? DEFAULT_DOME_LATITUDES;
  const domeLongitudes= opts.domeLongitudes?? DEFAULT_DOME_LONGITUDES;

  const room = scene.room;
  const shape = room.shape;
  switch (shape) {
    case 'rectangular':
      triangulateRectangularRoom(scene, tris);
      break;
    case 'polygon':
      triangulatePolygonalRoom(scene, tris, { domeLatitudes, domeLongitudes });
      break;
    case 'round':
      triangulatePolygonalRoom(scene, tris, {
        overrideSides: roundSides,
        domeLatitudes, domeLongitudes,
      });
      break;
    case 'custom':
      triangulateCustomRoom(scene, tris);
      break;
    default:
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[triangulateScene] unknown room.shape="${shape}"`);
      }
  }

  triangulateZones(scene, tris);
  triangulateScoreboard(scene, tris);

  return finalizeBuffer(tris);
}

// --- Rectangular room shell -------------------------------------------

function triangulateRectangularRoom(scene, tris) {
  const room = scene.room;
  const w = room.width_m;
  const d = room.depth_m;
  const h = room.height_m;
  const S = room.surfaces || {};
  const floorMat   = materialIdxFor(scene, S.floor);
  const ceilingMat = materialIdxFor(scene, S.ceiling);
  const wallN = materialIdxFor(scene, S.wall_north ?? S.walls);
  const wallS = materialIdxFor(scene, S.wall_south ?? S.walls);
  const wallE = materialIdxFor(scene, S.wall_east  ?? S.walls);
  const wallW = materialIdxFor(scene, S.wall_west  ?? S.walls);

  pushQuad(tris,
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, 1], floorMat, TAG_FLOOR, 'floor');
  pushQuad(tris,
    [0, 0, h], [0, d, h], [w, d, h], [w, 0, h],
    [0, 0, -1], ceilingMat, TAG_CEILING, 'ceiling');
  pushQuad(tris,
    [0, d, 0], [w, d, 0], [w, d, h], [0, d, h],
    [0, -1, 0], wallN, TAG_WALL, 'wall_north');
  pushQuad(tris,
    [w, 0, 0], [0, 0, 0], [0, 0, h], [w, 0, h],
    [0, 1, 0], wallS, TAG_WALL, 'wall_south');
  pushQuad(tris,
    [w, 0, 0], [w, d, 0], [w, d, h], [w, 0, h],
    [-1, 0, 0], wallE, TAG_WALL, 'wall_east');
  pushQuad(tris,
    [0, d, 0], [0, 0, 0], [0, 0, h], [0, d, h],
    [1, 0, 0], wallW, TAG_WALL, 'wall_west');
}

// --- Polygon / round room shell ---------------------------------------
// Polygon: N vertices on a circle of radius polygon_radius_m, centered on
// (width_m/2, depth_m/2). Each wall is a rectangle between two adjacent
// polygon verts, from z=0 to z=height_m. Floor fan-triangulates from the
// centroid; ceiling either flat-fans the same way or (if ceiling_type=
// 'dome') is replaced by the spherical-cap tessellation.

function triangulatePolygonalRoom(scene, tris, { overrideSides, domeLatitudes, domeLongitudes }) {
  const room = scene.room;
  const N = overrideSides ?? (room.polygon_sides ?? 6);
  const r = room.shape === 'round'
    ? (room.round_radius_m ?? (room.width_m / 2))
    : (room.polygon_radius_m ?? (room.width_m / 2));
  const cx = (room.width_m ?? (2 * r)) / 2;
  const cy = (room.depth_m ?? (2 * r)) / 2;
  const h = room.height_m;

  const S = room.surfaces || {};
  const floorMat   = materialIdxFor(scene, S.floor);
  const ceilingMat = materialIdxFor(scene, S.ceiling);
  const wallMat    = materialIdxFor(scene, S.walls ?? S.wall_north ?? S.wall_south ?? S.wall_east ?? S.wall_west);

  // Polygon vertices at z=0 — shared by floor fan + wall bottom edge.
  const verts = new Array(N);
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * 2 * Math.PI;
    verts[i] = [cx + r * Math.cos(theta), cy + r * Math.sin(theta)];
  }

  // Floor: fan-triangulate from centroid. Normal +z.
  for (let i = 0; i < N; i++) {
    const a = verts[i], b = verts[(i + 1) % N];
    pushTri(tris,
      [cx, cy, 0], [a[0], a[1], 0], [b[0], b[1], 0],
      [0, 0, 1], floorMat, TAG_FLOOR, 'floor');
  }

  // Walls: N rectangles. Normal points inward (toward centroid).
  for (let i = 0; i < N; i++) {
    const a = verts[i], b = verts[(i + 1) % N];
    // Midpoint → centroid direction gives inward normal.
    const midX = (a[0] + b[0]) / 2, midY = (a[1] + b[1]) / 2;
    let nx = cx - midX, ny = cy - midY;
    const nLen = Math.hypot(nx, ny);
    if (nLen > 1e-9) { nx /= nLen; ny /= nLen; } else { nx = 0; ny = 0; }
    pushQuad(tris,
      [a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], h], [a[0], a[1], h],
      [nx, ny, 0], wallMat, TAG_WALL, `wall_${i}`);
  }

  // Ceiling: flat polygon fan OR dome tessellation.
  if (room.ceiling_type === 'dome' && (room.ceiling_dome_rise_m ?? 0) > 0) {
    triangulateDomeCap(tris, cx, cy, r, h, room.ceiling_dome_rise_m,
      ceilingMat, domeLatitudes, domeLongitudes);
  } else {
    for (let i = 0; i < N; i++) {
      const a = verts[i], b = verts[(i + 1) % N];
      // Ceiling normal points DOWN (-z) — winding reversed vs floor.
      pushTri(tris,
        [cx, cy, h], [b[0], b[1], h], [a[0], a[1], h],
        [0, 0, -1], ceilingMat, TAG_CEILING, 'ceiling');
    }
  }
}

// --- Spherical-cap dome tessellation ----------------------------------
// A spherical cap of base radius `a` (equivalent circle from polygon
// footprint) and rise `d`, centered on (cx, cy) with its base plane at
// z = baseZ. Tessellated via a (latitude × longitude) grid. Each quad
// lies on the sphere; inner normals point down-and-inward toward the
// sphere centre below the apex.
//
// Sphere geometry:
//   The cap sphere has radius R = (a² + d²) / (2d) (standard formula).
//   Sphere centre sits at (cx, cy, baseZ + d − R) — below the base
//   plane when d < a (shallow dome), above when d > a.
//
// Each quad's normal is the inward-pointing radial vector at the quad's
// midpoint (i.e. from the quad toward the sphere centre). This is the
// correct direction for rays striking the dome from below.

function triangulateDomeCap(tris, cx, cy, a, baseZ, rise_m, matIdx, latBands, lonBands) {
  const d = rise_m;
  const R = (a * a + d * d) / (2 * d);        // sphere radius
  const zSphereCentre = baseZ + d - R;
  // The cap spans polar angle θ from 0 (apex) to θ_max = acos((R - d) / R).
  const thetaMax = Math.acos((R - d) / R);

  // Generate vertex grid.
  // verts[i][j] for i ∈ [0, latBands], j ∈ [0, lonBands]
  // i=0 is the apex (collapsed to a single point), i=latBands is the base rim.
  const grid = new Array(latBands + 1);
  for (let i = 0; i <= latBands; i++) {
    const theta = (i / latBands) * thetaMax;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    grid[i] = new Array(lonBands);
    for (let j = 0; j < lonBands; j++) {
      const phi = (j / lonBands) * 2 * Math.PI;
      const x = cx + R * sinT * Math.cos(phi);
      const y = cy + R * sinT * Math.sin(phi);
      const z = zSphereCentre + R * cosT;
      grid[i][j] = [x, y, z];
    }
  }

  // Build triangles. At i=0 the apex is a single point — we'd get
  // degenerate triangles if we used the quad pattern. Handle the first
  // ring (i=0 to 1) as triangle fan from the apex.
  const apex = grid[0][0];   // all j collapse to one point at apex; pick [0]

  for (let j = 0; j < lonBands; j++) {
    const v1 = grid[1][j];
    const v2 = grid[1][(j + 1) % lonBands];
    // Inward normal at mid-triangle = (midpoint − sphereCentre) reversed.
    const mx = (apex[0] + v1[0] + v2[0]) / 3;
    const my = (apex[1] + v1[1] + v2[1]) / 3;
    const mz = (apex[2] + v1[2] + v2[2]) / 3;
    const nx = -(mx - cx) / R;
    const ny = -(my - cy) / R;
    const nz = -(mz - zSphereCentre) / R;
    pushTri(tris, apex, v2, v1, [nx, ny, nz], matIdx, TAG_CEILING, `dome_apex_${j}`);
  }

  // Remaining rings: i=1..latBands-1 → quads split into 2 triangles each.
  for (let i = 1; i < latBands; i++) {
    for (let j = 0; j < lonBands; j++) {
      const v00 = grid[i][j];
      const v01 = grid[i][(j + 1) % lonBands];
      const v10 = grid[i + 1][j];
      const v11 = grid[i + 1][(j + 1) % lonBands];
      // Inward normals at each quad — use average of vertex inward radials.
      const avgX = (v00[0] + v01[0] + v10[0] + v11[0]) / 4;
      const avgY = (v00[1] + v01[1] + v10[1] + v11[1]) / 4;
      const avgZ = (v00[2] + v01[2] + v10[2] + v11[2]) / 4;
      const nx = -(avgX - cx) / R;
      const ny = -(avgY - cy) / R;
      const nz = -(avgZ - zSphereCentre) / R;
      pushQuad(tris, v00, v10, v11, v01, [nx, ny, nz], matIdx, TAG_CEILING, `dome_i${i}_j${j}`);
    }
  }
}

// --- Custom-vertex room -----------------------------------------------
// User-drawn 2D polygon footprint extruded to room.height_m. Floor is
// fan-triangulated from vertex 0 (assumes convex — same assumption as
// the rest of the codebase). Walls per edge.

function triangulateCustomRoom(scene, tris) {
  const room = scene.room;
  const verts = room.custom_vertices;
  if (!Array.isArray(verts) || verts.length < 3) return;
  const h = room.height_m;
  const S = room.surfaces || {};
  const floorMat   = materialIdxFor(scene, S.floor);
  const ceilingMat = materialIdxFor(scene, S.ceiling);
  const wallMat    = materialIdxFor(scene, S.walls ?? S.wall_north);

  // Centroid (for inward-normal computation).
  let cx = 0, cy = 0;
  for (const v of verts) { cx += v.x; cy += v.y; }
  cx /= verts.length; cy /= verts.length;

  // Floor: fan-triangulate from vertex 0.
  const v0 = [verts[0].x, verts[0].y, 0];
  for (let i = 1; i < verts.length - 1; i++) {
    const v1 = [verts[i].x, verts[i].y, 0];
    const v2 = [verts[i + 1].x, verts[i + 1].y, 0];
    pushTri(tris, v0, v1, v2, [0, 0, 1], floorMat, TAG_FLOOR, 'floor');
  }
  // Ceiling: same fan, reversed winding for -z normal.
  const v0c = [verts[0].x, verts[0].y, h];
  for (let i = 1; i < verts.length - 1; i++) {
    const v1 = [verts[i].x, verts[i].y, h];
    const v2 = [verts[i + 1].x, verts[i + 1].y, h];
    pushTri(tris, v0c, v2, v1, [0, 0, -1], ceilingMat, TAG_CEILING, 'ceiling');
  }
  // Walls.
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    let nx = cx - midX, ny = cy - midY;
    const nLen = Math.hypot(nx, ny);
    if (nLen > 1e-9) { nx /= nLen; ny /= nLen; }
    pushQuad(tris,
      [a.x, a.y, 0], [b.x, b.y, 0], [b.x, b.y, h], [a.x, a.y, h],
      [nx, ny, 0], wallMat, TAG_WALL, `wall_${i}`);
  }
}

// --- Audience zones ---------------------------------------------------

function triangulateZones(scene, tris) {
  const zones = scene.zones ?? [];
  for (let zi = 0; zi < zones.length; zi++) {
    const z = zones[zi];
    if (!z.verticesXY || z.vertexCount < 3) continue;
    const elev = z.elevation_m ?? 0;
    // Fan-triangulate from vertex 0 — correct for convex polygons, which
    // all current preset zones are. Concave zones would need ear clipping
    // (future work).
    const xy = z.verticesXY;
    const v0 = [xy[0], xy[1], elev];
    for (let i = 1; i < z.vertexCount - 1; i++) {
      const v1 = [xy[i * 2], xy[i * 2 + 1], elev];
      const v2 = [xy[(i + 1) * 2], xy[(i + 1) * 2 + 1], elev];
      // Zones are horizontal patches; normal points up (+z) so sound from
      // above reflects / absorbs. We store materialIdx for the resolved
      // (occupancy-blended) zone material.
      pushTri(tris, v0, v1, v2, [0, 0, 1],
        z.materialIdx, TAG_ZONE, `zone_${z.id}`);
    }
  }
}

// --- Stadium scoreboard (axis-aligned box) ----------------------------

function triangulateScoreboard(scene, tris) {
  const sb = scene.room?.stadiumStructure?.scoreboard;
  if (!sb) return;
  const cx = sb.cx, cy = sb.cy, cz = sb.center_z_m;
  const w2 = sb.width_m / 2, h2 = sb.height_m / 2;
  const matIdx = sb.material_id
    ? materialIdxFor(scene, sb.material_id)
    : materialIdxFor(scene, 'led-glass');
  // 8 corners.
  const pX0Y0Z0 = [cx - w2, cy - w2, cz - h2];
  const pX1Y0Z0 = [cx + w2, cy - w2, cz - h2];
  const pX1Y1Z0 = [cx + w2, cy + w2, cz - h2];
  const pX0Y1Z0 = [cx - w2, cy + w2, cz - h2];
  const pX0Y0Z1 = [cx - w2, cy - w2, cz + h2];
  const pX1Y0Z1 = [cx + w2, cy - w2, cz + h2];
  const pX1Y1Z1 = [cx + w2, cy + w2, cz + h2];
  const pX0Y1Z1 = [cx - w2, cy + w2, cz + h2];

  // Six outward-facing faces. Normals point OUTWARD (the scoreboard
  // reflects sound from the outside — this matches its acoustic role as
  // a hard reflector centered above the court).
  pushQuad(tris, pX0Y1Z0, pX1Y1Z0, pX1Y1Z1, pX0Y1Z1, [ 0,  1, 0], matIdx, TAG_SCOREBOARD, 'scoreboard_north');
  pushQuad(tris, pX1Y0Z0, pX0Y0Z0, pX0Y0Z1, pX1Y0Z1, [ 0, -1, 0], matIdx, TAG_SCOREBOARD, 'scoreboard_south');
  pushQuad(tris, pX1Y1Z0, pX1Y0Z0, pX1Y0Z1, pX1Y1Z1, [ 1,  0, 0], matIdx, TAG_SCOREBOARD, 'scoreboard_east');
  pushQuad(tris, pX0Y0Z0, pX0Y1Z0, pX0Y1Z1, pX0Y0Z1, [-1,  0, 0], matIdx, TAG_SCOREBOARD, 'scoreboard_west');
  pushQuad(tris, pX0Y0Z1, pX0Y1Z1, pX1Y1Z1, pX1Y0Z1, [ 0,  0, 1], matIdx, TAG_SCOREBOARD, 'scoreboard_top');
  pushQuad(tris, pX0Y1Z0, pX0Y0Z0, pX1Y0Z0, pX1Y1Z0, [ 0,  0,-1], matIdx, TAG_SCOREBOARD, 'scoreboard_bottom');
}

// --- Helpers ----------------------------------------------------------

function materialIdxFor(scene, matId) {
  if (!matId) return -1;
  const list = scene.materials;
  for (let i = 0; i < list.length; i++) if (list[i].id === matId) return i;
  return -1;
}

function pushTri(tris, v0, v1, v2, normal, materialIdx, tag, sourceKey) {
  tris.push({ v0, v1, v2, normal, materialIdx, tag, sourceKey });
}

function pushQuad(tris, v0, v1, v2, v3, normal, materialIdx, tag, sourceKey) {
  pushTri(tris, v0, v1, v2, normal, materialIdx, tag, sourceKey);
  pushTri(tris, v0, v2, v3, normal, materialIdx, tag, sourceKey);
}

function finalizeBuffer(tris) {
  const N = tris.length;
  const positions = new Float32Array(N * 9);
  const normals = new Float32Array(N * 3);
  const materialIdx = new Int16Array(N);
  const surfaceTag = new Uint16Array(N);
  const sourceKey = new Array(N);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < N; i++) {
    const t = tris[i];
    const p = i * 9;
    positions[p + 0] = t.v0[0]; positions[p + 1] = t.v0[1]; positions[p + 2] = t.v0[2];
    positions[p + 3] = t.v1[0]; positions[p + 4] = t.v1[1]; positions[p + 5] = t.v1[2];
    positions[p + 6] = t.v2[0]; positions[p + 7] = t.v2[1]; positions[p + 8] = t.v2[2];
    normals[i * 3 + 0] = t.normal[0];
    normals[i * 3 + 1] = t.normal[1];
    normals[i * 3 + 2] = t.normal[2];
    materialIdx[i] = t.materialIdx ?? -1;
    surfaceTag[i] = t.tag ?? 0;
    sourceKey[i] = t.sourceKey ?? '';
    // bounds
    for (const v of [t.v0, t.v1, t.v2]) {
      if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
      if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
    }
  }
  return {
    count: N,
    positions,
    normals,
    materialIdx,
    surfaceTag,
    sourceKey,
    aabb: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    },
  };
}
