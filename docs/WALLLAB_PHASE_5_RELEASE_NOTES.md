# WallLAB Phase 5 — Release Notes

**Status:** SHIPPED LOCAL at v=622. 15-commit stack v=603 → v=622 awaiting user eyeball + Maya screenshot pass + Priya UAT before push.
**Date:** 2026-05-23.
**Plan:** see `docs/WALLLAB_PHASE_5_PLAN.md` for the per-step ledger.
**Sign-off chain:** Dr. Chen (3 spec sign-offs) · Martina (code audit) · Carmen (competitive cross-check) · Sam (schema 1.5) · Lin (catalogue + glossary) · Maya (UX 7 decisions).

---

## At a glance

WallLAB Mode 1 graduates from "single-leaf mass-law toy" to a working partition-isolation workbench that quotes the spec-sheet number engineers actually use:

- **Single-number ratings**: Rw, STC, Ctr, C — per ISO 717-1:2020 and ASTM E413-22, on every selectable material.
- **Double-leaf cavity predictor**: Sharp 1973 three-region with cavity-fill + stud-bridging table. 5 new live sliders.
- **ISO 717-1 contour overlay on the plot**: dotted reference line + 45° hatching across unfavourable-deviation bands + Σ_unfav annotation.
- **Standards & method right-panel restructured**: two always-visible sections (EQUATION & METHOD per mode + RATING always).
- **7 new partition rows** from NRC IR-761 (5 measured wood/steel/staggered/double drywall) and Beranek & Vér (2 CMU). **4 rows deferred** to Phase 6 — Lin refused to fabricate measured data; rows appear in the dropdown disabled with `· measured data pending` sublabel.

Engineering tolerance vs measurement: ±3 dB on capped-stud rows (wood/steel) and ±4 dB on uncapped rows (staggered/double); pinned by per-row cross-check fixtures.

---

## NEW (user-visible features)

### Single-number ratings — Rw (C; Ctr) and STC

- ISO 717-1:2020 §3.1 contour-shift implemented; STC per ASTM E413-22 §5.
- Summary chip per ISO 717-1 §5 display format: `Rw (C; Ctr) = 47 (-2; -7)`.
- C uses the pink-noise / A-weighted spectrum (Table 2 col 2); Ctr uses the traffic spectrum (Table 2 col 3).
- Sum-hash regression tests on every frozen contour and spectrum array — transcription drift is the bug class this catches.

### Double-leaf cavity wall predictor (Sharp three-region)

Five new sliders appear when a material with `model: "formula"` is selected:
- **Leaf 1 mass** + **Leaf 2 mass** (kg/m²)
- **Cavity depth** (mm)
- **Cavity fill** (segment): `Air (no fill)` · `≥ 50 mm fibre` · `Reflective`
- **Stud system** (segment): `Rigid (wood)` · `Resilient (steel)` · `Staggered` · `Double stud`

Catalogue defaults prefill every slider on material change. f_mam and f_d are shown numerically in the Standards & method panel. Cavity-fill is a step function (Dr. Chen refused partial-fill interpolation — `≥ 50 mm fibre` is one option, no `fibrous_lt_50`).

### ISO 717-1 contour overlay on the TL plot

- Dotted reference contour line at the shifted-by-Rw position.
- 45° diagonal hatching across bands where computed TL < contour.
- `Σ unfav = 28 dB · shift +2 dB` annotation top-right.
- No toggle (Maya: "hiding the contour is hiding the method").

### 7 new partition rows in the material catalogue

Formula rows (NRC IR-761 measured Rw, Sharp three-region predictor available):
- `2×4 wood stud, 1×13 mm GWB e/s, air cavity` — Rw 33
- `2×4 wood stud, 1×13 mm GWB e/s, 50 mm mineral fibre` — Rw 39
- `2×4 wood stud, 2×13 mm GWB e/s, 90 mm mineral fibre` — Rw 45
- `Double 2×4 stud (25 mm gap), 2×13 GWB e/s, 140 mm fibre` — Rw 63
- `Staggered 2×4 studs on 2×6 plate, 2×13 GWB, 90 mm fibre` — Rw 56

Mass-law rows (Beranek & Vér 1992 Table 11.3 measured, existing thickness slider):
- `200 mm hollow concrete masonry unit, unpainted` — Rw 47
- `200 mm fully-grouted concrete masonry unit` — Rw 53

### 4 Phase 6 deferred rows in the dropdown (disabled)

Visible with `· measured data pending` sublabel; selectable when Lin lands the digitised 1/3-octave curves:
- `Steel stud, 2×13 GWB e/s, 65 mm fibre, RC one side`
- `IGU 4-12-4 mm float, air cavity`
- `IGU 6-16-8 mm asymmetric, air`
- `Laminated 8.8 / argon 16 / laminated 6.6`

Ambient caption below the dropdown: `4 rows pending measured data — picks marked "measured data pending" can't be computed yet.`

### 11 glossary entries (Lin)

`Rw`, `STC`, `Ctr`, `C`, `mass-air-mass resonance`, `stud bridging`, `composite wall`, `coincidence dip`, `thick-barrier correction`, `IGU`, `resilient channel`. Each entry is 3-5 sentences with the practical takeaway, citing the relevant standard (ISO 717-1, ASTM E413, etc).

### Materials catalogue extended to schema 1.5

Every row now carries `model: "mass-law" | "formula" | "catalogue"`. Formula rows additionally carry an `assembly` block with leaf masses, cavity depth, cavity fill, and stud type. Catalogue rows carry `tl_third_oct[18]` (18-band ISO 266 R10 1/3-octave TL). `reference_thickness_m` and `assembly_type` promoted from the UI layer.

---

## CHANGED (behaviour shifts)

### Summary block: ISO 717-1 §5 chip replaces broadband mean

- Previous: `mass-law mean TL 250 Hz – 4 kHz = 44 dB` (one big dB number).
- Now: `Rw (C; Ctr) = 47 (-2; -7)` with caption `single-number rating · ISO 717-1`.
- Mode 2 unchanged — over-wall IL has no ISO rating equivalent; its broadband-mean summary stays.

### Mode 1 control rail reshapes by material

- Pick a `· double-leaf` material → Construction + Stud system slider groups appear.
- Pick a mass-law row → original thickness slider returns.
- Pick a `· measured` row (Phase 6 / currently none selectable) → no parametric controls; measured curve speaks for itself.
- Reshape is opacity-only, ≤ 150 ms; column width does not jump.

### Standards & method panel: two-section stack

- **EQUATION & METHOD** (mode-specific):
  - Mass-law: existing `TL = 20·log₁₀(m·f) − 47` + Beranek/Sharp cite.
  - Formula: Sharp three-region piecewise + live f_mam / f_d / cavity-fill bonus dB + stud-bridging cap note + Bies & Hansen Eq. 8.40 / 8.41a + GA-600 cite.
  - Catalogue: "Measured row — no closed-form prediction" + source.
- **RATING (Rw)** (always shown when computable):
  - Rw + STC + C + Ctr + current contour shift.
  - Plain-text explanation of the 1-dB integer-shift procedure.
  - "Rw and STC can diverge — mass-air-mass resonance is the usual culprit" intuition.
  - ISO 717-1:2020 §3.1 + ASTM E413-22 §5 cites.
  - When Rw not computable: one-sentence "why not" in a dashed-border greyed box. Never hidden.

The "Field vs lab" ISO 12354 flanking caveat from v=609 is preserved in all three mode-specific blocks.

### Material dropdown adds model pill

Each option label now shows its physics path:
- `2×4 wood stud, 2×13 GWB e/s, 90 mm mineral fibre · double-leaf` (formula)
- `200 mm hollow concrete masonry unit, unpainted` (mass-law — no pill, default)
- `Steel stud, 2×13 GWB e/s, 65 mm fibre, RC one side · measured data pending` (Phase 6 deferred, disabled)

### Over-wall Mode 2 wired air absorption + ground reflection (v=610 PSC)

- Three rays in the cross-section: direct sightline, over-top diffracted, ground-reflected over-top (from an image-source marker; hidden on soft ground).
- Per-band table extends to three rows: Maekawa / Air abs (signed) / Net IL.
- Ground-type segmented control (Hard / Soft) per ISO 9613-2 §7.3.1.
- Summary block switches from `IL @ 1 kHz` to broadband mean 250 Hz – 4 kHz, matching Mode 1's domain summary.

### v=609 assembly-type tagging (cleanup before Phase 5)

Catalogue rows now carry `assembly_type: "single_leaf" | "double_leaf" | "composite"`. The mass-law Δ table hides for double-leaf and composite rows (mass-law line is the wrong comparator there). Replaces the misleading "divergence" annotation with an honest assembly-rating note.

---

## FIXED (bugs gone)

- **wall-rating.js returned non-integer Rw** on non-integer measured_R input (formula-driven). ISO 717-1 §3.2 specifies integer 1-dB shift steps. Fixed via `Math.ceil(shiftHi)` / `Math.floor(shiftLo)` bounds. Pre-existing tests passed silently because catalogue measured TL is integer.
- **Step 4 / Step 3 field-name mismatch** — formula module used `m1_kg_m2`, schema 1.5 used `leaf1_mass_kg_m2`. Renamed in the formula module so catalogue `row.assembly` flows straight through. Mass migration applied; all tests rebound.
- **Net IL at the lit-zone limit displayed full-detour air absorption** as if the wall were attenuating, when really the wall isn't blocking the sightline and the over-top path is just marginally longer. Per Martina audit (v=612), air-abs now subtracts the direct-sightline distance: `α × (detour − direct)`. Net IL at lit-graze approaches 0 cleanly.
- **PSC v=610 source / listener label-anchor inversion** — labels overlapped the receiver circle at recvDist=20 m. Anchors now point OUTSIDE the scene (source left, listener right) with heights shown symmetrically.
- **v=610 broadband summary mis-framed as "IL @ 1 kHz"** in the diffraction demo. Now broadband mean 250 Hz – 4 kHz, matching Mode 1's domain summary.
- **My own (acknowledged) sign-convention error** in the v=610 handoff — I told the user to expect hard ground to give higher Net IL than soft; correct physics is the opposite (hard ground adds a coherent reflected arrival → MORE energy at receiver → LOWER Net IL). Dr. Chen caught this on the numerical audit; the code was always correct, only my prose was inverted.

---

## KNOWN LIMITATIONS

### Phase 6 deferred catalogue rows (4)

Lin refused to fabricate measured 1/3-oct data — paywalled NRC IR-761 for the RC-1 wall and Saint-Gobain Acoustic Guide 2022 with graphed-only curves for the 3 IGU glazing rows. Owen or Carmen to source. When ready, drop `deferred: true` from `wall-catalogue.js` and the UI auto-promotes; no second commit needed.

### Physics model deferrals

- **Mass-air-mass dip not modelled** — air-cavity wood-stud Rw over-predicts by +8 dB vs measurement (e.g. `wall_2x4_sg_2x_each_air`: formula 41, measured 33). Sharp three-region transitions abruptly from Region I (below f_mam) to Region II (above f_mam) without the empirical 10–15 dB dip Dr. Chen flagged (Gotcha #2). That row is documented-excluded from the formula cross-check; the row still ships because its octave TL[7] is measured and the engine uses that directly. Phase 6 fix: add a 2/3-octave-wide asymmetric dip centred on f_mam.
- **Staggered / double-stud refinement** — Sharp uncapped over-predicts by ~+4 dB on these stud types because residual coupling through common top/bottom plates isn't modelled. Tolerance for those cross-checks widened to ±4 dB; refinement is Phase 6.
- **No ISO 12354 flanking prediction** — disclosure card landed in v=609 ("typical field DnT,w is 5–15 dB below lab R'w"); the full prediction model is Acoubat / BASTIAN territory and explicitly out of scope.

### Stretch work explicitly deferred (Maya)

- **Composite-wall UI** — engine ships at v=616 (`wall-composite.js`, area-weighted τ-bar per ISO 12354-3 §17). UI gesture (secondary-material slot + area-fraction slider) is Step 9, separate release. The 3 canary fixtures pass (50/50 split → 28 dB; 1 % door in 60 dB wall → 45 dB).
- **Loss factor η slider** — Phase 6+. Catalogue rows bake η in implicitly via measured TL.
- **Orthotropic coincidence** (gypsum, plywood) — Phase 6+. Sharp's Region III implicit `+6 dB` already over-predicts above coincidence on these panels; the orthotropic critical-frequency model is a 2-week job per Dr. Chen.
- **Regional code variants** (NBC, DnT,A,tr, R'w with derating, Australian Rw + Ctr min) — Phase 6+. ISO 717-1 + ASTM STC cover the canonical set.
- **PHYSICS_P1_5 public-deploy flag flip** — over-wall diffraction is currently off on the public deploy. The WallLAB BETA toggle now controls it per-user; flipping the global default is a separate UAT decision.

---

## TEST COVERAGE

**18 WallLAB test files, ~372 assertions, zero failing.**

Pre-merge gate (v=611 + v=612):
- **Dr. Chen** — 21 numerical golden fixtures with hand-computed expected values, every formula at multiple regimes (mass-law floor / mid / ceiling, Maekawa lit / graze / N=1 / cap, ground reflection).
- **Sam** — 5 invariant fixtures (G-inversion guard, +3 dB symmetric lift, Net IL non-negative, Maekawa cap engagement, dB↔Np conversion direction).
- **Martina** — code audit (HIGH ground-plane assumption + 3 MEDIUM-severity issues) all addressed in v=612.
- **Carmen** — competitive cross-check vs INSUL / Arup / Pilkington / simulations4all: Maekawa within ≤0.8 dB across all bands; mass-law within 1.5 dB at LF on 6 mm float glass.

Catalogue cross-check (v=619):
- Formula reproduces measured NRC IR-761 Rw within tolerance on 4 of 5 formula rows (the air-cavity row excluded with documented limitation).

Per-step regression tests:
- `tests/walllab-step8-mode1-redesign.test.mjs` (55 assertions)
- `tests/walllab-step8c-method-panel.test.mjs` (31)
- `tests/walllab-step8d-deferred-rows.test.mjs` (26)
- `tests/walllab-assembly-tagging.test.mjs` (50)
- `tests/walllab-psc-overwall.test.mjs` (32)
- `tests/wall-tl-double-leaf.test.mjs` (42)
- `tests/thick-barrier-il.test.mjs` (27)
- `tests/wall-rating.test.mjs` (22)
- `tests/wall-composite.test.mjs` (19)
- `tests/third-octave-bands.test.mjs` (18)
- `tests/wall-physics-golden.test.mjs` (21)
- `tests/walllab-net-il-invariants.test.mjs` (5)
- `tests/wall-tl-masslaw.test.mjs` (12)
- `tests/wall-tl-regression.test.mjs`, `tests/wall-reradiation.test.mjs`, `tests/walllab-phase1.test.mjs`, `tests/over-barrier-geometry.test.mjs`, `tests/materials-schema-1-5.test.mjs`

---

## STANDARDS CITED IN THE WORKBENCH

Surface and verifiable. Every standard below is named in the live UI (Standards & method panel, summary captions, or `_tl_source` row annotations).

- **ISO 717-1:2020 §3.1 + §5** — Rw, contour-shift procedure, display format.
- **ISO 717-1:2020 Table 1** — reference contour (16 bands 100–3150 Hz, sum 788 dB).
- **ISO 717-1:2020 Table 2** — C (pink-noise/A-weighted) and Ctr (traffic) spectrum-adaptation curves.
- **ASTM E413-22 §5** — STC reference contour + single-band ≤ 8 dB rule.
- **Sharp 1973** + **Bies & Hansen Eq. 8.40 / 8.41a/b / 8.43** — double-leaf three-region cavity model.
- **Gypsum Association GA-600** + **Cremer-Heckl-Müller §11.4** — stud-bridging empirical caps.
- **ISO 12354-3:2017 §17** + **Bies & Hansen Eq. 8.27** — composite wall area-weighted τ-bar.
- **Maekawa 1968** + **ISO 9613-2:1996 §7.4** — single-edge diffraction.
- **Kurze & Anderson 1971** (referenced but not used) — thick-barrier sum-form. WallLAB uses the simpler Maekawa + thickness-bonus form instead (Dr. Chen 2026-05-23 decision).
- **ISO 9613-1** — air absorption (standard atmosphere).
- **ISO 9613-2:1996 §7.3.1** — ground reflection (single-value G).
- **ISO 12354** (referenced but not modelled) — flanking transmission disclosure caveat.
- **Beranek & Vér** *Noise and Vibration Control Engineering* (1992) Table 11.3 — CMU TL.
- **Cavanaugh & Wilkes** *Architectural Acoustics* 2nd ed. table 24-6 — single-leaf gypsum on studs.
- **NRC IR-761 (1998)** Table A1 — measured wall TL for the 5 Phase 5 formula rows.

---

## UAT SCRIPT (Priya)

Walk through Mode 1 with each material model. Each step has an expected observation; if any diverges, log and escalate.

### 1. Default load (mass-law row)

- Open WallLAB → Through-wall isolation.
- Default material: a mass-law row (e.g. `Painted concrete`).
- **Observe**: thickness slider visible. Rw chip populated (e.g. ~58 dB). Plot shows a single computed curve plus reference contour with hatching. Right rail shows two sections — EQUATION & METHOD (mass law) and RATING (Rw).
- **Tweak thickness slider** → Rw chip updates in real-time; the contour shift annotation moves.

### 2. Pick a formula row

- Drop down Material → pick `2×4 wood stud, 2×13 mm GWB e/s, 90 mm mineral fibre · double-leaf`.
- **Observe**: slider rail reshapes into Construction + Stud system groups. Sliders prefilled with catalogue values (21 / 21 kg/m², 90 mm cavity, ≥ 50 mm fibre, Rigid wood).
- **Observe**: Rw chip reads ~47 dB. f_mam ≈ 62 Hz and f_d ≈ 606 Hz shown in the right rail EQUATION & METHOD section.
- **Tweak Stud system to Staggered** → Rw rises (no bridging cap). Cavity bonus stays unchanged.
- **Tweak Cavity fill to Air (no fill)** → Rw drops by ~5 dB (cavity-bonus removed).

### 3. Pick a Phase 6 deferred row

- Drop down Material → try to pick `Steel stud, 2×13 GWB e/s, 65 mm fibre, RC one side · measured data pending`.
- **Observe**: row is greyed out, can't be selected. Tab from the dropdown skips disabled rows. Caption below dropdown reads "4 rows pending measured data — picks marked 'measured data pending' can't be computed yet."

### 4. Switch to Over-wall mode (Mode 2)

- Click `Over-wall diffraction` segment.
- Default geometry: surau-like (source 7 m, wall 4.5 m, receiver 3 m).
- **Observe**: three rays in cross-section (direct sightline dashed; over-top solid; ground-reflected over-top from image-source marker). Summary block reads `Net IL · 250 Hz – 4 kHz ≈ 3 dB` — wall doesn't meaningfully attenuate a high horn.
- **Toggle Ground to Soft** → image-source marker, leader, and reflected ray disappear. Net IL rises slightly.
- **Move receiver to 20 m** → confirm source / listener labels sit OUTSIDE their circles, no overlap.

### 5. Material pill discoverability

- Drop down Material → scan all options. Confirm every formula row has `· double-leaf`, every Phase 6 row has `· measured data pending`, mass-law rows have no pill.

### 6. Right-rail story

- For a formula row, read down the right rail. Three test questions:
  - What's the equation? (Sharp three-region piecewise)
  - What's f_mam and f_d for this configuration? (numerical values shown)
  - What's the contour-shift result? (Rw, current shift, plain-text procedure)

### 7. Fresh-eyes feel

- Does the workbench tell a coherent story end-to-end (left controls → centre plot → right standards → top chip)?
- Is the ISO 717-1 contour overlay clear (informational) or cluttered (distracting)?
- Does the model pill in the dropdown help or confuse?
- Anything that reads "draft" or "TBD"?

---

## WHAT TO DO BEFORE PUSH

1. **User eyeball** — hard-refresh and walk Mode 1 + Mode 2 (UAT §1–6).
2. **Maya screenshot pass** — send her a screenshot of the formula-row workbench feel; she asked for a fresh-eyes check on the reshape after Step 8a.
3. **Priya UAT** — run the script above.
4. **Decision: PHYSICS_P1_5 public-deploy flag** — currently off; flipping the global default is its own UAT.
5. **Push `v=603 → v=622`** — 15 commits.

---

## CITATION CHAIN

| Specialist | Sign-off | Commits / artefacts |
|------------|----------|---------------------|
| **Dr. Chen** (acoustics) | ISO 717-1 / ASTM E413 contour arrays (Step 2) | v=614 |
|  | Sharp 1973 stud-bridging table (Step 4) | v=615 |
|  | Kurze-Anderson vs Maekawa-bonus form (Step 6) | v=617 |
| **Martina** (code review) | HIGH + 3 MEDIUM, all fixed | v=612 |
| **Carmen** (competitive) | INSUL / Arup / Pilkington cross-check — GREEN | v=611 audit |
| **Sam** (QA / schema) | Schema 1.5 spec + 5 invariant fixtures | v=611, v=618 |
| **Lin** (catalogue + docs) | 7 catalogue rows + 11 glossary entries + 4 honest deferrals | v=619 |
| **Maya** (UX) | 7 decisions for Step 8 + sequencing into sub-commits | v=620, v=621, v=622 |
| **Priya** (UAT) | UAT walkthrough TBD | (pending) |
| **User** | Eyeball TBD; push approval TBD | (pending) |
