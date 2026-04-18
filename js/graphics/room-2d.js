import { state } from '../app-state.js';
import { on } from '../ui/events.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { computeSPLGrid } from '../physics/spl-calculator.js';

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
  window.addEventListener('resize', render);
}

function render() {
  const vp = document.getElementById('viewport');
  const { width_m: w, depth_m: d, height_m: h, surfaces } = state.room;

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

  const wN = surfaces.wall_north, wS = surfaces.wall_south;
  const wE = surfaces.wall_east,  wW = surfaces.wall_west;
  const fl = surfaces.floor,      cl = surfaces.ceiling;

  let splResult = null;
  let splSvg = '';
  if (state.sources.length > 0) {
    const src = state.sources[0];
    const def = getCachedLoudspeaker(src.modelUrl);
    if (def) {
      splResult = computeSPLGrid({
        speakerDef: def, speakerState: src,
        room: state.room, gridSize: 25, freq_hz: 1000,
      });
      state.results.splGrid = splResult;
      splSvg = renderHeatmapSVG(splResult, x0, y0, pxW, pxD);
    }
  } else {
    state.results.splGrid = null;
  }

  const speakerSvg = state.sources.length > 0
    ? renderSpeakersSVG(state.sources, x0, y0, pxW, pxD, w, d)
    : '';

  vp.innerHTML = `
    <div class="viewport-2d">
      <div class="vp-header">Floor plan — top-down view</div>
      <svg viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet">
        <rect x="${x0}" y="${y0}" width="${pxW}" height="${pxD}"
              fill="${colorFor(alphaOf(fl))}" fill-opacity="0.15" rx="2" />
        ${splSvg}
        <line x1="${x0}" y1="${y0}" x2="${x0 + pxW}" y2="${y0}"
              stroke="${colorFor(alphaOf(wN))}" stroke-width="8" stroke-linecap="round" />
        <line x1="${x0}" y1="${y0 + pxD}" x2="${x0 + pxW}" y2="${y0 + pxD}"
              stroke="${colorFor(alphaOf(wS))}" stroke-width="8" stroke-linecap="round" />
        <line x1="${x0 + pxW}" y1="${y0}" x2="${x0 + pxW}" y2="${y0 + pxD}"
              stroke="${colorFor(alphaOf(wE))}" stroke-width="8" stroke-linecap="round" />
        <line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + pxD}"
              stroke="${colorFor(alphaOf(wW))}" stroke-width="8" stroke-linecap="round" />

        <text x="${x0 + pxW/2}" y="${y0 - 22}" text-anchor="middle" class="vp-lbl vp-lbl-wall">Front — ${nameOf(wN)}</text>
        <text x="${x0 + pxW/2}" y="${y0 + pxD + 34}" text-anchor="middle" class="vp-lbl vp-lbl-wall">Back — ${nameOf(wS)}</text>
        <text x="${x0 + pxW + 18}" y="${y0 + pxD/2 + 4}" text-anchor="start" class="vp-lbl vp-lbl-wall">Right — ${nameOf(wE)}</text>
        <text x="${x0 - 18}" y="${y0 + pxD/2 + 4}" text-anchor="end" class="vp-lbl vp-lbl-wall">Left — ${nameOf(wW)}</text>

        ${speakerSvg}

        <text x="${x0 + pxW/2}" y="${vbH - 20}" text-anchor="middle" class="vp-lbl vp-lbl-dim">${w} m wide · Floor: ${nameOf(fl)} · Ceiling: ${nameOf(cl)}</text>
        <text x="30" y="${y0 + pxD/2}" text-anchor="middle" class="vp-lbl vp-lbl-dim" transform="rotate(-90 30 ${y0 + pxD/2})">${d} m deep</text>
      </svg>
      ${renderLegend(splResult)}
      <div class="vp-note">${splResult ? `SPL heatmap @ 1 kHz, ear height 1.2 m · triangle = speaker (tip points along aim)` : 'Add a source in the Sources panel to see SPL coverage.'}</div>
    </div>
  `;
}

function renderHeatmapSVG(splResult, x0, y0, pxW, pxD) {
  const { grid, cellsX, cellsY } = splResult;
  const cw = pxW / cellsX;
  const ch = pxD / cellsY;
  let s = '';
  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++) {
      const spl = grid[j][i];
      s += `<rect x="${(x0 + i * cw).toFixed(2)}" y="${(y0 + j * ch).toFixed(2)}" width="${(cw + 0.5).toFixed(2)}" height="${(ch + 0.5).toFixed(2)}" fill="${splColor(spl)}" fill-opacity="0.55" />`;
    }
  }
  return s;
}

function renderSpeakersSVG(sources, x0, y0, pxW, pxD, roomW, roomD) {
  let s = '';
  sources.forEach((src, i) => {
    const sx = x0 + (src.position.x / roomW) * pxW;
    const sy = y0 + (src.position.y / roomD) * pxD;
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

    s += `<polygon points="${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${bl.x.toFixed(1)},${bl.y.toFixed(1)} ${br.x.toFixed(1)},${br.y.toFixed(1)}" fill="#fff" stroke="#000" stroke-width="1.5" />`;
    s += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="2" fill="#000" />`;
    s += `<text x="${sx.toFixed(1)}" y="${(sy - 18).toFixed(1)}" text-anchor="middle" class="vp-lbl vp-lbl-spk">S${i + 1}</text>`;
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
