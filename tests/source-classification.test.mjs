// Tests for js/physics/source-classification.js (Phase 1 of indoor
// exterior-source coupling fix). Verifies the predicate that downstream
// physics (Phase 2 view-factor / Phase 3 reverb gating) will consume.
//
// Style follows tests/spl.test.mjs + tests/wall-reradiation.test.mjs —
// plain Node, no framework, pass/fail printed and counted.

import { classifySource, listWallFacets } from '../js/physics/source-classification.js';
import surauPreset from '../js/presets/surau.js';

let failed = 0;
function pass(label) { console.log(`PASS  ${label}`); }
function fail(label, extra = '') { console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); failed++; }
function assertEq(a, b, label) { (a === b) ? pass(label) : fail(label, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }
function assertTrue(cond, label, extra = '') { cond ? pass(label) : fail(label, extra); }

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Synthetic rectangular room (auditorium-like) — used for the no-preset
// cases so we control every parameter explicitly.
function makeRectRoom({ W = 10, D = 10, H = 10, ceiling = 'flat' } = {}) {
  return {
    shape: 'rectangular',
    width_m: W,
    depth_m: D,
    height_m: H,
    ceiling_type: ceiling,
    surfaces: {
      floor: 'concrete-painted',
      ceiling: 'gypsum-board',
      wall_north: 'gypsum-board',
      wall_south: 'gypsum-board',
      wall_east:  'gypsum-board',
      wall_west:  'gypsum-board',
    },
  };
}

// Synthetic round room (no preset available — pavilion is custom, not
// 'round'). Round preset coverage matters because polygon/round shapes
// share the 'walls' slot; the classifier must still find them in
// listWallFacets and not blow up on the absent wall_north slot.
function makeRoundRoom({ r = 6, H = 5 } = {}) {
  return {
    shape: 'round',
    width_m: 2 * r,
    depth_m: 2 * r,
    height_m: H,
    round_radius_m: r,
    ceiling_type: 'flat',
    surfaces: {
      floor: 'concrete-painted',
      ceiling: 'gypsum-board',
      walls: 'gypsum-board',
    },
  };
}

// Synthetic standalone enclosure attached to a parent room. The
// enclosure occupies a 4×4 polygon offset from the parent.
function makeRoomWithEnclosure() {
  const room = makeRectRoom({ W: 12, D: 12, H: 4 });
  room.standaloneEnclosures = [{
    polygon: [
      { x: 14, y:  2 },
      { x: 18, y:  2 },
      { x: 18, y:  6 },
      { x: 14, y:  6 },
    ],
    elevation_m: 0,
    height_m: 3,
    materialId: 'gypsum-board',
  }];
  return room;
}

// ---------------------------------------------------------------------------
// Test 1 — Surau azan horn with mount:'minaret' → EXTERIOR (mount win)
// ---------------------------------------------------------------------------
{
  const room = surauPreset;
  const src = { position: { x: -1.2, y: 18.9, z: 7.0 }, mount: 'minaret' };
  const r = classifySource(src, room);
  assertEq(r.kind, 'EXTERIOR', 'T1 azan horn mount:minaret kind');
  assertEq(r.reason, 'mount:minaret', 'T1 azan horn mount:minaret reason');
  assertEq(r.confidence, 'high', 'T1 azan horn mount:minaret confidence');
}

// ---------------------------------------------------------------------------
// Test 2 — Same azan horn, NO mount tag → EXTERIOR via geometric
// ---------------------------------------------------------------------------
{
  const room = surauPreset;
  // Use a position outside the parent footprint AND outside the
  // surauStructure podium extension (extension_m = 3.5; podium spans
  // x ∈ [-3.5, 21.5], y ∈ [-3.5, 21.2]). The minaret centre at
  // (-1.2, 18.9) is INSIDE the podium and the podium check accepts
  // z ≤ 5.0, so a z=7.0 horn is geometrically outside. Per spec the
  // reason starts with 'geom:'.
  const src = { position: { x: -1.2, y: 18.9, z: 7.0 } };
  const r = classifySource(src, room);
  assertEq(r.kind, 'EXTERIOR', 'T2 legacy azan horn geometric kind');
  assertTrue(r.reason.startsWith('geom:'), 'T2 legacy azan horn reason starts with geom:', `reason=${r.reason}`);
}

// ---------------------------------------------------------------------------
// Test 3 — Auditorium flown line array, mount:'flown', Z > ceiling
// → INTERIOR (mount wins even though geometric would reject)
// ---------------------------------------------------------------------------
{
  const room = makeRectRoom({ W: 20, D: 20, H: 10 });
  const src = { position: { x: 0, y: 0, z: 12 }, mount: 'flown' };
  const r = classifySource(src, room);
  assertEq(r.kind, 'INTERIOR', 'T3 flown LA mount:flown above ceiling kind');
  assertEq(r.reason, 'mount:flown', 'T3 flown LA mount:flown reason');
  assertEq(r.confidence, 'high', 'T3 flown LA mount:flown confidence');
}

// ---------------------------------------------------------------------------
// Test 4 — Same flown LA, NO mount tag, (x,y) inside footprint, z > ceiling
// → INTERIOR via flown-above-ceiling safeguard
// ---------------------------------------------------------------------------
{
  const room = makeRectRoom({ W: 20, D: 20, H: 10 });
  // (5, 5) is interior to the 20×20 footprint; z=12 > ceiling=10.
  const src = { position: { x: 5, y: 5, z: 12 } };
  const r = classifySource(src, room);
  assertEq(r.kind, 'INTERIOR', 'T4 flown LA no-mount safeguard kind');
  assertEq(r.reason, 'geom:flown-above-ceiling', 'T4 flown LA safeguard reason');
  assertEq(r.confidence, 'low', 'T4 flown LA safeguard confidence (low → audit)');
}

// ---------------------------------------------------------------------------
// Test 5 — Source at exact polygon edge → deterministic kind (no flip-flop)
// ---------------------------------------------------------------------------
{
  const room = makeRectRoom({ W: 10, D: 10, H: 4 });
  // Exact east wall: x = W, y = 5, z = 1.5. isInsideRoom3D returns true
  // for boundary points (the parent footprint check uses inclusive
  // bounds). Distance to wall_east is 0 → FLUSH_INWARD.
  const src = { position: { x: 10, y: 5, z: 1.5 } };
  const r1 = classifySource(src, room);
  const r2 = classifySource(src, room);
  const r3 = classifySource(src, room);
  assertTrue(r1.kind === r2.kind && r2.kind === r3.kind,
    'T5 edge classification deterministic across repeated calls',
    `r1=${r1.kind} r2=${r2.kind} r3=${r3.kind}`);
  assertTrue(r1.kind === 'FLUSH_INWARD' || r1.kind === 'INTERIOR' || r1.kind === 'EXTERIOR',
    'T5 edge classification produces a valid kind', `kind=${r1.kind}`);
}

// ---------------------------------------------------------------------------
// Test 6 — Source flush on inner west wall facing inward → FLUSH_INWARD
// ---------------------------------------------------------------------------
{
  const room = makeRectRoom({ W: 10, D: 10, H: 4 });
  // 4 cm off the west wall — within the 5 cm hysteresis, well inside
  // otherwise. Normal of wall_west points +x (toward the room interior)
  // so a source mounted on the inner face faces inward.
  const src = { position: { x: 0.04, y: 5, z: 1.5 } };
  const r = classifySource(src, room);
  assertEq(r.kind, 'FLUSH_INWARD', 'T6 flush inner-wall kind');
  assertEq(r.reason, 'geom:flush-inner', 'T6 flush inner-wall reason');
  assertEq(r.confidence, 'medium', 'T6 flush inner-wall confidence');
}

// ---------------------------------------------------------------------------
// Test 7 — Source inside a surau porch → EXTERIOR with reason 'in-porch'
// ---------------------------------------------------------------------------
{
  const room = surauPreset;
  // South arcade (preset's 'south' = state-y=0). The porch polygon is
  // emitted by extractOverheadReflectors with depth=3.0 and 1.5 m end
  // insets on each side; for W=18 the arcade roof spans roughly
  // x ∈ [1.5, 16.5], y ∈ [-3.0, 0]. A source at (9, -1.5, 2.5) is
  // squarely inside both the arcade polygon and the z range [0, 4.4].
  const src = { position: { x: 9, y: -1.5, z: 2.5 } };
  const r = classifySource(src, room);
  assertEq(r.kind, 'EXTERIOR', 'T7 in-porch kind');
  assertEq(r.reason, 'in-porch', 'T7 in-porch reason');
  assertEq(r.confidence, 'high', 'T7 in-porch confidence');
}

// ---------------------------------------------------------------------------
// Test 8 — Source inside a standalone enclosure → INTERIOR 'in-standalone-enclosure'
// ---------------------------------------------------------------------------
{
  const room = makeRoomWithEnclosure();
  // Enclosure spans x ∈ [14, 18], y ∈ [2, 6], z ∈ [0, 3].
  const src = { position: { x: 16, y: 4, z: 1.5 } };
  const r = classifySource(src, room);
  assertEq(r.kind, 'INTERIOR', 'T8 in-standalone-enclosure kind');
  assertEq(r.reason, 'in-standalone-enclosure', 'T8 in-standalone-enclosure reason');
  assertEq(r.confidence, 'medium', 'T8 in-standalone-enclosure confidence');
}

// ---------------------------------------------------------------------------
// Test 9 — Surau podium-mounted source at (9, 9, 5.5), no mount.
// Documents the current behavior under the podium z ≤ 5.0 wart in
// isInsideRoom3D. (9, 9) sits INSIDE the parent footprint (W=18, D=17.7)
// and z=5.5 exceeds maxCeilingHeight=4.5, so the parent-footprint
// branch rejects. The podium-fallback branch in isInsideRoom3D also
// rejects because z=5.5 > 5.0. So isInside=false. The flown-above-
// ceiling safeguard then activates because (9, 9) IS inside the parent
// footprint and z > ceiling. Result: INTERIOR / geom:flown-above-
// ceiling / low confidence. Documented here — DO NOT silently fix
// the podium wart; Hannes wants it factored out, not papered over.
// ---------------------------------------------------------------------------
{
  const room = surauPreset;
  const src = { position: { x: 9, y: 9, z: 5.5 } };
  const r = classifySource(src, room);
  // Document — assert exactly what we get today.
  assertEq(r.kind, 'INTERIOR',
    'T9 podium-mounted z=5.5 documented kind (flown-above-ceiling safeguard hits)');
  assertEq(r.reason, 'geom:flown-above-ceiling',
    'T9 podium-mounted z=5.5 documented reason');
  assertEq(r.confidence, 'low',
    'T9 podium-mounted z=5.5 documented confidence (audit me)');
}

// ---------------------------------------------------------------------------
// Test 10 — Plain interior source via geometric → INTERIOR / geom:inside
// ---------------------------------------------------------------------------
{
  const room = makeRectRoom({ W: 10, D: 10, H: 4 });
  const src = { position: { x: 5, y: 5, z: 2 } };
  const r = classifySource(src, room);
  assertEq(r.kind, 'INTERIOR', 'T10 plain interior kind');
  assertEq(r.reason, 'geom:inside', 'T10 plain interior reason');
  assertEq(r.confidence, 'medium', 'T10 plain interior confidence');
}

// ---------------------------------------------------------------------------
// Test 11 — Plain exterior source via geometric → EXTERIOR / geom:outside
// ---------------------------------------------------------------------------
{
  const room = makeRectRoom({ W: 10, D: 10, H: 4 });
  // x=15 > W=10, y=5 in range, z=2 in range — clearly outside the
  // parent footprint with no enclosure, no porch, no flown.
  const src = { position: { x: 15, y: 5, z: 2 } };
  const r = classifySource(src, room);
  assertEq(r.kind, 'EXTERIOR', 'T11 plain exterior kind');
  assertEq(r.reason, 'geom:outside', 'T11 plain exterior reason');
  assertEq(r.confidence, 'medium', 'T11 plain exterior confidence');
}

// ---------------------------------------------------------------------------
// Test 12 — Round room source classification (non-rectangular shape works)
// ---------------------------------------------------------------------------
{
  const room = makeRoundRoom({ r: 6, H: 5 });
  // Room centre = (6, 6); a source 1 m off centre at z=2 is clearly
  // inside the disc and not at the wall.
  const inside = { position: { x: 7, y: 6, z: 2 } };
  const ri = classifySource(inside, room);
  assertEq(ri.kind, 'INTERIOR', 'T12 round-room interior kind');
  assertEq(ri.reason, 'geom:inside', 'T12 round-room interior reason');

  // A source far outside the disc.
  const outside = { position: { x: 100, y: 6, z: 2 } };
  const ro = classifySource(outside, room);
  assertEq(ro.kind, 'EXTERIOR', 'T12 round-room exterior kind');
  assertEq(ro.reason, 'geom:outside', 'T12 round-room exterior reason');

  // Wall facet enumeration should yield ≥ 3 segments and every facet
  // should have a non-zero area + materialId set.
  const facets = listWallFacets(room);
  assertTrue(facets.length >= 3,
    'T12 round-room listWallFacets yields a non-empty perimeter', `count=${facets.length}`);
  const allHaveArea = facets.every(f => Number.isFinite(f.area) && f.area > 0);
  const allHaveMat  = facets.every(f => typeof f.materialId === 'string' && f.materialId.length > 0);
  assertTrue(allHaveArea, 'T12 round-room facets all carry positive area');
  assertTrue(allHaveMat,  'T12 round-room facets all carry materialId');
}

// ---------------------------------------------------------------------------
// Bonus — listWallFacets sanity check on rectangular room
// ---------------------------------------------------------------------------
{
  const room = makeRectRoom({ W: 10, D: 8, H: 3 });
  const facets = listWallFacets(room);
  assertEq(facets.length, 4, 'rect facets count = 4');
  const ids = new Set(facets.map(f => f.id));
  const expectedIds = ['parent_wall_north', 'parent_wall_south', 'parent_wall_east', 'parent_wall_west'];
  const allFound = expectedIds.every(id => ids.has(id));
  assertTrue(allFound, 'rect facets cover all four canonical walls',
    `ids=${[...ids].join(',')}`);

  // Inward normals — wall_north sits at y=0 with normal +y (into the
  // room); wall_east at x=W with normal -x. Spot-check both.
  const north = facets.find(f => f.id === 'parent_wall_north');
  const east  = facets.find(f => f.id === 'parent_wall_east');
  assertTrue(north.normal.y > 0, 'rect parent_wall_north normal points +y (inward)');
  assertTrue(east.normal.x < 0, 'rect parent_wall_east normal points -x (inward)');

  // Areas: north/south = W*H = 30; east/west = D*H = 24.
  const northArea = facets.find(f => f.id === 'parent_wall_north').area;
  const eastArea  = facets.find(f => f.id === 'parent_wall_east').area;
  assertTrue(Math.abs(northArea - 30) < 1e-6, 'rect wall_north area = 30 m²', `actual=${northArea}`);
  assertTrue(Math.abs(eastArea  - 24) < 1e-6, 'rect wall_east area = 24 m²',  `actual=${eastArea}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.log(`\nFAIL ${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log('\nPASS source-classification (all assertions passed)');
}
