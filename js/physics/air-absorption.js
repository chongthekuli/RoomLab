// Atmospheric absorption coefficients (dB/m) at the canonical octave
// centres. This FIXED table is the INDOOR model — it is held constant so
// no existing scene's RT60 / SPL shifts when the outdoor parametric path
// (airAbsorptionDbPerM_param, below) is introduced. Used by:
//   • SPL propagation (indoor) — direct-field absorption = airAbsorptionDbPerM(f) · r dB.
//   • RT60 Sabine/Eyring — volumetric air sink adds 4·m·V to the absorption
//     budget, where m is the energy attenuation coefficient in Nepers/m.
//     At HF this becomes a first-order drop in high-frequency RT60 for
//     any large venue (arena 48k m³: 8 kHz RT60 halves vs ignoring 4mV).
//   • Hopkins-Stryker R — same 4mV additive term feeds into the equivalent-
//     absorption area used for the reverberant-field level calculation.
//
// PROVENANCE NOTE (corrected 2026-05-22): the original header claimed
// "20 °C / 50 % RH". The tabulated values do NOT match the ISO 9613-1
// 20 °C / 50 % curve — at 4 kHz the standard gives ~0.024 dB/m at 50 % RH,
// whereas this table carries 0.0375 dB/m, which is closer to a low-humidity
// (~15–20 % RH) 20 °C atmosphere (i.e. drier air, more HF loss). The
// numbers are retained UNCHANGED so indoor results are stable; only the
// label is corrected. Treat this table as an empirical "dry-ish indoor"
// curve, NOT a parametric ISO point. For an honest, temperature/humidity-
// parametric coefficient (outdoor field mode) use airAbsorptionDbPerM_param.
// 8 kHz is extrapolated log-linearly from the 4 kHz value.

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

// ===========================================================================
// PARAMETRIC ISO 9613-1:1993 air absorption — OUTDOOR FIELD ONLY
// ===========================================================================
//
// Implements the full ISO 9613-1:1993 §6–§A pure-tone attenuation
// coefficient α(f, T, RH, p) in dB/m, with explicit O2 and N2 vibrational
// relaxation frequencies. This is the honest temperature/humidity-dependent
// model the outdoor field needs (a 600 m path at 8 kHz swings ~25 dB across
// the humidity range). The INDOOR table above is left UNTOUCHED so no
// existing scene shifts — only outdoor cells call this function.
//
// Symbols (ISO 9613-1 notation):
//   pa   = ambient atmospheric pressure (kPa)
//   pr   = reference pressure = 101.325 kPa
//   T    = ambient temperature (K)
//   T0   = reference temperature = 293.15 K (20 °C)
//   T01  = triple-point isotherm temperature = 273.16 K
//   h    = molar concentration of water vapour (%) = RH · (psat/pa)
//   frO  = oxygen relaxation frequency (Hz)
//   frN  = nitrogen relaxation frequency (Hz)
//
// Reference cross-checks (ISO 9613-1 equations / NPL atmospheric-absorption
// calculator), at 101.325 kPa — verified to 3 sig figs by tests/spl.test.mjs:
//   20 °C / 70 % RH:  2 kHz ≈ 0.00899, 4 kHz ≈ 0.02307, 8 kHz ≈ 0.07752 dB/m
//   30 °C / 70 % RH:  2 kHz ≈ 0.01277, 4 kHz ≈ 0.02318, 8 kHz ≈ 0.05995 dB/m
//   30 °C / 20 % RH:  8 kHz ≈ 0.167 dB/m  (dry → high HF loss)
//   30 °C / 90 % RH:  8 kHz ≈ 0.0538 dB/m (humid → low HF loss)
// Note the relaxation peak SHIFTS with T and RH: at fixed 70 % RH the 8 kHz
// coefficient is actually LOWER at 30 °C than 20 °C, because the O2/N2
// relaxation frequencies move relative to 8 kHz — this is correct ISO
// behaviour, not a sign error.
// → 8 kHz over 600 m swings ~ (0.167 − 0.0538)·600 ≈ 68 dB across 20–90 % at
//   30 °C — well above the ~25 dB the user cited. The model is strongly
//   humidity-dependent at HF, which is the whole point of going parametric.

const ISO_T0 = 293.15;     // reference temperature (K), 20 °C
const ISO_T01 = 273.16;    // triple-point isotherm (K)
const ISO_PR = 101.325;    // reference pressure (kPa)

// Saturation vapour pressure ratio psat/pr per ISO 9613-1 Eq. (B.3):
//   psat/pr = 10^( -6.8346·(T01/T)^1.261 + 4.6151 )
function _psatRatio(T_K) {
  const exponent = -6.8346 * Math.pow(ISO_T01 / T_K, 1.261) + 4.6151;
  return Math.pow(10, exponent);
}

/**
 * airAbsorptionDbPerM_param
 * Pure-tone atmospheric attenuation coefficient α in dB/m per ISO 9613-1:1993.
 * OUTDOOR FIELD use only — the indoor table (airAbsorptionDbPerM) is unchanged.
 *
 * @param {number} freq_hz        pure-tone / band-centre frequency (Hz)
 * @param {number} temperature_C  ambient temperature (°C)
 * @param {number} humidity_pct   relative humidity (%)
 * @param {number} [pressure_kPa] ambient pressure (kPa); default sea level
 * @returns {number} α in dB/m  (multiply by path length for total dB loss)
 */
export function airAbsorptionDbPerM_param(freq_hz, temperature_C, humidity_pct, pressure_kPa = 101.325) {
  const f = Math.max(1e-6, freq_hz);
  const T = temperature_C + 273.15;       // ambient temperature, K
  const pa = pressure_kPa;                // ambient pressure, kPa
  const rh = Math.max(0, humidity_pct);   // relative humidity, %

  // Molar concentration of water vapour, h (% molar) — ISO 9613-1 Eq. (B.2):
  //   h = RH · (psat/pr) / (pa/pr)
  const psatRatio = _psatRatio(T);
  const h = rh * psatRatio / (pa / ISO_PR);

  // Relaxation frequency of oxygen, frO — ISO 9613-1 Eq. (3):
  const frO = (pa / ISO_PR) * (24 + 4.04e4 * h * (0.02 + h) / (0.391 + h));

  // Relaxation frequency of nitrogen, frN — ISO 9613-1 Eq. (4):
  const Tr = T / ISO_T0;   // temperature ratio
  const frN = (pa / ISO_PR) * Math.pow(Tr, -0.5) *
    (9 + 280 * h * Math.exp(-4.170 * (Math.pow(Tr, -1 / 3) - 1)));

  // Attenuation coefficient α (dB/m) — ISO 9613-1 Eq. (5).
  // The bracketed term is the classical + rotational absorption plus the
  // O2 and N2 vibrational relaxation contributions. The leading 8.686 is
  // 20·log10(e) (Nepers→dB on amplitude). f is in Hz; α comes out per metre.
  const f2 = f * f;
  const alpha = 8.686 * f2 * (
    1.84e-11 * Math.pow(pa / ISO_PR, -1) * Math.pow(Tr, 0.5) +
    Math.pow(Tr, -2.5) * (
      0.01275 * Math.exp(-2239.1 / T) * (frO / (frO * frO + f2)) +
      0.1068  * Math.exp(-3352.0 / T) * (frN / (frN * frN + f2))
    )
  );
  return alpha;
}

// Energy attenuation coefficient (Nepers/m) from the parametric model —
// the 4mV-style quantity, for any outdoor reverberant accounting. Kept
// alongside the indoor airAbsorptionCoefficient_m for symmetry; the field
// is free-field (no 4mV term in the locked Phase 2 scope) but exposing it
// avoids a second conversion site if outdoor reverb is added later.
export function airAbsorptionCoefficient_m_param(freq_hz, temperature_C, humidity_pct, pressure_kPa = 101.325) {
  return airAbsorptionDbPerM_param(freq_hz, temperature_C, humidity_pct, pressure_kPa) * NEPERS_PER_DB_ENERGY;
}
