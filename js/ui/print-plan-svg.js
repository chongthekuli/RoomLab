// SVG floor plan renderer for the print report.
//
// Pure function: takes (state) → returns SVG string. No DOM, no
// Three.js — runs in Node tests too. The print report inlines the
// returned string into the page-2 placeholder so the browser print
// pipeline rasterises it as vector (sharp at any DPI, BOMBA-reviewer
// zoom-friendly).
//
// Coordinate convention:
//   State plan coords: (x, y) where y is depth (north-south).
//   SVG coords: (svgX, svgY) where svgY goes DOWN.
//   We invert y at write time so north points UP on the page.
//
// Layout: room outline + zones + sources + listeners + scale bar +
// north arrow. ViewBox is sized to room bbox plus a 1-metre margin
// so legend annotations don't crowd the room edge.

import { expandSources, colorForGroup, colorForZone } from '../app-state.js';

const MARGIN_M = 1.0;
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

// Build the room-outline path. Returns an SVG element string
// (or empty on degenerate state). Coordinate frame is the same as
// the rest of the SVG — caller has already applied the +MARGIN_M
// translation by passing offsetX / offsetY.
function buildRoomOutline(room, depth_m, offsetX, offsetY) {
  const stroke = '#222';
  const sw = 0.06; // 6 cm in plan, scales as a hairline at print DPI
  if (room.shape === 'rectangular') {
    return `<rect x="${offsetX.toFixed(3)}" y="${offsetY.toFixed(3)}" width="${room.width_m.toFixed(3)}" height="${room.depth_m.toFixed(3)}" fill="#fafafa" stroke="${stroke}" stroke-width="${sw}" />`;
  }
  if (room.shape === 'polygon') {
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
    return `<polygon points="${pts.join(' ')}" fill="#fafafa" stroke="${stroke}" stroke-width="${sw}" />`;
  }
  if (room.shape === 'round') {
    const cx = room.width_m / 2 + offsetX;
    const cy = room.depth_m / 2 + offsetY;
    return `<circle cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" r="${room.round_radius_m.toFixed(3)}" fill="#fafafa" stroke="${stroke}" stroke-width="${sw}" />`;
  }
  if (room.shape === 'custom') {
    const verts = room.custom_vertices || [];
    if (verts.length < 3) return '';
    const pts = verts.map(v => {
      const sx = v.x + offsetX;
      const sy = (depth_m - v.y) + offsetY;
      return `${sx.toFixed(3)},${sy.toFixed(3)}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="#fafafa" stroke="${stroke}" stroke-width="${sw}" />`;
  }
  return '';
}

// Convert state-frame (x_m, y_m) to SVG-frame (sx, sy) with y flipped
// so north points up on the printed page.
function projectXY(x_m, y_m, depth_m, offsetX, offsetY) {
  return {
    sx: x_m + offsetX,
    sy: (depth_m - y_m) + offsetY,
  };
}

// Build the SVG floor plan as a string. Caller wraps in their own
// container (the print page slot is sized via CSS).
//
// Returns empty string if room is degenerate (no width / depth).
export function buildFloorPlanSVG(state, opts = {}) {
  const room = state.room;
  if (!room || !(room.width_m > 0) || !(room.depth_m > 0)) return '';

  const offsetX = MARGIN_M;
  const offsetY = MARGIN_M;
  const viewW = room.width_m + 2 * MARGIN_M;
  const viewH = room.depth_m + 2 * MARGIN_M;
  const depth_m = room.depth_m;

  const roomEl = buildRoomOutline(room, depth_m, offsetX, offsetY);

  // Zone fills + centroid labels.
  const zonesEl = (state.zones || []).map((z, idx) => {
    if (!z.vertices || z.vertices.length < 3) return '';
    const color = colorForZone(idx);
    const pts = z.vertices.map(v => {
      const p = projectXY(v.x, v.y, depth_m, offsetX, offsetY);
      return `${p.sx.toFixed(3)},${p.sy.toFixed(3)}`;
    }).join(' ');
    // Centroid for label placement.
    const sumX = z.vertices.reduce((a, v) => a + v.x, 0) / z.vertices.length;
    const sumY = z.vertices.reduce((a, v) => a + v.y, 0) / z.vertices.length;
    const c = projectXY(sumX, sumY, depth_m, offsetX, offsetY);
    return `<polygon points="${pts}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="0.04" />`
      + `<text x="${c.sx.toFixed(3)}" y="${c.sy.toFixed(3)}" font-size="0.45" text-anchor="middle" fill="#222">${escapeText(z.label || z.id)}</text>`;
  }).join('');

  // Sources — filled circles, group-tinted, indexed labels. Line arrays
  // expand to per-element circles so the user can see the column.
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
      sourcePieces.push(`<circle cx="${p.sx.toFixed(3)}" cy="${p.sy.toFixed(3)}" r="0.28" fill="${color}" stroke="#000" stroke-width="0.04" />`);
      sourcePieces.push(`<text x="${(p.sx + 0.42).toFixed(3)}" y="${(p.sy + 0.13).toFixed(3)}" font-size="0.42" fill="#000">${label}</text>`);
    });
  }
  const sourcesEl = sourcePieces.join('');

  // Listeners — equilateral triangles pointing up. Distinct from
  // source circles so the plan is readable in monochrome print too.
  const listenersEl = (state.listeners || []).map(l => {
    const px = l.position?.x;
    const py = l.position?.y;
    if (px == null || py == null) return '';
    const p = projectXY(px, py, depth_m, offsetX, offsetY);
    const r = 0.32;
    const tri = `${p.sx.toFixed(3)},${(p.sy - r).toFixed(3)} `
      + `${(p.sx + r * 0.866).toFixed(3)},${(p.sy + r * 0.5).toFixed(3)} `
      + `${(p.sx - r * 0.866).toFixed(3)},${(p.sy + r * 0.5).toFixed(3)}`;
    return `<polygon points="${tri}" fill="#0a8a4a" stroke="#000" stroke-width="0.04" />`
      + `<text x="${(p.sx + 0.55).toFixed(3)}" y="${(p.sy + 0.13).toFixed(3)}" font-size="0.42" fill="#0a4d28">${escapeText(l.label || l.id)}</text>`;
  }).join('');

  // Scale bar — chosen from a "nice" set so the labelled length is
  // legible (1 m / 5 m / 10 m). Bar is positioned bottom-left INSIDE
  // the SVG margin so it doesn't intrude on the room outline.
  const barLen = pickScaleBar(room.width_m);
  const barX = offsetX + 0.3;
  const barY = viewH - 0.5;
  const tickH = 0.18;
  const scaleBarEl = `
    <g class="pr-plan-scalebar">
      <line x1="${barX.toFixed(3)}" y1="${barY.toFixed(3)}" x2="${(barX + barLen).toFixed(3)}" y2="${barY.toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <line x1="${barX.toFixed(3)}" y1="${(barY - tickH).toFixed(3)}" x2="${barX.toFixed(3)}" y2="${(barY + tickH).toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <line x1="${(barX + barLen).toFixed(3)}" y1="${(barY - tickH).toFixed(3)}" x2="${(barX + barLen).toFixed(3)}" y2="${(barY + tickH).toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <text x="${(barX + barLen / 2).toFixed(3)}" y="${(barY - 0.3).toFixed(3)}" font-size="0.42" text-anchor="middle" fill="#000">${barLen} m</text>
    </g>`;

  // North arrow — top-right inside the SVG margin.
  const naSize = 0.65;
  const naX = viewW - 0.8;
  const naY = offsetY + 0.55;
  const northArrowEl = `
    <g class="pr-plan-northarrow">
      <polygon points="${naX.toFixed(3)},${(naY - naSize).toFixed(3)} ${(naX + naSize * 0.45).toFixed(3)},${(naY + naSize * 0.25).toFixed(3)} ${naX.toFixed(3)},${(naY + naSize * 0.05).toFixed(3)} ${(naX - naSize * 0.45).toFixed(3)},${(naY + naSize * 0.25).toFixed(3)}" fill="#000" />
      <text x="${naX.toFixed(3)}" y="${(naY + naSize * 0.75).toFixed(3)}" font-size="0.42" text-anchor="middle" fill="#000">N</text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW.toFixed(3)} ${viewH.toFixed(3)}" preserveAspectRatio="xMidYMid meet" class="pr-plan-svg">${roomEl}${zonesEl}${sourcesEl}${listenersEl}${scaleBarEl}${northArrowEl}</svg>`;
}

// Build a small legend block (paste-ready HTML) that names the symbol
// conventions on the plan. Caller decides whether to render this beside
// the SVG; the print stylesheet positions it as a side column.
export function buildFloorPlanLegend() {
  return `
    <div class="pr-plan-legend">
      <div class="pr-plan-legend-row">
        <svg class="pr-plan-legend-icon" viewBox="0 0 1 1"><circle cx="0.5" cy="0.5" r="0.42" fill="#1f5faa" stroke="#000" stroke-width="0.06" /></svg>
        <span>Source (per element)</span>
      </div>
      <div class="pr-plan-legend-row">
        <svg class="pr-plan-legend-icon" viewBox="0 0 1 1"><polygon points="0.5,0.1 0.93,0.85 0.07,0.85" fill="#0a8a4a" stroke="#000" stroke-width="0.06" /></svg>
        <span>Listener</span>
      </div>
      <div class="pr-plan-legend-row">
        <svg class="pr-plan-legend-icon" viewBox="0 0 1 1"><rect x="0.1" y="0.1" width="0.8" height="0.8" fill="#a855f7" fill-opacity="0.3" stroke="#a855f7" stroke-width="0.05" /></svg>
        <span>Audience zone</span>
      </div>
      <div class="pr-plan-legend-note">North = +y (state coords). Distances in metres. Scale bar drawn in plan units.</div>
    </div>`;
}
