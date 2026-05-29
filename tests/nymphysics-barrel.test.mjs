// Guard test for the nymphysics public API barrel (js/physics/nymphysics.js).
//
// The barrel is a re-export boundary: a future rename of an internal export
// silently drops a symbol from the public surface (ESM re-exports of a
// missing name throw at import; re-exports that resolve to `undefined` slip
// through). This test asserts the barrel imports under Node (no browser dep
// at module-eval) and that a representative public symbol from every tier is
// present with the right type — so the boundary can't quietly erode.
//
// It does NOT re-test physics behaviour (the per-model suites own that). It
// tests engine IDENTITY + re-export integrity only.

import * as nym from '../js/physics/nymphysics.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// 1. Engine identity --------------------------------------------------------
assert(typeof nym.NYMPHYSICS_VERSION === 'string' && nym.NYMPHYSICS_VERSION.length > 0,
  'NYMPHYSICS_VERSION is a non-empty string');
assert(/^\d+\.\d+\.\d+$/.test(nym.NYMPHYSICS_VERSION),
  `NYMPHYSICS_VERSION is semver-shaped (got "${nym.NYMPHYSICS_VERSION}")`);
assert(Array.isArray(nym.NYMPHYSICS_MODES) && nym.NYMPHYSICS_MODES.length === 2,
  'NYMPHYSICS_MODES has two entries');
assert(nym.NYMPHYSICS_MODES.includes('Draft') && nym.NYMPHYSICS_MODES.includes('Precision'),
  'NYMPHYSICS_MODES = Draft + Precision');

assert(typeof nym.engineInfo === 'function', 'engineInfo is a function');
const info = nym.engineInfo();
assert(info && info.name === 'nymphysics', `engineInfo().name === "nymphysics" (got ${info && info.name})`);
assert(info.version === nym.NYMPHYSICS_VERSION, 'engineInfo().version matches NYMPHYSICS_VERSION');
assert(Array.isArray(info.modes) && info.modes.length === 2, 'engineInfo().modes has two entries');
assert(Object.isFrozen(info), 'engineInfo() is frozen (no shared-state mutation)');

// 2. Re-export integrity — one representative symbol per tier --------------
//    [exportName, expectedTypeof]. If any internal rename breaks a re-export,
//    the barrel resolves the name to undefined and the matching row fails.
const TIER_PROBES = [
  // geometry
  ['roomVolume', 'function'],
  ['isInsideRoom3D', 'function'],
  ['wallInsetPolygon', 'function'],
  ['DEFAULT_WALL_THICKNESS_M', 'number'],
  // materials & walls
  ['loadMaterials', 'function'],
  ['massLawTL', 'function'],
  ['doubleLeafTL', 'function'],
  ['computeRw', 'function'],
  ['splitParentVsEnclosure', 'function'],
  // propagation
  ['computeMultiSourceSPL', 'function'],
  ['computeSPLGrid', 'function'],
  ['speedOfSound', 'function'],
  ['airAbsorptionDbPerM', 'function'],
  ['maekawaIL', 'function'],
  // reverberation
  ['sabine', 'function'],
  ['eyring', 'function'],
  ['computeAllBands', 'function'],
  // intelligibility
  ['computeSTIPA', 'function'],
  ['precomputeSTIPAContext', 'function'],
  // sources
  ['loadLoudspeaker', 'function'],
  ['interpolateAttenuation', 'function'],
  ['analyseSpeaker', 'function'],
  // per-listener
  ['computePerListenerMetrics', 'function'],
  // precision
  ['runPrecisionRender', 'function'],
  ['buildPhysicsScene', 'function'],
  ['PHYSICS_SCENE_VERSION', 'number'],
  ['buildBVH', 'function'],
  ['traceRays', 'function'],
  ['triangulateScene', 'function'],
  ['deriveMetrics', 'function'],
  ['calcT30', 'function'],
  ['PrecisionWorkerPool', 'function'], // class → typeof 'function'
  // display & util
  ['dilateGridForDisplay', 'function'],
  ['importDxfFile', 'function'],
  ['furnitureBlocksCylinder', 'function'],
];

for (const [name, kind] of TIER_PROBES) {
  assert(typeof nym[name] === kind, `barrel exports ${name} (${kind})`);
}

// 3. Sanity — the barrel exposes a broad surface, not a stub ---------------
const exportCount = Object.keys(nym).length;
assert(exportCount >= 100, `barrel exposes a broad public surface (${exportCount} exports)`);

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll nymphysics barrel tests passed.');
