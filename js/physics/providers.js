// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// providers — dependency-injection registry for catalogue data that lives
// OUTSIDE the engine.
//
// nymphysics must not import from js/labs/ (that would make a "pure" physics
// module depend on RoomLab's UI/catalogue layer and break standalone
// adoption). Instead, the catalogue modules REGISTER a getter here at import
// time — labs → physics is an allowed dependency direction — and the engine
// reads catalogue data only through these accessors.
//
// Each accessor returns a safe empty default until a provider is registered,
// so a physics-only consumer (a Node test, or a third-party adopter) that
// never wires a catalogue simply sees "no treatments / no furniture / no
// racks". That is exactly the fallback the engine has always had when the
// catalogue fetch race loses — see the docblocks on the original
// surfacelab/furniturelab/devicelab getters this replaces.
//
// A getter (not a snapshot of the data) is registered, so the values are
// always read live from the catalogue cache — no staleness, no need to
// re-push on every catalogue reload.
//
// Adopters: call setSurfaceCatalogueProvider / setFurnitureCatalogueProvider
// / setRackCatalogueProvider once with your own catalogue getter to drive the
// engine from your data source.

let _surfaceCatalogueGetter = null;   // () => { all: [{ id, absorption[], scattering_coefficient[] }], groups } | null
let _furnitureCatalogueGetter = null; // () => Map<catalogueId, row>
let _rackCatalogueGetter = null;      // () => { schema_version, racks: {...} } | null

export function setSurfaceCatalogueProvider(fn) { _surfaceCatalogueGetter = typeof fn === 'function' ? fn : null; }
export function setFurnitureCatalogueProvider(fn) { _furnitureCatalogueGetter = typeof fn === 'function' ? fn : null; }
export function setRackCatalogueProvider(fn) { _rackCatalogueGetter = typeof fn === 'function' ? fn : null; }

// TEST/ADOPTER hook — clear every registered provider (restores the
// "no catalogue wired" defaults). Lets a test assert the fallback path.
export function _clearAllProviders() {
  _surfaceCatalogueGetter = null;
  _furnitureCatalogueGetter = null;
  _rackCatalogueGetter = null;
}

// ---------------------------------------------------------------------------
// Surface (treatment) catalogue
// ---------------------------------------------------------------------------

// Whole loaded surface catalogue, or null if none wired / not yet loaded.
// Default null matches the old surfacelab getCachedCatalogue().
export function getCachedCatalogue() {
  return _surfaceCatalogueGetter ? _surfaceCatalogueGetter() : null;
}

// Per-band absorption coefficient of a placed treatment product. Returns
// null when no catalogue is wired, the product is unknown (deleted product /
// typo in a saved scene), or the band is out of range — callers treat null
// as "treatment is visually present but has no acoustic effect", which is the
// engine's documented visual-only fallback. Lookup logic is physics; the raw
// catalogue comes from the registered provider.
export function getTreatmentAbsorption(productId, bandIdx) {
  const cat = getCachedCatalogue();
  if (!cat || !Array.isArray(cat.all)) return null;
  const entry = cat.all.find(e => e.id === productId);
  if (!entry || !Array.isArray(entry.absorption)) return null;
  const v = entry.absorption[bandIdx];
  return Number.isFinite(v) ? v : null;
}

// Per-band ISO 17497-2 scattering coefficient of a placed treatment. Same
// fallback semantics as getTreatmentAbsorption; null → caller treats as 0
// (fully specular). Sibling accessor kept for completeness / adopters.
export function getTreatmentScattering(productId, bandIdx) {
  const cat = getCachedCatalogue();
  if (!cat || !Array.isArray(cat.all)) return null;
  const entry = cat.all.find(e => e.id === productId);
  if (!entry || !Array.isArray(entry.scattering_coefficient)) return null;
  const v = entry.scattering_coefficient[bandIdx];
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Furniture catalogue
// ---------------------------------------------------------------------------

// Map<catalogueId, row>, or an empty Map when none wired / not yet loaded.
// Default empty-Map matches the old furniturelab getFurnitureCatalogue().
export function getFurnitureCatalogue() {
  return _furnitureCatalogueGetter ? _furnitureCatalogueGetter() : new Map();
}

// ---------------------------------------------------------------------------
// Rack (DeviceLAB) catalogue
// ---------------------------------------------------------------------------

// Raw rack catalogue JSON ({ schema_version, racks: {...} }), or null.
// Default null matches the old devicelab getRackCatalogue().
export function getRackCatalogue() {
  return _rackCatalogueGetter ? _rackCatalogueGetter() : null;
}
