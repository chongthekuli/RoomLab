import { interpolateAttenuation } from './loudspeaker.js';
import { isInsideRoom3D, wallPerimeter, baseArea, ceilingArea } from './room-shape.js';

export const WALL_TRANSMISSION_LOSS_DB = 30;

// Speed of sound in dry air as a function of temperature (°C). Default
// 20 °C → 343.2 m/s. Over 30 m at 4 kHz a ±2 °C swing shifts phase by ~1.5
// wavelengths, so we wire this to a configurable constant for coherent
// summation accuracy.
export const DEFAULT_TEMPERATURE_C = 20;
export function speedOfSound(T_C = DEFAULT_TEMPERATURE_C) {
  return 331.3 * Math.sqrt(1 + T_C / 273.15);
}

// ISO 9613-1:1993 Annex A Table 1 — atmospheric absorption α (dB / m) at
// 20 °C, 50 % RH, 101.325 kPa, at standard octave bands. These are the
// reference-condition values; for non-standard T/RH/pressure the full
// ISO formula (O2 + N2 relaxation + classical term) can be plugged in
// later. 8 kHz extrapolated log-linearly from the 4 kHz value.
export const AIR_ABSORPTION_DB_PER_M = {
  125:  0.00038,
  250:  0.00108,
  500:  0.00244,
  1000: 0.00487,
  2000: 0.01154,
  4000: 0.03751,
  8000: 0.10200,
};

// Log-linear interpolation between known bands for any frequency in range.
export function airAbsorptionAt(freq_hz) {
  const v = AIR_ABSORPTION_DB_PER_M[freq_hz];
  if (v != null) return v;
  const bands = [125, 250, 500, 1000, 2000, 4000, 8000];
  if (freq_hz <= bands[0]) return AIR_ABSORPTION_DB_PER_M[bands[0]];
  if (freq_hz >= bands[bands.length - 1]) return AIR_ABSORPTION_DB_PER_M[bands[bands.length - 1]];
  for (let i = 0; i < bands.length - 1; i++) {
    const f0 = bands[i], f1 = bands[i + 1];
    if (freq_hz >= f0 && freq_hz <= f1) {
      const t = Math.log(freq_hz / f0) / Math.log(f1 / f0);
      const a0 = AIR_ABSORPTION_DB_PER_M[f0];
      const a1 = AIR_ABSORPTION_DB_PER_M[f1];
      return a0 + t * (a1 - a0);
    }
  }
  return 0;
}

// Hopkins-Stryker room constant R = S · α̅ / (1 − α̅) at the given octave
// band. Used to combine direct SPL with the diffuse reverberant field.
// Needs the materials database so it can resolve each surface's absorption.
export function computeRoomConstant(room, materials, freq_hz) {
  const bandIdx = materials?.frequency_bands_hz?.indexOf(freq_hz) ?? -1;
  if (bandIdx < 0) return 0;
  const surf = room.surfaces ?? {};
  const alphaFor = id => materials.byId[id]?.absorption[bandIdx] ?? 0;
  const wallId = surf.walls ?? surf.wall_north ?? 'gypsum-board';
  const S_walls   = wallPerimeter(room) * (room.height_m ?? 0);
  const S_floor   = baseArea(room);
  const S_ceiling = ceilingArea(room);
  const S_total = S_walls + S_floor + S_ceiling;
  if (S_total <= 0) return 0;
  // Weighted mean absorption.
  const alpha_bar = (
    S_walls * alphaFor(wallId) +
    S_floor * alphaFor(surf.floor) +
    S_ceiling * alphaFor(surf.ceiling)
  ) / S_total;
  // Numerically-safe cap. Fully-absorbing room → no reverberant field.
  if (alpha_bar >= 0.995) return 1e9;
  return S_total * alpha_bar / (1 - alpha_bar);
}

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

export function computeDirectSPL({ speakerDef, speakerState, listenerPos, freq_hz = 1000, room = null, airAbsorption = true }) {
  const { r, azimuth_deg, elevation_deg } = localAngles(
    speakerState.position, speakerState.aim, listenerPos
  );
  const clampedR = Math.max(r, 0.1);
  const sens = speakerDef.acoustic.sensitivity_db_1w_1m;
  const attn = interpolateAttenuation(speakerDef.directivity, azimuth_deg, elevation_deg, freq_hz);
  let spl_db = sens + 10 * Math.log10(speakerState.power_watts) - 20 * Math.log10(clampedR) + attn;
  // Air absorption (ISO 9613-1) — negligible at 1 kHz short range, significant
  // at 4+ kHz / long range. Pre-scaled α (dB / m) × distance.
  if (airAbsorption) {
    spl_db -= airAbsorptionAt(freq_hz) * clampedR;
  }
  const through_wall = pathCrossesBoundary(speakerState, listenerPos, room);
  if (through_wall) spl_db -= WALL_TRANSMISSION_LOSS_DB;
  return { r, azimuth_deg, elevation_deg, attn_db: attn, spl_db, through_wall };
}

// Approximate sound power level from on-axis sensitivity + input power.
// Assumes roughly spherical radiation — the +11 dB offset converts 1-m SPL
// on-axis to PWL for an omnidirectional source; directional sources with
// Q > 1 will over-estimate L_w slightly, under-estimating reverberant lift.
function approxSoundPowerLevel(speakerDef, power_watts) {
  const sens = speakerDef.acoustic.sensitivity_db_1w_1m;
  return sens + 10 * Math.log10(power_watts) + 11;
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
export function computeMultiSourceSPL({
  sources, getSpeakerDef, listenerPos,
  freq_hz = 1000, room = null,
  roomConstantR = 0,
  coherent = false,
  temperature_C = DEFAULT_TEMPERATURE_C,
  airAbsorption = true,
}) {
  // Direct field — either incoherent (pressure²) or coherent (complex).
  // Both paths work in units of p_ref (20 µPa) so the final 10·log10 converts
  // directly back to SPL in dB: A = 10^(L/20), |p|² = Re² + Im² is already
  // in p_ref² units, 10·log10 recovers dB.
  let directPressureSum = 0;        // incoherent Σ 10^(L/10)
  let Re = 0, Im = 0;               // coherent real/imag amplitude in p_ref units
  const c = coherent ? speedOfSound(temperature_C) : 0;
  const angFreq = 2 * Math.PI * freq_hz;
  const reverbPower_sum = [];       // per-source diffuse contribution (p_ref² units)

  for (const src of sources) {
    const def = getSpeakerDef(src.modelUrl);
    if (!def) continue;
    const d = computeDirectSPL({
      speakerDef: def, speakerState: src, listenerPos, freq_hz, room, airAbsorption,
    });
    const spl_db = d.spl_db;
    if (!isFinite(spl_db)) continue;
    if (coherent) {
      // Pressure amplitude (re p_ref) and phase at the listener.
      const A = Math.pow(10, spl_db / 20);
      const phase = angFreq * d.r / c;
      Re += A * Math.cos(phase);
      Im += A * Math.sin(phase);
    } else {
      directPressureSum += Math.pow(10, spl_db / 10);
    }
    if (roomConstantR > 0) {
      // Diffuse reverberant field is spatially uniform for a given source;
      // add one term per source, independent of listener position.
      let L_w = approxSoundPowerLevel(def, src.power_watts);
      if (d.through_wall) L_w -= WALL_TRANSMISSION_LOSS_DB;
      const L_rev = L_w + 10 * Math.log10(4 / roomConstantR);
      reverbPower_sum.push(Math.pow(10, L_rev / 10));
    }
  }

  let totalPower = coherent ? (Re * Re + Im * Im) : directPressureSum;
  for (const rp of reverbPower_sum) totalPower += rp;

  return totalPower > 0 ? 10 * Math.log10(totalPower) : -Infinity;
}

export function computeListenerBreakdown({
  sources, getSpeakerDef, listenerPos,
  freq_hz = 1000, room = null,
  roomConstantR = 0, airAbsorption = true,
}) {
  const perSpeaker = sources.map((src, i) => {
    const def = getSpeakerDef(src.modelUrl);
    const outsideRoom = room ? !isInsideRoom3D(src.position, room) : false;
    if (!def) return { idx: i, spl_db: -Infinity, r: null, azimuth_deg: null, modelUrl: src.modelUrl, outsideRoom, through_wall: false };
    const d = computeDirectSPL({ speakerDef: def, speakerState: src, listenerPos, freq_hz, room, airAbsorption });
    return { idx: i, spl_db: d.spl_db, r: d.r, azimuth_deg: d.azimuth_deg, modelUrl: src.modelUrl, outsideRoom, through_wall: d.through_wall };
  });
  // Direct pressure² sum.
  let pressureSum = 0;
  for (const p of perSpeaker) if (isFinite(p.spl_db)) pressureSum += Math.pow(10, p.spl_db / 10);
  // Diffuse reverberant contribution per source (added incoherently).
  let reverb_db = -Infinity;
  if (roomConstantR > 0) {
    let reverbSum = 0;
    for (const src of sources) {
      const def = getSpeakerDef(src.modelUrl);
      if (!def) continue;
      let L_w = approxSoundPowerLevel(def, src.power_watts);
      const through_wall = room ? (!isInsideRoom3D(src.position, room)) : false;
      if (through_wall) L_w -= WALL_TRANSMISSION_LOSS_DB;
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

export function computeZoneSPLGrid({
  zone, sources, getSpeakerDef, room,
  gridSize = 22, freq_hz = 1000, earAbove_m = 1.2,
  roomConstantR = 0, coherent = false, airAbsorption = true,
}) {
  const verts = zone.vertices || [];
  if (verts.length < 3) return null;
  const xs = verts.map(v => v.x), ys = verts.map(v => v.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cellW = (maxX - minX) / gridSize;
  const cellH = (maxY - minY) / gridSize;
  const grid = [];
  let minSPL = Infinity, maxSPL = -Infinity, sum = 0, count = 0;
  const earZ = (zone.elevation_m || 0) + earAbove_m;
  for (let j = 0; j < gridSize; j++) {
    const row = [];
    for (let i = 0; i < gridSize; i++) {
      const x = minX + (i + 0.5) * cellW;
      const y = minY + (j + 0.5) * cellH;
      if (!pointInPoly(x, y, verts)) { row.push(-Infinity); continue; }
      const listenerPos = { x, y, z: earZ };
      const spl = computeMultiSourceSPL({
        sources, getSpeakerDef, listenerPos, freq_hz, room,
        roomConstantR, coherent, airAbsorption,
      });
      row.push(spl);
      if (isFinite(spl)) {
        if (spl < minSPL) minSPL = spl;
        if (spl > maxSPL) maxSPL = spl;
        sum += spl;
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
    minSPL_db: ok ? minSPL : 0,
    maxSPL_db: ok ? maxSPL : 0,
    avgSPL_db: ok ? sum / count : 0,
    uniformity_db: ok ? (maxSPL - minSPL) : 0,
  };
}

export function computeSPLGrid({
  sources, getSpeakerDef, room,
  earHeight_m = 1.2, gridSize = 25, freq_hz = 1000,
  roomConstantR = 0, coherent = false, airAbsorption = true,
}) {
  const cellsX = gridSize;
  const cellsY = gridSize;
  const cellW_m = room.width_m / cellsX;
  const cellD_m = room.depth_m / cellsY;
  const grid = [];
  let minSPL = Infinity, maxSPL = -Infinity, sum = 0, count = 0;

  for (let j = 0; j < cellsY; j++) {
    const row = [];
    for (let i = 0; i < cellsX; i++) {
      const x = (i + 0.5) * cellW_m;
      const y = (j + 0.5) * cellD_m;
      const listenerPos = { x, y, z: earHeight_m };
      if (!isInsideRoom3D(listenerPos, room)) {
        row.push(-Infinity);
        continue;
      }
      const totalSPL = computeMultiSourceSPL({
        sources, getSpeakerDef, listenerPos, freq_hz, room,
        roomConstantR, coherent, airAbsorption,
      });
      row.push(totalSPL);
      if (isFinite(totalSPL)) {
        if (totalSPL < minSPL) minSPL = totalSPL;
        if (totalSPL > maxSPL) maxSPL = totalSPL;
        sum += totalSPL;
        count++;
      }
    }
    grid.push(row);
  }

  const hasResults = count > 0;
  return {
    grid, cellsX, cellsY, cellW_m, cellD_m,
    minSPL_db: hasResults ? minSPL : 0,
    maxSPL_db: hasResults ? maxSPL : 0,
    avgSPL_db: hasResults ? sum / count : 0,
    uniformity_db: hasResults ? (maxSPL - minSPL) : 0,
    freq_hz, earHeight_m,
    sourceCount: sources.length,
  };
}
