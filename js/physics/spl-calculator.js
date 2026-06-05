// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Copyright (c) 2026 Amperes Electronics SDN BHD. All rights reserved.
// Part of nymphysics — licensed under PolyForm Shield 1.0.0 (see
// js/physics/LICENSE): read / study / adapt for any NON-competing use; you
// may NOT use it to provide a product that competes with AuraLAB.

import { interpolateAttenuation } from './loudspeaker.js';
import { isInsideRoom3D, wallPerimeter, baseArea, ceilingArea, roomEffectiveBounds, roomSurfaces, maxCeilingHeightAt } from './room-shape.js';
import { computeRT60Band } from './rt60.js';
import {
  AIR_ABSORPTION_DB_PER_M as AIR_ABS_TABLE,
  airAbsorptionDbPerM, airSabins, airAbsorptionDbPerM_param,
} from './air-absorption.js';
import {
  wallsCrossedByPath, transmissionLossDb, bandIndexForFreq,
} from './wall-path.js';
import { computeDiffractionContributions } from './diffraction.js';
import {
  computeReradiationContributions, computeReverberantInsideSPL,
} from './reradiation.js';
import {
  extractOutdoorObstacles, outdoorObstacleLossDb,
} from './outdoor-obstacles.js';
import { PHYSICS_P1_5_ENABLED, isTier1aOutdoorOverrideDisabled } from './feature-flags.js';
import { wallInsetPolygon } from './wall-inset.js';
import { extractOverheadReflectors, computeOverheadReflectionPower } from './overhead-reflection.js';
import { extractPorches, computePorchReverbPower } from './porch-enclosure.js';
import { classifySource, listWallFacets } from './source-classification.js';
import { furnitureDirectPathLossDb } from './furniture-direct-blocking.js';
import { rackDirectPathLossDb } from './rack-direct-blocking.js';
import { structureDirectPathLossDb } from './building-structures.js';
import {
  computeCouplingForAllBands,
  COUPLING_BANDS_HZ,
  NUM_BANDS as COUPLING_NUM_BANDS,
} from './exterior-coupling.js';

// Per-call helper: classify every source in `sources`, lazily compute the
// per-band coupling coefficient for EXTERIOR ones, and derive the
// `isSourceInside` predicate downstream callers (computeReverberantInsideSPL,
// the reverb-leak hot loop) consume.
//
// Phase 3 wiring (Hannes plan 2026-05-25, Dr. Chen math):
//   • INTERIOR / FLUSH_INWARD → predicate returns TRUE; no coupling
//     adjustment applied to the Hopkins-Stryker 4/R leak. FLUSH_INWARD's
//     boundary-loading boost is a v2 item.
//   • EXTERIOR → predicate returns FALSE (source excluded from the
//     per-band INSIDE aggregate that drives wall re-radiation), AND a
//     Float32Array(COUPLING_NUM_BANDS) of C_couple is built so the
//     reverb-leak loop can subtract |C_couple| from L_w before
//     energy-summing the source's contribution to the per-listener
//     diffuse-field lift.
//
// Returns null when room is missing — caller falls back to historical
// "all sources are interior" behaviour (back-compat for tests / scripts
// that pass no room). Cache scope is PER-CALL — no module-level memo
// (Hannes brief §5: "no memoization at module level").
function _buildSourceClassifications(sources, room, materials) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  if (!room) return null;
  const classifications = sources.map(src => classifySource(src, room));
  // Lazy: only build coupling arrays for EXTERIOR sources, and only when
  // materials are in scope (no τ → no coupling math).
  let facets = null;
  const couplings = new Map();
  if (materials) {
    for (let i = 0; i < sources.length; i++) {
      if (classifications[i].kind !== 'EXTERIOR') continue;
      if (!facets) facets = listWallFacets(room);
      if (facets.length === 0) break;
      couplings.set(sources[i], computeCouplingForAllBands(sources[i], facets, materials));
    }
  }
  const isSourceInside = (src) => {
    const idx = sources.indexOf(src);
    if (idx < 0) return true;  // unknown src → default interior (back-compat)
    return classifications[idx].kind !== 'EXTERIOR';
  };
  return { classifications, couplings, isSourceInside };
}

// Re-exports for backward compatibility with existing callers (tests, scene.js).
export const AIR_ABSORPTION_DB_PER_M = AIR_ABS_TABLE;
export function airAbsorptionAt(freq_hz) { return airAbsorptionDbPerM(freq_hz); }

// Legacy flat transmission loss. Retained ONLY for the back-compat path
// when a caller passes `room` but not `materials` (older tests, scripts).
// Real callers now thread `materials` through and get material-aware,
// per-band, opening-aware TL via wall-path.js. See computeDirectSPL.
export const WALL_TRANSMISSION_LOSS_DB = 30;

// Per-band material-aware transmission loss for a single direct path.
// Falls back to the legacy flat WALL_TRANSMISSION_LOSS_DB when no
// materials catalogue is in scope, so unit tests without a loaded
// catalogue still see the old behaviour.
function pathWallLossDb(src, listener, room, materials, freq_hz) {
  if (!room) return { tl_db: 0, wallsCrossed: [] };
  const wallsCrossed = wallsCrossedByPath(src, listener, room);
  if (wallsCrossed.length === 0) return { tl_db: 0, wallsCrossed };
  if (!materials) {
    // Legacy back-compat: any wall crossed (regardless of opening
    // status, regardless of material) → flat 30 dB. Matches the
    // pre-1.4 isInsideRoom3D membership-flip behaviour for callers
    // that haven't yet been updated to thread the catalogue.
    return { tl_db: WALL_TRANSMISSION_LOSS_DB, wallsCrossed };
  }
  const bandIdx = bandIndexForFreq(materials, freq_hz);
  const tl_db = transmissionLossDb(wallsCrossed, materials, bandIdx);
  return { tl_db, wallsCrossed };
}

// Defensive cap: a real driver cannot accept more than its rated input
// power without burning out. The Sources panel clamps user input to the
// model's max_input_watts, but legacy saved projects (created before
// that UI clamp shipped) may still carry over-rated values. This helper
// is the engine-side floor — every physics reader of `power_watts`
// goes through it so no over-rated value can leak into the SPL math.
export function effectivePowerWatts(speakerDef, watts) {
  const w = Math.max(1e-6, watts ?? 1);
  const cap = speakerDef?.electrical?.max_input_watts;
  if (Number.isFinite(cap) && cap > 0) return Math.min(w, cap);
  return w;
}

// Speed of sound in dry air as a function of temperature (°C). Default
// 20 °C → 343.2 m/s. Over 30 m at 4 kHz a ±2 °C swing shifts phase by ~1.5
// wavelengths, so we wire this to a configurable constant for coherent
// summation accuracy.
export const DEFAULT_TEMPERATURE_C = 20;
export function speedOfSound(T_C = DEFAULT_TEMPERATURE_C) {
  return 331.3 * Math.sqrt(1 + T_C / 273.15);
}

// Octave-band PARTIAL-coherence power of a set of direct contributions
// {A (pressure amplitude), r (path length)} at one receiver.
//
// A naive all-coherent phasor sum |Σ Aᵢ·e^{jφᵢ}|² produces physically
// unrealistic interference fringes above ~500 Hz for spatially separated
// sources — real broadband program material decorrelates once the inter-path
// time difference Δr/c exceeds the band's coherence time. A blanket "incoherent
// above 500 Hz" cutoff is wrong the other way: co-located sources (Δr=0) stay
// coherent at ALL frequencies and must still gain +6 dB.
//
// Model the per-pair magnitude coherence as the normalized cross-correlation
// envelope of two octave-band-limited signals delayed by Δr/c:
//     γ(Δr) = |sinc(π·B·Δr/c)|,  octave bandwidth B ≈ 0.707·f
//           = |sinc(0.707·π·Δr/λ)|              (sinc x = sin x / x)
// γ=1 at Δr=0 (full coherent gain) and decays/oscillates toward 0 as Δr grows
// past ~λ, so widely-spaced HF sources sum incoherently. Power:
//     P = Σ Aᵢ²  +  Σ_{i<j} 2·γᵢⱼ·Aᵢ·Aⱼ·cos(Δφᵢⱼ),  Δφ = 2π·Δr/λ
// Reduces to the incoherent pressure² sum when every γ→0 and to |Σ A|² when
// every γ→1 (co-located). Clamped to ≥ 0 (damped cross-terms can't make
// physical power negative). See feedback_line_array_physics.
function partialCoherentPower(srcs, angFreq, c, lambda) {
  let p = 0;
  for (let i = 0; i < srcs.length; i++) p += srcs[i].A * srcs[i].A;
  if (!(lambda > 0) || !(c > 0)) {
    // No wavelength (degenerate) → fall back to full in-phase coherent sum.
    let sumA = 0;
    for (const s of srcs) sumA += s.A;
    return sumA * sumA;
  }
  for (let i = 0; i < srcs.length; i++) {
    for (let j = i + 1; j < srcs.length; j++) {
      const dr = Math.abs(srcs[i].r - srcs[j].r);
      const x = 0.7071 * Math.PI * dr / lambda;
      const gamma = x < 1e-9 ? 1 : Math.abs(Math.sin(x) / x);
      const dphi = angFreq * dr / c;
      p += 2 * gamma * srcs[i].A * srcs[j].A * Math.cos(dphi);
    }
  }
  return Math.max(0, p);
}

// Hopkins-Stryker room constant at the given octave band.
//
// Basic form:  R = S · α̅ / (1 − α̅)
// Extended (Kuttruff §5 with air absorption):
//    R = (S·α̅ + 4mV) / (1 − α̅_eff)     where α̅_eff = (S·α̅ + 4mV) / S
//    = A_total / (1 − A_total/S)
//
// The 4mV air-sink is the same term that goes into Sabine T60 = 0.161·V/
// (S·α̅ + 4mV). Ignoring it overstates the reverberant level at HF in
// large rooms — at 8 kHz in a 48k-m³ arena, 4mV is ~140 % of the
// surface-absorption total, so omitting it leaves R ~3 × too small and
// the reverberant level ~4–5 dB too loud.
//
// `airAbsorption` defaults to `true` and must only be set false by a
// deliberate caller (physics-toggle UI) that also disabled 4mV in RT60.
export function computeRoomConstant(room, materials, freq_hz, zones = [], { airAbsorption = true, treatments = [], furniture = [], furnitureCatalogue = null, racks = [], rackCatalogue = null, structures = [] } = {}) {
  if (!materials?.frequency_bands_hz) return 0;
  // Phase A2: was indexOf-exact-match; now snaps to nearest band. In
  // practice the UI emits exact band centres from the picker, so this is
  // a no-op for production calls; synthetic / test frequencies between
  // centres now resolve to the nearest band instead of silently
  // returning 0 (no reverb at all).
  const bandIdx = bandIndexForFreq(materials, freq_hz);
  const rt = computeRT60Band({ room, materials, bandIndex: bandIdx, zones, treatments, furniture, furnitureCatalogue, racks, rackCatalogue, structures, airAbsorption });
  const S = rt.totalArea_m2;
  if (S <= 0) return 0;
  // rt.totalAbsorption_sabins already includes 4mV when airAbsorption is
  // true (see rt60.js). Use the effective α_bar for the Hopkins-Stryker
  // form.
  const A_total = rt.totalAbsorption_sabins;
  const alpha_eff = A_total / S;
  if (alpha_eff >= 0.995) return 1e9;
  return A_total / (1 - alpha_eff);
}

// Retained for back-compat — `through_wall: boolean` is still exposed on
// computeDirectSPL's return value for the breakdown UI / print report.
// New code should consume `wallsCrossed` (full per-wall details with
// material id + opening flag) from the same return shape.
function pathCrossesBoundary(speakerState, listenerPos, room) {
  if (!room) return false;
  const sIn = isInsideRoom3D(speakerState.position, room);
  const lIn = isInsideRoom3D(listenerPos, room);
  return sIn !== lIn;
}

// Transform a listener's world position into the speaker's body frame and
// extract (azimuth, elevation) for directivity lookup.
//
// Body frame convention:
//   +Y = aim direction (forward)
//   +X = speaker's right
//   +Z = speaker's up
//
// Body-to-world composition (intrinsic rotations applied right-to-left):
//   R_bw = R_yaw · R_pitch · R_roll
// where
//   R_yaw rotates around world Z   (yaw=+90° rotates aim from +Y to +X, i.e. CW viewed from +Z)
//   R_pitch rotates around body X  (pitch=+90° rotates aim from +Y to +Z, i.e. up)
//   R_roll rotates around body Y   (roll=+90° rotates body +X toward world -Z)
//
// World-to-body applies the inverses in reverse order:
//   body = R_roll(-roll) · R_pitch(-pitch) · R_yaw(-yaw) · (listener - speaker)
//
// Because the original yaw convention is CW (standard math R_z(-yaw)), the
// "inverse yaw" step is a standard R_z(+yaw) rotation.
//
// This proper 3D rotation replaces the earlier 2D approximation that computed
// azimuth from horizontal projection only and then subtracted pitch from the
// global elevation. That approximation was correct only when the listener was
// directly forward (azimuth=0); at wide azimuths it distorted the directivity
// lookup because it never accounted for the pitch axis rotating around the
// yawed body-X axis.
export function localAngles(speakerPos, speakerAimDeg, listenerPos) {
  const dx = listenerPos.x - speakerPos.x;
  const dy = listenerPos.y - speakerPos.y;
  const dz = listenerPos.z - speakerPos.z;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (r < 1e-6) return { r: 1e-6, azimuth_deg: 0, elevation_deg: 0 };

  const yaw_rad = speakerAimDeg.yaw * Math.PI / 180;
  const pitch_rad = speakerAimDeg.pitch * Math.PI / 180;
  const roll_rad = (speakerAimDeg.roll || 0) * Math.PI / 180;

  // Step 1 — inverse yaw (standard R_z(+yaw) applied to world delta).
  const cy_ = Math.cos(yaw_rad);
  const sy_ = Math.sin(yaw_rad);
  const x1 = dx * cy_ - dy * sy_;
  const y1 = dx * sy_ + dy * cy_;
  const z1 = dz;

  // Step 2 — inverse pitch (standard R_x(-pitch) around the body X axis).
  const cp = Math.cos(pitch_rad);
  const sp = Math.sin(pitch_rad);
  const x2 = x1;
  const y2 = y1 * cp + z1 * sp;
  const z2 = -y1 * sp + z1 * cp;

  // Step 3 — inverse roll (standard R_y(-roll) around the body Y axis).
  const cr = Math.cos(roll_rad);
  const sr = Math.sin(roll_rad);
  const lx = cr * x2 - sr * z2;
  const ly = y2;
  const lz = sr * x2 + cr * z2;

  // Body frame: aim = +Y. Positive azimuth is toward speaker's right (+X).
  // Positive elevation is toward speaker's up (+Z).
  const azimuth_rad = Math.atan2(lx, ly);
  const horizLocal = Math.sqrt(lx * lx + ly * ly);
  const elevation_rad = Math.atan2(lz, horizLocal);

  return {
    r,
    azimuth_deg: azimuth_rad * 180 / Math.PI,
    elevation_deg: elevation_rad * 180 / Math.PI,
  };
}

export function computeDirectSPL({ speakerDef, speakerState, listenerPos, freq_hz = 1000, room = null, materials = null, airAbsorption = true, eqGainDb = 0, outdoorObstacles = null, airAbsorptionFn = null, furniture = null, furnitureCatalogue = null, racks = null, rackCatalogue = null, structures = null, structureMaterials = null }) {
  const { r, azimuth_deg, elevation_deg } = localAngles(
    speakerState.position, speakerState.aim, listenerPos
  );
  const clampedR = Math.max(r, 0.1);
  const sens = speakerDef.acoustic.sensitivity_db_1w_1m;
  const attn = interpolateAttenuation(speakerDef.directivity, azimuth_deg, elevation_deg, freq_hz);
  // Master EQ is a pre-speaker signal gain — adds directly to the SPL at
  // every listener position, per-frequency. When eq is bypassed the caller
  // passes 0. Typical professional-PA range is ±12 dB.
  const effW = effectivePowerWatts(speakerDef, speakerState.power_watts);
  let spl_db = sens + 10 * Math.log10(effW) - 20 * Math.log10(clampedR) + attn + eqGainDb;
  // Air absorption — negligible at 1 kHz short range, significant at
  // 4+ kHz / long range. Pre-scaled α (dB / m) × distance.
  //   • INDOOR (airAbsorptionFn == null): the fixed dry-ish indoor table
  //     via airAbsorptionAt(). Held constant so no existing scene shifts.
  //   • OUTDOOR FIELD (airAbsorptionFn supplied): a T/RH-parametric
  //     ISO 9613-1 coefficient closure bound by the caller (the field grid).
  if (airAbsorption) {
    const alpha = airAbsorptionFn ? airAbsorptionFn(freq_hz) : airAbsorptionAt(freq_hz);
    spl_db -= alpha * clampedR;
  }
  // Material-aware wall transmission loss when both `room` AND `materials`
  // are in scope. Falls back to the legacy flat 30 dB if only `room` is
  // passed (test fixtures without a loaded catalogue). The `through_wall`
  // boolean stays on the return shape for the breakdown UI / print report;
  // `wallsCrossed` exposes the full per-wall details (material id +
  // opening flag) for any caller that needs them.
  const tl = pathWallLossDb(speakerState.position, listenerPos, room, materials, freq_hz);
  spl_db -= tl.tl_db;
  const through_wall = tl.wallsCrossed.some(w => !w.throughOpening);

  // Outdoor obstacles (Maekawa diffraction around minaret / arcade
  // columns; parallel TL+diffraction sum for portico side walls). Applies
  // ON TOP of the existing wall TL — they're physically in series.
  // No-op when outdoorObstacles is null/empty (non-surau presets).
  let outdoor_obstacle_loss_db = 0;
  if (outdoorObstacles && outdoorObstacles.length > 0) {
    outdoor_obstacle_loss_db = outdoorObstacleLossDb({
      src: speakerState.position,
      listener: listenerPos,
      freq_hz,
      obstacles: outdoorObstacles,
      materials,
    });
    spl_db -= outdoor_obstacle_loss_db;
  }

  // FurnitureLAB direct-path blocking (v=679, 2026-05-27). When a
  // placed bookshelf / table / chair sits on the source→listener line
  // its sub-volumes attenuate the direct field. Same physics as the
  // precision tracer's Beer-Lambert sink for porous items + a barrier
  // μ for reflective ones. No-op when no furniture or no catalogue.
  let furniture_loss_db = 0;
  if (Array.isArray(furniture) && furniture.length > 0 && furnitureCatalogue && materials?.frequency_bands_hz) {
    furniture_loss_db = furnitureDirectPathLossDb(
      speakerState.position, listenerPos,
      furniture, furnitureCatalogue,
      materials.frequency_bands_hz, freq_hz,
    );
    spl_db -= furniture_loss_db;
  }

  // DeviceLAB rack direct-path blocking (v=700, 2026-05-27). Same
  // segment-AABB barrier-μ approach as furniture, but using each rack's
  // outer footprint × outer height (rotated by yaw_deg). Sound disturbed
  // by a rack sitting between speaker and listener now drops at the
  // grid cell behind the rack instead of passing through unchanged.
  let rack_loss_db = 0;
  if (Array.isArray(racks) && racks.length > 0 && rackCatalogue && materials?.frequency_bands_hz) {
    rack_loss_db = rackDirectPathLossDb(
      speakerState.position, listenerPos,
      racks, rackCatalogue,
      materials.frequency_bands_hz, freq_hz,
    );
    spl_db -= rack_loss_db;
  }

  // Building-structure direct-path obstruction (v=756, 2026-06-05). A pillar,
  // half-wall, partition, beam, or platform between speaker and listener
  // attenuates the direct field via the energy-summed diffraction + mass-law
  // transmission model (js/physics/building-structures.js, Dr. Chen spec).
  // No-op when no structures or no resolved materials. structureMaterials is a
  // Map<materialId, rawMaterialRow> from the structure-material provider (the
  // raw materials.json rows carrying TL + α, which the surface-catalogue
  // mapping drops).
  let structure_loss_db = 0;
  if (Array.isArray(structures) && structures.length > 0 && structureMaterials && materials?.frequency_bands_hz) {
    structure_loss_db = structureDirectPathLossDb(
      speakerState.position, listenerPos,
      structures, structureMaterials,
      materials.frequency_bands_hz, freq_hz, room,
    );
    spl_db -= structure_loss_db;
  }

  return {
    r, azimuth_deg, elevation_deg, attn_db: attn, spl_db,
    through_wall,
    wallsCrossed: tl.wallsCrossed,
    tl_db_applied: tl.tl_db,
    outdoor_obstacle_loss_db,
    furniture_loss_db,
    rack_loss_db,
    structure_loss_db,
  };
}

// Sound power level from on-axis sensitivity + input power + directivity.
// For an omnidirectional source: L_w = L_p(1m, 1W) + 11 dB. For a directional
// source with directivity index DI: L_w = L_p(on-axis, 1m, 1W) + 11 − DI,
// because the on-axis sensitivity OVERSTATES the total radiated power by DI
// dB (most energy is concentrated in the main beam).
//
// Without this correction, a line-array element with DI ≈ 12 dB was
// contributing ~12 dB more reverberant energy than it physically could —
// making the diffuse field dominate and masking per-source power changes
// (the exact symptom the user reported).
function approxSoundPowerLevel(speakerDef, power_watts) {
  const sens = speakerDef.acoustic.sensitivity_db_1w_1m;
  const DI = speakerDef.acoustic.directivity_index_db ?? 3;  // default mild Q
  const effW = effectivePowerWatts(speakerDef, power_watts);
  return sens + 10 * Math.log10(effW) + 11 - DI;
}

/**
 * precomputeSPLContext
 * Pre-resolve per-source values that do NOT depend on listener position —
 * speaker def lookup, L_w for the reverb term at the current frequency
 * (including EQ gain), and the constant 10·log10(4/R) term. Call this
 * ONCE per heatmap frame; then hand the context + each vertex position
 * to `computeMultiSourceSPLFromContext` in the hot loop. Mirrors the
 * `precomputeSTIPAContext` / `computeSTIPAAt` split.
 *
 * Per-vertex savings on the arena (24 sources × ~10k vertices heatmap):
 *   • eliminates 240k Map.get() calls for speaker-def lookup
 *   • eliminates 240k approxSoundPowerLevel evaluations
 *   • eliminates 240k `10·log10(4/R)` computations
 * Measured ~18 % wall-clock reduction on heatmap rebuild (arena,
 * 30 % occupancy, reverb on, Chrome 120 / Intel Iris Xe).
 */
export function precomputeSPLContext({
  sources, getSpeakerDef,
  freq_hz = 1000, roomConstantR = 0,
  roomR_per_band = null,    // optional number[7] — enables per-band L_p_rev
                            // for the Tier 1a wall re-radiation contribution.
                            // When omitted, re-radiation is silently skipped.
  isSourceInside = null,    // optional (src) => bool — excludes outdoor sources
                            // from the interior reverberant aggregate.
  exteriorCouplings = null, // optional Map<src, Float32Array(COUPLING_NUM_BANDS)>
                            // — per-EXTERIOR-source C_couple[k] (dB, ≤ 0). When
                            // present, the reverb-leak hot loop subtracts |C_couple|
                            // from L_w before energy-summing into reverbPowerSum.
                            // Built by _buildSourceClassifications when caller
                            // doesn't supply one. Phase 3 of the indoor exterior-
                            // source coupling fix (Dr. Chen, 2026-05-25).
  eqGainDb = 0,
  enableTier1a = PHYSICS_P1_5_ENABLED,  // Phase 2d outdoor opt-in. When true,
                            // Maekawa diffraction + Kuttruff re-radiation are
                            // active regardless of the public-deploy flag, so
                            // the interior→field boundary is a gradient.
                            // Defaults to the historical flag for indoor.
  // ---- Phase A3 (2026-05-24, Martina audit §1.4 + §1.5) ----
  // Geometry + porch-drive pre-computation hoisted from the per-cell loop.
  // When room + materials are provided, the ctx pre-extracts outdoor
  // obstacles, overhead reflectors, and porches ONCE per frame (was once
  // per cell — 10k cells × 5 extractions = wasted alloc). When porches AND
  // sources are both present, the per-source drive level at each porch
  // midpoint is also pre-computed (was re-running the full physics stack
  // per source per cell — 80k physics evals × 4 sources × N cells = real
  // burn). When omitted (e.g. tests / per-listener computeMultiSourceSPL
  // call), the per-cell loop falls back to inline extraction + drive eval.
  room = null, materials = null,
  temperature_C = DEFAULT_TEMPERATURE_C,
  airAbsorption = true,
  airAbsorptionFn = null,   // optional T/RH-parametric closure (outdoor)
}) {
  const reverbActive = roomConstantR > 0;
  const revConst_db = reverbActive ? 10 * Math.log10(4 / roomConstantR) : 0;
  const sourceCtx = [];
  for (const src of sources) {
    const def = getSpeakerDef(src.modelUrl);
    if (!def) continue;
    // L_w including EQ gain — constant across listener positions.
    // For Tier 1a we ALWAYS compute it (the wall re-radiation term
    // needs L_w even when the listener is in a free-field zone) but
    // the active-listener reverb leak still gates on reverbActive.
    const L_w_with_eq = approxSoundPowerLevel(def, src.power_watts) + eqGainDb;
    // Phase 3: attach the per-band coupling coefficient when this source
    // was classified EXTERIOR. INTERIOR / FLUSH_INWARD sources carry
    // `coupling_per_band: null` and the reverb-leak loop adds 0 dB (no
    // coupling adjustment). EXTERIOR sources carry the Float32Array
    // built by computeCouplingForAllBands.
    const coupling_per_band = exteriorCouplings ? (exteriorCouplings.get(src) ?? null) : null;
    sourceCtx.push({ src, def, L_w_with_eq, coupling_per_band });
  }
  // Per-band reverberant SPL inside the room — listener-independent,
  // computed once per frame. Drives the Kuttruff wall re-radiation
  // term in computeMultiSourceSPLFromContext. Per-band array (not
  // per-active-frequency) per the Tier 1a "per-band always" decision:
  // future per-band UI + STIPA both need all 7 values.
  let L_p_rev_inside_per_band = null;
  if (enableTier1a && Array.isArray(roomR_per_band) && roomR_per_band.length === 7) {
    const sourceLwPerBand = sourceCtx.map(s => ({
      src: s.src,
      // Source L_w is band-independent under the current model
      // (sensitivity + power + DI scalar). Broadcast to 7 bands.
      Lw_per_band: new Float64Array(7).fill(s.L_w_with_eq),
    }));
    L_p_rev_inside_per_band = computeReverberantInsideSPL({
      sourceLwPerBand,
      roomR_per_band,
      isSourceInside: isSourceInside || (() => true),
    });
  }
  // ---- Phase A3 geometry + porch-drive hoist ----
  const outdoorObstacles = room ? extractOutdoorObstacles(room) : [];
  const overheadReflectors = room ? extractOverheadReflectors(room) : [];
  const porches = room ? extractPorches(room) : [];
  // porchDrives[srcIdx][porchIdx] = drive level in dB at the porch
  // midpoint, energy-summing direct (post-TL) + diffraction + re-radiation.
  // Computed once per frame; per-cell porch reverb is then a pure
  // arithmetic lookup. Null when no porches OR no materials.
  let porchDrives = null;
  if (porches.length > 0 && materials && sourceCtx.length > 0) {
    const useP15 = enableTier1a && room;
    const bandIdx = useP15 ? bandIndexForFreq(materials, freq_hz) : -1;
    const L_p_rev_inside_band_db = (useP15 && L_p_rev_inside_per_band)
      ? L_p_rev_inside_per_band[bandIdx]
      : -Infinity;
    porchDrives = sourceCtx.map(({ src, def }) =>
      porches.map(porch => {
        const cx = (porch.bounds.minX + porch.bounds.maxX) / 2;
        const cy = (porch.bounds.minY + porch.bounds.maxY) / 2;
        const cz = porch.z_ceil / 2;
        const drivePoint = { x: cx, y: cy, z: cz };
        const dd = computeDirectSPL({
          speakerDef: def, speakerState: src, listenerPos: drivePoint,
          freq_hz, room, materials, airAbsorption, eqGainDb,
          outdoorObstacles, airAbsorptionFn,
        });
        let pSum = Number.isFinite(dd.spl_db) ? Math.pow(10, dd.spl_db / 10) : 0;
        if (useP15 && dd.wallsCrossed?.length > 0 && Number.isFinite(dd.spl_db)) {
          const drive_free_db = dd.spl_db + dd.tl_db_applied;
          const floorMatId = room?.surfaces?.floor;
          const groundG = (floorMatId && materials?.byId?.[floorMatId]?.ground_absorption_G) ?? 0;
          const diffDrive = computeDiffractionContributions({
            src, listener: drivePoint, room, wallsCrossed: dd.wallsCrossed,
            materials, freq_hz, sourceLpFreeField_db: drive_free_db,
            temperature_C, airAbsorption, groundG, groundPlaneZ: 0,
            enable: enableTier1a,
          });
          pSum += diffDrive.totalPower;
          if (Number.isFinite(L_p_rev_inside_band_db)) {
            const reradDrive = computeReradiationContributions({
              src, listener: drivePoint, room, wallsCrossed: dd.wallsCrossed,
              materials, freq_hz,
              L_p_rev_inside_band_db,
              airAbsorption, enable: enableTier1a,
            });
            pSum += reradDrive.totalPower;
          }
        }
        return pSum > 0 ? 10 * Math.log10(pSum) : -Infinity;
      })
    );
  }
  return {
    sourceCtx, freq_hz, roomConstantR, reverbActive, revConst_db, eqGainDb,
    L_p_rev_inside_per_band, enableTier1a,
    // Phase A3 geometry + drives
    outdoorObstacles, overheadReflectors, porches, porchDrives,
  };
}

// Phase A5: validate a ctx object at the consumer boundary. Throws when
// a required field is missing — the audit (Martina §2.B) flagged the
// pre-A5 `??` fallback as a silent-failure carrier ("a test that builds
// a ctx by hand and forgets a field reverts to the module-level flag").
// Every fresh ctx from precomputeSPLContext now carries these fields;
// callers building one inline (rare, mainly tests) must supply them too.
function assertSPLContext(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('SPL context: ctx is required (got: ' + ctx + ')');
  }
  if (!Array.isArray(ctx.sourceCtx)) {
    throw new Error('SPL context: ctx.sourceCtx must be an array');
  }
  if (!Number.isFinite(ctx.freq_hz)) {
    throw new Error('SPL context: ctx.freq_hz must be a finite number');
  }
  if (typeof ctx.enableTier1a !== 'boolean') {
    throw new Error(`SPL context: ctx.enableTier1a must be boolean (got ${typeof ctx.enableTier1a}: ${ctx.enableTier1a}). Build the ctx via precomputeSPLContext() to set this field.`);
  }
}

/**
 * computeMultiSourceSPLFromContext
 * The inner hot loop extracted from computeMultiSourceSPL, using pre-
 * resolved per-source values. Identical numerical output to the non-
 * context form — regression-tested.
 */
export function computeMultiSourceSPLFromContext(ctx, listenerPos, {
  room = null, materials = null, coherent = false,
  temperature_C = DEFAULT_TEMPERATURE_C,
  airAbsorption = true,
  outdoorObstacles = null,    // optional; auto-extracted from room.surauStructure when null
  airAbsorptionFn = null,     // optional (freq_hz)=>dB/m closure — OUTDOOR field
                              // T/RH-parametric ISO 9613-1. Null → indoor table.
  furniture = null,           // v=679: state.furniture for direct-path blocking
  furnitureCatalogue = null,  // v=679: Map<id, row> for sub-volume lookup
  racks = null,               // v=700: state.rackSystem.racks for direct-path blocking
  rackCatalogue = null,       // v=700: rack catalogue (raw JSON or Map)
  structures = null,          // v=756: state.structures for direct-path obstruction
  structureMaterials = null,  // v=756: Map<materialId, rawRow> (TL + α)
} = {}) {
  const { sourceCtx, freq_hz, reverbActive, revConst_db, eqGainDb, L_p_rev_inside_per_band } = ctx;
  // Phase A5 (2026-05-24, Martina audit §2.B): ctx fields are now
  // REQUIRED — no `??` fallback. precomputeSPLContext always sets
  // ctx.enableTier1a; the only way it could be undefined is if a caller
  // built a ctx by hand without going through the constructor, which is
  // bug-territory. Throw loudly so the misbuilt ctx surfaces at the
  // boundary instead of silently routing through the module-level flag.
  assertSPLContext(ctx);
  const tier1aEnabled = ctx.enableTier1a;
  // Phase A3: geometry hoisted into precomputeSPLContext. Read from ctx
  // when present; fall back to inline extraction when the caller built a
  // ctx without room/materials (per-listener computeMultiSourceSPL path,
  // tests). The inline fallback keeps tests + the per-listener panel
  // working unchanged.
  const obstacles = outdoorObstacles
    ?? ctx.outdoorObstacles
    ?? (room ? extractOutdoorObstacles(room) : []);
  const overheadReflectors = ctx.overheadReflectors
    ?? (room ? extractOverheadReflectors(room) : []);
  const porches = ctx.porches
    ?? (room ? extractPorches(room) : []);
  const porchDrivesCache = ctx.porchDrives;   // null when not pre-computed
  let directPressureSum = 0;
  const coherentSrcs = [];   // {A, r} per source — for the partial-coherence sum
  const c = coherent ? speedOfSound(temperature_C) : 0;
  const angFreq = 2 * Math.PI * freq_hz;
  let reverbPowerSum = 0;
  // Per-listener (source-independent): ceiling TL to add to any over-the-wall-
  // TOP diffraction path when this receiver is inside the roofed interior.
  // 0 for exterior / open-top receivers. See interiorRoofDiffractionTL_db.
  const interiorRoofTL_db = (tier1aEnabled && room && materials)
    ? interiorRoofDiffractionTL_db(listenerPos, room, materials, freq_hz)
    : 0;
  // Tier 1a — diffraction + re-radiation. Both modules early-return
  // zero when PHYSICS_P1_5_ENABLED is false, so this block is a no-op
  // on public deploys. The bandIdx + per-band L_p_rev scalar are resolved
  // once per call (constant across sources).
  const useP15 = tier1aEnabled && materials && room;
  const bandIdx = useP15 ? bandIndexForFreq(materials, freq_hz) : -1;
  const L_p_rev_inside_band_db = (useP15 && L_p_rev_inside_per_band)
    ? L_p_rev_inside_per_band[bandIdx]
    : -Infinity;
  // Phase 3 (Dr. Chen, 2026-05-25): coupling-band index for the active
  // frequency. COUPLING_BANDS_HZ = [125, 250, 500, 1k, 2k, 4k] — the
  // first 6 entries of materials.frequency_bands_hz. Computed
  // INDEPENDENTLY of useP15 / bandIdx — coupling is an indoor concern
  // that fires whenever a source is classified EXTERIOR, regardless of
  // whether Tier 1a wall re-radiation is also active. (bandIdx above
  // is gated on useP15 and stays at -1 on the indoor non-Tier-1a path,
  // so we cannot reuse it here.) For 8 kHz (or any band missing from
  // COUPLING_BANDS_HZ) the coupling adjustment is skipped — sources
  // stay full-power at that band, MVP-acceptable per Hannes brief.
  let couplingBandIdx = -1;
  if (materials && Array.isArray(materials.frequency_bands_hz)) {
    const cbIdx = bandIndexForFreq(materials, freq_hz);
    if (cbIdx >= 0 && cbIdx < COUPLING_NUM_BANDS) couplingBandIdx = cbIdx;
  } else if (Number.isFinite(freq_hz)) {
    const exact = COUPLING_BANDS_HZ.indexOf(freq_hz);
    if (exact >= 0) couplingBandIdx = exact;
  }
  let diffractionPowerSum = 0;
  let reradiationPowerSum = 0;
  let overheadReflPowerSum = 0;
  let porchReverbPowerSum = 0;

  for (let i = 0; i < sourceCtx.length; i++) {
    const { src, def, L_w_with_eq, coupling_per_band } = sourceCtx[i];
    const d = computeDirectSPL({
      speakerDef: def, speakerState: src, listenerPos,
      freq_hz, room, materials, airAbsorption, eqGainDb,
      outdoorObstacles: obstacles, airAbsorptionFn,
      furniture, furnitureCatalogue,
      racks, rackCatalogue,
      structures, structureMaterials,
    });
    const spl_db = d.spl_db;
    if (!isFinite(spl_db)) continue;
    if (coherent) {
      // Collect amplitude + distance; the interference is resolved pairwise
      // with octave-band partial coherence after the loop (a naive all-
      // coherent phasor sum produces unphysical interference fringes above
      // ~500 Hz for separated sources). See partialCoherentPower.
      coherentSrcs.push({ A: Math.pow(10, spl_db / 20), r: d.r });
    } else {
      directPressureSum += Math.pow(10, spl_db / 10);
    }
    if (reverbActive) {
      // Reverb leak follows the same per-band TL as the direct path —
      // L_w drops by the total wall TL we just computed for the direct
      // segment. This is an approximation (it ignores that the reverb
      // field radiates from many directions, not just the direct line)
      // but it tracks the band-specific concrete vs. gypsum vs. open-
      // door behaviour the user paid for. Falls back to the legacy
      // flat 30 dB via pathWallLossDb when `materials` is missing.
      //
      // Phase 3 (Dr. Chen 2026-05-25): when this source is EXTERIOR
      // (coupling_per_band attached), the Hopkins-Stryker diffuse-
      // field assumption breaks — the source's W only excites the
      // room via the fraction that geometrically + materially
      // couples through the envelope. Subtract |C_couple[k]| dB
      // from L_w before energy-summing. INTERIOR / FLUSH_INWARD
      // sources carry coupling_per_band=null and stay full-power.
      // Skip the source's reverb contribution when C_couple is
      // −Infinity (no facet contributed) or below −120 dB
      // (numerically zero — avoid 10^(-200/10) underflow noise).
      let coupling_db = 0;
      if (coupling_per_band) {
        if (couplingBandIdx < 0) {
          coupling_db = 0;  // off-band (8 kHz / missing materials) — no adjustment
        } else {
          coupling_db = coupling_per_band[couplingBandIdx];
          if (!Number.isFinite(coupling_db) || coupling_db < -120) {
            // Effectively no coupling at this band — skip the source's
            // reverb contribution entirely. (Without this guard the
            // 10^(L_w + C/10) term still adds a vanishing-but-nonzero
            // bias that the energy sum dutifully accumulates.)
            coupling_db = null;
          }
        }
      }
      if (coupling_db !== null) {
        const L_w = L_w_with_eq - d.tl_db_applied + coupling_db;
        const L_rev = L_w + revConst_db;
        reverbPowerSum += Math.pow(10, L_rev / 10);
      }
    }
    // Tier 1a — energy-sum diffraction over wall edges and Kuttruff
    // wall re-radiation alongside the direct (through-wall TL) path.
    // Both contributions early-return zero when the flag is off OR
    // when wallsCrossed is empty / all-openings — no extra cost on
    // the public-deploy path. The direct path's Lp at distance r is
    // already net-of-TL; diffraction needs the free-field Lp WITHOUT
    // the TL term applied, so we reconstruct it from spl_db + tl_db.
    if (useP15 && d.wallsCrossed?.length > 0) {
      const sourceLpFreeField_db = spl_db + d.tl_db_applied;
      // Ground absorption coefficient G ∈ [0,1] for outdoor reflection
      // on the diffracted path (Tier 1a commit (h), ISO 9613-2 §7.3).
      // Read from the floor material's optional ground_absorption_G
      // field; default 0 (hard concrete / fully reflective).
      const floorMatId = room?.surfaces?.floor;
      const groundG = (floorMatId && materials?.byId?.[floorMatId]?.ground_absorption_G) ?? 0;
      const diff = computeDiffractionContributions({
        src, listener: listenerPos, room, wallsCrossed: d.wallsCrossed,
        materials, freq_hz, sourceLpFreeField_db, temperature_C, airAbsorption,
        groundG, groundPlaneZ: 0, enable: tier1aEnabled,
        interiorTopEdgeTL_db: interiorRoofTL_db,
      });
      diffractionPowerSum += diff.totalPower;
      if (Number.isFinite(L_p_rev_inside_band_db)) {
        const rerad = computeReradiationContributions({
          src, listener: listenerPos, room, wallsCrossed: d.wallsCrossed,
          materials, freq_hz,
          L_p_rev_inside_band_db,
          airAbsorption, enable: tier1aEnabled,
        });
        reradiationPowerSum += rerad.totalPower;
      }
    }
    // Tier 1a commit (h): the +1.25 dB Pierce-Hadden wedge correction
    // that USED to live here has been REPLACED by the full multi-path
    // Maekawa-applied-to-the-vertical-edge geometry inside
    // computeDiffractionContributions. Same physics done explicitly,
    // no scalar fudge. computeCornerDiffractionContributions is now
    // deprecated and will be deleted in commit (i).

    // Phase 8 Step 1 — overhead specular reflection. Image-source mirror
    // across roof/canopy/soffit polygons, attenuated by 10·log10(1 − α_roof).
    // Empty list → 0 (the common non-surau case). Falls through to the
    // incoherent pressure² accumulator alongside diffraction + re-rad —
    // the four exterior energy paths (direct, edge-diffraction, wall
    // re-radiation, overhead reflection) sum in pressure².
    if (overheadReflectors.length > 0) {
      const overheadP = computeOverheadReflectionPower({
        src, speakerDef: def, listenerPos, freq_hz, room, materials,
        airAbsorption, airAbsorptionFn, eqGainDb,
        reflectors: overheadReflectors,
      });
      overheadReflPowerSum += overheadP;
    }
    // Phase 8 Step 4 — porch partial-enclosure reverberant lift. Adds an
    // extra reverberant term when the listener is inside an arcade/canopy
    // polygon.
    //
    // Drive includes diffraction (not just direct path). For the surau
    // azan-horn geometry — horns at z=7m above the 4.5m building roof —
    // the direct path from horn to porch midpoint crosses the room
    // ceiling + the building wall (~86 dB combined TL on concrete +
    // gypsum), so a direct-only drive is ~0 dB and the lift contributes
    // nothing. The dominant path is Maekawa diffraction over the
    // building eave (~10-15 dB IL only) — that's the energy that
    // physically fills the porch, so it must drive the porch lift.
    //
    // The drive at the porch midpoint = energy-sum of {direct after TL,
    // edge diffraction over each crossed wall, wall re-radiation}. Same
    // four-path stack the listener cell already uses, computed once per
    // source per porch BEFORE the cell evaluation.
    if (porches.length > 0) {
      // Phase A3: prefer the per-frame pre-computed drives on ctx. Falls
      // back to the inline closure when ctx.porchDrives is null (per-
      // listener computeMultiSourceSPL caller, tests). The closure path is
      // unchanged from pre-Phase-A3.
      const precomputed = porchDrivesCache?.[i];   // [porchIdx] → drive_dB, or undefined
      const porchP = computePorchReverbPower({
        src, listenerPos, freq_hz, room, materials, porches,
        precomputedDrives_dB: precomputed,
        getDirectSplDb: precomputed ? null : (srcLike, pos) => {
          // Direct path to the drive point — includes per-band wall TL
          // because we want to know the actual sound energy arriving.
          const dd = computeDirectSPL({
            speakerDef: def, speakerState: srcLike, listenerPos: pos,
            freq_hz, room, materials, airAbsorption, eqGainDb,
            outdoorObstacles: obstacles, airAbsorptionFn,
          });
          let pSum = Number.isFinite(dd.spl_db) ? Math.pow(10, dd.spl_db / 10) : 0;
          if (useP15 && dd.wallsCrossed?.length > 0 && Number.isFinite(dd.spl_db)) {
            const drive_free_db = dd.spl_db + dd.tl_db_applied;
            const floorMatId = room?.surfaces?.floor;
            const groundG = (floorMatId && materials?.byId?.[floorMatId]?.ground_absorption_G) ?? 0;
            const diffDrive = computeDiffractionContributions({
              src: srcLike, listener: pos, room, wallsCrossed: dd.wallsCrossed,
              materials, freq_hz, sourceLpFreeField_db: drive_free_db,
              temperature_C, airAbsorption, groundG, groundPlaneZ: 0,
              enable: tier1aEnabled,
            });
            pSum += diffDrive.totalPower;
            if (Number.isFinite(L_p_rev_inside_band_db)) {
              const reradDrive = computeReradiationContributions({
                src: srcLike, listener: pos, room, wallsCrossed: dd.wallsCrossed,
                materials, freq_hz,
                L_p_rev_inside_band_db,
                airAbsorption, enable: tier1aEnabled,
              });
              pSum += reradDrive.totalPower;
            }
          }
          return pSum > 0 ? 10 * Math.log10(pSum) : -Infinity;
        },
      });
      porchReverbPowerSum += porchP;
    }
  }
  const directTotal = coherent
    ? partialCoherentPower(coherentSrcs, angFreq, c, c > 0 ? c / freq_hz : 0)
    : directPressureSum;
  const totalPower = directTotal
                   + reverbPowerSum + diffractionPowerSum + reradiationPowerSum
                   + overheadReflPowerSum + porchReverbPowerSum;
  return totalPower > 0 ? 10 * Math.log10(totalPower) : -Infinity;
}

/**
 * computeMultiSourceSPL
 * Sum SPL contributions from every source at a single listener position.
 *
 * @param {object} opts
 * @param {Array} opts.sources                   List of { position, aim, power_watts, modelUrl, ... }
 * @param {(url:string)=>any} opts.getSpeakerDef Resolver returning the loudspeaker JSON (sensitivity + directivity)
 * @param {{x,y,z}} opts.listenerPos             Listener ear position (state coords)
 * @param {number} [opts.freq_hz=1000]           Frequency to evaluate
 * @param {object|null} [opts.room=null]         Room — used for wall-transmission path check
 * @param {number} [opts.roomConstantR=0]        Hopkins-Stryker R (m²). > 0 adds diffuse reverberant lift.
 * @param {boolean} [opts.coherent=false]        If true, complex-sum pressures (phase-aware). Default incoherent.
 * @param {number} [opts.temperature_C=20]       Used for speed-of-sound when coherent=true.
 * @param {boolean} [opts.airAbsorption=true]    Toggle ISO 9613-1 air absorption.
 */
// Top-level keyword args. Adds `materials` (catalogue: `{ frequency_bands_hz, list, byId }`
// from `loadMaterials`) so per-band wall TL applies; legacy callers that omit it
// keep the flat 30 dB back-compat path. Otherwise unchanged.
// Phase 7 (Dr. Chen audit 2026-05-24): listener at (x, y) is in the
// building's interior reverberant field iff it sits inside the parent
// INNER polygon (wallInsetPolygon's `inner`). Cells in the wall annulus
// or in outdoor zones (surau podium, sub-enclosures, free field) MUST
// NOT inherit the 4/R interior lift — the live walk-mode probe was
// showing ~6 dB of false lift on outdoor cells under the arcade roof
// before this fix.
//
// Returns true when the listener should get ctxInside-equivalent
// treatment (R > 0 honoured), false when R + RBands must be zeroed.
// Returns null when geometry can't be resolved (no room, no inset, no
// listenerPos) → caller defaults to "honour R" for back-compat.
function isListenerInsideBuildingInterior(listenerPos, room) {
  if (!room || !listenerPos
      || !Number.isFinite(listenerPos.x) || !Number.isFinite(listenerPos.y)) return null;
  const inset = wallInsetPolygon(room);
  if (!inset || !Array.isArray(inset.inner) || inset.inner.length < 3) return null;
  return pointInPolygon2DLocal(listenerPos.x, listenerPos.y, inset.inner);
}

// Roof transmission loss (dB) to add to an over-the-wall-TOP diffraction path
// when the receiver sits inside the building's ROOFED interior. The wall top is
// capped by the ceiling, so the over-the-top path physically passes through the
// roof slab — Maekawa over a free edge is invalid into a closed cavity (Dr.
// Chen 2026-05-30). Routed through the RESOLVED ceiling material (roomSurfaces
// forces 'open-air', TL=0, when room.enclosure==='outdoor'), so a roofless
// courtyard self-corrects to 0 and the over-the-top path survives — the
// roofed/open distinction falls out of the material, not a boolean. Returns 0
// when the receiver is not in the interior or is at/above the roof.
export function interiorRoofDiffractionTL_db(listenerPos, room, materials, freq_hz) {
  if (!room || !materials || !listenerPos) return 0;
  if (isListenerInsideBuildingInterior(listenerPos, room) !== true) return 0;
  const ceilH = maxCeilingHeightAt(listenerPos.x, listenerPos.y, room);
  if (Number.isFinite(ceilH) && Number.isFinite(listenerPos.z) && listenerPos.z >= ceilH) return 0;
  const ceiling = roomSurfaces(room).find(s => s.id === 'ceiling');
  if (!ceiling?.materialId) return 0;
  const bandIdx = bandIndexForFreq(materials, freq_hz);
  return transmissionLossDb([{ materialId: ceiling.materialId }], materials, bandIdx);
}

function pointInPolygon2DLocal(x, y, verts) {
  let inside = false;
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (((verts[i].y > y) !== (verts[j].y > y)) &&
        (x < (verts[j].x - verts[i].x) * (y - verts[i].y) / (verts[j].y - verts[i].y) + verts[i].x)) {
      inside = !inside;
    }
  }
  return inside;
}

export function computeMultiSourceSPL({
  sources, getSpeakerDef, listenerPos,
  freq_hz = 1000, room = null, materials = null,
  roomConstantR = 0,
  roomR_per_band = null,         // optional — enables Tier 1a re-radiation
  isSourceInside = null,         // optional — excludes outdoor sources from rev aggregate
  coherent = false,
  temperature_C = DEFAULT_TEMPERATURE_C,
  airAbsorption = true,
  eqGainDb = 0,
  enableTier1a = PHYSICS_P1_5_ENABLED,
  airAbsorptionFn = null,
  furniture = null,              // v=679 — direct-path blocking by placed furniture
  furnitureCatalogue = null,
  racks = null,                  // v=700 — direct-path blocking by placed racks
  rackCatalogue = null,
  structures = null,             // v=756 — direct-path obstruction by building structures
  structureMaterials = null,
}) {
  // Phase 7 — gate the interior reverberant context on the listener's
  // geometric classification. When the listener is OUTSIDE the parent
  // inner polygon (podium, enclosure, outdoor open field), zero R + RBands
  // so the building's interior reverberant field is not falsely attributed
  // to outdoor receivers. When the helper returns null (no room geometry
  // resolvable), keep the legacy behaviour and honour whatever R the
  // caller passed.
  const inInterior = isListenerInsideBuildingInterior(listenerPos, room);
  const effR = (inInterior === false) ? 0 : roomConstantR;
  const effRBands = (inInterior === false) ? null : roomR_per_band;
  // INTERIM SAFETY OVERRIDE (2026-05-24): mirror the gate at line 836 so the
  // per-listener readout matches the heatmap when the user has flipped the
  // outdoor-Tier-1a override ON. Outdoor rooms only; indoor unaffected.
  // Removed in Phase B.
  const isOutdoor = (room?.enclosure === 'outdoor');
  const effEnableTier1a = (isOutdoor && isTier1aOutdoorOverrideDisabled())
    ? false
    : enableTier1a;
  // Phase 3 (Dr. Chen 2026-05-25): when caller doesn't override
  // isSourceInside, derive it (and the per-EXTERIOR-source coupling
  // map) from the classifier. Caller's explicit isSourceInside still
  // wins for back-compat — but tests passing one without a materials
  // catalogue get the historical "no coupling adjustment" behaviour.
  let exteriorCouplings = null;
  let effIsSourceInside = isSourceInside;
  if (!effIsSourceInside) {
    const cls = _buildSourceClassifications(sources, room, materials);
    if (cls) {
      effIsSourceInside = cls.isSourceInside;
      exteriorCouplings = cls.couplings;
    }
  }
  // One-shot helper: build a context and evaluate at this listener.
  // Callers with many listeners against the same source set should use
  // `precomputeSPLContext` + `computeMultiSourceSPLFromContext` directly
  // to avoid redoing the per-source resolution on every vertex.
  const ctx = precomputeSPLContext({
    sources, getSpeakerDef, freq_hz, roomConstantR: effR,
    roomR_per_band: effRBands, isSourceInside: effIsSourceInside,
    exteriorCouplings, eqGainDb,
    enableTier1a: effEnableTier1a,
    // Phase A3: pass geometry params so porch drives are pre-computed
    // ONCE per call. Per-listener callers (tests, panel readings) only
    // pay this once anyway, but the cached result keeps the inline
    // closure path from running per source (the inline closure had its
    // own copy of the parallel-bypass bug — see Martina audit §1.5).
    room, materials, temperature_C, airAbsorption, airAbsorptionFn,
  });
  return computeMultiSourceSPLFromContext(ctx, listenerPos, {
    room, materials, coherent, temperature_C, airAbsorption, airAbsorptionFn,
    furniture, furnitureCatalogue,
    racks, rackCatalogue,
    structures, structureMaterials,
  });
}

export function computeListenerBreakdown({
  sources, getSpeakerDef, listenerPos,
  freq_hz = 1000, room = null, materials = null,
  roomConstantR = 0, airAbsorption = true,
  furniture = null, furnitureCatalogue = null,
  racks = null, rackCatalogue = null,
  structures = null, structureMaterials = null,
}) {
  // Phase 7 — same listener-classification gate as computeMultiSourceSPL.
  // The reverb leak term below adds (4/R · L_w) to every per-source
  // power; if the listener is outside the parent inner polygon, that term
  // is a false attribution of the building's reverberant field to an
  // outdoor receiver. Zero R when the listener is NOT in true interior.
  const inInterior = isListenerInsideBuildingInterior(listenerPos, room);
  if (inInterior === false) roomConstantR = 0;
  // Extract outdoor obstacles once for the whole breakdown (cheap; only
  // a few dozen entries even for surau). Per-source calls reuse this list.
  const obstacles = room ? extractOutdoorObstacles(room) : [];
  const perSpeaker = sources.map((src, i) => {
    const def = getSpeakerDef(src.modelUrl);
    const outsideRoom = room ? !isInsideRoom3D(src.position, room) : false;
    if (!def) return { idx: i, spl_db: -Infinity, r: null, azimuth_deg: null, modelUrl: src.modelUrl, outsideRoom, through_wall: false, tl_db_applied: 0 };
    const d = computeDirectSPL({ speakerDef: def, speakerState: src, listenerPos, freq_hz, room, materials, airAbsorption, outdoorObstacles: obstacles, furniture, furnitureCatalogue, racks, rackCatalogue, structures, structureMaterials });
    return {
      idx: i, spl_db: d.spl_db, r: d.r, azimuth_deg: d.azimuth_deg,
      modelUrl: src.modelUrl, outsideRoom,
      through_wall: d.through_wall,
      tl_db_applied: d.tl_db_applied,
      wallsCrossed: d.wallsCrossed,
    };
  });
  // Direct pressure² sum.
  let pressureSum = 0;
  for (const p of perSpeaker) if (isFinite(p.spl_db)) pressureSum += Math.pow(10, p.spl_db / 10);
  // Diffuse reverberant contribution per source (added incoherently).
  // Reverb leak uses the SAME per-band TL the direct path computed,
  // mirroring the multi-source hot loop. The legacy back-compat
  // (materials missing → flat 30 dB) flows through pathWallLossDb.
  //
  // Phase 3 (Dr. Chen 2026-05-25): mirror the EXTERIOR-source coupling
  // gate from computeMultiSourceSPLFromContext. Sources classified
  // EXTERIOR have their L_w_reverb reduced by |C_couple[k]| before
  // energy-summing; those whose coupling at this band is −Infinity or
  // < −120 dB are skipped entirely. Same _buildSourceClassifications
  // helper, same C_couple table, same band index → identical numerical
  // gate as the heatmap path. Without this the per-listener readout
  // and the heatmap would silently disagree by 3–5 dB on the surau.
  let reverb_db = -Infinity;
  if (roomConstantR > 0) {
    const cls = _buildSourceClassifications(sources, room, materials);
    const couplings = cls?.couplings ?? null;
    const couplingBandIdx = (materials && Array.isArray(materials.frequency_bands_hz))
      ? (() => {
          const bIdx = bandIndexForFreq(materials, freq_hz);
          return (bIdx >= 0 && bIdx < COUPLING_NUM_BANDS) ? bIdx : -1;
        })()
      : -1;
    let reverbSum = 0;
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const def = getSpeakerDef(src.modelUrl);
      if (!def) continue;
      const tl = pathWallLossDb(src.position, listenerPos, room, materials, freq_hz);
      // Coupling adjustment: 0 dB for INTERIOR / FLUSH_INWARD / no-coupling-
      // map; non-positive dB for EXTERIOR. null sentinel = "no meaningful
      // coupling at this band, skip the source's reverb contribution".
      let coupling_db = 0;
      const couplingArr = couplings?.get(src);
      if (couplingArr) {
        if (couplingBandIdx < 0) {
          coupling_db = 0;
        } else {
          coupling_db = couplingArr[couplingBandIdx];
          if (!Number.isFinite(coupling_db) || coupling_db < -120) coupling_db = null;
        }
      }
      if (coupling_db === null) continue;
      const L_w = approxSoundPowerLevel(def, src.power_watts) - tl.tl_db + coupling_db;
      const L_rev = L_w + 10 * Math.log10(4 / roomConstantR);
      reverbSum += Math.pow(10, L_rev / 10);
    }
    if (reverbSum > 0) reverb_db = 10 * Math.log10(reverbSum);
    pressureSum += reverbSum;
  }
  const total_spl_db = pressureSum > 0 ? 10 * Math.log10(pressureSum) : -Infinity;
  return { perSpeaker, total_spl_db, reverb_db, freq_hz };
}

function pointInPoly(x, y, verts) {
  let inside = false;
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (((verts[i].y > y) !== (verts[j].y > y)) &&
        (x < (verts[j].x - verts[i].x) * (y - verts[i].y) / (verts[j].y - verts[i].y) + verts[i].x)) {
      inside = !inside;
    }
  }
  return inside;
}

// Square-cell grid sizing (Dr. Chen 2026-05-21). Derive cellsX and cellsY
// INDEPENDENTLY from the extent at a ~0.5 m target so heatmap cells stay
// SQUARE in any room/zone aspect ratio — instead of stretching a fixed
// gridSize×gridSize count over a non-square bounding box (which made cells
// 3:1 rectangles in a tall corridor while a square room got square cells).
// The cell SIZE in metres governs, not the count; resolution is therefore
// consistent across room sizes, and the 2D viewport / 3D room plane /
// print report all sample identically because they all call through here.
//   * target 0.5 m (half-samples the steepest meaningful direct-field
//     gradient per Nyquist; matches the precision/3D path's existing
//     ceil(longestDim/0.5) convention)
//   * floor 8 / cap 120 cells per axis. When the long axis would exceed
//     120 the cell size grows so BOTH axes scale together and stay square.
//   * the per-axis floor can break exact squareness on a sliver-thin
//     room (the floor wins) — acceptable and bounded.
// NOTE: avgSPL_db here is an UNWEIGHTED mean over cell centres; with equal-
// area square cells that is unbiased. Do not reintroduce variable cell
// areas (e.g. a future per-cell polygon clip) without switching avg to
// area-weighting, or the mean will bias toward wherever cells are densest.
const HEATMAP_CELL_TARGET_M = 0.5;
const HEATMAP_CELL_MIN = 8;
const HEATMAP_CELL_MAX = 120;
export function squareCellCounts(totalW, totalD, targetM = HEATMAP_CELL_TARGET_M) {
  const w = Math.max(1e-3, totalW), d = Math.max(1e-3, totalD);
  const longest = Math.max(w, d);
  let cellSize = targetM;
  if (longest / cellSize > HEATMAP_CELL_MAX) cellSize = longest / HEATMAP_CELL_MAX;
  const cellsX = Math.max(HEATMAP_CELL_MIN, Math.min(HEATMAP_CELL_MAX, Math.round(w / cellSize)));
  const cellsY = Math.max(HEATMAP_CELL_MIN, Math.min(HEATMAP_CELL_MAX, Math.round(d / cellSize)));
  return { cellsX, cellsY };
}

// `metric: 'spl' | 'sti'` selects what each cell stores. When 'sti', the
// caller must also pass `stipaCtx` (from precomputeSTIPAContext) and
// optionally `ambient_per_band`. Field names stay `*_db` for backward
// compat — the `metric` tag on the result tells callers (texture
// builder, legend) how to interpret. Without this, switching the
// heatmap to STIPA in non-arena rooms left the legacy zone-grid path
// computing SPL while the legend rendered the values as if they were
// STI — producing the "STI bar shows 83–96" bug.
export function computeZoneSPLGrid({
  zone, sources, getSpeakerDef, room, materials = null,
  gridSize = 22, freq_hz = 1000, earAbove_m = 1.2,
  roomConstantR = 0, coherent = false, airAbsorption = true,
  metric = 'spl', stipaCtx = null, ambient_per_band = null,
  computeSTIPAAt = null,
}) {
  const verts = zone.vertices || [];
  if (verts.length < 3) return null;
  const useSTI = metric === 'sti' && stipaCtx && computeSTIPAAt;
  const xs = verts.map(v => v.x), ys = verts.map(v => v.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  // Square cells from the zone's own extent (see squareCellCounts). The
  // legacy `gridSize` count is superseded — cell SIZE governs so a long
  // thin audience strip no longer gets 0.5 m × 0.05 m slivers.
  const { cellsX, cellsY } = squareCellCounts(maxX - minX, maxY - minY);
  const cellW = (maxX - minX) / cellsX;
  const cellH = (maxY - minY) / cellsY;
  const grid = [];
  let minVal = Infinity, maxVal = -Infinity, sum = 0, count = 0;
  const earZ = (zone.elevation_m || 0) + earAbove_m;
  for (let j = 0; j < cellsY; j++) {
    const row = [];
    for (let i = 0; i < cellsX; i++) {
      const x = minX + (i + 0.5) * cellW;
      const y = minY + (j + 0.5) * cellH;
      if (!pointInPoly(x, y, verts)) { row.push(-Infinity); continue; }
      const listenerPos = { x, y, z: earZ };
      const v = useSTI
        ? computeSTIPAAt(stipaCtx, listenerPos, ambient_per_band)
        : computeMultiSourceSPL({
            sources, getSpeakerDef, listenerPos, freq_hz, room, materials,
            roomConstantR, coherent, airAbsorption,
          });
      row.push(v);
      if (isFinite(v)) {
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
        sum += v;
        count++;
      }
    }
    grid.push(row);
  }
  const ok = count > 0;
  return {
    id: zone.id, label: zone.label,
    grid, cellsX, cellsY,
    boundsX: [minX, maxX], boundsY: [minY, maxY],
    cellW_m: cellW, cellH_m: cellH,
    elevation_m: zone.elevation_m || 0,
    earZ_m: earZ,
    metric: useSTI ? 'sti' : 'spl',
    minSPL_db: ok ? minVal : 0,
    maxSPL_db: ok ? maxVal : 0,
    avgSPL_db: ok ? sum / count : 0,
    uniformity_db: ok ? (maxVal - minVal) : 0,
  };
}

export function computeSPLGrid({
  sources, getSpeakerDef, room, materials = null,
  earHeight_m = 1.2, gridSize = 25, freq_hz = 1000,
  roomConstantR = 0, coherent = false, airAbsorption = true,
  metric = 'spl', stipaCtx = null, ambient_per_band = null,
  computeSTIPAAt = null,
  // --- OUTDOOR FIELD MODE (Phase 2b/2c/2d) -------------------------------
  outdoor = false,             // when true: sample the full field, KEEP cells
                               // outside the footprint (evaluated free-field
                               // R=0), and use the parametric air-absorption.
  fieldBounds = null,          // {minX,minY,maxX,maxY} — field extent (metres).
                               // Required when outdoor; ignored otherwise.
  temperature_C = DEFAULT_TEMPERATURE_C,  // ISO 9613-1 parametric inputs (field)
  humidity_pct = 70,
  pressure_kPa = 101.325,
  furniture = null,            // v=679 — placed FurnitureLAB items for direct-path blocking
  furnitureCatalogue = null,
  racks = null,                // v=700 — placed DeviceLAB racks for direct-path blocking
  rackCatalogue = null,
  structures = null,           // v=756 — placed building structures for direct-path obstruction
  structureMaterials = null,
}) {
  const useSTI = metric === 'sti' && stipaCtx && computeSTIPAAt;

  // Bounds + cell sizing. Indoor: union of parent footprint + every
  // broken-out enclosure (a hut placed past room.width_m was being missed
  // when the grid assumed (0,0)..(width_m,depth_m)). Outdoor: the explicit
  // field extent so the grid covers the whole open ground.
  const bounds = (outdoor && fieldBounds) ? fieldBounds : roomEffectiveBounds(room);
  const totalW = Math.max(1e-3, bounds.maxX - bounds.minX);
  const totalD = Math.max(1e-3, bounds.maxY - bounds.minY);
  // Square cells from the effective extent (see squareCellCounts). The
  // legacy `gridSize` arg is superseded — cell SIZE (≈0.5 m) governs, so
  // an elongated room no longer gets stretched rectangular cells. All
  // surfaces (2D viewport / 3D room plane / print) call through here, so
  // they sample identically.
  const { cellsX, cellsY } = squareCellCounts(totalW, totalD);
  const cellW_m = totalW / cellsX;
  const cellD_m = totalD / cellsY;
  const originX_m = bounds.minX;
  const originY_m = bounds.minY;

  // OUTDOOR: bind a T/RH-parametric ISO 9613-1 air-absorption closure once
  // per frame. INDOOR: null → computeDirectSPL falls back to the fixed
  // indoor table (no existing scene shifts). The closure is per-band cheap;
  // hoisted out of the cell loop.
  const airAbsorptionFn = outdoor
    ? (f) => airAbsorptionDbPerM_param(f, temperature_C, humidity_pct, pressure_kPa)
    : null;

  // OUTDOOR: smooth the interior→field wall cliff. Maekawa diffraction +
  // Kuttruff re-radiation must be active at the boundary regardless of the
  // public-deploy PHYSICS_P1_5 flag (Phase 2d). Indoor keeps the flag.
  //
  // INTERIM SAFETY OVERRIDE (2026-05-24, see HEATMAP_AUDIT_SYNTHESIS): when
  // the user has flipped the WallLAB "outdoor diffraction" override ON, force
  // Tier 1a OFF for outdoor — exposes clean direct+reverb only, hiding the
  // parallel-bypass over-prediction until the Phase B rewrite lands. Indoor
  // path unaffected. Override defaults to NOT-disabled so existing scenes
  // render identically.
  const enableTier1a = outdoor
    ? !isTier1aOutdoorOverrideDisabled()
    : PHYSICS_P1_5_ENABLED;

  // OUTDOOR ONLY: the dominant interior→field leakage through a solid wall
  // mid-span is Kuttruff RE-RADIATION of the building's interior reverberant
  // field — NOT edge diffraction (which only helps near the wall corners).
  // To drive it, the context needs the per-band interior room constant R so
  // it can compute L_p_rev_inside_per_band once per frame. Compute R[7] from
  // the building's own absorption budget.
  //
  // We deliberately gate this on `outdoor`, NOT on `enableTier1a`, so the
  // INDOOR path stays byte-identical to the historical computeMultiSourceSPL
  // call (which never passed roomR_per_band / isSourceInside) on EVERY
  // origin — including localhost where PHYSICS_P1_5_ENABLED is true. The
  // 2a hoist contract is "identical output to the old per-cell path"; adding
  // re-radiation to indoor would break it. Indoor re-radiation, if ever
  // wanted, is a separate decision wired by the indoor caller.
  let roomR_per_band = null;
  if (outdoor && materials && room && Array.isArray(materials.frequency_bands_hz)) {
    const bands = materials.frequency_bands_hz;
    roomR_per_band = bands.map(fb => computeRoomConstant(room, materials, fb, []));
    // Pad/truncate to the 7-length the re-radiation context expects.
    if (roomR_per_band.length !== 7) {
      const padded = new Array(7).fill(0);
      for (let k = 0; k < Math.min(7, roomR_per_band.length); k++) padded[k] = roomR_per_band[k];
      roomR_per_band = padded;
    }
  }
  // Phase 3 (Dr. Chen 2026-05-25): classify every source ONCE per
  // heatmap rebuild and build the coupling table for EXTERIOR ones.
  // Replaces the outdoor-only inline `isSourceInside = src =>
  // isInsideRoom3D(src.position, room)` predicate — the classifier is
  // now the single source of truth for source membership AND it gives
  // the per-band C_couple table the reverb-leak loop needs. INDOOR
  // gets the same plumbing (Dr. Chen's whole point — symmetric
  // treatment of the surau-style geometry whether the user is in
  // outdoor or indoor mode). Pass-through when room is missing.
  const cls = _buildSourceClassifications(sources, room, materials);
  const isSourceInside = cls?.isSourceInside ?? null;
  const exteriorCouplings = cls?.couplings ?? null;

  // Hoist the SPL context OUT of the cell loop (was rebuilt per cell via
  // computeMultiSourceSPL — violated the "build context once per frame"
  // contract). We build TWO contexts when reverb is in play: one with the
  // room constant R (interior cells) and one with R=0 (exterior/field
  // cells). The per-source resolution (def lookup, L_w, revConst) differs
  // only by R, so the cost is two cheap context builds, not per-cell. Both
  // carry roomR_per_band so wall re-radiation (the cliff-smoother) is fed
  // for receivers on EITHER side of the wall.
  // Phase A3: pass room+materials+T/RH params so precomputeSPLContext
  // can hoist outdoor-obstacle + overhead-reflector + porch extraction
  // AND pre-compute porch drives ONCE per frame (was per cell — 10k cells
  // × 12 drives per cell = 120k physics-stack evals per heatmap; now 12
  // per heatmap).
  const ctxInside = useSTI ? null : precomputeSPLContext({
    sources, getSpeakerDef, freq_hz, roomConstantR, enableTier1a,
    roomR_per_band, isSourceInside, exteriorCouplings,
    room, materials, temperature_C, airAbsorption, airAbsorptionFn,
  });
  // Field cells (outside the footprint) have no enclosing room → no diffuse
  // reverberant lift → R=0. They DO still receive wall re-radiation, so they
  // keep roomR_per_band. Reuse ctxInside when R is already 0.
  const ctxOutside = useSTI ? null
    : (roomConstantR > 0
        ? precomputeSPLContext({
            sources, getSpeakerDef, freq_hz, roomConstantR: 0, enableTier1a,
            roomR_per_band, isSourceInside, exteriorCouplings,
            room, materials, temperature_C, airAbsorption, airAbsorptionFn,
          })
        : ctxInside);

  const evalOpts = { room, materials, coherent, temperature_C, airAbsorption, airAbsorptionFn, furniture, furnitureCatalogue, racks, rackCatalogue, structures, structureMaterials };

  // Phase 7 (Dr. Chen audit 2026-05-23): cells inside the PARENT footprint
  // but in the WALL-THICKNESS annulus (between outer + inner polygons) are
  // physically wall, not room interior. Before this fix they were getting
  // `isInsideRoom3D = true` → ctxInside → full 4/R reverberant lift →
  // a non-physical RED ring at wall-thickness-distance from the outer face
  // (the user-spotted "yellow → red → yellow" anomaly past the surau west
  // wall). Resolve by computing the parent inner polygon ONCE per grid
  // rebuild; per-cell ray-cast point-in-polygon costs ~6n ops on a 4-vert
  // rectangle (negligible). Sub-structures / enclosures / podium routes in
  // isInsideRoom3D are NOT subject to this — only the parent footprint's
  // own annulus is in scope.
  const insetInfo = room ? wallInsetPolygon(room) : null;
  const parentOuter = insetInfo?.outer || null;
  const parentInner = insetInfo?.inner || null;
  const haveInsetMask = Array.isArray(parentOuter) && Array.isArray(parentInner)
    && parentOuter.length >= 3 && parentInner.length === parentOuter.length;
  const pointInPoly = (x, y, verts) => {
    let inside = false;
    const n = verts.length;
    for (let k = 0, m = n - 1; k < n; m = k++) {
      if (((verts[k].y > y) !== (verts[m].y > y)) &&
          (x < (verts[m].x - verts[k].x) * (y - verts[k].y) / (verts[m].y - verts[k].y) + verts[k].x)) {
        inside = !inside;
      }
    }
    return inside;
  };

  const grid = [];
  let minVal = Infinity, maxVal = -Infinity, sum = 0, count = 0;

  for (let j = 0; j < cellsY; j++) {
    const row = [];
    for (let i = 0; i < cellsX; i++) {
      const x = originX_m + (i + 0.5) * cellW_m;
      const y = originY_m + (j + 0.5) * cellD_m;
      const listenerPos = { x, y, z: earHeight_m };
      const inside = isInsideRoom3D(listenerPos, room);
      // INDOOR mode: cells outside the footprint are not measurement
      // points → -Infinity (unchanged behaviour). OUTDOOR mode: KEEP those
      // cells — they're the open field — evaluated with R=0 (free-field).
      if (!inside && !outdoor) {
        row.push(-Infinity);
        continue;
      }
      // Phase 7 (Dr. Chen audit 2026-05-23/24): refine the SPL-context
      // classification using the parent inner + outer polygons.
      //
      // isInsideRoom3D returns TRUE for THREE distinct populations:
      //   1. Cells inside the parent footprint (true interior).
      //   2. Cells in the wall-thickness ANNULUS (between outer + inner
      //      polygon) — physically wall, not measurable air.
      //   3. Cells in OUTDOOR ZONES that the function intentionally
      //      reports inside so the heatmap covers them: the surau podium
      //      (the porch the arcade roof sits on), standaloneEnclosures,
      //      etc. Acoustically these are OUTDOOR — they must not inherit
      //      the building's interior 4/R reverberant lift.
      //
      // Before this fix all three populations went through ctxInside,
      // producing two well-defined bugs:
      //   - (2) hot ring of cells at wall-thickness distance from the
      //         outer face (user-spotted on west wall, fixed in C4).
      //   - (3) the surau arcade corridor reading ~6 dB HIGHER than the
      //         uncovered corridor next to it (user-spotted 2026-05-24).
      //         The roof material is irrelevant — the heatmap doesn't
      //         trace reflections off it — the lift comes entirely from
      //         the prayer hall's reverberant tail being attributed to
      //         the outdoor porch.
      //
      // New classification:
      //   inside parent outer ∧ inside parent inner  → ctxInside
      //   inside parent outer ∧ outside parent inner → -Infinity (wall)
      //   outside parent outer ∧ inside-via-podium/enclosure → ctxOutside
      let cellInTrueInterior;
      if (haveInsetMask) {
        const inOuter = pointInPoly(x, y, parentOuter);
        if (inOuter && !pointInPoly(x, y, parentInner)) {
          row.push(-Infinity);
          continue;
        }
        cellInTrueInterior = inOuter;
      } else {
        // Legacy / unsupported geometry — fall back to the original flag.
        cellInTrueInterior = inside;
      }
      let v;
      if (useSTI) {
        v = computeSTIPAAt(stipaCtx, listenerPos, ambient_per_band);
      } else {
        const ctx = cellInTrueInterior ? ctxInside : ctxOutside;
        v = computeMultiSourceSPLFromContext(ctx, listenerPos, evalOpts);
      }
      row.push(v);
      if (isFinite(v)) {
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
        sum += v;
        count++;
      }
    }
    grid.push(row);
  }

  const hasResults = count > 0;
  return {
    grid, cellsX, cellsY, cellW_m, cellD_m,
    // Origin of the (0,0) cell in state coords. Defaults to (0,0) for
    // legacy callers that were ignoring it; new callers that care about
    // post-merge geometry use these to position the heatmap cells.
    originX_m, originY_m,
    metric: useSTI ? 'sti' : 'spl',
    minSPL_db: hasResults ? minVal : 0,
    maxSPL_db: hasResults ? maxVal : 0,
    avgSPL_db: hasResults ? sum / count : 0,
    uniformity_db: hasResults ? (maxVal - minVal) : 0,
    freq_hz, earHeight_m,
    sourceCount: sources.length,
    outdoor,
  };
}
