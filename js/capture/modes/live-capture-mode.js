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

const BUILD = '[live-capture] build 2026-05-31 v736 — pan+tap LK marker-stick + single-ref rectify';

const MARKER_R = 20;          // visual radius (CSS px)
const HIT_R = 30;             // touch hit radius (CSS px) — fat-finger friendly
const TRACK_W = 160;          // tracking raster width (px) — downsampled, iOS-cheap
const MIN_CORNERS = 3;        // a triangle is the smallest committable room
const CORNER_HINT = ['far-left', 'far-right', 'near-right', 'near-left'];

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
    this.disposers = [];
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

    this._resolve = null;
    this.done = new Promise((res) => { this._resolve = res; });

    this._buildOverlay();
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

  _setBanner(text) { this.banner.textContent = text; }
  _setFooter(...nodes) { this.footer.replaceChildren(...nodes.filter(Boolean)); }
  _updateCounter() {
    const n = this.corners.length;
    this.counter.textContent = n === 0 ? 'Tap a corner to begin'
      : `${n} corner${n === 1 ? '' : 's'} placed${n >= MIN_CORNERS ? ' — Lock when done' : ''}`;
  }

  // ── Phase 1: live camera (default) → file fallback ──────────────────────────
  async _startCamera() {
    this._setBanner('Point at a floor corner and tap it. Pan slowly to the next corner — markers follow the walls.');
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
      this._useFileFallback('Camera permission denied or unavailable. Pick a photo instead.');
    }
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
    this._on(window, 'resize', () => this._fitCanvas());

    // Tap = place a new corner (in video-frame coords). Tap-near = grab to drag.
    this._on(canvas, 'pointerdown', (e) => this._onPointerDown(e));
    this._on(canvas, 'pointermove', (e) => this._onPointerMove(e));
    this._on(canvas, 'pointerup', (e) => this._onPointerUp(e));
    this._on(canvas, 'pointercancel', (e) => this._onPointerUp(e));

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
          // Off-screen (or lost) → carry by the median pan so it stays roughly placed.
          this.corners[i].x += pan.dx / this.trackScale;
          this.corners[i].y += pan.dy / this.trackScale;
          this.corners[i].valid = onScreen ? false : this.corners[i].valid;
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

    const pc = this.corners.map(c => this._imgToCanvas(c));
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
      // A triangle: synthesise a 4th corner to seat the homography, then drop it.
      // Use the parallelogram completion of the first three (p0 + p2 − p1).
      const [a, b, c] = this.refCorners;
      const fourth = { x: a.x + c.x - b.x, y: a.y + c.y - b.y };
      const quad = rectifyFloorQuad([a, b, c, fourth]);
      planRaw = quad ? quad.slice(0, 3) : null;
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
    this.planUnscaled = ensureCCW(planRaw);
    this._enterScalePhase();
  }

  _restartCamera() {
    if (this.canvas) { this.canvas.remove(); this.canvas = null; }
    this.corners = []; this.prevGray = null; this.dragIndex = -1;
    this._startCamera();
  }

  // ── Phase 4: scale anchor (one known edge length) → commit ──────────────────
  _enterScalePhase() {
    this._setBanner('Pick one wall whose real length you know, type its length, then Done. Default is a standard door width.');

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
    for (const dispose of this.disposers) { try { dispose(); } catch {} }
    this.disposers.length = 0;
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
    this._on(window, 'resize', () => { this._fitCanvas(); this._drawStill(); });
    this._on(canvas, 'pointerdown', (e) => this._onStillPointerDown(e));
    this._on(canvas, 'pointermove', (e) => this._onPointerMove(e));
    this._on(canvas, 'pointerup', (e) => this._onPointerUp(e));
    this._on(canvas, 'pointercancel', (e) => this._onPointerUp(e));
    this._setFooter(
      this._button('↺ Choose another', () => this._restartStill()),
      this._button('✓ Use these corners', () => this._lockReferenceFrame(), true),
    );
    this._drawStill();
  }

  _restartStill() {
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
