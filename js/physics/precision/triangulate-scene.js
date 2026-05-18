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

import { applySurauOpeningsToSlot } from '../room-shape.js';

const TAG_FLOOR = 1;
const TAG_CEILING = 2;
const TAG_WALL = 3;
const TAG_ZONE = 4;
const TAG_SCOREBOARD = 5;
const TAG_TREATMENT = 6;

export const SURFACE_TAGS = {
  FLOOR: TAG_FLOOR,
  CEILING: TAG_CEILING,
  WALL: TAG_WALL,
  ZONE: TAG_ZONE,
  SCOREBOARD: TAG_SCOREBOARD,
  TREATMENT: TAG_TREATMENT,
};

// Treatment quads sit this many metres in FRONT of the host wall /
// ceiling, along the host's inward normal, so the BVH always reports
// the treatment hit before the wall behind it. 1 mm is six orders of
// magnitude larger than the tracer's self-intersection EPS (1e-6 m in
// tracer-core.js) so a ray reflecting off the treatment and
// re-querying the BVH never accidentally hits the same treatment quad
// (the post-reflection origin nudge is along the OUTGOING direction,
// not toward the wall behind).
//
// Why 1 mm and not larger: any visible offset between the treatment
// face and the wall it sits on would leak rays grazing parallel to
// the wall through the gap, double-counting absorption on the back
// wall and biasing late reverb downward. 1 mm × tan(grazing angle of
// ~1°) ≈ 60 µm of leak width — negligible vs the 0.5 m receiver
// sphere radius.
const TREATMENT_OFFSET_M = 1e-3;

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
  triangulateSurauStructure(scene, tris);
  triangulateStandaloneEnclosures(scene, tris);
  triangulateWallSegments(scene, tris);
  triangulateTreatments(scene, tris);

  return finalizeBuffer(tris);
}

// --- Treatments (v3 — placed acoustic panels) -------------------------
// Each entry on scene.treatments (built by scene-snapshot.js) becomes
// a single rectangular quad in front of its host wall (or below the
// ceiling), with its synthetic `treatment:<productId>` material
// already resolved to materialIdx. The tracer treats the quad like
// any other reflector: when a ray hits it, scene.materials[matIdx]
// gives both the per-band absorption (energy attenuation) AND the
// scattering coefficient (diffuse-vs-specular branch — see
// tracer-core.js:427-455).
//
// Geometric model: the wall-anchored treatment's `position` is the
// CENTRE of its back face (per scene.js's
// _placeTreatmentGroupOnSurface convention — group local +Z extends
// into the room, body centred at z=d/2). The quad we push for the
// tracer is the FRONT face of the panel, shifted 1 mm into the room
// from the wall plane so the BVH tie-break is deterministic.
//
// Scope (matches the v2 Sabine path — `treatmentHostSurfaceId` in
// physics/room-shape.js):
//   - rectangular rooms: wallIndex 0..3 → north/south/east/west.
//   - custom-vertex rooms: wallIndex → edge between
//     custom_vertices[i] and custom_vertices[i+1] (CCW polygon).
//   - any room: anchor.surface === 'ceiling' → quad on the ceiling
//     plane facing down.
//
// Out of scope (matches Sabine — silently skipped):
//   - polygon / round rooms: Sabine bundles ALL panels onto the
//     merged 'walls' slot with no positional resolver. Until a
//     v4 resolver lands the precision tracer treats these as
//     visual-only too. UI never lets a user place a treatment on
//     these rooms anyway (the placement raycaster requires a wall
//     mesh).
//   - standalone enclosures: treatments anchored to enclosure walls
//     are not in the current Sabine scope either. State carries no
//     `enclosureId` field on the treatment.
function triangulateTreatments(scene, tris) {
  const list = scene.treatments;
  if (!Array.isArray(list) || list.length === 0) return;
  const room = scene.room;
  const shape = room?.shape ?? 'rectangular';
  // Only resolve anchors for shapes the Sabine path handles. Skipping
  // mirrors v2's silent-drop behaviour for unsupported geometries.
  if (shape !== 'rectangular' && shape !== 'custom') {
    // Ceiling-anchored treatments work on any shape — fall through
    // below; wall-anchored ones we'd silently drop here. Iterate
    // anyway to pick up ceiling anchors on polygon/round rooms.
  }
  for (let ti = 0; ti < list.length; ti++) {
    const t = list[ti];
    if (!t || t.materialIdx < 0) continue;     // catalogue cache miss → skip
    const w = Math.max(0, t.dimensions?.width_m  || 0);
    const h = Math.max(0, t.dimensions?.height_m || 0);
    if (w < 1e-3 || h < 1e-3) continue;

    if (t.anchor?.surface === 'ceiling') {
      pushCeilingTreatmentQuad(scene, tris, t, w, h, ti);
      continue;
    }
    if (t.anchor?.surface !== 'wall') continue;
    if (shape === 'rectangular') {
      pushRectWallTreatmentQuad(scene, tris, t, w, h, ti);
    } else if (shape === 'custom') {
      pushCustomWallTreatmentQuad(scene, tris, t, w, h, ti);
    }
  }
}

function pushRectWallTreatmentQuad(scene, tris, t, w, h, ti) {
  const room = scene.room;
  const W = room.width_m, D = room.depth_m;
  const idx = t.anchor.wallIndex | 0;
  const cx = t.position.x, cy = t.position.y, cz = t.position.z;
  // Local axes per rectangular wall:
  //   - normal n points INTO the room
  //   - in-plane tangent u runs along the wall's horizontal extent
  //   - in-plane up v = (0, 0, 1) (world +z) for all walls
  // Wall index → (n, u) per the convention in triangulateRectangularRoom:
  //   0 north (y=D, n=(0,-1,0)),  u=(+1,0,0)
  //   1 south (y=0, n=(0,+1,0)),  u=(-1,0,0)   (matches wall winding order)
  //   2 east  (x=W, n=(-1,0,0)),  u=(0,+1,0)
  //   3 west  (x=0, n=(+1,0,0)),  u=(0,-1,0)
  let nx = 0, ny = 0, nz = 0;
  let ux = 0, uy = 0;
  switch (idx) {
    case 0: nx = 0; ny = -1; ux = 1;  uy = 0;  break;
    case 1: nx = 0; ny = 1;  ux = -1; uy = 0;  break;
    case 2: nx = -1; ny = 0; ux = 0;  uy = 1;  break;
    case 3: nx = 1;  ny = 0; ux = 0;  uy = -1; break;
    default: return;   // unknown wall — drop silently (matches Sabine)
  }
  // Push the panel ε in front of the wall along n. The panel CENTRE is
  // (cx, cy, cz); its back rests on the wall plane (per scene.js).
  const ox = cx + nx * TREATMENT_OFFSET_M;
  const oy = cy + ny * TREATMENT_OFFSET_M;
  const oz = cz;
  // Four corners (CCW seen from the room interior — opposite to the
  // wall's interior winding because the panel face NORMAL is +n away
  // from the wall, into the room).
  const hw = w / 2, hh = h / 2;
  const v00 = [ox - ux * hw, oy - uy * hw, oz - hh];   // bottom-left
  const v10 = [ox + ux * hw, oy + uy * hw, oz - hh];   // bottom-right
  const v11 = [ox + ux * hw, oy + uy * hw, oz + hh];   // top-right
  const v01 = [ox - ux * hw, oy - uy * hw, oz + hh];   // top-left
  pushQuad(tris, v00, v10, v11, v01, [nx, ny, nz],
    t.materialIdx, TAG_TREATMENT, `treatment_${t.id ?? ti}`);
}

function pushCustomWallTreatmentQuad(scene, tris, t, w, h, ti) {
  const verts = scene.room.custom_vertices;
  if (!Array.isArray(verts) || verts.length < 3) return;
  const idx = t.anchor.wallIndex | 0;
  if (idx < 0 || idx >= verts.length) return;
  const a = verts[idx];
  const b = verts[(idx + 1) % verts.length];
  // Centroid for inward-normal sign — same convention as
  // triangulateCustomRoom (CCW polygons in state coords; inward
  // normal points toward the polygon centroid).
  let cxg = 0, cyg = 0;
  for (const v of verts) { cxg += v.x; cyg += v.y; }
  cxg /= verts.length; cyg /= verts.length;
  const ex = b.x - a.x, ey = b.y - a.y;
  const eLen = Math.hypot(ex, ey);
  if (eLen < 1e-6) return;
  const ux = ex / eLen, uy = ey / eLen;
  // Inward normal: 90° rotation of edge tangent toward the centroid.
  // For a CCW polygon, that's (-ey, ex) / |e|; verify by dot with
  // (centroid - midpoint) and flip if the sign is negative (handles
  // CW polygons gracefully).
  let nx = -uy, ny = ux;
  const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
  if ((cxg - midX) * nx + (cyg - midY) * ny < 0) { nx = -nx; ny = -ny; }
  const cx = t.position.x, cy = t.position.y, cz = t.position.z;
  const ox = cx + nx * TREATMENT_OFFSET_M;
  const oy = cy + ny * TREATMENT_OFFSET_M;
  const oz = cz;
  const hw = w / 2, hh = h / 2;
  const v00 = [ox - ux * hw, oy - uy * hw, oz - hh];
  const v10 = [ox + ux * hw, oy + uy * hw, oz - hh];
  const v11 = [ox + ux * hw, oy + uy * hw, oz + hh];
  const v01 = [ox - ux * hw, oy - uy * hw, oz + hh];
  pushQuad(tris, v00, v10, v11, v01, [nx, ny, 0],
    t.materialIdx, TAG_TREATMENT, `treatment_${t.id ?? ti}`);
}

function pushCeilingTreatmentQuad(scene, tris, t, w, h, ti) {
  // Ceiling panel sits flush with the ceiling plane; face normal
  // points DOWN (-z) so rays from below hit it. position.z is the
  // ceiling height (per scene.js's reanchorTreatmentsOnRoomChange).
  const cx = t.position.x, cy = t.position.y;
  const cz = t.position.z - TREATMENT_OFFSET_M;
  // rotation_deg = roll around vertical (world Y in Three, world Z
  // in state coords). Apply 2D rotation around (cx, cy).
  const rad = (t.rotation_deg || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = w / 2, hh = h / 2;
  // Local in-plane corners (before rotation): (-hw,-hh), (hw,-hh), etc.
  const rot = (lx, ly) => [cx + lx * c - ly * s, cy + lx * s + ly * c, cz];
  const v00 = rot(-hw, -hh);
  const v10 = rot( hw, -hh);
  const v11 = rot( hw,  hh);
  const v01 = rot(-hw,  hh);
  // Outward face normal = -z (panel faces down into the room).
  // Winding for -z normal: v00, v01, v11, v10 (reversed vs +z).
  pushQuad(tris, v00, v01, v11, v10, [0, 0, -1],
    t.materialIdx, TAG_TREATMENT, `treatment_${t.id ?? ti}`);
}

// --- Standalone enclosures (broken-out sub-rooms) ---------------------
// Each enclosure has a polygon (in parent coords, transform already
// baked), its own elevation_m + height_m, and a surfaces block with
// per-edge wall slots. Produced when the user clicks "Break to merge"
// on a placed sub-room; lives on state.room.standaloneEnclosures[].
//
// Without this, a listener placed INSIDE a merged enclosure had no
// surrounding walls in the BVH — every ray escaped, late reverberation
// went to zero, STI returned 1.0 ("excellent" — physically wrong).
//
// Walls that carry a system 'merge_cut' opening are SKIPPED here: those
// are the seam between parent + enclosure (or enclosure + enclosure),
// and the canonical shared wall is rendered separately by
// triangulateWallSegments. Skipping avoids two coincident triangle
// faces in the BVH (would cause z-fighting in raycast tie-breaks).
function triangulateStandaloneEnclosures(scene, tris) {
  const list = scene.room?.standaloneEnclosures;
  if (!Array.isArray(list) || list.length === 0) return;
  for (let ei = 0; ei < list.length; ei++) {
    const enc = list[ei];
    if (!enc || !Array.isArray(enc.polygon) || enc.polygon.length < 3) continue;
    const verts = enc.polygon;
    const h = Number.isFinite(enc.height_m) ? enc.height_m : 3;
    if (h <= 0) continue;
    const elev = Number.isFinite(enc.elevation_m) ? enc.elevation_m : 0;
    const S = enc.surfaces ?? {};
    const floorMat   = materialIdxFor(scene, S.floor);
    const ceilingMat = materialIdxFor(scene, S.ceiling);

    // Centroid for inward-normal computation on each edge.
    let cx = 0, cy = 0;
    for (const v of verts) { cx += v.x; cy += v.y; }
    cx /= verts.length; cy /= verts.length;

    // Floor: fan-triangulate from vertex 0 at world z = elev.
    const v0 = [verts[0].x, verts[0].y, elev];
    for (let i = 1; i < verts.length - 1; i++) {
      const v1 = [verts[i].x, verts[i].y, elev];
      const v2 = [verts[i + 1].x, verts[i + 1].y, elev];
      pushTri(tris, v0, v1, v2, [0, 0, 1], floorMat, TAG_FLOOR, `enc${ei}_floor`);
    }
    // Ceiling: same fan, top elevation, reversed winding for -z normal.
    // (An enclosure is always treated as enclosed even if the parent is
    // outdoor — a hut in a park still has a roof.)
    const ceilZ = elev + h;
    const v0c = [verts[0].x, verts[0].y, ceilZ];
    for (let i = 1; i < verts.length - 1; i++) {
      const v1 = [verts[i].x, verts[i].y, ceilZ];
      const v2 = [verts[i + 1].x, verts[i + 1].y, ceilZ];
      pushTri(tris, v0c, v2, v1, [0, 0, -1], ceilingMat, TAG_CEILING, `enc${ei}_ceiling`);
    }
    // Walls: one quad per polygon edge. Each wall is split around any
    // OPEN openings (state==='open' / materialId==='open-air' user doors
    // and windows, plus the system 'merge_cut' rectangles produced by
    // break-to-merge). Closed user openings stay as wall material — first-
    // order STI is dominated by whether a direct path exists, not by the
    // door's α difference vs the wall.
    const edges = Array.isArray(S.edges) ? S.edges : [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const slot = edges[i];
      const matId = (typeof slot === 'string') ? slot
        : (slot?.materialId ?? S.walls ?? 'gypsum-board');
      if (matId === 'open-air') continue;
      const matIdx = materialIdxFor(scene, matId);
      const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
      let nx = cx - midX, ny = cy - midY;
      const nLen = Math.hypot(nx, ny);
      if (nLen > 1e-9) { nx /= nLen; ny /= nLen; }
      const openings = (slot && typeof slot === 'object') ? slot.openings : null;
      const quads = wallQuadsAfterOpenings(a, b, elev, h, openings);
      for (let qi = 0; qi < quads.length; qi++) {
        const q = quads[qi];
        pushQuad(tris,
          [q.a.x, q.a.y, q.z0], [q.b.x, q.b.y, q.z0],
          [q.b.x, q.b.y, q.z1], [q.a.x, q.a.y, q.z1],
          [nx, ny, 0], matIdx, TAG_WALL, `enc${ei}_wall_${i}_p${qi}`);
      }
      // Closed user openings (state !== 'open') deserve their own quad
      // with the door/window material so the tracer sees the correct
      // absorption at that rectangle. Open ones we already cut out above.
      pushClosedOpeningQuads(tris, scene, a, b, elev, h, openings, [nx, ny, 0],
        `enc${ei}_wall_${i}_op`);
    }
  }
}

// --- Shared wall segments (canonical merged walls) --------------------
// Each entry from state.room.wallSegments[] is a quad sitting between
// the parent + the enclosure(s) it joins. Material is the merged-wall
// material the user chose in the Shared walls panel section. Normal
// orientation isn't structurally meaningful (no "interior" — it's
// shared) so we use the 90° CCW from edge direction; with two-sided
// hits in the BVH the ray sees both faces correctly.
//
// User-added doors/windows on a shared wall MUST be subtracted from the
// wall mesh when open (state==='open' / materialId==='open-air'), or the
// tracer treats the wall as continuously solid and STI for a listener
// across the door comes out identical to STI with the door closed —
// physically wrong (an open door is a direct LOS path).
function triangulateWallSegments(scene, tris) {
  const list = scene.room?.wallSegments;
  if (!Array.isArray(list) || list.length === 0) return;
  for (let si = 0; si < list.length; si++) {
    const seg = list[si];
    if (!seg) continue;
    const x1 = Number(seg.x1), y1 = Number(seg.y1);
    const x2 = Number(seg.x2), y2 = Number(seg.y2);
    if (!Number.isFinite(x1) || !Number.isFinite(y1)
        || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
    const ex = x2 - x1, ey = y2 - y1;
    const len = Math.hypot(ex, ey);
    if (len < 1e-3) continue;
    const h = Number.isFinite(seg.height_m) ? seg.height_m : 3;
    if (h <= 0) continue;
    const elev = Number.isFinite(seg.elevation_m) ? seg.elevation_m : 0;
    const matId = typeof seg.materialId === 'string' ? seg.materialId : 'gypsum-board';
    if (matId === 'open-air') continue;
    const matIdx = materialIdxFor(scene, matId);
    // Normal: 90° CCW from edge direction (in floor plane).
    const nx = -ey / len, ny = ex / len;
    const a = { x: x1, y: y1 }, b = { x: x2, y: y2 };
    const quads = wallQuadsAfterOpenings(a, b, elev, h, seg.openings);
    for (let qi = 0; qi < quads.length; qi++) {
      const q = quads[qi];
      pushQuad(tris,
        [q.a.x, q.a.y, q.z0], [q.b.x, q.b.y, q.z0],
        [q.b.x, q.b.y, q.z1], [q.a.x, q.a.y, q.z1],
        [nx, ny, 0], matIdx, TAG_WALL, `wseg_${seg.id ?? si}_p${qi}`);
    }
    pushClosedOpeningQuads(tris, scene, a, b, elev, h, seg.openings, [nx, ny, 0],
      `wseg_${seg.id ?? si}_op`);
  }
}

// True iff an opening should be CUT OUT of the wall mesh — i.e. the
// tracer should see daylight through that rectangle. System merge_cut
// (break-to-merge seams), open-air material (user picked "Open wall"
// for the door material), and explicitly state==='open' all qualify.
function isOpeningCutThrough(op) {
  if (!op) return false;
  if (op.system === 'merge_cut') return true;
  if (op.materialId === 'open-air') return true;
  if (op.state === 'open') return true;
  return false;
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

  pushQuad(tris,
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, 1], floorMat, TAG_FLOOR, 'floor');
  pushQuad(tris,
    [0, 0, h], [0, d, h], [w, d, h], [w, 0, h],
    [0, 0, -1], ceilingMat, TAG_CEILING, 'ceiling');

  // Walls now cut around any openings the room slot declares (user-
  // authored doors / windows + surauStructure entrances). Without this,
  // the BVH had solid concrete wall quads at the door positions even
  // though the visual mesh had real holes — rays bounced off invisible
  // walls. Bug reported by user 2026-05-16. Implementation parallels
  // triangulateStandaloneEnclosures + triangulateWallSegments which
  // already handled openings correctly.
  //
  // CRITICAL — scene.js's wall_north sits at z=0 (state-y=0; the main-
  // entrance / preset-'south' side) and wall_south sits at z=d (state-
  // y=d; the qibla / preset-'north' side). The triangulator must place
  // each wall's quad at the SAME state-y as scene.js, otherwise
  // surauStructureWallOpenings emits doors for the right key but they
  // get cut from the wrong wall geometry — visible doors stay solid
  // in the BVH and rays bounce back into the room.
  //
  // x_m mirror reasoning (per Martina audit 2026-05-16):
  //   • Helper for wall_north emits x_m = (W − cx) − ow/2 (mirrored
  //     relative to world-x) so the holes land at the rendered position
  //     after scene.js's rotation.y = π flips local-x.
  //   • Triangulator's v1 → v2 in +x direction makes that mirrored x_m
  //     measure world-x backwards too → holes land at the correct
  //     world-x (5, 9, 13 for the southPartition doors). Use v1=(w,0)
  //     v2=(0,0) so the bottom edge runs from world-x=w toward world-x=0.
  //   • Same reasoning for wall_west — helper mirrors via (D − cy),
  //     triangulator uses v1=(0,d) v2=(0,0) so local-x runs from
  //     state-y=d toward state-y=0.
  //   • wall_south + wall_east use natural orientation (no scene.js
  //     rotation flip, no helper mirror).
  //
  // Inward normals: room interior is at state-y ∈ [0, d], state-x ∈
  // [0, w]. wall_north at y=0 → normal +y; wall_south at y=d → normal
  // -y; wall_east at x=w → normal -x; wall_west at x=0 → normal +x.
  const wallSpecs = [
    { key: 'wall_north', v1: { x: w, y: 0 }, v2: { x: 0, y: 0 }, n: [0,  1, 0] },
    { key: 'wall_south', v1: { x: 0, y: d }, v2: { x: w, y: d }, n: [0, -1, 0] },
    { key: 'wall_east',  v1: { x: w, y: 0 }, v2: { x: w, y: d }, n: [-1, 0, 0] },
    { key: 'wall_west',  v1: { x: 0, y: d }, v2: { x: 0, y: 0 }, n: [ 1, 0, 0] },
  ];
  for (const spec of wallSpecs) {
    const rawSlot = S[spec.key] ?? S.walls;
    const slot = applySurauOpeningsToSlot(rawSlot, room, spec.key);
    const matId = (typeof slot === 'string')
      ? slot
      : (slot?.materialId ?? S.walls ?? 'gypsum-board');
    const matIdx = materialIdxFor(scene, matId);
    const openings = (slot && typeof slot === 'object') ? slot.openings : null;
    const quads = wallQuadsAfterOpenings(spec.v1, spec.v2, 0, h, openings);
    for (let qi = 0; qi < quads.length; qi++) {
      const q = quads[qi];
      pushQuad(tris,
        [q.a.x, q.a.y, q.z0], [q.b.x, q.b.y, q.z0],
        [q.b.x, q.b.y, q.z1], [q.a.x, q.a.y, q.z1],
        spec.n, matIdx, TAG_WALL, `${spec.key}_p${qi}`);
    }
    // Closed openings (state !== 'open') get their own quad with the
    // door / window material. Surau openings are all state==='open' so
    // this is for any user-authored closed openings.
    pushClosedOpeningQuads(tris, scene, spec.v1, spec.v2, 0, h, openings, spec.n,
      `${spec.key}_op`);
  }
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
// the rest of the codebase). Walls per edge — each edge reads its slot
// from S.edges[i] for material + system merge_cut openings, so the seam
// between parent + a merged enclosure renders ONCE (the wallSegments[]
// quad provides the canonical surface; the parent skips that vertical
// slice). Without this, rays at the seam see two coincident reflectors
// and the BVH tie-break is non-deterministic.

function triangulateCustomRoom(scene, tris) {
  const room = scene.room;
  const verts = room.custom_vertices;
  if (!Array.isArray(verts) || verts.length < 3) return;
  const h = room.height_m;
  const S = room.surfaces || {};
  const isOutdoor = room.enclosure === 'outdoor';
  const floorMat   = materialIdxFor(scene, S.floor);
  const ceilingMat = materialIdxFor(scene, S.ceiling);
  const fallbackWallMat = S.walls ?? S.wall_north;
  const edges = Array.isArray(S.edges) ? S.edges : [];

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
  // Ceiling: same fan, reversed winding for -z normal. Skipped for
  // outdoor parents (no roof — rays going up should escape the BVH, not
  // bounce off a phantom ceiling and return as late reverb).
  if (!isOutdoor) {
    const v0c = [verts[0].x, verts[0].y, h];
    for (let i = 1; i < verts.length - 1; i++) {
      const v1 = [verts[i].x, verts[i].y, h];
      const v2 = [verts[i + 1].x, verts[i + 1].y, h];
      pushTri(tris, v0c, v2, v1, [0, 0, -1], ceilingMat, TAG_CEILING, 'ceiling');
    }
  }
  // Walls — per-edge slot. Each wall is split around its open openings
  // (cut clean through) and gets a small quad per closed opening with
  // the door/window material (so the absorption step at that rectangle
  // matches the panel material rather than the wall material).
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const slot = edges[i];
    const matId = (typeof slot === 'string') ? slot
      : (slot?.materialId ?? fallbackWallMat ?? 'gypsum-board');
    if (matId === 'open-air') continue;     // open wall — no reflector
    const matIdx = materialIdxFor(scene, matId);
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    let nx = cx - midX, ny = cy - midY;
    const nLen = Math.hypot(nx, ny);
    if (nLen > 1e-9) { nx /= nLen; ny /= nLen; }
    const openings = (slot && typeof slot === 'object') ? slot.openings : null;
    const quads = wallQuadsAfterOpenings(a, b, 0, h, openings);
    for (let qi = 0; qi < quads.length; qi++) {
      const q = quads[qi];
      pushQuad(tris,
        [q.a.x, q.a.y, q.z0], [q.b.x, q.b.y, q.z0],
        [q.b.x, q.b.y, q.z1], [q.a.x, q.a.y, q.z1],
        [nx, ny, 0], matIdx, TAG_WALL, `wall_${i}_p${qi}`);
    }
    pushClosedOpeningQuads(tris, scene, a, b, 0, h, openings, [nx, ny, 0],
      `wall_${i}_op`);
  }
}

// Subtract OPEN openings (system merge_cut + user openings whose state
// is 'open' or whose material is 'open-air') from a wall mesh. Returns
// a list of remaining rectangles as { a:{x,y}, b:{x,y}, z0, z1 } in
// WORLD coordinates, ready to push as quads.
//
// Inputs:
//   v1, v2     — wall endpoint xy (z is implied by elev)
//   elev       — world z of wall bottom
//   height     — wall height (top is at elev + height)
//   openings   — array of opening descriptors, fields: x_m (along-wall
//                from v1), z_m (up from wall bottom — LOCAL not world),
//                width_m, height_m, plus state/system/materialId tags
//
// Closed openings (state !== 'open' and material !== 'open-air' and
// not system) are LEFT IN the wall mesh — caller emits a separate quad
// at the opening rectangle with the door/window material, so the tracer
// applies the correct absorption coefficient there.
function wallQuadsAfterOpenings(v1, v2, elev, height, openings) {
  const dx = v2.x - v1.x, dy = v2.y - v1.y;
  const wallW = Math.hypot(dx, dy);
  if (wallW < 1e-3 || height < 1e-3) return [];
  const ux = dx / wallW, uy = dy / wallW;
  // Local-coord rectangles. Start with the full wall.
  let rects = [{ x0: 0, z0: 0, x1: wallW, z1: height }];
  if (Array.isArray(openings)) {
    for (const op of openings) {
      if (!isOpeningCutThrough(op)) continue;
      const ow = Number(op.width_m) || 0;
      const oh = Number(op.height_m) || 0;
      if (ow < 1e-3 || oh < 1e-3) continue;
      const ox0 = Math.max(0, Number(op.x_m) || 0);
      const oz0 = Math.max(0, Number(op.z_m) || 0);
      const ox1 = Math.min(wallW, ox0 + ow);
      const oz1 = Math.min(height, oz0 + oh);
      if (ox1 - ox0 < 1e-3 || oz1 - oz0 < 1e-3) continue;
      const next = [];
      for (const r of rects) {
        // No overlap → keep this rect intact.
        if (ox1 <= r.x0 + 1e-9 || ox0 >= r.x1 - 1e-9
            || oz1 <= r.z0 + 1e-9 || oz0 >= r.z1 - 1e-9) {
          next.push(r);
          continue;
        }
        const ix0 = Math.max(ox0, r.x0), ix1 = Math.min(ox1, r.x1);
        const iz0 = Math.max(oz0, r.z0), iz1 = Math.min(oz1, r.z1);
        // Below the cut.
        if (iz0 - r.z0 > 1e-3) next.push({ x0: r.x0, z0: r.z0, x1: r.x1, z1: iz0 });
        // Above the cut.
        if (r.z1 - iz1 > 1e-3) next.push({ x0: r.x0, z0: iz1, x1: r.x1, z1: r.z1 });
        // Left strip at the cut height.
        if (ix0 - r.x0 > 1e-3) next.push({ x0: r.x0, z0: iz0, x1: ix0, z1: iz1 });
        // Right strip at the cut height.
        if (r.x1 - ix1 > 1e-3) next.push({ x0: ix1, z0: iz0, x1: r.x1, z1: iz1 });
      }
      rects = next;
    }
  }
  return rects.map(r => ({
    a: { x: v1.x + ux * r.x0, y: v1.y + uy * r.x0 },
    b: { x: v1.x + ux * r.x1, y: v1.y + uy * r.x1 },
    z0: elev + r.z0,
    z1: elev + r.z1,
  }));
}

// Emit a quad per CLOSED user opening so the tracer sees the door /
// window material at that rectangle instead of the surrounding wall
// material. Closed = not cut-through (opening has a solid pane: door,
// window, etc). Skipped silently when no openings or all are open.
function pushClosedOpeningQuads(tris, scene, v1, v2, elev, height, openings, normal, sourceTag) {
  if (!Array.isArray(openings) || openings.length === 0) return;
  const dx = v2.x - v1.x, dy = v2.y - v1.y;
  const wallW = Math.hypot(dx, dy);
  if (wallW < 1e-3) return;
  const ux = dx / wallW, uy = dy / wallW;
  let opi = 0;
  for (const op of openings) {
    if (isOpeningCutThrough(op)) { opi++; continue; }
    const ow = Number(op.width_m) || 0;
    const oh = Number(op.height_m) || 0;
    if (ow < 1e-3 || oh < 1e-3) { opi++; continue; }
    const ox0 = Math.max(0, Number(op.x_m) || 0);
    const oz0 = Math.max(0, Number(op.z_m) || 0);
    const ox1 = Math.min(wallW, ox0 + ow);
    const oz1 = Math.min(height, oz0 + oh);
    if (ox1 - ox0 < 1e-3 || oz1 - oz0 < 1e-3) { opi++; continue; }
    const matIdx = materialIdxFor(scene, op.materialId || 'glass-window');
    pushQuad(tris,
      [v1.x + ux * ox0, v1.y + uy * ox0, elev + oz0],
      [v1.x + ux * ox1, v1.y + uy * ox1, elev + oz0],
      [v1.x + ux * ox1, v1.y + uy * ox1, elev + oz1],
      [v1.x + ux * ox0, v1.y + uy * ox0, elev + oz1],
      normal, matIdx, TAG_WALL, `${sourceTag}_${opi}`);
    opi++;
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

// --- Surau exterior — podium, arcade, portico, south partition --------
// All five elements live on scene.room.surauStructure (mirrored from the
// preset by scene-snapshot.js). Before this 2026-05-17 commit they were
// rendered as Three.js meshes only and tagged userData.no_acoustic=true
// so the triangulator silently skipped them; rays exiting the prayer
// hall through a door cutout passed through the visible columns and
// disappeared into the void with no further bounces (and no late
// reverberation from the arcade volume). Effect on user-visible metrics:
// rays now hit columns / podium-top / arcade-roof-undersides and
// reflect; Sabine RT60 drops 5-10% from the extra absorbing area; the
// surface picker can click any of these and open the material UI.
//
// Schema reference (per element):
//   podium          → top face at z = podium.height_m, spans
//                     (-ext, -ext) to (W+ext, D+ext). Normal +z.
//                     materialId = surauStructure.materials.podium_top
//   arcade columns  → per side in arcade.sides[]: walk the side at
//                     bay_spacing intervals, drop a vertical square
//                     pillar at each bay-divider position. Each pillar
//                     = 4 wall quads from z=podium.height_m to
//                     z=arcade.roof_height_m (default 0.4 to 4.4). Each
//                     pillar emits a unique surface_id so the picker
//                     can distinguish columns. materialId =
//                     surauStructure.materials.arcade_columns.
//   arcade roof     → per side: flat rectangle at z=arcade.roof_height_m
//                     covering the arcade footprint outside the room
//                     wall. Normal -z (faces into the arcade).
//                     materialId = surauStructure.materials.arcade_roof
//   portico walls   → three vertical rectangles (front + 2 sides) of
//                     the projecting entrance pavilion. The front-wall
//                     pointed-arch cutout is NOT modelled in the BVH —
//                     the simplification means rays hitting the arch
//                     opening see a solid wall instead of an opening,
//                     but the entrance proper is already gated by the
//                     southPartition doors so listeners actually
//                     standing INSIDE the portico are rare. Cheaper
//                     than carving a Shape hole through the BVH wall.
//                     materialId = surauStructure.materials.portico_walls
//   portico roof    → underside of the pyramidal cap, four triangles
//                     meeting at apex. Normal points down-and-inward.
//                     materialId = surauStructure.materials.portico_roof
//   south partition → thin partition between the south doors, full
//                     band height; one rectangle per segment between
//                     consecutive doorCenters_x_m gaps. Inward normal
//                     +y. materialId = surauStructure.materials.south_partition
//
// Out of scope (visual-only, stays tagged no_acoustic):
//   • minaret CAP pieces (belt, lantern, dome, crescent / mustaka /
//     stepped variants) — small surface area, sits at z >= shaftH
//   • saf lines on the floor (flush with carpet, no acoustic effect)
// IN scope (added 2026-05-18 per Dr. Chen sign-off, user report):
//   • minaret SHAFT — 1.2 × 1.2 × 7.65 m concrete-painted box at the
//     NW outdoor corner. Was excluded historically on the (wrong)
//     premise "no ray path reaches it"; actually sits in the direct
//     path between west-arcade speaker D and outdoor listeners north
//     of y ≈ 17 m. Top face omitted (P4 simplification — diverges
//     <0.1 dB at listener plane per Dr. Chen 2026-05-18).
//   • atap tumpang multi-tier roof — apex >9 m, hipRoof already
//     in the BVH for tier 0; upper tiers are above the ceiling
//   • jali screens (currently disabled in the preset)
//   • mihrab niche / minbar steps — already covered by the existing
//     interior surauStructure render path (rebuildSurauStructure tags
//     them with surface_id and acoustic_material)
//   • portico's pointed-arch opening — treated as a solid wall in the
//     BVH (see portico walls note above)
function triangulateSurauStructure(scene, tris) {
  const room = scene.room;
  const s = room?.surauStructure;
  if (!s) return;
  if (room.shape !== 'rectangular') return;  // schema is shoebox-only

  const W = Number(room.width_m), D = Number(room.depth_m);
  if (!(W > 0 && D > 0)) return;

  const mats = s.materials || {};
  // Fallback material ids — chosen to match the legacy hard-coded
  // colours in scene.js. If the preset author forgets to set a slot,
  // the surface still enters the BVH with a sensible material rather
  // than -1 (no material → tracer treats it as fully reflective).
  const podiumMatId      = mats.podium_top      || 'concrete-painted';
  const arcadeColMatId   = mats.arcade_columns  || 'concrete-painted';
  const arcadeRoofMatId  = mats.arcade_roof     || 'gypsum-board';
  const porticoWallMatId = mats.portico_walls   || 'concrete-painted';
  const porticoRoofMatId = mats.portico_roof    || 'gypsum-board';
  // Partition material lookup order matches scene.js#rebuildSurauStructure:
  // prefer the new s.materials.south_partition slot (data-driven), fall
  // back to the legacy southPartition.materialId for older presets, then
  // a hardcoded default. Mismatched priority order between the renderer
  // and triangulator would let the BVH report a different material than
  // the user picked in the panel.
  const partitionMatId   = mats.south_partition || (s.southPartition?.materialId) || 'concrete-painted';

  // -------- Podium top face -------------------------------------------
  // Renderer: BoxGeometry(W + 2·ext, podH, D + 2·ext) centred so top
  // face is at z=0. For acoustic purposes the user-walked surface is
  // the TOP face only; the sides are exposed by the 0.4 m step but
  // only a ground-grazing ray (already escaped the BVH) would see them,
  // and the BOTTOM face is buried in terrain.
  //
  // We CUT OUT the prayer-hall footprint (0..W) × (0..D) so the BVH has
  // a single floor triangle at any (x, y) inside the hall instead of two
  // coplanar triangles fighting for the hit (the hall's own floor mesh
  // is already at z=0). Emit four ring rectangles around the inner cut:
  //   S strip: x ∈ [-ext, W+ext], y ∈ [-ext, 0]
  //   N strip: x ∈ [-ext, W+ext], y ∈ [D, D+ext]
  //   W strip: x ∈ [-ext, 0],     y ∈ [0, D]
  //   E strip: x ∈ [W, W+ext],    y ∈ [0, D]
  // All four share the same surface_id ('surau_podium_top') so a click
  // on any strip pulses the same Room-panel row.
  if (s.podium) {
    const ext = Number.isFinite(s.podium.extension_m) ? s.podium.extension_m : 0;
    if (ext > 0.05) {
      const matIdx = materialIdxFor(scene, podiumMatId);
      // CCW from above (looking down at +z normal): (x0,y0)→(x1,y0)→(x1,y1)→(x0,y1).
      const pushStrip = (x0, y0, x1, y1) => {
        if (x1 - x0 < 0.05 || y1 - y0 < 0.05) return;
        pushQuad(tris,
          [x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0],
          [0, 0, 1], matIdx, TAG_FLOOR, 'surau_podium_top');
      };
      pushStrip(-ext, -ext,  W + ext, 0);       // S strip (south of hall)
      pushStrip(-ext, D,     W + ext, D + ext); // N strip (north of hall)
      pushStrip(-ext, 0,     0,       D);       // W strip (west of hall)
      pushStrip(W,    0,     W + ext, D);       // E strip (east of hall)
    }
  }

  // -------- Arcade columns + roof undersides --------------------------
  // Renderer model: each side has nBays bays, each bay being a
  // pointed-arch extrusion. The columns are the solid material between
  // bay arches — for the BVH we approximate as one square pillar per
  // bay DIVIDER (i.e. one column between bays + the two end columns at
  // each side). Pillar cross-section = column_thickness_m square,
  // height from podium top to arcade roof underside.
  //
  // Side geometry (mirrors scene.js sideSpec exactly):
  //   'south': p1=(0,0)     p2=(W,0)     perp=(0,-1)  — arcade in y<0
  //   'east':  p1=(W,0)     p2=(W,D)     perp=(1, 0)  — arcade in x>W
  //   'west':  p1=(0,0)     p2=(0,D)     perp=(-1,0)  — arcade in x<0
  //   'north': p1=(0,D)     p2=(W,D)     perp=(0, 1)  — never wrapped per preset
  const ar = s.arcade;
  if (ar && Array.isArray(ar.sides) && ar.sides.length > 0) {
    const depth_m = Number.isFinite(ar.depth_m) ? ar.depth_m : 3.0;
    const bayW    = Number.isFinite(ar.column_spacing_m) ? ar.column_spacing_m : 2.8;
    const colT    = Number.isFinite(ar.column_thickness_m) ? ar.column_thickness_m : 0.30;
    const roofZ   = Number.isFinite(ar.roof_height_m) ? ar.roof_height_m : 4.4;
    // Pillar bottom: world z=0 (the podium top is flush with the prayer-
    // hall floor — podium.position.y in scene.js = -podH/2 so its top
    // face is at z=0). Pillar top: arcade roof underside at roofZ.
    const pillarZ0 = 0;
    const pillarZ1 = roofZ;
    const half = colT / 2;

    const sideSpec = {
      south: { p1: [0, 0], p2: [W, 0], perpX:  0, perpY: -1, name: 'S' },
      east:  { p1: [W, 0], p2: [W, D], perpX:  1, perpY:  0, name: 'E' },
      west:  { p1: [0, 0], p2: [0, D], perpX: -1, perpY:  0, name: 'W' },
      north: { p1: [0, D], p2: [W, D], perpX:  0, perpY:  1, name: 'N' },
    };

    const arcadeColMatIdx  = materialIdxFor(scene, arcadeColMatId);
    const arcadeRoofMatIdx = materialIdxFor(scene, arcadeRoofMatId);

    for (const sideName of ar.sides) {
      const spec = sideSpec[sideName];
      if (!spec) continue;
      const dx = spec.p2[0] - spec.p1[0];
      const dy = spec.p2[1] - spec.p1[1];
      const sideLen = Math.hypot(dx, dy);
      if (sideLen < bayW) continue;
      const sx = dx / sideLen, sy = dy / sideLen;
      // Match renderer: 0.5·depth inset at each end so corners stay clean.
      const startInset = depth_m * 0.5;
      const endInset   = depth_m * 0.5;
      const usableLen  = sideLen - startInset - endInset;
      if (usableLen < bayW) continue;
      const nBays = Math.max(1, Math.floor(usableLen / bayW));
      const actualBayW = usableLen / nBays;

      // Column positions: one at each bay divider + the two end caps.
      // (nBays + 1 columns total per side.) Position = u along the side
      // (in metres from p1), then offset OUTWARD by (depth - colT/2)
      // along perp — same convention as scene.js bay placement.
      const outwardDist = depth_m - colT / 2;
      for (let ci = 0; ci <= nBays; ci++) {
        const u = startInset + ci * actualBayW;
        const ux = spec.p1[0] + sx * u;
        const uy = spec.p1[1] + sy * u;
        const cx_col = ux + spec.perpX * outwardDist;
        const cy_col = uy + spec.perpY * outwardDist;
        // Pillar = 4 wall quads of a square cross-section box.
        // Local axes: side direction (sx, sy) on one face pair; perp on
        // the other. Each face's outward normal points AWAY from the
        // pillar centre. CCW winding seen from outside the pillar.
        const A = [cx_col - half * sx - half * spec.perpX, cy_col - half * sy - half * spec.perpY];
        const B = [cx_col + half * sx - half * spec.perpX, cy_col + half * sy - half * spec.perpY];
        const C = [cx_col + half * sx + half * spec.perpX, cy_col + half * sy + half * spec.perpY];
        const Dp= [cx_col - half * sx + half * spec.perpX, cy_col - half * sy + half * spec.perpY];
        const surfTagBase = `surau_arcade_column_${spec.name}_${ci}`;
        // Face AB (normal = -perp, points back toward the prayer hall wall)
        pushQuad(tris,
          [A[0], A[1], pillarZ0], [B[0], B[1], pillarZ0],
          [B[0], B[1], pillarZ1], [A[0], A[1], pillarZ1],
          [-spec.perpX, -spec.perpY, 0], arcadeColMatIdx, TAG_WALL, surfTagBase);
        // Face BC (normal = +s = side direction, points along the colonnade)
        pushQuad(tris,
          [B[0], B[1], pillarZ0], [C[0], C[1], pillarZ0],
          [C[0], C[1], pillarZ1], [B[0], B[1], pillarZ1],
          [sx, sy, 0], arcadeColMatIdx, TAG_WALL, surfTagBase);
        // Face CD (normal = +perp, points OUTWARD away from building)
        pushQuad(tris,
          [C[0], C[1], pillarZ0], [Dp[0], Dp[1], pillarZ0],
          [Dp[0], Dp[1], pillarZ1], [C[0], C[1], pillarZ1],
          [spec.perpX, spec.perpY, 0], arcadeColMatIdx, TAG_WALL, surfTagBase);
        // Face DA (normal = -s, points back along the colonnade)
        pushQuad(tris,
          [Dp[0], Dp[1], pillarZ0], [A[0], A[1], pillarZ0],
          [A[0], A[1], pillarZ1], [Dp[0], Dp[1], pillarZ1],
          [-sx, -sy, 0], arcadeColMatIdx, TAG_WALL, surfTagBase);
      }

      // Arcade roof underside — flat rectangle covering the arcade
      // footprint at z=roofZ, normal pointing DOWN. Spans from the
      // outer wall plane out to depth_m, and from startInset to
      // (sideLen - endInset) along the side direction. CCW seen from
      // BELOW gives -z normal.
      const rl = sideLen - startInset - endInset;
      const r0 = startInset;
      const r1 = sideLen - endInset;
      // Four corners (state coords): inner edge sits ON the wall plane
      // (which is p1 + s*u; perpendicular offset 0), outer edge sits
      // depth_m metres outward.
      const ix0 = spec.p1[0] + sx * r0;
      const iy0 = spec.p1[1] + sy * r0;
      const ix1 = spec.p1[0] + sx * r1;
      const iy1 = spec.p1[1] + sy * r1;
      const ox0 = ix0 + spec.perpX * depth_m;
      const oy0 = iy0 + spec.perpY * depth_m;
      const ox1 = ix1 + spec.perpX * depth_m;
      const oy1 = iy1 + spec.perpY * depth_m;
      void rl;
      // Winding for -z normal (face looks down): go CW when viewed from
      // above = CCW when viewed from below. Order: inner-start, outer-
      // start, outer-end, inner-end (so from below this is CCW).
      pushQuad(tris,
        [ix0, iy0, roofZ], [ox0, oy0, roofZ],
        [ox1, oy1, roofZ], [ix1, iy1, roofZ],
        [0, 0, -1], arcadeRoofMatIdx, TAG_CEILING, `surau_arcade_roof_${sideName}`);
    }

    // Corner cantilever support posts (Viktor diagnosis 2026-05-18) —
    // mirrors the renderer addition in scene.js. Each post is a square
    // pillar (colT × colT × roofH) at the outer corner of a cantilevered
    // arcade slab, planted where two wrapped sides meet at a building
    // corner. Same material as the bay columns so absorption stays
    // consistent; same surface_id prefix (`surau_arcade_column_corner_*`)
    // so panel picks route to the arcade-columns row.
    const cornerPostSpecs = [];
    const wrapped = new Set(ar.sides);
    if (wrapped.has('south') && wrapped.has('east')) {
      cornerPostSpecs.push({ cx: W - depth_m * 0.5, cy: -depth_m,        id: 'SE_S' });
      cornerPostSpecs.push({ cx: W + depth_m,        cy: depth_m * 0.5,  id: 'SE_E' });
    }
    if (wrapped.has('south') && wrapped.has('west')) {
      cornerPostSpecs.push({ cx: depth_m * 0.5,      cy: -depth_m,       id: 'SW_S' });
      cornerPostSpecs.push({ cx: -depth_m,           cy: depth_m * 0.5,  id: 'SW_W' });
    }
    if (wrapped.has('north') && wrapped.has('east')) {
      cornerPostSpecs.push({ cx: W - depth_m * 0.5, cy: D + depth_m,     id: 'NE_N' });
      cornerPostSpecs.push({ cx: W + depth_m,        cy: D - depth_m * 0.5, id: 'NE_E' });
    }
    if (wrapped.has('north') && wrapped.has('west')) {
      cornerPostSpecs.push({ cx: depth_m * 0.5,      cy: D + depth_m,    id: 'NW_N' });
      cornerPostSpecs.push({ cx: -depth_m,           cy: D - depth_m * 0.5, id: 'NW_W' });
    }
    for (const cp of cornerPostSpecs) {
      // Axis-aligned square pillar — emit 4 wall quads, each with outward
      // normal along +x / -x / +y / -y. CCW seen from outside the pillar.
      const x0 = cp.cx - half, x1 = cp.cx + half;
      const y0 = cp.cy - half, y1 = cp.cy + half;
      const tag = `surau_arcade_column_corner_${cp.id}`;
      // Face -x (normal points to -x):
      pushQuad(tris,
        [x0, y0, pillarZ0], [x0, y1, pillarZ0],
        [x0, y1, pillarZ1], [x0, y0, pillarZ1],
        [-1, 0, 0], arcadeColMatIdx, TAG_WALL, tag);
      // Face +x (normal points to +x):
      pushQuad(tris,
        [x1, y1, pillarZ0], [x1, y0, pillarZ0],
        [x1, y0, pillarZ1], [x1, y1, pillarZ1],
        [1, 0, 0], arcadeColMatIdx, TAG_WALL, tag);
      // Face -y (normal points to -y):
      pushQuad(tris,
        [x1, y0, pillarZ0], [x0, y0, pillarZ0],
        [x0, y0, pillarZ1], [x1, y0, pillarZ1],
        [0, -1, 0], arcadeColMatIdx, TAG_WALL, tag);
      // Face +y (normal points to +y):
      pushQuad(tris,
        [x0, y1, pillarZ0], [x1, y1, pillarZ0],
        [x1, y1, pillarZ1], [x0, y1, pillarZ1],
        [0, 1, 0], arcadeColMatIdx, TAG_WALL, tag);
    }
  }

  // -------- Minaret shaft ---------------------------------------------
  // Slender concrete-painted box at one outdoor corner (NW for surau).
  // Was historically excluded from the BVH on the (wrong) premise "8 m+
  // above ground, no ray reaches it" — actually sits in the direct path
  // between west-arcade speaker D (z=4.2 m) and outdoor listeners north
  // of y ≈ 17 m. Emit 4 vertical wall quads (top + bottom omitted, per
  // arcade-column precedent; P4 simplification — see header comment).
  //
  // Geometry mirrors scene.js#rebuildSurauStructure §8:
  //   clearance = 0.6 + base_size_m / 2
  //   centre at corner offset:
  //     NW: (-clearance, D + clearance)
  //     NE: (W + clearance, D + clearance)
  //     SW: (-clearance, -clearance)
  //     SE: (W + clearance, -clearance)
  //   footprint: square of side base_size_m centred on the above
  //   height: shaftH = total_height_m × 0.90
  if (s.minaret) {
    const mn = s.minaret;
    const baseSize = Number.isFinite(mn.base_size_m) ? mn.base_size_m : 1.2;
    const totalH   = Number.isFinite(mn.height_m)    ? mn.height_m    : 8.5;
    const shaftH   = totalH * 0.90;
    const clearance = 0.6 + baseSize / 2;
    const cornerOffsets = {
      SW: { x: -clearance,    y: -clearance    },
      SE: { x: W + clearance, y: -clearance    },
      NW: { x: -clearance,    y: D + clearance },
      NE: { x: W + clearance, y: D + clearance },
    };
    const co = cornerOffsets[mn.corner || 'NW'] || cornerOffsets.NW;
    const mnHalf = baseSize / 2;
    const x0 = co.x - mnHalf, x1 = co.x + mnHalf;
    const y0 = co.y - mnHalf, y1 = co.y + mnHalf;
    const minaretMatId = mats.minaret || mn.materialId || 'concrete-painted';
    const minaretMatIdx = materialIdxFor(scene, minaretMatId);
    const tag = 'surau_minaret';
    // Face -x (normal points to -x):
    pushQuad(tris,
      [x0, y0, 0],     [x0, y1, 0],
      [x0, y1, shaftH], [x0, y0, shaftH],
      [-1, 0, 0], minaretMatIdx, TAG_WALL, tag);
    // Face +x (normal points to +x):
    pushQuad(tris,
      [x1, y1, 0],     [x1, y0, 0],
      [x1, y0, shaftH], [x1, y1, shaftH],
      [1, 0, 0], minaretMatIdx, TAG_WALL, tag);
    // Face -y (normal points to -y):
    pushQuad(tris,
      [x1, y0, 0],     [x0, y0, 0],
      [x0, y0, shaftH], [x1, y0, shaftH],
      [0, -1, 0], minaretMatIdx, TAG_WALL, tag);
    // Face +y (normal points to +y):
    pushQuad(tris,
      [x0, y1, 0],     [x1, y1, 0],
      [x1, y1, shaftH], [x0, y1, shaftH],
      [0, 1, 0], minaretMatIdx, TAG_WALL, tag);
  }

  // -------- Portico walls + roof --------------------------------------
  // Renderer model: three solid walls (front + left + right) wrapping a
  // pyramid cap. Front wall has a pointed-arch cutout — we IGNORE the
  // cutout in the BVH (treat as solid; tracer will reflect off the
  // closed plane, which is acoustically safe-ish since the southPartition
  // doors actually gate entry/exit and listeners INSIDE the portico are
  // rare). Pyramid cap: 4 triangles meeting at apex above the portico's
  // centre, normals pointing down-and-inward.
  //
  // Side anchoring matches scene.js's anchor/yaw table:
  //   south: anchorX=W/2, anchorZ=0,  yaw=π   → portico projects to y<0
  //   north: anchorX=W/2, anchorZ=D,  yaw=0   → projects to y>D
  //   east:  anchorX=W,   anchorZ=D/2, yaw=π/2 → projects to x>W
  //   west:  anchorX=0,   anchorZ=D/2, yaw=-π/2 → projects to x<0
  // For each side compute the four outer corners of the portico's
  // footprint in WORLD coords (no Three.js rotation needed — we know
  // the geometry); then emit walls and roof.
  if (s.portico) {
    const po = s.portico;
    const side = po.side || 'south';
    const poW = Number.isFinite(po.width_m) ? po.width_m : 3.0;
    const poD = Number.isFinite(po.depth_m) ? po.depth_m : 3.0;
    const poH = Number.isFinite(po.height_m) ? po.height_m : 4.5;
    const poApex = Number.isFinite(po.apexRise_m) ? po.apexRise_m : 1.0;
    const portWallMatIdx = materialIdxFor(scene, porticoWallMatId);
    const portRoofMatIdx = materialIdxFor(scene, porticoRoofMatId);

    // Inner edge (anchored on the building wall) and outer edge
    // (projected away by poD along outNormal). Inner-edge corners:
    // (ax-poW/2 · sideDir, ay-poW/2 · sideDir) and +; outer corners
    // = inner + outNormal·poD.
    let ax = 0, ay = 0;       // anchor on building wall (state coords)
    let sxd = 0, syd = 0;     // side direction along the wall (unit)
    let nx = 0, ny = 0;       // outward normal (from building → portico)
    let validSide = true;
    if (side === 'south') { ax = W/2; ay = 0; sxd = 1; syd = 0; nx = 0; ny = -1; }
    else if (side === 'north') { ax = W/2; ay = D; sxd = 1; syd = 0; nx = 0; ny = 1; }
    else if (side === 'east')  { ax = W; ay = D/2; sxd = 0; syd = 1; nx = 1; ny = 0; }
    else if (side === 'west')  { ax = 0; ay = D/2; sxd = 0; syd = 1; nx = -1; ny = 0; }
    else { validSide = false; }
    // Skip portico (not return) so the southPartition step below still runs.
    if (validSide) {

    // Inner-edge corners (sit on the building wall plane, half-width
    // apart along sideDir).
    const iLeft  = [ax - sxd * poW/2, ay - syd * poW/2];
    const iRight = [ax + sxd * poW/2, ay + syd * poW/2];
    // Outer-edge corners (project by poD along outward normal).
    const oLeft  = [iLeft[0]  + nx * poD, iLeft[1]  + ny * poD];
    const oRight = [iRight[0] + nx * poD, iRight[1] + ny * poD];

    // FRONT WALL — between oLeft and oRight at z∈[0, poH]. Inward normal
    // points BACK toward the building (= -n).
    pushQuad(tris,
      [oLeft[0], oLeft[1], 0],  [oRight[0], oRight[1], 0],
      [oRight[0], oRight[1], poH], [oLeft[0], oLeft[1], poH],
      [-nx, -ny, 0], portWallMatIdx, TAG_WALL, 'surau_portico_walls');

    // LEFT SIDE WALL — between iLeft and oLeft. Inward normal points
    // ALONG +sideDir (toward the portico's interior centre line).
    pushQuad(tris,
      [iLeft[0], iLeft[1], 0], [oLeft[0], oLeft[1], 0],
      [oLeft[0], oLeft[1], poH], [iLeft[0], iLeft[1], poH],
      [sxd, syd, 0], portWallMatIdx, TAG_WALL, 'surau_portico_walls');

    // RIGHT SIDE WALL — between oRight and iRight. Inward normal -sideDir.
    pushQuad(tris,
      [oRight[0], oRight[1], 0], [iRight[0], iRight[1], 0],
      [iRight[0], iRight[1], poH], [oRight[0], oRight[1], poH],
      [-sxd, -syd, 0], portWallMatIdx, TAG_WALL, 'surau_portico_walls');

    // PYRAMID ROOF UNDERSIDE — 4 triangles from each edge of the
    // portico's top rectangle (corners at z=poH) meeting at an apex
    // centred on the portico, at z=poH+poApex. Normals point DOWN-AND-
    // INWARD (toward the apex from below). Winding chosen so the face
    // is visible from BELOW (inside the portico).
    const apexX = (iLeft[0] + iRight[0] + oLeft[0] + oRight[0]) / 4;
    const apexY = (iLeft[1] + iRight[1] + oLeft[1] + oRight[1]) / 4;
    const apexZ = poH + poApex;
    // Four edges of the top rect, walked CCW seen from above:
    //   iLeft → iRight → oRight → oLeft → iLeft
    // For each edge (a, b) the triangle (a, b, apex) faces DOWN when
    // (b-a) × (apex-a) has negative z. Use that winding directly; the
    // normal we store is the average down-inward direction.
    const triEdges = [
      [iLeft,  iRight],
      [iRight, oRight],
      [oRight, oLeft],
      [oLeft,  iLeft],
    ];
    for (const [a, b] of triEdges) {
      // Normal: cross((b-a), (apex-a)) flipped to point downward.
      const ex = b[0] - a[0],         ey = b[1] - a[1],         ez = 0;
      const fx = apexX - a[0],        fy = apexY - a[1],        fz = apexZ - poH;
      let cx = ey * fz - ez * fy;
      let cy = ez * fx - ex * fz;
      let cz = ex * fy - ey * fx;
      // Force downward-facing for "underside" reading.
      if (cz > 0) { cx = -cx; cy = -cy; cz = -cz; }
      const len = Math.hypot(cx, cy, cz) || 1;
      cx /= len; cy /= len; cz /= len;
      // Winding (a, b, apex) gives an UP-facing normal if cz>0; we
      // flipped above, so emit triangle in (a, apex, b) order to match.
      pushTri(tris,
        [a[0], a[1], poH], [apexX, apexY, apexZ], [b[0], b[1], poH],
        [cx, cy, cz], portRoofMatIdx, TAG_CEILING, 'surau_portico_roof');
    }
    }   // end if (validSide)
  }

  // -------- South partition segments ----------------------------------
  // Renderer: a thin slab on the inside face of the south wall (state
  // y = 0), full width W, with rectangular door cutouts at each
  // doorCenters_x_m. Slab thickness = sp.thickness_m, height = sp.height_m.
  // For the BVH we model each non-door segment as a single thin
  // rectangle on the room-side face (z extending from y=thickness to
  // y=0 would be the thin direction, but a 0.2 m slab is below the
  // tracer's resolution — a single face on the room-facing side is
  // enough). Inward normal = +y (faces into the prayer hall).
  if (s.southPartition) {
    const sp = s.southPartition;
    const thick = Number.isFinite(sp.thickness_m) ? sp.thickness_m : 0.2;
    const bandH = Number.isFinite(sp.height_m) ? sp.height_m : 2.4;
    const doorW = Number.isFinite(sp.doorWidth_m) ? sp.doorWidth_m : 1.0;
    const doorCenters = Array.isArray(sp.doorCenters_x_m)
      ? [...sp.doorCenters_x_m].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      : [];

    // Build x-segments by walking the wall and skipping door gaps —
    // mirrors the renderer's segment-building code exactly.
    const segments = [];
    let xPrev = 0;
    for (const dc of doorCenters) {
      const gapStart = dc - doorW / 2;
      const gapEnd = dc + doorW / 2;
      if (gapStart > xPrev + 0.01) segments.push({ x1: xPrev, x2: gapStart });
      xPrev = Math.max(xPrev, gapEnd);
    }
    if (xPrev < W - 0.01) segments.push({ x1: xPrev, x2: W });

    const partMatIdx = materialIdxFor(scene, partitionMatId);
    // Room-facing face at y = thick (the side closer to the prayer hall
    // interior). Inward normal +y points further into the room.
    // CCW seen from +y direction (looking at the face from inside):
    //   bottom-left (x1, y=thick, z=0), bottom-right (x2, y=thick, z=0),
    //   top-right (x2, y=thick, z=bandH), top-left (x1, y=thick, z=bandH).
    // pushQuad order (v0,v1,v2,v3) with normal +y means CCW when looking
    // from +y. Going (BL, BR, TR, TL) from +y side: BL→BR is +x,
    // BR→TR is +z → CCW. Good.
    for (const seg of segments) {
      const segW = seg.x2 - seg.x1;
      if (segW < 0.05) continue;
      pushQuad(tris,
        [seg.x1, thick, 0], [seg.x2, thick, 0],
        [seg.x2, thick, bandH], [seg.x1, thick, bandH],
        [0, 1, 0], partMatIdx, TAG_WALL, 'south_partition');
    }
    // Lintels — door-head bands above each cutout. Same +y face,
    // z from (bandH - 0.25) to bandH, x from (dc - doorW/2) to (dc + doorW/2).
    const lintelH = 0.25;
    for (const dc of doorCenters) {
      const x0 = dc - doorW / 2;
      const x1 = dc + doorW / 2;
      pushQuad(tris,
        [x0, thick, bandH - lintelH], [x1, thick, bandH - lintelH],
        [x1, thick, bandH],            [x0, thick, bandH],
        [0, 1, 0], partMatIdx, TAG_WALL, 'south_partition');
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
