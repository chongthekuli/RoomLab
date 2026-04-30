// Sub-structures (saved rooms placed into the current room) — schema
// round-trip + snapshot-independence regression.
//
// Phase 1: state.room.subStructures is a visual-only array. Each entry
// holds a deep snapshot of the source room geometry so deleting the
// library record never breaks the placement.
//
// Run: node tests/sub-structures.test.mjs

import {
  state, applyPresetToState, applyTemplateToState, applyBlankCustomRoom,
  serializeProject, deserializeProject,
} from '../js/app-state.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// 1. Default state has subStructures = [] after any reset entry point.
applyTemplateToState('hifi');
assert(Array.isArray(state.room.subStructures) && state.room.subStructures.length === 0,
  'applyTemplateToState yields empty subStructures: []');

applyPresetToState('auditorium');
assert(Array.isArray(state.room.subStructures) && state.room.subStructures.length === 0,
  'applyPresetToState yields empty subStructures: []');

applyBlankCustomRoom();
assert(Array.isArray(state.room.subStructures) && state.room.subStructures.length === 0,
  'applyBlankCustomRoom yields empty subStructures: []');

// 2. Push a synthetic sub-structure into the parent room and round-trip
//    through serialize → JSON → parse → deserialize. Every field must
//    survive byte-equal.
applyTemplateToState('hifi');
const sourceSnap = {
  shape: 'rectangular',
  enclosure: 'indoor',
  width_m: 3, depth_m: 2.5, height_m: 2.4,
  ceiling_type: 'flat', ceiling_dome_rise_m: 1.0,
  polygon_sides: 16, polygon_radius_m: 10, round_radius_m: 2.5,
  custom_vertices: null, stadiumStructure: null, multiLevelStructure: null,
  subStructures: [],
  surfaces: {
    floor: 'wood-floor', ceiling: 'gypsum-board', walls: 'gypsum-board',
    wall_north: 'gypsum-board', wall_south: 'gypsum-board',
    wall_east:  'gypsum-board', wall_west:  'gypsum-board', edges: null,
  },
};
state.room.subStructures = [
  {
    id: 'sub-test1',
    sourceRoomId: 'cr-fakeid',
    sourceRoomName: 'Hut A',
    position: { x_m: 5, y_m: 4 },
    elevation_m: 0,
    rotation_deg: 30,
    sourceRoom: JSON.parse(JSON.stringify(sourceSnap)),
  },
  {
    id: 'sub-test2',
    sourceRoomId: 'cr-fakeid2',
    sourceRoomName: 'Kiosk',
    position: { x_m: 1, y_m: 7 },
    elevation_m: 0.5,
    rotation_deg: 0,
    sourceRoom: JSON.parse(JSON.stringify(sourceSnap)),
  },
];

const text = JSON.stringify(serializeProject());
const parsed = JSON.parse(text);
deserializeProject(parsed);

assert(Array.isArray(state.room.subStructures) && state.room.subStructures.length === 2,
  'subStructures round-trips with both entries');
assert(state.room.subStructures[0].id === 'sub-test1', 'entry 0 id preserved');
assert(state.room.subStructures[0].sourceRoomName === 'Hut A', 'entry 0 sourceRoomName preserved');
assert(state.room.subStructures[0].position.x_m === 5, 'entry 0 position.x_m preserved');
assert(state.room.subStructures[0].position.y_m === 4, 'entry 0 position.y_m preserved');
assert(state.room.subStructures[0].rotation_deg === 30, 'entry 0 rotation_deg preserved');
assert(state.room.subStructures[1].elevation_m === 0.5, 'entry 1 elevation_m preserved');
assert(state.room.subStructures[0].sourceRoom?.width_m === 3,
  'entry 0 sourceRoom snapshot survives round-trip');
assert(state.room.subStructures[0].sourceRoom?.surfaces?.floor === 'wood-floor',
  'entry 0 sourceRoom surfaces preserved');

// 3. Snapshot independence: mutating the original sourceSnap object after
//    placement must NOT affect the entry stored in state.room.subStructures.
//    This is the "deleting the source doesn't break the placement"
//    contract — the entry must own its own copy of the geometry.
applyTemplateToState('hifi');
const original = JSON.parse(JSON.stringify(sourceSnap));
state.room.subStructures = [{
  id: 'sub-iso',
  sourceRoomId: 'cr-iso',
  sourceRoomName: 'Original',
  position: { x_m: 0, y_m: 0 },
  elevation_m: 0,
  rotation_deg: 0,
  // Caller is expected to deep-clone — mirror what the controller does.
  sourceRoom: JSON.parse(JSON.stringify(original)),
}];

// Mutate the (so-called) "library record" — change its width and surface.
original.width_m = 999;
original.surfaces.floor = 'concrete';

assert(state.room.subStructures[0].sourceRoom.width_m === 3,
  'mutating original library entry does NOT change placed sub-structure width_m');
assert(state.room.subStructures[0].sourceRoom.surfaces.floor === 'wood-floor',
  'mutating original library entry does NOT change placed sub-structure floor material');

// 4. After deserialize, the stored sub-structure ALSO survives mutating
//    the parsed JSON object (defensive — guarantees deepClone in
//    deserializeProject did its job).
const text2 = JSON.stringify(serializeProject());
const parsed2 = JSON.parse(text2);
deserializeProject(parsed2);
parsed2.room.subStructures[0].sourceRoom.width_m = 7777;
assert(state.room.subStructures[0].sourceRoom.width_m === 3,
  'deserializeProject deep-clones; mutating parsed JSON does not affect state');

// 5. Round-trip through the schema preserves an empty subStructures
//    array (no leaking of pollutant data, key-set stays clean).
applyTemplateToState('hifi');
state.room.subStructures = [];
const t3 = JSON.stringify(serializeProject());
const p3 = JSON.parse(t3);
deserializeProject(p3);
assert(Array.isArray(state.room.subStructures) && state.room.subStructures.length === 0,
  'empty subStructures: [] round-trips as []');

// 6. A future-saved file with an entry missing the sourceRoom snapshot
//    is filtered out (defensive against hand-edited JSON).
applyTemplateToState('hifi');
const malformed = serializeProject();
malformed.room.subStructures = [
  { id: 'good', sourceRoom: JSON.parse(JSON.stringify(sourceSnap)),
    position: { x_m: 1, y_m: 1 }, elevation_m: 0, rotation_deg: 0,
    sourceRoomName: 'good', sourceRoomId: 'cr-good' },
  { id: 'bad-no-source' },     // missing sourceRoom — must be dropped
  null,                        // null entry — must be dropped
];
deserializeProject(JSON.parse(JSON.stringify(malformed)));
assert(state.room.subStructures.length === 1 && state.room.subStructures[0].id === 'good',
  'malformed entries are filtered on load (1 of 3 survives)');

// 7. Resetting via preset/template/blank-custom clears subStructures.
//    Same discipline as zones / sources / listeners — no data from the
//    previous scene survives a fresh apply.
applyTemplateToState('hifi');
state.room.subStructures = [{
  id: 'leak-check', sourceRoomId: 'x', sourceRoomName: 'leak',
  position: { x_m: 0, y_m: 0 }, elevation_m: 0, rotation_deg: 0,
  sourceRoom: JSON.parse(JSON.stringify(sourceSnap)),
}];
applyPresetToState('auditorium');
assert(state.room.subStructures.length === 0,
  'applyPresetToState clears subStructures from previous scene');

state.room.subStructures = [{
  id: 'leak-check2', sourceRoomId: 'x', sourceRoomName: 'leak',
  position: { x_m: 0, y_m: 0 }, elevation_m: 0, rotation_deg: 0,
  sourceRoom: JSON.parse(JSON.stringify(sourceSnap)),
}];
applyTemplateToState('hifi');
assert(state.room.subStructures.length === 0,
  'applyTemplateToState clears subStructures from previous scene');

state.room.subStructures = [{
  id: 'leak-check3', sourceRoomId: 'x', sourceRoomName: 'leak',
  position: { x_m: 0, y_m: 0 }, elevation_m: 0, rotation_deg: 0,
  sourceRoom: JSON.parse(JSON.stringify(sourceSnap)),
}];
applyBlankCustomRoom();
assert(state.room.subStructures.length === 0,
  'applyBlankCustomRoom clears subStructures from previous scene');

// 8. Standalone enclosures — break-to-merge produces a polygon with the
//    sub's transform BAKED into vertex coords. The math here mirrors
//    breakSubStructureToEnclosure in js/ui/panel-room.js: rotate around
//    source-local origin (0,0), then translate by sub.position. If the
//    panel's bake math drifts from this, the test breaks first.
applyTemplateToState('hifi');
function bakeSubToEnclosure(sub) {
  const src = sub.sourceRoom;
  let local;
  if (src.shape === 'custom' && Array.isArray(src.custom_vertices) && src.custom_vertices.length >= 3) {
    local = src.custom_vertices.map(v => ({ x: v.x, y: v.y }));
  } else {
    const w = src.width_m ?? 5, d = src.depth_m ?? 5;
    local = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
  }
  const rotRad = ((sub.rotation_deg ?? 0) * Math.PI) / 180;
  const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
  const px = sub.position?.x_m ?? 0, py = sub.position?.y_m ?? 0;
  return local.map(p => ({
    x: p.x * cosR - p.y * sinR + px,
    y: p.x * sinR + p.y * cosR + py,
  }));
}
// Rectangular sub at (10, 5), 90° rotation, source 4 × 2.
const sub90 = {
  id: 'sub-bake1',
  sourceRoomId: 'cr-bake1',
  sourceRoomName: 'BakeTest',
  position: { x_m: 10, y_m: 5 },
  elevation_m: 0,
  rotation_deg: 90,
  sourceRoom: {
    shape: 'rectangular',
    width_m: 4, depth_m: 2, height_m: 3,
    surfaces: { floor: 'wood-floor', ceiling: 'gypsum-board',
                wall_north: 'gypsum-board', wall_south: 'gypsum-board',
                wall_east: 'gypsum-board', wall_west: 'gypsum-board',
                walls: 'gypsum-board', edges: null },
  },
};
const baked90 = bakeSubToEnclosure(sub90);
// At rotation 90° the bbox (0,0)→(4,0)→(4,2)→(0,2) maps to
// (0,0)→(0,4)→(-2,4)→(-2,0); add (10, 5) ⇒
// (10,5)→(10,9)→(8,9)→(8,5).
function close(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }
assert(baked90.length === 4, 'bake produces 4 vertices for rect sub');
assert(close(baked90[0].x, 10) && close(baked90[0].y, 5),
  'bake: vertex 0 = (10,5) after 90° rotation + translate');
assert(close(baked90[1].x, 10) && close(baked90[1].y, 9),
  'bake: vertex 1 = (10,9) after 90° rotation + translate');
assert(close(baked90[2].x, 8) && close(baked90[2].y, 9),
  'bake: vertex 2 = (8,9) after 90° rotation + translate');
assert(close(baked90[3].x, 8) && close(baked90[3].y, 5),
  'bake: vertex 3 = (8,5) after 90° rotation + translate');

// 0° rotation, custom polygon — verts pass through with translation only.
const subTri = {
  id: 'sub-bake2',
  sourceRoomId: 'cr-bake2',
  sourceRoomName: 'TriTest',
  position: { x_m: 3, y_m: 7 },
  elevation_m: 1.5,
  rotation_deg: 0,
  sourceRoom: {
    shape: 'custom',
    width_m: 4, depth_m: 4, height_m: 3,
    custom_vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 4 }],
    surfaces: { floor: 'concrete-painted', ceiling: 'acoustic-tile',
                edges: ['brick', 'gypsum-board', 'glass-window'] },
  },
};
const bakedTri = bakeSubToEnclosure(subTri);
assert(bakedTri.length === 3, 'bake: custom triangle survives as 3 verts');
assert(close(bakedTri[0].x, 3) && close(bakedTri[0].y, 7),
  'bake: tri vertex 0 translated to (3,7)');
assert(close(bakedTri[1].x, 7) && close(bakedTri[1].y, 7),
  'bake: tri vertex 1 translated to (7,7)');
assert(close(bakedTri[2].x, 5) && close(bakedTri[2].y, 11),
  'bake: tri vertex 2 translated to (5,11)');

// 9. State.room.standaloneEnclosures default + reset semantics.
applyTemplateToState('hifi');
assert(Array.isArray(state.room.standaloneEnclosures) && state.room.standaloneEnclosures.length === 0,
  'applyTemplateToState yields empty standaloneEnclosures: []');
applyPresetToState('auditorium');
assert(Array.isArray(state.room.standaloneEnclosures) && state.room.standaloneEnclosures.length === 0,
  'applyPresetToState yields empty standaloneEnclosures: []');
applyBlankCustomRoom();
assert(Array.isArray(state.room.standaloneEnclosures) && state.room.standaloneEnclosures.length === 0,
  'applyBlankCustomRoom yields empty standaloneEnclosures: []');

// 10. Round-trip — a populated standaloneEnclosures array survives
//     serialize → JSON → parse → deserialize.
applyTemplateToState('hifi');
state.room.standaloneEnclosures = [
  {
    id: 'enc-rt1',
    label: 'Hut A',
    polygon: baked90,
    height_m: 3,
    elevation_m: 0,
    surfaces: {
      floor: 'wood-floor', ceiling: 'gypsum-board',
      edges: ['gypsum-board', 'gypsum-board', 'gypsum-board', 'gypsum-board'],
    },
  },
  {
    id: 'enc-rt2',
    label: 'Triangle',
    polygon: bakedTri,
    height_m: 3,
    elevation_m: 1.5,
    surfaces: {
      floor: 'concrete-painted', ceiling: 'acoustic-tile',
      edges: ['brick', 'gypsum-board', 'glass-window'],
    },
  },
];
const encText = JSON.stringify(serializeProject());
deserializeProject(JSON.parse(encText));
assert(state.room.standaloneEnclosures.length === 2,
  'standaloneEnclosures round-trips with both entries');
assert(state.room.standaloneEnclosures[0].id === 'enc-rt1', 'enc 0 id preserved');
assert(state.room.standaloneEnclosures[0].label === 'Hut A', 'enc 0 label preserved');
assert(state.room.standaloneEnclosures[0].polygon.length === 4, 'enc 0 polygon length preserved');
assert(close(state.room.standaloneEnclosures[0].polygon[0].x, 10),
  'enc 0 polygon[0].x preserved (transform-baked)');
assert(state.room.standaloneEnclosures[1].surfaces.edges.length === 3,
  'enc 1 edges preserved (3 entries for a triangle)');
assert(state.room.standaloneEnclosures[1].surfaces.edges[0] === 'brick',
  'enc 1 edges[0] preserved');
assert(state.room.standaloneEnclosures[1].elevation_m === 1.5,
  'enc 1 elevation_m preserved');

// 11. Malformed enclosures get filtered on deserialize.
applyTemplateToState('hifi');
const malformedEnc = serializeProject();
malformedEnc.room.standaloneEnclosures = [
  // Good
  { id: 'good', label: 'OK', polygon: baked90, height_m: 3, elevation_m: 0,
    surfaces: { floor: 'wood-floor', ceiling: 'gypsum-board',
                edges: ['gypsum-board','gypsum-board','gypsum-board','gypsum-board'] } },
  // Polygon < 3 verts — drop
  { id: 'bad-poly', polygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }], height_m: 3, elevation_m: 0, surfaces: {} },
  // Missing height — drop
  { id: 'bad-height', polygon: baked90, elevation_m: 0, surfaces: {} },
  // Negative height — drop
  { id: 'bad-negheight', polygon: baked90, height_m: -1, elevation_m: 0, surfaces: {} },
  // Missing surfaces — drop
  { id: 'bad-no-surfaces', polygon: baked90, height_m: 3, elevation_m: 0 },
  // Null entry — drop
  null,
];
deserializeProject(JSON.parse(JSON.stringify(malformedEnc)));
assert(state.room.standaloneEnclosures.length === 1
  && state.room.standaloneEnclosures[0].id === 'good',
  'malformed standaloneEnclosures dropped on load (1 of 6 survives)');

// 12. Reset path also clears standaloneEnclosures (same discipline as
//     subStructures and zones / sources / listeners).
applyTemplateToState('hifi');
state.room.standaloneEnclosures = [{
  id: 'enc-leak', label: 'leak', polygon: baked90, height_m: 3, elevation_m: 0,
  surfaces: { floor: 'wood-floor', ceiling: 'gypsum-board',
              edges: ['gypsum-board','gypsum-board','gypsum-board','gypsum-board'] },
}];
applyPresetToState('auditorium');
assert(state.room.standaloneEnclosures.length === 0,
  'applyPresetToState clears standaloneEnclosures from previous scene');

state.room.standaloneEnclosures = [{
  id: 'enc-leak2', label: 'leak', polygon: baked90, height_m: 3, elevation_m: 0,
  surfaces: { floor: 'wood-floor', ceiling: 'gypsum-board',
              edges: ['gypsum-board','gypsum-board','gypsum-board','gypsum-board'] },
}];
applyBlankCustomRoom();
assert(state.room.standaloneEnclosures.length === 0,
  'applyBlankCustomRoom clears standaloneEnclosures from previous scene');

// 13. wallSegments default + reset semantics. Mirrors subStructures /
//     standaloneEnclosures: empty after every reset entry point so a
//     scene swap never leaves shared walls from the previous scene.
applyTemplateToState('hifi');
assert(Array.isArray(state.room.wallSegments) && state.room.wallSegments.length === 0,
  'applyTemplateToState yields empty wallSegments: []');
applyPresetToState('auditorium');
assert(Array.isArray(state.room.wallSegments) && state.room.wallSegments.length === 0,
  'applyPresetToState yields empty wallSegments: []');
applyBlankCustomRoom();
assert(Array.isArray(state.room.wallSegments) && state.room.wallSegments.length === 0,
  'applyBlankCustomRoom yields empty wallSegments: []');

// 14. wallSegments round-trip + malformed-entry filtering on deserialize.
applyTemplateToState('hifi');
state.room.wallSegments = [
  { id: 'wseg-rt1', x1: 0, y1: 0, x2: 5, y2: 0,
    elevation_m: 0, height_m: 3, materialId: 'gypsum-board',
    openings: [], sourceLabel: 'shared' },
  { id: 'wseg-rt2', x1: 5, y1: 5, x2: 5, y2: 8,
    elevation_m: 1.0, height_m: 2.5, materialId: 'concrete-painted',
    openings: [{ kind: 'door', state: 'closed', materialId: 'door-solid-wood',
                  x_m: 0.5, z_m: 0, width_m: 0.9, height_m: 2.1 }],
    sourceLabel: 'shared' },
];
const wsegText = JSON.stringify(serializeProject());
deserializeProject(JSON.parse(wsegText));
assert(state.room.wallSegments.length === 2, 'wallSegments round-trips with both entries');
assert(state.room.wallSegments[0].id === 'wseg-rt1', 'wseg 0 id preserved');
assert(close(state.room.wallSegments[0].x2, 5), 'wseg 0 x2 preserved');
assert(state.room.wallSegments[1].materialId === 'concrete-painted', 'wseg 1 materialId preserved');
assert(state.room.wallSegments[1].openings.length === 1, 'wseg 1 opening preserved');
assert(state.room.wallSegments[1].openings[0].kind === 'door', 'wseg 1 opening kind preserved');

applyTemplateToState('hifi');
const malformedWseg = serializeProject();
malformedWseg.room.wallSegments = [
  // Good
  { id: 'good', x1: 0, y1: 0, x2: 1, y2: 0, height_m: 3, elevation_m: 0,
    materialId: 'gypsum-board', openings: [] },
  // Missing x2/y2 — drop
  { id: 'bad-end', x1: 0, y1: 0, height_m: 3, materialId: 'gypsum-board' },
  // Negative height — drop
  { id: 'bad-height', x1: 0, y1: 0, x2: 1, y2: 0, height_m: -1, materialId: 'gypsum-board' },
  // Missing materialId — drop
  { id: 'bad-mat', x1: 0, y1: 0, x2: 1, y2: 0, height_m: 3 },
  // null entry — drop
  null,
];
deserializeProject(JSON.parse(JSON.stringify(malformedWseg)));
assert(state.room.wallSegments.length === 1
  && state.room.wallSegments[0].id === 'good',
  'malformed wallSegments dropped on load (1 of 5 survives)');

// 15. Wall-overlap split — three concrete cases driven through the
//     splitParentVsEnclosure helper. Each case verifies the post-split
//     polygons + edges + wallSegments list match the geometric expectation.
const { splitParentVsEnclosure } =
  await import('../js/physics/wall-overlap.js');

// Case 15a — collinear PARTIAL overlap (the brief's main scenario).
//   Parent custom: (0,0)(10,0)(10,10)(0,10), edges = 4× 'gypsum-board'.
//   Enclosure: hut at (5,0)→(7,0)→(7,2)→(5,2), south wall lies along
//   parent's south wall. Expected: parent grows to 6 vertices with the
//   middle wall set to 'open-air'; one wallSegments[] entry from (5,0)
//   to (7,0) inheriting parent's gypsum.
{
  const parentPoly = [{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}];
  const parentEdges = ['gypsum-board','gypsum-board','gypsum-board','gypsum-board'];
  const encPoly = [{x:5,y:0},{x:7,y:0},{x:7,y:2},{x:5,y:2}];
  const encEdges = ['wood-floor','wood-floor','wood-floor','wood-floor'];
  const r = splitParentVsEnclosure(parentPoly, parentEdges, encPoly, encEdges,
    { parentHeight_m: 3 });
  assert(r.parentPolygon.length === 6,
    'partial overlap: parent polygon grows from 4 → 6 vertices');
  // Parent's new south edge ring must be (0,0)→(5,0)→(7,0)→(10,0).
  // Find the index of (0,0) in the new ring.
  const idx00 = r.parentPolygon.findIndex(p => close(p.x, 0) && close(p.y, 0));
  assert(idx00 >= 0, 'partial overlap: parent (0,0) survives');
  const v1 = r.parentPolygon[(idx00 + 1) % 6];
  const v2 = r.parentPolygon[(idx00 + 2) % 6];
  const v3 = r.parentPolygon[(idx00 + 3) % 6];
  assert(close(v1.x, 5) && close(v1.y, 0),
    'partial overlap: parent vertex 1 = (5,0)');
  assert(close(v2.x, 7) && close(v2.y, 0),
    'partial overlap: parent vertex 2 = (7,0)');
  assert(close(v3.x, 10) && close(v3.y, 0),
    'partial overlap: parent vertex 3 = (10,0)');
  // The middle parent edge (5,0)→(7,0) keeps its original material AND
  // gets a system 'merge_cut' opening covering the overlap rectangle.
  // (Previously the slot was set to 'open-air' full-height; that broke
  // the user's case where rooms have different heights — the wall above
  // the shorter room's roof needs to stay solid.)
  const midEdge = r.parentEdges[(idx00 + 1) % 6];
  assert(typeof midEdge === 'object' && midEdge?.materialId === 'gypsum-board',
    'partial overlap: parent middle edge keeps its original material');
  assert(Array.isArray(midEdge.openings) && midEdge.openings.length === 1
      && midEdge.openings[0].system === 'merge_cut'
      && midEdge.openings[0].state === 'open',
    'partial overlap: parent middle edge gets a system merge_cut opening');
  assert(close(midEdge.openings[0].height_m, 3),
    'partial overlap: merge_cut height = min(parent_h, enc_h) = 3');
  assert(close(midEdge.openings[0].width_m, 2),
    'partial overlap: merge_cut width = overlap length = 2');
  // Two end edges stay gypsum-board.
  const e0 = r.parentEdges[idx00];
  const e2 = r.parentEdges[(idx00 + 2) % 6];
  const e0mat = typeof e0 === 'string' ? e0 : e0?.materialId;
  const e2mat = typeof e2 === 'string' ? e2 : e2?.materialId;
  assert(e0mat === 'gypsum-board',
    'partial overlap: parent left end edge stays gypsum');
  assert(e2mat === 'gypsum-board',
    'partial overlap: parent right end edge stays gypsum');
  // wallSegments has exactly one entry, gypsum, length 2 m.
  assert(r.wallSegments.length === 1,
    'partial overlap: one wallSegments entry');
  assert(r.wallSegments[0].materialId === 'gypsum-board',
    'partial overlap: wallSegment inherits parent gypsum');
  const ws = r.wallSegments[0];
  const wsLen = Math.hypot(ws.x2 - ws.x1, ws.y2 - ws.y1);
  assert(close(wsLen, 2), 'partial overlap: wallSegment length = 2 m');
  // Enclosure's south edge keeps its 'wood-floor' material AND gets a
  // matching merge_cut opening — same shape as parent's edge, height
  // bounded to min(parent, enc).
  let encMergeCutCount = 0;
  for (let i = 0; i < r.encPolygon.length; i++) {
    const a = r.encPolygon[i], b = r.encPolygon[(i + 1) % r.encPolygon.length];
    const slot = r.encEdges[i];
    if (typeof slot !== 'object' || !slot?.openings) continue;
    const hasCut = slot.openings.some(o => o.system === 'merge_cut');
    if (!hasCut) continue;
    if ((close(a.x, 5) && close(a.y, 0) && close(b.x, 7) && close(b.y, 0))
     || (close(a.x, 7) && close(a.y, 0) && close(b.x, 5) && close(b.y, 0))) {
      encMergeCutCount++;
    }
  }
  assert(encMergeCutCount === 1,
    'partial overlap: enclosure south edge gets the matching merge_cut opening');
}

// Case 15b — collinear IDENTICAL overlap. Enclosure wall = parent wall
// exactly. After split: the matching parent edge becomes 'open-air',
// no parent vertices are inserted (endpoints already exist), and a
// single wallSegment is created. Tiny parent so the south edge IS the
// enclosure south edge.
{
  const parentPoly = [{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2}];
  const parentEdges = ['brick','brick','brick','brick'];
  const encPoly = [{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2}];
  const encEdges = ['gypsum-board','gypsum-board','gypsum-board','gypsum-board'];
  const r = splitParentVsEnclosure(parentPoly, parentEdges, encPoly, encEdges,
    { parentHeight_m: 3 });
  assert(r.parentPolygon.length === 4,
    'identical overlap: parent polygon stays at 4 vertices');
  assert(r.encPolygon.length === 4,
    'identical overlap: enc polygon stays at 4 vertices');
  // All 4 parent edges keep brick + get a merge_cut opening.
  let mergeCutCount = 0;
  for (const slot of r.parentEdges) {
    if (typeof slot !== 'object' || !slot?.openings) continue;
    if (slot.materialId !== 'brick') continue;
    if (slot.openings.some(o => o.system === 'merge_cut')) mergeCutCount++;
  }
  assert(mergeCutCount === 4,
    'identical overlap: all 4 parent edges keep brick + get a merge_cut opening');
  assert(r.wallSegments.length === 4,
    'identical overlap: 4 wallSegments (one per shared edge)');
  // Each wall inherits parent's brick.
  const allBrick = r.wallSegments.every(s => s.materialId === 'brick');
  assert(allBrick, 'identical overlap: every wallSegment is brick');
}

// Case 15f — DIFFERENT GROUND ELEVATIONS. Parent is 4 m tall at z=0;
// enclosure is 2 m tall sitting on a raised platform at z=1 (so its
// vertical range is z=1..3). The overlap rectangle on the wall face is
// 2 m wide × 2 m tall, positioned at z=1 (NOT z=0). Parent's wall stays
// solid at z=0..1 AND z=3..4 — i.e. cropped both BELOW and ABOVE the
// shared region.
{
  const parentPoly = [{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}];
  const parentEdges = ['gypsum-board','gypsum-board','gypsum-board','gypsum-board'];
  const encPoly = [{x:5,y:0},{x:7,y:0},{x:7,y:2},{x:5,y:2}];
  const encEdges = ['wood-floor','wood-floor','wood-floor','wood-floor'];
  const r = splitParentVsEnclosure(parentPoly, parentEdges, encPoly, encEdges,
    { parentHeight_m: 4, parentElevation_m: 0, encHeight_m: 2, encElevation_m: 1 });
  assert(r.wallSegments.length === 1,
    'elev diff: one wallSegment for the overlap');
  assert(close(r.wallSegments[0].elevation_m, 1),
    'elev diff: wallSegment sits at world z = max(parent_el, enc_el) = 1');
  assert(close(r.wallSegments[0].height_m, 2),
    'elev diff: wallSegment height = overlap range = 2 m');
  // Parent's overlap edge: cut at z_m=1 (relative to parent floor), height 2 m.
  // Find the overlap edge in the parent ring.
  let parentCut = null;
  for (const slot of r.parentEdges) {
    if (typeof slot !== 'object' || !slot?.openings) continue;
    const cut = slot.openings.find(o => o.system === 'merge_cut');
    if (cut) { parentCut = cut; break; }
  }
  assert(parentCut !== null, 'elev diff: parent has a merge_cut');
  assert(close(parentCut.z_m, 1),
    'elev diff: parent cut z_m = overlap_z_min - parent_el = 1');
  assert(close(parentCut.height_m, 2),
    'elev diff: parent cut height = overlap range = 2 m');
  // Enclosure's overlap edge: cut at z_m=0 (relative to enc's own floor,
  // which is already at world z=1), height 2 m.
  let encCut = null;
  for (const slot of r.encEdges) {
    if (typeof slot !== 'object' || !slot?.openings) continue;
    const cut = slot.openings.find(o => o.system === 'merge_cut');
    if (cut) { encCut = cut; break; }
  }
  assert(encCut !== null, 'elev diff: enc has a merge_cut');
  assert(close(encCut.z_m, 0),
    'elev diff: enc cut z_m = overlap_z_min - enc_el = 0 (covers full enc wall)');
  assert(close(encCut.height_m, 2),
    'elev diff: enc cut height = full enc wall = 2 m');
}

// Case 15e — DIFFERENT HEIGHTS. Big parent room is 3 m tall; small
// enclosure is only 2 m tall. The shared wall is height 2 m (the overlap
// in Y is min(3, 2)). The cropped face ABOVE the small room (Y from 2 to
// 3) stays as the parent's solid material. This matches the user's
// reported scenario where a short hut against a tall room produced an
// incorrect full-height invisible cutout.
{
  const parentPoly = [{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}];
  const parentEdges = ['gypsum-board','gypsum-board','gypsum-board','gypsum-board'];
  const encPoly = [{x:5,y:0},{x:7,y:0},{x:7,y:2},{x:5,y:2}];
  const encEdges = ['wood-floor','wood-floor','wood-floor','wood-floor'];
  const r = splitParentVsEnclosure(parentPoly, parentEdges, encPoly, encEdges,
    { parentHeight_m: 3, encHeight_m: 2 });
  assert(r.wallSegments.length === 1,
    'height diff: one wallSegment for the overlap');
  assert(close(r.wallSegments[0].height_m, 2),
    'height diff: wallSegment height = min(3, 2) = 2 m (NOT parent full 3 m)');
  // Parent's overlap edge: keeps gypsum, has merge_cut at h=2 (NOT h=3).
  const idx00 = r.parentPolygon.findIndex(p => close(p.x, 0) && close(p.y, 0));
  const midEdge = r.parentEdges[(idx00 + 1) % 6];
  assert(typeof midEdge === 'object' && midEdge?.materialId === 'gypsum-board',
    'height diff: parent overlap edge keeps gypsum');
  const cut = midEdge.openings[0];
  assert(close(cut.height_m, 2),
    'height diff: merge_cut height matches min(parent, enc) — wall ABOVE stays solid');
  assert(close(cut.width_m, 2),
    'height diff: merge_cut width = overlap length 2 m');
  assert(cut.state === 'open',
    'height diff: merge_cut is acoustically open');
}

// Case 15c — TRANSVERSE cross. A 4-m-tall parent with a 2-m enclosure
// rotated 45° crossing parent's south wall at one point. After split:
// parent south is broken into 2 sub-edges, enclosure's offending wall
// also into 2 sub-edges. NO wallSegments[] entry (transverse crosses
// don't share a seam — they meet at a point).
{
  const parentPoly = [{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}];
  const parentEdges = ['brick','brick','brick','brick'];
  // Enclosure square (1,-1)(3,-1)(3,1)(1,1) — straddles parent's south
  // wall (y=0). Edge 2 (top) lies INSIDE parent. Edge 0 (bottom y=-1)
  // sits OUTSIDE. Left side (1,-1)→(1,1) crosses south wall at (1,0).
  // Right side (3,-1)→(3,1) crosses at (3,0).
  const encPoly = [{x:1,y:-1},{x:3,y:-1},{x:3,y:1},{x:1,y:1}];
  const encEdges = ['wood-floor','wood-floor','wood-floor','wood-floor'];
  const r = splitParentVsEnclosure(parentPoly, parentEdges, encPoly, encEdges,
    { parentHeight_m: 3 });
  // Parent south edge gets 2 new vertices (1,0) and (3,0). Polygon grows
  // by 2.
  assert(r.parentPolygon.length === 6,
    'transverse cross: parent polygon grows by 2 (cross points inserted)');
  // Find the (0,0) vertex in the parent and verify the next two are
  // (1,0) then (3,0).
  const i00 = r.parentPolygon.findIndex(p => close(p.x, 0) && close(p.y, 0));
  assert(i00 >= 0, 'transverse cross: parent (0,0) preserved');
  const a = r.parentPolygon[(i00 + 1) % 6];
  const b = r.parentPolygon[(i00 + 2) % 6];
  assert(close(a.x, 1) && close(a.y, 0),
    'transverse cross: parent first inserted vertex = (1,0)');
  assert(close(b.x, 3) && close(b.y, 0),
    'transverse cross: parent second inserted vertex = (3,0)');
  // No wallSegments — transverse crosses produce point intersections only.
  // (Some collinear segments may exist if vertex insertions caused new
  // walls to align. With these inputs none should.)
  assert(r.wallSegments.length === 0,
    'transverse cross: no wallSegments[] entries created');
  // No edges should be 'open-air' (all original brick segments preserved).
  let parentOpen = 0;
  for (const slot of r.parentEdges) {
    const matId = typeof slot === 'string' ? slot : slot?.materialId;
    if (matId === 'open-air') parentOpen++;
  }
  assert(parentOpen === 0,
    'transverse cross: no parent edges become open-air');
  // Enclosure's two side walls each split into 2 sub-edges → polygon
  // grows by 2 to 6.
  assert(r.encPolygon.length === 6,
    'transverse cross: enc polygon grows by 2');
}

// 16. wallSegments cleared by reset paths (scene swap discipline).
applyTemplateToState('hifi');
state.room.wallSegments = [
  { id: 'wseg-leak', x1: 0, y1: 0, x2: 1, y2: 0, height_m: 3, elevation_m: 0,
    materialId: 'gypsum-board', openings: [] },
];
applyPresetToState('auditorium');
assert(state.room.wallSegments.length === 0,
  'applyPresetToState clears wallSegments from previous scene');

state.room.wallSegments = [
  { id: 'wseg-leak2', x1: 0, y1: 0, x2: 1, y2: 0, height_m: 3, elevation_m: 0,
    materialId: 'gypsum-board', openings: [] },
];
applyBlankCustomRoom();
assert(state.room.wallSegments.length === 0,
  'applyBlankCustomRoom clears wallSegments from previous scene');

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll sub-structure tests passed.');
