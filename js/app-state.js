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

// Speaker catalogue lives in js/shared/ so SpeakerLAB and DeviceLAB can
// also read the same manifest without depending on RoomLAB-specific code.
export { SPEAKER_CATALOG } from './shared/speaker-catalog.js';
// Per-preset room data lives in js/presets/*.js — imported once below.
// Templates (parametric rooms) live in js/templates/*.js. Helpers
// (rectVerts, generateTieredBowl, etc.) live in presets/shared.js
// and are consumed by the preset files, not by this module directly.
import { PRESETS } from './presets/index.js';
import { TEMPLATES } from './templates/index.js';
import { resetSceneState } from './state/scene-lifecycle.js';
export { PRESETS, TEMPLATES };

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
    // Sub-structures — saved custom rooms placed inside this room. Each
    // entry holds a deep snapshot of the source room geometry so deleting
    // the original library entry never breaks the placement. Phase 1:
    // VISUAL ONLY (rendered in 3D + 2D plan, not merged into roomSurfaces
    // for acoustics). Phase 2 — pending Dr. Chen's review — will fold the
    // sub-room walls/floor/ceiling into RT60 + SPL math, with transmission
    // loss between parent and sub. See rebuildSubStructures in scene.js.
    //
    // Shape per entry:
    //   { id, sourceRoomId, sourceRoomName, position: { x_m, y_m },
    //     elevation_m, rotation_deg, sourceRoom: <full room snapshot> }
    subStructures: [],
    // Standalone enclosures — independent editable wall structures
    // produced by Break-to-merge from a placed sub-structure. Each
    // enclosure is a self-contained custom polygon with its own
    // floor / ceiling / per-edge wall materials (same wall-slot
    // schema as room.surfaces.edges, openings included).
    //
    // Shape per entry:
    //   { id, label, polygon: [{x,y}, ...] (PARENT-state coords, transform
    //     baked in), height_m, elevation_m,
    //     surfaces: { floor, ceiling, edges: [slot, ...] } }
    //
    // Phase 1 (Dr. Chen audit gate): VISUAL ONLY. roomSurfaces() does NOT
    // include these surfaces yet — same coupled-room physics deferral as
    // subStructures. See rebuildStandaloneEnclosures in scene.js.
    standaloneEnclosures: [],
    // Shared wall segments — produced by break-to-merge when an enclosure
    // wall is collinear with a parent wall. Each entry is an INDEPENDENT
    // editable wall surface that doesn't belong to any polygon's edge
    // ring. Both the parent's overlapped sub-edge AND the enclosure's
    // overlapped sub-edge are set to 'open-air' so they don't double-
    // render; this entry is the canonical surface.
    //
    // Shape per entry:
    //   { id, x1, y1, x2, y2, elevation_m, height_m, materialId,
    //     openings: [...], sourceLabel }
    //
    // Phase 1 (Dr. Chen audit gate): VISUAL ONLY. roomSurfaces() does NOT
    // include these segments yet — same physics deferral as subStructures
    // and standaloneEnclosures. See rebuildWallSegments in scene.js.
    wallSegments: [],
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
  // Project name — user-set string that flows through every export
  // surface (save file, share link, print-report cover, viewport title).
  // Set when the user names a custom-drawn room ("Hospital Serdang") or
  // edits the print-report project field. null = untitled.
  projectName: null,
  sources: [],
  // Speaker being examined in the Speaker viewport tab. Holds the modelUrl
  // of the selected catalogue entry; null when no speaker is under review.
  selectedSpeakerUrl: null,
  // Sub-structure currently selected in the 3D viewport (click-to-select).
  // Mirrors `selectedSpeakerUrl` / `selectedListenerId` discipline. The
  // chip in the Room panel reflects this; resetSceneState clears it.
  selectedSubStructureId: null,
  // Surface (wall / floor / ceiling / wall_segment) currently selected
  // in the 3D viewport. Drives the cyan emissive + edge-outline highlight
  // owned by setSurfaceSelectionHighlight in scene.js.
  selectedSurfaceId: null,
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
  // PA equipment racks placed in the room — populated by the PA Rack
  // Builder (panel-rack.js). One rack = a 19" open-frame with U-numbered
  // slots, each slot holding an amplifier from data/amplifiers/catalog.json.
  // Per Felix Brandt's spec (RACK_BUILDER_DESIGN.md §2). Optional field —
  // empty by default; preset apply / template apply / project load reset
  // it to []. Round-trips via the existing schema-v1.
  rackSystem: { racks: [] },
  display: {
    showHeatmaps: true, showAimLines: false, showIsobars: true, isobarStep_db: 3,
    // Ray-path visualisation — debug overlay that traces ~200 sample
    // rays from the sources and renders their reflection paths as line
    // segments. Off by default (clutter); user toggles on demand. Cached
    // paths invalidate on scene mutation.
    showRays: false,
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
  // Indoor (default) means there's a ceiling/roof and the room is an
  // enclosed volume — Sabine / Eyring apply. 'outdoor' means no roof:
  // ceiling is forced to α = 1.0 in roomSurfaces() so reverberant energy
  // escapes upward, the 3D viewport skips the ceiling mesh, and the
  // acoustic numbers should be read as "fenced courtyard with no roof"
  // (Dr. Chen flag: a real free-field outdoor model would use direct +
  // ground-bounce only — this is a Sabine-with-open-top approximation).
  enclosure: 'indoor',
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
  // See state.room.subStructures comment above. Default-empty so a
  // preset/template/blank-custom apply starts with no sub-rooms; the
  // canonical reset path picks this up automatically.
  subStructures: [],
  // See state.room.standaloneEnclosures comment above. Default-empty
  // so every preset/template/blank-custom apply starts with no broken-
  // out enclosures.
  standaloneEnclosures: [],
  // See state.room.wallSegments comment above. Default-empty so every
  // preset/template/blank-custom apply starts with no shared segments.
  // resetSceneState picks this up via the Object.assign() defaults pass.
  wallSegments: [],
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

  // --- 1. Reset all scene state via the canonical entry point --------
  // This clears state.room → defaults, sources/listeners/zones → [],
  // rackSystem → empty, projectName → null, results caches → cleared.
  // Single source of truth at js/state/scene-lifecycle.js — adding a
  // new state field there flows through every reset path automatically.
  resetSceneState({ state, defaultRoomState: DEFAULT_ROOM_STATE, deepClone });

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
  // --- 3. Overlay preset's per-scene content -------------------------
  // resetSceneState already cleared sources/listeners/zones/rackSystem
  // to empty arrays. Now apply this preset's data on top. If the preset
  // has no entry for a slot it stays empty (no leakage from prior state).
  if (Array.isArray(p.zones))     state.zones     = p.zones.map(deepClone);
  if (Array.isArray(p.sources))   state.sources   = p.sources.map(deepClone);
  if (Array.isArray(p.listeners)) state.listeners = p.listeners.map(deepClone);
  state.selectedZoneId     = state.zones[0]?.id     ?? null;
  state.selectedListenerId = state.listeners[0]?.id ?? null;

  if (Array.isArray(p.rackSystem?.racks)) {
    state.rackSystem = { racks: p.rackSystem.racks.map(deepClone) };
  }
  // (results caches + projectName already cleared by resetSceneState.)
}

// Apply a blank canvas for the user to draw a custom room into. Same
// reset rigor as applyPresetToState / applyTemplateToState — the
// previous scene's stadiumStructure / multiLevelStructure / sources /
// listeners / zones do NOT belong on a brand-new custom room. (User
// reported that drawing a custom room while Sports Arena was active
// left the bowl + line-arrays + audience overlapping the new shape.)
//
// Caller passes an optional initial bbox so the freshly-drawn polygon
// has somewhere to sit until the user commits the close — defaults to
// 10 × 10 × 3 m, which renders as an empty box.
export function applyBlankCustomRoom({ projectName = null } = {}) {
  // Canonical reset (same path preset/template apply use). Custom-room-
  // specific overrides applied after.
  resetSceneState({ state, defaultRoomState: DEFAULT_ROOM_STATE, deepClone, projectName });
  state.room.shape = 'custom';
  state.room.custom_vertices = null;
  state.room.surfaces.edges = null;
  state.room.width_m = 10;
  state.room.depth_m = 10;
  state.room.height_m = 3;
}

// Kept for backward-compatibility references — only the auditorium-derived
// ones survive the templates split, since hifi/studio/etc. are now
// parametric generators. Callers that need a starter hi-fi config should
// invoke `applyTemplateToState('hifi')` and read `state.sources`.
export const DEFAULT_AUDITORIUM_SOURCES = PRESETS.auditorium.sources;
export const DEFAULT_AUDITORIUM_ZONES = PRESETS.auditorium.zones;
export const DEFAULT_LISTENER = PRESETS.auditorium.listeners[0];

// Apply a template (parametric room shape) to state. Pass dimsOverride to
// substitute specific dimensions; otherwise the template's defaultDims
// are used. The sources / listeners / zones are regenerated every time
// so positions stay coherent with the room dimensions.
export function applyTemplateToState(key, dimsOverride) {
  const t = TEMPLATES[key];
  if (!t) return;
  const dims = { ...t.defaultDims, ...(dimsOverride || {}) };
  const generated = t.generate(dims);

  // Same canonical reset path as applyPresetToState — see
  // js/state/scene-lifecycle.js. Single source of truth.
  resetSceneState({ state, defaultRoomState: DEFAULT_ROOM_STATE, deepClone });
  if (generated.shape !== undefined)               state.room.shape = generated.shape;
  if (generated.ceiling_type !== undefined)        state.room.ceiling_type = generated.ceiling_type;
  if (generated.width_m !== undefined)             state.room.width_m = generated.width_m;
  if (generated.height_m !== undefined)            state.room.height_m = generated.height_m;
  if (generated.depth_m !== undefined)             state.room.depth_m = generated.depth_m;
  if (generated.polygon_sides !== undefined)       state.room.polygon_sides = generated.polygon_sides;
  if (generated.polygon_radius_m !== undefined)    state.room.polygon_radius_m = generated.polygon_radius_m;
  if (generated.round_radius_m !== undefined)      state.room.round_radius_m = generated.round_radius_m;
  if (generated.ceiling_dome_rise_m !== undefined) state.room.ceiling_dome_rise_m = generated.ceiling_dome_rise_m;
  if (generated.surfaces) Object.assign(state.room.surfaces, generated.surfaces);

  // Overlay this template's per-scene content. resetSceneState already
  // cleared sources/listeners/zones/rackSystem/projectName/results.
  if (Array.isArray(generated.zones))     state.zones     = generated.zones.map(deepClone);
  if (Array.isArray(generated.sources))   state.sources   = generated.sources.map(deepClone);
  if (Array.isArray(generated.listeners)) state.listeners = generated.listeners.map(deepClone);
  state.selectedZoneId     = state.zones[0]?.id     ?? null;
  state.selectedListenerId = state.listeners[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Project save/load — `.roomlab.json` schema v1
//
// Captures everything the user can edit in the scene: room geometry,
// sources (including line-array compound entries with kind:'line-array'),
// listeners, audience zones, ambient noise per-band, master EQ, current
// selection ids, and physics toggles. Excluded: results.* (recomputed
// after load), display.* (UI toggles), walkthrough camera, viewport tab.
//
// Versioning: top-level `formatVersion: 1`. A future schema change must
// either bump the version and add a migration step, OR remain a strict
// superset (new optional fields only) so v1 readers stay valid.
// ---------------------------------------------------------------------------
export const PROJECT_FORMAT_VERSION = 1;

export function serializeProject(src = state) {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    meta: {
      app: 'RoomLAB',
      savedAt: new Date().toISOString(),
    },
    projectName: src.projectName ?? null,
    room: deepClone(src.room),
    sources: deepClone(src.sources ?? []),
    selectedSpeakerUrl: src.selectedSpeakerUrl ?? null,
    listeners: deepClone(src.listeners ?? []),
    selectedListenerId: src.selectedListenerId ?? null,
    zones: deepClone(src.zones ?? []),
    selectedZoneId: src.selectedZoneId ?? null,
    physics: {
      reverberantField: !!src.physics?.reverberantField,
      coherent:         !!src.physics?.coherent,
      airAbsorption:    src.physics?.airAbsorption !== false,
      freq_hz:          src.physics?.freq_hz ?? 1000,
      ambientNoise:     deepClone(src.physics?.ambientNoise ?? { preset: 'nc-35', per_band: [60, 52, 45, 40, 36, 34, 33] }),
      eq:               deepClone(src.physics?.eq ?? { enabled: false, bands: [] }),
    },
    rackSystem: deepClone(src.rackSystem ?? { racks: [] }),
  };
}

export function deserializeProject(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new Error('Not a valid RoomLAB project file.');
  }
  if (typeof obj.formatVersion !== 'number') {
    throw new Error('Not a valid RoomLAB project file (missing formatVersion).');
  }
  if (obj.formatVersion > PROJECT_FORMAT_VERSION) {
    throw new Error(`Unsupported file version (got ${obj.formatVersion}, expected ≤ ${PROJECT_FORMAT_VERSION}).`);
  }

  const warnings = [];

  // Canonical reset path (same as preset/template/blank-custom apply).
  // Establishes a clean slate before overlaying the saved values, so any
  // state field present in the running app but absent from an older
  // saved file lands on its default rather than carrying through stale
  // data. js/state/scene-lifecycle.js is the single source of truth.
  resetSceneState({ state, defaultRoomState: DEFAULT_ROOM_STATE, deepClone });

  if (obj.room && typeof obj.room === 'object') {
    // Assign scalar fields one-by-one so an unexpected key in the file
    // can't pollute room state with a foreign property.
    const r = obj.room;
    if (typeof r.shape === 'string')             state.room.shape = r.shape;
    if (typeof r.ceiling_type === 'string')      state.room.ceiling_type = r.ceiling_type;
    if (Number.isFinite(r.width_m))              state.room.width_m = r.width_m;
    if (Number.isFinite(r.height_m))             state.room.height_m = r.height_m;
    if (Number.isFinite(r.depth_m))              state.room.depth_m = r.depth_m;
    if (Number.isFinite(r.polygon_sides))        state.room.polygon_sides = Math.round(r.polygon_sides);
    if (Number.isFinite(r.polygon_radius_m))     state.room.polygon_radius_m = r.polygon_radius_m;
    if (Number.isFinite(r.round_radius_m))       state.room.round_radius_m = r.round_radius_m;
    if (Number.isFinite(r.ceiling_dome_rise_m))  state.room.ceiling_dome_rise_m = r.ceiling_dome_rise_m;
    if (Array.isArray(r.custom_vertices))        state.room.custom_vertices = deepClone(r.custom_vertices);
    if (r.stadiumStructure && typeof r.stadiumStructure === 'object') {
      state.room.stadiumStructure = deepClone(r.stadiumStructure);
    }
    if (r.multiLevelStructure && typeof r.multiLevelStructure === 'object') {
      state.room.multiLevelStructure = deepClone(r.multiLevelStructure);
    }
    // Sub-structures (Phase 1: visual only). Each entry is self-contained —
    // sourceRoom is a full snapshot captured at placement time, so the
    // placement survives even if the saved library entry was later deleted.
    if (Array.isArray(r.subStructures)) {
      state.room.subStructures = r.subStructures
        .filter(s => s && typeof s === 'object' && s.sourceRoom && typeof s.sourceRoom === 'object')
        .map(deepClone);
    }
    // Standalone enclosures (Phase 1: visual only). Filter out malformed
    // entries — the polygon must have ≥3 vertices, height/elevation must
    // be finite, and surfaces must be an object. Same defensive shape as
    // subStructures: a hand-edited JSON with a half-formed entry should
    // not crash the rebuild.
    if (Array.isArray(r.standaloneEnclosures)) {
      state.room.standaloneEnclosures = r.standaloneEnclosures
        .filter(e => e && typeof e === 'object'
          && Array.isArray(e.polygon) && e.polygon.length >= 3
          && Number.isFinite(e.height_m) && e.height_m > 0
          && e.surfaces && typeof e.surfaces === 'object')
        .map(deepClone);
    }
    // Shared wall segments — produced by break-to-merge overlap split.
    // Filter out entries missing endpoints / height — same defensive
    // shape as subStructures + standaloneEnclosures so a hand-edited
    // file with a half-formed entry doesn't crash the rebuild.
    if (Array.isArray(r.wallSegments)) {
      state.room.wallSegments = r.wallSegments
        .filter(s => s && typeof s === 'object'
          && Number.isFinite(s.x1) && Number.isFinite(s.y1)
          && Number.isFinite(s.x2) && Number.isFinite(s.y2)
          && Number.isFinite(s.height_m) && s.height_m > 0
          && typeof s.materialId === 'string')
        .map(deepClone);
    }
    if (r.surfaces && typeof r.surfaces === 'object') {
      Object.assign(state.room.surfaces, deepClone(r.surfaces));
    }
  } else {
    warnings.push('room block missing — defaults applied');
  }

  // --- Project name — preserve the saved value, default to null -------
  state.projectName = (typeof obj.projectName === 'string' && obj.projectName.trim().length > 0)
    ? obj.projectName.trim()
    : null;

  // --- Sources / listeners / zones — overlay the saved values --------
  // (resetSceneState already initialised these to []; only replace if
  // the saved file actually has data.)
  if (Array.isArray(obj.sources))   state.sources   = obj.sources.map(deepClone);
  if (Array.isArray(obj.listeners)) state.listeners = obj.listeners.map(deepClone);
  if (Array.isArray(obj.zones))     state.zones     = obj.zones.map(deepClone);

  // --- Selection ids — preserve the user's last hover/selection -------
  // `null` is a valid serialized value meaning "no selection". Use
  // `'key' in obj` instead of `??` so an explicit null round-trips
  // cleanly (the `??` form would replace it with the first item).
  state.selectedSpeakerUrl = typeof obj.selectedSpeakerUrl === 'string' ? obj.selectedSpeakerUrl : null;
  state.selectedListenerId = ('selectedListenerId' in obj) ? obj.selectedListenerId : (state.listeners[0]?.id ?? null);
  state.selectedZoneId     = ('selectedZoneId'     in obj) ? obj.selectedZoneId     : (state.zones[0]?.id     ?? null);
  // Sub-structure selection isn't persisted across save/load (the user's
  // last selection is a UI affordance, not part of the design). Reset it
  // here so a stale id from a long-saved file doesn't highlight a sub
  // that no longer exists. resetSceneState already cleared it; this is
  // defensive in case the canonical reset's contract drifts later.
  state.selectedSubStructureId = null;
  state.selectedSurfaceId = null;

  // --- Physics + ambient + EQ — overlay scalars; arrays full replace ---
  if (obj.physics && typeof obj.physics === 'object') {
    const p = obj.physics;
    if (typeof p.reverberantField === 'boolean') state.physics.reverberantField = p.reverberantField;
    if (typeof p.coherent         === 'boolean') state.physics.coherent         = p.coherent;
    if (typeof p.airAbsorption    === 'boolean') state.physics.airAbsorption    = p.airAbsorption;
    if (Number.isFinite(p.freq_hz)) state.physics.freq_hz = p.freq_hz;
    if (p.ambientNoise && typeof p.ambientNoise === 'object') {
      state.physics.ambientNoise = deepClone({
        preset:   typeof p.ambientNoise.preset === 'string' ? p.ambientNoise.preset : 'nc-35',
        per_band: Array.isArray(p.ambientNoise.per_band) && p.ambientNoise.per_band.length === 7
          ? p.ambientNoise.per_band.map(v => Number.isFinite(v) ? v : 0)
          : [60, 52, 45, 40, 36, 34, 33],
      });
    }
    if (p.eq && typeof p.eq === 'object') {
      if (typeof p.eq.enabled === 'boolean') state.physics.eq.enabled = p.eq.enabled;
      if (Array.isArray(p.eq.bands) && p.eq.bands.length === state.physics.eq.bands.length) {
        for (let i = 0; i < p.eq.bands.length; i++) {
          const b = p.eq.bands[i];
          if (Number.isFinite(b?.gain_db)) state.physics.eq.bands[i].gain_db = b.gain_db;
        }
      }
    }
  }

  // --- PA equipment racks — accept the saved value, default already []
  if (obj.rackSystem && typeof obj.rackSystem === 'object' && Array.isArray(obj.rackSystem.racks)) {
    state.rackSystem = deepClone(obj.rackSystem);
  }
  // (results caches already cleared by resetSceneState above.)

  return { warnings };
}
