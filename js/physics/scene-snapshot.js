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

// Default raised-cosine exponent when neither nominal_dispersion_deg nor
// directivity_index_db is on the loudspeaker JSON. n=1 = cardioid =
// Q=2 = DI=3.01 dB. Soft default that gives audible directivity without
// being aggressive; user-visible only when a custom-imported speaker JSON
// strips both fields.
const DEFAULT_LOBE_N = 1;
// Numerical floor: never let n drive the on-axis weight beyond ~120 (≈
// pencil-beam horn, DI≈21 dB). Catches absurd JSON values without
// hardcoding domain knowledge in the tracer.
const MAX_LOBE_N = 120;

/**
 * solveLobeExponent — derive the raised-cosine lobe exponent n from the
 * speaker's parametric data. See the comment in buildPhysicsScene where
 * srcDirectivityN is allocated for the rationale and priority order.
 */
export function solveLobeExponent(acoustic) {
  if (!acoustic) return DEFAULT_LOBE_N;
  const disp = acoustic.nominal_dispersion_deg;
  if (Number.isFinite(disp) && disp > 0) {
    if (disp >= 340) return 0;            // ~omni — caller flagged it
    const half = (disp / 2) * Math.PI / 180;
    const c = (1 + Math.cos(half)) / 2;
    if (c > 0 && c < 1) {
      const n = Math.log(0.25) / Math.log(c);
      if (Number.isFinite(n) && n >= 0) return Math.min(n, MAX_LOBE_N);
    }
    return 0;
  }
  const DI = acoustic.directivity_index_db;
  if (Number.isFinite(DI)) {
    const n = Math.pow(10, DI / 10) - 1;
    if (n <= 0) return 0;
    return Math.min(n, MAX_LOBE_N);
  }
  return DEFAULT_LOBE_N;
}

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
  // Per-source raised-cosine-lobe exponent. D(θ) ∝ ((1+cosθ)/2)^n. n=0 is
  // omni, n=1 is cardioid (DI≈3 dB), higher n is narrower. Used by the
  // precision tracer for directivity-weighted ray emission. Derivation:
  //   1) prefer nominal_dispersion_deg → n s.t. D(α/2) = 0.25 (-6 dB):
  //        n = ln(0.25) / ln((1+cos(α/2))/2)
  //   2) else use directivity_index_db → n = 10^(DI/10) − 1 (since the
  //      normalized lobe has Q = n+1 exactly).
  //   3) else fall back to n = 1 (cardioid; "no measured polar" default).
  const srcDirectivityN = new Float32Array(S);
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

    const def = getLoudspeakerDef?.(src.modelUrl);
    let P = Math.max(1e-6, src.power_watts ?? 1);
    // Defensive cap: never let physics see more than the rated max.
    // The Sources panel clamps on input; this catches legacy saved
    // projects that carry over-rated values.
    const cap = def?.electrical?.max_input_watts;
    if (Number.isFinite(cap) && cap > 0) P = Math.min(P, cap);
    srcPowers[i] = P;
    srcModelUrls.push(src.modelUrl);
    srcGroupIds.push(src.groupId ?? null);

    // Pre-compute L_w per band. Current approximation is flat-across-
    // bands (sensitivity scalar + constant DI — the P6 simplification
    // in CALCULATIONS.md §11). When loudspeaker JSONs eventually carry
    // `sensitivity_db_per_band` / `directivity_index_db_per_band`, this
    // loop uses them and the downstream engines see proper HF roll-off.
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
    srcDirectivityN[i] = solveLobeExponent(a);
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
    // Indoor / outdoor flag — outdoor parent rooms have no roof, so the
    // precision tracer must NOT triangulate the parent ceiling (rays
    // escaping upward should leave the room, not bounce off a phantom).
    enclosure: srcRoom.enclosure === 'outdoor' ? 'outdoor' : 'indoor',
    // Broken-out sub-rooms produced by Place + Break-to-merge. Each is
    // an independent mini-room with its own polygon, height, elevation,
    // and surfaces (floor / ceiling / per-edge). The precision tracer
    // triangulates each one as if it were a small custom room — without
    // this, a listener INSIDE a merged enclosure has no surrounding walls
    // in the BVH and STI returns 1.0 (no late reverberation). Snapshot
    // shape mirrors panel-room.js's break-to-merge writer; deep-frozen.
    standaloneEnclosures: Array.isArray(srcRoom.standaloneEnclosures)
      ? Object.freeze(srcRoom.standaloneEnclosures.map(enc => Object.freeze({
          id: enc.id,
          label: enc.label,
          polygon: Object.freeze((enc.polygon ?? []).map(v =>
            Object.freeze({ x: v.x, y: v.y }))),
          height_m: Number.isFinite(enc.height_m) ? enc.height_m : 3,
          elevation_m: Number.isFinite(enc.elevation_m) ? enc.elevation_m : 0,
          surfaces: Object.freeze(JSON.parse(JSON.stringify(enc.surfaces ?? {}))),
        })))
      : Object.freeze([]),
    // Canonical shared walls produced by the wall-overlap split — one
    // entry per merged seam between parent + enclosure or enclosure +
    // enclosure. Triangulated as a single quad each.
    wallSegments: Array.isArray(srcRoom.wallSegments)
      ? Object.freeze(srcRoom.wallSegments.map(seg => Object.freeze({
          id: seg.id,
          x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2,
          elevation_m: Number.isFinite(seg.elevation_m) ? seg.elevation_m : 0,
          height_m: Number.isFinite(seg.height_m) ? seg.height_m : 3,
          materialId: typeof seg.materialId === 'string' ? seg.materialId : 'gypsum-board',
          openings: Object.freeze(JSON.parse(JSON.stringify(seg.openings ?? []))),
        })))
      : Object.freeze([]),
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
      directivityN: srcDirectivityN,
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
