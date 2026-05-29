// nymphysics — curated public entry point.
//
// This is the SMALL, documented surface a third party adopts: the engine's
// orchestrators, the standard band/constant exports, and the provider hooks
// to feed your own catalogue data. It is deliberately a fraction of the full
// barrel (nymphysics.js, ~150 exports) — that barrel is the internal one-stop
// for RoomLab's own code and exposes every leaf helper; this index is the
// stable front door for outside use.
//
// Adopt:
//   import { runPrecisionRender, computeSPLGrid, computeRT60Band,
//            engineInfo } from 'nymphysics';
//
// Wire your data (optional — only if you use treatments/furniture/racks):
//   import { setSurfaceCatalogueProvider } from 'nymphysics';
//   setSurfaceCatalogueProvider(() => myTreatmentCatalogue);
//
// Everything here re-exports from ./nymphysics.js, which is itself pure /
// Node-importable. See docs/NYMPHYSICS.md for the model derivations.

// ── engine identity ────────────────────────────────────────────────────────
export { NYMPHYSICS_VERSION, NYMPHYSICS_MODES, engineInfo } from './nymphysics.js';

// ── Draft engine — analytical / real-time ───────────────────────────────────
// Reverberation (Sabine / Eyring, ISO 3382-1 / Kuttruff)
export { computeRT60Band, computeAllBands, preferredRT60 } from './nymphysics.js';
// Sound field (direct + Hopkins-Stryker reverberant, multi-source)
export {
  computeSPLGrid,
  computeMultiSourceSPL,
  computeListenerBreakdown,
  computeDirectSPL,
  computeRoomConstant,
  speedOfSound,
} from './nymphysics.js';
// Intelligibility (STIPA, IEC 60268-16)
export { computeSTIPA, stipaRating, STIPA_BANDS } from './nymphysics.js';
// Building acoustics — transmission loss & ratings
export {
  massLawTL,
  doubleLeafTL,
  compositeTL,
  computeRw,
  computeSTC,
} from './nymphysics.js';

// ── Precision engine — ray-traced impulse response ──────────────────────────
export {
  runPrecisionRender,
  buildPhysicsScene,
  deriveMetrics,
  PHYSICS_SCENE_VERSION,
} from './nymphysics.js';

// ── Inputs — materials, loudspeakers, source geometry ───────────────────────
export { loadMaterials, getAbsorption } from './nymphysics.js';
export { loadLoudspeaker, registerLoudspeaker } from './nymphysics.js';
export { expandSources, earHeightFor } from './nymphysics.js';

// ── Adoption — wire your own catalogue data into the engine ──────────────────
export {
  setSurfaceCatalogueProvider,
  setFurnitureCatalogueProvider,
  setRackCatalogueProvider,
} from './nymphysics.js';
