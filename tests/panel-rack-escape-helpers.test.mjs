// Regression guard (bug 2026-05-29): panel-rack.js called escapeAttr(entry.id)
// in renderTargetRoomSelect, but only escapeHtml is defined in the module.
// The ReferenceError crashed DeviceLAB mount (router: mount(device) failed).
//
// panel-rack.js is browser-DOM code (document, localStorage) so it can't be
// imported in Node. This is a static tripwire instead — same pattern as
// tests/scene-x-mirror.test.mjs: every escapeXxx(...) call in the file must
// reference a helper that is either locally defined or imported. Catches a
// reintroduced typo / a renamed helper whose call sites weren't updated.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'js', 'labs', 'devicelab', 'panel-rack.js');
const src = readFileSync(SRC, 'utf8');

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// Collect every escape-helper NAME that is *called* (e.g. escapeHtml, escapeAttr).
const called = new Set();
for (const m of src.matchAll(/\b(escape[A-Za-z0-9_]*)\s*\(/g)) called.add(m[1]);

// Collect every escape-helper NAME that is *defined* (function decl / const)
// or *imported* in the module.
const defined = new Set();
for (const m of src.matchAll(/\bfunction\s+(escape[A-Za-z0-9_]*)\s*\(/g)) defined.add(m[1]);
for (const m of src.matchAll(/\bconst\s+(escape[A-Za-z0-9_]*)\s*=/g)) defined.add(m[1]);
for (const m of src.matchAll(/import\s+\{([^}]*)\}/g)) {
  for (const name of m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop().trim())) {
    if (/^escape/.test(name)) defined.add(name);
  }
}

assert(called.size > 0, 'panel-rack.js calls at least one escape helper (sanity)');
assert(defined.has('escapeHtml'), 'escapeHtml is defined in panel-rack.js');

for (const name of called) {
  assert(defined.has(name),
    `escape helper "${name}" is defined/imported before use (no ReferenceError)`);
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll panel-rack escape-helper tests passed.');
