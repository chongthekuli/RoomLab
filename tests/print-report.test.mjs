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
  // Sanity check: model has no result-grid blobs hiding in it
  assert(!('splGrid' in m) && !('zoneGrids' in m) && !('precision' in m),
    'print model excludes results.* (splGrid, zoneGrids, precision)');
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

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll print-report tests passed.');
