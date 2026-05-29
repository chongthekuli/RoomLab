// nymphysics decoupling guard.
//
// The engine (js/physics/, incl. precision/) must not import from the rest of
// RoomLab. If a physics module reaches into ../app-state, ../labs, ../graphics,
// ../state, ../ui, or pulls in Three.js / the DOM, nymphysics stops being
// standalone-adoptable — the whole point of the provider registry
// (js/physics/providers.js) and the source-expand / furniture-sub-volumes
// relocations.
//
// This is the test the barrel test does NOT cover: nymphysics-barrel.test.mjs
// proves the barrel imports under Node, which only means the dependency files
// exist on disk — NOT that the engine is decoupled. This file is the real
// guard. Owner: Sam (cross-surface / convention fixtures).
//
// Run: node tests/nymphysics-no-outbound-imports.test.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHYSICS_DIR = join(__dirname, '..', 'js', 'physics');

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// Recursively collect every .js file under js/physics/.
function collectJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectJs(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Forbidden import specifiers. The engine may only import from within
// js/physics/ (relative paths that don't escape) and Node/standard built-ins
// (the precision worker uses node:worker_threads in the Node test harness).
const FORBIDDEN = [
  { re: /from\s+['"][^'"]*\/app-state(\.js)?['"]/, what: '../app-state' },
  { re: /from\s+['"][^'"]*\/labs\//, what: '../labs/*' },
  { re: /from\s+['"][^'"]*\/graphics\//, what: '../graphics/*' },
  { re: /from\s+['"][^'"]*\/state\//, what: '../state/*' },
  { re: /from\s+['"][^'"]*\/ui\//, what: '../ui/*' },
  { re: /from\s+['"]three['"]/, what: 'three' },
  { re: /from\s+['"][^'"]*\/three(\.module)?\.js['"]/, what: 'three.module.js' },
  // import('...') dynamic forms of the same.
  { re: /import\(\s*['"][^'"]*\/(app-state|labs|graphics|state|ui)\//, what: 'dynamic import of app layer' },
];

// A relative import that climbs ABOVE js/physics/ (e.g. '../app-state.js',
// '../../js/...') is also a leak even if it doesn't match the named dirs.
// Detect any "../" import whose resolved target leaves the physics tree.
function importEscapesPhysics(spec, fileDir) {
  if (!spec.startsWith('.')) return false; // bare/builtin handled by FORBIDDEN
  const resolved = join(fileDir, spec);
  const rel = relative(PHYSICS_DIR, resolved);
  return rel.startsWith('..');
}

const files = collectJs(PHYSICS_DIR);
assert(files.length > 30, `found the physics tree (${files.length} modules)`);

const STATIC_IMPORT = /(?:^|\n)\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]/g;
const leaks = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const short = relative(join(__dirname, '..'), file).replace(/\\/g, '/');

  for (const { re, what } of FORBIDDEN) {
    if (re.test(src)) leaks.push(`${short} imports ${what}`);
  }

  let m;
  STATIC_IMPORT.lastIndex = 0;
  while ((m = STATIC_IMPORT.exec(src)) !== null) {
    const spec = m[1];
    if (importEscapesPhysics(spec, dirname(file))) {
      leaks.push(`${short} imports '${spec}' (escapes js/physics/)`);
    }
  }
}

if (leaks.length) {
  for (const l of leaks) console.log(`  LEAK: ${l}`);
}
assert(leaks.length === 0, 'no js/physics/ module imports outside the engine');

if (failed) {
  console.log(`\n${failed} test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll nymphysics decoupling tests passed.');
