// Regression: coherent summation must be SPACING-AWARE (octave-band partial
// coherence), not an all-or-nothing phasor sum.
//
// Bug (Dr. Chen P2, 2026-05-29): with coherent=true the engine did a naive
// |Σ Aᵢ·e^{jφᵢ}|² across all sources, producing unphysical interference fringes
// above ~500 Hz for spatially SEPARATED sources. A blanket "incoherent above
// 500 Hz" cutoff would be wrong the other way — co-located sources (Δr=0) stay
// coherent at ALL frequencies and must still gain +6 dB.
//
// Fix (partialCoherentPower): per source-pair magnitude coherence
//   γ(Δr) = |sinc(0.707·π·Δr/λ)|  (octave-band cross-correlation envelope).
// γ=1 at Δr=0 → full +6 dB; γ→0 for separated HF sources → incoherent +3 dB.
//
// Run: node tests/coherent-decorrelation.test.mjs

import { computeMultiSourceSPL } from '../js/physics/spl-calculator.js';

let failed = 0;
function assert(cond, label) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; }

// Flat-response omni-ish speaker at the bands we probe.
const flatGrid = [[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]];
const speaker = {
  acoustic: { sensitivity_db_1w_1m: 92, directivity_index_db: 8 },
  directivity: {
    azimuth_deg: [-180,-90,0,90,180], elevation_deg: [-90,0,90],
    attenuation_db: { '1000': flatGrid, '2000': flatGrid, '4000': flatGrid },
  },
};
const gsd = () => speaker;
const spl = (sources, listenerPos, freq_hz, coherent) =>
  computeMultiSourceSPL({ sources, getSpeakerDef: gsd, listenerPos, freq_hz, coherent });

// --- 1. Co-located sources stay fully coherent at ALL frequencies (+6 dB) ---
{
  const A = { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
  const B = { modelUrl: 'x', position: { x: 0, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
  const L = { x: 0, y: 1, z: 0 };
  for (const f of [1000, 2000, 4000]) {
    const single = spl([A], L, f, false);
    const coh = spl([A, B], L, f, true);
    const lift = coh - single;
    assert(Math.abs(lift - 6) < 0.1, `co-located coherent @ ${f}Hz = +6 dB (got +${lift.toFixed(2)})`);
  }
}

// --- 2. Separated sources decorrelate at HF → coherent ≈ incoherent ----------
// Two sources 2 m apart; an OFF-axis listener so the path difference Δr ≠ 0.
{
  const A = { modelUrl: 'x', position: { x: -1, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
  const B = { modelUrl: 'x', position: { x: 1, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
  const L = { x: 0.37, y: 3, z: 0 };
  for (const f of [2000, 4000]) {
    const inc = spl([A, B], L, f, false);
    const coh = spl([A, B], L, f, true);
    // Dr. Chen's acceptance: at 2 kHz+ for 2 m spacing the fringe is suppressed
    // — coherent must land within 1 dB of incoherent (no unphysical ±6 dB fringe).
    assert(Math.abs(coh - inc) < 1.0,
      `separated 2 m @ ${f}Hz: coherent ≈ incoherent within 1 dB (coh=${coh.toFixed(2)}, inc=${inc.toFixed(2)}, Δ=${(coh - inc).toFixed(2)})`);
  }
}

// --- 3. Separated sources at LF retain partial coherence (NOT forced equal) --
// At 1 kHz with sub-wavelength-ish geometry the cross-term survives, so the
// coherent result deviates from incoherent (interference is real here). This
// guards against a blanket cutoff that would kill ALL coherence above 500 Hz.
{
  const A = { modelUrl: 'x', position: { x: -0.1, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
  const B = { modelUrl: 'x', position: { x: 0.1, y: 0, z: 0 }, aim: { yaw: 0, pitch: 0 }, power_watts: 1 };
  const L = { x: 0, y: 1, z: 0 };   // near-equidistant → Δr ≈ 0 → still coherent
  const single = spl([A], L, 1000, false);
  const coh = spl([A, B], L, 1000, true);
  const lift = coh - single;
  assert(lift > 4.5,
    `closely-spaced (0.2 m) @ 1kHz retains strong coherence (lift +${lift.toFixed(2)} dB > +4.5, not collapsed to +3)`);
}

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll coherent-decorrelation tests passed.');
