// Phase 7 Commit 4 — 2D viewport + print plan SVG wall thickness parity.
//
// Maya, 2026-05-23. Pins the visual layer so the wall-thickness story
// is end-to-end:
//
//   schema (Commit 1) → 3D mesh (Commit 2) → per-wall UI (Commit 3)
//     → 2D viewport + print plan (Commit 4, this test guards it).
//
// Sam's cross-surface fixture (tests/cross-surface-conventions.test.mjs)
// already hard-gates the imports + call-sites for wallInsetPolygon,
// getMaterialHatchKind, wallLabelAnchor, and WALL_LABEL_MAX_CHARS. THIS
// test adds the behavioural contract:
//
//   • room-2d.js + print-plan-svg.js consume the inset polygon AND the
//     hatch helper AND the label anchor for EACH wall edge.
//   • print-plan-svg.js produces SVG output containing the wall
//     trapezoids (filled with the hatch pattern) and the per-wall
//     material labels — verified by running buildFloorPlanSVG(state) on
//     a fixture state in Node.
//   • Hatch patterns emitted in the SVG are MONOCHROME — no
//     rgb(255,*,*), no `fill="red"`-style colour leakage. Fabricators
//     print on B&W office machines.
//   • Material label text never exceeds WALL_LABEL_MAX_CHARS (12).
//
// Grep style mirrors tests/wall-thickness-ui.test.mjs — the modules
// under test depend on DOM and Three.js at module load, so we can't
// import them directly in Node. The print SVG module IS pure, and we
// exercise it via buildFloorPlanSVG with the project's own state shim.
//
// Run: node tests/wall-thickness-2d-print.test.mjs

import { readFileSync } from 'node:fs';
import { state } from '../js/app-state.js';
import { buildFloorPlanSVG } from '../js/ui/print-plan-svg.js';
import { WALL_LABEL_MAX_CHARS } from '../js/physics/wall-inset.js';
import { getMaterialHatchKind } from '../js/labs/walllab/material-family-hatch.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

const room2dSrc = readFileSync('./js/graphics/room-2d.js', 'utf8');
const printSrc  = readFileSync('./js/ui/print-plan-svg.js', 'utf8');

// ===========================================================================
// (1) Both render files consume wallInsetPolygon per-edge.
// ===========================================================================

check('room-2d.js imports wallInsetPolygon from physics/wall-inset.js',
  /import\s*\{[^}]*\bwallInsetPolygon\b[^}]*\}\s*from\s*['"][^'"]*physics\/wall-inset(?:\.js)?['"]/.test(room2dSrc));
check('room-2d.js calls wallInsetPolygon(room)',
  /wallInsetPolygon\s*\(/.test(room2dSrc));
check('room-2d.js iterates the inset outer + inner per edge (for-loop walks both)',
  /projOuter|outer\.length/.test(room2dSrc));

check('print-plan-svg.js imports wallInsetPolygon from physics/wall-inset.js',
  /import\s*\{[^}]*\bwallInsetPolygon\b[^}]*\}\s*from\s*['"][^'"]*physics\/wall-inset(?:\.js)?['"]/.test(printSrc));
check('print-plan-svg.js calls wallInsetPolygon(room)',
  /wallInsetPolygon\s*\(/.test(printSrc));

// ===========================================================================
// (2) Both render files import + call getMaterialHatchKind.
// ===========================================================================

check('room-2d.js imports getMaterialHatchKind from material-family-hatch.js',
  /import\s*\{[^}]*\bgetMaterialHatchKind\b[^}]*\}\s*from\s*['"][^'"]*walllab\/material-family-hatch(?:\.js)?['"]/.test(room2dSrc));
check('room-2d.js calls getMaterialHatchKind() on a wall material',
  /getMaterialHatchKind\s*\(/.test(room2dSrc));

check('print-plan-svg.js imports getMaterialHatchKind from material-family-hatch.js',
  /import\s*\{[^}]*\bgetMaterialHatchKind\b[^}]*\}\s*from\s*['"][^'"]*walllab\/material-family-hatch(?:\.js)?['"]/.test(printSrc));
check('print-plan-svg.js calls getMaterialHatchKind() on a wall material',
  /getMaterialHatchKind\s*\(/.test(printSrc));

// ===========================================================================
// (3) Both render files use wallLabelAnchor for label position.
// ===========================================================================

check('room-2d.js imports wallLabelAnchor + WALL_LABEL_MAX_CHARS',
  /\bwallLabelAnchor\b/.test(room2dSrc) && /\bWALL_LABEL_MAX_CHARS\b/.test(room2dSrc));
check('room-2d.js calls wallLabelAnchor() to position the wall label',
  /wallLabelAnchor\s*\(/.test(room2dSrc));

check('print-plan-svg.js imports wallLabelAnchor + WALL_LABEL_MAX_CHARS',
  /\bwallLabelAnchor\b/.test(printSrc) && /\bWALL_LABEL_MAX_CHARS\b/.test(printSrc));
check('print-plan-svg.js calls wallLabelAnchor() to position the wall label',
  /wallLabelAnchor\s*\(/.test(printSrc));

// ===========================================================================
// (4) Anti-leak — no inline family-bucket branching on materialId in the
//     renderer files. The whole point of material-family-hatch.js is one
//     resolution; if a renderer re-implements the if/else, the helper
//     can desync silently. Trip the gate on patterns that look like an
//     inline materialId → family branch.
// ===========================================================================

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/[ \t]+\/\/.*$/gm, '');
}
const room2dCode = stripComments(room2dSrc);
const printCode  = stripComments(printSrc);
const inlineFamilyPatterns = [
  /materialId\s*===\s*['"]concrete-painted['"]/,
  /materialId\s*===\s*['"]gypsum-board['"]/,
  /materialId\s*===\s*['"]glass-window['"]/,
  /\.startsWith\(['"]concrete['"]\)/,
  /\.startsWith\(['"]gypsum['"]\)/,
];
let inlineLeak2d = false, inlineLeakPrint = false;
for (const p of inlineFamilyPatterns) {
  if (p.test(room2dCode)) inlineLeak2d = true;
  if (p.test(printCode))  inlineLeakPrint = true;
}
check('room-2d.js does not inline materialId-family branching (routes via helper)',
  !inlineLeak2d);
check('print-plan-svg.js does not inline materialId-family branching (routes via helper)',
  !inlineLeakPrint);

// ===========================================================================
// (5) Behavioural — buildFloorPlanSVG output carries the wall trapezoids
//     AND the material labels. Use a fixture state where every wall has
//     a known material (rectangular, gypsum on all four sides).
// ===========================================================================

state.room = {
  name: 'WALL THICKNESS FIXTURE',
  shape: 'rectangular',
  width_m: 5,
  depth_m: 4,
  height_m: 3,
  ceiling_type: 'flat',
  surfaces: {
    floor: 'gypsum-board',
    ceiling: 'gypsum-board',
    // mixed materials so we exercise multiple hatch buckets in one SVG.
    wall_north: { materialId: 'concrete-painted', thickness_m: 0.20, openings: [] },
    wall_east:  { materialId: 'gypsum-board',     thickness_m: 0.10, openings: [] },
    wall_south: { materialId: 'glass-window',     thickness_m: 0.04, openings: [] },
    wall_west:  { materialId: 'open-air',         thickness_m: 0.10, openings: [] },
  },
  custom_vertices: null,
  subStructures: [],
  standaloneEnclosures: [],
  wallSegments: [],
};
state.sources = [];
state.listeners = [];
state.zones = [];
state.treatments = [];
state.results = { splGrid: null };

const svg = buildFloorPlanSVG(state);
check('buildFloorPlanSVG returns a non-empty string for the fixture room',
  typeof svg === 'string' && svg.length > 0);

// The hatch defs block exists.
check('print SVG carries the hatch <defs> block (pr-hatch-* patterns)',
  /<pattern id="pr-hatch-solid-dark"/.test(svg) &&
  /<pattern id="pr-hatch-diagonal"/.test(svg));

// Wall trapezoids — at least one <polygon fill="url(#pr-hatch-...)"> per
// non-open-air wall. The fixture has 3 drawable walls (north concrete,
// east gypsum, south glass) + west open-air (skipped).
const wallPolyMatches = svg.match(/<polygon[^>]*fill="url\(#pr-hatch-[^)]+\)"/g) || [];
check('print SVG emits ≥3 wall trapezoids (concrete + gypsum + glass — open-air skipped)',
  wallPolyMatches.length >= 3, `found ${wallPolyMatches.length}`);

// Each family used in the fixture appears in the output.
check('print SVG uses the solid-dark hatch for the concrete wall',
  /fill="url\(#pr-hatch-solid-dark\)"/.test(svg));
check('print SVG uses the diagonal-hatch for the gypsum wall',
  /fill="url\(#pr-hatch-diagonal\)"/.test(svg));
check('print SVG uses the outline-only hatch for the glass wall',
  /fill="url\(#pr-hatch-outline\)"/.test(svg));

// Open-air wall is NOT drawn — no openair-hatch polygon should appear
// for it. The pattern def is harmlessly defined (we ship it but skip
// the draw); guard that no wall polygon REFERENCES it.
check('print SVG does NOT emit a wall polygon for the open-air slot',
  !/<polygon[^>]*fill="url\(#pr-hatch-openair\)"/.test(svg));

// ===========================================================================
// (6) Material labels — every drawn wall carries a label inside the
//     room, anchored via wallLabelAnchor, truncated to
//     WALL_LABEL_MAX_CHARS.
// ===========================================================================

// The label text is one of the four wall material names; we don't have
// materialsRef in the test fixture (opts.materialsRef defaulted null),
// so nameOfPrint returns the materialId. Each label is therefore the
// raw materialId.
const labelRe = /<text[^>]*transform="rotate\([^)]+\)"[^>]*>([^<]+)<\/text>/g;
const labelMatches = [...svg.matchAll(labelRe)].map(m => m[1]);
check('print SVG emits per-wall rotated <text> labels (one per drawn wall)',
  labelMatches.length >= 3, `found ${labelMatches.length} → ${JSON.stringify(labelMatches)}`);

// Every label text is ≤ WALL_LABEL_MAX_CHARS.
let allTruncated = true;
let longestLabel = '';
for (const t of labelMatches) {
  if (t.length > WALL_LABEL_MAX_CHARS) {
    allTruncated = false;
    if (t.length > longestLabel.length) longestLabel = t;
  }
}
check(`every wall material label is truncated to ≤ ${WALL_LABEL_MAX_CHARS} chars`,
  allTruncated, longestLabel ? `longest = "${longestLabel}" (${longestLabel.length} chars)` : '');

// Truncation actually applies — fixture has a 17-char materialId
// (concrete-painted) that MUST come out clipped.
const concreteLabel = labelMatches.find(t => t.startsWith('concrete'));
check('17-char materialId "concrete-painted" was truncated by the renderer',
  !!concreteLabel && concreteLabel.length === WALL_LABEL_MAX_CHARS,
  concreteLabel ? `got "${concreteLabel}" (${concreteLabel.length} chars)` : 'no concrete label found');

// ===========================================================================
// (7) Monochrome safety — no colour leakage in the hatch defs OR in any
//     wall polygon stroke. Grep for warm/saturated colours that
//     wouldn't survive B&W print. Black, dark greys, mid greys are
//     allowed; pure white is allowed (background); transparent ditto.
// ===========================================================================

// Extract just the hatch defs block so we don't false-positive on
// listener / source / minaret fills elsewhere in the SVG.
const defsMatch = svg.match(/<defs>([\s\S]*?)<\/defs>/);
const hatchBlock = defsMatch ? defsMatch[1] : '';

// Greyscale = R == G == B. Allow #fff / #ffffff (white = paper) and
// any equal-channel hex. Flag any hex/rgb where channels differ.
function looksNonGrey(hex) {
  if (!hex) return false;
  // Named colours that aren't grey/white/black.
  if (/^(red|blue|green|orange|cyan|magenta|yellow|purple|pink|brown)$/i.test(hex)) return true;
  // 3-digit hex (#rgb expanded).
  let m = hex.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) return !(m[1].toLowerCase() === m[2].toLowerCase() && m[2].toLowerCase() === m[3].toLowerCase());
  // 6-digit hex (#rrggbb).
  m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) return !(m[1].toLowerCase() === m[2].toLowerCase() && m[2].toLowerCase() === m[3].toLowerCase());
  // rgb(r, g, b) / rgba(r, g, b, a).
  m = hex.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (m) return !(m[1] === m[2] && m[2] === m[3]);
  return false;
}

let leakedDef = null;
const allDefFills = [...hatchBlock.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map(m => m[1]);
for (const c of allDefFills) {
  if (c === 'none') continue;
  if (looksNonGrey(c)) { leakedDef = c; break; }
}
check('hatch <defs> block is monochrome (no pure RGB / named colour fills)',
  leakedDef === null,
  leakedDef ? `found "${leakedDef}" — must stay greyscale for B&W print` : '');

// Wall polygon strokes — same greyscale constraint.
const wallStrokes = [...svg.matchAll(/<polygon[^>]*fill="url\(#pr-hatch-[^)]+\)"[^>]*stroke="([^"]+)"/g)].map(m => m[1]);
let strokeLeak = null;
for (const s of wallStrokes) {
  if (looksNonGrey(s)) { strokeLeak = s; break; }
}
check('wall polygon strokes are monochrome (greyscale only)',
  strokeLeak === null,
  strokeLeak ? `found "${strokeLeak}" — wall outlines must stay greyscale` : '');

// ===========================================================================
// (8) Cross-surface bucket consistency — the helper used by both
//     renderers returns the same locked vocabulary. Re-check at runtime
//     so a future drive-by rename of a bucket trips this test too (Sam's
//     cross-surface fixture greps the source; this exercises behaviour).
// ===========================================================================

const HATCH_BUCKETS = new Set(['solid-dark', 'diagonal-hatch', 'outline-only', 'open-air', 'unknown']);
const probes = [
  'concrete-painted', 'gypsum-board', 'glass-window', 'open-air',
  'not-a-real-material-id-12345', null, undefined, '',
];
let bucketsOk = true;
let outlier = '';
for (const id of probes) {
  const k = getMaterialHatchKind(id);
  if (!HATCH_BUCKETS.has(k)) {
    bucketsOk = false; outlier = `${JSON.stringify(id)} → ${JSON.stringify(k)}`; break;
  }
}
check('getMaterialHatchKind returns a value from the locked 5-bucket vocabulary for every probe',
  bucketsOk, outlier);

// ===========================================================================
// Final tally
// ===========================================================================

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
