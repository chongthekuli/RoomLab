export const POSTURE_EAR_HEIGHTS_M = {
  standing: 1.60,
  sitting_chair: 1.15,
  sitting_floor: 0.85,
};

export const POSTURE_LABELS = {
  standing: 'Standing',
  sitting_chair: 'Sitting in chair',
  sitting_floor: 'Sitting on floor',
  custom: 'Custom height',
};

export const SHAPE_LABELS = {
  rectangular: 'Rectangular',
  polygon: 'Regular polygon',
  round: 'Round',
  custom: 'Custom (drawn)',
};

export const CEILING_LABELS = {
  flat: 'Flat',
  dome: 'Domed (spherical cap)',
};

export function earHeightFor(listener) {
  if (!listener) return 1.2;
  const elev = listener.elevation_m ?? 0;
  if (listener.posture === 'custom' && typeof listener.custom_ear_height_m === 'number') {
    return listener.custom_ear_height_m;
  }
  return elev + (POSTURE_EAR_HEIGHTS_M[listener.posture] ?? 1.2);
}

export function getSelectedListener() {
  if (state.selectedListenerId == null) return null;
  return state.listeners.find(l => l.id === state.selectedListenerId) || null;
}

export const ZONE_COLORS = [
  '#a855f7', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#6366f1',
];
export function colorForZone(idx) { return ZONE_COLORS[idx % ZONE_COLORS.length]; }

export const SPEAKER_GROUPS = [
  { id: 'A', label: 'Group A', color: '#ef4444' },
  { id: 'B', label: 'Group B', color: '#3b82f6' },
  { id: 'C', label: 'Group C', color: '#10b981' },
  { id: 'D', label: 'Group D', color: '#f59e0b' },
  { id: 'E', label: 'Group E', color: '#a855f7' },
  { id: 'F', label: 'Group F', color: '#ec4899' },
];
export function groupById(id) { return SPEAKER_GROUPS.find(g => g.id === id) || null; }
export function colorForGroup(id) { return groupById(id)?.color ?? '#ffffff'; }

export const SPEAKER_CATALOG = [
  { url: 'data/loudspeakers/generic-12inch.json',       label: 'Generic 12" 2-way' },
  { url: 'data/loudspeakers/compact-6inch.json',        label: 'Compact 6" monitor' },
  { url: 'data/loudspeakers/line-array-element.json',   label: 'Line-array element' },
  // ----- Amperes Electronics ceiling speakers (ampereselectronics.com) -----
  { url: 'data/loudspeakers/amperes-cs210.json',        label: 'Amperes CS210 (2\" dual-cone)' },
  { url: 'data/loudspeakers/amperes-cs343.json',        label: 'Amperes CS343 (4\" IP65)' },
  { url: 'data/loudspeakers/amperes-cs510.json',        label: 'Amperes CS510 (5\" dual-cone)' },
  { url: 'data/loudspeakers/amperes-cs515.json',        label: 'Amperes CS515 (5\" honeycomb)' },
  { url: 'data/loudspeakers/amperes-cs516.json',        label: 'Amperes CS516 (5\" surface)' },
  { url: 'data/loudspeakers/amperes-cs518.json',        label: 'Amperes CS518 (5\" square co-axial)' },
  { url: 'data/loudspeakers/amperes-cs520.json',        label: 'Amperes CS520 (5\" co-axial)' },
  { url: 'data/loudspeakers/amperes-cs606.json',        label: 'Amperes CS606 (6\" metal)' },
  { url: 'data/loudspeakers/amperes-cs606fr-e.json',    label: 'Amperes CS606FR-E (EN54)' },
  { url: 'data/loudspeakers/amperes-cs610.json',        label: 'Amperes CS610 (6\" dual-cone)' },
  { url: 'data/loudspeakers/amperes-cs610b.json',       label: 'Amperes CS610B (6\" 10 W)' },
  { url: 'data/loudspeakers/amperes-cs620.json',        label: 'Amperes CS620 (6.5\" co-axial)' },
  { url: 'data/loudspeakers/amperes-cs630.json',        label: 'Amperes CS630 (6.5\" 30 W co-axial)' },
  { url: 'data/loudspeakers/amperes-cs840.json',        label: 'Amperes CS840 (8\" 40 W co-axial)' },
];
// Per-preset room data lives in js/presets/*.js — imported once below.
// Helpers (rectVerts, generateTieredBowl, etc.) live in presets/_shared.js
// and are consumed by the preset files, not by this module directly.
import { PRESETS } from './presets/index.js';
export { PRESETS };

// ---------------------------------------------------------------------------
// Line-array expansion — one "compound" source entry expands to N element
// sources, each with its own position and aim. Matches how EASE Focus /
// EASE 5 handle line arrays: each element is an independent directional
// point source whose SPL contribution sums at every listener.
//
// A line-array source entry has shape:
//   {
//     kind: 'line-array',
//     modelUrl, groupId, id,
//     origin: { x, y, z },           // top rigging pin location
//     baseYaw_deg,                    // horizontal aim of whole hang
//     topTilt_deg,                    // flown angle — pitch of the top element
//     splayAnglesDeg: [2, 3, 4, ...], // cumulative splay between element i and i+1
//     elementSpacing_m,               // vertical spacing (≈ cabinet height)
//     power_watts_each,
//   }
// Element count = splayAnglesDeg.length + 1 (first element has no leading splay).
// ---------------------------------------------------------------------------
// Cabinet dimensions by speaker model. Mirror of the table in scene.js —
// kept here because expansion math needs depth to compute the cabinet center
// offset from the top-back rigging pin.
function lineArrayCabinetDims(modelUrl) {
  const url = modelUrl || '';
  if (/line-array/i.test(url)) return { h: 0.42, d: 0.45 };
  if (/compact-6/i.test(url))  return { h: 0.36, d: 0.24 };
  return { h: 0.66, d: 0.38 };
}

export function expandLineArrayToElements(src) {
  const splays = src.splayAnglesDeg || [];
  const n = (src.elementCount ?? (splays.length + 1));
  const dims = lineArrayCabinetDims(src.modelUrl);
  // elementSpacing_m is the cabinet height — adjacent cabinets butt against
  // each other along their back edges (spacing = h means bottom-back of
  // cabinet i is the top-back of cabinet i+1).
  const h = src.elementSpacing_m ?? dims.h;
  const d = src.cabinetDepth_m ?? dims.d;
  const topTilt = src.topTilt_deg ?? 0;
  const yaw = src.baseYaw_deg ?? 0;
  const origin = src.origin || src.position || { x: 0, y: 0, z: 0 };
  const power = src.power_watts_each ?? 500;
  const yawRad = yaw * Math.PI / 180;

  const elements = [];
  let curPitch = topTilt;
  // curRig is the TOP-BACK corner of the current cabinet — real line-array
  // rigging pivots around this point, so adjacent cabinets share their back
  // edge and only splay the fronts apart (no back-side overlap).
  let curRig = { x: origin.x, y: origin.y, z: origin.z };

  for (let i = 0; i < n; i++) {
    const pitchRad = curPitch * Math.PI / 180;
    // Cabinet-local axes expressed in world state coords (x=width, y=depth, z=height):
    //   aim = local −Z (front face normal, the direction the speaker points)
    //   up  = local +Y (cabinet vertical, tilted forward when pitch<0)
    //   down = local −Y, back = local +Z
    const aimX =  Math.sin(yawRad) * Math.cos(pitchRad);
    const aimY =  Math.cos(yawRad) * Math.cos(pitchRad);
    const aimZ =  Math.sin(pitchRad);
    const downX =  Math.sin(yawRad) * Math.sin(pitchRad);
    const downY =  Math.cos(yawRad) * Math.sin(pitchRad);
    const downZ = -Math.cos(pitchRad);
    // Geometric center of cabinet (rendering + point-source location): from
    // the top-back rig, go h/2 DOWN and d/2 FORWARD. Placing the rig at the
    // top-back corner matches real rigging hardware and makes the back edges
    // of adjacent cabinets align when splayed.
    const center = {
      x: curRig.x + (h / 2) * downX + (d / 2) * aimX,
      y: curRig.y + (h / 2) * downY + (d / 2) * aimY,
      z: curRig.z + (h / 2) * downZ + (d / 2) * aimZ,
    };
    elements.push({
      modelUrl: src.modelUrl,
      position: center,
      aim: { yaw, pitch: curPitch, roll: 0 },
      power_watts: power,
      groupId: src.groupId,
      arrayId: src.id ?? null,
      elementIndex: i,
      rigPoint: { ...curRig },
    });
    // Next element's top-back rig = this element's bottom-back corner.
    curRig = {
      x: curRig.x + h * downX,
      y: curRig.y + h * downY,
      z: curRig.z + h * downZ,
    };
    // Apply splay: positive splay = "this much more downward than the
    // element above". Pitch is negative for downward aim, so splay subtracts.
    curPitch -= splays[i] ?? 0;
  }
  return elements;
}

// Flatten any mix of single sources + line-array compound entries into the
// list of physical element sources used everywhere SPL math + rendering runs.
export function expandSources(sources) {
  const out = [];
  for (const s of sources) {
    if (s && s.kind === 'line-array') {
      for (const el of expandLineArrayToElements(s)) out.push(el);
    } else {
      out.push(s);
    }
  }
  return out;
}

export const state = {
  room: {
    shape: 'polygon',
    polygon_sides: 16,
    polygon_radius_m: 10,
    round_radius_m: 2.5,
    width_m: 20,
    height_m: 7,
    depth_m: 20,
    ceiling_type: 'dome',
    ceiling_dome_rise_m: 1.5,
    custom_vertices: null,
    stadiumStructure: null,
    // Multi-level structure for shopping-mall / atrium-based buildings.
    // When present, scene.js renders floor slabs with an atrium cut-out,
    // structural columns, and escalator ramps. Built for the Pavilion 2
    // Bukit Jalil preset.
    multiLevelStructure: null,
    surfaces: {
      floor: 'wood-floor',
      ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board',
      wall_south: 'gypsum-board',
      wall_east: 'gypsum-board',
      wall_west: 'gypsum-board',
      walls: 'gypsum-board',
      edges: null,
    },
  },
  sources: [],
  // Speaker being examined in the Speaker viewport tab. Holds the modelUrl
  // of the selected catalogue entry; null when no speaker is under review.
  selectedSpeakerUrl: null,
  listeners: [],
  selectedListenerId: null,
  zones: [],
  selectedZoneId: null,
  results: {
    // Draft-engine outputs (current Sabine / Hopkins-Stryker / STIPA) —
    // re-used names for backward compat; the entire block is conceptually
    // "state.results.draft" from the dual-engine blueprint's perspective.
    rt60: null, splGrid: null, zoneGrids: [],
    // Precision-engine outputs (ISM + stochastic ray tracer, Phase B+).
    // Stays null until the user manually triggers a Render; once populated
    // the UI treats it as authoritative over the draft numbers for the
    // same room/source/receiver configuration (per Phase 1 decision).
    precision: null,
    // Metadata the UI reads to know whether precision is in flight, stale,
    // or fresh. `staleAt` ms-timestamp marks the first mutation AFTER the
    // render completed — result stays visible but flagged as stale.
    engines: {
      draft:     { lastRun: null },
      precision: { lastRun: null, inProgress: false, staleAt: null, cancellable: false },
    },
  },
  display: {
    showHeatmaps: true, showAimLines: false, showIsobars: true, isobarStep_db: 3,
    // Heatmap metric — 'spl' paints SPL dB vertex colors + the 60–110 dB
    // legend; 'stipa' paints the IEC 60268-16 speech-intelligibility index
    // (0–1) + a different legend scale. Toggled from the toolbar.
    heatmapMode: 'spl',
  },
  // Physics model toggles (see spl-calculator.js). Reverberant field is OFF
  // by default — the Hopkins-Stryker statistical reverb is spatially uniform,
  // so when it dominates (high-R reflective venues) it masks per-source
  // direct-field coverage differences. EASE / Odeon keep the main heatmap
  // as direct-field and report reverberant/total SPL as statistical numbers.
  // Users can enable it via the "Reverb field" toolbar toggle.
  physics: {
    reverberantField: false, coherent: false, airAbsorption: true, freq_hz: 1000,
    // Ambient noise floor at the listener — drives the N term in the
    // STI denominator. Per-band values at 125/250/500/1k/2k/4k/8k Hz.
    // Defaults to NC-35 ("typical office"). Users pick real-world
    // profiles from `data/ambient-presets.js` (mosque, bus station,
    // pasar pagi, etc.) or edit per-band values manually.
    ambientNoise: {
      preset: 'nc-35',
      per_band: [60, 52, 45, 40, 36, 34, 33],
    },
    // Master source-side graphic EQ — one per-scene, applies to every speaker
    // before physical propagation. 10 bands at ISO preferred centres 31.5 Hz
    // → 16 kHz. gain_db per band is added to the SOURCE signal; physics then
    // computes direct + reverb as normal with the boosted/cut level. When
    // `enabled: false`, the EQ is bypassed (no gain applied regardless of
    // band values). Probe tool surfaces a live frequency-response curve at
    // the hovered point only when enabled.
    eq: {
      enabled: false,
      bands: [
        { freq_hz: 31.5,  gain_db: 0 },
        { freq_hz: 63,    gain_db: 0 },
        { freq_hz: 125,   gain_db: 0 },
        { freq_hz: 250,   gain_db: 0 },
        { freq_hz: 500,   gain_db: 0 },
        { freq_hz: 1000,  gain_db: 0 },
        { freq_hz: 2000,  gain_db: 0 },
        { freq_hz: 4000,  gain_db: 0 },
        { freq_hz: 8000,  gain_db: 0 },
        { freq_hz: 16000, gain_db: 0 },
      ],
    },
  },
};

// Interpolate the EQ gain (in dB) at an arbitrary frequency from the band
// values. Returns 0 when EQ is bypassed. Log-frequency linear-dB interp
// between adjacent band centres; clamps to the edge band below/above the
// range.
export function eqGainAt(eq, freq_hz) {
  if (!eq || !eq.enabled || !Array.isArray(eq.bands) || eq.bands.length === 0) return 0;
  const bs = eq.bands;
  if (freq_hz <= bs[0].freq_hz) return bs[0].gain_db;
  if (freq_hz >= bs[bs.length - 1].freq_hz) return bs[bs.length - 1].gain_db;
  for (let i = 0; i < bs.length - 1; i++) {
    const a = bs[i], b = bs[i + 1];
    if (freq_hz >= a.freq_hz && freq_hz <= b.freq_hz) {
      const t = Math.log(freq_hz / a.freq_hz) / Math.log(b.freq_hz / a.freq_hz);
      return a.gain_db + t * (b.gain_db - a.gain_db);
    }
  }
  return 0;
}

export const DEFAULT_PRESET_KEY = 'auditorium';


function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

// Baseline room state — every preset application first resets room to
// these defaults, then overlays the preset's fields. This prevents
// data from a previous preset (custom_vertices, stadiumStructure,
// multiLevelStructure, etc.) leaking through the next one.
const DEFAULT_ROOM_STATE = {
  shape: 'rectangular',
  polygon_sides: 16,
  polygon_radius_m: 10,
  round_radius_m: 2.5,
  width_m: 10,
  height_m: 3,
  depth_m: 10,
  ceiling_type: 'flat',
  ceiling_dome_rise_m: 1.0,
  custom_vertices: null,
  stadiumStructure: null,
  multiLevelStructure: null,
  surfaces: {
    floor: 'wood-floor',
    ceiling: 'gypsum-board',
    walls: 'gypsum-board',
    wall_north: 'gypsum-board',
    wall_south: 'gypsum-board',
    wall_east: 'gypsum-board',
    wall_west: 'gypsum-board',
    edges: null,
  },
};

export function applyPresetToState(key) {
  const p = PRESETS[key];
  if (!p) return;

  // --- 1. Reset the whole room block to defaults ----------------------
  // Scrubs stadiumStructure, multiLevelStructure, custom_vertices,
  // per-edge material overrides — anything the old preset might have
  // stamped on room state. Deep-cloning the defaults means later
  // mutations can't bleed back into the template.
  Object.assign(state.room, deepClone(DEFAULT_ROOM_STATE));

  // --- 2. Apply preset room fields ------------------------------------
  if (p.shape !== undefined)              state.room.shape = p.shape;
  if (p.ceiling_type !== undefined)       state.room.ceiling_type = p.ceiling_type;
  if (p.width_m !== undefined)            state.room.width_m = p.width_m;
  if (p.height_m !== undefined)           state.room.height_m = p.height_m;
  if (p.depth_m !== undefined)            state.room.depth_m = p.depth_m;
  if (p.polygon_sides !== undefined)      state.room.polygon_sides = p.polygon_sides;
  if (p.polygon_radius_m !== undefined)   state.room.polygon_radius_m = p.polygon_radius_m;
  if (p.round_radius_m !== undefined)     state.room.round_radius_m = p.round_radius_m;
  if (p.ceiling_dome_rise_m !== undefined) state.room.ceiling_dome_rise_m = p.ceiling_dome_rise_m;
  if (p.custom_vertices)                  state.room.custom_vertices = deepClone(p.custom_vertices);
  if (p.stadiumStructure)                 state.room.stadiumStructure = deepClone(p.stadiumStructure);
  if (p.multiLevelStructure)              state.room.multiLevelStructure = deepClone(p.multiLevelStructure);
  if (p.surfaces) Object.assign(state.room.surfaces, p.surfaces);
  if (p.shape === 'polygon' || p.shape === 'round') {
    const r = p.shape === 'polygon' ? state.room.polygon_radius_m : state.room.round_radius_m;
    state.room.width_m = 2 * r;
    state.room.depth_m = 2 * r;
  }

  // --- 3. Replace scene arrays unconditionally ------------------------
  // Even when a preset doesn't declare zones / sources / listeners we
  // reset them to empty — NO data from the previous scene survives a
  // preset swap. This was the root cause of the arena→pavilion bug:
  // arena's audience-zone instances + bowl sources were carrying over
  // because the old code only replaced fields when the preset had them.
  state.zones = Array.isArray(p.zones) ? p.zones.map(deepClone) : [];
  state.sources = Array.isArray(p.sources) ? p.sources.map(deepClone) : [];
  state.listeners = Array.isArray(p.listeners) ? p.listeners.map(deepClone) : [];
  state.selectedZoneId = state.zones[0]?.id ?? null;
  state.selectedListenerId = state.listeners[0]?.id ?? null;
  state.selectedSpeakerUrl = null;

  // --- 4. Invalidate derived caches -----------------------------------
  // Heatmaps, the zone SPL grids, and any cached precision render were
  // computed against the OLD scene and no longer mean anything once the
  // sources / listeners / room have been replaced. Clear them so the
  // Results + Precision panels redraw fresh.
  if (state.results) {
    state.results.splGrid = null;
    state.results.zoneGrids = [];
    state.results.precision = null;
    if (state.results.engines?.precision) {
      state.results.engines.precision.lastRun = null;
      state.results.engines.precision.staleAt = null;
      state.results.engines.precision.inProgress = false;
    }
  }
}

// Kept for backward-compatibility references
export const DEFAULT_AUDITORIUM_SOURCES = PRESETS.auditorium.sources;
export const DEFAULT_AUDITORIUM_ZONES = PRESETS.auditorium.zones;
export const DEFAULT_LISTENER = PRESETS.auditorium.listeners[0];
export const DEFAULT_HIFI_SOURCES = PRESETS.hifi.sources;
