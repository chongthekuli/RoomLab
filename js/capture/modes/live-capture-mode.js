// Room Capture — LIVE pan-and-tap capture mode (the "modern video way").
// Browser side: getUserMedia live camera (environment-facing), a per-frame
// Lucas-Kanade tracker that makes tapped corner markers "stick" to wall points
// as the phone pans, tap-any-N-corners (not just 4), drag-correct, then ONE
// homography rectify from a chosen reference frame → scale-anchor → commit
// through the SINGLE writer. Replaces the static single-photo mode (product
// owner: a single frame can't fit a whole room's corners).
//
// ═══════════════════════════════════════════════════════════════════════════
// THE CV MECHANISM DECISION (settled 2026-05-31, Viktor) — read before editing.
//
// PROBLEM: corners tapped across a PAN are seen in different camera frames.
// Without pose estimation (WebXR/ARKit absent in Safari; monocular SLAM has
// unavoidable scale ambiguity; web VIO drifts on iOS's loosely-synced sensors —
// research verdict, not re-litigated) how do they become ONE coherent polygon?
//
// CHOICE: option (a) — optical-flow marker-stick for UX + single REFERENCE-FRAME
// rectify. NOT (b) panorama homography-chaining.
//
//   • Lucas-Kanade (js/capture/geometry/optical-flow.js) tracks each placed
//     marker frame-to-frame so it STAYS on its wall corner while the user pans
//     to reach the next corner. Markers that pan off-screen are carried by the
//     robust median inter-frame translation (a BOUNDED accumulator) so the user
//     can still see/adjust roughly where they are.
//   • When the user taps "Lock floor view", we snapshot the CURRENT frame as the
//     REFERENCE frame and read every marker's position IN THAT FRAME. The plan
//     geometry is recovered by ONE homography (photo-rectify) on the 4 corners
//     that bound the room in that single reference frame; extra (>4) corners map
//     through the SAME H. Off-reference-frame error only affects where a marker
//     visually sits — the homography is still a single-view rectification.
//
// WHY NOT (b) frame-to-frame homography CHAIN: a hand-held room pan is mostly
// TRANSLATIONAL, which violates the homography model (valid only for pure
// rotation or a planar scene). Chaining accumulates drift unboundedly on
// feature-poor walls. It would let off-screen corners "persist" but produce a
// confidently-wrong polygon — the exact failure we refuse to ship. (a) can only
// degrade UX (a marker slides), never geometry.
//
// HONEST ACCURACY / FAILURE MODES (state plainly to the user via copy):
//   • The plan is a SINGLE-VIEW perspective rectification — same accuracy class
//     as the old photo mode, but the pan lets the user place corners that don't
//     all fit in one frame. Expect ±5–15% on the rough shape before drag-correct.
//   • Tracking drifts on blank walls / low light / fast pans / motion blur. When
//     a marker's LK track loses confidence it's flagged "drifting" (dimmed) and
//     the user re-drags it. Drift NEVER corrupts committed geometry.
//   • Scale is ALWAYS anchored by ONE known real dimension (scale-anchor step) —
//     never inferred from the camera. The user lands in the editable polygon to
//     drag-correct. This is "rough, then drag", honestly.
// ═══════════════════════════════════════════════════════════════════════════
//
// ── +y = NORTH mapping (cross-surface invariant — FLAG TO SAM) ──────────────
// Corners are tapped CLOCKWISE in the image starting at the FAR-LEFT floor
// corner. photo-rectify's DST_UNIT maps image "far/up" → plan +y and image
// "right" → plan +x, so the rectified polygon lands with the room's far wall
// toward +y = north and east to the right — the convention the 2D viewport / 3D
// top-down ortho / print plan SVG all use. No extra flip here; the rectify
// destination IS the state frame. Register in tests/cross-surface-conventions.
//
// ── Leak discipline (Martina rule) ──────────────────────────────────────────
// teardown() (called by BOTH cancel and the commit path) stops EVERY MediaStream
// track (camera LED off), cancels the rVFC/rAF frame loop, removes every
// listener, revokes object URLs, closes ImageBitmaps, and removes the overlay.
// The frame loop is idempotent-safe: the per-frame callback checks `this.torn`
// and re-registration is gated so a late frame after teardown is a no-op.

import { commitCapturedRoom } from '../capture-flow.js';
import { rectifyFloorQuad } from '../geometry/photo-rectify.js';
import { ensureCCW } from '../geometry/polygon-ops.js';
import { rescalePolygonToEdgeLength, doorWidthDefault } from '../geometry/scale-anchor.js';
import { trackPoints, medianTranslation, rgbaToGray } from '../geometry/optical-flow.js';
import { levelPlaneFromGravity, applyHeadingToPolygon } from '../geometry/orientation.js';

const BUILD = '[live-capture] build 2026-05-31 v738 — sensor-fusion (gravity+compass) + guided coaching overlay + iframe guard';

const MARKER_R = 20;          // visual radius (CSS px)
const HIT_R = 30;             // touch hit radius (CSS px) — fat-finger friendly
const TRACK_W = 160;          // tracking raster width (px) — downsampled, iOS-cheap
const MIN_CORNERS = 3;        // a triangle is the smallest committable room
const CORNER_HINT = ['far-left', 'far-right', 'near-right', 'near-left'];

// Coaching thresholds (cheap, frame-rate; one cue at a time, least-intrusive).
const DARK_LUMA = 55;         // mean frame luma (0..255) below this ⇒ "too dark"
const SHAKE_ACCEL = 3.2;      // |linear accel| m/s² above this ⇒ "hold steadier"
const CUE_MIN_MS = 900;       // don't flip the cue more often than this (anti-flicker)

// Standalone full-screen URL surfaced when the camera is blocked inside an
// iframe (Google Sites embed). Same origin/repo as the deploy.
const STANDALONE_URL = 'https://chongthekuli.github.io/RoomLab/#/room';

// Are we running inside an <iframe> (e.g. the Google Sites embed)? getUserMedia
// + DeviceOrientation need the PARENT to grant allow="camera; gyroscope;
// accelerometer" AND the gesture inside the frame; when that's missing the calls
// reject with NotAllowedError/SecurityError and the user sees a black screen
// unless we explain it.
function isFramed() {
  try { return window.self !== window.top; } catch { return true; }  // cross-origin access throws ⇒ framed
}
function isPermissionError(err) {
  const n = err && err.name;
  return n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError';
}

// Clamp a dead-reckoned off-screen marker coordinate to a sane envelope around the
// frame ([−span, 2·span]) so the carry accumulator stays BOUNDED — a marker that
// pans off-screen can drift one frame-width past the edge and no further, then
// reappears when the user pans back, instead of flying to x=50000 (P2-1).
function clampEnvelope(v, span) {
  return Math.max(-span, Math.min(2 * span, v));
}

/** @type {import('../capture-flow.js').CaptureMode} */
export const liveCaptureMode = {
  id: 'photo',                // KEEP id 'photo' — it replaces the photo registry slot
  label: 'Scan with camera',
  isAvailable: () => typeof document !== 'undefined',
  start(host, ctx) {
    const session = new LiveCaptureSession(host || document.body, ctx || {});
    return {
      done: session.done,
      cancel: () => session.teardown(null),
    };
  },
};

class LiveCaptureSession {
  /**
   * @param {HTMLElement} host
   * @param {{ region?: string }} ctx
   */
  constructor(host, ctx) {
    console.info(BUILD);
    this.host = host;
    this.ctx = ctx || {};
    this.region = this.ctx.region || 'default';

    // Resources to release in teardown() — track every one (leak rule).
    this.stream = null;
    this.raf = 0;             // requestAnimationFrame id (fallback loop)
    this.rvfcHandle = 0;      // requestVideoFrameCallback handle
    this.objectUrls = [];
    this.disposers = [];        // SESSION-lifetime listeners (header/footer buttons, sensors)
    this.phaseDisposers = [];   // PHASE-scoped listeners (window resize + canvas pointer
                                // binds) — drained on every rescan so retrying the scan
                                // can't accumulate stale resize/pointer handlers (P0-1).
    this.video = null;
    this.torn = false;

    // ── Capture state ──────────────────────────────────────────────────────
    // Corners live in VIDEO-FRAME pixel coords (the live video's intrinsic
    // videoWidth × videoHeight space), updated every frame by LK so they stick.
    // Each: { x, y, valid }  (valid=false ⇒ track is drifting → dimmed).
    this.corners = [];
    this.dragIndex = -1;
    this.frameW = 0; this.frameH = 0;       // video intrinsic size

    // Tracking scratch: previous downsampled grayscale frame + the scale from
    // video px → tracking-raster px (corners are tracked in raster space).
    this.prevGray = null;
    this.trackScale = 1;                    // raster px per video px
    this.trackCanvas = null;                // offscreen canvas for the small raster
    this.frozenBitmap = null;               // reference-frame snapshot (lock step)

    // ── Sensor fusion (DeviceOrientation/Motion) — all OPTIONAL, never blocks ──
    // Listeners are removed in teardown (new leak surface). Values are nullable:
    // null ⇒ unavailable / denied ⇒ graceful degrade to today's behaviour.
    this.sensorRemovers = [];               // listener disposers (also pushed to disposers)
    this.heading = null;                    // deg, compass heading (0=N, CW), live
    this.gravity = null;                    // { x,y,z } accelerationIncludingGravity, live
    this.accelMag = 0;                      // |linear accel| m/s² (shake detector)
    this.lastFrameLuma = 255;               // mean frame luminance (dark detector)
    this.coachCue = '';                     // current coaching string ('' = none)
    this._coachAt = 0;                      // last cue-change timestamp (anti-flicker)

    this._resolve = null;
    this.done = new Promise((res) => { this._resolve = res; });

    this._buildOverlay();
    // Request motion/orientation permission FIRST, still inside the start gesture
    // (iOS 13+ gates the data behind a user-gesture prompt). Fire-and-forget — the
    // camera path does not wait on it; sensors are pure enhancement.
    this._requestSensors();
    this._startCamera();
  }

  // ── DOM scaffold ──────────────────────────────────────────────────────────
  _buildOverlay() {
    const ov = document.createElement('div');
    ov.className = 'capture-live-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', 'Scan room with camera');
    Object.assign(ov.style, {
      position: 'fixed', inset: '0', zIndex: '10000',
      background: '#0b0e13', display: 'flex', flexDirection: 'column',
      touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
      color: '#e8edf3', font: '14px/1.4 system-ui, -apple-system, sans-serif',
    });
    this.overlay = ov;

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 14px', flex: '0 0 auto', background: '#12161d',
      borderBottom: '1px solid #232a35',
    });
    const title = document.createElement('div');
    title.textContent = 'Scan room with camera';
    title.style.fontWeight = '600';
    const closeBtn = this._button('✕ Cancel', () => this.teardown(null));
    closeBtn.style.background = 'transparent';
    closeBtn.style.border = '1px solid #3a4350';
    header.append(title, closeBtn);

    const stage = document.createElement('div');
    Object.assign(stage.style, {
      position: 'relative', flex: '1 1 auto', minHeight: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    });
    this.stage = stage;

    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'absolute', top: '8px', left: '50%', transform: 'translateX(-50%)',
      maxWidth: '92%', textAlign: 'center', padding: '6px 12px',
      background: 'rgba(10,14,20,0.82)', borderRadius: '8px', fontSize: '13px',
      pointerEvents: 'none', zIndex: '5',
    });
    this.banner = banner;
    stage.append(banner);

    // Live tap-count chip (bottom-left of stage).
    const counter = document.createElement('div');
    Object.assign(counter.style, {
      position: 'absolute', bottom: '8px', left: '8px', padding: '4px 10px',
      background: 'rgba(10,14,20,0.82)', borderRadius: '8px', fontSize: '12px',
      pointerEvents: 'none', zIndex: '5',
    });
    this.counter = counter;
    stage.append(counter);

    // Coaching cue chip (bottom-centre) — at most one cue at a time, unobtrusive.
    // Amber so it reads as advice, not an error. Hidden when there's no cue.
    const coach = document.createElement('div');
    Object.assign(coach.style, {
      position: 'absolute', bottom: '8px', left: '50%', transform: 'translateX(-50%)',
      padding: '5px 12px', background: 'rgba(40,30,8,0.88)', color: '#ffd27a',
      border: '1px solid #5a4416', borderRadius: '8px', fontSize: '12px',
      pointerEvents: 'none', zIndex: '6', display: 'none', maxWidth: '70%',
      textAlign: 'center',
    });
    this.coach = coach;
    stage.append(coach);

    const footer = document.createElement('div');
    Object.assign(footer.style, {
      display: 'flex', gap: '10px', padding: '12px 14px', flex: '0 0 auto',
      background: '#12161d', borderTop: '1px solid #232a35', flexWrap: 'wrap',
      alignItems: 'center',
    });
    this.footer = footer;

    ov.append(header, stage, footer);
    this.host.appendChild(ov);
  }

  _button(label, onClick, primary = false) {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      padding: '11px 16px', borderRadius: '8px', cursor: 'pointer',
      font: 'inherit', fontWeight: '600', minHeight: '44px',
      border: primary ? 'none' : '1px solid #3a4350',
      background: primary ? '#4c8bf5' : '#1b212b',
      color: primary ? '#fff' : '#e8edf3',
    });
    this._on(b, 'click', onClick);
    return b;
  }

  _on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this.disposers.push(() => el.removeEventListener(type, fn, opts));
  }

  // PHASE-scoped listener bind. Use this (not _on) for anything created inside a
  // scan/tap phase that is re-entered on rescan — the window 'resize' handler and
  // the canvas pointer handlers. _clearPhase() drains these at every phase exit so
  // a Lock→reject→rescan (or "↺ Rescan") loop can't leave a stale resize handler
  // bound to a discarded canvas/dispScale on each cycle (P0-1).
  _onPhase(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this.phaseDisposers.push(() => el.removeEventListener(type, fn, opts));
  }

  _clearPhase() {
    for (const d of this.phaseDisposers) { try { d(); } catch {} }
    this.phaseDisposers.length = 0;
  }

  _setBanner(text) { this.banner.textContent = text; }
  _setFooter(...nodes) { this.footer.replaceChildren(...nodes.filter(Boolean)); }
  _updateCounter() {
    const n = this.corners.length;
    // Per-corner prompt (RoomPlan-style): name the next corner for the first 4,
    // then a generic prompt; surface the loop-close hint once ≥ MIN_CORNERS.
    let prompt;
    if (n === 0) prompt = 'Point at the FAR-LEFT floor corner, then tap';
    else if (n < 4) prompt = `Point at the ${CORNER_HINT[n]} corner, then tap`;
    else prompt = 'Point at the next corner, then tap';
    const placed = n === 0 ? '' : ` · ${n} placed`;
    const lockHint = n >= MIN_CORNERS ? ' · Lock when the loop is closed' : '';
    this.counter.textContent = prompt + placed + lockHint;
  }

  // Coaching cue: dark / shaky scene. One cue at a time, least-intrusive wins,
  // rate-limited so it doesn't strobe. Sensors absent ⇒ shake cue simply never
  // fires (graceful). Called once per frame.
  _updateCoach() {
    let cue = '';
    if (this.lastFrameLuma < DARK_LUMA) cue = '💡 Too dark — turn on more light';
    else if (this.accelMag > SHAKE_ACCEL) cue = '✋ Hold steadier';
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (cue !== this.coachCue && (now - this._coachAt) >= CUE_MIN_MS) {
      this.coachCue = cue; this._coachAt = now;
      if (this.coach) {
        this.coach.textContent = cue;
        this.coach.style.display = cue ? 'block' : 'none';
      }
    }
  }

  // ── Sensor fusion: DeviceOrientation (compass) + DeviceMotion (gravity/shake) ─
  // ALL optional. iOS 13+ gates the data behind a permission prompt that must be
  // called from a user gesture (the start tap, satisfied — see constructor).
  // Android / desktop Chrome / older iOS expose the events without a prompt
  // (feature-detected). Permission denial / no sensors → we never attach the
  // listeners and the whole pipeline degrades to today's camera-relative plan.
  async _requestSensors() {
    const OE = (typeof window !== 'undefined') ? window.DeviceOrientationEvent : null;
    const ME = (typeof window !== 'undefined') ? window.DeviceMotionEvent : null;
    if (!OE && !ME) return;                          // no sensors at all
    try {
      // iOS gate: requestPermission() exists only there. Promise → 'granted'|'denied'.
      const needsOriPerm = OE && typeof OE.requestPermission === 'function';
      const needsMotPerm = ME && typeof ME.requestPermission === 'function';
      let oriOk = true, motOk = true;
      if (needsOriPerm) oriOk = (await OE.requestPermission()) === 'granted';
      if (needsMotPerm) motOk = (await ME.requestPermission()) === 'granted';
      if (this.torn) return;                         // cancelled mid-prompt
      if (OE && oriOk) this._attachOrientation();
      if (ME && motOk) this._attachMotion();
    } catch (err) {
      // requestPermission throws inside a cross-origin iframe (SecurityError) —
      // not fatal; the camera path surfaces the iframe guidance. Sensors just
      // stay off (graceful degrade).
      if (!isPermissionError(err)) console.warn('[live-capture] sensor permission:', err);
    }
  }

  _attachOrientation() {
    const onOri = (e) => {
      // iOS exposes a TRUE compass heading via webkitCompassHeading (0=N, CW).
      // Elsewhere, `alpha` is the Z-axis rotation; absolute orientation gives a
      // compass-like value (browser-dependent). Prefer the iOS field; fall back
      // to alpha when the event is flagged absolute (or as a best-effort).
      const wk = (typeof e.webkitCompassHeading === 'number') ? e.webkitCompassHeading : null;
      if (wk != null && Number.isFinite(wk)) {
        this.heading = wk;
      } else if (typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
        // alpha grows counter-clockwise from the device's reference; a compass
        // heading is clockwise from north → 360 − alpha as a best-effort.
        this.heading = (360 - e.alpha) % 360;
      }
    };
    window.addEventListener('deviceorientation', onOri);
    const rm = () => window.removeEventListener('deviceorientation', onOri);
    this.sensorRemovers.push(rm); this.disposers.push(rm);
  }

  _attachMotion() {
    const onMot = (e) => {
      const g = e.accelerationIncludingGravity;
      if (g && (g.x != null || g.y != null || g.z != null)) {
        this.gravity = { x: g.x || 0, y: g.y || 0, z: g.z || 0 };
      }
      const a = e.acceleration;                       // gravity-removed (when available)
      if (a && (a.x != null || a.y != null || a.z != null)) {
        this.accelMag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
      }
    };
    window.addEventListener('devicemotion', onMot);
    const rm = () => window.removeEventListener('devicemotion', onMot);
    this.sensorRemovers.push(rm); this.disposers.push(rm);
  }

  // ── Phase 1: live camera (default) → file fallback ──────────────────────────
  async _startCamera() {
    this._setBanner('Rough shape — pan slowly and tap each floor corner. You’ll set one real measurement next (not survey-grade).');
    const md = (typeof navigator !== 'undefined') && navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') {
      this._useFileFallback('Live camera is not available on this browser. Pick a photo instead.');
      return;
    }
    try {
      this.stream = await md.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false,
      });
      if (this.torn) { this._stopStream(); return; }       // cancelled mid-await
      const video = document.createElement('video');
      video.playsInline = true; video.muted = true; video.autoplay = true;
      video.setAttribute('playsinline', '');               // iOS Safari inline
      Object.assign(video.style, { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' });
      video.srcObject = this.stream;
      this.video = video;
      await video.play().catch(() => {});
      if (this.torn) { this._stopStream(); return; }
      this._enterLiveTapPhase();
    } catch (err) {
      // Inside a Google Sites iframe the camera is blocked unless the parent set
      // allow="camera; gyroscope; accelerometer". Don't leave a black screen —
      // explain it and offer the standalone full-screen URL. A genuine on-device
      // denial (not framed) still falls back to the file picker.
      if (isFramed() && isPermissionError(err)) {
        this._showIframeBlock();
      } else {
        this._useFileFallback('Camera permission denied or unavailable. Pick a photo instead.');
      }
    }
  }

  // Camera blocked because we're embedded in an iframe without camera permission.
  // Surface a clear message + a link to open RoomLab standalone (where the
  // gesture + getUserMedia work). Also offers the photo-file fallback so the
  // user isn't fully stuck inside the frame.
  _showIframeBlock() {
    this._stopStream();
    this._setBanner('The camera can’t open inside this embedded view.');
    const card = document.createElement('div');
    Object.assign(card.style, {
      maxWidth: '340px', textAlign: 'center', padding: '18px',
      background: '#12161d', border: '1px solid #232a35', borderRadius: '12px',
      lineHeight: '1.5',
    });
    const msg = document.createElement('div');
    msg.textContent = 'Open RoomLab in full screen (a new browser tab) to scan with the camera. Embedded views block camera access.';
    msg.style.marginBottom = '14px';
    const link = document.createElement('a');
    link.href = STANDALONE_URL; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = '↗ Open RoomLab in a new tab';
    Object.assign(link.style, {
      display: 'inline-block', padding: '11px 16px', borderRadius: '8px',
      background: '#4c8bf5', color: '#fff', textDecoration: 'none', fontWeight: '600',
      minHeight: '44px', boxSizing: 'border-box',
    });
    card.append(msg, link);
    // Replace the stage contents with the guidance card.
    for (const n of Array.from(this.stage.children)) {
      if (n !== this.banner && n !== this.counter) n.remove();
    }
    this.stage.insertBefore(card, this.banner);
    this._setFooter(
      this._button('Use a photo instead', () => { card.remove(); this._useFileFallback(); }),
      this._button('Close', () => this.teardown(null)),
    );
  }

  // ── Phase 2 (LIVE): pan + tap corners; LK keeps markers stuck ──────────────
  _enterLiveTapPhase() {
    this.frameW = this.video.videoWidth || 1280;
    this.frameH = this.video.videoHeight || 720;

    // The overlay canvas sits ON TOP of the live <video>, matched in size.
    this.video.style.position = 'absolute';
    this.stage.insertBefore(this.video, this.banner);

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      position: 'absolute', maxWidth: '100%', maxHeight: '100%',
      touchAction: 'none', display: 'block',
    });
    this.canvas = canvas;
    this.stage.insertBefore(canvas, this.banner);

    // Offscreen raster used for LK tracking — small, fixed-width, cheap on iOS.
    this.trackScale = TRACK_W / this.frameW;     // raster px per video px
    const tcw = TRACK_W;
    const tch = Math.max(1, Math.round(this.frameH * this.trackScale));
    const tc = document.createElement('canvas');
    tc.width = tcw; tc.height = tch;
    this.trackCanvas = tc;
    this.trackCtx = tc.getContext('2d', { willReadFrequently: true });

    this._fitCanvas();
    // PHASE-scoped (drained on rescan) — see _onPhase / P0-1.
    this._onPhase(window, 'resize', () => this._fitCanvas());

    // Tap = place a new corner (in video-frame coords). Tap-near = grab to drag.
    this._onPhase(canvas, 'pointerdown', (e) => this._onPointerDown(e));
    this._onPhase(canvas, 'pointermove', (e) => this._onPointerMove(e));
    this._onPhase(canvas, 'pointerup', (e) => this._onPointerUp(e));
    this._onPhase(canvas, 'pointercancel', (e) => this._onPointerUp(e));

    this._refreshFooter();
    this._updateCounter();

    // Kick the frame loop (rVFC preferred, rAF fallback).
    this.prevGray = null;
    this._startFrameLoop();
  }

  _refreshFooter() {
    const canLock = this.corners.length >= MIN_CORNERS;
    const undoBtn = this._button('↶ Undo', () => this._undoCorner());
    undoBtn.disabled = this.corners.length === 0;
    undoBtn.style.opacity = this.corners.length === 0 ? '0.5' : '1';
    const lockBtn = this._button('🔒 Lock floor view', () => this._lockReferenceFrame(), true);
    lockBtn.disabled = !canLock;
    lockBtn.style.opacity = canLock ? '1' : '0.5';
    this._setFooter(undoBtn, lockBtn);
  }

  _undoCorner() {
    if (this.corners.length > 0) { this.corners.pop(); this.dragIndex = -1; }
    this._refreshFooter(); this._updateCounter();
  }

  // ── Frame loop ─────────────────────────────────────────────────────────────
  _startFrameLoop() {
    const v = this.video;
    if (typeof v.requestVideoFrameCallback === 'function') {
      const cb = () => {
        if (this.torn) return;
        this._onFrame();
        this.rvfcHandle = v.requestVideoFrameCallback(cb);
      };
      this.rvfcHandle = v.requestVideoFrameCallback(cb);
    } else {
      const cb = () => {
        if (this.torn) return;
        this._onFrame();
        this.raf = requestAnimationFrame(cb);
      };
      this.raf = requestAnimationFrame(cb);
    }
  }

  // One live frame: grab a downsampled gray raster, LK-track every marker so it
  // sticks to its wall point, carry off-screen markers by the robust median
  // pan, then redraw the overlay. Cheap: tracking only the placed corners on a
  // 160px-wide raster.
  _onFrame() {
    const v = this.video;
    if (!v || !v.videoWidth) { this._draw(); return; }
    // Draw the current video frame into the small tracking raster.
    const tc = this.trackCanvas, tctx = this.trackCtx;
    try { tctx.drawImage(v, 0, 0, tc.width, tc.height); }
    catch { this._draw(); return; }            // not ready / cross-origin guard
    const rgba = tctx.getImageData(0, 0, tc.width, tc.height);
    const gray = rgbaToGray(rgba);

    // Cheap coaching signal: mean luma of the (already-downsampled) gray raster.
    // Subsample (every 4th px) so even the small raster stays nearly free.
    let sum = 0, cnt = 0;
    for (let i = 0; i < gray.data.length; i += 4) { sum += gray.data[i]; cnt++; }
    this.lastFrameLuma = cnt ? sum / cnt : 255;
    this._updateCoach();

    if (this.prevGray && this.corners.length > 0 && this.dragIndex < 0) {
      // Track in RASTER space: video → raster on the way in, raster → video out.
      const fromRaster = this.corners.map(c => ({ x: c.x * this.trackScale, y: c.y * this.trackScale }));
      const to = trackPoints(this.prevGray, gray, fromRaster, { levels: 3, win: 7, minEig: 8e-4 });
      const pan = medianTranslation(fromRaster, to);   // bounded accumulator for off-screen
      for (let i = 0; i < this.corners.length; i++) {
        const r = to[i];
        const onScreen = fromRaster[i].x >= 0 && fromRaster[i].y >= 0
          && fromRaster[i].x <= tc.width && fromRaster[i].y <= tc.height;
        if (onScreen && r.valid) {
          // Marker visible + tracked → snap to the tracked wall point.
          this.corners[i].x = r.x / this.trackScale;
          this.corners[i].y = r.y / this.trackScale;
          this.corners[i].valid = true;
        } else if (pan.n > 0) {
          // Off-screen (or lost) → carry by the median pan so it stays roughly
          // placed. CLAMP to a sane envelope so an off-screen marker can't drift to
          // x=50000 and never reappear (and can't feed a wild ref corner into the
          // lock homography) — makes the "BOUNDED accumulator" claim above true
          // (P2-1). Carried markers are DEAD-RECKONED, not tracked, so flag them
          // invalid → drawn dimmed (the drift honesty cue) (P2-5).
          this.corners[i].x = clampEnvelope(this.corners[i].x + pan.dx / this.trackScale, this.frameW);
          this.corners[i].y = clampEnvelope(this.corners[i].y + pan.dy / this.trackScale, this.frameH);
          this.corners[i].valid = false;
        } else {
          this.corners[i].valid = false;    // no motion estimate, flag as drifting
        }
      }
    }
    this.prevGray = gray;
    this._draw();
  }

  // Fit the overlay canvas + video to the stage box, preserving aspect.
  _fitCanvas() {
    const box = this.stage.getBoundingClientRect();
    const maxW = Math.max(64, box.width - 8);
    const maxH = Math.max(64, box.height - 8);
    const scale = Math.min(maxW / this.frameW, maxH / this.frameH);
    this.dispScale = scale;                          // CSS px per video px
    const cssW = Math.round(this.frameW * scale);
    const cssH = Math.round(this.frameH * scale);
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this._dpr = dpr;
    if (this.canvas) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.canvas.style.width = cssW + 'px';
      this.canvas.style.height = cssH + 'px';
    }
    if (this.video) { this.video.style.width = cssW + 'px'; this.video.style.height = cssH + 'px'; }
  }

  // video-frame point → canvas backing-store px
  _imgToCanvas(p) { return { x: p.x * this.dispScale * this._dpr, y: p.y * this.dispScale * this._dpr }; }
  // pointer event → video-frame point
  _eventToImage(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.dispScale, y: (e.clientY - r.top) / this.dispScale };
  }

  _onPointerDown(e) {
    e.preventDefault();
    const p = this._eventToImage(e);
    // Grab an existing nearby marker to drag-correct it.
    let best = -1, bestD = HIT_R / this.dispScale;
    for (let i = 0; i < this.corners.length; i++) {
      const d = Math.hypot(this.corners[i].x - p.x, this.corners[i].y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      this.dragIndex = best;
      try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    } else {
      // Otherwise place a NEW corner here (tap-to-add, any N).
      this.corners.push({
        x: Math.max(0, Math.min(this.frameW, p.x)),
        y: Math.max(0, Math.min(this.frameH, p.y)),
        valid: true,
      });
      this._refreshFooter(); this._updateCounter();
    }
    this._draw();
  }
  _onPointerMove(e) {
    if (this.dragIndex < 0) return;
    e.preventDefault();
    const p = this._eventToImage(e);
    const c = this.corners[this.dragIndex];
    c.x = Math.max(0, Math.min(this.frameW, p.x));
    c.y = Math.max(0, Math.min(this.frameH, p.y));
    c.valid = true;                          // a hand-placed corner is trusted
    this._repaint();
  }
  _onPointerUp(e) {
    if (this.dragIndex >= 0) { try { this.canvas.releasePointerCapture(e.pointerId); } catch {} }
    this.dragIndex = -1;
    this._repaint();
  }

  // Live mode paints transparent markers over the <video>; still mode must also
  // repaint the frozen background image first.
  _repaint() { if (this.isStill) this._drawStill(); else this._draw(); }

  // Draw the corner markers + connecting polygon over the live video.
  _draw() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);                // transparent — the <video> shows through

    // Centre crosshair / target reticle (live aim only — not on the still image).
    if (!this.isStill) {
      const cx = W / 2, cy = H / 2, r = 14 * this._dpr;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 2 * this._dpr;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - r * 1.7, cy); ctx.lineTo(cx - r * 0.5, cy);
      ctx.moveTo(cx + r * 0.5, cy); ctx.lineTo(cx + r * 1.7, cy);
      ctx.moveTo(cx, cy - r * 1.7); ctx.lineTo(cx, cy - r * 0.5);
      ctx.moveTo(cx, cy + r * 0.5); ctx.lineTo(cx, cy + r * 1.7);
      ctx.stroke();
      ctx.restore();
    }

    const pc = this.corners.map(c => this._imgToCanvas(c));

    // Loop-closure hint: once ≥ MIN_CORNERS, pulse a ring on corner 1 so the
    // user knows tapping/locking near it closes the room.
    if (!this.isStill && pc.length >= MIN_CORNERS) {
      const m0 = pc[0];
      ctx.save();
      ctx.strokeStyle = 'rgba(76,245,160,0.9)'; ctx.lineWidth = 2.5 * this._dpr;
      ctx.setLineDash([5 * this._dpr, 5 * this._dpr]);
      ctx.beginPath(); ctx.arc(m0.x, m0.y, (MARKER_R + 8) * this._dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    if (pc.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pc[0].x, pc[0].y);
      for (let i = 1; i < pc.length; i++) ctx.lineTo(pc[i].x, pc[i].y);
      if (pc.length >= 3) ctx.closePath();
      if (pc.length >= 3) { ctx.fillStyle = 'rgba(76,139,245,0.16)'; ctx.fill(); }
      ctx.lineWidth = 3 * this._dpr; ctx.strokeStyle = '#4c8bf5'; ctx.stroke();
    }
    for (let i = 0; i < pc.length; i++) {
      const m = pc[i];
      const active = (i === this.dragIndex);
      const drifting = this.corners[i].valid === false;
      ctx.globalAlpha = drifting ? 0.45 : 1;
      ctx.beginPath();
      ctx.arc(m.x, m.y, MARKER_R * this._dpr * (active ? 1.25 : 1), 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(76,139,245,0.95)' : 'rgba(255,255,255,0.92)';
      ctx.fill();
      ctx.lineWidth = 3 * this._dpr; ctx.strokeStyle = drifting ? '#e0a44c' : '#4c8bf5'; ctx.stroke();
      ctx.fillStyle = active ? '#fff' : '#12161d';
      ctx.font = `${14 * this._dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), m.x, m.y);
      ctx.globalAlpha = 1;
    }
  }

  // ── Phase 3: LOCK the reference frame → rectify → scale anchor ──────────────
  _lockReferenceFrame() {
    if (this.corners.length < MIN_CORNERS) return;
    // Snapshot the marker positions in the CURRENT frame as the reference set.
    // This single frame defines the homography — everything before was just UX
    // to let the user place corners that didn't fit in one view.
    this.refCorners = this.corners.map(c => ({ x: c.x, y: c.y }));

    // Snapshot the sensor state AT LOCK TIME: the compass heading the camera
    // faced (→ orient the plan to true north) and the gravity vector (→ was the
    // phone level enough to trust the rectify?). Both may be null (degrade).
    this.lockHeading = this.heading;
    this.lockLevel = this.gravity ? levelPlaneFromGravity(this.gravity) : null;

    // Hide the live-only coaching/counter chips — we're leaving the scan phase.
    if (this.coach) { this.coach.style.display = 'none'; this.coachCue = ''; }
    if (this.counter) this.counter.style.display = 'none';

    // Stop the live loop + camera now — we have what we need (LED off promptly).
    this._stopFrameLoop();
    this._stopStream();
    if (this.video) { try { this.video.srcObject = null; } catch {} this.video.remove(); this.video = null; }

    // Rectify: the first 4 tapped corners bound the room rectangle; any extra
    // corners (notches / N-gon) map through the SAME homography (rectifyFloorQuad
    // exposes extraImagePoints exactly for this).
    const first4 = this.refCorners.slice(0, 4);
    let planRaw;
    if (this.refCorners.length === 3) {
      // A triangle (the advertised MIN_CORNERS=3): do NOT route through the 4-point
      // homography. Three points under-determine an 8-DOF homography, and the
      // synthesised-4th-corner trick makes a near-collinear quad that
      // isDegenerateQuad rightly rejects for MANY valid triangles — bouncing the
      // user off the smallest legal room with "too flat, spread them out" (P1-1).
      // Instead pass the raw tapped triangle straight to the scale step: it's
      // already a "rough, drag-to-fix" plan and no perspective rectification is
      // possible from 3 points anyway. Flip image-y (origin top-left, y↓) so the
      // image-far direction becomes plan +y = north, matching the rectify path's
      // DST_UNIT convention.
      planRaw = this.refCorners.map(p => ({ x: p.x, y: -p.y }));
    } else if (this.refCorners.length === 4) {
      planRaw = rectifyFloorQuad(first4);
    } else {
      planRaw = rectifyFloorQuad(first4, { extraImagePoints: this.refCorners.slice(4) });
    }

    if (!planRaw) {
      // Re-enter live tapping so the user can spread the corners.
      this._setBanner('Those corners are too flat/collinear to form a room — spread them out and tap again.');
      this.refCorners = null;
      this._restartCamera();
      return;
    }
    // Orient to TRUE NORTH using the compass heading at lock time. The rectify
    // lands the camera-far wall along +y; applyHeadingToPolygon rotates the whole
    // shape so +y points at real-world north (cross-surface +y=north convention —
    // flagged to Sam). Null heading ⇒ returns a copy unchanged (camera-relative).
    const oriented = applyHeadingToPolygon(planRaw, this.lockHeading);
    this.planUnscaled = ensureCCW(oriented);
    this._enterScalePhase();
  }

  _restartCamera() {
    this._clearPhase();   // drop the previous phase's resize + pointer handlers (P0-1)
    if (this.canvas) { this.canvas.remove(); this.canvas = null; }
    this.corners = []; this.prevGray = null; this.dragIndex = -1;
    if (this.counter) this.counter.style.display = '';
    this._startCamera();
  }

  // ── Phase 4: scale anchor (one known edge length) → commit ──────────────────
  _enterScalePhase() {
    // Leaving the tap phase for good — drop its resize + pointer handlers so they
    // don't outlive the canvas they referenced (P0-1).
    this._clearPhase();
    // Scale anchor is MANDATORY — a browser can't get metric scale automatically
    // (no LiDAR / no exposed VIO), so ONE known real measurement is the accuracy
    // linchpin. State it plainly and don't let the user finish without it.
    let banner = 'Required: set one real measurement. Tap the wall you know, type its length, then Done. This rough plan is not survey-grade.';
    if (this.lockLevel && this.lockLevel.level === false) {
      banner = 'Heads-up: the phone was tilted at lock, so the shape may be skewed — drag corners to fix it later. ' + banner;
    }
    this._setBanner(banner);

    // Show a still preview of the rectified plan so the scale step isn't blind.
    if (this.canvas) { this.canvas.remove(); this.canvas = null; }
    const preview = document.createElement('canvas');
    Object.assign(preview.style, { maxWidth: '100%', maxHeight: '100%', display: 'block' });
    this.stage.insertBefore(preview, this.banner);
    this._drawPlanPreview(preview, this.planUnscaled);

    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' });

    const edgeSel = document.createElement('select');
    Object.assign(edgeSel.style, { padding: '10px', borderRadius: '8px', minHeight: '44px', background: '#1b212b', color: '#e8edf3', border: '1px solid #3a4350' });
    const n = this.planUnscaled.length;
    for (let i = 0; i < n; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Wall ${i + 1}`;
      edgeSel.appendChild(opt);
    }
    this.scaleEdgeIndex = 0;
    this._on(edgeSel, 'change', () => { this.scaleEdgeIndex = parseInt(edgeSel.value, 10) || 0; });

    const lenInput = document.createElement('input');
    lenInput.type = 'number'; lenInput.min = '0.1'; lenInput.step = '0.01';
    lenInput.value = String(doorWidthDefault(this.region));
    lenInput.setAttribute('aria-label', 'Real wall length in metres');
    Object.assign(lenInput.style, { padding: '10px', width: '90px', borderRadius: '8px', minHeight: '44px', background: '#1b212b', color: '#e8edf3', border: '1px solid #3a4350' });

    const unit = document.createElement('span'); unit.textContent = 'm';
    const doorBtn = this._button('🚪 Door (default)', () => { lenInput.value = String(doorWidthDefault(this.region)); });
    doorBtn.style.minHeight = '44px';

    wrap.append(document.createTextNode('Length of'), edgeSel, document.createTextNode('='), lenInput, unit, doorBtn);

    this._setFooter(
      this._button('↺ Rescan', () => { preview.remove(); this._restartCamera(); }),
      wrap,
      this._button('✓ Done', () => this._commit(parseFloat(lenInput.value)), true),
    );
  }

  // Tiny top-down preview of the unscaled plan polygon (fit into the canvas box).
  _drawPlanPreview(canvas, poly) {
    const box = this.stage.getBoundingClientRect();
    const cssW = Math.max(64, Math.min(box.width - 8, 420));
    const cssH = Math.max(64, Math.min(box.height - 8, 420));
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const w = maxX - minX || 1, h = maxY - minY || 1;
    const pad = 30 * dpr;
    const s = Math.min((canvas.width - 2 * pad) / w, (canvas.height - 2 * pad) / h);
    // +y = north → up: flip Y for screen (screen y grows downward).
    const tx = (p) => pad + (p.x - minX) * s;
    const ty = (p) => canvas.height - pad - (p.y - minY) * s;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.moveTo(tx(poly[0]), ty(poly[0]));
    for (let i = 1; i < poly.length; i++) ctx.lineTo(tx(poly[i]), ty(poly[i]));
    ctx.closePath();
    ctx.fillStyle = 'rgba(76,139,245,0.16)'; ctx.fill();
    ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#4c8bf5'; ctx.stroke();
    ctx.fillStyle = '#9fb4d6'; ctx.font = `${12 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('rough plan (drag to fix after)', canvas.width / 2, 18 * dpr);
  }

  _commit(lengthM) {
    if (!(lengthM > 0) || !Number.isFinite(lengthM)) {
      this._setBanner('Enter a positive wall length in metres (e.g. 3.2).');
      return;
    }
    const scaled = rescalePolygonToEdgeLength(this.planUnscaled, this.scaleEdgeIndex, lengthM);

    /** @type {import('../capture-flow.js').CaptureResult} */
    const result = {
      vertices: scaled,                       // real metres now, +y = north
      scaleResolved: true,
      scaleHint: { edgeIndex: this.scaleEdgeIndex, lengthHint_m: lengthM },
      heightHint_m: null,
      provenance: 'photo',                    // single-view rectification class
      // Pan-and-tap single-reference-frame homography on a non-survey tap →
      // advisory-low (same class as the old photo mode; the pan only helps
      // reach corners that didn't fit one frame).
      confidence: 0.4,
    };

    const ok = commitCapturedRoom(result);
    if (!ok) {
      this._setBanner('That shape was rejected (self-intersecting or too few corners). Rescan or adjust.');
      return;
    }
    this.teardown(result);
  }

  // ── Teardown — releases EVERYTHING (leak rule) ──────────────────────────────
  _stopStream() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) { try { t.stop(); } catch {} }
      this.stream = null;
    }
  }
  _stopFrameLoop() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.rvfcHandle && this.video && typeof this.video.cancelVideoFrameCallback === 'function') {
      try { this.video.cancelVideoFrameCallback(this.rvfcHandle); } catch {}
    }
    this.rvfcHandle = 0;
  }

  /** @param {import('../capture-flow.js').CaptureResult|null} result */
  teardown(result) {
    if (this.torn) return;
    this.torn = true;                                     // gate any late frame cb
    this._stopFrameLoop();
    this._stopStream();                                   // camera LED OFF
    if (this.video) { try { this.video.srcObject = null; } catch {} this.video = null; }
    // Remove sensor listeners explicitly too (they were also pushed to disposers,
    // but clearing here makes the new leak surface unmistakable + idempotent).
    for (const rm of this.sensorRemovers) { try { rm(); } catch {} }
    this.sensorRemovers.length = 0;
    this.heading = null; this.gravity = null;
    for (const dispose of this.disposers) { try { dispose(); } catch {} }
    this.disposers.length = 0;
    // Drain phase-scoped listeners too (resize + pointer binds) — they may not have
    // been cleared yet if teardown fires mid-scan (cancel / commit). Idempotent.
    this._clearPhase();
    for (const url of this.objectUrls) { try { URL.revokeObjectURL(url); } catch {} }
    this.objectUrls.length = 0;
    if (this.frozenBitmap && typeof this.frozenBitmap.close === 'function') {
      try { this.frozenBitmap.close(); } catch {}
    }
    this.frozenBitmap = null;
    this.prevGray = null; this.trackCanvas = null; this.trackCtx = null;
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
    const r = this._resolve; this._resolve = null;
    if (r) r(result);
  }

  // ── File fallback (camera denied) — single still frame, classic tap-4 ───────
  _useFileFallback(msg) {
    this._stopStream();
    if (this.video) { try { this.video.srcObject = null; } catch {} this.video.remove(); this.video = null; }
    this._setBanner(msg || 'Pick a photo of the room floor with the corners visible.');
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    this.overlay.appendChild(input);
    this._on(input, 'change', () => {
      const file = input.files && input.files[0];
      if (file) this._freezeFromFile(file);
    });
    this._setFooter(this._button('🖼 Choose photo', () => input.click(), true));
  }

  async _freezeFromFile(file) {
    const url = URL.createObjectURL(file);
    this.objectUrls.push(url);
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }).catch(() => {});
    if (this.torn) return;
    if (!img.naturalWidth) { this._setBanner('Could not read that image — try another.'); return; }
    this.frameW = img.naturalWidth; this.frameH = img.naturalHeight;
    this.frozenBitmap = img;
    // Reuse the live tap UI on the still image: no frame loop, markers are
    // static. We draw the still as the canvas background instead of the video.
    this._enterStillTapPhase();
  }

  // Still-image tap (no tracking): seed a centred quad the user nudges, like the
  // old photo mode. Shares the draw + scale + commit path.
  _enterStillTapPhase() {
    this._setBanner('Drag dots onto the floor corners (far-left, far-right, near-right, near-left). Rough is fine; fix it later.');
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { position: 'absolute', maxWidth: '100%', maxHeight: '100%', touchAction: 'none', display: 'block' });
    this.canvas = canvas;
    this.stage.insertBefore(canvas, this.banner);
    const w = this.frameW, h = this.frameH;
    this.corners = [
      { x: w * 0.30, y: h * 0.30, valid: true }, { x: w * 0.70, y: h * 0.30, valid: true },
      { x: w * 0.80, y: h * 0.78, valid: true }, { x: w * 0.20, y: h * 0.78, valid: true },
    ];
    this.isStill = true;
    this._fitCanvas();
    // PHASE-scoped (drained on rescan / "choose another") — see _onPhase / P0-1.
    this._onPhase(window, 'resize', () => { this._fitCanvas(); this._drawStill(); });
    this._onPhase(canvas, 'pointerdown', (e) => this._onStillPointerDown(e));
    this._onPhase(canvas, 'pointermove', (e) => this._onPointerMove(e));
    this._onPhase(canvas, 'pointerup', (e) => this._onPointerUp(e));
    this._onPhase(canvas, 'pointercancel', (e) => this._onPointerUp(e));
    this._setFooter(
      this._button('↺ Choose another', () => this._restartStill()),
      this._button('✓ Use these corners', () => this._lockReferenceFrame(), true),
    );
    this._drawStill();
  }

  _restartStill() {
    this._clearPhase();   // drop the still phase's resize + pointer handlers (P0-1)
    if (this.canvas) { this.canvas.remove(); this.canvas = null; }
    this.frozenBitmap = null; this.corners = []; this.isStill = false;
    this._useFileFallback();
  }

  // Still-mode pointerdown drags the nearest of the FIXED 4 corners (no add).
  _onStillPointerDown(e) {
    e.preventDefault();
    const p = this._eventToImage(e);
    let best = -1, bestD = HIT_R / this.dispScale;
    for (let i = 0; i < this.corners.length; i++) {
      const d = Math.hypot(this.corners[i].x - p.x, this.corners[i].y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.dragIndex = best;
    if (best >= 0) { try { this.canvas.setPointerCapture(e.pointerId); } catch {} }
    this._drawStill();
  }

  _drawStill() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (this.frozenBitmap) ctx.drawImage(this.frozenBitmap, 0, 0, W, H);
    this._draw();   // markers + polygon overlay (shared)
  }
}

export default liveCaptureMode;
