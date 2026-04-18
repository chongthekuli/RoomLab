import { state, earHeightFor, getSelectedListener } from '../app-state.js';
import { on } from '../ui/events.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { computeSPLGrid } from '../physics/spl-calculator.js';
import { roomPlanVertices, isInsideRoom } from '../physics/room-shape.js';

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

export function mount2DViewport({ materials }) {
  materialsRef = materials;
  render();
  on('room:changed', render);
  on('source:changed', render);
  on('source:model_changed', render);
  on('listener:changed', render);
  on('listener:selected', render);
  window.addEventListener('resize', render);
}

function roomToSvg(x0, y0, pxW, pxD, room, x, y) {
  return { sx: x0 + (x / room.width_m) * pxW, sy: y0 + (y / room.depth_m) * pxD };
}

function render() {
  const vp = document.getElementById('view-2d');
  const { width_m: w, depth_m: d, height_m: h, surfaces, shape } = state.room;

  if (!(w > 0 && d > 0 && h > 0)) {
    vp.innerHTML = `<div class="viewport-2d"><div class="vp-header">Enter positive room dimensions</div></div>`;
    return;
  }

  const bandIdx = materialsRef.frequency_bands_hz.indexOf(500);
  const useIdx = bandIdx >= 0 ? bandIdx : Math.floor(materialsRef.frequency_bands_hz.length / 2);
  const alphaOf = id => materialsRef.byId[id]?.absorption[useIdx] ?? 0;
  const nameOf = id => materialsRef.byId[id]?.name ?? id;

  const vbW = 800, vbH = 500;
  const pad = 90;
  const scale = Math.min((vbW - pad * 2) / w, (vbH - pad * 2) / d);
  const pxW = w * scale;
  const pxD = d * scale;
  const x0 = (vbW - pxW) / 2;
  const y0 = (vbH - pxD) / 2;

  const ear = earHeightFor(getSelectedListener());

  let splResult = null;
  let splSvg = '';
  if (state.sources.length > 0) {
    splResult = computeSPLGrid({
      sources: state.sources,
      getSpeakerDef: url => getCachedLoudspeaker(url),
      room: state.room, gridSize: 25, freq_hz: 1000, earHeight_m: ear,
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

  const speakerSvg = state.sources.length > 0
    ? renderSpeakersSVG(state.sources, x0, y0, pxW, pxD, state.room)
    : '';

  const listenerSvg = state.listeners.length > 0
    ? renderListenersSVG(state.listeners, state.selectedListenerId, x0, y0, pxW, pxD, state.room)
    : '';

  const shapeLbl = shape === 'rectangular'
    ? `${w} m wide · ${d} m deep`
    : shape === 'polygon'
      ? `${state.room.polygon_sides}-gon · radius ${state.room.polygon_radius_m} m`
      : `round · radius ${state.room.round_radius_m} m`;
  const ceilLbl = state.room.ceiling_type === 'dome'
    ? ` · domed ceiling (rise ${state.room.ceiling_dome_rise_m} m)`
    : '';

  vp.innerHTML = `
    <div class="viewport-2d">
      <div class="vp-header">Floor plan — top-down view (heatmap @ ${ear.toFixed(2)} m ear height)</div>
      <svg viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet">
        <defs>${clipPathSvg}</defs>
        ${roomOutline.floorFill}
        <g clip-path="url(#room-clip)">${splSvg}</g>
        ${roomOutline.walls}
        ${roomOutline.labels}
        ${listenerSvg}
        ${speakerSvg}
        <text x="${x0 + pxW/2}" y="${vbH - 20}" text-anchor="middle" class="vp-lbl vp-lbl-dim">${shapeLbl} · h ${h} m · Floor: ${nameOf(surfaces.floor)} · Ceiling: ${nameOf(surfaces.ceiling)}${ceilLbl}</text>
      </svg>
      ${renderLegend(splResult)}
      <div class="vp-note">${splResult ? `SPL heatmap sums all speakers · white triangles = speakers · yellow circle = selected listener` : 'Add a source to see SPL coverage.'}</div>
    </div>
  `;
}

function renderClipPath(room, x0, y0, pxW, pxD) {
  const verts = roomPlanVertices(room);
  const points = verts.map(v => {
    const sx = x0 + (v.x / room.width_m) * pxW;
    const sy = y0 + (v.y / room.depth_m) * pxD;
    return `${sx.toFixed(1)},${sy.toFixed(1)}`;
  }).join(' ');
  return `<clipPath id="room-clip"><polygon points="${points}" /></clipPath>`;
}

function renderRoomOutline(room, x0, y0, pxW, pxD, alphaOf, nameOf, surfaces) {
  const shape = room.shape ?? 'rectangular';
  const verts = roomPlanVertices(room);
  const svgPts = verts.map(v => ({
    sx: x0 + (v.x / room.width_m) * pxW,
    sy: y0 + (v.y / room.depth_m) * pxD,
  }));

  if (shape === 'rectangular') {
    const wN = surfaces.wall_north, wS = surfaces.wall_south;
    const wE = surfaces.wall_east,  wW = surfaces.wall_west;
    const floorFill = `<rect x="${x0}" y="${y0}" width="${pxW}" height="${pxD}"
              fill="${colorFor(alphaOf(surfaces.floor))}" fill-opacity="0.15" rx="2" />`;
    const walls = `
      <line x1="${x0}" y1="${y0}" x2="${x0 + pxW}" y2="${y0}"
            stroke="${colorFor(alphaOf(wN))}" stroke-width="8" stroke-linecap="round" />
      <line x1="${x0}" y1="${y0 + pxD}" x2="${x0 + pxW}" y2="${y0 + pxD}"
            stroke="${colorFor(alphaOf(wS))}" stroke-width="8" stroke-linecap="round" />
      <line x1="${x0 + pxW}" y1="${y0}" x2="${x0 + pxW}" y2="${y0 + pxD}"
            stroke="${colorFor(alphaOf(wE))}" stroke-width="8" stroke-linecap="round" />
      <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + pxD}"
            stroke="${colorFor(alphaOf(wW))}" stroke-width="8" stroke-linecap="round" />
    `;
    const labels = `
      <text x="${x0 + pxW/2}" y="${y0 - 22}" text-anchor="middle" class="vp-lbl vp-lbl-wall">Front — ${nameOf(wN)}</text>
      <text x="${x0 + pxW/2}" y="${y0 + pxD + 34}" text-anchor="middle" class="vp-lbl vp-lbl-wall">Back — ${nameOf(wS)}</text>
      <text x="${x0 + pxW + 18}" y="${y0 + pxD/2 + 4}" text-anchor="start" class="vp-lbl vp-lbl-wall">Right — ${nameOf(wE)}</text>
      <text x="${x0 - 18}" y="${y0 + pxD/2 + 4}" text-anchor="end" class="vp-lbl vp-lbl-wall">Left — ${nameOf(wW)}</text>
    `;
    return { floorFill, walls, labels };
  }

  // Polygon or round: single walls material, single outline
  const pointsAttr = svgPts.map(p => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ');
  const wallsMat = surfaces.walls ?? surfaces.wall_north ?? 'gypsum-board';
  const floorFill = `<polygon points="${pointsAttr}" fill="${colorFor(alphaOf(surfaces.floor))}" fill-opacity="0.15" />`;
  const walls = `<polygon points="${pointsAttr}" fill="none" stroke="${colorFor(alphaOf(wallsMat))}" stroke-width="8" stroke-linejoin="round" />`;

  // Single top label
  const centerX = svgPts.reduce((s, p) => s + p.sx, 0) / svgPts.length;
  const topY = Math.min(...svgPts.map(p => p.sy));
  const labels = `<text x="${centerX.toFixed(1)}" y="${(topY - 22).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-wall">Walls — ${nameOf(wallsMat)}</text>`;
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
    const outside = !isInsideRoom(src.position.x, src.position.y, room);
    const fill = outside ? '#ff5a3c' : '#fff';
    const stroke = outside ? '#8a1200' : '#000';

    const yaw_rad = src.aim.yaw * Math.PI / 180;
    const size = 13;
    const aimX = Math.sin(yaw_rad);
    const aimY = Math.cos(yaw_rad);
    const rightX = Math.cos(yaw_rad);
    const rightY = -Math.sin(yaw_rad);

    const tip = { x: sx + size * aimX, y: sy + size * aimY };
    const bl  = { x: sx - size * 0.5 * aimX - size * 0.6 * rightX,
                  y: sy - size * 0.5 * aimY - size * 0.6 * rightY };
    const br  = { x: sx - size * 0.5 * aimX + size * 0.6 * rightX,
                  y: sy - size * 0.5 * aimY + size * 0.6 * rightY };

    s += `<polygon points="${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${bl.x.toFixed(1)},${bl.y.toFixed(1)} ${br.x.toFixed(1)},${br.y.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" />`;
    s += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="2" fill="${stroke}" />`;
    const lblFill = outside ? '#ff5a3c' : '#fff';
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
    return `<div class="vp-legend spl-legend">
      <span class="legend-label">SPL</span>
      <span class="legend-range">${splResult.minSPL_db.toFixed(0)} dB</span>
      <span class="legend-bar"></span>
      <span class="legend-range">${splResult.maxSPL_db.toFixed(0)} dB</span>
    </div>`;
  }
  return `<div class="vp-legend">
    ${COLOR_BANDS.map(b => `<span class="legend-item"><span class="swatch" style="background:${b.color}"></span>${b.label}</span>`).join('')}
  </div>`;
}
