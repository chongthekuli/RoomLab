// Plain-English definitions for technical acoustic terms used in the UI.
// Used as `title=` tooltips on headings and metric labels so a non-expert
// can hover any abbreviation and get a one-sentence explainer.

export const GLOSSARY = {
  rt60:
    'RT60 — reverberation time: how long it takes sound to drop 60 dB after a source stops. Rooms of different uses have different targets (0.4–0.8 s for speech, 1.8–2.4 s for concert halls).',

  sabine:
    'Sabine formula — classic reverberation estimate, accurate for "live" rooms with average absorption α < 0.2.',

  eyring:
    'Eyring formula — reverberation estimate that is more accurate than Sabine when average absorption α > 0.2 (dead rooms, studios, treated spaces).',

  precision:
    'Precision T30 — reverberation derived from ray-traced impulse response at the selected listener. Unlike Sabine/Eyring (one number per room), this varies by position — reflective pockets show higher values than absorptive ones.',

  sti:
    'STI — Speech Transmission Index (IEC 60268-16). A single number 0–1 rating how intelligible speech is at a listener position. 0.6+ is "good" for a sound-reinforced venue; 0.75+ is excellent.',

  stipa:
    'STIPA — STI for Public Address. A simplified 7-band STI used in live-sound and safety-PA work, measured the same way as full STI for typical speech.',

  t30:
    'T30 — reverberation derived from the 5–35 dB segment of the energy decay curve, extrapolated to 60 dB (ISO 3382-1).',

  t20:
    'T20 — reverberation from the 5–25 dB decay segment. Used when the late tail is noisy.',

  edt:
    'EDT — Early Decay Time. Reverberation derived from the first 10 dB of decay. Correlates better than T30 with perceived liveness.',

  c80:
    'C80 — clarity index at 80 ms. Ratio of early (0–80 ms) to late (>80 ms) energy. Higher = music sounds clearer. Concert hall target: -2 to +4 dB.',

  c50:
    'C50 — clarity index at 50 ms. Same idea as C80 but a 50 ms window — more relevant for speech. +2 dB or higher is typical for good speech intelligibility.',

  dr:
    'D/R — Direct-to-reverberant ratio at the listener. Positive dB = direct sound dominates; negative = reverberant field dominates.',

  spl:
    'SPL — Sound Pressure Level in decibels. Measured relative to the 20 µPa threshold of hearing. Live concert target: ~95–103 dB.',

  dba:
    'dBA — A-weighted SPL. Single number approximating human loudness perception; emphasises the 2–4 kHz region where hearing is most sensitive.',

  nc35:
    'NC-35 — Noise Criterion 35. A per-band background-noise spec corresponding to a typical office with HVAC. Used as the default ambient noise floor for STIPA calculations.',

  absorption_alpha:
    'α — absorption coefficient. Fraction of sound energy a surface absorbs (0 = perfect reflector, 1 = perfect absorber). Per octave band.',

  scattering:
    'Scattering coefficient — fraction of reflected energy sent diffusely (not specularly). Per-material, per-band. Drives ray-tracing realism in precision mode.',

  uniformity:
    'Uniformity — max SPL minus min SPL across the audience zone. Lower is better; ±3 dB is a common target for even coverage.',

  directivity_index:
    'DI — Directivity Index. How focused a speaker is vs an omnidirectional source at the same power. Higher DI = less energy wasted into walls and ceiling.',
};

// Attach `title=` attributes to every element with a matching `data-gloss`
// attribute. Run after each panel renders so dynamically-inserted nodes
// pick up the glossary too.
export function applyGlossary(root = document) {
  const nodes = root.querySelectorAll('[data-gloss]');
  for (const el of nodes) {
    const key = el.dataset.gloss;
    const def = GLOSSARY[key];
    if (def && !el.title) el.title = def;
    // Visual affordance — dotted underline so users know there's a hover.
    el.classList.add('gloss-term');
  }
}
