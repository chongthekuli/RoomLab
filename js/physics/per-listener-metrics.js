// Per-listener SPL + STI used by the live 2D viewport and the print
// report's plan / heatmap pages. SPL is the same total computed by the
// listener-results panel (1 kHz, sources + reverb leak per physics
// settings). STI is read from the precision-engine result when one
// exists; null when the user hasn't kicked off a precision render.
//
// Output shape — array indexed in state.listeners order:
//   [{ spl_db: number|null, sti: number|null }, ...]
//
// Pure on its inputs; safe to call on every render (only one
// computeMultiSourceSPL per listener — N sources × N listeners — cheaper
// than the splGrid we already build).

import { earHeightFor, expandSources } from '../app-state.js';
import { computeMultiSourceSPL, computeRoomConstant } from './spl-calculator.js';
import { getCachedLoudspeaker } from './loudspeaker.js';
import { deriveMetrics } from './precision/derive-metrics.js';

export function computePerListenerMetrics(state, materials) {
  const listeners = state.listeners ?? [];
  if (listeners.length === 0) return [];

  const phys = state.physics ?? {};
  const freq = phys.freq_hz ?? 1000;
  const flatSources = expandSources(state.sources ?? []);
  const roomConstantR = (phys.reverberantField && materials)
    ? computeRoomConstant(state.room, materials, freq, state.zones, { treatments: state.treatments })
    : 0;

  // STI lookup — only populated when a precision render exists. Reuses
  // the same deriveMetrics() the precision panel uses so the value on
  // the dot matches the value in the table to two decimals.
  const stiByIdx = new Map();
  const precision = state.results?.precision;
  if (precision && typeof precision === 'object') {
    try {
      const metrics = deriveMetrics(precision, {
        ambientNoise_per_band: phys.ambientNoise?.per_band,
      });
      if (Array.isArray(metrics)) {
        metrics.forEach((m, idx) => {
          if (Number.isFinite(m?.sti?.sti)) stiByIdx.set(idx, m.sti.sti);
        });
      }
    } catch (err) {
      console.warn('[per-listener-metrics] deriveMetrics failed:', err);
    }
  }

  return listeners.map((lst, idx) => {
    let spl_db = null;
    if (flatSources.length > 0) {
      try {
        const ear = earHeightFor(lst);
        const v = computeMultiSourceSPL({
          sources: flatSources,
          getSpeakerDef: url => getCachedLoudspeaker(url),
          listenerPos: { x: lst.position.x, y: lst.position.y, z: ear },
          freq_hz: freq,
          room: state.room,
          materials,
          airAbsorption: phys.airAbsorption !== false,
          coherent: !!phys.coherent,
          roomConstantR,
        });
        if (Number.isFinite(v)) spl_db = v;
      } catch (err) {
        console.warn('[per-listener-metrics] SPL failed for', lst.id, err);
      }
    }
    return { spl_db, sti: stiByIdx.get(idx) ?? null };
  });
}

// Compact "82 · 0.55" / "82 dB" / "STI 0.55" label, or '' when neither
// metric is available. Used by both the live 2D viewport and the print
// SVGs so the formatting stays identical.
export function formatListenerMetricsLabel({ spl_db, sti }, { withUnits = true } = {}) {
  const parts = [];
  if (Number.isFinite(spl_db)) parts.push(withUnits ? `${spl_db.toFixed(0)} dB` : spl_db.toFixed(0));
  if (Number.isFinite(sti)) parts.push(withUnits ? `STI ${sti.toFixed(2)}` : sti.toFixed(2));
  return parts.join(' · ');
}
