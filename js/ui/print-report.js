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
import { deriveMetrics } from '../physics/precision/derive-metrics.js';
import { buildFloorPlanSVG, buildFloorPlanLegend } from './print-plan-svg.js';

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

  return {
    project: {
      name: nameHint || 'untitled scene',
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
  };
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
function renderPrintReport(model) {
  let root = document.getElementById('print-report');
  if (root) root.remove();
  root = document.createElement('div');
  root.id = 'print-report';

  const sec = (cls, title, body) => `
    <section class="pr-section ${cls}">
      <h2>${escapeHtml(title)}</h2>
      ${body}
    </section>`;

  // ------ Page 1: COVER — title block + hero plan + 3 displayed nums ----
  // Per Sofia: floor plan IS the hero element (174 mm wide). Three
  // displayed figures only (RT60, r_c, Volume). RT60 is the ONE accent
  // colour on the entire page. The 12-tile grid moves to page 2.
  const room = model.room;
  const rt60_1k = model.rt60[3];
  const planSvg = buildFloorPlanSVG(state);
  const planLegend = buildFloorPlanLegend();

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
        ${planSvg}
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
        <span>page 1 / 7</span>
      </div>
    </div>`;

  // ------ Page 2: PLAN — drawing-sheet treatment with tile grid below --
  // Per Sofia: heading demoted to small-caps eyebrow (cover already sold
  // the plan). Tile grid lands here below the plan as the "scene at a
  // glance" reference data.
  const planPage = `
    <div class="pr-page pr-page-plan">
      <span class="pr-eyebrow">Drawing 01 · Floor plan, top-down view</span>
      <div class="pr-plan-grid">
        <div class="pr-plan-svg-wrap">${planSvg}</div>
        ${planLegend}
      </div>
      <p class="pr-note">Numbers next to source markers index the equipment list on page 4 (<span class="pr-mono">3.2</span> = source 3, line-array element 2). Listener labels match the listener table on page 5.</p>
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

  const rt60Sparkline = renderRT60Sparkline(model.rt60);

  const roomPage = `
    <div class="pr-page">
      <div class="pr-chapter-opener">
        <span class="pr-chapter-number-ghost">02</span>
        <span class="pr-eyebrow">Chapter 02</span>
        <h2>Reverberation</h2>
      </div>
      <section class="pr-section">
        <table class="pr-table pr-kv">
          <tr><th>Shape</th><td>${escapeHtml(room.shape)}</td></tr>
          <tr><th>Width × Depth × Height</th><td>${fmt(room.width_m, 2)} × ${fmt(room.depth_m, 2)} × ${fmt(room.height_m, 2)} m</td></tr>
          <tr><th>Floor area</th><td>${fmt(room.baseArea_m2, 1)} m²</td></tr>
          <tr><th>Volume</th><td>${fmt(room.volume_m3, 0)} m³</td></tr>
          <tr><th>Total interior surface area</th><td>${fmt(room.totalArea_m2, 0)} m²</td></tr>
          <tr><th>Mean absorption (1 kHz)</th><td>${fmt(room.meanAbsorption_1k, 3)}</td></tr>
          <tr><th>Ceiling type</th><td>${escapeHtml(room.ceiling_type)}</td></tr>
          <tr><th>Critical distance r_c</th><td>${model.derived.criticalDistance_m != null ? `${fmt(model.derived.criticalDistance_m, 2)} m  <span class="pr-mute">(Q ≈ ${model.derived.Q_assumed}, DI ≈ ${model.derived.DI_assumed_db} dB)</span>` : '—'}</td></tr>
          <tr><th>Schroeder cutoff</th><td>${model.derived.schroederCutoff_hz != null ? `${fmt(model.derived.schroederCutoff_hz, 0)} Hz` : '—'}</td></tr>
        </table>
      </section>
      <section class="pr-section">
        ${rt60Sparkline}
        <table class="pr-table">
          <thead><tr><th>Band</th><th>Sabine</th><th>Eyring</th><th>Mean α</th></tr></thead>
          <tbody>${rt60Rows}</tbody>
        </table>
        <p class="pr-note">Sabine assumes a diffuse field; Eyring corrects for high mean absorption (α &gt; 0.2). Air absorption per ISO 9613-1 included in both denominators. Sparkline shows the Eyring per-band values across 125 Hz – 8 kHz.</p>
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

  // Per Sofia: reviewer's note moves to page 7 (above references), with
  // accent left-bar on white background (no banana-yellow). References
  // become a 2-column block at 8pt — comma-separated lists are
  // amateurish at this length.
  const methodPage = `
    <div class="pr-page">
      ${sec('', 'Methodology', `
        <p class="pr-note">The metrics below describe how each figure in this report is computed, the standard it follows, and the assumptions baked into the model. Citations are given inline so a reviewing engineer can trace any number back to its source.</p>
        ${methodRows}
      `)}
      ${sec('', 'Disclaimers', `
        <p class="pr-disclaimer-intro">${escapeHtml(DISCLAIMER_INTRO)}</p>
        ${disclaimerBody}
      `)}
      <div class="pr-reviewer-note">
        <span class="pr-eyebrow">Reviewer's note</span>
        Before issuing this report, confirm three items.
        The project name on page 1 matches the tendered scheme.
        The ambient noise floor reflects the venue's measured or specified condition, not a placeholder.
        Listener positions correspond to the seating, standing, or circulation intent of the design.
        Amend the scene and re-export if any item drifts.
      </div>
      ${sec('', 'References', `
        <div class="pr-references">${DISCLAIMER_REFERENCES.map(r => `<div>${escapeHtml(r)}</div>`).join('')}</div>
      `)}
    </div>`;

  root.innerHTML = `
    ${cover}
    ${planPage}
    ${roomPage}
    ${sourcePage}
    ${listenerPage}
    ${precisionPage}
    ${methodPage}
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

// RT60-vs-frequency sparkline for the chapter-02 page. Per Sofia: 7
// points (one per band) at 180 × 36 logical pt, 1.2pt stroke, no axis
// labels — texture, not a real chart. Uses Eyring values.
function renderRT60Sparkline(rt60Bands) {
  const eyringValues = rt60Bands.map(b => Number.isFinite(b.eyring_s) ? b.eyring_s : null);
  const finite = eyringValues.filter(v => v !== null);
  if (finite.length === 0) return '';
  const maxV = Math.max(...finite, 0.1);
  const W = 180, H = 36;
  const pad = 4;
  const innerW = W - pad * 2, innerH = H - pad * 2;
  const points = eyringValues.map((v, i) => {
    const x = pad + (i / (eyringValues.length - 1)) * innerW;
    const y = v === null ? null : pad + (1 - v / maxV) * innerH;
    return { x, y };
  });
  const dPath = points
    .filter(p => p.y !== null)
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');
  const dots = points
    .filter(p => p.y !== null)
    .map(p => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="1.4" />`)
    .join('');
  return `<svg class="pr-sparkline" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <path d="${dPath}" stroke-width="1.2" />
    ${dots}
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

export function triggerPrint() {
  if (!_printMaterialsRef) {
    console.warn('[print-report] mountPrintReport() never called — materials reference missing');
    return;
  }
  const model = buildPrintModel({ materials: _printMaterialsRef });
  renderPrintReport(model);
  requestAnimationFrame(() => { window.print(); });
}

export function mountPrintReport({ materials }) {
  _printMaterialsRef = materials;

  window.addEventListener('beforeprint', () => {
    if (!_printMaterialsRef) return;
    if (document.getElementById('print-report')) return;
    const model = buildPrintModel({ materials: _printMaterialsRef });
    renderPrintReport(model);
  });

  window.addEventListener('afterprint', () => {
    document.getElementById('print-report')?.remove();
  });
}
