// Floor-plan SVG generator tests.
//
// SVG output is a string — we verify shape (well-formed root, viewBox
// matches room dims, expected elements present) without invoking a
// headless browser.
//
// Run: node tests/print-plan.test.mjs

import {
  state, applyPresetToState, applyTemplateToState, PRESETS, TEMPLATES,
} from '../js/app-state.js';
import { buildFloorPlanSVG, buildFloorPlanLegend } from '../js/ui/print-plan-svg.js';

let failed = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// 1. Every preset / template produces non-empty, well-formed SVG.
for (const k of Object.keys(PRESETS)) {
  applyPresetToState(k);
  const svg = buildFloorPlanSVG(state);
  assert(svg.length > 0, `preset:${k}: SVG produced (${svg.length} chars)`);
  assert(svg.startsWith('<svg'), `preset:${k}: SVG opens with <svg`);
  assert(svg.endsWith('</svg>'), `preset:${k}: SVG closes with </svg>`);
  assert(/viewBox="[^"]+"/.test(svg), `preset:${k}: SVG has viewBox attribute`);
  assert(svg.includes('xmlns="http://www.w3.org/2000/svg"'), `preset:${k}: SVG has xmlns`);
}
for (const k of Object.keys(TEMPLATES)) {
  applyTemplateToState(k);
  const svg = buildFloorPlanSVG(state);
  assert(svg.length > 0, `template:${k}: SVG produced (${svg.length} chars)`);
  assert(svg.startsWith('<svg'), `template:${k}: SVG opens with <svg`);
}

// 2. ViewBox dimensions match the room bbox + 2 m margin.
applyTemplateToState('hifi');
{
  const svg = buildFloorPlanSVG(state);
  const m = svg.match(/viewBox="(\S+) (\S+) (\S+) (\S+)"/);
  assert(m && m[1] === '0' && m[2] === '0', 'viewBox starts at 0 0');
  const w = parseFloat(m[3]);
  const h = parseFloat(m[4]);
  // hifi default: 4.5 × 6 m + 3 m margin (1.5 each side) → 7.5 × 9 viewBox
  assert(Math.abs(w - 7.5) < 0.01, `hifi viewBox width (got ${w.toFixed(2)}, expected 7.5)`);
  assert(Math.abs(h - 9.0) < 0.01, `hifi viewBox height (got ${h.toFixed(2)}, expected 9.0)`);
}

// 3. Sources render as aim-direction triangles (polygons) in the SVG.
//    Switched from <circle> 2026-05 — see print-plan-svg.js:197 (sources
//    now use aimTrianglePoints to mirror the live 2D viewport convention
//    "sources radiate, listeners receive"). Listeners still render as
//    <circle>, so the polygon count is the source-shape signal.
applyTemplateToState('hifi');
{
  const svg = buildFloorPlanSVG(state);
  // hifi has 2 sources, each rendered as one <polygon> triangle.
  const polyCount = (svg.match(/<polygon points="/g) || []).length;
  assert(polyCount >= 2, `hifi: ≥ 2 source polygons in SVG (got ${polyCount}; sources render as triangles per print-plan-svg.js:197)`);
}

// 4. Listeners render as triangles (polygons with 3 points + green fill).
applyTemplateToState('hifi');
{
  const svg = buildFloorPlanSVG(state);
  assert(/fill="#0a8a4a"/.test(svg), 'listener triangles use the listener-green fill');
}

// 5. Zones render — chamber template has 5 zones, expect 5 zone polygons.
applyTemplateToState('chamber');
{
  const svg = buildFloorPlanSVG(state);
  // Each zone uses fill-opacity="0.18" — count those.
  const zoneFills = (svg.match(/fill-opacity="0\.18"/g) || []).length;
  assert(zoneFills === 5, `chamber: 5 zone polygons (got ${zoneFills})`);
}

// 6. Y-axis is flipped — depth = 6 m means a listener at y=2.802 should
//    render at SVG-y = anchorY - 2.802 = (1.5 + 6) - 2.802 = 4.698 with
//    the standard 1.5m margin.
//
//    Switched from asserting the source position (sources are now
//    <polygon> triangles whose first vertex is the aim apex, not the
//    centroid — see print-plan-svg.js:197 + aimTrianglePoints). The
//    listener stays as <circle>, so its cy is the stable Y-flip signal.
applyTemplateToState('hifi');
// Pin the listener at a known fraction so the math doesn't drift if
// the hifi template later changes its listener position.
state.listeners = [
  { id: 'L1', label: 'Listener 1', position: { x: 2.25, y: 6 * 0.467 }, posture: 'sitting_chair', custom_ear_height_m: null },
];
{
  const svg = buildFloorPlanSVG(state);
  // hifi default depth = 6, margin = 1.5 → anchorY = 7.5
  // Listener at y=2.802 → expected SVG-y = 7.5 - 2.802 = 4.698
  const m = svg.match(/<circle cx="([^"]+)" cy="([^"]+)" r="[^"]+" fill="#0a8a4a"/);
  assert(m, 'listener circle present (green fill marker)');
  if (m) {
    const cy = parseFloat(m[2]);
    const expected = 7.5 - 6 * 0.467;
    assert(Math.abs(cy - expected) < 0.01,
      `Y-flip: listener at state-y=${(6 * 0.467).toFixed(3)} → SVG-y=${expected.toFixed(3)} (got ${cy.toFixed(3)})`);
  }
}

// 7. Empty room (no width / depth) returns empty string, no crash.
{
  const fakeState = { room: { shape: 'rectangular', width_m: 0, depth_m: 0 } };
  const svg = buildFloorPlanSVG(fakeState);
  assert(svg === '', `degenerate room → empty SVG (got "${svg.slice(0, 30)}")`);
}

// 8. Custom-vertex room renders as a polygon outline.
applyTemplateToState('hifi');
state.room.shape = 'custom';
state.room.custom_vertices = [
  { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }, { x: 2.5, y: 3 }, { x: 2.5, y: 5 }, { x: 0, y: 5 },
];
state.room.width_m = 5;
state.room.depth_m = 5;
{
  const svg = buildFloorPlanSVG(state);
  assert(svg.includes('<polygon points="'), 'custom shape renders as <polygon>');
}

// 9. Scale bar is one of the "nice" lengths (0.5, 1, 2, 5, 10, 20, 50).
applyPresetToState('auditorium');
{
  const svg = buildFloorPlanSVG(state);
  // The scale label is a `<text>` near the scale bar with content "X m".
  const m = svg.match(/text-anchor="middle"[^>]*>(\S+) m</);
  assert(m, 'scale-bar label present');
  if (m) {
    const v = parseFloat(m[1]);
    const niceVals = [0.5, 1, 2, 5, 10, 20, 50];
    assert(niceVals.includes(v), `scale-bar length is in nice-set (got ${v})`);
  }
}

// 10. North arrow coverage — REMOVED 2026-05.
//
//    The N arrow used to live inside the SVG but scaled with the room
//    (large room -> tiny arrow). It now lives as a fixed-CSS-pixel HTML
//    overlay rendered by print containers (see print-plan-svg.js:280-283
//    + .pr-cover-hero-plan::after / .pr-heatmap-stage::after in
//    print.css). The pure-SVG generator no longer emits an 'N' glyph.
//
//    TODO: re-add a north-arrow assertion when print smoke tests exist
//    that exercise the full HTML container (DOM-driven, not pure-SVG).

// 11. Legend renders with the three symbol rows.
{
  const html = buildFloorPlanLegend();
  assert(html.includes('Source'), 'legend has Source row');
  assert(html.includes('Listener'), 'legend has Listener row');
  assert(html.includes('Audience zone'), 'legend has Audience zone row');
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll print-plan tests passed.');
