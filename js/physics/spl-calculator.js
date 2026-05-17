import { interpolateAttenuation } from './loudspeaker.js';
import { isInsideRoom3D, wallPerimeter, baseArea, ceilingArea, roomEffectiveBounds } from './room-shape.js';
import { computeRT60Band } from './rt60.js';
import {
  AIR_ABSORPTION_DB_PER_M as AIR_ABS_TABLE,
  airAbsorptionDbPerM, airSabins,
} from './air-absorption.js';
import {
  wallsCrossedByPath, transmissionLossDb, bandIndexForFreq,
} from './wall-path.js';
import {
  computeDiffractionContributions, computeCornerDiffractionContributions,
} from './diffraction.js';
import {
  computeReradiationContributions, computeReverberantInsideSPL,
} from './reradiation.js';
import { PHYSICS_P1_5_ENABLED } from './feature-flags.js';

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
export function computeRoomConstant(room, materials, freq_hz, zones = [], { airAbsorption = true, treatments = [] } = {}) {
  if (!materials?.frequency_bands_hz) return 0;
  const bandIdx = materials.frequency_bands_hz.indexOf(freq_hz);
  if (bandIdx < 0) return 0;
  const rt = computeRT60Band({ room, materials, bandIndex: bandIdx, zones, treatments, airAbsorption });
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

export function computeDirectSPL({ speakerDef, speakerState, listenerPos, freq_hz = 1000, room = null, materials = null, airAbsorption = true, eqGainDb = 0 }) {
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
  // Air absorption (ISO 9613-1) — negligible at 1 kHz short range, significant
  // at 4+ kHz / long range. Pre-scaled α (dB / m) × distance.
  if (airAbsorption) {
    spl_db -= airAbsorptionAt(freq_hz) * clampedR;
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
  return {
    r, azimuth_deg, elevation_deg, attn_db: attn, spl_db,
    through_wall,
    wallsCrossed: tl.wallsCrossed,
    tl_db_applied: tl.tl_db,
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
  eqGainDb = 0,
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
    sourceCtx.push({ src, def, L_w_with_eq });
  }
  // Per-band reverberant SPL inside the room — listener-independent,
  // computed once per frame. Drives the Kuttruff wall re-radiation
  // term in computeMultiSourceSPLFromContext. Per-band array (not
  // per-active-frequency) per the Tier 1a "per-band always" decision:
  // future per-band UI + STIPA both need all 7 values.
  let L_p_rev_inside_per_band = null;
  if (PHYSICS_P1_5_ENABLED && Array.isArray(roomR_per_band) && roomR_per_band.length === 7) {
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
  return {
    sourceCtx, freq_hz, roomConstantR, reverbActive, revConst_db, eqGainDb,
    L_p_rev_inside_per_band,
  };
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
} = {}) {
  const { sourceCtx, freq_hz, reverbActive, revConst_db, eqGainDb, L_p_rev_inside_per_band } = ctx;
  let directPressureSum = 0;
  let Re = 0, Im = 0;
  const c = coherent ? speedOfSound(temperature_C) : 0;
  const angFreq = 2 * Math.PI * freq_hz;
  let reverbPowerSum = 0;
  // Tier 1a — diffraction + re-radiation. Both modules early-return
  // zero when PHYSICS_P1_5_ENABLED is false, so this block is a no-op
  // on public deploys. The bandIdx + per-band L_p_rev scalar are resolved
  // once per call (constant across sources).
  const useP15 = PHYSICS_P1_5_ENABLED && materials && room;
  const bandIdx = useP15 ? bandIndexForFreq(materials, freq_hz) : -1;
  const L_p_rev_inside_band_db = (useP15 && L_p_rev_inside_per_band)
    ? L_p_rev_inside_per_band[bandIdx]
    : -Infinity;
  let diffractionPowerSum = 0;
  let reradiationPowerSum = 0;

  for (let i = 0; i < sourceCtx.length; i++) {
    const { src, def, L_w_with_eq } = sourceCtx[i];
    const d = computeDirectSPL({
      speakerDef: def, speakerState: src, listenerPos,
      freq_hz, room, materials, airAbsorption, eqGainDb,
    });
    const spl_db = d.spl_db;
    if (!isFinite(spl_db)) continue;
    if (coherent) {
      const A = Math.pow(10, spl_db / 20);
      const phase = angFreq * d.r / c;
      Re += A * Math.cos(phase);
      Im += A * Math.sin(phase);
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
      const L_w = L_w_with_eq - d.tl_db_applied;
      const L_rev = L_w + revConst_db;
      reverbPowerSum += Math.pow(10, L_rev / 10);
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
      const diff = computeDiffractionContributions({
        src, listener: listenerPos, room, wallsCrossed: d.wallsCrossed,
        materials, freq_hz, sourceLpFreeField_db, temperature_C, airAbsorption,
      });
      diffractionPowerSum += diff.totalPower;
      if (Number.isFinite(L_p_rev_inside_band_db)) {
        const rerad = computeReradiationContributions({
          src, listener: listenerPos, room, wallsCrossed: d.wallsCrossed,
          materials, freq_hz,
          L_p_rev_inside_band_db,
          airAbsorption,
        });
        reradiationPowerSum += rerad.totalPower;
      }
    }
    // Pierce-Hadden wedge diffraction around outdoor vertical building
    // corners — gates on its own shadow test (cornerIsInShadowPath),
    // independent of wallsCrossed. The corner-bend path goes AROUND
    // the building, not through any wall, so a listener can be in a
    // corner's shadow without the direct path crossing any wall.
    if (useP15) {
      const sourceLpFreeField_db = spl_db + d.tl_db_applied;
      const corner = computeCornerDiffractionContributions({
        src, listener: listenerPos, room,
        materials, freq_hz, sourceLpFreeField_db,
        temperature_C, airAbsorption,
      });
      diffractionPowerSum += corner.totalPower;
    }
  }
  const totalPower = (coherent ? (Re * Re + Im * Im) : directPressureSum)
                   + reverbPowerSum + diffractionPowerSum + reradiationPowerSum;
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
}) {
  // One-shot helper: build a context and evaluate at this listener.
  // Callers with many listeners against the same source set should use
  // `precomputeSPLContext` + `computeMultiSourceSPLFromContext` directly
  // to avoid redoing the per-source resolution on every vertex.
  const ctx = precomputeSPLContext({
    sources, getSpeakerDef, freq_hz, roomConstantR,
    roomR_per_band, isSourceInside, eqGainDb,
  });
  return computeMultiSourceSPLFromContext(ctx, listenerPos, {
    room, materials, coherent, temperature_C, airAbsorption,
  });
}

export function computeListenerBreakdown({
  sources, getSpeakerDef, listenerPos,
  freq_hz = 1000, room = null, materials = null,
  roomConstantR = 0, airAbsorption = true,
}) {
  const perSpeaker = sources.map((src, i) => {
    const def = getSpeakerDef(src.modelUrl);
    const outsideRoom = room ? !isInsideRoom3D(src.position, room) : false;
    if (!def) return { idx: i, spl_db: -Infinity, r: null, azimuth_deg: null, modelUrl: src.modelUrl, outsideRoom, through_wall: false, tl_db_applied: 0 };
    const d = computeDirectSPL({ speakerDef: def, speakerState: src, listenerPos, freq_hz, room, materials, airAbsorption });
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
  let reverb_db = -Infinity;
  if (roomConstantR > 0) {
    let reverbSum = 0;
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const def = getSpeakerDef(src.modelUrl);
      if (!def) continue;
      const tl = pathWallLossDb(src.position, listenerPos, room, materials, freq_hz);
      const L_w = approxSoundPowerLevel(def, src.power_watts) - tl.tl_db;
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
  const cellW = (maxX - minX) / gridSize;
  const cellH = (maxY - minY) / gridSize;
  const grid = [];
  let minVal = Infinity, maxVal = -Infinity, sum = 0, count = 0;
  const earZ = (zone.elevation_m || 0) + earAbove_m;
  for (let j = 0; j < gridSize; j++) {
    const row = [];
    for (let i = 0; i < gridSize; i++) {
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
    grid, cellsX: gridSize, cellsY: gridSize,
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
}) {
  const useSTI = metric === 'sti' && stipaCtx && computeSTIPAAt;
  const cellsX = gridSize;
  const cellsY = gridSize;
  // Sample over the union of the parent footprint AND every broken-out
  // enclosure — a hut placed adjacent to the parent (so its interior
  // sits past room.width_m or before x=0) was being missed by the grid
  // because the grid origin/extent assumed (0,0)..(width_m, depth_m).
  // originX/Y get returned alongside cellW_m/cellD_m so the heatmap
  // renderer can place the cells at the correct world coords.
  const bounds = roomEffectiveBounds(room);
  const totalW = Math.max(1e-3, bounds.maxX - bounds.minX);
  const totalD = Math.max(1e-3, bounds.maxY - bounds.minY);
  const cellW_m = totalW / cellsX;
  const cellD_m = totalD / cellsY;
  const originX_m = bounds.minX;
  const originY_m = bounds.minY;
  const grid = [];
  let minVal = Infinity, maxVal = -Infinity, sum = 0, count = 0;

  for (let j = 0; j < cellsY; j++) {
    const row = [];
    for (let i = 0; i < cellsX; i++) {
      const x = originX_m + (i + 0.5) * cellW_m;
      const y = originY_m + (j + 0.5) * cellD_m;
      const listenerPos = { x, y, z: earHeight_m };
      if (!isInsideRoom3D(listenerPos, room)) {
        row.push(-Infinity);
        continue;
      }
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
  };
}
