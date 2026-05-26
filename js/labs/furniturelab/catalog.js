// FurnitureLAB catalogue loader. Mirrors the discipline of
// js/labs/surfacelab/catalog.js — fetch JSON once, cache the parsed
// result, expose both an async loader and a sync getter so consumers
// (rt60 panel, room-2d render, print report) can read the cached map
// without paying a re-fetch.
//
// `loadFurnitureCatalogue()` is idempotent and safe to call from
// multiple entry points (FurnitureLAB mount, app startup pre-warm,
// the panel-results.js rt60 path). The async load is kicked from
// js/main.js so the catalogue is in memory by the time the user first
// places an object.
//
// `getFurnitureCatalogue()` always returns a Map (empty Map until the
// load resolves). Callers should treat an empty catalogue as "no
// furniture contributes A_obj yet" — same graceful-degradation pattern
// as surfacelab/catalog.js's getTreatmentAbsorption returning null.

const CATALOGUE_URL = './data/furniture/catalogue.json';

let _cache = null;
let _loadPromise = null;

/**
 * Load and cache the catalogue. Idempotent — repeat calls return the
 * same promise / cached value. Network failures bubble so callers can
 * surface a clear error to the user.
 */
export async function loadFurnitureCatalogue() {
  if (_cache) return _cache;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const res = await fetch(CATALOGUE_URL);
    if (!res.ok) throw new Error(`FurnitureLAB catalogue fetch failed: ${res.status}`);
    const json = await res.json();
    const map = new Map();
    for (const item of json.items ?? []) {
      if (item && typeof item.id === 'string') map.set(item.id, item);
    }
    _cache = { json, map };
    return _cache;
  })();
  return _loadPromise;
}

/**
 * Sync getter — returns the cached Map<catalogueId, row>, or an empty
 * Map when the load hasn't resolved yet. NEVER throws.
 */
export function getFurnitureCatalogue() {
  return _cache?.map ?? new Map();
}

/**
 * Sync getter for the full parsed JSON (items array + schema metadata).
 * Returns null when not yet loaded.
 */
export function getFurnitureCatalogueJson() {
  return _cache?.json ?? null;
}
