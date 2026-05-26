// FurnitureLAB catalogue schema-shape regression test.
//
// Locks Lin's schema discipline (catalogue sub-hat, 2026-05-26): every
// row in data/furniture/catalogue.json MUST carry the fields that the
// physics + UI + report paths read. Missing fields produce silent zeros
// (rt60 returns 0 A_obj, UI badges 'broken row', BoM reports no
// citation) — the kind of drift that ships if a future contributor
// adds a row in a hurry. This text-greps the JSON for the contract.
//
// Schema authored 2026-05-26; review by Dr. Chen on the
// `reliability` + `citation.estimated` discipline (acoustics-engineer
// brief, same date). Linked-device-id field reserved for Felix's
// Option-A DeviceLAB boundary mitigation (parallel-surrogate runtime
// validator) — required as a NULLABLE field on every row so the
// validator never has to handle 'missing key' vs 'explicit null'.

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOGUE_PATH = join(__dirname, '..', 'data', 'furniture', 'catalogue.json');

const raw = await readFile(CATALOGUE_PATH, 'utf8');
const catalogue = JSON.parse(raw);

let failed = 0;
function check(cond, label) {
  if (cond) console.log(`PASS  ${label}`);
  else { console.log(`FAIL  ${label}`); failed++; }
}

// --- File-level invariants ----------------------------------------------
check(Number.isFinite(catalogue.schema_version) && catalogue.schema_version >= 1,
  'catalogue carries a numeric schema_version >= 1');
check(typeof catalogue.schema_notes === 'string' && catalogue.schema_notes.length > 50,
  'catalogue carries human-readable schema_notes (>50 chars, so future readers know what the file is for)');
check(Array.isArray(catalogue.items) && catalogue.items.length >= 1,
  'catalogue.items is an array with at least one entry');

// Unique ids across the whole file — duplicates would silently mask one
// row with another's data (same risk as the preset-plumbing drift bug).
const ids = catalogue.items.map(it => it.id);
check(new Set(ids).size === ids.length,
  'every item.id is unique within the catalogue');

// --- Per-item schema -----------------------------------------------------
const FREQ_BANDS = ['125', '250', '500', '1000', '2000', '4000'];
const ALLOWED_RELIABILITY = new Set(['measured', 'derived', 'estimated']);
const ALLOWED_CATEGORIES = new Set([
  'seating', 'table', 'storage', 'tech', 'decorative', 'architectural', 'audience',
]);
const ALLOWED_MOUNTS = new Set(['floor', 'wall', 'ceiling', 'free-hanging']);
// Schema v2 (2026-05-26): visual.family drives both the 3D builder
// (scene.js _buildFurnitureMesh dispatch) and the iso-ink glyph
// (glyphs.js dispatch). Categories without a dedicated builder fall
// back to the generic box, but the FIELD is still required so the
// dispatcher always has something to read.
const ALLOWED_VISUAL_FAMILIES = new Set(['seat', 'slab-on-legs', 'vertical-box', 'flat-pad']);
// Schema v3 (2026-05-27): acoustics.interaction_mode controls how the
// precision ray-tracer treats the object. 'porous' = Beer-Lambert
// volumetric absorber the ray passes through with energy loss (chairs,
// sofas, drapes, audience blocks). 'reflective' = bbox triangulated
// into the wall BVH; rays hit and bounce with α-absorption (tables,
// lecterns, bookshelves, server racks). Both contribute identically to
// rt60.js Sabine/Eyring via the parallel-A sum.
const ALLOWED_INTERACTION_MODES = new Set(['porous', 'reflective']);

for (const item of catalogue.items) {
  const tag = `[${item.id ?? '<no-id>'}]`;

  // Identity + classification
  check(typeof item.id === 'string' && item.id.length > 0,
    `${tag} id is a non-empty string`);
  check(typeof item.name === 'string' && item.name.length > 0,
    `${tag} name is a non-empty string (drives card + BoM display)`);
  check(typeof item.short_name === 'string' && item.short_name.length > 0 && item.short_name.length <= 16,
    `${tag} short_name is a 1-16 char compact label (drives 2D plan + 3D HUD; long names overflow)`);
  check(typeof item.category === 'string' && ALLOWED_CATEGORIES.has(item.category),
    `${tag} category is one of {${[...ALLOWED_CATEGORIES].join(', ')}}`);
  check(item.visual && ALLOWED_VISUAL_FAMILIES.has(item.visual.family),
    `${tag} visual.family is one of {${[...ALLOWED_VISUAL_FAMILIES].join(', ')}} (drives 3D + iso-glyph dispatch)`);

  // Footprint — drives the 2D top-down render + 3D bbox
  check(item.footprint && typeof item.footprint === 'object',
    `${tag} footprint block is present`);
  check(Number.isFinite(item.footprint?.width_m) && item.footprint.width_m > 0,
    `${tag} footprint.width_m is a positive number`);
  check(Number.isFinite(item.footprint?.depth_m) && item.footprint.depth_m > 0,
    `${tag} footprint.depth_m is a positive number`);
  check(Number.isFinite(item.footprint?.height_m) && item.footprint.height_m > 0,
    `${tag} footprint.height_m is a positive number`);

  // Placement + mounting
  check(item.placement && ALLOWED_MOUNTS.has(item.placement.mounts_on),
    `${tag} placement.mounts_on is one of {${[...ALLOWED_MOUNTS].join(', ')}}`);

  // Acoustics — the load-bearing block
  check(item.acoustics?.model === 'equivalent_absorption_area',
    `${tag} acoustics.model = 'equivalent_absorption_area' (only model supported in Phase 0)`);
  check(ALLOWED_INTERACTION_MODES.has(item.acoustics?.interaction_mode),
    `${tag} acoustics.interaction_mode is one of {${[...ALLOWED_INTERACTION_MODES].join(', ')}} (drives tracer pass: porous = Beer-Lambert sink, reflective = triangulated into wall BVH)`);
  const A = item.acoustics?.A_obj_m2_sab_per_band;
  check(A && typeof A === 'object',
    `${tag} acoustics.A_obj_m2_sab_per_band block is present`);
  for (const band of FREQ_BANDS) {
    check(Number.isFinite(A?.[band]) && A[band] >= 0,
      `${tag} A_obj_m2_sab_per_band["${band}"] is a non-negative finite number`);
  }
  // scattering_per_band may be null OR a per-band object — never missing.
  check('scattering_per_band' in item.acoustics,
    `${tag} acoustics.scattering_per_band key is present (null or per-band object; never missing)`);
  // occupancy_state must be present (null for non-occupiable items).
  check('occupancy_state' in item.acoustics,
    `${tag} acoustics.occupancy_state key is present (null for non-occupiable items)`);

  // Citation — the discipline that separates measured from clip-art
  check(item.citation && typeof item.citation === 'object',
    `${tag} citation block is present`);
  check(typeof item.citation?.source === 'string' && item.citation.source.length > 0,
    `${tag} citation.source is a non-empty string`);
  check(typeof item.citation?.reference === 'string' && item.citation.reference.length > 0,
    `${tag} citation.reference is a non-empty string`);
  check(typeof item.citation?.measurement_method === 'string' && item.citation.measurement_method.length > 0,
    `${tag} citation.measurement_method is documented (Dr. Chen rule — no silent ISO 354 assumption)`);
  check(typeof item.citation?.estimated === 'boolean',
    `${tag} citation.estimated is a boolean (true iff numbers are derivation / engineering judgement)`);

  // Reliability tag — Dr. Chen's non-negotiable
  check(ALLOWED_RELIABILITY.has(item.reliability),
    `${tag} reliability is one of {${[...ALLOWED_RELIABILITY].join(', ')}}`);

  // Cross-check: citation.estimated and reliability='measured' must
  // agree. If citation.estimated=true, reliability cannot be 'measured'.
  if (item.citation?.estimated === true) {
    check(item.reliability !== 'measured',
      `${tag} citation.estimated=true is incompatible with reliability='measured' (Dr. Chen: silent estimate would ship as a lab number)`);
  }

  // DeviceLAB boundary mitigation — every row carries a nullable
  // linked_device_id field. Phase 0: always null. Phase 1+: rows that
  // surrogate a DeviceLAB entry populate this so the parallel-store
  // validator can badge stale links.
  check('linked_device_id' in item,
    `${tag} linked_device_id key is present (nullable; reserved for DeviceLAB-boundary Option-A mitigation)`);

  // Versioning + audit
  check(Number.isFinite(item.schema_version) && item.schema_version >= 1,
    `${tag} item.schema_version is a number >= 1`);
  check(typeof item.added === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.added),
    `${tag} added is an ISO date YYYY-MM-DD`);
  check('revised' in item && 'revised_by' in item && 'revised_note' in item,
    `${tag} revised / revised_by / revised_note keys all present (nullable; populated when Dr. Chen updates a value)`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${catalogue.items.length} FurnitureLAB catalogue rows pass schema discipline.`);
