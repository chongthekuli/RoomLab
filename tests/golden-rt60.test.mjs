// Golden RT60 snapshot — guards against silent physics drift.
//
// Why this exists: when Q1 #3 ships (Eyring/Fitzroy default for
// asymmetric-α rooms) the displayed RT60 will shift on every preset
// and template. Without a snapshot of "today's numbers" the change
// could land green-on-green and nobody would notice the auditorium
// suddenly reads 1.5 s when it used to be 1.9 s. This test fails
// LOUDLY whenever a physics change moves any preset's RT60 outside
// the tolerance band — forcing the author to update the snapshot
// intentionally with Dr. Chen's review in the same PR.
//
// Tolerance: ±0.02 s on RT60 per band. ±0.0001 on meanAbsorption.
// ±0.5 m³ on volume / ±1 m² on total area (rounding noise).
//
// To regenerate after an intentional physics change:
//   node tests/golden-rt60.test.mjs --update

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  state, applyPresetToState, applyTemplateToState, PRESETS, TEMPLATES,
} from '../js/app-state.js';
import { computeAllBands } from '../js/physics/rt60.js';

// Resolve the fixture path next to this test file so spaces / unicode
// in the absolute path don't break URL → filesystem decoding (Windows
// "OneDrive\CCY LINKAGE\…" hit %20-encoding bugs without this).
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'golden-rt60.json');
const RT60_TOL_S       = 0.02;
const ALPHA_TOL        = 0.0001;
const VOLUME_TOL_M3    = 0.5;
const AREA_TOL_M2      = 1.0;

const updateMode = process.argv.includes('--update');

const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};

function snapshot() {
  const bands = computeAllBands({ room: state.room, materials, zones: state.zones });
  return {
    volume_m3: Math.round(bands[0].volume_m3 * 100) / 100,
    totalArea_m2: Math.round(bands[0].totalArea_m2 * 100) / 100,
    meanAbsorption: bands.map(b => Math.round(b.meanAbsorption * 10000) / 10000),
    sabine_s: bands.map(b => Math.round(b.sabine_s * 1000) / 1000),
    eyring_s: bands.map(b => Math.round(b.eyring_s * 1000) / 1000),
  };
}

const live = {};
for (const k of Object.keys(PRESETS))   { applyPresetToState(k);   live['preset:'   + k] = snapshot(); }
for (const k of Object.keys(TEMPLATES)) { applyTemplateToState(k); live['template:' + k] = snapshot(); }

if (updateMode) {
  writeFileSync(FIXTURE_PATH, JSON.stringify(live, null, 2) + '\n');
  console.log(`Snapshot regenerated (${Object.keys(live).length} rooms) → ${FIXTURE_PATH}`);
  console.log('\nNow review the diff with `git diff tests/fixtures/golden-rt60.json` and have Dr. Chen sign off in the PR description.');
  process.exit(0);
}

if (!existsSync(FIXTURE_PATH)) {
  console.log(`FAIL — golden fixture missing at ${FIXTURE_PATH}.`);
  console.log('Run `node tests/golden-rt60.test.mjs --update` to capture the current numbers.');
  process.exit(1);
}

const golden = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const liveKeys   = Object.keys(live).sort();
const goldenKeys = Object.keys(golden).sort();
assert(liveKeys.length === goldenKeys.length && liveKeys.every((k, i) => k === goldenKeys[i]),
  `Room set unchanged (${liveKeys.length} rooms)`);

function band(i) { return materials.frequency_bands_hz[i] >= 1000 ? `${materials.frequency_bands_hz[i] / 1000}k` : `${materials.frequency_bands_hz[i]}`; }

for (const key of liveKeys) {
  const a = live[key], b = golden[key];
  if (!b) {
    console.log(`FAIL  ${key}: no golden entry — run with --update if this room is new`);
    failed++;
    continue;
  }
  // Volume / area within rounding noise — these shift only if geometry changes.
  if (Math.abs(a.volume_m3 - b.volume_m3) > VOLUME_TOL_M3) {
    console.log(`FAIL  ${key}: volume drift ${b.volume_m3} → ${a.volume_m3} m³ (Δ ${(a.volume_m3 - b.volume_m3).toFixed(2)})`);
    failed++;
  }
  if (Math.abs(a.totalArea_m2 - b.totalArea_m2) > AREA_TOL_M2) {
    console.log(`FAIL  ${key}: total area drift ${b.totalArea_m2} → ${a.totalArea_m2} m² (Δ ${(a.totalArea_m2 - b.totalArea_m2).toFixed(2)})`);
    failed++;
  }
  let bandFails = 0;
  for (let i = 0; i < a.sabine_s.length; i++) {
    if (Math.abs(a.meanAbsorption[i] - b.meanAbsorption[i]) > ALPHA_TOL) {
      console.log(`FAIL  ${key} @ ${band(i)}Hz: ᾱ drift ${b.meanAbsorption[i]} → ${a.meanAbsorption[i]}`);
      bandFails++;
    }
    if (Math.abs(a.sabine_s[i] - b.sabine_s[i]) > RT60_TOL_S) {
      console.log(`FAIL  ${key} @ ${band(i)}Hz: Sabine drift ${b.sabine_s[i]} → ${a.sabine_s[i]} s (Δ ${(a.sabine_s[i] - b.sabine_s[i]).toFixed(3)})`);
      bandFails++;
    }
    if (Math.abs(a.eyring_s[i] - b.eyring_s[i]) > RT60_TOL_S) {
      console.log(`FAIL  ${key} @ ${band(i)}Hz: Eyring drift ${b.eyring_s[i]} → ${a.eyring_s[i]} s (Δ ${(a.eyring_s[i] - b.eyring_s[i]).toFixed(3)})`);
      bandFails++;
    }
  }
  if (bandFails === 0) {
    console.log(`PASS  ${key}: all bands within tolerance`);
  } else {
    failed += bandFails;
  }
}

if (failed > 0) {
  console.log(`\n${failed} drift(s) detected.`);
  console.log('If this drift is INTENTIONAL (e.g. Eyring/Fitzroy upgrade landing), regenerate the fixture:');
  console.log('  node tests/golden-rt60.test.mjs --update');
  console.log('Then have Dr. Chen sign off the diff in the PR description before commit.');
  process.exit(1);
}
console.log('\nAll RT60 snapshots match within tolerance.');
