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
];
const SPK12 = SPEAKER_CATALOG[0].url;
const SPK6  = SPEAKER_CATALOG[1].url;
const SPKLA = SPEAKER_CATALOG[2].url;

function hexagonVerts(cx, cy, r) {
  const v = [];
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    v.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return v;
}
function rectVerts(x1, y1, x2, y2) {
  return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
}

function ringSectorVerts(cx, cy, r_in, r_out, theta_start_deg, theta_end_deg, arcSteps = 5) {
  const verts = [];
  const ts = theta_start_deg * Math.PI / 180;
  const te = theta_end_deg * Math.PI / 180;
  for (let i = 0; i <= arcSteps; i++) {
    const t = ts + (te - ts) * (i / arcSteps);
    verts.push({ x: cx + r_out * Math.cos(t), y: cy + r_out * Math.sin(t) });
  }
  for (let i = arcSteps; i >= 0; i--) {
    const t = ts + (te - ts) * (i / arcSteps);
    verts.push({ x: cx + r_in * Math.cos(t), y: cy + r_in * Math.sin(t) });
  }
  return verts;
}

function generateBowl({ cx, cy, r_in, r_out, elevation_m, material_id, idPrefix, labelPrefix, count = 8, startAngleDeg = -22.5 }) {
  const labels8 = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const step = 360 / count;
  const zones = [];
  for (let i = 0; i < count; i++) {
    const ts = startAngleDeg + i * step;
    const te = ts + step;
    zones.push({
      id: `${idPrefix}${i + 1}`,
      label: `${labelPrefix} ${labels8[i] ?? i + 1}`,
      vertices: ringSectorVerts(cx, cy, r_in, r_out, ts, te, 5),
      elevation_m,
      material_id,
    });
  }
  return zones;
}

// Tiered bowl: each sector is divided into multiple stepped tiers (rows of seats).
// Each tier is a thin ring sub-sector at its own elevation, creating a visible
// staircase profile in 3D when sampled by the per-zone heatmap planes.
// When `gapDeg` > 0, sectors are placed with angular gaps between them (for vomitory
// entrances). Center of sector N = startAngleDeg + N × (360/sectorCount).
// Sector angular width = (360/sectorCount) − gapDeg.
function generateTieredBowl({
  cx, cy, r_in, r_out, tier_heights_m, sectorCount = 4,
  gapDeg = 0, sectorLabelsOverride = null,
  material_id, idPrefix, labelPrefix, startAngleDeg,
  occupancy_percent = 0,
}) {
  const defaultLabels4 = ['E', 'S', 'W', 'N'];
  const defaultLabels8 = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const sectorLabels = sectorLabelsOverride
    ?? (sectorCount === 4 ? defaultLabels4
        : sectorCount === 8 ? defaultLabels8
        : null);
  const sectorAngularStep = 360 / sectorCount;
  const sectorWidth = sectorAngularStep - gapDeg;
  const centerStart = startAngleDeg ?? (gapDeg > 0 ? 0 : -sectorAngularStep / 2);
  const tierCount = tier_heights_m.length;
  const tierRadialDepth = (r_out - r_in) / tierCount;
  const zones = [];
  for (let s = 0; s < sectorCount; s++) {
    const centerDeg = centerStart + s * sectorAngularStep;
    const ts = centerDeg - sectorWidth / 2;
    const te = centerDeg + sectorWidth / 2;
    const sLabel = sectorLabels?.[s] ?? (s + 1);
    for (let t = 0; t < tierCount; t++) {
      const ri = r_in + t * tierRadialDepth;
      const ro = ri + tierRadialDepth;
      zones.push({
        id: `${idPrefix}${s + 1}_${t + 1}`,
        label: `${labelPrefix} ${sLabel} row ${t + 1}`,
        vertices: ringSectorVerts(cx, cy, ri, ro, ts, te, 4),
        elevation_m: tier_heights_m[t],
        material_id,
        occupancy_percent,
      });
    }
  }
  return zones;
}

// Factory for a center-hung line-array cluster: creates N line-array entries
// (one per compass direction), each hanging from the catwalk ring and aimed
// outward+down at its audience quadrant. Each "source" here is a compound
// line-array descriptor — `expandSources` unpacks it to individual elements
// at SPL-compute / render time.
function generateCenterLineArrayCluster({ cx, cy, cz, ring_r, hangCount = 4, elementsPerArray = 4, modelUrl, power_watts_each = 500, topTilt_deg = -12, splayAnglesDeg = null, elementSpacing_m = 0.42, startAngleDeg = 0 }) {
  const arrays = [];
  // Industry-standard progressive J-curve splays (K2/J8/SOUNDVISION style).
  // Upper boxes stay near 0° for long-throw line-source behavior, lower
  // boxes open up dramatically to cover near-field. The sums below give
  // ~36–44° total vertical coverage — enough to span a real arena bowl
  // audience from the closest row (60-70° depression) up to the far upper
  // tier (15-20° depression). Previous shallower splays (19° total) meant
  // only the bottom 1–2 elements actually hit audience, cutting sector
  // separation because the other 4 elements' energy went above the bowl.
  const DEFAULT_SPLAYS_BY_COUNT = {
    2: [10],
    3: [5, 10],
    4: [4, 8, 14],
    5: [2, 5, 10, 15],
    6: [2, 4, 6, 10, 14],
    8: [1, 2, 3, 4, 6, 10, 14],
  };
  const splay = splayAnglesDeg
    ?? DEFAULT_SPLAYS_BY_COUNT[elementsPerArray]
    ?? new Array(Math.max(0, elementsPerArray - 1)).fill(3);
  const step = 360 / hangCount;
  for (let i = 0; i < hangCount; i++) {
    const a_deg = startAngleDeg + i * step;
    const a_rad = a_deg * Math.PI / 180;
    const ox = cx + ring_r * Math.cos(a_rad);
    const oy = cy + ring_r * Math.sin(a_rad);
    // yaw convention: yaw=0 → aim +Y (state depth). baseYaw here so each hang
    // points radially outward at its compass direction.
    const baseYaw = ((90 - a_deg) % 360 + 360) % 360;
    const baseYaw_signed = baseYaw > 180 ? baseYaw - 360 : baseYaw;
    arrays.push({
      kind: 'line-array',
      id: `LA${i + 1}`,
      modelUrl,
      origin: { x: ox, y: oy, z: cz },
      baseYaw_deg: baseYaw_signed,
      topTilt_deg,
      splayAnglesDeg: splay,
      elementSpacing_m,
      power_watts_each,
      groupId: (i % 2 === 0) ? 'A' : 'B',
    });
  }
  return arrays;
}

function generateCenterCluster({ cx, cy, cz, ring_r, count = 8, modelUrl, power_watts = 500, pitch = -25 }) {
  const sources = [];
  const step = 360 / count;
  for (let i = 0; i < count; i++) {
    const a_deg = i * step;
    const a_rad = a_deg * Math.PI / 180;
    const x = cx + ring_r * Math.cos(a_rad);
    const y = cy + ring_r * Math.sin(a_rad);
    const yaw = ((90 - a_deg) % 360 + 360) % 360;
    const yaw_signed = yaw > 180 ? yaw - 360 : yaw;
    const groupId = (i % 2 === 0) ? 'A' : 'B';
    sources.push({
      modelUrl, position: { x, y, z: cz },
      aim: { yaw: yaw_signed, pitch, roll: 0 },
      power_watts, groupId,
    });
  }
  return sources;
}

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
  listeners: [],
  selectedListenerId: null,
  zones: [],
  selectedZoneId: null,
  results: { rt60: null, splGrid: null, zoneGrids: [] },
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
  physics: { reverberantField: false, coherent: false, airAbsorption: true, freq_hz: 1000 },
};

export const DEFAULT_PRESET_KEY = 'auditorium';

export const PRESETS = {
  auditorium: (() => {
    // Sports arena modeled after University of Wyoming Arena-Auditorium.
    // 60 m polygon plan (36 sides — finer resolution so 10° vomitories align
    // cleanly with wall segments). Walls 12 m + 10 m dome rise → 22 m at apex.
    // NCAA basketball court (28.7 × 15.2 m) at center; bowls start at r=18 m
    // to leave a 1.76 m out-of-bounds apron (court corners reach r≈16.24 m).
    //
    // Bowl structure (solid stepped volumes via LatheGeometry — see scene.js/rebuildBowlStructure):
    //   Retaining wall: r = 18 m, z = 0 → 1.0 m (front of house, first row sits at 1 m)
    //   Lower bowl:     r = 18 → 24 m, tiers at 1.0–3.25 m, tread = 1.0 m, riser = 0.45 m → rake 24°
    //   Concourse:      flat ring r = 24 → 26 m at z = 3.25 m (walkway behind lower bowl)
    //   Upper bowl:     r = 26 → 29 m, tiers at 7.0–8.75 m, tread = 0.5 m, riser = 0.35 m → rake 35°
    //
    // 4 vomitories (10° each at cardinal compass points) — narrow tunnel entrances,
    // 10° wide, with a ceiling at z=3.25 m (same level as the concourse).
    // 1 m service corridor (r = 29 → 30) between upper bowl back wall and room wall.
    // Center-hung PA cluster: 8 line-array elements on a 4 m ring at 15 m height.
    //
    // Upper bowl rake is 35° — top of the safe-egress band (building codes cap
    // seating rake around 35°). Earlier reviewer suggestions of 0.6–0.8 m step
    // on a 0.5 m tread would give 50–58° rake which violates that band.
    const cx = 30, cy = 30;
    const lowerBowl = { r_in: 18, r_out: 24, floor_z: 0,    tier_heights_m: [1.0, 1.45, 1.9, 2.35, 2.8, 3.25] };
    const upperBowl = { r_in: 26, r_out: 29, floor_z: 3.25, tier_heights_m: [7.0, 7.35, 7.7, 8.05, 8.4, 8.75] };
    const concourse = { r_in: 24, r_out: 26, elevation_m: 3.25 };
    return {
      label: 'Sports arena (dome)',
      shape: 'polygon', ceiling_type: 'dome',
      polygon_sides: 36, polygon_radius_m: 30,
      width_m: 60, height_m: 12, depth_m: 60,
      ceiling_dome_rise_m: 10,
      surfaces: {
        // Real arenas (e.g., MSG after 2013 renovation, Wyoming Arena-
        // Auditorium) use perforated metal deck ceilings with fiberglass
        // batt insulation and a mix of gypsum + fabric-wrapped panels on
        // the walls. Gypsum-everywhere was giving RT60 ~10 s vs real ~3 s.
        floor: 'wood-floor', ceiling: 'metal-deck-acoustic', walls: 'arena-wall-mixed',
        wall_north: 'arena-wall-mixed', wall_south: 'arena-wall-mixed',
        wall_east: 'arena-wall-mixed', wall_west: 'arena-wall-mixed',
      },
      // stadiumStructure is read by scene.js to build solid LatheGeometry bowl meshes
      // (per sector, with end caps) + cut the room wall at vomitory angles.
      // All structural meshes tagged userData.acoustic_material = 'concrete'.
      stadiumStructure: {
        cx, cy, lowerBowl, upperBowl, concourse,
        catwalkHeight_m: 15, catwalkRadius_m: 10,
        vomitories: {
          // 4 vomitories at cardinal angles (0/90/180/270°), each 10° wide (narrow tunnels).
          // Leaves 4 bowl sectors at 45/135/225/315° (diagonals), each 80° wide.
          centerAnglesDeg: [0, 90, 180, 270],
          widthDeg: 10,
        },
      },
      zones: [
        { id: 'Z_court', label: 'Court', vertices: rectVerts(15.65, 22.4, 44.35, 37.6), elevation_m: 0, material_id: 'wood-floor' },
        // Concourse split into 4 quadrants aligned with bowl sectors (leaves vomitory gaps clear).
        ...generateTieredBowl({
          cx, cy, r_in: 24, r_out: 26,
          tier_heights_m: [3.25],
          sectorCount: 4, material_id: 'concrete-painted',
          idPrefix: 'Z_co', labelPrefix: 'Concourse',
          gapDeg: 10, startAngleDeg: 45,
          sectorLabelsOverride: ['SE', 'SW', 'NW', 'NE'],
        }),
        ...generateTieredBowl({
          cx, cy, r_in: 18, r_out: 24,
          tier_heights_m: lowerBowl.tier_heights_m,
          sectorCount: 4, material_id: 'upholstered-seat-empty',
          idPrefix: 'Z_lb', labelPrefix: 'Lower',
          gapDeg: 10, startAngleDeg: 45,
          sectorLabelsOverride: ['SE', 'SW', 'NW', 'NE'],
          occupancy_percent: 30,
        }),
        ...generateTieredBowl({
          cx, cy, r_in: 26, r_out: 29,
          tier_heights_m: upperBowl.tier_heights_m,
          sectorCount: 4, material_id: 'upholstered-seat-empty',
          idPrefix: 'Z_ub', labelPrefix: 'Upper',
          gapDeg: 10, startAngleDeg: 45,
          sectorLabelsOverride: ['SE', 'SW', 'NW', 'NE'],
          occupancy_percent: 30,
        }),
      ],
      // 4 line-array hangs (N/E/S/W), each 4 elements with 4° splay between
      // adjacent elements — a classic small-arena center cluster pattern.
      // Each "source" below is a COMPOUND line-array descriptor; the physics
      // and renderer call expandSources() to unpack it into 4 elements.
      // 4 line-array hangs at the diagonal sector centers (SE/SW/NW/NE) so
      // each hang is positioned OVER an audience sector and aimed radially
      // outward at that sector. Previous startAngleDeg=0 put the hangs at
      // cardinal points — which is where the vomitories (doors) are, so the
      // arrays were aiming at empty walkways instead of audience. Sectors
      // span the 80° between adjacent vomitories.
      sources: generateCenterLineArrayCluster({
        cx, cy, cz: 15, ring_r: 5, hangCount: 4, elementsPerArray: 6,
        startAngleDeg: 45,
        modelUrl: SPKLA, power_watts_each: 500,
        topTilt_deg: -8, elementSpacing_m: 0.42,
      }),
      listeners: [
        // Positions land inside SE/SW/NW/NE quadrants (not in 10° vomitory gaps at cardinals).
        // SE = +x+y direction (state y grows "back" = south); NE = +x-y, etc.
        { id: 'L1', label: 'Courtside VIP',          position: { x: 22,   y: 30   }, elevation_m: 0,    posture: 'sitting_chair', custom_ear_height_m: null },
        { id: 'L2', label: 'Lower bowl row 1 SE',    position: { x: 43,   y: 43   }, elevation_m: 1.0,  posture: 'sitting_chair', custom_ear_height_m: null },
        { id: 'L3', label: 'Lower bowl row 6 SW',    position: { x: 13,   y: 47   }, elevation_m: 3.25, posture: 'sitting_chair', custom_ear_height_m: null },
        { id: 'L4', label: 'Upper bowl row 3 NW',    position: { x: 11,   y: 11   }, elevation_m: 7.7,  posture: 'sitting_chair', custom_ear_height_m: null },
        { id: 'L5', label: 'Concourse walker NE',    position: { x: 48,   y: 12   }, elevation_m: 3.25, posture: 'standing',      custom_ear_height_m: null },
      ],
    };
  })(),

  chamber: {
    label: 'Chamber (small arena)',
    shape: 'polygon', ceiling_type: 'dome',
    polygon_sides: 16, polygon_radius_m: 10,
    width_m: 20, height_m: 7, depth_m: 20,
    ceiling_dome_rise_m: 1.5,
    surfaces: {
      floor: 'wood-floor', ceiling: 'acoustic-tile', walls: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [
      { id: 'Z1', label: 'Stage',          vertices: hexagonVerts(10, 10, 2),          elevation_m: 0.50, material_id: 'wood-floor' },
      { id: 'Z2', label: 'North audience', vertices: rectVerts(7,   3.5, 13,  7.5),    elevation_m: 0.00, material_id: 'carpet-heavy' },
      { id: 'Z3', label: 'East audience',  vertices: rectVerts(12.5, 7.5, 16.5, 12.5), elevation_m: 0.25, material_id: 'carpet-heavy' },
      { id: 'Z4', label: 'South audience', vertices: rectVerts(7,   12.5, 13, 16.5),   elevation_m: 0.50, material_id: 'carpet-heavy' },
      { id: 'Z5', label: 'West audience',  vertices: rectVerts(3.5,  7.5,  7.5, 12.5), elevation_m: 0.25, material_id: 'carpet-heavy' },
    ],
    sources: [
      { modelUrl: SPK12, position: { x: 10, y: 8,  z: 4.5 }, aim: { yaw: 180, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 10, y: 12, z: 4.5 }, aim: { yaw: 0,   pitch: -20, roll: 0 }, power_watts: 200, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 12, y: 10, z: 4.5 }, aim: { yaw: 90,  pitch: -20, roll: 0 }, power_watts: 200, groupId: 'B' },
      { modelUrl: SPK12, position: { x: 8,  y: 10, z: 4.5 }, aim: { yaw: -90, pitch: -20, roll: 0 }, power_watts: 200, groupId: 'B' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 10, y: 5 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },

  recitalhall: {
    label: 'Recital hall',
    shape: 'rectangular', ceiling_type: 'dome',
    width_m: 12, height_m: 5, depth_m: 18,
    ceiling_dome_rise_m: 0.8,
    surfaces: {
      floor: 'wood-floor', ceiling: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [
      { id: 'Z1', label: 'Stage',         vertices: rectVerts(3, 1,   9, 4),    elevation_m: 0.6, material_id: 'wood-floor' },
      { id: 'Z2', label: 'Front stalls',  vertices: rectVerts(2, 5,  10, 9),    elevation_m: 0.0, material_id: 'carpet-heavy' },
      { id: 'Z3', label: 'Middle stalls', vertices: rectVerts(2, 9.5, 10, 13),  elevation_m: 0.3, material_id: 'carpet-heavy' },
      { id: 'Z4', label: 'Back stalls',   vertices: rectVerts(2, 13.5, 10, 17), elevation_m: 0.6, material_id: 'carpet-heavy' },
    ],
    sources: [
      { modelUrl: SPK12, position: { x: 3.5, y: 3, z: 3.5 }, aim: { yaw:  15, pitch: -12, roll: 0 }, power_watts: 150, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 8.5, y: 3, z: 3.5 }, aim: { yaw: -15, pitch: -12, roll: 0 }, power_watts: 150, groupId: 'A' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 6, y: 10 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },

  rotunda: {
    label: 'Rotunda (round + dome)',
    shape: 'round', ceiling_type: 'dome',
    round_radius_m: 4,
    width_m: 8, height_m: 3.5, depth_m: 8,
    ceiling_dome_rise_m: 1.5,
    surfaces: {
      floor: 'wood-floor', ceiling: 'gypsum-board', walls: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [],
    sources: [
      { modelUrl: SPK6, position: { x: 4,   y: 1.5, z: 2.5 }, aim: { yaw:   0, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'A' },
      { modelUrl: SPK6, position: { x: 4,   y: 6.5, z: 2.5 }, aim: { yaw: 180, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'A' },
      { modelUrl: SPK6, position: { x: 6.5, y: 4,   z: 2.5 }, aim: { yaw:  90, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'B' },
      { modelUrl: SPK6, position: { x: 1.5, y: 4,   z: 2.5 }, aim: { yaw: -90, pitch: -15, roll: 0 }, power_watts: 80, groupId: 'B' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 4, y: 4 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },

  octagon: {
    label: 'Octagonal hall',
    shape: 'polygon', ceiling_type: 'flat',
    polygon_sides: 8, polygon_radius_m: 5,
    width_m: 10, height_m: 4, depth_m: 10,
    surfaces: {
      floor: 'wood-floor', ceiling: 'acoustic-tile', walls: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [],
    sources: [
      { modelUrl: SPK12, position: { x: 5, y: 2, z: 3.2 }, aim: { yaw:   0, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 5, y: 8, z: 3.2 }, aim: { yaw: 180, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 8, y: 5, z: 3.2 }, aim: { yaw:  90, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'B' },
      { modelUrl: SPK12, position: { x: 2, y: 5, z: 3.2 }, aim: { yaw: -90, pitch: -12, roll: 0 }, power_watts: 120, groupId: 'B' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 5, y: 5 }, posture: 'standing', custom_ear_height_m: null },
    ],
  },

  hifi: {
    label: 'Hi-fi room',
    shape: 'rectangular', ceiling_type: 'flat',
    width_m: 4.5, height_m: 2.7, depth_m: 6,
    surfaces: {
      floor: 'carpet-heavy', ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [],
    sources: [
      { modelUrl: SPK12, position: { x: 1.0, y: 0.8, z: 1.0 }, aim: { yaw:  10, pitch: 0, roll: 0 }, power_watts: 50, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 3.5, y: 0.8, z: 1.0 }, aim: { yaw: -10, pitch: 0, roll: 0 }, power_watts: 50, groupId: 'A' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 2.25, y: 2.8 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },

  classroom: {
    label: 'Classroom',
    shape: 'rectangular', ceiling_type: 'flat',
    width_m: 8, height_m: 3, depth_m: 10,
    surfaces: {
      floor: 'wood-floor', ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [],
    sources: [
      { modelUrl: SPK6, position: { x: 4, y: 1.5, z: 2.5 }, aim: { yaw:   0, pitch: -15, roll: 0 }, power_watts: 60, groupId: 'A' },
      { modelUrl: SPK6, position: { x: 4, y: 7,   z: 2.5 }, aim: { yaw: 180, pitch: -20, roll: 0 }, power_watts: 60, groupId: 'A' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 4, y: 5 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },

  livevenue: {
    label: 'Live venue',
    shape: 'rectangular', ceiling_type: 'flat',
    width_m: 15, height_m: 6, depth_m: 20,
    surfaces: {
      floor: 'concrete-painted', ceiling: 'acoustic-tile',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [
      { id: 'Z1', label: 'Stage',    vertices: rectVerts(5, 0.5, 10, 4),    elevation_m: 1.0, material_id: 'wood-floor' },
      { id: 'Z2', label: 'Audience', vertices: rectVerts(1, 5,   14, 19),   elevation_m: 0.0, material_id: 'concrete-painted' },
    ],
    sources: [
      { modelUrl: SPKLA, position: { x: 4,   y: 2, z: 5   }, aim: { yaw:  15, pitch: -10, roll: 0 }, power_watts: 500, groupId: 'A' },
      { modelUrl: SPKLA, position: { x: 11,  y: 2, z: 5   }, aim: { yaw: -15, pitch: -10, roll: 0 }, power_watts: 500, groupId: 'A' },
      { modelUrl: SPK12, position: { x: 7.5, y: 1, z: 2.5 }, aim: { yaw:   0, pitch:  -5, roll: 0 }, power_watts: 200, groupId: 'B' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 7.5, y: 12 }, posture: 'standing', custom_ear_height_m: null },
    ],
  },

  studio: {
    label: 'Studio (dead)',
    shape: 'rectangular', ceiling_type: 'flat',
    width_m: 5, height_m: 2.7, depth_m: 6,
    surfaces: {
      floor: 'carpet-heavy', ceiling: 'acoustic-tile',
      wall_north: 'acoustic-tile', wall_south: 'acoustic-tile',
      wall_east: 'acoustic-tile', wall_west: 'acoustic-tile',
    },
    zones: [],
    sources: [
      { modelUrl: SPK6, position: { x: 1.8, y: 1.2, z: 1.2 }, aim: { yaw:  15, pitch: 0, roll: 0 }, power_watts: 40, groupId: 'A' },
      { modelUrl: SPK6, position: { x: 3.2, y: 1.2, z: 1.2 }, aim: { yaw: -15, pitch: 0, roll: 0 }, power_watts: 40, groupId: 'A' },
    ],
    listeners: [
      { id: 'L1', label: 'Listener 1', position: { x: 2.5, y: 2.5 }, posture: 'sitting_chair', custom_ear_height_m: null },
    ],
  },
};

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

export function applyPresetToState(key) {
  const p = PRESETS[key];
  if (!p) return;
  state.room.shape = p.shape ?? 'rectangular';
  state.room.ceiling_type = p.ceiling_type ?? 'flat';
  state.room.width_m = p.width_m;
  state.room.height_m = p.height_m;
  state.room.depth_m = p.depth_m;
  if (p.polygon_sides != null)      state.room.polygon_sides = p.polygon_sides;
  if (p.polygon_radius_m != null)   state.room.polygon_radius_m = p.polygon_radius_m;
  if (p.round_radius_m != null)     state.room.round_radius_m = p.round_radius_m;
  if (p.ceiling_dome_rise_m != null) state.room.ceiling_dome_rise_m = p.ceiling_dome_rise_m;
  Object.assign(state.room.surfaces, p.surfaces);
  if (p.shape === 'polygon' || p.shape === 'round') {
    const r = p.shape === 'polygon' ? state.room.polygon_radius_m : state.room.round_radius_m;
    state.room.width_m = 2 * r;
    state.room.depth_m = 2 * r;
  }

  if (p.zones !== undefined) {
    state.zones = p.zones.map(deepClone);
    state.selectedZoneId = state.zones[0]?.id ?? null;
  }
  if (p.sources !== undefined) {
    state.sources = p.sources.map(deepClone);
  }
  if (p.listeners !== undefined) {
    state.listeners = p.listeners.map(deepClone);
    state.selectedListenerId = state.listeners[0]?.id ?? null;
  }
  // Stadium structure descriptor (bowl profiles, vomitories, catwalk) — read by
  // scene.js/rebuildBowlStructure to build solid concrete lathe meshes. MUST be
  // copied or the bowl structure won't render. Default to null when a preset
  // doesn't define one.
  state.room.stadiumStructure = p.stadiumStructure ? deepClone(p.stadiumStructure) : null;
}

// Kept for backward-compatibility references
export const DEFAULT_AUDITORIUM_SOURCES = PRESETS.auditorium.sources;
export const DEFAULT_AUDITORIUM_ZONES = PRESETS.auditorium.zones;
export const DEFAULT_LISTENER = PRESETS.auditorium.listeners[0];
export const DEFAULT_HIFI_SOURCES = PRESETS.hifi.sources;
