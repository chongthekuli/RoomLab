import { state, earHeightFor, getSelectedListener, colorForZone, colorForGroup, expandSources, expandLineArrayToElements, duplicateSource, duplicateListener, duplicateFurniture, duplicateRack, duplicateStructure, rotateRack, convertRoomToCustomPolygon } from '../app-state.js';
import { openPanel } from '../ui/rail-system.js';
import { projectOntoWall } from '../ui/panel-treatments.js';
import { getFurnitureCatalogue } from '../labs/furniturelab/catalog.js';
import { getRackCatalogue } from '../labs/devicelab/catalog.js';
import { getStructureMaterialCatalogue } from '../physics/providers.js';
import { structureFootprintCorners, structureFootprintCircle, toiletPlanSegments } from '../physics/building-structures.js';
import { lowFreqCaption } from '../physics/modal-field.js';
import { makeStructure } from '../ui/panel-structure.js';
import { colorForReliability, reliabilityLegendRows } from '../labs/furniturelab/reliability-colors.js';
import { computeAllBands, preferredRT60 } from '../physics/rt60.js';
import { computeRoomConstant } from '../physics/spl-calculator.js';
import { on, emit } from '../ui/events.js';
import { commitCapturedRoom } from '../capture/capture-flow.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { computeSPLGrid } from '../physics/spl-calculator.js';
import { roomPlanVertices, isInsideRoom3D, roomEffectiveBounds } from '../physics/room-shape.js';
import { dilateGridForDisplay } from '../physics/grid-display.js';
import { colorForMetric } from './colour-ramps.js';
import { computeTicks, computeMinorTicks, formatTickLabel, legendHeader, getRampDomain, formatDataBracket, dataBracketPosition } from './legend-ticks.js';
import { computePerListenerMetrics, formatListenerMetricsLabel } from '../physics/per-listener-metrics.js';
import { wallInsetPolygon, wallLabelAnchor, WALL_LABEL_MAX_CHARS } from '../physics/wall-inset.js';
import { getMaterialHatchKind } from '../labs/walllab/material-family-hatch.js';
import { renderRackFootprintSVG, lookupRackDef } from './rack-2d.js';
import { insertMidpointNode, deleteNode, fixSelectionAfterDelete } from './polygon-node-edit.js';

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

// SPL/STI cell fill — delegates to the SHARED ramp in colour-ramps.js so the
// on-screen 2D heatmap, the 3D viewport, and the printed PDF all map the same
// value to the same colour. Previously a PRIVATE ramp here used divergent hex
// stops (#1a1a4a/#0066cc/…), so the on-screen field disagreed with BOTH the
// legend bar (already on the shared #1428b4/… stops) and the PDF the client
// received. Keep this a thin wrapper — no colour literals here. Guarded by
// tests/cross-surface-conventions.test.mjs (assertHeatmapRampParity).
function splFill(value, metric) {
  const [r, g, b] = colorForMetric(value, metric ?? 'spl');
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

// --- Pointer-based vertex placement (replaces the fragile native `click`) ---
// Why: draw mode rebuilds the entire <svg> via innerHTML on every mousemove
// (handleDrawMove → render → renderCustomDraw). A physical mouse emits a tiny
// `mousemove` between mousedown and mouseup; that move fires render(), which
// swaps out the <svg>. The native `click` event only fires when mousedown and
// mouseup land on the SAME element, so the swap suppresses the click and the
// vertex is never placed. Touch taps emit no intervening hover-move, so the
// synthesized click always lands — which is exactly why phone tap is reliable
// and fast desktop mouse is flaky. We therefore place on pointerdown→pointerup
// (with a drag threshold to distinguish a click from a pan-drag) and compute
// coords from the pointerUP event, so it does not matter that the <svg> was
// rebuilt mid-interaction.
const DRAW_DRAG_THRESHOLD_PX = 5;     // pointer travel under this = a click, not a drag
const DRAW_DBLCLICK_WINDOW_MS = 400;  // placements within this of a dblclick are undone
let drawPointerDown = null;           // { x, y, id } captured on pointerdown, or null
// Timestamps (performance.now) of vertices placed by pointerup, oldest→newest.
// On dblclick we pop any vertex whose placement falls inside the dblclick
// window so a double-click-to-finish does not leave 1–2 stray vertices behind.
let drawPlaceStamps = [];

// Pure decision helper (exported for tests): given the pointerdown client
// position, the pointerup client position, and whether a pan is/was active,
// decide whether this pointer interaction should place a vertex. A vertex is
// placed only when no pan was involved AND the pointer travelled less than the
// drag threshold (i.e. it was a click, not a drag). Distance is Euclidean.
export function shouldPlaceVertexOnPointerUp(down, up, panWasActive, threshold = DRAW_DRAG_THRESHOLD_PX) {
  if (panWasActive) return false;
  if (!down || !up) return false;
  const dx = up.clientX - down.x;
  const dy = up.clientY - down.y;
  return Math.sqrt(dx * dx + dy * dy) < threshold;
}

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
// Halo (m) added around the drag-start position when it sits OUTSIDE
// the room's natural clamp bounds. Without this, an item placed at a
// negative coordinate (via panel input, preset import, or a previous
// drag while the room was a different shape) gets snapped to the room
// edge on the very first click — the user can never drag it further
// out, only back in. The halo lets the drag extend outward from start.
// Re-applied on every move tick: dragging from (-2, 0) to (-1, 0)
// re-anchors start at -1; next drag floor is min(0, -1-5) = -6, etc.
// 5 m matches the surau podium extension that the legacy fix used.
const DRAG_OUTSIDE_HALO_M = 5;

// Pure clamp helper for 2D drag of point pickables (sources, listeners,
// treatments). Bidirectional — clamps both floor and ceiling. When the
// drag-start position sits outside the room's effective bounds, the
// clamp expands to include start ± DRAG_OUTSIDE_HALO_M so the user can
// reposition items that were previously placed in negative-quadrant or
// far-positive space without the first click teleporting them inside.
//
// Pure on its inputs. Exported for tests/room-2d-negative-drag.test.mjs.
export function clampDragTargetToBounds({ targetX, targetY, startX, startY, bounds, margin = 0, halo = DRAG_OUTSIDE_HALO_M }) {
  const normalMinX = bounds.minX + margin;
  const normalMaxX = bounds.maxX - margin;
  const normalMinY = bounds.minY + margin;
  const normalMaxY = bounds.maxY - margin;
  // Only expand when start is outside the normal clamp — preserves
  // in-room margin behaviour for items that were never outside.
  const minX = (startX < normalMinX) ? Math.min(normalMinX, startX - halo) : normalMinX;
  const maxX = (startX > normalMaxX) ? Math.max(normalMaxX, startX + halo) : normalMaxX;
  const minY = (startY < normalMinY) ? Math.min(normalMinY, startY - halo) : normalMinY;
  const maxY = (startY > normalMaxY) ? Math.max(normalMaxY, startY + halo) : normalMaxY;
  return {
    x: Math.max(minX, Math.min(maxX, targetX)),
    y: Math.max(minY, Math.min(maxY, targetY)),
  };
}

// Pure clamp helper for 2D drag of room vertices. Vertices are NOT
// clamped — the user is reshaping the footprint and may legitimately
// drag a corner into negative coordinate space (e.g. extending the
// room west/south past the origin).
//
// 2026-06-04: removed the old floor-at-0. The justifying comment ("the
// heatmap grid and SVG coord mapping only cover the positive quadrant")
// was STALE — both currentRoomGeom() and computeSPLGrid() now derive
// their extent from roomEffectiveBounds() (true vertex min/max, the
// same path that renders the surau podium at world x=-3.5), so negative
// vertices render and sample correctly. The floor was the only thing
// preventing it. recomputeRoomDimsFromPolygon() (below) now tracks the
// true bbox so width_m/depth_m stay correct when a vertex goes negative.
// Validated GO by Viktor (render paths) + Dr. Chen (RT60 volume is
// shoelace polygon area, translation-invariant). Signature kept stable
// (startX/startY/halo unused) for the call site + tests that import it.
// Exported for tests/room-2d-negative-drag.test.mjs.
export function clampVertexDragTarget({ targetX, targetY, startX, startY, halo = DRAG_OUTSIDE_HALO_M }) {
  return { x: targetX, y: targetY };
}
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
  console.info('[room-2d] build 2026-06-07 v770 — pointerup vertex placement (fixes lost-click on fast desktop mouse)');
  drawActive = true;
  resetDrawPointerState();
  installWindowKeyHandler();
  drawConfig = {
    mode: 'room-shape',
    label: 'Draw custom room shape',
    onFinish: (verts) => {
      // Single commit path — capture-flow.commitCapturedRoom is the ONE writer
      // of captured/drawn geometry (manual sketch + future photo/IMU/WebXR all
      // funnel through it). It does the vertex[0]=(0,0) origin shift, bbox
      // width_m/depth_m, per-edge wall material, self-intersection guard, and
      // emits scene:reset (whole geometry arrays replaced) + room:changed.
      // Manual draw is born in real metres → scaleResolved=true. finishDraw
      // skips its own trailing room:changed for room-shape (commit emitted it).
      commitCapturedRoom({ vertices: verts, scaleResolved: true, provenance: 'manual' });
    },
  };
  drawVertices = [];
  drawCursor = null;
  render();
}

export function startDrawZone(opts = {}) {
  drawActive = true;
  resetDrawPointerState();
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
  resetDrawPointerState();
  stopEdgePan();
  destroyFloatCoordEl();
  removeWindowKeyHandler();
  cfg.onFinish(verts);
  // room-shape commits via commitCapturedRoom which already emits
  // scene:reset + room:changed; other modes (zone, …) emit here.
  if (!wasRoomShape) emit('room:changed');
  // After auto-close, prompt for room height directly on the canvas
  // (centered modal-style overlay). User types a number + Enter and
  // the height is set on state.room.height_m without them having to
  // hunt for the height input in the side panel. Esc skips (keeps
  // whatever the previous height was).
  if (wasRoomShape) {
    document.dispatchEvent(new CustomEvent('roomshape:closed'));
    showHeightPrompt();
  }
}

// ---------------------------------------------------------------------
// Centered height prompt — shown after a custom room is closed so the
// user can set the room ceiling height with one keystroke. Lives on
// #viewport so it survives any subsequent re-render. Esc cancels (keeps
// the current state.room.height_m), Enter commits.
// ---------------------------------------------------------------------
function showHeightPrompt() {
  const host = document.getElementById('viewport') || document.getElementById('view-2d');
  if (!host) return;
  // If a previous prompt is still mounted (user closed two rooms in
  // quick succession), tear it down before mounting a fresh one.
  const existing = document.getElementById('draw-height-prompt');
  if (existing) existing.remove();
  const current = Number.isFinite(state.room?.height_m) ? state.room.height_m : 3;
  const el = document.createElement('div');
  el.id = 'draw-height-prompt';
  el.className = 'draw-height-prompt';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Room height');
  el.innerHTML = `
    <div class="draw-height-prompt-title">Room height</div>
    <div class="draw-height-prompt-row">
      <input id="draw-height-input" type="text" inputmode="decimal"
             autocomplete="off" spellcheck="false" maxlength="6"
             value="${current.toFixed(2)}" aria-label="Ceiling height in metres" />
      <span class="draw-height-prompt-unit">m</span>
    </div>
    <div class="draw-height-prompt-hint">
      <kbd>Enter</kbd> set height
      <span class="draw-height-prompt-sep">·</span>
      <kbd>Esc</kbd> skip
    </div>
  `;
  host.appendChild(el);
  const input = el.querySelector('#draw-height-input');
  const dismiss = () => { el.remove(); };
  const commit = () => {
    const raw = (input.value || '').trim();
    const val = parseFloat(raw);
    if (!Number.isFinite(val) || val <= 0 || val > 100) {
      input.classList.add('draw-height-prompt-err');
      setTimeout(() => input.classList.remove('draw-height-prompt-err'), 400);
      return;
    }
    state.room.height_m = val;
    emit('room:changed');
    dismiss();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
    else if (e.key.length === 1 && !/^[0-9.]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      // Numeric only (digits + decimal). Block letters.
      e.preventDefault();
    }
  });
  // Select-all on focus so a single keystroke replaces the default.
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

// Clear the pointer-placement bookkeeping (the in-flight pointerdown snapshot
// and the dblclick-undo placement stamps). Called whenever the vertex list is
// wholesale reset so stale stamps can never mis-trigger a dblclick undo.
function resetDrawPointerState() {
  drawPointerDown = null;
  drawPlaceStamps = [];
}

function cancelDraw() {
  drawActive = false;
  drawConfig = null;
  drawVertices = [];
  drawCursor = null;
  resetDrawPointerState();
  stopEdgePan();
  destroyFloatCoordEl();
  removeWindowKeyHandler();
  render();
}

function undoDrawVertex() {
  drawVertices.pop();
  // Keep the placement-stamp stack from outgrowing the vertex list so a later
  // dblclick can't undo a vertex the user already removed. Stamps are a pure
  // time-window heuristic, so dropping the newest one on any undo is safe.
  drawPlaceStamps.pop();
  render();
}

// Place (or close-loop) from an event whose currentTarget is the LIVE svg.
// Shared by the pointerup placement path. Records a placement timestamp so a
// trailing dblclick can undo stray vertices. Returns nothing.
function placeVertexFromEvent(event) {
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
  drawPlaceStamps.push(performance.now());
  // A mouse-placed vertex is the most recent intent — clear any half-
  // typed values in the floating panel so the next field shows blank
  // (ready to accept the next coord). The render() below re-uses the
  // existing panel; this just zeroes its inputs first.
  clearFloatCoordFields();
  render();
}

// Pointerdown on the canvas — record the start position so pointerup can tell
// a click (place) from a drag (pan). Pan-start (middle / Space+left) is
// handled separately by handleDrawPanStart, also bound to pointerdown; this
// handler only snapshots the position and ignores the pan buttons so a
// pan-drag never leaves a stale "down" that a later stray pointerup could
// misread as a click.
function handleDrawPlacePointerDown(event) {
  if (!drawActive) return;
  // Middle-button or Space+left is a pan, not a placement intent.
  if (event.button === 1 || (event.button === 0 && spaceHeld)) {
    drawPointerDown = null;
    return;
  }
  // Only the primary (left) button places.
  if (event.button !== 0) { drawPointerDown = null; return; }
  drawPointerDown = { x: event.clientX, y: event.clientY, id: event.pointerId };
}

// Pointerup on the canvas — place a vertex iff this was a click (not a pan,
// not a drag past the threshold). Coords come from THIS event, whose
// currentTarget is the live (possibly just-rebuilt) svg, so the mid-tap
// innerHTML swap that breaks the native `click` no longer matters.
function handleDrawPlacePointerUp(event) {
  if (!drawActive) return;
  const down = drawPointerDown;
  drawPointerDown = null;
  // panActive captures both manual pan (handleDrawPanStart set it) and the
  // mid-pan-release case the old click guard protected against.
  if (!shouldPlaceVertexOnPointerUp(
        down,
        { clientX: event.clientX, clientY: event.clientY },
        panActive)) {
    return;
  }
  placeVertexFromEvent(event);
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
  // Pointer-based placement means each click of a double-click already pushed
  // a vertex via pointerup (sequence: down,up,place, down,up,place, dblclick).
  // Undo any vertex placed inside the dblclick window so a double-click-to-
  // finish does not leave 1–2 stray points behind. We only pop placement-
  // stamped vertices (typed/floating-panel vertices don't stamp), and never
  // below zero.
  const now = performance.now();
  while (drawPlaceStamps.length
         && (now - drawPlaceStamps[drawPlaceStamps.length - 1]) <= DRAW_DBLCLICK_WINDOW_MS
         && drawVertices.length > 0) {
    drawPlaceStamps.pop();
    drawVertices.pop();
  }
  // Maya §4: double-click on empty canvas resets pan (when no vertices
  // placed yet). Otherwise double-click finishes the draw.
  if (drawVertices.length === 0) {
    drawPan.dx = 0; drawPan.dy = 0;
    render();
    return;
  }
  if (drawVertices.length < 3) {
    // Too few points to close after stripping the dblclick's own placements —
    // just re-render so the stripped vertices disappear; don't finish.
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
    // Y-flip inverse: world ry = (y0_pixel - sy) / scale. y0_pixel is
    // (CUSTOM_ORIGIN.y + drawPan.dy) since that's the SVG pixel where
    // world-Y=0 lands. Cursor BELOW origin (larger sy) → ry negative.
    const ry = (CUSTOM_ORIGIN.y + drawPan.dy - sy) / CUSTOM_SCALE;
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
    const snap = (v) => Math.round(v / SNAP_M) * SNAP_M;
    return { sx, sy, rx: snap(rx), ry: snap(ry) };
  }
  // zone mode: use current room scale, with the same Y-flip as
  // clientToWorldXY so a click on the canvas reads its world coords in
  // math convention (screen-up = +Y).
  const geom = currentRoomGeom();
  const rx = (sx - geom.x0) / geom.scale;
  const ry = (geom.y0 - sy) / geom.scale;
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
  // Y-axis math convention (v=458, Lindqvist) — world-Y=0 renders at
  // SCREEN-BOTTOM, world-Y=depth_m renders at SCREEN-TOP. Every screen-Y
  // call site now uses `y0 - worldY * scale` (was `y0 + worldY * scale`).
  // y0 is the screen pixel where world-Y=0 lands (bottom edge of the
  // effective bounds). To put bounds.maxY at the TOP of the canvas band:
  //   y_top_canvas = (vbH - pxTotalD) / 2
  //   y0 - bounds.maxY * scale = y_top_canvas
  //   y0 = y_top_canvas + bounds.maxY * scale
  const y0 = (vbH - pxTotalD) / 2 + bounds.maxY * scale;
  return { scale, pxW, pxD, x0, y0, bounds };
}

// OUTDOOR field bounds — a SQUARE of side state.outdoor.field_size_m centred
// on the room's effective centre, in STATE coords. This MUST byte-match the
// 3D path's _outdoorFieldBounds (scene.js ~3633): same clamp [50,1000], same
// roomEffectiveBounds centre, same fallback. Parity is mandatory — the two
// viewports sample the identical field square so the heatmap reads the same
// in 2D and 3D (Sam owns the cross-surface fixture). No X negation here:
// these are state coords; the 2D Y-flip is applied downstream by x0/y0/scale.
function outdoorFieldBounds() {
  const room = state.room || {};
  let b = null;
  try { b = roomEffectiveBounds(room); } catch (_) { b = null; }
  let cx, cy;
  if (b && Number.isFinite(b.minX) && Number.isFinite(b.maxX) && b.maxX > b.minX) {
    cx = (b.minX + b.maxX) / 2;
    cy = (b.minY + b.maxY) / 2;
  } else {
    cx = (room.width_m ?? 10) / 2;
    cy = (room.depth_m ?? 10) / 2;
  }
  const span = Math.max(50, Math.min(1000, state.outdoor?.field_size_m ?? 400));
  const half = span / 2;
  return { minX: cx - half, minY: cy - half, maxX: cx + half, maxY: cy + half };
}

// Geometry for OUTDOOR mode: fit the SVG viewBox band to the FIELD square
// (fb) instead of the room footprint, while keeping pxW / pxD pinned to the
// ROOM's metre dimensions so EVERY existing world→screen call site
// (renderHeatmapSVG, renderOneSpeakerSymbol, renderListenersSVG,
// renderRoomOutline, …) keeps working unchanged. Those sites all derive
// their per-metre scale as `pxW / room.width_m` (== `scale`), so as long as
// pxW = width_m * scale and pxD = depth_m * scale, a world coord anywhere in
// the field (incl. negative / past-the-walls) lands at the right pixel via
// `x0 + worldX * scale`. x0/y0 absorb the field offset so the room renders at
// its correct position inside the larger frame. Same Y-flip convention as
// currentRoomGeom (world-Y=0 → screen-bottom).
function currentFieldGeom(fb) {
  const { width_m: w, depth_m: d } = state.room;
  const totW = Math.max(1e-3, fb.maxX - fb.minX);
  const totD = Math.max(1e-3, fb.maxY - fb.minY);
  const vbW = 800, vbH = 500, pad = 90;
  const scale = Math.min((vbW - pad * 2) / totW, (vbH - pad * 2) / totD);
  const pxW = w * scale;
  const pxD = d * scale;
  const pxTotalW = totW * scale;
  const pxTotalD = totD * scale;
  const x0 = (vbW - pxTotalW) / 2 - fb.minX * scale;
  const y0 = (vbH - pxTotalD) / 2 + fb.maxY * scale;
  return { scale, pxW, pxD, x0, y0, bounds: fb };
}

// Icon / label scale factor for the 2D viewport (v=680).
// All icon and label sizes in the renderers below were originally tuned
// for an INDOOR fit (~50 px/m). When outdoor mode is enabled the viewBox
// fits a 50–1000 m field square into the same 800×500 SVG, so
// geom.scale drops to ~1–13 px/m and the speaker triangles / listener
// dots / FRONT-BACK labels become hugely oversized relative to the
// visible room — they overlap, cover the heatmap, and crowd each other.
//
// Two clamps (Maya recommendation):
//   • icons (triangles, dots, footprint label offsets) floor at 0.40
//   • text font-sizes floor at 0.50 (5 px reads as noise below that)
// Both ceiling at 1.0 so very small rooms don't get oversized icons.
function vp2dIconScale(geom) {
  const REF_PX_PER_M = 50;   // typical indoor fit
  return Math.max(0.40, Math.min(1.0, geom.scale / REF_PX_PER_M));
}
function vp2dLabelScale(geom) {
  const REF_PX_PER_M = 50;
  return Math.max(0.50, Math.min(1.0, geom.scale / REF_PX_PER_M));
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
  on('furniture:changed', render);
  on('furniture:selected', render);
  on('furniture-confidence:changed', render);
  on('treatment:selected', render);
  on('rack:changed', render);
  on('structure:changed', render);
  on('structure:selected', render);
  on('scene:reset', render);
  // OUTDOOR SIMULATION MODE (Phase 3b) — the UI panel mutates
  // state.outdoor.{enabled,field_size_m,temperature_C,humidity_pct} then emits
  // 'outdoor:changed'. Like the 3D handler (scene.js), we read STATE, not the
  // payload. Toggling on widens the viewBox to the field square; toggling off
  // (or scene:reset, which app-state resets outdoor → off) returns to the
  // room-fit framing. Reset the wheel-zoom so the new extent shows at default
  // scale — otherwise a zoomed-in room view stays cropped when the field
  // suddenly spans up to 1000 m.
  on('outdoor:changed', () => { resetView2dZoom(); render(); });
  // STI labels next to each listener come out of state.results.precision —
  // re-render when the precision engine completes so the value appears
  // immediately instead of waiting for the next scene mutation.
  on('precision:changed', render);
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
    // Y-flip: world +Y now maps to SVG -Y (screen up). Vertex v0's
    // pixel-Y is y0 minus its world-Y times scale.
    const oy = y0 - v0.y * CUSTOM_SCALE;
    // Tick world-x = v0.x + m for each integer m in the visible range.
    const minXm = -x0 / CUSTOM_SCALE;
    const maxXm = (CUSTOM_VB_W - x0) / CUSTOM_SCALE;
    // Visible world-Y range, given the inverse `ry = (y0 - sy)/scale`.
    // sy=0 (top of canvas) → ry = y0/scale (maxYm).
    // sy=CUSTOM_VB_H (bottom) → ry = (y0 - CUSTOM_VB_H)/scale (minYm).
    const minYm = (y0 - CUSTOM_VB_H) / CUSTOM_SCALE;
    const maxYm = y0 / CUSTOM_SCALE;
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
      // With math-convention rendering (y0 - worldY*scale), a label at
      // world delta +5 m from v0 already renders 5 m ABOVE the origin
      // line — so the label text matches the delta directly.
      svg += `<text x="6" y="${y0 - worldY * CUSTOM_SCALE + 3}" fill="#5a6677" font-size="9">${m} m</text>`;
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

  // Zone-draw mode: walls render with thickness so the user has a
  // proper room boundary to draw zone vertices against, but we OMIT
  // the per-wall material labels — they'd compete for attention with
  // the zone-drawing crosshair and snap markers.
  let svg = `<svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMid meet">`;
  svg += `<defs>${clipPathSvg}${WALL_HATCH_DEFS_2D}</defs>`;
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
  // Y-flip throughout: world +Y → SVG -Y. Every vertex/cursor world-Y
  // becomes `y0 - worldY * scale` in pixel space.
  // Edges between placed vertices
  for (let i = 0; i < drawVertices.length - 1; i++) {
    const a = drawVertices[i], b = drawVertices[i + 1];
    s += `<line x1="${x0 + a.x * scale}" y1="${y0 - a.y * scale}" x2="${x0 + b.x * scale}" y2="${y0 - b.y * scale}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`;
  }
  if (drawVertices.length > 0 && drawCursor) {
    const last = drawVertices[drawVertices.length - 1];
    // Rubber-band line tracks the SNAPPED grid intersection, not the
    // raw cursor pixel — same visual feedback the user gets after
    // committing a vertex. Was using sx/sy directly, which made the
    // line lag/lead the snap by up to 10 px.
    let endX = x0 + drawCursor.rx * scale;
    let endY = y0 - drawCursor.ry * scale;
    if (drawCursorNearStart && drawVertices.length >= 3) {
      const first = drawVertices[0];
      endX = x0 + first.x * scale;
      endY = y0 - first.y * scale;
    }
    const startX = x0 + last.x * scale;
    const startY = y0 - last.y * scale;
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
      s += `<line x1="${endX}" y1="${endY}" x2="${x0 + first.x * scale}" y2="${y0 - first.y * scale}" stroke="${color}" stroke-width="${widthPx}" stroke-dasharray="${dash}" opacity="${opacity}"/>`;
    }
  }
  // Vertex 1 grows + highlights when cursor is near; other vertices stay regular
  drawVertices.forEach((v, i) => {
    const sx = x0 + v.x * scale, sy = y0 - v.y * scale;
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
    const cy = y0 - drawCursor.ry * scale;
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
      // Storage already in math convention (drawCoordsFromEvent inverts
      // sy → ry with `y0 - sy`), so a cursor 3 m ABOVE v0 has
      // drawCursor.ry = v0.y + 3 → relY = +3. Direct subtract.
      const v0 = drawVertices[0];
      const relX = drawCursor.rx - v0.x;
      const relY = drawCursor.ry - v0.y;
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
  // Vertex placement is on pointerdown→pointerup, NOT the native `click`.
  // The native click only fires when mousedown and mouseup land on the same
  // element; draw mode rebuilds the <svg> on every mousemove, so a fast
  // physical mouse (which emits a stray move between button-down and -up)
  // swaps the element out and the click is lost. Touch taps emit no hover
  // move, so click survives there — which is why phone was reliable and fast
  // desktop mouse flaky. pointerup computes coords from its OWN event (live
  // svg), so the mid-tap rebuild no longer matters. See
  // shouldPlaceVertexOnPointerUp + handleDrawPlacePointerUp.
  svgEl.addEventListener('mousemove', handleDrawMove);
  svgEl.addEventListener('dblclick', handleDrawDblClick);
  // mouseleave halts edge auto-pan when the cursor exits the canvas
  // (otherwise the RAF loop keeps panning indefinitely on stale
  // coordinates). It's also the right semantic: no cursor in the
  // band → no edge-pan.
  svgEl.addEventListener('mouseleave', stopEdgePan);
  // Pan: middle-button or Space + left-button. Middle-button still
  // gets clicked through, so guard in handleDrawPanStart.
  // ORDER MATTERS: on pointerdown, pan-start must set panActive BEFORE the
  // placement handler snapshots the down-position (placement bails on
  // pan buttons). On pointerup, placement must read panActive BEFORE pan-end
  // clears it — otherwise a pan-release would slip past the guard and drop a
  // vertex. So: panStart, placeDown on pointerdown; placeUp, panEnd on pointerup.
  svgEl.addEventListener('pointerdown', handleDrawPanStart);
  svgEl.addEventListener('pointerdown', handleDrawPlacePointerDown);
  svgEl.addEventListener('pointerup', handleDrawPlacePointerUp);
  svgEl.addEventListener('pointerup', handleDrawPanEnd);
  svgEl.addEventListener('pointercancel', handleDrawPanEnd);
  svgEl.addEventListener('pointercancel', () => { drawPointerDown = null; });
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
  // The whole 2D plan now renders in math convention (world +Y = screen
  // up). Typed dy=+3 ("3 m up on screen") translates directly to storage
  // delta +3 — the renderer's flip puts it 3 m above origin pixelwise.
  drawVertices.push({ x: v0.x + dx, y: v0.y + dy });
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

  // OUTDOOR SIMULATION MODE (Phase 3b) — when state.outdoor.enabled, fit the
  // viewBox to the FIELD square (currentFieldGeom) and sample computeSPLGrid
  // over the same square the 3D path uses. Indoor: room-fit geom, unchanged.
  const outdoorOn = !!(state.outdoor && state.outdoor.enabled);
  const fieldBounds = outdoorOn ? outdoorFieldBounds() : null;
  const geom = outdoorOn ? currentFieldGeom(fieldBounds) : currentRoomGeom();
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
      // Material-aware wall TL — must match the 3D path (scene.js
      // currentPhysicsOpts). Omitting this fell back to the legacy flat
      // 30 dB, leaking ~23 dB too much through walls (e.g. surau azan
      // horn bleeding into the prayer hall). Dr. Chen diagnosis 2026-05-22.
      materials: materialsRef || null,
      roomConstantR: phys.reverberantField && materialsRef
        ? computeRoomConstant(state.room, materialsRef, freq, state.zones, {
            treatments: state.treatments,
            furniture: state.furniture,
            furnitureCatalogue: getFurnitureCatalogue(),
            racks: state.rackSystem?.racks ?? [],
            rackCatalogue: getRackCatalogue(),
            structures: state.structures,
          }) : 0,
      // OUTDOOR pass-through — must match the 3D call site (scene.js ~10605).
      // When outdoorOn is false these revert to computeSPLGrid's defaults
      // (outdoor:false, fieldBounds:null) → the indoor grid is byte-identical.
      // outdoor:true returns ONE continuous grid over fieldBounds: finite free-
      // field SPL outside the walls, room reverb inside. The 25-cell gridSize is
      // legacy; squareCellCounts() inside computeSPLGrid governs actual cell size.
      outdoor: outdoorOn,
      fieldBounds,
      temperature_C: outdoorOn ? (state.outdoor.temperature_C ?? 20) : undefined,
      humidity_pct:  outdoorOn ? (state.outdoor.humidity_pct ?? 70) : undefined,
      // v=679 — placed furniture attenuates the direct field. Bookshelf
      // or rack between source and a grid cell drops SPL via the
      // segment-AABB barrier model in furniture-direct-blocking.js.
      furniture: state.furniture,
      furnitureCatalogue: getFurnitureCatalogue(),
      // v=700 — DeviceLAB racks attenuate the direct field too via
      // rack-direct-blocking.js (segment-AABB barrier-μ on the outer
      // footprint). Same as furniture but rotated by rack.yaw_deg.
      racks: state.rackSystem?.racks ?? [],
      rackCatalogue: getRackCatalogue(),
      // v=756 — building structures (pillars/half-walls/etc.) attenuate the
      // direct field (diffraction + transmission). Matches the 3D grid call
      // so 2D + 3D heatmaps agree. structureMaterials = raw materials.json rows.
      structures: state.structures,
      structureMaterials: getStructureMaterialCatalogue(),
      // v=759 — zones + treatments for the low-frequency modal field RT60.
      zones: state.zones,
      treatments: state.treatments,
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

  // Outdoor mode shrinks geom.scale ~10× — icons/labels need to shrink
  // proportionally or the room becomes unusable (overlap, cramped click
  // targets). Indoor view → both scales ≈ 1.0 → no visible change.
  const iconScale  = vp2dIconScale(geom);
  const labelScale = vp2dLabelScale(geom);

  const roomOutline = renderRoomOutline(state.room, x0, y0, pxW, pxD, alphaOf, nameOf, surfaces, labelScale);
  // Indoor: clip the heatmap to the room polygon (the field stops at the
  // walls). Outdoor: the field extends PAST the walls, so we do NOT clip it —
  // instead we apply a radial alpha feather at the field's OUTER edge (the 2D
  // analogue of heatmap-shader.js's circular falloff) so the square doesn't end
  // in a hard edge. The wall SPL step (interior↔exterior) is NOT feathered —
  // that boundary is correct physics (Dr. Chen). The feather only touches the
  // outermost rim of the field square.
  const clipPathSvg = outdoorOn ? '' : renderClipPath(state.room, x0, y0, pxW, pxD);
  const fieldFeatherDef = outdoorOn ? renderFieldFeatherMask(fieldBounds, geom) : '';

  const zonesSvg = renderZones(state.zones, state.selectedZoneId, x0, y0, pxW, pxD, state.room, false);
  // Render speakers from state.sources DIRECTLY (not the flat-element
  // list) so each rendered group is tagged with its parent-source index
  // for click-to-select and drag-to-move. Line-array elements expand
  // inline and all share the parent index — dragging any element moves
  // the whole array as a unit.
  const selectedSrcIdx = (typeof state.selectedSourceIdx === 'number') ? state.selectedSourceIdx : -1;
  const draggingSrcIdx = (pickableDrag?.kind === 'source' && pickableDrag?.didMove) ? pickableDrag.sourceIdx : -1;
  const speakerSvg = state.sources.length > 0
    ? renderSpeakersSVG(state.sources, x0, y0, pxW, pxD, state.room, selectedSrcIdx, draggingSrcIdx, iconScale)
    : '';
  const draggingListenerId = (pickableDrag?.kind === 'listener' && pickableDrag?.didMove) ? pickableDrag.listenerId : null;
  // Per-listener SPL / STI labels — SPL is the same 1-kHz total the
  // results panel shows; STI shows only after a precision render exists.
  // Both gracefully read null when not available and the label is just
  // omitted.
  const listenerMetrics = state.listeners.length > 0
    ? computePerListenerMetrics(state, materialsRef)
    : [];
  const listenerSvg = state.listeners.length > 0 ? renderListenersSVG(state.listeners, state.selectedListenerId, x0, y0, pxW, pxD, state.room, draggingListenerId, listenerMetrics, iconScale) : '';
  const draggingTreatId = (pickableDrag?.kind === 'treatment' && pickableDrag?.didMove) ? pickableDrag.treatmentId : null;
  const treatmentSvg = (state.treatments && state.treatments.length > 0)
    ? renderTreatmentsSVG(state.treatments, state.selectedTreatmentId, draggingTreatId, x0, y0, pxW, pxD, state.room, labelScale)
    : '';
  const furnitureSvg = (state.furniture && state.furniture.length > 0)
    ? renderFurnitureSVG(state.furniture, state.selectedFurnitureId, x0, y0, pxW, pxD, state.room, labelScale)
    : '';
  const structureSvg = (state.structures && state.structures.length > 0)
    ? renderStructuresSVG(state.structures, state.selectedStructureId, x0, y0, pxW, pxD, state.room, labelScale)
    : '';
  // PA equipment racks — closed-footprint top-down via the shared
  // helper in rack-2d.js (also used by print-plan-svg.js, so the two
  // surfaces cannot drift on origin / front-cue / hinge-cue). Door-open
  // state is 3D-only — 2D always shows the closed rectangle.
  const rackSvg = (Array.isArray(state.rackSystem?.racks) && state.rackSystem.racks.length > 0)
    ? renderRacksSVG(state.rackSystem.racks, state.selectedRackId, x0, y0, pxW, pxD, state.room, labelScale)
    : '';

  // Room-corner vertex handles. Skipped for 'round' rooms (no
  // corners) and when room dims are zero. Shown only after the user
  // is in 2D (where geometry edits make sense).
  const draggingVertexIdx = (pickableDrag?.kind === 'vertex' && pickableDrag?.didMove) ? pickableDrag.vertexIdx : -1;
  const vertexSvg = renderVertexHandlesSVG(state.room, state.selectedVertexIdx, draggingVertexIdx, x0, y0, pxW, pxD);
  const subSvg = renderSubStructures(state.room.subStructures, x0, y0, pxW, pxD, state.room);
  const encSvg = renderStandaloneEnclosures(state.room.standaloneEnclosures, x0, y0, pxW, pxD, state.room);
  const wsegSvg = renderSharedWallSegments(state.room.wallSegments, x0, y0, pxW, pxD, state.room);
  const minaretSvg = renderSurauMinaret(state.room.surauStructure?.minaret, x0, y0, pxW, pxD, state.room);

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

  const fieldSpanLabel = outdoorOn
    ? ` — outdoor field ${Math.round(Math.max(50, Math.min(1000, state.outdoor?.field_size_m ?? 400)))} m`
    : '';
  vp.innerHTML = `
    <div class="viewport-2d">
      <div class="vp-header">Floor plan — top-down${fieldSpanLabel}</div>
      <svg viewBox="0 0 800 500" preserveAspectRatio="xMidYMid meet">
        <defs>${clipPathSvg}${fieldFeatherDef}${WALL_HATCH_DEFS_2D}</defs>
        ${roomOutline.floorFill}
        ${outdoorOn
          ? `<g mask="url(#field-feather-mask)">${splSvg}</g>`
          : `<g clip-path="url(#room-clip)">${splSvg}</g>`}
        ${roomOutline.walls}
        ${roomOutline.labels}
        ${zonesSvg}
        ${subSvg}
        ${encSvg}
        ${wsegSvg}
        ${minaretSvg}
        ${structureSvg}
        ${treatmentSvg}
        ${furnitureSvg}
        ${rackSvg}
        ${renderFurnitureConfidenceLegend(800, 500)}
        <g id="r2d-furniture-ghost-layer"></g>
        ${listenerSvg}
        ${speakerSvg}
        ${vertexSvg}
        ${renderOriginCrosshair(x0, y0, '#5a6677')}
        ${splResult ? '' : `<text x="${x0 + pxW/2}" y="${y0 - pxD/2}" text-anchor="middle" class="vp-lbl vp-lbl-empty">no sources placed</text><text x="${x0 + pxW/2}" y="${y0 - pxD/2 + 18}" text-anchor="middle" class="vp-lbl vp-lbl-empty-hint">add a speaker to compute SPL</text>`}
      </svg>
      <!-- North arrow as HTML overlay — fixed CSS pixel size at the
           top-right of the viewport. Doesn't scale with wheel zoom
           (which mutates the SVG viewBox) and doesn't follow the room
           around the canvas. The arrow always indicates "north = top
           of page" regardless of where the room is rendered. -->
      <div class="vp-north-arrow" aria-hidden="true">
        <svg width="100%" height="100%" viewBox="0 0 12 18">
          <polygon points="6,0 9,6 6,5 3,6" fill="#cfd3d9" stroke="#0a0c10" stroke-width="0.4"/>
        </svg>
        <span>N</span>
      </div>
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
      const sy = y0 - (v.y / room.depth_m) * pxD;
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    }).join(' ');
    s += `<polygon points="${points}" fill="${color}" fill-opacity="${fillOpacity}" stroke="${color}" stroke-width="${isSel ? 3 : 2}" stroke-opacity="${strokeOpacity}" fill-rule="evenodd" />`;
    // Label placement: vertex-average centroid by default, but a non-convex
    // zone (e.g. the surau podium annulus, whose centroid lies INSIDE the
    // building hole at ~(5.9, 6.4) and would put the label text in the
    // middle of the prayer hall) can override via `label_anchor: {x, y}`
    // in the preset zone schema. Coords are state-space metres, same as
    // vertices. Added 2026-05-17 (v475) for the Z_podium annulus.
    const anchor = z.label_anchor;
    const cx = (anchor && Number.isFinite(anchor.x))
      ? anchor.x
      : z.vertices.reduce((a, v) => a + v.x, 0) / z.vertices.length;
    const cy = (anchor && Number.isFinite(anchor.y))
      ? anchor.y
      : z.vertices.reduce((a, v) => a + v.y, 0) / z.vertices.length;
    const scx = x0 + (cx / room.width_m) * pxW;
    const scy = y0 - (cy / room.depth_m) * pxD;
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
// Render the surau minaret as a filled mid-grey square at its outdoor
// corner, with a crescent glyph centred. Plan-view projection is honest
// (the shaft IS a 1.2 m × 1.2 m solid footprint at ground level); fill
// distinguishes it from zone outlines, stroke 1 px darker grey for
// small-zoom legibility. Per Viktor 2026-05-18: scope = minaret only;
// arcade columns / portico get their own design pass.
function renderSurauMinaret(mn, x0, y0, pxW, pxD, room) {
  if (!mn || !(room.width_m > 0) || !(room.depth_m > 0)) return '';
  const baseSize = Number.isFinite(mn.base_size_m) ? mn.base_size_m : 1.2;
  const clearance = 0.6 + baseSize / 2;
  const W = room.width_m, D = room.depth_m;
  const cornerOffsets = {
    SW: { x: -clearance,    y: -clearance    },
    SE: { x: W + clearance, y: -clearance    },
    NW: { x: -clearance,    y: D + clearance },
    NE: { x: W + clearance, y: D + clearance },
  };
  const co = cornerOffsets[mn.corner || 'NW'] || cornerOffsets.NW;
  const half = baseSize / 2;
  const corners = [
    { x: co.x - half, y: co.y - half },
    { x: co.x + half, y: co.y - half },
    { x: co.x + half, y: co.y + half },
    { x: co.x - half, y: co.y + half },
  ];
  const points = corners.map(c => {
    const sx = x0 + (c.x / W) * pxW;
    const sy = y0 - (c.y / D) * pxD;
    return `${sx.toFixed(1)},${sy.toFixed(1)}`;
  }).join(' ');
  // Glyph: crescent (☪ U+262A) for cap_style 'crescent', dome circle for
  // 'dome' / 'mustaka', filled square for 'stepped'. Centred on the
  // footprint, sized to fit inside the square.
  const gx = x0 + (co.x / W) * pxW;
  const gy = y0 - (co.y / D) * pxD;
  const cap = mn.cap_style || 'mustaka';
  const glyph = cap === 'crescent' ? '☪'
              : cap === 'dome' || cap === 'mustaka' ? '◯'
              : '■';
  // Stroke 1 px darker grey; fill mid-grey signals "solid structure" vs
  // zones (translucent colour) and treatments (outline only).
  return `<polygon class="vp-surau-minaret" points="${points}" fill="#9a9a9a" stroke="#666666" stroke-width="1" />`
       + `<text x="${gx.toFixed(1)}" y="${(gy + 4).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-minaret">${glyph}</text>`;
}

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
      const sy = y0 - (ry / parentRoom.depth_m) * pxD;
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    }).join(' ');
    const labelX = x0 + (px / parentRoom.width_m) * pxW;
    const labelY = y0 - (py / parentRoom.depth_m) * pxD;
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
      const sy = y0 - (p.y / parentRoom.depth_m) * pxD;
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    }).join(' ');
    let lcx = 0, lcy = 0;
    for (const p of enc.polygon) { lcx += p.x; lcy += p.y; }
    lcx /= enc.polygon.length; lcy /= enc.polygon.length;
    const labelX = x0 + (lcx / parentRoom.width_m) * pxW;
    const labelY = y0 - (lcy / parentRoom.depth_m) * pxD;
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
    const ay = y0 - (seg.y1 / parentRoom.depth_m) * pxD;
    const bx = x0 + (seg.x2 / parentRoom.width_m) * pxW;
    const by = y0 - (seg.y2 / parentRoom.depth_m) * pxD;
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
    // After Y-flip, the SMALLER world Y (south podium edge at -podiumExt)
    // maps to the LARGER screen Y (bottom of canvas), and vice versa.
    const y1 = (y0 - (-podiumExt) * syPerM).toFixed(1);   // south podium edge → bottom of canvas
    const x2 = (x0 + (w + podiumExt) * sxPerM).toFixed(1);
    const y2 = (y0 - (d + podiumExt) * syPerM).toFixed(1); // north podium edge → top of canvas
    return `<clipPath id="room-clip"><polygon points="${x1},${y1} ${x2},${y1} ${x2},${y2} ${x1},${y2}" /></clipPath>`;
  }
  const verts = roomPlanVertices(room);
  if (verts.length === 0) return '';
  const points = verts.map(v => {
    const sx = x0 + (v.x / room.width_m) * pxW;
    const sy = y0 - (v.y / room.depth_m) * pxD;
    return `${sx.toFixed(1)},${sy.toFixed(1)}`;
  }).join(' ');
  return `<clipPath id="room-clip"><polygon points="${points}" /></clipPath>`;
}

// OUTDOOR radial edge feather — the 2D analogue of heatmap-shader.js's
// circular falloff (FRAG: r = length(uv-0.5)*2; edge = 1 - smoothstep(0.78,1,r)).
// Returns an SVG <mask> whose alpha is 1 (opaque) out to ~78 % of the field's
// half-span then ramps to 0 at the edge midpoint, so the square field reads as
// a soft disc of influence rather than a cropped screenshot. The mask is keyed
// to the FIELD square only — it never touches the interior/wall SPL step (that
// boundary is correct physics, Dr. Chen). Corners of the square (radius > the
// half-side) fall past the gradient's outer stop and are fully transparent,
// exactly as the shader discards r > 1.
//
// SVG gradient r is a fraction of the bounding-box's longest side. We size an
// explicit ellipse covering the field's pixel span and give the gradient an
// objectBoundingBox so the 0.78 / 1.0 stops land at the same normalised radius
// the shader uses. falloffStart MUST match heatmap-shader.js (0.78).
const FIELD_FEATHER_START = 0.78;   // keep in lock-step with heatmap-shader.js falloffStart
function renderFieldFeatherMask(fb, geom) {
  const { scale, x0, y0 } = geom;
  const cxW = (fb.minX + fb.maxX) / 2;
  const cyW = (fb.minY + fb.maxY) / 2;
  const cxPx = x0 + cxW * scale;
  const cyPx = y0 - cyW * scale;            // Y-flip
  const halfPx = ((fb.maxX - fb.minX) / 2) * scale;   // square → X half-span == Y half-span
  // Gradient: white (mask=on) solid to FIELD_FEATHER_START, ramp to black at
  // the edge midpoint. Mask backdrop stays black so anything past the disc is
  // hidden — including the square's corners (distance √2·halfPx > halfPx).
  return `
    <radialGradient id="field-feather-grad" gradientUnits="userSpaceOnUse"
      cx="${cxPx.toFixed(1)}" cy="${cyPx.toFixed(1)}" r="${halfPx.toFixed(1)}"
      fx="${cxPx.toFixed(1)}" fy="${cyPx.toFixed(1)}">
      <stop offset="0" stop-color="#fff"/>
      <stop offset="${FIELD_FEATHER_START}" stop-color="#fff"/>
      <stop offset="1" stop-color="#000"/>
    </radialGradient>
    <mask id="field-feather-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="800" height="500">
      <circle cx="${cxPx.toFixed(1)}" cy="${cyPx.toFixed(1)}" r="${halfPx.toFixed(1)}" fill="url(#field-feather-grad)"/>
    </mask>`;
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
function renderNorthArrowSVG(x0, y0, pxW, pxD) {
  const size = 14;                          // half-height of the arrow
  const cx = x0 + pxW - 10;                 // top-right, just inside the right edge
  // After Y-flip, world-Y=depth_m (the "north / FRONT" wall) lives at
  // screen-Y = y0 - pxD. The arrow sits just ABOVE that wall in the
  // top margin band.
  const cy = y0 - pxD - 18;
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

// --------------------------------------------------------------------
// Wall hatch SVG <pattern> defs — 2D viewport (Maya, Phase 7 Commit 4).
//
// Five families locked by material-family-hatch.js. Patterns are
// MONOCHROME by contract (Sam's anti-leak grep would catch any
// rgb(255,*,*) leakage); the 2D viewport may layer a thin coloured
// outline stroke ON TOP as an absorption accent (kept for parity with
// the previous wall renderer).
//
// patternUnits="userSpaceOnUse" so the hatch period is in viewport
// pixels — independent of the polygon's own size. Print uses the same
// helper but with metric-scale pattern sizes (see print-plan-svg.js).
// --------------------------------------------------------------------
const WALL_HATCH_DEFS_2D = `
  <pattern id="r2d-hatch-solid-dark" width="6" height="6" patternUnits="userSpaceOnUse">
    <rect width="6" height="6" fill="#2a2a2a" />
  </pattern>
  <pattern id="r2d-hatch-diagonal" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="6" height="6" fill="#d8d8d8" />
    <line x1="0" y1="0" x2="0" y2="6" stroke="#3a3a3a" stroke-width="0.9" />
  </pattern>
  <pattern id="r2d-hatch-outline" width="6" height="6" patternUnits="userSpaceOnUse">
    <rect width="6" height="6" fill="#ffffff" fill-opacity="0" />
  </pattern>
  <pattern id="r2d-hatch-openair" width="6" height="6" patternUnits="userSpaceOnUse">
    <rect width="6" height="6" fill="#ffffff" fill-opacity="0" />
  </pattern>
  <pattern id="r2d-hatch-unknown" width="5" height="5" patternUnits="userSpaceOnUse">
    <rect width="5" height="5" fill="#efefef" />
    <circle cx="2.5" cy="2.5" r="0.7" fill="#888888" />
  </pattern>
`;

function r2dHatchFor(kind) {
  switch (kind) {
    case 'solid-dark':     return { fill: 'url(#r2d-hatch-solid-dark)',  draw: true,  outlineStroke: '#1c1c1c' };
    case 'diagonal-hatch': return { fill: 'url(#r2d-hatch-diagonal)',    draw: true,  outlineStroke: '#3a3a3a' };
    case 'outline-only':   return { fill: 'url(#r2d-hatch-outline)',     draw: true,  outlineStroke: '#3a3a3a' };
    case 'open-air':       return { fill: 'url(#r2d-hatch-openair)',     draw: false, outlineStroke: '#bbbbbb' };
    case 'unknown':
    default:               return { fill: 'url(#r2d-hatch-unknown)',     draw: true,  outlineStroke: '#888888' };
  }
}

// --------------------------------------------------------------------
// renderRoomOutline — Phase 7 Commit 4.
//
// Walls render as FILLED RECTANGLES (trapezoids at corners with varying
// thickness) using the family hatch from material-family-hatch.js. The
// outer polygon comes from roomPlanVertices(); the inner polygon comes
// from wallInsetPolygon(), so the corner geometry matches the 3D
// extrusion in scene.js exactly. ALL thickness math is funnelled
// through wall-inset.js — Sam's anti-leak grep enforces no raw
// `thickness_m / 2` etc. in this file.
//
// Returns { floorFill, walls, labels } so the caller (renderNormal) can
// keep its existing layering: floorFill goes under the heatmap clip,
// walls + labels paint on top.
// --------------------------------------------------------------------
function renderRoomOutline(room, x0, y0, pxW, pxD, alphaOf, nameOf, surfaces, labelScale = 1.0) {
  const shape = room.shape ?? 'rectangular';
  const inset = wallInsetPolygon(room);
  const outer = inset.outer || [];
  const inner = inset.inner || [];
  const thicknesses = inset.thicknesses || [];

  // State → screen projection. scale = pxW / room.width_m (and pxD /
  // room.depth_m on the Y axis — both match the speaker/listener
  // renderers above). Y-flip puts state +y at the top of the canvas.
  const sxOf = (xm) => x0 + (xm / room.width_m) * pxW;
  const syOf = (ym) => y0 - (ym / room.depth_m) * pxD;
  const projOuter = outer.map(v => ({ sx: sxOf(v.x), sy: syOf(v.y) }));
  const projInner = inner.map(v => ({ sx: sxOf(v.x), sy: syOf(v.y) }));

  // Inner polygon = room interior face. The floor fill paints the
  // inside of the walls; the heatmap clip (renderClipPath) still uses
  // the OUTER polygon, but the wall trapezoids paint on top of the
  // heatmap's outer ring so the visual result is "heatmap stops at the
  // inner wall face" — exactly what the user expects.
  const innerPointsAttr = projInner.map(p => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ');
  const floorFillColor = colorFor(alphaOf(surfaces.floor));
  const floorFill = projInner.length >= 3
    ? `<polygon points="${innerPointsAttr}" fill="${floorFillColor}" fill-opacity="0.15" />`
    : '';

  // Resolve the materialId for each edge in CCW order. Rectangular has
  // a per-side slot map (matches the CCW edge order locked in
  // wall-inset.js → rectEdgeSlotKey). Custom uses surfaces.edges[i].
  // Polygon / round share surfaces.walls across every edge.
  function edgeMaterialId(i) {
    if (shape === 'rectangular') {
      const key = ['wall_north', 'wall_east', 'wall_south', 'wall_west'][i & 3];
      return matIdOf(surfaces[key]);
    }
    if (shape === 'custom') {
      const edges = surfaces.edges || [];
      return matIdOf(edges[i]);
    }
    return matIdOf(surfaces.walls ?? surfaces.wall_north);
  }

  // Build the wall trapezoids. Edge i runs outer[i] → outer[i+1]; the
  // matching inner segment runs inner[i] → inner[i+1] (winding-aware:
  // we go around the trapezoid as outer[i] → outer[i+1] → inner[i+1] →
  // inner[i] so the polygon is non-self-intersecting). Open-air walls
  // are skipped (no fill, no stroke) — the contractor reads "opening".
  let walls = '';
  let labels = '';
  const n = projOuter.length;
  if (n >= 3 && projInner.length === n) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const A = projOuter[i], B = projOuter[j];
      const C = projInner[j], D = projInner[i];
      const matId = edgeMaterialId(i);
      const kind = getMaterialHatchKind(matId);
      const skin = r2dHatchFor(kind);
      if (!skin.draw) continue;   // open-air: no wall drawn
      const pts = `${A.sx.toFixed(1)},${A.sy.toFixed(1)} ${B.sx.toFixed(1)},${B.sy.toFixed(1)} ${C.sx.toFixed(1)},${C.sy.toFixed(1)} ${D.sx.toFixed(1)},${D.sy.toFixed(1)}`;
      // Absorption-derived accent stroke on the INNER face only — keeps
      // the prior "wall colour = absorption" signal visible without
      // breaking monochrome-safety of the hatch fill. Kind 'unknown'
      // uses its own grey stroke (no absorption claim).
      const accent = kind === 'unknown' ? skin.outlineStroke : colorFor(alphaOf(matId));
      walls += `<polygon points="${pts}" fill="${skin.fill}" stroke="${skin.outlineStroke}" stroke-width="0.6" stroke-linejoin="miter" />`;
      // Inner-face accent line (C → D, the room-side edge of the trap).
      walls += `<line x1="${D.sx.toFixed(1)}" y1="${D.sy.toFixed(1)}" x2="${C.sx.toFixed(1)}" y2="${C.sy.toFixed(1)}" stroke="${accent}" stroke-width="1.6" stroke-linecap="butt" opacity="0.85" />`;

      // Per-wall material label — wallLabelAnchor places it on the
      // INSIDE face, centred on the edge midpoint, offset inward by
      // thickness/2 + 10 mm gap. Truncate to WALL_LABEL_MAX_CHARS.
      // Y-flip: state-frame rotation needs sign-flip for SVG-y-down.
      const stateEdge = { v1: outer[i], v2: outer[j] };
      const tEdge = Number.isFinite(thicknesses[i]) ? thicknesses[i] : 0.10;
      const anchor = wallLabelAnchor(stateEdge, tEdge);
      const labelTxt = String(nameOf(matId) || matId || '').slice(0, WALL_LABEL_MAX_CHARS);
      if (labelTxt) {
        const lsx = sxOf(anchor.x);
        const lsy = syOf(anchor.y);
        // SVG screen-Y is INVERTED vs state-frame Y. A CCW rotation in
        // state-frame becomes CW on screen — negate the angle so the
        // label still tracks the wall direction visually.
        const rot = -anchor.rotation_deg;
        // Per-wall material label scales with labelScale (8 px base × labelScale).
        const wallMatPx = (8 * labelScale).toFixed(1);
        labels += `<text x="${lsx.toFixed(1)}" y="${lsy.toFixed(1)}" transform="rotate(${rot.toFixed(2)} ${lsx.toFixed(1)} ${lsy.toFixed(1)})" text-anchor="middle" class="vp-lbl vp-lbl-wall vp-lbl-wall-mat" style="font-size:${wallMatPx}px">${escapeText2D(labelTxt)}</text>`;
      }
    }
  }

  // Cardinal direction tags for rectangular rooms — unchanged from the
  // pre-Commit-4 layout (Maya v9 audit §2 retained). The wall material
  // name lives on the wall itself now (see labels above), so the
  // direction tags stay as orientation cues for the contractor.
  // Font + offset both scale with labelScale so outdoor mode doesn't
  // crowd the (now small) room with full-size cardinal tags.
  const cardFontPx = (9 * labelScale).toFixed(1);
  const cardOffsetTop    = 14 * labelScale;
  const cardOffsetBottom = 22 * labelScale;
  const cardOffsetSide   = 14 * labelScale;
  if (shape === 'rectangular') {
    const yTop = y0 - pxD, yBottom = y0;
    labels += `
      <text x="${x0 + pxW/2}" y="${(yTop - cardOffsetTop).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-wall" style="font-size:${cardFontPx}px">FRONT</text>
      <text x="${x0 + pxW/2}" y="${(yBottom + cardOffsetBottom).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-wall" style="font-size:${cardFontPx}px">BACK</text>
      <text x="${(x0 + pxW + cardOffsetSide).toFixed(1)}" y="${(yTop + pxD/2) + 4}" text-anchor="start" class="vp-lbl vp-lbl-wall" style="font-size:${cardFontPx}px">RIGHT</text>
      <text x="${(x0 - cardOffsetSide).toFixed(1)}" y="${(yTop + pxD/2) + 4}" text-anchor="end" class="vp-lbl vp-lbl-wall" style="font-size:${cardFontPx}px">LEFT</text>
    `;
  } else if (shape === 'custom') {
    // Per-edge numeric tag — keeps the previous edge-handle UX legible
    // when the user is selecting a custom edge from the room panel.
    // Font scales but the circle radius stays at 8 SVG units so it's
    // still a clickable handle in outdoor view.
    const edgeFontPx = (10 * labelScale).toFixed(1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = projOuter[i], b = projOuter[j];
      const midX = (a.sx + b.sx) / 2, midY = (a.sy + b.sy) / 2;
      labels += `<circle cx="${midX.toFixed(1)}" cy="${midY.toFixed(1)}" r="8" fill="#0e1116" stroke="#888" stroke-width="1" />`;
      labels += `<text x="${midX.toFixed(1)}" y="${(midY + 3).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-edge" style="font-size:${edgeFontPx}px">${i + 1}</text>`;
    }
  } else if (n >= 3) {
    // Polygon / round — single WALLS tag at the top of the outline.
    const centerX = projOuter.reduce((s, p) => s + p.sx, 0) / n;
    const topY = Math.min(...projOuter.map(p => p.sy));
    labels += `<text x="${centerX.toFixed(1)}" y="${(topY - cardOffsetTop).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-wall" style="font-size:${cardFontPx}px">WALLS</text>`;
  }

  return { floorFill, walls, labels };
}

// Minimal text escape for SVG (used by wall material labels). The
// existing print-plan-svg.js carries its own; both stay consistent.
function escapeText2D(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
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
  const { cellsX, cellsY, cellW_m, cellD_m, originX_m, originY_m } = splResult;
  // DISPLAY-ONLY fill — bleed boundary cells one ring so the field reaches
  // the wall instead of leaving a white gap. The room-clip <g> wrapping
  // this output trims any overshoot back to the polygon. splResult.grid
  // (physics, drives metrics + legend) is read, never mutated. See
  // js/physics/grid-display.js and the 2026-05-21 leak/gap fix.
  const grid = dilateGridForDisplay(splResult.grid, cellsX, cellsY);
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
      // After Y-flip: cell at world Y=wym sits at screen-Y=y0-wym*syPerM,
      // but `<rect y="...">` is the TOP-LEFT corner, so subtract a full
      // cell height to anchor the rect's BOTTOM at that line.
      const sy = y0 - wym * syPerM - chPx;
      s += `<rect x="${sx.toFixed(2)}" y="${sy.toFixed(2)}" width="${(cwPx + 0.5).toFixed(2)}" height="${(chPx + 0.5).toFixed(2)}" fill="${splFill(spl, splResult.metric)}" fill-opacity="0.55" />`;
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
function renderSpeakersSVG(sources, x0, y0, pxW, pxD, room, selectedIdx, draggingIdx, iconScale = 1.0) {
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
        s += renderOneSpeakerSymbol(el, i, k, x0, y0, pxW, pxD, room, isSelected, isDragging, `LA${i + 1}-${k + 1}`, iconScale);
      });
    } else if (src && src.position) {
      s += renderOneSpeakerSymbol(src, i, 0, x0, y0, pxW, pxD, room, isSelected, isDragging, `S${i + 1}`, iconScale);
    }
  });
  return s;
}

// Render a single speaker icon as an interactive <g> group. `src` is
// the already-resolved element (point source OR line-array expanded
// element with position + aim + groupId). `parentIdx` is the index in
// state.sources used for click-select / drag. `elemIdx` distinguishes
// line-array elements (0..N-1).
function renderOneSpeakerSymbol(src, parentIdx, elemIdx, x0, y0, pxW, pxD, room, isSelected, isDragging, labelText, iconScale = 1.0) {
  const sx = x0 + (src.position.x / room.width_m) * pxW;
  const sy = y0 - (src.position.y / room.depth_m) * pxD;
  const outside = !isInsideRoom3D(src.position, room);
  const groupColor = src.groupId ? colorForGroup(src.groupId) : null;
  const baseFill = outside ? '#ff5a3c' : (groupColor || '#fff');
  const baseStroke = outside ? '#8a1200' : '#000';
  const yaw_rad = (src.aim?.yaw ?? 0) * Math.PI / 180;
  const size = 13;
  // Y-flip: world +Y now maps to SVG -Y (up on screen). World aim vector
  // is (sin yaw, cos yaw); the SVG-pixel offset is (sin yaw, -cos yaw).
  // Without the negation, yaw=180 (fires toward state -Y, e.g. surau
  // qibla → mihrab) would visually point AWAY from the qibla wall.
  const aimX = Math.sin(yaw_rad), aimY = -Math.cos(yaw_rad);
  const rightX = Math.cos(yaw_rad), rightY = Math.sin(yaw_rad);
  // Vertices are written relative to (0, 0) so the parent <g>'s
  // transform=translate(sx,sy) places them in the viewport AND so a
  // scale(2) appended during drag scales about the icon's centre.
  const tip = { x:  size * aimX,           y:  size * aimY };
  const bl  = { x: -size * 0.5 * aimX - size * 0.6 * rightX, y: -size * 0.5 * aimY - size * 0.6 * rightY };
  const br  = { x: -size * 0.5 * aimX + size * 0.6 * rightX, y: -size * 0.5 * aimY + size * 0.6 * rightY };

  // Apply iconScale to the group so the entire symbol (triangle, rings,
  // dot, label) shrinks together in outdoor mode. Drag scale is RELATIVE
  // and stacks on top so dragging still gives a visible bump even when
  // iconScale is < 1.
  const sclTok = iconScale !== 1.0 ? ` scale(${iconScale.toFixed(3)})` : '';
  const transform = `translate(${sx.toFixed(1)},${sy.toFixed(1)})${sclTok}${isDragging ? ' scale(2)' : ''}`;
  const cls = ['r2d-source']
    .concat(isSelected ? ['r2d-source-selected'] : [])
    .concat(isDragging ? ['r2d-source-dragging'] : [])
    .join(' ');

  let s = `<g class="${cls}" data-source-idx="${parentIdx}" data-elem-idx="${elemIdx}" transform="${transform}">`;

  // Invisible hit-target sized for the cursor, NOT for the visual icon.
  // At small iconScale the visible triangle can be 5–6 SVG units across
  // (Maekawa-thumbsized on a trackpad → rage-quit). Divide by iconScale
  // so the hit shape stays at full size in screen coords regardless of
  // how shrunk the visible glyph is.
  const hitR = 14 / Math.max(0.1, iconScale);
  s += `<circle class="r2d-spk-hit" cx="0" cy="0" r="${hitR.toFixed(1)}" fill="transparent" stroke="none" />`;
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
  // Acoustic-ghost preview — only fires when armed; bails fast otherwise.
  // RAF-throttled so 60+ Hz mousemoves don't redo rt60 math every event.
  svg.addEventListener('mousemove', (e) => {
    if (!state.furnitureArmed) return;
    scheduleFurnitureGhostUpdate(e.clientX, e.clientY);
  });
  svg.addEventListener('mouseleave', clearFurnitureGhost);
  // If the viewport mounts AFTER the user already armed a placement
  // (the more common ordering — FurnitureLAB → click "Place into room"
  // → route to RoomLAB), sync the armed-cursor UI now.
  applyArmedCursorState();
}

// Drop a new furniture instance at `pos` (world metres) referencing
// `catalogueId`. Pushes onto state.furniture, emits scene:reset (the
// canonical "scene contents changed" signal that every subscribed
// panel listens to, including panel-results for RT60 recompute) and
// scrolls the new entry into view in the eventual right-rail listing.
function placeFurnitureAt(catalogueId, pos) {
  if (!Array.isArray(state.furniture)) state.furniture = [];
  const usedIds = new Set(state.furniture.map(f => f.id).filter(Boolean));
  let n = state.furniture.length + 1;
  while (usedIds.has(`F${n}`)) n++;
  state.furniture.push({
    id: `F${n}`,
    catalogueId,
    label: null,        // null → render uses catalogue row's name
    position: { x: pos.x, y: pos.y },
    rotation_deg: 0,
  });
  state.selectedFurnitureId = `F${n}`;
  // Targeted broadcasts: scene.js rebuilds just the furniture group
  // (REBUILD_FURNITURE), panel-results recomputes RT60 (parallel-A
  // term picks up the new chair), room-2d redraws to show the new
  // glyph. scene:reset would also work but rebuilds everything — too
  // heavy for a single-chair placement, and would re-trigger the 3D
  // viewport's "nuclear disposal" pass.
  emit('furniture:changed', { id: state.selectedFurnitureId });
  emit('furniture:selected', { id: state.selectedFurnitureId });
}

// Place a default building structure of `type` at world {x,y}, select it,
// and broadcast. Mirrors placeFurnitureAt; the default factory lives in
// panel-structure.js (makeStructure) so the panel + the click-placement path
// agree on every default field.
function placeStructureAt(type, pos) {
  if (!Array.isArray(state.structures)) state.structures = [];
  const st = makeStructure(type, snapToGrid(pos.x), snapToGrid(pos.y));
  state.structures.push(st);
  state.selectedStructureId = st.id;
  emit('structure:changed', { id: st.id });
  emit('structure:selected', { id: st.id });
}

// Reflect state.furnitureArmed / state.structureArmed onto the viewport DOM —
// crosshair cursor + a floating hint over the floor plan. Called at viewport
// mount and on arm/cancel events.
function applyArmedCursorState() {
  const vp = document.querySelector('#view-2d');
  if (!vp) return;
  const furnArmed = state.furnitureArmed && typeof state.furnitureArmed.catalogueId === 'string';
  const structArmed = state.structureArmed && typeof state.structureArmed.type === 'string';
  const armed = furnArmed || structArmed;
  vp.classList.toggle('r2d-armed', armed);
  vp.querySelector('.r2d-armed-hint')?.remove();
  if (furnArmed) {
    const catalogue = getFurnitureCatalogue();
    const row = catalogue.get(state.furnitureArmed.catalogueId);
    const name = row?.name || state.furnitureArmed.catalogueId;
    const hint = document.createElement('div');
    hint.className = 'r2d-armed-hint';
    hint.textContent = `Click in the room to place “${name}”  ·  ESC to cancel  ·  hover for RT60 preview`;
    vp.appendChild(hint);
  } else if (structArmed) {
    const hint = document.createElement('div');
    hint.className = 'r2d-armed-hint';
    hint.textContent = `Click in the room to place this structure  ·  ESC to cancel`;
    vp.appendChild(hint);
  } else {
    // Arm just dropped — clear any leftover ghost.
    clearFurnitureGhost();
  }
}

// Cancel armed placement on ESC, anywhere in the app. Idempotent; safe
// to call when nothing is armed.
function cancelFurnitureArming() {
  if (!state.furnitureArmed) return;
  state.furnitureArmed = null;
  applyArmedCursorState();
}

// ---------------------------------------------------------------------------
// Acoustic-ghost preview (Phase 1C, 2026-05-26).
//
// While the user has armed a placement and is hovering the 2D viewport,
// show two things at the cursor: (1) a dashed footprint rect where the
// object would land, (2) a chip with the RT60 delta the placement would
// cause. The delta is honest — it computes a hypothetical rt60 with the
// candidate added, against the current rt60. Position doesn't affect
// rt60 (parallel-A is spatially uniform in Sabine/Eyring), but adding
// "one more chair" does.
//
// Architectural note: mousemove fires faster than render() can run, so
// the ghost lives in its own #r2d-furniture-ghost-layer element and is
// DOM-mutated directly (innerHTML swap), NOT via the normal render
// pipeline. Updates coalesce to one per animation frame.

let _ghostRAF = 0;
let _ghostLastClientXY = null;

function scheduleFurnitureGhostUpdate(clientX, clientY) {
  _ghostLastClientXY = { x: clientX, y: clientY };
  if (_ghostRAF) return;
  _ghostRAF = requestAnimationFrame(() => {
    _ghostRAF = 0;
    const svg = document.querySelector('#view-2d svg');
    if (!svg || !_ghostLastClientXY) return;
    if (!state.furnitureArmed) { clearFurnitureGhost(); return; }
    const worldXY = clientToWorldXY(svg, _ghostLastClientXY.x, _ghostLastClientXY.y);
    if (!worldXY) { clearFurnitureGhost(); return; }
    renderFurnitureGhost(worldXY);
  });
}

function clearFurnitureGhost() {
  if (_ghostRAF) { cancelAnimationFrame(_ghostRAF); _ghostRAF = 0; }
  _ghostLastClientXY = null;
  const ghost = document.getElementById('r2d-furniture-ghost-layer');
  if (ghost) ghost.innerHTML = '';
}

function renderFurnitureGhost(hoverWorldXY) {
  const ghost = document.getElementById('r2d-furniture-ghost-layer');
  if (!ghost) return;
  const armed = state.furnitureArmed;
  if (!armed || typeof armed.catalogueId !== 'string') {
    ghost.innerHTML = '';
    return;
  }
  const cat = getFurnitureCatalogue();
  const row = cat.get(armed.catalogueId);
  if (!row) { ghost.innerHTML = ''; return; }

  // Hypothetical RT60 at 1 kHz with the candidate added. Compute both
  // bands lazily — the rt60 module is pure / Node-fast, but we still
  // bail before re-rendering the ghost if neither current nor hover
  // yielded a finite number (degenerate room, no materials, etc.).
  let delta_s = null;
  if (materialsRef && state.room) {
    try {
      const ghostEntry = {
        id: '__GHOST__', catalogueId: armed.catalogueId,
        position: { x: hoverWorldXY.x, y: hoverWorldXY.y }, rotation_deg: 0,
      };
      const currBands = computeAllBands({
        room: state.room, materials: materialsRef,
        zones: state.zones, treatments: state.treatments,
        furniture: state.furniture || [], furnitureCatalogue: cat,
        structures: state.structures,
      });
      const ghBands = computeAllBands({
        room: state.room, materials: materialsRef,
        zones: state.zones, treatments: state.treatments,
        furniture: [...(state.furniture || []), ghostEntry], furnitureCatalogue: cat,
        structures: state.structures,
      });
      const curr1k = currBands.find(b => b.frequency_hz === 1000);
      const gh1k   = ghBands.find(b => b.frequency_hz === 1000);
      const a = preferredRT60(curr1k);
      const b = preferredRT60(gh1k);
      if (Number.isFinite(a) && Number.isFinite(b)) delta_s = b - a;
    } catch (err) {
      // Pure helper failure shouldn't break the cursor — silently no-op.
      delta_s = null;
    }
  }

  // Project hover XY to SVG pixels using the same geometry the main
  // render path uses. currentRoomGeom() returns the cached x0/y0/pxW/pxD
  // from the most recent full render.
  const geom = currentRoomGeom();
  if (!geom) { ghost.innerHTML = ''; return; }
  const w_m = Math.max(0.1, row.footprint?.width_m ?? 0.55);
  const d_m = Math.max(0.1, row.footprint?.depth_m ?? 0.60);
  const cx = geom.x0 + (hoverWorldXY.x / state.room.width_m) * geom.pxW;
  const cy = geom.y0 - (hoverWorldXY.y / state.room.depth_m) * geom.pxD;
  const wPx = w_m * (geom.pxW / Math.max(0.01, state.room.width_m));
  const dPx = d_m * (geom.pxD / Math.max(0.01, state.room.depth_m));

  // Format the delta. Threshold below 5ms reads as "no audible change"
  // (just-noticeable-difference for reverb is ~50 ms; below 5 ms is
  // numerically zero for engineering purposes).
  let deltaText;
  if (delta_s == null) deltaText = 'RT60 — @ 1k';
  else if (Math.abs(delta_s) < 0.005) deltaText = 'RT60 ~0.00 s @ 1k';
  else {
    const sign = delta_s < 0 ? '−' : '+';
    deltaText = `RT60 ${sign}${Math.abs(delta_s).toFixed(2)} s @ 1k`;
  }
  // Chip is sized to text length so long deltas (e.g. -1.00 s) don't
  // get clipped. Approx 5.5 SVG-units per char at 9 px font.
  const chipW = Math.max(64, 6 * deltaText.length + 14);
  const chipH = 14;
  const chipY = (-dPx / 2) - 10 - chipH / 2;

  // Tint the dashed border by the row's reliability tier so the user
  // sees confidence WHILE previewing — consistent with the confidence
  // overlay (Phase 1B). Falls back to terracotta accent if the row has
  // no tier (defensive — every row should have one).
  const tier = row.reliability;
  const c = colorForReliability(tier);

  ghost.innerHTML = `
    <g class="r2d-furn-ghost" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})">
      <rect x="${(-wPx/2).toFixed(1)}" y="${(-dPx/2).toFixed(1)}"
            width="${wPx.toFixed(1)}" height="${dPx.toFixed(1)}"
            fill="${c.fill}" stroke="${c.stroke}"
            stroke-width="1.6" stroke-dasharray="4,3" />
      <g class="r2d-furn-ghost-chip" transform="translate(0 ${chipY.toFixed(1)})">
        <rect x="${(-chipW/2).toFixed(1)}" y="${(-chipH/2).toFixed(1)}"
              width="${chipW.toFixed(1)}" height="${chipH.toFixed(1)}" rx="3"
              fill="rgba(20,25,32,0.94)" stroke="${c.stroke}" stroke-width="0.7" />
        <text x="0" y="3.4" text-anchor="middle" fill="#FAFAF7"
              font-size="9" font-weight="600" font-variant-numeric="tabular-nums">${escapeXml(deltaText)}</text>
      </g>
    </g>
  `;
}

on('furniture:armed', applyArmedCursorState);
on('structure:arm_placement', applyArmedCursorState);
on('structure:cancel_placement', applyArmedCursorState);
// router.js emits `route:change` via document.dispatchEvent (not the
// shared events bus) so the listener has to attach to document.
// Guarded for Node-side test imports (tests/room-2d-*.test.mjs) where
// `document` doesn't exist — the listeners are only meaningful in the
// browser anyway.
if (typeof document !== 'undefined') {
  document.addEventListener('route:change', applyArmedCursorState);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancelFurnitureArming();
      if (state.structureArmed) { state.structureArmed = null; applyArmedCursorState(); }
    }
    // Delete / Backspace removes the currently-selected furniture
    // entry. Guarded so a delete keystroke while a text input has
    // focus (room-name field, listener-label, etc.) doesn't accidentally
    // delete a placed chair from beneath the user.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const tag = e.target?.tagName?.toLowerCase();
      const editable = e.target?.isContentEditable;
      if (tag === 'input' || tag === 'textarea' || editable) return;
      if (state.selectedFurnitureId && location.hash === '#/room') {
        const id = state.selectedFurnitureId;
        const idx = state.furniture.findIndex(x => x.id === id);
        if (idx >= 0) {
          state.furniture.splice(idx, 1);
          state.selectedFurnitureId = null;
          emit('furniture:changed', { removed: id });
          e.preventDefault();
        }
      } else if (state.selectedStructureId && location.hash === '#/room') {
        const id = state.selectedStructureId;
        const idx = state.structures.findIndex(x => x.id === id);
        if (idx >= 0) {
          state.structures.splice(idx, 1);
          state.selectedStructureId = null;
          emit('structure:changed', { removed: id });
          e.preventDefault();
        }
      }
    }
  });
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
  // FurnitureLAB placements — same priority bucket as treatments.
  const furnEl = target.closest('.r2d-furniture');
  if (furnEl) {
    const id = furnEl.dataset.furnitureId;
    if (id) return { kind: 'furniture', el: furnEl, furnitureId: id };
  }
  // DeviceLAB placed racks — same priority bucket as furniture.
  const rackEl = target.closest('.r2d-rack');
  if (rackEl) {
    const id = rackEl.dataset.rackId;
    if (id) return { kind: 'rack', el: rackEl, rackId: id };
  }
  // Building structures — lowest priority (large architectural footprints;
  // a source/listener/treatment on top of a pillar still claims the click).
  const structEl = target.closest('.r2d-structure');
  if (structEl) {
    const id = structEl.dataset.structureId;
    if (id) return { kind: 'structure', el: structEl, structureId: id };
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
  // Y-axis math convention: screen Y grows DOWN, world Y grows UP, so
  // the inverse subtracts in the other order. local.y > y0 (clicked
  // BELOW the world-Y=0 line) → ry < 0 (storage south of origin).
  const ry = ((geom.y0 - local.y) / geom.pxD) * room.depth_m;
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

  // FurnitureLAB armed-placement intercept — runs BEFORE the normal
  // pick path so the user's first click drops the object instead of
  // selecting whatever happens to sit under the cursor. State flag is
  // set by js/labs/furniturelab/main.js armForPlacement(). Consume the
  // click here regardless of whether the placement succeeded so a
  // stray-click can't accidentally arm forever.
  if (state.furnitureArmed && typeof state.furnitureArmed.catalogueId === 'string') {
    const armedCatalogueId = state.furnitureArmed.catalogueId;
    const world = clientToWorldXY(e.currentTarget, e.clientX, e.clientY);
    state.furnitureArmed = null;
    document.querySelector('#view-2d')?.classList.remove('r2d-armed');
    document.querySelector('.r2d-armed-hint')?.remove();
    clearFurnitureGhost();
    if (world && Number.isFinite(world.x) && Number.isFinite(world.y)) {
      placeFurnitureAt(armedCatalogueId, world);
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // Building-structure armed-placement intercept — same protocol as
  // furniture. state.structureArmed is set by panel-structure.js
  // armStructurePlacement(). Drop a default structure of that type at the
  // click, select it, broadcast.
  if (state.structureArmed && typeof state.structureArmed.type === 'string') {
    const armedType = state.structureArmed.type;
    const world = clientToWorldXY(e.currentTarget, e.clientX, e.clientY);
    state.structureArmed = null;
    applyArmedCursorState();
    if (world && Number.isFinite(world.x) && Number.isFinite(world.y)) {
      placeStructureAt(armedType, world);
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }

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
    if (state.selectedStructureId != null) {
      state.selectedStructureId = null;
      emit('structure:selected', { id: null });
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
  } else if (pick.kind === 'furniture') {
    const f = state.furniture?.find(x => x.id === pick.furnitureId);
    if (!f) return;
    try { openPanel('left', 'furniture'); } catch (_) {}
    if (state.selectedFurnitureId !== pick.furnitureId) {
      state.selectedFurnitureId = pick.furnitureId;
      emit('furniture:selected', { id: pick.furnitureId });
    }
    startWorldX = f.position.x;
    startWorldY = f.position.y;
    pickableDrag = {
      kind: 'furniture',
      furnitureId: pick.furnitureId,
      startClientX: e.clientX, startClientY: e.clientY,
      startSrcWorldX: startWorldX, startSrcWorldY: startWorldY,
      pointerId: e.pointerId, didMove: false,
    };
  } else if (pick.kind === 'rack') {
    const r = state.rackSystem?.racks?.find(x => x.id === pick.rackId);
    if (!r || !r.position) return;
    if (state.selectedRackId !== pick.rackId) {
      state.selectedRackId = pick.rackId;
      emit('rack:changed');
    }
    startWorldX = r.position.x;
    startWorldY = r.position.y;
    pickableDrag = {
      kind: 'rack',
      rackId: pick.rackId,
      startClientX: e.clientX, startClientY: e.clientY,
      startSrcWorldX: startWorldX, startSrcWorldY: startWorldY,
      pointerId: e.pointerId, didMove: false,
    };
  } else if (pick.kind === 'structure') {
    const st = state.structures?.find(x => x.id === pick.structureId);
    if (!st || !st.position) return;
    try { openPanel('left', 'structure'); } catch (_) {}
    if (state.selectedStructureId !== pick.structureId) {
      state.selectedStructureId = pick.structureId;
      emit('structure:selected', { id: pick.structureId });
    }
    startWorldX = st.position.x;
    startWorldY = st.position.y;
    pickableDrag = {
      kind: 'structure',
      structureId: pick.structureId,
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
                   : pickableDrag.kind === 'furniture' ? 'furniture:changed'
                   : pickableDrag.kind === 'rack'      ? 'rack:changed'
                   : pickableDrag.kind === 'structure' ? 'structure:changed'
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

  const margin = SOURCE_SNAP_M;
  // Clamp to the EFFECTIVE bounds (room footprint UNIONED with surau
  // podium extension + broken-out enclosures), with start-position
  // expansion so items already placed OUTSIDE the room footprint can
  // still be repositioned. Two prior fixes lived here:
  //   2026-05-17 — Was clamped to just [0, width_m] × [0, depth_m]
  //                which prevented dragging arcade listeners (L6/L7/L8
  //                at y<0) on surau presets. Switched to
  //                roomEffectiveBounds which folds in podium extension.
  //   2026-05-20 — User reported negative-coord room nodes / audience
  //                / speakers jumping to 0 on first click in non-surau
  //                rooms (where bounds.minX = 0). Now the clamp
  //                EXPANDS to include the drag-start position with a
  //                halo when start sits outside normal bounds — see
  //                clampDragTargetToBounds() above.
  const bounds = roomEffectiveBounds(state.room);
  const clamped = clampDragTargetToBounds({
    targetX: snapToGrid(targetX),
    targetY: snapToGrid(targetY),
    startX: pickableDrag.startSrcWorldX,
    startY: pickableDrag.startSrcWorldY,
    bounds, margin,
  });
  const nx = clamped.x;
  const ny = clamped.y;

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
  } else if (pickableDrag.kind === 'furniture') {
    // Floor-mounted objects — free X/Y drag inside room bounds, no
    // surface re-projection. Uses the SNAPPED target (chairs / tables
    // benefit from the same SOURCE_SNAP_M grid the speakers use; small
    // drift while precision-placing reads as polish, not slop).
    const f = state.furniture?.find(x => x.id === pickableDrag.furnitureId);
    if (!f) return;
    if (f.position.x !== nx || f.position.y !== ny) {
      f.position.x = nx;
      f.position.y = ny;
      emit('furniture:changed');
    }
  } else if (pickableDrag.kind === 'rack') {
    // DeviceLAB racks — same free-drag pattern as furniture. Snap to
    // the existing SOURCE_SNAP_M grid; clamped to room bounds by the
    // shared clamp above. rack.position.z stays untouched (racks are
    // floor-standing; vertical position is decorative — castors land
    // them at z=0 in 3D regardless).
    const r = state.rackSystem?.racks?.find(x => x.id === pickableDrag.rackId);
    if (!r || !r.position) return;
    if (r.position.x !== nx || r.position.y !== ny) {
      r.position.x = nx;
      r.position.y = ny;
      emit('rack:changed');
    }
  } else if (pickableDrag.kind === 'structure') {
    // Building structures — same free X/Y drag as furniture/racks, snapped
    // to the SOURCE_SNAP_M grid and clamped to room bounds.
    const st = state.structures?.find(x => x.id === pickableDrag.structureId);
    if (!st || !st.position) return;
    if (st.position.x !== nx || st.position.y !== ny) {
      st.position.x = nx;
      st.position.y = ny;
      emit('structure:changed');
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
    //
    // 2026-05-20: when a vertex already SITS at negative coords (from
    // a previous reshape, programmatic state mutation, or an imported
    // scene), the strict floor-at-0 clamp snapped it to 0 on the first
    // click — the user could never edit it back into place. The vertex
    // clamp now expands its floor to include the drag-start position
    // (with DRAG_OUTSIDE_HALO_M halo) when start is already negative.
    // See clampVertexDragTarget() above.
    const vertexClamped = clampVertexDragTarget({
      targetX: snapToGrid(targetX),
      targetY: snapToGrid(targetY),
      startX: pickableDrag.startSrcWorldX,
      startY: pickableDrag.startSrcWorldY,
    });
    const targetSnapX = vertexClamped.x;
    const targetSnapY = vertexClamped.y;
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
// room. width_m/depth_m are the true bbox SPAN (maxX-minX, maxY-minY),
// not just the positive extent — a vertex dragged into negative space
// (2026-06-04, floor removed in clampVertexDragTarget) must still grow
// the reported dimensions, or downstream consumers that read width_m
// raw (camera framing, print-plan viewBox, panel readout) under-size
// the room. The custom-room render formulas cancel width_m, and RT60
// volume uses the shoelace polygon area, so this value is a render/UI
// extent — but it must reflect the real span.
function recomputeRoomDimsFromPolygon(room) {
  if (!room) return;
  const verts = room.custom_vertices;
  if (!Array.isArray(verts) || verts.length < 3) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of verts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;
  room.width_m = Math.max(1, Math.ceil((maxX - minX) * 2) / 2);
  room.depth_m = Math.max(1, Math.ceil((maxY - minY) * 2) / 2);
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
  } else if (pick.kind === 'furniture') {
    try { openPanel('left', 'furniture'); } catch (_) {}
    if (state.selectedFurnitureId !== pick.furnitureId) {
      state.selectedFurnitureId = pick.furnitureId;
      emit('furniture:selected', { id: pick.furnitureId });
    }
    openFurnitureContextMenu(e.clientX, e.clientY, pick.furnitureId);
  } else if (pick.kind === 'rack') {
    if (state.selectedRackId !== pick.rackId) {
      state.selectedRackId = pick.rackId;
      emit('rack:changed');
    }
    openRackContextMenu(e.clientX, e.clientY, pick.rackId);
  } else if (pick.kind === 'listener') {
    try { openPanel('left', 'listeners'); } catch (_) {}
    if (state.selectedListenerId !== pick.listenerId) {
      state.selectedListenerId = pick.listenerId;
      emit('listener:selected', { id: pick.listenerId });
    }
    openListenerContextMenu(e.clientX, e.clientY, pick.listenerId);
  } else if (pick.kind === 'structure') {
    try { openPanel('left', 'structure'); } catch (_) {}
    if (state.selectedStructureId !== pick.structureId) {
      state.selectedStructureId = pick.structureId;
      emit('structure:selected', { id: pick.structureId });
    }
    openStructureContextMenu(e.clientX, e.clientY, pick.structureId);
  } else if (pick.kind === 'vertex') {
    // Only custom rooms have an editable vertex array. If a non-custom
    // room somehow exposed a vertex pick, bail gracefully (no menu).
    const verts = state.room?.custom_vertices;
    if (state.room?.shape !== 'custom'
        || !Array.isArray(verts)
        || pick.vertexIdx < 0
        || pick.vertexIdx >= verts.length) {
      closeSourceContextMenu();
      return;
    }
    if (state.selectedVertexIdx !== pick.vertexIdx) {
      state.selectedVertexIdx = pick.vertexIdx;
      emit('room:changed');
    }
    openVertexContextMenu(e.clientX, e.clientY, pick.vertexIdx);
  }
}

// Node (polygon-vertex) context menu for custom rooms — "Add node" inserts
// a vertex at the next-edge midpoint; "Delete node" removes this vertex
// (disabled at the 3-vertex floor). Both follow the same write path as the
// vertex DRAG handler — mutate custom_vertices → recomputeRoomDimsFromPolygon
// → emit('room:changed') — so the 3D wall builder + heatmap grid rebuild
// identically for a vertex-COUNT change as for a position change.
function openVertexContextMenu(clientX, clientY, vertexIdx) {
  closeSourceContextMenu();
  const verts = state.room?.custom_vertices;
  if (!Array.isArray(verts) || vertexIdx < 0 || vertexIdx >= verts.length) return;
  const canDelete = verts.length > 3;
  openItemsMenu(clientX, clientY, `Node ${vertexIdx + 1}`, [
    {
      action: 'add-node',
      glyph: '＋',
      label: 'Add node',
      hint: 'midpoint of next edge',
      onClick: () => {
        const cur = state.room?.custom_vertices;
        if (!Array.isArray(cur) || vertexIdx >= cur.length) {
          closeSourceContextMenu();
          return;
        }
        state.room.custom_vertices = insertMidpointNode(cur, vertexIdx, snapToGrid);
        // Select the freshly-inserted node so the user can drag it now.
        state.selectedVertexIdx = vertexIdx + 1;
        recomputeRoomDimsFromPolygon(state.room);
        closeSourceContextMenu();
        emit('room:changed');
      },
    },
    {
      action: 'delete-node',
      glyph: '✕',
      label: 'Delete node',
      hint: canDelete ? '' : 'min 3 nodes',
      disabled: !canDelete,
      onClick: () => {
        const cur = state.room?.custom_vertices;
        const next = deleteNode(cur, vertexIdx);
        if (!next) { closeSourceContextMenu(); return; }   // refused (≤3)
        state.room.custom_vertices = next;
        state.selectedVertexIdx = fixSelectionAfterDelete(
          state.selectedVertexIdx, vertexIdx, next.length);
        recomputeRoomDimsFromPolygon(state.room);
        closeSourceContextMenu();
        emit('room:changed');
      },
    },
  ]);
}

// Structure context menu. For a TOILET bank it lists each cubicle with an
// open/close-door toggle (the same `doorsOpen[i]` boolean the 3D door swing +
// walk-mode 'Press E' mutate — one source of truth, so all three surfaces stay
// consistent). Each toggle flips doorsOpen[i] and emits 'structure:changed',
// which rebuilds the 3D mesh AND re-renders this 2D plan (the door-state-aware
// toiletPlanSegments now draws the flush/swung leaf accordingly). For non-
// toilet structures, a simple label-only menu (Duplicate) preserves prior
// behaviour. (v=776)
function openStructureContextMenu(clientX, clientY, structureId) {
  closeSourceContextMenu();
  const st = state.structures?.find(x => x.id === structureId);
  if (!st) return;

  if (st.type === 'toilet') {
    const n = Math.max(1, Math.min(20, Math.round(Number(st.cubicles) || 3)));
    if (!Array.isArray(st.doorsOpen)) st.doorsOpen = [];
    const header = st.label || `Toilet — ${n} cubicle${n === 1 ? '' : 's'}`;
    const items = [];
    for (let i = 0; i < n; i++) {
      const isOpen = st.doorsOpen[i] === true;
      items.push({
        action: `door-${i}`,
        glyph: isOpen ? '▢' : '▣',
        label: `Cubicle ${i + 1} — ${isOpen ? 'Close door' : 'Open door'}`,
        hint: isOpen ? 'open' : 'closed',
        onClick: () => {
          const cur = state.structures?.find(x => x.id === structureId);
          if (!cur) { closeSourceContextMenu(); return; }
          if (!Array.isArray(cur.doorsOpen)) cur.doorsOpen = [];
          cur.doorsOpen[i] = !cur.doorsOpen[i];
          closeSourceContextMenu();
          emit('structure:changed', { id: structureId, key: 'doorsOpen' });
        },
      });
    }
    openItemsMenu(clientX, clientY, header, items);
    return;
  }

  // Non-toilet structures: label-only menu with Duplicate (matches the click-
  // select behaviour; keeps prior right-click expectation simple).
  const label = st.label || st.type || 'Structure';
  openPickableMenu(clientX, clientY, label, () => {
    const newId = duplicateStructure(structureId);
    closeSourceContextMenu();
    if (newId) {
      state.selectedStructureId = newId;
      emit('structure:changed', { id: newId });
      emit('structure:selected', { id: newId });
    }
  });
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

function openFurnitureContextMenu(clientX, clientY, furnitureId) {
  closeSourceContextMenu();
  const f = state.furniture?.find(x => x.id === furnitureId);
  if (!f) return;
  // Prefer the human-facing catalogue name in the menu header; fall back
  // to the instance id ("F1") when the catalogue hasn't resolved or the
  // link is broken.
  const cat = getFurnitureCatalogue();
  const row = cat.get(f.catalogueId);
  const label = f.label || row?.name || f.id || 'Furniture';
  openPickableMenu(clientX, clientY, label, () => {
    const newId = duplicateFurniture(furnitureId);
    closeSourceContextMenu();
    if (newId) {
      state.selectedFurnitureId = newId;
      emit('furniture:changed', { id: newId });
      emit('furniture:selected', { id: newId });
    }
  });
}

function openRackContextMenu(clientX, clientY, rackId) {
  closeSourceContextMenu();
  const r = state.rackSystem?.racks?.find(x => x.id === rackId);
  if (!r) return;
  const cat = getRackCatalogue();
  const def = cat?.racks?.[r.rackModelKey];
  const label = r.label || def?.label || r.rackModelKey || 'Rack';
  openPickableMenu(
    clientX, clientY, label,
    // Duplicate
    () => {
      const newId = duplicateRack(rackId);
      closeSourceContextMenu();
      if (newId) {
        state.selectedRackId = newId;
        emit('rack:changed');
      }
    },
    // Rotate +45° clockwise (in state-frame; the rack-2d.js renderer +
    // scene.js rebuildRacks both read rack.yaw_deg).
    () => {
      const next = rotateRack(rackId, 45);
      closeSourceContextMenu();
      if (next != null) emit('rack:changed');
    },
  );
}

// Shared menu builder — same chrome for sources / listeners / furniture /
// racks. `onDuplicate` always shown; `onRotate` (optional) adds a "Rotate
// 45°" item for racks + anything else that grows rotation support later.
// This is a thin compatibility shim over openItemsMenu so the four
// existing callers stay byte-for-byte unchanged.
function openPickableMenu(clientX, clientY, label, onDuplicate, onRotate = null) {
  const items = [
    { action: 'duplicate', glyph: '⎘', label: 'Duplicate',
      hint: 'all settings, +0.5 m', onClick: onDuplicate },
  ];
  if (typeof onRotate === 'function') {
    items.push({ action: 'rotate', glyph: '↻', label: 'Rotate 45°',
      hint: 'clockwise around centre', onClick: onRotate });
  }
  openItemsMenu(clientX, clientY, label, items);
}

// Generic context-menu builder. `items` is an array of
// `{ action, glyph, label, hint?, disabled?, onClick }`. A disabled item
// renders greyed and non-clickable (`.is-disabled` + the native disabled
// attribute). Reuses the same `.r2d-ctx-*` chrome + outside-click/Esc
// dismissal as before. closeSourceContextMenu() tears it down (the var
// name is historical — it owns whichever r2d context menu is open).
function openItemsMenu(clientX, clientY, label, items) {
  closeSourceContextMenu();
  const menu = document.createElement('div');
  menu.className = 'r2d-ctx-menu';
  menu.setAttribute('role', 'menu');
  const rows = (items || []).map((it) => {
    const disabled = !!it.disabled;
    const hint = it.hint
      ? `<span class="r2d-ctx-hint">${escapeMenuHtml(it.hint)}</span>` : '';
    return `<button type="button"
              class="r2d-ctx-item${disabled ? ' is-disabled' : ''}"
              data-action="${escapeMenuHtml(it.action)}"
              role="menuitem"${disabled ? ' disabled aria-disabled="true"' : ''}>
              <span class="r2d-ctx-glyph">${escapeMenuHtml(it.glyph ?? '')}</span> ${escapeMenuHtml(it.label ?? '')}
              ${hint}
            </button>`;
  }).join('');
  menu.innerHTML = `
    <div class="r2d-ctx-header">${escapeMenuHtml(label)}</div>
    ${rows}
  `;
  // Position. Clamp into the viewport so menus near the right/bottom
  // edge don't open off-screen.
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth  - r.width  - 8);
  const top  = Math.min(clientY, window.innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top  = `${Math.max(8, top)}px`;

  for (const it of (items || [])) {
    if (it.disabled || typeof it.onClick !== 'function') continue;
    menu.querySelector(`[data-action="${CSS.escape(it.action)}"]`)
      ?.addEventListener('click', it.onClick);
  }

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
function renderTreatmentsSVG(treatments, selectedId, draggingId, x0, y0, pxW, pxD, room, labelScale = 1.0) {
  if (!Array.isArray(treatments) || treatments.length === 0) return '';
  const stateToSvgX = (x) => x0 + (x / room.width_m) * pxW;
  const stateToSvgY = (y) => y0 - (y / room.depth_m) * pxD;
  // World-metres → SVG-pixels scale (uniform — assume the floor plan is
  // aspect-correct because the renderer fits the room into pxW × pxD).
  const px_per_m_x = pxW / Math.max(0.01, room.width_m);
  const px_per_m_y = pxD / Math.max(0.01, room.depth_m);
  // For wall panels we draw a rectangle whose long edge is `width_m`
  // along the wall tangent, and whose short edge is `depth_m` projecting
  // INTO the room. Use the average scale for the short edge so a
  // skewed room aspect doesn't squash the panel visually.
  const px_per_m_avg = (px_per_m_x + px_per_m_y) / 2;
  // Label-only scaling (footprints are real-world dimensions).
  const lblFontPx = (10 * labelScale).toFixed(1);
  const lblCeilOff = 12 * labelScale;
  const lblWallOff = 4 * labelScale;

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
              ${isDrag ? '' : `<text x="0" y="${(hPx/2 + lblCeilOff).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-zone-sub" fill="#a0afc0" style="font-size:${lblFontPx}px">${escapeXml(t.label || t.id)}</text>`}
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
      // The polygon edge is in WORLD coords (a.y, b.y in state units).
      // The 2D plan now uses math convention: world +Y maps to SVG -Y
      // (screen-up). The treatment panel rectangle is in SVG-local
      // coords (rotation applied to a horizontal rect), so the tangent
      // angle must be computed in SVG space → negate dy when forming
      // atan2 so the rect orients along the same SVG line the room
      // outline draws.
      tangAngleDeg = (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
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
            ${isDrag ? '' : `<text x="0" y="-${(dPx + lblWallOff).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-zone-sub" fill="#cfd6df" style="font-size:${lblFontPx}px">${escapeXml(t.label || t.id)}</text>`}
          </g>`;
  }
  return s;
}

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Render placed FurnitureLAB objects as top-down footprint rectangles
// with a label. Phase 0: simplified shape (oriented rectangle filled
// with the accent terracotta tint). Phase 1 will swap in the same
// isometric-ink glyph used on the catalogue card so card↔plan parity
// is automatic. The catalogue resolves footprint dimensions; missing
// rows render as a neutral grey box so a broken catalogueId doesn't
// vanish silently.
// Top-down rack footprints. Closed rectangle with a thicker FRONT-edge
// stroke + a small hinge dot at the FRONT-LEFT corner — see
// js/graphics/rack-2d.js header for the convention rationale and
// 3D-coord-frame mapping. Same helper feeds the print plan SVG so the
// two surfaces stay in lock-step (parity fixture:
// tests/cross-surface-conventions.test.mjs).
function renderRacksSVG(racks, selectedRackId, x0, y0, pxW, pxD, room, labelScale = 1.0) {
  if (!Array.isArray(racks) || racks.length === 0) return '';
  const catalogue = getRackCatalogue();
  if (!catalogue) return '';   // graceful: no catalogue → no footprint (3D rebuild path warns)
  const stateToSvgX = (x) => x0 + (x / room.width_m) * pxW;
  const stateToSvgY = (y) => y0 - (y / room.depth_m) * pxD;
  // Isotropic m→px factor. Use the smaller of the two so a non-square
  // room doesn't squash the rack footprint into a parallelogram.
  // Furniture uses the SAME approach (see renderFurnitureSVG).
  const px_per_m_x = pxW / Math.max(0.01, room.width_m);
  const px_per_m_y = pxD / Math.max(0.01, room.depth_m);
  const mToPx = Math.min(px_per_m_x, px_per_m_y);
  const labelFontPx = 10 * labelScale;

  let s = '';
  for (const r of racks) {
    if (!r || !r.position) continue;
    const def = lookupRackDef(catalogue, r.rackModelKey);
    if (!def) continue;
    const cxPx = stateToSvgX(r.position.x);
    const cyPx = stateToSvgY(r.position.y);
    const isSel = r.id && r.id === selectedRackId;
    const label = r.label || def.label || r.rackModelKey || '';
    s += renderRackFootprintSVG(r, def, {
      cxPx, cyPx, mToPx,
    }, {
      selected: isSel,
      label,
      labelFontPx,
      styleClass: 'r2d-rack' + (isSel ? ' selected' : ''),
      dataAttrs: r.id ? `data-rack-id="${escapeXml(r.id)}"` : '',
    });
  }
  return s;
}

function renderFurnitureSVG(furniture, selectedId, x0, y0, pxW, pxD, room, labelScale = 1.0) {
  if (!Array.isArray(furniture) || furniture.length === 0) return '';
  const catalogue = getFurnitureCatalogue();
  const stateToSvgX = (x) => x0 + (x / room.width_m) * pxW;
  const stateToSvgY = (y) => y0 - (y / room.depth_m) * pxD;
  const px_per_m_x = pxW / Math.max(0.01, room.width_m);
  const px_per_m_y = pxD / Math.max(0.01, room.depth_m);
  // Footprint is a real physical rectangle in metres → does NOT shrink
  // with labelScale. Only the label text + its offset below the
  // footprint scales, so a 0.30 m bookshelf stays 0.30 m wide on screen
  // regardless of indoor vs outdoor view.
  const lblFontPx = (10 * labelScale).toFixed(1);
  const lblOffset = 11 * labelScale;
  // Carmen's confidence-overlay mode — when ON, the footprint fill /
  // stroke are sourced from reliability-colors.js (green/amber/red
  // per row.reliability) instead of the default accent CSS class.
  const confidenceMode = !!state.display?.furnitureConfidenceMode;

  let s = '';
  for (const f of furniture) {
    if (!f || !f.position) continue;
    const row = catalogue.get(f.catalogueId);
    const w = Math.max(0.1, row?.footprint?.width_m ?? 0.55);
    const d = Math.max(0.1, row?.footprint?.depth_m ?? 0.60);
    const cx = stateToSvgX(f.position.x);
    const cy = stateToSvgY(f.position.y);
    const wPx = w * px_per_m_x;
    const dPx = d * px_per_m_y;
    const rot = f.rotation_deg ?? 0;
    const isSel = f.id === selectedId;
    const isBroken = !row;
    // Compact label for the top-down plan — full catalogue names like
    // "Theater seat, upholstered (occupied)" overflow the footprint
    // rectangle. Prefer the user's f.label override, then the
    // catalogue's short_name (1-16 chars), only fall back to the long
    // name / id if the row is malformed or missing.
    const lblText = f.label || row?.short_name || row?.name || f.catalogueId || f.id;

    // Footprint style: confidence overlay wins, then broken fallback,
    // then the default CSS-driven accent. Inline style only when we're
    // overriding the CSS (keeps the default code path unchanged so
    // CSS-only tweaks don't fight inline declarations).
    let rectStyle = '';
    if (confidenceMode) {
      const tier = isBroken ? 'unknown' : row.reliability;
      const c = colorForReliability(tier);
      rectStyle = `style="fill:${c.fill};stroke:${c.stroke};stroke-width:1.4"`;
    } else if (isBroken) {
      rectStyle = 'style="fill:rgba(120,120,120,0.18);stroke:rgba(120,120,120,0.6);stroke-dasharray:3,2"';
    }

    s += `<g class="r2d-furniture ${isSel ? 'selected' : ''} ${isBroken ? 'broken' : ''}"
            data-furniture-id="${f.id}"
            transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rot.toFixed(1)})">
            <rect class="r2d-furniture-footprint"
                  x="${(-wPx/2).toFixed(1)}" y="${(-dPx/2).toFixed(1)}"
                  width="${wPx.toFixed(1)}" height="${dPx.toFixed(1)}"
                  ${rectStyle} />
            <text class="r2d-furniture-label" x="0" y="${(dPx/2 + lblOffset).toFixed(1)}" text-anchor="middle" style="font-size:${lblFontPx}px">${escapeXml(lblText)}</text>
          </g>`;
  }
  return s;
}

// Building structures (pillars / half-walls / partitions / beams / platforms)
// top-down footprints. Uses the SAME geometry helpers the physics engine + the
// print plan SVG consume (structureFootprintCorners / Circle from
// building-structures.js) so the three surfaces cannot drift — cross-surface
// convention (Sam). Y is flipped here (state +y = north renders UP) exactly
// like every other 2D element.
function renderStructuresSVG(structures, selectedId, x0, y0, pxW, pxD, room, labelScale = 1.0) {
  if (!Array.isArray(structures) || structures.length === 0) return '';
  const stateToSvgX = (x) => x0 + (x / room.width_m) * pxW;
  const stateToSvgY = (y) => y0 - (y / room.depth_m) * pxD;
  const px_per_m_x = pxW / Math.max(0.01, room.width_m);
  const px_per_m_y = pxD / Math.max(0.01, room.depth_m);
  const lblFontPx = (10 * labelScale).toFixed(1);
  const lblOffset = 11 * labelScale;

  // --- Toilet architectural plan symbol (v=774) ----------------------------
  // Shared pure helper toiletPlanSegments → dividers + part-open door leaf +
  // quarter-circle door-swing arc + WC pan/cistern. Each primitive rides the
  // SAME stateToSvgX/Y wrapper as every other 2D element (no parallel transform,
  // NO X-mirror — plan surfaces use plain X). The Y-flip (sy = const − y)
  // mirrors the plane, so the door-swing ARC has its angles negated + winding
  // flipped (a→−a, ccw→!ccw) — the IDENTICAL transform print-plan-svg.js applies,
  // so the door curves the same way on both surfaces.
  const toiletPlanSVG = (st) => {
    const seg = toiletPlanSegments(st, room);
    // role → stroke weight: heavy bank-outline, medium divider/filler/leaf,
    // light dashed swing, light WC.
    const weight = (role) => {
      if (role === 'bank-outline') return 'r2d-toilet-heavy';
      if (role === 'divider' || role === 'front-filler' || role === 'door-leaf') return 'r2d-toilet-medium';
      if (role === 'door-swing') return 'r2d-toilet-swing';
      return 'r2d-toilet-fixture';   // wc-pan / wc-cistern
    };
    const rectPts = (p) => {
      const hx = p.lx / 2, hy = p.ly / 2;
      const c = Math.cos(p.rot), sn = Math.sin(p.rot);
      return [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([u, v]) => {
        const x = p.center.x + u * c - v * sn;
        const y = p.center.y + u * sn + v * c;
        return `${stateToSvgX(x).toFixed(1)},${stateToSvgY(y).toFixed(1)}`;
      }).join(' ');
    };
    let out = '';
    for (const p of seg.primitives) {
      const w = weight(p.role);
      if (p.kind === 'line') {
        out += `<line class="r2d-toilet-prim ${w}" data-role="${p.role}" x1="${stateToSvgX(p.a.x).toFixed(1)}" y1="${stateToSvgY(p.a.y).toFixed(1)}" x2="${stateToSvgX(p.b.x).toFixed(1)}" y2="${stateToSvgY(p.b.y).toFixed(1)}" />`;
      } else if (p.kind === 'rect') {
        out += `<polygon class="r2d-toilet-prim ${w}" data-role="${p.role}" points="${rectPts(p)}" />`;
      } else if (p.kind === 'ellipse') {
        // Average pixel scale (rx/ry in metres) — plan is near-isotropic.
        const rxPx = p.rx * px_per_m_x, ryPx = p.ry * px_per_m_y;
        const ecx = stateToSvgX(p.center.x), ecy = stateToSvgY(p.center.y);
        // Y-flip negates the rotation (sy = const − y mirrors the plane).
        const rotDeg = (-p.rot * 180 / Math.PI).toFixed(2);
        out += `<ellipse class="r2d-toilet-prim ${w}" data-role="${p.role}" cx="${ecx.toFixed(1)}" cy="${ecy.toFixed(1)}" rx="${rxPx.toFixed(1)}" ry="${ryPx.toFixed(1)}" transform="rotate(${rotDeg} ${ecx.toFixed(1)} ${ecy.toFixed(1)})" />`;
      } else if (p.kind === 'arc') {
        // Endpoints in state coords → Y-flipped SVG coords. The Y-flip mirrors
        // the plane → negate angles + flip winding (a→−a, ccw→!ccw).
        const sxA = stateToSvgX(p.center.x + p.r * Math.cos(p.a0));
        const syA = stateToSvgY(p.center.y + p.r * Math.sin(p.a0));
        const sxB = stateToSvgX(p.center.x + p.r * Math.cos(p.a1));
        const syB = stateToSvgY(p.center.y + p.r * Math.sin(p.a1));
        const rPx = p.r * px_per_m_x;
        // After Y-flip the winding inverts: a state-frame CCW arc draws CW on
        // screen. SVG sweep-flag=1 = clockwise (screen). flippedCcw = !ccw.
        const sweep = p.ccw ? 1 : 0;   // !ccw → CW(screen)=sweep1; ccw → sweep0
        out += `<path class="r2d-toilet-prim ${weight(p.role)}" data-role="${p.role}" d="M ${sxA.toFixed(1)} ${syA.toFixed(1)} A ${rPx.toFixed(1)} ${rPx.toFixed(1)} 0 0 ${sweep} ${sxB.toFixed(1)} ${syB.toFixed(1)}" />`;
      }
    }
    return out;
  };

  let s = '';
  for (const st of structures) {
    if (!st || !st.position) continue;
    const isSel = st.id === selectedId;
    const cls = `r2d-structure r2d-structure-${st.type} ${isSel ? 'selected' : ''}`;
    let shape;
    if (st.type === 'toilet') {
      const cxT = stateToSvgX(st.position.x);
      const cyT = stateToSvgY(st.position.y);
      const lblT = st.label || st.id;
      // Invisible hit-area over the whole bank footprint so a click
      // anywhere on the toilet selects it (and opens the structure
      // panel). The plan symbol itself is mostly unfilled strokes
      // (dividers / door-swing arcs / WC glyphs) with no clickable
      // interior — without this, only the thin lines were pickable.
      // fill="transparent" (not "none") still receives pointer events.
      const hitPts = structureFootprintCorners(st)
        .map(c => `${stateToSvgX(c.x).toFixed(1)},${stateToSvgY(c.y).toFixed(1)}`)
        .join(' ');
      s += `<g class="${cls}" data-structure-id="${escapeXml(st.id)}">
              <polygon class="r2d-structure-hit" points="${hitPts}" fill="transparent" stroke="none" />
              ${toiletPlanSVG(st)}
              <text class="r2d-structure-label" x="${cxT.toFixed(1)}" y="${(cyT + lblOffset + 6).toFixed(1)}" text-anchor="middle" style="font-size:${lblFontPx}px">${escapeXml(lblT)}</text>
            </g>`;
      continue;
    }
    const circle = structureFootprintCircle(st);
    if (circle) {
      const r = Math.max(circle.r * px_per_m_x, circle.r * px_per_m_y);
      shape = `<circle class="r2d-structure-footprint" cx="${stateToSvgX(circle.cx).toFixed(1)}" cy="${stateToSvgY(circle.cy).toFixed(1)}" r="${r.toFixed(1)}" />`;
    } else {
      const pts = structureFootprintCorners(st)
        .map(c => `${stateToSvgX(c.x).toFixed(1)},${stateToSvgY(c.y).toFixed(1)}`)
        .join(' ');
      shape = `<polygon class="r2d-structure-footprint" points="${pts}" />`;
    }
    const cx = stateToSvgX(st.position.x);
    const cy = stateToSvgY(st.position.y);
    const lbl = st.label || st.id;
    s += `<g class="${cls}" data-structure-id="${escapeXml(st.id)}">
            ${shape}
            <text class="r2d-structure-label" x="${cx.toFixed(1)}" y="${(cy + lblOffset + 6).toFixed(1)}" text-anchor="middle" style="font-size:${lblFontPx}px">${escapeXml(lbl)}</text>
          </g>`;
  }
  return s;
}

// Small legend chip rendered when the confidence overlay is on. Lives
// inside the floor-plan SVG (not as an HTML overlay) so it pans + zooms
// naturally with the rest of the viewport content and doesn't get
// caught in the click-outside-to-close-panel hit testing.
function renderFurnitureConfidenceLegend(svgViewBoxW, svgViewBoxH) {
  if (!state.display?.furnitureConfidenceMode) return '';
  const rows = reliabilityLegendRows();
  const padX = 8, padY = 6, rowH = 12, swatch = 9, gap = 6, charW = 5.2;
  const longestLabelLen = Math.max(...rows.map(r => r.label.length));
  const w = padX * 2 + swatch + gap + longestLabelLen * charW + 4;
  const h = padY * 2 + rows.length * rowH;
  // Bottom-left of the viewport, clear of the room outline most of the
  // time. Pure SVG-coord layout (no transform) so it renders sharp.
  const x = 12;
  const y = svgViewBoxH - h - 12;
  const rowsSvg = rows.map((r, i) => {
    const ry = y + padY + i * rowH;
    return `
      <rect x="${x + padX}" y="${ry + (rowH - swatch) / 2}" width="${swatch}" height="${swatch}"
            fill="${r.swatchHex}" stroke="none" />
      <text x="${x + padX + swatch + gap}" y="${ry + rowH / 2 + 3.4}" class="r2d-furn-leg-label">${r.label}</text>
    `;
  }).join('');
  return `
    <g class="r2d-furn-confidence-legend" pointer-events="none">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3"
            fill="rgba(20, 25, 32, 0.92)" stroke="rgba(255, 255, 255, 0.12)" stroke-width="0.6" />
      <text x="${x + padX}" y="${y - 2}" class="r2d-furn-leg-title">Acoustic data confidence</text>
      ${rowsSvg}
    </g>`;
}

function renderListenersSVG(listeners, selectedId, x0, y0, pxW, pxD, room, draggingId, metrics = [], iconScale = 1.0) {
  let s = '';
  listeners.forEach((lst, idx) => {
    const sx = x0 + (lst.position.x / room.width_m) * pxW;
    const sy = y0 - (lst.position.y / room.depth_m) * pxD;
    const isSel = lst.id === selectedId;
    const isDragging = lst.id === draggingId;
    const radius = isSel ? 10 : 7;
    const fill = isSel ? '#ffd000' : '#4a8ff0';
    const stroke = isSel ? '#ffffff' : '#13161c';
    const strokeW = isSel ? 2.5 : 1.5;
    const sclTok = iconScale !== 1.0 ? ` scale(${iconScale.toFixed(3)})` : '';
    const transform = `translate(${sx.toFixed(1)},${sy.toFixed(1)})${sclTok}${isDragging ? ' scale(2)' : ''}`;
    const cls = ['r2d-listener']
      .concat(isSel       ? ['r2d-listener-selected'] : [])
      .concat(isDragging  ? ['r2d-listener-dragging'] : [])
      .join(' ');
    s += `<g class="${cls}" data-listener-id="${escapeMenuHtml(lst.id)}" transform="${transform}">`;
    // Invisible hit-target — keeps full screen-coord click size even
    // when the visible dot is shrunk to 3 SVG units in outdoor mode.
    const hitR = 12 / Math.max(0.1, iconScale);
    s += `<circle class="r2d-lst-hit" cx="0" cy="0" r="${hitR.toFixed(1)}" fill="transparent" stroke="none" />`;
    s += `<circle class="r2d-lst-dot" cx="0" cy="0" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" />`;
    if (!isDragging) {
      const lblMatch = String(lst.label).match(/\d+/);
      const short = lblMatch ? lblMatch[0] : String(lst.label).slice(0, 2);
      s += `<text x="0" y="3" text-anchor="middle" class="vp-lbl vp-lbl-listener">${escapeMenuHtml(short)}</text>`;
      // SPL / STI line — placed below the dot so it never covers the
      // short id inside it. Hidden during drag (the dot doubles in size
      // and would push the text off-grid). Empty when neither metric is
      // available so there's no orphan visual. Scales with the group's
      // iconScale in outdoor view — small but still rendered.
      const txt = formatListenerMetricsLabel(metrics[idx] ?? {});
      if (txt) {
        s += `<text x="0" y="${(radius + 11).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-listener-metrics">${escapeMenuHtml(txt)}</text>`;
      }
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
    y: y0 - (v.y / d) * pxD,
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
    //
    // Phase 11a (2026-05-25, Maya): ticks now span the RAMP DOMAIN
    // (30..110 dB), not the data extent. The data extent is shown as a
    // faint bracket inside the bar + sub-caption "data: 72–106 dB".
    // Same convention enforced across all three heatmap legends —
    // tests/cross-surface-conventions.test.mjs.
    const minVal = splResult.minSPL_db;
    const maxVal = splResult.maxSPL_db;
    const freqHz = state.physics?.freq_hz ?? 1000;
    const rampDom = getRampDomain('spl');
    const ticks = computeTicks(rampDom.min, rampDom.max, 'spl');
    const minorTicks = computeMinorTicks(rampDom.min, rampDom.max, 'spl', ticks);
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
    // Data bracket (faint translucent band inside the bar) + sub-caption.
    // Hidden when the data range is degenerate.
    const bracket = dataBracketPosition(minVal, maxVal, 'spl');
    const bracketHtml = bracket
      ? `<div class="spl-legend-data-bracket" style="top:${((1 - bracket.end01) * 100).toFixed(2)}%;bottom:${(bracket.start01 * 100).toFixed(2)}%"></div>`
      : '';
    const dataCap = formatDataBracket(minVal, maxVal, 'spl');
    const dataCapHtml = dataCap
      ? `<span class="spl-legend-data-caption">${dataCap}</span>`
      : '';
    // Low-frequency modal / statistical disclosure (Dr. Chen, 2026-06-05).
    const lfCap = lowFreqCaption({ freq_hz: freqHz, schroeder_hz: splResult.schroeder_hz, modalApplied: splResult.modalApplied });
    const lfCapHtml = lfCap ? `<span class="spl-legend-lf-caption">${lfCap}</span>` : '';
    return `<div class="vp-legend spl-legend spl-legend-v">
      <span class="legend-header">${legendHeader('spl', freqHz)}</span>
      <div class="spl-legend-stage">
        <div class="legend-bar">${bracketHtml}</div>
        <div class="spl-legend-ticks">${minorRows}${tickRows}</div>
      </div>
      ${dataCapHtml}
      ${lfCapHtml}
      <span class="legend-footnote">re 20 µPa</span>
    </div>`;
  }
  return `<div class="vp-legend">
    ${COLOR_BANDS.map(b => `<span class="legend-item"><span class="swatch" style="background:${b.color}"></span>${b.label}</span>`).join('')}
  </div>`;
}
