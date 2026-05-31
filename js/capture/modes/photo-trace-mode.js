// Photo-trace capture mode (P2) — "shoot the floor, tap the corners, get a rough
// plan". Browser side: getUserMedia live camera (environment-facing) by default,
// file-input fallback when the camera is denied/unavailable (plan §9 Q2). Freeze
// a frame to a <canvas>, drop 4 draggable markers on the floor corners, rectify
// with the pure ./geometry/photo-rectify.js homography strategy, anchor scale
// with one known edge length, then commit through the SINGLE writer.
//
// This mode owns its own full-screen overlay UI and runs the whole flow
// (capture → tap → rectify → scale-anchor → commit). It exposes the CaptureMode
// contract (id/isAvailable/start→CaptureSession{done,cancel}) so a future
// mode-picker / orchestrator can drive it uniformly; today it is started
// directly like manual-mode. The `done` Promise resolves with the committed
// CaptureResult (scaleResolved:true) or null on cancel.
//
// ── +y = NORTH mapping (cross-surface invariant — FLAG TO SAM) ──────────────
// The user is instructed to tap the 4 floor corners CLOCKWISE starting at the
// FAR-LEFT corner: [farLeft, farRight, nearRight, nearLeft]. photo-rectify maps
// image-"far/up" → plan +y and image-"right" → plan +x (DST_UNIT layout), so the
// rectified polygon lands with the room's far wall toward +y = north and east to
// the right — the same convention the 2D viewport / 3D top-down ortho / print
// plan SVG all use. No extra flip is applied here; the rectify destination IS the
// state frame. Register this in tests/cross-surface-conventions.test.mjs.
//
// ── Leak discipline (Martina rule) ──────────────────────────────────────────
// cancel() AND the confirm path BOTH call teardown(), which: stops every
// MediaStream track (camera LED off), cancels any pending RAF, removes every
// listener, revokes object URLs, and removes the overlay from the DOM. A
// getUserMedia track left running keeps the camera active across the whole app.

import { commitCapturedRoom } from '../capture-flow.js';
import { rectifyFloorQuad } from '../geometry/photo-rectify.js';
import { ensureCCW } from '../geometry/polygon-ops.js';
import { rescalePolygonToEdgeLength, edgeLength, doorWidthDefault } from '../geometry/scale-anchor.js';

const BUILD = '[photo-trace] build 2026-05-31 v734 — rectify+scale-anchor+getUserMedia teardown';

// Default corner colours / sizes — fat-finger friendly (44px hit target ≈ Apple HIG).
const MARKER_R = 22;            // visual radius (px, CSS)
const HIT_R = 30;               // touch hit radius (px, CSS) — generous
const CORNER_LABELS = ['far-left', 'far-right', 'near-right', 'near-left'];

/** @type {import('../capture-flow.js').CaptureMode} */
export const photoTraceMode = {
  id: 'photo',
  label: 'From a photo',
  isAvailable: () => typeof document !== 'undefined',
  start(host, ctx) {
    const session = new PhotoTraceSession(host || document.body, ctx || {});
    return {
      done: session.done,
      cancel: () => session.teardown(null),
    };
  },
};

class PhotoTraceSession {
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
    this.stream = null;             // MediaStream from getUserMedia
    this.raf = 0;                   // requestAnimationFrame id (live preview loop)
    this.objectUrls = [];           // createObjectURL handles to revoke
    this.disposers = [];            // () => void listener removers
    this.video = null;
    this.torn = false;

    // Capture state.
    this.frozenBitmap = null;       // ImageBitmap | HTMLImageElement of the frozen frame
    this.frameW = 0;
    this.frameH = 0;
    // 4 corners in IMAGE pixel coords (frozen-frame space), tap order
    // [farLeft, farRight, nearRight, nearLeft]. Seeded to a centred quad.
    this.corners = null;
    this.dragIndex = -1;

    this._resolve = null;
    this.done = new Promise((res) => { this._resolve = res; });

    this._buildOverlay();
    this._startCamera();
  }

  // ── DOM scaffold ──────────────────────────────────────────────────────────
  _buildOverlay() {
    const ov = document.createElement('div');
    ov.className = 'capture-photo-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', 'Capture room from a photo');
    Object.assign(ov.style, {
      position: 'fixed', inset: '0', zIndex: '10000',
      background: '#0b0e13', display: 'flex', flexDirection: 'column',
      touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
      color: '#e8edf3', font: '14px/1.4 system-ui, -apple-system, sans-serif',
    });
    this.overlay = ov;

    // Header: title + cancel.
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 14px', flex: '0 0 auto', background: '#12161d',
      borderBottom: '1px solid #232a35',
    });
    const title = document.createElement('div');
    title.textContent = 'Capture room from a photo';
    title.style.fontWeight = '600';
    const closeBtn = this._button('✕ Cancel', () => this.teardown(null));
    closeBtn.style.background = 'transparent';
    closeBtn.style.border = '1px solid #3a4350';
    header.append(title, closeBtn);

    // Stage (video / canvas + markers live here).
    const stage = document.createElement('div');
    Object.assign(stage.style, {
      position: 'relative', flex: '1 1 auto', minHeight: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    });
    this.stage = stage;

    // Instruction banner — "rough, then drag" honesty (Maya copy direction).
    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'absolute', top: '8px', left: '50%', transform: 'translateX(-50%)',
      maxWidth: '92%', textAlign: 'center', padding: '6px 12px',
      background: 'rgba(10,14,20,0.82)', borderRadius: '8px', fontSize: '13px',
      pointerEvents: 'none', zIndex: '5',
    });
    this.banner = banner;
    stage.append(banner);

    // Footer: action buttons (change per phase).
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

  // listener registration that auto-disposes
  _on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this.disposers.push(() => el.removeEventListener(type, fn, opts));
  }

  _setBanner(text) { this.banner.textContent = text; }
  _setFooter(...nodes) {
    this.footer.replaceChildren(...nodes.filter(Boolean));
  }

  // ── Phase 1: live camera (default) → file fallback ──────────────────────────
  async _startCamera() {
    this._setBanner('Point at the floor so all four wall corners are visible, then Capture.');
    const md = (typeof navigator !== 'undefined') && navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') {
      this._useFileFallback('Live camera is not available on this browser. Pick a photo instead.');
      return;
    }
    try {
      this.stream = await md.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false,
      });
      if (this.torn) { this._stopStream(); return; }   // cancelled mid-await
      const video = document.createElement('video');
      video.playsInline = true; video.muted = true; video.autoplay = true;
      video.setAttribute('playsinline', '');           // iOS Safari inline
      Object.assign(video.style, { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' });
      video.srcObject = this.stream;
      this.video = video;
      this.stage.insertBefore(video, this.banner);
      await video.play().catch(() => {});
      this._setFooter(
        this._button('📷 Capture', () => this._freezeFromVideo(), true),
        this._button('🖼 Use a photo instead', () => this._useFileFallback()),
      );
    } catch (err) {
      // Permission denied / no device / insecure context → file fallback.
      this._useFileFallback('Camera permission denied or unavailable. Pick a photo instead.');
    }
  }

  _useFileFallback(msg) {
    this._stopStream();
    if (this.video) { try { this.video.srcObject = null; } catch {} this.video.remove(); this.video = null; }
    if (msg) this._setBanner(msg);
    else this._setBanner('Pick a photo of the room floor with all four corners visible.');
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.setAttribute('capture', 'environment');     // hints rear camera on mobile
    input.style.display = 'none';
    this.overlay.appendChild(input);
    this._on(input, 'change', () => {
      const file = input.files && input.files[0];
      if (file) this._freezeFromFile(file);
    });
    this._setFooter(
      this._button('🖼 Choose photo', () => input.click(), true),
    );
  }

  // ── Freeze a frame → ImageBitmap, then go to tap phase ──────────────────────
  async _freezeFromVideo() {
    const v = this.video;
    if (!v || !v.videoWidth) return;
    this.frameW = v.videoWidth; this.frameH = v.videoHeight;
    let bmp;
    try { bmp = await createImageBitmap(v); }
    catch { bmp = this._canvasSnapshot(v, v.videoWidth, v.videoHeight); }
    if (this.torn) return;
    this._stopStream();                                // camera LED off the instant we have the frame
    if (this.video) { try { this.video.srcObject = null; } catch {} this.video.remove(); this.video = null; }
    this.frozenBitmap = bmp;
    this._enterTapPhase();
  }

  async _freezeFromFile(file) {
    const url = URL.createObjectURL(file);
    this.objectUrls.push(url);
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; })
      .catch(() => {});
    if (this.torn) return;
    if (!img.naturalWidth) { this._setBanner('Could not read that image — try another.'); return; }
    this.frameW = img.naturalWidth; this.frameH = img.naturalHeight;
    this.frozenBitmap = img;
    this._enterTapPhase();
  }

  // Fallback snapshot when createImageBitmap is unavailable.
  _canvasSnapshot(src, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return c;
  }

  // ── Phase 2: tap / drag the 4 floor corners ────────────────────────────────
  _enterTapPhase() {
    this._setBanner('Drag the 4 dots onto the floor corners — far-left, far-right, near-right, near-left. Rough is fine; you can fix it later.');

    // Canvas sized to its on-screen box; we keep a separate image→canvas scale.
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { maxWidth: '100%', maxHeight: '100%', touchAction: 'none', display: 'block' });
    this.canvas = canvas;
    this.stage.insertBefore(canvas, this.banner);

    // Seed corners as a centred quad in IMAGE space (a parallelogram the user nudges).
    const w = this.frameW, h = this.frameH;
    this.corners = [
      { x: w * 0.30, y: h * 0.30 },   // far-left
      { x: w * 0.70, y: h * 0.30 },   // far-right
      { x: w * 0.80, y: h * 0.78 },   // near-right
      { x: w * 0.20, y: h * 0.78 },   // near-left
    ];

    this._fitCanvas();
    // Re-fit on resize/orientation change.
    this._on(window, 'resize', () => { this._fitCanvas(); this._draw(); });

    // Pointer events (covers mouse + touch + pen) — fat-finger hit radius.
    this._on(canvas, 'pointerdown', (e) => this._onPointerDown(e));
    this._on(canvas, 'pointermove', (e) => this._onPointerMove(e));
    this._on(canvas, 'pointerup', (e) => this._onPointerUp(e));
    this._on(canvas, 'pointercancel', (e) => this._onPointerUp(e));

    this._setFooter(
      this._button('↺ Retake', () => this._retake()),
      this._button('✓ Use these corners', () => this._enterScalePhase(), true),
    );
    this._draw();
  }

  // Compute the canvas pixel size + the image→canvas display scale so taps map back.
  _fitCanvas() {
    const box = this.stage.getBoundingClientRect();
    const maxW = Math.max(64, box.width - 8);
    const maxH = Math.max(64, box.height - 8);
    const scale = Math.min(maxW / this.frameW, maxH / this.frameH);
    this.dispScale = scale;                       // canvas px per image px
    const cssW = Math.round(this.frameW * scale);
    const cssH = Math.round(this.frameH * scale);
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this._dpr = dpr;
  }

  // image-space point → canvas backing-store px
  _imgToCanvas(p) {
    return { x: p.x * this.dispScale * this._dpr, y: p.y * this.dispScale * this._dpr };
  }
  // pointer event (clientX/Y) → image-space point
  _eventToImage(e) {
    const r = this.canvas.getBoundingClientRect();
    const cx = (e.clientX - r.left);             // CSS px in canvas
    const cy = (e.clientY - r.top);
    return { x: cx / this.dispScale, y: cy / this.dispScale };
  }

  _onPointerDown(e) {
    e.preventDefault();
    const p = this._eventToImage(e);
    // Nearest corner within hit radius (in CSS px terms).
    let best = -1, bestD = (HIT_R / this.dispScale);
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(this.corners[i].x - p.x, this.corners[i].y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.dragIndex = best;
    if (best >= 0) {
      try { this.canvas.setPointerCapture(e.pointerId); } catch {}
      this._draw();
    }
  }
  _onPointerMove(e) {
    if (this.dragIndex < 0) return;
    e.preventDefault();
    const p = this._eventToImage(e);
    // Clamp into the image so a corner can't be dragged off-frame.
    this.corners[this.dragIndex] = {
      x: Math.max(0, Math.min(this.frameW, p.x)),
      y: Math.max(0, Math.min(this.frameH, p.y)),
    };
    this._draw();
  }
  _onPointerUp(e) {
    if (this.dragIndex >= 0) { try { this.canvas.releasePointerCapture(e.pointerId); } catch {} }
    this.dragIndex = -1;
    this._draw();
  }

  // Draw frozen frame + the trace quad + corner markers + a faint rectified grid.
  _draw() {
    const ctx = this.canvas.getContext('2d');
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (this.frozenBitmap) ctx.drawImage(this.frozenBitmap, 0, 0, W, H);

    const pc = this.corners.map(c => this._imgToCanvas(c));

    // Quad fill + outline.
    ctx.beginPath();
    ctx.moveTo(pc[0].x, pc[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pc[i].x, pc[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(76,139,245,0.16)';
    ctx.fill();
    ctx.lineWidth = 3 * this._dpr;
    ctx.strokeStyle = '#4c8bf5';
    ctx.stroke();

    // Markers + index labels.
    for (let i = 0; i < 4; i++) {
      const m = pc[i];
      const active = (i === this.dragIndex);
      ctx.beginPath();
      ctx.arc(m.x, m.y, MARKER_R * this._dpr * (active ? 1.25 : 1), 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(76,139,245,0.95)' : 'rgba(255,255,255,0.92)';
      ctx.fill();
      ctx.lineWidth = 3 * this._dpr;
      ctx.strokeStyle = '#4c8bf5';
      ctx.stroke();
      ctx.fillStyle = active ? '#fff' : '#12161d';
      ctx.font = `${14 * this._dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), m.x, m.y);
    }
  }

  _retake() {
    // Clear frozen frame, restart the camera/file phase.
    if (this.canvas) { this.canvas.remove(); this.canvas = null; }
    this.frozenBitmap = null; this.corners = null;
    this._startCamera();
  }

  // ── Phase 3: scale anchor (one known edge length) → commit ──────────────────
  _enterScalePhase() {
    // Rectify NOW so we can reject a degenerate tap before asking for a length.
    const planRaw = rectifyFloorQuad(this.corners);
    if (!planRaw) {
      this._setBanner('Those corners are too flat/collinear to form a room — spread the 4 dots into a quad and try again.');
      return;
    }
    // CCW for downstream winding (triangulation / wall ids).
    this.planUnscaled = ensureCCW(planRaw);

    this._setBanner('Pick one wall whose real length you know, type its length, then Done. Default is a standard door width.');

    // Edge selector + length input + door default.
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' });

    const edgeSel = document.createElement('select');
    Object.assign(edgeSel.style, { padding: '10px', borderRadius: '8px', minHeight: '44px', background: '#1b212b', color: '#e8edf3', border: '1px solid #3a4350' });
    const n = this.planUnscaled.length;
    for (let i = 0; i < n; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      const lbl = i < 4 ? CORNER_LABELS[i] : `corner ${i + 1}`;
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

    const unit = document.createElement('span');
    unit.textContent = 'm';

    const doorBtn = this._button('🚪 Door (default)', () => { lenInput.value = String(doorWidthDefault(this.region)); });
    doorBtn.style.minHeight = '44px';

    wrap.append(document.createTextNode('Length of'), edgeSel, document.createTextNode('='), lenInput, unit, doorBtn);

    this._setFooter(
      this._button('↺ Back to corners', () => this._enterTapPhase()),
      wrap,
      this._button('✓ Done', () => this._commit(parseFloat(lenInput.value)), true),
    );
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
      provenance: 'photo',
      // Single-photo 4-point homography on a non-survey tap → advisory-low.
      confidence: 0.4,
    };

    // commitCapturedRoom is the SINGLE writer (origin-shift, bbox, surfaces.edges,
    // scene:reset). It validates (≥3 verts, scale resolved, not self-intersecting)
    // and returns false if the result is bad — keep the user in the editor.
    const ok = commitCapturedRoom(result);
    if (!ok) {
      this._setBanner('That shape was rejected (self-intersecting or too few corners). Go back and adjust the corners.');
      return;
    }
    // Hand off: the user lands in the room-2d editable polygon to drag-correct.
    // (Editor-handoff seam — see deliverable note. The committed room is already
    // live + editable via the existing 2D viewport drag-vertex behaviour.)
    this.teardown(result);
  }

  // ── Teardown — releases EVERYTHING (leak rule) ──────────────────────────────
  _stopStream() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) { try { t.stop(); } catch {} }
      this.stream = null;
    }
  }

  /** @param {import('../capture-flow.js').CaptureResult|null} result */
  teardown(result) {
    if (this.torn) return;
    this.torn = true;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this._stopStream();                                   // camera LED OFF
    if (this.video) { try { this.video.srcObject = null; } catch {} this.video = null; }
    for (const dispose of this.disposers) { try { dispose(); } catch {} }
    this.disposers.length = 0;
    for (const url of this.objectUrls) { try { URL.revokeObjectURL(url); } catch {} }
    this.objectUrls.length = 0;
    if (this.frozenBitmap && typeof this.frozenBitmap.close === 'function') {
      try { this.frozenBitmap.close(); } catch {}        // release ImageBitmap GPU mem
    }
    this.frozenBitmap = null;
    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
    const r = this._resolve; this._resolve = null;
    if (r) r(result);
  }
}

export default photoTraceMode;
