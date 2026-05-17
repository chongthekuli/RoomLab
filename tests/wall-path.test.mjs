// Tests for js/physics/wall-path.js — material-aware, opening-aware
// transmission-loss geometry. Replaces the old flat WALL_TRANSMISSION_LOSS_DB
// model. Validates the 8 path-vs-wall fixtures from Hannes's design doc:
//   (a) source inside, listener inside, no walls
//   (b) source inside, listener outside through SOLID wall, 1 wall
//   (c) path through south door opening, 1 wall with throughOpening:true
//   (d) path through south wall MISSING the door (offset), 1 wall opaque
//   (e) source inside hut enclosure, listener in parent room, 2 walls
//   (f) source above ceiling, listener below, ceiling hit
//   (g) polygon room 6-sided, path crosses 2 edges
//   (h) tangent-grazing edge case at corner

import {
  wallsCrossedByPath, transmissionLossDb, bandIndexForFreq,
  pathTransmissionLoss, _resetWarningCachesForTests,
} from '../js/physics/wall-path.js';

let failed = 0;
function pass(label) { console.log(`PASS  ${label}`); }
function fail(label, extra = '') {
  console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`);
  failed++;
}
function assertEq(actual, expected, label) {
  if (actual === expected) pass(label);
  else fail(label, `actual=${actual} expected=${expected}`);
}
function assertClose(actual, expected, tol, label) {
  if (Math.abs(actual - expected) < tol) pass(label);
  else fail(label, `actual=${actual} expected=${expected} tol=${tol}`);
}
function assertTrue(cond, label) { cond ? pass(label) : fail(label); }

// Stub materials catalogue — minimum fields wall-path.js consumes.
const materials = {
  frequency_bands_hz: [125, 250, 500, 1000, 2000, 4000, 8000],
  byId: {
    'concrete-painted': {
      transmission_loss_db: [39, 41, 47, 53, 58, 62, 65],
    },
    'gypsum-board': {
      transmission_loss_db: [15, 21, 28, 33, 33, 28, 32],
    },
    'open-air': {
      transmission_loss_db: [0, 0, 0, 0, 0, 0, 0],
    },
    'door-solid-wood': {
      transmission_loss_db: [17, 21, 25, 25, 28, 32, 36],
    },
    'wood-floor': {
      transmission_loss_db: [18, 22, 25, 28, 32, 32, 32],
    },
    'mat-no-tl': {
      // Deliberately omits transmission_loss_db to exercise the engine
      // floor fallback path.
    },
  },
};

// 5×3×5 m rectangular room (W × H × D). All four walls + floor + ceiling
// are concrete-painted with no openings unless the fixture adds them.
function makeRectRoom(extras = {}) {
  return {
    shape: 'rectangular',
    width_m: 5, height_m: 3, depth_m: 5,
    surfaces: {
      floor: 'concrete-painted',
      ceiling: 'concrete-painted',
      wall_north: 'concrete-painted',
      wall_south: 'concrete-painted',
      wall_east:  'concrete-painted',
      wall_west:  'concrete-painted',
    },
    ...extras,
  };
}

// ---- (a) Both inside: no walls crossed --------------------------------
{
  const room = makeRectRoom();
  const src = { x: 2.5, y: 1, z: 1 };
  const lst = { x: 2.5, y: 2, z: 1 };
  const walls = wallsCrossedByPath(src, lst, room);
  assertEq(walls.length, 0, '(a) src + listener both inside → 0 wall crossings');
  const tl = transmissionLossDb(walls, materials, bandIndexForFreq(materials, 1000));
  assertEq(tl, 0, '(a) TL = 0 dB when both inside');
}

// ---- (b) Through SOLID wall (no opening on that wall) -----------------
// Speaker outside east wall, listener inside. Path enters via wall_east.
{
  const room = makeRectRoom();
  const src = { x: 10, y: 2.5, z: 1 };
  const lst = { x: 2.5, y: 2.5, z: 1 };
  const walls = wallsCrossedByPath(src, lst, room);
  assertEq(walls.length, 1, '(b) speaker outside east → 1 wall hit');
  assertEq(walls[0].materialId, 'concrete-painted', '(b) wall material = concrete-painted');
  assertEq(walls[0].throughOpening, false, '(b) throughOpening = false (solid wall)');
  assertEq(walls[0].wallId, 'parent_wall_east', '(b) wallId identifies wall_east');
  const tl1k = transmissionLossDb(walls, materials, bandIndexForFreq(materials, 1000));
  assertEq(tl1k, 53, '(b) TL = 53 dB at 1 kHz (concrete-painted band 3)');
  const tl125 = transmissionLossDb(walls, materials, bandIndexForFreq(materials, 125));
  assertEq(tl125, 39, '(b) TL = 39 dB at 125 Hz (band 0)');
  const tl8k = transmissionLossDb(walls, materials, bandIndexForFreq(materials, 8000));
  assertEq(tl8k, 65, '(b) TL = 65 dB at 8 kHz (band 6)');
}

// ---- (c) Path through an OPEN door opening → TL = 0 -------------------
// wall_south carries one 1m wide × 2m tall opening centred at x_m = 2.0,
// floor-level. wall_south's v1 is (0, D) = (0, 5), v2 = (W, D) = (5, 5),
// so x_m measures from the west end of that wall toward the east.
// Path runs from listener at (2.5, 4, 1) (inside) to source at (2.5, 10, 1)
// (outside, beyond the south wall). The path crosses (2.5, 5, 1) which
// is x_m = 2.5 along wall_south, zLocal = 1 — inside the opening rectangle
// [x_m ∈ [2, 3], z ∈ [0, 2]].
{
  const room = makeRectRoom({
    surfaces: {
      floor: 'concrete-painted',
      ceiling: 'concrete-painted',
      wall_north: 'concrete-painted',
      wall_south: {
        materialId: 'concrete-painted',
        openings: [{
          x_m: 2.0, z_m: 0, width_m: 1.0, height_m: 2.0,
          state: 'open', materialId: 'open-air',
        }],
      },
      wall_east:  'concrete-painted',
      wall_west:  'concrete-painted',
    },
  });
  const src = { x: 2.5, y: 10, z: 1 };
  const lst = { x: 2.5, y: 4,  z: 1 };
  const walls = wallsCrossedByPath(src, lst, room);
  assertEq(walls.length, 1, '(c) path through door opening → 1 wall hit');
  assertEq(walls[0].throughOpening, true, '(c) throughOpening = true (door)');
  assertEq(walls[0].materialId, 'open-air', '(c) materialId reports open-air for the hit');
  const tl = transmissionLossDb(walls, materials, bandIndexForFreq(materials, 1000));
  assertEq(tl, 0, '(c) TL = 0 dB through open door');
}

// ---- (d) Path through SAME wall but offset to MISS the door -----------
// Same wall + same opening as (c). Now the path crosses wall_south at
// x_m = 4.5 (well outside the door's [2..3] interval) — must be opaque.
{
  const room = makeRectRoom({
    surfaces: {
      floor: 'concrete-painted',
      ceiling: 'concrete-painted',
      wall_north: 'concrete-painted',
      wall_south: {
        materialId: 'concrete-painted',
        openings: [{
          x_m: 2.0, z_m: 0, width_m: 1.0, height_m: 2.0,
          state: 'open', materialId: 'open-air',
        }],
      },
      wall_east:  'concrete-painted',
      wall_west:  'concrete-painted',
    },
  });
  // wall_south.v1 = (0, 5), v2 = (5, 5). u maps x_m / wallLen.
  // We want x_m = 4.5 → u = 0.9 → world hit at (4.5, 5).
  const src = { x: 4.5, y: 10, z: 1 };
  const lst = { x: 4.5, y: 4,  z: 1 };
  const walls = wallsCrossedByPath(src, lst, room);
  assertEq(walls.length, 1, '(d) path offset past door → 1 wall hit');
  assertEq(walls[0].throughOpening, false, '(d) throughOpening = false (misses door)');
  assertEq(walls[0].materialId, 'concrete-painted', '(d) hit reports concrete material');
  const tl = transmissionLossDb(walls, materials, bandIndexForFreq(materials, 1000));
  assertEq(tl, 53, '(d) TL = 53 dB at 1 kHz (full concrete TL applied)');
}

// ---- (e) Source inside enclosure, listener in parent room -------------
// Parent: 10×10 rectangular. Standalone enclosure: 2×2 hut placed at
// (1..3, 1..3) inside the parent, gypsum walls. Path from src inside
// the hut to listener in the parent crosses ONE hut wall.
{
  const room = {
    shape: 'rectangular',
    width_m: 10, height_m: 3, depth_m: 10,
    surfaces: {
      floor: 'concrete-painted', ceiling: 'concrete-painted',
      wall_north: 'concrete-painted', wall_south: 'concrete-painted',
      wall_east:  'concrete-painted', wall_west:  'concrete-painted',
    },
    standaloneEnclosures: [{
      id: 'hut1',
      polygon: [
        { x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 },
      ],
      elevation_m: 0, height_m: 3,
      surfaces: {
        floor: 'wood-floor', ceiling: 'gypsum-board',
        walls: 'gypsum-board',
        edges: ['gypsum-board', 'gypsum-board', 'gypsum-board', 'gypsum-board'],
      },
    }],
  };
  const src = { x: 2, y: 2, z: 1 };   // inside hut
  const lst = { x: 7, y: 2, z: 1 };   // in parent, east of hut
  const walls = wallsCrossedByPath(src, lst, room);
  // Expected: 1 hut wall (the east edge of hut1, from (3,1) to (3,3))
  // and NO parent wall (both endpoints are inside the parent footprint).
  const hutHits = walls.filter(w => w.wallId.startsWith('enc0_'));
  const parentHits = walls.filter(w => w.wallId.startsWith('parent_'));
  assertEq(hutHits.length, 1, '(e) src in hut, listener in parent → 1 hut wall hit');
  assertEq(parentHits.length, 0, '(e) no parent wall hit (both inside parent)');
  assertEq(hutHits[0].materialId, 'gypsum-board', '(e) hut wall material = gypsum-board');
  const tl = transmissionLossDb(walls, materials, bandIndexForFreq(materials, 1000));
  assertEq(tl, 33, '(e) TL = 33 dB at 1 kHz (gypsum band 3)');
}

// ---- (f) Source above ceiling, listener below → ceiling plane hit -----
{
  const room = makeRectRoom();
  const src = { x: 2.5, y: 2.5, z: 5 };       // above ceiling at z=3
  const lst = { x: 2.5, y: 2.5, z: 1.2 };     // listener ear height
  const walls = wallsCrossedByPath(src, lst, room);
  // Path is purely vertical so no wall edge intersection; only ceiling.
  const ceilHits = walls.filter(w => w.wallId === 'parent_ceiling');
  const floorHits = walls.filter(w => w.wallId === 'parent_floor');
  assertEq(ceilHits.length, 1, '(f) ceiling crossing detected');
  assertEq(floorHits.length, 0, '(f) no floor crossing (listener above floor)');
  assertEq(ceilHits[0].materialId, 'concrete-painted', '(f) ceiling material recorded');
  assertEq(ceilHits[0].throughOpening, false, '(f) ceiling is solid (no openings on planes)');
}

// ---- (g) Polygon room (6-sided), path crosses 2 edges -----------------
// Hex polygon centred at (5, 5) with radius 4, rotated 30° so no vertex
// lands on the y=5 path line (otherwise vertex-grazing gives 4 hits).
// Source outside polygon on the +X side, listener outside polygon on
// the -X side, line through the centre → 2 clean edge crossings.
{
  const verts = [];
  const rotOffset = Math.PI / 6;   // 30° rotation
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 2 * Math.PI + rotOffset;
    verts.push({ x: 5 + 4 * Math.cos(a), y: 5 + 4 * Math.sin(a) });
  }
  const room = {
    shape: 'custom',
    custom_vertices: verts,
    width_m: 10, height_m: 3, depth_m: 10,
    surfaces: {
      floor: 'concrete-painted', ceiling: 'concrete-painted',
      walls: 'gypsum-board',
      edges: ['gypsum-board','gypsum-board','gypsum-board','gypsum-board','gypsum-board','gypsum-board'],
    },
  };
  const src = { x: 12, y: 5, z: 1 };
  const lst = { x: -2, y: 5, z: 1 };
  const walls = wallsCrossedByPath(src, lst, room);
  // Floor/ceiling not crossed (z = 1 within [0, 3] for both endpoints).
  // Expect exactly 2 polygon edge hits.
  const edgeHits = walls.filter(w => w.wallId.startsWith('parent_edge_'));
  assertEq(edgeHits.length, 2, '(g) line through hex room crosses 2 edges');
  const tl = transmissionLossDb(walls, materials, bandIndexForFreq(materials, 1000));
  assertEq(tl, 33 + 33, '(g) TL = sum of 2 gypsum walls = 66 dB at 1 kHz');
}

// ---- (h) Corner-grazing path — deterministic single hit ---------------
// Path along the diagonal that exits via the SE corner of the rect.
// Without the EPS tolerance in segmentIntersect2D this would flicker
// between 0 and 2 hits. With EPS, the path scores at least one hit
// (deterministic) and at most two (one per adjacent edge at the corner).
{
  const room = makeRectRoom();
  // From inside (1,1) heading to (10, 10) — exits via corner (5, 5).
  const src = { x: 1, y: 1, z: 1 };
  const lst = { x: 10, y: 10, z: 1 };
  const walls = wallsCrossedByPath(src, lst, room);
  // The path crosses both wall_east (x=5) and wall_south (y=5) at
  // exactly (5,5). With EPS-tolerant segment hits this resolves to
  // both walls registering; the TL dB-sum still gives a finite,
  // well-defined value (no NaN, no Infinity, no flicker).
  assertTrue(walls.length >= 1 && walls.length <= 2, `(h) corner-grazing → 1 or 2 hits (got ${walls.length})`);
  for (const w of walls) {
    assertTrue(Number.isFinite(w.hitPoint.x) && Number.isFinite(w.hitPoint.y) && Number.isFinite(w.hitPoint.z),
      '(h) hitPoint coordinates finite');
  }
  const tl = transmissionLossDb(walls, materials, bandIndexForFreq(materials, 1000));
  assertTrue(Number.isFinite(tl) && tl > 0, `(h) TL finite + > 0 (got ${tl})`);
}

// ---- Bonus: missing-TL fallback emits one warning then silences -------
{
  _resetWarningCachesForTests();
  const origWarn = console.warn;
  let warnCount = 0;
  console.warn = () => { warnCount++; };
  try {
    const walls = [
      { wallId: 'parent_wall_east', materialId: 'mat-no-tl', throughOpening: false },
    ];
    const tl1 = transmissionLossDb(walls, materials, 3);
    const tl2 = transmissionLossDb(walls, materials, 3);
    assertEq(tl1, 20, 'Missing TL → engine floor 20 dB (first call)');
    assertEq(tl2, 20, 'Missing TL → engine floor 20 dB (second call)');
    assertEq(warnCount, 1, 'Engine emits exactly one warning per missing material');
  } finally {
    console.warn = origWarn;
  }
}

// ---- bandIndexForFreq snap-to-nearest-log behaviour -------------------
assertEq(bandIndexForFreq(materials, 1000), 3, 'bandIndexForFreq(1000) → 3');
// 707 Hz is the log-midpoint between 500 and 1000 (sqrt(500·1000)).
// 700 Hz is just below the midpoint → snaps to 500 (index 2), not 1000.
assertEq(bandIndexForFreq(materials, 700), 2, 'bandIndexForFreq(700) snaps to 500 (just below log-midpoint)');
assertEq(bandIndexForFreq(materials, 750), 3, 'bandIndexForFreq(750) snaps to 1000 (just above log-midpoint)');
assertEq(bandIndexForFreq(materials, 350), 1, 'bandIndexForFreq(350) snaps to 250 (index 1)');
assertEq(bandIndexForFreq(materials, 125), 0, 'bandIndexForFreq(125) → 0');
assertEq(bandIndexForFreq(materials, 8000), 6, 'bandIndexForFreq(8000) → 6');

// ---- pathTransmissionLoss convenience wrapper -------------------------
{
  const room = makeRectRoom();
  const src = { x: 10, y: 2.5, z: 1 };
  const lst = { x: 2.5, y: 2.5, z: 1 };
  const r = pathTransmissionLoss(src, lst, room, materials, 1000);
  assertEq(r.tl_db, 53, 'pathTransmissionLoss returns TL at 1 kHz through concrete');
  assertEq(r.wallsCrossed.length, 1, 'pathTransmissionLoss includes wallsCrossed array');
}

if (failed > 0) { console.log(`\n${failed} wall-path test(s) FAILED`); process.exit(1); }
console.log('\nAll wall-path tests passed.');
