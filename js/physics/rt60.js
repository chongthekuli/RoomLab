import { roomSurfaces, roomEffectiveSurfaces, roomVolume } from './room-shape.js';

const SABINE_CONSTANT = 0.161;

export function sabine({ volume_m3, totalAbsorption_sabins }) {
  if (totalAbsorption_sabins <= 0) return Infinity;
  return SABINE_CONSTANT * volume_m3 / totalAbsorption_sabins;
}

export function eyring({ volume_m3, totalArea_m2, meanAbsorption }) {
  if (meanAbsorption <= 0) return Infinity;
  if (meanAbsorption >= 1) return 0;
  return SABINE_CONSTANT * volume_m3 / (-totalArea_m2 * Math.log(1 - meanAbsorption));
}

export function computeRT60Band({ room, materials, bandIndex, zones = [] }) {
  // Include zone absorption so stadium bowl carpet + court wood actually
  // contribute. Without this the arena preset reports ~16 s RT60.
  const surfaces = roomEffectiveSurfaces(room, zones);
  // Seated-audience absorption replaces the seating material for the fraction
  // of seats occupied (ISO 3382-1). α_eff = α_material·(1−occ) + α_audience·occ.
  const audienceAlpha = materials.byId['audience-seated']?.absorption[bandIndex] ?? 0;
  let totalArea_m2 = 0;
  let totalAbsorption_sabins = 0;
  for (const s of surfaces) {
    const baseAlpha = materials.byId[s.materialId]?.absorption[bandIndex] ?? 0;
    const occ = Math.max(0, Math.min(1, (s.occupancy_percent ?? 0) / 100));
    const alpha = occ > 0 ? baseAlpha * (1 - occ) + audienceAlpha * occ : baseAlpha;
    totalArea_m2 += s.area_m2;
    totalAbsorption_sabins += s.area_m2 * alpha;
  }
  const volume_m3 = roomVolume(room);
  const meanAbsorption = totalArea_m2 > 0 ? totalAbsorption_sabins / totalArea_m2 : 0;
  return {
    volume_m3,
    totalArea_m2,
    totalAbsorption_sabins,
    meanAbsorption,
    sabine_s: sabine({ volume_m3, totalAbsorption_sabins }),
    eyring_s: eyring({ volume_m3, totalArea_m2, meanAbsorption }),
  };
}

export function computeAllBands({ room, materials, zones = [] }) {
  return materials.frequency_bands_hz.map((frequency_hz, i) => ({
    frequency_hz,
    ...computeRT60Band({ room, materials, bandIndex: i, zones }),
  }));
}
