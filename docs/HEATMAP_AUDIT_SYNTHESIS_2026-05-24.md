# Heatmap Audit Synthesis — 2026-05-24

Three specialists audited the heatmap physics pipeline independently. Their reports landed in:
- `docs/CHEN_HEATMAP_AUDIT_2026-05-24.md` — physics model (Dr. Lena Chen)
- `docs/MARTINA_HEATMAP_CODE_AUDIT_2026-05-24.md` — code architecture (Martina Weiss)
- `docs/SAM_HEATMAP_COVERAGE_AUDIT_2026-05-24.md` — test coverage (Sam Reyes)

This document collates them into a single prioritized plan. **Nothing has been committed yet. Nothing has been pushed. The user has not signed off on this plan.**

---

## 1. All three audits converge on the same root cause

| Audit | What they call the root | The "code" sentence |
|---|---|---|
| Dr. Chen | E1 + E2 (P0) | `computeDiffractionContributions` energy-sums Maekawa IL across EVERY edge of EVERY wall in wallsCrossed; bent path is never re-tested against other walls. |
| Martina | #1 + #2 (P0) | Diffraction loop iterates `for (const crossing of wallsCrossed)` and accumulates parallel bypass paths. `wallsCrossed` is the SHADOW signal AND the LOSS signal, conflated. |
| Sam | I4 root (catches all 4 inversions) | "Adding obstacles between source and receiver, holding all else equal, can only attenuate." That invariant has never been tested. |

**One sentence summary:** the diffraction module treats every crossed wall as a parallel bypass channel and energy-sums them. For paths crossing N walls in series, this gives **more parallel paths = more energy = louder than less-occluded cells**. ISO 9613-2 §7.4.2 + Maekawa 1968 §IV + Beranek §5.5 all say the same thing: **for multiple screens in series, use the single most-effective screen**, not a sum.

The four inversions (SW spike, interior-louder-than-exterior, listener-6 hotspot, B-behind-wall-louder-than-A) are all the same bug viewed from different cells.

---

## 2. The pipeline ISN'T conceptually wrong at the top level

All three audits explicitly note this. The decomposition `direct + diffuse + diffraction + reradiation + overhead-reflection + porch-reverb` is the right physics shape. The per-band per-material per-opening TL pipeline is structurally sound for ISO 12354-1.

**What's broken** is:
- The contracts between those six terms (Martina)
- The fact that diffraction has been the dumping ground for "this corner is too bright / too dark," accreting per-edge floors and per-prefix gates instead of being restructured (Martina)
- The tests pin VALUES where they should pin INVARIANTS (Sam)

This is the architectural disease the user has been the QA team for. Fix it once and the rest stops.

---

## 3. Recommended fix sequence

Two phases. **Phase A (substrate)** lands before any physics rework. **Phase B (physics)** lands on top of A.

### Phase A — Substrate (Sam + Martina, ~16-20 hours total)

A0. **Write Sam's R8 path-monotonicity fixture FIRST.** `tests/heatmap-path-monotonicity.test.mjs`. Surau preset, 5×5 listener grid, assert SPL(Q) ≤ SPL(P) + 1.5 dB for every pair where wallCount(Q) > wallCount(P). At 1 kHz, 4 kHz, 250 Hz. **This test WILL fail on current code at the I4 pair** — that's the point. It becomes the green-light for the physics rework. (~150 LOC, ~1 hour to write + verify it fails for the right reason.)

A1. **Extract `wall-geometry.js`** — move `resolveWallGeometry`, `resolveOverheadGeometry`, `wallFootprintLine`, `signedDistanceToLine2D` out of `diffraction.js` into their own module. Diffraction, reradiation, and wall-path all import from it. No behavior change. (~2 hours, low risk.)

A2. **Centralize `bandIndexForFreq`** — one shared snap-to-nearest implementation. Delete inline copies in porch-enclosure, reradiation. Behavior change: porch and reradiation now snap to nearest instead of -1 / 0 fallback. Add a test before. (~2 hours, low risk.)

A3. **Hoist `extractPorches`, `extractOverheadReflectors`** into `precomputeSPLContext`. Compute `drive_dB_per_porch_per_source[band]` ONCE per frame instead of recomputing the whole physics stack per cell × per source. **This also kills Martina's bug #5 (porch midpoint diffraction running its own copy of the parallel-bypass bug).** (~3 hours, medium risk — verify per-cell cost regression.)

A4. **Promote `wallId` to a tagged object** `{ scope, side, kind, edgeIdx? }`. Update producers (wall-path) + consumers (diffraction, reradiation, porch). Add `keyToId(id)` helper for debug logs. (~4 hours, medium risk — touches 5 modules.)

A5. **Add `assertSPLContext(ctx)` at the consumer boundary.** Make `enable` mandatory in `computeDiffractionContributions` and `computeReradiationContributions`. Delete the load-bearing `??` defaults. (~4 hours, low risk.)

A6. **Add R1-R7 fixtures** alongside R8 as targeted regression locks. Include the v=641 indoor-source material-change case as R6 to prevent the v=642 "fixture-walked-back" silent regression. Replace the value-locked SW corner test (v=644/v=645) with the invariant R3. (~3 hours.)

**Phase A deliverable:** clean substrate. R8 fixture fails on current code at the I4 inversion. Diagnostic logs are reliable. Material-rename typos are no longer silent. The breakdown panel and the heatmap probe agree.

### Phase B — Physics rework (Dr. Chen, ~3-4 days)

B1. **E1 + E2 + E12 architectural rewrite of `computeDiffractionContributions`.** Replace the `for (crossing of wallsCrossed) for (edge of edges)` energy-sum with **per-path shortest-detour**:
1. Enumerate candidate physical edges (de-dup'd by corner-group — fixes E11).
2. For each, compute the bent path AND test it against the room — accumulate TL on any walls the bent ray itself crosses.
3. Keep the realisable path with the LOWEST total attenuation (= loudest contribution).
4. Apply Maekawa IL with the existing `thickBarrierIL` formula (already implemented for WallLAB, just not wired here).
5. Energy-sum with direct (post-TL).

   R8 fixture must pass for this to be considered done. R1, R2, R4 (the inversion-shaped tests) must also pass.

B2. **E11 corner-group dedupe** — same physical corner (e.g., SW) gets enumerated multiple times under different (wallId, edgeId) keys; the v=647 skipAxis dedupe only catches the arcade-vs-building-wall case. Generalize to group-by-corner. (~2 hours, lands inside B1's rewrite.)

B3. **E6 series-TL fix** — replace additive TL sum with `max + 10·log10(N)` per ISO 12354-1 §B.5. Currently masked by E1 inflating diffraction; will under-predict once B1 lands. (~1 hour.)

B4. **Remove the 16 dB IL floors** — the parallel-bypass-cap workarounds in `diffraction.js`. Phase B1 makes them unnecessary; keeping them after the rewrite would double-cap. Verify R3 still passes without the floors. (~30 minutes, part of B1.)

**Phase B deliverable:** the diffraction module computes physics, not workarounds. All four user-reported inversions vanish. R8 + R1-R10 pass.

### Phase C — Deferred (next release, NOT this push)

C1. **E7 thick-barrier IL with real `thickness_m` data.** Lin (docs-writer) specs `thickness_m` field in `data/materials.json`. Dr. Chen wires `thickBarrierIL` formula end-to-end. The 16 dB floor goes away entirely; corner IL becomes data-driven. Coordinate with Lin's product-catalogue sub-hat.

C2. **E4 ground-reflection thickness dedupe** — currently every edge emits both `direct` and `ground` variants summed in parallel. After B1, the multi-path sum is gone; the ground reflection becomes a property of the single dominant path, not an additive contributor.

C3. **E8 + E9 porch enclosure** — switch to Beranek S_open form and open-face drive point per Dr. Chen's spec.

C4. **Sora's auralization Phase W.x** — unrelated, walk-mode work.

---

## 4. Effort estimate and risk

| Phase | Effort | Risk | What unblocks |
|---|---|---|---|
| A0 (R8 fixture) | 1 hour | low | physics rework can be verified |
| A1-A6 (substrate) | ~16-20 hours | medium | physics rework can be done cleanly |
| B1-B4 (physics) | ~3-4 days | medium-high | inversions disappear |
| C1-C4 (deferred) | next release | low | catalogue hardening, polish |

**Total before this can be pushed: ~5-6 focused days.**

The chain of 30+ local commits since v=606 includes a lot of substrate work that should be SQUASHED before push — many of them were workarounds for bugs Phase B fixes properly. Recommended push strategy:
- Keep the 30+ commits as the development trail.
- Cut a `phase-8-physics-rework` branch from the current HEAD, do Phase A + B on it, then squash the entire chain into a clean commit set: "Phase A substrate," "Phase B physics rework," "Phase B regression fixtures."
- Original chain stays in local reflog for archaeology.

---

## 5. Open questions for the user (Dr. Chen flagged these)

| Q | What it decides | Dr. Chen's recommendation |
|---|---|---|
| Q1 | Stay first-order ISO 9613-2, or escalate to GTD/UTD? | Stay first-order. GTD/UTD is overkill for browser-render heatmap; cost is 5× per-cell. |
| Q2 | Add `thickness_m` to `data/materials.json` this week, or defer to Phase C? | Defer to C1 — Phase B works without it; the floor goes away once thickness is data-driven. |
| Q4 | Lock a 6-point listener verification matrix (A/B/C/D/E/F) for golden-test? | Yes — Sam's R8 + a 6-point inspection panel makes the next inversion findable in seconds. |
| Q5 | Bake matrix into `tests/golden-spl-surau.test.mjs` with Sam as owner? | Yes — R8 is the broad gate, golden-spl is the targeted-cell pin. |

---

## 6. What the audits agree we should NOT touch

(All three flagged independently — leave alone.)

- `scene.scale.x = -1` and downstream X-negation sites (10 commits to land; documented in CLAUDE.md §6).
- `_outdoor` flag forking in `computeSPLGrid` (one path with two parameter sets; asymmetry is the point).
- `wallInsetPolygon` annulus discard (Phase 7 fix; genuinely needed).
- `squareCellCounts` (0.5 m cell target empirically right).
- `scene:reset` + nuclear disposal in scene.js (frame-perfect cleanup matters).
- Pierce-Hadden `wedgeIL` + `computeCornerDiffractionContributions` (deprecated but exported; keep until commit (i)).
- The per-band per-material per-opening TL pipeline (`wall-path.js` + `bandIndexForFreq` + materials catalogue) — structurally sound.

---

## 7. What to tell the customer if asked TODAY

The honest answer: **the heatmap is reliable for the closed-indoor case (RoomLAB rectangular rooms with no surauStructure)**, where the parallel-bypass bug never triggers (only one or zero walls between source and receiver). The bug surfaces specifically in OUTDOOR mode with multi-wall paths — the surau azan-horn case, the auditorium-with-lobby case, anything with arcade/portico geometry plus walls in series.

For the surau exterior demo, the values are within ±5 dB of correct in clear-LOS zones and over-predict by 3-8 dB in heavily-shadowed corner zones. The relative pattern (which sources dominate, which areas need treatment) is mostly right; the absolute values in shadowed cells are not.

If shipping is on the calendar before Phase B lands, **do not ship the outdoor heatmap as a contract deliverable** — the indoor cells, RT60, STIPA, line-array math, and the print proposal are all unaffected.

---

## 8. Decision points the user needs to make

Before I touch any code I need a sign-off on:

**D1.** Phase A + B is ~5-6 days of focused work. Confirm this is the right investment vs. shipping a workaround (e.g., disable Tier 1a outdoor diffraction entirely and ship without it; the indoor heatmap is unaffected).

**D2.** Push strategy: squash-and-replace the 30+ commit chain (D2a), or push the chain as-is after Phase B lands (D2b). D2a gives a clean history; D2b preserves the audit trail in git.

**D3.** Dr. Chen's Q1, Q2, Q4, Q5 (above).

**D4.** Do we want a "tier 1a outdoor disabled" toggle as an interim safety net, so the surau preset shows clean direct + reverb (closed-LOS sources only) until Phase B lands? This would give Felix a non-misleading PA system preview today.

Nothing happens until you've signed off on D1-D4. No commits, no push, no cache bump.
