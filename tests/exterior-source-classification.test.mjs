// tests/exterior-source-classification.test.mjs
//
// Phase 4 of the indoor exterior-source coupling fix. Owns the
// regression tripwires for Martina's Phase 3 wiring in
// js/physics/spl-calculator.js — the per-EXTERIOR-source reverb-leak
// suppression that stops minaret horns from inflating the prayer-hall
// reverberant aggregate by 3-5 dB.
//
// Tests (Sam audit, 2026-05-25):
//   1. Exterior source must not inflate interior reverb (vs interior-only).
//   2. Indoor heatmap cell ↔ outdoor heatmap cell parity at an interior
//      listener (the indoor pipeline must drop with the fix; the outdoor
//      pipeline already excludes exterior sources, so they should converge).
//   3. Heatmap cell ↔ per-listener label lockstep (single-listener path
//      vs grid path must agree within 0.2 dB at the same point).
//   4. Panel-results breakdown ↔ label parity — computeListenerBreakdown
//      reverb loop is its own surface that has to learn the classifier too.
//   5. STIPA direction — at an interior listener, EXTERIOR-classified source
//      yields STI ≥ same-listener STI with the source forced INTERIOR.
//      (Direction-only: removing fake reverb cannot HURT intelligibility.)
//   6. Golden surau snapshot — mean interior SPL across all interior cells,
//      pinned to a hardcoded constant. Captured AFTER Martina's fix lands;
//      placeholder NaN today, autopaper-skip until filled.
//
// Style follows tests/spl.test.mjs + tests/exterior-coupling.test.mjs —
// plain Node, no framework. PASS/FAIL printed per assertion; exit non-zero
// on any failure. PHYSICS_P1_5 ON so Tier 1a paths are exercised (the
// classifier fix has to work in the deploy configuration that ships).
//
// Run: node tests/exterior-source-classification.test.mjs

import { readFileSync } from 'node:fs';

// localStorage polyfill BEFORE module import so PHYSICS_P1_5 reads truthy
// at load time (same pattern as tests/wall-reradiation.test.mjs).
const _store = { PHYSICS_P1_5: '1' };
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
};

const {
  computeMultiSourceSPL,
  computeListenerBreakdown,
  computeSPLGrid,
  computeRoomConstant,
} = await import('../js/physics/spl-calculator.js');
const {
  computeSTIPA,
} = await import('../js/physics/stipa.js');
const { classifySource } = await import('../js/physics/source-classification.js');
const { isInsideRoom3D } = await import('../js/physics/room-shape.js');

// ----- Materials + loudspeaker catalogues from disk -----
const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};
const hs880 = JSON.parse(readFileSync('./data/loudspeakers/amperes-hs880.json', 'utf8'));
const cs520 = JSON.parse(readFileSync('./data/loudspeakers/amperes-cs520.json', 'utf8'));

// Bring in the surau preset for the canonical scene tests (5, 6).
const surauPreset = (await import('../js/presets/surau.js')).default;

// ----- Test scaffolding -----
let failed = 0;
const pass = (l) => console.log(`PASS  ${l}`);
const fail = (l, e = '') => { console.log(`FAIL  ${l}${e ? '  — ' + e : ''}`); failed++; };
const ok = (c, l, e = '') => (c ? pass(l) : fail(l, e));
const assertClose = (a, b, tol, l) => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    fail(l, `non-finite: actual=${a} expected=${b}`); return;
  }
  if (Math.abs(a - b) < tol) pass(`${l}  (actual=${a.toFixed(3)} expected=${b.toFixed(3)} tol=${tol})`);
  else fail(l, `actual=${a.toFixed(3)} expected=${b.toFixed(3)} tol=${tol} delta=${(a-b).toFixed(3)}`);
};
const assertLE = (a, b, l) => {
  if (a <= b) pass(`${l}  (actual=${a.toFixed(3)} ≤ ${b.toFixed(3)})`);
  else fail(l, `actual=${a.toFixed(3)} > ${b.toFixed(3)}`);
};
const assertGE = (a, b, l) => {
  if (a >= b) pass(`${l}  (actual=${a.toFixed(3)} ≥ ${b.toFixed(3)})`);
  else fail(l, `actual=${a.toFixed(3)} < ${b.toFixed(3)}`);
};

// ============================================================================
// Helper — synthetic two-source fixture: rectangular room with one
// INTERIOR (low-power CS520) source and one EXTERIOR high-power HS880 horn
// just outside the west wall. The bug being guarded is "exterior source's
// full L_w is added to the interior Hopkins-Stryker aggregate". To MAKE
// that visible we need an exterior source whose L_w (after coupling) is
// comparable to the interior source's L_w — otherwise the bug rides below
// the interior source's own reverberant lift.
//
// Choices:
//   - Walls: gypsum-board (TL ≈ 27 dB @ 1 kHz) — not so opaque the horn's
//     post-coupling contribution disappears in numerical noise, not so
//     transparent the direct path swamps reverb.
//   - Interior source: 20 W cs520 well inside, aimed away from listener so
//     the reverb path dominates the direct path at the listener.
//   - Exterior source: 80 W hs880 just outside the west wall at horn
//     height (the actual azan-horn use case), no mount tag — classifier
//     picks EXTERIOR via geometry.
//   - Room: 6×8×3 m. Listener centred to avoid being near any wall.
//
// Pre-fix: exterior horn's full L_w (~107 dB after DI subtraction) feeds
// the 4/R term → ~3-5 dB lift at the interior listener vs interior-only.
// Post-fix: |C_couple| ~30-40 dB at gypsum → exterior contribution sinks
// below interior source's reverb → both totals converge.
// ============================================================================

function buildFixture() {
  const room = {
    shape: 'rectangular',
    width_m: 6, depth_m: 8, height_m: 3,
    ceiling_type: 'flat',
    surfaces: {
      floor: 'gypsum-board', ceiling: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east:  'gypsum-board', wall_west:  'gypsum-board',
    },
  };
  // Weak interior source, aimed AWAY from the listener — so the listener
  // hears interior mostly through the room's reverberant tail (not the
  // direct path). This maximises the relative impact of a misclassified
  // exterior source on the per-listener SPL.
  const interiorSrc = {
    modelUrl: 'data/loudspeakers/amperes-cs520.json',
    position: { x: 1, y: 1, z: 2 },
    aim: { yaw: 180, pitch: 0, roll: 0 },   // aimed south (away from listener)
    power_watts: 1,                          // weak
  };
  // High-power exterior horn just outside the west wall at horn height
  // (matches the real surau azan horn geometry: 80 W HS880, ~7 m up,
  // pointed away from the building).
  const exteriorSrc = {
    modelUrl: 'data/loudspeakers/amperes-hs880.json',
    position: { x: -2, y: 4, z: 7 },
    aim: { yaw: 270, pitch: -12, roll: 0 },   // points WEST, AWAY from building
    power_watts: 80,
  };
  const listener = { x: 5, y: 7, z: 1.2 };    // far corner, away from both
  const getSpeakerDef = (url) => {
    if (url.includes('cs520')) return cs520;
    if (url.includes('hs880')) return hs880;
    return null;
  };
  // Confirm the classifier agrees the exterior source is in fact EXTERIOR.
  const cls = classifySource(exteriorSrc, room);
  ok(cls.kind === 'EXTERIOR',
     `Fixture sanity: exterior source classified EXTERIOR (got ${cls.kind} via ${cls.reason})`);
  // Confirm the interior source is in fact INTERIOR.
  const clsI = classifySource(interiorSrc, room);
  ok(clsI.kind === 'INTERIOR' || clsI.kind === 'FLUSH_INWARD',
     `Fixture sanity: interior source classified INTERIOR/FLUSH (got ${clsI.kind} via ${clsI.reason})`);
  return { room, interiorSrc, exteriorSrc, listener, getSpeakerDef };
}

// ============================================================================
// Test 1 — Exterior classification suppresses the interior reverberant lift
// that a forced-INTERIOR classification produces at the SAME position.
//
// We use the same physical source twice: once mount-tagged `wall_outer`
// (classifier → EXTERIOR, reverb loop must apply |C_couple| subtraction),
// once mount-tagged `ceiling` (classifier → INTERIOR, full L_w into the
// reverb aggregate). The interior listener should hear MORE total SPL in
// the forced-INTERIOR case if and only if the classifier is feeding the
// reverb-leak loop. Pre-fix: both totals identical (classifier ignored).
// Post-fix: EXTERIOR-classified total measurably lower at an interior
// listener (≥ 1 dB drop for a high-power horn).
//
// We also assert the absolute drop is large enough to be a real signal,
// not noise — at least 1 dB. The HS880 at 80 W against a gypsum (≈27 dB
// TL @ 1 kHz) envelope drops by ~3-5 dB once C_couple kicks in.
// ============================================================================
{
  const { room, interiorSrc, listener, getSpeakerDef } = buildFixture();
  const R = computeRoomConstant(room, materials, 1000, []);
  // Same physical horn position; only mount-tag flips classification.
  const sharedPos = { x: -2, y: 4, z: 7 };
  const sharedAim = { yaw: 270, pitch: -12, roll: 0 };
  const exteriorTagged = {
    modelUrl: 'data/loudspeakers/amperes-hs880.json',
    position: sharedPos, aim: sharedAim, power_watts: 80,
    mount: 'wall_outer',
  };
  const forcedInteriorTagged = {
    modelUrl: 'data/loudspeakers/amperes-hs880.json',
    position: sharedPos, aim: sharedAim, power_watts: 80,
    mount: 'ceiling',     // pins INTERIOR even though geometrically outside
  };
  ok(classifySource(exteriorTagged, room).kind === 'EXTERIOR',
     'T1 setup: mount:wall_outer → EXTERIOR');
  ok(classifySource(forcedInteriorTagged, room).kind === 'INTERIOR',
     'T1 setup: mount:ceiling → INTERIOR (overrides geometry)');
  const splExt = computeMultiSourceSPL({
    sources: [interiorSrc, exteriorTagged], getSpeakerDef,
    listenerPos: listener, freq_hz: 1000,
    room, materials, roomConstantR: R,
  });
  const splForcedInt = computeMultiSourceSPL({
    sources: [interiorSrc, forcedInteriorTagged], getSpeakerDef,
    listenerPos: listener, freq_hz: 1000,
    room, materials, roomConstantR: R,
  });
  const drop = splForcedInt - splExt;
  ok(drop >= 1.0,
    'T1: EXTERIOR-classified horn produces ≥ 1.0 dB LESS interior SPL than the same horn forced INTERIOR',
    `splExt=${splExt.toFixed(2)} dB, splForcedInt=${splForcedInt.toFixed(2)} dB, drop=${drop.toFixed(2)} dB`);
}

// ============================================================================
// Test 2 — Exterior source must not inflate the INDOOR HEATMAP at an
// interior cell.
//
// Same shape as T1 but for the heatmap surface (computeSPLGrid indoor
// mode). T1 validates the per-listener label; T2 validates the
// computeSPLGrid pipeline. They're separate code paths — the heatmap goes
// through precomputeSPLContext + computeMultiSourceSPLFromContext, and
// had to be wired separately. Pre-fix the heatmap cell at this interior
// listener would inflate by ~10 dB when the exterior horn is added.
//
// Compares two heatmaps at the same cell:
//   (a) [interior + EXTERIOR-tagged horn] sources
//   (b) [interior + forced-INTERIOR-tagged horn] sources
// EXTERIOR classification must produce a heatmap reading that is ≥ 1.0 dB
// LESS than the forced-INTERIOR reading at the same cell.
// ============================================================================
{
  const { room, interiorSrc, listener, getSpeakerDef } = buildFixture();
  const sharedPos = { x: -2, y: 4, z: 7 };
  const sharedAim = { yaw: 270, pitch: -12, roll: 0 };
  const exteriorTagged = {
    modelUrl: 'data/loudspeakers/amperes-hs880.json',
    position: sharedPos, aim: sharedAim, power_watts: 80, mount: 'wall_outer',
  };
  const forcedInteriorTagged = {
    modelUrl: 'data/loudspeakers/amperes-hs880.json',
    position: sharedPos, aim: sharedAim, power_watts: 80, mount: 'ceiling',
  };
  const R = computeRoomConstant(room, materials, 1000, []);
  const cellAt = (grid, pos) => {
    const i = Math.floor((pos.x - grid.originX_m) / grid.cellW_m);
    const j = Math.floor((pos.y - grid.originY_m) / grid.cellD_m);
    if (j < 0 || j >= grid.cellsY || i < 0 || i >= grid.cellsX) return -Infinity;
    return grid.grid[j][i];
  };
  const gridExt = computeSPLGrid({
    sources: [interiorSrc, exteriorTagged], getSpeakerDef,
    room, materials, freq_hz: 1000, earHeight_m: 1.2, roomConstantR: R,
  });
  const gridForcedInt = computeSPLGrid({
    sources: [interiorSrc, forcedInteriorTagged], getSpeakerDef,
    room, materials, freq_hz: 1000, earHeight_m: 1.2, roomConstantR: R,
  });
  const splExt = cellAt(gridExt, listener);
  const splForcedInt = cellAt(gridForcedInt, listener);
  const drop = splForcedInt - splExt;
  ok(drop >= 1.0,
    'T2: indoor heatmap cell drops ≥ 1.0 dB when horn is EXTERIOR vs forced-INTERIOR',
    `splExt=${splExt.toFixed(2)} dB, splForcedInt=${splForcedInt.toFixed(2)} dB, drop=${drop.toFixed(2)} dB`);
}

// ============================================================================
// Test 3 — Heatmap cell ↔ per-listener label lockstep.
//
// The per-listener panel calls computeMultiSourceSPL directly; the heatmap
// goes through computeSPLGrid → precomputeSPLContext → ...FromContext. If
// only ONE of the two paths gets the classifier wired, the two surfaces
// will disagree. Pre-fix they "matched by being wrong"; post-fix they must
// match by being right.
//
// Tolerance: 0.2 dB (they share the same physics under the hood — any
// classification mismatch is at least ~3 dB so 0.2 dB easily catches it).
// ============================================================================
{
  const { room, interiorSrc, exteriorSrc, listener, getSpeakerDef } = buildFixture();
  const R = computeRoomConstant(room, materials, 1000, []);
  const sources = [interiorSrc, exteriorSrc];
  const splLabel = computeMultiSourceSPL({
    sources, getSpeakerDef, listenerPos: listener, freq_hz: 1000,
    room, materials, roomConstantR: R,
  });
  const splGrid = computeSPLGrid({
    sources, getSpeakerDef, room, materials, freq_hz: 1000, earHeight_m: 1.2,
    roomConstantR: R,
  });
  const i = Math.floor((listener.x - splGrid.originX_m) / splGrid.cellW_m);
  const j = Math.floor((listener.y - splGrid.originY_m) / splGrid.cellD_m);
  const splCell = splGrid.grid[j][i];
  assertClose(splCell, splLabel, 0.2,
    'T3: heatmap cell agrees with per-listener label at the same point');
}

// ============================================================================
// Test 4 — Panel-results breakdown ↔ label parity.
//
// computeListenerBreakdown has its own reverb loop (spl-calculator.js
// :883-897) that is a SEPARATE bypass surface — it still calls
// approxSoundPowerLevel directly without consulting classifySource.
// If Martina only patches computeMultiSourceSPL, this test stays RED.
//
// Tolerance: 0.2 dB (same path-physics under the hood — any classification
// mismatch is the 3-5 dB bug).
// ============================================================================
{
  const { room, interiorSrc, exteriorSrc, listener, getSpeakerDef } = buildFixture();
  const R = computeRoomConstant(room, materials, 1000, []);
  const sources = [interiorSrc, exteriorSrc];
  const splLabel = computeMultiSourceSPL({
    sources, getSpeakerDef, listenerPos: listener, freq_hz: 1000,
    room, materials, roomConstantR: R,
  });
  const breakdown = computeListenerBreakdown({
    sources, getSpeakerDef, listenerPos: listener, freq_hz: 1000,
    room, materials, roomConstantR: R,
  });
  assertClose(breakdown.total_spl_db, splLabel, 0.2,
    'T4: computeListenerBreakdown.total_spl_db agrees with computeMultiSourceSPL label');
}

// ============================================================================
// Test 5 — STIPA direction at interior listener.
//
// Removing fake reverb at an interior listener cannot HURT intelligibility.
// We construct a 2-source scene (interior + exterior) and compare STI under
// two source classifications:
//   (a) exterior source with mount='wall_outer' → classified EXTERIOR
//   (b) same source position with mount='ceiling' → forced INTERIOR
// Post-fix: (a) ≥ (b) (less false reverb = better STI at this listener).
// Pre-fix: (a) == (b) (classifier ignored by STIPA path; both inflate).
//
// Note: the STIPA path (js/physics/stipa.js) has its OWN
// isSourceInside derivation today (`isInsideRoom3D`, not classifySource).
// If that gets refactored to call classifySource as part of Phase 3 wiring,
// this test will catch a regression where the geometric-fallback path
// produces a DIFFERENT classification than the mount-tag path.
// ============================================================================
{
  const room = {
    shape: 'rectangular',
    width_m: 6, depth_m: 8, height_m: 3,
    ceiling_type: 'flat',
    surfaces: {
      floor: 'concrete-painted', ceiling: 'concrete-painted',
      wall_north: 'concrete-painted', wall_south: 'concrete-painted',
      wall_east:  'concrete-painted', wall_west:  'concrete-painted',
    },
  };
  const interiorSrc = {
    modelUrl: 'data/loudspeakers/amperes-cs520.json',
    position: { x: 3, y: 4, z: 2.5 },
    aim: { yaw: 0, pitch: 0, roll: 0 },
    power_watts: 20,
  };
  // Same position; only the mount tag differs to flip classification.
  const sharedPos = { x: -3, y: 4, z: 2 };
  const sharedAim = { yaw: 90, pitch: 0, roll: 0 };
  const exteriorSrc = {
    modelUrl: 'data/loudspeakers/amperes-cs520.json',
    position: sharedPos, aim: sharedAim, power_watts: 20,
    mount: 'wall_outer',  // pins EXTERIOR
  };
  const forcedInteriorSrc = {
    modelUrl: 'data/loudspeakers/amperes-cs520.json',
    position: sharedPos, aim: sharedAim, power_watts: 20,
    mount: 'ceiling',     // pins INTERIOR even though geometrically outside
  };
  // Sanity-check the classifier agrees with the mount-tag dominance.
  ok(classifySource(exteriorSrc, room).kind === 'EXTERIOR',
     'T5 setup: mount:wall_outer → EXTERIOR');
  ok(classifySource(forcedInteriorSrc, room).kind === 'INTERIOR',
     'T5 setup: mount:ceiling → INTERIOR (overrides geometry)');
  const getSpeakerDef = () => cs520;
  const interiorListener = { x: 3, y: 4, z: 1.2 };
  const stiExterior = computeSTIPA({
    sources: [interiorSrc, exteriorSrc],
    getSpeakerDef, listenerPos: interiorListener,
    room, materials,
  });
  const stiInterior = computeSTIPA({
    sources: [interiorSrc, forcedInteriorSrc],
    getSpeakerDef, listenerPos: interiorListener,
    room, materials,
  });
  // computeSTIPA returns either a scalar or {sti, ...} depending on version.
  const sE = typeof stiExterior === 'number' ? stiExterior : stiExterior?.sti;
  const sI = typeof stiInterior === 'number' ? stiInterior : stiInterior?.sti;
  assertGE(sE, sI - 1e-3,
    'T5: STI with EXTERIOR classification ≥ STI with forced-INTERIOR (removing fake reverb cannot HURT)');
}

// ============================================================================
// Test 6 — Golden surau snapshot.
//
// Mean SPL across all interior cells of the surau preset, computed with the
// fix in place. Captured AFTER Martina's Phase 3 lands; placeholder NaN
// today triggers AUTO-SKIP that PRINTS the actual value so a maintainer can
// paste it in.
//
// Workflow:
//   1. Run the test today → it prints `T6 measurement: actual=XX.X dB` and
//      reports SKIP.
//   2. Once Martina's fix is verified by tests 1-5 → edit the constant.
//   3. Future regressions trip the assertion.
//
// Tolerance: 0.5 dB.
// ============================================================================
// Captured 2026-05-25 after Martina's Phase 3 wiring landed across
// computeMultiSourceSPL, computeListenerBreakdown, AND computeSPLGrid.
// Mean SPL across true prayer-hall cells at z=1.2, 1 kHz, full surau preset
// (4 ceiling + 5 arcade + 1 imam + 4 minaret horns), gypsum ceiling /
// carpet floor / concrete walls. If this drifts > 0.5 dB without an
// intentional physics change, classifier or coupling math has regressed.
const GOLDEN_SURAU_INTERIOR_MEAN_DB = 92.73;
{
  // The surau preset object IS a state-shape room (default export). It
  // carries the rectangular footprint + surauStructure + indoor surfaces.
  // computeSPLGrid in INDOOR mode wants `enclosure` undefined or non-outdoor.
  const room = { ...surauPreset };   // shallow clone is enough — we don't mutate

  const getSpeakerDef = (url) => {
    if (url && url.includes('cs520')) return cs520;
    if (url && url.includes('hs880')) return hs880;
    return null;
  };
  // Skip the test if the loudspeaker resolver doesn't recognise every model
  // in the preset — keeps this test from breaking when new sources land.
  const allRecognised = surauPreset.sources.every(s => getSpeakerDef(s.modelUrl) !== null);
  if (!allRecognised) {
    console.log('SKIP  T6 golden snapshot — at least one preset source has unrecognised modelUrl');
  } else {
    const R = computeRoomConstant(room, materials, 1000, []);
    const grid = computeSPLGrid({
      sources: surauPreset.sources, getSpeakerDef,
      room, materials, freq_hz: 1000, earHeight_m: 1.2,
      roomConstantR: R,
    });
    // Average SPL across cells whose CENTRE is inside the 3D room volume —
    // skips podium / arcade corridor cells that isInsideRoom3D accepts but
    // are physically OUTDOOR per the Phase 7 inset gate.
    let sum = 0, count = 0;
    for (let j = 0; j < grid.cellsY; j++) {
      for (let i = 0; i < grid.cellsX; i++) {
        const v = grid.grid[j][i];
        if (!Number.isFinite(v)) continue;
        const cellX = grid.originX_m + (i + 0.5) * grid.cellW_m;
        const cellY = grid.originY_m + (j + 0.5) * grid.cellD_m;
        // Restrict the mean to TRUE prayer-hall cells (0..W, 0..D) — the
        // grid extends past that to cover the surau podium / arcade, and
        // those cells are physically outdoor.
        if (cellX < 0 || cellX > room.width_m) continue;
        if (cellY < 0 || cellY > room.depth_m) continue;
        if (!isInsideRoom3D({ x: cellX, y: cellY, z: 1.2 }, room)) continue;
        sum += v; count++;
      }
    }
    const actualMean = count > 0 ? sum / count : NaN;
    console.log(`T6 measurement: actual=${actualMean.toFixed(2)} dB (interior cells: ${count})`);
    if (Number.isNaN(GOLDEN_SURAU_INTERIOR_MEAN_DB)) {
      console.log(`SKIP  T6 golden surau interior mean — capture after Phase 3 stabilises (today's value: ${actualMean.toFixed(2)} dB)`);
    } else {
      assertClose(actualMean, GOLDEN_SURAU_INTERIOR_MEAN_DB, 0.5,
        'T6: surau interior-cell mean SPL matches golden snapshot');
    }
  }
}

// ============================================================================
// Exit
// ============================================================================
if (failed > 0) {
  console.log(`\n${failed} exterior-source-classification test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll exterior-source-classification tests passed.');
