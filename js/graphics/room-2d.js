import { state, earHeightFor, getSelectedListener, colorForZone, colorForGroup, expandSources } from '../app-state.js';
import { computeRoomConstant } from '../physics/spl-calculator.js';
import { on, emit } from '../ui/events.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { computeSPLGrid } from '../physics/spl-calculator.js';
import { roomPlanVertices, isInsideRoom3D } from '../physics/room-shape.js';
import { computeTicks, formatTickLabel, legendHeader } from './legend-ticks.js';

let materialsRef;

const COLOR_BANDS = [
  { max: 0.10, color: '#d93a3a', label: 'Hard (α < 0.1)' },
  { max: 0.25, color: '#e6a53a', label: 'Reflective' },
  { max: 0.45, color: '#d9c93a', label: 'Balanced' },
  { max: 0.65, color: '#7fb85a', label: 'Absorptive' },
  { max: 1.01, color: '#3a9e5a', label: 'Very absorptive' },
];

function colorFor(alpha) {
  for (const b of COLOR_BANDS) if (alpha < b.max) return b.color;
  return COLOR_BANDS[COLOR_BANDS.length - 1].color;
}

function splColor(spl_db) {
  const t = Math.max(0, Math.min(1, (spl_db - 60) / 50));
  if (t < 0.25) return interp('#1a1a4a', '#0066cc', t / 0.25);
  if (t < 0.50) return interp('#0066cc', '#00cc66', (t - 0.25) / 0.25);
  if (t < 0.75) return interp('#00cc66', '#ffcc00', (t - 0.50) / 0.25);
  return interp('#ffcc00', '#ff3300', (t - 0.75) / 0.25);
}

function interp(hex1, hex2, t) {
  const p1 = parseInt(hex1.slice(1), 16);
  const p2 = parseInt(hex2.slice(1), 16);
  const r = Math.round(((p1 >> 16) & 0xff) * (1 - t) + ((p2 >> 16) & 0xff) * t);
  const g = Math.round(((p1 >> 8)  & 0xff) * (1 - t) + ((p2 >> 8)  & 0xff) * t);
  const b = Math.round((p1 & 0xff) * (1 - t) + (p2 & 0xff) * t);
  return `rgb(${r},${g},${b})`;
}

// --- Draw mode (generic polygon draw) ---
// Default viewBox dimensions — used as a fallback if the parent
// container can't be measured (e.g., first render before mount).
// The actual viewBox is computed dynamically from the .draw-canvas
// parent container size on every render, so the grid fills the full
// viewport regardless of aspect ratio and the cursor math doesn't
// suffer letterbox offsets.
const CUSTOM_VB_DEFAULT_W = 800, CUSTOM_VB_DEFAULT_H = 500;
let CUSTOM_VB_W = CUSTOM_VB_DEFAULT_W;
let CUSTOM_VB_H = CUSTOM_VB_DEFAULT_H;
const CUSTOM_SCALE = 40;             // 1 m = 40 px → 0.5 m = 20 px
const CUSTOM_ORIGIN = { x: 60, y: 60 };
const SNAP_M = 0.5;                  // Maya §3: pros work to 0.5 m, not 0.1 m
const CLOSE_RADIUS_M = 0.6;          // Maya §2: cursor-near-vertex-1 commits as close

let drawActive = false;
let drawConfig = null;
let drawVertices = [];
let drawCursor = null;
let drawCursorNearStart = false;     // updated by handleDrawMove for visual feedback
let pendingMove = false;
// Maya §4: drag-pan moves the canvas origin without touching state.
// Hold middle-mouse OR space+left to pan. Reset via double-click on empty
// canvas (when drawVertices is still 0) or the dedicated recentre button.
const drawPan = { dx: 0, dy: 0 };
let panActive = false;
let panStart = null;
let spaceHeld = false;

// Edge auto-pan — when the cursor lingers within EDGE_PAN_BAND_PX of
// any canvas border during a draw, the canvas auto-shifts in that
// direction so the user can chase a large building outside the
// initially-visible region without manually middle-click-panning. The
// closer the cursor sits to the edge, the faster the pan.
const EDGE_PAN_BAND_PX = 60;          // band thickness measured from each border
const EDGE_PAN_MAX_PX_PER_FRAME = 9;  // peak speed at the very edge
let edgePanRAF = 0;
// Snapshot of the latest cursor for the RAF loop to re-sample.
// `event.currentTarget` is nulled after the handler returns, so we
// cache the SVG element directly.
let edgePanSampler = null;            // { svg, clientX, clientY }

export function startDrawCustomShape() {
  // Build marker — if you see this in DevTools Console you have the
  // latest room-2d.js with snap-to-grid + edge auto-pan. If you DON'T
  // see this, your browser is serving a cached copy; do "Empty cache
  // and hard reload" (Chrome: right-click the reload button) or
  // toggle DevTools Network → "Disable cache".
  console.info('[room-2d] draw started — snap-to-grid + edge auto-pan ENABLED (build 2026-04-28b)');
  drawActive = true;
  drawConfig = {
    mode: 'room-shape',
    label: 'Draw custom room shape',
    onFinish: (verts) => {
      const minX = Math.min(...verts.map(v => v.x));
      const minY = Math.min(...verts.map(v => v.y));
      const maxX = Math.max(...verts.map(v => v.x));
      const maxY = Math.max(...verts.map(v => v.y));
      const shifted = verts.map(v => ({ x: v.x - minX, y: v.y - minY }));
      state.room.shape = 'custom';
      state.room.custom_vertices = shifted;
      state.room.width_m = Math.max(maxX - minX, 0.5);
      state.room.depth_m = Math.max(maxY - minY, 0.5);
      state.room.surfaces.edges = shifted.map(() => state.room.surfaces.walls || 'gypsum-board');
    },
  };
  drawVertices = [];
  drawCursor = null;
  render();
}

export function startDrawZone(opts = {}) {
  drawActive = true;
  drawConfig = {
    mode: 'zone',
    label: opts.existingId ? 'Redraw audience zone' : 'Draw audience zone (inside room)',
    existingId: opts.existingId || null,
    onFinish: (verts) => {
      if (opts.existingId) {
        const z = state.zones.find(z => z.id === opts.existingId);
        if (z) z.vertices = verts;
      } else {
        const id = 'Z' + (state.zones.length + 1);
        state.zones.push({
          id,
          label: `Zone ${state.zones.length + 1}`,
          vertices: verts,
          elevation_m: 0,
          material_id: 'wood-floor',
        });
        state.selectedZoneId = id;
      }
    },
  };
  drawVertices = [];
  drawCursor = null;
  render();
}

function finishDraw() {
  if (drawVertices.length < 3) return;
  // Belt-and-braces filter: only finite, real-numbered vertices make
  // it through. Defends downstream consumers (scene.js
  // makeFloorCeilingShape, edge wall builder) against any Infinity
  // / NaN that might have survived the upstream guards.
  const verts = drawVertices
    .filter(v => v && Number.isFinite(v.x) && Number.isFinite(v.y))
    .map(v => ({ x: v.x, y: v.y }));
  if (verts.length < 3) return;
  const cfg = drawConfig;
  const wasRoomShape = cfg.mode === 'room-shape';
  drawActive = false;
  drawConfig = null;
  drawVertices = [];
  drawCursor = null;
  drawCursorNearStart = false;
  drawPan.dx = 0; drawPan.dy = 0;
  stopEdgePan();
  cfg.onFinish(verts);
  emit('room:changed');
  // Maya §7: after auto-close, scroll the side panel to the height
  // input and select-all so the user can replace it with one keystroke.
  // The panel-room.js listener handles the actual focus/select.
  if (wasRoomShape) {
    document.dispatchEvent(new CustomEvent('roomshape:closed'));
  }
}

function cancelDraw() {
  drawActive = false;
  drawConfig = null;
  drawVertices = [];
  drawCursor = null;
  stopEdgePan();
  render();
}

function undoDrawVertex() {
  drawVertices.pop();
  render();
}

function handleDrawClick(event) {
  if (!drawActive) return;
  if (panActive) return;       // mid-pan release should not place a vertex
  const c = drawCoordsFromEvent(event);
  // Negative coords were rejected here historically because the room
  // model assumed a positive-quadrant origin. We now accept anywhere
  // on the plane — onFinish (above) shifts the polygon so its
  // bounding-box minX/minY land on (0, 0). Non-finite coords (caused
  // by transient zero-size SVG during a route swap) are dropped so a
  // bad vertex can never enter state.
  if (!c || !Number.isFinite(c.rx) || !Number.isFinite(c.ry)) return;
  // Maya §2: cursor within 0.6 m of vertex 1 (with ≥ 3 placed) commits
  // as a close. The user clicks anywhere inside that radius and the
  // polygon closes — no pixel-perfect accuracy required.
  if (drawConfig.mode === 'room-shape' && drawVertices.length >= 3) {
    const v1 = drawVertices[0];
    const dx = c.rx - v1.x;
    const dy = c.ry - v1.y;
    if (Math.sqrt(dx * dx + dy * dy) <= CLOSE_RADIUS_M) {
      finishDraw();
      return;
    }
  }
  drawVertices.push({ x: c.rx, y: c.ry });
  render();
}

function handleDrawMove(event) {
  if (!drawActive) return;
  if (panActive) {
    // Drag-pan the viewport — translate the visible origin without
    // touching state. Updates render so origin crosshair tracks.
    const dx = event.clientX - panStart.x;
    const dy = event.clientY - panStart.y;
    drawPan.dx = panStart.startDx + dx;
    drawPan.dy = panStart.startDy + dy;
    if (!pendingMove) {
      pendingMove = true;
      requestAnimationFrame(() => { pendingMove = false; if (drawActive) render(); });
    }
    return;
  }
  const c = drawCoordsFromEvent(event);
  // SVG was detached / not yet laid out → bail; pending raf will re-
  // sample on the next mousemove once layout is stable.
  if (!c) return;
  drawCursor = c;
  // We no longer cache the SVG element here — `liveDrawSvg()` re-
  // resolves it each frame inside stepEdgePan, defending against
  // the post-render() detached-node problem.
  edgePanSampler = { clientX: event.clientX, clientY: event.clientY };
  // Update near-start flag for visual feedback (Maya §2)
  if (drawConfig.mode === 'room-shape' && drawVertices.length >= 3) {
    const v1 = drawVertices[0];
    const dx = drawCursor.rx - v1.x;
    const dy = drawCursor.ry - v1.y;
    drawCursorNearStart = Math.sqrt(dx * dx + dy * dy) <= CLOSE_RADIUS_M;
  } else {
    drawCursorNearStart = false;
  }
  // Edge auto-pan — start the RAF loop the first time the cursor
  // crosses into the edge band. The loop self-stops when the
  // cursor leaves the band.
  maybeStartEdgePan();
  if (!pendingMove) {
    pendingMove = true;
    requestAnimationFrame(() => { pendingMove = false; if (drawActive) render(); });
  }
}

// Resolve the live draw-mode SVG every frame. After each render() the
// panel re-writes innerHTML, so any cached SVG reference becomes a
// detached node whose getBoundingClientRect() returns 0×0 — causing
// division-by-zero in edgePanDelta and runaway pan deltas. Re-query
// the live element each tick so we always measure the current SVG.
function liveDrawSvg() {
  return document.querySelector('#view-2d svg');
}

// Compute pan delta (px/frame) for edge auto-pan from a cached
// { clientX, clientY } sample. Returns { dx, dy } where positive dx
// pans the canvas RIGHT (cursor near LEFT edge reveals more space to
// the left). Speed ramps linearly from 0 at the band's inner border
// to EDGE_PAN_MAX at the actual edge. Returns null if the SVG isn't
// laid out yet (zero-size rect) — defends against the
// hidden-route / detached-node edge cases that produced
// Infinity-scaled pan jumps.
function edgePanDelta(sampler) {
  if (!sampler) return null;
  const svg = liveDrawSvg();
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = sampler.clientX - rect.left;
  const y = sampler.clientY - rect.top;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let dx = 0, dy = 0;
  if (x < EDGE_PAN_BAND_PX) {
    dx = (1 - x / EDGE_PAN_BAND_PX) * EDGE_PAN_MAX_PX_PER_FRAME;
  } else if (x > rect.width - EDGE_PAN_BAND_PX) {
    dx = -((x - (rect.width - EDGE_PAN_BAND_PX)) / EDGE_PAN_BAND_PX) * EDGE_PAN_MAX_PX_PER_FRAME;
  }
  if (y < EDGE_PAN_BAND_PX) {
    dy = (1 - y / EDGE_PAN_BAND_PX) * EDGE_PAN_MAX_PX_PER_FRAME;
  } else if (y > rect.height - EDGE_PAN_BAND_PX) {
    dy = -((y - (rect.height - EDGE_PAN_BAND_PX)) / EDGE_PAN_BAND_PX) * EDGE_PAN_MAX_PX_PER_FRAME;
  }
  // Final guard: clamp to ±EDGE_PAN_MAX in case some rect quirk produces
  // out-of-range values; better to under-pan than to teleport the canvas.
  dx = Math.max(-EDGE_PAN_MAX_PX_PER_FRAME, Math.min(EDGE_PAN_MAX_PX_PER_FRAME, dx));
  dy = Math.max(-EDGE_PAN_MAX_PX_PER_FRAME, Math.min(EDGE_PAN_MAX_PX_PER_FRAME, dy));
  return { dx, dy };
}

function maybeStartEdgePan() {
  if (panActive) return;   // the user is already manually panning
  if (edgePanRAF) return;
  const d = edgePanDelta(edgePanSampler);
  if (!d || (d.dx === 0 && d.dy === 0)) return;
  edgePanRAF = requestAnimationFrame(stepEdgePan);
}

function stepEdgePan() {
  edgePanRAF = 0;
  if (!drawActive || !edgePanSampler) return;
  const d = edgePanDelta(edgePanSampler);
  if (!d || (d.dx === 0 && d.dy === 0)) return;
  drawPan.dx += d.dx;
  drawPan.dy += d.dy;
  // Recompute the cursor against the new pan offset using the LIVE
  // SVG (not a cached ref — see liveDrawSvg comment above).
  const svg = liveDrawSvg();
  if (svg) {
    const fakeEvent = {
      currentTarget: svg,
      clientX: edgePanSampler.clientX,
      clientY: edgePanSampler.clientY,
    };
    const c = drawCoordsFromEvent(fakeEvent);
    if (c && Number.isFinite(c.rx) && Number.isFinite(c.ry)) {
      drawCursor = c;
      if (drawConfig?.mode === 'room-shape' && drawVertices.length >= 3) {
        const v1 = drawVertices[0];
        const dx = drawCursor.rx - v1.x;
        const dy = drawCursor.ry - v1.y;
        drawCursorNearStart = Math.sqrt(dx * dx + dy * dy) <= CLOSE_RADIUS_M;
      }
    }
  }
  render();
  // Keep the loop alive while the cursor is still in the band.
  if (drawActive) edgePanRAF = requestAnimationFrame(stepEdgePan);
}

function stopEdgePan() {
  if (edgePanRAF) cancelAnimationFrame(edgePanRAF);
  edgePanRAF = 0;
  edgePanSampler = null;
}

function handleDrawDblClick(event) {
  event.preventDefault();
  if (!drawActive) return;
  // Maya §4: double-click on empty canvas resets pan (when no vertices
  // placed yet). Otherwise double-click finishes the draw.
  if (drawVertices.length === 0) {
    drawPan.dx = 0; drawPan.dy = 0;
    render();
    return;
  }
  finishDraw();
}

function handleDrawPanStart(event) {
  // Middle-button or Space + left-button starts a pan
  if (!drawActive) return;
  if (event.button !== 1 && !(event.button === 0 && spaceHeld)) return;
  event.preventDefault();
  panActive = true;
  panStart = {
    x: event.clientX, y: event.clientY,
    startDx: drawPan.dx, startDy: drawPan.dy,
  };
}

function handleDrawPanEnd() {
  if (panActive) {
    panActive = false;
    panStart = null;
  }
}

function handleDrawKey(event) {
  if (!drawActive) return;
  if (event.key === 'Escape')      { cancelDraw(); event.preventDefault(); }
  else if (event.key === 'Backspace') { undoDrawVertex(); event.preventDefault(); }
  else if (event.key === 'Enter')  { if (drawVertices.length >= 3) finishDraw(); event.preventDefault(); }
  else if (event.key === ' ')      { spaceHeld = true; event.preventDefault(); }
}
function handleDrawKeyUp(event) {
  if (event.key === ' ') spaceHeld = false;
}

function drawCoordsFromEvent(event) {
  const svg = event.currentTarget;
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  // Detached / hidden / not-yet-laid-out SVG → bail out cleanly so we
  // never produce Infinity or NaN coords downstream.
  if (rect.width <= 0 || rect.height <= 0) return null;

  // Convert client (pixel) coords → SVG user-space coords via the
  // browser's native CTM. This correctly handles preserveAspectRatio
  // letterbox/pillarbox, transforms, scrolling, devicePixelRatio,
  // and any future viewBox change — the previous manual math (sx =
  // (clientX - rect.left) * vbW / rect.width) assumed the element
  // rect mapped 1:1 to the viewBox, which is wrong as soon as the
  // viewBox aspect ratio differs from the element aspect ratio.
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const inv = ctm.inverse();
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const userPt = pt.matrixTransform(inv);
  const sx = userPt.x;
  const sy = userPt.y;

  if (drawConfig.mode === 'room-shape') {
    const rx = (sx - CUSTOM_ORIGIN.x - drawPan.dx) / CUSTOM_SCALE;
    const ry = (sy - CUSTOM_ORIGIN.y - drawPan.dy) / CUSTOM_SCALE;
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
    const snap = (v) => Math.round(v / SNAP_M) * SNAP_M;
    return { sx, sy, rx: snap(rx), ry: snap(ry) };
  }
  // zone mode: use current room scale
  const geom = currentRoomGeom();
  const rx = (sx - geom.x0) / geom.scale;
  const ry = (sy - geom.y0) / geom.scale;
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
  return { sx, sy, rx: Math.round(rx * 100) / 100, ry: Math.round(ry * 100) / 100 };
}

function currentRoomGeom() {
  const { width_m: w, depth_m: d } = state.room;
  const vbW = 800, vbH = 500, pad = 90;
  const scale = Math.min((vbW - pad * 2) / w, (vbH - pad * 2) / d);
  const pxW = w * scale;
  const pxD = d * scale;
  const x0 = (vbW - pxW) / 2;
  const y0 = (vbH - pxD) / 2;
  return { scale, pxW, pxD, x0, y0 };
}

// --- Mount ---
export function mount2DViewport({ materials }) {
  materialsRef = materials;
  render();
  on('room:changed', render);
  on('source:changed', render);
  on('source:model_changed', render);
  on('listener:changed', render);
  on('listener:selected', render);
  on('scene:reset', render);
  window.addEventListener('resize', render);
}

function render() {
  const vp = document.getElementById('view-2d');
  if (drawActive && drawConfig.mode === 'room-shape') { renderCustomDraw(vp); return; }
  if (drawActive && drawConfig.mode === 'zone') { renderZoneDraw(vp); return; }
  renderNormal(vp);
}

// Compute the state copy for the guide-text band based on draw state.
// Maya §2 — exact strings.
function drawGuideText() {
  if (drawConfig?.mode !== 'room-shape') {
    return drawConfig?.label ?? '';
  }
  const n = drawVertices.length;
  if (drawCursorNearStart && n >= 3) {
    return `release here to close the loop — ${n} edge${n === 1 ? '' : 's'}.`;
  }
  if (n === 0) return 'click on the grid to place point 1. press esc to cancel.';
  if (n === 1) return 'click to add point 2. snap is 0.5 m.';
  if (n === 2) return 'click to add point 3. you\'ll need at least 3 to close a polygon.';
  return `click to add point ${n + 1}. double-click to finish, or click point 1 to close.`;
}

function renderCustomDraw(vp) {
  // Dynamic viewBox sized to the parent container so the grid fills
  // the full available area instead of being letterboxed. Read the
  // .draw-canvas slot if a previous render already created it,
  // otherwise fall back to the #view-2d parent's content rect.
  const prevCanvas = vp.querySelector('.draw-canvas');
  const measureEl = prevCanvas && prevCanvas.clientHeight > 0 ? prevCanvas : vp;
  const r = measureEl.getBoundingClientRect();
  // Subtract toolbar height from total when measuring vp (vp includes
  // both toolbar and canvas; .draw-canvas is canvas-only).
  const toolbarH = (measureEl === vp) ? 50 : 0;
  CUSTOM_VB_W = Math.max(400, Math.round(r.width));
  CUSTOM_VB_H = Math.max(300, Math.round(r.height - toolbarH));

  // Maya §3: origin shifted by viewport pan offset
  const x0 = CUSTOM_ORIGIN.x + drawPan.dx;
  const y0 = CUSTOM_ORIGIN.y + drawPan.dy;
  const minor = CUSTOM_SCALE * SNAP_M;            // 20 px = 0.5 m
  const major = CUSTOM_SCALE * 5;                 // 200 px = 5 m

  let svg = `<svg viewBox="0 0 ${CUSTOM_VB_W} ${CUSTOM_VB_H}" preserveAspectRatio="xMidYMid meet" tabindex="0">`;
  // Two stacked grid layers, minor first, major on top.
  svg += `<defs>
    <pattern id="gridp-minor" width="${minor}" height="${minor}" x="${x0 % minor}" y="${y0 % minor}" patternUnits="userSpaceOnUse">
      <path d="M ${minor} 0 L 0 0 0 ${minor}" fill="none" stroke="#1f242c" stroke-width="0.5"/>
    </pattern>
    <pattern id="gridp-major" width="${major}" height="${major}" x="${x0 % major}" y="${y0 % major}" patternUnits="userSpaceOnUse">
      <path d="M ${major} 0 L 0 0 0 ${major}" fill="none" stroke="#2f3744" stroke-width="1"/>
    </pattern>
  </defs>`;
  svg += `<rect width="${CUSTOM_VB_W}" height="${CUSTOM_VB_H}" fill="#13161c" />`;
  svg += `<rect width="${CUSTOM_VB_W}" height="${CUSTOM_VB_H}" fill="url(#gridp-minor)" />`;
  svg += `<rect width="${CUSTOM_VB_W}" height="${CUSTOM_VB_H}" fill="url(#gridp-major)" />`;

  // 5 m tick labels along top + left edges (only on majors that fall
  // inside the viewport). Skip the label at world-origin — the
  // crosshair already labels itself.
  const minXm = -x0 / CUSTOM_SCALE;
  const maxXm = (CUSTOM_VB_W - x0) / CUSTOM_SCALE;
  const minYm = -y0 / CUSTOM_SCALE;
  const maxYm = (CUSTOM_VB_H - y0) / CUSTOM_SCALE;
  for (let m = Math.ceil(minXm / 5) * 5; m <= maxXm; m += 5) {
    if (m === 0) continue;
    svg += `<text x="${x0 + m * CUSTOM_SCALE}" y="14" fill="#5a6677" font-size="9" text-anchor="middle">${m} m</text>`;
  }
  for (let m = Math.ceil(minYm / 5) * 5; m <= maxYm; m += 5) {
    if (m === 0) continue;
    svg += `<text x="6" y="${y0 + m * CUSTOM_SCALE + 3}" fill="#5a6677" font-size="9">${m} m</text>`;
  }

  // Always-visible origin crosshair (Maya §2)
  svg += renderOriginCrosshair(x0, y0, '#7a89a0');

  svg += renderDrawOverlay(x0, y0, CUSTOM_SCALE, '#4a8ff0');
  svg += `</svg>`;

  vp.innerHTML = buildDrawHtml(svg);
  wireDrawEvents(vp);
}

// Origin crosshair: 14 px stroke arms with a 4 px gap at centre.
// Used in BOTH custom-draw and normal modes so the user always knows
// where world (0, 0) sits on the canvas. Per Maya v9 audit §4 the
// `0.0, 0.0 m` text is dropped — the crosshair is self-explanatory
// to anyone using a 2D CAD tool, and the text was clutter at low
// contrast that nobody read.
function renderOriginCrosshair(x0, y0, color = '#5a6677') {
  const armLen = 14, gap = 4;
  return `
    <line x1="${x0 - armLen - gap}" y1="${y0}" x2="${x0 - gap}" y2="${y0}" stroke="${color}" stroke-width="1"/>
    <line x1="${x0 + gap}" y1="${y0}" x2="${x0 + armLen + gap}" y2="${y0}" stroke="${color}" stroke-width="1"/>
    <line x1="${x0}" y1="${y0 - armLen - gap}" x2="${x0}" y2="${y0 - gap}" stroke="${color}" stroke-width="1"/>
    <line x1="${x0}" y1="${y0 + gap}" x2="${x0}" y2="${y0 + armLen + gap}" stroke="${color}" stroke-width="1"/>
  `;
}

function renderZoneDraw(vp) {
  const { width_m: w, depth_m: d, height_m: h, surfaces, shape } = state.room;
  const bandIdx = materialsRef.frequency_bands_hz.indexOf(500);
  const useIdx = bandIdx >= 0 ? bandIdx : Math.floor(materialsRef.frequency_bands_hz.length / 2);
  const alphaOf = id => materialsRef.byId[id]?.absorption[useIdx] ?? 0;
  const nameOf = id => materialsRef.byId[id]?.name ?? id;

  const geom = currentRoomGeom();
  const { x0, y0, pxW, pxD, scale } = geom;

  const roomOutline = renderRoomOutline(state.room, x0, y0, pxW, pxD, alphaOf, nameOf, surfaces);
  const clipPathSvg = renderClipPath(state.room, x0, y0, pxW, pxD);
  const zoneColor = colorForZone(state.zones.length);

  let svg = `<svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMid meet">`;
  svg += `<defs>${clipPathSvg}</defs>`;
  svg += roomOutline.floorFill;
  svg += roomOutline.walls;
  svg += renderZones(state.zones, state.selectedZoneId, x0, y0, pxW, pxD, state.room, true);
  svg += renderDrawOverlay(x0, y0, scale, zoneColor);
  svg += `</svg>`;

  vp.innerHTML = buildDrawHtml(svg);
  wireDrawEvents(vp);
}

function renderDrawOverlay(x0, y0, scale, color) {
  let s = '';
  // Edges between placed vertices
  for (let i = 0; i < drawVertices.length - 1; i++) {
    const a = drawVertices[i], b = drawVertices[i + 1];
    s += `<line x1="${x0 + a.x * scale}" y1="${y0 + a.y * scale}" x2="${x0 + b.x * scale}" y2="${y0 + b.y * scale}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`;
  }
  if (drawVertices.length > 0 && drawCursor) {
    const last = drawVertices[drawVertices.length - 1];
    // Rubber-band line tracks the SNAPPED grid intersection, not the
    // raw cursor pixel — same visual feedback the user gets after
    // committing a vertex. Was using sx/sy directly, which made the
    // line lag/lead the snap by up to 10 px.
    let endX = x0 + drawCursor.rx * scale;
    let endY = y0 + drawCursor.ry * scale;
    if (drawCursorNearStart && drawVertices.length >= 3) {
      const first = drawVertices[0];
      endX = x0 + first.x * scale;
      endY = y0 + first.y * scale;
    }
    s += `<line x1="${x0 + last.x * scale}" y1="${y0 + last.y * scale}" x2="${endX}" y2="${endY}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5,5" opacity="0.7"/>`;
    if (drawVertices.length >= 2) {
      const first = drawVertices[0];
      // Maya §2: closing dashed line goes solid + opaque when ready to commit.
      const ready = drawCursorNearStart && drawVertices.length >= 3;
      const widthPx = ready ? 2.5 : 1;
      const dash = ready ? 'none' : '2,3';
      const opacity = ready ? 1 : 0.4;
      s += `<line x1="${endX}" y1="${endY}" x2="${x0 + first.x * scale}" y2="${y0 + first.y * scale}" stroke="${color}" stroke-width="${widthPx}" stroke-dasharray="${dash}" opacity="${opacity}"/>`;
    }
  }
  // Vertex 1 grows + highlights when cursor is near; other vertices stay regular
  drawVertices.forEach((v, i) => {
    const sx = x0 + v.x * scale, sy = y0 + v.y * scale;
    const isFirstReady = i === 0 && drawCursorNearStart && drawVertices.length >= 3;
    const r = isFirstReady ? 10 : 6;
    const stroke = isFirstReady ? 3 : 2;
    s += `<circle cx="${sx}" cy="${sy}" r="${r}" fill="${color}" stroke="#fff" stroke-width="${stroke}"/>`;
    s += `<text x="${sx + 12}" y="${sy - 8}" fill="#cce" font-size="11" font-weight="600">${i + 1}</text>`;
  });
  // Cursor preview pinned to the snapped grid intersection so the
  // user sees exactly where the next click will land. Was using the
  // raw sx/sy which made the dot drift between grid points. Negative
  // coordinates are allowed now — the onFinish step shifts the
  // polygon so its bbox-min lands on the origin, so users can draw
  // rooms anywhere on the plane (combined with edge-auto-pan they
  // can chase the cursor across as much canvas as they need).
  if (drawCursor) {
    const cx = x0 + drawCursor.rx * scale;
    const cy = y0 + drawCursor.ry * scale;
    s += `<circle cx="${cx}" cy="${cy}" r="6" fill="#4a8ff0" fill-opacity="0.5" stroke="#ffffff" stroke-width="1.5"/>`;
    s += `<text x="${cx + 10}" y="${cy - 8}" fill="#ffd000" font-size="10">${drawCursor.rx.toFixed(1)}, ${drawCursor.ry.toFixed(1)} m</text>`;
  }
  return s;
}

function buildDrawHtml(svg) {
  const guideText = drawGuideText();
  const ready = drawCursorNearStart && drawVertices.length >= 3;
  return `
    <div class="viewport-2d draw-mode">
      <div class="draw-toolbar">
        <span class="draw-hint ${ready ? 'draw-hint-ready' : ''}">${guideText}</span>
        <div class="draw-actions">
          <button id="btn-draw-recentre" title="reset pan (also: double-click empty canvas)">recentre</button>
          <button id="btn-draw-undo" ${drawVertices.length === 0 ? 'disabled' : ''}>undo last point</button>
          <button id="btn-draw-finish" ${drawVertices.length < 3 ? 'disabled' : ''}>finish (${drawVertices.length} pt${drawVertices.length === 1 ? '' : 's'})</button>
          <button id="btn-draw-cancel">cancel</button>
        </div>
      </div>
      <div class="draw-canvas">${svg}</div>
    </div>
  `;
}

function wireDrawEvents(vp) {
  const svgEl = vp.querySelector('svg');
  svgEl.addEventListener('click', handleDrawClick);
  svgEl.addEventListener('mousemove', handleDrawMove);
  svgEl.addEventListener('dblclick', handleDrawDblClick);
  // mouseleave halts edge auto-pan when the cursor exits the canvas
  // (otherwise the RAF loop keeps panning indefinitely on stale
  // coordinates). It's also the right semantic: no cursor in the
  // band → no edge-pan.
  svgEl.addEventListener('mouseleave', stopEdgePan);
  // Pan: middle-button or Space + left-button. Middle-button still
  // gets clicked through, so guard in handleDrawPanStart.
  svgEl.addEventListener('pointerdown', handleDrawPanStart);
  svgEl.addEventListener('pointerup', handleDrawPanEnd);
  svgEl.addEventListener('pointercancel', handleDrawPanEnd);
  // Keyboard: focus the SVG so Esc / Backspace / Enter / Space reach us.
  svgEl.addEventListener('keydown', handleDrawKey);
  svgEl.addEventListener('keyup', handleDrawKeyUp);
  // Auto-focus so keyboard works from the moment draw mode opens.
  setTimeout(() => svgEl.focus?.(), 0);

  const recentre = vp.querySelector('#btn-draw-recentre');
  if (recentre) recentre.addEventListener('click', () => {
    drawPan.dx = 0; drawPan.dy = 0;
    render();
  });
  vp.querySelector('#btn-draw-undo').addEventListener('click', undoDrawVertex);
  vp.querySelector('#btn-draw-finish').addEventListener('click', finishDraw);
  vp.querySelector('#btn-draw-cancel').addEventListener('click', cancelDraw);
}

function renderNormal(vp) {
  const { width_m: w, depth_m: d, height_m: h, surfaces, shape } = state.room;

  if (!(w > 0 && d > 0 && h > 0)) {
    vp.innerHTML = `<div class="viewport-2d"><div class="vp-header">Enter positive room dimensions</div></div>`;
    return;
  }

  const bandIdx = materialsRef.frequency_bands_hz.indexOf(500);
  const useIdx = bandIdx >= 0 ? bandIdx : Math.floor(materialsRef.frequency_bands_hz.length / 2);
  const alphaOf = id => materialsRef.byId[id]?.absorption[useIdx] ?? 0;
  const nameOf = id => materialsRef.byId[id]?.name ?? id;

  const geom = currentRoomGeom();
  const { x0, y0, pxW, pxD } = geom;
  // Origin crosshair shown in normal mode too — Maya §2: pros need to
  // know where world (0, 0) sits before they decide where to draw.
  // Placed in module scope so renderRoomOutline can compose it in.

  const ear = earHeightFor(getSelectedListener());

  const flatSources = expandSources(state.sources);
  let splResult = null;
  let splSvg = '';
  if (flatSources.length > 0) {
    const phys = state.physics ?? {};
    const freq = phys.freq_hz ?? 1000;
    splResult = computeSPLGrid({
      sources: flatSources,
      getSpeakerDef: url => getCachedLoudspeaker(url),
      room: state.room, gridSize: 25, freq_hz: freq, earHeight_m: ear,
      airAbsorption: phys.airAbsorption !== false,
      coherent: !!phys.coherent,
      roomConstantR: phys.reverberantField && materialsRef
        ? computeRoomConstant(state.room, materialsRef, freq, state.zones) : 0,
    });
    if (splResult.sourceCount > 0 && isFinite(splResult.maxSPL_db)) {
      state.results.splGrid = splResult;
      splSvg = renderHeatmapSVG(splResult, x0, y0, pxW, pxD);
    } else {
      state.results.splGrid = null;
      splResult = null;
    }
  } else {
    state.results.splGrid = null;
  }

  const roomOutline = renderRoomOutline(state.room, x0, y0, pxW, pxD, alphaOf, nameOf, surfaces);
  const clipPathSvg = renderClipPath(state.room, x0, y0, pxW, pxD);

  const zonesSvg = renderZones(state.zones, state.selectedZoneId, x0, y0, pxW, pxD, state.room, false);
  const speakerSvg = flatSources.length > 0 ? renderSpeakersSVG(flatSources, x0, y0, pxW, pxD, state.room) : '';
  const listenerSvg = state.listeners.length > 0 ? renderListenersSVG(state.listeners, state.selectedListenerId, x0, y0, pxW, pxD, state.room) : '';
  const subSvg = renderSubStructures(state.room.subStructures, x0, y0, pxW, pxD, state.room);
  const encSvg = renderStandaloneEnclosures(state.room.standaloneEnclosures, x0, y0, pxW, pxD, state.room);
  const wsegSvg = renderSharedWallSegments(state.room.wallSegments, x0, y0, pxW, pxD, state.room);

  // Maya v9 audit §3 — collapsed footer, single line of structured
  // metadata pipe-separated. Engineers read `4.5 × 6.0 × 2.7 m`,
  // not `4.5 m wide · 6 m deep · h 2.7 m`.
  const shapeMeta = shape === 'rectangular'
    ? `${w} × ${d} × ${h} m`
    : shape === 'polygon'
      ? `${state.room.polygon_sides}-gon · r ${state.room.polygon_radius_m} m · h ${h} m`
      : shape === 'round'
        ? `round · r ${state.room.round_radius_m} m · h ${h} m`
        : `custom · ${(state.room.custom_vertices || []).length} verts · h ${h} m`;
  const ceilMeta = state.room.ceiling_type === 'dome'
    ? `dome (rise ${state.room.ceiling_dome_rise_m} m)`
    : nameOf(surfaces.ceiling);
  // For rectangular rooms the wall material is per-side; pick the
  // most common one for the footer line. For other shapes the
  // single `walls` material is canonical.
  const wallsMeta = shape === 'rectangular'
    ? nameOf(matIdOf(surfaces.wall_north ?? surfaces.walls))
    : nameOf(matIdOf(surfaces.walls ?? surfaces.wall_north));

  vp.innerHTML = `
    <div class="viewport-2d">
      <div class="vp-header">Floor plan — top-down</div>
      <svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMid meet">
        <defs>${clipPathSvg}</defs>
        ${roomOutline.floorFill}
        <g clip-path="url(#room-clip)">${splSvg}</g>
        ${roomOutline.walls}
        ${roomOutline.labels}
        ${zonesSvg}
        ${subSvg}
        ${encSvg}
        ${wsegSvg}
        ${listenerSvg}
        ${speakerSvg}
        ${renderOriginCrosshair(x0, y0, '#5a6677')}
        <text x="${x0 + pxW/2}" y="${500 - 18}" text-anchor="middle" class="vp-lbl vp-lbl-dim">${shapeMeta}  |  floor: ${nameOf(surfaces.floor)}  |  walls: ${wallsMeta}  |  ceiling: ${ceilMeta}</text>
        ${splResult ? '' : `<text x="${x0 + pxW/2}" y="${y0 + pxD/2}" text-anchor="middle" class="vp-lbl vp-lbl-empty">no sources placed</text><text x="${x0 + pxW/2}" y="${y0 + pxD/2 + 18}" text-anchor="middle" class="vp-lbl vp-lbl-empty-hint">add a speaker to compute SPL</text>`}
      </svg>
      ${renderLegend(splResult)}
    </div>
  `;
}

function renderZones(zones, selectedId, x0, y0, pxW, pxD, room, isDrawBackdrop) {
  let s = '';
  zones.forEach((z, i) => {
    if (z.vertices.length < 3) return;
    const color = colorForZone(i);
    const isSel = z.id === selectedId;
    const fillOpacity = isDrawBackdrop ? 0.2 : (isSel ? 0.35 : 0.22);
    const strokeOpacity = isSel ? 1 : 0.75;
    const points = z.vertices.map(v => {
      const sx = x0 + (v.x / room.width_m) * pxW;
      const sy = y0 + (v.y / room.depth_m) * pxD;
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    }).join(' ');
    s += `<polygon points="${points}" fill="${color}" fill-opacity="${fillOpacity}" stroke="${color}" stroke-width="${isSel ? 3 : 2}" stroke-opacity="${strokeOpacity}" />`;
    const cx = z.vertices.reduce((a, v) => a + v.x, 0) / z.vertices.length;
    const cy = z.vertices.reduce((a, v) => a + v.y, 0) / z.vertices.length;
    const scx = x0 + (cx / room.width_m) * pxW;
    const scy = y0 + (cy / room.depth_m) * pxD;
    s += `<text x="${scx.toFixed(1)}" y="${scy.toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-zone" fill="${color}">${z.label}</text>`;
    s += `<text x="${scx.toFixed(1)}" y="${(scy + 13).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-zone-sub">elev ${z.elevation_m} m</text>`;
  });
  return s;
}

// Render placed sub-structures (saved rooms placed inside this one) as
// translucent outlines on the floor plan. Phase 1 = visual only; matches
// the 3D viewport's ghost-blue colour scheme so the user can recognise
// them at a glance.
//
// Each sub is positioned at parent-state coords (sub.position.x_m,
// sub.position.y_m); rotation is around the sub's local origin (0,0).
// We rotate each footprint vertex around (0,0) then translate to the
// placement point, then map to SVG pixel coords.
function renderSubStructures(subs, x0, y0, pxW, pxD, parentRoom) {
  if (!Array.isArray(subs) || subs.length === 0) return '';
  let out = '';
  for (const sub of subs) {
    const src = sub.sourceRoom;
    if (!src) continue;
    const w = src.width_m ?? 5;
    const d = src.depth_m ?? 5;
    if (!(w > 0 && d > 0)) continue;
    // Footprint in source-local coords. For custom shapes, walk the
    // polygon; otherwise the bbox.
    let local;
    if (src.shape === 'custom' && Array.isArray(src.custom_vertices) && src.custom_vertices.length >= 3) {
      local = src.custom_vertices.map(v => ({ x: v.x, y: v.y }));
    } else {
      local = [
        { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d },
      ];
    }
    const rotRad = ((sub.rotation_deg ?? 0) * Math.PI) / 180;
    const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
    const px = sub.position?.x_m ?? 0;
    const py = sub.position?.y_m ?? 0;
    const points = local.map(p => {
      // Rotate around source-local origin then translate to placement.
      const rx = p.x * cosR - p.y * sinR + px;
      const ry = p.x * sinR + p.y * cosR + py;
      const sx = x0 + (rx / parentRoom.width_m) * pxW;
      const sy = y0 + (ry / parentRoom.depth_m) * pxD;
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    }).join(' ');
    const labelX = x0 + (px / parentRoom.width_m) * pxW;
    const labelY = y0 + (py / parentRoom.depth_m) * pxD;
    const lbl = (sub.sourceRoomName || 'Sub-room').replace(/[<>&]/g, '');
    out += `<polygon points="${points}" fill="#4aa3ff" fill-opacity="0.18" stroke="#7fc7ff" stroke-width="1.5" stroke-dasharray="4,3" />`;
    out += `<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-zone-sub" fill="#7fc7ff">${lbl}</text>`;
  }
  return out;
}

// Render standalone enclosures (broken-out from a sub-structure into
// editable walls) as solid-stroked outlines on the floor plan. Polygon
// is already in PARENT-state coords (transform baked at break time —
// see panel-room.js break-to-merge). Phase 1 = visual only; uses the
// same ghost-blue palette as sub-structures for visual continuity, but
// with a SOLID stroke (vs. dashed) to signal "these are now real
// editable walls, not a placement ghost".
function renderStandaloneEnclosures(encs, x0, y0, pxW, pxD, parentRoom) {
  if (!Array.isArray(encs) || encs.length === 0) return '';
  let out = '';
  for (const enc of encs) {
    if (!enc || !Array.isArray(enc.polygon) || enc.polygon.length < 3) continue;
    const points = enc.polygon.map(p => {
      const sx = x0 + (p.x / parentRoom.width_m) * pxW;
      const sy = y0 + (p.y / parentRoom.depth_m) * pxD;
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    }).join(' ');
    let lcx = 0, lcy = 0;
    for (const p of enc.polygon) { lcx += p.x; lcy += p.y; }
    lcx /= enc.polygon.length; lcy /= enc.polygon.length;
    const labelX = x0 + (lcx / parentRoom.width_m) * pxW;
    const labelY = y0 + (lcy / parentRoom.depth_m) * pxD;
    const lbl = (enc.label || 'Enclosure').replace(/[<>&]/g, '');
    out += `<polygon points="${points}" fill="#4aa3ff" fill-opacity="0.10" stroke="#7fc7ff" stroke-width="1.8" />`;
    out += `<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-zone-sub" fill="#7fc7ff">${lbl}</text>`;
  }
  return out;
}

// Render shared wall segments on the 2D plan — produced by break-to-merge
// overlap split. Each entry is in PARENT-state coords; we map each
// endpoint to SVG pixels and stroke a single highlighted line. Colour
// is amber to distinguish from sub/enclosure ghost-blue and zone fills,
// reflecting the "shared between two structures" semantics. Phase 1 =
// visual only (acoustic gate at Dr. Chen).
function renderSharedWallSegments(segs, x0, y0, pxW, pxD, parentRoom) {
  if (!Array.isArray(segs) || segs.length === 0) return '';
  let out = '';
  for (const seg of segs) {
    if (!seg || typeof seg !== 'object') continue;
    if (!Number.isFinite(seg.x1) || !Number.isFinite(seg.y1)
        || !Number.isFinite(seg.x2) || !Number.isFinite(seg.y2)) continue;
    const ax = x0 + (seg.x1 / parentRoom.width_m) * pxW;
    const ay = y0 + (seg.y1 / parentRoom.depth_m) * pxD;
    const bx = x0 + (seg.x2 / parentRoom.width_m) * pxW;
    const by = y0 + (seg.y2 / parentRoom.depth_m) * pxD;
    out += `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#f59e0b" stroke-width="6" stroke-linecap="round" stroke-opacity="0.85" />`;
  }
  return out;
}

function renderClipPath(room, x0, y0, pxW, pxD) {
  const verts = roomPlanVertices(room);
  if (verts.length === 0) return '';
  const points = verts.map(v => {
    const sx = x0 + (v.x / room.width_m) * pxW;
    const sy = y0 + (v.y / room.depth_m) * pxD;
    return `${sx.toFixed(1)},${sy.toFixed(1)}`;
  }).join(' ');
  return `<clipPath id="room-clip"><polygon points="${points}" /></clipPath>`;
}

// Wall slots may be either a string (legacy: material id only) or an
// object { materialId, openings } (PR2 schema). The 2D plan only needs
// the material id for label + colour, so unwrap here at every read site.
function matIdOf(slot) {
  if (typeof slot === 'string') return slot;
  if (slot && typeof slot === 'object' && typeof slot.materialId === 'string') return slot.materialId;
  return 'gypsum-board';
}

function renderRoomOutline(room, x0, y0, pxW, pxD, alphaOf, nameOf, surfaces) {
  const shape = room.shape ?? 'rectangular';
  const verts = roomPlanVertices(room);
  const svgPts = verts.map(v => ({
    sx: x0 + (v.x / room.width_m) * pxW,
    sy: y0 + (v.y / room.depth_m) * pxD,
  }));

  if (shape === 'rectangular') {
    const wN = matIdOf(surfaces.wall_north), wS = matIdOf(surfaces.wall_south);
    const wE = matIdOf(surfaces.wall_east),  wW = matIdOf(surfaces.wall_west);
    const floorFill = `<rect x="${x0}" y="${y0}" width="${pxW}" height="${pxD}" fill="${colorFor(alphaOf(surfaces.floor))}" fill-opacity="0.15" rx="2" />`;
    const walls = `
      <line x1="${x0}" y1="${y0}" x2="${x0 + pxW}" y2="${y0}" stroke="${colorFor(alphaOf(wN))}" stroke-width="8" stroke-linecap="round" />
      <line x1="${x0}" y1="${y0 + pxD}" x2="${x0 + pxW}" y2="${y0 + pxD}" stroke="${colorFor(alphaOf(wS))}" stroke-width="8" stroke-linecap="round" />
      <line x1="${x0 + pxW}" y1="${y0}" x2="${x0 + pxW}" y2="${y0 + pxD}" stroke="${colorFor(alphaOf(wE))}" stroke-width="8" stroke-linecap="round" />
      <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + pxD}" stroke="${colorFor(alphaOf(wW))}" stroke-width="8" stroke-linecap="round" />
    `;
    // Maya v9 audit §2 — direction tags only (small caps, muted),
    // material name moves to a hover tooltip on the wall stroke and
    // is restated authoritatively in the page footer. Drops the
    // "Front — Gypsum board 13mm on studs" inline label that was
    // shouting louder than the architecture.
    const labels = `
      <text x="${x0 + pxW/2}" y="${y0 - 14}" text-anchor="middle" class="vp-lbl vp-lbl-wall">FRONT</text>
      <text x="${x0 + pxW/2}" y="${y0 + pxD + 22}" text-anchor="middle" class="vp-lbl vp-lbl-wall">BACK</text>
      <text x="${x0 + pxW + 14}" y="${y0 + pxD/2 + 4}" text-anchor="start" class="vp-lbl vp-lbl-wall">RIGHT</text>
      <text x="${x0 - 14}" y="${y0 + pxD/2 + 4}" text-anchor="end" class="vp-lbl vp-lbl-wall">LEFT</text>
    `;
    return { floorFill, walls, labels };
  }

  const pointsAttr = svgPts.map(p => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ');
  const floorFill = `<polygon points="${pointsAttr}" fill="${colorFor(alphaOf(surfaces.floor))}" fill-opacity="0.15" />`;

  if (shape === 'custom') {
    const edges = surfaces.edges || [];
    let walls = '';
    for (let i = 0; i < svgPts.length; i++) {
      const a = svgPts[i], b = svgPts[(i + 1) % svgPts.length];
      const mat = matIdOf(edges[i]);
      walls += `<line x1="${a.sx.toFixed(1)}" y1="${a.sy.toFixed(1)}" x2="${b.sx.toFixed(1)}" y2="${b.sy.toFixed(1)}" stroke="${colorFor(alphaOf(mat))}" stroke-width="8" stroke-linecap="round" />`;
      const midX = (a.sx + b.sx) / 2, midY = (a.sy + b.sy) / 2;
      walls += `<circle cx="${midX.toFixed(1)}" cy="${midY.toFixed(1)}" r="8" fill="#0e1116" stroke="${colorFor(alphaOf(mat))}" stroke-width="1" />`;
      walls += `<text x="${midX.toFixed(1)}" y="${(midY + 3).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-edge">${i + 1}</text>`;
    }
    return { floorFill, walls, labels: '' };
  }

  const wallsMat = matIdOf(surfaces.walls ?? surfaces.wall_north);
  const walls = `<polygon points="${pointsAttr}" fill="none" stroke="${colorFor(alphaOf(wallsMat))}" stroke-width="8" stroke-linejoin="round" />`;
  const centerX = svgPts.reduce((s, p) => s + p.sx, 0) / svgPts.length;
  const topY = Math.min(...svgPts.map(p => p.sy));
  // Maya v9 audit §2 — single direction tag, no material name on canvas.
  const labels = `<text x="${centerX.toFixed(1)}" y="${(topY - 14).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-wall">WALLS</text>`;
  return { floorFill, walls, labels };
}

function renderHeatmapSVG(splResult, x0, y0, pxW, pxD) {
  const { grid, cellsX, cellsY } = splResult;
  const cw = pxW / cellsX;
  const ch = pxD / cellsY;
  let s = '';
  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++) {
      const spl = grid[j][i];
      if (!isFinite(spl)) continue;
      s += `<rect x="${(x0 + i * cw).toFixed(2)}" y="${(y0 + j * ch).toFixed(2)}" width="${(cw + 0.5).toFixed(2)}" height="${(ch + 0.5).toFixed(2)}" fill="${splColor(spl)}" fill-opacity="0.55" />`;
    }
  }
  return s;
}

function renderSpeakersSVG(sources, x0, y0, pxW, pxD, room) {
  let s = '';
  sources.forEach((src, i) => {
    const sx = x0 + (src.position.x / room.width_m) * pxW;
    const sy = y0 + (src.position.y / room.depth_m) * pxD;
    const outside = !isInsideRoom3D(src.position, room);
    const groupColor = src.groupId ? colorForGroup(src.groupId) : null;
    const fill = outside ? '#ff5a3c' : (groupColor || '#fff');
    const stroke = outside ? '#8a1200' : '#000';
    const yaw_rad = src.aim.yaw * Math.PI / 180;
    const size = 13;
    const aimX = Math.sin(yaw_rad), aimY = Math.cos(yaw_rad);
    const rightX = Math.cos(yaw_rad), rightY = -Math.sin(yaw_rad);
    const tip = { x: sx + size * aimX, y: sy + size * aimY };
    const bl  = { x: sx - size * 0.5 * aimX - size * 0.6 * rightX, y: sy - size * 0.5 * aimY - size * 0.6 * rightY };
    const br  = { x: sx - size * 0.5 * aimX + size * 0.6 * rightX, y: sy - size * 0.5 * aimY + size * 0.6 * rightY };
    if (groupColor && !outside) {
      s += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${size + 3}" fill="none" stroke="${groupColor}" stroke-width="2" opacity="0.6"/>`;
    }
    s += `<polygon points="${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${bl.x.toFixed(1)},${bl.y.toFixed(1)} ${br.x.toFixed(1)},${br.y.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" />`;
    s += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="2" fill="${stroke}" />`;
    // Maya v9 audit §5 — drop the `[A]` group tag from the label
    // text. Group identity is COLOUR (the ring around the triangle),
    // not text. The bracketed letter was decorative noise.
    const lblFill = outside ? '#ff5a3c' : (groupColor || '#e8ecf2');
    const lblText = outside ? `S${i + 1} ⚠` : `S${i + 1}`;
    s += `<text x="${sx.toFixed(1)}" y="${(sy - 18).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-spk" fill="${lblFill}">${lblText}</text>`;
  });
  return s;
}

function renderListenersSVG(listeners, selectedId, x0, y0, pxW, pxD, room) {
  let s = '';
  listeners.forEach((lst) => {
    const sx = x0 + (lst.position.x / room.width_m) * pxW;
    const sy = y0 + (lst.position.y / room.depth_m) * pxD;
    const isSel = lst.id === selectedId;
    const radius = isSel ? 10 : 7;
    const fill = isSel ? '#ffd000' : '#4a8ff0';
    const stroke = isSel ? '#ffffff' : '#13161c';
    const strokeW = isSel ? 2.5 : 1.5;
    s += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" />`;
    const lblMatch = String(lst.label).match(/\d+/);
    const short = lblMatch ? lblMatch[0] : String(lst.label).slice(0, 2);
    s += `<text x="${sx.toFixed(1)}" y="${(sy + 3).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-listener">${short}</text>`;
  });
  return s;
}

function renderLegend(splResult) {
  if (splResult) {
    // Vertical legend (Maya v9 audit §1). Metric NAME with frequency
    // context above the bar; tick values include unit suffix on each
    // line; reference footnote ("re 20 µPa") below — gives the dB its
    // physical meaning. Drops the orphaned standalone "DB" label.
    const minVal = splResult.minSPL_db;
    const maxVal = splResult.maxSPL_db;
    const freqHz = state.physics?.freq_hz ?? 1000;
    const ticks = computeTicks(minVal, maxVal, 'spl');
    const tickRows = ticks.map(t => {
      const pct = Math.max(0, Math.min(100, (1 - t.position01) * 100)).toFixed(2);
      return `<div class="spl-legend-tick" style="top:${pct}%">
        <span class="spl-legend-tick-line"></span>
        <span class="spl-legend-tick-label">${formatTickLabel(t.value, 'spl')}</span>
      </div>`;
    }).join('');
    return `<div class="vp-legend spl-legend spl-legend-v">
      <span class="legend-header">${legendHeader('spl', freqHz)}</span>
      <div class="spl-legend-stage">
        <div class="legend-bar"></div>
        <div class="spl-legend-ticks">${tickRows}</div>
      </div>
      <span class="legend-footnote">re 20 µPa</span>
    </div>`;
  }
  return `<div class="vp-legend">
    ${COLOR_BANDS.map(b => `<span class="legend-item"><span class="swatch" style="background:${b.color}"></span>${b.label}</span>`).join('')}
  </div>`;
}
