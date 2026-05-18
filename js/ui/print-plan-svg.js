// SVG floor plan renderer for the print report.
//
// Pure function: takes (state) → returns SVG string. No DOM, no
// Three.js — runs in Node tests too. The print report inlines the
// returned string into the page-2 placeholder so the browser print
// pipeline rasterises it as vector (sharp at any DPI, BOMBA-reviewer
// zoom-friendly).
//
// Coordinate convention (v=458, Lindqvist Y-flip):
//   State plan coords: (x, y) where y is depth (north-south, +y = north).
//   SVG coords: (svgX, svgY) where svgY goes DOWN.
//   We invert y at write time so north (large state y) renders at the
//   TOP of the page. Matches the live 2D plan in room-2d.js exactly.
//
// Layout: room outline + zones + sources + listeners + scale bar +
// north arrow. ViewBox is sized to room bbox plus a 1-metre margin
// so legend annotations don't crowd the room edge.

import { expandSources, colorForGroup, colorForZone } from '../app-state.js';

// 1.5m margin gives the North arrow + scale bar enough room to live
// fully inside the top-right and bottom-left margin bands without ever
// overlapping the room outline — even for tiny (1-2m wide) rooms.
const MARGIN_M = 1.5;
const NICE_BAR_M = [0.5, 1, 2, 5, 10, 20, 50];

function escapeText(s) {
  if (s == null) return '';
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Format the SPL / STI text that sits under a listener marker. Empty
// string when neither metric is available — caller skips the <text>.
function formatPrintListenerMetrics(m) {
  if (!m) return '';
  const parts = [];
  if (Number.isFinite(m.spl_db)) parts.push(`${m.spl_db.toFixed(0)} dB`);
  if (Number.isFinite(m.sti))    parts.push(`STI ${m.sti.toFixed(2)}`);
  return parts.join(' · ');
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
// (or empty on degenerate state). Caller passes `anchorY` = the SVG
// pixel y where world-Y=0 lives (bottom edge of the effective room
// band). Every world-Y is mapped to `anchorY - y_m` so larger world Y
// renders HIGHER on the page (math convention; v=458 Y-flip).
function buildRoomOutline(room, offsetX, anchorY) {
  const stroke = '#222';
  const sw = 0.06; // 6 cm in plan, scales as a hairline at print DPI
  if (room.shape === 'rectangular') {
    // Rect top-left is at (offsetX, anchorY - depth_m).
    return `<rect x="${offsetX.toFixed(3)}" y="${(anchorY - room.depth_m).toFixed(3)}" width="${room.width_m.toFixed(3)}" height="${room.depth_m.toFixed(3)}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
  }
  if (room.shape === 'polygon') {
    const cx = room.width_m / 2 + offsetX;
    const cy = anchorY - room.depth_m / 2;
    const r = room.polygon_radius_m;
    const N = room.polygon_sides;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
      // World vertex = (cx_world + r*cos, cy_world + r*sin). Map cx
      // directly (X-axis unchanged) and subtract sin since world +Y
      // now maps to SVG -Y. For symmetric N-gons (even sides) the
      // result is visually identical to the previous render; odd-N
      // polygons flip mirror-image, as expected.
      const py = cy - r * Math.sin(angle);
      const px = cx + r * Math.cos(angle);
      pts.push(`${px.toFixed(3)},${py.toFixed(3)}`);
    }
    return `<polygon points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
  }
  if (room.shape === 'round') {
    const cx = room.width_m / 2 + offsetX;
    const cy = anchorY - room.depth_m / 2;
    return `<circle cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" r="${room.round_radius_m.toFixed(3)}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
  }
  if (room.shape === 'custom') {
    const verts = room.custom_vertices || [];
    if (verts.length < 3) return '';
    const pts = verts.map(v => {
      const sx = v.x + offsetX;
      const sy = anchorY - v.y;
      return `${sx.toFixed(3)},${sy.toFixed(3)}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
  }
  return '';
}

// State y grows toward the north / FRONT wall. SVG y grows DOWN. We
// invert y so state +y renders UP the page — math convention, matching
// the live 2D plan in room-2d.js.
//
// Signature note: the third arg used to be `depth_m`. With the Y-flip
// the world→SVG anchor is `anchorY` = SVG pixel where world-Y=0 sits
// (i.e. the bottom edge of the room band on the printed page).
function projectXY(x_m, y_m, anchorY, offsetX) {
  return {
    sx: x_m + offsetX,
    sy: anchorY - y_m,
  };
}

// Aim-triangle builder: apex points in the source yaw direction.
// Source aim yaw=0 fires along state +y (north / toward the FRONT
// wall). After the Y-flip, state +y maps to SVG -y (page-up), so the
// SVG-pixel aim vector is (sin yaw, -cos yaw). yaw=180 (fires south /
// toward BACK) → apex points DOWN on the page.
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

// Build the SVG floor plan as a string. Caller wraps in their own
// container (the print page slot is sized via CSS).
//
// Returns empty string if room is degenerate (no width / depth).
export function buildFloorPlanSVG(state, opts = {}) {
  const listenerMetrics = Array.isArray(opts.listenerMetrics) ? opts.listenerMetrics : null;
  const room = state.room;
  if (!room || !(room.width_m > 0) || !(room.depth_m > 0)) return '';

  // Surau podium pushes the visible footprint past the room walls
  // (state-x can go negative when podium.extension_m > 0; arcade
  // speakers/listeners live at negative or past-wall coords). Expand
  // the SVG viewBox to capture everything; non-surau presets keep
  // the legacy minX=0, maxX=width_m bounds so this is a no-op.
  const podiumExt = room?.surauStructure?.podium?.extension_m;
  const ext = Number.isFinite(podiumExt) && podiumExt > 0 ? podiumExt : 0;
  const minX = -ext, minY = -ext;
  const maxX = room.width_m + ext, maxY = room.depth_m + ext;
  const offsetX = MARGIN_M - minX;
  const viewW = (maxX - minX) + 2 * MARGIN_M;
  const viewH = (maxY - minY) + 2 * MARGIN_M;
  // Y-flip anchor: SVG pixel where world-Y=0 lands. The room band is
  // centered between MARGIN_M and viewH-MARGIN_M; world-Y=maxY (north
  // podium edge) renders at SVG y=MARGIN_M. So world-Y=0 renders at
  // SVG y=MARGIN_M + maxY = anchorY.
  const anchorY = MARGIN_M + maxY;

  const roomEl = buildRoomOutline(room, offsetX, anchorY);

  // Zone fills + centroid labels.
  const zonesEl = (state.zones || []).map((z, idx) => {
    if (!z.vertices || z.vertices.length < 3) return '';
    const color = colorForZone(idx);
    const pts = z.vertices.map(v => {
      const p = projectXY(v.x, v.y, anchorY, offsetX);
      return `${p.sx.toFixed(3)},${p.sy.toFixed(3)}`;
    }).join(' ');
    // Centroid for label placement.
    const sumX = z.vertices.reduce((a, v) => a + v.x, 0) / z.vertices.length;
    const sumY = z.vertices.reduce((a, v) => a + v.y, 0) / z.vertices.length;
    const c = projectXY(sumX, sumY, anchorY, offsetX);
    return `<polygon points="${pts}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="0.04" />`
      + `<text x="${c.sx.toFixed(3)}" y="${c.sy.toFixed(3)}" font-size="0.45" text-anchor="middle" fill="#222">${escapeText(z.label || z.id)}</text>`;
  }).join('');

  // Sources — triangles pointing in the aim direction (matches the
  // live 2D viewport: sources radiate, listeners receive). Line arrays
  // expand to per-element triangles so the user can see the column.
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
      sourcePieces.push(`<polygon points="${tri}" fill="${color}" stroke="#000" stroke-width="0.04" />`);
      sourcePieces.push(`<text x="${(p.sx + 0.48).toFixed(3)}" y="${(p.sy + 0.13).toFixed(3)}" font-size="0.42" fill="#000">${label}</text>`);
    });
  }
  const sourcesEl = sourcePieces.join('');

  // Listeners — circles. Distinct from source triangles so the plan
  // is readable in monochrome print too.
  const listenersEl = (state.listeners || []).map((l, idx) => {
    const px = l.position?.x;
    const py = l.position?.y;
    if (px == null || py == null) return '';
    const p = projectXY(px, py, anchorY, offsetX);
    const r = 0.26;
    const circle = `<circle cx="${p.sx.toFixed(3)}" cy="${p.sy.toFixed(3)}" r="${r}" fill="#0a8a4a" stroke="#000" stroke-width="0.04" />`;
    const label = `<text x="${(p.sx + 0.42).toFixed(3)}" y="${(p.sy + 0.13).toFixed(3)}" font-size="0.42" fill="#0a4d28">${escapeText(l.label || l.id)}</text>`;
    const metricsStr = formatPrintListenerMetrics(listenerMetrics?.[idx]);
    const metricsTxt = metricsStr
      ? `<text x="${(p.sx + 0.42).toFixed(3)}" y="${(p.sy + 0.62).toFixed(3)}" font-size="0.36" fill="#0a4d28">${escapeText(metricsStr)}</text>`
      : '';
    return circle + label + metricsTxt;
  }).join('');

  // Surau minaret — filled mid-grey square + crescent (or dome) glyph
  // at the outdoor corner specified by surauStructure.minaret.corner.
  // Mirrors the live 2D viewport rendering so the printed plan stays
  // consistent. Per Viktor 2026-05-18: scope = minaret only.
  const minaretEl = (() => {
    const mn = state.room?.surauStructure?.minaret;
    if (!mn) return '';
    const W = state.room.width_m, D = state.room.depth_m;
    const baseSize = Number.isFinite(mn.base_size_m) ? mn.base_size_m : 1.2;
    const clearance = 0.6 + baseSize / 2;
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
    const pts = corners.map(c => {
      const p = projectXY(c.x, c.y, anchorY, offsetX);
      return `${p.sx.toFixed(3)},${p.sy.toFixed(3)}`;
    }).join(' ');
    const c = projectXY(co.x, co.y, anchorY, offsetX);
    const cap = mn.cap_style || 'mustaka';
    const glyph = cap === 'crescent' ? '☪'
                : cap === 'dome' || cap === 'mustaka' ? '◯'
                : '■';
    return `<polygon points="${pts}" fill="#9a9a9a" stroke="#3a3a3a" stroke-width="0.04" />`
         + `<text x="${c.sx.toFixed(3)}" y="${(c.sy + 0.18).toFixed(3)}" font-size="0.55" text-anchor="middle" fill="#1a1a1a">${glyph}</text>`;
  })();

  // Scale bar — chosen from a "nice" set so the labelled length is
  // legible (1 m / 5 m / 10 m). Lives in the BOTTOM margin band, fully
  // below the room outline — bar + label + ticks all clear the room
  // edge by ≥0.2m for any room size.
  const barLen = pickScaleBar(room.width_m);
  const barX = offsetX;                   // left-aligned with room
  const barY = viewH - MARGIN_M * 0.35;   // bar in bottom margin (0.525m up from bottom edge)
  const tickH = 0.15;
  const scaleBarEl = `
    <g class="pr-plan-scalebar">
      <line x1="${barX.toFixed(3)}" y1="${barY.toFixed(3)}" x2="${(barX + barLen).toFixed(3)}" y2="${barY.toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <line x1="${barX.toFixed(3)}" y1="${(barY - tickH).toFixed(3)}" x2="${barX.toFixed(3)}" y2="${(barY + tickH).toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <line x1="${(barX + barLen).toFixed(3)}" y1="${(barY - tickH).toFixed(3)}" x2="${(barX + barLen).toFixed(3)}" y2="${(barY + tickH).toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <text x="${(barX + barLen / 2).toFixed(3)}" y="${(barY - 0.28).toFixed(3)}" font-size="0.42" text-anchor="middle" fill="#000">${barLen} m</text>
    </g>`;

  // North arrow — top-right corner. Center placed in the top margin
  // band so the arrow tip + body + 'N' label all clear the room top
  // edge. With MARGIN=1.5 and naSize=0.55: tip at y=0.2, body bottom
  // at y≈0.78, N text baseline at y≈1.16 — room top is at y=1.5, so
  // ~0.34m clearance. Horizontally placed 0.7m from right SVG edge,
  // which keeps the arrow body fully past the room's right edge.
  // North arrow REMOVED from SVG content as of 2026-05-17 — was scaling
  // with the room (large room → tiny arrow). Print containers render
  // the arrow as a fixed-CSS-pixel HTML overlay (see print.css for
  // .pr-cover-hero-plan::after / .pr-heatmap-stage::after).

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW.toFixed(3)} ${viewH.toFixed(3)}" preserveAspectRatio="xMidYMid meet" class="pr-plan-svg">${roomEl}${zonesEl}${minaretEl}${sourcesEl}${listenersEl}${scaleBarEl}</svg>`;
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
