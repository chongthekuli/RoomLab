// Regression test for js/labs/furniturelab/reliability-colors.js
//
// Locks the colour-tier contract that drives the FurnitureLAB
// confidence overlay (Carmen's wedge). Five consumers read this helper
// (2D viewport, 3D viewport, print BoM, sidebar legend, in-viewport
// legend chip) — if a tier swatch or fallback semantics drift, the
// "green = measured / amber = derived / red = estimated" semantic
// breaks across surfaces. This test is the tripwire.

import { colorForReliability, reliabilityLegendRows } from '../js/labs/furniturelab/reliability-colors.js';
import assert from 'node:assert/strict';

let failed = 0;
function check(cond, label) {
  if (cond) console.log(`PASS  ${label}`);
  else { console.log(`FAIL  ${label}`); failed++; }
}

// --- Shape per tier ----------------------------------------------------
const TIERS = ['measured', 'derived', 'estimated'];
for (const tier of TIERS) {
  const c = colorForReliability(tier);
  check(typeof c.fill === 'string' && c.fill.startsWith('rgba('),
    `colorForReliability("${tier}").fill is an rgba() string`);
  check(typeof c.stroke === 'string' && c.stroke.startsWith('rgba('),
    `colorForReliability("${tier}").stroke is an rgba() string`);
  check(typeof c.label === 'string' && c.label.length > 0,
    `colorForReliability("${tier}").label is a non-empty string`);
  check(typeof c.hexInt === 'number' && Number.isInteger(c.hexInt) && c.hexInt >= 0 && c.hexInt <= 0xFFFFFF,
    `colorForReliability("${tier}").hexInt is a valid 24-bit colour int (drives 3D MeshStandardMaterial.color)`);
  check(typeof c.swatchHex === 'string' && /^#[0-9A-F]{6}$/i.test(c.swatchHex),
    `colorForReliability("${tier}").swatchHex is a #RRGGBB string`);
}

// --- Fallback semantics ------------------------------------------------
// Unknown / missing / null input must fall back — never throw, never
// return null. A broken catalogue row would otherwise paint nothing
// and the placed object would render invisible.
const fallback = colorForReliability('unknown');
const fallbackByNull = colorForReliability(null);
const fallbackByUndef = colorForReliability(undefined);
const fallbackByGarbage = colorForReliability('not-a-tier');
check(fallback === fallbackByNull && fallback === fallbackByUndef && fallback === fallbackByGarbage,
  'null / undefined / unknown / garbage input all return the SAME fallback object');
check(fallback.label === 'Unknown',
  'fallback label is "Unknown"');

// --- Visual distinguishability ------------------------------------------
// The three tiers must have visibly distinct hexInts — if measured and
// estimated collided, the overlay would be meaningless. Cheap distance
// check on the RGB ints (any pair separated by >=64 in any channel).
function rgb(int) { return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff]; }
function maxChannelDelta(a, b) {
  const ra = rgb(a), rb = rgb(b);
  return Math.max(...ra.map((v, i) => Math.abs(v - rb[i])));
}
const m = colorForReliability('measured').hexInt;
const d = colorForReliability('derived').hexInt;
const e = colorForReliability('estimated').hexInt;
check(maxChannelDelta(m, d) >= 32, `measured vs derived: distinct (max-channel-delta=${maxChannelDelta(m, d)})`);
check(maxChannelDelta(d, e) >= 32, `derived vs estimated: distinct (max-channel-delta=${maxChannelDelta(d, e)})`);
check(maxChannelDelta(m, e) >= 32, `measured vs estimated: distinct (max-channel-delta=${maxChannelDelta(m, e)})`);

// --- Legend ordering ----------------------------------------------------
// The legend rows are rendered in fixed order — best evidence at the
// top so the user reads top-to-bottom from "trust" to "doubt".
const rows = reliabilityLegendRows();
check(Array.isArray(rows) && rows.length === 3,
  'reliabilityLegendRows returns 3 rows');
check(rows[0]?.tier === 'measured' && rows[1]?.tier === 'derived' && rows[2]?.tier === 'estimated',
  'legend tier order is measured → derived → estimated (top-to-bottom = best-to-worst)');
for (const row of rows) {
  check(typeof row.label === 'string' && row.label.length > 0
        && typeof row.swatchHex === 'string' && /^#[0-9A-F]{6}$/i.test(row.swatchHex),
    `legend row "${row.tier}" carries label + valid swatchHex`);
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll reliability-colors tests passed.');
