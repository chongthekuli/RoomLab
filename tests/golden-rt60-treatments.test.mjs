// Golden RT60 fixture freeze — TREATMENT-INTEGRATION safety net.
//
// Why this exists: PR-2 wires acoustic treatments into
// `roomEffectiveSurfaces()` so the v2 RT60 will react to placed panels.
// Without a captured "today's v1 numbers" snapshot we'd merge the
// integration code with no way to assert that a scene WITHOUT panels
// still renders the same Sabine/Eyring numbers it did before (i.e.
// the integration is additive, not a stealth refactor).
//
// Three scenes:
//   1. empty       — 6×8×3 m rectangular room, no treatments, no zones.
//   2. one-panel   — same room, 1 Primacoustic Broadway 50 mm
//                    glass-wool absorber on wall_north.
//   3. three-panels — same room, 3 Broadway panels spread across
//                    three walls.
//
// In v1 (visual-only treatments) all THREE produce identical numbers
// because the engine never reads state.treatments. After PR-2 ships
// the integration:
//   * "empty" should stay byte-identical (tolerance ±0.5 %).
//   * "one-panel" should drop noticeably at 500/1k/2k Hz (Broadway α
//     ≈1.15 vs gypsum α≈0.04 → big Sabine boost).
//   * "three-panels" should drop further.
// At that point regenerate the fixture with `--update` and have Dr.
// Chen review the diff in the same PR (Theo's regression rule).
//
// Tolerance: ±0.5 % per band on Sabine/Eyring (=Hannes' v2 spec).
//
// Regenerate: node tests/golden-rt60-treatments.test.mjs --update

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { state, applyBlankCustomRoom } from '../js/app-state.js';
import { computeAllBands } from '../js/physics/rt60.js';
import { makeTreatmentEntry } from '../js/ui/panel-treatments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'golden-rt60-treatments.json');

// ±0.5 % relative tolerance per band — spec from Hannes' PR-1 brief.
const REL_TOL = 0.005;

const updateMode = process.argv.includes('--update');

const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};

// Catalogue spec for the Primacoustic Broadway panel — read straight
// from data so any α tweak in the JSON is reflected in the fixture
// snapshot the next time we regenerate.
const products = JSON.parse(readFileSync('data/treatment-products.json', 'utf8'));
const BROADWAY_SPEC = products.products.find(p => p.id === 'primacoustic-broadway');
if (!BROADWAY_SPEC) {
  console.log('FAIL  primacoustic-broadway missing from data/treatment-products.json — fixture cannot be authored.');
  process.exit(1);
}

function freshScene() {
  applyBlankCustomRoom();
  state.room.shape = 'rectangular';
  state.room.width_m = 6;
  state.room.depth_m = 8;
  state.room.height_m = 3;
  state.room.custom_vertices = null;
  state.room.surfaces = {
    floor: 'wood-floor',
    ceiling: 'gypsum-board',
    wall_north: 'gypsum-board',
    wall_south: 'gypsum-board',
    wall_east: 'gypsum-board',
    wall_west: 'gypsum-board',
  };
  state.zones = [];
  state.treatments = [];
  state.selectedTreatmentId = null;
}

function snapshot() {
  const bands = computeAllBands({ room: state.room, materials, zones: state.zones });
  return {
    volume_m3: Math.round(bands[0].volume_m3 * 100) / 100,
    totalArea_m2: Math.round(bands[0].totalArea_m2 * 100) / 100,
    sabine_s: bands.map(b => Math.round(b.sabine_s * 1000) / 1000),
    eyring_s: bands.map(b => Math.round(b.eyring_s * 1000) / 1000),
    meanAbsorption: bands.map(b => Math.round(b.meanAbsorption * 10000) / 10000),
  };
}

// ---- Scene 1: empty -------------------------------------------------------
freshScene();
const sceneEmpty = snapshot();

// ---- Scene 2: one panel on wall_north -------------------------------------
freshScene();
state.treatments = [
  makeTreatmentEntry(
    BROADWAY_SPEC,
    { surface: 'wall', wallIndex: 0 },  // 0 = north (rectangular wall index convention)
    { x: 3, y: 0, z: 1.5 },
    0,
  ),
];
const sceneOnePanel = snapshot();

// ---- Scene 3: three panels (north, east, south) ---------------------------
freshScene();
state.treatments = [
  makeTreatmentEntry(BROADWAY_SPEC, { surface: 'wall', wallIndex: 0 }, { x: 3, y: 0, z: 1.5 }, 0),
  makeTreatmentEntry(BROADWAY_SPEC, { surface: 'wall', wallIndex: 1 }, { x: 6, y: 4, z: 1.5 }, 0),
  makeTreatmentEntry(BROADWAY_SPEC, { surface: 'wall', wallIndex: 2 }, { x: 3, y: 8, z: 1.5 }, 0),
];
const sceneThreePanels = snapshot();

const live = {
  empty: sceneEmpty,
  'one-panel': sceneOnePanel,
  'three-panels': sceneThreePanels,
};

if (updateMode) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(live, null, 2) + '\n');
  console.log(`Treatments RT60 snapshot regenerated → ${FIXTURE_PATH}`);
  console.log('\nReview the diff with `git diff tests/fixtures/golden-rt60-treatments.json`.');
  console.log('Have Dr. Chen sign off in the PR description before commit.');
  process.exit(0);
}

if (!existsSync(FIXTURE_PATH)) {
  console.log(`FAIL — fixture missing at ${FIXTURE_PATH}.`);
  console.log('Run `node tests/golden-rt60-treatments.test.mjs --update` to capture current numbers.');
  process.exit(1);
}

const golden = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

function band(i) {
  return materials.frequency_bands_hz[i] >= 1000
    ? `${materials.frequency_bands_hz[i] / 1000}k`
    : `${materials.frequency_bands_hz[i]}`;
}

// Relative-tolerance compare: |a − b| ≤ REL_TOL · |b|, with a tiny abs
// floor so 0.0-vs-0.001 doesn't fail on rounding noise.
function withinRelTol(a, b) {
  return Math.abs(a - b) <= Math.max(REL_TOL * Math.abs(b), 0.005);
}

for (const sceneKey of ['empty', 'one-panel', 'three-panels']) {
  const a = live[sceneKey], b = golden[sceneKey];
  if (!b) {
    console.log(`FAIL  ${sceneKey}: no golden entry — run with --update if this scene is new`);
    failed++;
    continue;
  }
  // Geometry-derived totals — these should NEVER drift unless we change
  // the fixture's room dimensions. They guard against an accidental
  // rectangle-vs-custom shape regression in applyBlankCustomRoom().
  if (Math.abs(a.volume_m3 - b.volume_m3) > 0.5) {
    console.log(`FAIL  ${sceneKey}: volume drift ${b.volume_m3} → ${a.volume_m3} m³`);
    failed++;
  }
  if (Math.abs(a.totalArea_m2 - b.totalArea_m2) > 1.0) {
    console.log(`FAIL  ${sceneKey}: total area drift ${b.totalArea_m2} → ${a.totalArea_m2} m²`);
    failed++;
  }
  let bandFails = 0;
  for (let i = 0; i < a.sabine_s.length; i++) {
    if (!withinRelTol(a.sabine_s[i], b.sabine_s[i])) {
      console.log(`FAIL  ${sceneKey} @ ${band(i)}Hz: Sabine drift ${b.sabine_s[i]} → ${a.sabine_s[i]} s (Δ ${(a.sabine_s[i] - b.sabine_s[i]).toFixed(3)})`);
      bandFails++;
    }
    if (!withinRelTol(a.eyring_s[i], b.eyring_s[i])) {
      console.log(`FAIL  ${sceneKey} @ ${band(i)}Hz: Eyring drift ${b.eyring_s[i]} → ${a.eyring_s[i]} s (Δ ${(a.eyring_s[i] - b.eyring_s[i]).toFixed(3)})`);
      bandFails++;
    }
  }
  if (bandFails === 0) {
    console.log(`PASS  ${sceneKey}: all bands within ±${(REL_TOL * 100).toFixed(2)} % tolerance`);
  } else {
    failed += bandFails;
  }
}

if (failed > 0) {
  console.log(`\n${failed} drift(s) detected.`);
  console.log('If this drift is INTENTIONAL (e.g. PR-2 treatment integration), regenerate the fixture:');
  console.log('  node tests/golden-rt60-treatments.test.mjs --update');
  console.log('Then have Dr. Chen sign off the diff in the PR description before commit.');
  process.exit(1);
}
console.log('\nAll treatment-scenario RT60 snapshots match within tolerance.');
