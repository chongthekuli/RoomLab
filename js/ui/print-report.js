// Printable scene report (Q1 #2) — proposal-ready edition.
//
// Click 🖨 (or Cmd/Ctrl-P) → builds a hidden DOM tree formatted for
// A4 portrait printout, then calls window.print(). The screen DOM
// stays untouched; @media print CSS hides everything except
// #print-report when the print pipeline runs.
//
// Layout follows Maya's page spec (post-specialist review):
//   page 1 — cover + executive summary + key-figures tile grid
//   page 2 — room geometry + reverberation
//   page 3 — sources + Bill of Materials + per-element placement
//   page 4 — listeners + audience zones + ambient noise
//   page 5 — precision-engine results (placeholder when not yet run)
//   page 6 — methodology, references, disclaimers, reviewer's note
//
// Methodology + disclaimers ratified by Dr. Chen (acoustics-engineer)
// against ISO 3382-1, IEC 60268-16, ISO 9613-1, Beranek 2nd ed.,
// Kuttruff 6th ed., Sabine 1900, Eyring 1930. Citations preserved
// inline so a reviewing engineer can trace each number to its source.
//
// Maya's BLOCKER: every numeric column carries units already embedded
// in the data layer (s, dB, °, m, Hz, %). Single source of truth —
// CSS doesn't add unit suffixes that could drift.
//
// Martina's HIGH respected: NO globally-on preserveDrawingBuffer.
// v1 ships pure tables + future SVG plan; no WebGL canvas raster.

import { state, earHeightFor, expandSources, POSTURE_LABELS, SPEAKER_CATALOG } from '../app-state.js';
import { computeAllBands } from '../physics/rt60.js';
import { roomVolume, baseArea } from '../physics/room-shape.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { computeSPLGrid, computeRoomConstant } from '../physics/spl-calculator.js';
import { deriveMetrics } from '../physics/precision/derive-metrics.js';
import { buildHeatmapPageSVG, buildHeatmapLegend } from './print-heatmap.js';
import { getAcceptanceTimestamp } from './welcome-card.js';

// ---------------------------------------------------------------------------
// buildPrintModel — pure data function (testable without a headless browser).
// Returns the full structured payload the renderer consumes, including
// derived figures (BOM aggregation, critical distance, Schroeder cutoff)
// and a normalised view of any precision-engine results currently held
// on state.results.precision.
// ---------------------------------------------------------------------------
export function buildPrintModel({ materials, nameHint } = {}) {
  const rt60Bands = computeAllBands({ room: state.room, materials, zones: state.zones });
  const totalArea = rt60Bands[0]?.totalArea_m2 ?? 0;
  const volume = roomVolume(state.room);
  const flatSources = expandSources(state.sources ?? []);
  const meanAlpha1k = rt60Bands[3]?.meanAbsorption ?? 0;
  const t60_1k = rt60Bands[3]?.eyring_s ?? rt60Bands[3]?.sabine_s ?? null;

  // Critical distance r_c = 0.057·√(Q·V/T60). Q derived from a scene-
  // average DI of 3 dB (omnidirectional baseline) since per-source DI
  // is a flat scalar in the current speaker JSONs (Dr. Chen P3
  // simplification). We surface r_c as a single scene-level figure
  // rather than per-source — clients use it as a "where does the
  // direct field stop dominating" diagnostic, not a placement number.
  const Q_avg = 2; // 10^(DI_dB/10) for DI ≈ 3 dB
  const criticalDistance_m = (t60_1k && t60_1k > 0 && volume > 0)
    ? 0.057 * Math.sqrt((Q_avg * volume) / t60_1k)
    : null;

  // Schroeder cutoff f_s = 2000·√(T60/V). Below this frequency the
  // room is modal; statistical-acoustics figures lose physical meaning.
  const schroederCutoff_hz = (t60_1k && t60_1k > 0 && volume > 0)
    ? 2000 * Math.sqrt(t60_1k / volume)
    : null;

  // SPL heatmap grid. Re-uses the cached state.results.splGrid when the
  // user has already visited the 2D viewport this session — that grid
  // matches what they see on screen exactly. When no grid is cached
  // (e.g., the user opens print straight from the 3D view), we compute
  // a fresh one at print resolution so the report never ships with an
  // empty hero page. Honours the active heatmap mode (SPL / STIPA) via
  // state.display.heatmapMode.
  const splGrid = ensurePrintSplGrid({ materials, t60_1k });

  return {
    project: {
      name: nameHint || state.projectName || 'untitled scene',
      date: new Date().toISOString().slice(0, 10),
      generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      schemaVersion: 1,
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
      meanAbsorption_1k: meanAlpha1k,
    },
    rt60: rt60Bands.map(b => ({
      freq_hz: b.frequency_hz,
      sabine_s: Number.isFinite(b.sabine_s) ? b.sabine_s : null,
      eyring_s: Number.isFinite(b.eyring_s) ? b.eyring_s : null,
      meanAbsorption: b.meanAbsorption,
      airAbsorption_sabins: b.airAbsorption_sabins ?? 0,
    })),
    sources: (state.sources ?? []).map((s, i) => ({
      index: i + 1,
      kind: s.kind ?? 'speaker',
      modelUrl: s.modelUrl ?? '—',
      modelLabel: getSpeakerLabel(s.modelUrl),
      x: (s.position?.x ?? s.origin?.x) ?? null,
      y: (s.position?.y ?? s.origin?.y) ?? null,
      z: (s.position?.z ?? s.origin?.z) ?? null,
      yaw_deg: s.aim?.yaw ?? s.baseYaw_deg ?? null,
      pitch_deg: s.aim?.pitch ?? s.topTilt_deg ?? null,
      power_w: s.power_watts ?? s.power_watts_each ?? null,
      groupId: s.groupId ?? null,
    })),
    bom: aggregateBOM(state.sources ?? []),
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
    precision: extractPrecisionResults(state, materials),
    sourceFlat: {
      total: flatSources.length,
      raw: state.sources?.length ?? 0,
      lineArrays: (state.sources ?? []).filter(s => s?.kind === 'line-array').length,
    },
    derived: {
      criticalDistance_m,
      schroederCutoff_hz,
      Q_assumed: Q_avg,
      DI_assumed_db: 3,
    },
    // Heatmap METADATA only — keeps the model JSON-serialisable under
    // the 50 KB print-report budget (a 60×60 grid would not fit). The
    // grid blob is recomputed at render time via ensurePrintSplGrid.
    heatmap: splGrid ? {
      metric: splGrid.metric ?? 'spl',
      freq_hz: splGrid.freq_hz ?? 1000,
      earHeight_m: splGrid.earHeight_m ?? null,
      minSPL_db: splGrid.minSPL_db,
      maxSPL_db: splGrid.maxSPL_db,
      avgSPL_db: splGrid.avgSPL_db,
      sourceCount: splGrid.sourceCount ?? 0,
    } : null,
  };
}

// Build (or reuse) the SPL grid used for the print-report hero
// heatmap. Keeps the render pure — never mutates state.results.
function ensurePrintSplGrid({ materials, t60_1k }) {
  const cached = state.results?.splGrid;
  const hasSources = (state.sources ?? []).length > 0;
  if (!hasSources) return null;
  if (cached && cached.grid && cached.cellsX > 0 && cached.cellsY > 0
      && (cached.sourceCount ?? 0) > 0) {
    return cached;
  }
  // Compute fresh. Match the same parameters the 2D viewport uses so
  // the printed heatmap is byte-for-byte the on-screen heatmap.
  try {
    const earH = state.listeners?.[0] ? earHeightFor(state.listeners[0]) : 1.2;
    const includeReverb = !!state.physics?.reverberantField;
    const coherent = !!state.physics?.coherent;
    const airAbs = state.physics?.airAbsorption !== false;
    let R = 0;
    if (includeReverb && t60_1k && t60_1k > 0 && materials) {
      try { R = computeRoomConstant({ room: state.room, materials, T60_s: t60_1k }); }
      catch (_) { R = 0; }
    }
    return computeSPLGrid({
      sources: state.sources ?? [],
      getSpeakerDef: getCachedLoudspeaker,
      room: state.room,
      earHeight_m: earH,
      gridSize: 60,             // Sofia spec: print-resolution raster
      freq_hz: state.physics?.freq_hz ?? 1000,
      roomConstantR: R,
      coherent,
      airAbsorption: airAbs,
      metric: 'spl',
    });
  } catch (err) {
    console.warn('[print-report] heatmap grid compute failed:', err);
    return null;
  }
}

// Aggregate sources into a Bill of Materials. One row per unique model
// URL. Line-array entries expand to their element count for the qty.
// `groups` collects every distinct groupId the model is assigned to in
// the scene. `power_each_w` is the per-element rated input.
//
// Refused (Maya): a price column. RoomLAB does not own pricing data;
// shipping a price field invents authority we don't have.
function aggregateBOM(sources) {
  const byModel = new Map();
  for (const s of sources) {
    const url = s?.modelUrl;
    if (!url) continue;
    let qty = 1;
    let powerEach = s.power_watts ?? null;
    if (s.kind === 'line-array') {
      const splays = s.splayAnglesDeg ?? [];
      qty = (s.elementCount ?? splays.length + 1);
      powerEach = s.power_watts_each ?? null;
    }
    const groupId = s.groupId ?? null;
    const key = url;
    let row = byModel.get(key);
    if (!row) {
      row = {
        modelUrl: url,
        modelLabel: getSpeakerLabel(url),
        qty: 0,
        power_each_w: powerEach,
        total_power_w: 0,
        groupIds: new Set(),
      };
      byModel.set(key, row);
    }
    row.qty += qty;
    if (powerEach != null) row.total_power_w += qty * powerEach;
    if (groupId) row.groupIds.add(groupId);
  }
  return Array.from(byModel.values()).map(row => ({
    modelUrl: row.modelUrl,
    modelLabel: row.modelLabel,
    qty: row.qty,
    power_each_w: row.power_each_w,
    total_power_w: row.total_power_w || null,
    groups: Array.from(row.groupIds).sort().join(', ') || '—',
  })).sort((a, b) => b.qty - a.qty);
}

function getSpeakerLabel(url) {
  if (!url) return '—';
  const entry = SPEAKER_CATALOG.find(c => c.url === url);
  if (entry?.label) return entry.label;
  // Fallback: basename stripped of .json + path.
  return url.replace(/.*\//, '').replace(/\.json$/, '');
}

// Pull precision results into the shape the renderer wants. Returns
// null when no render has been performed; renderer shows the empty-
// state placeholder in that case (Lin's copy).
//
// `state.results.precision` holds the FULL precision-engine render
// object (histograms, BVH refs, scene, etc.) — not the derived
// per-receiver metrics. `deriveMetrics(result)` is what unpacks it
// into the [{receiverIdx, perBand, broadband, sti}, …] array we
// want here. (Caught in user testing: print said "not yet computed"
// even after a successful render because we were checking
// Array.isArray on an object.)
function extractPrecisionResults(s, materials) {
  const result = s.results?.precision;
  if (!result || typeof result !== 'object') return null;
  let metrics;
  try {
    metrics = deriveMetrics(result, {
      ambientNoise_per_band: s.physics?.ambientNoise?.per_band,
    });
  } catch (err) {
    console.warn('[print-report] deriveMetrics failed:', err);
    return null;
  }
  if (!Array.isArray(metrics) || metrics.length === 0) return null;

  const bandsHz = materials?.frequency_bands_hz ?? [125, 250, 500, 1000, 2000, 4000, 8000];
  return {
    available: true,
    bands_hz: bandsHz,
    receivers: metrics.map((m, i) => ({
      index: i,
      label: s.listeners?.[i]?.label ?? `Listener ${i + 1}`,
      broadband: {
        edt_s:  Number.isFinite(m.broadband?.edt_s)  ? m.broadband.edt_s  : null,
        t20_s:  Number.isFinite(m.broadband?.t20_s)  ? m.broadband.t20_s  : null,
        t30_s:  Number.isFinite(m.broadband?.t30_s)  ? m.broadband.t30_s  : null,
        c80_db: Number.isFinite(m.broadband?.c80_db) ? m.broadband.c80_db : null,
        c50_db: Number.isFinite(m.broadband?.c50_db) ? m.broadband.c50_db : null,
        dr_db:  Number.isFinite(m.broadband?.dr_db)  ? m.broadband.dr_db  : null,
      },
      sti: Number.isFinite(m.sti?.sti) ? m.sti.sti : null,
      perBand: (m.perBand ?? []).map((b, idx) => ({
        freq_hz: bandsHz[idx] ?? null,
        t30_s:  Number.isFinite(b.t30_s)  ? b.t30_s  : null,
        c80_db: Number.isFinite(b.c80_db) ? b.c80_db : null,
        c50_db: Number.isFinite(b.c50_db) ? b.c50_db : null,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Methodology block — Dr. Chen's authoritative copy. Inline as a
// constant so the report always carries the same standards mapping
// regardless of state. Each entry: (heading, citation, method).
// ---------------------------------------------------------------------------
const METHODOLOGY_ENTRIES = [
  ['Room volume',
    'ISO 3382-1 §3.1; geometric (Euclidean).',
    'Polygon prism + spherical-cap dome; structural concrete (bowl tiers, concourse, columns, slabs, cores) subtracted from gross volume.'],
  ['Interior surface area',
    'Sabine 1900; Beranek 2nd ed. §7.2.',
    'Sum of all wall, floor, ceiling, slab, soffit, column, partition and fixture faces; both faces of internal partitions counted; atrium voids excluded.'],
  ['Mean absorption ᾱ',
    'ISO 354:2003 (reverberation-room values); Beranek tab. 7-3.',
    'ᾱₖ = Σ(αᵢₖ·Sᵢ) / ΣSᵢ at each octave centre; seated-audience coefficient blends with seat material per ISO 3382-1 by occupancy fraction.'],
  ['RT60 — Sabine',
    'Sabine 1900; ISO 3382-2 §A.2; Kuttruff 6th ed. eq. 5.9.',
    'T₆₀ = 0.161·V / (Σαᵢ·Sᵢ + 4mV) per band; the 4mV air-absorption term uses ISO 9613-1 standard atmosphere (20 °C, 50 % RH).'],
  ['RT60 — Eyring',
    'Eyring 1930 (J. Acoust. Soc. Am. 1, 217); Kuttruff 6th ed. eq. 5.13.',
    'T₆₀ = 0.161·V / (−S·ln(1−ᾱ) + 4mV) per band; preferred when ᾱ > 0.2.'],
  ['SPL @ listener — direct field',
    'IEC 60268-22:2020 §6; Beranek eq. 6-1.',
    'Lₚ = sens + 10·log₁₀P − 20·log₁₀r + Q(θ,φ,f) − α_air(f)·r at 1 kHz; incoherent power-sum across sources.'],
  ['SPL @ listener — reverberant field (toggle)',
    'Hopkins & Stryker 1948; Beranek eq. 6-3.',
    'Lₚ = L_w + 10·log₁₀(Q/4πr² + 4/R), R = (Sᾱ + 4mV) / (1 − ᾱ_eff); L_w = sens + 10·log₁₀P + 11 − DI per source.'],
  ['STIPA per zone',
    'IEC 60268-16:2020 Annex A & C; Bradley 1986 (D/R-aware MTF); ISO 9921:2003.',
    'Per-band MTF(f_m) = (D + R·m_rev)/(D + R + N) with m_rev = 1/√(1 + (2π f_m T/13.8)²); apparent SNR clamped ±15 dB.'],
  ['Ambient noise floor',
    'ANSI/ASA S12.2-2019 (NC curves); Beranek tab. 18-2.',
    'NC-35 default per-band SPL; user-overridable. Drives N in the STIPA denominator and noise correction in full STI.'],
  ['Critical distance r_c',
    'Beranek 2nd ed. eq. 6-7.',
    'r_c = 0.057·√(Q·V/T₆₀) at 1 kHz with assumed Q = 2 (DI ≈ 3 dB, omnidirectional baseline). Beyond r_c the reverberant field dominates the direct.'],
  ['Schroeder cutoff frequency',
    'Schroeder 1962; Kuttruff 6th ed. §3.4.',
    'f_s = 2000·√(T₆₀/V). Below f_s the room is modal; statistical-acoustics figures lose physical meaning.'],
  ['Precision engine — T20 / T30 / EDT',
    'ISO 3382-1:2009 §3.3 & §A.2.2.',
    'Schroeder backward integration of energy histogram; least-squares regression on dB decay over [−5, −25] (T20), [−5, −35] (T30), [0, −10] (EDT).'],
  ['Precision engine — C50 / C80',
    'ISO 3382-1:2009 §3.4; Reichardt 1975 (C80); Marshall 1994 (C50).',
    'Cₙ = 10·log₁₀(∫₀^n·ms h² dt / ∫_n·ms^∞ h² dt) per band and broadband.'],
  ['Precision engine — D/R',
    'Beranek 2nd ed. §10.5.',
    'Direct window anchored to geometric arrival t_d = r_min/c, ±10 ms bracket; ratio of integrated energy inside vs outside the window.'],
  ['Precision engine — STI (full)',
    'IEC 60268-16:2020 Annex A (full STI, 14 mod-freqs).',
    'm(f_m) = |∫h²·e^(−j2π fₘ t)dt| / ∫h²dt across 14 modulation frequencies × 7 bands; α/β weighting and ±15 dB clamp as STIPA.'],
];

// ---------------------------------------------------------------------------
// Disclaimer block — Dr. Chen, polished by Lin. Mounted verbatim.
// ---------------------------------------------------------------------------
const DISCLAIMER_INTRO = 'The figures in this report are simulated predictions, not measurements. Treat them as design guidance against the modelled scene; verify on site with calibrated instruments before sign-off.';

const DISCLAIMER_BODY = [
  'RT60 is reported in both Sabine and Eyring forms. Sabine is known to over-predict by 10–20 % once the surface-mean absorption ᾱ exceeds approximately 0.2; in that regime the Eyring figure should be preferred. A Fitzroy variant for asymmetric absorption distribution is on the engineering backlog and is not yet included.',
  'The draft engine treats every surface as a diffuse Lambertian absorber: per-surface scattering coefficients (Cox & D\'Antonio §6.4) are ignored. Specular early reflections, flutter echoes, focusing from concave geometry, and the build-up of comb filtering near hard parallel walls are therefore not represented. The optional precision engine, when run, captures these effects via ray-traced energy histograms and supersedes the diffuse-field figures for that scene.',
  'Loudspeaker directivity is represented by a flat broadband Directivity Index (DI) plus tabulated polar attenuation. Models supplied with coverage-angle metadata only (no measured polar) tend to over-state DI below 500 Hz; SPL at the rear of the audience may read up to 2 dB optimistic at 125–250 Hz. Line-array coherent-cluster gain (~6 dB below the spacing wavelength) is not added: arrays with 0.42 m element spacing are conservative below ~800 Hz.',
  'STIPA values are reported per IEC 60268-16:2020 as a design-stage indicator of speech intelligibility. They are NOT a substitute for the in-situ verification measurements required by BS 5839-8, IEC 60849 / ISO 7240-19 or local emergency-PA codes; a final commissioning STIPA reading is mandatory.',
  'SPL figures display the 1 kHz octave only on the heatmap. High-frequency coverage at the rear of the audience may differ by 6–10 dB at 8 kHz versus 1 kHz due to air absorption and array directivity narrowing. Refer to the per-band tables before drawing HF coverage conclusions.',
];

const DISCLAIMER_REFERENCES = [
  'ISO 3382-1:2009', 'ISO 3382-2:2008', 'ISO 9613-1:1993',
  'IEC 60268-16:2020', 'IEC 60268-22:2020', 'ANSI/ASA S12.2-2019',
  'Sabine 1900', 'Eyring 1930', 'Schroeder 1962', 'Bradley 1986',
  'Hopkins & Stryker 1948', 'Beranek 2nd ed.', 'Kuttruff 6th ed.',
  'BS 5839-8:2013 (referenced, not certified against)',
];

// ---------------------------------------------------------------------------
// Helpers for cell rendering. Units are embedded at format time so the
// data layer is single-source-of-truth for unit handling.
// ---------------------------------------------------------------------------
function fmt(v, decimals = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(decimals);
}
function fmtBand(hz) {
  return hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// renderPrintReport — assemble the hidden DOM that print.css formats
// for A4. Composition follows Sofia Calderón's spec (PROPOSAL_DESIGN.md):
// hero plan on the cover, displayed numbers, two-tone + one accent.
// Tear-down is via afterprint, see mountPrintReport.
// ---------------------------------------------------------------------------
function renderPrintReport(model, { splGrid = null } = {}) {
  let root = document.getElementById('print-report');
  if (root) root.remove();
  root = document.createElement('div');
  root.id = 'print-report';

  const sec = (cls, title, body) => `
    <section class="pr-section ${cls}">
      <h2>${escapeHtml(title)}</h2>
      ${body}
    </section>`;

  // ------ Page 1: COVER — title block + COLOURED heatmap hero + 3 figs --
  // Per Sofia v2 (post-export-audit): the coloured heatmap IS the hero.
  // Earlier draft shipped a B&W floor plan on the cover AND on page 2,
  // then the colour heatmap on page 6 — the user flagged the duplication
  // ("don't need so many pages reminding this 2D view"). One plan view,
  // the colour one, top of the report.
  const room = model.room;
  const rt60_1k = model.rt60[3];
  const heatSvg = (model.heatmap && splGrid) ? buildHeatmapPageSVG(state, splGrid) : '';
  const heatLegend = (model.heatmap && splGrid) ? buildHeatmapLegend(splGrid) : '';

  const coverFigures = `
    <div class="pr-hero-figures">
      <div class="pr-hero-figure">
        <div class="pr-hero-figure-label">RT60 @ 1 kHz · Eyring</div>
        <div class="pr-hero-figure-value pr-accent">${rt60_1k ? fmt(rt60_1k.eyring_s, 2) : '—'}<span class="pr-hero-figure-unit"> s</span></div>
      </div>
      <div class="pr-hero-figure">
        <div class="pr-hero-figure-label">Critical distance r_c</div>
        <div class="pr-hero-figure-value">${model.derived.criticalDistance_m != null ? fmt(model.derived.criticalDistance_m, 2) : '—'}<span class="pr-hero-figure-unit"> m</span></div>
      </div>
      <div class="pr-hero-figure">
        <div class="pr-hero-figure-label">Volume</div>
        <div class="pr-hero-figure-value">${fmt(room.volume_m3, 0)}<span class="pr-hero-figure-unit"> m³</span></div>
      </div>
    </div>`;

  const cover = `
    <div class="pr-page pr-page-cover">
      <div class="pr-cover-titleblock">
        <div>
          <span class="pr-eyebrow">RoomLAB · Acoustic design summary</span>
          <h1>${escapeHtml(model.project.name)}</h1>
        </div>
        <div class="pr-cover-titleblock-right">
          ${escapeHtml(model.project.date)}<br>
          <span class="pr-mute">${model.precision ? 'precision engine' : 'draft engine'}</span>
        </div>
      </div>
      <div class="pr-cover-hero">
        ${heatSvg || '<p class="pr-empty-state" style="margin:0">Place at least one source to render a coverage map.</p>'}
      </div>
      ${coverFigures}
      <p class="pr-lead">
        This document is a RoomLAB scene-design report for the project above. It records the room geometry,
        sources, listener and zone layout, and predicted reverberation, coverage, and speech intelligibility
        against the venue's noise floor. Use the figures to validate equipment selection, placement, and
        treatment before procurement or BOMBA submission.
      </p>
      <div class="pr-cover-foot">
        <span>schema v${model.project.schemaVersion} · generated ${escapeHtml(model.project.generatedAt)}</span>
      </div>
    </div>`;

  // The standalone B&W floor-plan page used to live here. Killed in
  // Sofia v2 to remove the cover/page-2 duplication. Tile grid now
  // lives on the heatmap detail page (built further down, alongside
  // the larger coverage map + numeric legend).

  // ------ Page 3: RT60 — chapter opener with ghost number + sparkline --
  // Per Sofia: chapter eyebrow + 60 pt ghost "02" + h2; sparkline above
  // the table gives visual texture without being a real chart. Re-style
  // .pr-kv as left-rag with dotted leader (no boxed form look).
  const rt60Rows = model.rt60.map(r => `
    <tr>
      <td>${fmtBand(r.freq_hz)}</td>
      <td>${fmt(r.sabine_s, 2)} s</td>
      <td>${fmt(r.eyring_s, 2)} s</td>
      <td>${fmt(r.meanAbsorption, 3)}</td>
    </tr>`).join('');

  const rt60Chart = renderRT60Chart(model.rt60, {
    volume_m3: room.volume_m3,
    schroederHz: model.derived.schroederCutoff_hz,
  });
  const targetLabel = (() => {
    const t = resolveRT60Target(room.volume_m3);
    return t ? `${t.lo.toFixed(1)}–${t.hi.toFixed(1)} s (${t.label})` : null;
  })();
  const schroederNote = model.derived.schroederCutoff_hz != null
    ? `Schroeder cutoff f<sub>s</sub> = ${fmt(model.derived.schroederCutoff_hz, 0)} Hz — modal region below 125 Hz band.`
    : '';

  const roomPage = `
    <div class="pr-page">
      <div class="pr-chapter-opener">
        <span class="pr-chapter-number-ghost">02</span>
        <span class="pr-eyebrow">Chapter 02</span>
        <h2>Reverberation</h2>
      </div>
      <section class="pr-section pr-rt60-grid">
        <div class="pr-rt60-chart-wrap">
          ${rt60Chart}
          <p class="pr-caption">Fig. 02.1 — Octave-band reverberation time per ISO 3382-1, computed via Sabine and Eyring formulae with ISO 9613-1 air absorption. ${targetLabel ? `Target band ${escapeHtml(targetLabel)} per Beranek volume heuristic.` : ''} Values on Eyring curve; Sabine shown for reference. n = 7 bands, 125 Hz – 8 kHz.</p>
        </div>
        <div class="pr-rt60-kv-wrap">
          <table class="pr-table pr-kv">
            <tr><th>Shape</th><td>${escapeHtml(room.shape)}</td></tr>
            <tr><th>W × D × H</th><td>${fmt(room.width_m, 2)} × ${fmt(room.depth_m, 2)} × ${fmt(room.height_m, 2)} m</td></tr>
            <tr><th>Floor area</th><td>${fmt(room.baseArea_m2, 1)} m²</td></tr>
            <tr><th>Volume</th><td>${fmt(room.volume_m3, 0)} m³</td></tr>
            <tr><th>Total surface</th><td>${fmt(room.totalArea_m2, 0)} m²</td></tr>
            <tr><th>Mean α (1 kHz)</th><td>${fmt(room.meanAbsorption_1k, 3)}</td></tr>
            <tr><th>Ceiling</th><td>${escapeHtml(room.ceiling_type)}</td></tr>
            <tr><th>r_c (critical)</th><td>${model.derived.criticalDistance_m != null ? `${fmt(model.derived.criticalDistance_m, 2)} m` : '—'}</td></tr>
            <tr><th>f_s (Schroeder)</th><td>${model.derived.schroederCutoff_hz != null ? `${fmt(model.derived.schroederCutoff_hz, 0)} Hz` : '—'}</td></tr>
          </table>
        </div>
      </section>
      <section class="pr-section">
        <table class="pr-table pr-zebra">
          <thead><tr><th>Band</th><th>Sabine</th><th>Eyring</th><th>Mean α</th></tr></thead>
          <tbody>${rt60Rows}</tbody>
        </table>
        <p class="pr-note">Sabine assumes a diffuse field; Eyring corrects for high mean absorption (α &gt; 0.2). Air absorption per ISO 9613-1 included in both denominators. ${schroederNote}</p>
      </section>
    </div>`;

  // ------ Page 3: sources + BOM + per-element placement ---------------
  const sourceRows = model.sources.map(s => `
    <tr>
      <td>${s.index}</td>
      <td>${s.kind === 'line-array' ? 'line-array' : 'speaker'}</td>
      <td class="pr-mono">${escapeHtml(s.modelLabel)}</td>
      <td>${fmt(s.x, 2)} m</td>
      <td>${fmt(s.y, 2)} m</td>
      <td>${fmt(s.z, 2)} m</td>
      <td>${fmt(s.yaw_deg, 0)}°</td>
      <td>${fmt(s.pitch_deg, 0)}°</td>
      <td>${fmt(s.power_w, 0)} W</td>
      <td>${escapeHtml(s.groupId ?? '—')}</td>
    </tr>`).join('');

  const bomRows = model.bom.map(r => `
    <tr>
      <td class="pr-bom-model">${escapeHtml(r.modelLabel)}</td>
      <td>${r.qty}</td>
      <td>${fmt(r.power_each_w, 0)} W</td>
      <td>${fmt(r.total_power_w, 0)} W</td>
      <td>${escapeHtml(r.groups)}</td>
    </tr>`).join('');

  // Per Sofia: appendix treatment — small h2, 8 pt body, zebra-striped
  // BOM table for scannability of long lists.
  const sourcePage = `
    <div class="pr-page pr-page-appendix">
      <span class="pr-eyebrow">Appendix A · Equipment schedule</span>
      ${sec('', `Bill of materials (${model.sourceFlat.total} radiating element${model.sourceFlat.total === 1 ? '' : 's'} from ${model.sourceFlat.raw} entr${model.sourceFlat.raw === 1 ? 'y' : 'ies'})`, `
        ${model.bom.length === 0 ? '<p class="pr-note">no sources placed.</p>' : `
          <table class="pr-table pr-zebra">
            <thead><tr><th>Model</th><th>Qty</th><th>Max power (per element)</th><th>Total power</th><th>Group(s)</th></tr></thead>
            <tbody>${bomRows}</tbody>
          </table>
          <p class="pr-note">Power figures are rated input per element; total = qty × per-element. RoomLAB does not own pricing data; consult vendor quotations for cost.</p>
        `}
      `)}
      ${sec('', 'Source placement (per element)', `
        ${model.sources.length === 0 ? '<p class="pr-note">no sources placed.</p>' : `
          <table class="pr-table pr-source-table pr-zebra">
            <thead><tr><th>#</th><th>Kind</th><th>Model</th><th>X</th><th>Y</th><th>Z</th><th>Yaw</th><th>Pitch</th><th>Power</th><th>Group</th></tr></thead>
            <tbody>${sourceRows}</tbody>
          </table>
        `}
      `)}
    </div>`;

  // ------ Page 4: listeners + zones + ambient -------------------------
  const listenerRows = model.listeners.map(l => `
    <tr>
      <td class="pr-mono">${escapeHtml(l.id)}</td>
      <td>${escapeHtml(l.label ?? '')}</td>
      <td>${fmt(l.x, 2)} m</td>
      <td>${fmt(l.y, 2)} m</td>
      <td>${fmt(l.elevation_m, 2)} m</td>
      <td>${escapeHtml(l.posture ?? '')}</td>
      <td>${fmt(l.earHeight_m, 2)} m</td>
    </tr>`).join('');

  const zoneRows = model.zones.map(z => `
    <tr>
      <td class="pr-mono">${escapeHtml(z.id)}</td>
      <td>${escapeHtml(z.label ?? '')}</td>
      <td>${z.vertices_n}</td>
      <td>${fmt(z.elevation_m, 2)} m</td>
      <td>${escapeHtml(z.material_id ?? '')}</td>
      <td>${fmt(z.occupancy_percent, 0)} %</td>
    </tr>`).join('');

  // Per Sofia: ambient noise as a horizontal band-strip "fingerprint",
  // not a table. Reads as a single visual element rather than tabular
  // data the user has to scan numerically.
  const ambientStrip = (model.ambient.per_band?.length ?? 0) > 0 ? `
    <div class="pr-bandstrip">
      <div class="pr-bandstrip-label">${escapeHtml(model.ambient.preset)}</div>
      ${model.ambient.per_band.map((v, i) => `
        <div class="pr-bandstrip-cell">
          <div class="pr-bandstrip-cell-band">${fmtBand(model.rt60[i]?.freq_hz ?? 0)}</div>
          <div class="pr-bandstrip-cell-value">${fmt(v, 0)}</div>
        </div>`).join('')}
    </div>
    <p class="pr-note">Per-band noise floor (dB SPL) used as the N term in STIPA (IEC 60268-16) and the ambient subtraction in the heatmap.</p>
  ` : '';

  // Per Sofia: appendix treatment — same demoted styling as page 4.
  const listenerPage = `
    <div class="pr-page pr-page-appendix">
      <span class="pr-eyebrow">Appendix B · Listener and zone schedule</span>
      ${sec('', 'Listener positions', `
        ${model.listeners.length === 0 ? '<p class="pr-empty-state">No listeners placed. Listener positions drive the zone-by-zone STI calculation.</p>' : `
          <table class="pr-table pr-zebra">
            <thead><tr><th>ID</th><th>Label</th><th>X</th><th>Y</th><th>Elevation</th><th>Posture</th><th>Ear height</th></tr></thead>
            <tbody>${listenerRows}</tbody>
          </table>
        `}
      `)}
      ${sec('', `Audience zones (${model.zones.length})`, `
        ${model.zones.length === 0 ? '<p class="pr-empty-state">No audience zones defined. Add a zone via the Zones panel to receive a STIPA reading.</p>' : `
          <table class="pr-table pr-zebra">
            <thead><tr><th>ID</th><th>Label</th><th>Vertices</th><th>Elevation</th><th>Material</th><th>Occupancy</th></tr></thead>
            <tbody>${zoneRows}</tbody>
          </table>
        `}
      `)}
      ${ambientStrip ? sec('', 'Ambient noise floor', ambientStrip) : ''}
    </div>`;

  // ------ Page 2: SCENE AT A GLANCE — coverage map + 12 KPI tiles ------
  // Per Sofia v2 (post-export-audit): the heatmap on the cover is the
  // headline composition; this page repeats it larger with the numeric
  // legend and the scene-summary tile grid below. Replaces the dead
  // standalone B&W floor-plan page from v1.
  let heatmapPage = '';
  if (heatSvg) {
    const metricLabel = model.heatmap.metric === 'sti' ? 'STI (IEC 60268-16)' : 'SPL @ 1 kHz';
    const earTxt = model.heatmap.earHeight_m != null
      ? `at ${fmt(model.heatmap.earHeight_m, 2)} m ear height`
      : '';
    const valueRange = model.heatmap.metric === 'sti'
      ? `range ${fmt(model.heatmap.minSPL_db, 2)} – ${fmt(model.heatmap.maxSPL_db, 2)}`
      : `range ${fmt(model.heatmap.minSPL_db, 0)} – ${fmt(model.heatmap.maxSPL_db, 0)} dB`;
    const meanTxt = model.heatmap.metric === 'sti'
      ? `mean ${fmt(model.heatmap.avgSPL_db, 2)}`
      : `mean ${fmt(model.heatmap.avgSPL_db, 0)} dB`;
    heatmapPage = `
      <div class="pr-page pr-page-heatmap">
        <span class="pr-eyebrow">Drawing 01 · Coverage map, top-down view</span>
        <div class="pr-heatmap-grid">
          <div class="pr-heatmap-stage">${heatSvg}</div>
          ${heatLegend}
        </div>
        <p class="pr-caption">
          ${escapeHtml(metricLabel)} ${escapeHtml(earTxt)} across
          ${model.heatmap.sourceCount} element${model.heatmap.sourceCount === 1 ? '' : 's'}.
          ${escapeHtml(valueRange)}, ${escapeHtml(meanTxt)}. Grey is outside the room footprint.
        </p>
        <div class="pr-tilegrid">
          ${tile('Volume',                  `${fmt(room.volume_m3, 0)} m³`)}
          ${tile('Floor area',              `${fmt(room.baseArea_m2, 1)} m²`)}
          ${tile('Surface area',            `${fmt(room.totalArea_m2, 0)} m²`)}
          ${tile('Mean α @ 1 kHz',          fmt(room.meanAbsorption_1k, 3))}
          ${tile('RT60 @ 1 kHz · Sabine',   rt60_1k ? `${fmt(rt60_1k.sabine_s, 2)} s` : '—')}
          ${tile('RT60 @ 1 kHz · Eyring',   rt60_1k ? `${fmt(rt60_1k.eyring_s, 2)} s` : '—')}
          ${tile('Sources (raw / elements)', `${model.sourceFlat.raw} / ${model.sourceFlat.total}`)}
          ${tile('Listeners',               `${model.listeners.length}`)}
          ${tile('Audience zones',          `${model.zones.length}`)}
          ${tile('Schroeder cutoff',        model.derived.schroederCutoff_hz != null ? `${fmt(model.derived.schroederCutoff_hz, 0)} Hz` : '—')}
          ${tile('Critical distance',       model.derived.criticalDistance_m != null ? `${fmt(model.derived.criticalDistance_m, 2)} m` : '—')}
          ${tile('Ambient preset',          escapeHtml(model.ambient.preset))}
        </div>
      </div>`;
  }

  // ------ Page 6: PRECISION — chapter opener + STI tier strip ---------
  // Per Sofia: this is "the second answer" — promote it. STI broadband
  // pulled out as a 28 pt accent-coloured displayed number with a
  // 3-cell pass/marginal/fail tier indicator. IEC 60268-16: STI < 0.45
  // is fail, 0.45–0.50 marginal, ≥ 0.50 pass for emergency-PA.
  const precisionPage = `
    <div class="pr-page">
      <div class="pr-chapter-opener">
        <span class="pr-chapter-number-ghost">03</span>
        <span class="pr-eyebrow">Chapter 03</span>
        <h2>Precision results</h2>
      </div>
      ${model.precision
        ? renderPrecisionSection(model.precision)
        : `<p class="pr-empty-state">Precision render not yet computed. Re-run with the Render button before submission. Draft RT60 figures on page 3 remain valid for first-pass design.</p>`
      }
    </div>`;

  // ------ Page 6: methodology + disclaimers ---------------------------
  const methodRows = METHODOLOGY_ENTRIES.map(([heading, cite, method]) => `
    <div class="pr-method-entry">
      <div class="pr-method-heading">${escapeHtml(heading)}</div>
      <div class="pr-method-cite"><span class="pr-mute">cite:</span> ${escapeHtml(cite)}</div>
      <div class="pr-method-body"><span class="pr-mute">method:</span> ${escapeHtml(method)}</div>
    </div>
  `).join('');

  const disclaimerBody = DISCLAIMER_BODY.map(p => `<p>${escapeHtml(p)}</p>`).join('');

  // Terms-of-use acceptance addendum — reads the timestamp captured by
  // the mandatory terms modal at app load. If the user somehow reaches
  // the print pipeline without an acceptance on record (race, manual
  // sessionStorage clear), fall back to "Not on record" — the report
  // is still printable but the legal trail is flagged as broken.
  const acceptedAtUTC = getAcceptanceTimestamp() || 'Not on record for this session';
  const acceptanceParagraph = `The named user accessed RoomLAB Suite and accepted its terms of use at <span class="pr-mono pr-accept-ts">${escapeHtml(acceptedAtUTC)}</span>. All predictions in this document — including reverberation time, speech transmission index, sound pressure level and coverage maps — were generated under that acceptance and are simulations executed by the browser-side engine described in the methodology section of this report. The standards referenced therein are implemented, not certified; RoomLAB is not a measurement instrument. Engineering responsibility for the application of these results rests with the named user and their organisation. Where this report informs an emergency public-address, voice-alarm or other safety-of-life installation — including work falling under BS 5839-8, EN 54-16, IEC 60849 or MS IEC 60849 — independent on-site STIPA and SPL verification with calibrated instruments is required before commissioning.`;

  // Methodology + disclaimers are on TWO separate .pr-page blocks so
  // each is forced to the top of its own physical page. Earlier draft
  // packed both into one page; on short scenes (1–2 listeners, no
  // precision render) the precision page ran short and the disclaimers
  // started halfway down — proposal-readers flagged it as unfinished
  // ("page break in the middle of legalese reads sloppy"). Per Sofia
  // v1 + user request: ALWAYS new page for methodology AND for
  // disclaimers, regardless of scene length.
  // Methodology + disclaimers + references + reviewer's note all on
  // ONE page. User request: "squeeze into 1 page, small letter also
  // nevermind. But make sure its professional addressing how we
  // measure the results, and what standard this apps is following.
  // Because people will challenge us." Layout: methodology as a
  // 3-column compact grid (15 entries × ~3 lines each), disclaimers
  // as a 2-column flow below, references inline at the bottom,
  // reviewer's note as a left-accent-bar sidebar. Font 7–8pt body,
  // 10pt section headings.
  const combinedPage = `
    <div class="pr-page pr-page-methodology pr-page-credentials">
      <header class="pr-credentials-header">
        <h2>Methodology, Standards &amp; Disclaimers</h2>
        <p class="pr-credentials-intro">${escapeHtml(DISCLAIMER_INTRO)} Each metric below names the standard it follows and the assumption baked in, so a reviewing engineer can trace any number back to its source.</p>
      </header>

      <section class="pr-credentials-method">
        <h3 class="pr-credentials-section-h">Methodology — how each figure is computed</h3>
        <div class="pr-method-grid">
          ${methodRows}
        </div>
      </section>

      <section class="pr-credentials-disclaimer">
        <h3 class="pr-credentials-section-h">Disclaimers — known limits of this model</h3>
        <div class="pr-disclaimer-grid">${disclaimerBody}</div>
      </section>

      <section class="pr-credentials-acceptance">
        <h3 class="pr-credentials-section-h">Acceptance of terms of use</h3>
        <p class="pr-acceptance-body">${acceptanceParagraph}</p>
      </section>

      <footer class="pr-credentials-footer">
        <div class="pr-references-inline">
          <strong>Standards &amp; sources cited:</strong>
          ${DISCLAIMER_REFERENCES.map(r => escapeHtml(r)).join(' · ')}
        </div>
        <div class="pr-reviewer-note pr-reviewer-compact">
          <span class="pr-eyebrow">Reviewer's note —</span>
          Before issuing this report, confirm: (1) the project name on page 1 matches the tendered scheme; (2) the ambient noise floor reflects the venue's measured or specified condition, not a placeholder; (3) listener positions correspond to the seating, standing, or circulation intent of the design. Amend the scene and re-export if any item drifts.
        </div>
      </footer>
    </div>`;

  root.innerHTML = `
    ${cover}
    ${heatmapPage}
    ${roomPage}
    ${sourcePage}
    ${listenerPage}
    ${precisionPage}
    ${combinedPage}
    <footer class="pr-foot">
      RoomLAB · <span class="pr-mono">chongthekuli.github.io/RoomLab</span> · generated ${escapeHtml(model.project.generatedAt)} · schema v${model.project.schemaVersion}
    </footer>
  `;
  document.body.appendChild(root);
  return root;
}

function tile(label, value) {
  return `
    <div class="pr-tile">
      <div class="pr-tile-label">${escapeHtml(label)}</div>
      <div class="pr-tile-value">${value}</div>
    </div>`;
}

// Resolve target RT60 band for the proposal chart. Pure volume heuristic
// per Beranek (Concert Halls and Opera Houses, 2nd ed. 2004, §3) and BBC
// R&D studio tech notes: mid-frequency target reverberation rises with
// room volume because larger rooms benefit acoustically from a longer
// decay. Boundaries are conservative midpoints of the cited ranges; the
// label tells the reviewer which usage band we assumed.
function resolveRT60Target(volumeM3) {
  if (!(volumeM3 > 0)) return null;
  if (volumeM3 < 50)   return { lo: 0.25, hi: 0.45, label: 'studio / control room' };
  if (volumeM3 < 200)  return { lo: 0.35, hi: 0.60, label: 'small speech / classroom' };
  if (volumeM3 < 1000) return { lo: 0.60, hi: 1.00, label: 'speech / lecture' };
  if (volumeM3 < 5000) return { lo: 1.00, hi: 1.50, label: 'multi-purpose' };
  return                       { lo: 1.40, hi: 2.20, label: 'music / concert' };
}

// RT60-vs-frequency analytical chart for the Reverberation page. Sofia's
// spec (post-sparkline rejection): 100×70mm vector, two series (Eyring
// solid + accent, Sabine dotted reference), shaded target band per
// Beranek volume heuristic, gridlines every 0.5s, value labels on every
// Eyring point, 1 kHz gridline emphasised as the headline anchor. SVG
// coordinate system is in millimetres so the figure prints crisp.
//
// Inline stroke/fill (no CSS classes) — keeps the figure self-contained
// for any rasterisation pipeline (browser print, screenshot tools).
function renderRT60Chart(rt60Bands, { volume_m3, schroederHz } = {}) {
  const eyring = rt60Bands.map(b => Number.isFinite(b.eyring_s) ? b.eyring_s : null);
  const sabine = rt60Bands.map(b => Number.isFinite(b.sabine_s) ? b.sabine_s : null);
  const finiteE = eyring.filter(v => v !== null);
  if (finiteE.length === 0) return '';

  // ---- Plot geometry (mm) -------------------------------------------
  const W = 100, H = 70;
  const padL = 12, padR = 4, padT = 6, padB = 12;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const plotX = padL;
  const plotY = padT;

  // ---- Y range -------------------------------------------------------
  // Floor at 1.5s so different scenes are visually comparable, lift to
  // include any value over 1.25s. Always rounded up to a 0.5s tick.
  const target = resolveRT60Target(volume_m3);
  const allValues = [...finiteE, ...sabine.filter(v => v !== null)];
  if (target) allValues.push(target.hi);
  const maxRaw = Math.max(...allValues) * 1.2;
  const yMax = Math.max(1.5, Math.ceil(maxRaw * 2) / 2);

  // ---- Coordinate helpers -------------------------------------------
  const N = rt60Bands.length;
  const xOf = (i) => plotX + (N === 1 ? plotW / 2 : (i / (N - 1)) * plotW);
  const yOf = (v) => plotY + plotH - (v / yMax) * plotH;

  // ---- Target band rect (drawn first so lines paint over) -----------
  let targetRect = '';
  let targetLabel = '';
  if (target) {
    const yHi = yOf(target.hi);                  // higher RT = lower y
    const yLo = yOf(target.lo);
    targetRect = `<rect x="${plotX.toFixed(2)}" y="${yHi.toFixed(2)}" width="${plotW.toFixed(2)}" height="${(yLo - yHi).toFixed(2)}" fill="#8C2A2A" fill-opacity="0.12" />`;
    targetLabel = `<text x="${(plotX + plotW - 0.5).toFixed(2)}" y="${(plotY + 3).toFixed(2)}" text-anchor="end" font-size="2.4" font-weight="600" fill="#8C2A2A">Target ${target.lo.toFixed(1)}–${target.hi.toFixed(1)} s · ${target.label}</text>`;
  }

  // ---- Major + minor gridlines --------------------------------------
  const gridLines = [];
  for (let v = 0; v <= yMax + 1e-6; v += 0.25) {
    const y = yOf(v);
    const isMajor = Math.abs((v * 2) % 1) < 1e-6;     // every 0.5
    const sw = isMajor ? 0.12 : 0.06;
    gridLines.push(`<line x1="${plotX.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(plotX + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#C9C5BC" stroke-width="${sw}" />`);
  }
  // 1 kHz vertical anchor — index 3 in the standard 125…8k array.
  const idx1k = rt60Bands.findIndex(b => b.freq_hz === 1000);
  if (idx1k >= 0) {
    const x1k = xOf(idx1k);
    gridLines.push(`<line x1="${x1k.toFixed(2)}" y1="${plotY.toFixed(2)}" x2="${x1k.toFixed(2)}" y2="${(plotY + plotH).toFixed(2)}" stroke="#C9C5BC" stroke-width="0.18" />`);
  }

  // ---- Y-axis tick labels (major gridlines only) --------------------
  const yLabels = [];
  for (let v = 0; v <= yMax + 1e-6; v += 0.5) {
    const y = yOf(v);
    yLabels.push(`<text x="${(plotX - 1.5).toFixed(2)}" y="${(y + 0.9).toFixed(2)}" text-anchor="end" font-size="2.4" fill="#6B6F75">${v.toFixed(1)}</text>`);
  }
  // Y-axis title
  yLabels.push(`<text x="${(plotX - 8).toFixed(2)}" y="${(plotY + plotH / 2).toFixed(2)}" text-anchor="middle" font-size="2.4" font-weight="600" fill="#1A1F24" transform="rotate(-90 ${(plotX - 8).toFixed(2)} ${(plotY + plotH / 2).toFixed(2)})">RT60 (s)</text>`);

  // ---- X-axis tick labels -------------------------------------------
  const xLabels = rt60Bands.map((b, i) => {
    const x = xOf(i);
    const label = b.freq_hz >= 1000 ? `${b.freq_hz / 1000}k` : `${b.freq_hz}`;
    return `<text x="${x.toFixed(2)}" y="${(plotY + plotH + 4).toFixed(2)}" text-anchor="middle" font-size="2.4" fill="#6B6F75">${label}</text>`;
  }).join('');
  const xAxisTitle = `<text x="${(plotX + plotW / 2).toFixed(2)}" y="${(plotY + plotH + 8.5).toFixed(2)}" text-anchor="middle" font-size="2.4" font-weight="600" fill="#1A1F24">Octave-band centre frequency (Hz)</text>`;

  // ---- Plot frame (left + bottom only — Tufte-friendly) -------------
  const frame = `
    <line x1="${plotX.toFixed(2)}" y1="${plotY.toFixed(2)}" x2="${plotX.toFixed(2)}" y2="${(plotY + plotH).toFixed(2)}" stroke="#1A1F24" stroke-width="0.16" />
    <line x1="${plotX.toFixed(2)}" y1="${(plotY + plotH).toFixed(2)}" x2="${(plotX + plotW).toFixed(2)}" y2="${(plotY + plotH).toFixed(2)}" stroke="#1A1F24" stroke-width="0.16" />`;

  // ---- Sabine series (dotted ink reference) -------------------------
  const sabinePts = sabine.map((v, i) => v == null ? null : { x: xOf(i), y: yOf(v) }).filter(p => p);
  const sabinePath = sabinePts.length >= 2
    ? `<path d="${sabinePts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')}" stroke="#1A1F24" stroke-width="0.2" stroke-dasharray="0.8 0.8" fill="none" stroke-linejoin="round" />`
    : '';

  // ---- Eyring series (headline accent) ------------------------------
  const eyringPts = eyring.map((v, i) => v == null ? null : { x: xOf(i), y: yOf(v), v }).filter(p => p);
  const eyringPath = eyringPts.length >= 2
    ? `<path d="${eyringPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')}" stroke="#8C2A2A" stroke-width="0.4" fill="none" stroke-linejoin="round" stroke-linecap="round" />`
    : '';
  const eyringDots = eyringPts.map(p =>
    `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="0.8" fill="#8C2A2A" />`
  ).join('');
  const eyringLabels = eyringPts.map(p =>
    `<text x="${p.x.toFixed(2)}" y="${(p.y - 1.6).toFixed(2)}" text-anchor="middle" font-size="2.3" font-weight="500" fill="#1A1F24">${p.v.toFixed(2)}</text>`
  ).join('');

  // ---- Legend (top-left of plot) ------------------------------------
  const lx = plotX + 1.5;
  const ly = plotY + 3;
  const legend = `
    <g>
      <line x1="${lx.toFixed(2)}" y1="${ly.toFixed(2)}" x2="${(lx + 5).toFixed(2)}" y2="${ly.toFixed(2)}" stroke="#8C2A2A" stroke-width="0.4" />
      <circle cx="${(lx + 2.5).toFixed(2)}" cy="${ly.toFixed(2)}" r="0.7" fill="#8C2A2A" />
      <text x="${(lx + 6).toFixed(2)}" y="${(ly + 0.9).toFixed(2)}" font-size="2.4" fill="#1A1F24">Eyring</text>
      <line x1="${(lx + 14).toFixed(2)}" y1="${ly.toFixed(2)}" x2="${(lx + 19).toFixed(2)}" y2="${ly.toFixed(2)}" stroke="#1A1F24" stroke-width="0.2" stroke-dasharray="0.8 0.8" />
      <text x="${(lx + 20).toFixed(2)}" y="${(ly + 0.9).toFixed(2)}" font-size="2.4" fill="#1A1F24">Sabine</text>
    </g>`;

  return `<svg class="pr-rt60-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" width="100mm" height="70mm">
    ${targetRect}
    ${gridLines.join('')}
    ${frame}
    ${legend}
    ${sabinePath}
    ${eyringPath}
    ${eyringDots}
    ${eyringLabels}
    ${targetLabel}
    ${yLabels.join('')}
    ${xLabels}
    ${xAxisTitle}
  </svg>`;
}

function renderPrecisionSection(p) {
  const hzCols = (p.bands_hz ?? []).map(hz => `<th>${fmtBand(hz)}</th>`).join('');

  const broadbandRows = p.receivers.map(r => `
    <tr>
      <td class="pr-mono">${escapeHtml(r.label)}</td>
      <td>${fmt(r.broadband.edt_s, 2)} s</td>
      <td>${fmt(r.broadband.t20_s, 2)} s</td>
      <td>${fmt(r.broadband.t30_s, 2)} s</td>
      <td>${fmt(r.broadband.c50_db, 1)} dB</td>
      <td>${fmt(r.broadband.c80_db, 1)} dB</td>
      <td>${fmt(r.broadband.dr_db, 1)} dB</td>
      <td>${fmt(r.sti, 3)}</td>
    </tr>`).join('');

  const perBandT30 = p.receivers.map(r => `
    <tr>
      <td class="pr-mono">${escapeHtml(r.label)}</td>
      ${(r.perBand ?? []).map(b => `<td>${fmt(b.t30_s, 2)} s</td>`).join('')}
    </tr>`).join('');

  // Per Sofia: STI broadband as a displayed number, with a 3-cell tier
  // strip showing fail / marginal / pass. Use the receiver with the
  // LOWEST STI as the headline figure — that's the worst-case zone, and
  // the figure a BOMBA reviewer would care about.
  const stiValues = p.receivers.map(r => r.sti).filter(v => Number.isFinite(v));
  const stiMin = stiValues.length > 0 ? Math.min(...stiValues) : null;
  let stiTier = null;
  if (stiMin !== null) {
    if (stiMin < 0.45) stiTier = 0;
    else if (stiMin < 0.50) stiTier = 1;
    else stiTier = 2;
  }
  const tierLabels = ['< 0.45 fail', '0.45 – 0.50 marginal', '≥ 0.50 pass'];
  const tierStrip = stiTier === null ? '' : `
    <div class="pr-tierstrip" aria-label="STI tier">
      ${tierLabels.map((label, i) => `
        <div class="pr-tierstrip-cell ${i === stiTier ? 'pr-tierstrip-active' : ''}">${escapeHtml(label)}</div>
      `).join('')}
    </div>`;
  const stiHeadline = stiMin === null ? '' : `
    <div class="pr-precision-headline">
      <div>
        <div class="pr-precision-sti-label">Worst-zone STI · IEC 60268-16</div>
        <div class="pr-precision-sti">${fmt(stiMin, 2)}</div>
      </div>
      <div>
        ${tierStrip}
        <p class="pr-note" style="margin-top:4pt">${stiTier === 2 ? 'Above the MS IEC 60849 / BOMBA emergency-PA threshold (0.50). Verify with in-situ commissioning.' : stiTier === 1 ? 'Marginal — between the BS 5839-8 floor (0.45) and the MS IEC 60849 / BOMBA threshold (0.50). Treatment recommended.' : 'Below the BS 5839-8 floor (0.45). Treatment required before submission.'}</p>
      </div>
    </div>`;

  return `
    ${stiHeadline}
    <section class="pr-section">
      <h3>Broadband per receiver</h3>
      <table class="pr-table pr-zebra">
        <thead><tr><th>Receiver</th><th>EDT</th><th>T20</th><th>T30</th><th>C50</th><th>C80</th><th>D/R</th><th>STI</th></tr></thead>
        <tbody>${broadbandRows}</tbody>
      </table>
      <h3>T30 per band</h3>
      <table class="pr-table pr-zebra">
        <thead><tr><th>Receiver</th>${hzCols}</tr></thead>
        <tbody>${perBandT30}</tbody>
      </table>
      <p class="pr-note">Values computed by ray-traced energy histograms (Schroeder backward integration). Supersedes draft RT60 for this scene.</p>
    </section>`;
}

let _printMaterialsRef = null;

// Click handler for the header "Print" button. Renders the report
// DOM (so it's ready when @media print kicks in) and calls
// window.print(). On desktop browsers the print dialog has a
// "Save as PDF" destination. On mobile, the dialog usually offers
// it too — but the option is sometimes buried in a menu, so the
// first-time mobile click also pops a one-off hint.
//
// Why no in-app PDF generation: html2canvas / html2pdf / jspdf
// approaches all failed on this report — the page hosts a Three.js
// WebGL canvas that breaks html2canvas's clone pipeline (returns
// 0×0 canvases). The SVG <foreignObject> fallback hits browser
// security blocks on the resulting Blob URL. EASE, Odeon, and CATT
// all use native print for the same reason: client-side raster of
// rich CSS layouts is fragile. The mobile UX trade-off (one extra
// tap) is worth the reliability.
const MOBILE_HINT_KEY = 'roomlab.printMobileHintShown.v1';

function isMobileBrowser() {
  // UA-string sniffing is unreliable in general but adequate for
  // an opt-in tooltip — false negatives just mean a desktop user
  // sees the hint once, which is harmless.
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function showMobilePrintHint() {
  if (typeof alert !== 'function') return;
  alert(
    'Tip: To save the proposal as a PDF on your phone:\n\n' +
    '• Android Chrome: tap the destination dropdown and choose "Save as PDF".\n' +
    '• iOS Safari: tap the share icon in the print preview, then "Save to Files".\n\n' +
    'This tip won\'t show again.'
  );
  try { localStorage.setItem(MOBILE_HINT_KEY, '1'); } catch (e) { /* private mode */ }
}

export function triggerPrint() {
  if (!_printMaterialsRef) {
    console.warn('[print-report] mountPrintReport() never called — materials reference missing');
    return;
  }
  // Compute the grid ONCE here (so buildPrintModel's metadata and the
  // renderer's hero heatmap come from the same data) instead of twice.
  const rt60Bands = computeAllBands({ room: state.room, materials: _printMaterialsRef, zones: state.zones });
  const t60_1k = rt60Bands[3]?.eyring_s ?? rt60Bands[3]?.sabine_s ?? null;
  const splGrid = ensurePrintSplGrid({ materials: _printMaterialsRef, t60_1k });
  const model = buildPrintModel({ materials: _printMaterialsRef });
  renderPrintReport(model, { splGrid });

  // Show the mobile hint BEFORE invoking print so users have time
  // to read it. The hint is a blocking alert — print() runs after
  // they dismiss it.
  let hintShown = false;
  try {
    if (isMobileBrowser() && !localStorage.getItem(MOBILE_HINT_KEY)) {
      showMobilePrintHint();
      hintShown = true;
    }
  } catch (e) { /* localStorage blocked — skip hint silently */ }

  requestAnimationFrame(() => { window.print(); });
}

export function mountPrintReport({ materials }) {
  _printMaterialsRef = materials;

  window.addEventListener('beforeprint', () => {
    if (!_printMaterialsRef) return;
    if (document.getElementById('print-report')) return;
    const rt60Bands = computeAllBands({ room: state.room, materials: _printMaterialsRef, zones: state.zones });
    const t60_1k = rt60Bands[3]?.eyring_s ?? rt60Bands[3]?.sabine_s ?? null;
    const splGrid = ensurePrintSplGrid({ materials: _printMaterialsRef, t60_1k });
    const model = buildPrintModel({ materials: _printMaterialsRef });
    renderPrintReport(model, { splGrid });
  });

  window.addEventListener('afterprint', () => {
    document.getElementById('print-report')?.remove();
  });
}
