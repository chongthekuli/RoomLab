# Sports Arena — Design & Code Review

This document assembles the code that renders RoomLAB's **Sports arena (dome)** preset — a simplified model of a tiered dome arena inspired by the University of Wyoming Arena-Auditorium (~11,600-seat geodesic dome, 360° seating). The goal of this file is to let an external acoustics or architecture consultant review our approach end-to-end in one read, and flag where our approximations diverge from real arena design.

---

## 1. Data Flow

RoomLAB is a single-page browser app (pure ES modules, no build step, Three.js from CDN). The arena is produced entirely by **data** (preset definition) and **deterministic render code** — no heavyweight scene file.

```
┌─────────────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  PRESETS.auditorium     │ →   │  applyPresetToState  │ →   │  state (live)   │
│  (app-state.js)         │     │                      │     │                 │
│  - room dims/shape      │     │  deep-clones into    │     │  room           │
│  - zones[] (bowl tiers) │     │  state.*             │     │  sources[]      │
│  - sources[] (PA)       │     │                      │     │  listeners[]    │
│  - listeners[]          │     │                      │     │  zones[]        │
└─────────────────────────┘     └──────────────────────┘     └────────┬────────┘
                                                                      │
                         ┌────────────────────────────────────────────┤
                         ↓                                            ↓
            ┌──────────────────────────┐                  ┌──────────────────────┐
            │  Physics                 │                  │  3D rendering        │
            │  (room-shape.js,         │                  │  (scene.js,          │
            │   spl-calculator.js)     │                  │   Three.js)          │
            │                          │                  │                      │
            │  - roomVolume / surfaces │                  │  - rebuildRoom       │
            │  - isInsideRoom3D        │                  │  - rebuildZones      │
            │  - computeZoneSPLGrid    │ → SPL grids →    │    (ShapeGeometry    │
            │    (per zone at ear Z)   │                  │     + CanvasTexture) │
            └──────────────────────────┘                  │  - rebuildStadium-   │
                                                          │    Furniture        │
                                                          │    (risers, catwalk)│
                                                          │  - rebuildSources    │
                                                          │  - rebuildListeners  │
                                                          └──────────────────────┘
```

**Coordinate conventions**

| | Plan (2D, state) | World (3D, Three.js) |
|---|---|---|
| width / right-left | `x` | `X` |
| depth / front-back | `y` | `Z` |
| height / up-down | `z` | `Y` |

`state.y` (depth) maps to world `Z`. A speaker at `position.z = 15` is 15 m vertically above the floor in 3D.

Angles: yaw=0 points along state `+y` (toward back of room, world `+Z`). yaw=90° points along state `+x` (world `+X`).

---

## 2. The Preset Blueprint

The arena is defined by a data object. No imperative scene construction — the 3D renderer iterates this data.

**Overall geometry**
- 50 m wide × 50 m deep × 12 m wall height + 8 m dome rise (apex at 20 m)
- Plan: regular 24-sided polygon of radius 25 m (approximates the geodesic dome in plan)
- Floor: wood; ceiling: gypsum; walls: gypsum

**Zones** (33 total; each zone gets its own SPL heatmap plane in 3D at its `elevation_m`)
- 1 × court (28.7 × 15.2 m NCAA basketball court at z=0)
- 24 × lower bowl (4 quadrants × 6 stepped tiers, elevations 0.3–2.55 m, radial span 16–22 m)
- 24 × upper bowl (4 quadrants × 6 stepped tiers, elevations 5.8–8.3 m, radial span 22.5–24.5 m)
- Concourse gap between lower-top (2.55 m) and upper-bottom (5.8 m) is unoccupied space

**Sources** (8 line-array elements, 500 W each)
- Center-hung cluster: 3 m-radius ring at z=15 m, 8 speakers at 45° intervals
- Each aimed radially outward with pitch = −25°
- Cardinals (E/S/W/N) → Group A (red); diagonals → Group B (blue)

**Listeners** (4 preplaced sampling different rows)
- Courtside VIP (z=0)
- Lower bowl row 1 S (z=0.3), row 4 E (z=1.65)
- Upper bowl row 3 N (z=6.8)
- All seated (ear 1.15 m above their elevation)

### 2.1 Source code: `js/app-state.js` — auditorium preset

```js
const SPKLA = 'data/loudspeakers/line-array-element.json';

// ...

auditorium: (() => {
  // Sports arena modeled after University of Wyoming Arena-Auditorium.
  // 50 m polygon plan (24 sides approximates the geodesic dome).
  // Walls 12 m + 8 m dome rise → 20 m at apex.
  // NCAA basketball court (28.7 × 15.2 m) at center.
  // Two continuous bowls wrapping 360°, each divided into
  // 4 quadrants × 6 stepped tiers = 24 stadium rows per bowl.
  // Concourse between lower bowl top (2.55 m) and upper bowl bottom (5.8 m).
  // Center-hung PA cluster of 8 line-array elements at 15 m.
  const cx = 25, cy = 25;
  return {
    label: 'Sports arena (dome)',
    shape: 'polygon', ceiling_type: 'dome',
    polygon_sides: 24, polygon_radius_m: 25,
    width_m: 50, height_m: 12, depth_m: 50,
    ceiling_dome_rise_m: 8,
    surfaces: {
      floor: 'wood-floor', ceiling: 'gypsum-board', walls: 'gypsum-board',
      wall_north: 'gypsum-board', wall_south: 'gypsum-board',
      wall_east: 'gypsum-board', wall_west: 'gypsum-board',
    },
    zones: [
      { id: 'Z_court', label: 'Court',
        vertices: rectVerts(10.65, 17.4, 39.35, 32.6),
        elevation_m: 0, material_id: 'wood-floor' },
      ...generateTieredBowl({
        cx, cy, r_in: 16, r_out: 22,
        tier_heights_m: [0.3, 0.75, 1.2, 1.65, 2.1, 2.55],
        sectorCount: 4, material_id: 'carpet-heavy',
        idPrefix: 'Z_lb', labelPrefix: 'Lower',
      }),
      ...generateTieredBowl({
        cx, cy, r_in: 22.5, r_out: 24.5,
        tier_heights_m: [5.8, 6.3, 6.8, 7.3, 7.8, 8.3],
        sectorCount: 4, material_id: 'carpet-heavy',
        idPrefix: 'Z_ub', labelPrefix: 'Upper',
      }),
    ],
    sources: generateCenterCluster({
      cx, cy, cz: 15, ring_r: 3, count: 8,
      modelUrl: SPKLA, power_watts: 500, pitch: -25,
    }),
    listeners: [
      { id: 'L1', label: 'Courtside VIP',        position: { x: 12,   y: 25   }, elevation_m: 0,    posture: 'sitting_chair' },
      { id: 'L2', label: 'Lower bowl row 1 S',   position: { x: 25,   y: 41.5 }, elevation_m: 0.3,  posture: 'sitting_chair' },
      { id: 'L3', label: 'Lower bowl row 4 E',   position: { x: 45.5, y: 25   }, elevation_m: 1.65, posture: 'sitting_chair' },
      { id: 'L4', label: 'Upper bowl row 3 N',   position: { x: 25,   y: 1.8  }, elevation_m: 6.8,  posture: 'sitting_chair' },
    ],
  };
})();
```

---

## 3. Geometry Helpers

All in `js/app-state.js`. These generate vertex arrays in the plan (x, y) coordinate system.

```js
// A rectangle by two corners.
function rectVerts(x1, y1, x2, y2) {
  return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
}

// An annular sector polygon, approximated with `arcSteps` linear segments along each arc.
// Vertices order: outer arc (r=r_out, θ_start → θ_end), then inner arc (r=r_in, θ_end → θ_start).
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

// Builds a tiered bowl: sectorCount sectors × tier_heights_m.length tiers.
// Each tier is a thin ring sub-sector at its own elevation.
function generateTieredBowl({
  cx, cy, r_in, r_out, tier_heights_m, sectorCount = 4,
  material_id, idPrefix, labelPrefix, startAngleDeg,
}) {
  const sectorLabels = sectorCount === 4 ? ['E', 'S', 'W', 'N']
    : sectorCount === 8 ? ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] : null;
  const sectorStep = 360 / sectorCount;
  const start = startAngleDeg ?? -sectorStep / 2;
  const tierCount = tier_heights_m.length;
  const tierRadialDepth = (r_out - r_in) / tierCount;
  const zones = [];
  for (let s = 0; s < sectorCount; s++) {
    const ts = start + s * sectorStep;
    const te = ts + sectorStep;
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
      });
    }
  }
  return zones;
}

// Center-hung PA cluster: `count` speakers evenly spaced on a ring of radius ring_r,
// each aimed radially outward (yaw = 90° − angle) with fixed downtilt.
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
```

---

## 4. Physics

### 4.1 Room geometry — `js/physics/room-shape.js`

Handles plan-shape math (polygon / round / rectangular / arbitrary-vertex) and dome ceiling math (spherical cap).

```js
// Floor area in m² for any shape.
export function baseArea(room) {
  switch (getShape(room)) {
    case 'polygon': {
      const n = room.polygon_sides ?? 6;
      const r = room.polygon_radius_m ?? 3;
      return (n / 2) * r * r * Math.sin(2 * Math.PI / n);
    }
    case 'round':
      return Math.PI * (room.round_radius_m ?? 3) ** 2;
    case 'custom': {
      // Shoelace formula for arbitrary polygon.
      const v = room.custom_vertices || [];
      if (v.length < 3) return 0;
      let a = 0;
      for (let i = 0; i < v.length; i++) {
        const j = (i + 1) % v.length;
        a += v[i].x * v[j].y - v[j].x * v[i].y;
      }
      return Math.abs(a) / 2;
    }
    default:
      return room.width_m * room.depth_m;
  }
}

// Total perimeter of the plan (linear meters of wall).
export function wallPerimeter(room) {
  switch (getShape(room)) {
    case 'polygon': {
      const n = room.polygon_sides ?? 6;
      const r = room.polygon_radius_m ?? 3;
      return 2 * r * n * Math.sin(Math.PI / n);
    }
    case 'round':
      return 2 * Math.PI * (room.round_radius_m ?? 3);
    // ... custom, default omitted for brevity
  }
}

// Spherical-cap ceiling area (surface of the dome).
// Uses the equivalent-circle approximation for non-round bases.
export function ceilingArea(room) {
  const b = baseArea(room);
  if (room.ceiling_type === 'dome' && (room.ceiling_dome_rise_m ?? 0) > 0) {
    const a = Math.sqrt(b / Math.PI);   // equivalent circle radius
    const d = room.ceiling_dome_rise_m;
    return Math.PI * (a * a + d * d);   // lateral surface area of spherical cap
  }
  return b;
}

// Spherical-cap volume addition.
export function domeVolume(room) {
  if (room.ceiling_type !== 'dome' || !((room.ceiling_dome_rise_m ?? 0) > 0)) return 0;
  const a = Math.sqrt(baseArea(room) / Math.PI);
  const d = room.ceiling_dome_rise_m;
  return Math.PI * d / 6 * (3 * a * a + d * d);
}

export function roomVolume(room) {
  return baseArea(room) * room.height_m + domeVolume(room);
}

// Ceiling height at any horizontal point.
// Flat ceiling: constant wall height.
// Dome ceiling: spherical cap math; height drops off toward the perimeter;
// returns wall height when the point is outside the dome's circular projection.
export function maxCeilingHeightAt(x, y, room) {
  if (room.ceiling_type !== 'dome' || !((room.ceiling_dome_rise_m ?? 0) > 0)) {
    return room.height_m;
  }
  const d = room.ceiling_dome_rise_m;
  const a = Math.sqrt(baseArea(room) / Math.PI);
  const R = (a * a + d * d) / (2 * d);   // sphere radius from base/rise
  const cx = room.width_m / 2, cy = room.depth_m / 2;
  const horizDistSq = (x - cx) ** 2 + (y - cy) ** 2;
  if (horizDistSq >= a * a) return room.height_m;
  const heightAboveWall = Math.sqrt(R * R - horizDistSq) - (R - d);
  return room.height_m + heightAboveWall;
}

// 3D containment test. Used to decide whether a speaker or listener is
// "outside the room" (which triggers a wall transmission loss penalty in SPL).
export function isInsideRoom3D(pos, room) {
  if (!isInsideRoom(pos.x, pos.y, room)) return false;
  if (pos.z < 0) return false;
  if (pos.z > maxCeilingHeightAt(pos.x, pos.y, room)) return false;
  return true;
}

// Dome geometry data (used by the 3D renderer to build a SphereGeometry cap).
export function domeGeometry(room) {
  if (room.ceiling_type !== 'dome' || !((room.ceiling_dome_rise_m ?? 0) > 0)) return null;
  const a = Math.sqrt(baseArea(room) / Math.PI);
  const d = room.ceiling_dome_rise_m;
  const R = (a * a + d * d) / (2 * d);
  const thetaMax = Math.acos((R - d) / R);
  return { baseRadius: a, rise: d, sphereRadius: R, thetaMax };
}
```

### 4.2 Direct-field SPL — `js/physics/spl-calculator.js`

```js
export const WALL_TRANSMISSION_LOSS_DB = 30;  // fixed; single-band approximation

// Transform a listener position into the speaker's local polar frame
// (azimuth & elevation relative to the speaker's aim direction).
export function localAngles(speakerPos, speakerAimDeg, listenerPos) {
  const dx = listenerPos.x - speakerPos.x;
  const dy = listenerPos.y - speakerPos.y;
  const dz = listenerPos.z - speakerPos.z;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (r < 1e-6) return { r: 1e-6, azimuth_deg: 0, elevation_deg: 0 };

  const yaw_rad = speakerAimDeg.yaw * Math.PI / 180;
  const pitch_rad = speakerAimDeg.pitch * Math.PI / 180;

  // Speaker aim vector in plan: (sin yaw, cos yaw). "Right" perpendicular: (cos yaw, -sin yaw).
  const aimX = Math.sin(yaw_rad);   const aimY = Math.cos(yaw_rad);
  const rightX = Math.cos(yaw_rad); const rightY = -Math.sin(yaw_rad);

  const azimuth_rad = Math.atan2(
    dx * rightX + dy * rightY,
    dx * aimX + dy * aimY
  );
  const horizDist = Math.sqrt(dx * dx + dy * dy);
  const listenerElev_rad = Math.atan2(dz, horizDist);
  const elevation_rad = listenerElev_rad - pitch_rad;

  return {
    r,
    azimuth_deg: azimuth_rad * 180 / Math.PI,
    elevation_deg: elevation_rad * 180 / Math.PI,
  };
}

// Direct-field SPL from a single speaker at one listener point.
// L = sensitivity + 10 log10(W) − 20 log10(r) + directivity(θ, φ, f)
// Penalty of 30 dB if the direct path crosses the room boundary (wall transmission loss).
export function computeDirectSPL({ speakerDef, speakerState, listenerPos, freq_hz = 1000, room = null }) {
  const { r, azimuth_deg, elevation_deg } = localAngles(
    speakerState.position, speakerState.aim, listenerPos
  );
  const clampedR = Math.max(r, 0.1);
  const sens = speakerDef.acoustic.sensitivity_db_1w_1m;
  const attn = interpolateAttenuation(
    speakerDef.directivity, azimuth_deg, elevation_deg, freq_hz
  );
  let spl_db = sens + 10 * Math.log10(speakerState.power_watts)
                    - 20 * Math.log10(clampedR)
                    + attn;
  const through_wall = pathCrossesBoundary(speakerState, listenerPos, room);
  if (through_wall) spl_db -= WALL_TRANSMISSION_LOSS_DB;
  return { r, azimuth_deg, elevation_deg, attn_db: attn, spl_db, through_wall };
}

// Combine multiple speakers at one listener point.
// Assumes uncorrelated sources: sum pressure² (= sum 10^(SPL/10)), then 10 log10.
// For two identical sources this yields +3 dB over a single source.
export function computeMultiSourceSPL({ sources, getSpeakerDef, listenerPos, freq_hz = 1000, room = null }) {
  let pressureSum = 0;
  for (const src of sources) {
    const def = getSpeakerDef(src.modelUrl);
    if (!def) continue;
    const { spl_db } = computeDirectSPL({
      speakerDef: def, speakerState: src, listenerPos, freq_hz, room,
    });
    pressureSum += Math.pow(10, spl_db / 10);
  }
  return pressureSum > 0 ? 10 * Math.log10(pressureSum) : -Infinity;
}

// SPL grid for a single zone (e.g., one bowl tier).
// Grid is computed over the zone's bounding box, masked to points inside the polygon.
// Ear height = zone.elevation_m + earAbove_m (default 1.2 m for a seated audience).
export function computeZoneSPLGrid({
  zone, sources, getSpeakerDef, room,
  gridSize = 22, freq_hz = 1000, earAbove_m = 1.2,
}) {
  const verts = zone.vertices || [];
  if (verts.length < 3) return null;
  const xs = verts.map(v => v.x), ys = verts.map(v => v.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cellW = (maxX - minX) / gridSize;
  const cellH = (maxY - minY) / gridSize;
  const grid = [];
  let minSPL = Infinity, maxSPL = -Infinity, sum = 0, count = 0;
  const earZ = (zone.elevation_m || 0) + earAbove_m;
  for (let j = 0; j < gridSize; j++) {
    const row = [];
    for (let i = 0; i < gridSize; i++) {
      const x = minX + (i + 0.5) * cellW;
      const y = minY + (j + 0.5) * cellH;
      if (!pointInPoly(x, y, verts)) { row.push(-Infinity); continue; }
      const listenerPos = { x, y, z: earZ };
      const spl = computeMultiSourceSPL({ sources, getSpeakerDef, listenerPos, freq_hz, room });
      row.push(spl);
      if (isFinite(spl)) {
        if (spl < minSPL) minSPL = spl;
        if (spl > maxSPL) maxSPL = spl;
        sum += spl;
        count++;
      }
    }
    grid.push(row);
  }
  return {
    id: zone.id, label: zone.label,
    grid, cellsX: gridSize, cellsY: gridSize,
    boundsX: [minX, maxX], boundsY: [minY, maxY],
    cellW_m: cellW, cellH_m: cellH,
    elevation_m: zone.elevation_m || 0, earZ_m: earZ,
    minSPL_db: ..., maxSPL_db: ..., avgSPL_db: ..., uniformity_db: ...,
  };
}
```

### 4.3 Loudspeaker directivity

Each loudspeaker is a JSON file with an open schema (GLL replacement). Directivity is a 2D attenuation grid per frequency band (dB re on-axis), bilinearly interpolated by `interpolateAttenuation(directivity, azimuth_deg, elevation_deg, freq_hz)`. Example file: `data/loudspeakers/line-array-element.json`.

---

## 5. 3D Rendering

### 5.1 Room shell — `js/graphics/scene.js::rebuildRoom()` (polygon + dome branch)

For the arena's 24-sided polygon plan with domed ceiling:

- **Floor**: `ShapeGeometry` of the 24-gon at y=0.001
- **Walls**: 24 separate `PlaneGeometry` quads, one per edge, each positioned at the edge midpoint and oriented to face the room center via `mesh.lookAt(cx, h/2, cz)`
- **Ring wireframes**: top and bottom polygon outlines as `THREE.Line` loops
- **Vertical edge lines**: one `Line` per polygon vertex
- **Dome cap**: `SphereGeometry` with `thetaStart=0, thetaLength=thetaMax` — only the cap portion of the sphere is generated. Positioned at `(cx, h + rise − sphereRadius, cz)` so the sphere's apex sits at `h + rise`.

```js
// Polygon walls:
const n = room.polygon_sides ?? 6;
const verts = roomPlanVertices(room);
for (let i = 0; i < n; i++) {
  const v1 = verts[i], v2 = verts[(i + 1) % n];
  const edgeLen = Math.hypot(v2.x - v1.x, v2.y - v1.y);
  const midX = (v1.x + v2.x) / 2;
  const midZ = (v1.y + v2.y) / 2;
  const geo = new THREE.PlaneGeometry(edgeLen, h);
  const m = new THREE.Mesh(geo, wallsMat);
  m.position.set(midX, h/2, midZ);
  m.lookAt(cx, h/2, cz);    // orient wall to face room center
  roomGroup.add(m);
}

// Dome cap:
const dome = domeGeometry(room);  // { sphereRadius, rise, thetaMax, baseRadius }
if (dome) {
  const capGeo = new THREE.SphereGeometry(
    dome.sphereRadius, 48, 24,
    0, Math.PI * 2,     // full φ (azimuth)
    0, dome.thetaMax    // θ from top to base of cap
  );
  const cap = new THREE.Mesh(capGeo, ceilMat);
  cap.position.set(cx, h + dome.rise - dome.sphereRadius, cz);
  roomGroup.add(cap);
}
```

### 5.2 Zone heatmap meshes — `scene.js::rebuildZones()`

Each zone (court + 48 bowl tiers) becomes one `ShapeGeometry` textured with an SPL heatmap computed by `computeZoneSPLGrid`.

Key technique: **custom UV mapping so the texture aligns with the zone's bounding box in state coords**. `ShapeGeometry`'s default UVs don't fit our heatmap texture sampling.

```js
for (let zi = 0; zi < state.zones.length; zi++) {
  const zone = state.zones[zi];

  // Local shape centered on zone centroid (for numerical stability).
  const cx = zone.vertices.reduce((a, v) => a + v.x, 0) / zone.vertices.length;
  const cz = zone.vertices.reduce((a, v) => a + v.y, 0) / zone.vertices.length;
  const shape = new THREE.Shape();
  shape.moveTo(zone.vertices[0].x - cx, -(zone.vertices[0].y - cz));
  for (let i = 1; i < zone.vertices.length; i++) {
    shape.lineTo(zone.vertices[i].x - cx, -(zone.vertices[i].y - cz));
  }
  shape.closePath();

  // Compute per-zone SPL grid (22×22 cells at zone.elevation_m + 1.2m)
  const splInfo = computeZoneSPLGrid({
    zone, sources: state.sources,
    getSpeakerDef: url => getCachedLoudspeaker(url),
    room: state.room, gridSize: 24, freq_hz: 1000, earAbove_m: 1.2,
  });
  const heatmapTex = zoneHeatmapTexture(splInfo);

  // ShapeGeometry + manually computed UVs
  const geo = new THREE.ShapeGeometry(shape);
  const [minX, maxX] = splInfo.boundsX;
  const [minY, maxY] = splInfo.boundsY;
  const w = maxX - minX, d = maxY - minY;
  const positions = geo.attributes.position;
  const uvs = new Float32Array(positions.count * 2);
  for (let i = 0; i < positions.count; i++) {
    const lx = positions.getX(i);
    const ly = positions.getY(i);
    // Local (shape) coords back to state coords:
    const sx = lx + cx;
    const sy = cz - ly;
    uvs[i * 2]     = (sx - minX) / w;
    uvs[i * 2 + 1] = 1 - (sy - minY) / d;  // flipY compensation for CanvasTexture
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  const mat = new THREE.MeshBasicMaterial({
    map: heatmapTex, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;           // lay flat
  mesh.position.set(cx, zone.elevation_m + 0.01, cz);  // at zone elevation
  zonesGroup.add(mesh);
}
```

### 5.3 SPL → color

```js
function splColorRGB(spl_db) {
  const t = Math.max(0, Math.min(1, (spl_db - 60) / 50));  // 60..110 dB range
  if (t < 0.25) return interpRGB([26, 26, 74],   [0, 102, 204], t / 0.25);       // dark purple → blue
  if (t < 0.50) return interpRGB([0, 102, 204],  [0, 204, 102], (t - 0.25) / 0.25); // blue → green
  if (t < 0.75) return interpRGB([0, 204, 102],  [255, 204, 0], (t - 0.50) / 0.25); // green → yellow
  return interpRGB([255, 204, 0], [255, 51, 0], (t - 0.75) / 0.25);                  // yellow → red
}
```

### 5.4 Heatmap texture generation

```js
function zoneHeatmapTexture(splInfo) {
  const { grid, cellsX, cellsY } = splInfo;
  const canvas = document.createElement('canvas');
  canvas.width = cellsX; canvas.height = cellsY;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cellsX, cellsY);
  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++) {
      const val = grid[j][i];
      const idx = (j * cellsX + i) * 4;
      if (!isFinite(val)) { img.data[idx + 3] = 0; continue; }  // outside polygon → transparent
      const [r, g, b] = splColorRGB(val);
      img.data[idx + 0] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 210;
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(canvas);
}
```

### 5.5 Stadium furniture — `scene.js::rebuildStadiumFurniture()`

Separate pass that adds **visual-only** elements: vertical riser walls between stepped tiers, courtside risers up from the court floor, and an overhead catwalk torus (rigging truss). No physics impact.

Tier relationships are detected by **zone ID pattern** (`Z_lb{s}_{t}` / `Z_ub{s}_{t}`). The outer radius/angle of each tier is read back from its first 5 polygon vertices (the outer arc).

```js
function rebuildStadiumFurniture() {
  const zoneById = new Map(state.zones.map(z => [z.id, z]));
  const cx = state.room.width_m / 2;
  const cy = state.room.depth_m / 2;
  const arcSteps = 4;  // must match ringSectorVerts default

  const riserMat = new THREE.MeshStandardMaterial({
    color: 0x5a4a38, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
  });

  for (const zone of state.zones) {
    const m = zone.id.match(/^(Z_lb|Z_ub)(\d+)_(\d+)$/);
    if (!m) continue;
    const [, prefix, sectorId, tierStr] = m;
    const tierNum = parseInt(tierStr, 10);
    const nextZone = zoneById.get(`${prefix}${sectorId}_${tierNum + 1}`);

    // Recover outer arc geometry from the polygon vertices (indices 0..arcSteps).
    const vOuter0 = zone.vertices[0];
    const vOuterEnd = zone.vertices[arcSteps];
    const r_outer = Math.hypot(vOuter0.x - cx, vOuter0.y - cy);
    const ts = Math.atan2(vOuter0.y - cy, vOuter0.x - cx);
    const te = Math.atan2(vOuterEnd.y - cy, vOuterEnd.x - cx);
    let thetaLen = te - ts;
    if (thetaLen < -0.01) thetaLen += 2 * Math.PI;

    // Between-tier riser at shared outer radius.
    if (nextZone) {
      const h_bottom = zone.elevation_m;
      const h_top = nextZone.elevation_m;
      const h_diff = h_top - h_bottom;
      if (h_diff > 0.02) {
        const geo = new THREE.CylinderGeometry(
          r_outer, r_outer, h_diff,
          arcSteps * 2, 1, true,      // open-ended, no caps
          ts, thetaLen
        );
        const mesh = new THREE.Mesh(geo, riserMat);
        mesh.position.set(cx, h_bottom + h_diff / 2, cy);
        zonesGroup.add(mesh);
      }
    }

    // Courtside riser for front-row lower-bowl tiers.
    if (prefix === 'Z_lb' && tierNum === 1 && zone.elevation_m > 0.05) {
      const vInnerFromEnd = zone.vertices[arcSteps + 1];
      const vInnerToStart = zone.vertices[2 * arcSteps + 1];
      const r_inner = Math.hypot(vInnerToStart.x - cx, vInnerToStart.y - cy);
      const ts_i = Math.atan2(vInnerToStart.y - cy, vInnerToStart.x - cx);
      const te_i = Math.atan2(vInnerFromEnd.y - cy, vInnerFromEnd.x - cx);
      let thetaLenI = te_i - ts_i;
      if (thetaLenI < -0.01) thetaLenI += 2 * Math.PI;
      const geo = new THREE.CylinderGeometry(
        r_inner, r_inner, zone.elevation_m,
        arcSteps * 2, 1, true, ts_i, thetaLenI
      );
      const mesh = new THREE.Mesh(geo, riserMat);
      mesh.position.set(cx, zone.elevation_m / 2, cy);
      zonesGroup.add(mesh);
    }
  }

  // Catwalk torus (visual rigging truss) for arena-scale rooms only.
  if ((state.room.shape === 'polygon' || state.room.shape === 'round')
      && state.room.ceiling_type === 'dome'
      && state.room.height_m >= 10) {
    const catwalkRadius = Math.min(cx, cy) * 0.35;
    const catwalkHeight = state.room.height_m + 1;
    const ctGeo = new THREE.TorusGeometry(catwalkRadius, 0.25, 8, 48);
    const ctMat = new THREE.MeshStandardMaterial({
      color: 0x888888, metalness: 0.7, roughness: 0.35
    });
    const catwalk = new THREE.Mesh(ctGeo, ctMat);
    catwalk.rotation.x = Math.PI / 2;
    catwalk.position.set(cx, catwalkHeight, cy);
    zonesGroup.add(catwalk);
    // 8 cables from dome to truss.
    const cableMat = new THREE.LineBasicMaterial({ color: 0x666666 });
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const x1 = cx + catwalkRadius * Math.cos(ang);
      const z1 = cy + catwalkRadius * Math.sin(ang);
      const pts = [
        new THREE.Vector3(x1, catwalkHeight, z1),
        new THREE.Vector3(x1 * 0.7 + cx * 0.3, catwalkHeight + 3, z1 * 0.7 + cy * 0.3),
      ];
      zonesGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts), cableMat
      ));
    }
  }
}
```

### 5.6 Sources (speakers) — `scene.js::rebuildSources()`

Each source is rendered as a cone oriented by a quaternion built from the speaker's (yaw, pitch), plus a base sphere and an optional colored floor torus for group membership.

```js
for (const src of state.sources) {
  const outside = !isInsideRoom3D(src.position, state.room);
  const groupHex = src.groupId ? colorForGroup(src.groupId) : null;
  const groupInt = groupHex ? parseInt(groupHex.slice(1), 16) : null;

  // Cone body, color tinted by group (or red if outside room).
  const coneGeo = new THREE.ConeGeometry(0.22, 0.6, 20);
  const coneMat = new THREE.MeshStandardMaterial({
    color: outside ? 0xff5a3c : (groupInt ?? 0xffffff),
    emissive: outside ? 0x550000 : (groupInt ? (groupInt & 0x666666) : 0x333333),
  });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.position.set(src.position.x, src.position.z, src.position.y);  // state z → world Y

  // Orient: cone's default +Y axis should align with aim vector.
  const yaw = src.aim.yaw * Math.PI / 180;
  const pitch = src.aim.pitch * Math.PI / 180;
  const aim = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),                 // +pitch = tilt up
    Math.cos(yaw) * Math.cos(pitch)
  );
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), aim);
  sourcesGroup.add(cone);

  // Base sphere at same position + optional group torus at floor level.
  // ...
}
```

---

## 6. Known Simplifications & Questions for Review

These are documented in [project_chen_audit.md](../memory placeholder) and tracked as a physics/architecture backlog. **Flagging them openly for the reviewer.**

### Physics approximations (Dr. Chen's P1–P5)

| # | Issue | Current approach | What's missing |
|---|---|---|---|
| P1 | Wall transmission loss is **fixed at 30 dB** | Single value at all frequencies | Real TL rises ~6 dB/octave (mass law); gypsum ~20 dB @ 125 Hz, ~38 dB @ 2 kHz |
| P2 | **No reverberant-field SPL** | Only direct-field `L = L_s + 10 log W − 20 log r + dir` | Should add `L_reverb` via room constant `R = Sα/(1−α)` (EASE/ISO 3382) |
| P3 | **No air absorption** | Ignored | At 1 kHz < 1 dB/100 m — fine for this room, wrong for large venues |
| P4 | **No diffraction or aperture coupling** | Wall is either fully present (30 dB TL) or absent | Doors, openings should couple more than 30 dB penalty allows |
| P5 | **Dome volume for non-round bases** | Equivalent-circle radius: `a = √(A/π)` | Introduces ~1–3% error for polygon+dome combinations |
| — | **Multi-source combination** | Pressure² sum (uncorrelated) | Correct for music/speech; wrong for coherent tones (+6 dB instead of +3) |

### Architectural simplifications (Elena Marchetti's review)

| # | Issue | Real arena | Our model |
|---|---|---|---|
| A1 | **Raked seating** | 15–30 continuous rows per bowl, slope ~20–30° | 6 discrete tiers per bowl quadrant, 0.45 m step height |
| A2 | **Concourse level** | Real concourse ~4 m wide with seats & aisles | Empty gap between lower (2.55 m) and upper (5.8 m) bowls |
| A3 | **Vomitories / stair access** | Vertical breaks through the bowl at regular intervals | Not modeled — bowls wrap 360° uninterrupted |
| A4 | **Seat acoustic effect** | Upholstered seats dominate absorption at audience freq bands | Zones use `carpet-heavy` material; no seat-density modeling |
| A5 | **Geodesic dome truss** | Triangulated panels of different absorption | Smooth spherical-cap approximation with single `gypsum-board` material |
| A6 | **Center-hung PA radius** | Wyoming catwalk ~15 m radius | Our cluster is 3 m ring radius; treated as a tight central cluster |
| A7 | **Speaker directivity** | Real line arrays have very narrow vertical (~10°) dispersion | Our JSON has ±45° vertical coverage; mispredicts throw distance |

### Questions for an acoustic / architectural consultant

1. For the bowl zones (point 2.4 **Zones**), should each zone have a **distinct absorption coefficient** reflecting seat density + audience occupancy? Currently all zones use the same material.
2. Is **30 dB wall TL** a reasonable single-band stand-in for a simulation whose primary output is a 1 kHz heatmap? Or should we switch to per-material TL pulled from the `data/materials.json` once we add a `transmission_loss_db` field?
3. The **center-hung PA cluster** (8 speakers at 3 m ring, 15 m high, aimed radially outward at −25°) — is this representative of a typical arena design, or would a real arena use a **left/right/center split array** (a small number of larger arrays rather than a ring of 8 elements)?
4. The **zone heatmap ear height** is hard-coded `zone.elevation_m + 1.2 m` (seated audience). Should upper-bowl visitors really be modeled at 1.2 m above their row surface, or should we account for **sight-line rake** that changes effective ear height row-by-row?
5. RT60 calculation uses `roomVolume` which includes dome volume via spherical-cap formula on the equivalent-circle radius. Is the **Sabine/Eyring model** even applicable to a domed room, or does the concave ceiling create focusing that requires a more sophisticated model?

---

## 7. Testing

All physics has unit tests in `tests/`:
- `rt60.test.mjs` — Sabine/Eyring textbook verification (α=0.1 uniform room → 1.27 s / 1.21 s)
- `spl.test.mjs` — on-axis 1m 1W = sensitivity; 2m = −6 dB; 10W = +10 dB; 90° off-axis = −3 dB; multi-source addition; wall transmission loss
- `room-shape.test.mjs` — shoelace area for L-shape; hex/round/dome volumes & surfaces; 3D containment including dome cap
- `preset.test.mjs` — every preset defines sources + listeners; preset swaps fully replace state; no preset template mutation

Total: ~100 assertions pass.

---

## 8. Repository

- Source: <https://github.com/chongthekuli/RoomLab>
- Live demo: <https://chongthekuli.github.io/RoomLab/>
- Full file references (current commit):
  - `js/app-state.js` — presets, generators, state shape
  - `js/physics/room-shape.js` — plan-shape & dome math
  - `js/physics/spl-calculator.js` — direct-field SPL, wall TL, zone grid
  - `js/physics/loudspeaker.js` — directivity JSON loader + bilinear interpolation
  - `js/graphics/scene.js` — Three.js renderer (room / zones / stadium furniture / sources / listeners)
  - `data/loudspeakers/line-array-element.json` — the speaker used in the arena preset

Reference source for the arena model: [Arena-Auditorium (Wikipedia)](https://en.wikipedia.org/wiki/Arena-Auditorium).
