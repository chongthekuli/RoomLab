// Phase 5 Step 3 regression — schema 1.5 validator for data/materials.json
// (v=618, 2026-05-23).
//
// Sam (qa-engineer) signed off the schema spec 2026-05-23. This test
// enforces every assertion A1–A19 from his punch list. Failure
// semantics per Sam: name the offending row's id + field + value, NOT
// "1 failure" — so any drift is debuggable in one read.
//
// Schema 1.5 extends 1.4 additively:
//   * `model: "mass-law" | "formula" | "catalogue"` REQUIRED on every row.
//   * `tl_third_oct: number[18]` OPTIONAL, REQUIRED iff model === "catalogue".
//   * `assembly: {leaf1_mass_kg_m2, leaf2_mass_kg_m2, cavity_depth_m,
//      cavity_fill, stud_type}` REQUIRED iff model === "formula", FORBIDDEN
//      otherwise.
//   * `reference_thickness_m` PROMOTED from wall-catalogue.js, OPTIONAL.
//   * `assembly_type` PROMOTED from wall-catalogue.js, OPTIONAL.
//
// Cross-field invariant: rc1 stud_type cannot use the formula path —
// Dr. Chen's "catalogue only" sentinel. Schema forbids the combination.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ISO_THIRD_OCTAVE_HZ } from '../js/physics/third-octave-bands.js';
import { CAVITY_FILL_BONUS_DB, STUD_TYPES } from '../js/physics/wall-tl-double-leaf.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(root, 'data/materials.json'), 'utf8');
const data = JSON.parse(raw);

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// Per Sam's "name the row" requirement — collect per-row failures and
// surface them with the row's id + offending field + value.
const rowFailures = [];
function rowFail(row, field, msg) {
  rowFailures.push(`row "${row.id}" field "${field}": ${msg}`);
}

const MODEL_KINDS = ['mass-law', 'formula', 'catalogue'];
const ASSEMBLY_KINDS = ['single_leaf', 'double_leaf', 'composite'];
const CAVITY_FILL_KINDS = Object.keys(CAVITY_FILL_BONUS_DB);   // import, don't hardcode
const STUD_TYPE_KINDS = [...STUD_TYPES];                       // import, don't hardcode

// =============================================================================
// A1. schema_version === "1.5"
// =============================================================================

check('A1. schema_version is "1.5"',
  data.schema_version === '1.5',
  `got "${data.schema_version}"`);

// =============================================================================
// A2. frequency_bands_hz unchanged (legacy octave list)
// =============================================================================

check('A2. frequency_bands_hz unchanged: [125, 250, 500, 1000, 2000, 4000, 8000]',
  JSON.stringify(data.frequency_bands_hz) === JSON.stringify([125, 250, 500, 1000, 2000, 4000, 8000]));

// =============================================================================
// Per-row sweep (A3–A18 enforced per row)
// =============================================================================

const rows = data.materials;
check('materials array exists and is non-empty',
  Array.isArray(rows) && rows.length > 0,
  `got ${rows?.length ?? 'undefined'}`);

const seenIds = new Set();

for (const r of rows) {
  // A3. every row has a valid model.
  if (!MODEL_KINDS.includes(r.model)) {
    rowFail(r, 'model', `must be one of ${JSON.stringify(MODEL_KINDS)}, got ${JSON.stringify(r.model)}`);
  }
  // A4. octave arrays still length 7.
  for (const f of ['absorption', 'scattering', 'transmission_loss_db']) {
    if (!Array.isArray(r[f]) || r[f].length !== 7) {
      rowFail(r, f, `must be a length-7 array, got ${Array.isArray(r[f]) ? `length ${r[f].length}` : typeof r[f]}`);
    }
  }
  // A5. iff model === "catalogue", tl_third_oct present.
  if (r.model === 'catalogue' && !Array.isArray(r.tl_third_oct)) {
    rowFail(r, 'tl_third_oct', `REQUIRED for model="catalogue", missing`);
  }
  // A6. iff tl_third_oct present, length === 18 and values finite [0, 80].
  if (r.tl_third_oct !== undefined) {
    if (!Array.isArray(r.tl_third_oct)) {
      rowFail(r, 'tl_third_oct', `must be array, got ${typeof r.tl_third_oct}`);
    } else if (r.tl_third_oct.length !== ISO_THIRD_OCTAVE_HZ.length) {
      rowFail(r, 'tl_third_oct', `length must be ${ISO_THIRD_OCTAVE_HZ.length} (ISO 717-1 1/3-oct), got ${r.tl_third_oct.length}`);
    } else {
      for (let i = 0; i < r.tl_third_oct.length; i++) {
        const v = r.tl_third_oct[i];
        if (!Number.isFinite(v) || v < 0 || v > 80) {
          rowFail(r, `tl_third_oct[${i}]`, `must be finite in [0, 80] dB, got ${v}`);
        }
      }
    }
  }
  // A7. iff model === "formula", assembly present and complete.
  if (r.model === 'formula') {
    if (!r.assembly || typeof r.assembly !== 'object') {
      rowFail(r, 'assembly', `REQUIRED for model="formula", missing`);
    } else {
      const a = r.assembly;
      for (const f of ['leaf1_mass_kg_m2', 'leaf2_mass_kg_m2', 'cavity_depth_m', 'cavity_fill', 'stud_type']) {
        if (a[f] === undefined) {
          rowFail(r, `assembly.${f}`, `REQUIRED in assembly block, missing`);
        }
      }
      if (!(a.leaf1_mass_kg_m2 > 0) || !Number.isFinite(a.leaf1_mass_kg_m2)) {
        rowFail(r, 'assembly.leaf1_mass_kg_m2', `must be finite > 0, got ${a.leaf1_mass_kg_m2}`);
      }
      if (!(a.leaf2_mass_kg_m2 > 0) || !Number.isFinite(a.leaf2_mass_kg_m2)) {
        rowFail(r, 'assembly.leaf2_mass_kg_m2', `must be finite > 0, got ${a.leaf2_mass_kg_m2}`);
      }
      if (!(a.cavity_depth_m > 0) || a.cavity_depth_m >= 1.0 || !Number.isFinite(a.cavity_depth_m)) {
        rowFail(r, 'assembly.cavity_depth_m', `must be finite in (0, 1.0) m, got ${a.cavity_depth_m}`);
      }
      // A9. cavity_fill in canonical enum.
      if (a.cavity_fill !== undefined && !CAVITY_FILL_KINDS.includes(a.cavity_fill)) {
        rowFail(r, 'assembly.cavity_fill', `must be one of ${JSON.stringify(CAVITY_FILL_KINDS)}, got ${JSON.stringify(a.cavity_fill)}`);
      }
      // A10. stud_type in canonical enum.
      if (a.stud_type !== undefined && !STUD_TYPE_KINDS.includes(a.stud_type)) {
        rowFail(r, 'assembly.stud_type', `must be one of ${JSON.stringify(STUD_TYPE_KINDS)}, got ${JSON.stringify(a.stud_type)}`);
      }
      // A13. FORBIDDEN combo: model === "formula" AND stud_type === "rc1".
      if (a.stud_type === 'rc1') {
        rowFail(r, 'assembly.stud_type', `rc1 (resilient channel) has no closed-form predictor; row must be model="catalogue", not model="formula"`);
      }
    }
  }
  // A8. iff model !== "formula", assembly FORBIDDEN.
  if (r.model !== 'formula' && r.assembly !== undefined) {
    rowFail(r, 'assembly', `FORBIDDEN when model="${r.model}", got present`);
  }
  // A14. reference_thickness_m sanity.
  if (r.reference_thickness_m !== undefined) {
    if (!(r.reference_thickness_m > 0) || r.reference_thickness_m >= 1.0 || !Number.isFinite(r.reference_thickness_m)) {
      rowFail(r, 'reference_thickness_m', `must be finite in (0, 1.0) m, got ${r.reference_thickness_m}`);
    }
  }
  // A15. assembly_type in canonical enum.
  if (r.assembly_type !== undefined && !ASSEMBLY_KINDS.includes(r.assembly_type)) {
    rowFail(r, 'assembly_type', `must be one of ${JSON.stringify(ASSEMBLY_KINDS)}, got ${JSON.stringify(r.assembly_type)}`);
  }
  // A16. row ids unique.
  if (seenIds.has(r.id)) {
    rowFail(r, 'id', `duplicate id`);
  }
  seenIds.add(r.id);
  // A17. tl_estimated === false retains _tl_source.
  if (r.tl_estimated === false && !r._tl_source) {
    rowFail(r, '_tl_source', `REQUIRED when tl_estimated=false (preserves 1.4 citation discipline)`);
  }
  // A18. legacy 1.4 fields all present (regression — migration didn't drop anything).
  for (const f of ['id', 'name', 'absorption', 'scattering', 'transmission_loss_db', 'surface_density_kg_m2', 'tl_estimated']) {
    if (r[f] === undefined) {
      rowFail(r, f, `legacy 1.4 field missing — migration regression`);
    }
  }
  // A19. catalogue rows carry citation (Sam's belt-and-braces).
  if (r.model === 'catalogue' && !r._tl_source) {
    rowFail(r, '_tl_source', `model="catalogue" rows must cite the measured source`);
  }
}

if (rowFailures.length === 0) {
  console.log(`PASS  A3-A19. all ${rows.length} rows validate against schema 1.5`);
  passed++;
} else {
  console.log(`FAIL  A3-A19. ${rowFailures.length} row(s) failed validation:`);
  for (const m of rowFailures) console.log(`        ${m}`);
  failed++;
}

// =============================================================================
// Sanity: every promoted wall row carries reference_thickness_m AND assembly_type
// =============================================================================
//
// Sam said: promote both fields now (memory rule "extract when a second
// consumer needs it" — Phase 5 Step 8 is the second consumer). The 8 wall
// rows known to wall-catalogue.js MUST carry both promoted fields in 1.5.

const PROMOTED_WALL_IDS = [
  'concrete-painted',
  'plaster-smooth',
  'gypsum-board',
  'led-glass',
  'glass-window',
  'door-solid-wood',
  'door-hollow-core',
  'wood-floor',
];

let promotedAllOk = true;
for (const id of PROMOTED_WALL_IDS) {
  const row = rows.find(r => r.id === id);
  if (!row) { console.log(`FAIL  promoted row "${id}" missing entirely`); promotedAllOk = false; continue; }
  if (row.reference_thickness_m === undefined) {
    console.log(`FAIL  row "${id}" missing reference_thickness_m (promoted from wall-catalogue.js)`);
    promotedAllOk = false;
  }
  if (row.assembly_type === undefined) {
    console.log(`FAIL  row "${id}" missing assembly_type (promoted from wall-catalogue.js)`);
    promotedAllOk = false;
  }
}
if (promotedAllOk) {
  console.log(`PASS  all 8 wall rows carry reference_thickness_m + assembly_type (promoted from wall-catalogue.js)`);
  passed++;
} else {
  failed++;
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
