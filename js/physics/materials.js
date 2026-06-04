// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Chong Ching Yong (chongthekuli). All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// Load + index the material absorption catalogue. The URL is REQUIRED — the
// engine carries no host-specific default path (a third-party adopter passes
// their own catalogue location). RoomLab callers pass 'data/materials.json'.
export async function loadMaterials(url) {
  if (!url) {
    throw new Error('loadMaterials(url): a materials-JSON URL is required (the engine has no host default path).');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const data = await res.json();
  return {
    frequency_bands_hz: data.frequency_bands_hz,
    list: data.materials,
    byId: Object.fromEntries(data.materials.map(m => [m.id, m])),
  };
}

export function getAbsorption(materials, materialId, bandIndex) {
  return materials.byId[materialId]?.absorption[bandIndex] ?? 0;
}
