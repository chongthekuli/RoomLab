# Sam Reyes — Heatmap Test Coverage Audit (2026-05-24)

Cross-references: Dr. Chen owns the physics model audit (`CHEN_HEATMAP_AUDIT_2026-05-24.md`), Martina owns the code structural audit (`MARTINA_HEATMAP_CODE_AUDIT_2026-05-24.md`). I only touch test surfaces.

---

## 1. Current coverage inventory (heatmap physics)

| Capability under test | File(s) | What's pinned | What's missing / weak |
|---|---|---|---|
| Maekawa IL primitive at known Fresnel numbers | `diffraction-maekawa.test.mjs` | Closed-form at N=0, 0.1, 1, 10, 100; grazing handoff; clamp at MAEKAWA_IL_MAX_DB. | Strong. No gap. |
| Diffraction path enumeration (dedupe, ground reflection, lit-zone skip, single-corner past-corner ≥ deep-shadow + 4 dB) | `diffraction-multipath.test.mjs` | Edge tuples unique; G=0 lift > 0.3 dB; G=0.7 < G=0; lit zone returns 0; past-corner > deep-shadow + 4 dB. | Single-wall geometry only. **NEVER tests N-wall serial paths.** I4's root pattern is invisible to every assertion here. |
| Vertical-edge thick-barrier IL floor (I1) | `diffraction-corner.test.mjs` | Floor=16 dB; gated to left/right; SW corner ≤ +7 dB above mid-wall. | Locks a value at one source layout. Re-aiming horns, moving them down 2 m, or putting a single source at z=3 — none verified. SW corner inversion against ANY clear-LOS cell in same row not pinned. |
| Roof-eave diffraction enumeration (I2) | `diffraction-roof-edge.test.mjs` | wallsCrossedByPath includes arcade_roof_*; ≤ 4 unique roof-perim edges; below-roof source → no roof crossing; plain room → no arcade roofs. | **No SPL-magnitude assertion at all.** Tests enumeration shape but never asserts that the roof-edge contribution stays bounded. The double-count bug (I2) shipped through this fixture because no value was checked. |
| Interior-louder-than-exterior inversion (I2 fix) | `diffraction-interior-not-louder-than-exterior.test.mjs` | Inner-edge skip; inside ≤ outside + 1 dB; both > 60 dB. | Single source-array, single probe-point pair. I4's B-cell is under SOUTH arcade, untested. |
| Past-corner ≥ deep-shadow + 4 dB | `diffraction-multipath.test.mjs` (case 5) | Lower bound on lift. | Locks a SPECIFIC source position. The user's I4 horn array at z=7 is not exercised. |
| Porch / arcade partial-enclosure lift, material sensitivity | `porch-lift.test.mjs` | extractPorches; point-in-polygon; concrete vs acoustic-tile ≥ 1 dB on covered listener with OUTDOOR podium source. | **(C) had to walk back the magnitude prediction** — fixture chosen TO MAKE IT PASS, not the user's original failing case. The user's v=641 complaint is one fixture refactor away from regressing silently. |
| Overhead specular reflection | `overhead-reflection.test.mjs` | Material-sensitivity invariant (≥ 4 dB swing). | Strong. |
| In-wall annulus classification (Phase 7 fix) | `heatmap-in-wall-classification.test.mjs` | Wall annulus = −∞; **radial monotonicity along a slice** (case F). | This is the ONE existing test that uses the right invariant style. **Replicate this shape elsewhere.** |
| Flag-OFF parity | `physics-flag-off-parity.test.mjs` | Tier 1a disabled → no diffraction leak. | OK. |
| Outdoor field gradient + air absorption | `outdoor-field.test.mjs` | Free-field outside footprint; air-absorption table identity. | No assertion that outdoor cells respect monotonic-with-obstacles invariant. |
| Cross-surface conventions | `cross-surface-conventions.test.mjs` | 4 surfaces × 5 invariants + dilate + heatmap clipPath. | 3D top-camera numeric projection DEFERRED (text-grep only). Otherwise complete. |
| Heatmap-shader row-flip | `heatmap-shader-orientation.test.mjs` | grep on `jSrc = cellsY - 1 - j`. | OK. |

---

## 2. The shared invariant the four inversions violate

**Path-monotonicity invariant.** For a fixed source array S and two listener positions A and B in the same outdoor field, if every direct path from any source `s ∈ S` to B passes through at least as many solid surfaces (walls, roofs, podia) as the corresponding path to A — and no path to B passes through STRICTLY FEWER — then `SPL(B) ≤ SPL(A) + ε` at every frequency band, where `ε` ≤ 2 dB.

This is one stronger than "behind-wall ≤ clear-LOS." It says: **adding obstacles between source and receiver, holding all else equal, can only attenuate.** It is impossible — physically — for adding a second crossed wall to a path to LIFT the receiver SPL above the single-wall case.

- **I1** violated it because the SW corner cell ran a vertical-edge Maekawa bypass while mid-wall cells did not.
- **I2** violated it because the arcade-roof-inner edge and the building-wall-top edge were counted as parallel bypasses when they're the same physical eave.
- **I3** was within Pierce-Hadden tolerance but user perceived inversion — suggests the invariant should also bound the spatial GRADIENT.
- **I4** violated it because Maekawa contributions from EACH crossed wall summed in parallel — N walls in series produces N bypasses, when physics says the deepest IL wins.

**Why this is the right invariant**: testable from outside (no need to reach into the algorithm), covers all four bugs from one statement, frame-invariant. The user can VERIFY by intuition: "B has more stuff between it and the speaker than A; B must be quieter than or equal to A." Locked-value tests cannot do that.

---

## 3. Proposed regression fixture matrix

| # | Test case | Source layout | A (baseline) | B (more occluded) | Expected | Tolerance | Catches |
|---|---|---|---|---|---|---|---|
| R1 | Behind-wall ≤ clear-LOS at same angular position | 4 horns at minaret | (-1.5, -2, 1.7) | (1, -2, 1.7) | SPL(B) ≤ SPL(A) + 1 dB | 1 dB | I4 directly |
| R2 | Behind 2 walls ≤ behind 1 wall (serial-bypass cap) | 1 horn at minaret | (5, 9, 1.7) — 1 wall | (15, 9, 1.7) — 2 walls | SPL(B) ≤ SPL(A) | 0.5 dB | I4 root pattern |
| R3 | SW corner not louder than nearest clear-LOS cell | 4 horns at minaret | (3, -2, 1.7) | (-1, -2, 1.7) | SPL(corner) ≤ SPL(mid-row) + 2 dB | 2 dB | I1 — current test only vs average |
| R4 | Inside-near-wall ≤ outside-under-arcade (SOUTH arcade) | 4 horns at minaret | (-1.5, -2, 1.7) | (1, -2, 1.7) | SPL(B) ≤ SPL(A) + 1 dB | 1 dB | I2 south-arcade variant |
| R5 | Arcade roof material change propagates (AZAN source) | 4 horns at minaret | West arcade listener, concrete roof | Same listener, acoustic-tile | Δ ≥ 1 dB at 1 kHz AND 4 kHz | 1 dB | v=641 user case, FORCES azan source |
| R6 | Same but indoor speaker | 1 indoor (8, 9, 2.5) | Same listener, concrete | Same listener, acoustic-tile | Δ ≥ 0.3 dB at 4 kHz | 0.3 dB | Original v=641, smaller-but-nonzero delta locked |
| R7 | Monotonic along radial slice | 4 horns at minaret | 11 cells along y=-2 | NO cell > 3 dB above BOTH neighbors | spatial-gradient bound | 3 dB | I3 + future spike bugs |
| **R8** | **No-inversion across N²/2 pairs in 9-cell ring** | 4 horns at minaret | 9 cells south of building | wallCount(Q) > wallCount(P) → SPL(Q) ≤ SPL(P) + 1 dB | 1 dB | **Path-monotonicity in full. ONE assertion covers all four bugs.** |
| R9 | Adding building ≤ free field | 1 horn at (-2, 5, 3) | (-4, 5, 1.7) free field | Same point with building present | SPL(with) ≤ SPL(free) + 2 dB | 2 dB | "Adding obstacles never lifts" sanity check |
| R10 | Register computeSPLGrid as 5th cross-surface surface | n/a | n/a | n/a | Path-monotonicity contract enforced | n/a | Convention parity |

Priorities (catch ratio per LOC): **R8 > R2 > R7 > R1 > R5 > R6 > R3 > R4 > R9 > R10**.

---

## 4. Same-PR compliance audit, last 30 commits

Same-PR test compliance is much HIGHER than the May-2026 baseline — every diffraction/heatmap fix in this run carried a test. **The DEFECT is what those tests assert.**

| Commit | Fix | Test added? | Asserts invariant or value? |
|---|---|---|---|
| v=634 inWall classification | YES | Monotonic slice. Good shape. |
| v=636 arcade-roof material picker | YES | UI wiring only. OK. |
| v=637 surau podium 4/R | YES | Value. |
| v=638 walk-mode 4/R outdoor | YES | Value + flag-off-parity. |
| v=639 overhead reflection | YES | Material-sensitivity invariant. Good. |
| v=640 porch enclosure | YES | Mostly invariants. |
| v=641 porch lift drive | YES | Source-grep. WEAK. |
| v=642 porch closed-enclosure | YES | **MAGNITUDE WALKED BACK** to match code. Highest-risk row. |
| v=644 vertical-edge IL floor | YES | Locks +7 dB. Value, weak. |
| v=645 IL floor 12 → 16 | YES | Value. |
| **v=646 roof-eave diffraction** | YES | **Enumeration shape only, NO SPL value.** This commit IS the one that shipped I2's double-count. A SPL-magnitude assertion in this same PR would have caught the regression before v=647 was needed. |
| v=647 interior-louder inversion | YES | One listener pair. Invariant-shaped but scope = 1 pair. |

Concrete flagged rows:
- **v=646** — test had no SPL bound; **single line of "cell SPL must not exceed same cell with roof-edge disabled" would have failed v=646 and saved v=647**.
- **v=642** — magnitude walked back. Add R6 fixture pinning the smaller-but-nonzero delta.
- **v=644 / v=645** — pin values. Replace with invariant R3.

Of 12 fix commits: **2 weak-test, 3 value-locked where invariants would serve better**. Compliance on the surface ≈ 92%; compliance on what-the-test-actually-protects ≈ 50%.

---

## 5. Architectural smells in existing tests

1. **Locked-value tests where invariants belong.** `diffraction-corner.test.mjs` (C) compares to a different angular position (mid-wall average); blind to corner-exceeds-LOS-on-same-row. (A/B) grep for the constant 16.0 — brittle to refactor.

2. **Source-grep used in place of behavior.** `porch-lift.test.mjs` (G) greps for `computeDiffractionContributions(` — passes behavior question with a syntax check.

3. **Single-position pin in inversion tests.** `diffraction-interior-not-louder-than-exterior.test.mjs` (B) — exactly ONE pair. Replace with R1+R8 sweep.

4. **Material magnitudes walked back to whatever the code does.** `porch-lift.test.mjs` (C). Cite a Dr. Chen-sourced number, or pin a relative ordering — not the magnitudes the code happens to produce.

5. **Tests that pass for the wrong reason.** `diffraction-roof-edge.test.mjs` (A)(C)(D) — all check enumeration shape, none check SPL magnitudes. Passed all the way through v=646 while shipping the I2 double-count.

6. **No shared fixtures.** Every diffraction test reads materials.json independently, builds the same surau room object inline. A shared `tests/fixtures/heatmap-scenes.mjs` would cut ~600 lines and let R1-R8 use the EXACT same scene the user reports inversions on.

---

## 6. Cross-surface conventions fixture status

`tests/cross-surface-conventions.test.mjs` exists and is in good shape.

**Covered**: Y-axis, X-axis, north-arrow, scale-bar, units, registry guard, `dilateGridForDisplay`, heatmap clipPath in print + insideAt parity in 3D, Phase 7 wall-thickness gates.

**Missing / deferred**:
- 3D top-camera **numeric** projection — text-grep only. Action: Viktor's matrix-capture debug task open.
- The 5th implicit surface — `computeSPLGrid` — is **not registered**. The path-monotonicity invariant (R8) is a CONTRACT this grid must obey on a par with axis sign. **Register a 5th entry** `{ id: 'spl-grid', file: 'js/physics/spl-calculator.js', mode: 'invariant' }` and hang the path-monotonicity sweep off it.

---

## 7. If I write ONE fixture next, it's this

**`tests/heatmap-path-monotonicity.test.mjs`** — the path-monotonicity invariant (R8).

```
Fixture: surau preset, all-concrete walls, 3-side arcade, podium ext 3 m,
         4 azan horns at minaret.

Probe: 5×5 grid of listener cells at z=1.7, spanning
   x ∈ {-4, -2, 0, 2, 6, 10, 14, 18, 22}
   y ∈ {-6, -2, 2, 6, 9, 13, 17, 19, 22}
   (Filter out cells INSIDE wall annulus — -Infinity by design.)

For each cell:
   (a) SPL via computeMultiSourceSPL at 1 kHz
   (b) wallCount = Σ over 4 sources of wallsCrossedByPath(src, cell, room).length

For every pair (P, Q) within 5 m:
   IF wallCount(Q) > wallCount(P) AND solidCount(Q) ≥ solidCount(P)
   THEN assert SPL(Q) ≤ SPL(P) + 1.5 dB.

Repeat at 4 kHz and 250 Hz (multi-band).
```

**Why this is THE one**:
- Single sweep catches I1, I2, I3-shape, I4, and any future inversion.
- Does NOT require an oracle. No Maekawa values, no Pierce-Hadden corrections, no absorption magnitudes. Asks ONE question: does adding obstacles ever lift the field?
- Invariant-shaped — future physics improvements don't break it. Only regressions break it.
- ~150 LOC.
- Supersedes 3 weaker tests (diffraction-corner C, diffraction-interior-not-louder B, diffraction-roof-edge implicit).

**Integration**: Register the file as a "must-pass before any heatmap-touching commit" gate via the same-PR hook (already exists per CLAUDE.md §7).

---

## Coordination notes

- **Dr. Chen**: my job is to have R8 ready and failing for the I4 pair so her fix has a ready-made test.
- **Martina**: her fix should also satisfy R2 (behind-2-walls ≤ behind-1-wall). If her fix passes R8, the broader inversion family is sealed.
- **Theo (regression-curator)**: needs four new rows in `docs/REGRESSION_INDEX.md` — RL-017 (I1, GUARDED), RL-018 (I2, GUARDED), RL-019 (I3, UNGUARDED until R7), RL-020 (I4, UNGUARDED until R1 + R8).

Proposed new files:
- `tests/heatmap-path-monotonicity.test.mjs`
- `tests/fixtures/heatmap-scenes.mjs`
