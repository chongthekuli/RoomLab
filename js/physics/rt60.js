// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

import { roomSurfaces, roomEffectiveSurfaces, roomVolume } from './room-shape.js';
import { airSabins } from './air-absorption.js';
import { getTreatmentAbsorption } from './providers.js';
import { sumFurnitureAbsorption } from './furniture-absorption.js';
import { sumStructureAbsorption } from './building-structures.js';
import { sumRackAbsorption } from './rack-absorption.js';

const SABINE_CONSTANT = 0.161;

export function sabine({ volume_m3, totalAbsorption_sabins }) {
  if (totalAbsorption_sabins <= 0) return Infinity;
  return SABINE_CONSTANT * volume_m3 / totalAbsorption_sabins;
}

// Eyring with optional additive air-absorption and object (furniture)
// absorption terms.
//   Classical:    T = 0.161·V / (−S·ln(1−α̅))
//   With air:     T = 0.161·V / (−S·ln(1−α̅_surface) + 4mV)
//   With objects: T = 0.161·V / (−S·ln(1−α̅_surface) + 4mV + ΣA_obj)
//
// Air absorption and discrete object absorption (chairs, drapes,
// audience etc.) enter linearly as in Sabine — Kuttruff 5th ed. §5.3
// and Beranek 2nd ed. §7.3 keep the logarithm on SURFACE absorption
// only. Lumping ΣA_obj into ᾱ_surfaces inflates the log argument and
// underestimates RT60 by ~8% in objects-heavy rooms; the parallel-A
// formulation is the physically-correct one.
export function eyring({ volume_m3, totalArea_m2, surfaceMeanAbsorption, airAbsSabins = 0, objectAbsSabins = 0 }) {
  const denom = (-totalArea_m2 * Math.log(Math.max(1e-9, 1 - surfaceMeanAbsorption)))
              + airAbsSabins
              + objectAbsSabins;
  if (denom <= 0) return Infinity;
  if (surfaceMeanAbsorption >= 1 && airAbsSabins <= 0 && objectAbsSabins <= 0) return 0;
  return SABINE_CONSTANT * volume_m3 / denom;
}

// RT60 at one octave band.
//
// Total absorption in Sabins includes the 4mV air-absorption volumetric
// sink (ISO 9613-1 converted to Nepers/m), not just wall+zone surfaces.
// For small rooms the term is negligible; for a 48 k-m³ arena at 8 kHz
// 4mV is ~4,100 Sabins vs ~3,000 Sabins of surface absorption, so
// omitting it doubles the predicted 8 kHz RT60.
//
// `airAbsorption` flag defaults to true. When a caller disables it here
// it must also disable it in `computeRoomConstant` to keep the two
// reverberant-field calculations consistent.
export function computeRT60Band({ room, materials, bandIndex, zones = [], treatments = [], furniture = [], furnitureCatalogue = null, racks = [], rackCatalogue = null, structures = [], airAbsorption = true }) {
  // Include zone + treatment absorption so stadium bowl carpet + court
  // wood + placed acoustic panels actually contribute. Without zones the
  // arena preset reports ~16 s RT60; without treatments the user can
  // place 50 absorbers and watch RT60 do nothing (v1 visual-only bug).
  const surfaces = roomEffectiveSurfaces(room, zones, treatments);
  // Seated-audience absorption replaces the seating material for the fraction
  // of seats occupied (ISO 3382-1). α_eff = α_material·(1−occ) + α_audience·occ.
  const audienceAlpha = materials.byId['audience-seated']?.absorption[bandIndex] ?? 0;
  let totalArea_m2 = 0;
  let surfaceAbsorption_sabins = 0;
  for (const s of surfaces) {
    // Treatment surfaces carry a `treatment:<productId>` materialId
    // that doesn't exist in materials.byId. The catalogue accessor
    // returns null when SurfaceLAB hasn't loaded yet — we treat that
    // as α=0 so a half-initialized engine never inflates RT60 by
    // pretending a panel that has no α is fully reflective.
    let baseAlpha;
    if (s._isTreatment) {
      baseAlpha = getTreatmentAbsorption(s.productId, bandIndex) ?? 0;
    } else {
      baseAlpha = materials.byId[s.materialId]?.absorption[bandIndex] ?? 0;
    }
    const occ = Math.max(0, Math.min(1, (s.occupancy_percent ?? 0) / 100));
    const alpha = occ > 0 ? baseAlpha * (1 - occ) + audienceAlpha * occ : baseAlpha;
    totalArea_m2 += s.area_m2;
    surfaceAbsorption_sabins += s.area_m2 * alpha;
  }
  const volume_m3 = roomVolume(room);
  const freq_hz = materials.frequency_bands_hz[bandIndex];
  const airAbsorption_sabins = airSabins(freq_hz, volume_m3, airAbsorption);
  // Furniture (FurnitureLAB placements) contributes equivalent
  // absorption area A_obj as a parallel term. Stays separate from
  // surfaceAbsorption_sabins so it does NOT inflate α̅; gets folded into
  // totalAbsorption_sabins for Sabine + into the Eyring denominator
  // outside the log (Kuttruff §5.3, Beranek §7.3). When the caller has
  // no FurnitureLAB catalogue yet (Node tests, Lab not visited), the
  // helper returns 0 and rt60 reverts to the original surface+air model.
  const furnitureAbsorption_sabins = sumFurnitureAbsorption(furniture, furnitureCatalogue, freq_hz);
  // DeviceLAB rack contribution (Dr. Chen slice 4, integrated slice 5).
  // sumRackAbsorption accepts the rack catalogue and a per-band α
  // lookup closure built from the same materials catalogue we already
  // have in scope. Material-swap on the front face per Dr. Chen
  // (perforated-panel-over-cavity Helmholtz behaviour empty vs lossy-
  // chassis-front loaded — different absorber topologies, blended
  // linearly by fillRatio). Sums into objectAbsorption alongside
  // furniture so RT60 / Eyring / Hopkins-Stryker R all pick it up.
  const rackMaterialAlphaAt = (id, _f) => materials.byId?.[id]?.absorption?.[bandIndex] ?? 0;
  const rackAbsorption_sabins = sumRackAbsorption(racks, rackCatalogue, rackMaterialAlphaAt, freq_hz);
  // Building structures (pillars/half-walls/partitions/beams/platforms)
  // contribute exposed-face absorption Σ(area × α) into the SAME parallel-A
  // channel — α resolves from the room's own materials catalogue (structures
  // use materials.json ids). A single column barely moves RT60; a colonnade or
  // a gypsum half-wall does (Dr. Chen). Folded into objectAbsorption so Sabine
  // + Eyring + the Hopkins-Stryker R all stay self-consistent (assertion #13:
  // the reverberant field must not refill a diffraction shadow).
  const structureMaterialAlphaAt = (id, bi) => materials.byId?.[id]?.absorption?.[bi] ?? 0;
  const structureAbsorption_sabins = sumStructureAbsorption(structures, room, structureMaterialAlphaAt, bandIndex);
  const objectAbsorption_sabins = furnitureAbsorption_sabins + rackAbsorption_sabins + structureAbsorption_sabins;
  const totalAbsorption_sabins = surfaceAbsorption_sabins + airAbsorption_sabins + objectAbsorption_sabins;
  // `meanAbsorption` stays surface-only — that's the α̅ a user expects to
  // see in UI (property of the walls, not a function of air or contents).
  // The air sink and object sink are exposed as separate fields and are
  // folded into `totalAbsorption_sabins` for Sabine / Hopkins-Stryker
  // calculations.
  const meanAbsorption = totalArea_m2 > 0 ? surfaceAbsorption_sabins / totalArea_m2 : 0;
  return {
    volume_m3,
    totalArea_m2,
    totalAbsorption_sabins,          // surface + 4mV + ΣA_obj — drives Sabine + R
    surfaceAbsorption_sabins,        // surface only
    airAbsorption_sabins,            // 4mV contribution
    objectAbsorption_sabins,         // ΣA_obj: furniture + racks + structures combined
    furnitureAbsorption_sabins,      // ΣA_obj from FurnitureLAB placements only
    rackAbsorption_sabins,           // ΣA_obj from DeviceLAB rack placements only
    structureAbsorption_sabins,      // ΣA_obj from building-structure placements only
    meanAbsorption,                  // α̅ surfaces only (unchanged from before)
    sabine_s: sabine({ volume_m3, totalAbsorption_sabins }),
    eyring_s: eyring({
      volume_m3, totalArea_m2,
      surfaceMeanAbsorption: meanAbsorption,
      airAbsSabins: airAbsorption_sabins,
      objectAbsSabins: objectAbsorption_sabins,
    }),
  };
}

// Per-band formula picker. Sabine over-reads by 25-35% once mean absorption
// exceeds α̅ = 0.2 (ISO 354 §B.2; Beranek 2nd ed §7.5; Hopkins 2007 §2.6.4).
// Below the threshold both formulae agree to <2%; above it Eyring is the
// physically-correct choice. Returns the appropriate value for the band.
export function preferredRT60(band) {
  if (!band) return null;
  if ((band.meanAbsorption ?? 0) > 0.2 && Number.isFinite(band.eyring_s)) {
    return band.eyring_s;
  }
  return band.sabine_s;
}

export function computeAllBands({ room, materials, zones = [], treatments = [], furniture = [], furnitureCatalogue = null, racks = [], rackCatalogue = null, structures = [], airAbsorption = true }) {
  return materials.frequency_bands_hz.map((frequency_hz, i) => ({
    frequency_hz,
    ...computeRT60Band({ room, materials, bandIndex: i, zones, treatments, furniture, furnitureCatalogue, racks, rackCatalogue, structures, airAbsorption }),
  }));
}
