import { roomSurfaces, roomEffectiveSurfaces, roomVolume } from './room-shape.js';
import { airSabins } from './air-absorption.js';

const SABINE_CONSTANT = 0.161;

export function sabine({ volume_m3, totalAbsorption_sabins }) {
  if (totalAbsorption_sabins <= 0) return Infinity;
  return SABINE_CONSTANT * volume_m3 / totalAbsorption_sabins;
}

// Eyring with optional additive air-absorption term.
//   Classical: T = 0.161·V / (−S·ln(1−α̅))
//   With air:  T = 0.161·V / (−S·ln(1−α̅_surface) + 4mV)
// Air absorption enters linearly as in Sabine — Kuttruff §5.3 keeps the
// logarithm on SURFACE absorption only because air decay is inherently
// exponential-in-time regardless of reflection count.
export function eyring({ volume_m3, totalArea_m2, surfaceMeanAbsorption, airAbsSabins = 0 }) {
  const denom = (-totalArea_m2 * Math.log(Math.max(1e-9, 1 - surfaceMeanAbsorption))) + airAbsSabins;
  if (denom <= 0) return Infinity;
  if (surfaceMeanAbsorption >= 1 && airAbsSabins <= 0) return 0;
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
export function computeRT60Band({ room, materials, bandIndex, zones = [], airAbsorption = true }) {
  // Include zone absorption so stadium bowl carpet + court wood actually
  // contribute. Without this the arena preset reports ~16 s RT60.
  const surfaces = roomEffectiveSurfaces(room, zones);
  // Seated-audience absorption replaces the seating material for the fraction
  // of seats occupied (ISO 3382-1). α_eff = α_material·(1−occ) + α_audience·occ.
  const audienceAlpha = materials.byId['audience-seated']?.absorption[bandIndex] ?? 0;
  let totalArea_m2 = 0;
  let surfaceAbsorption_sabins = 0;
  for (const s of surfaces) {
    const baseAlpha = materials.byId[s.materialId]?.absorption[bandIndex] ?? 0;
    const occ = Math.max(0, Math.min(1, (s.occupancy_percent ?? 0) / 100));
    const alpha = occ > 0 ? baseAlpha * (1 - occ) + audienceAlpha * occ : baseAlpha;
    totalArea_m2 += s.area_m2;
    surfaceAbsorption_sabins += s.area_m2 * alpha;
  }
  const volume_m3 = roomVolume(room);
  const freq_hz = materials.frequency_bands_hz[bandIndex];
  const airAbsorption_sabins = airSabins(freq_hz, volume_m3, airAbsorption);
  const totalAbsorption_sabins = surfaceAbsorption_sabins + airAbsorption_sabins;
  // `meanAbsorption` stays surface-only — that's the α̅ a user expects to
  // see in UI (property of the walls, not a function of air). The air
  // sink is exposed as a separate `airAbsorption_sabins` field and is
  // folded into `totalAbsorption_sabins` for Sabine / Hopkins-Stryker
  // calculations.
  const meanAbsorption = totalArea_m2 > 0 ? surfaceAbsorption_sabins / totalArea_m2 : 0;
  return {
    volume_m3,
    totalArea_m2,
    totalAbsorption_sabins,          // surface + 4mV — drives Sabine + R
    surfaceAbsorption_sabins,        // surface only
    airAbsorption_sabins,            // 4mV contribution
    meanAbsorption,                  // α̅ surfaces only (unchanged from before)
    sabine_s: sabine({ volume_m3, totalAbsorption_sabins }),
    eyring_s: eyring({
      volume_m3, totalArea_m2,
      surfaceMeanAbsorption: meanAbsorption,
      airAbsSabins: airAbsorption_sabins,
    }),
  };
}

export function computeAllBands({ room, materials, zones = [], airAbsorption = true }) {
  return materials.frequency_bands_hz.map((frequency_hz, i) => ({
    frequency_hz,
    ...computeRT60Band({ room, materials, bandIndex: i, zones, airAbsorption }),
  }));
}
