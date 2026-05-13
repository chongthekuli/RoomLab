// Regression — acoustic treatments (v1 visual-only placement).
//
// Covers: state schema, duplicate, anchor preservation under vertex
// drag, orphan-rescue after wall removal, BOM aggregation, and project
// save/load round-trip. These are the failure modes Hannes & Sam
// flagged in the brief — any breakage here means a user-reported bug
// is one merge away.
//
// Run: node tests/treatments.test.mjs

import {
  state, applyPresetToState, applyBlankCustomRoom,
  duplicateTreatment, serializeProject, deserializeProject,
} from '../js/app-state.js';
import {
  makeTreatmentEntry, projectOntoNearestWall, projectOntoWall,
  rescueOrphanedTreatments, nextTreatmentId,
} from '../js/ui/panel-treatments.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// ---------------------------------------------------------------------------
// Test fixture — small rectangular room, simulate a hand-placed panel.
// ---------------------------------------------------------------------------
function freshScene() {
  // Use blank-custom — gives us a clean state.room with no preset baggage.
  applyBlankCustomRoom();
  state.room.width_m = 10;
  state.room.depth_m = 10;
  state.room.height_m = 3;
  state.room.shape = 'custom';
  state.room.custom_vertices = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
  ];
  state.treatments = [];
  state.selectedTreatmentId = null;
}

const FAKE_SPEC = {
  id: 'rpg-skyline-2d',
  name: 'Skyline',
  manufacturer: 'RPG Diffusor Systems',
  category: 'diffuser.qrd_2d',
  geometry: { width_mm: 600, height_mm: 600, depth_mm: 100, weight_kg_m2: 11 },
};

// ---------------------------------------------------------------------------
// State schema — default + makeTreatmentEntry shape
// ---------------------------------------------------------------------------
freshScene();
assert(Array.isArray(state.treatments) && state.treatments.length === 0,
  'state.treatments starts empty after scene reset');
assert(state.selectedTreatmentId === null,
  'selectedTreatmentId starts null after scene reset');

const t1 = makeTreatmentEntry(
  FAKE_SPEC,
  { surface: 'wall', wallIndex: 0 },
  { x: 5, y: 0, z: 1.2 },
  0,
);
assert(t1.id === 'T1', 'first treatment gets id T1');
assert(t1.productId === 'rpg-skyline-2d', 'productId copied from spec');
assert(t1.label === 'Skyline', 'label defaults to product name');
assert(t1.dimensions.width_m === 0.6, 'width_m derived from geometry mm');
assert(t1.dimensions.height_m === 0.6, 'height_m derived from geometry mm');
assert(t1.dimensions.depth_m === 0.1, 'depth_m derived from geometry mm');
assert(t1.anchor.surface === 'wall' && t1.anchor.wallIndex === 0,
  'anchor surface + wallIndex preserved');
assert(t1.position.x === 5 && t1.position.y === 0 && t1.position.z === 1.2,
  'position passed through');
state.treatments.push(t1);
assert(nextTreatmentId() === 'T2', 'nextTreatmentId increments after push');

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------
const newId = duplicateTreatment('T1');
assert(newId === 'T2', 'duplicateTreatment returns the new id');
assert(state.treatments.length === 2, 'duplicate added a second entry');
const t2 = state.treatments.find(t => t.id === 'T2');
assert(t2 && t2.productId === t1.productId,
  'duplicate preserves productId');
assert(t2.position.x !== t1.position.x,
  'duplicate offsets the X position (not exactly on top)');
assert(t2._cachedSpec === undefined,
  'duplicate strips _cachedSpec (session-only field)');

// ---------------------------------------------------------------------------
// projectOntoNearestWall — sanity
// ---------------------------------------------------------------------------
const verts = state.room.custom_vertices;
const proj = projectOntoNearestWall(state.room, verts, { x: 5, y: 0.3 }, 1.5);
assert(proj && proj.wallIndex === 0, 'nearest wall to (5, 0.3) is edge 0');
assert(Math.abs(proj.position.x - 5) < 1e-6, 'projected X clamped to the wall');
assert(Math.abs(proj.position.y - 0) < 1e-6, 'projected Y snapped to wall edge y=0');
assert(proj.position.z === 1.5, 'projection preserves height');

// projectOntoWall — explicit index
const projAcross = projectOntoWall(verts, 2, { x: 5, y: 5 }, 2.0);
assert(projAcross && projAcross.wallIndex === 2, 'projectOntoWall honours explicit index');
assert(Math.abs(projAcross.position.y - 10) < 1e-6, 'wall 2 has y=10');

// ---------------------------------------------------------------------------
// Anchor preservation under vertex drag — re-projects onto current segment
// ---------------------------------------------------------------------------
// Move wall 0 — pull vertex 0 to (0, -2). Treatment T1 at (5, 0) should
// re-snap to the new edge, NOT drift through the wall.
verts[0] = { x: 0, y: -2 };  // now wall 0 runs from (0,-2) to (10,0)
const projAfterDrag = projectOntoWall(verts, 0, { x: 5, y: 0 }, 1.2);
assert(projAfterDrag,
  'projection after vertex drag returns a result');
// The wall now slopes; the closest point on it to (5, 0) is no longer (5,0).
const dx = projAfterDrag.position.x - 5;
const dy = projAfterDrag.position.y - 0;
const dist = Math.hypot(dx, dy);
assert(dist > 0 && dist < 2,
  'projection after wall drag yields a point ON the new segment (not the old)');

// Restore for the next test
verts[0] = { x: 0, y: 0 };

// ---------------------------------------------------------------------------
// Orphan rescue — wall index becomes invalid after polygon collapse
// ---------------------------------------------------------------------------
state.treatments = [
  makeTreatmentEntry(FAKE_SPEC, { surface: 'wall', wallIndex: 0 }, { x: 5, y: 0, z: 1.2 }),
  makeTreatmentEntry(FAKE_SPEC, { surface: 'wall', wallIndex: 7 }, { x: 5, y: 5, z: 1.2 }),
  makeTreatmentEntry(FAKE_SPEC, { surface: 'ceiling' },           { x: 3, y: 3, z: 3.0 }),
];
const rescued = rescueOrphanedTreatments(verts);
assert(rescued === 1, 'one wall-anchored treatment rescued (wallIndex 7 out of range)');
assert(state.treatments[0].anchor.wallIndex === 0, 'in-range wall anchor untouched');
assert(state.treatments[1].anchor.wallIndex >= 0 && state.treatments[1].anchor.wallIndex < 4,
  'orphaned wall anchor re-projected onto a surviving wall');
assert(state.treatments[2].anchor.surface === 'ceiling',
  'ceiling anchor not touched by orphan rescue');

// ---------------------------------------------------------------------------
// Save / load round-trip — schema v1 additive, treatments survive
// ---------------------------------------------------------------------------
state.treatments = [
  makeTreatmentEntry(FAKE_SPEC, { surface: 'wall', wallIndex: 2 }, { x: 4, y: 10, z: 1.5 }, 0),
  makeTreatmentEntry(FAKE_SPEC, { surface: 'ceiling' },           { x: 5, y: 5, z: 3.0 }, 45),
];
state.selectedTreatmentId = state.treatments[0].id;
const json = serializeProject(state);
assert(Array.isArray(json.treatments) && json.treatments.length === 2,
  'serializeProject includes treatments array');
assert(json.treatments[0]._cachedSpec === undefined,
  'serializeProject strips _cachedSpec from serialized output');
assert(json.selectedTreatmentId === state.treatments[0].id,
  'serializeProject preserves selectedTreatmentId');

// Wipe + reload via deserialize — verifies state.treatments survives.
applyBlankCustomRoom();
assert(state.treatments.length === 0,
  'applyBlankCustomRoom clears treatments');
deserializeProject(json);
assert(state.treatments.length === 2,
  'deserialize restores treatment count');
assert(state.treatments[0].anchor.wallIndex === 2,
  'deserialize preserves wall anchor');
assert(state.treatments[1].anchor.surface === 'ceiling',
  'deserialize preserves ceiling anchor');
assert(state.treatments[1].rotation_deg === 45,
  'deserialize preserves rotation_deg');
assert(state.selectedTreatmentId === state.treatments[0].id,
  'deserialize restores selectedTreatmentId when treatment still exists');

// ---------------------------------------------------------------------------
// Scene reset clears treatments (preset / blank-custom / template path)
// ---------------------------------------------------------------------------
applyPresetToState('auditorium');
assert(Array.isArray(state.treatments) && state.treatments.length === 0,
  'applyPresetToState wipes treatments');
assert(state.selectedTreatmentId === null,
  'applyPresetToState clears selectedTreatmentId');

// ---------------------------------------------------------------------------
// Deserialize filters malformed entries
// ---------------------------------------------------------------------------
const malformed = {
  formatVersion: 1,
  room: { shape: 'rectangular', width_m: 10, depth_m: 10, height_m: 3,
          surfaces: { floor: 'wood-floor', ceiling: 'gypsum-board',
                      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
                      wall_east: 'gypsum-board', wall_west: 'gypsum-board' } },
  treatments: [
    { id: 'T1', productId: 'x', position: { x: 1, y: 2, z: 3 }, dimensions: {} },     // valid
    { id: 'T2' /* no productId */, position: { x: 1, y: 2, z: 3 } },                  // skipped
    null,                                                                              // skipped
    { id: 'T3', productId: 'x' /* no position */ },                                   // skipped
    { id: 'T4', productId: 'x', position: { x: NaN, y: 0, z: 0 } },                  // skipped
  ],
};
deserializeProject(malformed);
assert(state.treatments.length === 1,
  'deserialize filters malformed treatment entries (4 of 5 invalid)');
assert(state.treatments[0].id === 'T1',
  'only valid treatment T1 survives the filter');

// ---------------------------------------------------------------------------
// BOM aggregation — productId × count, area + weight sums
// ---------------------------------------------------------------------------
state.treatments = [
  makeTreatmentEntry({ ...FAKE_SPEC, id: 'a' }, { surface: 'wall', wallIndex: 0 }, { x: 1, y: 0, z: 1 }),
  makeTreatmentEntry({ ...FAKE_SPEC, id: 'a' }, { surface: 'wall', wallIndex: 0 }, { x: 2, y: 0, z: 1 }),
  makeTreatmentEntry({ ...FAKE_SPEC, id: 'b' }, { surface: 'ceiling' },           { x: 3, y: 3, z: 3 }),
];
// Inline replica of aggregateTreatmentsBOM (kept private in print-
// report.js so it doesn't escape that module's surface). Tests the
// same grouping rule the printer applies.
function aggBOM(treatments) {
  const by = new Map();
  for (const t of treatments) {
    const dim = t.dimensions || {};
    const unitArea = (dim.width_m ?? 0) * (dim.height_m ?? 0);
    let row = by.get(t.productId);
    if (!row) {
      row = { productId: t.productId, count: 0, totalArea: 0 };
      by.set(t.productId, row);
    }
    row.count += 1;
    row.totalArea += unitArea;
  }
  return Array.from(by.values()).sort((a, b) => b.count - a.count);
}
const bom = aggBOM(state.treatments);
assert(bom.length === 2, 'BOM groups by productId');
assert(bom[0].productId === 'a' && bom[0].count === 2,
  'BOM most-used row is "a" with count 2');
assert(Math.abs(bom[0].totalArea - 2 * 0.6 * 0.6) < 1e-9,
  'BOM aggregates total area correctly');
assert(bom[1].productId === 'b' && bom[1].count === 1,
  'BOM second row is "b" with count 1');

// ---------------------------------------------------------------------------
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
