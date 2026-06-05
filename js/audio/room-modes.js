// Audio-side room modal synthesis — the Web Audio biquad bank.
//
// The MODAL PHYSICS (eigenfrequencies, cos·cos·cos mode shapes, Q from T60)
// moved to js/physics/room-modes.js on 2026-06-05 so it can be shared by the
// low-frequency heatmap modal field. This module now owns ONLY the audio graph
// concern: turning the computed mode list into a chain of BiquadFilterNodes.
// computeRectangularModes is re-exported here so existing audition.js imports
// (`from './room-modes.js'`) keep working unchanged.
//
// Why modal synthesis exists for auralization: geometric ray tracing fails
// below the Schroeder frequency because a real small room behaves wave-
// acoustically there — a sparse set of resonances, not smooth statistical
// decay. This bank of peaking filters tuned to the eigenfrequencies restores
// the modal "boom is at one note" character. Rectangular rooms only.

export { computeRectangularModes } from '../physics/room-modes.js';

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
