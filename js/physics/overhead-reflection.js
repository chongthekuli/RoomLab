// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

// js/physics/overhead-reflection.js
//
// Phase 8 Step 1 (Dr. Chen audit 2026-05-24): overhead specular reflection
// for the analytical SPL pipeline. Previously the heatmap pipeline ignored
// roof / canopy / soffit polygons entirely; a listener under a covered
// arcade read the same value as a listener in open sky next to it because
// no analytical term picked up the first-order reflection off the roof.
//
// Mechanism — classic image source mirrored across an overhead plane (ISO
// 9613-2 §7.5 ground-reflection construction generalised to an overhead
// reflector). Reflected SPL at the listener = SPL of a virtual source
// reflected through the roof plane, attenuated by 10·log₁₀(1 − α_roof(f)).
// Reuses computeDirectSPL machinery so source directivity + air absorption
// + diffraction-edge bookkeeping are applied to the mirrored geometry the
// same way as the direct path.
//
// Scope:
//   - Extracts overhead reflectors from room.surauStructure (3 arcade
//     roofs + the portico flat roof on the surau preset).
//   - Indoor room ceiling (the main building ceiling) is NOT included
//     here — its contribution is already captured by the Sabine room
//     constant R in the existing reverb path; double-counting would
//     inflate interior cells by 3-6 dB.
//   - Step 1 covers FLAT horizontal reflectors only. Pyramidal /
//     vaulted overhead surfaces (e.g. the portico pyramid cap, dome
//     ceilings) get a Step-5-style edge-diffraction treatment later.
//
// Incoherent sum with direct + diffraction + re-radiation pressure² (≥
// 500 Hz; below ~250 Hz the partition between coherent and incoherent
// blurs but the level error is < 1 dB for the surau geometry — Cox &
// D'Antonio §3.6).

import { computeDirectSPL } from './spl-calculator.js';
import { extractOverheadReflectors, pointInPolygon2D } from './overhead-geometry.js';

// Re-export so existing callers / tests that import from this module
// continue to work after the geometry helper was split out.
export { extractOverheadReflectors };

// ---------------------------------------------------------------------------
// Material α at frequency. Reads the per-band α_third_oct or
// absorption_coeff array on the material; falls back to the engine's
// existing "what to do with a missing field" pattern (default 0.05 — a
// mid-gypsum value that won't silently make a missing material into a
// perfect reflector).
// ---------------------------------------------------------------------------

function getMaterialAbsorptionAt(materials, materialId, freq_hz) {
  const mat = materials?.byId?.[materialId];
  if (!mat) return 0.05;
  // Materials catalogue field is `absorption[7]` (one entry per band in
  // materials.frequency_bands_hz). Some legacy entries used
  // `absorption_coeff` either as a 7-band array or as a single scalar;
  // both fallbacks are retained so a future schema rename doesn't
  // silently zero the term.
  const bands = materials?.frequency_bands_hz;
  const bandArray = Array.isArray(mat.absorption) ? mat.absorption
                  : (Array.isArray(mat.absorption_coeff) ? mat.absorption_coeff : null);
  if (Array.isArray(bands) && bandArray) {
    // Find nearest band on a log axis.
    let bestIdx = 0, bestDelta = Infinity;
    for (let i = 0; i < bands.length; i++) {
      const d = Math.abs(Math.log2(bands[i] / freq_hz));
      if (d < bestDelta) { bestDelta = d; bestIdx = i; }
    }
    const a = bandArray[bestIdx];
    if (Number.isFinite(a) && a >= 0 && a <= 1) return a;
  }
  if (Number.isFinite(mat.absorption_coeff)) return mat.absorption_coeff;
  return 0.05;
}

// ---------------------------------------------------------------------------
// Per-source reflection pressure² contribution. Returns the linear pressure²
// to be added to the incoherent direct + diffraction + re-radiation sum.
//
// Geometry:
//   - Skip when listener.z >= roof.z_top (listener is at or above the roof
//     — no reflection back down at them).
//   - Skip when source.z >= roof.z_top (source is at or above the roof —
//     the source-to-listener line goes UNDER the reflector; image-source
//     reflection is not the right mechanism here, see TODO Step 5 for
//     a Maekawa-edge treatment of canopy edges).
//   - Mirror the LISTENER (not the source) across the roof plane. The
//     direct-path SPL from src → mirroredListener equals the reflected-
//     path level at the actual listener, by image-source symmetry.
//   - The mirror-segment must intersect the roof polygon at z = z_top;
//     otherwise the reflection misses the reflector and contributes
//     nothing.
//
// Returns 0 (linear pressure²) when no reflectors contribute, so the
// caller can incoherent-sum without branching.
// ---------------------------------------------------------------------------

export function computeOverheadReflectionPower({
  src, speakerDef, listenerPos, freq_hz, room, materials,
  airAbsorption, airAbsorptionFn, eqGainDb = 0, reflectors = null,
}) {
  const polys = reflectors || extractOverheadReflectors(room);
  if (polys.length === 0) return 0;
  let pressureSum = 0;

  for (const poly of polys) {
    const zTop = poly.z_top;
    if (!Number.isFinite(zTop)) continue;
    // Both source and listener must be BELOW the reflector for image-source
    // reflection. Skip otherwise.
    if (listenerPos.z >= zTop - 1e-3) continue;
    if (src.position.z >= zTop - 1e-3) continue;
    // Mirror the listener across z = zTop. The path src → mirroredListener
    // is geometrically identical to src → roof → listener (the two have
    // equal length and the source aim toward the mirror sees the same
    // off-axis angle that the actual reflection requires).
    const mirroredListener = {
      x: listenerPos.x,
      y: listenerPos.y,
      z: 2 * zTop - listenerPos.z,
    };
    // Hit point on the roof plane — parameterize the segment src → mirroredL
    // and solve for z = zTop. Both src.z and listenerPos.z are < zTop, so
    // by construction t ∈ (0, 1).
    const dz = mirroredListener.z - src.position.z;   // > 0 because mirrored is above
    if (Math.abs(dz) < 1e-9) continue;
    const t = (zTop - src.position.z) / dz;
    if (t <= 0 || t >= 1) continue;
    const hitX = src.position.x + t * (mirroredListener.x - src.position.x);
    const hitY = src.position.y + t * (mirroredListener.y - src.position.y);
    if (!pointInPolygon2D(hitX, hitY, poly.vertices)) continue;

    // SPL via the mirror path. Reuses computeDirectSPL so directivity,
    // air absorption, and wall-crossing TL all apply on the geometric
    // mirror — same physics, same code path.
    //
    // CRITICAL: bypass overhead-reflector TLs on the reflection path.
    // The reflection BOUNCES off the roof; it does NOT transmit through
    // it. wall-path.js now treats arcade/portico roofs as horizontal
    // transmissive planes (for the source-above-roof case), so calling
    // computeDirectSPL with the room as-is would erroneously apply the
    // roof's TL on the bounce path. Strip arcade + portico from a temp
    // room snapshot so wallsCrossedByPath returns no roof crossings on
    // THIS call. Other surauStructure features (entrances, podium,
    // south_partition) keep working — only the overhead surfaces are
    // suppressed.
    const roomNoOverhead = (room.surauStructure?.arcade || room.surauStructure?.portico)
      ? {
          ...room,
          surauStructure: {
            ...room.surauStructure,
            arcade: undefined,
            portico: undefined,
          },
        }
      : room;
    const d = computeDirectSPL({
      speakerDef, speakerState: src, listenerPos: mirroredListener,
      freq_hz, room: roomNoOverhead, materials, airAbsorption, eqGainDb,
      outdoorObstacles: null, airAbsorptionFn,
    });
    const spl_via_mirror = d.spl_db;
    if (!Number.isFinite(spl_via_mirror)) continue;

    // Reflection loss = -10·log₁₀(1 − α). α floored at 0, α clamped to
    // 0.99 to avoid log10(0) singularity (totally-absorptive limit gives
    // -20 dB, still finite — physically there's always SOME reflection
    // from finite-impedance surfaces).
    const alpha = Math.max(0, Math.min(0.99, getMaterialAbsorptionAt(materials, poly.materialId, freq_hz)));
    const reflLoss_db = 10 * Math.log10(1 - alpha);    // ≤ 0
    const spl_reflected = spl_via_mirror + reflLoss_db;
    pressureSum += Math.pow(10, spl_reflected / 10);
  }
  return pressureSum;
}
