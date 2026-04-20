// Atmospheric absorption coefficients per ISO 9613-1:1993 Annex A Table 1
// (reference: 20 °C / 50 % RH / 101.325 kPa, dry-ish air). Used by:
//   • SPL propagation — direct-field absorption = airAbsorptionDbPerM(f) · r dB.
//   • RT60 Sabine/Eyring — volumetric air sink adds 4·m·V to the absorption
//     budget, where m is the energy attenuation coefficient in Nepers/m.
//     At 20 °C this becomes a first-order drop in high-frequency RT60 for
//     any large venue (arena 48k m³: 8 kHz RT60 halves vs ignoring 4mV).
//   • Hopkins-Stryker R — same 4mV additive term feeds into the equivalent-
//     absorption area used for the reverberant-field level calculation.
//
// Values at the canonical octave centres; 8 kHz extrapolated log-linearly
// from the 4 kHz value (ISO 9613-1 only tabulates up to 10 kHz).

export const AIR_ABSORPTION_DB_PER_M = {
  125:  0.00038,
  250:  0.00108,
  500:  0.00244,
  1000: 0.00487,
  2000: 0.01154,
  4000: 0.03751,
  8000: 0.10200,
};

// Conversion factor from dB/m to Nepers/m. A decay of 1 dB corresponds to
// an amplitude ratio of 10^(−1/20); expressed in natural log (Nepers) that
// is 1 dB = (ln 10)/20 ≈ 0.1151 Np. For ENERGY attenuation (which is what
// 4mV uses) the factor is doubled: 1 dB = 0.2303 Np_energy. Equivalently,
// m (Np/m for energy) = α_dB/m / (10·log10 e) = α_dB/m / 4.3429.
const NEPERS_PER_DB_ENERGY = 1 / (10 * Math.log10(Math.E));   // ≈ 0.2303

// Log-linear interpolation between the two enclosing bands for any
// frequency in the range; edge-clamp outside.
export function airAbsorptionDbPerM(freq_hz) {
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

// Energy attenuation coefficient (Nepers/m). This is the quantity that
// enters the 4mV term in Sabine/Eyring:  T60 = 0.161·V / (S·α̅ + 4mV).
export function airAbsorptionCoefficient_m(freq_hz) {
  return airAbsorptionDbPerM(freq_hz) * NEPERS_PER_DB_ENERGY;
}

// Convenience: the additive Sabins contribution from air absorption in a
// room of volume V at a given frequency. Returns 0 when air absorption is
// disabled so callers can pass a flag without branching on every call.
export function airSabins(freq_hz, volume_m3, enabled = true) {
  if (!enabled || !(volume_m3 > 0)) return 0;
  return 4 * airAbsorptionCoefficient_m(freq_hz) * volume_m3;
}
