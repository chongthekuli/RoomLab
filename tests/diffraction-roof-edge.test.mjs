// Phase 8 Step 5 (real) — roof-eave diffraction over arcade / portico
// roofs.
//
// Dr. Chen's roadmap: "currently only side walls produce Tier 1a edges;
// a low canopy edge can become the dominant diffractor in close-in
// shadows." For paths that cross an arcade or portico roof (e.g. the
// surau azan horn at z=7 firing toward a listener under the arcade
// roof at z=4.4), the roof's outer perimeter edge provides an
// alternative bypass path — sound bending around the open side of the
// arcade instead of transmitting through the roof.
//
// The wallsCrossedByPath pipeline (since Phase 8 Step 1) already adds
// arcade / portico roofs as horizontal transmissive surfaces with
// wallId pattern `${kind}_${side}_ceiling`. This step extends the
// diffraction module: it now ALSO enumerates the 4 perimeter edges of
// each such roof and computes Maekawa diffraction over each. Edges
// are added on top of existing wall-side diffractions (de-duplication
// via edgeKey still catches shared edges if any).

import { readFileSync } from 'node:fs';

globalThis.localStorage = (() => {
  const _s = { PHYSICS_P1_5: '1' };
  return {
    getItem: (k) => _s[k] ?? null,
    setItem: (k, v) => { _s[k] = String(v); },
    removeItem: (k) => { delete _s[k]; },
  };
})();

const { computeDiffractionContributions } = await import('../js/physics/diffraction.js');
const { wallsCrossedByPath } = await import('../js/physics/wall-path.js');

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// Synthetic surau-like geometry: rectangular building + arcade on west side.
const room = {
  shape: 'rectangular', width_m: 18, height_m: 4.5, depth_m: 17.7,
  enclosure: 'outdoor',
  surfaces: {
    floor: 'concrete-painted', ceiling: 'concrete-painted',
    wall_north: 'concrete-painted', wall_south: 'concrete-painted',
    wall_east: 'concrete-painted', wall_west: 'concrete-painted',
  },
  surauStructure: {
    arcade: { sides: ['west'], depth_m: 3, roof_height_m: 4.4 },
    materials: { arcade_roof: 'concrete-painted', podium_top: 'concrete-painted' },
    podium: { extension_m: 3 },
  },
};

// =============================================================================
// (A) Source above the arcade roof; listener under the arcade. Path crosses
//     the arcade roof. wallsCrossedByPath should now include the roof
//     crossing, AND the diffraction module should enumerate its
//     perimeter edges.
// =============================================================================
{
  // Source positioned directly above the arcade (x=-1.5, y=5, z=6 — above
  // the 4.4 m roof). Listener at (-1.5, 5, 1.7) directly under it.
  const src = { position: { x: -1.5, y: 5, z: 6 } };
  const listener = { x: -1.5, y: 5, z: 1.7 };
  const wallsCrossed = wallsCrossedByPath(src.position, listener, room);
  const hasRoofCrossing = wallsCrossed.some(c => c.wallId.startsWith('arcade_roof_'));
  check('(A) wallsCrossedByPath includes the arcade roof when source is above + listener below',
    hasRoofCrossing, `crossings: ${wallsCrossed.map(c => c.wallId).join(', ')}`);

  const result = computeDiffractionContributions({
    src, listener, room, wallsCrossed, materials, freq_hz: 1000,
    sourceLpFreeField_db: 90, temperature_C: 20, airAbsorption: true,
    groundG: 0, groundPlaneZ: 0, enable: true,
  });
  const roofPaths = result.paths.filter(p => p.wallId.startsWith('arcade_roof_'));
  check('(A) diffraction now enumerates roof-edge paths (was: skipped entirely)',
    roofPaths.length >= 1, `${roofPaths.length} roof-edge paths emitted`);
  check('(A) at least one roof-edge path has finite SPL contribution',
    roofPaths.some(p => Number.isFinite(p.spl_db)));
}

// =============================================================================
// (B) Roof-perimeter edges are 4 per arcade (1 along each side of the
//     polygon). Verified by counting paths with edgeId starting with
//     `roof_perim_`.
// =============================================================================
{
  const src = { position: { x: -1.5, y: 5, z: 6 } };
  const listener = { x: -1.5, y: 5, z: 1.7 };
  const wallsCrossed = wallsCrossedByPath(src.position, listener, room);
  const result = computeDiffractionContributions({
    src, listener, room, wallsCrossed, materials, freq_hz: 1000,
    sourceLpFreeField_db: 90, temperature_C: 20, airAbsorption: true,
    groundG: 0, groundPlaneZ: 0, enable: true,
  });
  // Some edges may early-return on lit-zone or zero-IL; we expect AT
  // MOST 4 unique roof-perim edges per arcade.
  const uniqueRoofEdges = new Set(result.paths
    .filter(p => p.wallId.startsWith('arcade_roof_'))
    .map(p => p.edgeId));
  check('(B) up to 4 unique roof perimeter edge ids enumerated',
    uniqueRoofEdges.size > 0 && uniqueRoofEdges.size <= 4,
    `unique edgeIds: ${[...uniqueRoofEdges].join(', ')}`);
}

// =============================================================================
// (C) Source at typical PA height BELOW the arcade roof — no roof
//     crossing — no roof-edge diffraction (the path stays inside the
//     porch space; transmission isn't the mechanism here).
// =============================================================================
{
  const src = { position: { x: -2, y: 5, z: 2.5 } };  // below roof, outside arcade
  const listener = { x: -1.5, y: 5, z: 1.7 };
  const wallsCrossed = wallsCrossedByPath(src.position, listener, room);
  const hasRoof = wallsCrossed.some(c => c.wallId.startsWith('arcade_roof_'));
  check('(C) path stays below arcade roof → no roof crossing in wallsCrossedByPath',
    !hasRoof, `crossings: ${wallsCrossed.map(c => c.wallId).join(', ')}`);
}

// =============================================================================
// (D) Plain room (no surauStructure) → no roof edges, no regression
//     in pre-Step-5 behaviour.
// =============================================================================
{
  const plainRoom = {
    shape: 'rectangular', width_m: 10, height_m: 4.5, depth_m: 10,
    enclosure: 'outdoor',
    surfaces: {
      floor: 'concrete-painted', ceiling: 'concrete-painted',
      wall_north: 'concrete-painted', wall_south: 'concrete-painted',
      wall_east: 'concrete-painted', wall_west: 'concrete-painted',
    },
  };
  const src = { position: { x: 5, y: 5, z: 6 } };
  const listener = { x: 5, y: 12, z: 1.7 };
  const wallsCrossed = wallsCrossedByPath(src.position, listener, plainRoom);
  const hasRoof = wallsCrossed.some(c => c.wallId.startsWith('arcade_roof_'));
  check('(D) plain room (no surauStructure) → no arcade roof crossings',
    !hasRoof);
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${failed === 0 ? 'all checks passed' : failed + ' failed'}`);
if (failed > 0) process.exit(1);
