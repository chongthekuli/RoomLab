// FurnitureLAB glossary entries — regression test (v=673, 2026-05-27).
//
// Lin (docs-writer) committed during the FurnitureLAB brainstorm to
// shipping plain-English definitions for every new term the lab
// introduces. This test enforces that contract — each Phase 0/1/2/4
// term has a glossary entry with a real definition (>50 chars), tied
// to the standard or formula it references.
//
// What this catches:
//   • A term used in the UI with data-gloss="foo" but no GLOSSARY[foo]
//     entry — the tooltip would be silently absent.
//   • A drive-by removal of one of the FurnitureLAB entries during
//     a glossary refactor.
//   • A placeholder one-liner entry that doesn't actually explain the
//     term (e.g. "ISO 354 — see ISO 354").
//
// Adding a new glossary term? Add the key to REQUIRED below, write
// the entry in js/ui/glossary.js, and update the docstring on the
// catalogue row that uses the term so future readers know which
// rows depend on which glossary keys.

import { GLOSSARY } from '../js/ui/glossary.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// FurnitureLAB-specific glossary keys that must exist. Listed in the
// order of the Phase 0 → Phase 4 evolution so the test reads like a
// timeline.
const REQUIRED = [
  // Phase 0/1 — Lin's original debt list from the brainstorm.
  'a_obj',
  'iso_354',
  'iso_17497',
  'type_a_mounting',
  'object_vs_surface_frame',
  'occupancy_state',
  'audience_block',
  'reliability_tier',
  // Phase 1B — confidence overlay (Carmen's competitive wedge).
  'confidence_overlay',
  // Phase 2 — Beer-Lambert sink + porous/reflective routing.
  'interaction_mode',
  'beer_lambert_furniture',
];

for (const key of REQUIRED) {
  const def = GLOSSARY[key];
  ok(typeof def === 'string',
    `GLOSSARY["${key}"] exists as a string`);
  ok(typeof def === 'string' && def.length >= 80,
    `GLOSSARY["${key}"] is a real definition (>= 80 chars; got ${def?.length ?? 0})`);
  // Each entry must lead with the term + em-dash + definition, the
  // pattern the existing entries use. Catches "A_obj — see Beranek"
  // placeholder-style entries that aren't actual definitions.
  ok(typeof def === 'string' && /[—\-]\s/.test(def),
    `GLOSSARY["${key}"] uses "Term — definition" format (em-dash separator)`);
}

// Standards / references that MUST appear somewhere in the new
// definitions, so the user can trace a term to its source.
ok(GLOSSARY.a_obj?.includes('Kuttruff') || GLOSSARY.a_obj?.includes('Beranek') || GLOSSARY.a_obj?.includes('Sabine'),
  'a_obj references at least one canonical source (Kuttruff / Beranek / Sabine)');
ok(GLOSSARY.iso_354?.includes('ISO 354'),
  'iso_354 references ISO 354 by name');
ok(GLOSSARY.iso_17497?.includes('17497'),
  'iso_17497 references ISO 17497 by name');
ok(GLOSSARY.beer_lambert_furniture?.includes('Kuttruff') && GLOSSARY.beer_lambert_furniture?.includes('4'),
  'beer_lambert_furniture references Kuttruff §4.1 and the factor of 4 in A/(4V)');
ok(GLOSSARY.occupancy_state?.includes('Beranek'),
  'occupancy_state references the Beranek occupied/empty 3× ratio');

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll FurnitureLAB glossary entries pass (${REQUIRED.length} keys).`);
