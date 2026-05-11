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

import { colorForMetric } from '../graphics/colour-ramps.js';
import { computeTicks, formatTickLabel, legendHeader } from '../graphics/legend-ticks.js';
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

function projectXY(x_m, y_m, depth_m, offsetX, offsetY) {
  return { sx: x_m + offsetX, sy: (depth_m - y_m) + offsetY };
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
  // Image-Y points DOWN; state-Y points UP (north). The plan SVG flips
  // the linework via projectXY; we mirror the heatmap raster the same
  // way so cell (i, j) lines up with cell (i, cellsY-1-j) on screen.
  for (let j = 0; j < cellsY; j++) {
    const srcRow = cellsY - 1 - j;
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

// Build the full hero heatmap SVG. Mirrors print-plan-svg.js exactly
// so the proposal reads as one design system, then layers the heatmap
// raster behind the linework.
export function buildHeatmapPageSVG(state, splGrid) {
  const room = state.room;
  if (!room || !(room.width_m > 0) || !(room.depth_m > 0)) return '';
  if (!splGrid) return '';

  const dataURL = buildHeatmapDataURL(splGrid);
  if (!dataURL) return '';

  const offsetX = MARGIN_M;
  const offsetY = MARGIN_M;
  const viewW = room.width_m + 2 * MARGIN_M;
  const viewH = room.depth_m + 2 * MARGIN_M;
  const depth_m = room.depth_m;

  // Heatmap raster — placed at the grid's effective bounds. Falls
  // back to the room bbox for the common case where origin = (0,0).
  const ox = splGrid.originX_m ?? 0;
  const oy = splGrid.originY_m ?? 0;
  const planeW = (splGrid.cellW_m ?? 0) * splGrid.cellsX || room.width_m;
  const planeD = (splGrid.cellD_m ?? 0) * splGrid.cellsY || room.depth_m;
  // image-Y is flipped (state Y goes north, SVG Y goes south); we
  // already mirrored the raster row order in buildHeatmapDataURL, so
  // we just place the image at the top-left corner of its bounds in
  // SVG space.
  const imgX = ox + offsetX;
  const imgY = (depth_m - (oy + planeD)) + offsetY;
  const heatEl = `<image href="${dataURL}" x="${imgX.toFixed(3)}" y="${imgY.toFixed(3)}" width="${planeW.toFixed(3)}" height="${planeD.toFixed(3)}" preserveAspectRatio="none" image-rendering="optimizeQuality" />`;

  // Room outline — drawn over the heatmap so the architectural reads
  // first. Same 6 cm hairline as the plan view.
  const stroke = '#222';
  const sw = 0.06;
  let outlineEl = '';
  if (room.shape === 'rectangular') {
    outlineEl = `<rect x="${offsetX.toFixed(3)}" y="${offsetY.toFixed(3)}" width="${room.width_m.toFixed(3)}" height="${room.depth_m.toFixed(3)}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
  } else if (room.shape === 'polygon') {
    const cx = room.width_m / 2 + offsetX;
    const cy = room.depth_m / 2 + offsetY;
    const r = room.polygon_radius_m;
    const N = room.polygon_sides;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
      const px = cx + r * Math.cos(angle);
      const py = cy + r * Math.sin(angle);
      pts.push(`${px.toFixed(3)},${py.toFixed(3)}`);
    }
    outlineEl = `<polygon points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
  } else if (room.shape === 'round') {
    const cx = room.width_m / 2 + offsetX;
    const cy = room.depth_m / 2 + offsetY;
    outlineEl = `<circle cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" r="${room.round_radius_m.toFixed(3)}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
  } else if (room.shape === 'custom') {
    const verts = room.custom_vertices || [];
    if (verts.length >= 3) {
      const pts = verts.map(v => {
        const sx = v.x + offsetX;
        const sy = (depth_m - v.y) + offsetY;
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
      const p = projectXY(v.x, v.y, depth_m, offsetX, offsetY);
      return `${p.sx.toFixed(3)},${p.sy.toFixed(3)}`;
    }).join(' ');
    const sumX = z.vertices.reduce((a, v) => a + v.x, 0) / z.vertices.length;
    const sumY = z.vertices.reduce((a, v) => a + v.y, 0) / z.vertices.length;
    const c = projectXY(sumX, sumY, depth_m, offsetX, offsetY);
    return `<polygon points="${pts}" fill="none" stroke="${color}" stroke-width="0.06" stroke-dasharray="0.3 0.18" />`
      + `<text x="${c.sx.toFixed(3)}" y="${c.sy.toFixed(3)}" font-size="0.42" text-anchor="middle" fill="#111" stroke="#fff" stroke-width="0.05" paint-order="stroke">${escapeText(z.label || z.id)}</text>`;
  }).join('');

  // Sources — same indexed circles as the cover plan so a reader can
  // cross-reference between the two pages.
  const sourcePieces = [];
  let srcCounter = 0;
  for (const s of (state.sources || [])) {
    srcCounter++;
    const flat = s.kind === 'line-array' ? expandSources([s]) : [s];
    flat.forEach((el, eIdx) => {
      const px = (el.position?.x ?? el.origin?.x);
      const py = (el.position?.y ?? el.origin?.y);
      if (px == null || py == null) return;
      const p = projectXY(px, py, depth_m, offsetX, offsetY);
      const color = el.groupId ? colorForGroup(el.groupId) : '#1f5faa';
      const label = s.kind === 'line-array' ? `${srcCounter}.${eIdx + 1}` : `${srcCounter}`;
      sourcePieces.push(`<circle cx="${p.sx.toFixed(3)}" cy="${p.sy.toFixed(3)}" r="0.26" fill="${color}" stroke="#fff" stroke-width="0.07" />`);
      sourcePieces.push(`<circle cx="${p.sx.toFixed(3)}" cy="${p.sy.toFixed(3)}" r="0.26" fill="none" stroke="#000" stroke-width="0.04" />`);
      sourcePieces.push(`<text x="${(p.sx + 0.42).toFixed(3)}" y="${(p.sy + 0.13).toFixed(3)}" font-size="0.42" fill="#000" stroke="#fff" stroke-width="0.06" paint-order="stroke">${label}</text>`);
    });
  }
  const sourcesEl = sourcePieces.join('');

  // Listeners — triangles, white halo for legibility against any
  // colour from the heatmap underneath.
  const listenersEl = (state.listeners || []).map(l => {
    const px = l.position?.x;
    const py = l.position?.y;
    if (px == null || py == null) return '';
    const p = projectXY(px, py, depth_m, offsetX, offsetY);
    const r = 0.32;
    const tri = `${p.sx.toFixed(3)},${(p.sy - r).toFixed(3)} `
      + `${(p.sx + r * 0.866).toFixed(3)},${(p.sy + r * 0.5).toFixed(3)} `
      + `${(p.sx - r * 0.866).toFixed(3)},${(p.sy + r * 0.5).toFixed(3)}`;
    return `<polygon points="${tri}" fill="#0a8a4a" stroke="#fff" stroke-width="0.08" />`
      + `<polygon points="${tri}" fill="none" stroke="#000" stroke-width="0.04" />`
      + `<text x="${(p.sx + 0.55).toFixed(3)}" y="${(p.sy + 0.13).toFixed(3)}" font-size="0.42" fill="#0a4d28" stroke="#fff" stroke-width="0.06" paint-order="stroke">${escapeText(l.label || l.id)}</text>`;
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

  const naSize = 0.55;
  const naX = viewW - 0.7;
  const naY = MARGIN_M * 0.5;
  const northArrowEl = `
    <g class="pr-plan-northarrow">
      <polygon points="${naX.toFixed(3)},${(naY - naSize).toFixed(3)} ${(naX + naSize * 0.45).toFixed(3)},${(naY + naSize * 0.25).toFixed(3)} ${naX.toFixed(3)},${(naY + naSize * 0.05).toFixed(3)} ${(naX - naSize * 0.45).toFixed(3)},${(naY + naSize * 0.25).toFixed(3)}" fill="#000" />
      <text x="${naX.toFixed(3)}" y="${(naY + naSize * 0.75).toFixed(3)}" font-size="0.42" text-anchor="middle" fill="#000">N</text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW.toFixed(3)} ${viewH.toFixed(3)}" preserveAspectRatio="xMidYMid meet" class="pr-heatmap-svg">${heatEl}${zonesEl}${outlineEl}${sourcesEl}${listenersEl}${scaleBarEl}${northArrowEl}</svg>`;
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
  const ticks = computeTicks(min, max, metric === 'sti' ? 'sti' : 'spl');
  const tickRows = ticks.map(t => {
    const pct = Math.max(0, Math.min(100, (1 - t.position01) * 100)).toFixed(2);
    return `<div class="pr-heatmap-legend-tick" style="top:${pct}%">
      <span class="pr-heatmap-legend-tick-line"></span>
      <span class="pr-heatmap-legend-tick-label">${formatTickLabel(t.value, metric === 'sti' ? 'sti' : 'spl')}</span>
    </div>`;
  }).join('');
  const gradient = metric === 'sti'
    ? 'linear-gradient(to top, #d21414 0%, #ff8214 30%, #ffd700 45%, #3cd23c 60%, #00c896 75%, #00aadc 100%)'
    : 'linear-gradient(to top, #1428b4 0%, #008ce6 25%, #1edc50 50%, #ffd700 75%, #f01e1e 100%)';
  return `
    <div class="pr-heatmap-legend">
      <div class="pr-heatmap-legend-header">${legendHeader(metric === 'sti' ? 'sti' : 'spl')}</div>
      <div class="pr-heatmap-legend-stage">
        <div class="pr-heatmap-legend-bar" style="background:${gradient}"></div>
        <div class="pr-heatmap-legend-ticks">${tickRows}</div>
      </div>
    </div>`;
}
