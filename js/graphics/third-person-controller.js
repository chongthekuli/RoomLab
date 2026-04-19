import * as THREE from 'three';

// Modern 3rd-person character controller for a Three.js scene. Camera-
// relative WASD, slerp character rotation toward movement direction,
// orbit-around-character mouse drag, spring-chase lerp for the camera,
// and raycast-based ground + wall collision against a provided collidable
// Group (the scene's architectural geometry, NOT the heatmap overlays).
//
// Zero-build dependency on three/addons. The caller provides the avatar
// Group so this controller stays decoupled from model-loading choices
// (procedural, GLTF, skeletal — all work). An optional onAnimate callback
// fires each update() so the caller can drive secondary animation
// (walk-cycle limb swings, crouch pose, etc.).

const TAU = Math.PI * 2;

function shortestAngle(from, to) {
  let d = to - from;
  while (d >  Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

export class ThirdPersonController {
  constructor({ worldCamera, domElement, collidables, getCollidables, character }) {
    this.worldCamera = worldCamera;
    this.domElement = domElement;
    // Accept either a direct Group reference OR a getter function that
    // returns the current roomGroup — scene.js builds roomGroup lazily,
    // so the getter pattern lets us create the controller early.
    this._collidablesGetter = getCollidables ?? (() => collidables);
    this.character = character;

    // --- Character state (world-space) -----------------------------------
    this.pos = new THREE.Vector3(0, 0, 0);
    this.yaw = 0;                     // current character facing, rad
    this.targetYaw = 0;               // slerp target
    this.vy = 0;                      // vertical velocity
    this.grounded = true;
    this.movementSpeed = 2.8;         // m/s walking
    this.runMultiplier = 1.9;         // ×1.9 when Shift held (≈5.3 m/s running)
    this.rotationSlerp = 12;          // rad/s, tuned for "snappy but not instant"
    this.characterHeight = 1.78;
    this.characterRadius = 0.32;      // for wall-ray length
    this.stepHeight = 0.55;           // max auto-climb
    this.groundOffset = 0.02;         // tiny float above the hit to avoid z-fighting
    this.gravity = 9.81;
    // External hook: when true, WASD is ignored (character locked in place
    // while still rendering / animating). Used for the sit posture.
    this.blockMovement = false;

    // --- Camera orbit state (independent of character yaw) ----------------
    this.cameraYaw = 0;
    this.cameraPitch = -0.12;
    this.cameraDistance = 4.5;
    this.cameraDistanceMin = 1.6;
    this.cameraDistanceMax = 12;
    this.pitchMin = -1.3;             // can look almost straight up
    this.pitchMax =  0.45;            // up to ~25° above horizontal

    // --- Chase-camera smoothing (springy follow) --------------------------
    // Exponential easing toward ideal pose each frame. tau ≈ 0.12 s for
    // position gives a snappy but soft follow; lookAt uses a slightly
    // longer tau so rapid direction changes don't jolt the view.
    this.currentOffset = new THREE.Vector3();
    this.currentLookAt = new THREE.Vector3();
    this.idealOffset = new THREE.Vector3();
    this.idealLookAt = new THREE.Vector3();
    this.offsetLerpTau = 0.12;
    this.lookAtLerpTau = 0.16;

    // --- Walkthrough "juice" — Viktor rendering audit item #3. -----------
    // Without these, the walkthrough camera is a tripod on wheels. With
    // them, sprint feels fast, jumps feel weighty, and the lens "breathes"
    // with the avatar.
    this.fovIdle    = 55;
    this.fovWalking = 58;
    this.fovRunning = 62;
    this.fovTau     = 0.22;     // exponential lerp tau (s)
    this._fovTarget = this.fovIdle;
    this._bobPhase  = 0;
    this._bobWalkHz = 6.5;      // rad/s cadence at walk speed
    this._bobRunHz  = 9.5;      // rad/s cadence at sprint speed
    this._bobWalkAmp = 0.022;   // m — subtle
    this._bobRunAmp  = 0.045;   // m — pronounced
    this._pitchJolt = 0;        // radians, decays each frame
    this._pitchJoltTau = 0.22;  // s

    // --- Pre-allocated scratch vectors — Martina audit #3. ---------------
    // At 60 Hz the walkthrough update path was creating 6 fresh Vector3s
    // per frame: _canMoveTo (2), _groundSnap (2), camera-collision (2).
    // Over a 6-second walk that's ~2,200 throwaway vectors → GC hitches.
    // Reuse a handful of instance-level scratch buffers instead.
    this._scratchDxz      = new THREE.Vector3();
    this._scratchFrom     = new THREE.Vector3();
    this._scratchDown     = new THREE.Vector3(0, -1, 0);
    this._scratchHead     = new THREE.Vector3();
    this._scratchToCam    = new THREE.Vector3();
    this.cameraEyeHeight = 1.4;       // where the camera "looks" relative to feet

    // --- Input ------------------------------------------------------------
    this.keys = new Set();
    this._mouseDragging = false;
    this._mouseLastX = 0;
    this._mouseLastY = 0;
    this._mouseButton = 0;

    // --- Raycasting -------------------------------------------------------
    this.raycaster = new THREE.Raycaster();

    // --- Hooks ------------------------------------------------------------
    this.onAnimate = null;            // callback({ dt, moving, running, grounded, vy, keys, speed })
    this.onJump = null;               // fired once per jump impulse

    this.enabled = false;

    // Bind handlers for add/removeEventListener parity.
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp   = this._onKeyUp.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp   = this._onMouseUp.bind(this);
    this._onWheel     = this._onWheel.bind(this);
    this._onBlur      = () => this.keys.clear();
  }

  setPosition(v) {
    this.pos.copy(v);
    this.character.position.copy(v);
    this.currentOffset.copy(v);
    this.currentLookAt.copy(v);
  }
  setYaw(y) {
    this.yaw = y;
    this.targetYaw = y;
    this.cameraYaw = y;               // start with camera looking the same way
    this.character.rotation.y = y;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup',   this._onKeyUp);
    this.domElement.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup',   this._onMouseUp);
    this.domElement.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('blur', this._onBlur);
  }
  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.keys.clear();
    this._mouseDragging = false;
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup',   this._onKeyUp);
    this.domElement.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup',   this._onMouseUp);
    this.domElement.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._onBlur);
    this.domElement.style.cursor = '';
  }

  // ----- Input handlers ---------------------------------------------------
  _onKeyDown(e) {
    if (!this.enabled) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    this.keys.add(e.code);
    if (e.code === 'Space' && this.grounded && this.onJump) this.onJump();
    if (['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','Space','ShiftLeft','ShiftRight','KeyC','KeyZ','ControlLeft','ControlRight','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  }
  _onKeyUp(e) { this.keys.delete(e.code); }

  _onMouseDown(e) {
    if (!this.enabled) return;
    this._mouseDragging = true;
    this._mouseLastX = e.clientX;
    this._mouseLastY = e.clientY;
    this._mouseButton = e.button;
    this.domElement.style.cursor = 'grabbing';
  }
  _onMouseMove(e) {
    if (!this.enabled || !this._mouseDragging) return;
    const dx = e.clientX - this._mouseLastX;
    const dy = e.clientY - this._mouseLastY;
    this._mouseLastX = e.clientX;
    this._mouseLastY = e.clientY;
    this.cameraYaw   -= dx * 0.006;
    this.cameraPitch -= dy * 0.0045;
    this.cameraPitch = Math.max(this.pitchMin, Math.min(this.pitchMax, this.cameraPitch));
  }
  _onMouseUp()   { this._mouseDragging = false; this.domElement.style.cursor = ''; }
  _onWheel(e) {
    e.preventDefault();
    this.cameraDistance *= (1 + e.deltaY * 0.001);
    this.cameraDistance = Math.max(this.cameraDistanceMin, Math.min(this.cameraDistanceMax, this.cameraDistance));
  }

  // ----- Movement computation --------------------------------------------
  // WASD relative to the CAMERA yaw, not the character's. W always pushes
  // the character away from the camera (into the screen). Camera yaw=0
  // means camera is at +Z of character, so "away from camera" is -Z.
  _cameraRelativeMove() {
    if (this.blockMovement) return { x: 0, z: 0, magnitude: 0 };
    const fx = -Math.sin(this.cameraYaw);
    const fz = -Math.cos(this.cameraYaw);
    // Strafe right (perpendicular to forward, rotated −90° in XZ).
    const rx = -fz;
    const rz =  fx;
    let mx = 0, mz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp'))    { mx += fx; mz += fz; }
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown'))  { mx -= fx; mz -= fz; }
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  { mx -= rx; mz -= rz; }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) { mx += rx; mz += rz; }
    const mag = Math.hypot(mx, mz);
    return { x: mag > 0 ? mx / mag : 0, z: mag > 0 ? mz / mag : 0, magnitude: mag };
  }

  // ----- Raycast helpers --------------------------------------------------
  _structuralHits(raycaster) {
    const group = this._collidablesGetter();
    if (!group) return [];
    const hits = raycaster.intersectObject(group, true);
    return hits.filter(h => {
      const tag = h.object.userData?.tag ?? '';
      return !tag.startsWith('heatmap_') && tag !== 'walk_avatar';
    });
  }

  _canMoveTo(newX, newZ) {
    const dxz = this._scratchDxz.set(newX - this.pos.x, 0, newZ - this.pos.z);
    const dist = dxz.length();
    if (dist < 1e-6) return true;
    dxz.normalize();
    // Cast from chest height so we don't hit floors / short steps.
    const from = this._scratchFrom.set(this.pos.x, this.pos.y + this.characterHeight * 0.55, this.pos.z);
    this.raycaster.set(from, dxz);
    this.raycaster.far = dist + this.characterRadius;
    return this._structuralHits(this.raycaster).length === 0;
  }

  _groundSnap() {
    const from = this._scratchFrom.set(this.pos.x, this.pos.y + this.characterHeight, this.pos.z);
    this.raycaster.set(from, this._scratchDown);
    this.raycaster.far = this.characterHeight + 3;
    const hits = this._structuralHits(this.raycaster);
    if (hits.length === 0) { this.grounded = false; return; }
    const groundY = from.y - hits[0].distance;
    const delta = this.pos.y - groundY;
    if (delta <= this.groundOffset + 0.01) {
      // On or below ground → snap up, zero vy.
      this.pos.y = groundY + this.groundOffset;
      if (this.vy < 0) this.vy = 0;
      this.grounded = true;
    } else if (delta < this.stepHeight + 0.05 && this.vy <= 0) {
      // Falling onto a step within reach → snap to it.
      this.pos.y = groundY + this.groundOffset;
      this.vy = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
  }

  // ----- Per-frame update -------------------------------------------------
  update(dt) {
    if (!this.enabled || dt <= 0) return;

    const move = this._cameraRelativeMove();
    const running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = this.movementSpeed * (running ? this.runMultiplier : 1);

    if (move.magnitude > 0.01) {
      const dx = move.x * speed * dt;
      const dz = move.z * speed * dt;
      if (this._canMoveTo(this.pos.x + dx, this.pos.z + dz)) {
        this.pos.x += dx; this.pos.z += dz;
      } else if (this._canMoveTo(this.pos.x + dx, this.pos.z)) {
        this.pos.x += dx;
      } else if (this._canMoveTo(this.pos.x, this.pos.z + dz)) {
        this.pos.z += dz;
      }
      // Slerp character toward movement direction. atan2(x, z) because yaw=0 faces +Z.
      this.targetYaw = Math.atan2(move.x, move.z);
    }

    // Gravity + vertical motion
    this.vy -= this.gravity * dt;
    this.pos.y += this.vy * dt;
    const preSnapVy = this.vy;
    const preSnapGrounded = this.grounded;
    this._groundSnap();
    // Detect a just-landed transition so the animation callback can read
    // the actual impact velocity (gets zeroed by the snap).
    this._justLanded = !preSnapGrounded && this.grounded;
    this._impactVy = this._justLanded ? preSnapVy : 0;

    // Slerp character yaw (smooth turn).
    const yawDelta = shortestAngle(this.yaw, this.targetYaw);
    const yawStep = Math.min(1, dt * this.rotationSlerp);
    this.yaw += yawDelta * yawStep;

    this.character.position.copy(this.pos);
    this.character.rotation.y = this.yaw;

    // --- Chase camera ---
    const cp = Math.cos(this.cameraPitch);
    this.idealOffset.set(
      this.pos.x + Math.sin(this.cameraYaw) * cp * this.cameraDistance,
      this.pos.y + Math.sin(this.cameraPitch) * this.cameraDistance + this.cameraEyeHeight,
      this.pos.z + Math.cos(this.cameraYaw) * cp * this.cameraDistance,
    );
    // Look slightly ahead of the character (in their current facing direction).
    this.idealLookAt.set(
      this.pos.x + Math.sin(this.yaw) * 0.35,
      this.pos.y + this.characterHeight * 0.78,
      this.pos.z + Math.cos(this.yaw) * 0.35,
    );

    // Camera collision — raycast from character head toward idealOffset.
    // If a structural surface lies between, pull idealOffset in to just
    // short of the hit so the camera never clips through walls or
    // ceilings. Viktor audit item #4 — the "refuse to ship" finding.
    const headY = this.pos.y + this.cameraEyeHeight;
    const head = this._scratchHead.set(this.pos.x, headY, this.pos.z);
    const toCam = this._scratchToCam.subVectors(this.idealOffset, head);
    const wantDist = toCam.length();
    if (wantDist > 1e-3) {
      toCam.divideScalar(wantDist);
      this.raycaster.set(head, toCam);
      this.raycaster.far = wantDist;
      const hits = this._structuralHits(this.raycaster);
      const allowedDist = hits.length > 0
        ? Math.max(this.cameraDistanceMin * 0.6, hits[0].distance - 0.18)
        : wantDist;
      this.idealOffset.copy(head).addScaledVector(toCam, allowedDist);
    }

    // Exponential lerp for springy follow. dt-adjusted so behavior is
    // frame-rate independent.
    const offT = 1 - Math.exp(-dt / this.offsetLerpTau);
    const laT  = 1 - Math.exp(-dt / this.lookAtLerpTau);
    // First frame after enable: snap immediately so we don't see a swoop.
    if (this.currentOffset.lengthSq() === 0) this.currentOffset.copy(this.idealOffset);
    if (this.currentLookAt.lengthSq() === 0) this.currentLookAt.copy(this.idealLookAt);
    this.currentOffset.lerp(this.idealOffset, offT);
    this.currentLookAt.lerp(this.idealLookAt, laT);

    // Head-bob — inject a sin-based vertical oscillation into the camera
    // position at a cadence that scales with gait. Only while moving on
    // the ground. Zero additional raycasts — pure math.
    const moving = move.magnitude > 0.1;
    let bobY = 0;
    if (moving && this.grounded) {
      const hz = running ? this._bobRunHz : this._bobWalkHz;
      const amp = running ? this._bobRunAmp : this._bobWalkAmp;
      this._bobPhase += dt * hz;
      bobY = Math.sin(this._bobPhase) * amp;
    } else {
      // Decay the phase slowly so standing-after-walking doesn't abruptly
      // reset and cause a visible snap.
      this._bobPhase *= Math.exp(-dt / 0.8);
    }

    this.worldCamera.position.copy(this.currentOffset);
    this.worldCamera.position.y += bobY;
    this.worldCamera.lookAt(this.currentLookAt);

    // Landing pitch-jolt — on the just-landed frame, seed a downward
    // pitch nudge proportional to impact velocity. Decays exponentially.
    if (this._justLanded) {
      const impactMag = Math.min(1, Math.abs(this._impactVy) / 8);
      this._pitchJolt = -0.10 * impactMag;
    }
    if (Math.abs(this._pitchJolt) > 1e-4) {
      this.worldCamera.rotateX(this._pitchJolt);
      this._pitchJolt *= Math.exp(-dt / this._pitchJoltTau);
    }

    // FOV kick — breathe between idle / walking / sprinting. Viktor
    // suggested 55/58/64; 62 reads visibly fast without making the
    // scene lens-distorted on a 60 m arena.
    this._fovTarget = running ? this.fovRunning : (moving ? this.fovWalking : this.fovIdle);
    const fovLerp = 1 - Math.exp(-dt / this.fovTau);
    if (this.worldCamera.isPerspectiveCamera) {
      this.worldCamera.fov += (this._fovTarget - this.worldCamera.fov) * fovLerp;
      this.worldCamera.updateProjectionMatrix();
    }

    if (this.onAnimate) {
      this.onAnimate({
        dt,
        moving: move.magnitude > 0.01,
        running,
        grounded: this.grounded,
        vy: this.vy,
        yaw: this.yaw,
        keys: this.keys,
        speed,
        justLanded: this._justLanded,
        impactVy: this._impactVy,
      });
    }
  }

  jump(v = 4.0) {
    if (!this.grounded) return false;
    this.vy = v;
    this.grounded = false;
    return true;
  }

  getEarPosition(eyeHeight = 1.68) {
    return new THREE.Vector3(this.pos.x, this.pos.y + eyeHeight, this.pos.z);
  }
}
