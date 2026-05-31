# Room Capture & Sketcher — Feature Plan (research / study / structure)

> **Status:** PREP — research + study + architecture. No implementation yet.
> Prepared 2026-05-31. Inputs: market/technique research (web), codebase study,
> tech-lead architecture (Hannes), against the user's "Implementation Prompt."
>
> **One-line goal (from the prompt):** let a user on a phone or desktop define
> their room's floor-plan geometry — rough shape, scale anchored by one known
> dimension, drag to correct ("adjust later" is the model) — feeding the
> acoustic SPL/coverage engine. 100% client-side, iOS-Safari-safe, no LiDAR, no
> native app, no backend. Every capture mode emits ONE shared geometry model.

---

## 0. Stack reconciliation — READ FIRST

The pasted prompt says **"Vite + React + TypeScript."** **That is not this repo.**
RoomLAB is **plain ES6 modules + Three.js, NO build step, no package.json, no
bundler, no React, no TypeScript** (CLAUDE.md §1), deployed as static files to
GitHub Pages over HTTPS. Every line of this feature is hand-authored `.js` under
`js/`, lazy-imported via existing `import()` patterns, cache-busted with
`?v=NNN`. **No npm dependency may be added** — homography, linear solve, and IMU
math are hand-written (small + Node-testable) or, only if unavoidable, vendored
as a single ES module under `js/capture/vendor/`. Types are **JSDoc `@typedef`**,
validated by tests, never a compiler.

Consequence the prompt's framing hid: there is no `npm install opencv`. The
photo-trace homography is a ~120-LOC hand-written 4-point DLT solve on a plain
`<canvas>` — small, pure, and Node-testable, which suits the same-PR test rule.

---

## 1. The shared geometry model ALREADY EXISTS

The prompt's "ONE shared geometry model" is the existing RoomLAB room state — we
do not invent a new one, we target this contract:

```js
state.room = {
  shape: 'custom',
  custom_vertices: [{x, y}, ...],  // metres, floor plane, state +y = NORTH,
                                    // vertex[0] = (0,0) by convention
  width_m, depth_m,                 // bbox extents (DERIVED from vertices)
  height_m,                         // ceiling height
  surfaces: { floor, ceiling, edges: [perWallMaterialId, ...] },
}
```

So **every capture mode is just a front-end that produces `custom_vertices`**
(+ height + a default per-edge material), then funnels through the SAME commit
path and the SAME editable polygon. The downstream sim is already agnostic to
how the room was drawn — it only reads this state. Drag-to-correct of vertices
already exists in the 2D viewport.

---

## 2. Existing "draw custom room" flow (what we extend)

- **Interaction** lives in [`js/graphics/room-2d.js`](../js/graphics/room-2d.js) —
  a generic polygon-draw mode: tap-to-drop corners, 0.5 m snap-to-grid,
  close-near-start (`CLOSE_RADIUS_M = 0.6`), floating coord readout, edge
  auto-pan, shortcuts (R / Backspace / Esc / Enter). `startDrawCustomShape`'s
  `onFinish` shifts so vertex[0]=(0,0) and sets shape / `custom_vertices` /
  `width_m` / `depth_m` / `surfaces.edges`.
- **Entry point:** [`js/ui/panel-room.js`](../js/ui/panel-room.js) `#btn-draw-custom`
  → `applyBlankCustomRoom()` ([app-state.js:843](../js/app-state.js)) →
  `startDrawCustomShape()`.
- **Commit nuance (to fix):** `onFinish` mutates `state.room` directly and emits
  `room:changed`, NOT `scene:reset`. Capture replaces the whole `surfaces.edges`
  array → that's the "replaces whole state arrays" case the CLAUDE.md state-events
  invariant says MUST emit `scene:reset`. The new single commit path fixes this.
- **Coverage gap (CLAUDE.md §6 #1):** the custom-draw polygon flow has ~zero
  tests (10 iterative fixes, no tests). This feature must land WITH tests
  (same-PR rule). The recent walk-spawn-into-custom-room free-fall bug shows
  custom geometry has sharp edges.

---

## 3. Research findings — capture landscape (iOS Safari, client-side, no LiDAR)

Full sourced report retained in the research agent output; verdicts:

| Mode | Verdict on THIS constraint set |
|------|-------------------------------|
| **Manual touch sketcher** | **The only universal baseline.** Works everywhere, no permissions/sensors/ML. Reuse + harden the existing room-2d draw flow. |
| **Photo-trace + homography** | **VIABLE** progressive enhancement on iOS Safari. User shoots the floor, taps 4 corners, a 4-point plane homography rectifies to a plan; scale anchor sets the metric. Pure JS/Canvas. |
| **In-browser ML auto-layout** | **NOT shippable in 2026.** Strong models are panorama-based; no phone single-RGB-image → polygon model packaged for the browser. Out of scope. |
| **IMU "point at corners"** | **Low-confidence ASSIST only.** Orientation tracks; position/distance drifts (double-integration). Seeds a rough polygon; never "measured." Decision-gated (likely cut). |
| **WebXR** | **NOT viable on iOS** (no immersive session, no plane/mesh capture; visionOS is VR-only). Niche bonus on Android Chrome / Quest Browser. Design so its ABSENCE is the normal path. |

**Scale anchor:** default to **"type one known wall length"** (most foolproof +
accurate for a non-expert), with a **standard-door-width fallback** (region
default ~0.81 m / 32" US residential). The single dimension uniformly rescales
the whole polygon; the user always lands in the manual editor.

**Misconceptions the plan explicitly kills:** WebXR works on iPhone (it does
not); Apple RoomPlan is reusable on web (native, LiDAR-only); phone IMU can
measure distance (orientation yes, distance no); a single phone photo can be
auto-converted to a floor plan in-browser (no shippable model — use manual
trace + homography).

---

## 4. Capture-mode abstraction

A **capture mode** is a self-contained front-end that produces a rough polygon
in metres and hands it to ONE shared editor. **It never writes `state.room`** —
that keeps the commit path single and the sim mode-agnostic.

```js
/**
 * @typedef {Object} CaptureResult
 * @property {{x:number,y:number}[]} vertices  Rough polygon, metres, floor plane,
 *   +y = north. NOT yet origin-shifted (editor/commit owns vertex[0]=(0,0)).
 *   MAY be unscaled if scaleResolved=false.
 * @property {boolean} scaleResolved  true = real metres; false = arbitrary unit
 *   awaiting a scale anchor (photo-trace, IMU).
 * @property {{edgeIndex:number, lengthHint_m:number}|null} scaleHint  optional
 *   confident wall (e.g. tapped door = 0.81 m) to pre-fill the anchor.
 * @property {number|null} heightHint_m
 * @property {'manual'|'photo'|'imu'|'webxr'} provenance
 * @property {number} confidence  0..1 advisory only; drives banner copy, never gates.
 */

/**
 * @typedef {Object} CaptureMode
 * @property {string} id, label
 * @property {() => boolean|Promise<boolean>} isAvailable  runtime capability probe:
 *   manual → true; photo → !!navigator.mediaDevices?.getUserMedia (file-input
 *   fallback still true); imu → typeof DeviceOrientationEvent !== 'undefined';
 *   webxr → await navigator.xr?.isSessionSupported('immersive-ar') ?? false.
 * @property {(host, ctx) => CaptureSession} start
 */

/** @typedef {Object} CaptureSession
 *  @property {Promise<CaptureResult>} done  // resolves with polygon, null on cancel
 *  @property {() => void} cancel             // tear down streams / RAF / listeners
 */
```

**Handoff rule (load-bearing):** a mode resolves a `CaptureResult` and is *done* —
it does not commit. A single orchestrator runs scale-anchor (if needed) → opens
the shared editor → and only the editor's confirm calls the one commit. Modes
are interchangeable because they all converge on `{ vertices, scaleResolved }`.

---

## 5. Module structure (vanilla ES6 under `js/`)

```
js/capture/
  capture-flow.js        Orchestrator: mode registry, CaptureResult→scale→editor→
                         commit pipeline, and the SINGLE commitCapturedRoom().
  capture-modes.js       Registry of CaptureMode objects + isAvailable probes
                         (photo/imu/webxr lazy-import their impl on first use).
  modes/
    manual-mode.js       ~40-LOC adapter wrapping the EXISTING room-2d draw flow.
    photo-trace-mode.js  getUserMedia/file-input → frozen <canvas> → 4-corner tap
                         → UNSCALED vertices + scaleHint.            (P2)
    imu-assist-mode.js   DeviceOrientation point-at-corners → coarse polygon,
                         scaleResolved=false, low confidence.        (P3, gated)
    webxr-mode.js        immersive-ar probe; registered only if available. (far)
  geometry/              ALL PURE, Node-testable, no DOM / no Three.js:
    homography.js        4-point DLT solve + apply.                  (P2)
    scale-anchor.js      rescalePolygonToEdgeLength(); doorWidthDefault(region);
                         normalizeOrigin() (vertex[0]→(0,0) + bbox derive).
    polygon-ops.js       right-angle/parallel snap, edge "+"-insert, self-
                         intersection guard, winding normalize.  (new + lift from room-2d)
  vendor/                only if a hand-written solver is insufficient (likely empty).
```

**Reuse vs new — explicit:**
- **Extend, do not fork, `room-2d.js`.** Drag-to-correct / tap-to-drop /
  snap-to-grid / auto-close / edge auto-pan / coord readout already live there.
  The MVP "manual sketcher hardened" is *that file hardened*, not a rewrite.
- **Lift the pure math out** of room-2d.js into `geometry/` so the live editor
  AND tests share one implementation (origin-normalize, snapping) — directly
  attacking the §2 no-tests gap.
- **New editor enhancements** serve ALL modes (they all land in the same editor):
  per-edge numeric length entry, "+"-handle midpoint insert, long-press
  magnifier (touch fat-finger), right-angle/parallel snap.
- **Entry point:** `#btn-draw-custom` becomes a **"Capture room"** entry calling
  `captureFlow.begin()`, which presents available modes (manual always; others
  gated by `isAvailable`). Desktop-no-camera → just "Draw it" → existing flow.
  Zero regression for current users.

---

## 6. Scale-anchor + "adjust later" editor model

ONE editor, all modes feed it. "Adjust later" is the *primary* model. Pipeline in
`capture-flow.js`:

1. Mode resolves `CaptureResult`.
2. **Scale resolution** (only if `scaleResolved=false`): user taps an edge + types
   its real length (default), or accepts a door-width `scaleHint`.
   `rescalePolygonToEdgeLength()` uniformly scales the whole polygon. Manual mode
   is born `scaleResolved=true` (drawn on the metre grid) and skips this — but the
   same per-edge length entry stays available in the editor for correction.
3. **Origin + bbox normalize** (`normalizeOrigin()` — the logic currently inlined
   in room-2d.js `onFinish`, moved to the pure module).
4. **Editor** — drag-vertex (exists) + per-edge length entry (new) + snapping
   (new) + "+"-insert (new) + magnifier (new).
5. **Confirm → single commit path** (§7).

Discipline: scale-anchor + origin-normalize are **pure functions tested in Node**;
the editor is a thin interactive layer over them.

---

## 7. Phasing

- **MVP — the baseline every user gets (ship first, useful alone):** manual
  sketcher *hardened* (origin-normalize + snap extracted to pure modules; per-edge
  length entry; right-angle/parallel snap; long-press magnifier; self-intersection
  guard) + scale anchor in-editor + the `CaptureMode` abstraction + `capture-flow`
  orchestrator + single commit path, with **only `manual-mode` registered**. This
  is the architectural spine, so P2/P3 are pure additions, not refactors. **Closes
  the biggest current test gap** and gives phone users a genuinely good sketcher.
  Ship and stop here if P2 slips.
- **P2 — photo-trace homography:** `photo-trace-mode.js` + `homography.js`.
  getUserMedia OR file input (file input is the guaranteed fallback). Freeze frame
  → tap 4 floor corners → homography → scale-anchor → editor.
- **P3 — IMU "point at corners" assist:** low-confidence seed only; `requestPermission`
  gesture + HTTPS. **Decision-gated — recommend CUT** (photo-trace covers the
  camera case better; IMU may be dead weight).
- **Far-future — WebXR:** `webxr-mode.js`, registered only where `immersive-ar`
  is supported (Android Chrome / Quest). Never a dependency.

---

## 8. Integration + invariants + required tests

- **Single commit path:** new `commitCapturedRoom(captureResult)` is the ONE writer
  — sets shape / `custom_vertices` / derived `width_m`/`depth_m` / `surfaces.edges`
  / optional `height_m`, then **emits `scene:reset`** (not `room:changed`) because
  the edges array is wholesale-replaced. Manual `onFinish` is refactored to route
  through it — one writer, and it fixes a latent state-event inconsistency
  (flag to Martina + a preset/template regression sweep).
- **Walk-spawn / default placement:** capture polygons can be concave (real rooms)
  — the case that just bit us. `commitCapturedRoom` must guarantee the polygon is
  one `defaultInsidePosition(room)` handles (interior anchor). Regression test
  required.
- **Y-axis convention (+y = north):** photo-trace + IMU introduce fresh coordinate
  frames; their output must be mapped to +y=north BEFORE handoff or 2D/3D/print
  disagree (the recurring north-arrow / X-mirror failure mode). **Routes through
  Sam**; register in `tests/cross-surface-conventions.test.mjs` before merge.
- **Pure-module invariant:** everything in `geometry/` never imports Three.js or
  touches the DOM (same rule as `js/physics/` + `js/ui/print-*.js`).
- **Tests that MUST exist (same-PR rule):**
  - `tests/capture-scale-anchor.test.mjs` — rescale-to-edge-length; door-width default; idempotent origin-normalize.
  - `tests/capture-geometry-roundtrip.test.mjs` — `CaptureResult → commitCapturedRoom → custom_vertices` preserves shape (closes the untested custom-draw flow).
  - `tests/capture-homography.test.mjs` (P2) — known quad → known rect; degenerate-corner rejection.
  - `tests/capture-contract.test.mjs` — every registered mode's `CaptureResult` satisfies the typedef.
  - `tests/capture-defaultinside.test.mjs` — `defaultInsidePosition` returns an interior point for a captured concave polygon.
  - extend `tests/cross-surface-conventions.test.mjs` — captured polygon +y=north across 2D/3D/print.

---

## 9. Decisions — RESOLVED (2026-05-31)

1. **IMU assist (P3) — KEPT on the roadmap** (user decision). Built as a rough-
   shape seed only: always user-correctable, labelled "estimated", never
   presented as measured. Still last in phasing (after photo-trace) and needs no
   spine changes.
2. **Photo path default — LIVE CAMERA** (user decision). `photo-trace-mode` opens
   `getUserMedia` live camera by default (permission prompt on first use; HTTPS
   already satisfied by Pages), with file/photo-pick as the fallback when camera
   permission is denied or unavailable.

### Still open (lower-stakes, decide during build)
3. **Photo-trace accuracy expectation** — single-photo 4-point homography assumes
   a flat floor; perspective error can be 10–20% on wide rooms (scale anchor fixes
   global scale, not skew). Set "rough — then drag" expectation (Maya copy). Want
   a multi-wall / 2-photo trace later?
4. **"Capture" rail/panel placement** — replace `#btn-draw-custom` text vs add a
   sibling (Maya).
5. **Door-width region default** — single editable default vs region-detected; Lin
   owns the number + citation.

---

## 10. Specialist ownership at build time

- **Maya (ux-designer)** — touch sketcher interaction (magnifier, "+"-insert,
  per-edge length feel), "rough — adjust later" banner + permission-prompt copy,
  the mode-picker panel, "Capture" rail placement.
- **Viktor (3d-rendering-expert)** — camera/GPU: getUserMedia frame capture, the
  homography pixel warp (visual sign-off), any 3D preview; co-owns `webxr-mode.js`.
- **Sam (qa-engineer)** — geometry/cross-surface tests; scale-anchor + round-trip +
  contract + `defaultInsidePosition` guard; the +y=north cross-surface registration
  (cross-surface convention owner).
- **Dr. Chen (acoustics-engineer)** — consulted only on geometry-validity bounds
  `commitCapturedRoom` should enforce (concave/degenerate polygons that could break
  RT60 surface-area or the precision tracer).
- **Martina (fullstack-code-reviewer)** — the `onFinish → commitCapturedRoom /
  scene:reset` change (state-swap invariant) + camera-stream/RAF/listener teardown
  in `CaptureSession.cancel` (leak surface).
- **Hannes (tech-lead)** — the `CaptureMode` abstraction, `capture-flow`
  orchestration, single commit path, phasing, integration glue.

**Build order:** MVP spine + manual hardening + pure geometry tests (Maya UX ∥ Sam
tests ∥ Hannes abstraction) → Martina review of the `scene:reset` change → ship MVP
→ P2 photo-trace as a clean addition (Viktor + Hannes + Sam's homography test).
P3/WebXR are decision-gated and need no spine changes.

---

## Ready-engine evaluation (2026-05-31) — DECISION: keep the hand-built capture

The owner asked whether a ready open-source engine (GitHub) would be far better
than the hand-built live capture, and must work Android/iOS/Windows. Surveyed
GitHub + web. **Verdict: under the hard constraints (client-side browser, iOS
Safari, no LiDAR, no native, no backend) NO ready engine beats the hand-built
tap-to-scale optical-flow polygon — and the "far better" ones would WORSEN the
cross-platform goal.**

- **Browser SLAM:** only AlvaAR self-contains SLAM in iOS Safari — GPL-3,
  abandoned since Jul 2023, jittery on iOS, outputs a non-metric camera pose
  (not a floor polygon). 8th Wall open-sourced everything *except* SLAM (hosting
  ends Feb 2027). MindAR/AR.js = image-target tracking only. WebXR world-tracking
  is still **absent in iOS Safari (2026)**.
- **In-browser ML:** Depth Anything V2 runs in iOS Safari 26 (transformers.js,
  WASM/WebGPU) but is **relative depth, not metres** — it still needs our
  one-known-dimension scale anchor. An *assist* at best, not a replacement.
- **RoomPlan / Polycam / magicplan:** native + LiDAR + (often) cloud. RoomPlan is
  Swift-only, LiDAR-only, **no web SDK**, iOS-Pro-only. Adopting any of these
  loses Android, Windows, the browser, and non-Pro iPhones — the opposite of the
  cross-platform goal.

**The cross-platform irony:** the browser tap-to-scale approach IS the
cross-platform one; the "better" engines are the *least* portable. Decision:
keep the hand-built capture. Constraint-preserving upgrades, only if wanted
later: (1) a transformers.js depth *assist* (corner-snap hints, still our scale
anchor); (2) relax "no backend" → cloud SfM API (keeps browser reach, adds
server + per-scan cost); (3) relax "browser-only" → native RoomPlan (best
capture, iOS-LiDAR-only, separate app). 2027 re-evaluation trigger: a maintained
WebGPU monocular room tracker (none exists today).

## Related
- Source: the user's pasted "Room-LAB — Room Capture & Sketcher (Implementation Prompt)".
- Existing flow: `js/graphics/room-2d.js`, `js/app-state.js`, `js/ui/panel-room.js`,
  `js/physics/room-shape.js` (`defaultInsidePosition`).
- Invariants: CLAUDE.md §3 (state events, Y-axis, cross-surface, pure modules), §6 #1 (custom-draw test gap).
