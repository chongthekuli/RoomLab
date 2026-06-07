// 3D render-loop pause/resume regression test (v=767, 2026-06-07).
//
// Pins the perf fix that PAUSES the WebGL render loop (animate →
// composer.render: SSAO + Bloom + SMAA + OutputPass) whenever the 2D
// view is active. On weak integrated GPUs that post-FX chain runs
// 30–80 ms/frame; left running behind a hidden 3D canvas it starved the
// 2D SVG editor and the custom-room coord-entry text input (keystrokes
// lagging by seconds). The fix gates the rAF chain on the active view:
//   - '2d'            → pauseAnimation()  (loop stops; budget freed)
//   - '3d' | 'walk'   → startAnimation()  (loop resumes + one repaint)
// Walk shares the 3D canvas (view='walk' maps to #view-3d), so it must
// keep the loop alive.
//
// Why text-grep instead of behavioural: animate() needs the full
// Three.js + WebGL + EffectComposer pipeline + a live DOM, none of which
// run under plain `node`. The bug surface this guards is "someone re-arms
// rAF unconditionally again, or drops the 2D pause / 3D resume wiring, or
// makes startAnimation() non-idempotent (double rAF chain)". A static
// regex audit pins every load-bearing site.
//
// Run: node tests/scene-loop-pause.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const scene = readFileSync('./js/graphics/scene.js', 'utf8');

// ---- 1. Loop-gating module state exists ---------------------------
ok(/let _rafId = null;/.test(scene),
   '_rafId module binding declared (in-flight rAF handle / null when stopped)');
ok(/let _loopPaused = false;/.test(scene),
   '_loopPaused module binding declared (2D-view pause flag)');

// ---- 2. animate() re-arm is GUARDED by the pause flag -------------
// The whole point: rAF must NOT be re-armed unconditionally any more.
// Slice from `function animate(ts) {` up to the start of `_renderOnce`
// (the next function), so the assertions below scan only animate()'s body.
const animStart = scene.indexOf('function animate(ts) {');
const animEnd = scene.indexOf('function _renderOnce()', animStart);
ok(animStart !== -1 && animEnd !== -1 && animEnd > animStart,
   'animate() function found (followed by _renderOnce())');
if (animStart !== -1 && animEnd > animStart) {
  const body = scene.slice(animStart, animEnd);
  ok(/if \(_loopPaused\) \{ _rafId = null; return; \}/.test(body),
     'animate(): bails (and nulls _rafId) when _loopPaused — chain unwinds, no render');
  ok(/_rafId = requestAnimationFrame\(animate\);/.test(body),
     'animate(): captures the rAF handle in _rafId (so pause can cancel it)');
  // Guard against regression to the old unconditional re-arm.
  ok(!/^\s*requestAnimationFrame\(animate\);\s*$/m.test(body),
     'animate(): no bare unconditional requestAnimationFrame(animate) re-arm');
}

// ---- 3. _renderOnce() — shared single render pass -----------------
ok(/function _renderOnce\(\) \{/.test(scene),
   '_renderOnce() exists (shared by animate + resume repaint)');
const renderOnce = scene.match(/function _renderOnce\(\) \{[\s\S]*?\n\}/);
ok(!!renderOnce && /composer\.render\(\);/.test(renderOnce[0]),
   '_renderOnce(): routes through composer.render() (SSAO+Bloom+SMAA chain)');

// ---- 4. startAnimation(): idempotent + clock reset + repaint ------
const startFn = scene.match(/function startAnimation\(\) \{[\s\S]*?\n\}/);
ok(!!startFn, 'startAnimation() exists');
if (startFn) {
  const b = startFn[0];
  ok(/_loopPaused = false;/.test(b),
     'startAnimation(): clears _loopPaused');
  ok(/if \(_rafId != null\) return;/.test(b),
     'startAnimation(): idempotent — no-op if a chain is already armed (no double rAF)');
  ok(/_lastFrameTs = now;/.test(b) && /tpLastTs = now;/.test(b),
     'startAnimation(): resets frame clocks so first dt isn\'t multi-second (avatar/wall teleport)');
  ok(/_renderOnce\(\);/.test(b),
     'startAnimation(): one immediate render so the scene isn\'t stale/black on resume');
  ok(/_rafId = requestAnimationFrame\(animate\);/.test(b),
     'startAnimation(): arms the rAF chain');
}

// ---- 5. pauseAnimation(): set flag + cancel pending frame ---------
const pauseFn = scene.match(/function pauseAnimation\(\) \{[\s\S]*?\n\}/);
ok(!!pauseFn, 'pauseAnimation() exists');
if (pauseFn) {
  const b = pauseFn[0];
  ok(/_loopPaused = true;/.test(b),
     'pauseAnimation(): sets _loopPaused');
  ok(/cancelAnimationFrame\(_rafId\);\s*_rafId = null;/.test(b),
     'pauseAnimation(): cancels the in-flight frame and nulls _rafId');
}

// ---- 6. viewport:tab-changed wires 2D=pause, 3D/walk=resume -------
const listener = scene.match(/document\.addEventListener\('viewport:tab-changed', e => \{[\s\S]*?\n  \}\);/);
ok(!!listener, "viewport:tab-changed listener found in scene.js");
if (listener) {
  const b = listener[0];
  ok(/if \(view === '2d'\) \{\s*pauseAnimation\(\);/.test(b),
     "tab-changed: view === '2d' → pauseAnimation()");
  ok(/\} else \{\s*\n\s*\/\/[\s\S]*?startAnimation\(\);/.test(b),
     "tab-changed: else branch ('3d' | 'walk') → startAnimation()");
  ok(/requestAnimationFrame\(onResize\);/.test(b),
     'tab-changed: still re-fits the renderer on 3D/walk (onResize)');
}

// ---- 7. Boot only starts the loop if #view-3d is visible ----------
// Default tab is 3D, but the boot path must gate on the live DOM so a
// future 2D-default or 2D deep-link doesn't burn the SSAO chain behind a
// hidden canvas.
ok(/getElementById\('view-3d'\)/.test(scene) &&
   /if \(view3dVisible\) startAnimation\(\);/.test(scene),
   'boot: startAnimation() only when #view-3d is visible (initial-state gate)');
ok(/else _loopPaused = true;/.test(scene),
   'boot: if 3D hidden on load, leave the loop paused (armed on demand by listener)');

console.log(failed === 0
  ? '\nAll scene loop-pause v=767 tests passed.'
  : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
