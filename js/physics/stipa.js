import { airAbsorptionAt, computeRoomConstant, localAngles } from './spl-calculator.js';
import { computeRT60Band } from './rt60.js';
import { interpolateAttenuation } from './loudspeaker.js';

// --- STIPA — Speech Transmission Index for Public Address, per IEC
// 60268-16:2011 Annex C (simplified STIPA version of the full STI).
// Returns a single 0..1 intelligibility scalar plus per-band transmission
// indices and a human-readable rating. Used to answer "at this listener
// position, can you understand a PA announcement?"
//
// Algorithm summary:
//   1. For each of 7 octave bands (125–8000 Hz):
//      • compute RT60 (Sabine) from room + materials
//      • compute signal SPL at the listener (direct field from speakers)
//      • SNR_k = signal_k − ambient_noise_k
//      • For each of 2 STIPA modulation frequencies f_m:
//          m(k, f_m) = reverb_term · noise_term
//            reverb_term = 1 / sqrt(1 + (2π f_m T_k / 13.8)²)
//            noise_term  = 1 / (1 + 10^(-SNR_k/10))
//      • Apparent SNR per band: SNR_app = 10·log10(m̄ / (1 − m̄))
//        (m̄ = mean of the 2 MTF values), clamped to [−15, 15] dB
//      • TI_k = (SNR_app + 15) / 30, clamped to [0, 1]
//   2. Weighted STI = Σ α_k · TI_k − Σ β_k · √(TI_k · TI_{k+1})   (male)
//   3. Clamp STI to [0, 1], map to 5-tier rating.

export const STIPA_BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];

// STIPA modulation frequencies — IEC 60268-16 Annex C Table C.2.
// Each octave band has TWO modulation frequencies; the test signal
// modulates the octave band's noise carrier at these rates.
export const STIPA_MOD_FREQS = {
  125:  [1.60, 8.00],
  250:  [1.00, 5.00],
  500:  [0.63, 3.15],
  1000: [2.00, 10.00],
  2000: [1.25, 6.25],
  4000: [0.80, 4.00],
  8000: [2.50, 12.50],
};

// Male speech weighting — IEC 60268-16 Annex A Table A.3 (male).
// α sums to 1.381; β corrects for inter-band redundancy via the
// Σ β_k · √(TI_k · TI_{k+1}) term, so β has ONE FEWER entry than α
// (6 adjacent-band pairs across 7 bands).
const STI_ALPHA_MALE = [0.085, 0.127, 0.230, 0.233, 0.309, 0.224, 0.173];
const STI_BETA_MALE  = [0.085, 0.078, 0.065, 0.011, 0.047, 0.095];   // length 6

// Apparent SNR clamp range per IEC 60268-16.
const SNR_APP_CLAMP = 15;

// Default ambient noise profile — NC-35 (Noise Criterion 35), a reasonable
// "quiet venue with HVAC running" assumption. Flat 40 dB was too
// optimistic at low freq / too pessimistic at high freq. Per-band values
// for 125/250/500/1k/2k/4k/8k Hz:
const NC_35_PER_BAND = [55, 50, 45, 40, 36, 34, 33];

/**
 * Compute STIPA at a listener position.
 *
 * @param {object} opts
 * @param {Array}  opts.sources              Expanded (flat) sources
 * @param {(url:string)=>any} opts.getSpeakerDef
 * @param {{x,y,z}} opts.listenerPos
 * @param {object} opts.room                 Room (for wall checks + RT60 surfaces)
 * @param {object} opts.materials            Material DB for RT60
 * @param {number[]} [opts.ambientNoise_per_band] Per-band ambient SPL dB.
 *                                                Defaults to NC-35 curve.
 * @param {number} [opts.temperature_C=20]
 * @returns {{ sti:number, ti_per_band:number[], rating:string, bands:number[],
 *             rt60_per_band:number[], signalSPL_per_band:number[] }}
 */
// Precompute per-frame STIPA context (RT60 per band, room constant R per
// band, per-source L_w and directivity def). Feed this once to
// computeSTIPAAt for each listener position — ~10× faster than calling
// computeSTIPA independently for every vertex of a heatmap surface.
export function precomputeSTIPAContext({ sources, getSpeakerDef, room, materials, zones = [] }) {
  const rt60_per_band = STIPA_BANDS.map(fhz => {
    const bandIdx = materials?.frequency_bands_hz?.indexOf(fhz) ?? -1;
    if (bandIdx < 0) return 0.5;
    return computeRT60Band({ room, materials, bandIndex: bandIdx, zones }).sabine_s;
  });
  const roomR_per_band = STIPA_BANDS.map(fhz =>
    materials ? computeRoomConstant(room, materials, fhz, zones) : 0
  );
  const sourceCtx = [];
  for (const src of sources) {
    const def = getSpeakerDef(src.modelUrl);
    if (!def) continue;
    const sens = def.acoustic.sensitivity_db_1w_1m;
    const DI = def.acoustic.directivity_index_db ?? 3;
    const p10 = 10 * Math.log10(Math.max(1e-6, src.power_watts || 1));
    sourceCtx.push({
      src, def, sens, DI, p10,
      L_w: sens + p10 + 11 - DI,   // flat-across-bands approximation
    });
  }
  return { rt60_per_band, roomR_per_band, sourceCtx };
}

// Sample STIPA at one listener position using the precomputed context.
// Returns just the STI scalar (not the full per-band breakdown) since this
// is called per-vertex at 10k+ samples for heatmap generation.
//
// MTF formulation — direct-to-reverb aware (Bradley 1986, ISO 9921, EASE /
// CATT / ODEON convention):
//     MTF(f_m) = (D + R·m_rev) / (D + R + N)
// where D = direct power sum, R = reverb power sum, N = noise power, and
// m_rev = 1/sqrt(1 + (2π·f_m·T/13.8)²). The direct field is impulse-like
// and preserves modulation (MTF=1 on the direct component); only the
// reverb component is smeared by m_rev. Previously the code computed
//     MTF = m_rev · (D+R)/(D+R+N)
// which applied the reverb smear to the direct field too — that collapses
// to a spatially uniform STI whenever D+R >> N, because the reverb term
// and noise term are both position-independent in a diffuse-field model.
// With the D/R-aware form, positions near sources (D >> R) get MTF ≈ 1
// and STI rises, while reverb-dominated positions still get MTF ≈ m_rev.
export function computeSTIPAAt(stipaCtx, listenerPos, ambientNoise_per_band = NC_35_PER_BAND) {
  const { rt60_per_band, roomR_per_band, sourceCtx } = stipaCtx;
  let sti = 0;
  let prevTi = 0;

  for (let k = 0; k < STIPA_BANDS.length; k++) {
    const fhz = STIPA_BANDS[k];
    const R = roomR_per_band[k];
    let directPower = 0;
    let reverbPower = 0;
    for (let i = 0; i < sourceCtx.length; i++) {
      const s = sourceCtx[i];
      const { r, azimuth_deg, elevation_deg } = localAngles(
        s.src.position, s.src.aim, listenerPos
      );
      const clampedR = r < 0.1 ? 0.1 : r;
      const attn = interpolateAttenuation(s.def.directivity, azimuth_deg, elevation_deg, fhz);
      const airAbs = airAbsorptionAt(fhz) * clampedR;
      const direct_db = s.sens + s.p10 - 20 * Math.log10(clampedR) + attn - airAbs;
      if (isFinite(direct_db)) directPower += Math.pow(10, direct_db / 10);
      if (R > 0) {
        const L_rev = s.L_w + 10 * Math.log10(4 / R);
        reverbPower += Math.pow(10, L_rev / 10);
      }
    }
    const ambient_k = ambientNoise_per_band[k] ?? 40;
    const noisePower = Math.pow(10, ambient_k / 10);
    const denom = directPower + reverbPower + noisePower;
    const T = rt60_per_band[k];

    // MTF mean over the 2 STIPA modulation frequencies for this band.
    const fms = STIPA_MOD_FREQS[fhz];
    const mRev1 = 1 / Math.sqrt(1 + Math.pow(2 * Math.PI * fms[0] * T / 13.8, 2));
    const mRev2 = 1 / Math.sqrt(1 + Math.pow(2 * Math.PI * fms[1] * T / 13.8, 2));
    const mtf1 = (directPower + reverbPower * mRev1) / denom;
    const mtf2 = (directPower + reverbPower * mRev2) / denom;
    const m_mean = (mtf1 + mtf2) / 2;
    const m_safe = m_mean < 0.0001 ? 0.0001 : (m_mean > 0.9999 ? 0.9999 : m_mean);
    const snr_app_raw = 10 * Math.log10(m_safe / (1 - m_safe));
    const snr_app = snr_app_raw < -SNR_APP_CLAMP ? -SNR_APP_CLAMP :
                    (snr_app_raw >  SNR_APP_CLAMP ?  SNR_APP_CLAMP : snr_app_raw);
    const ti_k = (snr_app + SNR_APP_CLAMP) / (2 * SNR_APP_CLAMP);

    sti += STI_ALPHA_MALE[k] * ti_k;
    if (k > 0 && k - 1 < STI_BETA_MALE.length) {
      sti -= STI_BETA_MALE[k - 1] * Math.sqrt(Math.max(0, prevTi * ti_k));
    }
    prevTi = ti_k;
  }
  return sti < 0 ? 0 : (sti > 1 ? 1 : sti);
}

export function computeSTIPA({
  sources, getSpeakerDef, listenerPos, room, materials, zones = [],
  ambientNoise_per_band = NC_35_PER_BAND,
  temperature_C = 20,
}) {
  const ctx = precomputeSTIPAContext({ sources, getSpeakerDef, room, materials, zones });
  const rt60_per_band = ctx.rt60_per_band;
  const roomR_per_band = ctx.roomR_per_band;
  // Split direct and reverb power per band so MTF can apply the reverb-
  // smearing m_rev ONLY to the reverb component (Bradley 1986 / ISO 9921).
  const dr_per_band = STIPA_BANDS.map((fhz, k) => {
    let D = 0, R_p = 0;
    const R = roomR_per_band[k];
    for (const s of ctx.sourceCtx) {
      const { r, azimuth_deg, elevation_deg } = localAngles(
        s.src.position, s.src.aim, listenerPos
      );
      const clampedR = Math.max(r, 0.1);
      const attn = interpolateAttenuation(s.def.directivity, azimuth_deg, elevation_deg, fhz);
      const airAbs = airAbsorptionAt(fhz) * clampedR;
      const direct_db = s.sens + s.p10 - 20 * Math.log10(clampedR) + attn - airAbs;
      if (isFinite(direct_db)) D += Math.pow(10, direct_db / 10);
      if (R > 0) {
        const L_rev = s.L_w + 10 * Math.log10(4 / R);
        R_p += Math.pow(10, L_rev / 10);
      }
    }
    return { D, R: R_p };
  });
  const signalSPL_per_band = dr_per_band.map(({ D, R }) => {
    const total = D + R;
    return total > 0 ? 10 * Math.log10(total) : -Infinity;
  });
  const ti_per_band = STIPA_BANDS.map((fhz, k) => {
    const T = rt60_per_band[k];
    const { D, R } = dr_per_band[k];
    const ambient_k = ambientNoise_per_band[k] ?? 40;
    const noisePower = Math.pow(10, ambient_k / 10);
    const denom = D + R + noisePower;
    if (denom <= 0) return 0;
    const modFreqs = STIPA_MOD_FREQS[fhz];
    const mtf = modFreqs.map(fm => {
      const mRev = 1 / Math.sqrt(1 + Math.pow(2 * Math.PI * fm * T / 13.8, 2));
      return (D + R * mRev) / denom;
    });
    const m_mean = (mtf[0] + mtf[1]) / 2;
    const m_safe = Math.max(0.0001, Math.min(0.9999, m_mean));
    const snr_app_raw = 10 * Math.log10(m_safe / (1 - m_safe));
    const snr_app = Math.max(-SNR_APP_CLAMP, Math.min(SNR_APP_CLAMP, snr_app_raw));
    return (snr_app + SNR_APP_CLAMP) / (2 * SNR_APP_CLAMP);
  });
  let sti = 0;
  for (let k = 0; k < STIPA_BANDS.length; k++) sti += STI_ALPHA_MALE[k] * ti_per_band[k];
  for (let k = 0; k < STI_BETA_MALE.length; k++) {
    sti -= STI_BETA_MALE[k] * Math.sqrt(Math.max(0, ti_per_band[k] * ti_per_band[k + 1]));
  }
  sti = Math.max(0, Math.min(1, sti));
  return {
    sti, ti_per_band, rating: stipaRating(sti),
    bands: STIPA_BANDS, rt60_per_band, signalSPL_per_band, ambientNoise_per_band,
  };
}

// Map a 0..1 STI value to the IEC 60268-16 5-tier intelligibility rating.
export function stipaRating(sti) {
  if (sti < 0.30) return 'bad';
  if (sti < 0.45) return 'poor';
  if (sti < 0.60) return 'fair';
  if (sti < 0.75) return 'good';
  return 'excellent';
}
