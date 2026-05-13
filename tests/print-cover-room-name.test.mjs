// Print-report cover redesign — regression test (Sofia v3, 2026-05-13).
//
// User scenario:
//   1. Load a preset → print → cover shows project name + room name
//      under it (room name seeded from the preset label, e.g.
//      "Sports arena (dome)" for the arena preset).
//   2. User edits state.room.name → print → cover reflects the new name.
//   3. User loads a preset whose label is empty / not provided → cover
//      falls back to "Untitled room".
//   4. Round-trip serialize / deserialize keeps state.room.name.
//   5. Cover always shows the room measurements panel — width, depth,
//      height, floor area, volume, surface area, shape.
//
// Hannes's rule: every bug-fix + every shipped feature gets a
// same-PR regression test. This file is that test for the room-name +
// cover-redesign feature.

import { readFileSync } from 'node:fs';
import {
  state, applyPresetToState, applyTemplateToState, PRESETS, TEMPLATES,
  serializeProject, deserializeProject,
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

// ---------------------------------------------------------------------
// 1. Every preset seeds state.room.name from its label
// ---------------------------------------------------------------------
for (const k of Object.keys(PRESETS)) {
  applyPresetToState(k);
  const labelOnPreset = PRESETS[k].label;
  if (typeof labelOnPreset === 'string' && labelOnPreset.length > 0) {
    assert(state.room.name === labelOnPreset,
      `preset:${k}: room.name seeded from preset.label ("${labelOnPreset}")`);
  } else {
    assert(state.room.name === '',
      `preset:${k}: no label → room.name stays empty (got "${state.room.name}")`);
  }
  const m = buildPrintModel({ materials });
  assert(typeof m.room.name === 'string',
    `preset:${k}: print model surfaces room.name as string`);
}

// ---------------------------------------------------------------------
// 2. Every template seeds state.room.name from its label
// ---------------------------------------------------------------------
for (const k of Object.keys(TEMPLATES)) {
  applyTemplateToState(k);
  const labelOnTemplate = TEMPLATES[k].label;
  if (typeof labelOnTemplate === 'string' && labelOnTemplate.length > 0) {
    assert(state.room.name === labelOnTemplate,
      `template:${k}: room.name seeded from template.label ("${labelOnTemplate}")`);
  }
}

// ---------------------------------------------------------------------
// 3. User edit propagates through buildPrintModel
// ---------------------------------------------------------------------
applyTemplateToState('hifi');
state.room.name = 'Hospital Serdang — Lobby';
{
  const m = buildPrintModel({ materials });
  assert(m.room.name === 'Hospital Serdang — Lobby',
    'user-edited room.name reaches print model');
}

// Whitespace-only name should normalise to '' so the cover falls back
// to the "Untitled room" placeholder.
applyTemplateToState('hifi');
state.room.name = '   ';
{
  const m = buildPrintModel({ materials });
  assert(m.room.name === '',
    'whitespace-only room.name trims to empty string in print model');
}

// ---------------------------------------------------------------------
// 4. Serialize / deserialize round-trip preserves room.name
// ---------------------------------------------------------------------
applyTemplateToState('classroom');
state.room.name = 'Room 3B';
state.projectName = 'School Alpha';
{
  const json = serializeProject();
  const blob = JSON.parse(JSON.stringify(json));      // simulate save/load
  // Wipe room.name first to prove deserialize is what restores it.
  applyTemplateToState('hifi');
  state.room.name = '';
  state.projectName = null;
  deserializeProject(blob);
  assert(state.room.name === 'Room 3B',
    'round-trip serialize/deserialize preserves room.name');
  assert(state.projectName === 'School Alpha',
    'round-trip serialize/deserialize preserves projectName (unchanged behaviour)');
}

// ---------------------------------------------------------------------
// 5. Cover model always carries measurements + shape descriptor
// ---------------------------------------------------------------------
applyPresetToState('arena');
{
  const m = buildPrintModel({ materials });
  assert(Number.isFinite(m.room.width_m) && m.room.width_m > 0,
    'cover model: width_m finite + positive');
  assert(Number.isFinite(m.room.depth_m) && m.room.depth_m > 0,
    'cover model: depth_m finite + positive');
  assert(Number.isFinite(m.room.height_m) && m.room.height_m > 0,
    'cover model: height_m finite + positive');
  assert(Number.isFinite(m.room.baseArea_m2) && m.room.baseArea_m2 > 0,
    'cover model: baseArea_m2 finite + positive');
  assert(Number.isFinite(m.room.volume_m3) && m.room.volume_m3 > 0,
    'cover model: volume_m3 finite + positive');
  assert(Number.isFinite(m.room.totalArea_m2) && m.room.totalArea_m2 > 0,
    'cover model: totalArea_m2 finite + positive');
  assert(typeof m.room.shape === 'string' && m.room.shape.length > 0,
    'cover model: shape descriptor present');
}

// ---------------------------------------------------------------------
// 6. Polygon / round / custom shapes don't break the measurements pull
// ---------------------------------------------------------------------
applyTemplateToState('chamber');     // polygon
{
  const m = buildPrintModel({ materials });
  assert(m.room.shape === 'polygon', 'chamber template: shape = polygon');
  assert(Number.isFinite(m.room.polygon_sides) || m.room.polygon_sides === null,
    'cover model: polygon_sides present (numeric or null)');
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
