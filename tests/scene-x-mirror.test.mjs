// Scene-level X-mirror regression test (v=504, 2026-05-18).
//
// Pins the v=504 fix for the global 2D-3D X-axis mismatch: the 3D
// scene applies `scene.scale.x = -1` to render state +x at screen-
// RIGHT (matching the 2D viewport's east-right convention), and
// every state↔world conversion site must negate X to keep cameras,
// raycasts, walk-mode, click-to-place, and audition writebacks
// consistent. v=497 attempted this mirror without the downstream
// fixes and broke camera-fit + walk-mode + drag; v=504 is the
// version-with-fixes.
//
// Why text-grep instead of behavioural: the actual axis behaviour
// requires the full Three.js + WebGL rendering pipeline to verify
// empirically. The bug surface here is "someone removes one of the
// negation sites and silently re-mirrors a subsystem" — a static
// regex audit guards every conversion site listed in CLAUDE.md §6.
//
// Run: node tests/scene-x-mirror.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const scene = readFileSync('./js/graphics/scene.js', 'utf8');
const placeRoom = readFileSync('./js/graphics/place-room-controller.js', 'utf8');
const tpc = readFileSync('./js/graphics/third-person-controller.js', 'utf8');

// ---- 1. scene.scale.x = -1 in initScene ----------------------------
ok(/scene\.scale\.x\s*=\s*-1\s*;/.test(scene),
   'initScene applies scene.scale.x = -1 (global X mirror)');

// ---- 2. frameCameraToRoom negates X in camera position + target ---
const frame = scene.match(/export function frameCameraToRoom[\s\S]*?\n\}/);
ok(!!frame, 'frameCameraToRoom exists');
if (frame) {
  ok(/camera\.position\.set\(-\(cx \+ d3 \* 0\.9\)/.test(frame[0]),
     'frameCameraToRoom: camera.position.x = -(cx + d3*0.9)');
  ok(/controls\.target\.set\(-cx,/.test(frame[0]),
     'frameCameraToRoom: controls.target.x = -cx');
}

// ---- 3. _cameraPresetTransform negates X in all 5 cardinal presets -
const presets = scene.match(/function _cameraPresetTransform[\s\S]*?^\}/m);
ok(!!presets, '_cameraPresetTransform exists');
if (presets) {
  const body = presets[0];
  // top preset
  ok(/case 'top':[\s\S]*?targetPos: new THREE\.Vector3\(-cx,[\s\S]*?targetCam: new THREE\.Vector3\(-cx, camY, cz\)/.test(body),
     "Top preset negates cx in targetPos + targetCam");
  // front
  ok(/case 'front':[\s\S]*?targetPos: new THREE\.Vector3\(-cx, h \* 0\.5, cz\)[\s\S]*?targetCam: new THREE\.Vector3\(-cx, h \* 0\.5, minZ - dist\)/.test(body),
     'Front preset negates cx in targetPos + targetCam');
  // back
  ok(/case 'back':[\s\S]*?targetPos: new THREE\.Vector3\(-cx, h \* 0\.5, cz\)[\s\S]*?targetCam: new THREE\.Vector3\(-cx, h \* 0\.5, maxZ \+ dist\)/.test(body),
     'Back preset negates cx in targetPos + targetCam');
  // left — camera at world.x = -minX + dist (after mirror)
  ok(/case 'left':[\s\S]*?targetPos: new THREE\.Vector3\(-cx,[\s\S]*?targetCam: new THREE\.Vector3\(-minX \+ dist,/.test(body),
     "Left preset: targetCam at world.x = -minX + dist");
  // right — camera at world.x = -maxX - dist
  ok(/case 'right':[\s\S]*?targetPos: new THREE\.Vector3\(-cx,[\s\S]*?targetCam: new THREE\.Vector3\(-maxX - dist,/.test(body),
     "Right preset: targetCam at world.x = -maxX - dist");
}

// ---- 4. focusCameraOnSelectedListener: tx = -lst.position.x -------
ok(/const tx = -lst\.position\.x;/.test(scene),
   'focusCameraOnSelectedListener: tx = -lst.position.x');

// ---- 5. placeAvatarAtDefault: setPosition(-cx, ...) ----------------
ok(/tpController\.setPosition\(new THREE\.Vector3\(-cx, gz \+ 0\.05, cy\)\)/.test(scene),
   'placeAvatarAtDefault: setPosition uses -cx (mesh-local for world cx after mirror)');

// ---- 6. Audition writeback: posState.x = -tp.x ---------------------
ok(/x: -tp\.x,/.test(scene),
   'audition writeback: posState.x = -tp.x (state-frame from world)');

// ---- 7. Walk SPL readout: px = -tpController.pos.x ----------------
ok(/const px = -tpController\.pos\.x;/.test(scene),
   'walkSplReadout: px = -tpController.pos.x (state-frame)');

// ---- 8. Probe tool: probeMarker + listener pos negate X -----------
ok(/probeMarker\.position\.set\(-hit\.point\.x,/.test(scene),
   'probe tool: probeMarker.position.x = -hit.point.x (compensates scene mirror)');
ok(/listenerPos = \{\s*x: -hit\.point\.x,/.test(scene),
   'probe tool: listenerPos.x = -hit.point.x (state-frame)');

// ---- 9. Treatment placement: ceiling + wall negate X ---------------
ok(/anchor = \{ surface: 'ceiling' \};[\s\S]*?x: -hit\.point\.x,/.test(scene),
   "treatment placement (ceiling): position.x = -hit.point.x");
ok(/const worldXY = \{ x: -hit\.point\.x, y: hit\.point\.z \}/.test(scene),
   'treatment placement (wall): worldXY.x = -hit.point.x');

// ---- 10. _raycastIntoSurfacePlane: ceiling + wall returns negate X
const ceilingReturn = scene.match(/surface_id === 'ceiling'[\s\S]*?return \{ worldXY: \{ x: -h\.point\.x,/);
ok(!!ceilingReturn,
   '_raycastIntoSurfacePlane ceiling: worldXY.x = -h.point.x');
const wallReturn = scene.match(/startsWith\('wall_'\)[\s\S]*?return \{ worldXY: \{ x: -h\.point\.x,/);
ok(!!wallReturn,
   '_raycastIntoSurfacePlane wall: worldXY.x = -h.point.x');

// ---- 11. place-room-controller _screenToFloor negates X -----------
ok(/return \{ x_m: -hit\.x, y_m: hit\.z \}/.test(placeRoom),
   'place-room-controller _screenToFloor: x_m = -hit.x');

// ---- 12. avatarMirrorCancel Group exists with scale.x = -1 -------
// v=508: avatar lives inside this Group (net identity frame) so
// SkinnedMesh skinning works without bindMatrix complications.
ok(/let avatarMirrorCancel = null;/.test(scene),
   'avatarMirrorCancel module-scope binding declared');
ok(/avatarMirrorCancel = new THREE\.Group\(\);\s*\n\s*avatarMirrorCancel\.scale\.x = -1;/.test(scene),
   'avatarMirrorCancel created with scale.x = -1');
ok(/avatarMirrorCancel\.add\(avatar\);/.test(scene),
   'procedural avatar added to avatarMirrorCancel (not directly to scene)');
ok(/avatarMirrorCancel\.add\(rig\.root\);/.test(scene),
   'rigged avatar (rig.root) added to avatarMirrorCancel');
ok(/avatarMirrorCancel\.remove\(avatar\);/.test(scene),
   'procedural avatar removed from avatarMirrorCancel on rig load');

// ---- 13. third-person-controller: setPosition does NOT negate X ---
// Avatar is in identity frame (avatarMirrorCancel cancels scene mirror),
// so character.position = this.pos directly. No negation needed.
const setPos = tpc.match(/setPosition\(v\) \{[\s\S]*?\n\s{2}\}/);
ok(!!setPos, 'setPosition exists');
if (setPos) {
  ok(/this\.character\.position\.copy\(v\)/.test(setPos[0]),
     'setPosition: character.position.copy(v) (avatar in identity frame, no negation)');
}

// ---- 14. setYaw assigns yaw directly to character.rotation.y ------
const setYaw = tpc.match(/setYaw\(y\) \{[\s\S]*?\n\s{2}\}/);
ok(!!setYaw, 'setYaw exists');
if (setYaw) {
  ok(/this\.character\.rotation\.y = y;/.test(setYaw[0]),
     'setYaw: character.rotation.y = y (identity frame, no negation)');
}

// ---- 15. update() writes mesh position + rotation directly ---------
ok(/this\.character\.position\.copy\(this\.pos\)/.test(tpc),
   'update(): character.position.copy(this.pos) (identity frame)');
ok(/this\.character\.rotation\.y = this\.yaw;/.test(tpc),
   'update(): character.rotation.y = this.yaw');

// ---- 16. Mouse-drag + touch-drag cameraYaw direction ORIGINAL -----
// With avatarMirrorCancel, camera math runs in world frame; original
// pre-mirror drag direction (cameraYaw -= dx) is correct.
const mouseHandler = tpc.match(/_onMouseMove\(e\) \{[\s\S]*?\n\s{2}\}/);
ok(!!mouseHandler, '_onMouseMove exists');
if (mouseHandler) {
  ok(/this\.cameraYaw\s*-=\s*dx \* 0\.006;/.test(mouseHandler[0]),
     '_onMouseMove: cameraYaw -= dx * 0.006 (original direction)');
}
const touchHandler = tpc.match(/_onTouchMove\(e\) \{[\s\S]*?\n\s{2}\}/);
ok(!!touchHandler, '_onTouchMove exists');
if (touchHandler) {
  ok(/this\.cameraYaw\s*-=\s*dx \* 0\.006;/.test(touchHandler[0]),
     '_onTouchMove: cameraYaw -= dx * 0.006 (original direction)');
}

console.log(failed === 0
  ? '\nAll scene X-mirror v=504 tests passed.'
  : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
