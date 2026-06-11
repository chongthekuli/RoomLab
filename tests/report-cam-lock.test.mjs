// Report-cam lock regression test (v=800, 2026-06-11).
//
// Pins the "report 3D cover = fixed Iso (locked) vs current angle
// (unlocked)" feature. The lock toggle lives inside the Iso preset
// button; flipping it switches captureViewportImage between the fixed
// 'iso' preset and a new 'current' mode that reuses the LIVE orbit
// camera direction and re-fits the room to the cover frame.
//
// Why text-grep instead of behavioural: the 'current'-angle fit needs
// the full Three.js + WebGL pipeline (live camera, controls.target,
// render target) to verify empirically — not available in the headless
// Node harness. The bug surface this guards is "someone removes the
// 'current' branch, the flag default flips to unlocked, or the
// stopPropagation that keeps the lock from snapping the iso preset gets
// dropped." A static audit catches all three.
//
// Run: node tests/report-cam-lock.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const appState   = readFileSync('./js/app-state.js', 'utf8');
const scene      = readFileSync('./js/graphics/scene.js', 'utf8');
const printRep   = readFileSync('./js/ui/print-report.js', 'utf8');
const roomMain   = readFileSync('./js/labs/roomlab/main.js', 'utf8');
const indexHtml  = readFileSync('./index.html', 'utf8');

// ---- 1. State flag exists and DEFAULTS TO LOCKED (true) -------------
// Default MUST be true so existing users see unchanged behaviour.
ok(/reportCamLocked:\s*true/.test(appState),
   'app-state.js: display.reportCamLocked default is true (locked)');

// ---- 2. scene.js has the 'current'-angle capture branch ------------
ok(/presetName === 'current'/.test(scene),
   "scene.js: captureViewportImage has a presetName === 'current' branch");
ok(/function _currentAngleTransform/.test(scene),
   'scene.js: _currentAngleTransform helper exists');

// The 'current' transform must derive direction from the LIVE camera,
// NOT the hardcoded iso dirToCam. Assert it subtracts the controls
// target from the live camera position.
const cat = scene.match(/function _currentAngleTransform[\s\S]*?\n\}/);
ok(!!cat, '_currentAngleTransform body found');
if (cat) {
  const body = cat[0];
  ok(/subVectors\(camera\.position,\s*liveTarget\)/.test(body),
     "_currentAngleTransform derives dir from live camera.position - controls.target");
  // Gimbal / degenerate guard near top-down view (cross collapses).
  ok(/viewDir\.dot\(worldUp\)\)\s*>\s*0\.999/.test(body),
     '_currentAngleTransform guards the near-vertical gimbal case');
  // NaN guard falls back to iso so capture never renders garbage.
  ok(/return _cameraPresetTransform\('iso'\)/.test(body),
     '_currentAngleTransform falls back to iso preset on non-finite result');
  // Re-fits against the caller frame aspect, not the live canvas aspect.
  ok(/frameAspect/.test(body),
     '_currentAngleTransform fits against the passed frame aspect');
}

// ---- 3. print-report selects preset from the flag ------------------
ok(/reportCamLocked === false[\s\S]*?'current'[\s\S]*?'iso'/.test(printRep),
   "print-report.js: unlocked -> 'current', locked -> 'iso'");
// Still a fixed 4:3 cover slot in both modes.
ok(/preset:\s*reportPreset,\s*fixedAspect:\s*true/.test(printRep),
   'print-report.js: still passes fixedAspect:true (fixed cover slot)');

// ---- 4. Lock button markup inside the Iso button -------------------
ok(/id="vp-iso-lock"/.test(indexHtml),
   'index.html: vp-iso-lock toggle element exists');
// It must be a child of the iso .vp-view-btn (same element run), so a
// crude check: the lock span appears on the same line as data-preset="iso".
ok(/data-preset="iso"[\s\S]*?vp-iso-lock/.test(indexHtml),
   'index.html: lock toggle nested inside the Iso preset button');

// ---- 5. Wiring: toggle flips the flag AND stops propagation ---------
ok(/getElementById\('vp-iso-lock'\)/.test(roomMain),
   'main.js: iso lock toggle is wired');
ok(/state\.display\.reportCamLocked\s*=\s*\(state\.display\.reportCamLocked === false\)/.test(roomMain),
   'main.js: clicking the lock toggles reportCamLocked');
// stopPropagation is load-bearing: without it the click also snaps the
// camera to the iso preset.
const toggleFn = roomMain.match(/const toggleIsoLock = \(ev\) => \{[\s\S]*?\n\s{6}\};/);
ok(!!toggleFn && /ev\.stopPropagation\(\)/.test(toggleFn[0]),
   'main.js: toggleIsoLock calls ev.stopPropagation() (no iso preset snap)');

// ---- summary -------------------------------------------------------
if (failed > 0) {
  console.log(`\nFAIL  ${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll report-cam-lock assertions passed.');
}
