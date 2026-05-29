// nymphysics — RoomLab's acoustics engine, public API barrel.
//
// nymphysics is the named boundary around js/physics/. It re-exports the
// PUBLIC surface of the engine in tiers so the rest of the app imports
// from one stable place instead of reaching into individual module files.
// Internal helpers (wall-id, wall-geometry, the worker adapter, low-level
// segment math, *_testing hooks) are intentionally NOT re-exported.
//
// The engine runs in two MODES, both branded nymphysics:
//   • Draft     — analytical / statistical, real-time (Sabine, Eyring,
//                 Hopkins-Stryker diffuse field, mass-law TL, Maekawa
//                 diffraction, STIPA). Powers the live heatmap + readouts.
//   • Precision — ray-traced impulse response (BVH + stochastic tracer →
//                 energy histogram → ISO 3382 / IEC 60268-16 metrics).
//
// This module is PURE / Node-importable: nothing here touches the DOM or
// Three.js at import time, and no re-exported module does browser work at
// module-eval (workers + fetch only fire when their functions are called).
// The canonical derivations live in docs/NYMPHYSICS.md; each tier below
// maps to a section of that document.
//
// NOTE (decision, 2026-05-29): consumers are NOT yet migrated to import
// from here — the barrel ships first with zero consumer churn. New code
// SHOULD import from 'js/physics/nymphysics.js'; deep imports into
// individual physics modules remain valid until a later migration pass.

// ---------------------------------------------------------------------------
// meta — engine identity
// ---------------------------------------------------------------------------

// Engine version. Independent of index.html's ?v=NNN cache-bust string —
// this identifies the PHYSICS, not the asset bundle. Bump on a meaningful
// model/behaviour change to the engine (not on every UI tweak).
export const NYMPHYSICS_VERSION = '1.0.0';

export const NYMPHYSICS_MODES = Object.freeze(['Draft', 'Precision']);

// Small descriptor for UI / report credit lines ("Computed with nymphysics
// v1.0.0 · Precision"). Frozen so a consumer can't mutate shared state.
export function engineInfo() {
  return Object.freeze({
    name: 'nymphysics',
    version: NYMPHYSICS_VERSION,
    modes: NYMPHYSICS_MODES,
    description: "RoomLab's acoustics engine — Draft (analytical) + Precision (ray-traced).",
  });
}

// ---------------------------------------------------------------------------
// geometry — room shape, bounds, containment, wall insets
// ---------------------------------------------------------------------------

export {
  DEFAULT_WALL_THICKNESS_M,
  PODIUM_MAX_Z_M,
  normalizeWallSlot,
  baseArea,
  wallPerimeter,
  ceilingArea,
  roomVolume,
  roomCenter,
  roomPlanVertices,
  roomEffectiveBounds,
  isInsideParentFootprint,
  isInsideRoom,
  isInsideRoom3D,
  defaultInsidePosition,
  maxCeilingHeightAt,
  roomSurfaces,
  roomEffectiveSurfaces,
  surauStructureWallOpenings,
  applySurauOpeningsToSlot,
  domeGeometry,
} from './room-shape.js';

export {
  WALL_LABEL_MAX_CHARS,
  getWallEdgeThickness,
  wallInsetPolygon,
  wallLabelAnchor,
} from './wall-inset.js';

// ---------------------------------------------------------------------------
// materials & walls — absorption catalogue, transmission loss, ratings
// ---------------------------------------------------------------------------

export { loadMaterials, getAbsorption } from './materials.js';

export {
  TL_FLOOR_DB,
  TL_CEIL_DB,
  MASS_LAW_CONST_DB,
  massLawTL,
  massLawTLBands,
  massLawTLBandsAtThickness,
  surfaceDensity,
  densityFromCatalogue,
} from './wall-tl.js';

export {
  doubleLeafTL,
  doubleLeafTLBand,
  massAirMassFreq,
  cavityCutoffFreq,
  STUD_TYPES,
} from './wall-tl-double-leaf.js';

export { compositeTL } from './wall-composite.js';

export { computeRw, computeSTC, computeC, computeCtr } from './wall-rating.js';

export { splitParentVsEnclosure } from './wall-overlap.js';

// ---------------------------------------------------------------------------
// propagation — direct SPL, air absorption, diffraction
// ---------------------------------------------------------------------------

export {
  AIR_ABSORPTION_DB_PER_M,
  airAbsorptionDbPerM,
  airAbsorptionCoefficient_m,
  airSabins,
  airAbsorptionDbPerM_param,
  airAbsorptionCoefficient_m_param,
} from './air-absorption.js';

export {
  airAbsorptionAt,
  WALL_TRANSMISSION_LOSS_DB,
  effectivePowerWatts,
  DEFAULT_TEMPERATURE_C,
  speedOfSound,
  computeRoomConstant,
  computeDirectSPL,
  precomputeSPLContext,
  computeMultiSourceSPLFromContext,
  computeMultiSourceSPL,
  computeListenerBreakdown,
  squareCellCounts,
  computeZoneSPLGrid,
  computeSPLGrid,
} from './spl-calculator.js';

export {
  MAEKAWA_IL_MAX_DB,
  MAEKAWA_IL_GRAZE_DB,
  maekawaIL,
  thickBarrierIL,
  overBarrierPathDifference,
  wedgeIL,
  computeDiffractionContributions,
  computeCornerDiffractionContributions,
} from './diffraction.js';

// ---------------------------------------------------------------------------
// reverberation — Sabine / Eyring RT60
// ---------------------------------------------------------------------------

export {
  sabine,
  eyring,
  computeRT60Band,
  preferredRT60,
  computeAllBands,
} from './rt60.js';

// ---------------------------------------------------------------------------
// intelligibility — STIPA (IEC 60268-16)
// ---------------------------------------------------------------------------

export {
  STIPA_BANDS,
  STIPA_MOD_FREQS,
  precomputeSTIPAContext,
  computeSTIPAAt,
  computeSTIPA,
  stipaRating,
} from './stipa.js';

// ---------------------------------------------------------------------------
// sources — loudspeaker directivity, speaker analysis & import
// ---------------------------------------------------------------------------

export {
  loadLoudspeaker,
  getCachedLoudspeaker,
  registerLoudspeaker,
  interpolateAttenuation,
} from './loudspeaker.js';

export {
  analyseSpeaker,
  estimateNominalDispersion,
  onAxisResponseDb,
  csdPerBand,
} from './speaker-expert.js';

export { GLL_GUIDE, importSpeakerFile } from './speaker-import.js';

// ---------------------------------------------------------------------------
// per-listener — combined SPL + STI metric helper (2D + print share this)
// ---------------------------------------------------------------------------

export {
  computePerListenerMetrics,
  formatListenerMetricsLabel,
} from './per-listener-metrics.js';

// ---------------------------------------------------------------------------
// precision — ray-traced engine (scene snapshot → BVH → tracer → metrics)
// ---------------------------------------------------------------------------

export {
  PHYSICS_SCENE_VERSION,
  solveLobeExponent,
  buildPhysicsScene,
  snapshotsEquivalent,
} from './scene-snapshot.js';

export { runPrecisionRender } from './precision/precision-engine.js';

export {
  buildBVH,
  buildAabbBVH,
  intersectRay,
  intersectRayBrute,
  intersectRay_collectAabbs,
} from './precision/bvh.js';

export { traceRays, histogramWindowSum } from './precision/tracer-core.js';

export { triangulateScene, SURFACE_TAGS } from './precision/triangulate-scene.js';

export {
  deriveMetrics,
  calcEDT,
  calcT20,
  calcT30,
  calcC80,
  calcC50,
  calcDR,
  calcSTIFromIR,
  schroederDecay,
  computeMTF,
} from './precision/derive-metrics.js';

export { PrecisionWorkerPool, mergePartialHistograms } from './precision/worker-pool.js';

// ---------------------------------------------------------------------------
// display & utilities — render-only grid post-processing, viz, flags, import
// ---------------------------------------------------------------------------

export { dilateGridForDisplay, buildSilhouetteMask } from './grid-display.js';

export { recordRayPaths, buildLineSegmentIndex } from './ray-viz.js';

export {
  PHYSICS_P1_5_ENABLED,
  getEffectivePhysicsP15,
  getStoredPhysicsP15,
  setStoredPhysicsP15,
  isTier1aOutdoorOverrideDisabled,
} from './feature-flags.js';

export { importDxfFile, parseDxfText } from './dxf-import.js';

export { furnitureBlocksCylinder } from './furniture-walk-collision.js';
export { rackBlocksCylinder } from './rack-walk-collision.js';
