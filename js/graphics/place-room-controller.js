// Place-Room Controller — drives the interactive placement of a saved
// custom room as a sub-structure inside the currently-loaded room.
//
// Lifecycle: one instance is mounted on demand by panel-room.js when the
// user clicks "Place" and picks a source room from the cross-project
// picker. The controller takes over mouse + keyboard until the user
// either confirms the placement (click → confirmation modal → commit) or
// cancels (Esc / right-click).
//
// Coordinate convention follows scene.js:
//   state-space (XYZ): x = width, y = depth (floor plane), z = up
//   three-space:       x = width, y = up,                  z = depth
// Sub-structures are stored in state-space — position.x_m / position.y_m
// are floor-plane coords; elevation_m is height above the parent floor.
//
// Design choices the brief left open (locked here so the next person can
// see what was decided):
//   - Movement: mouse drag in XZ (floor) plane by default; while V key
//     is HELD ("vertical"), mouse vertical motion (clientY delta) maps to
//     elevation. V was chosen over Y to avoid colliding with the global
//     "Y = ray-paths on/off" viewport shortcut bound in roomlab/main.js.
//   - Rotation: R rotates +15°, Shift+R rotates −15°. No mouse rotation
//     in v1 — keyboard is unambiguous.
//   - Cancel: Esc or right-click.
//   - Default position: parent room's floor centroid; elevation 0.
//
// Phase-2 NOTE (acoustics): the placed sub-room is purely visual in
// Phase 1. Its walls / floor / ceiling are NOT folded into roomSurfaces()
// for RT60 / SPL math. The hooks for that live next to rebuildSubStructures
// in scene.js — see the comment block there.

import * as THREE from 'three';

const ROTATION_STEP_DEG = 15;
const SNAP_M = 0.5;   // matches the custom-room drawing convention (Maya §3)
const snap = (v) => Math.round(v / SNAP_M) * SNAP_M;

export class PlaceRoomController {
  constructor({
    domElement, camera, scene,
    parentRoom,
    sourceRoom, sourceRoomId, sourceRoomName,
    onPreviewMove,    // ({ position, elevation_m, rotation_deg }) — called every frame
    onCommit,         // ({ id, sourceRoomId, sourceRoomName, position, elevation_m, rotation_deg, sourceRoom })
    onCancel,         // () — placement aborted
    onHud,            // (text|null) — instructional HUD overlay text
    onConfirmRequest, // ({ sourceRoomName, onYes, onNo }) — opens confirmation modal
  }) {
    this.domElement = domElement;
    this.camera = camera;
    this.scene = scene;
    this.parentRoom = parentRoom;
    this.sourceRoom = sourceRoom;
    this.sourceRoomId = sourceRoomId;
    this.sourceRoomName = sourceRoomName;
    this.onPreviewMove = onPreviewMove;
    this.onCommit = onCommit;
    this.onCancel = onCancel;
    this.onHud = onHud;
    this.onConfirmRequest = onConfirmRequest;

    // Centroid default: parent room's bbox centre, on the floor —
    // snapped to the 0.5 m grid so the initial placement is on a
    // user-meaningful coordinate (matches the drawing tool's snap).
    const w = parentRoom.width_m ?? 10;
    const d = parentRoom.depth_m ?? 10;
    this.position = { x_m: snap(w / 2), y_m: snap(d / 2) };
    this.elevation_m = 0;
    this.rotation_deg = 0;

    // V-key axis switch: when held, mouse-Y delta drives elevation
    // instead of cursor projecting to floor. Field name kept generic
    // (yAxisActive) since it describes the WORLD axis being moved on,
    // independent of which keyboard letter triggers it. Exposed for tests.
    this.yAxisActive = false;
    this._lastClientY = 0;
    // Confirmation modal is open — suspend mouse/keyboard so the modal
    // owns the input.
    this._confirmOpen = false;
    // Track if pointer-down hit was a real click (not a drag) — we treat
    // any click on the canvas as "place here" intent. Cursor follows the
    // mouse continuously regardless.
    this._enabled = false;

    this._raycaster = new THREE.Raycaster();
    this._floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._ndc = new THREE.Vector2();
    this._hitPoint = new THREE.Vector3();

    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  enable() {
    if (this._enabled) return;
    this._enabled = true;
    // Surface the controls hint immediately so the user knows what to do.
    this._emitHud();
    // Capture phase + suppress so the existing click handlers in scene.js
    // (onSpeakerClick / onSurfaceClick) don't fire when the user clicks
    // the canvas to commit a placement. mousedown is cheaper to dedupe
    // than click because click fires AFTER our mouseup → confirmation
    // modal opens, and we want zero competing handlers in the gap.
    this._suppressClick = (e) => {
      if (!this._enabled) return;
      e.stopPropagation();
      e.preventDefault();
    };
    this.domElement.addEventListener('mousemove', this._onMouseMove);
    this.domElement.addEventListener('mousedown', this._onMouseDown, true);
    this.domElement.addEventListener('click', this._suppressClick, true);
    this.domElement.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    this.domElement.style.cursor = 'crosshair';
    // Push initial preview to scene so the user sees the sub-room ghost
    // at the centroid before any mouse motion.
    this._notifyPreview();
  }

  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this.domElement.removeEventListener('mousemove', this._onMouseMove);
    this.domElement.removeEventListener('mousedown', this._onMouseDown, true);
    if (this._suppressClick) {
      this.domElement.removeEventListener('click', this._suppressClick, true);
      this._suppressClick = null;
    }
    this.domElement.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    this.domElement.style.cursor = '';
    if (this.onHud) this.onHud(null);
  }

  // Translate a screen-space (clientX, clientY) into a state-space
  // (x_m, y_m) point on the parent room's floor (y=0 plane in three-space).
  _screenToFloor(clientX, clientY) {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._ndc, this.camera);
    // Intersect the y=0 plane (parent floor in three-space).
    const hit = this._raycaster.ray.intersectPlane(this._floorPlane, this._hitPoint);
    if (!hit) return null;
    // three-space world (x, y_up, z_depth) → state-space (x_m, y_m).
    // X negated — scene.scale.x = -1 in scene.js initScene mirrors meshes
    // so state.x_m = -world.x. (Y axis unaffected — state.y_m → world.z
    // directly.)
    return { x_m: -hit.x, y_m: hit.z };
  }

  _onMouseMove(e) {
    if (!this._enabled || this._confirmOpen) return;
    if (this.yAxisActive) {
      // V key held: mouse-Y delta maps to elevation. Up = up; ~100 px
      // corresponds to 1 m which is the same scale walkthrough mode uses
      // for vertical drag. We accumulate the raw float into _rawElev so
      // sub-snap mouse moves aren't lost (rounding straight to elevation
      // would freeze it whenever the per-frame delta is < 0.5 m). The
      // visible elevation_m is the snapped value the user actually sees.
      const dy = e.clientY - this._lastClientY;
      this._lastClientY = e.clientY;
      if (this._rawElev === undefined) this._rawElev = this.elevation_m;
      this._rawElev += -dy / 100;
      // Clamp so the user cannot send the sub-room miles away. Negative
      // elevation is allowed (basement-style placement); the cap is
      // generous.
      const h = this.parentRoom.height_m ?? 3;
      this._rawElev = Math.max(-50, Math.min(h * 5 + 50, this._rawElev));
      this.elevation_m = snap(this._rawElev);
      this._notifyPreview();
      return;
    }
    const p = this._screenToFloor(e.clientX, e.clientY);
    if (!p) return;
    // 0.5 m snap on the floor-plane move — same convention as the
    // custom-room draw flow so a placed sub-room aligns cleanly with
    // hand-drawn polygons.
    this.position.x_m = snap(p.x_m);
    this.position.y_m = snap(p.y_m);
    this._notifyPreview();
  }

  _onMouseDown(e) {
    if (!this._enabled || this._confirmOpen) return;
    if (e.button === 2) {
      // Right-click cancels (consistent with most CAD placement tools).
      e.preventDefault();
      e.stopPropagation();
      this._cancel();
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Open confirmation modal. Suspend input until the user answers.
    this._confirmOpen = true;
    if (this.onHud) this.onHud(null);
    this.onConfirmRequest?.({
      sourceRoomName: this.sourceRoomName,
      onYes: () => {
        this._confirmOpen = false;
        this._commit();
      },
      onNo: () => {
        // User said no — keep the placement session live so they can
        // move further. Restore HUD.
        this._confirmOpen = false;
        this._emitHud();
      },
    });
  }

  _onContextMenu(e) {
    if (!this._enabled) return;
    // Always swallow contextmenu while placing — the right-click cancel
    // path is in _onMouseDown so the menu never appears.
    e.preventDefault();
  }

  _onKeyDown(e) {
    if (!this._enabled || this._confirmOpen) return;
    // Ignore key events on text inputs etc. so the user can still type
    // in side-panel fields if they happen to be focused (defensive).
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this._cancel();
    } else if (e.key === 'v' || e.key === 'V') {
      if (!this.yAxisActive) {
        this.yAxisActive = true;
        this._lastClientY = 0;
        this._rawElev = this.elevation_m;
        this._emitHud();
      }
      e.preventDefault();
      // stopPropagation prevents any global keyboard shortcut bound to V
      // from firing while placement is live. (Y was previously used here
      // and clashed with the ray-paths viewport toggle — bug fix 2026-04.)
      e.stopPropagation();
      // Capture a baseline clientY from the next mousemove tick — without
      // a recent reading we'd jump on first move. Use page-level event so
      // we get coords even if the cursor isn't currently over the canvas.
      const captureOnce = (ev) => {
        this._lastClientY = ev.clientY;
        document.removeEventListener('mousemove', captureOnce, true);
      };
      document.addEventListener('mousemove', captureOnce, true);
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? -ROTATION_STEP_DEG : ROTATION_STEP_DEG;
      this.rotation_deg = ((this.rotation_deg + step) % 360 + 360) % 360;
      this._notifyPreview();
    }
  }

  _onKeyUp(e) {
    if (!this._enabled) return;
    if (e.key === 'v' || e.key === 'V') {
      if (this.yAxisActive) {
        this.yAxisActive = false;
        this._rawElev = undefined;
        this._emitHud();
      }
    }
  }

  _emitHud() {
    if (!this.onHud) return;
    if (this.yAxisActive) {
      this.onHud('Adjusting height — mouse up/down · snap 0.5 m · release V for floor move · R to rotate · Esc to cancel');
    } else {
      this.onHud('Click to place · snap 0.5 m · press V to adjust height · R to rotate · Esc to cancel');
    }
  }

  _notifyPreview() {
    this.onPreviewMove?.({
      position: { ...this.position },
      elevation_m: this.elevation_m,
      rotation_deg: this.rotation_deg,
    });
  }

  _cancel() {
    if (!this._enabled) return;
    this.disable();
    this.onCancel?.();
  }

  _commit() {
    if (!this._enabled) return;
    const id = 'sub-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const entry = {
      id,
      sourceRoomId: this.sourceRoomId,
      sourceRoomName: this.sourceRoomName,
      position: { ...this.position },
      elevation_m: this.elevation_m,
      rotation_deg: this.rotation_deg,
      // Deep-clone the source room so the entry survives deletion of the
      // library record. JSON-clone is fine — saved rooms are pure data.
      sourceRoom: JSON.parse(JSON.stringify(this.sourceRoom)),
    };
    this.disable();
    this.onCommit?.(entry);
  }
}
