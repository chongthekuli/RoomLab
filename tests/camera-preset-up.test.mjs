// Camera preset .up regression test (v=529, 2026-05-19).
//
// Pins the Top-camera 180°-rotation fix. Before this fix:
//   - Top preset used the default camera.up = (0,1,0).
//   - Three.js lookAt with eye straight above target and up=(0,1,0)
//     is a near-degenerate case: it yields camera-right = world +X
//     and camera-up = world -Z.
//   - Combined with the v=504 scene.scale.x = -1 global mirror, this
//     flipped BOTH state-X and state-Y on screen relative to the 2D
//     viewport (visible as a 180° rotation in Top view).
//
// Fix: every preset now returns an `up` field. Top uses (0,0,1) so
// camera-right re-derives to world -X (state +x → screen-RIGHT) and
// camera-up = world +Z (state +y / north → screen-UP). Every other
// preset returns (0,1,0) explicitly so a Top → iso switch doesn't
// leave the up-vector contaminated.
//
// applyCameraPreset() and the capture path both apply .up BEFORE
// the lookAt / tween so OrbitControls and the off-screen renderer
// see the correct basis. Capture path stashes + restores prevCamUp
// so a print/capture from Top doesn't corrupt the interactive view.
//
// Why text-grep instead of behavioural: _cameraPresetTransform is
// not exported and the failure mode is "someone removes the up
// field from one preset and silently re-introduces the 180° flip."
// Static regex audit catches that on the next commit. The numeric
// counterpart will land in tests/cross-surface-conventions.test.mjs
// once the live camera.matrixWorld for Top has been captured.
//
// Run: node tests/camera-preset-up.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const scene = readFileSync('./js/graphics/scene.js', 'utf8');

// ---- 1. _cameraPresetTransform: top branch returns up = (0,0,1) ---
const presets = scene.match(/function _cameraPresetTransform[\s\S]*?^\}/m);
ok(!!presets, '_cameraPresetTransform exists');
if (presets) {
  const body = presets[0];

  ok(/case 'top':[\s\S]*?up: new THREE\.Vector3\(0,\s*0,\s*1\)/.test(body),
     "Top preset returns up = (0, 0, 1) — world +Z (north → screen-UP)");

  ok(/case 'front':[\s\S]*?up: new THREE\.Vector3\(0,\s*1,\s*0\)/.test(body),
     "Front preset returns up = (0, 1, 0) — world +Y (vertical → screen-UP)");

  ok(/case 'back':[\s\S]*?up: new THREE\.Vector3\(0,\s*1,\s*0\)/.test(body),
     'Back preset returns up = (0, 1, 0)');

  ok(/case 'left':[\s\S]*?up: new THREE\.Vector3\(0,\s*1,\s*0\)/.test(body),
     'Left preset returns up = (0, 1, 0)');

  ok(/case 'right':[\s\S]*?up: new THREE\.Vector3\(0,\s*1,\s*0\)/.test(body),
     'Right preset returns up = (0, 1, 0)');

  // The iso/default branch is the last branch in the switch; its
  // return is at the bottom of the function body.
  const isoReturn = body.match(/return\s*\{\s*targetPos,\s*targetCam:[\s\S]*?up: new THREE\.Vector3\(0,\s*1,\s*0\)[\s\S]*?\};/);
  ok(!!isoReturn, 'Iso/default preset returns up = (0, 1, 0)');
}

// ---- 2. applyCameraPreset wires up before tween + calls update() --
const apply = scene.match(/export function applyCameraPreset[\s\S]*?\n\}/);
ok(!!apply, 'applyCameraPreset exists');
if (apply) {
  const body = apply[0];
  ok(/camera\.up\.copy\(t\.up\)/.test(body),
     'applyCameraPreset applies camera.up.copy(t.up)');
  ok(/controls\.update\(\)/.test(body),
     'applyCameraPreset calls controls.update() to flush OrbitControls basis');
  // The .up application must be BEFORE the _focusTween assignment
  // (snapping .up at tween-start, not interpolating it).
  const upIdx = body.indexOf('camera.up.copy(t.up)');
  const tweenIdx = body.indexOf('_focusTween = {');
  ok(upIdx > -1 && tweenIdx > -1 && upIdx < tweenIdx,
     'applyCameraPreset applies camera.up BEFORE the tween starts (no mid-flight roll)');
}

// ---- 3. Capture path: stash prevCamUp, apply up before lookAt, restore in finally ----
ok(/const prevCamUp = camera\.up\.clone\(\)/.test(scene),
   'captureViewportImage stashes prevCamUp before mutating');

// Capture path's apply-up happens inside `if (t) { ... }` followed by
// position copy, target copy, pull-back maths, then lookAt — ~600
// chars between the .up.copy and the lookAt. Match the structural
// ordering without a tight char limit.
ok(/if \(t\.up\) camera\.up\.copy\(t\.up\);[\s\S]{0,2000}?camera\.lookAt\(t\.targetPos\)/.test(scene),
   'Capture path applies camera.up BEFORE camera.lookAt(t.targetPos)');

ok(/camera\.up\.copy\(prevCamUp\)/.test(scene),
   'Capture path restores camera.up in the finally block');

// ---- 4. Coexistence with v=504 X-mirror — still required ----------
ok(/scene\.scale\.x\s*=\s*-1\s*;/.test(scene),
   'v=504 scene.scale.x = -1 mirror still in place (camera.up fix is additive, not replacing)');

console.log(failed === 0
  ? '\nAll camera-preset .up regression tests passed.'
  : `\n${failed} FAILURE(S). The Top-view 180° rotation may have regressed.`);
process.exit(failed === 0 ? 0 : 1);
