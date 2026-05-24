# Heatmap SPL Pipeline — Code Audit (Martina Weiss, 2026-05-24)

**Scope reminder:** Code/architecture/contracts only. Dr. Chen owns the physics correctness call. I'm trying to answer the user's actual question: *"Is the heatmap built on the wrong concept?"* — translated into engineering terms, **"Is the architecture letting silent failures and contract drift produce wrong dB without complaint, so every fix uncovers a new face of the same disease?"** Answer: yes, in several specific ways. Below.

---

## Section 1 — Architectural issues

### 1. **P0 — Diffraction is energy-summed in parallel across every crossed surface, with no shielding / cap.** `js/physics/spl-calculator.js:423-446` + `js/physics/diffraction.js:549-654`

The bug Dr. Chen will scope. Code shape:

```
for (const crossing of solid) {                  // ← spl-calculator wraps this
  for (const edge of edges_of_this_wall) {
    totalPower += pow(10, Lp_detour / 10);       // direct path
    totalPower += pow(10, Lp_reflected / 10);    // ground-mirrored path
  }
}
```

Three architectural smells:

(a) Outer loop is over `wallsCrossed`. For a 3-wall-deep cell (Cell B: `parent_wall_north + parent_wall_west + arcade_roof_west`) the loop adds **three independent diffraction contributions** that all bypass the obstruction. The physics is wrong, but the *code shape* is the carrier. It treats diffraction edges as parallel bypass channels with no joint-IL ceiling and no "the second wall further attenuates the bypass found around the first" coupling. This is identical in shape to the SW-corner spike that v=647 patched with a 16 dB floor on the verticals — a per-edge floor is a poor man's fix for an architecture problem. The fix isn't another floor; it's restructuring this loop so that *additional* surfaces between source and receiver can only ADD attenuation to the dominant diffracted path, never open a new parallel channel.

(b) Direct + ground-reflected diffraction are both added to the SAME `totalPower` accumulator (lines 605 and 640). For hard ground (G=0) this adds +3 dB to every diffracted edge. With three crossings × three edges each × two paths, you're stacking 18 energy contributions for one source.

(c) `seenEdges` is per-source, scoped at line 513. Dedup is *only* by edge geometry, not by (edge, wall-pair-context). When a building-wall TOP edge and an arcade-roof INNER edge happen to land within 0.05 m (the COINCIDE_TOL_M check in `enumerateRoofPerimeterEdges`), the roof-inner skip and the edgeKey dedup are doing *the same job by two different mechanisms*. If either drifts, the other silently fails to catch what it was catching.

**Fix:** Restructure `computeDiffractionContributions` to **enumerate diffracting edges of the SCENE, not edges of each crossed wall**. Diffracted-path power should be `max_over_paths` (dominant edge) plus a small correlated-edge bonus, NOT `sum_over_walls_of(sum_over_edges)`. The wallsCrossed list should be an *input to gating shadow tests*, not an outer loop.

### 2. **P0 — `wallsCrossed` is the SHADOW signal AND the LOSS signal, conflated.** `js/physics/spl-calculator.js:217-219` + `js/physics/diffraction.js:474-494`

`wallsCrossedByPath` returns one structure consumed two ways:

1. `transmissionLossDb` sums TL across all crossings → the direct-path attenuation.
2. `computeDiffractionContributions` iterates the same list to enumerate edges to diffract over.

These are different physical questions. The crossings list is "what surfaces does the straight line ray pierce?" — correct for #1. But #2 wants "what is the OUTERMOST silhouette between S and R?" — a single edge (or edge chain) for a convex-shadow geometry, not a list of every wall. The code is using the convenient available data structure for the wrong question, and that's *what* enables the parallel-bypass bug.

**Fix:** Add a separate `silhouetteEdgesBetween(src, listener, room)` function whose return is geometric, not material. `wallsCrossed` stays as the TL signal.

### 3. **P0 — The 16 dB vertical/top edge floors are a band-aid in the wrong location.** `js/physics/diffraction.js:544-545, 591-600, 629-636`

```js
const VERTICAL_EDGE_IL_FLOOR_DB = 16.0;
const TOP_EDGE_IL_FLOOR_DB = 16.0;
```

These floors live INSIDE the diffraction module but only apply when `crossing.wallId.startsWith('parent_wall_')`. So:
- Standalone enclosures (huts, sub-rooms): zero floor.
- Polygon rooms: zero floor.
- Arcade roof perimeter edges: 16 dB floor via `isOverheadEdge` branch.

The floor compensates for issue #1 (parallel bypass) by burning each path down by 16 dB whenever it can. It will need a SIXTH layer next time the user finds geometry that doesn't start with `parent_wall_`. **REFACTOR-NEEDED**; do not add another floor.

### 4. **P0 — `porch._cachedBands` writes back onto an extractPorches() output that is rebuilt every call.** `js/physics/porch-enclosure.js:161, 193, 250` + `js/physics/spl-calculator.js:367`

`extractPorches(room)` is called once per `computeMultiSourceSPLFromContext` call — i.e. **once per cell** (10k cells on a 50 m field). Each call returns *fresh* porch objects. Then `ensurePorchBands` writes `porch._cachedBands` — but that cache lives on the freshly-allocated object that goes out of scope at the end of the cell evaluation. **The cache is doing nothing.** It allocates extra objects per cell.

Worse: the `_bandsLoggedForKey` singleton (line 175) at module scope DOES persist across calls. So the "porch v=642" log fires exactly once per unique material tuple ever — even after a material change, because the new material tuple gets a new log, but earlier ones are remembered forever (the singleton is one slot, not a Set). On a long session that mutates materials, the diagnostic is unreliable.

**Fix:** Hoist `extractPorches` into the SPL context. Cache lives on the context, not the porch.

### 5. **P0 — `getDirectSplDb` closure in `computePorchReverbPower` re-runs the FULL physics stack per source per porch.** `js/physics/spl-calculator.js:488-525`

Inside the per-source loop, the porch reverb path constructs an inline closure that calls `computeDirectSPL` AND `computeDiffractionContributions` AND `computeReradiationContributions` *again*, this time targeting the porch midpoint. So a cell that triggers a porch active contribution is now doing the entire physics stack TWICE — once for the listener, once for the porch midpoint. For 4 sources × 10k cells × 2x = 80k physics evaluations.

Worse, the **porch midpoint is geometric, not listener-position-dependent**. The drive level at the porch midpoint is *identical* for every cell inside the same porch. This belongs in the context build, computed once per source per porch per frame — not per cell.

Worse still, because diffraction is path-sensitive, the porch-midpoint diffraction sum is currently using `dd.wallsCrossed` (line 500) — wallsCrossed for the *porch midpoint*'s direct path. So the porch-drive computation is doing its OWN copy of the parallel-bypass bug from #1. Two bugs feeding one number.

**Fix:** Compute `drive_dB_per_porch_per_source[band]` ONCE in `precomputeSPLContext`. Per-cell lookup is then `pressureSum += pow(10, (drive_dB + lift_dB) / 10)` — pure dB arithmetic, no recursive physics.

### 6. **P1 — `bandIndexForFreq` vs `indexOf` vs Map-by-`indexOf(freq_hz)` are three different "snap to band" implementations.** `js/physics/wall-path.js:306-317` + `js/physics/reradiation.js:164` + `js/physics/porch-enclosure.js:289-295` + `js/physics/spl-calculator.js:92`

Four call sites, three behaviors:

| Call | Behavior |
|---|---|
| `wall-path.js:bandIndexForFreq` | Log-axis nearest, returns 0 on missing — defensive default |
| `reradiation.js:164` | `materials?.frequency_bands_hz?.indexOf?.(freq_hz)` — EXACT match, returns -1 on miss, early-exits |
| `porch-enclosure.js:291-295` | Inline log-axis nearest (duplicated) |
| `spl-calculator.js:92` | `materials.frequency_bands_hz.indexOf(freq_hz)` — EXACT match, returns -1 → R=0 |

If `state.physics.freq_hz` ever drifts from the exact band centres (e.g. UI lets the user type 700 Hz), the reradiation term and Hopkins-Stryker silently go to zero, the porch and wall-TL terms snap to nearest, the diffraction terms snap. Result: only some of the physics responds to the new frequency, no error, the heatmap looks plausible but is inconsistent.

**Fix:** One shared `bandIndexForFreq` import everywhere. Delete the inline copies.

### 7. **P1 — `useP15` gates re-radiation on `L_p_rev_inside_band_db` finiteness in spl-calculator, but reradiation.js gates on the flag re-read.** `js/physics/spl-calculator.js:377-381, 437-446` + `js/physics/reradiation.js:155-161`

Both sides guard, with different conditions, and `enable` defaults to `PHYSICS_P1_5_ENABLED` re-read from the imported module constant. Cross-couple this with feature-flag's load-time read of localStorage and you get: caller did everything right, ctx says enableTier1a:true, callee says "but the module-level PHYSICS_P1_5_ENABLED at IMPORT TIME was false on this origin, so I return zero." Audit cost: minutes to trace.

**Fix:** Route the flag through ctx exclusively. Delete the default in `reradiation.js` and `diffraction.js` — make `enable` mandatory.

### 8. **P1 — Material fallbacks silently use 0.05 absorption and 20 dB TL on missing material.** `js/physics/porch-enclosure.js:57-67` + `js/physics/overhead-reflection.js:48-71` + `js/physics/wall-path.js:340-348` + `js/physics/reradiation.js:172-178`

Five separate "default α / default TL" code paths. wall-path correctly emits a one-time `console.warn`. The other four silently return 0.05 absorption or 20 dB TL with no warning. If a future material rename happens in `data/materials.json` and the surau preset's `surauStructure.materials.arcade_roof` still says `'gypsum-board'`, EVERY consumer silently uses 0.05 — and the user reports "changing the arcade roof material does nothing" (which is exactly what they reported leading to Phase 8 Step 4).

**Fix:** Centralize material lookup in one helper that warns once per unknown id.

### 9. **P1 — `wallId` strings are constructed and pattern-matched across module boundaries with no schema.** `js/physics/wall-path.js:193, 269-275` + `js/physics/diffraction.js:329-330, 402-449, 588` + `js/physics/porch-enclosure.js:90`

`wallId` is a stringly-typed key encoding (a) which polygon, (b) which side/edge, (c) for overhead reflectors (kind, side). Consumers use `.startsWith()`, regex, and string-equality across 5+ sites. Two namespaces exist: diffraction's `parent_wall_north` and porch-enclosure's `wall_north` (no prefix). `wallId.startsWith('parent_wall_')` will match a hypothetical future `parent_wall_north_lower` introduced by partial walls. The 16 dB floor will apply to surfaces it wasn't audited for.

**Fix:** Promote `wallId` to a tagged object `{ scope, side, kind, edgeIdx? }`. Consumers switch on `.kind` / `.scope`.

### 10. **P1 — `_bandsLoggedForKey` and `_heatmapBuildTagLogged` are module-level singletons that survive forever.** `js/physics/porch-enclosure.js:175` + `js/graphics/scene.js:10735` + `js/physics/wall-path.js:326, 329`

Three independent one-shot log gates with different scopes. Inconsistent. If the audit is partly about "the user is debugging by reading console output," that output is unreliable. A `console.log` that doesn't fire when expected is worse than no log.

**Fix:** Reset on `scene:reset` and `heatmap:rebuilt`, or strip them.

### 11. **P1 — `cellInTrueInterior` heuristic relies on `wallInsetPolygon` parity that's never asserted.** `js/physics/spl-calculator.js:902-975`

If `wallInsetPolygon` ever returns `inner.length !== outer.length` (e.g. a notched footprint where wall inset collapses an edge), `haveInsetMask = false` → fallback to the old `inside` flag → the wall-annulus and outdoor-podium false-positive bugs from v=645 reappear silently.

**Fix:** Add a one-time `console.warn` when `haveInsetMask` is false in a room that has `surauStructure` or `standaloneEnclosures`.

### 12. **P2 — `computeMultiSourceSPLFromContext` is 200 lines and does 7 jobs.** `js/physics/spl-calculator.js:338-534`

Direct + coherent/incoherent + reverb + diffraction (with inline ground param resolution) + reradiation + overhead reflection + porch reverb. Each is a self-contained physical process; each is added to a different accumulator; each has its own enable guard with different conditions. This function is the integration point that has eaten the last 30 commits.

**Fix:** A `PowerSummer` helper that takes a list of contribution computers.

### 13. **P2 — `computeListenerBreakdown` duplicates the multi-source pipeline minus diffraction + reradiation + overhead + porch.** `js/physics/spl-calculator.js:622-674`

It IS noted as "for the breakdown UI / print report," but the per-listener probe the user is consulting to debug Cell A vs Cell B uses the *full* `computeMultiSourceSPL`, while the Listener Breakdown panel uses THIS function — and the breakdown is missing the four newer contributions. **The user looking at the Listener Breakdown panel will see numbers that do not add up to the heatmap value.** That mismatch is its own bug factory; it's how the user starts losing trust in the engine.

**Fix:** Breakdown should call the same pipeline with a debug mode that records per-contribution values.

### 14. **P2 — Coherent-sum branch and incoherent-sum branch share an outer accumulator with subtle gotcha.** `js/physics/spl-calculator.js:396-403, 530`

When `coherent=true`, diffraction/reverb/rerad/overhead/porch contributions are STILL summed incoherently to the coherent-direct sum. Almost certainly correct physics (you can't phase-correlate diffuse reverberant energy with the direct ray), but the comment doesn't say so and no test pins it. Future "fix" risk.

**Fix:** Add a comment + test.

### 15. **P2 — Tests don't fixture the user's repro geometry.** No test in `tests/` exercises the surau preset with 4 sources, takes a probe at the two cells in the brief (one clear-LoS, one behind-3-walls), and asserts the clear-LoS reads higher.

This is the test-coverage failure that lets the parallel-bypass bug keep resurfacing. Every fix patches a different cell because there's no fixture that says "Cell B must read ≤ Cell A under these specific source positions."

**Fix (Sam's lane, but flagging):** A `tests/surau-spl-monotonicity.test.mjs` that loads the surau preset, builds the SPL grid, and asserts a panel of constraint pairs.

---

## Section 2 — Contract gaps between modules

### A. `wallsCrossedByPath` → diffraction / reradiation / TL.

Producer emits `{ wallId: string, materialId: string, throughOpening: bool, hitPoint: {x,y,z} }`. Three consumers expect different invariants:
- `transmissionLossDb`: filters `throughOpening`, sums `materialId`'s TL.
- `computeDiffractionContributions`: filters `throughOpening`, regex-matches `wallId` to recover wall geometry.
- `computeReradiationContributions`: filters `throughOpening`, regex-matches `wallId` via `resolveWallGeometry` exported from diffraction.js.

**Gap:** If wall-path.js renames `parent_wall_north`, diffraction & rerad silently treat every crossing as "unknown" → heatmap drops every Tier 1a contribution. No error. No test fires.

**Proposal:** Replace stringly-typed `wallId` with a tagged object.

### B. `precomputeSPLContext` → `computeMultiSourceSPLFromContext`.

`const tier1aEnabled = ctx.enableTier1a ?? PHYSICS_P1_5_ENABLED;` — defensive `??` is load-bearing for any test that builds a ctx by hand and forgets a field.

**Proposal:** `assertSPLContext(ctx)` at the top of the consumer that throws on missing fields.

### C. `extractPorches`/`extractOverheadReflectors` → spl-calculator.

Producers return arrays of opaque objects with no shared type. If `overhead-geometry.js` ever renames `z_top` to `roofHeight`, multiple callers silently drop contributions.

**Proposal:** Move both into a single `js/physics/scene-geometry.js` with explicit JSDoc typedefs.

### D. `getDirectSplDb` closure in porch-enclosure.

The callback's variable name and type don't communicate that it must include diffraction. A future caller wiring `() => computeDirectSPL().spl_db` will get a different number and not know why.

**Proposal:** Rename to `getDrivePower_pressureSquared(src, pos, bandIdx)` and return linear pressure².

### E. `diffraction.js` exports `resolveWallGeometry` for `reradiation.js`.

Wrong dependency direction. Diffraction depends on knowing wall geometry; so does reradiation; so does wall-path. The shared helper belongs in a separate module.

**Proposal:** Extract into `js/physics/wall-geometry.js`.

---

## Section 3 — Suggested order of operations to stabilize

Substrate work BEFORE physics rework:

**S1 (1 hour, low risk).** Add the missing regression fixture — `tests/heatmap-surau-monotonicity.test.mjs`. Encode the Cell A / Cell B constraint and the SW-corner constraint and the wall-annulus constraint as `A.total_db > B.total_db`. **Do this first**; even before Dr. Chen specs.

**S2 (2 hours, low risk).** Extract `resolveWallGeometry`, `resolveOverheadGeometry`, `wallFootprintLine`, `signedDistanceToLine2D` into a new `js/physics/wall-geometry.js`. No behavior change.

**S3 (2 hours, low risk).** Centralize `bandIndexForFreq` — delete the inline copies in porch-enclosure, reradiation. Behavior change: porch and reradiation now snap to nearest instead of -1 / 0 fallback. Add a test before.

**S4 (3 hours, medium risk).** Hoist `extractPorches`, `extractOverheadReflectors`, `extractOutdoorObstacles` out of `computeMultiSourceSPLFromContext` into `precomputeSPLContext`. Same for the `getDirectSplDb` closure. Verified by per-cell cost regression test. User-visible: heatmap rebuild gets faster.

**S5 (4 hours, medium risk).** Promote `wallId` to a tagged object. Update producers + consumers.

**S6 (4 hours, low risk).** Add `assertSPLContext(ctx)` at the consumer boundary. Make `enable` mandatory in `computeDiffractionContributions` and `computeReradiationContributions` — delete the default.

**S7 — physics rework starts here.** Dr. Chen's spec for the diffraction model gets implemented against the clean substrate. Without S1, the rework is fixing what it can't measure. Without S2-S6, the rework will fight the architecture.

**Can be deferred:**
- C14 (coherent flag test). P2.
- Reconciling `computeListenerBreakdown` with the multi-source pipeline. P2.
- Killing the `_bandsLoggedForKey` singleton. P2 polish.

---

## Section 4 — What I would NOT touch

1. **The `_outdoor` flag forking inside `computeSPLGrid`** (lines 829-887). One path with two parameter sets. The asymmetry is the point.
2. **The `scene.scale.x = -1` mirror** and downstream X-negation sites. Burnt 10 commits to land; documented in CLAUDE.md §6. Future engineer who "cleans this up" will reintroduce the X-mirror bug.
3. **The `wallInsetPolygon` annulus discard** (Phase 7). Genuinely needed; the user reported the hot-ring artifact.
4. **The `pathWallLossDb` materials-missing legacy fallback** (line 41). Documented, tested.
5. **`squareCellCounts`** (lines 707-718). The 0.5 m cell target is empirically right.
6. **`scene:reset` + nuclear disposal in scene.js** (lines 433-478). Frame-perfect cleanup matters here.
7. **The Pierce-Hadden `wedgeIL` + `computeCornerDiffractionContributions`** (deprecated but exported; keep until commit (i) per the comment).

---

## Closing read

The pipeline ISN'T conceptually wrong at the top level. The decomposition `direct + diffuse + diffraction + rerad + overhead-reflection + porch-reverb` is the right physics shape. What's broken is **the contracts between those six terms** and **the fact that diffraction has been the dumping ground for "this corner is too bright" and "this corner is too dark"**, accreting per-edge floors and per-prefix gates instead of being restructured.

Substrate fix in S1-S6 first. The user's frustration is engineering frustration with the WAY this code says no, not with the level of ambition of the physics. Stabilize how modules talk to each other, fixture the user's actual repro, then let Dr. Chen put a clean model on top.

Three things to commit this week, ranked by user impact × likelihood: **S1 (regression fixture), S4 (hoist + drive-power refactor — eliminates the per-cell physics re-run), S6 (assert + delete fallback flag defaults)**. Those three close the silent-failure window the user has been losing trust to.

Codebase maturity: **post-mvp production with principal-led ambition, principal-led-supervision deficit.** The contracts aren't documented enough for the second engineer who didn't write them, and the heatmap's been the canary for that. Six S-tasks change the trajectory.
