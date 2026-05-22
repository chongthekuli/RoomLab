// Top-down roof-dim line-hiding regression (v=596, 2026-05-22).
//
// Bug: in Top camera view, _setRoofsDimmedForTopDown hides overhead
// roof FACES (THREE.Mesh) so the floor heatmap reads cleanly — but its
// traversal filter was `if (!obj.isMesh ...) return`, which skipped
// THREE.Line geometry. The surau hip-roof / atap-tumpang RIDGE lines
// are Lines, so they stayed drawn and floated over the heatmap as a
// dark corner-to-corner "X", which users mistook for a heatmap feature
// / sound leak. (Viktor diagnosis 2026-05-22.)
//
// Fix: broaden the filter to also catch obj.isLine / obj.isLineSegments.
// Floor-level reference lines (room outline) remain protected by the
// existing height gate (bb.min.y < TOPDOWN_DIM_FLOOR_Z), NOT the type
// filter — so they must NOT be hidden.
//
// Why text-grep: scene.js needs the full Three.js + WebGL pipeline to
// run; not Node-importable (same constraint as scene-x-mirror.test.mjs).
// The regression surface is "someone narrows the filter back to
// isMesh-only and the ridge X returns."
//
// Run: node tests/topdown-roof-dim.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const scene = readFileSync('./js/graphics/scene.js', 'utf8');

// Isolate the _setRoofsDimmedForTopDown function body.
const fn = scene.match(/function _setRoofsDimmedForTopDown[\s\S]*?\n\}/);
ok(!!fn, '_setRoofsDimmedForTopDown exists');

if (fn) {
  const body = fn[0];

  // 1. The traversal must consider line geometry, not meshes only.
  ok(/obj\.isLine\b/.test(body),
     'dim pass tests obj.isLine (overhead roof ridge strokes get hidden)');

  // 2. Must NOT have reverted to a mesh-only early-return that bypasses
  //    lines. Guard against the exact old filter coming back.
  ok(!/if\s*\(\s*!obj\.isMesh\s*\|\|\s*!obj\.geometry\s*\)\s*return\s*;/.test(body),
     'dim pass does NOT use the old isMesh-only filter');

  // 3. The floor-height gate must still be present so floor-level lines
  //    (room outline) are protected from being hidden.
  ok(/bb\.min\.y\s*<\s*TOPDOWN_DIM_FLOOR_Z/.test(body),
     'floor-height gate still protects floor-level reference lines');
}

if (failed > 0) {
  console.log(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll top-down roof-dim tests passed.');
