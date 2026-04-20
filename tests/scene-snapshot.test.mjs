import { state, applyPresetToState } from '../js/app-state.js';
import { buildPhysicsScene, snapshotsEquivalent, PHYSICS_SCENE_VERSION } from '../js/physics/scene-snapshot.js';
import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function assertClose(actual, expected, tol, label) {
  const diff = Math.abs(actual - expected);
  const good = diff < tol;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${label}  actual=${actual.toFixed(4)} expected=${expected.toFixed(4)}`);
  if (!good) failed++;
}

// --- Load materials + a stub loudspeaker resolver ------------------------
const matJson = JSON.parse(readFileSync('./data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};
const stubSpeaker = {
  acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 12 },
  directivity: { azimuth_deg: [-180, 0, 180], elevation_deg: [-90, 0, 90], attenuation_db: {} },
};
const getDef = () => stubSpeaker;

// --- Apply the arena preset — the stress case ---------------------------
applyPresetToState('auditorium');
const snap = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });

// --- Shape + versioning --------------------------------------------------
ok(snap.version === PHYSICS_SCENE_VERSION, 'Version stamped on the snapshot');
ok(Object.isFrozen(snap), 'Top-level snapshot is frozen');
ok(Object.isFrozen(snap.room), 'room sub-tree is frozen');
ok(Object.isFrozen(snap.sources), 'sources sub-tree is frozen');
ok(Object.isFrozen(snap.receivers), 'receivers sub-tree is frozen');
ok(Object.isFrozen(snap.zones), 'zones array is frozen');

// --- Frequency bands propagated intact ----------------------------------
ok(snap.bands_hz.length === 7, 'bands_hz length = 7 (after 8 kHz addition)');
ok(snap.bands_hz[0] === 125 && snap.bands_hz[6] === 8000, 'bands span 125..8000 Hz');

// --- Materials resolved to flat indexed table ---------------------------
ok(snap.materials.length === materials.list.length, 'materials count matches source');
for (const m of snap.materials) {
  ok(m.absorption instanceof Float32Array, `${m.id} absorption is Float32Array`);
  ok(m.scattering instanceof Float32Array, `${m.id} scattering is Float32Array`);
  ok(m.absorption.length === 7, `${m.id} absorption has 7 bands`);
  ok(m.scattering.length === 7, `${m.id} scattering has 7 bands`);
}
// Spot-check: audience-seated 1 kHz absorption should match source JSON.
const aud = snap.materials.find(m => m.id === 'audience-seated');
assertClose(aud.absorption[3], 0.96, 1e-6, 'audience-seated @1kHz absorption unchanged');
assertClose(aud.scattering[4], 0.85, 1e-6, 'audience-seated @2kHz scattering loaded');

// --- Line-array expansion — arena has 4 compound arrays → 24 elements. --
ok(snap.sources.count === 24, `arena sources expanded to 24 elements (got ${snap.sources.count})`);
ok(snap.sources.positions instanceof Float32Array, 'source positions Float32Array');
ok(snap.sources.positions.length === 24 * 3, 'positions length = 24 × 3');
ok(snap.sources.L_w instanceof Float32Array, 'L_w is Float32Array');
ok(snap.sources.L_w.length === 24 * 7, 'L_w shape = sources × bands');

// L_w sanity: sensitivity 100 + 10·log10(500) + 11 − 12 = 126 dB per element.
const expectedLw = 100 + 10 * Math.log10(500) + 11 - 12;
assertClose(snap.sources.L_w[0], expectedLw, 0.01, 'L_w[0] matches 100 + 27 + 11 − 12');
assertClose(snap.sources.L_w[23 * 7 + 6], expectedLw, 0.01, 'L_w[last, 8kHz] equal — flat-across-bands (P6)');

// --- Receivers (listeners) ----------------------------------------------
ok(snap.receivers.count === state.listeners.length, 'receiver count = listener count');
ok(snap.receivers.radii[0] === 0.5, 'default receiver radius = 0.5 m (ODEON convention)');
// Ear height offset: elevation_m + 1.2 m.
const l0 = state.listeners[0];
assertClose(snap.receivers.positions[2], (l0.elevation_m ?? 0) + 1.2, 1e-6, 'Listener 0 z = elevation + ear height');

// --- Zones: occupancy blend pre-computed --------------------------------
// Lower-bowl zones in arena default to 30 % occupancy with upholstered
// seat empty material. α_eff @1kHz = 0.61·0.7 + 0.96·0.3 = 0.715.
const lbZone = snap.zones.find(z => z.id.startsWith('Z_lb'));
ok(!!lbZone, 'lower-bowl zone present in snapshot');
assertClose(lbZone.occupancy, 0.30, 1e-4, 'lower-bowl occupancy propagated at 30%');
const expectedAlpha1k = 0.61 * 0.7 + 0.96 * 0.3;
assertClose(lbZone.absorption[3], expectedAlpha1k, 0.01, 'lower-bowl α @1kHz blended (upholstered⇌audience × 30%)');

// --- Physics flags snapshot ---------------------------------------------
ok(snap.physics.airAbsorption === true, 'airAbsorption default on');
ok(snap.physics.freq_hz === 1000, 'freq_hz default 1000');
ok(snap.physics.reverberantField === false, 'reverberantField default off');

// --- snapshotsEquivalent (before any state mutation) -------------------
const snap2 = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
ok(snapshotsEquivalent(snap, snap2), 'two snapshots of unchanged state are equivalent');

// --- EQ snapshot deep-cloned (mutate state, snapshot unaffected) --------
state.physics.eq.enabled = true;
state.physics.eq.bands[5].gain_db = 6;
ok(snap.eq.enabled === false, 'snapshot.eq.enabled not affected by later state.* mutation');
ok(snap.eq.bands[5].gain_db === 0, 'snapshot.eq.bands frozen — mutation to state does not bleed');

// Post-mutation snapshot should NOT be equivalent — eq toggle flipped.
const snapAfterEqMut = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
ok(!snapshotsEquivalent(snap, snapAfterEqMut), 'eq.enabled flip breaks equivalence');

// --- Immutability: mutation attempts fail silently (strict mode would
// throw, non-strict returns false). We check the VALUE didn't change. ---
try { snap.bands_hz[0] = 999; } catch (_) { /* strict */ }
ok(snap.bands_hz[0] === 125, 'bands_hz frozen — cannot overwrite entry');
try { snap.sources.positions[0] = 9999; } catch (_) { /* ok */ }
// TypedArrays are NOT frozen by Object.freeze (it only shallow-freezes
// the view object, not the buffer). Document this limitation so callers
// know the physics engines must not mutate these arrays.
ok(snap.sources.positions instanceof Float32Array, 'positions is a TypedArray (caller must not mutate)');

// --- Removing a source breaks equivalence ------------------------------
state.sources.pop();
const snap3 = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
ok(!snapshotsEquivalent(snap, snap3), 'removing a source breaks equivalence');

// --- Pristine empty state: must still produce a valid snapshot ----------
const emptySnap = buildPhysicsScene({
  state: { room: {}, sources: [], listeners: [], zones: [], physics: {} },
  materials,
  getLoudspeakerDef: getDef,
});
ok(emptySnap.sources.count === 0, 'empty state → 0 sources');
ok(emptySnap.receivers.count === 0, 'empty state → 0 receivers');
ok(emptySnap.zones.length === 0, 'empty state → 0 zones');
ok(emptySnap.eq === null, 'empty physics → eq is null');

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll scene-snapshot tests passed.');
