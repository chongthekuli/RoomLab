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
  // hifi default: 4.5 × 6 m + 2 m margin → 6.5 × 8 viewBox
  assert(Math.abs(w - 6.5) < 0.01, `hifi viewBox width (got ${w.toFixed(2)}, expected 6.5)`);
  assert(Math.abs(h - 8.0) < 0.01, `hifi viewBox height (got ${h.toFixed(2)}, expected 8.0)`);
}

// 3. Sources render as circles in the SVG.
applyTemplateToState('hifi');
{
  const svg = buildFloorPlanSVG(state);
  // hifi has 2 sources, each rendered as one circle.
  const circleCount = (svg.match(/<circle /g) || []).length;
  assert(circleCount >= 2, `hifi: ≥ 2 circles in SVG (got ${circleCount}; sources expected to render as circles)`);
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

// 6. Y-axis is flipped — depth = 6 m means a source at y=0.8 should
//    render at SVG-y ≈ depth - 0.8 + margin = 6.2.
applyTemplateToState('hifi');
state.sources = [
  { modelUrl: 'data/loudspeakers/generic-12inch.json', position: { x: 1, y: 0.8, z: 1 }, aim: { yaw: 0, pitch: 0, roll: 0 }, power_watts: 50, groupId: 'A' },
];
{
  const svg = buildFloorPlanSVG(state);
  // hifi default depth = 6, margin = 1 → expected SVG-y = 6 - 0.8 + 1 = 6.2
  // First circle should have cy near 6.2.
  const m = svg.match(/<circle cx="([^"]+)" cy="([^"]+)"/);
  assert(m, 'circle present');
  if (m) {
    const cy = parseFloat(m[2]);
    assert(Math.abs(cy - 6.2) < 0.01,
      `Y-flip: source at state-y=0.8 → SVG-y=6.2 (got ${cy.toFixed(3)})`);
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

// 10. North arrow + 'N' label present.
applyTemplateToState('hifi');
{
  const svg = buildFloorPlanSVG(state);
  assert(svg.includes('>N<'), 'north arrow has the N label');
}

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
