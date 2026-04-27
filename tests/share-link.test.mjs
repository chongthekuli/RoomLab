// Share-link round-trip tests (Q1 #1).
//
// Catches the exact failure modes Sam + Martina flagged:
//   - btoa throwing on em-dash / ″ / emoji labels
//   - base64 truncation silently corrupting state
//   - oversize payloads not flagged
//   - results.* / display.* leaking into URLs
//   - garbage / future-version hashes mutating state
//
// Run: node tests/share-link.test.mjs

import {
  state, applyPresetToState, applyTemplateToState, PRESETS, TEMPLATES,
  serializeProject, deserializeProject,
} from '../js/app-state.js';
import {
  encodeShareLink, decodeShareLink, buildShareUrl, SHARE_LINK_MAX_CHARS,
} from '../js/io/share-link.js';

// btoa / atob / TextEncoder / TextDecoder are global in Node 16+ — no shim needed.
if (typeof btoa !== 'function' || typeof atob !== 'function') {
  console.log('FAIL — btoa/atob not present in this Node runtime');
  process.exit(1);
}

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

function deepEqual(a, b, path = '') {
  if (a === b) return true;
  if (typeof a !== typeof b) { console.log(`  type mismatch at ${path}`); return false; }
  if (a === null || b === null) { console.log(`  null mismatch at ${path}`); return false; }
  if (Array.isArray(a) !== Array.isArray(b)) { console.log(`  array vs object at ${path}`); return false; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) { console.log(`  length mismatch at ${path}: ${a.length} vs ${b.length}`); return false; }
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], `${path}[${i}]`)) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
      console.log(`  key set differs at ${path}: ${JSON.stringify(ka)} vs ${JSON.stringify(kb)}`);
      return false;
    }
    for (const k of ka) if (!deepEqual(a[k], b[k], `${path}.${k}`)) return false;
    return true;
  }
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  console.log(`  value differs at ${path}: ${JSON.stringify(a).slice(0, 80)} vs ${JSON.stringify(b).slice(0, 80)}`);
  return false;
}

function snapshotState() {
  const dump = JSON.parse(JSON.stringify(serializeProject()));
  delete dump.meta;
  return dump;
}

function roundTrip(label) {
  const before = snapshotState();
  const { hash, tooLarge } = encodeShareLink();
  const result = decodeShareLink(hash);
  const after = snapshotState();
  return { ok: deepEqual(before, after), tooLarge, hash, result };
}

// 1. Round-trip every preset and every template.
for (const k of Object.keys(PRESETS)) {
  applyPresetToState(k);
  const { ok } = roundTrip(`preset:${k}`);
  assert(ok, `Round-trip clean: preset ${k}`);
}
for (const k of Object.keys(TEMPLATES)) {
  applyTemplateToState(k);
  const { ok } = roundTrip(`template:${k}`);
  assert(ok, `Round-trip clean: template ${k}`);
}

// 2. Unicode survives — em-dash, ″, emoji, non-Latin script.
applyTemplateToState('hifi');
state.zones = [{ id: 'Z1', label: '禮堂 — Auditorium « 1 »', vertices: [{x:0,y:0},{x:1,y:0},{x:1,y:1}], elevation_m: 0, material_id: 'wood-floor' }];
state.listeners[0].label = '🎧 mix pos — chair ♯1';
{
  const { ok, hash } = roundTrip('unicode preservation');
  assert(ok, 'Round-trip clean: Unicode in labels (em-dash, ″, emoji, CJK) survives');
  // Sanity check: the encoded hash itself must be base64-url (no spaces / non-ASCII).
  assert(/^[A-Za-z0-9\-_]+$/.test(hash), 'Encoded hash is URL-safe ASCII (no spaces, no Unicode)');
}

// 3. Float precision — values that JSON-stringify could disturb.
applyTemplateToState('hifi');
state.room.width_m = 0.1 + 0.2;          // = 0.30000000000000004
state.listeners[0].position.x = 1e-9;
state.physics.eq.bands[5].gain_db = -3.5;
{
  const { ok } = roundTrip('float-precision torture');
  assert(ok, 'Round-trip clean: 0.1+0.2, 1e-9, -3.5 all survive');
}

// 4. Oversize fixture — pavilion preset is well over the URL cap.
applyPresetToState('pavilion');
{
  const { hash, tooLarge, chars } = encodeShareLink();
  assert(tooLarge === true, `Pavilion preset flagged tooLarge (chars=${chars}, max=${SHARE_LINK_MAX_CHARS})`);
  // Even when oversized, the hash must still decode losslessly when used
  // (some browsers DO accept long URLs). Don't truncate silently.
  const before = snapshotState();
  decodeShareLink(hash);
  const after = snapshotState();
  assert(deepEqual(before, after), 'Oversize hash still decodes losslessly (no silent truncation)');
}

// 5. Garbage hash — every malformed input throws a CLEAR error AND does
//    NOT mutate state. The state-snapshot guard is essential because a
//    silent half-mutation would be the worst possible failure mode.
applyTemplateToState('hifi');
const pristine = snapshotState();
const garbageInputs = [
  'not-base64!@#',
  '',
  '#',
  'aGVsbG8gd29ybGQ',          // base64 of "hello world" → not JSON
  btoa(JSON.stringify(null)).replace(/=+$/, ''),     // valid base64 of null
  btoa(JSON.stringify({})).replace(/=+$/, ''),       // valid base64 of {} (no formatVersion)
  btoa(JSON.stringify({ formatVersion: 'one' })).replace(/=+$/, ''), // wrong type
  btoa(JSON.stringify({ formatVersion: 99 })).replace(/=+$/, ''),    // future version
];
for (const g of garbageInputs) {
  let threw = null;
  try {
    decodeShareLink(g);
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof Error && threw.message.length > 0,
    `Garbage hash rejected with clear error: "${g.slice(0, 30)}${g.length > 30 ? '…' : ''}" → ${threw?.message?.slice(0, 50)}`);
  const now = snapshotState();
  if (!deepEqual(now, pristine)) {
    console.log(`FAIL  Garbage hash mutated state: "${g.slice(0, 30)}"`);
    failed++;
  }
}

// 6. Truncated hash — chop chars off a valid encoding, must throw,
//    must not mutate state. Common real-world failure when a link is
//    copy-pasted across a line break.
applyTemplateToState('hifi');
const fresh = snapshotState();
const { hash: validHash } = encodeShareLink();
const truncated = validHash.slice(0, validHash.length - 10);
let truncThrew = null;
try { decodeShareLink(truncated); } catch (e) { truncThrew = e; }
assert(truncThrew instanceof Error, 'Truncated hash rejected with error');
assert(deepEqual(snapshotState(), fresh), 'Truncated hash did not mutate state');

// 7. Slimmed-subset whitelist — encoded payload must NOT carry
//    results.*, display.*, walkthrough state, or any '_'-prefixed key.
//    This test prevents the exact failure mode where a future field
//    addition silently bloats every shared URL with a 200 KB splGrid.
applyPresetToState('auditorium');
{
  const { hash } = encodeShareLink();
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(hash.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - hash.length % 4) % 4)), c => c.charCodeAt(0))
  );
  const parsed = JSON.parse(json);
  const allowedTopKeys = new Set([
    'formatVersion', 'meta', 'room', 'sources', 'selectedSpeakerUrl',
    'listeners', 'selectedListenerId', 'zones', 'selectedZoneId', 'physics',
  ]);
  const present = Object.keys(parsed);
  const unexpected = present.filter(k => !allowedTopKeys.has(k));
  assert(unexpected.length === 0,
    `Encoded payload top-level keys are whitelisted (no leakage of ${unexpected.join(', ') || 'none'})`);
  assert(!('results' in parsed), 'Encoded payload does NOT carry results.*');
  assert(!('display' in parsed), 'Encoded payload does NOT carry display.*');
  // Defense against a future engineer using "_priv" keys for cache.
  const underscoreKeys = present.filter(k => k.startsWith('_'));
  assert(underscoreKeys.length === 0,
    `Encoded payload has no underscore-prefixed keys (${underscoreKeys.join(', ') || 'none'})`);
}

// 8. buildShareUrl smoke — produces an absolute-looking URL with the hash.
{
  const url = buildShareUrl('abc123');
  assert(url.endsWith('#abc123'), `buildShareUrl appends '#<hash>': ${url}`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll share-link tests passed.');
