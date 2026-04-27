// Printable scene report (Q1 #2).
//
// Click 🖨 (or Cmd/Ctrl-P) → builds a hidden DOM tree containing room
// dimensions, RT60 per band, source list, listener list, zone list,
// ambient noise — formatted for A4 portrait printout — then calls
// window.print(). The screen DOM stays untouched; @media print CSS
// hides everything except #print-report when the print pipeline runs.
//
// Maya's BLOCKER: every numeric column carries units (s, dB, °, m, Hz).
// A printed report attached to a BOMBA submission without units is a
// liability.
//
// Martina's HIGH: no globally-on `preserveDrawingBuffer`. We don't
// raster the WebGL canvas in v1 — pure tables only. A future commit
// can add a snapshot path with proper beforeprint/afterprint cleanup.

import { state, earHeightFor, expandSources, POSTURE_LABELS } from '../app-state.js';
import { computeAllBands } from '../physics/rt60.js';
import { roomVolume, baseArea } from '../physics/room-shape.js';

// Build the data model the print DOM will render. Pure function — no
// DOM access — so tests can verify the shape without a headless browser.
//
// `materials` is the shape returned by loadMaterials() — has .byId and
// .frequency_bands_hz. `nameHint` is an optional project-name override
// (for now we use a default; future commit will wire an inline-editable
// project title in the room-panel header).
export function buildPrintModel({ materials, nameHint } = {}) {
  const rt60Bands = computeAllBands({ room: state.room, materials, zones: state.zones });
  const totalArea = rt60Bands[0]?.totalArea_m2 ?? 0;
  const volume = roomVolume(state.room);
  const flatSources = expandSources(state.sources ?? []);

  return {
    project: {
      name: nameHint || 'untitled scene',
      date: new Date().toISOString().slice(0, 10),
      formatVersion: 1,
    },
    room: {
      shape: state.room.shape,
      width_m: state.room.width_m,
      depth_m: state.room.depth_m,
      height_m: state.room.height_m,
      volume_m3: volume,
      baseArea_m2: baseArea(state.room),
      totalArea_m2: totalArea,
      ceiling_type: state.room.ceiling_type,
      meanAbsorption_1k: rt60Bands[3]?.meanAbsorption ?? 0,
    },
    rt60: rt60Bands.map(b => ({
      freq_hz: b.frequency_hz,
      sabine_s: Number.isFinite(b.sabine_s) ? b.sabine_s : null,
      eyring_s: Number.isFinite(b.eyring_s) ? b.eyring_s : null,
      meanAbsorption: b.meanAbsorption,
    })),
    sources: (state.sources ?? []).map((s, i) => ({
      index: i + 1,
      kind: s.kind ?? 'speaker',
      modelUrl: s.modelUrl ?? '—',
      x: (s.position?.x ?? s.origin?.x) ?? null,
      y: (s.position?.y ?? s.origin?.y) ?? null,
      z: (s.position?.z ?? s.origin?.z) ?? null,
      yaw_deg: s.aim?.yaw ?? s.baseYaw_deg ?? null,
      pitch_deg: s.aim?.pitch ?? s.topTilt_deg ?? null,
      power_w: s.power_watts ?? s.power_watts_each ?? null,
      groupId: s.groupId ?? null,
    })),
    listeners: (state.listeners ?? []).map(l => ({
      id: l.id,
      label: l.label,
      x: l.position?.x ?? null,
      y: l.position?.y ?? null,
      elevation_m: l.elevation_m ?? 0,
      posture: POSTURE_LABELS[l.posture] ?? l.posture,
      earHeight_m: earHeightFor(l),
    })),
    zones: (state.zones ?? []).map(z => ({
      id: z.id,
      label: z.label,
      vertices_n: (z.vertices ?? []).length,
      elevation_m: z.elevation_m ?? 0,
      material_id: z.material_id ?? '—',
      occupancy_percent: z.occupancy_percent ?? 0,
    })),
    ambient: {
      preset: state.physics?.ambientNoise?.preset ?? 'nc-35',
      per_band: state.physics?.ambientNoise?.per_band ?? [],
    },
    sourceFlat: {
      total: flatSources.length,
      raw: state.sources?.length ?? 0,
      lineArrays: (state.sources ?? []).filter(s => s?.kind === 'line-array').length,
    },
  };
}

// Helpers for table-cell rendering with units already attached.
function fmt(v, decimals = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(decimals);
}
function fmtBand(hz) {
  return hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
}

// Render the print model into a styled DOM tree. Called once per
// print invocation — we tear down + rebuild rather than caching, so
// the data is always fresh (a user editing then immediately printing
// gets the current state, not a stale snapshot).
function renderPrintReport(model) {
  let root = document.getElementById('print-report');
  if (root) root.remove();
  root = document.createElement('div');
  root.id = 'print-report';

  const sec = (title, body) => `<section class="pr-section"><h2>${title}</h2>${body}</section>`;

  const rt60Rows = model.rt60.map(r => `
    <tr>
      <td>${fmtBand(r.freq_hz)}</td>
      <td>${fmt(r.sabine_s, 2)} s</td>
      <td>${fmt(r.eyring_s, 2)} s</td>
      <td>${fmt(r.meanAbsorption, 3)}</td>
    </tr>`).join('');

  const sourceRows = model.sources.map(s => `
    <tr>
      <td>${s.index}</td>
      <td>${s.kind === 'line-array' ? 'line-array' : 'speaker'}</td>
      <td class="pr-mono">${(s.modelUrl ?? '—').replace(/.*\//, '').replace(/\.json$/, '')}</td>
      <td>${fmt(s.x, 2)} m</td>
      <td>${fmt(s.y, 2)} m</td>
      <td>${fmt(s.z, 2)} m</td>
      <td>${fmt(s.yaw_deg, 0)}°</td>
      <td>${fmt(s.pitch_deg, 0)}°</td>
      <td>${fmt(s.power_w, 0)} W</td>
      <td>${s.groupId ?? '—'}</td>
    </tr>`).join('');

  const listenerRows = model.listeners.map(l => `
    <tr>
      <td class="pr-mono">${l.id}</td>
      <td>${escapeHtml(l.label ?? '')}</td>
      <td>${fmt(l.x, 2)} m</td>
      <td>${fmt(l.y, 2)} m</td>
      <td>${fmt(l.elevation_m, 2)} m</td>
      <td>${escapeHtml(l.posture ?? '')}</td>
      <td>${fmt(l.earHeight_m, 2)} m</td>
    </tr>`).join('');

  const zoneRows = model.zones.map(z => `
    <tr>
      <td class="pr-mono">${z.id}</td>
      <td>${escapeHtml(z.label ?? '')}</td>
      <td>${z.vertices_n}</td>
      <td>${fmt(z.elevation_m, 2)} m</td>
      <td>${escapeHtml(z.material_id ?? '')}</td>
      <td>${fmt(z.occupancy_percent, 0)} %</td>
    </tr>`).join('');

  const ambientRow = (model.ambient.per_band ?? []).map((v, i) => {
    const hz = model.rt60[i]?.freq_hz ?? '?';
    return `<td>${fmt(v, 0)} dB</td>`;
  }).join('');
  const ambientHeader = (model.ambient.per_band ?? []).map((_, i) => {
    const hz = model.rt60[i]?.freq_hz;
    return `<th>${hz ? fmtBand(hz) : '?'}</th>`;
  }).join('');

  root.innerHTML = `
    <header class="pr-head">
      <h1>RoomLAB design summary</h1>
      <div class="pr-meta">
        <span><strong>Project:</strong> ${escapeHtml(model.project.name)}</span>
        <span><strong>Date:</strong> ${model.project.date}</span>
        <span><strong>Schema:</strong> v${model.project.formatVersion}</span>
      </div>
    </header>

    ${sec('Room', `
      <table class="pr-table pr-kv">
        <tr><th>Shape</th><td>${model.room.shape}</td></tr>
        <tr><th>Dimensions (W × D × H)</th><td>${fmt(model.room.width_m, 2)} × ${fmt(model.room.depth_m, 2)} × ${fmt(model.room.height_m, 2)} m</td></tr>
        <tr><th>Floor area</th><td>${fmt(model.room.baseArea_m2, 1)} m²</td></tr>
        <tr><th>Volume</th><td>${fmt(model.room.volume_m3, 0)} m³</td></tr>
        <tr><th>Total interior surface area</th><td>${fmt(model.room.totalArea_m2, 0)} m²</td></tr>
        <tr><th>Mean absorption (1 kHz)</th><td>${fmt(model.room.meanAbsorption_1k, 3)}</td></tr>
        <tr><th>Ceiling type</th><td>${model.room.ceiling_type}</td></tr>
      </table>
    `)}

    ${sec('Reverberation time', `
      <table class="pr-table">
        <thead><tr><th>Band</th><th>Sabine</th><th>Eyring</th><th>Mean α</th></tr></thead>
        <tbody>${rt60Rows}</tbody>
      </table>
      <p class="pr-note">Sabine assumes a diffuse field; Eyring corrects for high mean absorption (α &gt; 0.2). RT60 figures here are the draft engine; precision-engine values, when computed, supersede.</p>
    `)}

    ${sec(`Sources (${model.sourceFlat.raw} entr${model.sourceFlat.raw === 1 ? 'y' : 'ies'}, ${model.sourceFlat.total} radiating element${model.sourceFlat.total === 1 ? '' : 's'})`, `
      ${model.sources.length === 0 ? '<p class="pr-note">no sources placed.</p>' : `
        <table class="pr-table pr-source-table">
          <thead><tr><th>#</th><th>Kind</th><th>Model</th><th>X</th><th>Y</th><th>Z</th><th>Yaw</th><th>Pitch</th><th>Power</th><th>Group</th></tr></thead>
          <tbody>${sourceRows}</tbody>
        </table>
      `}
    `)}

    ${sec(`Listeners (${model.listeners.length})`, `
      ${model.listeners.length === 0 ? '<p class="pr-note">no listeners placed.</p>' : `
        <table class="pr-table">
          <thead><tr><th>ID</th><th>Label</th><th>X</th><th>Y</th><th>Elevation</th><th>Posture</th><th>Ear height</th></tr></thead>
          <tbody>${listenerRows}</tbody>
        </table>
      `}
    `)}

    ${sec(`Audience zones (${model.zones.length})`, `
      ${model.zones.length === 0 ? '<p class="pr-note">no audience zones defined.</p>' : `
        <table class="pr-table">
          <thead><tr><th>ID</th><th>Label</th><th>Vertices</th><th>Elevation</th><th>Material</th><th>Occupancy</th></tr></thead>
          <tbody>${zoneRows}</tbody>
        </table>
      `}
    `)}

    ${ambientHeader ? sec('Ambient noise floor', `
      <table class="pr-table">
        <thead><tr><th>Preset</th>${ambientHeader}</tr></thead>
        <tbody><tr><td class="pr-mono">${escapeHtml(model.ambient.preset)}</td>${ambientRow}</tr></tbody>
      </table>
      <p class="pr-note">Per-band noise floor used as the N term in STIPA (IEC 60268-16) and the ambient subtraction in the heatmap.</p>
    `) : ''}

    <footer class="pr-foot">
      <span>roomlab — <span class="pr-mono">chongthekuli.github.io/RoomLab</span></span>
      <span class="pr-pageno">page <span class="pr-page-current"></span></span>
    </footer>
  `;
  document.body.appendChild(root);
  return root;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let _printMaterialsRef = null;

// Public entry — wired up from panel-room.js when the user clicks 🖨.
// Renders a fresh print DOM, calls window.print(), tears down on
// afterprint. Cmd/Ctrl-P also triggers via the same path because
// `beforeprint` listens regardless of how print was initiated.
export function triggerPrint() {
  if (!_printMaterialsRef) {
    console.warn('[print-report] mountPrintReport() never called — materials reference missing');
    return;
  }
  const model = buildPrintModel({ materials: _printMaterialsRef });
  renderPrintReport(model);
  // Defer to next frame so the DOM is in the document before the print
  // dialog reads layout — Chromium otherwise rasterises mid-mount.
  requestAnimationFrame(() => {
    window.print();
  });
}

// Mount the print integration. Called once at boot from main.js.
export function mountPrintReport({ materials }) {
  _printMaterialsRef = materials;

  // Browser-initiated print (Cmd/Ctrl-P) — render the DOM before the
  // print dialog reads layout. This is what makes the Cmd/Ctrl-P
  // shortcut "just work" without us hijacking the keystroke.
  window.addEventListener('beforeprint', () => {
    if (!_printMaterialsRef) return;
    if (document.getElementById('print-report')) return; // already rendered (button path)
    const model = buildPrintModel({ materials: _printMaterialsRef });
    renderPrintReport(model);
  });

  // Tear down after print so the DOM doesn't accumulate stale entries
  // across multiple print runs.
  window.addEventListener('afterprint', () => {
    document.getElementById('print-report')?.remove();
  });
}
