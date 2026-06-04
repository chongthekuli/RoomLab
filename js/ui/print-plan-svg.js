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
import { wallInsetPolygon, wallLabelAnchor, WALL_LABEL_MAX_CHARS } from '../physics/wall-inset.js';
import { roomEffectiveBounds } from '../physics/room-shape.js';
import { getMaterialHatchKind } from '../labs/walllab/material-family-hatch.js';
import { renderRackFootprintSVG, lookupRackDef } from '../graphics/rack-2d.js';
import { getRackCatalogue } from '../labs/devicelab/catalog.js';

// 1.5m margin gives the North arrow + scale bar enough room to live
// fully inside the top-right and bottom-left margin bands without ever
// overlapping the room outline — even for tiny (1-2m wide) rooms.
const MARGIN_M = 1.5;
const NICE_BAR_M = [0.5, 1, 2, 5, 10, 20, 50];

// --------------------------------------------------------------------
// Wall hatch SVG <pattern> defs — print plan (Maya, Phase 7 Commit 4).
//
// MONOCHROME by contract — fabricators print on black-and-white office
// machines. Pattern dimensions are in METRES (the print SVG viewBox is
// metres), so the hatch period is constant in real-world units (3 cm
// stripes regardless of room size). userSpaceOnUse so the pattern
// doesn't distort with the polygon's aspect ratio.
//
// IDs are prefixed `pr-` to namespace away from the 2D viewport's
// inline defs (same SVG document can't host two patterns with the same
// id without the second silently overriding).
// --------------------------------------------------------------------
const WALL_HATCH_DEFS_PRINT = `
  <pattern id="pr-hatch-solid-dark" width="0.04" height="0.04" patternUnits="userSpaceOnUse">
    <rect width="0.04" height="0.04" fill="#2a2a2a" />
  </pattern>
  <pattern id="pr-hatch-diagonal" width="0.06" height="0.06" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="0.06" height="0.06" fill="#dcdcdc" />
    <line x1="0" y1="0" x2="0" y2="0.06" stroke="#3a3a3a" stroke-width="0.008" />
  </pattern>
  <pattern id="pr-hatch-outline" width="0.04" height="0.04" patternUnits="userSpaceOnUse">
    <rect width="0.04" height="0.04" fill="#ffffff" fill-opacity="0" />
  </pattern>
  <pattern id="pr-hatch-openair" width="0.04" height="0.04" patternUnits="userSpaceOnUse">
    <rect width="0.04" height="0.04" fill="#ffffff" fill-opacity="0" />
  </pattern>
  <pattern id="pr-hatch-unknown" width="0.05" height="0.05" patternUnits="userSpaceOnUse">
    <rect width="0.05" height="0.05" fill="#efefef" />
    <circle cx="0.025" cy="0.025" r="0.006" fill="#888888" />
  </pattern>
`;

function printHatchFor(kind) {
  switch (kind) {
    case 'solid-dark':     return { fill: 'url(#pr-hatch-solid-dark)', draw: true,  stroke: '#1c1c1c' };
    case 'diagonal-hatch': return { fill: 'url(#pr-hatch-diagonal)',   draw: true,  stroke: '#3a3a3a' };
    case 'outline-only':   return { fill: 'url(#pr-hatch-outline)',    draw: true,  stroke: '#3a3a3a' };
    case 'open-air':       return { fill: 'url(#pr-hatch-openair)',    draw: false, stroke: '#bbbbbb' };
    case 'unknown':
    default:               return { fill: 'url(#pr-hatch-unknown)',    draw: true,  stroke: '#888888' };
  }
}

// matIdOf — same shape as the room-2d.js helper. Resolves a slot
// (string or { materialId, ... }) to a materialId string.
function matIdOfPrint(slot, fallback = 'gypsum-board') {
  if (typeof slot === 'string') return slot;
  if (slot && typeof slot === 'object' && typeof slot.materialId === 'string') return slot.materialId;
  return fallback;
}

// Optional materials reference for label name lookup. The print report
// (print-report.js) calls buildFloorPlanSVG with opts.materialsRef when
// available; the fallback is the materialId itself.
function nameOfPrint(materialsRef, id) {
  return materialsRef?.byId?.[id]?.name || id || '';
}

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

// Build the room walls — Phase 7 Commit 4 (Maya).
//
// Walls render as FILLED RECTANGLES (trapezoids at corners with
// varying thickness) using the family hatch from
// material-family-hatch.js. The outer polygon comes from
// wallInsetPolygon(); the inner polygon comes from the same call. ALL
// thickness math funnels through wall-inset.js — Sam's anti-leak grep
// would catch any raw `thickness_m / 2` etc.
//
// Returns { walls, labels } as concatenated SVG strings (both pure
// strings, no DOM). Caller composes them into the page.
//
// Coordinate convention (matches the rest of this file):
//   state +x → SVG +x at `x + offsetX`
//   state +y → SVG -y at `anchorY - y` (Y-flip: state y=0 sits at the
//                                       BOTTOM of the room band on the
//                                       printed page)
function buildWallThicknessSVG(room, offsetX, anchorY, materialsRef) {
  if (!room) return { walls: '', labels: '' };
  const inset = wallInsetPolygon(room);
  const outer = inset.outer || [];
  const inner = inset.inner || [];
  const thicknesses = inset.thicknesses || [];
  const n = outer.length;
  if (n < 3 || inner.length !== n) return { walls: '', labels: '' };

  const shape = room.shape ?? 'rectangular';
  const surfaces = room.surfaces || {};

  // State → SVG mapping (metric units throughout).
  const sxOf = (xm) => xm + offsetX;
  const syOf = (ym) => anchorY - ym;

  // Resolve per-edge materialId in CCW order — matches wall-inset.js
  // rectEdgeSlotKey for rectangular, surfaces.edges[i] for custom,
  // surfaces.walls (shared) for polygon / round.
  function edgeMaterialId(i) {
    if (shape === 'rectangular') {
      const key = ['wall_north', 'wall_east', 'wall_south', 'wall_west'][i & 3];
      return matIdOfPrint(surfaces[key]);
    }
    if (shape === 'custom') {
      const edges = surfaces.edges || [];
      return matIdOfPrint(edges[i]);
    }
    return matIdOfPrint(surfaces.walls ?? surfaces.wall_north);
  }

  let walls = '';
  let labels = '';
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const A = { x: sxOf(outer[i].x), y: syOf(outer[i].y) };
    const B = { x: sxOf(outer[j].x), y: syOf(outer[j].y) };
    const C = { x: sxOf(inner[j].x), y: syOf(inner[j].y) };
    const D = { x: sxOf(inner[i].x), y: syOf(inner[i].y) };
    const matId = edgeMaterialId(i);
    const kind = getMaterialHatchKind(matId);
    const skin = printHatchFor(kind);
    if (!skin.draw) continue;
    const pts = `${A.x.toFixed(3)},${A.y.toFixed(3)} ${B.x.toFixed(3)},${B.y.toFixed(3)} ${C.x.toFixed(3)},${C.y.toFixed(3)} ${D.x.toFixed(3)},${D.y.toFixed(3)}`;
    walls += `<polygon points="${pts}" fill="${skin.fill}" stroke="${skin.stroke}" stroke-width="0.018" stroke-linejoin="miter" />`;

    // Per-wall material label — INSIDE face, edge midpoint, offset
    // inward by thickness/2 + 10 mm gap via wallLabelAnchor. Truncate
    // to WALL_LABEL_MAX_CHARS. Y-flip → negate rotation_deg so the
    // text rides the wall direction visually.
    const stateEdge = { v1: outer[i], v2: outer[j] };
    const tEdge = Number.isFinite(thicknesses[i]) ? thicknesses[i] : 0.10;
    const anchor = wallLabelAnchor(stateEdge, tEdge);
    const labelTxt = String(nameOfPrint(materialsRef, matId)).slice(0, WALL_LABEL_MAX_CHARS);
    if (labelTxt) {
      const lsx = sxOf(anchor.x);
      const lsy = syOf(anchor.y);
      const rot = -anchor.rotation_deg;
      labels += `<text x="${lsx.toFixed(3)}" y="${lsy.toFixed(3)}" transform="rotate(${rot.toFixed(2)} ${lsx.toFixed(3)} ${lsy.toFixed(3)})" font-size="0.22" text-anchor="middle" fill="#1a1a1a">${escapeText(labelTxt)}</text>`;
    }
  }
  return { walls, labels };
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
  const materialsRef = opts.materialsRef || null;
  const room = state.room;
  if (!room || !(room.width_m > 0) || !(room.depth_m > 0)) return '';

  // Size the viewBox to the room's TRUE effective bounds so nothing
  // renders off-page AND the room sits centered with equal margins.
  // roomEffectiveBounds folds in the surau podium extension (state-x goes
  // negative when podium.extension_m > 0; arcade speakers/listeners live
  // at negative or past-wall coords) AND any custom-polygon vertex in
  // negative space (the 2D editor allows it; see clampVertexDragTarget).
  //
  // Use b.min/b.max DIRECTLY — do NOT min/max against (0, width_m). That
  // origin assumption padded a phantom dead-band from world (0,0) to a
  // custom room drawn/dragged at an offset, pushing it to one edge of the
  // page and distorting the aspect (the "doesn't fit the frame" bug,
  // 2026-06-04 — same fix applied to print-heatmap.js). For a plain
  // rectangular room b collapses to (0,0)→(width,depth), so this is
  // byte-identical to the legacy layout. (No podiumExt re-add —
  // roomEffectiveBounds already includes it.)
  const b = roomEffectiveBounds(room);
  const minX = b.minX, minY = b.minY;
  const maxX = b.maxX, maxY = b.maxY;
  const offsetX = MARGIN_M - minX;
  const viewW = (maxX - minX) + 2 * MARGIN_M;
  const viewH = (maxY - minY) + 2 * MARGIN_M;
  // Y-flip anchor: SVG pixel where world-Y=0 lands. The room band is
  // centered between MARGIN_M and viewH-MARGIN_M; world-Y=maxY (north
  // podium edge) renders at SVG y=MARGIN_M. So world-Y=0 renders at
  // SVG y=MARGIN_M + maxY = anchorY.
  const anchorY = MARGIN_M + maxY;

  const wallParts = buildWallThicknessSVG(room, offsetX, anchorY, materialsRef);
  const roomEl = wallParts.walls;
  const wallLabelsEl = wallParts.labels;

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

  // PA equipment racks — closed-footprint top-down via the shared
  // helper (js/graphics/rack-2d.js). Same visual cues as the 2D
  // viewport: thicker FRONT-edge stroke + hinge dot at front-LEFT
  // corner. Parity guaranteed by tests/cross-surface-conventions.test.mjs.
  // Print stroke is monochrome (the print report is BW-fabricator-friendly
  // by contract — see WALL_HATCH_DEFS_PRINT note above).
  // Caller may pass opts.rackCatalogue to inject the catalogue (Node
  // tests do this); falls back to the live sync getter for the browser
  // (catalogue is loaded before the print iframe renders).
  const rackCatalogue = opts.rackCatalogue || getRackCatalogue();
  const rackEl = (() => {
    const racks = state.rackSystem?.racks;
    if (!Array.isArray(racks) || racks.length === 0 || !rackCatalogue) return '';
    // Use a single isotropic m→px factor of 1 — the print SVG viewBox
    // is in METRES already (1 SVG unit = 1 m). So pixel-space helpers
    // collapse to identity in this surface; the projection just shifts
    // the centre into the viewBox via projectXY().
    const mToPx = 1;
    let s = '';
    for (const r of racks) {
      if (!r || !r.position) continue;
      const def = lookupRackDef(rackCatalogue, r.rackModelKey);
      if (!def) continue;
      const p = projectXY(r.position.x, r.position.y, anchorY, offsetX);
      const label = r.label || def.label || r.rackModelKey || '';
      s += renderRackFootprintSVG(r, def, {
        cxPx: p.sx, cyPx: p.sy, mToPx,
      }, {
        // Print is monochrome by contract — no selection halo, no
        // colour-coded fill. Light grey body, black side stroke, thicker
        // black front-line, black hinge dot. Same kind / family as walls.
        fill: '#dadce0',
        stroke: '#1c1c1c',
        frontStroke: '#000000',
        hingeFill: '#000000',
        // lineScale = 1 — stroke widths in metres match the print SVG's
        // metric viewBox (6 cm front-edge line, 1.5 cm side stroke).
        lineScale: 1,
        label,
        labelFontPx: 0.32,        // metres — readable but small
        labelFill: '#1a1a1a',
      });
    }
    return s;
  })();

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

  // Hatch <defs> for the wall fills — monochrome by contract (see
  // WALL_HATCH_DEFS_PRINT comment above). Defs are inside the SVG so
  // the print pipeline rasterises them with the rest of the document
  // (a separate <svg defs> would be lost when the report node is
  // cloned into the print iframe).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW.toFixed(3)} ${viewH.toFixed(3)}" preserveAspectRatio="xMidYMid meet" class="pr-plan-svg"><defs>${WALL_HATCH_DEFS_PRINT}</defs>${roomEl}${zonesEl}${minaretEl}${rackEl}${sourcesEl}${listenersEl}${wallLabelsEl}${scaleBarEl}</svg>`;
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
