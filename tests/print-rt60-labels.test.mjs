// Regression — bug 2026-05-21 (user-reported):
//
//   "In the generated report, for the reverb graph, only show the plotted
//    parameter value for T30. I see there is a parameter value shown on
//    (not sure eyring or sabine), remove it."
//
// The RT60 chart printed numeric value labels on the EYRING series. The
// user wants them on the ray-traced T30 line (the ground-truth series),
// removed from Eyring. Ruling: label T30; OMIT below-Schroeder T30 labels
// (modal/unreliable — a printed number reads as precision regardless of
// tint, Dr. Chen); fall back to Eyring labels only when there is no
// precision data at all (statistical-only report); name the labelled
// series in the caption so it's never ambiguous.
//
// renderRT60Chart is an internal (non-exported) function, so this guards
// the label-placement contract by source text-grep — same convention as
// tests/scene-x-mirror.test.mjs and tests/heatmap-shader-orientation.test.mjs.
//
// Run: node tests/print-rt60-labels.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : (e ? '  — ' + e : '')}`); if (!c) failed++; };

const src = readFileSync('./js/ui/print-report.js', 'utf8');

// Isolate renderRT60Chart so we don't match the Chapter-04 compare chart.
const fn = src.match(/function renderRT60Chart\([\s\S]*?\n\}/);
ok(!!fn, 'renderRT60Chart function found');
const body = fn ? fn[0] : '';

// (1) T30 points carry their value `v` (needed to print the label).
ok(/const t30Pts = t30\.map\([\s\S]*?x: xOf\(i\), y: yOf\(v\), v,/.test(body),
   'T30 points carry their value v (so the label can be printed)');

// (2) A t30Labels block exists and OMITS below-Schroeder points.
ok(/const t30Labels =/.test(body),
   't30Labels block exists (value labels ride the T30 line)');
ok(/t30Pts\.filter\(p => p && !p\.belowFs\)/.test(body),
   't30Labels OMITS below-Schroeder points (filter !p.belowFs) — no false-precision number in the modal region');

// (3) Eyring labels are now a FALLBACK ONLY — gated on !hasT30.
ok(/const hasT30 = t30Pts\.some\(p => p\)/.test(body),
   'hasT30 flag detects whether the precision pass covered any band');
ok(/const eyringLabels = hasT30 \? '' :/.test(body),
   'Eyring value labels are suppressed when T30 exists, kept only as the no-precision fallback');

// (4) The SVG paints t30Labels.
ok(/\$\{t30Labels\}/.test(body),
   'renderRT60Chart SVG output includes ${t30Labels}');

// (5) The caption names which series carries the numbers (never ambiguous).
ok(/labelledSeries\s*=\s*rayT30Means\.some\(v => Number\.isFinite\(v\)\)/.test(src),
   'caption derives labelledSeries from whether any ray-traced T30 band exists');
ok(/label \$\{labelledSeries\}/.test(src),
   'caption states which curve the plotted numeric values label');

console.log(failed === 0
  ? '\nAll RT60 label-placement tests passed.'
  : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
