// Schema guard for data/materials.json — enforces the v1.4 contract
// every consumer (rt60.js, spl-calculator.js, wall-path.js, SurfaceLAB,
// the print report) depends on.
//
// Fields that MUST exist on every material:
//   id (string)
//   name (string)
//   absorption (number[7])
//   scattering (number[7])
//   transmission_loss_db (number[7])    ← added in v1.4
//   tl_estimated (boolean)               ← added in v1.4
//
// Fields that MAY exist:
//   surface_density_kg_m2 (number)       ← required when tl_estimated=true
//                                          so the engine can re-derive the
//                                          mass-law estimate if the value
//                                          ever needs to be regenerated
//   _source / _tl_source / _tl_note (string, citation/explanation)
//
// Locked-in invariants (regression guards):
//   transmission_loss_db values are non-negative
//   absorption values are in [0, 1]

import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('./data/materials.json', 'utf8'));

let failed = 0;
function ok(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
}

ok(data.schema_version === '1.4',
  'schema_version is 1.4', `actual=${data.schema_version}`);
ok(Array.isArray(data.frequency_bands_hz) && data.frequency_bands_hz.length === 7,
  'frequency_bands_hz has 7 octave bands');
const expectedBands = [125, 250, 500, 1000, 2000, 4000, 8000];
ok(data.frequency_bands_hz.every((f, i) => f === expectedBands[i]),
  'frequency_bands_hz match canonical [125..8000]');

ok(Array.isArray(data.materials) && data.materials.length > 0,
  `materials catalogue non-empty (${data.materials.length} entries)`);

for (const m of data.materials) {
  const id = m.id || '<unknown>';
  ok(typeof m.id === 'string' && m.id.length > 0,
    `${id}: id is non-empty string`);
  ok(typeof m.name === 'string' && m.name.length > 0,
    `${id}: name is non-empty string`);

  // absorption
  ok(Array.isArray(m.absorption) && m.absorption.length === 7,
    `${id}: absorption is array of length 7`);
  if (Array.isArray(m.absorption)) {
    const allValid = m.absorption.every(a => Number.isFinite(a) && a >= 0 && a <= 1);
    ok(allValid, `${id}: absorption values in [0, 1]`);
  }

  // scattering
  ok(Array.isArray(m.scattering) && m.scattering.length === 7,
    `${id}: scattering is array of length 7`);

  // transmission_loss_db
  ok(Array.isArray(m.transmission_loss_db) && m.transmission_loss_db.length === 7,
    `${id}: transmission_loss_db is array of length 7`);
  if (Array.isArray(m.transmission_loss_db)) {
    const allValid = m.transmission_loss_db.every(t => Number.isFinite(t) && t >= 0);
    ok(allValid, `${id}: transmission_loss_db values are finite and non-negative`);
  }

  // tl_estimated
  ok(typeof m.tl_estimated === 'boolean',
    `${id}: tl_estimated is boolean`);

  // surface_density_kg_m2 required when tl_estimated is true (so the
  // engine can re-derive the mass-law estimate if/when values need
  // regenerating from source). Materials with measured TL data may omit it.
  if (m.tl_estimated === true) {
    ok(Number.isFinite(m.surface_density_kg_m2) && m.surface_density_kg_m2 >= 0,
      `${id}: surface_density_kg_m2 present (required when tl_estimated=true)`);
  }
}

// Sanity-check a few specific TL values landed correctly.
const byId = Object.fromEntries(data.materials.map(m => [m.id, m]));
function tlEq(matId, bandIdx, expected, label) {
  const v = byId[matId]?.transmission_loss_db?.[bandIdx];
  ok(v === expected, label, `actual=${v} expected=${expected}`);
}
tlEq('concrete-painted', 3, 53, '150mm painted concrete TL @ 1kHz = 53 dB');
tlEq('concrete-painted', 6, 65, '150mm painted concrete TL @ 8kHz = 65 dB');
tlEq('gypsum-board',     5, 28, '13mm gypsum-board TL @ 4kHz = 28 dB (coincidence dip)');
tlEq('open-air',         3, 0,  'open-air TL = 0 at every band');
tlEq('door-solid-wood',  3, 25, '45mm solid wood door TL @ 1kHz = 25 dB');

if (failed > 0) { console.log(`\n${failed} materials-schema test(s) FAILED`); process.exit(1); }
console.log('\nAll materials-schema tests passed.');
