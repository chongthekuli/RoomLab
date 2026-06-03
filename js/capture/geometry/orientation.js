// Room Capture — DeviceOrientation / DeviceMotion sensor-fusion MATH. PURE: no
// DOM, no Three.js, no npm, Node-testable (same discipline as js/physics/). The
// browser-side permission prompt + event plumbing lives in the MODE
// (live-capture-mode.js); this module is only the geometry it feeds on:
//
//   • levelPlaneFromGravity()  — from the gravity/accelerometer vector, recover
//     the phone's tilt (how far the camera's "up" is from true vertical). Lets
//     the mode KEEP THE FLOOR LEVEL / WALLS VERTICAL (the Manhattan-vertical
//     anchor the giants get from VIO — here from gravity) and flag a too-tilted
//     capture instead of silently rectifying a skewed plan.
//   • headingToNorthRotation() — from the compass heading (DeviceOrientation
//     alpha / webkitCompassHeading) of the wall the user FACED when they locked
//     the reference frame, compute the rotation that lands the committed polygon
//     with +y = NORTH (the cross-surface convention — flag to Sam).
//   • applyHeadingToPolygon() / rotatePolygon() — apply that rotation.
//
// Coordinate frame (matches scale-anchor.js / capture-flow.js): metres, floor
// plane, state +y = NORTH, +x = EAST. A polygon is an array of {x, y}.
//
// ── +y = NORTH mapping (cross-surface invariant — FLAG TO SAM) ──────────────
// photo-rectify lands the rectified polygon with the room's FAR wall toward +y
// and image-right toward +x — but that "far wall" points wherever the phone's
// CAMERA was facing, not necessarily north. headingToNorthRotation() closes
// that gap: the phone reports a compass heading (degrees clockwise from magnetic
// north, 0=N, 90=E) for the direction the camera faced at lock time. The
// rectified +y axis currently points along that camera heading; to make +y point
// at TRUE north we rotate the whole polygon by −heading (clockwise heading →
// counter-clockwise polygon correction in the +y-up, +x-east math frame). After
// the rotation the room sits at its real-world bearing with north up the page,
// consistent with the 2D viewport / 3D top-down ortho / print plan SVG. When the
// heading is unavailable (permission denied / no magnetometer) the mode skips
// this step and the plan keeps its today behaviour (camera-relative orientation)
// — never blocked on sensors. Register in tests/cross-surface-conventions.

const DEG = Math.PI / 180;

/**
 * Recover the phone's tilt from a gravity / accelerometer reading. The vector
 * points along the direction gravity pulls in the DEVICE frame (the convention
 * DeviceMotionEvent.accelerationIncludingGravity uses: with the phone held
 * upright in portrait, screen toward the user, g ≈ (0, -9.81, 0); held flat
 * face-up, g ≈ (0, 0, -9.81)). We only need the DIRECTION, so the magnitude
 * (≈9.81, but noisy) is normalised away.
 *
 * Returns:
 *   • tiltRad   — angle between the device's optical axis (−Z, out the back
 *     camera) and the horizontal plane is NOT what a non-expert wants; instead
 *     we report `tiltRad` = angle of the device's screen-normal from vertical,
 *     i.e. how far from "held upright, camera pointing at the wall" the phone is.
 *     0 = perfectly upright (good for scanning a wall); π/2 = pointing straight
 *     down/up.
 *   • level     — boolean: is the phone within `uprightTolRad` of a good
 *     wall-scanning pose? Drives the "hold the phone more upright" coaching cue.
 *   • gx,gy,gz  — the normalised gravity direction (handy for tests / further math).
 *
 * @param {{x:number,y:number,z:number}} accel  gravity vector in device frame
 * @param {Object} [opts]
 * @param {number} [opts.uprightTolRad=0.6]  ~34° — generous; we only flag gross tilt
 * @returns {{tiltRad:number, level:boolean, gx:number, gy:number, gz:number}}
 */
export function levelPlaneFromGravity(accel, opts = {}) {
  const uprightTolRad = opts.uprightTolRad ?? 0.6;
  const x = accel?.x ?? 0, y = accel?.y ?? 0, z = accel?.z ?? 0;
  const mag = Math.hypot(x, y, z);
  if (!(mag > 1e-6)) {
    // No usable reading — treat as "unknown", level=true so we never block.
    return { tiltRad: 0, level: true, gx: 0, gy: -1, gz: 0 };
  }
  const gx = x / mag, gy = y / mag, gz = z / mag;
  // Phone held upright to scan a wall: gravity points "down the screen", i.e.
  // along device −Y → gy ≈ −1. The tilt is the angle between the actual gravity
  // direction and that ideal (0,−1,0). cosθ = −gy.
  const cos = Math.max(-1, Math.min(1, -gy));
  const tiltRad = Math.acos(cos);
  return { tiltRad, level: tiltRad <= uprightTolRad, gx, gy, gz };
}

/**
 * Normalise a compass heading (any real, degrees) into [0, 360).
 * @param {number} headingDeg
 * @returns {number}
 */
export function normalizeHeadingDeg(headingDeg) {
  if (!Number.isFinite(headingDeg)) return 0;
  let h = headingDeg % 360;
  if (h < 0) h += 360;
  return h;
}

/**
 * From the compass heading the camera FACED when the reference frame was locked,
 * compute the rotation (RADIANS, counter-clockwise in the +y-up/+x-east math
 * frame) to apply to the rectified polygon so its +y axis points at TRUE NORTH.
 *
 * The rectify lands the room's far wall along +y, and that far wall is whatever
 * the camera faced. A heading of `H` degrees means the camera (and thus the
 * polygon's current +y) points H° clockwise from north. To bring +y back onto
 * north we must rotate the polygon by H° clockwise = −H° in the CCW-positive
 * math convention. Returns the angle in radians; feed to rotatePolygon().
 *
 * @param {number} headingDeg  0=N, 90=E, 180=S, 270=W (clockwise from north)
 * @returns {number} rotation in radians (CCW-positive) for rotatePolygon()
 */
export function headingToNorthRotation(headingDeg) {
  const h = normalizeHeadingDeg(headingDeg);
  return -h * DEG;
}

/**
 * Rotate a polygon about its centroid by `angleRad` (CCW-positive in a +y-up
 * frame). Rotating about the centroid (not the origin) keeps the shape put while
 * it turns — the downstream normalizeOrigin re-shifts vertex[0] to (0,0) anyway,
 * so the pivot only affects intermediate coords, never the committed shape.
 * Returns a NEW array; input untouched.
 *
 * @param {{x:number,y:number}[]} vertices
 * @param {number} angleRad
 * @returns {{x:number,y:number}[]}
 */
export function rotatePolygon(vertices, angleRad) {
  if (!Array.isArray(vertices) || vertices.length === 0) return [];
  if (!Number.isFinite(angleRad) || angleRad === 0) {
    return vertices.map(v => ({ x: v.x, y: v.y }));
  }
  let cx = 0, cy = 0;
  for (const v of vertices) { cx += v.x; cy += v.y; }
  cx /= vertices.length; cy /= vertices.length;
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  return vertices.map(v => {
    const dx = v.x - cx, dy = v.y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  });
}

/**
 * Orient a rectified (camera-relative) polygon to TRUE NORTH using the compass
 * heading recorded at lock time. Thin convenience wrapper: heading → rotation →
 * rotatePolygon. When `headingDeg` is null/undefined/non-finite (sensor absent
 * or permission denied) returns a COPY unchanged — the graceful-degrade path
 * (plan keeps its camera-relative orientation; never blocked on sensors).
 *
 * @param {{x:number,y:number}[]} vertices  rectified polygon (+y = camera-far)
 * @param {number|null|undefined} headingDeg  compass heading at lock, or null
 * @returns {{x:number,y:number}[]}  polygon with +y ≈ true north (or a copy)
 */
export function applyHeadingToPolygon(vertices, headingDeg) {
  if (headingDeg == null || !Number.isFinite(headingDeg)) {
    return (vertices || []).map(v => ({ x: v.x, y: v.y }));
  }
  return rotatePolygon(vertices, headingToNorthRotation(headingDeg));
}
