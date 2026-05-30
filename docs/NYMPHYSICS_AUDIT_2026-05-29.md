# nymphysics Engine Audit — 2026-05-29

Two parallel expert audits of the acoustics engine (`js/physics/`), run to
answer one question: **make nymphysics as accurate to the real world as
possible, and modular enough that a third party could adopt it.**

- **Physics accuracy:** Dr. Lena Chen (acoustics-engineer)
- **Architecture / adoptability:** Hannes Brauer (tech-lead)

Headline from both: the engine is in **materially better shape than its own
doc backlog implied.** The hard physics is mostly correct against the
standards; the hard decoupling is concentrated in a handful of files. The
work below is bounded, not a rewrite.

---

## Part A — Physics accuracy (Dr. Chen)

### Models verified VALID against the standards
RT60 Sabine/Eyring (correct parallel-A form, ᾱ>0.2 auto-switch), direct
field (3D body-frame directivity), Hopkins-Stryker reverberant `4/R`,
sound-power `−DI`, incoherent multi-source sum, mass-law TL (field-incidence
−47, not the −42 trap), full Sharp-1973 double-leaf TL, ISO 717 Rw/STC/C/Ctr,
composite τ-bar TL, STIPA D/R-aware MTF (break-points verified by hand),
Maekawa/wedge diffraction core + per-path shortest-detour (E1/E2 rewrite),
ISO 9613-1 outdoor air absorption, ISO 3382 EDT/T20/T30/C80/C50/D-R
(EDT/T20/T30 verified = 1.500 on an analytic 1.5 s decay), STI-from-IR
(14-mod-freq MTF). Reradiation, exterior coupling, outdoor obstacles,
furniture/rack absorption judged **defensible physics** awaiting only a
written derivation.

### Ranked correctness gaps

| ID | Sev | Where | Problem | Fix |
|----|-----|-------|---------|-----|
| P0 | **P0** | `panel-precision.js:307-309` × `precision/derive-metrics.js:252-257` | Precision STI ignores ambient noise — caller passes noise but not signal, so the both-vectors gate runs noise-free. NC-25 == NC-45 STI. Back-row STI inflated up to **+0.12**. | Compute per-band signal SPL at each receiver and pass `signalSPL_per_band` through; or disclose high-SNR assumption in the panel. |
| P1 | **P1** | `diffraction.js:512-513` (applied 633-688) | Two hardcoded 16 dB IL floors on parent-wall edges are tuned knobs, not thick-barrier physics. Over-clamps LF/mid by up to **+10 dB at 250 Hz**, band shape inverted. | Replace both floors with `thickBarrierIL(delta, lambda, thickness_m)` (already in the same file). Needs `thickness_m` on materials.json. |
| P2 | **P2** | `porch-enclosure.js:214,227-247` | Closed-Sabine-then-scale heuristic biases covered cells ~**+2 dB** vs Beranek §10.6. Only Part-3 stub whose code is the wrong *form*. | `A = Σα·S_present + 1·S_open; R = A/(1−A/S_total); lift = 10log₁₀(4/R)`; drop enclosureFactor. |
| P2 | **P2** | `spl-calculator.js:610-614,772` | Coherent sum has no λ/4 / 500 Hz decorrelation gate → unphysical fringes above ~500 Hz. **Latent** (coherent defaults off). | Auto-disable coherent above 500 Hz (or above c/spacing). Guard before any line-array preset enables it broadband. |
| P3 | P3 | `loudspeaker.js:92-93` | Directivity returns omni (0) for off-grid frequencies — no inter-band interpolation. Bites the EQ FR probe + sparse custom speaker JSONs only (octave callers pass exact centres). | Log-frequency interpolate attenuation between enclosing band grids. |
| P3 | P3 | `wall-rating.js` output | Lab Rw vs field DnT,w (flanking, ISO 12354) not disclosed; field is typically 5-15 dB lower. | Disclosure copy in the WallLAB rating readout. |
| P3 | P3 | `overhead-reflection.js:128` | Binary in/out polygon test → hard 0-dB cliff at arcade edges instead of Fresnel falloff (E10). Render-only, cosmetic. | Leave as-is, documented. |

### Validation goldens that should exist
1. `tests/precision-sti-noise.test.mjs` — NC-25 vs NC-45, assert precision STI differs >0.03 at a reverb-dominated receiver. **(catches P0; nothing guards it today)**
2. Diffraction band-shape test — 0.25 m concrete top-edge: IL ≈ Maekawa at 250 Hz, +4.6 over Maekawa at 4 kHz, NOT flat 16. **(catches P1)**
3. `tests/golden-spl-surau.test.mjs` — 6-point frozen SPL matrix, fail on >1 dB drift. **(catches P2 porch + any diffraction regression; Sam owns it)**
4. Coherent decorrelation test — two sources 2 m apart, coherent on, 2 kHz ≈ incoherent within 1 dB.
5. Directivity frequency-interpolation test — off-band query returns interpolated value, not omni.
6. ISO 3382 analytic-limit golden — pure exponential decay → EDT/T20/T30 within 1%.

---

## Part B — Modularity / adoptability (Hannes)

### Adoption blockers

**Cross-boundary imports (7, in 6 files).** The `precision/` subtree and
`room-shape.js` are already 100% clean.

| # | File | Imports | Cut today? |
|---|------|---------|-----------|
| 1 | `per-listener-metrics.js` | `earHeightFor, expandSources` ← `app-state` | relocate into physics |
| 2 | `scene-snapshot.js` | `expandSources` ← `app-state` | relocate into physics |
| 3 | `ray-viz.js` | `colorForGroup` ← `app-state` | evict ray-viz to graphics |
| 4 | `per-listener-metrics.js` | furniture/rack catalogue ← `labs/*` | inject as param |
| 5 | `scene-snapshot.js` | 4× catalogue/sub-volume ← `labs/*` | inject as param |
| 6 | `rt60.js` | `getTreatmentAbsorption` ← `labs/surfacelab` | inject as param |
| 7 | `furniture-direct-blocking.js` + `furniture-walk-collision.js` | `getSubVolumes` ← `labs/furniturelab` | pass resolved sub-volumes |

**The real blocker — input contract.** `buildPhysicsScene`,
`runPrecisionRender`, `computePerListenerMetrics` take RoomLab's mutable
`state` object. Lower tiers (`computeDirectSPL`, `sabine`, `massLawTL`,
`computeSTIPA`, the whole `precision/` kernel) already take clean typed
param objects. The leak is concentrated at those 3 orchestrators.
`buildPhysicsScene` is effectively the adapter that already exists — it just
consumes `state`+singletons instead of a neutral scene description.

**The barrel test is false comfort.** `nymphysics-barrel.test.mjs` proves
importability-under-Node, NOT decoupling — `js/physics/` has 7 live outbound
imports. A real mechanical guard is needed.

**Singletons / globals:** `loudspeaker.js` URL cache never cleared;
catalogue singletons in `labs/*`; `feature-flags.js` is a frozen
localStorage snapshot baked at import (test-safe under Node, but ambient
physics-behaviour switch). `loadMaterials` defaults to RoomLab-relative
`'data/materials.json'`.

**Worker loading is already correct** — `worker-pool.js` uses
`new URL('./precision-worker.js', import.meta.url)`, relocatable. Don't
"fix" it.

### API surface
138 exports is too broad for a front door. "display & util" tier is a junk
drawer (render post-proc + feature flags + DXF I/O + walk-collision).
Internal helpers leaked (`intersectRayBrute`, `histogramWindowSum`,
`schroederDecay`, `computeMTF`, `mergePartialHistograms`…). Naming wart:
precision uses `calc*`, everything else `compute*`. Recommendation: keep the
barrel as the internal one-stop; add a curated `index.js` (~15-20 symbols)
as the documented adopter surface.

### Structural risks
- `triangulate-scene.js` (1542 LOC, **untested** — backlog #5): highest-risk file. Split only AFTER a characterization test.
- `spl-calculator.js` (1351 LOC, 13 imports): propagation god-module. Split during extraction.
- `room-shape.js` (1207 LOC, 0 imports): large but pure leaf, lower priority. Surau-specific openings are a domain wart.
- `ray-viz.js`: a visualization module in the physics tree — belongs in `js/graphics/`.
- `worker-smoke*.js`: dev tooling (`window.__roomlabWorkerSmoke`) — exclude from any extracted package.

No circular deps. Internal graph is a clean DAG with evidence of active hygiene.

### Packaging path
- **v1 adoptable (~2-3 days, no physics change):** cut the 7 imports → mechanical no-import test → curated `index.js` → `package.json`+`exports` → fix hardcoded path. After this a third party can `import { runPrecisionRender }` but still must build a `state`-shaped object (documented limitation).
- **Full extraction (~2-3 weeks, needs Chen + Sam):** neutral `PhysicsScene` input schema (RoomLab writes `stateToPhysicsScene` on its side); feature-flags → explicit config; instance-scope the loudspeaker cache; split the god-modules under characterization tests.

---

## Execution decision (2026-05-29)
User approved **both, modularity first then physics**. Tranche A
(modularity v1, pushable) → Tranche B (physics fixes, LOCAL-FIRST).
Directory move + neutral schema deferred to a later v2 pass.

## Reconciliations after re-review (2026-05-29)

On implementation, two of Dr. Chen's audit recommendations were **revised by
Dr. Chen herself** after reading the actual code:

- **P2 Porch → WITHDRAWN.** Her S_open-at-α=1 recommendation was the
  textbook-clean form for the general case, but `porch-enclosure.js` is gated
  to the ≥40%-enclosed regime (`openFrac ≤ 0.6`), where the *implemented*
  present-surface-R + energy-fraction form is the better physics — pure S_open
  would put the α=1 open faces in the same `A` sum and kill the roof-material
  lever (the v=641 finding). **Resolution: keep the code, fix the docs** (the
  header described the rejected formula). No heatmap change.
- **P1 Diffraction floor → DONE (v=727).** The per-path diagnostic (floor=0)
  showed the inversion is asymmetric: removing the floor added +9.6 dB to the
  interior cell vs +1.3 dB to the exterior, because the interior's dominant path
  bends over the building WALL TOP edge (δ≈0, raw Maekawa ~5.6 dB) **into a
  roofed interior** — the wall top is capped by the ceiling, so that path must
  pass through the roof slab (`bentTL=0` missed it: the secondary-TL check only
  sees vertical walls). Fix (Dr. Chen sign-off): `interiorRoofDiffractionTL_db`
  resolves the ceiling-material TL (via `roomSurfaces` → open-air TL 0 for a
  roofless courtyard, concrete ~53 for a roofed building) and adds it to the
  over-the-top path; the flat 16 dB parent-wall TOP floor is DROPPED (wrong
  band-shape) and replaced with `thickBarrierIL` on the wall's geometric
  thickness. Roofed interior now 40/35/31 dB @1/2/4k (TL-bound); arcade
  unchanged; open-top courtyard interior stays loud (material-gated). Guard test
  re-blessed (multi-band + open-top control); monotonicity snapshot re-baselined
  158→188 (the flat floor was cosmetically smoothing the Phase-B raw-Maekawa
  shadow field). **VERTICAL_EDGE floor + arcade overhead floor retained**
  (different mechanisms — separate tasks).
- **P2 Coherent gate → DONE (v=728).** Replaced the naive all-coherent phasor
  sum with octave-band PARTIAL coherence: per source-pair `γ(Δr) =
  |sinc(0.707π·Δr/λ)|` damps the cross-term by path-length difference. Co-located
  sources (Δr=0) keep full +6 dB at all frequencies; separated sources at HF
  decorrelate to incoherent +3 dB — no blanket >500 Hz cutoff (which would
  wrongly kill co-located coherence). `partialCoherentPower` in spl-calculator.

## Validation goldens — STATUS
- `tests/precision-sti-noise.test.mjs` — **LANDED** (with the P0 fix, ae… `4a091e6`).
- `tests/directivity-freq-interp.test.mjs` — **LANDED** (with the P3 fix, `ae83147`).
- `tests/precision-iso3382-analytic.test.mjs` — **LANDED** (EDT/T20/T30 = 1.500 on analytic decay).
- `tests/golden-spl-surau.test.mjs` — **LANDED** (6 pts × 2 bands frozen + scene orderings; the diffraction-fix tripwire).
- `tests/nymphysics-no-outbound-imports.test.mjs` — **LANDED** (modularity decoupling guard).
- `tests/diffraction-interior-not-louder-than-exterior.test.mjs` — **RE-BLESSED**
  (v=727): multi-band isolation matrix + open-top control (the diffraction P1 guard).
- `tests/coherent-decorrelation.test.mjs` — **LANDED** (v=728): co-located +6 at
  all bands + separated-HF ≈ incoherent + LF partial coherence retained.

## Still deferred (next pass)
- **VERTICAL_EDGE_IL_FLOOR_DB → thickBarrierIL** (the SW-corner exterior spike —
  a DIFFERENT mechanism from the roofed-interior path; needs its own per-path
  diagnostic at the corner cell. Retained for now).
- **General horizontal-plane TL** — the roof-TL fix is a correct point-solution
  for the interior ceiling; the general mechanism is a `horizontalPlanesCrossed
  ByPath` so any bent ray piercing any roof/soffit/mezzanine slab accrues its TL
  (clerestory, multi-storey). Dr. Chen P3 backlog.
- **Flanking transmission (ISO 12354) disclosure** — interior transmitted level
  is optimistic by 5-15 dB vs field DnT,w; documentation (route to Lin).
- **STIPA roof-TL consistency** — the interior roof-TL fix is wired into the SPL
  heatmap path; STIPA's own diffraction calls don't yet pass it, so an interior
  STIPA readout could disagree with the SPL heatmap. Thread the same param.
- **v2 extraction**: directory move, neutral `PhysicsScene` input schema,
  feature-flags → config object, loudspeaker-cache instance scoping, god-module
  splits under characterization tests.
