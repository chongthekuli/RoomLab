# WallLAB Phase 5 — Rw + Double-leaf + Composite + Thick-barrier

**Status (2026-05-23): SHIPPED end-to-end at v=622 (functionally complete).** Local-only stack v=603 → v=622 — 15 commits awaiting user eyeball + Maya screenshot pass + Priya UAT before push. Step 9 (composite stretch) explicitly deferred per Maya as a separate release.
**Authoring chain:** Dr. Chen (physics scope, 2026-05-23) → Hannes (roster, 2026-05-23) → this plan (Claude, 2026-05-23). Step-by-step sign-offs from Dr. Chen (contour arrays Step 2, stud-bridging table Step 4, Kurze-Anderson Step 6) + Sam (schema 1.5 Step 3) + Carmen (competitive cross-check Step 7) + Lin (catalogue seeds Step 7) + Maya (UI UX Steps 8a-d).
**Previous phases:** P1 (BETA toggle, v=603) · P2/P3 (mass-law simulator, v=606) · P4 (over-wall demo, v=608) · v=609 (assembly tagging cleanup) — all on LOCAL-FIRST hold per `feedback_visual_physics_local_first`.

## SHIPPED STEPS (per-commit ledger)

| Step | Module / artefact | Commit | Test file | Assertions |
|------|------------------|--------|-----------|-----------|
| PSC | Over-wall ground reflection + air absorption | v=610 | walllab-psc-overwall.test.mjs | 32 |
| pre-merge gate | Numerical golden fixtures (Dr. Chen) + invariants (Sam) | v=611 | wall-physics-golden.test.mjs, walllab-net-il-invariants.test.mjs | 21 + 5 |
| Martina audit | HIGH (ground-plane assumption) + MEDIUM x3 | v=612 | (existing tests) | — |
| 1 | `third-octave-bands.js` | v=613 | third-octave-bands.test.mjs | 18 |
| 2 | `wall-rating.js` (Rw / STC / Ctr / C) | v=614 | wall-rating.test.mjs | 22 |
| 3 | Schema 1.5 migration on materials.json (Sam) | v=618 | materials-schema-1-5.test.mjs | 5 (per-row sweep) |
| 4 | `wall-tl-double-leaf.js` (Sharp three-region) | v=615 | wall-tl-double-leaf.test.mjs | 42 |
| 5 | `wall-composite.js` (area-weighted τ-bar) | v=616 | wall-composite.test.mjs | 19 |
| 6 | `thickBarrierIL` in diffraction.js (Kurze single-edge + bonus) | v=617 | thick-barrier-il.test.mjs | 27 |
| 7 | Catalogue seeds (7 ship + 4 Phase 6 deferred) + glossary (Lin) | v=619 | catalogue cross-check inside wall-tl-double-leaf | 4 cross-checks |
| 8a+b | Mode 1 UI redesign — sub-mode routing + Rw chip + ISO 717-1 contour overlay | v=620 | walllab-step8-mode1-redesign.test.mjs | 55 |
| 8c | Standards & method right-panel two-section stack | v=621 | walllab-step8c-method-panel.test.mjs | 31 |
| 8d | Phase 6 disabled rows in the dropdown | v=622 | walllab-step8d-deferred-rows.test.mjs | 26 |
| 9 | Composite stretch (Mode 1 UI for compositeTL) | DEFERRED — separate release per Maya | — | — |

**Phase 5 total:** ~372 assertions across 18 WallLAB test files.

## Phase 6 deferrals (logged at end of Step 7)

Lin refused to fabricate measured 1/3-oct data, so 4 catalogue rows are deferred to Phase 6 pending source-data digitisation:
- `wall_steel_25_dg_mf65_rc` — paywall on NRC IR-761.
- 3 glazing rows (`glaz_igu_4_12_4_air`, `glaz_igu_6_16_8_air`, `glaz_lam_88_argon_lam_66`) — Saint-Gobain Acoustic Guide 2022 curves are graphed, not tabulated.

Plus physics-model deferrals exposed by Step 4/7 cross-check:
- Mass-air-mass dip modelling (formula over-predicts air-cavity wood-stud row by +8 dB; Dr. Chen Gotcha #2 — 2/3-oct wide asymmetric dip not in current Sharp implementation).
- Staggered / double-stud refinement (Sharp uncapped over-predicts by ~+4 dB vs measurement; residual coupling through common top/bottom plates not modelled).

All 4 deferred catalogue rows appear in the dropdown DISABLED with "· measured data pending" sublabel per Maya §5 — engineers see they're coming without selectable confusion. When real data lands the rows auto-promote (no second UI commit needed).

---

## 1. Why this phase exists

WallLAB Mode 1 today shows a single-leaf mass-law line vs. a measured curve. That works for concrete, single-pane glass, and bare plaster. It does NOT work for the partitions an acoustician actually specifies — every modern wall is double-leaf cavity (drywall on studs), and partitions are quoted by **single-number ratings** (Rw, STC, Ctr, C), not per-band TL.

The v=609 cleanup made the workbench honest about this gap (assembly rows hide the misleading Δ table). Phase 5 closes the gap by **shipping the predictor for the missing physics**:

- **Real double-leaf cavity TL** (Sharp 1973 three-region: mass-air-mass, plateau, cavity-fill, stud bridging).
- **Real single-number ratings** (ISO 717-1 contour-shift for Rw + Ctr + C; ASTM E413 for STC).
- **Real composite-wall TL** (a 60 dB concrete wall with a 25 dB door collapses to ~38 dB — the area-weighted τ-bar sum). *Stretch goal in same release.*

Plus a **parallel small commit (PSC, v=610)** unblocking work that's already mostly written:
- **Over-wall Mode 2 wires `groundReflectedDiffraction` + `airAbsorptionDbPerM`** into the cross-section demo (Kurze-Anderson thick-barrier stays in Step 6 — it doesn't exist as a pure module yet). Per Maya 2026-05-23: three-ray cross-section (direct sightline / over-top / ground-reflected over-top, the last drawn from an image-source marker on the ground line — no below-ground line drawing); ground-type segmented control (Hard / Soft) below the geometry sliders; per-band table extends to three rows (Maekawa / Air abs / Net IL); summary block switches from "IL @ 1 kHz" to broadband mean (250 Hz – 4 kHz) matching Mode 1; source/listener label-anchor bug fixed in the same touch.

**Defer to Phase 6** (locked, do not scope-creep): loss-factor η slider; orthotropic coincidence; regional code variants (NBC / DnT,A,tr / R'w); finite-wall side-diffraction in WallLAB UI; flanking ISO 12354 prediction; partition-aging tolerance.

---

## 2. Definition of done

A real partition engineer can:
1. Pick a wall type (e.g. "2×4 wood stud, 1×13 mm GWB each side, 90 mm mineral fibre"), see Rw + Ctr + C on screen *correctly*, and quote the number to a client.
2. Pick a single-leaf row (e.g. "150 mm concrete") and see it computed the same way it was in v=609 — no regression on existing behaviour.
3. Toggle a "door in this wall" sub-mode, dial in the door area + door TL row, and see the composite Rw collapse (stretch).
4. Open the standards panel and see ISO 717-1 §3.1 / ASTM E413 / Sharp 1973 / Bies & Hansen Eq. 8.41 cited inline with the live numbers.
5. **Not** see flanking absent without a disclosure — the ISO 12354 caveat already landed in v=609 stays.

---

## 3. Implementation sequence (test-first, 8 steps)

Each step lands as a single commit on the local v=609 branch. Cache bump at each step (v=610, v=611, …). Hold local until end-of-release UAT.

### Step 1 — `js/physics/third-octave-bands.js` (pure helper)
- **Scope:** export `ISO_THIRD_OCTAVE_HZ = [100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000]` (16 bands per ISO 717-1) + `octaveToThirdOctave(octave_values)` log-linear interpolator.
- **Test:** `tests/third-octave-bands.test.mjs`. Fixtures:
  - Flat octave 30 dB → flat 1/3-octave 30 dB.
  - Linear ramp octave → log-linear 1/3-octave (assert monotonicity + endpoint match).
  - Concrete-painted catalogue row → interpolated 1/3-octave (golden snapshot).
- **Specialist:** none — pure math.
- **LOC budget:** ~50.
- **Acceptance:** test passes; no Three.js / DOM imports; exported constants frozen.

### Step 2 — `js/physics/wall-rating.js` (Rw + STC + Ctr + C)
- **Scope:** four exports — `computeRw(tl_third_oct, freqs)`, `computeSTC(...)`, `computeCtr(tl, freqs)`, `computeC(tl, freqs)`. All four share an internal `shiftContourToFit(contour, tl, maxDevPerBand, maxSum)` helper. Reference contours from ISO 717-1 Table 1 + ASTM E413 §5, baked into the module as frozen arrays with the source cited.
- **Test:** `tests/wall-rating.test.mjs`. Fixtures (Dr. Chen's gotchas #1 + #5 turned into tests):
  - Flat 50 dB across 16 bands → Rw === 50 (off-by-one canary).
  - Flat 50 dB → STC === 50, Rw === STC for a flat curve.
  - Known NRC partition (e.g. wall_2x4_sg_2x_each_air, measured Rw 33) → computeRw within ±1 dB.
  - Ctr should be negative for a wall whose deficit sits in the low-frequency bands (test fixture: rolloff TL at 100-200 Hz).
- **Specialist:** Dr. Chen sign-off on contour arrays before merge (she'll catch any transcription drift).
- **LOC budget:** ~120.
- **Acceptance:** all four fixtures pass; the Saint-Gobain Acoustic Guide IGU 4-12-4 example reproduces Rw 30 within ±1 dB.

### Step 3 — Schema 1.5 (Sam first, in parallel with Step 4)
- **Scope:** `data/materials.json` schema extension:
  - Optional `tl_third_oct: number[16]` (1/3-oct 100–5000 Hz). Only on rows where a measured 1/3-oct dataset exists.
  - Required `model: "catalogue" | "formula" | "mass-law"`. Drives the workbench's path choice. Default for legacy rows: `"mass-law"` (current behaviour).
  - Optional `assembly: { leaf1_mass_kg_m2, leaf2_mass_kg_m2, cavity_depth_m, cavity_fill, stud_type, bridge_ceiling_db }` for double-leaf rows shipping measured Rw.
- **Test:** `tests/materials-schema-1-5.test.mjs`. Owned by Sam. Validates every row in `materials.json` declares `model`; if `model === "formula"` then `assembly` is present; if `tl_third_oct` is present then `length === 16`.
- **Specialist:** Sam owns the migration test + the schema validator. He has refusal authority on the field names.
- **LOC budget:** ~30 (schema), ~60 (validator + migration).
- **Acceptance:** Sam's validator green; existing tests don't move; legacy `transmission_loss_db` octave field still honoured.

### Step 4 — `js/physics/wall-tl-double-leaf.js` (Sharp three-region)
- **Scope:** export `doubleLeafTL({ m1, m2, d_m, cavity_fill, stud_type }, bands_third_oct_hz) → Float64Array`. Internal helpers `fMassAirMass(m1, m2, d)` (Bies & Hansen Eq. 8.40, constant 60 with provenance comment), `regionII(m1, m2, d, f)`, `regionIII(m1, m2, f)`, `cavityFillBonus(fill)` (catalogue table: none=0, MF≥50 mm=+5, MF<50=+3, reflective=−3), `studBridgeCap(stud_type, m1, m2, f)` (empirical table from GA-600 + Cremer-Heckl-Müller).
- **Test:** `tests/wall-tl-double-leaf.test.mjs`. Fixtures (Dr. Chen's gotchas #2, #3, #4, #6):
  - f_mam location: 2× 10.5 kg/m² leaves with 90 mm cavity → f_mam ≈ 90 Hz (closed-form check).
  - Sub-f_mam region recovers single-leaf mass law of total m1+m2.
  - Above f_d (= c/2πd), TL ≈ TL₁ + TL₂ + 6 within ±0.5 dB.
  - Mass-air-mass dip is at least 2/3 octave wide (gotcha #2 — pin the dip-width invariant).
  - RC-1 stud type returns `null` (resilient channel = catalogue-only per Dr. Chen; formula refuses).
  - Region II → Region III crossover at f_d is monotone-non-decreasing (gotcha #6: clamp `min(II, III)`).
- **Specialist:** Dr. Chen reviews the stud-bridging table before merge.
- **LOC budget:** ~140.
- **Acceptance:** all fixtures pass; against the 6 NRC partitions seeded in Step 7, predicted Rw within ±3 dB of measured (Dr. Chen's claim, not a regression — drift beyond this means the formula was implemented wrong).

### Step 5 — `js/physics/wall-composite.js` (stretch)
- **Scope:** export `compositeTL({ elements: [{ tl_third_oct, area_m2 }, ...] })`. Computes per-band `R = -10·log10(Σ τᵢ·Sᵢ / S_total)`. Refuses on missing area or NaN TL (returns null, not silently 0).
- **Test:** `tests/wall-composite.test.mjs`:
  - 100% concrete (60 dB) → 60 dB.
  - 50/50 split between 60 dB and 25 dB material → 28 dB ±1 (the worked example from Beranek §11.5).
  - Tiny door (1% area, 25 dB) in 60 dB wall → 45 dB (the "leaky door dominates fast" canary).
- **LOC budget:** ~50.
- **Acceptance:** all three canary points within ±0.5 dB.

### Step 6 — Extend `js/physics/diffraction.js` with `thickBarrierIL`
- **Scope:** Kurze-Anderson 1971 Eq. 12. New export `thickBarrierIL({ delta1, delta2, width_m, lambda_m, il_floor_db = 0 })`. Computes `IL_thick = min(24, maekawaIL(δ₁, λ)) + min(24, maekawaIL(δ₂, λ)) + max(0, 10·log10(width_m / lambda_m))`. Clamps the cap term at 0 for w < λ/4 (gotcha #7).
- **Test:** `tests/thick-barrier-il.test.mjs`:
  - w → 0 reduces to single-edge Maekawa.
  - w = 0.25 m at 1 kHz (λ=0.343) → cap term ≈ −1.4 dB → clamped to 0 (sub-λ/4 regime).
  - w = 0.25 m at 4 kHz (λ=0.086) → cap term ≈ +4.6 dB.
- **LOC budget:** ~30.
- **Acceptance:** matches Dr. Chen's worked examples in the Phase 5 spec.

### Step 7 — Catalogue seeds (Lin first)
- **Scope:** Lin adds the 11 rows from Dr. Chen's table to `data/materials.json` (or a new `data/wall-products.json` if Sam prefers a separate file in Step 3 — that's a Step 3 decision). Each row carries `model`, `assembly` (if formula), `tl_third_oct` (if measured), and a single-line citation. Lin owns the row names + citation accuracy as the new sub-hat.
- **Test:** existing `tests/walllab-assembly-tagging.test.mjs` extended; new `tests/wall-catalogue-citations.test.mjs` asserting every Phase 5 row has either `_tl_source` or `_tl_note` non-empty.
- **Specialist:** Lin owns; Dr. Chen sanity-checks the assembly params; Sam green-lights the schema match.
- **Acceptance:** all 11 rows render in WallLAB material selector; no row missing a citation; the workbench's compareReason gate (v=609) routes formula-only rows to the new double-leaf path.

### Step 8 — UI integration (Maya first)
- **Scope:** `wall-sim.js` learns three new presentation modes:
  - **Single-leaf** (current v=609 path) — unchanged.
  - **Double-leaf** — new sliders for leaf masses, cavity depth, cavity fill, stud type. f_mam + f_d annotated on the plot (vertical leader lines, same style as the existing coincidence-dip leader). Stud-type dropdown disables on RC and shows "catalogue only" sub-label.
  - **Composite** (stretch) — second material slot + area-fraction slider on the primary wall area.
  - Summary block: `Rw (C; Ctr) = 52 (-2; -7)` chip per ISO 717-1 §5 reporting format; chip greys out with tooltip "single-number rating requires 1/3-octave data" when row is octave-only.
  - Standards panel: rotates per active mode (mass law / Sharp / composite / ratings), live equation + cited clause.
- **Specialist:** Maya owns the chip styling + contour-overlay legend + slider affordance. Lin owns the standards-panel copy + tooltip wording.
- **LOC budget:** ~250.
- **Acceptance:** Priya UAT pass — fresh-eyes walkthrough with the locked-physics partitions; no "draft / TBD" strings.

---

## 4. Schema 1.5 workstream (parallel to Steps 1–2)

Owned by Sam — independent of Steps 1–2, blocks Steps 3 onward. Sam should:
1. Author `tests/materials-schema-1-5.test.mjs` enforcing the new shape on every row.
2. Decide: extend `materials.json` in place vs. add `data/wall-products.json` and a second loader. Recommendation (Carmen-aligned): extend in place; the rooms catalogue is small, and a second file doubles the surface area for citation drift.
3. Write the migration: every legacy row gets `model: "mass-law"` (current behaviour); only Phase 5 new rows get `model: "formula"` or `model: "catalogue"`. No row silently changes path.
4. Update the existing `materials.byId` loader to expose the new fields without breaking the existing single-leaf path.

---

## 5. Pre-mortem — Dr. Chen's gotchas → named test fixtures

Every gotcha from the Phase 5 spec maps to a test name. If the test isn't in the suite, the fixture is missing.

| Gotcha | Failure mode | Test fixture |
|---|---|---|
| ISO 717-1 contour shift off-by-one | Flat 50 dB → Rw 49 or 51 | `tests/wall-rating.test.mjs` — "flat 50 dB across 16 bands → Rw === 50" |
| Mass-air-mass dip rendered as single-band spike | Dip < 1 octave wide | `tests/wall-tl-double-leaf.test.mjs` — "mass-air-mass dip width ≥ 2/3 octave" |
| Catalogue-vs-formula handshake mixed | `tl_third_oct` present AND formula fires | `tests/wall-tl-double-leaf.test.mjs` — "row with tl_third_oct never invokes formula" |
| RC-1 silently uses formula | Slider responds to f_mam change on RC row | `tests/wall-tl-double-leaf.test.mjs` — "stud_type === 'RC-1' returns null" |
| Rw vs STC label swap | Display says STC but shows Rw value | `tests/wall-rating.test.mjs` — "Rw and STC for asymmetric IGU diverge by ≥1 dB" |
| Region II/III crossover spike | TL discontinuity near f_d | `tests/wall-tl-double-leaf.test.mjs` — "TL is monotone-non-decreasing in f from f_mam to f_d × 2" |
| Thick-barrier cap term goes negative | IL_thick < IL_single_edge at sub-λ/4 | `tests/thick-barrier-il.test.mjs` — "w = 0.25 m at 1 kHz: cap term clamps to 0" |

---

## 6. Cache-bump + LOCAL-FIRST plan

- v=609 (DONE, uncommitted) — assembly tagging cleanup.
- v=610 — PSC (over-wall mode wires existing ground / air-abs / thick-barrier into the demo) — optional, can land before Phase 5 if user wants the over-wall mode finished first.
- v=611 — Step 1 (third-octave-bands helper).
- v=612 — Step 2 (wall-rating).
- v=613 — Step 3 (schema 1.5) — needs Sam green.
- v=614 — Step 4 (wall-tl-double-leaf).
- v=615 — Step 5 (wall-composite, stretch).
- v=616 — Step 6 (thick-barrier in diffraction).
- v=617 — Step 7 (catalogue seeds, Lin).
- v=618 — Step 8 (UI integration, Maya + Lin).

All commits LOCAL until end-of-release UAT (Priya). Per `feedback_visual_physics_local_first` + `feedback_visual_physics_workflow`.

Owen polls live URL only after the user says "push it".

---

## 7. Routing handoffs (open)

- **Sam** — schema 1.5 design + validator. **Decision needed before Step 3.** Recommendation: extend `materials.json` in place; new fields are additive.
- **Maya** — chip styling for `Rw (C; Ctr) =` summary, contour-overlay legend, slider affordances for the new double-leaf knobs. **Pre-consult before Step 8.**
- **Lin** — catalogue row names + citations + standards-panel copy + new glossary entries (`Rw`, `STC`, `Ctr`, `C`, `mass-air-mass resonance`, `stud bridging`, `composite wall`, `coincidence dip` if not already there). **Pre-consult before Step 7.**
- **Dr. Chen** — sign-off on (a) ISO 717-1 contour arrays before Step 2 merge, (b) stud-bridging empirical table before Step 4 merge, (c) the assembly params on the 11 catalogue seeds before Step 7 merge.
- **Theo / regression-curator** — every step lands with its named test fixture per §5; same-PR rule enforced.
- **Priya / UAT** — single walkthrough at end-of-release before push. Locked partitions from §2 are the script.

---

## 8. Decisions — locked 2026-05-23

| # | Decision | Locked |
|---|----------|--------|
| 1 | PSC ordering | **PSC lands as v=610 BEFORE Phase 5 Step 1.** Scope locked to ground-reflection + air-absorption wiring only — Kurze-Anderson thick-barrier stays in Step 6 (it doesn't exist as a pure module yet). |
| 2 | Composite-wall stretch | **SHIPS in Phase 5 as Step 5** (not deferred). ~50 LOC + canary test. |
| 3 | Schema 1.5 file location | **Extend `materials.json` in place** — Sam confirms before Step 3 lands. New fields are additive; legacy rows default to `model: "mass-law"` and keep existing octave `transmission_loss_db`. |
| 4 | Public-deploy `PHYSICS_P1_5` flag flip | **DEFERRED to a separate UAT after Phase 5 ships.** Per-user toggle is sufficient for now; flipping the public default is its own decision with its own walkthrough. |
| 5 | Phase 6 placeholder doc | **Not yet** — bias toward shipping Phase 5 first per `feedback_team_size_vs_ceremony`. Open `docs/WALLLAB_PHASE_6_PLAN.md` only when Phase 5 is in user UAT. |
