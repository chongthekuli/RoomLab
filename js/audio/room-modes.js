// Phase 11.F — Room modal synthesis for rectangular rooms.
//
// Geometric ray tracing fundamentally fails below the Schroeder frequency
// because real small rooms behave WAVE-acoustically there: the field is
// dominated by a sparse set of resonant modes at specific frequencies,
// not the smooth statistical decay the tracer produces. Listening to a
// real small room you hear "the boom is at one note" (e.g. a strong
// resonance at 38 Hz between front and back walls); the simulation
// without modal correction sounds boomy across the band.
//
// This module adds the modal character via a parallel bank of biquad
// peaking filters tuned to the room's eigenfrequencies. Each filter
// emphasises its mode by an amount proportional to mode-source-receiver
// coupling. Inserted into the audition chain only for rectangular rooms;
// other geometries fall back to the geometric IR.
//
// Theory (Kuttruff, Room Acoustics 6th ed §3.2; Mechel, Formulas of
// Acoustics §M.5):
//
//   For a rectangular room of dimensions Lx × Ly × Lz, the eigenmodes
//   are
//     f_{nx,ny,nz} = (c/2) · √((nx/Lx)² + (ny/Ly)² + (nz/Lz)²)
//   for non-negative integers (nx, ny, nz), excluding (0,0,0).
//
//   The mode shape (acoustic pressure pattern) at a point (x, y, z) is
//     ψ_{nx,ny,nz}(x,y,z) = cos(nx·π·x/Lx)·cos(ny·π·y/Ly)·cos(nz·π·z/Lz)
//
//   The transfer function from source to receiver is the sum over all
//   modes of (ψ(source) × ψ(receiver)) / mode resonance pole. Each
//   pole is a 2nd-order resonance — a biquad peak. Damping comes from
//   total room absorption: Q ≈ π·f·T60/ln(10³) = π·f·T60/6.91.

const SPEED_OF_SOUND_M_PER_S = 343.2;
const MAX_MODE_INDEX = 5;
const MAX_MODE_GAIN_DB = 4;          // perceptual cap; +∞ would ring forever
const MAX_FILTERS = 16;              // CPU budget — most rooms have 8–14 modes below f_s

// Compute the list of modes to synthesise for a rectangular room and the
// listener at its position. Returns an array of
//   { freq, Q, gainDb, coupling }
// sorted by descending |coupling|, capped at MAX_FILTERS entries.
//
// Args:
//   width_m, depth_m, height_m — room dimensions (state coords: x = width,
//     y = depth, z = height)
//   sourcePos     — { x, y, z } in state coords
//   listenerPos   — { x, y, z } in state coords
//   t60_s         — broadband T60 from the precision metric (drives Q)
//   schroederHz   — fs = 2000·√(T60/V); modes below ~1.5×fs are kept
//   roomVolume_m3 — for Schroeder calc validation
export function computeRectangularModes({
  width_m, depth_m, height_m, sourcePos, listenerPos,
  t60_s, schroederHz, roomVolume_m3,
}) {
  if (!Number.isFinite(width_m) || !Number.isFinite(depth_m) || !Number.isFinite(height_m)) return [];
  if (width_m <= 0 || depth_m <= 0 || height_m <= 0) return [];
  if (!sourcePos || !listenerPos) return [];
  if (!(t60_s > 0)) return [];
  const cutoffHz = Math.max(60, Math.min(400, schroederHz * 1.5));
  const modes = [];
  for (let nx = 0; nx <= MAX_MODE_INDEX; nx++) {
    for (let ny = 0; ny <= MAX_MODE_INDEX; ny++) {
      for (let nz = 0; nz <= MAX_MODE_INDEX; nz++) {
        if (nx === 0 && ny === 0 && nz === 0) continue;
        const fx = nx / width_m;
        const fy = ny / depth_m;
        const fz = nz / height_m;
        const f = (SPEED_OF_SOUND_M_PER_S / 2) * Math.sqrt(fx * fx + fy * fy + fz * fz);
        if (f > cutoffHz) continue;
        // Mode-shape amplitude at source × at receiver (signed, then |·|
        // for the peak gain magnitude).
        const psi_s = Math.cos((nx * Math.PI * sourcePos.x) / width_m)
                    * Math.cos((ny * Math.PI * sourcePos.y) / depth_m)
                    * Math.cos((nz * Math.PI * sourcePos.z) / height_m);
        const psi_r = Math.cos((nx * Math.PI * listenerPos.x) / width_m)
                    * Math.cos((ny * Math.PI * listenerPos.y) / depth_m)
                    * Math.cos((nz * Math.PI * listenerPos.z) / height_m);
        const coupling = Math.abs(psi_s * psi_r);
        if (coupling < 0.05) continue;     // mode barely excited at these positions
        // Q from T60 (Schroeder 1962 — pole-half-power ≈ 1/(π·f·T60·ln10/3))
        // Cap at 30 to keep filters numerically well-behaved on Float32.
        const Q = Math.min(30, (Math.PI * f * t60_s) / Math.log(1000));
        // Gain proportional to coupling, capped. Modes that dominate
        // physically should also dominate perceptually.
        const gainDb = MAX_MODE_GAIN_DB * coupling;
        modes.push({ freq: f, Q, gainDb, coupling, nx, ny, nz });
      }
    }
  }
  modes.sort((a, b) => b.coupling - a.coupling);
  return modes.slice(0, MAX_FILTERS);
}

// Build a serial chain of BiquadFilterNode 'peaking' filters from the
// computed mode list, returning the input + output ends so the caller
// can splice them into the audio graph. Empty array → returns null.
export function buildModeFilterChain(audioContext, modes) {
  if (!modes || modes.length === 0) return null;
  const nodes = [];
  for (const m of modes) {
    if (!Number.isFinite(m.freq) || m.freq <= 0) continue;
    const f = audioContext.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = m.freq;
    f.Q.value = m.Q;
    f.gain.value = m.gainDb;
    nodes.push(f);
  }
  if (nodes.length === 0) return null;
  // Wire serially.
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return { input: nodes[0], output: nodes[nodes.length - 1], all: nodes };
}
