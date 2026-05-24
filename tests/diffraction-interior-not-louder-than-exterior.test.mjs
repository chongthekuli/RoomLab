// Regression: listener INSIDE a closed building must NOT read louder
// than a listener OUTSIDE in the adjacent corridor under an arcade
// roof. The pre-fix bug (user-reported 2026-05-24): listener at
// (1, 14, 1.7) just inside the west wall read 89 dB while a listener
// at (-1.5, 9, 1.7) under the west arcade read 84 dB — INVERSION.
//
// Two compounding causes:
//   (a) Maekawa over the BUILDING WALL TOP edge has near-zero IL for
//       listeners just past the wall (shallow shadow → knife-edge
//       formula returns ~3-5 dB, ignoring the wall's thickness and
//       mass).
//   (b) The arcade roof's INNER perimeter edge sits on the SAME
//       physical eave line as the building wall's top edge, so the
//       diffraction module counted the bypass path TWICE.
//
// Fix (v=647):
//   - TOP_EDGE_IL_FLOOR_DB = 16 dB on parent_wall_* top edges (was 10).
//   - enumerateRoofPerimeterEdges skips the inner edge whose endpoints
//     coincide with the building wall corresponding to refl.side.
//   - TOP_EDGE_IL_FLOOR_DB also applied to arcade/portico roof
//     perimeter edges (they're thick-concrete in real construction).

import { readFileSync } from 'node:fs';

globalThis.localStorage = (() => {
  const _s = { PHYSICS_P1_5: '1' };
  return {
    getItem: (k) => _s[k] ?? null,
    setItem: (k, v) => { _s[k] = String(v); },
    removeItem: (k) => { delete _s[k]; },
  };
})();

const { computeMultiSourceSPL, computeRoomConstant } = await import('../js/physics/spl-calculator.js');

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

const speaker = {
  acoustic: { sensitivity_db_1w_1m: 92, directivity_index_db: 8 },
  directivity: {
    azimuth_deg: [-180, -90, 0, 90, 180],
    elevation_deg: [-90, 0, 90],
    attenuation_db: {
      '1000': [[-15,-10,-6,-10,-15],[-6,-3,0,-3,-6],[-15,-10,-6,-10,-15]],
    },
  },
};

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// =============================================================================
// (A) Source-grep: dedup of arcade-roof INNER edge present
// =============================================================================
const diffSrc = readFileSync('./js/physics/diffraction.js', 'utf8');
check('(A) enumerateRoofPerimeterEdges takes a room arg (for inner-edge dedup)',
  /function enumerateRoofPerimeterEdges\s*\(\s*refl\s*,\s*room\s*\)/.test(diffSrc));
check('(A) inner-edge dedupe: skipAxis/skipValue logic present',
  /skipAxis\s*=\s*['"](x|y)['"]/.test(diffSrc));
check('(A) TOP_EDGE_IL_FLOOR_DB = 16 dB (raised from 10)',
  /TOP_EDGE_IL_FLOOR_DB\s*=\s*16\.0/.test(diffSrc));

// =============================================================================
// (B) End-to-end: surau-style geometry with all-concrete walls + arcade.
//     Listener just INSIDE west wall must NOT read significantly higher
//     than listener just OUTSIDE under west arcade.
// =============================================================================
{
  const room = {
    shape: 'rectangular', width_m: 18, height_m: 4.5, depth_m: 17.7,
    surfaces: {
      floor: 'carpet-heavy-underlay', ceiling: 'concrete-painted',
      wall_north: 'concrete-painted', wall_south: 'concrete-painted',
      wall_east: 'concrete-painted', wall_west: 'concrete-painted',
    },
    surauStructure: {
      arcade: { sides: ['south','east','west'], depth_m: 3, roof_height_m: 4.4 },
      materials: { arcade_roof: 'concrete-painted', podium_top: 'concrete-painted' },
      podium: { extension_m: 3 },
    },
  };
  // 4 azan horns at minaret (NW corner OUTSIDE building per surau preset).
  const horns = [
    { modelUrl: 'x', position: { x: -1.2, y: 19.9, z: 7 }, aim: { yaw: 0,   pitch: -12 }, power_watts: 80 },
    { modelUrl: 'x', position: { x: -0.2, y: 18.9, z: 7 }, aim: { yaw: 90,  pitch: -12 }, power_watts: 80 },
    { modelUrl: 'x', position: { x: -1.2, y: 17.9, z: 7 }, aim: { yaw: 180, pitch: -12 }, power_watts: 80 },
    { modelUrl: 'x', position: { x: -2.2, y: 18.9, z: 7 }, aim: { yaw: 270, pitch: -12 }, power_watts: 80 },
  ];
  const R = computeRoomConstant(room, materials, 1000, []);
  const splAt = (pos) => computeMultiSourceSPL({
    sources: horns, getSpeakerDef: () => speaker, listenerPos: pos,
    freq_hz: 1000, room, materials, roomConstantR: R,
  });
  const insideNearWestWall = splAt({ x: 1,    y: 14, z: 1.7 });
  const outsideUnderWestArcade = splAt({ x: -1.5, y: 9,  z: 1.7 });
  // Inside must not exceed outside by more than 1 dB. The two cells
  // share the same dominant bypass path (eave diffraction); they should
  // read approximately equal. Pre-fix it was inverted by ~5 dB.
  check('(B) inside-near-west-wall ≤ outside-under-arcade + 1 dB (no inversion)',
    insideNearWestWall <= outsideUnderWestArcade + 1.0,
    `inside=${insideNearWestWall.toFixed(1)}, outside=${outsideUnderWestArcade.toFixed(1)}, Δ=${(insideNearWestWall - outsideUnderWestArcade).toFixed(1)} dB`);
  // Sanity: both cells should be in a similar range (~75-90 dB), neither
  // collapsed to silence by an over-aggressive floor.
  check('(B) inside cell stays above 60 dB (eave diffraction still meaningful)',
    insideNearWestWall > 60, `inside=${insideNearWestWall.toFixed(1)}`);
  check('(B) outside cell stays above 60 dB (porch lift + diffraction)',
    outsideUnderWestArcade > 60, `outside=${outsideUnderWestArcade.toFixed(1)}`);
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${failed === 0 ? 'all checks passed' : failed + ' failed'}`);
if (failed > 0) process.exit(1);
