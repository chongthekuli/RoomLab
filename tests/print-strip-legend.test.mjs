// Print heatmap STRIP legend — edge-label clipping regression.
//
// Bug (reported 2026-06-04, report page 2 coverage map): the shared-scale
// strip legend centred every tick label on its tick via translateX(-50%).
// The FIRST (60 dB) and LAST (100 dB) ticks sit on the bar ends (left:0% /
// left:100%), so the centred label overflowed the legend edge and the print
// clipped it — "60 dB" rendered as "dB" and "100 dB" as "100".
//
// Fix: the builder tags the first/last labelled ticks with
// pr-strip-legend-tick--first / --last; print.css anchors the first label
// left-aligned and the last right-aligned (tick LINE stays on the bar end).
// The full label text is ALWAYS in the markup — the clip was purely visual —
// so here we guard the structural tripwire (edge classes present, labels
// intact, interior ticks unaffected).
//
// Run: node tests/print-strip-legend.test.mjs

import { buildHeatmapStripLegend, buildHeatmapLegend } from '../js/ui/print-heatmap.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const html = buildHeatmapStripLegend({ minDb: 60, maxDb: 100, stepDb: 5 });

// Pull out the labelled tick blocks in document order.
const tickBlocks = [...html.matchAll(/<div class="pr-strip-legend-tick(?! minor)([^"]*)"[^>]*>([\s\S]*?)<\/div>/g)]
  .map(m => ({ cls: m[1], inner: m[2] }))
  .filter(b => /pr-strip-legend-tick-label/.test(b.inner)); // labelled majors only

assert(tickBlocks.length >= 3, `strip legend emits multiple labelled ticks (got ${tickBlocks.length})`);

const firstTick = tickBlocks[0];
const lastTick = tickBlocks[tickBlocks.length - 1];

// 1. End ticks carry the edge modifier so CSS can anchor their labels inside.
assert(/pr-strip-legend-tick--first/.test(firstTick.cls),
  'first labelled tick carries pr-strip-legend-tick--first');
assert(/pr-strip-legend-tick--last/.test(lastTick.cls),
  'last labelled tick carries pr-strip-legend-tick--last');

// 2. Full label text is present in the DOM for BOTH end ticks (never truncated).
assert(/>\s*60 dB\s*</.test(firstTick.inner),
  'first tick label is the full "60 dB" (number + unit), not just "dB"');
assert(/>\s*100 dB\s*</.test(lastTick.inner),
  'last tick label is the full "100 dB" (number + unit), not just "100"');

// 3. Interior ticks are NOT tagged as edges (only the two ends shift).
const interior = tickBlocks.slice(1, -1);
assert(interior.length > 0 && interior.every(b => !/--first|--last/.test(b.cls)),
  'interior ticks carry no edge modifier (centred as before)');
// Spot-check an interior label still renders "number dB".
assert(interior.some(b => /\d+ dB</.test(b.inner)),
  'interior ticks still render "<n> dB" labels');

// --- buildHeatmapLegend (single-map path) shares the same edge fix ---
{
  const lhtml = buildHeatmapLegend({ minSPL_db: 72, maxSPL_db: 106, metric: 'spl' });
  const blocks = [...lhtml.matchAll(/<div class="pr-heatmap-legend-tick(?! minor)([^"]*)"[^>]*>([\s\S]*?)<\/div>/g)]
    .map(m => ({ cls: m[1], inner: m[2] }))
    .filter(b => /pr-heatmap-legend-tick-label/.test(b.inner));
  assert(blocks.length >= 3, `single-map legend emits multiple labelled ticks (got ${blocks.length})`);
  assert(/pr-heatmap-legend-tick--first/.test(blocks[0].cls),
    'single-map legend: first tick carries --first edge modifier');
  assert(/pr-heatmap-legend-tick--last/.test(blocks[blocks.length - 1].cls),
    'single-map legend: last tick carries --last edge modifier');
  assert(blocks.slice(1, -1).every(b => !/--first|--last/.test(b.cls)),
    'single-map legend: interior ticks carry no edge modifier');
}

if (failed > 0) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll print strip-legend tests passed.');
