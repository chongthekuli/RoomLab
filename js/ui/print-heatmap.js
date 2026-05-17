// Hero heatmap renderer for the print report (Sofia v1, path A).
//
// Re-rasterises the cached state.results.splGrid into a PNG data URL
// and embeds it inside an SVG that ALSO carries the plan-view linework
// (room outline, sources, listeners, zones, scale bar, north arrow).
// Single SVG → vector linework over a raster heatmap → prints sharp
// edges with smooth colour fills.
//
// Path A (re-rasterise) over path B (toDataURL the live 3D canvas)
// because:
//   • path B requires preserveDrawingBuffer on Three.js → 30-50% perf
//     hit on the live viewport for every frame.
//   • path A reads from the same data the 2D viewport reads, so the
//     printed heatmap is byte-for-byte the 2D heatmap (no resampling
//     drift, no missing zones).
//   • path A runs in Node-friendly canvas APIs → unit-testable.
//
// Coordinate frames mirror print-plan-svg.js exactly so the heatmap
// page is layout-compatible with the cover plan.

import { colorForMetric, splColorRGB } from '../graphics/colour-ramps.js';
import { computeTicks, computeMinorTicks, formatTickLabel, legendHeader } from '../graphics/legend-ticks.js';
import { expandSources, colorForGroup, colorForZone } from '../app-state.js';

// 1.5m margin gives the North arrow + scale bar enough room to live
// fully inside the margin band without overlapping the room outline,
// even for tiny (1-2m wide) rooms. Matches print-plan-svg.js.
const MARGIN_M = 1.5;
const NICE_BAR_M = [0.5, 1, 2, 5, 10, 20, 50];

function escapeText(s) {
  if (s == null) return '';
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function pickScaleBar(roomWidth_m) {
  const target = roomWidth_m / 5;
  let best = NICE_BAR_M[0];
  let bestDelta = Math.abs(best - target);
  for (const v of NICE_BAR_M) {
    const d = Math.abs(v - target);
    if (d < bestDelta) { best = v; bestDelta = d; }
  }
  return best;
}

// State y grows toward the north / FRONT wall (where the north arrow
// points). SVG y grows DOWN. We invert y so state +y renders UP the
// page — math convention, matching the live 2D plan in room-2d.js.
//
// Signature note: the third arg used to be `depth_m`. With the v=458
// Y-flip the world→SVG anchor is `anchorY` = SVG pixel where world-Y=0
// sits (i.e. the bottom of the room band on the printed page).
function projectXY(x_m, y_m, anchorY, offsetX) {
  return { sx: x_m + offsetX, sy: anchorY - y_m };
}

// Build a triangle whose apex points in the source aim direction.
// Source aim yaw=0 fires along state +y (north / toward the FRONT
// wall). After the Y-flip, state +y maps to SVG -y (page-up), so the
// SVG-pixel aim vector is (sin yaw, -cos yaw).
function aimTrianglePoints(cx, cy, r, yawDeg) {
  const yaw = (yawDeg || 0) * Math.PI / 180;
  const dx = Math.sin(yaw), dy = -Math.cos(yaw);   // unit aim in SVG coords (Y-flipped)
  const px = -dy, py = dx;                          // perpendicular (right-hand)
  const ax = cx + dx * r;                           // apex along aim
  const ay = cy + dy * r;
  const bcx = cx - dx * r * 0.4;                    // base center slightly back
  const bcy = cy - dy * r * 0.4;
  const bw = r * 0.75;
  const blx = bcx + px * bw, bly = bcy + py * bw;
  const brx = bcx - px * bw, bry = bcy - py * bw;
  return `${ax.toFixed(3)},${ay.toFixed(3)} ${blx.toFixed(3)},${bly.toFixed(3)} ${brx.toFixed(3)},${bry.toFixed(3)}`;
}

// Render the splGrid into a canvas-2d ImageData and return the PNG
// data URL. Cells outside the room (-Infinity in the grid) become
// fully transparent so the room background shows through.
//
// Returns null when the grid is missing or empty — caller should
// suppress the heatmap page in that case.
export function buildHeatmapDataURL(splGrid) {
  if (!splGrid || !splGrid.grid || !splGrid.cellsX || !splGrid.cellsY) return null;
  if (typeof document === 'undefined') return null;
  const { grid, cellsX, cellsY, metric } = splGrid;
  const canvas = document.createElement('canvas');
  canvas.width = cellsX;
  canvas.height = cellsY;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cellsX, cellsY);
  // Raster row order is grid-native (row j = world cell j, growing
  // toward state +y). The page SVG flips the image vertically via a
  // group transform (see buildHeatmapPageSVG → heatEl), so this
  // function stays trivial and unit-testable. Keeping the row order
  // grid-native also means downstream raster consumers (a future PDF
  // exporter, a thumbnail strip) see the same pixel layout as the
  // splGrid arrays themselves.
  for (let j = 0; j < cellsY; j++) {
    const srcRow = j;
    for (let i = 0; i < cellsX; i++) {
      const v = grid[srcRow][i];
      const idx = (j * cellsX + i) * 4;
      if (!Number.isFinite(v)) {
        img.data[idx + 3] = 0;
        continue;
      }
      const [r, g, b] = colorForMetric(v, metric ?? 'spl');
      img.data[idx + 0] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 218;     // Sofia spec: 0.85 alpha for legibility under linework
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

// Produce a shallow-copy splGrid with every finite cell value shifted
// by `offsetDb`. Used by Drawing 02 (operating-range strip) to render
// the same coverage map at −20 / −10 / 0 dB rel. rated drive without
// re-running the full SPL solver. Physics: total SPL = direct +
// reverberant, both proportional to source power, so a uniform power
// offset is mathematically a uniform dB shift on every in-room cell.
// Out-of-room cells (-Infinity) stay -Infinity. Min/mean/max are
// recomputed so the caller can render sub-captions.
//
// IMPORTANT: this only works on an absolute-SPL grid. If a future grid
// is ever switched to "SPL − ambient" (S/N), only the signal scales —
// the caller would need to back the ambient out, shift, re-add. The
// current SPL grid (computeSPLGrid → computeMultiSourceSPL) is pure
// absolute SPL, no ambient subtraction — verified May 2026.
export function shiftSplGridByDb(splGrid, offsetDb) {
  if (!splGrid || !splGrid.grid) return null;
  const offset = Number.isFinite(offsetDb) ? offsetDb : 0;
  const newGrid = new Array(splGrid.cellsY);
  let minVal = Infinity, maxVal = -Infinity, sum = 0, count = 0;
  for (let j = 0; j < splGrid.cellsY; j++) {
    const srcRow = splGrid.grid[j];
    const dstRow = new Array(splGrid.cellsX);
    for (let i = 0; i < splGrid.cellsX; i++) {
      const v = srcRow[i];
      if (!Number.isFinite(v)) { dstRow[i] = v; continue; }
      const shifted = v + offset;
      dstRow[i] = shifted;
      if (shifted < minVal) minVal = shifted;
      if (shifted > maxVal) maxVal = shifted;
      sum += shifted;
      count++;
    }
    newGrid[j] = dstRow;
  }
  const ok = count > 0;
  return {
    ...splGrid,
    grid: newGrid,
    minSPL_db: ok ? minVal : 0,
    maxSPL_db: ok ? maxVal : 0,
    avgSPL_db: ok ? sum / count : 0,
  };
}

// Build the full hero heatmap SVG. Mirrors print-plan-svg.js exactly
// so the proposal reads as one design system, then layers the heatmap
// raster behind the linework.
//
// Options:
//   compact (default false) — drop the scale bar, north arrow, and
//     source/listener labels for use in a small thumbnail (e.g.
//     Drawing 02's 1×3 strip). Markers still draw but un-labeled.
export function buildHeatmapPageSVG(state, splGrid, { compact = false } = {}) {
  const room = state.room;
  if (!room || !(room.width_m > 0) || !(room.depth_m > 0)) return '';
  if (!splGrid) return '';

  const dataURL = buildHeatmapDataURL(splGrid);
  if (!dataURL) return '';

  // Surau podium pushes the heatmap grid past the room bounds (origin
  // can be negative, span can exceed width_m + depth_m). Compute the
  // full extent so the SVG viewBox captures every cell instead of
  // clipping the arcade. For non-surau rooms (no podium, no extension),
  // the spans match room.width_m / room.depth_m exactly.
  const gridOX = splGrid.originX_m ?? 0;
  const gridOY = splGrid.originY_m ?? 0;
  const gridW = (splGrid.cellW_m ?? 0) * splGrid.cellsX || room.width_m;
  const gridD = (splGrid.cellD_m ?? 0) * splGrid.cellsY || room.depth_m;
  const minX = Math.min(0, gridOX);
  const minY = Math.min(0, gridOY);
  const maxX = Math.max(room.width_m, gridOX + gridW);
  const maxY = Math.max(room.depth_m, gridOY + gridD);
  const offsetX = MARGIN_M - minX;   // shift world (0,0) so minX maps to MARGIN_M
  const viewW = (maxX - minX) + 2 * MARGIN_M;
  const viewH = (maxY - minY) + 2 * MARGIN_M;
  // Y-flip anchor: SVG pixel where world-Y=0 lands. World-Y=maxY (north
  // podium edge) renders at SVG y=MARGIN_M (top of band).
  const anchorY = MARGIN_M + maxY;

  // Heatmap raster — placed at the grid's effective bounds. The raster
  // data URL is grid-native (row 0 = world cell row 0, growing with
  // +world-Y), but we want world +Y to render UP the page. Solve with
  // a per-image SVG transform: translate to the row's TOP-LEFT after
  // flip, then scale(1,-1) so the image draws upside-down inside its
  // own width×height box. Net: image bottom-row pixels end up at the
  // BOTTOM of the SVG band — matches world-Y=gridOY rendering at
  // SVG y = anchorY - gridOY.
  const imgX = gridOX + offsetX;
  const imgYTop = anchorY - (gridOY + gridD);   // SVG y of grid's max-Y edge
  const heatEl = `<g transform="translate(${imgX.toFixed(3)} ${(imgYTop + gridD).toFixed(3)}) scale(1 -1)"><image href="${dataURL}" x="0" y="0" width="${gridW.toFixed(3)}" height="${gridD.toFixed(3)}" preserveAspectRatio="none" image-rendering="optimizeQuality" /></g>`;

  // Room outline — drawn over the heatmap so the architectural reads
  // first. Same 6 cm hairline as the plan view.
  const stroke = '#222';
  const sw = 0.06;
  let outlineEl = '';
  if (room.shape === 'rectangular') {
    // Rect top-left after Y-flip is at (offsetX, anchorY - depth_m).
    outlineEl = `<rect x="${offsetX.toFixed(3)}" y="${(anchorY - room.depth_m).toFixed(3)}" width="${room.width_m.toFixed(3)}" height="${room.depth_m.toFixed(3)}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
  } else if (room.shape === 'polygon') {
    const cx = room.width_m / 2 + offsetX;
    const cy = anchorY - room.depth_m / 2;
    const r = room.polygon_radius_m;
    const N = room.polygon_sides;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
      const px = cx + r * Math.cos(angle);
      const py = cy - r * Math.sin(angle);
      pts.push(`${px.toFixed(3)},${py.toFixed(3)}`);
    }
    outlineEl = `<polygon points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
  } else if (room.shape === 'round') {
    const cx = room.width_m / 2 + offsetX;
    const cy = anchorY - room.depth_m / 2;
    outlineEl = `<circle cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" r="${room.round_radius_m.toFixed(3)}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
  } else if (room.shape === 'custom') {
    const verts = room.custom_vertices || [];
    if (verts.length >= 3) {
      const pts = verts.map(v => {
        const sx = v.x + offsetX;
        const sy = anchorY - v.y;
        return `${sx.toFixed(3)},${sy.toFixed(3)}`;
      }).join(' ');
      outlineEl = `<polygon points="${pts}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
    }
  }

  // Audience zones — semi-transparent fills on top of the heatmap so
  // the user can still read the metric inside each zone.
  const zonesEl = (state.zones || []).map((z, idx) => {
    if (!z.vertices || z.vertices.length < 3) return '';
    const color = colorForZone(idx);
    const pts = z.vertices.map(v => {
      const p = projectXY(v.x, v.y, anchorY, offsetX);
      return `${p.sx.toFixed(3)},${p.sy.toFixed(3)}`;
    }).join(' ');
    const sumX = z.vertices.reduce((a, v) => a + v.x, 0) / z.vertices.length;
    const sumY = z.vertices.reduce((a, v) => a + v.y, 0) / z.vertices.length;
    const c = projectXY(sumX, sumY, anchorY, offsetX);
    const polyEl = `<polygon points="${pts}" fill="none" stroke="${color}" stroke-width="0.06" stroke-dasharray="0.3 0.18" />`;
    if (compact) return polyEl;
    return polyEl
      + `<text x="${c.sx.toFixed(3)}" y="${c.sy.toFixed(3)}" font-size="0.42" text-anchor="middle" fill="#111" stroke="#fff" stroke-width="0.05" paint-order="stroke">${escapeText(z.label || z.id)}</text>`;
  }).join('');

  // Sources — triangles pointing in the aim direction. Matches the
  // live 2D viewport convention: sources radiate (directional symbol),
  // listeners receive (circle). Previously these were swapped, which
  // contradicted every other view in the app.
  const sourcePieces = [];
  let srcCounter = 0;
  for (const s of (state.sources || [])) {
    srcCounter++;
    const flat = s.kind === 'line-array' ? expandSources([s]) : [s];
    flat.forEach((el, eIdx) => {
      const px = (el.position?.x ?? el.origin?.x);
      const py = (el.position?.y ?? el.origin?.y);
      if (px == null || py == null) return;
      const p = projectXY(px, py, anchorY, offsetX);
      const color = el.groupId ? colorForGroup(el.groupId) : '#1f5faa';
      const label = s.kind === 'line-array' ? `${srcCounter}.${eIdx + 1}` : `${srcCounter}`;
      const tri = aimTrianglePoints(p.sx, p.sy, 0.32, el.aim?.yaw ?? 0);
      sourcePieces.push(`<polygon points="${tri}" fill="${color}" stroke="#fff" stroke-width="0.08" />`);
      sourcePieces.push(`<polygon points="${tri}" fill="none" stroke="#000" stroke-width="0.04" />`);
      if (!compact) {
        sourcePieces.push(`<text x="${(p.sx + 0.48).toFixed(3)}" y="${(p.sy + 0.13).toFixed(3)}" font-size="0.42" fill="#000" stroke="#fff" stroke-width="0.06" paint-order="stroke">${label}</text>`);
      }
    });
  }
  const sourcesEl = sourcePieces.join('');

  // Listeners — circles. White halo for legibility against any
  // colour from the heatmap underneath.
  const listenersEl = (state.listeners || []).map(l => {
    const px = l.position?.x;
    const py = l.position?.y;
    if (px == null || py == null) return '';
    const p = projectXY(px, py, anchorY, offsetX);
    const r = 0.26;
    const base = `<circle cx="${p.sx.toFixed(3)}" cy="${p.sy.toFixed(3)}" r="${r}" fill="#0a8a4a" stroke="#fff" stroke-width="0.08" />`
      + `<circle cx="${p.sx.toFixed(3)}" cy="${p.sy.toFixed(3)}" r="${r}" fill="none" stroke="#000" stroke-width="0.04" />`;
    if (compact) return base;
    return base
      + `<text x="${(p.sx + 0.42).toFixed(3)}" y="${(p.sy + 0.13).toFixed(3)}" font-size="0.42" fill="#0a4d28" stroke="#fff" stroke-width="0.06" paint-order="stroke">${escapeText(l.label || l.id)}</text>`;
  }).join('');

  // Scale bar + north arrow — both placed fully inside the SVG margin
  // bands so they never overlap the room outline. Geometry mirrors
  // print-plan-svg.js so the two pages share one visual convention.
  const barLen = pickScaleBar(room.width_m);
  const barX = offsetX;
  const barY = viewH - MARGIN_M * 0.35;
  const tickH = 0.15;
  const scaleBarEl = `
    <g class="pr-plan-scalebar">
      <line x1="${barX.toFixed(3)}" y1="${barY.toFixed(3)}" x2="${(barX + barLen).toFixed(3)}" y2="${barY.toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <line x1="${barX.toFixed(3)}" y1="${(barY - tickH).toFixed(3)}" x2="${barX.toFixed(3)}" y2="${(barY + tickH).toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <line x1="${(barX + barLen).toFixed(3)}" y1="${(barY - tickH).toFixed(3)}" x2="${(barX + barLen).toFixed(3)}" y2="${(barY + tickH).toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <text x="${(barX + barLen / 2).toFixed(3)}" y="${(barY - 0.28).toFixed(3)}" font-size="0.42" text-anchor="middle" fill="#000">${barLen} m</text>
    </g>`;

  // North arrow REMOVED from SVG content as of 2026-05-17 — was scaling
  // with the room (large room → tiny arrow; small room → huge arrow).
  // Render as fixed-CSS-pixel HTML overlay on the .pr-heatmap-stage
  // container (see print.css .pr-heatmap-stage::after).
  const chromeEl = compact ? '' : `${scaleBarEl}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW.toFixed(3)} ${viewH.toFixed(3)}" preserveAspectRatio="xMidYMid meet" class="pr-heatmap-svg">${heatEl}${zonesEl}${outlineEl}${sourcesEl}${listenersEl}${chromeEl}</svg>`;
}

// Build the vertical legend that sits beside the heatmap. Same
// computeTicks() helper that drives the 2D and 3D legends so the
// printed scale matches the on-screen scale exactly.
export function buildHeatmapLegend(splGrid) {
  if (!splGrid) return '';
  const metric = splGrid.metric ?? 'spl';
  const min = splGrid.minSPL_db;
  const max = splGrid.maxSPL_db;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return '';
  const tickMode = metric === 'sti' ? 'sti' : 'spl';
  const ticks = computeTicks(min, max, tickMode);
  const minorTicks = computeMinorTicks(min, max, tickMode, ticks);
  const minorRows = minorTicks.map(t => {
    const pct = Math.max(0, Math.min(100, (1 - t.position01) * 100)).toFixed(2);
    return `<div class="pr-heatmap-legend-tick minor" style="top:${pct}%">
      <span class="pr-heatmap-legend-tick-line"></span>
    </div>`;
  }).join('');
  const tickRows = ticks.map(t => {
    const pct = Math.max(0, Math.min(100, (1 - t.position01) * 100)).toFixed(2);
    return `<div class="pr-heatmap-legend-tick" style="top:${pct}%">
      <span class="pr-heatmap-legend-tick-line"></span>
      <span class="pr-heatmap-legend-tick-label">${formatTickLabel(t.value, tickMode)}</span>
    </div>`;
  }).join('');
  const gradient = metric === 'sti'
    ? 'linear-gradient(to top, #d21414 0%, #ff8214 30%, #ffd700 45%, #3cd23c 60%, #00c896 75%, #00aadc 100%)'
    : 'linear-gradient(to top, #1428b4 0%, #008ce6 25%, #1edc50 50%, #ffd700 75%, #f01e1e 100%)';
  return `
    <div class="pr-heatmap-legend">
      <div class="pr-heatmap-legend-header">${legendHeader(tickMode)}</div>
      <div class="pr-heatmap-legend-stage">
        <div class="pr-heatmap-legend-bar" style="background:${gradient}"></div>
        <div class="pr-heatmap-legend-ticks">${minorRows}${tickRows}</div>
      </div>
    </div>`;
}

// Horizontal legend for the operating-range strip (Drawing 02). Three
// plots share ONE legend centred below them. The tick range is FIXED
// across all three plots so a reader can compare absolute SPL across
// drive levels without re-mapping the gradient mentally. Caller passes
// `min` / `max` already widened to a 5 dB-aligned integer envelope.
//
// Differs from buildHeatmapLegend() because:
//   • horizontal (gradient is left→right, not bottom→top)
//   • ticks are absolute integer values from a caller-supplied range,
//     not auto-derived from min/max — Sofia spec "fixed integer ticks"
//   • header is a plain label string (no metric/freq inference)
export function buildHeatmapStripLegend({ minDb, maxDb, stepDb = 5, header = 'SPL @ 1 kHz' }) {
  if (!Number.isFinite(minDb) || !Number.isFinite(maxDb) || maxDb <= minDb) return '';
  const span = maxDb - minDb;
  const first = Math.ceil(minDb / stepDb) * stepDb;
  const last = Math.floor(maxDb / stepDb) * stepDb;
  const ticks = [];
  for (let v = first; v <= last + 1e-6; v += stepDb) {
    const pct = ((v - minDb) / span) * 100;
    ticks.push({ value: v, pct });
  }
  // Minor (unlabeled) sub-ticks — half the major step. With the typical
  // 5 dB major step that places one minor in the middle of each major
  // interval; coincident minors at major positions are filtered out.
  const minorStep = stepDb / 2;
  const majorVals = new Set(ticks.map(t => Math.round(t.value * 100) / 100));
  const minorTicks = [];
  if (minorStep > 0) {
    const mFirst = Math.ceil(minDb / minorStep) * minorStep;
    const mLast = Math.floor(maxDb / minorStep) * minorStep;
    for (let v = mFirst; v <= mLast + 1e-6; v += minorStep) {
      const key = Math.round(v * 100) / 100;
      if (majorVals.has(key)) continue;
      minorTicks.push({ value: v, pct: ((v - minDb) / span) * 100 });
    }
  }
  // The cell ramp (splColorRGB) is fixed-domain 60–110 dB. To make the
  // legend bar's colour-at-position MATCH the cell colour for the same
  // dB value, sample splColorRGB across [minDb, maxDb] and emit those
  // stops. Otherwise the strip would be coloured blue→red end-to-end
  // even when minDb=70 (which is actually cyan in the cell ramp), and
  // the reader's eye would mis-map a 70 dB cell to "low" on the legend.
  const NSTOPS = 9;
  const stops = [];
  for (let i = 0; i < NSTOPS; i++) {
    const t = i / (NSTOPS - 1);
    const db = minDb + t * span;
    const [r, g, b] = splColorRGB(db);
    stops.push(`rgb(${r},${g},${b}) ${(t * 100).toFixed(2)}%`);
  }
  const gradient = `linear-gradient(to right, ${stops.join(', ')})`;
  const minorEls = minorTicks.map(t => `
    <div class="pr-strip-legend-tick minor" style="left:${t.pct.toFixed(2)}%">
      <span class="pr-strip-legend-tick-line"></span>
    </div>`).join('');
  const tickEls = ticks.map(t => `
    <div class="pr-strip-legend-tick" style="left:${t.pct.toFixed(2)}%">
      <span class="pr-strip-legend-tick-line"></span>
      <span class="pr-strip-legend-tick-label">${Math.round(t.value)} dB</span>
    </div>`).join('');
  return `
    <div class="pr-strip-legend">
      <div class="pr-strip-legend-header">${escapeText(header)}</div>
      <div class="pr-strip-legend-stage">
        <div class="pr-strip-legend-bar" style="background:${gradient}"></div>
        <div class="pr-strip-legend-ticks">${minorEls}${tickEls}</div>
      </div>
    </div>`;
}
