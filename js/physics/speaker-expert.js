// Speaker-expert heuristics — plain-English flags and recommendations
// derived from the loudspeaker spec + current venue state. These are not
// physics calculations; they are the sort of rules a live-sound designer
// applies when they pick a box for a room. Use them as "is this cabinet
// a reasonable fit" signals, not as gospel.
//
// Every check returns one of:
//   { kind: 'good',  text }   — green, reassuring
//   { kind: 'info',  text }   — neutral, context
//   { kind: 'warn',  text }   — yellow, should think about
//   { kind: 'bad',   text }   — red, likely wrong

import { interpolateAttenuation } from './loudspeaker.js';

export function analyseSpeaker(def, { room } = {}) {
  if (!def) return [];
  const flags = [];

  // --- Raw-spec sanity ---------------------------------------------------
  const sens = def.acoustic?.sensitivity_db_1w_1m ?? null;
  const pmax = def.electrical?.max_input_watts ?? null;
  const splMax = def.electrical?.max_spl_db ?? null;
  const di = def.acoustic?.directivity_index_db ?? null;
  const range = def.acoustic?.frequency_range_hz ?? null;

  if (sens != null) {
    if (sens >= 98) flags.push({ kind: 'good', text: `High sensitivity ${sens.toFixed(0)} dB @ 1 W / 1 m — efficient, headroom-friendly.` });
    else if (sens < 87) flags.push({ kind: 'warn', text: `Low sensitivity ${sens.toFixed(0)} dB @ 1 W / 1 m — expect ~${(90 - sens).toFixed(0)} dB more amp power vs a typical pro cabinet.` });
  }

  if (pmax != null && sens != null) {
    const theoreticalMax = sens + 10 * Math.log10(pmax);
    if (splMax != null) {
      const gap = Math.abs(splMax - theoreticalMax);
      if (gap > 6) {
        flags.push({
          kind: 'warn',
          text: `Spec mismatch: sensitivity + 10·log₁₀(${pmax} W) = ${theoreticalMax.toFixed(0)} dB but max SPL is ${splMax.toFixed(0)} dB (Δ ${gap.toFixed(0)} dB). Compression/limiter losses aren't in the spec sheet — treat max SPL as the authority.`,
        });
      }
    }
  }

  if (di != null) {
    if (di < 3) flags.push({ kind: 'info', text: `DI ${di.toFixed(1)} dB — near-omni pattern, good for wide-fill, bad for reverberant rooms.` });
    else if (di >= 10) flags.push({ kind: 'info', text: `DI ${di.toFixed(1)} dB — very directional. Longest throw in its class; needs careful aim to cover audience edges.` });
  }

  if (range) {
    const [low, high] = range;
    if (low >= 100) flags.push({ kind: 'info', text: `LF limit ${low} Hz — a subwoofer or LF extension is needed for full-range music.` });
    if (high < 15000) flags.push({ kind: 'warn', text: `HF limit ${high} Hz — air and sibilance detail will be muted vs. a full-range cabinet.` });
  }

  // --- Dispersion shape from directivity grid ----------------------------
  const disp = estimateNominalDispersion(def);
  if (disp) {
    flags.push({
      kind: 'info',
      text: `Nominal −6 dB dispersion at 1 kHz: ${disp.h.toFixed(0)}° H × ${disp.v.toFixed(0)}° V.`,
    });
  }

  // --- Room-specific fit -------------------------------------------------
  if (room) {
    const volume = estimateRoomVolume(room);
    if (volume && splMax != null) {
      // Quick heuristic: need ~95 dB at the far seat for music, ~85 dB for
      // speech. Estimate far throw as longest room dim.
      const farThrow = Math.max(room.width_m ?? 0, room.depth_m ?? 0, room.polygon_radius_m ? 2 * room.polygon_radius_m : 0);
      if (farThrow > 0) {
        const splAtFar = splMax - 20 * Math.log10(Math.max(1, farThrow));
        if (splAtFar < 85) {
          flags.push({ kind: 'warn', text: `Single cabinet: at the far seat (~${farThrow.toFixed(0)} m) max SPL drops to ~${splAtFar.toFixed(0)} dB — below typical 85 dB speech target. Plan for multiple boxes or line arrays.` });
        } else if (splAtFar >= 100) {
          flags.push({ kind: 'good', text: `Plenty of headroom: at the far seat (~${farThrow.toFixed(0)} m) this cabinet still hits ~${splAtFar.toFixed(0)} dB.` });
        }
      }
    }

    // Directivity vs room volume sanity: big reverberant room + low DI = bad STI.
    if (volume && volume > 1000 && di != null && di < 5) {
      flags.push({
        kind: 'bad',
        text: `Wide-pattern cabinet (DI ${di.toFixed(1)} dB) in a ${volume.toFixed(0)} m³ room — expect poor speech intelligibility. Pick a more directional box or a column/line array.`,
      });
    }
  }

  // Always include one positive if nothing else flagged.
  if (!flags.some(f => f.kind === 'good' || f.kind === 'bad' || f.kind === 'warn')) {
    flags.push({ kind: 'good', text: 'No red flags for this cabinet in the current venue.' });
  }

  return flags;
}

// Estimate −6 dB nominal dispersion from the directivity grid at 1 kHz.
// Scans azimuth (H plane at elevation=0) and elevation (V plane at azimuth=0)
// until attenuation drops below −6 dB on both sides of centre, then sums.
export function estimateNominalDispersion(def) {
  const dir = def?.directivity;
  if (!dir || !dir.attenuation_db?.['1000']) return null;
  // H plane — sweep azimuth from 0 outward in both directions, record the
  // first angle where |att| >= 6.
  const azs = dir.azimuth_deg;
  const els = dir.elevation_deg;
  const elIdx0 = els.indexOf(0);
  if (elIdx0 < 0) return null;
  const row = dir.attenuation_db['1000'][elIdx0];

  const hLeft = scanDown6(row, azs, azs.indexOf(0), -1);
  const hRight = scanDown6(row, azs, azs.indexOf(0), +1);

  // V plane — sweep elevation at azimuth=0.
  const azIdx0 = azs.indexOf(0);
  if (azIdx0 < 0) return null;
  const vcol = dir.attenuation_db['1000'].map(r => r[azIdx0]);
  const vUp = scanDown6(vcol, els, els.indexOf(0), +1);
  const vDown = scanDown6(vcol, els, els.indexOf(0), -1);

  const h = (hLeft != null && hRight != null) ? (hRight - hLeft) : null;
  const v = (vUp != null && vDown != null) ? (vUp - vDown) : null;
  if (h == null || v == null) return null;
  return { h: Math.abs(h), v: Math.abs(v) };
}

function scanDown6(values, anglesDeg, fromIdx, dir) {
  if (fromIdx < 0) return null;
  for (let i = fromIdx; i >= 0 && i < values.length; i += dir) {
    if (values[i] <= -6) return anglesDeg[i];
  }
  return anglesDeg[dir > 0 ? values.length - 1 : 0];
}

function estimateRoomVolume(room) {
  if (!room) return null;
  const h = room.height_m ?? 7;
  if (room.shape === 'rectangular') return (room.width_m ?? 0) * (room.depth_m ?? 0) * h;
  if (room.shape === 'polygon') {
    const r = room.polygon_radius_m ?? 10;
    const n = room.polygon_sides ?? 8;
    const area = 0.5 * n * r * r * Math.sin(2 * Math.PI / n);
    return area * h;
  }
  if (room.shape === 'round') {
    const r = room.round_radius_m ?? 10;
    return Math.PI * r * r * h;
  }
  return (room.width_m ?? 10) * (room.depth_m ?? 10) * h;
}

// Broadband frequency response on-axis — for the FR plot. Returns the
// directivity-grid attenuation at (0°, 0°) for every available band
// frequency; a fully-on-axis reading is usually 0 dB (reference), so
// this curve mostly reports sensitivity flatness across bands.
export function onAxisResponseDb(def) {
  const dir = def?.directivity;
  if (!dir) return [];
  const freqs = Object.keys(dir.attenuation_db).map(Number).sort((a, b) => a - b);
  return freqs.map(f => ({
    hz: f,
    db: interpolateAttenuation(dir, 0, 0, f),
  }));
}
