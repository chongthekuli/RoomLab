// WallLAB Phase 1 regression guard (2026-05-22).
//
// Locks the nav/route wiring for the 5th LAB and the over-wall-acoustics
// BETA-toggle helper behaviour in js/physics/feature-flags.js. A future
// refactor that drops the 'wall' route, the lab mount, or the stored-flag
// helpers trips here instead of silently 404-ing the tab.
//
// Wiring assertions are text-greps (like scene-x-mirror.test.mjs) so we
// don't import DOM-coupled modules (router.js → lab-loading-overlay,
// header-nav → app-state) into the Node runner.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`PASS  ${name}`);
  passed++;
}

// --- Nav / route wiring -----------------------------------------------------
const router = read('js/shared/router.js');
check("router ROUTES includes 'wall'", /ROUTES\s*=\s*\[[^\]]*'wall'[^\]]*\]/.test(router));
check("router ROUTE_LABELS maps wall → WallLAB", /wall:\s*'WallLAB'/.test(router));

const header = read('js/shared/header-nav.js');
check("header LABS registers the wall tab", /id:\s*'wall'[^}]*href:\s*'#\/wall'/.test(header));

const main = read('js/main.js');
check("main.js lazy-mounts walllab on the wall route", /wall:\s*\(\)\s*=>\s*import\(`\.\/labs\/walllab\/main\.js/.test(main));

const html = read('index.html');
check('index.html has the route-wall container', /data-route="wall"/.test(html) && /id="view-wall"/.test(html));
check('index.html cache-bust is not stale (no ?v=600 left)', !/\?v=600\b/.test(html));

// --- BETA-toggle helpers ----------------------------------------------------
// Stub a minimal localStorage so the helpers exercise the real read/write
// path the browser uses (Node has none → the module otherwise no-ops).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const ff = await import('../js/physics/feature-flags.js');
check('exports PHYSICS_P1_5_STORAGE_KEY = PHYSICS_P1_5', ff.PHYSICS_P1_5_STORAGE_KEY === 'PHYSICS_P1_5');

// Tri-state: no explicit preference reads back as null (not false), so the UI
// can distinguish "you chose Off" from "defaulting to the origin behaviour".
check('default stored preference is null (no explicit choice)', ff.getStoredPhysicsP15() === null);

ff.setStoredPhysicsP15(true);
check('setStoredPhysicsP15(true) → reads back ON, writes "1"',
  ff.getStoredPhysicsP15() === true && store.get('PHYSICS_P1_5') === '1');

// The load-bearing fix: an explicit OFF must write "0", NOT remove the key —
// so it overrides the localhost auto-enable instead of falling back to it.
ff.setStoredPhysicsP15(false);
check('setStoredPhysicsP15(false) → reads back OFF, writes EXPLICIT "0"',
  ff.getStoredPhysicsP15() === false && store.get('PHYSICS_P1_5') === '0');

ff.clearStoredPhysicsP15();
check('clearStoredPhysicsP15() removes the key → back to null default',
  ff.getStoredPhysicsP15() === null && !store.has('PHYSICS_P1_5'));

check('isPhysicsP15AutoOrigin is false off-localhost (no window in Node)',
  ff.isPhysicsP15AutoOrigin() === false);
check('getEffectivePhysicsP15 falls back to origin default (false in Node) when unset',
  ff.getEffectivePhysicsP15() === false);

console.log(`\nOK  ${passed} assertions passed`);
