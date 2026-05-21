// Speaker-category taxonomy guard.
//
// Categories are stored on each loudspeaker JSON's `mount_type` field (the
// single source of truth — reused, not a parallel `category` field). This
// test pins the canonical taxonomy, the label resolver, and the contract
// that every Amperes catalogue model is the 'ceiling' category.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SPEAKER_CATEGORIES, speakerCategoryLabel } from '../js/shared/speaker-catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LS_DIR = join(__dirname, '..', 'data', 'loudspeakers');

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// --- 1. Canonical taxonomy ------------------------------------------------
const EXPECTED = ['ceiling', 'surface-mount', 'horn', 'sound-projector',
                  'full-range', 'column', 'garden', 'pendant', 'bookshelf'];
assert(SPEAKER_CATEGORIES.length === EXPECTED.length,
  `SPEAKER_CATEGORIES has ${EXPECTED.length} entries`);
for (const v of EXPECTED) {
  assert(SPEAKER_CATEGORIES.some(c => c.value === v),
    `SPEAKER_CATEGORIES contains '${v}'`);
}
// Every entry has a non-empty display label.
for (const c of SPEAKER_CATEGORIES) {
  assert(typeof c.label === 'string' && c.label.length > 0,
    `category '${c.value}' has a label`);
}

// --- 2. Label resolver ----------------------------------------------------
assert(speakerCategoryLabel('ceiling') === 'Ceiling', "label('ceiling') = 'Ceiling'");
assert(speakerCategoryLabel('sound-projector') === 'Sound Projector',
  "label('sound-projector') = 'Sound Projector'");
assert(speakerCategoryLabel('not-a-real-value') === 'Uncategorised',
  'unknown value falls back to Uncategorised');
assert(speakerCategoryLabel(null) === 'Uncategorised',
  'null falls back to Uncategorised');

// --- 3. Data contract: every Amperes CS-series model is 'ceiling' ---------
const csFiles = readdirSync(LS_DIR).filter(f => /^amperes-cs.*\.json$/.test(f));
assert(csFiles.length > 0, 'found Amperes CS-series loudspeaker JSON files');
for (const f of csFiles) {
  const def = JSON.parse(readFileSync(join(LS_DIR, f), 'utf8'));
  assert(def.mount_type === 'ceiling', `${f} mount_type === 'ceiling'`);
}

// Any mount_type that IS set across the catalogue must be a known category
// (catches typos like 'surface_mount' vs 'surface-mount').
const known = new Set(EXPECTED);
const seen = new Set();
for (const f of readdirSync(LS_DIR).filter(f => f.endsWith('.json'))) {
  const def = JSON.parse(readFileSync(join(LS_DIR, f), 'utf8'));
  if (def.mount_type != null) {
    seen.add(def.mount_type);
    assert(known.has(def.mount_type),
      `${f} mount_type '${def.mount_type}' is a known category`);
  }
}

// --- 4. Each non-bookshelf category has at least one Amperes model --------
// (bookshelf is intentionally empty — kept for future non-Amperes imports.)
for (const v of EXPECTED) {
  if (v === 'bookshelf') continue;
  assert(seen.has(v), `category '${v}' has at least one speaker in the catalogue`);
}

// --- 5. Generated files carry the estimate caveat + a valid 1 kHz grid ----
const newFiles = readdirSync(LS_DIR).filter(f => /^amperes-(bs|fs|cl|hs|lh|sp|sg|ps)/.test(f));
assert(newFiles.length === 30, `30 new non-ceiling Amperes files present (got ${newFiles.length})`);
for (const f of newFiles) {
  const def = JSON.parse(readFileSync(join(LS_DIR, f), 'utf8'));
  const grid = def.directivity?.attenuation_db?.['1000'];
  const onAxis = Array.isArray(grid) ? grid[3]?.[6] : null;   // el=0,az=0
  assert(onAxis === 0, `${f} on-axis (el0,az0) 1 kHz attenuation === 0`);
  // Coverage/directivity is always modelled (Amperes never publishes polar
  // data), so every note must carry the MODELLED caveat regardless of how
  // many measured spec fields it has.
  assert(/MODELLED/i.test(def.note ?? ''), `${f} note carries the MODELLED directivity caveat`);
  assert(def.electrical?.max_spl_db > def.acoustic?.sensitivity_db_1w_1m,
    `${f} max SPL exceeds 1 W sensitivity`);
}

console.log(failed === 0 ? '\nAll speaker-category tests passed.' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
