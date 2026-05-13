// Golden precision fixture — POST-v3 regression net.
//
// History
// -------
// This file was created pre-v3 to freeze the precision-engine numbers
// for three reference scenes before the treatment-scattering bridge
// landed. The bridge (PR-2) wires placed treatments into the
// precision tracer via `triangulateTreatments` in triangulate-scene.js
// + synthetic `treatment:<productId>` materials in scene-snapshot.js.
//
// Before PR-2, the precision tracer ignored state.treatments entirely:
// every ray bounced specularly off the bare shell. As a result, the
// "absorbers" scene's pre-v3 numbers were wrong by construction — the
// tracer never saw the broadband-absorber α at all, so its IR matched
// the bare shell. After v3 ships, the absorber scene drops T30 by
// ~16 % and EDT by ~38 %, which is the correct physics.
//
// What the fixture holds NOW (post-v3 PR3)
// ----------------------------------------
//   bare       — pre-v3 baseline. No treatments, so pre/post v3 must
//                match. Used as a tracer-determinism regression test;
//                catches FP drift across Node versions.
//   absorbers  — POST-v3 ground truth, locked at PR3 ship. Going
//                forward this is the regression target; if it drifts
//                beyond ±1 % the precision engine has a bug.
//   qrd        — PRE-v3 reference for the v3 acceptance gate. Held
//                frozen so the Δ baseline in
//                tests/treatments-precision-v3.test.mjs is stable.
//                NOT compared by this test (drift is the whole point
//                of v3); the acceptance gate owns that scene.
//
// Tolerance: ±1 % per metric per receiver. We capture EDT, T30, C50,
// C80, and STI (broadband for ETC metrics, full STI from the band
// IR). Tighter than ±0.5 % (the Sabine fixture) because the tracer is
// stochastic — ±1 % with a fixed seed/ray-count is achievable but
// leaves headroom for FP determinism quirks across Node versions.
//
// Regenerate: node tests/golden-precision-pre-v3.test.mjs --update
// IMPORTANT: regenerating the absorber baseline locks in whatever the
// tracer currently produces. Only regenerate after a deliberate
// physics change Dr. Chen has signed off on.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPhysicsScene } from '../js/physics/scene-snapshot.js';
import { triangulateScene } from '../js/physics/precision/triangulate-scene.js';
import { buildBVH } from '../js/physics/precision/bvh.js';
import { traceRays } from '../js/physics/precision/tracer-core.js';
import { deriveMetrics } from '../js/physics/precision/derive-metrics.js';
import { makeTreatmentEntry } from '../js/ui/panel-treatments.js';
import {
  _setCachedCatalogueForTests,
  _clearCachedCatalogueForTests,
} from '../js/labs/surfacelab/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'golden-precision-pre-v3.json');

// ±1 % relative tolerance per metric — Hannes' v3 spec.
const REL_TOL = 0.01;

const updateMode = process.argv.includes('--update');

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// ---- Stubs + fixtures -----------------------------------------------------

const matJson = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: matJson.frequency_bands_hz,
  list: matJson.materials,
  byId: Object.fromEntries(matJson.materials.map(m => [m.id, m])),
};
const productJson = JSON.parse(readFileSync('data/treatment-products.json', 'utf8'));
const QRD_SPEC = productJson.products.find(p => p.id === 'rpg-skyline-2d');
const ABS_SPEC = productJson.products.find(p => p.id === 'gik-244');
if (!QRD_SPEC || !ABS_SPEC) {
  console.log('FAIL  required catalogue products missing from data/treatment-products.json.');
  process.exit(1);
}

// Pre-seed the SurfaceLAB catalogue cache so `getTreatmentAbsorption`
// works without a fetch round-trip. Critical: the catalogue is
// consulted at SCENE-BUILD time (PR-2 reads scattering coefficients
// out of it for the synthetic `treatment:*` materials), so a cold
// cache would silently strip the scattering coef in the v3 path.
_setCachedCatalogueForTests({
  all: [QRD_SPEC, ABS_SPEC],
  groups: [],
});

const stubSpeaker = {
  acoustic: { sensitivity_db_1w_1m: 100, directivity_index_db: 3 },
};
const getDef = () => stubSpeaker;

// 8×10×3 m room — moderately reverberant (gypsum walls + concrete
// floor + plaster ceiling). One omni source + one off-axis listener
// give meaningful C50 / C80 / STI variance.
const ROOM_W = 8, ROOM_D = 10, ROOM_H = 3;

function makeBaseState(treatments) {
  return {
    room: {
      shape: 'rectangular',
      width_m: ROOM_W, depth_m: ROOM_D, height_m: ROOM_H,
      surfaces: {
        floor: 'concrete-painted',
        ceiling: 'gypsum-board',
        wall_north: 'gypsum-board',
        wall_south: 'gypsum-board',
        wall_east: 'gypsum-board',
        wall_west: 'gypsum-board',
      },
    },
    zones: [],
    sources: [{
      modelUrl: 'stub',
      position: { x: 4, y: 2, z: 1.5 },
      aim: { yaw: 0, pitch: 0 },
      power_watts: 1,
    }],
    listeners: [{
      id: 'L1', label: 'Rec',
      position: { x: 5.5, y: 7.5 },
      elevation_m: 0.0,                       // ear height 1.2 added by snapshot
      receiver_radius_m: 0.5,
    }],
    treatments,
    physics: { airAbsorption: true },
  };
}

// Distribute 10 panels around the perimeter — 3 on north/south (long
// walls), 2 on east/west (short walls). Position them mid-height,
// spaced apart so they don't all sit on top of each other.
function tenPanelsOf(spec) {
  const panels = [];
  // wall_north (idx 0) — y=depth, x along
  for (let i = 0; i < 3; i++) {
    const x = 1.5 + i * 2.5;
    panels.push(makeTreatmentEntry(spec, { surface: 'wall', wallIndex: 0 }, { x, y: ROOM_D, z: 1.5 }, 0));
  }
  // wall_south (idx 1) — y=0
  for (let i = 0; i < 3; i++) {
    const x = 1.5 + i * 2.5;
    panels.push(makeTreatmentEntry(spec, { surface: 'wall', wallIndex: 1 }, { x, y: 0, z: 1.5 }, 0));
  }
  // wall_east (idx 2) — x=width
  for (let i = 0; i < 2; i++) {
    const y = 2.5 + i * 3.5;
    panels.push(makeTreatmentEntry(spec, { surface: 'wall', wallIndex: 2 }, { x: ROOM_W, y, z: 1.5 }, 0));
  }
  // wall_west (idx 3) — x=0
  for (let i = 0; i < 2; i++) {
    const y = 2.5 + i * 3.5;
    panels.push(makeTreatmentEntry(spec, { surface: 'wall', wallIndex: 3 }, { x: 0, y, z: 1.5 }, 0));
  }
  return panels;
}

// Run the tracer end-to-end and pull the broadband metrics + STI for
// the first (and only) receiver. Fixed seed + ray count keeps the
// captured numbers reproducible across Node versions to a few parts
// per thousand; the ±1 % tolerance absorbs any residual FP drift.
function precisionSnapshot(state) {
  const scene = buildPhysicsScene({ state, materials, getLoudspeakerDef: getDef });
  const soup = triangulateScene(scene);
  const bvh = buildBVH(soup);
  const result = traceRays(scene, bvh, {
    raysPerSource: 10000,
    maxBounces: 60,
    bucketDtMs: 2,
    maxTimeMs: 1500,
    seed: 4242,
  });
  result.scene = scene;   // deriveMetrics reads result.scene for D/R direct-arrival
  const metrics = deriveMetrics(result, {});
  const m = metrics[0];
  return {
    edt_s: round4(m.broadband.edt_s),
    t30_s: round4(m.broadband.t30_s),
    c50_db: round3(m.broadband.c50_db),
    c80_db: round3(m.broadband.c80_db),
    sti: round3(m.sti.sti),
  };
}

function round3(v) { return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null; }
function round4(v) { return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null; }

// ---- Capture the three scenes --------------------------------------------

const live = {
  bare:      precisionSnapshot(makeBaseState([])),
  absorbers: precisionSnapshot(makeBaseState(tenPanelsOf(ABS_SPEC))),
  qrd:       precisionSnapshot(makeBaseState(tenPanelsOf(QRD_SPEC))),
};

_clearCachedCatalogueForTests();

// ---- Update mode: write the fixture --------------------------------------
//
// Update mode regenerates the BARE and ABSORBERS rows only. The QRD
// row is the pre-v3 acceptance-gate reference and is preserved
// verbatim from the existing fixture. If the file is missing
// entirely, the QRD row is written from the current tracer output
// (cold-start case) and the operator is expected to swap it back to
// a pre-v3 capture before committing.

if (updateMode) {
  const existing = existsSync(FIXTURE_PATH)
    ? JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    : {};
  const out = {
    _schema: {
      version: 'v3-post',
      bare:      'pre-v3 baseline (no treatments — identical pre/post v3, used as a tracer-determinism regression)',
      absorbers: 'post-v3 ground truth (pre-v3 was wrong by construction — tracer ignored treatment absorption entirely; v3 wires treatment α into the precision engine)',
      qrd:       'pre-v3 reference for v3 acceptance gate in tests/treatments-precision-v3.test.mjs (Δ = live − this; window ΔC50 ∈ [-1.5, -0.3] dB, ΔSTI ∈ [-0.04, +0.02])',
    },
    bare:      live.bare,
    absorbers: { _origin: 'post-v3 ground truth — locked in at PR3 ship', ...live.absorbers },
    qrd: existing.qrd
      ? existing.qrd
      : { _origin: 'cold-start capture — replace with pre-v3 reference before committing', ...live.qrd },
  };
  writeFileSync(FIXTURE_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${FIXTURE_PATH}`);
  process.exit(0);
}

// ---- Read mode: compare against frozen fixture ---------------------------

if (!existsSync(FIXTURE_PATH)) {
  console.log(`FAIL  fixture missing: ${FIXTURE_PATH}`);
  console.log(`      regenerate with: node tests/golden-precision-pre-v3.test.mjs --update`);
  process.exit(1);
}

const frozen = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

function compareScene(name) {
  const f = frozen[name];
  const v = live[name];
  if (!f) {
    console.log(`FAIL  ${name}: scene missing from fixture`);
    failed++;
    return;
  }
  for (const key of Object.keys(f)) {
    // Skip metadata keys (anything starting with `_`, e.g. `_origin`).
    if (key.startsWith('_')) continue;
    const a = v[key], b = f[key];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      ok(a === b, `${name}.${key}: both null`);
      continue;
    }
    const denom = Math.abs(b) > 1e-6 ? Math.abs(b) : 1;
    const rel = Math.abs(a - b) / denom;
    const good = rel <= REL_TOL;
    console.log(`${good ? 'PASS' : 'FAIL'}  ${name}.${key} live=${a} frozen=${b} rel=${(rel * 100).toFixed(2)}%`);
    if (!good) failed++;
  }
}

compareScene('bare');
compareScene('absorbers');
// 'qrd' scene is intentionally NOT compared here. The frozen qrd
// values are the PRE-v3 baseline held as the Δ reference for the v3
// acceptance gate (tests/treatments-precision-v3.test.mjs Test 4).
// Drift on this scene is expected and validated there, not here.
console.log(`INFO  qrd scene skipped — owned by tests/treatments-precision-v3.test.mjs (v3 acceptance gate)`);

console.log('');
console.log(failed === 0 ? '\nAll fixture comparisons passed.' : `\n${failed} fixture comparisons FAILED.`);
process.exit(failed === 0 ? 0 : 1);
