// js/physics/reradiation.js
//
// Kuttruff wall re-radiation. The reverberant sound field inside a
// room excites every interior wall surface as a piston. Each wall
// then radiates into the outside hemisphere as a planar secondary
// source. Without this term, a listener standing 0.5 m behind a wall
// in the dead-acoustic shadow of every direct ray would read SPL
// dominated by the (heavily attenuated) through-wall transmission
// only — which underestimates the real outside SPL by 10–20 dB in
// most rooms.
//
// References:
//   * Kuttruff, Room Acoustics 5th ed. §5.4 (sound transmission +
//     re-radiation), eq. 5.42–5.43.
//   * ISO 9613-2:1996 §7 (outdoor sound propagation from a building).
//   * ISO 12354-1 §B.2 (incident-vs-diffuse intensity conversion).
//
// Formula (Dr. Chen, Tier 1a spec):
//
//   L_w_wall_radiated[band] = L_p_rev_inside[band] − 6 − TL[band] + 10·log10(S_wall)
//
//   conservation clamp:
//     L_w_wall_radiated ≤ L_p_rev_inside − 6 + 10·log10(S_wall · (1 − α[band]))
//     (radiated power can't exceed incident-minus-absorbed)
//
//   listener SPL contribution at distance r_perp from the closest
//   point on the wall surface:
//     r_t      = √(S_wall / π)                          disk-equivalent radius
//     L_p_near = L_w − 10·log10(S_wall) − 3             planar near-field, flat
//     L_p_far  = L_w − 20·log10(r_perp) − 8             point-source far-field, hemisphere
//   smoothstep blend over [r_t/2, 2·r_t] so the heatmap doesn't show
//   a visible discontinuity line at the transition radius.
//
// The −6 dB (vs the alternative −3 dB) is Kuttruff's diffuse-energy-
// density to incident-intensity conversion (eq. 3.20). Matches the
// 4/R convention the engine uses everywhere else for Hopkins-Stryker.
//
// Simplifications logged with the regression-curator (Theo):
//   P8  — single-bounce re-radiation only; the radiated wall power is
//         NOT re-injected into the receiver-side environment as a
//         secondary source for further reverb. Outside is treated as
//         semi-free-field.
//   P10 — radiation efficiency σ = 1 across all bands. TL already
//         encodes coincidence-dip behaviour; no separate σ multiplier.
//
// Per-band always: this module computes contributions at the band
// passed in. Caller iterates bands for STIPA / breakdown UI; for the
// single-frequency heatmap, caller calls once at state.physics.freq_hz.

import { airAbsorptionDbPerM } from './air-absorption.js';
import { PHYSICS_P1_5_ENABLED } from './feature-flags.js';
import { resolveWallGeometry } from './diffraction.js';

// C¹-continuous smoothstep (Hermite). Used for the near/far blend so
// the transition between planar and point-source regimes doesn't
// render as a visible kink in the heatmap.
function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge0 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Wall area = length × height. For non-rectangular polygons we treat
// each edge as a rectangle of (edge_length × wall_height) which is
// physically correct — each polygon edge is a planar wall facet.
function wallArea(wall) {
  if (!wall) return 0;
  const len = Math.hypot(wall.v2.x - wall.v1.x, wall.v2.y - wall.v1.y);
  return len * (wall.height_m ?? 0);
}

// Closest point on the finite rectangular wall (in 3D) to the listener.
// Projects listener onto the wall's local (along-wall, vertical) frame,
// clamps to [0, wallLen] × [elev, elev+height], reconstructs world XYZ.
function closestPointOnFiniteWall(listener, wall) {
  const dx = wall.v2.x - wall.v1.x, dy = wall.v2.y - wall.v1.y;
  const wallLen = Math.hypot(dx, dy);
  if (wallLen < 1e-9) return { x: wall.v1.x, y: wall.v1.y, z: wall.elev_m };
  const ux = dx / wallLen, uy = dy / wallLen;
  // Along-wall coordinate of listener (projection onto wall axis).
  const along = (listener.x - wall.v1.x) * ux + (listener.y - wall.v1.y) * uy;
  const alongClamped = Math.max(0, Math.min(wallLen, along));
  // Vertical clamp.
  const z0 = wall.elev_m ?? 0;
  const z1 = z0 + (wall.height_m ?? 0);
  const zClamped = Math.max(z0, Math.min(z1, listener.z));
  return {
    x: wall.v1.x + alongClamped * ux,
    y: wall.v1.y + alongClamped * uy,
    z: zClamped,
  };
}

// Per-wall, per-band re-radiation SPL contribution at the listener.
// Returns { spl_db, regime, r_m, clampedByConservation }.
export function wallReradiationContribution({
  wall, listener, L_p_rev_inside_db, TL_band_db, alpha_band,
  freq_hz, airAbsorption = true,
}) {
  const S = wallArea(wall);
  if (S <= 0) return { spl_db: -Infinity, regime: 'none', r_m: Infinity, clampedByConservation: false };
  if (!Number.isFinite(L_p_rev_inside_db) || !Number.isFinite(TL_band_db)) {
    return { spl_db: -Infinity, regime: 'none', r_m: Infinity, clampedByConservation: false };
  }

  // Sound power radiated outside. Two formulas; take the smaller for
  // energy conservation (can't radiate more than incident-minus-absorbed).
  const a = Number.isFinite(alpha_band) ? Math.max(0, Math.min(1, alpha_band)) : 0.05;
  const Lw_raw = L_p_rev_inside_db - 6 - TL_band_db + 10 * Math.log10(S);
  // Avoid log(0) when α = 1.
  const remaining = S * Math.max(1e-9, 1 - a);
  const Lw_cap = L_p_rev_inside_db - 6 + 10 * Math.log10(remaining);
  const clamped = Lw_raw > Lw_cap;
  const Lw = clamped ? Lw_cap : Lw_raw;

  // Listener distance from the wall surface.
  const cp = closestPointOnFiniteWall(listener, wall);
  const r = Math.max(0.1, Math.hypot(listener.x - cp.x, listener.y - cp.y, listener.z - cp.z));

  // Near / far / blend regime.
  const r_t = Math.sqrt(S / Math.PI);
  const Lp_near = Lw - 10 * Math.log10(S) - 3;
  const Lp_far  = Lw - 20 * Math.log10(r) - 8;
  const w = smoothstep(r_t / 2, 2 * r_t, r);
  let Lp = (1 - w) * Lp_near + w * Lp_far;

  // Air absorption on the rerad path (wall → listener).
  if (airAbsorption) {
    Lp -= airAbsorptionDbPerM(freq_hz) * r;
  }

  let regime;
  if (w <= 0)      regime = 'near';
  else if (w >= 1) regime = 'far';
  else             regime = 'blend';

  return { spl_db: Lp, regime, r_m: r, clampedByConservation: clamped };
}

// Compute total re-radiation power contribution at the listener
// across every solid wall the direct path crosses. Returns
// { perWall: [...], totalPower }. Caller energy-sums with direct +
// diffraction + reverb contributions.
//
// `L_p_rev_inside_band_db` is a room-wide scalar at this band — caller
// pre-computes once per frame via the SPL context.
export function computeReradiationContributions({
  src, listener, room, wallsCrossed, materials, freq_hz,
  L_p_rev_inside_band_db,
  airAbsorption = true,
}) {
  if (!PHYSICS_P1_5_ENABLED) return { perWall: [], totalPower: 0 };
  if (!Array.isArray(wallsCrossed) || wallsCrossed.length === 0) {
    return { perWall: [], totalPower: 0 };
  }
  if (!Number.isFinite(L_p_rev_inside_band_db)) return { perWall: [], totalPower: 0 };
  const solid = wallsCrossed.filter(w => !w.throughOpening);
  if (solid.length === 0) return { perWall: [], totalPower: 0 };
  const bandIdx = materials?.frequency_bands_hz?.indexOf?.(freq_hz);
  if (bandIdx == null || bandIdx < 0) return { perWall: [], totalPower: 0 };

  let totalPower = 0;
  const perWall = [];
  for (const crossing of solid) {
    const wall = resolveWallGeometry(room, crossing.wallId);
    if (!wall) continue;
    const mat = materials?.byId?.[crossing.materialId];
    const TL_band_db = Array.isArray(mat?.transmission_loss_db)
      ? mat.transmission_loss_db[bandIdx]
      : 20;
    const alpha_band = Array.isArray(mat?.absorption)
      ? mat.absorption[bandIdx]
      : 0.05;
    const res = wallReradiationContribution({
      wall, listener, L_p_rev_inside_db: L_p_rev_inside_band_db,
      TL_band_db, alpha_band, freq_hz, airAbsorption,
    });
    if (!Number.isFinite(res.spl_db)) continue;
    totalPower += Math.pow(10, res.spl_db / 10);
    perWall.push({
      wallId: crossing.wallId,
      materialId: crossing.materialId,
      ...res,
    });
  }
  return { perWall, totalPower };
}

// Compute the room-wide reverberant SPL per octave band from the
// pre-resolved source context. Result is listener-independent; caller
// computes once per frame and passes into computeReradiationContributions
// for every receiver vertex. Returns Float64Array indexed by band.
//
//   L_p_rev_inside[k] = 10·log10( Σ_source 10^((L_w_source[k] + 10·log10(4/R[k])) / 10) )
//
// Sources outside the room (e.g. arcade speakers on the podium) are
// excluded — they don't contribute to the *interior* reverberant
// field that drives wall re-radiation.
export function computeReverberantInsideSPL({
  sourceLwPerBand,         // [{src, Lw_per_band: Float64Array(7)}]
  roomR_per_band,          // number[7]
  isSourceInside,          // (src) => boolean (excludes outdoor sources)
}) {
  const bands = roomR_per_band?.length ?? 7;
  const out = new Float64Array(bands);
  for (let k = 0; k < bands; k++) {
    const R = roomR_per_band[k];
    if (!Number.isFinite(R) || R <= 0) { out[k] = -Infinity; continue; }
    const revGain_db = 10 * Math.log10(4 / R);
    let powerSum = 0;
    for (const s of sourceLwPerBand) {
      if (isSourceInside && !isSourceInside(s.src)) continue;
      const Lw = s.Lw_per_band[k];
      if (!Number.isFinite(Lw)) continue;
      powerSum += Math.pow(10, (Lw + revGain_db) / 10);
    }
    out[k] = powerSum > 0 ? 10 * Math.log10(powerSum) : -Infinity;
  }
  return out;
}

// Test-only export so the conservation test can call the per-wall
// helper without exercising the full caller chain.
export const _testing = { wallArea, closestPointOnFiniteWall, smoothstep };
