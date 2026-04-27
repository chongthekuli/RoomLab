// Print-report data-shape tests (Q1 #2).
//
// Sam's spec: skip headless browser. Verify buildPrintModel returns a
// plain object with the expected shape, all numeric values are units-
// agnostic (units come from the renderer, not the data), empty scenes
// don't crash, and the model size is bounded so nobody embeds a 200 KB
// splGrid into the print model by accident.

import { readFileSync } from 'node:fs';
import {
  state, applyPresetToState, applyTemplateToState, PRESETS, TEMPLATES,
} from '../js/app-state.js';
import { buildPrintModel } from '../js/ui/print-report.js';

const data = JSON.parse(readFileSync('data/materials.json', 'utf8'));
const materials = {
  frequency_bands_hz: data.frequency_bands_hz,
  list: data.materials,
  byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
};

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// 1. Every preset + every template builds a valid print model.
for (const k of Object.keys(PRESETS)) {
  applyPresetToState(k);
  const m = buildPrintModel({ materials });
  assert(m && typeof m === 'object', `buildPrintModel returns object for preset:${k}`);
  assert(Array.isArray(m.rt60) && m.rt60.length === materials.frequency_bands_hz.length,
    `preset:${k}: rt60 array matches band count (${m.rt60.length})`);
  assert(Array.isArray(m.sources), `preset:${k}: sources is array`);
  assert(Array.isArray(m.listeners), `preset:${k}: listeners is array`);
  assert(Array.isArray(m.zones), `preset:${k}: zones is array`);
  assert(typeof m.room.volume_m3 === 'number' && Number.isFinite(m.room.volume_m3),
    `preset:${k}: room.volume_m3 is finite number`);
  assert(typeof m.project.name === 'string', `preset:${k}: project.name is string`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(m.project.date), `preset:${k}: project.date is ISO yyyy-mm-dd`);
}
for (const k of Object.keys(TEMPLATES)) {
  applyTemplateToState(k);
  const m = buildPrintModel({ materials });
  assert(m.sources.length > 0, `template:${k}: at least one source rendered into model`);
  assert(m.listeners.length > 0, `template:${k}: at least one listener rendered into model`);
}

// 2. Empty scene (no sources / listeners / zones) doesn't crash.
applyTemplateToState('hifi');
state.sources = [];
state.listeners = [];
state.zones = [];
{
  const m = buildPrintModel({ materials });
  assert(m.sources.length === 0, 'empty scene: sources array is empty (not undefined)');
  assert(m.listeners.length === 0, 'empty scene: listeners array is empty');
  assert(m.zones.length === 0, 'empty scene: zones array is empty');
  assert(typeof m.room.volume_m3 === 'number', 'empty scene: room.volume_m3 still computed');
}

// 3. Print model size is bounded — guards against future "embed splGrid
//    into print" mistakes. The pavilion preset is the largest scene; its
//    model JSON should fit comfortably under 50 KB even with all sources
//    and zones spelled out.
applyPresetToState('pavilion');
{
  const m = buildPrintModel({ materials });
  const json = JSON.stringify(m);
  assert(json.length < 50_000, `pavilion print model bounded (${(json.length / 1024).toFixed(1)} KB < 50 KB)`);
  // Sanity check: model has no result-grid BLOBS hiding in it. The
  // large-volume keys (splGrid, zoneGrids) must not appear; the
  // precision summary is allowed (it's a digest, not the full grid).
  assert(!('splGrid' in m) && !('zoneGrids' in m),
    'print model excludes results.splGrid + results.zoneGrids (large blobs)');
}

// 4. nameHint plumbs through to project.name.
applyTemplateToState('hifi');
{
  const m = buildPrintModel({ materials, nameHint: 'Theatre A — concept 3' });
  assert(m.project.name === 'Theatre A — concept 3', 'nameHint propagates to project.name');
}

// 5. Line-array vs flat sources distinction reaches the source counts.
applyTemplateToState('livevenue');
const before = state.sources.length;
state.sources.push({
  kind: 'line-array',
  id: 'LA1',
  modelUrl: 'data/loudspeakers/line-array-element.json',
  origin: { x: 1, y: 1, z: 5 },
  splayAnglesDeg: [2, 3, 5, 8],
  power_watts_each: 500,
});
{
  const m = buildPrintModel({ materials });
  assert(m.sources.length === before + 1, 'sources length is RAW state.sources count, not flattened');
  assert(m.sourceFlat.total > m.sourceFlat.raw,
    `sourceFlat.total (${m.sourceFlat.total}) > sourceFlat.raw (${m.sourceFlat.raw}) — line-array expanded for radiating-element count`);
  assert(m.sourceFlat.lineArrays === 1, 'sourceFlat.lineArrays counts the LA correctly');
}

// 6. BOM aggregation — same model URL collapses to a single row with
//    qty summed; line-arrays count their elements; per-element power
//    multiplies into total power.
applyTemplateToState('livevenue');
{
  const m = buildPrintModel({ materials });
  assert(Array.isArray(m.bom), 'bom is array');
  // livevenue has 2 SPKLA + 1 SPK12: 2 rows in BOM after dedupe.
  assert(m.bom.length >= 1, `BOM aggregates to >=1 row (got ${m.bom.length})`);
  // Every BOM row has the required columns.
  for (const r of m.bom) {
    assert(typeof r.modelUrl === 'string', 'BOM row has modelUrl');
    assert(typeof r.modelLabel === 'string' && r.modelLabel.length > 0, `BOM row has modelLabel: ${r.modelLabel}`);
    assert(Number.isFinite(r.qty) && r.qty > 0, `BOM row has positive qty: ${r.qty}`);
    assert(typeof r.groups === 'string', 'BOM row has groups string');
  }
}

// 7. BOM with line-array: qty equals element count, total = qty × power_each.
applyTemplateToState('hifi');
state.sources = [{
  kind: 'line-array',
  id: 'LA1',
  modelUrl: 'data/loudspeakers/line-array-element.json',
  origin: { x: 2, y: 2, z: 5 },
  splayAnglesDeg: [2, 3, 5, 8],            // 5 elements
  power_watts_each: 500,
  groupId: 'A',
}];
{
  const m = buildPrintModel({ materials });
  assert(m.bom.length === 1, 'single LA → single BOM row');
  const row = m.bom[0];
  assert(row.qty === 5, `LA qty == element count (got ${row.qty}, expected 5)`);
  assert(row.power_each_w === 500, `LA per-element power 500W (got ${row.power_each_w})`);
  assert(row.total_power_w === 5 * 500, `LA total power == qty × each (got ${row.total_power_w}, expected 2500)`);
  assert(row.groups === 'A', `LA group string == 'A' (got "${row.groups}")`);
}

// 8. BOM aggregates duplicate models with different groups into one row.
applyTemplateToState('hifi');
state.sources = [
  { modelUrl: 'data/loudspeakers/generic-12inch.json', position: { x: 1, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0, roll: 0 }, power_watts: 100, groupId: 'A' },
  { modelUrl: 'data/loudspeakers/generic-12inch.json', position: { x: 3, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0, roll: 0 }, power_watts: 100, groupId: 'B' },
  { modelUrl: 'data/loudspeakers/generic-12inch.json', position: { x: 5, y: 1, z: 1 }, aim: { yaw: 0, pitch: 0, roll: 0 }, power_watts: 100, groupId: 'A' },
];
{
  const m = buildPrintModel({ materials });
  assert(m.bom.length === 1, '3 same-model sources → 1 BOM row');
  assert(m.bom[0].qty === 3, 'qty sums to 3');
  assert(m.bom[0].total_power_w === 300, 'total power == 3 × 100');
  assert(m.bom[0].groups === 'A, B', `groups list is alphabetised + comma-separated (got "${m.bom[0].groups}")`);
}

// 9. Derived metrics — critical distance + Schroeder cutoff present
//    and within plausible ranges for known scenes.
applyTemplateToState('hifi');
{
  const m = buildPrintModel({ materials });
  assert(m.derived != null, 'derived block present');
  assert(typeof m.derived.criticalDistance_m === 'number' && m.derived.criticalDistance_m > 0,
    `hifi critical distance > 0 (got ${m.derived.criticalDistance_m})`);
  assert(m.derived.criticalDistance_m < 3,
    `hifi critical distance < 3 m for small room (got ${m.derived.criticalDistance_m})`);
  assert(typeof m.derived.schroederCutoff_hz === 'number' && m.derived.schroederCutoff_hz > 100,
    `hifi Schroeder cutoff > 100 Hz for small room (got ${m.derived.schroederCutoff_hz})`);
}
applyPresetToState('auditorium');
{
  const m = buildPrintModel({ materials });
  // Bigger room: lower Schroeder cutoff, longer critical distance.
  assert(m.derived.schroederCutoff_hz < 50,
    `auditorium Schroeder cutoff < 50 Hz for big room (got ${m.derived.schroederCutoff_hz})`);
}

// 10. Precision results — null when no render has been run.
applyTemplateToState('hifi');
{
  const m = buildPrintModel({ materials });
  assert(m.precision === null, 'precision is null when results.precision is empty');
}

// 11. Project metadata — name, date, generatedAt all present.
applyTemplateToState('hifi');
{
  const m = buildPrintModel({ materials, nameHint: 'Test scene' });
  assert(m.project.name === 'Test scene', 'nameHint propagates');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(m.project.date), 'date is yyyy-mm-dd');
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m.project.generatedAt),
    `generatedAt is yyyy-mm-dd hh:mm:ss (got "${m.project.generatedAt}")`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll print-report tests passed.');
