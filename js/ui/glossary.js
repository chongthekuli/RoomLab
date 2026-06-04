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

  open_ceiling:
    'Open ceiling — the ceiling material is set to "open wall (no boundary)," so the roof contributes zero transmission loss and zero absorption. Use for open courtyards, arcades, and partly-roofed prayer halls. Whether interior SPL drops or rises depends on where the sources sit. Sources mounted INSIDE the room (ceiling speakers, floor monitors) lose energy upward — SPL drops and reverberation falls toward zero. Sources mounted ABOVE the roof line (minaret horns, tower-mounted PA, flown speakers on an external gallery) gain direct line-of-sight into every interior cell; the removed roof TL (~30 dB for concrete, ~15 dB for metal deck) can outweigh the lost reverberant lift, raising interior SPL by several dB. Always check source z relative to room.height_m before declaring the result a bug.',

  absorption_alpha:
    'α — absorption coefficient. Fraction of sound energy a surface absorbs (0 = perfect reflector, 1 = perfect absorber). Per octave band.',

  scattering:
    'Scattering coefficient — fraction of reflected energy sent diffusely (not specularly). Per-material, per-band. Drives ray-tracing realism in precision mode.',

  uniformity:
    'Uniformity — max SPL minus min SPL across the audience zone. Lower is better; ±3 dB is a common target for even coverage.',

  directivity_index:
    'DI — Directivity Index. How focused a speaker is vs an omnidirectional source at the same power. Higher DI = less energy wasted into walls and ceiling.',

  // --- WallLAB Phase 5 (Step 7, 2026-05-23): partition isolation + spectrum adaptation ---

  rw:
    'Rw — weighted sound reduction index (ISO 717-1). A single-number rating derived by sliding a reference contour against a wall\'s 1/3-octave TL curve from 100 Hz to 3150 Hz, then reading the contour value at 500 Hz. Higher = better isolation; a domestic separating wall typically targets Rw ≥ 50 dB. Laboratory value; field performance (R\'w, DnT,w) is usually 3-8 dB lower.',

  stc:
    'STC — Sound Transmission Class (ASTM E413). North-American counterpart to Rw. The contour and frequency range differ slightly, but STC and Rw typically agree within ±1 dB for partitions tested 125-4000 Hz. A wall sold as "STC 50" reads as Rw ≈ 49-51.',

  ctr:
    'Ctr — spectrum adaptation term for traffic noise (ISO 717-1). Added to Rw to predict performance against low-frequency-heavy sources: lorries, bass-heavy music, plant rooms. Always ≤ 0. A wall rated Rw 50 (Ctr -7) gives only Rw+Ctr = 43 dB against road traffic.',

  c_spectrum:
    'C — spectrum adaptation term for pink-noise / speech (ISO 717-1). Added to Rw to flag walls whose TL curve dips near speech frequencies. Typically -1 to -2 dB. For offices and classrooms, judge on Rw+C, not Rw alone.',

  mass_air_mass:
    'Mass-air-mass resonance — the frequency at which a double-leaf wall\'s two leaves move out of phase on the cavity\'s air spring, collapsing TL by 5-15 dB. Approximated as f₀ = 60·√[(m₁+m₂)/(m₁·m₂·d)] for an air-filled cavity. Filling the cavity with mineral fibre damps the resonance; an empty cavity is the worst configuration despite the same wall mass.',

  stud_bridging:
    'Stud bridging — mechanical short-circuit through a wall\'s studs that caps TL regardless of leaf mass or cavity depth. Wood studs cap TL around 55 dB; steel studs flex and reach 60+ dB; resilient channel (RC-1) or a fully decoupled double-stud frame removes the bridge and unlocks Rw 60-70 dB. Adding GWB layers past Rw ~45 is wasted unless the stud path is broken.',

  composite_wall:
    'Composite wall — any wall with two or more leaves separated by a cavity. TL is not the sum of its leaves; it is governed by leaf mass, cavity depth, fill, and stud coupling. AuraLAB computes composite-wall TL via the Sharp three-region formula when stud type is wood, steel, staggered, or double; resilient-channel and proprietary assemblies use measured 1/3-octave data (catalogue model).',

  coincidence_dip:
    'Coincidence dip — a frequency band where bending waves in a leaf match the airborne wavelength and TL drops sharply. For 13 mm GWB the critical frequency is around 2500 Hz; for 6 mm float glass around 2000 Hz. Visible as a notch in the TL curve. Two leaves with different masses (asymmetric IGU 6-16-8) shift their dips apart and smooth the combined curve.',

  thick_barrier:
    'Thick-barrier correction — adjustment to Maekawa single-edge diffraction loss when a barrier\'s thickness is large compared to wavelength. Adds max(0, 10·log10(w/λ)) dB on top of Maekawa\'s single-edge IL. Zero at low frequencies (w < λ); +4-8 dB at HF for typical 200-300 mm walls.',

  igu:
    'IGU — insulating glass unit. Two or more glass panes bonded around a sealed cavity (air, argon, or krypton). Acoustic IGUs use asymmetric panes (6-16-8, 6-20-10) to displace the coincidence dip and laminated glass (PVB interlayer) to damp it. A symmetric 4-12-4 unit performs worse than a single 8 mm pane at speech frequencies.',

  resilient_channel:
    'Resilient channel (RC-1) — hat-shaped sheet-metal furring screwed to studs to decouple one wall leaf from the frame. Adds 6-12 dB to Rw when installed correctly (single screw per stud, no bridging). RC performance is sensitive to fastener length and panel overlap, so AuraLAB treats RC walls as catalogue-only — no closed-form prediction.',

  wall_hatch_family:
    'Wall hatch family — the plan-drawing convention AuraLAB uses to render wall materials on the 2D viewport and printed plan: solid fill for dense masonry, diagonal hatch for framed and lightweight partitions, outline only for glazing, blank for openings. Buckets are monochrome-safe so the print reads correctly on a black-and-white office machine; an unknown materialId draws as a dotted outline rather than silently as concrete.',

  // --- FurnitureLAB glossary (Phase 4, 2026-05-27, Lin docs-writer
  // debt list from the FurnitureLAB brainstorm + Phase 2 additions) ---

  a_obj:
    'A_obj — equivalent absorption area of a discrete object (chair, sofa, audience block, etc.) in m² Sabine units. Unlike α (per m² of a surface), A_obj is per object and per octave band: 0.25 m²·Sa @ 1 kHz for a single padded office chair means it removes the same energy from the diffuse field as 0.25 m² of a perfectly absorptive surface. Summed into the room\'s absorption budget as a parallel-A term outside the Eyring log (Kuttruff §5.3, Beranek §7.3) — see also "Object-frame vs surface-frame absorption."',

  iso_354:
    'ISO 354 — the reverberation-room method for measuring A_obj. A sample is placed in a 200 m³ reverb chamber; the difference in RT60 with and without the sample gives the sample\'s effective Sabine absorption. The only acceptable source of "measured" A_obj numbers in the FurnitureLAB catalogue. Reliability tag "measured" is reserved for ISO 354 (or its predecessor ASTM C423) lab certificates.',

  iso_17497:
    'ISO 17497 — measurement of the scattering coefficient s. Part 1 (reverberation-room method) yields a single number per band for how much reflected energy is sent diffusely rather than specularly. Used by the precision ray-tracer to choose Lambertian vs. specular reflection per bounce. Rarely measured for individual furniture items; most rows carry s=null and the engine falls back to 0.20 default per Cox & D\'Antonio §6.4.',

  type_a_mounting:
    'Type-A mounting — the default ISO 354 / ASTM E795 fixture for porous absorbers: sample placed flat directly on the reverb-room floor, no air gap. Catalogue rows derived from "audience" measurements assume Type-A; "occupied seat" data is also Type-A in practice (chairs on the floor). When a real installation deviates (panels on stand-off battens; deep ceiling void behind), the per-band α can drift 20-30% at the cavity-tuned frequency.',

  object_vs_surface_frame:
    'Object-frame vs. surface-frame absorption — two ways to encode the same acoustic effect. Surface-frame: α per m² of a finish (carpet on concrete, wood floor). Object-frame: A_obj per item (one chair). Don\'t double-count carpet under chairs — pick one frame per row. FurnitureLAB stores A_obj per item; SurfaceLAB stores α per m². The Sabine sum reads both: Σαᵢ·Sᵢ + Σ A_obj,j.',

  interaction_mode:
    'Interaction mode (porous vs reflective) — how the precision ray-tracer handles a placed object. "Porous" treats the object as a Beer-Lambert volumetric absorber the ray passes through with energy loss (chairs, sofas, drapes, audience — sound diffuses into the upholstery). "Reflective" triangulates the bbox into the wall BVH; rays bounce off the outer surfaces (wood tables, lecterns, bookshelves, metal racks). Both modes contribute identically to Sabine/Eyring via the rt60 parallel-A sum — the mode only changes how rays interact with the object in the precision engine.',

  beer_lambert_furniture:
    'Beer-Lambert furniture sink — the per-ray attenuation rule the precision tracer applies inside a porous-mode object. Per-band coefficient μ_b = A_obj(b) / (4·V_bbox) [Nepers/m], derived from Kuttruff 5e §4.1 eq. 4.11 via the Cauchy mean-chord theorem (factor of 4 is the ratio of mean chord length to volume of a convex region). Per-ray energy loss across pathlength L_in through the bbox: E\' = E·exp(-μ·L_in). Dropping the 4 in A/(4V) is the canonical bug — engines that get this wrong under-read RT60 by 25%.',

  occupancy_state:
    'Occupied vs. empty seat — two distinct catalogue rows, paired via paired_state_id. An occupied chair absorbs ~3× more energy at speech frequencies (Beranek 2e Table 7.2 vs 7.1). For rehearsal-vs-performance modelling, flip the placed-list row\'s "⇆ Occupied/Empty" toggle — same position + same id, swapped A_obj. Sound designers run BOTH states before sign-off because the RT60 swing is typically 0.3-0.6 s in seated venues.',

  audience_block:
    'Audience block per m² — a per-area row that represents one square metre of densely-seated audience, not one chair. Use this row when seats are >50 deep (Beranek 2e §7.3 recommendation): the discrete-chair sum overstates because crowded audiences absorb collectively. A_obj per row = published per-m² α × the row\'s 1 m² footprint, encoded directly as m²·Sa. Place one row per m² of seating area.',

  reliability_tier:
    'Reliability tier — the catalogue badge that tells you what evidence backs a row\'s A_obj numbers. "Measured" (green) = direct ISO 354 lab certificate. "Derived" (amber) = calculated from a parent ISO 354 measurement via a documented derivation (per-seat from per-m² × footprint, occupied from empty × Beranek ratio, etc.). "Estimated" (red) = engineering judgement, material-class extrapolation, or back-of-envelope. The Furnishing schedule in the printed report carries the same tier badge per row.',

  confidence_overlay:
    'Confidence overlay — FurnitureLAB sidebar toggle that re-tints every placed object in the 2D viewport by its reliability tier (green / amber / red). The competitive differentiator: most simulators bury per-row provenance in metadata; this view surfaces "where does the RT60 number rest on solid lab data, where on a guess" at a glance. No physics change; visual overlay only.',
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
