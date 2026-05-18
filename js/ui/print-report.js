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
import { buildHeatmapPageSVG, buildHeatmapLegend, shiftSplGridByDb, buildHeatmapStripLegend, heatmapPageViewBox } from './print-heatmap.js';
import { buildFloorPlanSVG } from './print-plan-svg.js';
import { computePerListenerMetrics } from '../physics/per-listener-metrics.js';
import { getAcceptanceTimestamp, getAcceptanceRecord } from './welcome-card.js';
import { findCatalogueEntry } from '../labs/surfacelab/catalog.js';

// scene.js pulls in Three.js, which has no Node resolution path. We
// import captureViewportImage LAZILY inside mountPrintReport so the
// headless test harness (tests/print-*.test.mjs) can still build a
// print model without dragging Three into the test graph.
//
// In the browser: mountPrintReport kicks the dynamic import on mount;
// by the time the user clicks Print (or hits Ctrl-P) the module is
// cached and _captureFn is ready to call synchronously. If the import
// is still in flight when print fires, the cover falls back to the
// 2D plan as the hero — same graceful-degradation path as walk mode.
let _captureFn = null;
async function _loadCaptureFn() {
  if (_captureFn) return _captureFn;
  try {
    const mod = await import('../graphics/scene.js');
    if (typeof mod.captureViewportImage === 'function') {
      _captureFn = mod.captureViewportImage;
      return _captureFn;
    }
  } catch (err) {
    console.warn('[print-report] scene.js dynamic import failed:', err);
  }
  return null;
}

// Human-readable label for the room's plan shape. Pulled out of the
// cover template so it can be unit-tested without spinning up a DOM.
function describeShape(room) {
  if (!room) return 'unknown';
  switch (room.shape) {
    case 'rectangular': return 'rectangular';
    case 'round':       return 'round';
    case 'polygon':     return `regular ${room.polygon_sides ?? 6}-sided polygon`;
    case 'custom': {
      const n = Array.isArray(room.custom_vertices) ? room.custom_vertices.length : 0;
      return n > 0 ? `custom polygon (${n} vertices)` : 'custom polygon';
    }
    default: return room.shape || 'unknown';
  }
}

// One-or-two sentence plain-English summary written for the print cover.
// Reads from the print model's room block plus the model's mean-α-1k
// figure so we don't double-compute. Pure function — testable.
function buildRoomSummary(room) {
  if (!room) return '';
  const dims = `${fmt(room.width_m, 1)} × ${fmt(room.depth_m, 1)} × ${fmt(room.height_m, 1)} m`;
  const shape = describeShape(room);
  const vol = fmt(room.volume_m3, 0);
  const meanA = (Number.isFinite(room.meanAbsorption_1k) && room.meanAbsorption_1k > 0)
    ? room.meanAbsorption_1k
    : null;
  const finishCue = meanA == null
    ? ''
    : meanA < 0.10 ? ' Hard, reflective finishes throughout — long reverb expected.'
    : meanA < 0.25 ? ' Mixed finishes — moderate reverberation.'
    : ' Substantial soft / absorbent finishes — short reverb.';
  return `This is a ${dims} ${shape} room (${vol} m³ total volume).${finishCue}`;
}

// ---------------------------------------------------------------------------
// buildPrintModel — pure data function (testable without a headless browser).
// Returns the full structured payload the renderer consumes, including
// derived figures (BOM aggregation, critical distance, Schroeder cutoff)
// and a normalised view of any precision-engine results currently held
// on state.results.precision.
// ---------------------------------------------------------------------------
export function buildPrintModel({ materials, nameHint } = {}) {
  const rt60Bands = computeAllBands({ room: state.room, materials, zones: state.zones, treatments: state.treatments });
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
      // Room name surfaces on the print-report cover as a sub-title under
      // the project name. Falls back to "Untitled room" at render time so
      // the cover always has SOMETHING in the room-name slot.
      name: (typeof state.room.name === 'string' && state.room.name.trim().length > 0)
        ? state.room.name.trim()
        : '',
      shape: state.room.shape,
      polygon_sides: state.room.polygon_sides ?? null,
      custom_vertices: Array.isArray(state.room.custom_vertices) ? state.room.custom_vertices.slice() : null,
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
    treatmentsBom: aggregateTreatmentsBOM(state.treatments ?? []),
    treatmentsSchedule: buildTreatmentSchedule(state.treatments ?? [], state.room),
    treatmentCompare: buildTreatmentCompareModel({
      room: state.room,
      materials,
      zones: state.zones ?? [],
      treatments: state.treatments ?? [],
    }),
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
    // Per-listener SPL (1 kHz total) + STI (precision render, when one
    // exists). Same numbers the results panel + live 2D viewport show;
    // attached to the model so the print SVG renderers can label each
    // dot without re-running the physics.
    listenerMetrics: (() => {
      try { return computePerListenerMetrics(state, materials); }
      catch (err) { console.warn('[print-report] per-listener metrics failed:', err); return null; }
    })(),
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

// Aggregate placed acoustic treatments into a Bill of Materials grouped
// by productId × count. Each row carries the catalogue-resolved name,
// manufacturer, per-unit area (width_m × height_m), total area and total
// weight (from `weight_kg_m2` on the spec). The footer rows in the
// renderer print grand totals across all rows.
//
// Falls back gracefully if the catalogue hasn't loaded yet (rare in
// practice — print is user-triggered well after the panel mount).
function aggregateTreatmentsBOM(treatments) {
  if (!Array.isArray(treatments) || treatments.length === 0) return [];
  const byPid = new Map();
  for (const t of treatments) {
    if (!t || !t.productId) continue;
    const dim = t.dimensions || {};
    const unitArea_m2 = (dim.width_m ?? 0) * (dim.height_m ?? 0);
    const spec = t._cachedSpec || findCatalogueEntry(t.productId) || null;
    const weightPerArea = spec?.geometry?.weight_kg_m2 ?? null;
    const unitWeight_kg = weightPerArea != null ? weightPerArea * unitArea_m2 : null;
    const key = t.productId;
    let row = byPid.get(key);
    if (!row) {
      row = {
        productId: t.productId,
        name: spec?.name ?? t.productId,
        manufacturer: spec?.manufacturer ?? '—',
        count: 0,
        unitArea_m2,
        totalArea_m2: 0,
        unitWeight_kg,
        totalWeight_kg: 0,
        hasWeight: weightPerArea != null,
      };
      byPid.set(key, row);
    }
    row.count += 1;
    row.totalArea_m2 += unitArea_m2;
    if (row.hasWeight) row.totalWeight_kg += unitWeight_kg ?? 0;
  }
  return Array.from(byPid.values()).sort((a, b) => b.count - a.count);
}

function getSpeakerLabel(url) {
  if (!url) return '—';
  const entry = SPEAKER_CATALOG.find(c => c.url === url);
  if (entry?.label) return entry.label;
  // Fallback: basename stripped of .json + path.
  return url.replace(/.*\//, '').replace(/\.json$/, '');
}

// ---------------------------------------------------------------------------
// Per-panel treatment placement schedule. Unlike aggregateTreatmentsBOM
// (which groups by productId × count), this returns ONE ROW PER PLACED
// panel — required by Dr. Chen for sign-off-grade reporting: each
// treatment carries its own tag, location, mounting, parameters, fire
// rating, and the full 7-band α vector so a reviewing engineer can
// trace each absorption-budget contribution to a single physical panel.
// ---------------------------------------------------------------------------
function buildTreatmentSchedule(treatments, room) {
  if (!Array.isArray(treatments) || treatments.length === 0) return [];
  // Wall-index → readable location label. Rectangular rooms = N/S/E/W;
  // custom + polygon rooms = "Wall n" (1-based for client-readability).
  const wallLabel = (anchor) => {
    if (!anchor) return '—';
    if (anchor.surface === 'ceiling') return 'Ceiling';
    if (anchor.surface !== 'wall') return '—';
    const idx = Number.isFinite(anchor.wallIndex) ? anchor.wallIndex : null;
    if (idx == null) return 'Wall';
    if ((room?.shape ?? 'rectangular') === 'rectangular') {
      return ['North wall', 'South wall', 'East wall', 'West wall'][idx] ?? `Wall ${idx + 1}`;
    }
    return `Wall ${idx + 1}`;
  };
  return treatments.map((t, i) => {
    const spec = t?._cachedSpec || findCatalogueEntry(t?.productId) || null;
    const dim = t?.dimensions || {};
    const unitArea_m2 = (dim.width_m ?? 0) * (dim.height_m ?? 0);
    const weightPerArea = spec?.geometry?.weight_kg_m2 ?? null;
    const weight_kg = (weightPerArea != null) ? weightPerArea * unitArea_m2 : null;
    const absorption = Array.isArray(spec?.absorption) ? spec.absorption : null;
    // NRC = arithmetic mean of α at 250 / 500 / 1k / 2k Hz (ASTM C423).
    // Band indices in materials.json: 0=125, 1=250, 2=500, 3=1k, 4=2k.
    let nrc = null;
    if (absorption && absorption.length >= 5) {
      const vals = [absorption[1], absorption[2], absorption[3], absorption[4]];
      if (vals.every(v => Number.isFinite(v))) {
        nrc = Math.round((vals.reduce((a, b) => a + b, 0) / 4) * 100) / 100;
      }
    }
    return {
      tag: t.id || `T${i + 1}`,
      productId: t.productId || '—',
      name: spec?.name ?? t.productId ?? 'Unknown product',
      manufacturer: spec?.manufacturer ?? '—',
      category: spec?.category ?? '—',
      mounting: spec?.mounting ?? '—',
      location: wallLabel(t?.anchor),
      position: {
        x: t?.position?.x ?? null,
        y: t?.position?.y ?? null,
        z: t?.position?.z ?? null,
      },
      width_m: dim.width_m ?? null,
      height_m: dim.height_m ?? null,
      area_m2: unitArea_m2,
      weight_kg,
      fire_rating: spec?.fire_rating ?? null,
      test_standard: spec?.test_standard ?? null,
      test_lab: spec?.test_lab ?? null,
      test_report_id: spec?.test_report_id ?? null,
      scattering: Array.isArray(spec?.scattering_coefficient)
        ? spec.scattering_coefficient
        : (Number.isFinite(spec?.scattering_coefficient) ? spec.scattering_coefficient : null),
      absorption,    // 7-band α vector or null
      nrc,           // ASTM C423 mean of α(250/500/1k/2k), rounded to 2dp
      alpha500: Number.isFinite(absorption?.[2]) ? absorption[2] : null,
      alpha1k:  Number.isFinite(absorption?.[3]) ? absorption[3] : null,
      clamped: !!t?._physicsClamped,
    };
  });
}

// Build a bare-vs-treated comparison model. Re-runs the RT60 solver
// with treatments=[] for the baseline and with the actual placed
// treatments for the proposed state, then derives the headline KPIs
// Dr. Chen called out: RT60(Sabine+Eyring) per band, Eyring @ 1 kHz,
// mean α @ 1 kHz, Schroeder cutoff. Returns null if no treatments are
// placed — the caller suppresses Chapter 04 in that case.
//
// PURE function. Does NOT mutate state; reads from caller-supplied
// inputs so unit tests can pass synthetic rooms / treatments.
export function buildTreatmentCompareModel({ room, materials, zones, treatments } = {}) {
  if (!Array.isArray(treatments) || treatments.length === 0) return null;
  const bareBands    = computeAllBands({ room, materials, zones, treatments: [] });
  const treatedBands = computeAllBands({ room, materials, zones, treatments });
  const volume = roomVolume(room);

  const eyringAt = (bands, i) => Number.isFinite(bands[i]?.eyring_s) ? bands[i].eyring_s : null;
  const sabineAt = (bands, i) => Number.isFinite(bands[i]?.sabine_s) ? bands[i].sabine_s : null;

  const bareT1k    = eyringAt(bareBands, 3);
  const treatedT1k = eyringAt(treatedBands, 3);
  const bareT500    = eyringAt(bareBands, 2);
  const treatedT500 = eyringAt(treatedBands, 2);
  const bareMidEyr    = (bareT500 != null && bareT1k != null)    ? (bareT500 + bareT1k) / 2    : null;
  const treatedMidEyr = (treatedT500 != null && treatedT1k != null) ? (treatedT500 + treatedT1k) / 2 : null;

  const bareAlpha1k    = bareBands[3]?.meanAbsorption ?? null;
  const treatedAlpha1k = treatedBands[3]?.meanAbsorption ?? null;

  const schroederOf = (t60, V) => (t60 && t60 > 0 && V > 0) ? 2000 * Math.sqrt(t60 / V) : null;
  const bareSchroeder    = schroederOf(bareT1k, volume);
  const treatedSchroeder = schroederOf(treatedT1k, volume);

  // KPI rows for the headline comparison table. Each entry is an
  // intentional pick — these are the numbers a non-technical client
  // reads in a proposal: RT60 mid-band (the "headline second"), STI
  // when available, α as a one-glance density metric, f_s shift to
  // explain low-end behaviour.
  // Δ sign convention: "improvement" is shorter RT60, higher STI,
  // higher α, lower Schroeder. The renderer flips arrow + colour
  // based on `improvementSign`: -1 = lower is better, +1 = higher.
  const kpis = [
    {
      key: 'rt60_mid_eyring',
      label: 'RT60 mid-band (500 Hz / 1 kHz mean) · Eyring',
      unit: 's',
      decimals: 2,
      bare: bareMidEyr,
      treated: treatedMidEyr,
      improvementSign: -1,
    },
    {
      key: 'rt60_1k_eyring',
      label: 'RT60 @ 1 kHz · Eyring',
      unit: 's',
      decimals: 2,
      bare: bareT1k,
      treated: treatedT1k,
      improvementSign: -1,
    },
    {
      key: 'rt60_1k_sabine',
      label: 'RT60 @ 1 kHz · Sabine (reference, ᾱ<0.2)',
      unit: 's',
      decimals: 2,
      bare: sabineAt(bareBands, 3),
      treated: sabineAt(treatedBands, 3),
      improvementSign: -1,
    },
    {
      key: 'mean_alpha_1k',
      label: 'Mean absorption ᾱ @ 1 kHz',
      unit: '',
      decimals: 3,
      bare: bareAlpha1k,
      treated: treatedAlpha1k,
      improvementSign: +1,
    },
    {
      key: 'schroeder_hz',
      label: 'Schroeder cutoff f_s',
      unit: 'Hz',
      decimals: 0,
      bare: bareSchroeder,
      treated: treatedSchroeder,
      improvementSign: -1,
    },
  ];

  return {
    bareBands: bareBands.map(b => ({
      freq_hz: b.frequency_hz,
      sabine_s: Number.isFinite(b.sabine_s) ? b.sabine_s : null,
      eyring_s: Number.isFinite(b.eyring_s) ? b.eyring_s : null,
      meanAbsorption: b.meanAbsorption,
    })),
    treatedBands: treatedBands.map(b => ({
      freq_hz: b.frequency_hz,
      sabine_s: Number.isFinite(b.sabine_s) ? b.sabine_s : null,
      eyring_s: Number.isFinite(b.eyring_s) ? b.eyring_s : null,
      meanAbsorption: b.meanAbsorption,
    })),
    kpis,
    panels_n: treatments.length,
  };
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
  ['Operating-range coverage',
    'scene-design heuristic; BS 5839-8 §17 and IEC 60268-16 recommend programme-level intelligibility verification.',
    'SPL recomputed at three system-input levels (−20 / −10 / 0 dB rel. rated). Levels represent background, programme, and max operating points typical of speech-reinforcement venues. Max-level plot assumes linear extrapolation from 1 W / 1 m sensitivity; real thermal compression (1–3 dB above ~50 % rated drive on compression drivers) is not modelled.'],
  ['STIPA per zone',
    'IEC 60268-16:2020 Annex A & C; Bradley 1986 (D/R-aware MTF); ISO 9921:2003.',
    'Per-band MTF(f_m) = (D + R·m_rev)/(D + R + N) with m_rev = 1/√(1 + (2π f_m T/13.8)²); apparent SNR clamped ±15 dB.'],
  ['Ambient noise floor',
    'ANSI/ASA S12.2-2019 (NC curves); Beranek tab. 18-2.',
    'NC-35 default per-band SPL; user-overridable. Drives N in the STIPA denominator and noise correction in full STI.'],
  ['Critical distance r_c',
    'Beranek 2nd ed. eq. 6-7.',
    'Distance from the source at which direct and reverberant sound are equal in level. Listeners within r_c hear the speaker; beyond r_c they hear the room. r_c = 0.057·√(Q·V/T₆₀) at 1 kHz, Q = 2 (DI ≈ 3 dB, moderately directional). Grows with lower RT60 and higher directivity.'],
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
  ['Precision engine — treatment scattering (v3)',
    'ISO 17497-2:2012 (scattering coefficient); Cox & D\'Antonio 2nd ed. §6.4 & §11.2.',
    'Each ray bouncing off a placed treatment in the precision tracer is reflected diffusely (cosine-weighted hemisphere) with probability equal to the catalogued ISO 17497-2 scattering coefficient s(f) at that frequency band; the complementary probability (1 − s) produces a specular reflection. Absorbers behave the same way with s = 0 (pure specular). Methodology change vs pre-v3: STI, C50, C80 and EDT may shift in rooms with placed treatments. Typical magnitudes are scene-dependent: diffuser-rich rooms exhibit C50 drift in the range of a few tenths of a dB to ~1.5 dB (sign depends on the balance of catalogued α versus s in the chosen product); absorber-rich rooms show RT60 reductions of 5–20 % depending on coverage.'],
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
function renderPrintReport(model, { splGrid = null, coverImage = null } = {}) {
  let root = document.getElementById('print-report');
  if (root) root.remove();
  root = document.createElement('div');
  root.id = 'print-report';

  const sec = (cls, title, body) => `
    <section class="pr-section ${cls}">
      <h2>${escapeHtml(title)}</h2>
      ${body}
    </section>`;

  // ------ Page 1: COVER — room-centric ----------------------------------
  // Sofia v3 (user-requested redesign, 2026-05-13): cover is about the
  // ROOM, not scene-level metrics. Layout:
  //   - title block: project name (h1) + room name (h2, falls back to
  //     "Untitled room"). Date + engine on the right.
  //   - hero: 3D iso perspective render of the room (PNG captured from
  //     the live Three.js viewport). Falls back to the 2D floor plan
  //     when no 3D capture is available (walk mode, scene unmounted).
  //   - inset: small 2D floor plan overlapping the hero's bottom-right
  //     corner. Hairline border + drop shadow so it reads as a callout.
  //   - measurements panel: W×D×H, floor area, volume, surface area,
  //     shape descriptor. Tabular, 5 rows.
  //   - summary: one-sentence plain-English description of the room.
  //   - footer: schema + generated stamp.
  // The 3 KPI tiles (RT60, r_c, Volume) that used to live here moved
  // to the Reverberation chapter on page 2 — they belong with the
  // physics, not on the room-detail cover.
  const room = model.room;
  // 2D plan for the inset. buildFloorPlanSVG already exists for the
  // standalone plan page; reusing it keeps the visual identical. Per-
  // listener SPL / STI labels (model.listenerMetrics) decorate every
  // listener dot — same numbers the live 2D viewport + results panel show.
  const planSvg = (() => {
    try { return buildFloorPlanSVG(state, { compact: true, listenerMetrics: model.listenerMetrics }); }
    catch (err) { console.warn('[print-report] plan SVG failed:', err); return ''; }
  })();
  // Hero — prefer the 3D render. Fallback chain: 3D PNG → 2D plan SVG
  // (full-sized) → an empty-state notice. Cover ALWAYS has something.
  const heroBody = coverImage
    ? `<img class="pr-cover-hero-image" src="${coverImage}" alt="3D perspective view of the room" />`
    : (planSvg
        ? `<div class="pr-cover-hero-plan">${planSvg}</div>`
        : '<p class="pr-empty-state" style="margin:0">3D preview unavailable — visit RoomLAB before printing.</p>');
  // Inset — only show the 2D plan as an inset when we actually have a
  // 3D render to sit on top of. Without the 3D the plan IS the hero;
  // showing it twice would be redundant.
  const insetHtml = (coverImage && planSvg)
    ? `<div class="pr-cover-hero-inset" title="2D plan view">${planSvg}</div>`
    : '';

  const roomNameDisplay = room.name && room.name.length > 0 ? room.name : 'Untitled room';
  // Sofia v5 — measurements card overlays the top-left of the hero; the
  // old below-hero summary is replaced by a proposal-tone description.
  const measurementsRows = `
    <tr><th>Shape</th><td>${escapeHtml(describeShape(room))}</td></tr>
    <tr><th>W × D × H</th><td>${fmt(room.width_m, 2)} × ${fmt(room.depth_m, 2)} × ${fmt(room.height_m, 2)} m</td></tr>
    <tr><th>Floor area</th><td>${fmt(room.baseArea_m2, 1)} m²</td></tr>
    <tr><th>Volume</th><td>${fmt(room.volume_m3, 0)} m³</td></tr>
    <tr><th>Surface area</th><td>${fmt(room.totalArea_m2, 0)} m²</td></tr>`;

  // Proposal description copy — engineer-tone, no marketing fluff.
  // References project + room without repeating them as labels (the
  // title block already carries those). Dynamic where possible:
  // sources / zones / listeners come from the model so the cover
  // narrates what the report actually contains.
  const nSources   = model.sources.length;
  const nListeners = model.listeners.length;
  const nZones     = model.zones.length;
  const hasPrecision = !!model.precision;
  const shapeLabel = describeShape(room);
  const dims = `${fmt(room.width_m, 0)} × ${fmt(room.depth_m, 0)} × ${fmt(room.height_m, 0)} m`;
  const sourcePhrase = nSources === 0
    ? 'a proposed loudspeaker layout'
    : `the proposed ${nSources}-source loudspeaker layout`;
  const coveragePhrase = nZones > 0
    ? `, with intelligibility reported across ${nZones} audience zone${nZones === 1 ? '' : 's'}`
    : (nListeners > 0
        ? `, with intelligibility sampled at ${nListeners} listener position${nListeners === 1 ? '' : 's'}`
        : '');
  const engineNote = hasPrecision
    ? 'Results are computed with the precision ray-tracing engine.'
    : 'Results are computed with the statistical-acoustics engine (Sabine / Eyring).';
  const proposalParagraph = `This document is an acoustic simulation report for the ${dims} ${shapeLabel} room described above. It quantifies reverberation time (RT60) per ISO 3382-1, speech intelligibility (STI / STIPA) per IEC 60268-16, and sound-pressure-level coverage for ${sourcePhrase}${coveragePhrase}. A proposed surface-treatment scheme is presented alongside before-versus-after figures so the acoustic impact of each intervention is auditable. ${engineNote}`;

  // Meta strip — five short lines, scannable, sits under the eyebrow
  // (Scope-table dropped per user v6 — the paragraph is the entire
  // proposal opener now, justified prose, no point-form sidebar.)

  const cover = `
    <div class="pr-page pr-page-cover">
      <div class="pr-cover-titleblock">
        <div>
          <span class="pr-eyebrow">RoomLAB · Acoustic simulation</span>
          <h1>${escapeHtml(model.project.name)}</h1>
          <h2 class="pr-cover-room-name">${escapeHtml(roomNameDisplay)}</h2>
        </div>
        <div class="pr-cover-titleblock-right">
          ${escapeHtml(model.project.date)}<br>
          <span class="pr-mute">${model.precision ? 'precision engine' : 'draft engine'}</span>
        </div>
      </div>
      <div class="pr-cover-hero-wrap">
        <div class="pr-cover-hero">
          ${heroBody}
        </div>
        <aside class="pr-cover-spec-overlay" aria-label="Room specifications">
          <div class="pr-cover-spec-overlay-title">Room specifications</div>
          <table class="pr-cover-spec-overlay-table">
            ${measurementsRows}
          </table>
        </aside>
      </div>
      ${coverImage ? `<div class="pr-cover-hero-caption">Ceiling rendered at 5 % opacity for visibility of room interior.</div>` : ''}
      <section class="pr-cover-proposal">
        <p class="pr-cover-proposal-para">${escapeHtml(proposalParagraph)}</p>
      </section>
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

  // ------ Chapter 04: Acoustic treatment ------------------------------
  // Two pages, only when treatments are placed:
  //   4a — Chapter opener + paired-bar comparison chart + KPI table
  //   4b — Drawing 03 (treatment plan) + per-panel schedule + α matrix
  //
  // Page plan synthesised from Dr. Chen (acoustics) + Sofia (composition)
  // for v2 treatment physics. Comparison metrics picked by Dr. Chen as
  // the 4–6 a non-technical client actually reads: RT60 mid-band, RT60
  // @1k Eyring, α̅, Schroeder f_s. Sabine retained as a reference row
  // bounded by the ᾱ<0.2 caveat.
  //
  // The v1 "visual placement only" disclaimer is removed: as of v2
  // (computeAllBands now folds treatments[]), the RT60/STIPA values
  // ARE the treated values, and the bare-room comparison column lives
  // alongside as the explicit before-state.
  const compare = model.treatmentCompare;
  const schedule = model.treatmentsSchedule || [];
  const treatmentsBom = model.treatmentsBom || [];
  let treatmentPages = '';
  if (compare && schedule.length > 0) {
    // ---- Page 4a: comparison hero -------------------------------------
    const compareChart = renderCompareChart(compare);
    const kpiRows = compare.kpis.map(kpi => {
      const bareStr    = (kpi.bare    != null && Number.isFinite(kpi.bare))    ? `${fmt(kpi.bare, kpi.decimals)}${kpi.unit ? ` ${kpi.unit}` : ''}`    : '—';
      const treatedStr = (kpi.treated != null && Number.isFinite(kpi.treated)) ? `${fmt(kpi.treated, kpi.decimals)}${kpi.unit ? ` ${kpi.unit}` : ''}` : '—';
      let deltaStr = '—';
      let deltaClass = 'pr-delta-neutral';
      if (Number.isFinite(kpi.bare) && Number.isFinite(kpi.treated)) {
        const delta = kpi.treated - kpi.bare;
        const sign = delta === 0 ? 0 : (delta > 0 ? +1 : -1);
        const improved = sign === kpi.improvementSign;
        deltaClass = sign === 0 ? 'pr-delta-neutral'
                   : improved   ? 'pr-delta-improve'
                                : 'pr-delta-regress';
        const arrow = sign === 0 ? '·' : (sign > 0 ? '↑' : '↓');
        deltaStr = `${arrow} ${Math.abs(delta).toFixed(kpi.decimals)}${kpi.unit ? ` ${kpi.unit}` : ''}`;
      }
      return `
        <tr>
          <td>${escapeHtml(kpi.label)}</td>
          <td class="pr-num">${bareStr}</td>
          <td class="pr-num">${treatedStr}</td>
          <td class="pr-num ${deltaClass}">${deltaStr}</td>
        </tr>`;
    }).join('');

    // Dr. Chen's framing sentence — opens the chapter so the reader
    // understands WHY this section exists before reading any numbers.
    const chenFrame = `Speech intelligibility and reverberation control are programme-level safety items in this venue; the treatment package below is a quantified intervention against the bare-room baseline — not a marketing description.`;

    const compareCaption = `Fig. 04.1 — Octave-band RT60 (Eyring per ISO 3382-1) for the bare room (grey) versus the proposed treatment package (red). ${compare.panels_n} panel${compare.panels_n === 1 ? '' : 's'} folded in via the per-wall overlap-clamped Sabine budget (RoomLAB v2). The Sabine reference row in the KPI table is bounded by the ᾱ<0.2 assumption; once ᾱ exceeds 0.2 the Eyring values are the physical answer.`;

    const ch04a = `
      <div class="pr-page pr-page-treatment-hero">
        <div class="pr-chapter-opener">
          <span class="pr-chapter-number-ghost">04</span>
          <span class="pr-eyebrow">Chapter 04</span>
          <h2>Acoustic treatment</h2>
        </div>
        <p class="pr-lead pr-lead-chen">${escapeHtml(chenFrame)}</p>
        <section class="pr-section">
          <div class="pr-compare-chart-wrap">${compareChart}</div>
          <p class="pr-caption">${escapeHtml(compareCaption)}</p>
        </section>
        <section class="pr-section">
          <h3>Before / after — headline metrics</h3>
          <table class="pr-table pr-zebra pr-compare-kpi">
            <thead><tr><th>Metric</th><th class="pr-num">Bare room</th><th class="pr-num">With treatment</th><th class="pr-num">&Delta;</th></tr></thead>
            <tbody>${kpiRows}</tbody>
          </table>
          <p class="pr-note">&Delta; signs follow improvement convention: arrow down ↓ on RT60 / Schroeder, arrow up ↑ on mean α. Green = improvement; red = regression. Sabine row shown for engineer cross-reference only — once ᾱ rises above 0.2 (which is typical for any meaningful treatment package), Eyring is the physical answer.</p>
        </section>
      </div>`;

    // ---- Page 4b: Drawing 03 + per-panel schedule ---------------------
    const planSvg = buildTreatmentPlanSVG(state);
    const scheduleRows = schedule.map(r => {
      const sizeStr = (r.width_m != null && r.height_m != null)
        ? `${fmt(r.width_m, 2)} × ${fmt(r.height_m, 2)}`
        : '—';
      const a500 = Number.isFinite(r.alpha500) ? r.alpha500.toFixed(2) : '—';
      const a1k  = Number.isFinite(r.alpha1k)  ? r.alpha1k.toFixed(2)  : '—';
      const nrc  = Number.isFinite(r.nrc) ? r.nrc.toFixed(2) : '—';
      const weight = (r.weight_kg != null) ? `${fmt(r.weight_kg, 1)} kg` : '—';
      const clampedBadge = r.clamped ? ' <span class="pr-clamp-badge" title="Panel area clamped to host-wall remaining area">clamped</span>' : '';
      return `
        <tr>
          <td class="pr-mono">${escapeHtml(r.tag)}</td>
          <td>${escapeHtml(r.name)}${clampedBadge}</td>
          <td>${escapeHtml(r.manufacturer)}</td>
          <td>${escapeHtml(r.mounting)}</td>
          <td>${escapeHtml(r.location)}</td>
          <td class="pr-num">${sizeStr} m</td>
          <td class="pr-num">${a500}</td>
          <td class="pr-num">${a1k}</td>
          <td class="pr-num">${nrc}</td>
          <td>${escapeHtml(r.fire_rating ?? '—')}</td>
          <td class="pr-num">${weight}</td>
        </tr>`;
    }).join('');

    // Per-band α matrix (Tag × 7 octave bands). Only rendered when at
    // least one panel has an absorption vector — otherwise it's a wall
    // of em-dashes.
    const bandsHz = compare.treatedBands.map(b => b.freq_hz);
    const anyAbsorption = schedule.some(r => Array.isArray(r.absorption));
    const alphaMatrixHead = anyAbsorption
      ? `<tr><th>Tag</th>${bandsHz.map(hz => `<th class="pr-num">${escapeHtml(fmtBand(hz))}</th>`).join('')}</tr>`
      : '';
    const alphaMatrixRows = anyAbsorption
      ? schedule.map(r => `
          <tr>
            <td class="pr-mono">${escapeHtml(r.tag)}</td>
            ${bandsHz.map((_, idx) => {
              const v = r.absorption?.[idx];
              return `<td class="pr-num">${Number.isFinite(v) ? v.toFixed(2) : '—'}</td>`;
            }).join('')}
          </tr>`).join('')
      : '';

    // Aggregate strip — count, total area, total weight.
    const totalCount = schedule.length;
    const totalArea  = schedule.reduce((a, r) => a + (r.area_m2 || 0), 0);
    const weightedRows = schedule.filter(r => r.weight_kg != null);
    const totalWeight = weightedRows.reduce((a, r) => a + r.weight_kg, 0);
    const aggregateLine = `${totalCount} panel${totalCount === 1 ? '' : 's'} · ${fmt(totalArea, 2)} m² total absorbing area · ${weightedRows.length > 0 ? `${fmt(totalWeight, 1)} kg total weight (${weightedRows.length}/${totalCount} panels with catalogued mass)` : 'weight not catalogued'}`;

    // Trace strip — test standards + labs for the panels in the schedule.
    // De-duplicated so a long schedule with the same product family
    // doesn't repeat the same reference 20 times.
    const traceSeen = new Set();
    const traceItems = [];
    for (const r of schedule) {
      const key = `${r.test_standard ?? '—'}|${r.test_lab ?? '—'}|${r.test_report_id ?? '—'}`;
      if (traceSeen.has(key)) continue;
      traceSeen.add(key);
      if (!r.test_standard && !r.test_lab && !r.test_report_id) continue;
      const parts = [];
      if (r.test_standard) parts.push(escapeHtml(r.test_standard));
      if (r.test_lab) parts.push(escapeHtml(r.test_lab));
      if (r.test_report_id) parts.push(`report ${escapeHtml(r.test_report_id)}`);
      traceItems.push(parts.join(' · '));
    }
    const traceLine = traceItems.length > 0
      ? `<p class="pr-note"><strong>Test traceability:</strong> ${traceItems.join('; ')}.</p>`
      : '';

    const ch04b = `
      <div class="pr-page pr-page-treatment-plan">
        <span class="pr-eyebrow">Drawing 03 · Treatment plan, top-down view</span>
        <div class="pr-treatment-plan-grid">
          <div class="pr-treatment-plan-stage">${planSvg}</div>
          <div class="pr-treatment-plan-key">
            <div class="pr-treatment-key-title">Legend</div>
            <div class="pr-treatment-key-row"><span class="pr-treatment-key-swatch" style="background:#4F6E8F"></span>Absorber (porous / panel)</div>
            <div class="pr-treatment-key-row"><span class="pr-treatment-key-swatch" style="background:#2F5560"></span>Bass control</div>
            <div class="pr-treatment-key-row"><span class="pr-treatment-key-swatch" style="background:#B58741"></span>Diffuser</div>
            <div class="pr-treatment-key-row"><span class="pr-treatment-key-swatch pr-treatment-key-ceiling" style="border-color:#4F6E8F"></span>Ceiling-mounted (dashed)</div>
            <div class="pr-treatment-key-row"><span class="pr-treatment-key-swatch" style="background:#9EAA82"></span>Opening / system</div>
          </div>
        </div>
        <p class="pr-caption">Drawing 03 — Treatment placement, top-down. Tags T1…Tn correspond to the rows in the schedule below. Ceiling-mounted panels are drawn with a dashed outline; wall-mounted panels are drawn at their plan-view footprint centred at the placement coordinate.</p>
        <section class="pr-section">
          <h3>Treatment placement schedule</h3>
          <table class="pr-table pr-zebra pr-treatment-schedule">
            <thead><tr>
              <th>Tag</th><th>Product</th><th>Manufacturer</th>
              <th>Mounting</th><th>Location</th>
              <th class="pr-num">Size (m)</th>
              <th class="pr-num">α(500)</th><th class="pr-num">α(1k)</th>
              <th class="pr-num">NRC</th>
              <th>Fire</th>
              <th class="pr-num">Weight</th>
            </tr></thead>
            <tbody>${scheduleRows}</tbody>
          </table>
          <p class="pr-aggregate">${escapeHtml(aggregateLine)}</p>
          ${traceLine}
        </section>
        ${anyAbsorption ? `
          <section class="pr-section">
            <h3>Per-band absorption coefficients α(f)</h3>
            <table class="pr-table pr-zebra pr-alpha-matrix">
              <thead>${alphaMatrixHead}</thead>
              <tbody>${alphaMatrixRows}</tbody>
            </table>
            <p class="pr-note">Values per ISO 354 reverberation-room measurements as supplied by the manufacturer. Mounting condition shown in the schedule above governs the α curve (Type-A flush vs spaced); RoomLAB assumes Type-A flush unless the catalogue entry specifies otherwise. Where a panel's catalogue area exceeded the host wall's remaining area, the panel was clamped (badged in the schedule) and the absorption contribution scaled accordingly.</p>
          </section>` : ''}
      </div>`;

    treatmentPages = ch04a + ch04b;
  }

  // ------ Page 2: SCENE AT A GLANCE — coverage map + 12 KPI tiles ------
  // Per Sofia v2 (post-export-audit): the heatmap on the cover is the
  // headline composition; this page repeats it larger with the numeric
  // legend and the scene-summary tile grid below. Replaces the dead
  // standalone B&W floor-plan page from v1.
  //
  // Cover redesign (Sofia v3, 2026-05-13): the heatmap is no longer on
  // the cover, but THIS page still needs it as the full-size coverage
  // figure. The cover hero is now a 3D render of the room. heatSvg /
  // heatLegend are rebuilt locally here so the heatmap-detail page
  // (and the operating-range strip below) remain unchanged.
  const heatSvg = (model.heatmap && splGrid) ? buildHeatmapPageSVG(state, splGrid, { listenerMetrics: model.listenerMetrics }) : '';
  const heatLegend = (model.heatmap && splGrid) ? buildHeatmapLegend(splGrid) : '';
  // Compute the SVG's viewBox aspect so the stage CSS can size itself
  // to match the room — eliminates the preserveAspectRatio centering
  // empty space the user reported (tall room → no empty top/bottom;
  // wide room → no empty left/right). Falls back to no aspect-ratio
  // style when grid is unavailable.
  const heatViewBox = (model.heatmap && splGrid) ? heatmapPageViewBox(state, splGrid) : null;
  const heatStageStyle = heatViewBox
    ? ` style="aspect-ratio: ${heatViewBox.viewW.toFixed(3)} / ${heatViewBox.viewH.toFixed(3)}"`
    : '';
  const rt60_1k = model.rt60[3];
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
          <div class="pr-heatmap-stage"${heatStageStyle}>${heatSvg}</div>
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

  // ------ Drawing 02: operating-range coverage strip ------------------
  // Per Sofia v3 + Dr. Chen: ONE physics solve, three shifted copies of
  // the same grid at −20 / −10 / 0 dB rel. rated drive. Shared 5 dB-
  // step integer legend below the strip; per-plot sub-caption with
  // min/mean/max so the absolute numbers are in type as well as colour.
  //
  // Suppressed for STI heatmaps (drive offset has no linear meaning on
  // an intelligibility metric) and for the empty-scene case.
  let operatingRangePage = '';
  const heatmapIsSpl = (model.heatmap?.metric ?? 'spl') === 'spl';
  if (heatSvg && splGrid && heatmapIsSpl) {
    const LEVELS = [
      { offsetDb: -20, label: 'Background', sub: '−20 dB rel. rated' },
      { offsetDb: -10, label: 'Programme',  sub: '−10 dB rel. rated' },
      { offsetDb:   0, label: 'Max',        sub: '0 dB rel. rated' },
    ];
    const shifted = LEVELS.map(L => ({
      ...L,
      grid: shiftSplGridByDb(splGrid, L.offsetDb),
    }));
    // Shared integer range derived from the max-level plot (offsetDb=0).
    // Rounded out to 5 dB ticks at both ends so all three plots map
    // cleanly onto a single legend. The lower plots will have darker
    // colours overall; that's the point of the comparison.
    const topGrid = shifted[shifted.length - 1].grid;
    const sharedMin = Math.floor(shifted[0].grid.minSPL_db / 5) * 5;
    const sharedMax = Math.ceil(topGrid.maxSPL_db / 5) * 5;
    const stripCells = shifted.map((L, idx) => {
      const svg = buildHeatmapPageSVG(state, L.grid, { compact: true });
      const sub = `${fmt(L.grid.minSPL_db, 0)} / ${fmt(L.grid.avgSPL_db, 0)} / ${fmt(L.grid.maxSPL_db, 0)} dB · ${L.sub}`;
      return `
        <div class="pr-strip-cell">
          <div class="pr-strip-cell-label">
            <span class="pr-strip-cell-tag">${String(idx + 1).padStart(2, '0')}</span>
            <span class="pr-strip-cell-title">${escapeHtml(L.label)}</span>
          </div>
          <div class="pr-strip-cell-stage">${svg}</div>
          <div class="pr-strip-cell-sub">${escapeHtml(sub)}</div>
        </div>`;
    }).join('');
    const sharedLegend = buildHeatmapStripLegend({
      minDb: sharedMin,
      maxDb: sharedMax,
      stepDb: 5,
      header: `SPL @ 1 kHz · shared scale, ${sharedMin}–${sharedMax} dB`,
    });
    operatingRangePage = `
      <div class="pr-page pr-page-operating-range">
        <span class="pr-eyebrow">Drawing 02 · Operating-range coverage, top-down view</span>
        <div class="pr-strip">${stripCells}</div>
        <div class="pr-strip-legend-wrap">${sharedLegend}</div>
        <p class="pr-caption">
          SPL @ 1 kHz at three operating power levels, shared colour scale. Grey = outside footprint.
          Levels per RoomLAB operating-range model; see methodology.
        </p>
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

  // ------ Page 8: methodology + disclaimers + signature ----------------
  // CLEAN-SLATE REWRITE (Edition 2026-05-14, 9th iteration).
  //
  // The page had been patched 8 rounds with type-property drift between
  // disclaimer / acceptance / reviewer paragraphs. Root cause: too many
  // class names (25+) each carrying its own slightly-different rule set.
  // Replaced with ONE coherent type system on 5 new classes (pg-*).
  //
  // Sofia's spec:
  //   body prose tier  — 7 pt sans, weight 400, line-height 1.35,
  //                      letter-spacing 0, text-align left, hyphens auto
  //   section labels   — 6.5 pt, weight 700, uppercase, letter-spacing
  //                      0.12em, muted colour
  //   micro-cite       — 6 pt italic, weight 400, muted, line-height 1.3
  //   spacing unit     — 3 pt; every vertical gap is k·3pt (3/6/9/12)
  //   methodology grid — 4 columns, column-gap 9pt, balanced height
  //
  // Every paragraph on this page (methodology body, disclaimers,
  // acceptance, reviewer note) is a <p> with class="pg-prose". Identical
  // element + identical class = identical baseline, by construction.
  //
  // Old classes (deleted from print.css in the same commit):
  //   pr-credentials-header, pr-credentials-intro, pr-credentials-method,
  //   pr-credentials-section-h, pr-method-grid, pr-method-entry,
  //   pr-method-heading, pr-method-cite, pr-method-body,
  //   pr-credentials-disclaimer, pr-disclaimer-grid,
  //   pr-credentials-acceptance, pr-acceptance-body, pr-accept-grid,
  //   pr-accept-kv, pr-accept-k, pr-accept-v, pr-accept-ts,
  //   pr-accept-operator, pr-credentials-footer, pr-reviewer-compact,
  //   pr-signoff-table, pr-signoff-cell, pr-signoff-spacer,
  //   pr-signoff-sub, pr-signoff-sub-row, pr-signoff-line, pr-signoff-label
  // (.pr-eyebrow kept — shared with cover / chapter openers / heatmaps.)
  const methodEntries = METHODOLOGY_ENTRIES.map(([heading, cite, method]) => `
    <div class="pg-method-entry">
      <p class="pg-method-heading">${escapeHtml(heading)}</p>
      <p class="pg-method-cite">${escapeHtml(cite)}</p>
      <p class="pg-prose">${escapeHtml(method)}</p>
    </div>
  `).join('');

  const disclaimerProse = DISCLAIMER_BODY.map(p => `<p class="pg-prose">${escapeHtml(p)}</p>`).join('');

  // Terms-of-use acceptance addendum — reads the full record captured
  // by the mandatory terms modal at app load. If the user somehow
  // reaches the print pipeline without an acceptance on record (race,
  // manual sessionStorage clear), fall back to placeholders — the
  // report is still printable but the legal trail is flagged as broken.
  const acceptanceRecord = getAcceptanceRecord();
  const acceptedAtUTC = acceptanceRecord?.acceptedAt || getAcceptanceTimestamp() || 'Not on record';
  const operatorName  = acceptanceRecord?.operatorName || 'Not on record';
  const publicIp      = acceptanceRecord?.publicIp     || 'Not on record';
  const browserStr    = acceptanceRecord?.browser      || 'Not on record';
  const timezoneStr   = acceptanceRecord?.timezone     || 'Not on record';

  // Session-signature grid: 5 captured fields in a single row above the
  // attestation prose. Reviewer's eye lands on operator + IP + UTC first.
  const acceptanceSignatureGrid = `
    <div class="pg-signature-row">
      <div class="pg-signature-cell">
        <span class="pg-signature-key">Author</span>
        <span class="pg-signature-val">${escapeHtml(operatorName)}</span>
      </div>
      <div class="pg-signature-cell">
        <span class="pg-signature-key">Public IP</span>
        <span class="pg-signature-val">${escapeHtml(publicIp)}</span>
      </div>
      <div class="pg-signature-cell">
        <span class="pg-signature-key">Accepted at</span>
        <span class="pg-signature-val">${escapeHtml(acceptedAtUTC)}</span>
      </div>
      <div class="pg-signature-cell">
        <span class="pg-signature-key">Browser / OS</span>
        <span class="pg-signature-val">${escapeHtml(browserStr)}</span>
      </div>
      <div class="pg-signature-cell">
        <span class="pg-signature-key">Timezone</span>
        <span class="pg-signature-val">${escapeHtml(timezoneStr)}</span>
      </div>
    </div>
  `;
  // Acceptance prose — Lin tightened the previous 5-sentence fragment list
  // into 3 cohesive paragraphs. No technical content removed; only the
  // "engineering responsibility for the application of these results
  // rests with the named author and their organisation" verbosity was
  // collapsed into the closing paragraph.
  const acceptanceParagraphs = [
    `${escapeHtml(operatorName)} accessed RoomLAB Suite from the network address recorded above and accepted its terms of use at the timestamp shown. All predictions in this document — reverberation time, speech transmission index, sound pressure level and coverage maps — were generated under that acceptance.`,
    `RoomLAB is a browser-side simulation engine, not a measurement instrument. The standards cited in the methodology block above are implemented, not certified. Engineering responsibility for applying these results rests with the named author.`,
    `Where this report informs an emergency public-address, voice-alarm or safety-of-life installation — including work falling under BS 5839-8, EN 54-16, IEC 60849 or MS IEC 60849 — independent on-site STIPA and SPL verification with calibrated instruments is mandatory before commissioning.`,
  ];
  const acceptanceProse = acceptanceParagraphs.map(p => `<p class="pg-prose">${p}</p>`).join('');

  // Reviewer note rendered as PLAIN <p class="pg-prose"> with no inline
  // emphasis — every paragraph on this page is now structurally identical
  // (one <p>, one class, no nested tags). The em-dash after "Reviewer's
  // note" semantically separates the label from the body.
  const reviewerProse = `<p class="pg-prose">Reviewer's note — Before issuing this report, confirm: (1) the project name on page 1 matches the tendered scheme; (2) the ambient noise floor reflects the venue's measured or specified condition, not a placeholder; (3) listener positions correspond to the seating, standing, or circulation intent of the design. Amend the scene and re-export if any item drifts.</p>`;

  // Single methodology / disclaimers / signature page. ONE A4 portrait,
  // ONE coherent type system, FIVE classes (pg-*). See "CLEAN-SLATE
  // REWRITE" note above the methodEntries builder for the full rationale.
  //
  // Page outline:
  //   h2 page title + intro paragraph
  //   h3 "Methodology" + 4-column grid of 17 entries
  //   h3 "Disclaimers" + 5 prose paragraphs
  //   h3 "Acceptance of terms of use" + signature grid + 3 prose paragraphs
  //   Reviewer's note (one prose paragraph)
  //   Wet-signature row: 3 cells (Author / Company / Date)
  const combinedPage = `
    <div class="pr-page pg-methodology">
      <h2 class="pg-page-title">Methodology, Standards &amp; Disclaimers</h2>
      <p class="pg-prose pg-intro">${escapeHtml(DISCLAIMER_INTRO)} Each metric below names the standard it follows and the assumption baked in, so a reviewing engineer can trace any number back to its source.</p>

      <h3 class="pg-section-label">Methodology — how each figure is computed</h3>
      <div class="pg-method-grid">${methodEntries}</div>

      <h3 class="pg-section-label">Disclaimers — known limits of this model</h3>
      ${disclaimerProse}

      <h3 class="pg-section-label">Acceptance of terms of use — session signature</h3>
      ${acceptanceSignatureGrid}
      ${acceptanceProse}

      ${reviewerProse}

      <table class="pg-signoff" role="presentation">
        <tr class="pg-signoff-sub-row">
          <th class="pg-signoff-sub">Signature</th>
          <td class="pg-signoff-spacer" aria-hidden="true"></td>
          <th class="pg-signoff-sub">Signature / Stamp</th>
          <td class="pg-signoff-spacer" aria-hidden="true"></td>
          <th class="pg-signoff-sub">Date</th>
        </tr>
        <tr>
          <td class="pg-signoff-cell">
            <span class="pg-signoff-line" aria-hidden="true"></span>
            <span class="pg-signoff-label">Author</span>
          </td>
          <td class="pg-signoff-spacer" aria-hidden="true"></td>
          <td class="pg-signoff-cell">
            <span class="pg-signoff-line" aria-hidden="true"></span>
            <span class="pg-signoff-label">Company</span>
          </td>
          <td class="pg-signoff-spacer" aria-hidden="true"></td>
          <td class="pg-signoff-cell">
            <span class="pg-signoff-line" aria-hidden="true"></span>
            <span class="pg-signoff-label">Date</span>
          </td>
        </tr>
      </table>
    </div>`;

  root.innerHTML = `
    ${cover}
    ${heatmapPage}
    ${operatingRangePage}
    ${roomPage}
    ${sourcePage}
    ${listenerPage}
    ${precisionPage}
    ${treatmentPages}
    ${combinedPage}
    <!-- Footer band removed per user request (Edition 2026-05-14). The
         CSS-rendered page numbers in the @page bottom-right margin box
         (css/print.css ~line 52) still appear on every page. -->

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

// ---------------------------------------------------------------------------
// renderCompareChart — paired-bar RT60-Eyring chart for Chapter 04.
// Two bars per octave band: bare-room baseline (mid-grey) and treated
// (#8C2A2A accent). Shared y-axis with the room's RT60 chart so a
// reviewer flipping pages sees the same vertical scale. Per Sofia's
// "visual continuity" call.
//
// Same SVG-in-millimetres approach as renderRT60Chart so the figure
// is self-contained and prints crisply.
// ---------------------------------------------------------------------------
function renderCompareChart(compare) {
  if (!compare || !Array.isArray(compare.treatedBands) || compare.treatedBands.length === 0) return '';
  const N = compare.treatedBands.length;

  // Pair values per band: prefer Eyring (correct when ᾱ > 0.2 — which
  // is precisely the regime any meaningful treatment package pushes us
  // into). Fall back to Sabine if Eyring is null/Infinity.
  const pairs = [];
  for (let i = 0; i < N; i++) {
    const b = compare.bareBands[i];
    const t = compare.treatedBands[i];
    const bareV    = Number.isFinite(b?.eyring_s) ? b.eyring_s : (Number.isFinite(b?.sabine_s) ? b.sabine_s : null);
    const treatedV = Number.isFinite(t?.eyring_s) ? t.eyring_s : (Number.isFinite(t?.sabine_s) ? t.sabine_s : null);
    pairs.push({
      freq_hz: t?.freq_hz ?? b?.freq_hz ?? null,
      bare: bareV,
      treated: treatedV,
    });
  }
  const finite = pairs.flatMap(p => [p.bare, p.treated]).filter(v => Number.isFinite(v));
  if (finite.length === 0) return '';

  // ---- Plot geometry (mm) -------------------------------------------
  const W = 180, H = 75;
  const padL = 14, padR = 6, padT = 8, padB = 14;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const plotX = padL;
  const plotY = padT;

  // Y range: anchor at 1.5 s like renderRT60Chart so Chapter 02 and
  // Chapter 04 share the same vertical scale visually.
  const maxRaw = Math.max(...finite) * 1.15;
  const yMax = Math.max(1.5, Math.ceil(maxRaw * 2) / 2);

  const groupW = plotW / N;
  const innerPad = 0.18 * groupW;
  const barW = (groupW - innerPad * 2) / 2 - 0.6;          // 0.6 mm gutter between bars in a pair
  const xOf = (i) => plotX + i * groupW;
  const yOf = (v) => plotY + plotH - (v / yMax) * plotH;

  // ---- Gridlines ----------------------------------------------------
  const grid = [];
  for (let v = 0; v <= yMax + 1e-6; v += 0.25) {
    const y = yOf(v);
    const isMajor = Math.abs((v * 2) % 1) < 1e-6;
    const sw = isMajor ? 0.12 : 0.06;
    grid.push(`<line x1="${plotX.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(plotX + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#C9C5BC" stroke-width="${sw}" />`);
  }

  // ---- Y-axis tick labels (every 0.5 s) -----------------------------
  const yLabels = [];
  for (let v = 0; v <= yMax + 1e-6; v += 0.5) {
    const y = yOf(v);
    yLabels.push(`<text x="${(plotX - 1.5).toFixed(2)}" y="${(y + 0.9).toFixed(2)}" text-anchor="end" font-size="2.4" fill="#6B6F75">${v.toFixed(1)}</text>`);
  }
  yLabels.push(`<text x="${(plotX - 10).toFixed(2)}" y="${(plotY + plotH / 2).toFixed(2)}" text-anchor="middle" font-size="2.4" font-weight="600" fill="#1A1F24" transform="rotate(-90 ${(plotX - 10).toFixed(2)} ${(plotY + plotH / 2).toFixed(2)})">RT60 (s)</text>`);

  // ---- Bars ---------------------------------------------------------
  const BARE_FILL    = '#A9A6A0';
  const TREATED_FILL = '#8C2A2A';
  const bars = [];
  const valueLabels = [];
  const xLabels = [];
  for (let i = 0; i < N; i++) {
    const groupX = xOf(i);
    const cx = groupX + groupW / 2;
    // Bare bar (left)
    if (Number.isFinite(pairs[i].bare)) {
      const v = Math.min(pairs[i].bare, yMax);
      const y = yOf(v);
      const x = cx - barW - 0.3;
      bars.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${(plotY + plotH - y).toFixed(2)}" fill="${BARE_FILL}" />`);
      valueLabels.push(`<text x="${(x + barW / 2).toFixed(2)}" y="${(y - 0.8).toFixed(2)}" text-anchor="middle" font-size="2.0" fill="#1A1F24">${pairs[i].bare.toFixed(2)}</text>`);
    }
    // Treated bar (right)
    if (Number.isFinite(pairs[i].treated)) {
      const v = Math.min(pairs[i].treated, yMax);
      const y = yOf(v);
      const x = cx + 0.3;
      bars.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${(plotY + plotH - y).toFixed(2)}" fill="${TREATED_FILL}" />`);
      valueLabels.push(`<text x="${(x + barW / 2).toFixed(2)}" y="${(y - 0.8).toFixed(2)}" text-anchor="middle" font-size="2.0" fill="#1A1F24">${pairs[i].treated.toFixed(2)}</text>`);
    }
    // x-axis tick label
    const hz = pairs[i].freq_hz;
    const lbl = hz == null ? '' : (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);
    xLabels.push(`<text x="${cx.toFixed(2)}" y="${(plotY + plotH + 4).toFixed(2)}" text-anchor="middle" font-size="2.4" fill="#6B6F75">${lbl}</text>`);
  }
  const xAxisTitle = `<text x="${(plotX + plotW / 2).toFixed(2)}" y="${(plotY + plotH + 9).toFixed(2)}" text-anchor="middle" font-size="2.4" font-weight="600" fill="#1A1F24">Octave-band centre frequency (Hz)</text>`;

  // ---- Plot frame ----------------------------------------------------
  const frame = `
    <line x1="${plotX.toFixed(2)}" y1="${plotY.toFixed(2)}" x2="${plotX.toFixed(2)}" y2="${(plotY + plotH).toFixed(2)}" stroke="#1A1F24" stroke-width="0.16" />
    <line x1="${plotX.toFixed(2)}" y1="${(plotY + plotH).toFixed(2)}" x2="${(plotX + plotW).toFixed(2)}" y2="${(plotY + plotH).toFixed(2)}" stroke="#1A1F24" stroke-width="0.16" />`;

  // ---- Legend (top-right of plot) -----------------------------------
  const lx = plotX + plotW - 35;
  const ly = plotY + 3;
  const legend = `
    <g>
      <rect x="${lx.toFixed(2)}" y="${(ly - 1.6).toFixed(2)}" width="3.5" height="2.0" fill="${BARE_FILL}" />
      <text x="${(lx + 4.5).toFixed(2)}" y="${(ly + 0.1).toFixed(2)}" font-size="2.4" fill="#1A1F24">Bare room</text>
      <rect x="${(lx + 15).toFixed(2)}" y="${(ly - 1.6).toFixed(2)}" width="3.5" height="2.0" fill="${TREATED_FILL}" />
      <text x="${(lx + 19.5).toFixed(2)}" y="${(ly + 0.1).toFixed(2)}" font-size="2.4" fill="#1A1F24">With treatment</text>
    </g>`;

  return `<svg class="pr-compare-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" width="180mm" height="75mm">
    ${grid.join('')}
    ${frame}
    ${bars.join('')}
    ${valueLabels.join('')}
    ${yLabels.join('')}
    ${xLabels.join('')}
    ${xAxisTitle}
    ${legend}
  </svg>`;
}

// ---------------------------------------------------------------------------
// buildTreatmentPlanSVG — Drawing 03. Top-down floor plan with each
// placed treatment rendered as a small filled rectangle, colour-coded
// by category, with an index tag matching the schedule row.
//
// Mirrors print-heatmap.js coordinate frame (1.5 m margin, depth-flip
// for the SVG Y axis) so the plan layout is interchangeable with
// Drawing 01.
//
// Why a separate plan (not "overlay treatments on the SPL heatmap"):
// (a) the SPL hero ships even with no treatments — overlaying would
// force a special case there; (b) the schedule reader wants
// uncluttered placement (no colour gradient distraction); (c) treatment
// colour is by category, separate from the metric ramp.
// ---------------------------------------------------------------------------
function buildTreatmentPlanSVG(stateRef) {
  const room = stateRef?.room;
  if (!room || !(room.width_m > 0) || !(room.depth_m > 0)) return '';
  const treatments = stateRef.treatments || [];
  if (treatments.length === 0) return '';

  const MARGIN = 1.5;
  const offsetX = MARGIN;
  const viewW = room.width_m + 2 * MARGIN;
  const viewH = room.depth_m + 2 * MARGIN;
  // Y-flip anchor (v=458): SVG pixel where world-Y=0 lands. World-Y=
  // depth_m (north / FRONT wall) renders at SVG y=MARGIN (top of page).
  // Matches print-plan-svg.js + print-heatmap.js exactly.
  const anchorY = MARGIN + room.depth_m;

  // State +y grows toward the north / FRONT wall. SVG y grows DOWN. We
  // invert y so state +y renders UP the page — math convention, matching
  // the live 2D plan in room-2d.js.
  const project = (x, y) => ({ sx: x + offsetX, sy: anchorY - y });

  // ---- Room outline -------------------------------------------------
  const stroke = '#222';
  const sw = 0.06;
  let outlineEl = '';
  if (room.shape === 'rectangular') {
    outlineEl = `<rect x="${offsetX.toFixed(3)}" y="${(anchorY - room.depth_m).toFixed(3)}" width="${room.width_m.toFixed(3)}" height="${room.depth_m.toFixed(3)}" fill="#F8F6F1" stroke="${stroke}" stroke-width="${sw}" />`;
  } else if (room.shape === 'polygon') {
    const cx = room.width_m / 2 + offsetX;
    const cy = anchorY - room.depth_m / 2;
    const r = room.polygon_radius_m;
    const N = room.polygon_sides;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
      pts.push(`${(cx + r * Math.cos(angle)).toFixed(3)},${(cy - r * Math.sin(angle)).toFixed(3)}`);
    }
    outlineEl = `<polygon points="${pts.join(' ')}" fill="#F8F6F1" stroke="${stroke}" stroke-width="${sw}" />`;
  } else if (room.shape === 'round') {
    const cx = room.width_m / 2 + offsetX;
    const cy = anchorY - room.depth_m / 2;
    outlineEl = `<circle cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" r="${room.round_radius_m.toFixed(3)}" fill="#F8F6F1" stroke="${stroke}" stroke-width="${sw}" />`;
  } else if (room.shape === 'custom') {
    const verts = room.custom_vertices || [];
    if (verts.length >= 3) {
      const pts = verts.map(v => {
        const p = project(v.x, v.y);
        return `${p.sx.toFixed(3)},${p.sy.toFixed(3)}`;
      }).join(' ');
      outlineEl = `<polygon points="${pts}" fill="#F8F6F1" stroke="${stroke}" stroke-width="${sw}" />`;
    }
  }

  // ---- Treatment rectangles -----------------------------------------
  // Category → fill colour (Sofia's palette).
  const categoryColor = (cat) => {
    if (!cat) return '#4F6E8F';
    if (cat.startsWith('absorber')) return '#4F6E8F';
    if (cat.startsWith('bass'))     return '#2F5560';
    if (cat.startsWith('diffuser')) return '#B58741';
    if (cat.startsWith('opening'))  return '#9EAA82';
    return '#5B5048';
  };
  // For ceiling-mounted treatments: render a small dashed-outline
  // rectangle (no fill darkening) so the reader sees that the panel is
  // overhead, not on the floor footprint. Tag colour stays the same.
  const treatmentEls = treatments.map((t, i) => {
    const spec = t?._cachedSpec || findCatalogueEntry(t?.productId) || null;
    const fill = categoryColor(spec?.category);
    const isCeiling = t?.anchor?.surface === 'ceiling';
    const px = t?.position?.x ?? (room.width_m / 2);
    const py = t?.position?.y ?? (room.depth_m / 2);
    const p = project(px, py);
    const w = Math.max(0.18, (t?.dimensions?.width_m ?? 0.6));
    const h = Math.max(0.18, (t?.dimensions?.height_m ?? 0.6));
    // For plan view, the treatment is shown as its footprint-equivalent
    // rectangle centred at the placement position. Wall-mounted panels
    // are drawn flush to the wall edge in the schematic; ceiling tiles
    // are drawn at their xy with a dashed outline.
    const rx = p.sx - w / 2;
    const ry = p.sy - h / 2;
    const tag = t.id || `T${i + 1}`;
    const rectEl = isCeiling
      ? `<rect x="${rx.toFixed(3)}" y="${ry.toFixed(3)}" width="${w.toFixed(3)}" height="${h.toFixed(3)}" fill="${fill}" fill-opacity="0.35" stroke="${fill}" stroke-width="0.05" stroke-dasharray="0.18 0.12" />`
      : `<rect x="${rx.toFixed(3)}" y="${ry.toFixed(3)}" width="${w.toFixed(3)}" height="${h.toFixed(3)}" fill="${fill}" fill-opacity="0.85" stroke="#1A1F24" stroke-width="0.04" />`;
    const tagEl = `<text x="${p.sx.toFixed(3)}" y="${(p.sy + 0.16).toFixed(3)}" font-size="0.40" text-anchor="middle" fill="#fff" stroke="#1A1F24" stroke-width="0.05" paint-order="stroke">${escapeHtml(tag)}</text>`;
    return rectEl + tagEl;
  }).join('');

  // ---- Scale bar (re-uses heatmap convention) -----------------------
  const NICE = [0.5, 1, 2, 5, 10, 20];
  const target = room.width_m / 5;
  let barLen = NICE[0];
  let bestD = Math.abs(barLen - target);
  for (const v of NICE) { const d = Math.abs(v - target); if (d < bestD) { barLen = v; bestD = d; } }
  const barX = offsetX;
  const barY = viewH - MARGIN * 0.35;
  const tickH = 0.15;
  const scaleBar = `
    <g class="pr-plan-scalebar">
      <line x1="${barX.toFixed(3)}" y1="${barY.toFixed(3)}" x2="${(barX + barLen).toFixed(3)}" y2="${barY.toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <line x1="${barX.toFixed(3)}" y1="${(barY - tickH).toFixed(3)}" x2="${barX.toFixed(3)}" y2="${(barY + tickH).toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <line x1="${(barX + barLen).toFixed(3)}" y1="${(barY - tickH).toFixed(3)}" x2="${(barX + barLen).toFixed(3)}" y2="${(barY + tickH).toFixed(3)}" stroke="#000" stroke-width="0.07" />
      <text x="${(barX + barLen / 2).toFixed(3)}" y="${(barY - 0.28).toFixed(3)}" font-size="0.42" text-anchor="middle" fill="#000">${barLen} m</text>
    </g>`;

  // North arrow REMOVED from SVG content (was scaling with the room).
  // Print containers render the arrow as a fixed-CSS-pixel HTML overlay
  // (see print.css for the ::after pseudo-element on the stage wrapper).

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewW.toFixed(3)} ${viewH.toFixed(3)}" preserveAspectRatio="xMidYMid meet" class="pr-treatment-plan-svg">${outlineEl}${treatmentEls}${scaleBar}</svg>`;
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
  // LOWEST STI as the headline figure — that's the LIMITING listener,
  // the binding sign-off constraint a BOMBA reviewer cares about.
  // (Renamed from 'worst-zone' for client-facing reading; the metric
  // is unchanged.)
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
        <div class="pr-precision-sti-label">Limiting listener — STI · IEC 60268-16</div>
        <div class="pr-precision-sti">${fmt(stiMin, 2)}</div>
      </div>
      <div>
        ${tierStrip}
        <p class="pr-note" style="margin-top:4pt">${stiTier === 2 ? 'Above the IEC 60849 emergency-PA threshold (0.50). Verify with in-situ commissioning.' : stiTier === 1 ? 'Marginal — between the BS 5839-8 floor (0.45) and the IEC 60849 threshold (0.50). Treatment recommended.' : 'Below the BS 5839-8 floor (0.45). Treatment required before submission.'}</p>
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

export async function triggerPrint() {
  if (!_printMaterialsRef) {
    console.warn('[print-report] mountPrintReport() never called — materials reference missing');
    return;
  }
  // Compute the grid ONCE here (so buildPrintModel's metadata and the
  // renderer's hero heatmap come from the same data) instead of twice.
  const rt60Bands = computeAllBands({ room: state.room, materials: _printMaterialsRef, zones: state.zones, treatments: state.treatments });
  const t60_1k = rt60Bands[3]?.eyring_s ?? rt60Bands[3]?.sabine_s ?? null;
  const splGrid = ensurePrintSplGrid({ materials: _printMaterialsRef, t60_1k });
  // 3D viewport snapshot for the cover hero. Lazily imports scene.js
  // (which pulls Three.js) so the headless test harness can still
  // build a print model without that dependency. Returns null when
  // the scene hasn't mounted yet (user printed from a non-3D Lab),
  // walk mode is active, or WebGL context is lost — renderPrintReport
  // handles null by falling back to the 2D plan as the hero.
  let coverImage = null;
  try {
    const captureFn = await _loadCaptureFn();
    if (captureFn) coverImage = captureFn({ width: 1500, height: 1500, preset: 'iso' });
  } catch (err) { console.warn('[print-report] capture failed:', err); }
  const model = buildPrintModel({ materials: _printMaterialsRef });
  renderPrintReport(model, { splGrid, coverImage });

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

  // (Title-blanking trick reverted: most browsers fall back to the
  // page URL — "localhost:8000/#/room" or similar — when title is
  // empty, which is worse than "RoomLAB Suite". To strip the centre
  // header entirely, the user must uncheck "Headers and footers" in
  // their print dialog — no programmatic alternative.)

  requestAnimationFrame(() => { window.print(); });
}

export function mountPrintReport({ materials }) {
  _printMaterialsRef = materials;

  // Warm-load the scene.js capture path so the synchronous beforeprint
  // handler below can call it without waiting on a dynamic import. By
  // the time the user opens the print dialog (seconds later at the
  // earliest), the module is cached.
  _loadCaptureFn();

  window.addEventListener('beforeprint', () => {
    if (!_printMaterialsRef) return;
    if (document.getElementById('print-report')) return;
    const rt60Bands = computeAllBands({ room: state.room, materials: _printMaterialsRef, zones: state.zones, treatments: state.treatments });
    const t60_1k = rt60Bands[3]?.eyring_s ?? rt60Bands[3]?.sabine_s ?? null;
    const splGrid = ensurePrintSplGrid({ materials: _printMaterialsRef, t60_1k });
    // 3D viewport snapshot for the cover hero. _captureFn is populated
    // by the warm-load above — if it's still null at this point the
    // import is still in flight and we fall back to the 2D plan.
    let coverImage = null;
    try {
      if (_captureFn) coverImage = _captureFn({ width: 1500, height: 1500, preset: 'iso' });
    } catch (err) { console.warn('[print-report] capture failed:', err); }
    const model = buildPrintModel({ materials: _printMaterialsRef });
    renderPrintReport(model, { splGrid, coverImage });
  });

  window.addEventListener('afterprint', () => {
    document.getElementById('print-report')?.remove();
  });
}
