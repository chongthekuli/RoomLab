import { state } from '../app-state.js';
import { on } from '../ui/events.js';

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

export function mount2DViewport({ materials }) {
  materialsRef = materials;
  render();
  on('room:changed', render);
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

  vp.innerHTML = `
    <div class="viewport-2d">
      <div class="vp-header">Floor plan — top-down view</div>
      <svg viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet">
        <rect x="${x0}" y="${y0}" width="${pxW}" height="${pxD}"
              fill="${colorFor(alphaOf(fl))}" fill-opacity="0.15" rx="2" />

        <line x1="${x0}"       y1="${y0}"       x2="${x0 + pxW}" y2="${y0}"
              stroke="${colorFor(alphaOf(wN))}" stroke-width="8" stroke-linecap="round" />
        <line x1="${x0}"       y1="${y0 + pxD}" x2="${x0 + pxW}" y2="${y0 + pxD}"
              stroke="${colorFor(alphaOf(wS))}" stroke-width="8" stroke-linecap="round" />
        <line x1="${x0 + pxW}" y1="${y0}"       x2="${x0 + pxW}" y2="${y0 + pxD}"
              stroke="${colorFor(alphaOf(wE))}" stroke-width="8" stroke-linecap="round" />
        <line x1="${x0}"       y1="${y0}"       x2="${x0}"       y2="${y0 + pxD}"
              stroke="${colorFor(alphaOf(wW))}" stroke-width="8" stroke-linecap="round" />

        <text x="${x0 + pxW/2}" y="${y0 - 22}"        text-anchor="middle" class="vp-lbl vp-lbl-wall">Front — ${nameOf(wN)}</text>
        <text x="${x0 + pxW/2}" y="${y0 + pxD + 34}"  text-anchor="middle" class="vp-lbl vp-lbl-wall">Back — ${nameOf(wS)}</text>
        <text x="${x0 + pxW + 18}" y="${y0 + pxD/2 + 4}" text-anchor="start"  class="vp-lbl vp-lbl-wall">Right — ${nameOf(wE)}</text>
        <text x="${x0 - 18}"       y="${y0 + pxD/2 + 4}" text-anchor="end"    class="vp-lbl vp-lbl-wall">Left — ${nameOf(wW)}</text>

        <text x="${x0 + pxW/2}" y="${y0 + pxD/2 - 10}" text-anchor="middle" class="vp-lbl vp-lbl-center">Floor: ${nameOf(fl)}</text>
        <text x="${x0 + pxW/2}" y="${y0 + pxD/2 + 10}" text-anchor="middle" class="vp-lbl vp-lbl-center">Ceiling: ${nameOf(cl)}</text>
        <text x="${x0 + pxW/2}" y="${y0 + pxD/2 + 30}" text-anchor="middle" class="vp-lbl vp-lbl-dim">Height ${h} m</text>

        <text x="${x0 + pxW/2}" y="${vbH - 20}" text-anchor="middle" class="vp-lbl vp-lbl-dim">${w} m wide</text>
        <text x="30" y="${y0 + pxD/2}" text-anchor="middle" class="vp-lbl vp-lbl-dim" transform="rotate(-90 30 ${y0 + pxD/2})">${d} m deep</text>
      </svg>
      <div class="vp-legend">
        ${COLOR_BANDS.map(b => `<span class="legend-item"><span class="swatch" style="background:${b.color}"></span>${b.label}</span>`).join('')}
      </div>
      <div class="vp-note">Wall &amp; floor color = absorption at 500 Hz. Interactive 3D view coming in Phase 3.</div>
    </div>
  `;
}
