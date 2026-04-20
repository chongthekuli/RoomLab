// PhysicsScene — immutable, flat, worker-transferable snapshot of every
// physics input. Both engines (current Sabine/Hopkins-Stryker draft + the
// future ISM+ray-traced precision) consume this instead of reading from
// the mutable `state.*` tree directly.
//
// Design goals (per docs/DUAL-ENGINE-BLUEPRINT.md §1):
//   • No string-keyed lookups in hot loops — materials resolved to
//     indices, absorption/scattering stored in Float32Arrays.
//   • Worker-safe — only primitives + TypedArrays + frozen plain objects.
//     No class instances, no functions, no DOM refs. Transferable by
//     structured clone OR SharedArrayBuffer.
//   • Cheap to rebuild on state edits (draft path); cheap to transfer
//     once to a worker pool (precision path).
//   • Versioned — PHYSICS_SCENE_VERSION bumps whenever the shape changes
//     so workers can refuse incompatible snapshots.
//
// This is Phase A scaffolding. Existing physics functions still read
// `state.*` directly; the A2 refactor will retire those call sites in
// favour of `PhysicsScene`-accepting signatures.

import { expandSources } from '../app-state.js';

export const PHYSICS_SCENE_VERSION = 1;

// Default scattering coefficient when a material pre-dates the v1.3
// materials.json schema (all current entries have `scattering` but a
// user-imported custom material may not). Matches ODEON's "slightly
// rough" default used when no measurement is available.
const DEFAULT_SCATTERING = 0.10;

// ODEON convention — volumetric receiver sphere radius. Smaller = sharper
// impulse response but more rays needed to converge. Larger = blurred
// early reflections. Overridable per-listener later.
const DEFAULT_RECEIVER_RADIUS_M = 0.5;
const DEFAULT_EAR_HEIGHT_M = 1.2;

/**
 * Build a frozen PhysicsScene snapshot from the mutable state.
 *
 * @param {object} args
 * @param {object} args.state            The mutable app state (not retained).
 * @param {object} args.materials        materials module output: { frequency_bands_hz, list, byId }.
 * @param {(url:string)=>object|null} args.getLoudspeakerDef  Resolver for speaker JSON.
 * @returns {PhysicsScene} immutable snapshot.
 */
export function buildPhysicsScene({ state, materials, getLoudspeakerDef }) {
  const bands_hz = Object.freeze([...materials.frequency_bands_hz]);
  const BANDS = bands_hz.length;

  // --- Materials — resolve to flat indexed table. ---------------------
  const materialsTable = materials.list.map((m, idx) => {
    const abs = m.absorption ?? [];
    const sca = m.scattering ?? [];
    const absArr = new Float32Array(BANDS);
    const scaArr = new Float32Array(BANDS);
    for (let k = 0; k < BANDS; k++) {
      absArr[k] = abs[k] ?? 0;
      scaArr[k] = sca[k] ?? DEFAULT_SCATTERING;
    }
    return Object.freeze({
      index: idx,
      id: m.id,
      name: m.name ?? m.id,
      absorption: absArr,
      scattering: scaArr,
    });
  });
  const materialIndexById = new Map(materialsTable.map(m => [m.id, m.index]));
  const audienceMatIdx = materialIndexById.get('audience-seated') ?? -1;
  const audienceMat = audienceMatIdx >= 0 ? materialsTable[audienceMatIdx] : null;

  // --- Sources — expand line arrays into physical elements. -----------
  const flatSources = expandSources(state.sources ?? []);
  const S = flatSources.length;
  const srcPositions = new Float32Array(S * 3);
  const srcAims = new Float32Array(S * 3);
  const srcPowers = new Float32Array(S);
  const srcLwPerBand = new Float32Array(S * BANDS);
  const srcModelUrls = [];
  const srcGroupIds = [];

  for (let i = 0; i < S; i++) {
    const src = flatSources[i];
    srcPositions[i * 3 + 0] = src.position.x;
    srcPositions[i * 3 + 1] = src.position.y;
    srcPositions[i * 3 + 2] = src.position.z;

    // Convert yaw/pitch (degrees) to unit aim vector in state coords.
    const yawRad = ((src.aim?.yaw ?? 0) * Math.PI) / 180;
    const pitchRad = ((src.aim?.pitch ?? 0) * Math.PI) / 180;
    const cp = Math.cos(pitchRad);
    srcAims[i * 3 + 0] = Math.sin(yawRad) * cp;
    srcAims[i * 3 + 1] = Math.cos(yawRad) * cp;
    srcAims[i * 3 + 2] = Math.sin(pitchRad);

    const P = Math.max(1e-6, src.power_watts ?? 1);
    srcPowers[i] = P;
    srcModelUrls.push(src.modelUrl);
    srcGroupIds.push(src.groupId ?? null);

    // Pre-compute L_w per band. Current approximation is flat-across-
    // bands (sensitivity scalar + constant DI — the P6 simplification
    // in CALCULATIONS.md §11). When loudspeaker JSONs eventually carry
    // `sensitivity_db_per_band` / `directivity_index_db_per_band`, this
    // loop uses them and the downstream engines see proper HF roll-off.
    const def = getLoudspeakerDef?.(src.modelUrl);
    const a = def?.acoustic ?? {};
    const sensScalar = a.sensitivity_db_1w_1m ?? 90;
    const sensPerBand = Array.isArray(a.sensitivity_db_per_band) && a.sensitivity_db_per_band.length === BANDS
      ? a.sensitivity_db_per_band : null;
    const DI_scalar = a.directivity_index_db ?? 3;
    const DIperBand = Array.isArray(a.directivity_index_db_per_band) && a.directivity_index_db_per_band.length === BANDS
      ? a.directivity_index_db_per_band : null;
    const p10 = 10 * Math.log10(P);
    for (let k = 0; k < BANDS; k++) {
      const sens = sensPerBand ? sensPerBand[k] : sensScalar;
      const DI = DIperBand ? DIperBand[k] : DI_scalar;
      srcLwPerBand[i * BANDS + k] = sens + p10 + 11 - DI;
    }
  }

  // --- Receivers — listeners as volumetric spheres. -------------------
  const listeners = state.listeners ?? [];
  const R = listeners.length;
  const recPositions = new Float32Array(R * 3);
  const recRadii = new Float32Array(R);
  const recLabels = [];
  const recIds = [];
  for (let i = 0; i < R; i++) {
    const lst = listeners[i];
    recPositions[i * 3 + 0] = lst.position.x;
    recPositions[i * 3 + 1] = lst.position.y;
    recPositions[i * 3 + 2] = (lst.elevation_m ?? 0) + DEFAULT_EAR_HEIGHT_M;
    recRadii[i] = lst.receiver_radius_m ?? DEFAULT_RECEIVER_RADIUS_M;
    recLabels.push(lst.label ?? `Listener ${i + 1}`);
    recIds.push(lst.id ?? `L${i + 1}`);
  }

  // --- Zones — pre-blend audience occupancy absorption + scattering. --
  const stateZones = state.zones ?? [];
  const zones = stateZones.map(z => {
    const matIdx = materialIndexById.get(z.material_id) ?? -1;
    const occ = Math.max(0, Math.min(1, (z.occupancy_percent ?? 0) / 100));
    const baseMat = matIdx >= 0 ? materialsTable[matIdx] : null;

    const absArr = new Float32Array(BANDS);
    const scaArr = new Float32Array(BANDS);
    for (let k = 0; k < BANDS; k++) {
      const a = baseMat?.absorption[k] ?? 0;
      const s = baseMat?.scattering[k] ?? DEFAULT_SCATTERING;
      if (occ > 0 && audienceMat) {
        absArr[k] = a * (1 - occ) + audienceMat.absorption[k] * occ;
        scaArr[k] = s * (1 - occ) + audienceMat.scattering[k] * occ;
      } else {
        absArr[k] = a;
        scaArr[k] = s;
      }
    }

    // Copy vertices as a flat Float32Array for potential worker transfer
    // later (triangulation happens in Phase B).
    const verts = z.vertices ?? [];
    const vertsXY = new Float32Array(verts.length * 2);
    for (let vi = 0; vi < verts.length; vi++) {
      vertsXY[vi * 2 + 0] = verts[vi].x;
      vertsXY[vi * 2 + 1] = verts[vi].y;
    }
    return Object.freeze({
      id: z.id,
      label: z.label ?? z.id,
      materialIdx: matIdx,
      occupancy: occ,
      absorption: absArr,
      scattering: scaArr,
      elevation_m: z.elevation_m ?? 0,
      vertexCount: verts.length,
      verticesXY: vertsXY,
    });
  });

  // --- Room — shallow-clone the fields physics cares about. -----------
  const srcRoom = state.room ?? {};
  const room = Object.freeze({
    shape: srcRoom.shape ?? 'rectangular',
    width_m: srcRoom.width_m ?? 10,
    depth_m: srcRoom.depth_m ?? 10,
    height_m: srcRoom.height_m ?? 3,
    polygon_sides: srcRoom.polygon_sides,
    polygon_radius_m: srcRoom.polygon_radius_m,
    round_radius_m: srcRoom.round_radius_m,
    ceiling_type: srcRoom.ceiling_type ?? 'flat',
    ceiling_dome_rise_m: srcRoom.ceiling_dome_rise_m,
    surfaces: Object.freeze({ ...(srcRoom.surfaces ?? {}) }),
    stadiumStructure: srcRoom.stadiumStructure
      ? Object.freeze(JSON.parse(JSON.stringify(srcRoom.stadiumStructure)))
      : null,
    // custom_vertices preserved for custom-polygon rooms.
    custom_vertices: Array.isArray(srcRoom.custom_vertices)
      ? Object.freeze(srcRoom.custom_vertices.map(v => Object.freeze({ x: v.x, y: v.y })))
      : null,
  });

  // --- Physics flags — snapshot the toggle state at build time. -------
  const p = state.physics ?? {};
  const physics = Object.freeze({
    reverberantField: !!p.reverberantField,
    coherent: !!p.coherent,
    airAbsorption: p.airAbsorption !== false,
    freq_hz: p.freq_hz ?? 1000,
    temperature_C: p.temperature_C ?? 20,
  });

  // --- Master EQ — deep-clone so worker can't observe live mutations. -
  const eq = p.eq ? Object.freeze({
    enabled: !!p.eq.enabled,
    bands: Object.freeze((p.eq.bands ?? []).map(b =>
      Object.freeze({ freq_hz: b.freq_hz, gain_db: b.gain_db }))),
  }) : null;

  return Object.freeze({
    version: PHYSICS_SCENE_VERSION,
    createdAt: Date.now(),
    bands_hz,
    materials: Object.freeze(materialsTable),
    room,
    zones: Object.freeze(zones),
    sources: Object.freeze({
      count: S,
      positions: srcPositions,
      aims: srcAims,
      powers: srcPowers,
      L_w: srcLwPerBand,
      modelUrls: Object.freeze([...srcModelUrls]),
      groupIds: Object.freeze([...srcGroupIds]),
    }),
    receivers: Object.freeze({
      count: R,
      positions: recPositions,
      radii: recRadii,
      labels: Object.freeze(recLabels),
      ids: Object.freeze(recIds),
    }),
    physics,
    eq,

    // Phase B additions — triangle list + BVH — land with the
    // precision engine. Present here as null placeholders so worker
    // messages can be statically typed against the final shape.
    triangles: null,
    bvh: null,
  });
}

// Small helper for UI code that wants to know if two snapshots would
// produce identical physics results (e.g. to skip a recompute). Not
// exhaustive — intended for quick dirty-bit checks, not deep diff.
export function snapshotsEquivalent(a, b) {
  if (!a || !b) return a === b;
  if (a.version !== b.version) return false;
  if (a.sources.count !== b.sources.count) return false;
  if (a.receivers.count !== b.receivers.count) return false;
  if (a.zones.length !== b.zones.length) return false;
  if (a.physics.freq_hz !== b.physics.freq_hz) return false;
  if (a.physics.reverberantField !== b.physics.reverberantField) return false;
  if (a.physics.airAbsorption !== b.physics.airAbsorption) return false;
  if (!!a.eq?.enabled !== !!b.eq?.enabled) return false;
  // Deeper equality (geometry, material values) is expensive; caller
  // can always compare .createdAt or use explicit dirty bits.
  return true;
}
