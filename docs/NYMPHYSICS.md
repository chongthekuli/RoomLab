# nymphysics — RoomLab's Acoustics Engine

> **Status:** Phase-1 skeleton (2026-05-29). This is the umbrella reference
> for RoomLab's acoustics engine. It consolidates the existing scattered
> docs and the public API into one front door, and tracks — explicitly —
> the models that still need a written derivation.
>
> **Correctness ownership:** Dr. Lena Chen (acoustics-engineer) owns the
> physics claims in this document. Per `feedback_physics_needs_audit`,
> nothing here is "correct" until it has been through her audit. Parts 3
> and 4 are gap-trackers, not sign-offs.
>
> **Code boundary:** [`js/physics/nymphysics.js`](../js/physics/nymphysics.js)
> is the public API barrel. **Part 5** maps every exported symbol to the
> model it implements.

---

## What nymphysics is

nymphysics is the named acoustics core under `js/physics/` (52 public
modules + a 7-module precision ray-tracer). It runs in **two modes**, both
branded nymphysics:

| Mode | What it is | Method | Powers |
|------|------------|--------|--------|
| **Draft** | Analytical / statistical, real-time | Sabine/Eyring reverb, Hopkins-Stryker diffuse field, inverse-square direct field, mass-law TL, Maekawa diffraction, STIPA | Live 2D/3D heatmap, per-listener readouts, instant feedback |
| **Precision** | Ray-traced impulse response | BVH + stochastic specular tracer → per-band energy histogram → ISO 3382 / IEC 60268-16 metrics | The "Render Precision" pass, report metrics |

`engineInfo()` returns `{ name, version, modes, description }` for any UI or
report that wants to cite the engine (e.g. *"Computed with nymphysics
v1.0.0 · Precision"*). `NYMPHYSICS_VERSION` identifies the **physics**, and
is independent of `index.html`'s `?v=NNN` asset cache-bust.

### Conventions (shared by every model)

- **Units:** SI throughout — metres, seconds, Hz, dB SPL re 20 µPa, watts.
- **Coordinate axis:** state `+y` = north (toward the front / qibla wall).
  All four render surfaces flip Y so `+y` renders up the page. See
  `CALCULATIONS.md §1.1`.
- **Frequency bands:** octave centres 125 Hz – 8 kHz (the working set);
  third-octave interpolation available via `third-octave-bands.js`. See
  `CALCULATIONS.md §1.3`.
- **Reference standards:** ISO 3382-1, ISO 9613-1/-2, ISO 717-1, ISO
  12354, IEC 60268-16, ASTM E413, plus Kuttruff / Beranek / Pierce
  textbook forms. See `CALCULATIONS.md §1.4`.

---

## Part 1 — Draft engine (analytical) — DERIVED

These models are already derived in detail in
[`CALCULATIONS.md`](./CALCULATIONS.md); this section is the index. The
equations below are the canonical forms as implemented.

### 1.1 Reverberation — Sabine / Eyring
- **Sabine:** `T60 = 0.161·V / (S·ᾱ + 4mV + ΣA_obj)`
- **Eyring:** `T60 = 0.161·V / (−S·ln(1−ᾱ) + 4mV + ΣA_obj)`
- `4mV` = volumetric air absorption; `ΣA_obj` = furniture + rack Sabine area.
- Code: `rt60.js` → `sabine`, `eyring`, `computeRT60Band`, `computeAllBands`.
- Detail: `CALCULATIONS.md §4`.

### 1.2 Direct field — inverse-square + directivity + air
- `L_direct = L_w + DI(θ,φ,f) − 20·log₁₀(r) − 11 − α_air(f)·r − TL_path(f)`
- Sound power: `L_w = sensitivity + 10·log₁₀(P) + 11 − DI` (the `−DI` term
  is load-bearing — see `feedback_sound_power_needs_DI`).
- Directivity: bilinear interpolation on the (az, el) polar grid per band.
- Code: `spl-calculator.js` → `computeDirectSPL`; `loudspeaker.js` →
  `interpolateAttenuation`. Detail: `CALCULATIONS.md §5.1–§5.3`.

### 1.3 Reverberant field — Hopkins-Stryker
- Room constant `R = S·ᾱ / (1 − ᾱ)` (with `4mV` air term folded in).
- `L_rev = L_w + 10·log₁₀(4/R)`; total = direct ⊕ reverb (energy sum).
- Code: `spl-calculator.js` → `computeRoomConstant`, reverberant term in
  `computeMultiSourceSPL`. Detail: `CALCULATIONS.md §6`.

### 1.4 Multi-source summation
- **Incoherent (default):** `L = 10·log₁₀(Σ 10^(Lᵢ/10))` — uncorrelated
  sources; two identical sources = +3 dB.
- **Coherent (opt-in):** pressure-phasor sum. Detail: `CALCULATIONS.md §5.6–§5.7`.

### 1.5 Mass-law transmission loss
- `TL = 20·log₁₀(m·f) − 47 dB` (field-incidence constant).
- Double-leaf: Sharp 1973 three-region model (`wall-tl-double-leaf.js`).
- Single-number ratings Rw / C / Ctr (ISO 717-1) + STC (ASTM E413) in
  `wall-rating.js`. Detail: `CALCULATIONS.md §5.4`.

### 1.6 STIPA (IEC 60268-16)
- D/R-aware MTF: `m(F) = (D + R·m_rev(F)) / (D + R + N)` (NOT the simplified
  `m_rev·(D+R)/(D+R+N)` form — see `feedback_stipa_dr_aware`).
- `STI = Σα·TIₖ − Σβ·√(TIₖ·TIₖ₊₁)`; β has 6 entries; ±15 dB SNR clamp.
- Code: `stipa.js`. Detail: `CALCULATIONS.md §9`.

### 1.7 Line-array rigging + Master EQ
- Back-pivot rigging geometry (`feedback_line_array_rigging_pivot`),
  incoherent element sum above 500 Hz. Detail: `CALCULATIONS.md §7`.
- Master EQ: log-frequency linear-dB interpolation. Detail: `CALCULATIONS.md §8`.

---

## Part 2 — Precision engine (ray-traced) — DERIVED (in blueprint)

Architecture and metric derivations live in
[`DUAL-ENGINE-BLUEPRINT.md`](./DUAL-ENGINE-BLUEPRINT.md). Index:

- **Scene snapshot:** immutable, worker-transferable `PhysicsScene`
  (`scene-snapshot.js` → `buildPhysicsScene`). Blueprint §1.2.
- **Spatial index:** SAH BVH + Möller-Trumbore ray-triangle
  (`precision/bvh.js`). Blueprint §3.
- **Tracer:** stochastic specular rays → per-band, per-time-bucket energy
  histogram at volumetric receivers (`precision/tracer-core.js`).
  Blueprint §4–§5.
- **Worker pool:** fan-out with prime-stride seeds, element-wise histogram
  sum (`precision/worker-pool.js`). Blueprint §2.
- **Derived metrics (from the IR histogram):** EDT, T20, T30, C80, C50,
  D/R (ISO 3382-1) and STI-from-IR (IEC 60268-16 Annex A) in
  `precision/derive-metrics.js`. Blueprint §5.4.

---

## Part 3 — Models in code with NO written derivation (STUBS)

> These ship and run today but have no first-principles writeup anywhere.
> Each stub records the file, the standard it claims, and the current
> simplification. **Filling these is the next phase, one model per pass,
> owned by Dr. Chen.** Do not treat a stub as validated.

| Model | File | Claims / standard | Derivation |
|-------|------|-------------------|------------|
| Maekawa edge diffraction (+ multi-wall shortest-detour) | `diffraction.js` | Maekawa 1968; ISO 9613-2 §7.4; Pierce-Hadden wedge | **TODO (Dr. Chen).** Per-path shortest-detour (Phase B1, v=649) replaced the earlier parallel-sum; needs a written δ/IL/lit-zone derivation + re-audit confirmation. **The two 16 dB IL floors (diffraction.js:512-513) are LOAD-BEARING for the interior-louder-than-exterior inversion guard — DO NOT drop without the diagnostic in the code comment. They mask a TL-budget bug, not a diffraction error (Chen 2026-05-29). The correct thickBarrierIL input is the WALL geometric thickness_m, not a materials property — no schema change needed when the fix lands.** |
| Series wall transmission loss | `wall-path.js`, `wall-tl.js` | ISO 12354-1 combination | **TODO (Dr. Chen).** Confirm current multi-wall combination vs `max(TLᵢ)+10·log₁₀(N)`; Chen E6 flagged additive summation. |
| Wall re-radiation (secondary source) | `reradiation.js` | Kuttruff §5.4; ISO 12354-1 §B.2 | **TODO (Dr. Chen).** `L_w_wall = L_p_rev − 6 − TL + 10·log₁₀(S)`, near/far blend — derive + cite. |
| Overhead reflection (image-source) | `overhead-reflection.js`, `overhead-geometry.js` | ISO 9613-2 §7.5 (generalised) | **TODO (Dr. Chen).** Image position, visibility test, edge falloff (Chen E10). |
| Porch / arcade enclosure lift | `porch-enclosure.js` | Beranek semi-open; ISO 3382-1 | **Form ENDORSED (Chen 2026-05-29).** Present-surface Sabine R + open-face energy-fraction scaling — NOT pure S_open-at-α=1 (which would kill the roof-material lever in the gated ≥40%-enclosed regime, the v=641 finding). Header docblock corrected to match the implemented form. Drive-point (Chen E8/E9) writeup still TODO. |
| Exterior source coupling | `exterior-coupling.js`, `source-classification.js` | Kuttruff §5.4; ISO 12354-3 §4.3 | **TODO (Dr. Chen).** View-factor × τ coupling coefficient; classification predicates. |
| Zone carving & treatment overlap | `room-shape.js` (surface enum) | — | **TODO.** Per-band absorption budget with occupancy blend + treatment clamp (extend `CALCULATIONS.md §2.6`). |
| Furniture / rack absorption & blocking | `furniture-absorption.js`, `rack-absorption.js`, `*-direct-blocking.js` | ISO 354; Beer-Lambert μ=A/4V | **TODO.** Articulate the absorption + direct-shadowing model. |
| Outdoor obstacles (minaret / columns / portico) | `outdoor-obstacles.js` | ISO 9613-2 §7.4.2; cascade cap | **TODO (Dr. Chen).** Single-screen pick + cascade ≤ 8 dB cap. |
| Atmospheric absorption (outdoor parametric) | `air-absorption.js` `*_param` | ISO 9613-1:1993 §6 | **TODO.** O₂/N₂ relaxation parametric form (vs the table form in `CALCULATIONS.md §5.3`). |

---

## Part 4 — Known limitations & simplifications (document-as-is)

> Consolidated from Dr. Chen's audit (`project_chen_audit` P1–P5;
> `docs/CHEN_HEATMAP_AUDIT_2026-05-24.md` E1–E12), the
> `CALCULATIONS.md §11` live list, and the physics rows of
> `docs/REGRESSION_INDEX.md`. This is an honest catalog of what the engine
> approximates — **not** a to-do list being worked in this pass.

- **E1/E2 (diffraction parallel-sum)** — *reworked.* Phase B1 per-path
  shortest-detour (v=649) supersedes the parallel energy-sum across edges.
  Needs Dr. Chen re-audit to close.
- **E6 (series wall TL)** — multi-wall combination under review (additive
  vs ISO 12354-1). Tracked as a Part 3 stub.
- **E7 (thick-barrier IL floor)** — hard floor vs frequency-dependent form.
- **E8/E9 (porch enclosure factor + drive point)** — heuristic vs Beranek.
- **E10/E11 (overhead reflection edge / shared roof edges)** — falloff and
  double-count edge cases.
- **P-series (Chen 2026-04-18):** frequency-dependent TL, reverberant-field
  coupling, air absorption magnitude, aperture/diffraction coupling, dome
  volume for non-circular bases. See `project_chen_audit`.
- **Heatmap near-wall extrapolation** — `grid-display.js` bleeds one cosmetic
  ring to the wall (render-only; never fed back into metrics). Signed off by
  Dr. Chen as standard nearest-extrapolation; < 1 dB at default grid. Caveat
  tracked in `project_chen_audit`.

> **GUARDED models** (do not "simplify" in a refactor — they encode hard-won
> fixes): directivity aim-flip, sound-power `−DI`, STIPA D/R-aware MTF,
> line-array rigging pivot, preset plumbing, state-swap events. See the
> `feedback_*` memory set and `CLAUDE.md §6`.

---

## Part 5 — Public API reference

There are **two entry points** (added in the 2026-05-29 modularity pass):

- **`js/physics/index.js`** — the **curated adopter surface** (~33 symbols):
  the orchestrators, the standard band/constant exports, and the provider
  hooks. This is what a third party imports (`import { runPrecisionRender }
  from 'nymphysics'` resolves here via the `exports` map in
  `js/physics/package.json`).
- **`js/physics/nymphysics.js`** — the **comprehensive internal barrel**
  (~148 symbols, every public + many leaf helpers). RoomLab's own code imports
  from here; it exposes implementation detail the curated index intentionally
  hides.

The barrel re-exports the internal surface in tiers (below). **Decoupling is
mechanically guarded** by `tests/nymphysics-no-outbound-imports.test.mjs` —
no module under `js/physics/` may import from `../app-state`, `../labs`,
`../graphics`, `../state`, `../ui`, or Three.js. Outside catalogue data
(treatments / furniture / racks) enters only through the **provider registry**
(`js/physics/providers.js`); RoomLab's lab modules self-register at import,
adopters call `setSurfaceCatalogueProvider` / `setFurnitureCatalogueProvider`
/ `setRackCatalogueProvider`.

| Tier | Key exports | Model (Part) |
|------|-------------|--------------|
| **meta** | `NYMPHYSICS_VERSION`, `NYMPHYSICS_MODES`, `engineInfo()` | Engine identity |
| **geometry** | `roomVolume`, `baseArea`, `roomEffectiveBounds`, `isInsideRoom3D`, `roomPlanVertices`, `domeGeometry`, `normalizeWallSlot`, `wallInsetPolygon`, `wallLabelAnchor` | §Conventions; geometry support |
| **materials & walls** | `loadMaterials`, `massLawTL`, `massLawTLBands`, `doubleLeafTL`, `compositeTL`, `computeRw`/`computeSTC`/`computeC`/`computeCtr`, `splitParentVsEnclosure` | 1.5 |
| **propagation** | `computeMultiSourceSPL`, `computeSPLGrid`, `computeDirectSPL`, `computeRoomConstant`, `precomputeSPLContext`, `speedOfSound`, `airAbsorptionDbPerM`, `maekawaIL`, `thickBarrierIL`, `computeDiffractionContributions` | 1.2, 1.3, 3 (diffraction) |
| **reverberation** | `sabine`, `eyring`, `computeRT60Band`, `computeAllBands`, `preferredRT60` | 1.1 |
| **intelligibility** | `computeSTIPA`, `computeSTIPAAt`, `precomputeSTIPAContext`, `stipaRating`, `STIPA_BANDS` | 1.6 |
| **sources** | `loadLoudspeaker`, `getCachedLoudspeaker`, `interpolateAttenuation`, `registerLoudspeaker`, `analyseSpeaker`, `importSpeakerFile` | 1.2 |
| **sources (geometry)** | `expandSources`, `expandLineArrayToElements`, `earHeightFor`, `POSTURE_EAR_HEIGHTS_M` | 1.2/1.7 (`source-expand.js`) |
| **providers** | `setSurfaceCatalogueProvider`, `setFurnitureCatalogueProvider`, `setRackCatalogueProvider`, `getTreatmentAbsorption`, `getCachedCatalogue`, `getFurnitureCatalogue`, `getRackCatalogue` | DI registry (`providers.js`) |
| **per-listener** | `computePerListenerMetrics`, `formatListenerMetricsLabel` | 1.2/1.3 + Precision STI |
| **precision** | `runPrecisionRender`, `buildPhysicsScene`, `PHYSICS_SCENE_VERSION`, `buildBVH`, `intersectRay`, `traceRays`, `triangulateScene`, `deriveMetrics`, `calcEDT`/`calcT30`/`calcC80`/`calcC50`/`calcDR`/`calcSTIFromIR`, `PrecisionWorkerPool` | Part 2 |
| **display & util** | `dilateGridForDisplay`, `buildSilhouetteMask`, `PHYSICS_P1_5_ENABLED`, `importDxfFile`, `furnitureBlocksCylinder`, `rackBlocksCylinder` | Render-only / utilities |

> `recordRayPaths` / `buildLineSegmentIndex` moved OUT of the engine to
> `js/graphics/ray-viz.js` (2026-05-29) — they are a Three.js-feeding
> visualisation helper, not physics.

Full symbol list: see [`js/physics/nymphysics.js`](../js/physics/nymphysics.js)
(~148 exports). Re-export integrity is guarded by
[`tests/nymphysics-barrel.test.mjs`](../tests/nymphysics-barrel.test.mjs);
decoupling by
[`tests/nymphysics-no-outbound-imports.test.mjs`](../tests/nymphysics-no-outbound-imports.test.mjs).

---

## Related documents

- [`CALCULATIONS.md`](./CALCULATIONS.md) — full draft-engine derivations (Part 1 detail).
- [`DUAL-ENGINE-BLUEPRINT.md`](./DUAL-ENGINE-BLUEPRINT.md) — precision-engine architecture (Part 2 detail).
- [`REGRESSION_INDEX.md`](./REGRESSION_INDEX.md) — shipped bugs ↔ guarding tests.
- `docs/CHEN_HEATMAP_AUDIT_2026-05-24.md` + synthesis — outdoor-pipeline audit (Part 4 source).
