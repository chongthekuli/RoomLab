// Golden precision fixture freeze — TREATMENT-SCATTERING (v3) safety net.
//
// Why this exists: PR-2 wires placed treatments into the precision
// tracer (via `triangulateTreatments` in triangulate-scene.js +
// synthetic `treatment:<productId>` materials in scene-snapshot.js).
// Before the integration code lands we freeze the CURRENT (pre-v3)
// precision-engine numbers for three reference scenes:
//
//   1. bare        — 8×10×3 m rectangular room, walls/floor/ceiling
//                    plain materials, no treatments at all.
//   2. absorbers   — same shell, 10 GIK 244 broadband absorbers
//                    (α 0.85–1.00 mid-band, scattering ~0.15).
//                    Absorption-dominant — once v3 ships, the absorber
//                    α already feeds the Sabine path so the precision
//                    numbers should be ESSENTIALLY UNCHANGED (within
//                    ±1 %): rays already saw the wall α via the
//                    overlap math; v3 just lets the absorber surface
//                    show up as its own quad with the same α.
//   3. qrd         — same shell, 10 RPG Skyline (2D QRD) diffusers
//                    on walls. Scattering 0.20–0.90 across bands.
//                    THIS scene is allowed to drift after v3 lands;
//                    the bridge brings actual diffuse scatter into
//                    the tracer where pre-v3 it was specular only.
//
// In pre-v3 (today) all three scenes produce the SAME tracer behaviour
// in practice because triangulate-scene.js never iterates
// state.treatments — every ray bounces specularly off the bare shell.
// After PR-2 ships:
//   • bare        — must still match ±1 % (no treatments, no change).
//   • absorbers   — must still match ±1 % (α already in Sabine path
//                   and now also as own surface; sum is the same).
//   • qrd         — EXPECTED TO DRIFT (this is the whole point of v3).
//                   The companion E2E test in
//                   tests/treatments-precision-v3.test.mjs asserts
//                   the drift lands inside Dr. Chen's accepted band:
//                   ΔC50 ∈ [-1.5, -0.3] dB, ΔSTI ∈ [-0.04, +0.02].
//
// Tolerance: ±1 % per metric per receiver. We capture EDT, T30, C50,
// C80, and STI (broadband for ETC metrics, full STI from the band
// IR). Tighter than ±0.5 % (the Sabine fixture) because the tracer is
// stochastic — ±1 % with a fixed seed/ray-count is achievable but
// leaves headroom for FP determinism quirks across Node versions.
//
// Regenerate: node tests/golden-precision-pre-v3.test.mjs --update
// IMPORTANT: only regenerate AFTER PR-2 lands AND Dr. Chen has signed
// off on the QRD drift. The bare + absorber numbers must NOT drift
// across the v3 boundary.

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

if (updateMode) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(live, null, 2) + '\n', 'utf8');
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
compareScene('qrd');

console.log('');
console.log(failed === 0 ? '\nAll fixture comparisons passed.' : `\n${failed} fixture comparisons FAILED.`);
process.exit(failed === 0 ? 0 : 1);
