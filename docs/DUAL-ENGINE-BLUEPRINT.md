# RoomLab — Dual-Engine Architecture Blueprint

**Status:** Phase A in progress — foundation scaffolding landed commit `HEAD`. See §6 "Phase A-1" below for what's done vs. pending.
**Goal:** keep the current statistical-acoustics engine as the real-time "Draft Mode" while introducing a hybrid Image-Source + Ray-Traced engine for "Precision Render Mode" that outputs time-domain impulse responses and derived metrics (EDT, C80, C50, D/R, STI-from-IR).
**Non-goal:** a one-shot rewrite. Every phase below must leave the product in a shippable state.

---

## 0. Summary of Key Decisions

| Question | Decision |
|---|---|
| State sharing | Introduce an immutable `PhysicsScene` snapshot both engines consume. Both write results into disjoint namespaces in `state.results`. |
| Compute layer | **Web Workers + SharedArrayBuffer**, not WASM or WebGPU — at least initially. Design for a WASM drop-in at the hot loop later. |
| Spatial index | `three-mesh-bvh` (npm) for the BVH. Rebuilt once per scene snapshot, not per frame. |
| Boundary interaction | Per-band α AND scattering coefficient `s` in `materials.json`. Hybrid: ISM for first 2–3 specular bounces, stochastic Lambertian scattering for the rest. |
| Receivers | Volumetric spheres (r = 0.5 m default) logging ray hits into per-band energy-time histograms (ΔT = 2 ms buckets). |
| User flow | Draft runs on every state change. Precision is explicitly triggered via a "Render" button, cancellable, with a progress indicator. |

---

## 1. Dual-Engine State Management

### 1.1 The problem

The current engine reads directly from `state.*` at compute time — physics functions iterate `state.sources`, dereference `state.zones[i].material_id` against a dictionary, lookup loudspeaker JSONs via URL. This is fine for single-threaded statistical math but fails for a worker-based precision engine:

- Workers cannot observe the main thread's `state` object.
- Dictionary lookups by string ID inside a hot ray-tracing loop are ~10× slower than indexed array access.
- A mid-render state mutation (user drags a speaker) would corrupt the precision result silently.

### 1.2 Proposed solution: `PhysicsScene` snapshot

Introduce a new module `js/physics/scene-snapshot.js` that produces an **immutable, flat, worker-transferable** representation of everything the physics engines need.

```js
// Conceptually — actual implementation uses typed arrays + indices.
PhysicsScene = {
  version: 1,
  timestamp_ms: 1713552000000,

  // Geometry — flat arrays. One entry per triangle.
  triangles: {
    positions: Float32Array,       // length 9·N (3 verts × xyz)
    normals:   Float32Array,       // length 3·N (face normal)
    materialIdx: Uint16Array,      // index into materials table
    zoneIdx: Int16Array,           // -1 for room shell, ≥0 for audience zones
  },

  // Materials — per-triangle lookup table.
  materials: {
    names:      string[],          // for debugging / UI
    alpha:      Float32Array,      // length M·BANDS, α per band
    scattering: Float32Array,      // length M·BANDS, Lambertian scatter coef
  },
  bands_hz:   [125, 250, 500, 1000, 2000, 4000, 8000],

  // Sources — one entry per physical element (line arrays pre-expanded).
  sources: {
    positions:  Float32Array,      // 3·S
    aims:       Float32Array,      // 3·S (unit vectors)
    Lw_per_band: Float32Array,     // S·BANDS
    directivityGrids: [...],       // already interpolated per-band on a fixed θ/φ grid
  },

  // Receivers — for precision mode only (draft mode uses direct state.listeners).
  receivers: {
    positions: Float32Array,       // 3·R
    radius_m:  Float32Array,       // R
    labels:    string[],
  },

  // Room volume (already computed; workers trust this).
  volume_m3: number,

  // Pre-built BVH handle — see §3.
  bvhBuffer:  ArrayBuffer,
}
```

### 1.3 Engine interface

```js
// Both engines implement:
interface AcousticEngine {
  name: 'draft' | 'precision';
  compute(scene: PhysicsScene, opts: ComputeOptions): Promise<EngineResult> | EngineResult;
  cancel?(): void;    // precision only
}

// Result shapes are different but both land in state.results.<engineName>.
DraftResult = { rt60_per_band, spl_grid, room_constant, stipa, ... };
PrecisionResult = {
  impulseResponse_per_receiver_per_band: Float32Array,  // [R, BANDS, N_buckets]
  bucket_dt_ms: 2,
  total_duration_ms: 2000,
  metrics_per_receiver: { edt_s, c80_db, c50_db, t30_s, d_r_db, sti_full, ... },
  convergenceWarnings: [...],
}
```

### 1.4 Ownership rules

1. **Draft engine** runs synchronously on the main thread, consumes `PhysicsScene`, writes `state.results.draft` within the same tick.
2. **Precision engine** receives a `PhysicsScene` snapshot, runs in workers, and posts its result back. The main thread writes `state.results.precision` on completion.
3. Both engines never mutate the scene. Snapshots are frozen (`Object.freeze` at the top level; typed arrays are transferred to workers as copies or `SharedArrayBuffer`).
4. If the user mutates state during a precision render, the result is marked stale (`state.results.precision.staleAt`) but NOT discarded — stale-but-visible beats silently-blank.

### 1.5 Migration path

- **Step 1** — add `PhysicsScene.build(state)` that produces the snapshot. Initially unused.
- **Step 2** — add `state.results.draft` as a parallel namespace alongside today's output. Draft engine writes here.
- **Step 3** — refactor current physics functions one at a time to accept `PhysicsScene` instead of `state`. Tests drive the transition.
- **Step 4** — once all physics go through `PhysicsScene`, the worker pathway becomes a local-only change.

---

## 2. Compute Layer

### 2.1 The three candidates

| Option | Hot-loop perf | Authoring cost | Browser support | Ship today? |
|---|---|---|---|---|
| **Web Workers + JS** | ~5 M ray-tri/sec/core | trivial (same JS) | universal | yes |
| **WASM (Rust/C++)** | ~25 M ray-tri/sec/core | build toolchain, deploy binary blob | universal | yes with work |
| **WebGPU compute** | ~500 M ray-tri/sec/GPU | WGSL shaders, buffer packing | Chrome/Edge stable, Safari shipping, Firefox behind flag | risky today |

### 2.2 Recommendation: Web Workers + SharedArrayBuffer

**Reasoning:**

1. **Perf math works.** For 50,000 rays × mean path length 100 m ÷ mean free path 15 m ≈ 330,000 triangle tests/ray. With a BVH that's ~log₂(5000) ≈ 12 node checks/test, so ~4 million ops per ray, 200 billion ops total. At 5 M ray-tri/sec/core (pessimistic JS with BVH), 8 cores = 40 M/sec → **5 seconds** for the full render. Acceptable for a "press Render and wait" workflow.
2. **Zero toolchain change.** RoomLab's identity is "pure ES modules, no build step, GitHub Pages deploy." Introducing Emscripten or wasm-pack is a significant burden and makes contribution harder.
3. **Drop-in WASM later.** The worker's inner loop is well-isolated. Once we know the algorithm is right and identify the hot spots, swapping the ray-triangle test for a WASM-compiled function is a local change — the worker messaging protocol doesn't move.
4. **WebGPU too early.** Safari only just shipped WebGPU in 17.0. Firefox is still behind a flag. A dual-engine roadmap betting on WebGPU exclusivity would lock out macOS Safari users and Firefox users for 1–2 years.

### 2.3 Architecture

```
┌─────────────────────┐
│  Main thread        │
│                     │
│  • builds scene     │
│  • dispatches jobs  │
│  • aggregates       │
└──────┬──────────────┘
       │ postMessage + transferable
       │
   ┌───┴──────┬──────────┬──────────┐
   │          │          │          │
┌──▼──┐   ┌──▼──┐   ┌──▼──┐   ┌──▼──┐
│ W1  │   │ W2  │   │ W3  │   │ W4  │   ... navigator.hardwareConcurrency - 1
└─────┘   └─────┘   └─────┘   └─────┘
Each worker has:
 • copy of PhysicsScene geometry
 • its own BVH instance
 • an RNG with a deterministic seed (for reproducibility)
 • chunk of rays to trace (e.g. N_total / N_workers)
```

### 2.4 Message protocol

```
main → worker:
  { type: 'init', scene: PhysicsScene }         (once per render)
  { type: 'trace', rayCount, seed, jobId }      (per chunk)
  { type: 'cancel', jobId }

worker → main:
  { type: 'progress', jobId, raysDone }         (every ~50ms)
  { type: 'result', jobId, histogram, hits }    (at end)
  { type: 'error', jobId, message }
```

Use `SharedArrayBuffer` for the aggregate per-receiver histogram when available (requires cross-origin isolation headers on GitHub Pages — need to check, possibly fall back to postMessage accumulation). Histograms are small (~100KB per receiver) so postMessage is acceptable.

### 2.5 Cancellation

The Precision Render button must be cancellable. Implementation:
- Each worker checks a shared flag every ~500 rays.
- Main thread posts `cancel` → workers wrap up their current ray, post partial result, return to idle.
- Partial results marked `incomplete: true` and not stored in `state.results.precision`.

---

## 3. Spatial Partitioning & Geometry

### 3.1 Scale

- Arena preset: ~5000 triangles (bowl tiers + dome + speakers + audience instances).
- Auditorium + orchestra pit + balcony: ~2000 triangles.
- Small recital hall: ~500 triangles.

Without BVH: naive ray-triangle is O(5000) per ray → 25 billion ops for 50k rays × 100 bounces. Unacceptable.
With BVH: O(log N) traversal → 12 node tests + ~2 leaf tests per ray segment. 3 orders of magnitude speedup.

### 3.2 Recommendation: `three-mesh-bvh`

**Rationale:**
- Maintained (Garrett Johnson, 5k stars, active issues/PRs).
- Integrates with Three.js geometry — reuses the buffer geometry we already build for the 3D viewport.
- Surface-area-heuristic splits for good quality.
- Exports the BVH to a serializable form we can transfer to workers.

**Ownership path:**
- Scene snapshot builder extracts every material-tagged mesh from the Three.js scene, merges into a single geometry per material group, builds one BVH per group.
- BVH serialized to an ArrayBuffer, included in `PhysicsScene.bvhBuffer`.
- Worker deserializes on `init` message.

### 3.3 Rebuild discipline

- BVH is **static per snapshot**. Precision mode always runs against a frozen scene.
- User edits invalidate the current snapshot; next Precision Render builds a new one.
- BVH build is ~20-50 ms for the arena. Fast enough to rebuild on demand, too slow to do on every slider tick — but we don't need to.

### 3.4 Alternative for later

If `three-mesh-bvh` adds an unacceptable dep or we need finer control, a hand-rolled SAH BVH in ~200 lines is straightforward. The interface stays the same.

---

## 4. Boundary Interactions

### 4.1 Two coefficients per material, not one

Currently `materials.json` has only `absorption`. We need to add `scattering`:

```json
{
  "id": "concrete-painted",
  "absorption":  [0.01, 0.01, 0.02, 0.02, 0.02, 0.03, 0.03],
  "scattering":  [0.05, 0.05, 0.05, 0.10, 0.10, 0.15, 0.15]
},
{
  "id": "audience-seated",
  "absorption":  [0.60, 0.74, 0.88, 0.96, 0.93, 0.85, 0.80],
  "scattering":  [0.40, 0.60, 0.70, 0.80, 0.85, 0.85, 0.80]
}
```

Scattering coefficient `s(f)` per ISO 17497-1 is the fraction of incident energy scattered non-specularly. Published values exist for most common materials (Vorländer *Auralization*, Cox & D'Antonio *Acoustic Absorbers and Diffusers*).

Default scattering for unknown materials: **start at s = 0.10 per band** — this matches ODEON's default "slightly rough" assumption. Users can override per zone.

### 4.2 Per-ray boundary logic

When a ray with energy `E_i(f)` hits a triangle with material `m`:

```
α(f) = materials[m].absorption[f]
s(f) = materials[m].scattering[f]

// Energy lost to absorption — same for either reflection type.
E_after(f) = E_i(f) · (1 − α(f))

// Pick reflection type per ray (not per band — ray has one direction).
// Average s across bands, weighted by current E per band.
s_eff = Σ_f (E_i(f) · s(f)) / Σ_f E_i(f)
r = rng.random()

if r < s_eff:
    // Lambertian diffuse: random direction in the hemisphere around n
    // with density ∝ cos(θ). Trivial sampling: square-to-cosine-hemisphere.
    direction_new = cosineSampleHemisphere(n, rng)
else:
    // Specular: direction_new = direction_old − 2(direction_old · n) · n
    direction_new = reflect(direction_old, n)
```

### 4.3 Early reflections: Image-Source Method

ISM handles the first 2–3 reflections exactly (per the EASE/ODEON playbook). For each source:

1. Mirror the source across every nearby planar triangle → first-order image sources.
2. For each first-order image, mirror again across reachable triangles → second-order images.
3. Continue to depth `N_ism` (typically 2 or 3).
4. For each image + receiver pair: test visibility (ray from image to receiver must not be occluded), compute direct-path arrival time, attenuate by path-length spreading + air absorption + product of (1 − α) at each mirroring plane.

ISM generates **exact specular** reflections. For a cuboid room with N_ism=3, that's ~50 image sources per real source. Cheap.

ISM becomes useless for complex geometry (curved walls, diffuse panels, audience) because the image explosion grows combinatorially AND most images get occluded. So we cap at `N_ism = 2` or `3` and hand off to stochastic ray tracing for later reflections.

### 4.4 Hybrid transition

```
For each real source:
    emit N_ism-order image sources (deterministic, reused across all receivers).

For the stochastic pass:
    For each ray:
        reflection_count = 0
        while ray.energy > cutoff and reflection_count < max_bounces:
            if reflection_count < N_ism:
                # Already covered by ISM above — skip to avoid double-counting.
                reflection_count += 1
                continue
            intersect ray with BVH → hit
            log hit-vs-receiver energy (see §5)
            reflect or scatter per §4.2
            ray.energy *= (1 − α) per band
            reflection_count += 1
```

This means early reflections (high temporal precision, low diffuseness) come from ISM, late reverberant tail (low precision, high diffuseness) comes from ray tracing. Matches how the ear processes the sound field.

### 4.5 Energy cutoff

Terminate rays when `max(E_per_band) < E_cutoff` (typical: −60 dB of initial, i.e. `E_cutoff = E_0 · 10^(-6)`). Prevents infinite ray paths in reflective rooms.

---

## 5. Receivers & the Echogram

### 5.1 Volumetric receivers

A point receiver is useless for stochastic rays — probability of a ray hitting a point is zero. Use spheres:

```
Receiver = {
  position: Vec3,
  radius_m: 0.5,          // default; configurable
  absorptionHistogram: Float32Array,   // [BANDS × N_buckets], filled during trace
}
```

**Sphere radius is a trade-off:**
- Smaller (e.g. 0.3 m) → better temporal precision (less time-smearing) but more rays needed for a converged IR.
- Larger (e.g. 1.0 m) → fewer rays needed, but the IR early portion is blurred (a 1 m sphere spans ~3 ms of direct-path time).

ODEON default: 0.5 m. Follow their convention.

### 5.2 Ray-sphere hit

Ray-sphere intersection is cheap (quadratic in `t`). Per bounce:

```
for receiver in receivers:
    if intersectRaySphere(ray, receiver, t_max):
        t_hit = intersection parameter → path length so far / c
        bucket = floor(t_hit / bucket_dt_ms)
        for f in BANDS:
            receiver.histogram[f][bucket] += ray.energy[f] · geometricWeight
```

Where `geometricWeight` corrects for the finite sphere size (energy/area of sphere projection from the ray direction). Standard formula: `1 / (π · r²)`.

### 5.3 Per-band impulse response

After the trace completes, each receiver holds a 2D histogram `h[f, t]` (length BANDS × N_buckets). This is the **broadband impulse response**:

```
IR(t) = sum over all bands, windowed by hearing band weights
     ≈ 10·log10(Σ_f h[f, t])    (dB energy decay curve)
```

For display: convert to dB, plot vs time. The classic "echogram" / "reflectogram".

### 5.4 Derived metrics

All computable from `h[f, t]`:

```
# Early-to-late energy ratios per band (Hidaka 1993 standard windows):
C80(f) = 10·log10(Σ_{t<80ms} h[f,t] / Σ_{t>80ms} h[f,t])
C50(f) = 10·log10(Σ_{t<50ms} h[f,t] / Σ_{t>50ms} h[f,t])

# Early Decay Time — linear regression on 0 to -10 dB decay × 6:
EDT(f) = 6 · T(-10 dB, from t=0)

# Reverberation time — regression -5 to -35 dB × 2:
T30(f) = 2 · T(-35 dB, from -5 dB)

# Direct-to-reverberant ratio — windowed at ~10 ms (varies by source distance):
D(f) = Σ_{t<10ms} h[f,t]
R(f) = Σ_{t>10ms} h[f,t]
D/R(f) = 10·log10(D(f) / R(f))

# STI from full MTF:
For each modulation frequency f_m ∈ IEC STIPA table:
    MTF(f, f_m) = |Σ_t h[f,t] · exp(-j · 2π · f_m · t)| / Σ_t h[f,t]
Then apply the full STI formula (IEC 60268-16 Annex A), more accurate than
the simplified STIPA currently used.
```

### 5.5 Convergence

IR noise floor is determined by `rays_per_receiver`. For a 2-second IR with 2 ms buckets = 1000 buckets, and we want SNR ≥ 20 dB in the late tail, we need ~1000 rays hitting the receiver. At typical hit rate (sphere cross-section / total ray sphere) ~ 10⁻³, that's ~10⁶ rays per receiver. For 5 receivers × arena at 50k total rays → wildly under-converged.

**This is the honest bottleneck.** ODEON and EASE achieve their quality with 50k-500k ray counts AND clever importance sampling (e.g. only count rays that could plausibly reach each receiver). For RoomLab to compete, we need to either:

1. Ship with a strict "use few receivers" constraint (3-5 per render).
2. Add importance sampling / angular cone tracing.
3. Use GPU eventually for brute-force quantity.

Recommend (1) for MVP, (2) as first precision-engine refinement.

---

## 6. Step-by-Step Architectural Proposal

### Phase A — Foundation (ship in 2-3 weeks, still draft-only)

**A1.** ✅ `buildPhysicsScene({ state, materials, getLoudspeakerDef })` in [js/physics/scene-snapshot.js](../js/physics/scene-snapshot.js) — returns a frozen snapshot with resolved materials (index-keyed Float32 absorption + scattering), pre-expanded line-array elements, pre-computed L_w per source per band, volumetric receivers with 0.5 m default radius, zones with occupancy-blended α + s, and a snapshot of physics flags + Master EQ. `PHYSICS_SCENE_VERSION = 1`. 34 regression tests.
**A2.** ⏳ Refactor `computeRT60Band`, `computeMultiSourceSPL`, `computeSTIPA` to accept `PhysicsScene` instead of raw `state`. Tests drive the change. **Pending next session — large blast radius, deserves focused pass.**
**A3.** ✅ `scattering` array added to every entry in `materials.json` (schema v1.3). Values per Cox & D'Antonio *Acoustic Absorbers and Diffusers* 2nd ed. / ISO 17497-1 references. Draft engine ignores scattering (backward compatible); precision ray tracer (Phase B+) uses it for Lambertian vs specular bounce decisions.
**A4.** ✅ `state.results.precision = null` scaffolded; `state.results.engines` metadata tracks `inProgress`, `staleAt`, `cancellable`. Existing draft fields (`rt60`, `splGrid`, `zoneGrids`) preserved for backward compat.
**A5.** ✅ Worker smoke test landed. Run on the live deploy from DevTools:
```js
await window.__roomlabWorkerSmoke()
```
Driver: [js/physics/precision/worker-smoke-driver.js](../js/physics/precision/worker-smoke-driver.js). Worker: [js/physics/precision/worker-smoke.js](../js/physics/precision/worker-smoke.js). Lazy-loaded — zero bytes on default page load. Reports: `env.crossOriginIsolated`, `env.sharedArrayBufferAvailable`, echo round-trip latency (budget < 5 ms), N-way parallel speedup (budget > 0.7 × N), 1 MB transferable round-trip (budget < 10 ms), and human-readable recommendations for Phase B architecture decisions.

**Expected on github.io:** `crossOriginIsolated = false`, `sharedArrayBufferAvailable = false` (no COOP/COEP headers on default GitHub Pages CDN). That's OK — Phase B uses `postMessage` + `[transferable]` lists for ray-batch handoff. Histogram aggregation runs on the main thread (fan-in from workers) instead of via shared memory. For our data sizes (per-receiver histogram < 100 KB) this is not a performance issue.

**Measured on live deploy (2026-04-20, user machine, 14 threads):**

| Metric | Value | Budget | Result |
|---|---|---|---|
| `env.hardwareConcurrency` | 14 | — | modern laptop / workstation |
| `env.crossOriginIsolated` | false | — | expected on github.io |
| `env.sharedArrayBufferAvailable` | false | — | expected; fallback path confirmed sufficient |
| `env.atomicsAvailable` | true | — | usable for lock-free counters if SAB ever enabled |
| `tests.echo.roundTripMs_median` | **0** ms | < 5 ms | ✓ well under budget (min 0 / max 262 — 262 is JIT cold-start) |
| `tests.echo.spawnMs` | 0.2 ms | — | worker spawn essentially instant |
| `tests.parallel` (8 workers × 10M ops) | **7.34× of 8× ideal** (92% efficiency) | > 0.7 × N | ✓ comfortable margin; Chrome not serializing |
| `tests.transfer` (1 MB round-trip) | **2.4 ms** (pure transfer 2.1 ms) | < 10 ms | ✓ 4× under budget; ray batches effectively free |

**Revised Phase B compute budget** based on these numbers: the original blueprint estimated 5 s for 50k rays. With ~92 % parallel efficiency and 14 hardware threads actually available, and assuming the ray-tracer hot loop (BVH traversal + ray-triangle + receiver-sphere tests) is ~4,000 FLOPs/ray averaged over the full ray life, we can project:

- **50k rays: ~400 ms** (was 5 s estimate — off by 10× in our favour)
- **500k rays: ~4 seconds** — reasonable "press Render and wait"
- **5M rays: ~40 seconds** — publishable-quality late-tail convergence on 5 receivers

This means the MVP ray tracer can ship with much higher default ray count than planned, or with a progressive-refinement UX (start at 50k for instant feedback, converge to 500k in the background).

### Phase B — BVH + worker scaffolding (2-3 weeks)

**B1.** Phase B1 split into three smaller sessions:
  - **B1a — Triangulator** ✅ landed `HEAD`. [js/physics/precision/triangulate-scene.js](../js/physics/precision/triangulate-scene.js) produces a flat triangle soup (Float32 positions, face normals, material indices, surface tags, source keys) from a `PhysicsScene`. Covers **rectangular rooms + flat zones + scoreboard box** — enough for 5 of 9 presets (classroom, studio, livevenue, hifi, chamber). Polygon / round / dome / stadium bowl are Phase B2.
  - **B1b — Hand-rolled SAH BVH** ✅ landed `HEAD`. [js/physics/precision/bvh.js](../js/physics/precision/bvh.js) — ~250 lines pure JS, Node-testable without dragging `three` into test deps. Build via recursive surface-area-heuristic splits along the longest centroid-axis. Query via iterative stack-based traversal with ray-AABB slab test + Möller-Trumbore ray-triangle. Output is a flat Float32Array of nodes + Uint32Array of triangle indices (worker-transferable by design). Also exports `intersectRayBrute` for tests to verify correctness.
  - **B1c — Tests** ✅ landed `HEAD`. [tests/precision-bvh.test.mjs](../tests/precision-bvh.test.mjs) — 500/500 random rays agree between BVH and brute-force (correctness), 678 rays/ms on a 26-triangle shoebox (perf above the 500 rays/ms budget).

  **Decision change from the original blueprint:** using a hand-rolled BVH instead of `three-mesh-bvh`. Reasoning: (a) keeps physics tests pure Node without pulling three into dev deps; (b) 250 lines of reviewable, self-contained code beats an opaque npm dep we can't easily patch; (c) perf is well within budget — our scenes are 100–10,000 triangles, not movie-scale. If perf ever becomes the bottleneck the swap to `three-mesh-bvh` is a single-file change.

**B2.** ✅ landed `HEAD`. Extended triangulator covers polygon rooms (hexagonal / 36-sided arena / octagon / etc.), round rooms (approximated as 32-sided polygon), dome ceilings (spherical-cap tessellation, 8 latitudes × 24 longitudes), and custom-vertex rooms. Arena preset now produces **898 triangles**; court-centre ray-up correctly hits the scoreboard_bottom face. Perf on arena scene: **324 rays/ms** (BVH with 599 nodes) — well above the ≥100 rays/ms budget for arena-class scenes.

**B2.5.** ⏳ Stadium bowl structural triangulation — risers, retaining walls, back walls, concourse ring — deferred. Zones (tread tops) are already triangulated via the zones path, which covers the acoustically-significant audience-facing surfaces. Adding risers requires either (a) reconstructing scene.js's LatheGeometry bowl in the physics layer, or (b) extracting triangles from the already-built Three.js meshes. Both are doable; neither is blocking a first precision-render demo.

**B3.** Worker pool (`js/physics/precision/worker-pool.js`) — 4-8 workers, job queue, cancellation. Scene + BVH transferred once to each worker via `postMessage` + transferable list.

**B4.** Progress UI — spinner, rays-done/total counter, cancel button.

### Phase C — Minimum-viable precision engine (3-4 weeks)

**C1.** Ray tracer in worker. Specular-only, no ISM, no scattering. Just: emit rays from each source, bounce until energy cutoff, log receiver hits.
**C2.** Energy-time histograms per receiver per band.
**C3.** Derive RT60 (T30) from histograms. Compare to draft's Sabine RT60 in the Results panel side-by-side. This becomes our first real cross-engine validation.

### Phase D — ISM + scattering (3-4 weeks)

**D1.** ISM pass: generate first-order and second-order image sources. Visibility tests against BVH.
**D2.** Combine ISM early reflections with stochastic late reverb (§4.4).
**D3.** Add Lambertian scattering per material's `s(f)` coefficient.
**D4.** Derive full metric suite: EDT, C80, C50, D/R, STI-from-IR.

### Phase E — UI + visualization (2-3 weeks)

**E1.** "Render Precision" button. Shows progress, estimated remaining time, cancel.
**E2.** Echogram panel — per-receiver IR plot (log time × dB energy).
**E3.** Metric table in Results panel — draft vs precision side-by-side, with clear labels.
**E4.** 3D ray-path visualizer — overlay first-N-bounces of a few representative rays for debugging and teaching.

### Phase F — Performance (ongoing)

**F1.** Profile. Identify whether BVH traversal, scattering math, or message overhead dominates.
**F2.** If BVH traversal dominates: consider WASM port of the ray-triangle test.
**F3.** If scattering dominates: importance sampling (bias rays toward receivers).
**F4.** If neither: add a low-priority WebGPU fast path for supported browsers.

---

## 7. The Hardest Bottlenecks

Enumerated in expected pain order:

### 7.1 Scene-freezing discipline

The precision engine runs on a snapshot. If the user edits `state.sources` mid-render, the worker's results no longer match what the UI shows. Handling:
- Snapshot is immutable (Object.freeze at creation).
- On state mutation during render: mark result `stale = true`, show banner, **don't discard** (user may want to see it anyway).
- Re-triggering Render while one is in flight cancels the previous, starts fresh.

**Risk class:** very high. Every SPA project with async compute hits this. Requires discipline in the state-management layer that RoomLab currently lacks (Weiss audit item #2 called this out in the single-engine case).

### 7.2 Draft vs Precision reconciliation

At α̅ = 0.2 Sabine and Eyring disagree by ~10 %. Between Sabine RT60 and ray-traced T30 in a real room, the gap can be 20-30 % depending on geometry diffusivity. The user will see TWO RT60 numbers and ask "which is right?"

Honest answer: both. Draft is a statistical approximation; Precision is a time-domain simulation. They converge for Sabine-assumption-compliant rooms (simple, moderately absorbent) and diverge for irregular or highly diffuse ones.

Needs: (a) explicit UI labelling, (b) documentation in CALCULATIONS.md, (c) tooltip explaining the difference on hover.

### 7.3 Material data gap

`materials.json` has no scattering coefficients today. Must add for all 11 materials + audience-seat variants + scoreboard. Cox & D'Antonio is the canonical source. Authoring burden: ~1 day for good defaults.

For user-authored custom materials, we need a UI to edit scattering too. More UI surface.

### 7.4 Convergence noise in the IR

As noted in §5.5: achieving 20 dB SNR in the late tail requires ~10⁶ rays per receiver. At 5 receivers, that's 5 million rays. At ~5 M ray-tri/sec/core × 8 cores with BVH, that's ~1 minute per render. Acceptable but pushes the "real feeling" edge.

Mitigations: importance sampling, angular cone tracing, WASM-compiled hot loop.

### 7.5 Float32 precision for large rooms

WebGL (and most worker contexts) default to Float32Array. Ray-triangle intersections at arena scale (60 m × 60 m × 22 m) in Float32 can miss triangles near the epsilon boundary (~10⁻⁴ m = 0.1 mm). Most engines mitigate with a scene-scaled epsilon.

Code must use a carefully-chosen `RAY_EPSILON = 1e-4 · scene_diameter`, not a hardcoded `1e-6`.

### 7.6 GitHub Pages + SharedArrayBuffer

SharedArrayBuffer requires cross-origin isolation headers (COOP/COEP). GitHub Pages's default CDN does not set these. We either:
- Fall back to `postMessage` + copying (slightly slower, works everywhere).
- Move to a custom deploy (Cloudflare Pages, Vercel) with header control.

Not a blocker — copying is fine for our data sizes — but worth confirming on the live deploy early.

### 7.7 BVH build time scales with triangle count

For the full arena with audience instances (10k+ triangles), BVH build is ~200 ms. Too slow to do on every scene edit. Discipline: only rebuild on precision-render-start, not on draft-render.

### 7.8 Loudspeaker directivity in the time domain

Our current loudspeaker JSON has a per-band attenuation grid. Ray tracing needs: on emission, the speaker's radiation pattern determines each ray's initial energy direction. That's fine — sample rays via a probability distribution proportional to the directivity.

BUT: the directivity is currently only defined at "1000" Hz in the default line-array JSON (everything else treated as omni). For precision ray tracing this is worse than for statistical — because ray tracing is per-band and the missing HF directivity produces wrong early-reflection patterns. Needs: complete directivity grids in all loudspeaker JSONs. Authoring burden.

### 7.9 Worker initialization cost

Spinning up 8 workers + transferring scene + building BVHs = ~100-200 ms overhead per Precision Render. Acceptable for manual-trigger UX; users will notice but won't complain.

Optimization later: keep workers alive between renders (persistent pool) and only send the scene delta.

### 7.10 Testing strategy

Unit-testable: BVH correctness, ISM image generation, energy attenuation.
Hard-to-test: full ray-traced IR against reference. Need fixture rooms with published measured IRs (e.g. Concertgebouw, Royal Albert Hall — both have published IRs in the research literature). Integration suite: hand-picked "shoebox at α=0.1 with one source, one receiver" → check ray-traced T30 matches Sabine's 1.27 s to within 5 %.

---

## 8. What We DON'T Do

To keep scope finite for the first Precision Engine release:

- **No auralization** (convolving source audio with IR). Nice-to-have later; out of Phase 1.
- **No moving sources/receivers** in Precision. Snapshot-only.
- **No directional receivers** (binaural / Ambisonics). Sphere only.
- **No below-200 Hz wave-based modelling** (FDTD / FEM). Ray tracing assumes geometric acoustics regime.
- **No coupled-volume rooms** (adjacent spaces connected via open doors with their own reverb). Would need major geometry work.
- **No temperature gradients** in the ray path (c is a constant).

These are flagged in a §11 new-simplifications addition we'd add to CALCULATIONS.md when the precision engine ships.

---

## 9. Open Questions for Discussion

Before committing to build, worth resolving:

1. **Is `three-mesh-bvh` acceptable as a new dependency?** It violates "pure ESM, no build step" slightly (ships as ESM, but is an external package). Alternative: hand-rolled BVH.
2. **Do we ship SharedArrayBuffer-requiring deploy targets?** Requires moving off github.io/chongthekuli.github.io to a COOP/COEP-capable host.
3. **How authoritative is the Precision result vs Draft?** Strong opinion needed: when they disagree, does the UI's "primary KPI" use Precision when available?
4. **Who authors missing scattering coefficients?** If we commit to the dual engine, we commit to maintaining two coefficient columns per material.
5. **Do we expose ray count / seed to power users?** Reproducibility is a pro-tool feature; adds UI surface.

---

## 10. Summary of Decisions to Make Now

1. **Commit to Web Workers + JS for Phase 1.** Defer WASM/WebGPU to Phase F or later.
2. **Adopt `three-mesh-bvh` (or equivalent) for spatial partitioning.** Decision point: acceptable to add one dep?
3. **Introduce `PhysicsScene` snapshot as the sole physics input.** Refactor existing engine first (Phase A) before adding the precision one.
4. **Add `scattering` column to materials.json now** (backward compatible, draft engine ignores it).
5. **UI model: "Draft runs on every edit; press Render for Precision; Precision result is persistent until invalidated."**

Once these five are agreed, Phase A can start immediately. Phases A–F map roughly to a 3–4 month development window for a single developer.
