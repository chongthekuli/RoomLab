// DeviceLAB rack catalogue accessor. Mirrors
// js/labs/furniturelab/catalog.js — fetch once, cache the parsed result,
// expose sync getters so consumers (rt60 panel, room acoustics, scene
// rebuilder, print report) can read without paying a re-fetch.
//
// `loadRackCatalogue()` is idempotent — multiple entry points
// (DeviceLAB mount, app startup pre-warm, the physics integration path)
// converge on the same cached value.
//
// `getRackCatalogue()` returns the raw {schema_version, racks: {key: def}}
// JSON shape, or null when not loaded. `getRackCatalogueMap()` returns
// a Map<key, def>. Either is accepted by sumRackAbsorption (the helper
// detects shape).

import { setRackCatalogueProvider } from '../../physics/providers.js';

const CATALOGUE_URL = './data/racks/catalogue.json';

let _cache = null;
let _loadPromise = null;

// Wire this catalogue into the engine's provider registry (labs → physics is
// the allowed direction) so nymphysics reads rack defs without importing
// js/labs/. getRackCatalogue is a hoisted function declaration.
setRackCatalogueProvider(getRackCatalogue);

/**
 * Load and cache the catalogue. Idempotent — repeat calls return the
 * same promise / cached value.
 */
export async function loadRackCatalogue() {
  if (_cache) return _cache;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const res = await fetch(CATALOGUE_URL);
    if (!res.ok) throw new Error(`DeviceLAB rack catalogue fetch failed: ${res.status}`);
    const json = await res.json();
    const map = new Map();
    for (const [key, def] of Object.entries(json.racks ?? {})) {
      if (key && def) map.set(key, def);
    }
    _cache = { json, map };
    return _cache;
  })();
  return _loadPromise;
}

/** Sync getter — returns the raw JSON ({schema_version, racks: {...}}), or null. */
export function getRackCatalogue() {
  return _cache?.json ?? null;
}

/** Sync getter — returns Map<rackModelKey, def>, or empty Map. */
export function getRackCatalogueMap() {
  return _cache?.map ?? new Map();
}

/** Seed the catalogue cache for Node tests. Mirrors the furniturelab pattern. */
export function _setRackCatalogueForTests(jsonOrDefsObject) {
  if (!jsonOrDefsObject) { _cache = null; _loadPromise = null; return; }
  const json = jsonOrDefsObject.racks ? jsonOrDefsObject : { schema_version: 'test', racks: jsonOrDefsObject };
  const map = new Map();
  for (const [key, def] of Object.entries(json.racks ?? {})) {
    if (key && def) map.set(key, def);
  }
  _cache = { json, map };
  _loadPromise = Promise.resolve(_cache);
}
