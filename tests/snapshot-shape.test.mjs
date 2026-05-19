// Snapshot-shape fixture (Sam, 2026-05-19).
//
// Failure mode this prevents
// --------------------------
// js/physics/scene-snapshot.js's `buildPhysicsScene` returns a frozen
// object with a LITERAL field list. Until commit d302d0d (today), the
// literal silently dropped TWO documented fields — `physics` and `eq` —
// and every production caller masked the drop by using optional chaining:
//
//     scene.physics?.airAbsorption !== false   // default-true when missing
//     scene.eq?.enabled                        // falsy when missing
//
// The drop survived weeks in main because no test asserted the shape
// of the returned object as a contract. Other production fields
// (`triangles`, `bvh` — Phase B placeholders) sit in the same literal
// and would fail the same way if dropped.
//
// This is preset-plumbing-class — same bug shape as
// feedback_preset_plumbing.md (PRESETS field added, applyPresetToState
// not updated, renderer reads undefined and bails silently). Fix here
// is the same: a fixture asserting every documented field EXISTS,
// independent of value, so the next field drop fails the build before
// it ships.
//
// What this asserts
// -----------------
//   1. Every top-level field documented in scene-snapshot.js is `in` the
//      returned object (existence-only, no value pinning — `createdAt`
//      is wall-clock and `version` will bump).
//   2. The snapshot itself + every nested frozen sub-tree is frozen
//      (Object.isFrozen). Catches refactors that swap a frozen literal
//      for a mutable plain object — would break worker-transferable
//      guarantees.
//   3. Empty-state path produces the same shape — no field is "absent
//      because the input was minimal".
//
// What this does NOT assert
// -------------------------
//   Values, lengths, or numerical correctness. Those live in the
//   existing scene-snapshot.test.mjs, which spot-checks materials /
//   sources / receivers / zones content. This fixture is shape-only on
//   purpose — adding value assertions duplicates that coverage and
//   makes the shape contract brittle to legitimate value changes.
//
// Run: node tests/snapshot-shape.test.mjs

import { readFileSync } from 'node:fs';
import { buildPhysicsScene, PHYSICS_SCENE_VERSION } from '../js/physics/scene-snapshot.js';

let failed = 0;
const pass = (l) => console.log(`PASS  ${l}`);
const fail = (l, e = '') => { console.log(`FAIL  ${l}${e ? '  — ' + e : ''}`); failed++; };
const ok = (c, l, e = '') => (c ? pass(l) : fail(l, e));

// --------------------------------------------------------------------
// Load materials (same shape as every other physics test).
// --------------------------------------------------------------------

const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};

// --------------------------------------------------------------------
// Minimal-state fixture — rectangular 6×8 m room, no sources, no
// listeners, no zones, no treatments. Default physics, no EQ.
// We use the bare-bones state to prove every field exists EVEN when
// the input carries no content for it (the `eq` field is the tricky
// one — it can be null but must always be present).
// --------------------------------------------------------------------

function buildMinimalState() {
  return {
    room: {
      shape: 'rectangular',
      width_m: 6, depth_m: 8, height_m: 3,
      ceiling_type: 'flat',
      surfaces: {
        floor: 'gypsum-board', ceiling: 'gypsum-board',
        wall_north: 'gypsum-board', wall_south: 'gypsum-board',
        wall_east: 'gypsum-board', wall_west: 'gypsum-board',
      },
    },
    sources: [],
    listeners: [],
    zones: [],
    treatments: [],
    physics: {},   // empty — eq path must yield null
  };
}

const snap = buildPhysicsScene({
  state: buildMinimalState(),
  materials,
  getLoudspeakerDef: () => null,
});

// --------------------------------------------------------------------
// Top-level shape — every documented field MUST exist on the returned
// object. Order matches the return literal in scene-snapshot.js
// L436-480 so a side-by-side diff with the source is trivial.
// --------------------------------------------------------------------

// version: PHYSICS_SCENE_VERSION integer — workers refuse incompatible snapshots.
ok('version' in snap, "snapshot.version exists (worker-version gate)");
ok(snap.version === PHYSICS_SCENE_VERSION, `snapshot.version === ${PHYSICS_SCENE_VERSION}`);

// createdAt: Date.now() — Martina flagged not to pin a value (cache-key trap).
ok('createdAt' in snap, "snapshot.createdAt exists (cache freshness marker)");

// bands_hz: frozen array of octave-band centre frequencies.
ok('bands_hz' in snap, "snapshot.bands_hz exists (octave-band table)");

// materials: frozen array of resolved material table entries.
ok('materials' in snap, "snapshot.materials exists (flat indexed table)");

// room: frozen object — shape, dimensions, surfaces, structure, enclosures.
ok('room' in snap, "snapshot.room exists (geometry + surface-material map)");

// zones: frozen array — audience zones with pre-blended occupancy.
ok('zones' in snap, "snapshot.zones exists (audience polygons)");

// sources: frozen object — expanded line-array elements as typed arrays.
ok('sources' in snap, "snapshot.sources exists (expanded loudspeaker elements)");

// receivers: frozen object — listeners as volumetric spheres.
ok('receivers' in snap, "snapshot.receivers exists (listener spheres)");

// treatments: frozen array — placed acoustic panels with resolved material indices.
ok('treatments' in snap, "snapshot.treatments exists (placed acoustic panels)");

// physics: frozen object — toggle state at build time.
// THE FIELD THAT WAS DROPPED FOR WEEKS (d302d0d). Optional chaining in
// tracer-core.js:230 (`scene.physics?.airAbsorption !== false`) masked
// the miss because `undefined !== false` is true.
ok('physics' in snap, "snapshot.physics exists (toggle state — DROPPED before d302d0d)");

// eq: frozen object OR null — null when state.physics.eq is absent.
// SECOND DROPPED FIELD. Also masked by `?.` chaining.
ok('eq' in snap, "snapshot.eq exists (master-EQ snapshot — DROPPED before d302d0d)");

// triangles: null placeholder — populated by triangulateScene() later.
// Phase B precision pipeline depends on the key existing for typed
// worker messaging even when not yet built.
ok('triangles' in snap, "snapshot.triangles exists (null placeholder for Phase B)");

// bvh: null placeholder — populated by buildBVH() later. Same reason as triangles.
ok('bvh' in snap, "snapshot.bvh exists (null placeholder for Phase B)");

// --------------------------------------------------------------------
// Field-count guard — any NEW top-level field added to the literal
// triggers a deliberate test update. Keeps the shape contract honest:
// if someone adds a field but forgets to add an `in` assertion above,
// this trips and forces them to document the addition here.
// --------------------------------------------------------------------

const EXPECTED_TOP_LEVEL_KEYS = new Set([
  'version', 'createdAt', 'bands_hz', 'materials', 'room', 'zones',
  'sources', 'receivers', 'treatments', 'physics', 'eq',
  'triangles', 'bvh',
]);
const actualKeys = new Set(Object.keys(snap));
const extraKeys = [...actualKeys].filter(k => !EXPECTED_TOP_LEVEL_KEYS.has(k));
const missingKeys = [...EXPECTED_TOP_LEVEL_KEYS].filter(k => !actualKeys.has(k));
ok(extraKeys.length === 0,
   'no UNDOCUMENTED top-level fields on snapshot',
   extraKeys.length ? `extra: ${extraKeys.join(', ')} — add to EXPECTED_TOP_LEVEL_KEYS + add an "in" assertion above` : '');
ok(missingKeys.length === 0,
   'no MISSING top-level fields (every EXPECTED_TOP_LEVEL_KEYS present)',
   missingKeys.length ? `missing: ${missingKeys.join(', ')} — preset-plumbing-class drop, see file header` : '');

// --------------------------------------------------------------------
// Frozen-ness — the snapshot is meant to be worker-transferable and
// the precision engines treat it as read-only. Anything mutable here
// is a leak waiting to happen.
// --------------------------------------------------------------------

ok(Object.isFrozen(snap),           'snapshot itself is frozen');
ok(Object.isFrozen(snap.room),      'snap.room is frozen');
ok(Object.isFrozen(snap.sources),   'snap.sources is frozen');
ok(Object.isFrozen(snap.receivers), 'snap.receivers is frozen');
ok(Object.isFrozen(snap.zones),     'snap.zones is frozen');
ok(Object.isFrozen(snap.treatments),'snap.treatments is frozen');
ok(Object.isFrozen(snap.materials), 'snap.materials is frozen');
ok(Object.isFrozen(snap.physics),   'snap.physics is frozen');
ok(Object.isFrozen(snap.bands_hz),  'snap.bands_hz is frozen');
ok(Object.isFrozen(snap.room.surfaces),
   'snap.room.surfaces is frozen (surface-material map)');
// room.standaloneEnclosures + room.wallSegments default to frozen empty
// arrays even when state carries nothing; pin that.
ok(Object.isFrozen(snap.room.standaloneEnclosures),
   'snap.room.standaloneEnclosures is frozen (empty-by-default frozen array)');
ok(Object.isFrozen(snap.room.wallSegments),
   'snap.room.wallSegments is frozen (empty-by-default frozen array)');

// eq is null when state.physics has no eq — assert that's a deliberate
// null (not undefined, not missing).
ok(snap.eq === null, 'snap.eq === null when state.physics.eq is absent (empty fixture)');

// --------------------------------------------------------------------
// Mutation guard — try to overwrite a known field; the freeze must
// prevent the write. (TypedArray BUFFERS are not frozen by
// Object.freeze; that limitation is documented in scene-snapshot.test
// already so we don't re-assert here.)
// --------------------------------------------------------------------

try { snap.physics = { malicious: true }; } catch (_) { /* strict */ }
ok(snap.physics && !snap.physics.malicious,
   'snap.physics frozen — cannot be replaced by a poisoned object');

try { snap.eq = { enabled: true, bands: [] }; } catch (_) { /* strict */ }
ok(snap.eq === null, 'snap.eq frozen at null — cannot be replaced post-build');

// --------------------------------------------------------------------
// Report.
// --------------------------------------------------------------------

console.log(failed === 0
  ? '\nAll snapshot-shape tests passed.'
  : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
