// Scene → triangle soup — Phase B.1 (rectangular rooms + zones + scoreboard).
//
// Given a PhysicsScene snapshot (from scene-snapshot.js), produce a flat
// triangle list suitable for BVH construction and ray tracing. Output is
// pure typed arrays so it can be transferred to a worker without copies.
//
// Coverage in this commit:
//   • rectangular room shell — floor, ceiling, 4 walls (12 triangles)
//   • audience zones — flat convex polygons at zone.elevation_m
//     (fan-triangulated from vertex 0)
//   • stadium scoreboard — 6-face box
//
// Deferred to Phase B.2:
//   • polygon-shaped rooms (arena, rotunda)
//   • round rooms
//   • dome ceilings (spherical-cap tessellation)
//   • stadium bowl lathe triangulation
//   • concave zone polygons (would need ear clipping)
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

export function triangulateScene(scene) {
  if (!scene) throw new Error('triangulateScene: scene is required');
  const tris = [];   // temporary; converted to typed arrays at end

  triangulateRectangularRoom(scene, tris);
  triangulateZones(scene, tris);
  triangulateScoreboard(scene, tris);

  return finalizeBuffer(tris);
}

// --- Rectangular room shell -------------------------------------------

function triangulateRectangularRoom(scene, tris) {
  const room = scene.room;
  if (room.shape !== 'rectangular' && room.shape !== 'custom') {
    // Phase B.2 will add polygon/round/dome paths. Until then the caller
    // gets an incomplete scene — log once so the ray tracer doesn't
    // silently miss entire geometries.
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[triangulateScene] room.shape="${room.shape}" not yet triangulated (Phase B.2). Returning partial scene.`);
    }
    return;
  }
  const w = room.width_m;
  const d = room.depth_m;
  const h = room.height_m;
  // Wall-material lookup: use explicit wall_* entries if present, else fall back to surfaces.walls.
  const S = room.surfaces || {};
  const floorMat   = materialIdxFor(scene, S.floor);
  const ceilingMat = materialIdxFor(scene, S.ceiling);
  const wallN = materialIdxFor(scene, S.wall_north ?? S.walls);
  const wallS = materialIdxFor(scene, S.wall_south ?? S.walls);
  const wallE = materialIdxFor(scene, S.wall_east  ?? S.walls);
  const wallW = materialIdxFor(scene, S.wall_west  ?? S.walls);

  // Floor (normal points UP, +z).
  pushQuad(tris,
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, 1], floorMat, TAG_FLOOR, 'floor');
  // Ceiling (normal points DOWN, -z).
  pushQuad(tris,
    [0, 0, h], [0, d, h], [w, d, h], [w, 0, h],
    [0, 0, -1], ceilingMat, TAG_CEILING, 'ceiling');
  // Wall north (y = d, normal points -y).
  pushQuad(tris,
    [0, d, 0], [w, d, 0], [w, d, h], [0, d, h],
    [0, -1, 0], wallN, TAG_WALL, 'wall_north');
  // Wall south (y = 0, normal points +y).
  pushQuad(tris,
    [w, 0, 0], [0, 0, 0], [0, 0, h], [w, 0, h],
    [0, 1, 0], wallS, TAG_WALL, 'wall_south');
  // Wall east (x = w, normal points -x).
  pushQuad(tris,
    [w, 0, 0], [w, d, 0], [w, d, h], [w, 0, h],
    [-1, 0, 0], wallE, TAG_WALL, 'wall_east');
  // Wall west (x = 0, normal points +x).
  pushQuad(tris,
    [0, d, 0], [0, 0, 0], [0, 0, h], [0, d, h],
    [1, 0, 0], wallW, TAG_WALL, 'wall_west');
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
