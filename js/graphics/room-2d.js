import { state, earHeightFor, getSelectedListener, colorForZone, colorForGroup, expandSources, expandLineArrayToElements, duplicateSource, duplicateListener, convertRoomToCustomPolygon } from '../app-state.js';
import { openPanel } from '../ui/rail-system.js';
import { projectOntoWall } from '../ui/panel-treatments.js';
import { computeRoomConstant } from '../physics/spl-calculator.js';
import { on, emit } from '../ui/events.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { computeSPLGrid } from '../physics/spl-calculator.js';
import { roomPlanVertices, isInsideRoom3D, roomEffectiveBounds } from '../physics/room-shape.js';
import { computeTicks, computeMinorTicks, formatTickLabel, legendHeader } from './legend-ticks.js';

let materialsRef;

// ---- Mouse-wheel zoom state ----
// We zoom by mutating the SVG's viewBox (NOT CSS transform). Reason:
// CSS transform scales the rasterized SVG output → vector content
// blurs on zoom-in. Mutating the viewBox makes the browser re-render
// at the new resolution → strokes / text / heatmap rects stay sharp.
// clientToWorldXY uses getScreenCTM, which automatically follows the
// viewBox, so click math keeps working with no further changes.
//
// The viewBox base for normal mode is "0 0 800 500" (see renderNormal).
// We track a virtual zoom + pan and reconstruct the viewBox each call:
//   vbW = 800 / zoom; vbH = 500 / zoom
//   vbX = panX_view ; vbY = panY_view   (in viewBox-coord px)
const VIEW2D_BASE_VB_W = 800;
const VIEW2D_BASE_VB_H = 500;
let _view2dZoom = 1;
let _view2dVbX  = 0;       // viewBox-coord pan (NOT screen px)
let _view2dVbY  = 0;
const VIEW2D_ZOOM_MIN = 0.5;
const VIEW2D_ZOOM_MAX = 8;
const VIEW2D_ZOOM_STEP = 1.15;       // per wheel-tick zoom multiplier

function applyView2dTransform() {
  const svg = document.querySelector('#view-2d svg');
  if (!svg) return;
  const vbW = VIEW2D_BASE_VB_W / _view2dZoom;
  const vbH = VIEW2D_BASE_VB_H / _view2dZoom;
  svg.setAttribute('viewBox', `${_view2dVbX} ${_view2dVbY} ${vbW} ${vbH}`);
  svg.style.transform = '';            // ensure no leftover CSS transform
}

function resetView2dZoom() {
  _view2dZoom = 1;
  _view2dVbX = 0;
  _view2dVbY = 0;
  applyView2dTransform();
}

function onView2dWheel(e) {
  if (!e.currentTarget.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  const svg = e.currentTarget.querySelector('svg');
  if (!svg) return;
  // Cursor → viewBox coord (the world point we want to keep under the
  // cursor across the zoom change). getScreenCTM().inverse() handles
  // the current viewBox → screen mapping for us.
  const ctm = svg.getScreenCTM();
  if (!ctm) return;
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const before = pt.matrixTransform(ctm.inverse());

  const factor = e.deltaY < 0 ? VIEW2D_ZOOM_STEP : 1 / VIEW2D_ZOOM_STEP;
  const newZoom = Math.max(VIEW2D_ZOOM_MIN, Math.min(VIEW2D_ZOOM_MAX, _view2dZoom * factor));
  if (newZoom === _view2dZoom) return;        // hit a clamp

  // New viewBox dimensions.
  const newVbW = VIEW2D_BASE_VB_W / newZoom;
  const newVbH = VIEW2D_BASE_VB_H / newZoom;
  // After the zoom, the cursor's screen position should map to the
  // same viewBox coord `before`. Cursor's position relative to the
  // viewBox origin in CURRENT mapping is `before.x - _view2dVbX`. To
  // keep that fraction constant of the new viewBox, the new origin is:
  //   newVbX = before.x - (cursor_fraction_of_new_vb) × newVbW
  // where cursor_fraction was (before.x - oldVbX) / oldVbW.
  const oldVbW = VIEW2D_BASE_VB_W / _view2dZoom;
  const oldVbH = VIEW2D_BASE_VB_H / _view2dZoom;
  const fx = (before.x - _view2dVbX) / oldVbW;   // 0..1
  const fy = (before.y - _view2dVbY) / oldVbH;
  _view2dVbX = before.x - fx * newVbW;
  _view2dVbY = before.y - fy * newVbH;
  _view2dZoom = newZoom;
  applyView2dTransform();
}

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

// Floating coord-entry panel — CAD-style "next point (x, y)" input that
// follows the cursor. Lives as a direct child of #view-2d (NOT inside
// the SVG and NOT inside the .draw-canvas innerHTML, which is rewritten
// on every mousemove and would destroy the input + focus). Created on
// first vertex placement, destroyed on cancel/finish. Position updates
// are batched through requestAnimationFrame so the panel can follow the
// pointer without jank.
let floatCoordEl = null;             // root .draw-float-coord div, or null
let floatCoordCursor = { clientX: 0, clientY: 0 };
let floatCoordPosRAF = 0;
let floatCoordCachedX = '';          // preserves typed value across re-renders if we ever rebuild
let floatCoordCachedY = '';
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

// ---------------------------------------------------------------------
// Source interaction state — 2D click-to-select, drag-to-move, and the
// right-click context menu used to duplicate a speaker.
//
// Drag mechanics:
//   - mousedown on a .r2d-source group captures the parent source-idx
//     plus the cursor's starting world coords.
//   - mousemove only enters "drag" mode after the cursor crosses
//     DRAG_THRESHOLD_PX in screen pixels — otherwise the press is
//     treated as a click (select only).
//   - In drag mode every move updates the source's world XY, snapped
//     to the 0.5 m grid, and triggers a re-render via source:changed.
//   - mouseup ends the drag. If `didMove` is false the click-select
//     fires.
//
// Selection persists in state.selectedSourceIdx so the sources panel
// can mirror it.
// ---------------------------------------------------------------------
const SOURCE_SNAP_M = 0.5;             // 0.5 m grid for drag-to-position
const DRAG_THRESHOLD_PX = 3;           // clicks within this radius = select-only
// Unified drag state for BOTH speakers and listeners. The `kind` field
// is 'source' or 'listener'; for sources we keep sourceIdx + posKey
// (point speakers use 'position', line-arrays use 'origin'); for
// listeners we keep listenerId. Same drag math; different state slot.
let pickableDrag = null;
let sourceContextMenuEl = null;        // open right-click menu DOM ref (null when closed)

// Window-level keyboard handler — registered when draw mode starts,
// removed when it ends. Lets shortcuts (Esc / Backspace / Ctrl-Z / R /
// Enter / Space) fire even when focus is on a button or elsewhere
// outside the SVG.
let _winKeyHandlerInstalled = false;
function installWindowKeyHandler() {
  if (_winKeyHandlerInstalled) return;
  window.addEventListener('keydown', handleDrawKey);
  window.addEventListener('keyup', handleDrawKeyUp);
  _winKeyHandlerInstalled = true;
}
function removeWindowKeyHandler() {
  if (!_winKeyHandlerInstalled) return;
  window.removeEventListener('keydown', handleDrawKey);
  window.removeEventListener('keyup', handleDrawKeyUp);
  _winKeyHandlerInstalled = false;
}
// handleDrawKey + handleDrawKeyUp are defined further down (~line 401).

export function startDrawCustomShape() {
  // Build marker — if you see this in DevTools Console you have the
  // latest room-2d.js with snap-to-grid + edge auto-pan. If you DON'T
  // see this, your browser is serving a cached copy; do "Empty cache
  // and hard reload" (Chrome: right-click the reload button) or
  // toggle DevTools Network → "Disable cache".
  console.info('[room-2d] draw started — snap-to-grid + edge auto-pan + shortcuts (R/Backspace/Esc/Enter) ENABLED');
  drawActive = true;
  installWindowKeyHandler();
  drawConfig = {
    mode: 'room-shape',
    label: 'Draw custom room shape',
    onFinish: (verts) => {
      // Per user request 2026-05-17 (clarified): wherever the user's
      // FIRST click landed becomes world (0, 0). Subsequent vertices
      // get translated by the same amount so they sit at coords
      // RELATIVE to the first click. Result: vertex[0] is always
      // (0, 0) — predictable origin for saved-room library entries
      // regardless of which corner the user started at.
      const ox = verts[0].x;
      const oy = verts[0].y;
      const shifted = verts.map(v => ({ x: v.x - ox, y: v.y - oy }));
      const minX = Math.min(...shifted.map(v => v.x));
      const minY = Math.min(...shifted.map(v => v.y));
      const maxX = Math.max(...shifted.map(v => v.x));
      const maxY = Math.max(...shifted.map(v => v.y));
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
  installWindowKeyHandler();
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
  destroyFloatCoordEl();
  removeWindowKeyHandler();
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
  destroyFloatCoordEl();
  removeWindowKeyHandler();
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
  // A mouse-placed vertex is the most recent intent — clear any half-
  // typed values in the floating panel so the next field shows blank
  // (ready to accept the next coord). The render() below re-uses the
  // existing panel; this just zeroes its inputs first.
  clearFloatCoordFields();
  render();
}

function clearFloatCoordFields() {
  floatCoordCachedX = '';
  floatCoordCachedY = '';
  if (!floatCoordEl) return;
  const xInput = floatCoordEl.querySelector('#draw-float-x');
  const yInput = floatCoordEl.querySelector('#draw-float-y');
  if (xInput) xInput.value = '';
  if (yInput) yInput.value = '';
  xInput?.classList.remove('draw-float-coord-input-close');
  yInput?.classList.remove('draw-float-coord-input-close');
  // Refocus x so the user can immediately type the next pair without
  // clicking back into the field.
  setTimeout(() => { xInput?.focus(); xInput?.select(); }, 0);
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
  // Floating panel: track cursor position (RAF-batched) and refresh
  // close-state highlight. Both are cheap; doing them inline is fine.
  scheduleFloatCoordPosUpdate(event.clientX, event.clientY);
  updateFloatCoordState();
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
  // Ignore key events that originate from a text input so the user can
  // type into the room-name field etc. without nuking their polygon.
  const t = event.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

  const k = event.key;
  if (k === 'Escape')          { cancelDraw(); event.preventDefault(); }
  else if (k === 'Backspace')  { undoDrawVertex(); event.preventDefault(); }
  else if (k === 'Enter')      { if (drawVertices.length >= 3) finishDraw(); event.preventDefault(); }
  else if (k === ' ')          { spaceHeld = true; event.preventDefault(); }
  else if (k === 'r' || k === 'R') {
    // Recentre — same effect as clicking the recentre button or
    // double-clicking the canvas. Reset pan only; keeps placed vertices.
    drawPan.dx = 0; drawPan.dy = 0;
    render();
    event.preventDefault();
  }
  else if ((k === 'z' || k === 'Z') && (event.ctrlKey || event.metaKey)) {
    undoDrawVertex();
    event.preventDefault();
  }
  // Close-loop shortcut. Picked 'C' over Space (Space is held-for-pan;
  // a tap-vs-hold dual binding produces ambiguous affordances). 'C' is
  // unambiguous, sits on the home row for the off-mouse hand, and the
  // letter matches the verb ("Close"). Only fires when ≥3 vertices
  // exist, otherwise it's a no-op.
  else if ((k === 'c' || k === 'C') && drawConfig?.mode === 'room-shape') {
    if (drawVertices.length >= 3) {
      finishDraw();
      event.preventDefault();
    }
  }
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
  // Scale based on the EFFECTIVE bounds (room footprint UNIONED with
  // any surau podium extension and any broken-out enclosures) so the
  // 2D viewport fits the whole walkable + acoustic region. Before
  // this, surau presets clipped the arcade speakers/listeners and
  // the SPL heatmap stopped at the prayer-hall wall — visible to the
  // user as "corridor walkway has no heatmap".
  //
  // pxW / pxD are kept at `room.width_m * scale` (NOT totW * scale)
  // so the legacy world→screen formulas in renderOneSpeakerSymbol,
  // renderListenersSVG, etc. (which compute `x0 + (worldX /
  // room.width_m) * pxW`) still work. x0/y0 absorb the bounds-offset
  // so positions outside the room (world x < 0, etc.) still land at
  // the correct screen pixel.
  //
  // For rooms without an extension (every non-surau preset + every
  // template), bounds collapse to (0,0)→(width_m, depth_m), and this
  // function behaves identically to the previous version.
  const { width_m: w, depth_m: d } = state.room;
  const bounds = roomEffectiveBounds(state.room);
  const totW = Math.max(1e-3, bounds.maxX - bounds.minX);
  const totD = Math.max(1e-3, bounds.maxY - bounds.minY);
  const vbW = 800, vbH = 500, pad = 90;
  const scale = Math.min((vbW - pad * 2) / totW, (vbH - pad * 2) / totD);
  const pxW = w * scale;
  const pxD = d * scale;
  const pxTotalW = totW * scale;
  const pxTotalD = totD * scale;
  // Anchor: the world origin (0, 0) lands at (x0, y0). bounds.min
  // pulls the viewport so the podium edge (e.g. world x = -3.5)
  // becomes the leftmost visible point.
  const x0 = (vbW - pxTotalW) / 2 - bounds.minX * scale;
  const y0 = (vbH - pxTotalD) / 2 - bounds.minY * scale;
  return { scale, pxW, pxD, x0, y0, bounds };
}

// --- Mount ---
export function mount2DViewport({ materials }) {
  materialsRef = materials;
  render();
  on('room:changed', render);
  on('source:changed', render);
  on('source:model_changed', render);
  on('source:selected', render);
  on('listener:changed', render);
  on('listener:selected', render);
  on('treatment:changed', render);
  on('treatment:selected', render);
  on('scene:reset', render);
  window.addEventListener('resize', render);
  // Reset zoom whenever the scene is fully replaced so the new room
  // shows at default scale.
  on('scene:reset', resetView2dZoom);

  // Mouse-wheel zoom on the 2D viewport container. Attached ONCE on
  // mount; renders rewrite the inner SVG but leave the container alone.
  const vp = document.getElementById('view-2d');
  if (vp) {
    vp.addEventListener('wheel', onView2dWheel, { passive: false });
    // Double-click on empty background → reset zoom. Handler bails if
    // the click hit an interactive element (room outline, speaker,
    // listener, treatment) so it doesn't fight existing dblclick.
    vp.addEventListener('dblclick', (e) => {
      const target = e.target;
      if (target.closest('[data-source-idx], [data-listener-id], [data-treatment-id], [data-zone-id], [data-vertex-idx]')) return;
      if (_view2dZoom === 1 && _view2dPanX === 0 && _view2dPanY === 0) return;
      e.preventDefault();
      resetView2dZoom();
    });
  }
}

function render() {
  const vp = document.getElementById('view-2d');
  if (drawActive && drawConfig.mode === 'room-shape') { renderCustomDraw(vp); applyView2dTransform(); return; }
  if (drawActive && drawConfig.mode === 'zone') { renderZoneDraw(vp); applyView2dTransform(); return; }
  renderNormal(vp);
  applyView2dTransform();
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

  // 5 m tick labels along top + left edges. Only render AFTER the
  // first vertex has been placed (which becomes the new world origin
  // (0, 0) per the v=450 onFinish-shift). Before first click, the
  // canvas shows a blank grid + a "click to set origin" prompt at
  // the cursor — no meter axis yet, so the user isn't anchored to a
  // coord system that hasn't been chosen.
  if (drawVertices.length >= 1) {
    const v0 = drawVertices[0];
    const ox = x0 + v0.x * CUSTOM_SCALE;
    const oy = y0 + v0.y * CUSTOM_SCALE;
    // Tick world-x = v0.x + m for each integer m in the visible range.
    const minXm = -x0 / CUSTOM_SCALE;
    const maxXm = (CUSTOM_VB_W - x0) / CUSTOM_SCALE;
    const minYm = -y0 / CUSTOM_SCALE;
    const maxYm = (CUSTOM_VB_H - y0) / CUSTOM_SCALE;
    const startMx = Math.ceil((minXm - v0.x) / 5) * 5;
    const endMx   = Math.floor((maxXm - v0.x) / 5) * 5;
    for (let m = startMx; m <= endMx; m += 5) {
      if (m === 0) continue;
      const worldX = v0.x + m;
      svg += `<text x="${x0 + worldX * CUSTOM_SCALE}" y="14" fill="#5a6677" font-size="9" text-anchor="middle">${m} m</text>`;
    }
    const startMy = Math.ceil((minYm - v0.y) / 5) * 5;
    const endMy   = Math.floor((maxYm - v0.y) / 5) * 5;
    for (let m = startMy; m <= endMy; m += 5) {
      if (m === 0) continue;
      const worldY = v0.y + m;
      // Y-axis flipped — label text is the NEGATION of the world-Y
      // offset so the user sees math convention (positive labels above
      // origin, negative below) instead of SVG convention.
      svg += `<text x="6" y="${y0 + worldY * CUSTOM_SCALE + 3}" fill="#5a6677" font-size="9">${-m} m</text>`;
    }
    // Origin crosshair sits at the FIRST click — it marks the new (0, 0)
    // not the canvas centre.
    svg += renderOriginCrosshair(ox, oy, '#7a89a0');
  }

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
    const startX = x0 + last.x * scale;
    const startY = y0 + last.y * scale;
    s += `<line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5,5" opacity="0.7"/>`;
    // Dimension label on the rubber-band line — shows length of the
    // PROSPECTIVE edge in metres at its midpoint. Hides when the cursor
    // sits on the last vertex (zero-length segment) to avoid a "0.0 m"
    // strobing artefact during clicks.
    const dxW = (drawCursorNearStart && drawVertices.length >= 3 ? drawVertices[0].x : drawCursor.rx) - last.x;
    const dyW = (drawCursorNearStart && drawVertices.length >= 3 ? drawVertices[0].y : drawCursor.ry) - last.y;
    const dist = Math.sqrt(dxW * dxW + dyW * dyW);
    if (dist >= 0.25) {
      const mx = (startX + endX) / 2;
      const my = (startY + endY) / 2;
      // Tiny background plate keeps the number readable on top of the
      // grid + heatmap. 30×14 px, centred on the midpoint, with a 2 px
      // pad above the line so the text doesn't overlap the dashes.
      const labelW = Math.max(34, 8 + dist.toFixed(1).length * 6);
      s += `<rect x="${mx - labelW / 2}" y="${my - 16}" width="${labelW}" height="13" rx="2" fill="#0e1116" fill-opacity="0.82" stroke="${color}" stroke-width="0.6" stroke-opacity="0.4"/>`;
      s += `<text x="${mx}" y="${my - 6}" fill="#dde3ec" font-size="10" text-anchor="middle" font-family="JetBrains Mono, ui-monospace, monospace">${dist.toFixed(1)} m</text>`;
    }
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
    if (drawVertices.length === 0 && drawConfig?.mode === 'room-shape') {
      // No origin chosen yet — prompt user to place the first dot.
      // Per user request 2026-05-17: until the first click sets the
      // origin, the cursor must not display world coords (which are
      // arbitrary canvas-pan-dependent values that confuse the user
      // trying to read a meaningful "where I am" number).
      s += `<text x="${cx + 10}" y="${cy - 8}" fill="#ffd000" font-size="10">Click to set origin (0, 0)</text>`;
    } else if (drawVertices.length >= 1) {
      // Cursor coords RELATIVE to vertex[0] which is the new origin.
      // Y-axis flipped so screen-up reads positive (math convention).
      const v0 = drawVertices[0];
      const relX = drawCursor.rx - v0.x;
      const relY = v0.y - drawCursor.ry;
      s += `<text x="${cx + 10}" y="${cy - 8}" fill="#ffd000" font-size="10">${relX.toFixed(1)}, ${relY.toFixed(1)} m</text>`;
    } else {
      // Zone-draw mode etc. — keep the old world-coord readout.
      s += `<text x="${cx + 10}" y="${cy - 8}" fill="#ffd000" font-size="10">${drawCursor.rx.toFixed(1)}, ${drawCursor.ry.toFixed(1)} m</text>`;
    }
  }
  return s;
}

function buildDrawHtml(svg) {
  const guideText = drawGuideText();
  const ready = drawCursorNearStart && drawVertices.length >= 3;
  // Coord entry is handled by the floating panel that follows the
  // cursor (see ensureFloatCoordEl). The toolbar no longer hosts a
  // second input — two surfaces for the same job created split focus
  // and ambiguity about which "Enter" did what.
  return `
    <div class="viewport-2d draw-mode">
      <div class="draw-toolbar">
        <span class="draw-hint ${ready ? 'draw-hint-ready' : ''}">${guideText}</span>
        <div class="draw-actions">
          <button id="btn-draw-recentre" title="reset pan — shortcut R (or double-click empty canvas)">recentre <kbd>R</kbd></button>
          <button id="btn-draw-undo" ${drawVertices.length === 0 ? 'disabled' : ''} title="remove the last placed point — shortcut Backspace or Ctrl+Z">undo <kbd>Backspace</kbd></button>
          <button id="btn-draw-finish" ${drawVertices.length < 3 ? 'disabled' : ''} title="close the polygon — shortcut C (or Enter)">finish (${drawVertices.length} pt${drawVertices.length === 1 ? '' : 's'}) <kbd>C</kbd></button>
          <button id="btn-draw-cancel" title="discard and exit draw mode — shortcut Esc">cancel <kbd>Esc</kbd></button>
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
  // Auto-focus so keyboard works from the moment draw mode opens —
  // BUT only when the floating coord panel ISN'T mounted, otherwise
  // every mousemove re-render would steal focus from the typing input.
  // Window-level handleDrawKey still catches Esc/Backspace/Enter/Space/
  // R/Ctrl+Z when focus lives in the floating x/y inputs (see line 519
  // where the handler skips key events whose target is an INPUT).
  const floatPanelMounted = drawConfig?.mode === 'room-shape'
    && drawVertices.length >= 1;
  if (!floatPanelMounted) {
    setTimeout(() => svgEl.focus?.(), 0);
  }

  const recentre = vp.querySelector('#btn-draw-recentre');
  if (recentre) recentre.addEventListener('click', () => {
    drawPan.dx = 0; drawPan.dy = 0;
    render();
  });
  vp.querySelector('#btn-draw-undo').addEventListener('click', undoDrawVertex);
  vp.querySelector('#btn-draw-finish').addEventListener('click', finishDraw);
  vp.querySelector('#btn-draw-cancel').addEventListener('click', cancelDraw);

  // Floating coord-entry panel. Mounted on #viewport (the outer
  // container) so it survives the per-frame innerHTML rewrite of
  // #view-2d that happens on every mousemove. Appears once the first
  // vertex is placed (room-shape mode only).
  if (drawConfig?.mode === 'room-shape' && drawVertices.length >= 1) {
    ensureFloatCoordEl(vp);
    updateFloatCoordState();
  } else {
    destroyFloatCoordEl();
  }
}

// Commit a vertex from two already-parsed coordinates (the floating
// panel's path — its x and y are separate <input>s). Returns true on
// success. Does NOT call render() so the caller can re-render and then
// restore focus to the x field in a controlled sequence.
function commitCoordPair(dx, dy) {
  if (!drawActive || drawVertices.length < 1) return false;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  const v0 = drawVertices[0];
  // Y-axis flip — user-facing convention is math-style (Y-up = positive)
  // but internal SVG world-Y goes DOWN as positive. So typed dy=+3
  // means "3 m up on screen" = world-Y v0.y − 3 (smaller world Y).
  drawVertices.push({ x: v0.x + dx, y: v0.y - dy });
  return true;
}

// ---------------------------------------------------------------------
// Floating coord-entry panel
// ---------------------------------------------------------------------
// Lives as a direct child of #view-2d so the per-frame innerHTML
// rewrite of .viewport-2d never destroys its inputs (and never blows
// away the typing focus). All position changes happen via
// requestAnimationFrame so mousemove doesn't trigger a layout per
// event.
function ensureFloatCoordEl(vp) {
  // Mount the panel as a child of #viewport (the outer container) NOT
  // #view-2d, because #view-2d.innerHTML gets rewritten on every
  // mousemove — that would obliterate the panel + the user's typing
  // focus per frame. #viewport is position:relative + overflow:hidden,
  // a perfect anchor for the absolute panel.
  const host = document.getElementById('viewport') || document.getElementById('view-2d');
  if (!host) return;
  if (floatCoordEl && host.contains(floatCoordEl)) return;
  const el = document.createElement('div');
  el.className = 'draw-float-coord';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Next point — type coordinates');
  el.innerHTML = `
    <div class="draw-float-coord-row">
      <label class="draw-float-coord-label" for="draw-float-x">x</label>
      <input id="draw-float-x" class="draw-float-coord-input" type="text"
             inputmode="decimal" autocomplete="off" spellcheck="false"
             maxlength="7" aria-label="x in metres relative to first click" />
      <span class="draw-float-coord-unit">m</span>
      <label class="draw-float-coord-label" for="draw-float-y">y</label>
      <input id="draw-float-y" class="draw-float-coord-input" type="text"
             inputmode="decimal" autocomplete="off" spellcheck="false"
             maxlength="7" aria-label="y in metres relative to first click" />
      <span class="draw-float-coord-unit">m</span>
    </div>
    <div class="draw-float-coord-hint">
      <kbd>Enter</kbd> add point
      <span class="draw-float-coord-sep">·</span>
      <kbd>C</kbd> close room
      <span class="draw-float-coord-sep">·</span>
      <kbd>Esc</kbd> cancel
    </div>
  `;
  host.appendChild(el);
  floatCoordEl = el;
  const xInput = el.querySelector('#draw-float-x');
  const yInput = el.querySelector('#draw-float-y');
  // Restore any cached typed values that survived a re-render (we keep
  // the cache so accidental destroys don't lose user typing).
  if (floatCoordCachedX) xInput.value = floatCoordCachedX;
  if (floatCoordCachedY) yInput.value = floatCoordCachedY;
  const onFieldKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitFloatCoord();
      return;
    }
    if (e.key === 'Escape') {
      // Don't swallow — pass through to window handler so the user can
      // cancel draw mode while focus is in the input.
      cancelDraw();
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      // Trap Tab inside the panel: forward x → y, forward y → x;
      // Shift+Tab y → x, Shift+Tab x → y. Without trapping, Tab
      // would escape to a random toolbar button and the user would
      // lose typing context.
      e.preventDefault();
      if (e.target === xInput) { yInput.focus(); yInput.select(); }
      else                     { xInput.focus(); xInput.select(); }
      return;
    }
    // 'C' (close room) — fire finishDraw if ≥3 pts placed. Without
    // this guard the literal character 'C' enters the field, which
    // the user reported 2026-05-17 (couldn't close the loop while
    // focus was in a coord input).
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      if (drawVertices.length >= 3) finishDraw();
      return;
    }
    // Numeric-input filter — block any key that can't legally appear
    // in a metric coord string. Allow: digits, '-' (negative), '.'
    // (decimal), plus all navigation / editing keys (arrows, Home,
    // End, Tab handled above, Backspace, Delete, etc.) and modifier
    // combos (Ctrl+A, Ctrl+C, Ctrl+V). Block everything else so 'c',
    // 'r', 'q' etc. can't pollute the field.
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // Ctrl+A, Cmd+V, etc.
    if (e.key.length > 1) return;                     // navigation/editing keys
    const ok = /^[0-9.\-]$/.test(e.key);
    if (!ok) {
      e.preventDefault();
    }
  };
  const onFieldInput = (e) => {
    // Cache + live-validate. Green if the typed pair would land within
    // the close-radius of vertex[0] (so the user knows pressing Enter
    // here will close the loop, not place a new edge).
    if (e.target === xInput) floatCoordCachedX = xInput.value;
    if (e.target === yInput) floatCoordCachedY = yInput.value;
    updateFloatCoordState();
  };
  xInput.addEventListener('keydown', onFieldKey);
  yInput.addEventListener('keydown', onFieldKey);
  xInput.addEventListener('input', onFieldInput);
  yInput.addEventListener('input', onFieldInput);
  // Auto-focus x so the user can start typing immediately after the
  // first click without reaching for the panel.
  setTimeout(() => { xInput.focus(); xInput.select(); }, 0);
  // Initial position — use the last known cursor sample if we have one
  // (e.g., the user moved the mouse before placing vertex 1), otherwise
  // anchor near the SVG centre so the panel doesn't flash at 0,0.
  positionFloatCoord();
}

function destroyFloatCoordEl() {
  if (!floatCoordEl) return;
  floatCoordEl.remove();
  floatCoordEl = null;
  floatCoordCachedX = '';
  floatCoordCachedY = '';
}

// Re-position the panel near the current cursor. Called on every
// mousemove (batched through RAF) and once at mount time.
function scheduleFloatCoordPosUpdate(clientX, clientY) {
  floatCoordCursor.clientX = clientX;
  floatCoordCursor.clientY = clientY;
  if (floatCoordPosRAF) return;
  floatCoordPosRAF = requestAnimationFrame(() => {
    floatCoordPosRAF = 0;
    positionFloatCoord();
  });
}

function positionFloatCoord() {
  if (!floatCoordEl) return;
  const host = document.getElementById('viewport') || document.getElementById('view-2d');
  if (!host) return;
  const hostRect = host.getBoundingClientRect();
  // Anchor the auto-flip math to the actual draw canvas inside
  // #view-2d (the visible drawing region) — not to #viewport, which
  // includes the floating toolbar/segmented controls + side rails.
  // Without this the panel could clip cleanly inside #viewport but
  // sit on top of the segmented control.
  const view2d = document.getElementById('view-2d');
  const canvas = view2d?.querySelector('.draw-canvas') || view2d || host;
  const canvasRect = canvas.getBoundingClientRect();
  // Measure panel size after a layout pass. Use offsetWidth/Height
  // which doesn't trigger an extra layout for absolutely-positioned
  // siblings whose size hasn't changed.
  const pw = floatCoordEl.offsetWidth || 220;
  const ph = floatCoordEl.offsetHeight || 56;
  const OFFSET = 14;       // px diagonal offset from the cursor crosshair
  const GAP    = 8;        // min gap to the canvas edge
  // Fall back to canvas centre if we don't yet have a real cursor sample
  // (happens on initial mount before the first mousemove).
  let cx = floatCoordCursor.clientX;
  let cy = floatCoordCursor.clientY;
  if (!cx && !cy) {
    cx = canvasRect.left + canvasRect.width / 2;
    cy = canvasRect.top + canvasRect.height / 2;
  }
  // Default: below-right of cursor.
  let left = cx + OFFSET;
  let top  = cy + OFFSET;
  // Auto-flip horizontally if we'd clip the canvas's right edge.
  if (left + pw + GAP > canvasRect.right) left = cx - OFFSET - pw;
  if (left < canvasRect.left + GAP)       left = canvasRect.left + GAP;
  // Auto-flip vertically if we'd clip the bottom edge. Ceiling is the
  // canvas top (not viewport top) so the panel can never slide up over
  // the draw toolbar / mode segmented control above the canvas.
  if (top + ph + GAP > canvasRect.bottom) top = cy - OFFSET - ph;
  if (top < canvasRect.top + GAP)         top = canvasRect.top + GAP;
  // Convert to host-relative (the panel is absolutely positioned inside #view-2d).
  floatCoordEl.style.left = `${Math.round(left - hostRect.left)}px`;
  floatCoordEl.style.top  = `${Math.round(top  - hostRect.top)}px`;
}

// Decide the panel's visual state — "ready to close" (when cursor is
// inside close-radius and ≥3 pts placed) or default. Also colours the
// y/x fields green when typed coords would commit at the close point.
function updateFloatCoordState() {
  if (!floatCoordEl) return;
  const readyClose = drawCursorNearStart && drawVertices.length >= 3;
  floatCoordEl.classList.toggle('draw-float-coord-ready-close', readyClose);
  // Typed-coord-near-close highlight — only if we have a v0 to compare against.
  const xInput = floatCoordEl.querySelector('#draw-float-x');
  const yInput = floatCoordEl.querySelector('#draw-float-y');
  if (!xInput || !yInput) return;
  if (drawVertices.length >= 3) {
    const dx = parseFloat(xInput.value);
    const dy = parseFloat(yInput.value);
    let typedNearClose = false;
    if (Number.isFinite(dx) && Number.isFinite(dy)) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      typedNearClose = dist <= CLOSE_RADIUS_M;
    }
    xInput.classList.toggle('draw-float-coord-input-close', typedNearClose);
    yInput.classList.toggle('draw-float-coord-input-close', typedNearClose);
  } else {
    xInput.classList.remove('draw-float-coord-input-close');
    yInput.classList.remove('draw-float-coord-input-close');
  }
}

// Commit the typed (x, y) pair as a new vertex. If the typed point
// lands within the close-radius of vertex[0] AND we have ≥3 pts, that's
// a close-loop intent — finishDraw() instead of pushing a vertex on top
// of the origin. Refocuses x and clears both fields on success.
function submitFloatCoord() {
  if (!floatCoordEl) return;
  const xInput = floatCoordEl.querySelector('#draw-float-x');
  const yInput = floatCoordEl.querySelector('#draw-float-y');
  if (!xInput || !yInput) return;
  const dx = parseFloat(xInput.value);
  const dy = parseFloat(yInput.value);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    // Flash whichever field is bad so the user sees what to fix. If
    // both are bad, flash both.
    if (!Number.isFinite(dx)) flashField(xInput);
    if (!Number.isFinite(dy)) flashField(yInput);
    return;
  }
  // Close-loop intent — typed point sits within close-radius of v0 (the
  // new origin) and we already have a closeable polygon.
  if (drawVertices.length >= 3 && Math.sqrt(dx * dx + dy * dy) <= CLOSE_RADIUS_M) {
    finishDraw();
    return;
  }
  if (!commitCoordPair(dx, dy)) { flashField(xInput); flashField(yInput); return; }
  xInput.value = '';
  yInput.value = '';
  floatCoordCachedX = '';
  floatCoordCachedY = '';
  render();
  // render() rebuilds .viewport-2d but ensureFloatCoordEl keeps the
  // panel intact, so the x input still exists — refocus it for the
  // next entry.
  setTimeout(() => {
    const fresh = document.getElementById('draw-float-x');
    if (fresh) { fresh.focus(); fresh.select(); }
  }, 0);
}

function flashField(el) {
  el.classList.add('draw-float-coord-err');
  setTimeout(() => el.classList.remove('draw-float-coord-err'), 360);
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
        ? computeRoomConstant(state.room, materialsRef, freq, state.zones, { treatments: state.treatments }) : 0,
    });
    if (splResult.sourceCount > 0 && isFinite(splResult.maxSPL_db)) {
      state.results.splGrid = splResult;
      splSvg = renderHeatmapSVG(splResult, x0, y0, pxW, pxD, state.room);
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
  // Render speakers from state.sources DIRECTLY (not the flat-element
  // list) so each rendered group is tagged with its parent-source index
  // for click-to-select and drag-to-move. Line-array elements expand
  // inline and all share the parent index — dragging any element moves
  // the whole array as a unit.
  const selectedSrcIdx = (typeof state.selectedSourceIdx === 'number') ? state.selectedSourceIdx : -1;
  const draggingSrcIdx = (pickableDrag?.kind === 'source' && pickableDrag?.didMove) ? pickableDrag.sourceIdx : -1;
  const speakerSvg = state.sources.length > 0
    ? renderSpeakersSVG(state.sources, x0, y0, pxW, pxD, state.room, selectedSrcIdx, draggingSrcIdx)
    : '';
  const draggingListenerId = (pickableDrag?.kind === 'listener' && pickableDrag?.didMove) ? pickableDrag.listenerId : null;
  const listenerSvg = state.listeners.length > 0 ? renderListenersSVG(state.listeners, state.selectedListenerId, x0, y0, pxW, pxD, state.room, draggingListenerId) : '';
  const draggingTreatId = (pickableDrag?.kind === 'treatment' && pickableDrag?.didMove) ? pickableDrag.treatmentId : null;
  const treatmentSvg = (state.treatments && state.treatments.length > 0)
    ? renderTreatmentsSVG(state.treatments, state.selectedTreatmentId, draggingTreatId, x0, y0, pxW, pxD, state.room)
    : '';

  // Room-corner vertex handles. Skipped for 'round' rooms (no
  // corners) and when room dims are zero. Shown only after the user
  // is in 2D (where geometry edits make sense).
  const draggingVertexIdx = (pickableDrag?.kind === 'vertex' && pickableDrag?.didMove) ? pickableDrag.vertexIdx : -1;
  const vertexSvg = renderVertexHandlesSVG(state.room, state.selectedVertexIdx, draggingVertexIdx, x0, y0, pxW, pxD);
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
        ${renderNorthArrowSVG(x0, y0, pxW)}
        ${zonesSvg}
        ${subSvg}
        ${encSvg}
        ${wsegSvg}
        ${treatmentSvg}
        ${listenerSvg}
        ${speakerSvg}
        ${vertexSvg}
        ${renderOriginCrosshair(x0, y0, '#5a6677')}
        ${splResult ? '' : `<text x="${x0 + pxW/2}" y="${y0 + pxD/2}" text-anchor="middle" class="vp-lbl vp-lbl-empty">no sources placed</text><text x="${x0 + pxW/2}" y="${y0 + pxD/2 + 18}" text-anchor="middle" class="vp-lbl vp-lbl-empty-hint">add a speaker to compute SPL</text>`}
      </svg>
      <!-- Meta text moved OUT of the SVG so wheel-zoom (which adjusts
           the SVG viewBox) doesn't scale it. Lives below the SVG as
           plain HTML; same .vp-lbl-dim styling. -->
      <div class="vp-meta-strip">${shapeMeta}  |  floor: ${nameOf(surfaces.floor)}  |  walls: ${wallsMeta}  |  ceiling: ${ceilMeta}</div>
      ${renderLegend(splResult)}
    </div>
  `;

  // Wire source interaction AFTER innerHTML — the new SVG elements
  // exist now and event delegation can find .r2d-source groups via
  // closest(). Re-runs on every render() so listeners always point
  // at the live SVG (the old SVG was thrown out with the innerHTML).
  wireSourceInteraction(vp);
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
  // Surau with podium: clip path extends to the podium rectangle so
  // the SPL heatmap is visible across the arcade / corridor area
  // (not just inside the prayer-hall walls). Previously the heatmap
  // was clipped at the room polygon and the user saw an empty
  // corridor even when arcade speakers were lighting it up.
  const podiumExt = room?.surauStructure?.podium?.extension_m;
  if (Number.isFinite(podiumExt) && podiumExt > 0 && room.width_m > 0 && room.depth_m > 0) {
    const w = room.width_m, d = room.depth_m;
    const sxPerM = pxW / w, syPerM = pxD / d;
    const x1 = (x0 + (-podiumExt) * sxPerM).toFixed(1);
    const y1 = (y0 + (-podiumExt) * syPerM).toFixed(1);
    const x2 = (x0 + (w + podiumExt) * sxPerM).toFixed(1);
    const y2 = (y0 + (d + podiumExt) * syPerM).toFixed(1);
    return `<clipPath id="room-clip"><polygon points="${x1},${y1} ${x2},${y1} ${x2},${y2} ${x1},${y2}" /></clipPath>`;
  }
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

// North arrow drawn above the top-right of the room rect, matching the
// kite + 'N' label convention used by the printed report (see
// print-heatmap.js northArrowEl) so the two views read identically.
// In the live 2D plan the FRONT wall is at the top, which is also
// where the arrow points — sources with yaw=180 in state coordinates
// fire toward the front, so 'north = front' is the canonical map.
function renderNorthArrowSVG(x0, y0, pxW) {
  const size = 14;                          // half-height of the arrow
  const cx = x0 + pxW - 10;                 // top-right, just inside the right edge
  const cy = y0 - 18;                       // sits above the FRONT label band
  const apexY = cy - size;
  const midY = cy + size * 0.25;
  const baseY = cy + size * 0.05;
  const halfW = size * 0.45;
  return `
    <g class="vp-north-arrow" aria-hidden="true">
      <polygon points="${cx},${apexY} ${cx + halfW},${midY} ${cx},${baseY} ${cx - halfW},${midY}" fill="#cfd3d9" stroke="#0a0c10" stroke-width="0.6" />
      <text x="${cx}" y="${cy + size * 0.95}" text-anchor="middle" font-size="10" font-weight="600" fill="#cfd3d9" stroke="#0a0c10" stroke-width="0.4" paint-order="stroke">N</text>
    </g>
  `;
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

// Render the SPL/STI grid as colored rectangles.
//
// IMPORTANT: computeSPLGrid samples over the polygon's effective
// bounding box (origin = bounds.minX, bounds.minY; extent = totalW,
// totalD), which can differ from the room's nominal [0, width_m] ×
// [0, depth_m] window — especially after a vertex-drag reshape that
// leaves minX > 0 or maxX < width_m. The cells must be placed at
// their true WORLD coords (via originX_m + cellW_m) and then mapped
// through the same world→screen function speakers and listeners use,
// or the heatmap will visibly drift away from the source it belongs to.
function renderHeatmapSVG(splResult, x0, y0, pxW, pxD, room) {
  const { grid, cellsX, cellsY, cellW_m, cellD_m, originX_m, originY_m } = splResult;
  if (!room || !(room.width_m > 0) || !(room.depth_m > 0)) return '';
  const w = room.width_m, d = room.depth_m;
  const ox = Number.isFinite(originX_m) ? originX_m : 0;
  const oy = Number.isFinite(originY_m) ? originY_m : 0;
  const cwm = Number.isFinite(cellW_m) ? cellW_m : (w / cellsX);
  const cdm = Number.isFinite(cellD_m) ? cellD_m : (d / cellsY);
  // Each world-metre maps to pxW / width_m screen pixels (same scale
  // the speaker / listener renderers use).
  const sxPerM = pxW / w;
  const syPerM = pxD / d;
  const cwPx = cwm * sxPerM;
  const chPx = cdm * syPerM;
  let s = '';
  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++) {
      const spl = grid[j][i];
      if (!isFinite(spl)) continue;
      const wxm = ox + i * cwm;
      const wym = oy + j * cdm;
      const sx = x0 + wxm * sxPerM;
      const sy = y0 + wym * syPerM;
      s += `<rect x="${sx.toFixed(2)}" y="${sy.toFixed(2)}" width="${(cwPx + 0.5).toFixed(2)}" height="${(chPx + 0.5).toFixed(2)}" fill="${splColor(spl)}" fill-opacity="0.55" />`;
    }
  }
  return s;
}

// Render the speakers + line-array elements as interactive <g> groups.
//
// Each group is tagged with data-source-idx (parent index in
// state.sources) and data-elem-idx (0 for point sources; 0..N-1 for
// line-array elements). Groups carry `transform="translate(sx,sy)"`
// with all children at relative (0,0) coords so a CSS / inline scale
// during drag enlarges the icon about its visual centre.
//
// Selection + drag highlight:
//   .r2d-source-selected — cyan ring around the group's source icon
//   .r2d-source-dragging — 2x scale + yellow fill (transform appended)
function renderSpeakersSVG(sources, x0, y0, pxW, pxD, room, selectedIdx, draggingIdx) {
  let s = '';
  // Iterate state.sources DIRECTLY (not the expanded list) so we know
  // each rendered element's parent source-idx for click/drag wiring.
  // Line arrays expand inline; every element shares the parent idx
  // because drag moves the whole array as a unit.
  sources.forEach((src, i) => {
    const isSelected = (i === selectedIdx);
    const isDragging = (i === draggingIdx);
    if (src && src.kind === 'line-array') {
      const elements = expandLineArrayToElements(src);
      elements.forEach((el, k) => {
        s += renderOneSpeakerSymbol(el, i, k, x0, y0, pxW, pxD, room, isSelected, isDragging, `LA${i + 1}-${k + 1}`);
      });
    } else if (src && src.position) {
      s += renderOneSpeakerSymbol(src, i, 0, x0, y0, pxW, pxD, room, isSelected, isDragging, `S${i + 1}`);
    }
  });
  return s;
}

// Render a single speaker icon as an interactive <g> group. `src` is
// the already-resolved element (point source OR line-array expanded
// element with position + aim + groupId). `parentIdx` is the index in
// state.sources used for click-select / drag. `elemIdx` distinguishes
// line-array elements (0..N-1).
function renderOneSpeakerSymbol(src, parentIdx, elemIdx, x0, y0, pxW, pxD, room, isSelected, isDragging, labelText) {
  const sx = x0 + (src.position.x / room.width_m) * pxW;
  const sy = y0 + (src.position.y / room.depth_m) * pxD;
  const outside = !isInsideRoom3D(src.position, room);
  const groupColor = src.groupId ? colorForGroup(src.groupId) : null;
  const baseFill = outside ? '#ff5a3c' : (groupColor || '#fff');
  const baseStroke = outside ? '#8a1200' : '#000';
  const yaw_rad = (src.aim?.yaw ?? 0) * Math.PI / 180;
  const size = 13;
  const aimX = Math.sin(yaw_rad), aimY = Math.cos(yaw_rad);
  const rightX = Math.cos(yaw_rad), rightY = -Math.sin(yaw_rad);
  // Vertices are written relative to (0, 0) so the parent <g>'s
  // transform=translate(sx,sy) places them in the viewport AND so a
  // scale(2) appended during drag scales about the icon's centre.
  const tip = { x:  size * aimX,           y:  size * aimY };
  const bl  = { x: -size * 0.5 * aimX - size * 0.6 * rightX, y: -size * 0.5 * aimY - size * 0.6 * rightY };
  const br  = { x: -size * 0.5 * aimX + size * 0.6 * rightX, y: -size * 0.5 * aimY + size * 0.6 * rightY };

  const transform = `translate(${sx.toFixed(1)},${sy.toFixed(1)})${isDragging ? ' scale(2)' : ''}`;
  const cls = ['r2d-source']
    .concat(isSelected ? ['r2d-source-selected'] : [])
    .concat(isDragging ? ['r2d-source-dragging'] : [])
    .join(' ');

  let s = `<g class="${cls}" data-source-idx="${parentIdx}" data-elem-idx="${elemIdx}" transform="${transform}">`;

  // Selection ring — soft cyan halo behind the icon. Sized so the
  // 2x-scaled dragging state stays visible and the selected state is
  // unambiguous against the heatmap.
  if (isSelected) {
    s += `<circle class="r2d-spk-selring" cx="0" cy="0" r="${size + 7}" fill="none" stroke="#ffd24a" stroke-width="2.2" />`;
  }
  // Speaker-group colour ring (unchanged from the previous render).
  if (groupColor && !outside) {
    s += `<circle cx="0" cy="0" r="${size + 3}" fill="none" stroke="${groupColor}" stroke-width="2" opacity="0.6"/>`;
  }
  // Body triangle + centre dot.
  s += `<polygon class="r2d-spk-poly" points="${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${bl.x.toFixed(1)},${bl.y.toFixed(1)} ${br.x.toFixed(1)},${br.y.toFixed(1)}" fill="${baseFill}" stroke="${baseStroke}" stroke-width="1.5" />`;
  s += `<circle class="r2d-spk-dot" cx="0" cy="0" r="2" fill="${baseStroke}" />`;
  // Label sits above the icon. We hide it during drag so the moving
  // text doesn't blur — the cyan ring + colour are enough during the
  // 100-ms drag operation.
  if (!isDragging) {
    const lblFill = outside ? '#ff5a3c' : (groupColor || '#e8ecf2');
    const lblText = outside ? `${labelText} ⚠` : labelText;
    s += `<text x="0" y="-18" text-anchor="middle" class="vp-lbl vp-lbl-spk" fill="${lblFill}">${lblText}</text>`;
  }
  s += `</g>`;
  return s;
}

// ---------------------------------------------------------------------
// 2D source interaction — click-select, drag-move, right-click context
// menu. Wired via event delegation on the floor-plan SVG so a single
// listener set covers every speaker rendered into the viewport.
// ---------------------------------------------------------------------
function wireSourceInteraction(vp) {
  const svg = vp.querySelector('svg');
  if (!svg) return;
  svg.addEventListener('pointerdown', onPickablePointerDown);
  svg.addEventListener('contextmenu', onPickableContextMenu);
}

// Find a pickable target (speaker OR listener) from an event. Returns
// `{ kind, el, sourceIdx?, listenerId? }` or null if the event hit the
// floor-plan background.
function findPickableFromEvent(e) {
  const target = e.target;
  if (!(target instanceof Element)) return null;
  // Vertex handles take priority — they sit above speakers/listeners
  // and are smaller, so the user clicking a vertex shouldn't be
  // hijacked by a speaker icon that happens to share the same spot.
  const vEl = target.closest('.r2d-vertex');
  if (vEl) {
    const i = parseInt(vEl.dataset.vertexIdx, 10);
    if (Number.isFinite(i)) return { kind: 'vertex', el: vEl, vertexIdx: i };
  }
  const srcEl = target.closest('.r2d-source');
  if (srcEl) {
    const i = parseInt(srcEl.dataset.sourceIdx, 10);
    if (Number.isFinite(i)) return { kind: 'source', el: srcEl, sourceIdx: i };
  }
  const lstEl = target.closest('.r2d-listener');
  if (lstEl) {
    const id = lstEl.dataset.listenerId;
    if (id) return { kind: 'listener', el: lstEl, listenerId: id };
  }
  // Treatments — lowest priority among pickables. A speaker / listener
  // / vertex sitting on top of a treatment still claims the click first.
  const treatEl = target.closest('.r2d-treatment');
  if (treatEl) {
    const id = treatEl.dataset.treatmentId;
    if (id) return { kind: 'treatment', el: treatEl, treatmentId: id };
  }
  return null;
}

// Convert a client (mouse) pixel coordinate into world metres using
// the same room-fitted geometry the renderer uses. Returns null if
// the SVG has been removed or the conversion can't be performed.
function clientToWorldXY(svg, clientX, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const local = pt.matrixTransform(ctm.inverse());
  const geom = currentRoomGeom();
  const room = state.room;
  const rx = ((local.x - geom.x0) / geom.pxW) * room.width_m;
  const ry = ((local.y - geom.y0) / geom.pxD) * room.depth_m;
  return { x: rx, y: ry };
}

function snapToGrid(v) { return Math.round(v / SOURCE_SNAP_M) * SOURCE_SNAP_M; }

// Return the current room's vertex list in WORLD coords without
// converting to 'custom' (read-only inspection). Used by the vertex
// selection code paths that must NOT mutate the room shape just
// because the user clicked a handle.
function currentRoomVertices(room) {
  if (!room) return null;
  if (room.shape === 'round') return null;
  const w = room.width_m, d = room.depth_m;
  if (room.shape === 'polygon') {
    const n = room.polygon_sides ?? 6;
    const r = room.polygon_radius_m ?? 3;
    const cx = (w ?? 8) / 2, cy = (d ?? 8) / 2;
    const verts = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n;
      verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return verts;
  }
  if (room.shape === 'custom'
      && Array.isArray(room.custom_vertices)
      && room.custom_vertices.length >= 3) {
    return room.custom_vertices.map(v => ({ x: v.x, y: v.y }));
  }
  if (!(w > 0) || !(d > 0)) return null;
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
}

function onPickablePointerDown(e) {
  // Right-click is handled by contextmenu, not pointerdown.
  if (e.button === 2) return;
  // Left-click only — middle-click stays free for the existing pan
  // gesture (and isn't bound on the normal-mode SVG yet).
  if (e.button !== 0) return;

  const pick = findPickableFromEvent(e);
  if (!pick) {
    // Click on empty 2D area — close any open context menu AND clear
    // all pickable selections (source / listener / vertex). Click-to-
    // deselect mirrors the standard pick-tool behaviour.
    closeSourceContextMenu();
    if (state.selectedSourceIdx != null) {
      state.selectedSourceIdx = null;
      emit('source:selected', { idx: null });
    }
    if (state.selectedListenerId != null) {
      state.selectedListenerId = null;
      emit('listener:selected', { id: null });
    }
    if (state.selectedVertexIdx != null) {
      state.selectedVertexIdx = null;
      emit('room:changed');
    }
    if (state.selectedTreatmentId != null) {
      state.selectedTreatmentId = null;
      emit('treatment:selected', { id: null });
    }
    return;
  }

  e.preventDefault();
  e.stopPropagation();
  closeSourceContextMenu();

  // Resolve the pickable into the source/listener state object + the
  // panel it belongs in. Both branches set up identical drag bookkeeping
  // — only the start position and selection event differ.
  let startWorldX, startWorldY;
  if (pick.kind === 'source') {
    const src = state.sources[pick.sourceIdx];
    if (!src) return;
    try { openPanel('left', 'sources'); } catch (_) {}
    if (state.selectedSourceIdx !== pick.sourceIdx) {
      state.selectedSourceIdx = pick.sourceIdx;
      emit('source:selected', { idx: pick.sourceIdx });
    }
    const posKey = (src.kind === 'line-array') ? 'origin' : 'position';
    startWorldX = src[posKey].x;
    startWorldY = src[posKey].y;
    pickableDrag = {
      kind: 'source',
      sourceIdx: pick.sourceIdx,
      posKey,
      startClientX: e.clientX, startClientY: e.clientY,
      startSrcWorldX: startWorldX, startSrcWorldY: startWorldY,
      pointerId: e.pointerId, didMove: false,
    };
  } else if (pick.kind === 'listener') {
    const lst = state.listeners.find(l => l.id === pick.listenerId);
    if (!lst) return;
    try { openPanel('left', 'listeners'); } catch (_) {}
    if (state.selectedListenerId !== pick.listenerId) {
      state.selectedListenerId = pick.listenerId;
      emit('listener:selected', { id: pick.listenerId });
    }
    startWorldX = lst.position.x;
    startWorldY = lst.position.y;
    pickableDrag = {
      kind: 'listener',
      listenerId: pick.listenerId,
      startClientX: e.clientX, startClientY: e.clientY,
      startSrcWorldX: startWorldX, startSrcWorldY: startWorldY,
      pointerId: e.pointerId, didMove: false,
    };
  } else if (pick.kind === 'treatment') {
    const t = state.treatments?.find(x => x.id === pick.treatmentId);
    if (!t) return;
    try { openPanel('left', 'treatments'); } catch (_) {}
    if (state.selectedTreatmentId !== pick.treatmentId) {
      state.selectedTreatmentId = pick.treatmentId;
      emit('treatment:selected', { id: pick.treatmentId });
    }
    startWorldX = t.position.x;
    startWorldY = t.position.y;
    pickableDrag = {
      kind: 'treatment',
      treatmentId: pick.treatmentId,
      startClientX: e.clientX, startClientY: e.clientY,
      startSrcWorldX: startWorldX, startSrcWorldY: startWorldY,
      pointerId: e.pointerId, didMove: false,
    };
  } else { // 'vertex'
    // Resolve the vertex's CURRENT world position from whatever shape
    // the room is in right now. If/when the user actually drags, the
    // shape gets converted to 'custom' before mutation.
    const verts = currentRoomVertices(state.room);
    if (!verts || pick.vertexIdx < 0 || pick.vertexIdx >= verts.length) return;
    if (state.selectedVertexIdx !== pick.vertexIdx) {
      state.selectedVertexIdx = pick.vertexIdx;
      // No dedicated 'vertex:selected' event — the handles + adjacent
      // highlight are part of the 2D renderer's room:changed path.
      emit('room:changed');
    }
    startWorldX = verts[pick.vertexIdx].x;
    startWorldY = verts[pick.vertexIdx].y;
    pickableDrag = {
      kind: 'vertex',
      vertexIdx: pick.vertexIdx,
      startClientX: e.clientX, startClientY: e.clientY,
      startSrcWorldX: startWorldX, startSrcWorldY: startWorldY,
      pointerId: e.pointerId, didMove: false,
    };
  }

  // Window + document listeners — SVG-level listeners would be
  // detached by the source/listener:changed innerHTML rebuilds, so
  // neither target is the SVG. Document is the safety net.
  window.addEventListener('pointermove',   onPickablePointerMove);
  window.addEventListener('pointerup',     onPickablePointerUp);
  window.addEventListener('pointercancel', onPickablePointerUp);
  document.addEventListener('pointerup',   onPickablePointerUp);
  document.addEventListener('pointercancel', onPickablePointerUp);
  pickableDrag.safetyTimer = setTimeout(() => onPickablePointerUp(), 30000);
}

function onPickablePointerMove(e) {
  if (!pickableDrag) return;
  const dx = e.clientX - pickableDrag.startClientX;
  const dy = e.clientY - pickableDrag.startClientY;
  if (!pickableDrag.didMove) {
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    pickableDrag.didMove = true;
    // For VERTEX drags, ensure the room is in 'custom' mode before
    // mutating coords. convertRoomToCustomPolygon is idempotent —
    // calling it on an already-custom room is a no-op. After this
    // call, room.custom_vertices is a live array we can write into.
    if (pickableDrag.kind === 'vertex') {
      const verts = convertRoomToCustomPolygon(state.room);
      // If the conversion failed (round room) cancel the drag.
      if (!verts || pickableDrag.vertexIdx >= verts.length) {
        pickableDrag = null;
        return;
      }
    }
    // First move — re-render so the dragged item switches to the
    // 2x scale visual before the position update lands.
    const firstEvt = pickableDrag.kind === 'listener' ? 'listener:changed'
                   : pickableDrag.kind === 'vertex'   ? 'room:changed'
                   : pickableDrag.kind === 'treatment' ? 'treatment:changed'
                   : 'source:changed';
    emit(firstEvt);
  }

  // Re-acquire the LIVE SVG. Compute start-world and live-world
  // through the SAME current CTM, every tick — robust against any
  // layout shift mid-drag.
  const svg = document.querySelector('#view-2d svg');
  if (!svg) return;
  const startWorld = clientToWorldXY(svg, pickableDrag.startClientX, pickableDrag.startClientY);
  const liveWorld  = clientToWorldXY(svg, e.clientX, e.clientY);
  if (!startWorld || !liveWorld) return;

  const targetX = pickableDrag.startSrcWorldX + (liveWorld.x - startWorld.x);
  const targetY = pickableDrag.startSrcWorldY + (liveWorld.y - startWorld.y);

  const w = state.room.width_m;
  const d = state.room.depth_m;
  const margin = SOURCE_SNAP_M;
  let nx = snapToGrid(targetX);
  let ny = snapToGrid(targetY);
  if (Number.isFinite(w)) nx = Math.max(margin, Math.min(w - margin, nx));
  if (Number.isFinite(d)) ny = Math.max(margin, Math.min(d - margin, ny));

  if (pickableDrag.kind === 'source') {
    const src = state.sources[pickableDrag.sourceIdx];
    if (!src) return;
    const key = pickableDrag.posKey;
    if (src[key].x !== nx || src[key].y !== ny) {
      src[key].x = nx;
      src[key].y = ny;
      emit('source:changed');
      emit('source:position', { idx: pickableDrag.sourceIdx, x: nx, y: ny, kind: src.kind || 'speaker' });
    }
  } else if (pickableDrag.kind === 'listener') {
    const lst = state.listeners.find(l => l.id === pickableDrag.listenerId);
    if (!lst) return;
    if (lst.position.x !== nx || lst.position.y !== ny) {
      lst.position.x = nx;
      lst.position.y = ny;
      emit('listener:changed');
      // Same side-channel pattern — surgical X/Y patch in the panel
      // so a drag doesn't yank focus from inputs the user might be
      // editing on another listener card.
      emit('listener:position', { id: pickableDrag.listenerId, x: nx, y: ny });
    }
  } else if (pickableDrag.kind === 'treatment') {
    // Treatments are constrained to their anchored surface plane —
    // for wall anchors we re-project the un-snapped raw target onto
    // the wall segment. For ceiling we let it float in X/Y at room
    // height.
    const t = state.treatments?.find(x => x.id === pickableDrag.treatmentId);
    if (!t) return;
    // Use the RAW (un-clamped, un-snapped) target so a small drag
    // doesn't gridlock at 0.5 m intervals — panels are continuous,
    // not on a grid.
    if (t.anchor?.surface === 'ceiling') {
      if (t.position.x !== targetX || t.position.y !== targetY) {
        t.position.x = targetX;
        t.position.y = targetY;
        t.position.z = state.room.height_m ?? t.position.z;
        emit('treatment:changed');
      }
    } else if (t.anchor?.surface === 'wall' && Number.isFinite(t.anchor.wallIndex)) {
      const polygonVerts = roomPlanVertices(state.room);
      const proj = projectOntoWall(polygonVerts, t.anchor.wallIndex,
        { x: targetX, y: targetY }, t.position.z);
      if (proj && (t.position.x !== proj.position.x || t.position.y !== proj.position.y)) {
        t.position.x = proj.position.x;
        t.position.y = proj.position.y;
        emit('treatment:changed');
      }
    }
  } else { // 'vertex'
    // Vertex coords aren't clamped against the OLD room footprint
    // (the user IS reshaping that footprint), but they ARE clamped
    // to non-negative space — origin (0,0) is the world reference,
    // and the heatmap grid / SVG coord mapping only cover the
    // positive quadrant. Letting verts drift past 0 would leave
    // a region of the polygon uncovered by the heatmap.
    const targetSnapX = Math.max(0, snapToGrid(targetX));
    const targetSnapY = Math.max(0, snapToGrid(targetY));
    const verts = state.room.custom_vertices;
    if (!Array.isArray(verts) || pickableDrag.vertexIdx >= verts.length) return;
    const v = verts[pickableDrag.vertexIdx];
    if (v.x !== targetSnapX || v.y !== targetSnapY) {
      v.x = targetSnapX;
      v.y = targetSnapY;
      // Resize the bounding box so the heatmap grid, 3D walls, and
      // the SVG coord mapping all stretch to the new polygon.
      recomputeRoomDimsFromPolygon(state.room);
      emit('room:changed');
    }
  }
}

// Recalculate room.width_m / room.depth_m from the polygon bounding
// box. Called from the vertex drag handler so the heatmap grid (which
// iterates [0, width_m] × [0, depth_m]) always covers the visible
// shape after the user reshapes it.
//
// We round UP to the 0.5 m grid so widths land on clean numbers and
// floor at 1 m so a degenerate polygon doesn't produce a zero-size
// room. Negative coords are not considered — vertex drags are clamped
// to >= 0 above.
function recomputeRoomDimsFromPolygon(room) {
  if (!room) return;
  const verts = room.custom_vertices;
  if (!Array.isArray(verts) || verts.length < 3) return;
  let maxX = 0, maxY = 0;
  for (const v of verts) {
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  room.width_m = Math.max(1, Math.ceil(maxX * 2) / 2);
  room.depth_m = Math.max(1, Math.ceil(maxY * 2) / 2);
}

function onPickablePointerUp() {
  if (!pickableDrag) return;
  window.removeEventListener('pointermove',   onPickablePointerMove);
  window.removeEventListener('pointerup',     onPickablePointerUp);
  window.removeEventListener('pointercancel', onPickablePointerUp);
  document.removeEventListener('pointerup',   onPickablePointerUp);
  document.removeEventListener('pointercancel', onPickablePointerUp);
  if (pickableDrag.safetyTimer) clearTimeout(pickableDrag.safetyTimer);
  const kind = pickableDrag.kind;
  pickableDrag = null;
  // Always re-render on pointerup so the drag visual drops back to
  // resting state.
  const finalEvt = kind === 'listener' ? 'listener:changed'
                 : kind === 'vertex'   ? 'room:changed'
                 : kind === 'treatment' ? 'treatment:changed'
                 : 'source:changed';
  emit(finalEvt);
}

function onPickableContextMenu(e) {
  const pick = findPickableFromEvent(e);
  if (!pick) {
    closeSourceContextMenu();
    return;
  }
  e.preventDefault();
  if (pick.kind === 'source') {
    try { openPanel('left', 'sources'); } catch (_) {}
    if (state.selectedSourceIdx !== pick.sourceIdx) {
      state.selectedSourceIdx = pick.sourceIdx;
      emit('source:selected', { idx: pick.sourceIdx });
    }
    openSourceContextMenu(e.clientX, e.clientY, pick.sourceIdx);
  } else {
    try { openPanel('left', 'listeners'); } catch (_) {}
    if (state.selectedListenerId !== pick.listenerId) {
      state.selectedListenerId = pick.listenerId;
      emit('listener:selected', { id: pick.listenerId });
    }
    openListenerContextMenu(e.clientX, e.clientY, pick.listenerId);
  }
}

function openSourceContextMenu(clientX, clientY, sourceIdx) {
  closeSourceContextMenu();
  const src = state.sources[sourceIdx];
  if (!src) return;
  const label = (src.kind === 'line-array')
    ? `${src.id || `Line array ${sourceIdx + 1}`}`
    : `Speaker ${sourceIdx + 1}`;
  openPickableMenu(clientX, clientY, label, () => {
    const newIdx = duplicateSource(sourceIdx);
    closeSourceContextMenu();
    if (newIdx >= 0) {
      state.selectedSourceIdx = newIdx;
      emit('source:changed');
      emit('source:selected', { idx: newIdx });
    }
  });
}

function openListenerContextMenu(clientX, clientY, listenerId) {
  closeSourceContextMenu();
  const lst = state.listeners.find(l => l.id === listenerId);
  if (!lst) return;
  const label = lst.label || lst.id || 'Listener';
  openPickableMenu(clientX, clientY, label, () => {
    const newId = duplicateListener(listenerId);
    closeSourceContextMenu();
    if (newId) {
      state.selectedListenerId = newId;
      emit('listener:changed');
      emit('listener:selected', { id: newId });
    }
  });
}

// Shared menu builder — same chrome for sources and listeners. The
// `onDuplicate` callback is the only behavioural difference.
function openPickableMenu(clientX, clientY, label, onDuplicate) {
  const menu = document.createElement('div');
  menu.className = 'r2d-ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <div class="r2d-ctx-header">${escapeMenuHtml(label)}</div>
    <button type="button" class="r2d-ctx-item" data-action="duplicate" role="menuitem">
      <span class="r2d-ctx-glyph">⎘</span> Duplicate
      <span class="r2d-ctx-hint">all settings, +0.5 m</span>
    </button>
  `;
  // Position. Clamp into the viewport so menus near the right/bottom
  // edge don't open off-screen.
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth  - r.width  - 8);
  const top  = Math.min(clientY, window.innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top  = `${Math.max(8, top)}px`;

  menu.querySelector('[data-action="duplicate"]').addEventListener('click', onDuplicate);

  // Dismiss on outside click / Escape.
  const onWinDown = (ev) => {
    if (!menu.contains(ev.target)) closeSourceContextMenu();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') closeSourceContextMenu();
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', onWinDown, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);

  sourceContextMenuEl = { el: menu, onWinDown, onKey };
}

function closeSourceContextMenu() {
  if (!sourceContextMenuEl) return;
  const { el, onWinDown, onKey } = sourceContextMenuEl;
  try { el.remove(); } catch (_) {}
  window.removeEventListener('pointerdown', onWinDown, true);
  window.removeEventListener('keydown', onKey, true);
  sourceContextMenuEl = null;
}

function escapeMenuHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Render listener dots as interactive <g> groups — mirrors the speaker
// pickable groups so the same delegated pointer handlers can drive
// click-select, drag-to-move, and right-click-duplicate for both.
//
// Group transform = translate(sx, sy) with children at (0, 0). Drag
// state appends `scale(2)` to grow the dot around its own centre.
// Acoustic-treatment panels on the 2D plan — wall-anchored items render
// as a tangent rectangle hugging the wall edge; ceiling-anchored items
// render as a small dashed square at the world XY (the ceiling "view"
// is the plan from above so a ceiling panel still has a recognisable
// footprint). Both groups carry data-treatment-id so the click / drag
// handlers can pick them up.
function renderTreatmentsSVG(treatments, selectedId, draggingId, x0, y0, pxW, pxD, room) {
  if (!Array.isArray(treatments) || treatments.length === 0) return '';
  const stateToSvgX = (x) => x0 + (x / room.width_m) * pxW;
  const stateToSvgY = (y) => y0 + (y / room.depth_m) * pxD;
  // World-metres → SVG-pixels scale (uniform — assume the floor plan is
  // aspect-correct because the renderer fits the room into pxW × pxD).
  const px_per_m_x = pxW / Math.max(0.01, room.width_m);
  const px_per_m_y = pxD / Math.max(0.01, room.depth_m);
  // For wall panels we draw a rectangle whose long edge is `width_m`
  // along the wall tangent, and whose short edge is `depth_m` projecting
  // INTO the room. Use the average scale for the short edge so a
  // skewed room aspect doesn't squash the panel visually.
  const px_per_m_avg = (px_per_m_x + px_per_m_y) / 2;

  let s = '';
  for (const t of treatments) {
    if (!t || !t.position || !t.dimensions) continue;
    const isSel = t.id === selectedId;
    const isDrag = t.id === draggingId;
    const w = Math.max(0.05, t.dimensions.width_m ?? 0.6);
    const d = Math.max(0.01, t.dimensions.depth_m ?? 0.05);
    const cx = stateToSvgX(t.position.x);
    const cy = stateToSvgY(t.position.y);

    if (t.anchor?.surface === 'ceiling') {
      // Dashed square — the ceiling panel viewed from above. Size is
      // the panel's full width × height in state-XY plane.
      const h = Math.max(0.05, t.dimensions.height_m ?? 0.6);
      const wPx = w * px_per_m_x;
      const hPx = h * px_per_m_y;
      const rot = t.rotation_deg ?? 0;
      s += `<g class="r2d-treatment ${isSel ? 'selected' : ''} ${isDrag ? 'dragging' : ''}"
              data-treatment-id="${t.id}"
              transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rot.toFixed(1)})">
              ${isSel ? `<rect x="${(-wPx/2 - 4).toFixed(1)}" y="${(-hPx/2 - 4).toFixed(1)}"
                              width="${(wPx + 8).toFixed(1)}" height="${(hPx + 8).toFixed(1)}"
                              fill="none" stroke="#00d4ff" stroke-width="2" stroke-dasharray="4,2" />` : ''}
              <rect x="${(-wPx/2).toFixed(1)}" y="${(-hPx/2).toFixed(1)}"
                    width="${wPx.toFixed(1)}" height="${hPx.toFixed(1)}"
                    fill="#7a89a0" fill-opacity="0.25" stroke="#a0afc0" stroke-width="1.2"
                    stroke-dasharray="3,2" />
              ${isDrag ? '' : `<text x="0" y="${(hPx/2 + 12).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-zone-sub" fill="#a0afc0">${escapeXml(t.label || t.id)}</text>`}
            </g>`;
      continue;
    }
    // Wall-anchored — orient along the polygon edge tangent.
    // Recompute the edge tangent from the anchor's wallIndex.
    const polygonVerts = roomPlanVertices(room);
    let tangAngleDeg = 0;
    if (Array.isArray(polygonVerts) && polygonVerts.length >= 2
        && Number.isFinite(t.anchor?.wallIndex)) {
      const idx = t.anchor.wallIndex % polygonVerts.length;
      const a = polygonVerts[idx];
      const b = polygonVerts[(idx + 1) % polygonVerts.length];
      // SVG +Y is downward so flip the sign on dy when computing the
      // tangent angle — this keeps the rectangle hugging the same edge
      // the renderRoomOutline draws.
      tangAngleDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    }
    const wPx = w * px_per_m_avg;
    const dPx = Math.max(2, d * px_per_m_avg);
    // Rectangle is laid out centered, long edge along local X (tangent
    // direction), short edge along local Y (into the room). Shift along
    // local +Y so the panel sits INSIDE the room (the wall sits at the
    // anchor point, panel projects inward). Without the half-depth
    // offset the panel straddles the wall line and looks tangential.
    s += `<g class="r2d-treatment ${isSel ? 'selected' : ''} ${isDrag ? 'dragging' : ''}"
            data-treatment-id="${t.id}"
            transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${tangAngleDeg.toFixed(1)})">
            ${isSel ? `<rect x="${(-wPx/2 - 3).toFixed(1)}" y="-${(dPx + 3).toFixed(1)}"
                            width="${(wPx + 6).toFixed(1)}" height="${(dPx + 6).toFixed(1)}"
                            fill="none" stroke="#00d4ff" stroke-width="2" />` : ''}
            <rect x="${(-wPx/2).toFixed(1)}" y="-${dPx.toFixed(1)}"
                  width="${wPx.toFixed(1)}" height="${dPx.toFixed(1)}"
                  fill="#7a89a0" fill-opacity="0.7" stroke="#cfd6df" stroke-width="1.2" />
            ${isDrag ? '' : `<text x="0" y="-${(dPx + 4).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-zone-sub" fill="#cfd6df">${escapeXml(t.label || t.id)}</text>`}
          </g>`;
  }
  return s;
}

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderListenersSVG(listeners, selectedId, x0, y0, pxW, pxD, room, draggingId) {
  let s = '';
  listeners.forEach((lst) => {
    const sx = x0 + (lst.position.x / room.width_m) * pxW;
    const sy = y0 + (lst.position.y / room.depth_m) * pxD;
    const isSel = lst.id === selectedId;
    const isDragging = lst.id === draggingId;
    const radius = isSel ? 10 : 7;
    const fill = isSel ? '#ffd000' : '#4a8ff0';
    const stroke = isSel ? '#ffffff' : '#13161c';
    const strokeW = isSel ? 2.5 : 1.5;
    const transform = `translate(${sx.toFixed(1)},${sy.toFixed(1)})${isDragging ? ' scale(2)' : ''}`;
    const cls = ['r2d-listener']
      .concat(isSel       ? ['r2d-listener-selected'] : [])
      .concat(isDragging  ? ['r2d-listener-dragging'] : [])
      .join(' ');
    s += `<g class="${cls}" data-listener-id="${escapeMenuHtml(lst.id)}" transform="${transform}">`;
    s += `<circle class="r2d-lst-dot" cx="0" cy="0" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" />`;
    if (!isDragging) {
      const lblMatch = String(lst.label).match(/\d+/);
      const short = lblMatch ? lblMatch[0] : String(lst.label).slice(0, 2);
      s += `<text x="0" y="3" text-anchor="middle" class="vp-lbl vp-lbl-listener">${escapeMenuHtml(short)}</text>`;
    }
    s += `</g>`;
  });
  return s;
}

// Render room-corner vertex handles for the click + drag editor.
// Skipped for 'round' rooms (no corners) and when shape is invalid.
//
// Selection highlights:
//   - Selected vertex: bigger cyan ring around the handle
//   - Adjacent vertices (prev / next in the polygon): smaller cyan ring
//   - Adjacent edges (the two edges touching the selected vertex):
//     overlaid cyan stroke so the user sees what they're about to edit
//
// Handle group transform = translate(sx, sy); during drag a `scale(2)`
// is appended for the same "grow into a draggable disk" feedback the
// speakers and listeners use.
function renderVertexHandlesSVG(room, selectedIdx, draggingIdx, x0, y0, pxW, pxD) {
  if (!room) return '';
  if (room.shape === 'round') return '';
  const w = room.width_m, d = room.depth_m;
  if (!(w > 0) || !(d > 0)) return '';

  // Snapshot the current vertices in WORLD coords. Don't mutate state
  // here — conversion to 'custom' only happens on actual drag.
  let verts;
  const cx = w / 2, cy = d / 2;
  if (room.shape === 'polygon') {
    const n = room.polygon_sides ?? 6;
    const r = room.polygon_radius_m ?? 3;
    verts = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n;
      verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  } else if (room.shape === 'custom'
             && Array.isArray(room.custom_vertices)
             && room.custom_vertices.length >= 3) {
    verts = room.custom_vertices.map(v => ({ x: v.x, y: v.y }));
  } else {
    verts = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
  }
  if (verts.length === 0) return '';

  const n = verts.length;
  const toScreen = (v) => ({
    x: x0 + (v.x / w) * pxW,
    y: y0 + (v.y / d) * pxD,
  });

  let s = '';

  // Selected vertex + adjacent vertices info
  let selectedScreen = null, prevScreen = null, nextScreen = null;
  if (typeof selectedIdx === 'number' && selectedIdx >= 0 && selectedIdx < n) {
    selectedScreen = toScreen(verts[selectedIdx]);
    prevScreen = toScreen(verts[(selectedIdx - 1 + n) % n]);
    nextScreen = toScreen(verts[(selectedIdx + 1) % n]);
    // Adjacent-edge overlays — drawn UNDER the handles so the dots sit
    // on top. Cyan stroke 2.5 px so they're visible against the
    // heatmap-warm room outline but don't overpower it.
    s += `<line class="r2d-vertex-edge" x1="${prevScreen.x.toFixed(1)}" y1="${prevScreen.y.toFixed(1)}" x2="${selectedScreen.x.toFixed(1)}" y2="${selectedScreen.y.toFixed(1)}" />`;
    s += `<line class="r2d-vertex-edge" x1="${selectedScreen.x.toFixed(1)}" y1="${selectedScreen.y.toFixed(1)}" x2="${nextScreen.x.toFixed(1)}" y2="${nextScreen.y.toFixed(1)}" />`;
  }

  // While any vertex is being dragged, show world-coord labels beside
  // EVERY vertex so the user can read off the full polygon dimensions
  // live as they reshape. Labels render OUTSIDE the handle groups so
  // they aren't scaled by the dragged group's `scale(2)` transform.
  // Position: top-right of each handle dot, ~12 px offset so it
  // clears the hit-target. The dragged vertex's own label gets a
  // brighter colour so it stands out from the read-only neighbours.
  const showCoordLabels = (draggingIdx >= 0 && draggingIdx < n);
  if (showCoordLabels) {
    for (let i = 0; i < n; i++) {
      const v = verts[i];
      const p = toScreen(v);
      const isDragging = (i === draggingIdx);
      const tx = (p.x + 12).toFixed(1);
      const ty = (p.y - 10).toFixed(1);
      const label = `(${v.x.toFixed(2)}, ${v.y.toFixed(2)})`;
      const cls = isDragging ? 'r2d-vertex-coord r2d-vertex-coord-active' : 'r2d-vertex-coord';
      s += `<text x="${tx}" y="${ty}" class="${cls}">${label}</text>`;
    }
  }

  // Vertex handles
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    const p = toScreen(v);
    const isSel = (i === selectedIdx);
    const isAdj = (selectedScreen != null && !isSel
                   && (i === (selectedIdx - 1 + n) % n || i === (selectedIdx + 1) % n));
    const isDragging = (i === draggingIdx);
    const transform = `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})${isDragging ? ' scale(2)' : ''}`;
    const cls = ['r2d-vertex']
      .concat(isSel       ? ['r2d-vertex-selected']  : [])
      .concat(isAdj       ? ['r2d-vertex-adjacent']  : [])
      .concat(isDragging  ? ['r2d-vertex-dragging']  : [])
      .join(' ');
    s += `<g class="${cls}" data-vertex-idx="${i}" transform="${transform}">`;
    // Hit-target — invisible larger circle so users don't have to be
    // pixel-perfect on the visible 5 px dot. ~12 px radius.
    s += `<circle class="r2d-vertex-hit" cx="0" cy="0" r="12" />`;
    // Visible handle.
    s += `<circle class="r2d-vertex-dot" cx="0" cy="0" r="${isSel ? 6 : 5}" />`;
    s += `</g>`;
  }
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
    const minorTicks = computeMinorTicks(minVal, maxVal, 'spl', ticks);
    const minorRows = minorTicks.map(t => {
      const pct = Math.max(0, Math.min(100, (1 - t.position01) * 100)).toFixed(2);
      return `<div class="spl-legend-tick minor" style="top:${pct}%">
        <span class="spl-legend-tick-line"></span>
      </div>`;
    }).join('');
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
        <div class="spl-legend-ticks">${minorRows}${tickRows}</div>
      </div>
      <span class="legend-footnote">re 20 µPa</span>
    </div>`;
  }
  return `<div class="vp-legend">
    ${COLOR_BANDS.map(b => `<span class="legend-item"><span class="swatch" style="background:${b.color}"></span>${b.label}</span>`).join('')}
  </div>`;
}
