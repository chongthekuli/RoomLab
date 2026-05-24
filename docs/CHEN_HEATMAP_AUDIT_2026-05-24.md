# Dr. Chen — Heatmap Physics Audit, 2026-05-24

Surau preset, outdoor mode, 4× HS880 minaret horns active. User-reported inversion: a fully-shadowed listener behind the south wall (B = +92.6 dB) reads louder than a clear-LOS listener outside the SW corner (A = +89.9 dB).

This is the second inversion in a fortnight. The first (v=647) was patched with `TOP_EDGE_IL_FLOOR_DB`; this one demands the same patch on different geometry. **The pattern says the model itself is wrong, not the constants.** I'm going to stop tuning floors and say what I should have said in the audit two weeks ago: the energy-sum-over-every-edge-of-every-crossed-wall pipeline is conceptually wrong for multi-barrier outdoor diffraction. ISO 9613-2 §7.4.2 is unambiguous on this. We will not stop seeing inversions until the architecture changes.

---

## Section 1 — Conceptual errors

### E1. Parallel sum across edges of serially-crossed walls (P0, inversion-causing)

- **Current code** (`diffraction.js` lines 549–654, `spl-calculator.js` lines 423–446): for each `crossing` in `wallsCrossed`, enumerate its free edges (top + 2 verticals + roof perimeter), compute Maekawa IL on each independently, and **energy-sum all contributions** into `diffractionPowerSum`. With 3 walls crossed and 3 edges each, that's up to 9 parallel bypass paths summed in pressure². Plus their ground-reflected twins → up to 18.
- **Standard** (ISO 9613-2:1996 §7.4.2): *"Where there are multiple barriers between source and receiver, only the most effective single barrier shall be considered."* Maekawa-Tachibana, Pierce *Acoustics* §9.5 (wedge diffraction), and Beranek *Noise & Vibration Control* 2nd ed. §5.5 all agree: serial barriers do not provide parallel-summed *bypass* paths. They provide a **single dominant detour** whose IL ≈ max(IL_barrier_i), with a small correction (≤ 3 dB at typical geometries) for the second barrier on the same detour ray.
- **Geometric reason the current code can only over-predict**: every additional edge added to a pressure²-sum can only INCREASE the total. The Maekawa IL is bounded above (24 dB clamp + thick-barrier bonus), so adding more edges to a serially-blocked path makes the listener *louder*, not quieter. This is the mechanism that produces "behind two walls is louder than behind one wall."
- **Severity**: P0. This is THE inversion. B is louder than A because B's path crosses 3 walls and inherits 9–18 bypass terms; A's path crosses 1 wall and gets 3 terms. The pressure² sum of more terms (all of which are valid Maekawa values for their *individual* edge) exceeds the sum of fewer terms.
- **Files**: `js/physics/diffraction.js` (`computeDiffractionContributions` loop), `js/physics/spl-calculator.js` lines 423–446 (caller).

### E2. Bent-path detour does not re-test against OTHER walls (P0, inversion-causing)

- **Current code** (`diffraction.js` 567–615): each candidate edge yields `(S, E, R)` via `diffractionPointOnEdge`. The bent path `S → E → R` is then assumed to be a free-field detour. It is never tested against the room geometry. So a path that bends OVER `parent_wall_west.top` at edge point E and then descends back THROUGH `parent_wall_north` to reach listener B is counted as if it bypasses everything.
- **Standard / physical**: Maekawa applies to a single screen. If the detour ray itself crosses ANOTHER solid surface, that crossing must contribute its own TL (Pierce §9.5; ISO 9613-2 §7.4.1). The current model gives the listener a free ride through the second wall.
- **Severity**: P0. The dominant contributors in B's breakdown (`parent_wall_west.top` 85 dB, `parent_wall_north.right` 85 dB) bend over one wall but then re-traverse another wall on the descent. These paths are physically infeasible as written.
- **Files**: `js/physics/diffraction.js` (`computeDiffractionContributions`; add a per-path re-test via `wallsCrossedByPath(S, E, room)` + `wallsCrossedByPath(E, R, room)` minus the wall the edge belongs to).

### E3. Vertical-edge "corner" identity not enforced (P1, silent overestimate)

- **Current code**: the SW corner of the building is the line x=0, y=0, z∈[0,H]. This single physical edge is enumerable from FOUR different walls: `parent_wall_north.right` (v1=W,0 → v2=0,0; vertical edge at v2 = corner SW... wait, no — at v2.right is at (0,0)). And `parent_wall_west.left` (v1=0,D → v2=0,0; right at (0,0)). The `edgeKey` dedupe (line 276) catches these two — good. But it does NOT catch `arcade_roof_west`'s south perimeter edge running along y=0 (which physically *is* the SW corner re-projected to z=4.4), nor `arcade_roof_south`'s west perimeter edge along x=0. These are at different z, so different keys, so they all fire as INDEPENDENT diffractors for the same physical corner geometry.
- **Standard** (Pierce §9.5 multi-edge GTD; UTD per Kouyoumjian–Pathak 1974): for a single physical corner, GTD says one diffracted ray exists per source-receiver pair, with one IL value. Stacking IL contributions from different z-values along the same vertical corner is non-physical.
- **Severity**: P1 (silent overestimate, ~+3 to +5 dB at corners). Becomes P0 in combination with E1.
- **Files**: `js/physics/diffraction.js` `enumerateRoofPerimeterEdges` + `enumerateFreeEdges`. Needs a corner-group key, not a (geometric-endpoints) key.

### E4. Ground-reflected diffraction stacks with thick-barrier IL floor (P1)

- **Current code** (`diffraction.js` 622–652): for each diffraction edge, a second path is computed by mirroring the source through z=0, computing a separate Maekawa IL on the imaged geometry. The same `VERTICAL_EDGE_IL_FLOOR_DB = 16` is then **re-applied** to the ground-image path (lines 627–636).
- **Standard**: the thick-barrier IL floor (ISO 9613-2 §7.4 caps and Maekawa 1968 thickness extension) is a correction for the *physical thickness of the diffracting edge*, not for the source-image geometry. The ground-reflected path uses the SAME physical edge — applying the floor a second time double-counts the thickness correction. For hard ground (G=0, no attenuation), the result is two 16 dB-floored paths summing to ~13 dB IL instead of the ~13 dB single edge prediction.
- **Severity**: P1 (silent +3 dB lift on diffraction-dominated cells).
- **Files**: `js/physics/diffraction.js` lines 622–652.

### E5. Diffraction is summed with `directPressureSum` even when `direct` is "through 159 dB of wall" noise (P2)

- **Current code** (`spl-calculator.js` line 530): `totalPower = directPressureSum + reverbPowerSum + diffractionPowerSum + …`. For B, `direct` is -57.9 dB through 159 dB combined TL — effectively zero contribution. That's correct, but it does mean diffraction *alone* drives the result, which exposes E1+E2+E3 fully.
- **Standard**: the pipeline shape is right. The issue is only that diffraction is being over-counted; once E1/E2 are fixed, this works.
- **Severity**: P2 (architectural — flag to revisit after E1–E3 fixes).

### E6. Wall TL on direct path is summed (additive dB) for every crossing without checking series correlation (P1)

- **Current code** (`wall-path.js` `transmissionLossDb`, lines 331–355): `totalTL = Σ tl_i` over all solid crossings. So a path through 3 walls of concrete = 3 × 53 = 159 dB.
- **Standard** (ISO 12354-1, ISO 717-1 flanking treatment; Beranek §10): in-series transmission losses do NOT simply add. The path through two walls of the same construction is roughly `TL_wall + 6 dB` for thin walls (the two are correlated) and only approaches `2·TL` in the limit of perfectly decoupled, dissimilar partitions. The current additive form OVER-predicts TL by 30–60 dB on multi-wall outdoor paths — which is why E1's diffraction sum wins so easily.
- **Severity**: P1. Note: this CURRENTLY *helps* by killing the direct contribution and forcing the diffraction-only result. After E1 is fixed it becomes an under-prediction of the dominant path (which would then be a single barrier).
- **Files**: `js/physics/wall-path.js`. Replace additive sum with `max + 6` or `max + 10·log10(N)` per ISO 12354-1.

### E7. The thick-barrier IL floors are knobs, not physics (P1)

- **Current code**: `VERTICAL_EDGE_IL_FLOOR_DB = 16` and `TOP_EDGE_IL_FLOOR_DB = 16` were tuned twice (v=645 → v=647) to suppress visible inversions. They override the Maekawa formula whenever Maekawa returns < 16 dB.
- **Standard**: thick-barrier correction per Maekawa 1968 + ISO 9613-2 §7.4 is `IL_thick = IL_M(δ) + max(0, 10·log10(w/λ))` (see `thickBarrierIL` already in this same file at line 134 — properly implemented for WallLAB, not used here). For a 0.25 m concrete wall at 1 kHz, the thickness bonus is 0 dB (λ > w). At 4 kHz, +4.6 dB. **Not 16 dB across all bands.** The 16 dB floor is over-clamping HF and under-clamping LF.
- **Severity**: P1 (visible band-shape error in the heatmap; mid-band over-prediction, HF under-prediction).
- **Files**: `diffraction.js` lines 544–545 + their usage at 588–600. Replace with `thickBarrierIL(opt.delta, lambda, wall_thickness_m)` using actual material thickness from materials.json (most current entries lack a thickness field — that needs to land too).

### E8. Porch enclosureFactor heuristic — re-evaluation (P2)

- **Current code** (`porch-enclosure.js` 192–253): computes a closed-surface Sabine R from the three present surfaces (roof, podium, back), then multiplies the energy-domain lift by `enclosureFactor = S_present / S_total`. Beranek-style.
- **Standard** (Beranek 1992 §10.6 — semi-open enclosure): the established treatment is to add S_open at α=1 to the absorption budget so it dampens the buildup, then use Sabine on the FULL S_total. The closed-Sabine-then-scale approach in the code OVER-amplifies low-α porches (acoustic-tile case) and UNDER-amplifies high-α porches (concrete case). Comparing the two formulations on the surau west arcade:
  - Beranek standard: `A = α·S_present + 1·S_open`, `R_porch = A/(1-A/S_total)`, lift = 10·log10(4/R_porch).
  - Current code: `R_closed = α·S_present/(1-α)`, lift_closed = 10·log10(4/R_closed), lift = lift_closed + 10·log10(S_present/S_total).
  - For α=0.3 concrete + 50% open: standard gives ~−3 dB lift; current gives ~−1 dB lift. ~+2 dB systematic bias.
- **Severity**: P2 (smooth bias, not inversion-causing).
- **Files**: `js/physics/porch-enclosure.js` `ensurePorchBands`. Switch to Beranek S_open-at-α=1 form. I signed off on the heuristic in the rush of Phase 8; on re-reading Beranek §10.6 the standard form is cleaner AND right.

### E9. Porch drive-point at polygon centroid + z=roof/2 (P2)

- **Current code** (`porch-enclosure.js` 312–315): drive point = polygon centroid at z = z_ceil/2. For an outdoor source whose direct path is blocked by the building, this point is INSIDE the porch on the open side — i.e. the drive is what's already arriving inside the porch via direct + diffraction. The lift on top of THAT drive is the multi-bounce buildup.
- **Standard** (Beranek §10.6 — semi-open enclosure model): the drive should be evaluated at the *open-face centroid* (the energy flux entering the enclosure), not the volume centroid. Using a volume centroid double-counts the diffraction term (which already shows up in the drive's `getDirectSplDb` closure, lines 488–525), then lifts it again by the porch's reverb constant.
- **Severity**: P2 (drive ~1–2 dB high; lift then propagates that).
- **Files**: `js/physics/porch-enclosure.js`. Move drive point to the open-face centroid (front edge of the arcade polygon, perpendicular from building wall × half depth outward).

### E10. Overhead reflection — image source via polygon-edge crossings (P2)

- **Current code** (`overhead-reflection.js` 121–128): `t = (zTop - src.z)/(mirroredL.z - src.z)`; then `pointInPolygon2D(hitX, hitY, poly.vertices)`. If the hit lands OUTSIDE the polygon, the reflection contributes zero.
- **Bug case**: if the reflection point is just outside the polygon edge (within a wavelength), real diffraction at the polygon edge bends the reflection into the receiver — but the binary in/out test gives a sharp 0 dB contribution. The shadow boundary at the roof edge will show a step discontinuity.
- **Standard**: GTD says the specular-reflection field has a Fresnel-zone falloff at the edge, not a hard cliff. Pierce §9.6.
- **Severity**: P2 (sharp boundary in the heatmap visible at arcade edges).
- **Files**: `js/physics/overhead-reflection.js`. Lower priority; the visual artifact is mild.

### E11. `enumerateRoofPerimeterEdges` "inner edge" co-location: not extended to multiple arcades (P1)

- **Current code** (`diffraction.js` 362–398): skips the inner perimeter edge co-located with the building wall (the v=647 fix). Detects via `refl.side ∈ {south, north, east, west}` + axis-coord match.
- **Bug case**: when TWO arcades meet at a building corner (e.g. surau has south + east + west arcades all present), the south arcade's WEST edge (running along x=0, y∈[1.5, 1.5+something]) is at the SAME physical location as the west arcade's SOUTH edge. Both currently fire as independent diffractors. Same physical edge, counted twice in the parallel sum that E1 is already mis-applying. Compounds E1+E3.
- **Severity**: P1 (additional +1.5–3 dB at building corners where arcades meet).
- **Files**: `js/physics/diffraction.js` `enumerateRoofPerimeterEdges`. Needs a corner-shared-edge detection alongside the building-wall co-location detection.

### E12. Bent-path with edge OUTSIDE shadow zone: contribution rejected on `il_db <= 0` but never validated for visibility (P1)

- **Current code** (line 574): `if (il_db <= 0) continue;` skips edges where the direct path's image into the edge falls in the "lit" zone (δ ≤ 0). That's fine for the SHADOW-vs-LIT test, but it doesn't validate that the bent path is *geometrically realisable* — the diffraction point E must lie on the FREE part of the edge, not behind another building.
- **Concrete failure**: for B, the dominant `parent_wall_north.right` edge is at (0, 0, z) — the SW vertical corner. The bent path from horn (NW corner area, z=7) to B (1, -2, 1.7) optimises E at some z in [0, H]. The bent ray from E descends to B and CROSSES `parent_wall_north` somewhere x∈[0,1], y=0. Currently no check. Tied to E2 but distinct: even if E2's wall-revisit test is added, the SAME wall as the diffracting edge needs special handling (the bent path properly bypasses *that* wall but not *others*).
- **Severity**: P1 (sub-case of E2 but worth its own line item — the SW corner case is the dominant contributor in the user's screenshot).
- **Files**: `js/physics/diffraction.js`. Same fix surface as E2.

---

## Section 2 — Recommended model corrections

### Correction for E1 + E2 + E3 + E11 + E12 — replace parallel-sum with per-path SHORTEST-DETOUR (P0)

The energy-sum-over-every-edge model is wrong in principle. Replace it with the following algorithm, which is what ISO 9613-2 §7.4.2 actually specifies operationally:

```
For each source S and listener R:
  1. If direct LOS is clear (wallsCrossed = []), use the direct path only — no diffraction.
  2. Otherwise, enumerate CANDIDATE physical edges in the room:
       - top edges of every wall whose footprint line lies between S(xy) and R(xy)
       - vertical corner edges of every such wall
       - roof perimeter edges (outer perimeter only, dedup'd by corner-group)
     A "candidate" edge is one whose Fermat-optimal bend point E places the bent
     path |S→E| + |E→R| in the shadow zone for that edge.
  3. For each candidate edge, COMPUTE the bent path SE + ER and TEST it against
     the room geometry:
       a. wallsCrossedByPath(S, E, room) minus the wall this edge belongs to
       b. wallsCrossedByPath(E, R, room) minus the wall this edge belongs to
     Accumulate per-band TL across any walls the bent path itself crosses.
     A "physically realisable" path has zero unexpected crossings (or low TL ones).
  4. From all realisable candidate paths, KEEP THE ONE WITH THE LOWEST TOTAL
     ATTENUATION (= LOUDEST CONTRIBUTION).
  5. Apply Maekawa IL on the kept edge ONLY, with thick-barrier bonus per
     `thickBarrierIL`. Sum (in pressure²) with direct path (post-TL).
```

**Why this is right** — ISO 9613-2 §7.4.2 explicitly says "the most effective single screen." Maekawa 1968 §IV says the formula is derived for a single edge; multi-edge GTD per Pierce §9.5 collapses to the dominant edge in the practical engineering case. Beranek §5.5 Table 5.7: "When two or more barriers lie between source and receiver, the noise reduction is approximately equal to that of the highest single barrier, plus 1–3 dB for the second barrier." So: ONE dominant path + a small additive correction for a second barrier on the same path, NOT a parallel sum across every edge of every wall.

The "shortest detour wins" framing is equivalent because Maekawa IL is monotonically increasing in δ (the detour) and monotonically increasing in barrier height; the lowest-IL path is the loudest contribution, and for a single physical sound to reach the listener, the lowest-IL path *is* the one nature uses. The energy in higher-IL paths is part of the SAME wavefront, not additional energy — that's the conceptual confusion the current code makes.

### Correction for E4 — ground-reflected diffraction shares the thick-barrier IL

The ground image path and the direct path share the same physical edge. Apply `thickBarrierIL(δ_direct, λ, w)` once; then for the ground image, apply Maekawa pure (no second thickness bonus) on the imaged geometry; energy-sum the two with the (1-G) factor on the ground path. Pierce §6.5 on image-source ground reflection: the image source is geometric, the absorption is in the reflection coefficient, the thickness correction is a property of the EDGE not the source.

### Correction for E6 — series-TL is not additive

Use `TL_total = max(TL_i) + 10·log10(N_solid)` where N is the count of solid crossings, per ISO 12354-1 §B.5 ("simplified flanking" form). For two concrete walls in series: `53 + 3 = 56 dB` not `106 dB`. For three: `53 + 4.8 = 58 dB`. This is a small correction in absolute terms but it shifts the direct-vs-diffraction balance materially.

### Correction for E7 — replace IL floors with real thick-barrier formula

`thickBarrierIL` is already implemented (line 134) and Dr. Chen-signed-off for WallLAB. Use it. Requires a `thickness_m` field on each wall material in materials.json — currently absent for most entries; need to add it. Defaults: concrete 0.20 m, gypsum 0.013 m, masonry 0.10 m, glass 0.006 m.

### Correction for E8 — Beranek S_open-at-α=1 form

```js
const A = alphaRoof*S_roof + alphaPodium*S_podium + alphaBack*S_back + 1.0*S_open;
const alphaAvg = A / S_total;
const R_porch = A / Math.max(1e-6, 1 - alphaAvg);
const lift_dB = 10 * Math.log10(4 / R_porch);
```

Then DROP the enclosureFactor multiplier — it's no longer needed because S_open at α=1 already does the partial-enclosure work. Beranek §10.6 eq. 10.13.

---

## Section 3 — Open questions for the user

### Q1. ISO 9613-2 first-order vs. higher-fidelity GTD

ISO 9613-2 §7.4 is a first-order engineering model designed for community-noise impact reports — single dominant barrier, no edge-to-edge diffraction, no creeping waves. Real GTD/UTD (Pierce §9.5) handles all of these but is ~10× the implementation effort and ~3× the per-cell compute. **My recommendation: stay first-order ISO 9613-2.** It's the standard reviewers will reference, and the surau use case doesn't justify GTD. Confirm?

### Q2. Wall thickness on materials.json

We currently have no `thickness_m` field. To do E7 properly, we need it. Should I (Dr. Chen) propose a list of defaults to Lin (docs-writer) for materials.json this week, or defer to a later session? My defaults would be: concrete-painted 0.20, gypsum-board 0.013, masonry 0.10, glass 0.006, wood 0.025, open-air 0.

### Q3. Three-arcade corner-edge dedupe — physical or geometric basis?

For E11 (south + west arcades sharing a corner edge), do you want corner-grouping by 3D-point co-location (cheap, tolerance-based), or by topological tagging (each physical corner gets an id at preset-build time)? Geometric is simpler; topological is exacter. Recommend geometric with 0.1 m tolerance — same as current `edgeKey`.

### Q4. Verification matrix on the fix

I want to commit to a 6-point matrix that any fix must pass before it ships:
- A (clear LOS outside SW corner): expected 89–91 dB
- B (behind south wall, in arcade footprint): expected 83–86 dB
- C (deep behind two walls, no arcade): expected 70–75 dB
- D (under the south arcade, on-axis): expected ~92 dB (porch reverb dominant)
- E (in the building, far from any wall): expected 30–40 dB (through-wall only)
- F (north qibla wall area, far from horns): expected 40–50 dB

Confirm these expectations are roughly your acoustical intuition? If not, I'm out of calibration and need to walk the geometry with you.

### Q5. Do we lock the test matrix into `tests/golden-spl-surau.test.mjs`?

Sam (qa-engineer) should own this. Pattern: load surau preset, freeze 6 listener positions, snapshot SPL values, fail-on-drift > 1.0 dB. Recommend yes; this is exactly the cross-surface convention pattern but applied to the physics.

---

## Section 4 — Suggested fix order

**This release (to remove the inversion):**

1. **E1+E2+E12 (one fix)**: rewrite `computeDiffractionContributions` to per-path-shortest-detour. ~3 days work. THIS removes the inversion. Cancel-fix-everything-else-and-do-this-first if compute budget is tight.
2. **E11**: corner-shared-edge dedup in `enumerateRoofPerimeterEdges`. ~2 hours. Folds naturally into (1).
3. **E6**: series-TL fix in `transmissionLossDb`. ~1 hour. Independent of (1), but should ship in the same release because (1) exposes it.

**Backlog (P1 fixes for next 2-3 releases):**

4. **E7**: real `thickBarrierIL` + `thickness_m` on materials. Coordinate with Lin for materials.json defaults. Remove the `IL_FLOOR_DB` knobs entirely. ~1 day + a materials.json PR.
5. **E4**: ground-reflected thick-barrier deduplication. ~2 hours.
6. **E8 + E9**: porch enclosure → Beranek S_open form + open-face drive point. ~half-day. Depends on golden-test coverage being in place first or it'll silently shift the surau numbers.

**Deferred (P2 — cosmetic / smooth bias):**

7. E5 — pipeline shape audit after (1). May resolve itself.
8. E10 — Fresnel-soft polygon edge for overhead reflection. Cosmetic.

**What I would NOT defer further:** E1/E2. The inversion the user reported is not a "still-tuning" problem. The user is right — we're patching symptoms. The first-order ISO 9613-2 model is well-defined and we are not implementing it. Two inversions in two weeks is the third regression in this family I've signed off on and I'd like to stop being part of the problem.

---

## One thing the implementation gets right that I wouldn't have expected from a draft engine

The per-band material-aware TL pipeline (`wall-path.js` + `bandIndexForFreq`) is correctly structured for ISO 12354-1 multi-band evaluation. The frequency-snap-to-nearest-band on log axis is the right convention. When E6 is fixed, this module will be solidly correct. Most draft engines I've audited use a flat 30 dB scalar; the current state of the per-band per-material per-opening lookup is genuinely above the bar I expected. Don't lose this in the multi-barrier rewrite — keep the same materials/opening surface and only replace the additive-sum step.

— Lena Chen, 2026-05-24
