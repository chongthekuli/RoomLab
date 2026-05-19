# CLAUDE.md — RoomLab

This file is loaded into every Claude Code session. It is the canonical
map of the project: what lives where, the rules that ship/block work,
and the specialists to call. Memory entries (see `MEMORY.md` in
`~/.claude/projects/d--OneDrive-CCY-LINKAGE-Projects-RoomLab/memory/`)
hold the **why** behind each rule and the past incident that earned it.
This file holds the **what** — read both.

---

## 1. Project identity

- **What**: Web-based acoustic simulator (EASE-inspired). Plain ES6
  modules, Three.js, no build step, no package.json.
- **Deploys to**: <https://chongthekuli.github.io/RoomLab/> via GitHub
  Pages on push to `main`. Repo: `chongthekuli/RoomLab`.
- **User**: `chongthekuli` (new to GitHub — explain git/Pages steps
  explicitly, don't assume familiarity).
- **Embed target**: Google Site iframe.

Cache-bust scheme: every CSS/JS/HTML asset is tagged `?v=NNN` in
`index.html`. Bump on every visual / behavior change or browsers will
serve stale modules.

---

## 2. Repo layout (where things live)

```
index.html              cache-bump strings (?v=NNN)  — bump on every shipped change
css/{main,theme,print}.css

js/
  main.js               SPA bootstrap, hash router, header nav
  app-state.js          state shape + helpers (earHeightFor, expandSources, getSelectedListener)
  labs/
    roomlab/main.js     RoomLAB entry — lazy-mounted on #/room
    speakerlab/         speaker browser/editor
    surfacelab/         material catalogue
    devicelab/          rack/amp/PA hardware browser
  physics/              pure (Node-testable), no DOM
    rt60.js             Sabine + Eyring, per band
    spl-calculator.js   computeSPLGrid, computeListenerBreakdown, computeMultiSourceSPL
    stipa.js            IEC 60268-16 STIPA
    precision/          ray-traced engine — histograms, derive-metrics
    diffraction.js, reradiation.js     Tier 1a (ISO 9613-2, Kuttruff)
    wall-path.js, wall-overlap.js
    loudspeaker.js, materials.js
    per-listener-metrics.js     SPL+STI label helper (shared by 2D + print)
    room-shape.js        geometry — rectangular / polygon / round / custom
    scene-snapshot.js    immutable snapshot for the precision engine
    ray-viz.js
  graphics/             Three.js + 2D SVG renderers
    scene.js             3D scene, heatmap planes, walk-mode controller wiring
    room-2d.js           2D SVG viewport (top-down editor + heatmap overlay)
    heatmap-shader.js    scalar-field shader (replaces canvas-texture per-zone)
    colour-ramps.js, legend-ticks.js
    third-person-controller.js, place-room-controller.js
  ui/                   panels + report — DOM-side, subscribes to events
    panel-*.js           one per right-rail panel (room, sources, listeners, zones, etc.)
    print-report.js      full proposal-style PDF report
    print-plan-svg.js    pure SVG floor plan (Node-testable)
    print-heatmap.js     pure SVG heatmap page (Node-testable)
    rail-system.js, glossary.js, welcome-card.js
  audio/audition.js      walk-mode auralization (in progress — W.1–W.6)
  io/share-link.js, project-file.js
  presets/{surau,auditorium,pavilion,index}.js   full scene presets
  templates/             empty-room starter shells
  state/                 reducers + event glue
  shared/                cross-lab utilities

data/                   loudspeaker JSON, material absorption, rack catalogue
tests/                  ~42 Node test files (no framework — plain assert.*)
.claude/agents/         14 specialist agent definitions
```

---

## 3. Core invariants (break these and things go silently wrong)

### State events
Any function that REPLACES whole state arrays (preset apply, project
load, template switch) MUST emit `scene:reset`. Every panel subscribes
to `scene:reset` on mount. Never subscribe a panel to its own granular
event. See `feedback_state_events.md`.

### Preset plumbing
When adding a new field to PRESETS, copy it in `applyPresetToState`
AND assert propagation in `tests/preset.test.mjs`. Otherwise the
renderer sees `undefined` and bails silently. See
`feedback_preset_plumbing.md`.

### Y-axis convention
State coord `+y` = north (toward the front / qibla wall). 2D SVG, 3D
top-down ortho, print plan SVG, and the heatmap pixel grid all flip Y
so state `+y` renders UP the page. There is no single fixture
asserting this across all four surfaces — **track 2 in the regression
backlog**. Don't add a fifth rendering path without one.

### Cache-bust
Bump the `?v=NNN` integer in `index.html` on EVERY shipped change to
CSS/JS/HTML. Verify the deployed file via `curl` before claiming the
fix is live — push exit code is not enough. See
`feedback_verify_deploys.md`.

### Cross-surface conventions
Any concept that renders on ≥ 2 of {2D viewport, 3D viewport, print
plan SVG, print heatmap SVG} (axis sign, north arrow, scale bar, units,
label sizing) must be registered in
`tests/cross-surface-conventions.test.mjs` before merge. Sam
(qa-engineer) owns this fixture as **cross-surface convention owner**.
The north-arrow leak chase (v=515 → v=525, 9 Debug commits) is the
recurring failure mode this invariant prevents.

### Pure modules in `js/physics/` and `js/ui/print-*.js`
These run in Node tests. Never import Three.js or browser-only APIs
into them. The `per-listener-metrics.js` helper imports physics but is
itself imported only by browser-side callers — the pure print SVG
modules accept its OUTPUT (precomputed array), not the helper itself.

### Specialist consultation BEFORE commit
For any visual-physics work (heatmap, 3D, 2D rendering, audio playback,
print layout), consult the relevant specialist FIRST:
- **Graphics / Three.js / camera / shaders** → Viktor (3d-rendering-expert)
- **Physics correctness / standards** → Dr. Chen (acoustics-engineer)
- **Panel UX / copy / accessibility / print art direction** → Maya (ux-designer)
- **PA system architecture** → Felix (pa-integrator)
- **Cross-surface convention parity** → Sam (qa-engineer)

Three regressions shipped in one session (commits f.1/f.2/f.3) when
this was skipped. See `feedback_visual_physics_workflow.md`.

Single-file, ≤ 30 LOC, non-guarded fixes do NOT need pre-consult —
they take the fast lane in §5.

### Visual-physics is LOCAL-FIRST
Heatmap, 3D viewport, 2D viewport, walk-mode commits: commit + bump
cache LOCALLY, **do not push** until the user has hard-refreshed their
own browser and explicitly said "push it". See
`feedback_visual_physics_local_first.md`.

### Same-PR regression test
Every shipped bug fix must land WITH a regression test in the same
commit. Current compliance is ~12% (Theo audit, May 2026) — actively
underwater. Hooks proposed in §7 are intended to enforce this.

---

## 4. Specialist routing table

When a task touches one of these, route to the matching agent (see
`.claude/agents/`):

| Task surface                                       | Agent                       | Persona            |
|----------------------------------------------------|-----------------------------|--------------------|
| Cross-system feature, "which agent?", architecture | tech-lead                   | Hannes Brauer      |
| 3D viewport, Three.js, walk-mode, post-FX, shaders | 3d-rendering-expert         | Viktor Lindqvist   |
| Acoustics physics correctness, standards (ISO/IEC) | acoustics-engineer          | Dr. Lena Chen      |
| PA spec, racking, amps, Dante/AES67, compliance    | pa-integrator               | Felix Brandt       |
| Walk-mode auralization, IR convolution, WebAudio   | audio-engine-specialist     | Sora Akiyama       |
| Panel UX, copy, accessibility, onboarding          | ux-designer                 | Maya Okafor        |
| Glossary, README, release notes, user-facing copy  | docs-writer                 | Lin Sato           |
| Competitor research (EASE/Odeon/Treble/ArrayCalc)  | market-strategist           | Carmen Vasquez     |
| Test design, fixtures, regression sweeps; cross-surface convention owner (axis, north arrow, scale bar, units, label sizing across 2D viewport / 3D viewport / print plan SVG / print heatmap SVG) | qa-engineer | Sam Reyes |
| Bug-→-test index, same-PR rule enforcement         | regression-curator          | Theo Halvorsen     |
| Frame budget, heap growth, long-session leaks      | performance-profiler        | Mehmet Kaya        |
| GitHub Pages deploy verification, cache-bust       | release-engineer            | Owen Pritchard     |
| End-to-end code review, leaks, state pitfalls      | fullstack-code-reviewer     | Martina Weiss      |
| Fresh-eyes UAT, polish gate before "done"          | uat-tester                  | Priya Krishnamurthy|

Known routing ambiguities (now annotated in each agent's `description:`):
- **Viktor ↔ Maya** on walk-mode → Viktor owns rendering/camera, Maya owns UI feel
- **Lin ↔ Maya** on tooltips → Lin writes the words, Maya approves brevity
- **Martina ↔ Viktor** on Three.js bugs → Martina first (state/leak/order), Viktor validates visual outcome
- **Sora ↔ Dr. Chen** on auralization → Dr. Chen owns the physics that produces the IR; Sora owns everything from the IR onward (WebAudio graph, gain mapping, ConvolverNode lifecycle).
- **Mehmet ↔ Viktor** on perf → Viktor optimises for ms-per-pretty-pixel; Mehmet optimises for ms-per-frame and bytes-per-hour. Frame-budget regression goes to Viktor; heap-growth or long-session bug goes to Mehmet.

Sam is the **cross-surface convention owner**. Any concept that
renders on ≥ 2 of {2D viewport, 3D viewport, print plan SVG, print
heatmap SVG} routes through him before edit — he decides whether it
lives in a shared helper or stays per-surface, and he owns the parity
fixture `tests/cross-surface-conventions.test.mjs`. North arrow, axis
sign, scale bar, units, label sizing currently qualify; add more as
they arise.

Maya also covers **print/proposal art direction** as a sub-hat
(typographic hierarchy, accent colour, cover composition for
`js/ui/print-report.js`). Inherited from the retired proposal-designer
seat 2026-05-19 — the work proved to need an implementer-owner inside
the engineering flow, not an outside spec.

Still-open role gap: dedicated accessibility lead (WCAG / screen-reader / motor-only). Lower priority — Maya covers the basics for now.

### Single-domain vs cross-domain routing

(Added 2026-05-18 per Hannes's self-audit — he was adding latency on single-specialist tasks.)

- **Single-domain (1 subsystem)**: call the specialist DIRECTLY. Don't route through Hannes. Examples: glossary tweak → Lin; shader tone-mapping → Viktor; Sabine equation edit → Dr. Chen; deploy verification → Owen.
- **Cross-domain (2+ subsystems)**: call Hannes (tech-lead). He decomposes and routes. Examples: walk-mode auralization (graphics + physics + audio + UI); the print report (physics + UI + design); preset/template restructure (state + UI + tests + docs).
- **Specialist-vs-specialist disagreement** (the 5 ambiguities above): call Hannes for the tiebreak. He synthesizes the trade-off and decides. If the call is subjective (UX feel, aesthetic), he escalates to the user. If it's a physics or safety claim, the standards specialist has the final say — Dr. Chen for acoustics, Owen for deploys.

### Probation status (Hannes audit, updated 2026-05-19)

- **pa-integrator (Felix)** — still on probation. Deadline extended to **2026-06-22**. Deliverable: a printable BoM + heat-budget page for the surau exterior speaker fitout (single-file print page, one subsystem — fast-lane-friendly). If missed, fold into Dr. Chen as a "system specifier" sub-hat.
- **proposal-designer (Sofia)** — **FOLDED 2026-05-19.** Print/proposal art direction is now a Maya sub-hat. The last 15 commits showed the print report needs an implementer-owner embedded in the engineering flow, not an outside design spec. Sofia's agent file has been retired; `PROPOSAL_DESIGN.md`, if it exists, is no longer load-bearing.

Sora (audio) and Mehmet (perf) are load-bearing-pending but justified by the walk-mode roadmap — expect zero output from them until W.2 work starts. Not on probation.

---

## 5. Workflow

### Before code
1. If the task spans 2+ subsystems → call `tech-lead` (Hannes) first.
2. If the task touches physics / graphics / UX in a non-trivial way →
   consult that specialist BEFORE editing. State the proposal back to
   them; only then implement.
3. Read the relevant memory entries (`feedback_*.md`, `project_*.md`).

### While coding
- **Pure modules stay pure** — physics + print-SVG never import Three.js.
- **Hypothesis BEFORE fix** — when two render paths diverge on the same
  scene, diff scene-level state (`scene.fog`, exposure, camera bounds,
  background) FIRST. Six wasted iterations on geometry knobs once
  because nobody checked `scene.fog`. See `feedback_render_path_diff_first.md`.
- **Style-match work** — audit the rendered DOM + full cascade + structure
  BEFORE patching one CSS property at a time. The May 2026 prose-tier
  match burned 7 rounds otherwise. See `feedback_style_match_audit_first.md`.

### Before commit
1. Run the relevant tests (`node tests/<name>.test.mjs`).
2. Bump the cache version in `index.html` (`?v=NNN` → `NNN+1`).
3. Visual-physics work? Get the user to hard-refresh and accept BEFORE
   pushing. Commit locally, sit on it.
4. Bug fix? Add a regression test in the SAME commit (`feedback_*` says
   what to assert). If no test, name it as a tripwire gap.

### Fast-lane workflow (added 2026-05-19)

A change is a **fast-lane fix** if ALL of these are true:

- Single file, ≤ 30 LOC net diff.
- One subsystem (matches single-domain rule in §4).
- Does **not** touch: `js/physics/`, `js/graphics/scene.js`,
  `js/graphics/heatmap-shader.js`, `js/audio/`, `js/state/`,
  `js/app-state.js`, `data/materials.json`, `data/loudspeakers/*.json`,
  or any GUARDED memory surface (see §6).
- Is one of: a CSS rule change, a copy-string edit, a typo, an
  `overflow:` / `z-index:` / `display:` fix, a tooltip wording change,
  a one-line numeric clamp.

**Fast-lane SKIPS:** specialist pre-consult; LOCAL-FIRST holdback;
Priya UAT gate; hypothesis-before-fix paragraph in the commit message.

**Fast-lane STILL REQUIRES:** cache-bump `?v=NNN`; regression test in
the same commit IF the change is a bug-fix; Owen's post-push live-URL
poll; revert-first if the user reports a regression within 24 h.

**Examples:**
- v=525 `overflow:hidden` on cover titleblock stages → fast lane.
- v=523 outline-every-titleblock-child Debug commit → would have been
  fast-lane, but shouldn't have been a LOCAL commit at all (use a
  worktree probe).
- v=504 `scene.scale.x = -1` X-mirror saga → **NOT** fast lane. Multi-file,
  scene.js + controllers, 12 conversion sites. Full ceremony correct.
- W.x walk-mode auralization → **NOT** fast lane (cross-subsystem).
- Heatmap colour-ramp tweak → **NOT** fast lane (heatmap-shader is guarded).

The cost of one specialist round-trip on a 3-LOC CSS fix exceeds the
regression risk of the fix itself. The north-arrow chase (v=515→v=525,
9 Debug commits) is the canonical waste this rule prevents.

### After push
1. Poll `https://chongthekuli.github.io/RoomLab/index.html` until the
   new `?v=NNN` is served. Don't trust `git push` exit code.
2. UAT gate — for any user-facing change, walk through the feature
   yourself (or hand off to Priya). Technical correctness alone is
   insufficient. See `feedback_uat_gate.md`. (Skipped for fast-lane
   fixes per the rule above.)

---

## 6. Top known coverage gaps (Theo, May 2026)

Same-PR regression test compliance: **~12%**. Priority backlog:

1. **Custom-draw polygon flow** — 10 iterative fixes (`3d86a6a` →
   `90248db`), zero tests. Needs a state-machine test of
   `js/ui/custom-draw.js`.
2. **2D ↔ 3D ↔ print Y-axis convention** — 4 commits chased the same
   orientation bug across surfaces. **Resolved-on-paper 2026-05-19** by
   `tests/cross-surface-conventions.test.mjs` (spec'd by Hannes, owned
   by Sam — see §3 "Cross-surface conventions"). Remove from backlog
   when the fixture lands. The X-mirror saga (v=494→v=504) gets
   subsumed by the same fixture.
3. **Heatmap rendering pipeline** — N-S row flip, surau split-on-rotation,
   pipeline-order, single-annulus podium all shipped behavior-untested.
   Needs synthetic 2-source scene → Float32 SPL buffer monotonicity test.
4. **Preset/template confirm-dialog silent-loss guard** (`6883d42`) —
   data-safety feature with no test; refactor would silently lose work.
5. **Triangulate-scene geometry contract** — wall openings, triangle
   winding, wall-id tags. Outputs are entirely untested.

Memories that are **GUARDED** (don't break in a refactor):
`feedback_directivity_aim_flip`, `feedback_sound_power_needs_DI`,
`feedback_stipa_dr_aware`, `feedback_stipa_impl`,
`feedback_line_array_rigging_pivot`, `feedback_preset_plumbing`,
`feedback_state_events` (data swap), `feedback_physics_needs_audit`
(surau only).

Master ledger of every shipped bug + its guarding test: `docs/REGRESSION_INDEX.md`
(owned by Theo / regression-curator).

### Open bugs / convention mismatches

- **2D-3D X-axis disagree** — **RESOLVED 2026-05-18, v=504**. Empirical fix: `scene.scale.x = -1` in `initScene` (mirrors the entire 3D scene horizontally) + every state↔world conversion site updated to negate X. Why a mirror: my math said state +x should land at screen-RIGHT in iso/default (per Three.js lookAt formula), but the user empirically observed state +x at screen-LEFT in EVERY 3D view, consistent with the 2D viewport's east-right convention being violated. After 3 failed attempts to reproduce in math (v=495 camera-pose, v=500 camera.up=(0,0,-1), v=502 camera.up=(0,0,1) + v=503 CSS scaleX(-1) Top-only — all only fixed Top), v=504 trusts the empirical observation and applies a scene-level mirror with the downstream conversion sites the v=497 attempt missed:
  - **Camera presets** (`_cameraPresetTransform` top/front/back/left/right): negate `cx`, `minX`, `maxX` in `targetPos`/`targetCam`. Iso uses `box.getCenter()` which auto-handles the mirror via `expandByObject`'s `matrixWorld` traversal.
  - **`frameCameraToRoom`**: negate `cx + d3*0.9` and `cx` (initial 3D framing on mount).
  - **`focusCameraOnSelectedListener`**: `tx = -lst.position.x`.
  - **Walk-mode spawn** (`placeAvatarAtDefault`): `setPosition(new Vector3(-cx, ...))`.
  - **Walk-mode controller** (`third-person-controller.js`): `this.pos` semantics changed to **WORLD frame**; mesh writes negate X (`character.position.set(-this.pos.x, …)` + `character.rotation.y = -this.yaw`). Raycasts and camera offsets use `this.pos` directly (world frame). Mouse-drag `cameraYaw` direction inverted (`+= dx` not `-= dx`) so visible-right rotation matches user expectation.
  - **Click-to-place / drag**: every site converting `hit.point.x` (raycaster world output) back to `state.x_m` negates X — probe tool listener pos + marker, treatment placement ceiling + wall, `_raycastIntoSurfacePlane`'s two `worldXY` returns, `place-room-controller._screenToFloor` ✓.
  - **Audition writeback** + **walk SPL readout**: `tp.x` negated when consumed in state-frame (`x: -tp.x`).
  - **Unchanged on purpose**: room/source/listener/treatment/zone/podium mesh placement (they use state coords as mesh-local positions; scene.scale.x = -1 handles the visual mirror automatically). Three.js auto-detects negative-determinant world matrix and reverses face-winding internally, so no `material.side = DoubleSide` change needed.
  - **Known limitation**: source-aim ray viz (scene.js ~5089) keeps state-frame origin/direction; its raycaster shoots into the mirrored mesh world so it may miss the wall mesh it should stop at. Falls back to `polygonRayExitT` clamp (state-frame, correct). Visual arrow length is correct; raycast-against-audience-tier hits may overshoot. Fix later if it bites.
  - **Failed-attempt history**: v=494 (minaret corner flip), v=495 (move camera to -Z side), v=497 (scene.scale.x = -1 without downstream fixes — broke camera-fit + walk + drag), v=498 (revert v=497), v=500 (camera.up = (0,0,-1) — no-op), v=501 (revert v=500), v=502 (camera.up = (0,0,1) — fixed Top Y only, X still mirrored), v=503 (Top-only CSS X-flip — only fixed Top), v=504 (this fix).
  - **Guard**: `tests/scene-x-mirror.test.mjs` — text-grep over scene.js + place-room-controller.js + third-person-controller.js asserting all negation sites are present.

### Other coverage holes (Hannes 2026-05-18 audit)

These are roles / surfaces with no clear owner, not test gaps:

1. **WCAG / accessibility lead** — Maya covers keyboard reachability + contrast basics, but no one owns screen-reader semantics, motor-only nav, or colour-blind palette validation. Heatmap ramps have not been audited for deuteranopia.
2. **HRTF / DOA pipeline** — between Dr. Chen's physics (produces the IR) and Sora's WebAudio (consumes the IR from convolver onward), the per-DOA energy decomposition has no owner. Becomes load-bearing when walk-mode auralization adds head-tracked binaural.
3. **CI for test suite** — **RESOLVED 2026-05-19** by `.github/workflows/tests.yml` (owned by Owen, release-engineer). The workflow runs `node tests/*.test.mjs` on push to `main` and on PRs targeting `main`, pinned to Node 22 LTS, no install step (project has no package.json). Per-file pass/fail with both signals checked (non-zero exit code AND `FAIL ` line on stdout — some legacy tests print + exit 0). A single failure fails the build and shows up in the PR check list as `tests`. The 12% same-PR regression-test compliance number now has a mechanical signal behind it.
4. **Vendor outreach** for ROADMAP item #11 (open speaker spec evangelism) — Carmen owns strategy, Lin owns documentation; no one owns the actual conversations with Amperes/Bose/Adamson.

---

## 7. Hooks (live — `.claude/settings.json` + `.claude/hooks/`)

Shipped 2026-05-18. Activate via `/hooks` once or restart Claude Code if they aren't firing yet.

- **`cache-bump-guard.js`** — PreToolUse on `git commit *`. Warns (non-blocking) if `js/`, `css/`, or `index.html` are staged but `?v=NNN` integer is unchanged vs `origin/main`.
- **`regression-test-reminder.js`** — PreToolUse on `git commit *`. Asks (`permissionDecision: "ask"`, blocking) if commit message contains `fix|regression|revert|broken|hotfix` but no `tests/*` file is staged.
- **`visual-physics-push-guard.js`** — PreToolUse on `git push *`. Asks for confirmation (`permissionDecision: "ask"`) when HEAD touches `js/graphics/`, `js/physics/precision/`, `js/audio/`, `js/ui/print-heatmap.js`, `js/ui/print-plan-svg.js`, or heatmap-shader code. Enforces `feedback_visual_physics_local_first` mechanically.
- **`stop-cache-bump-nudge.js`** — Stop event. One-line nudge if uncommitted js/css/html exists with unchanged `?v=`.
- **`deploy-poll.js`** — PostToolUse on `git push origin main`, async. Polls live URL for 30 s until `?v=NNN` matches local; reports result.

To disable any one, edit `.claude/settings.json` or use `/hooks`.

---

## 8. Quick commands

```bash
# run a single test
node tests/<name>.test.mjs

# verify live deploy
curl -s "https://chongthekuli.github.io/RoomLab/index.html?cb=$RANDOM" | grep "v="

# find references to a symbol
# (use the Grep tool, not raw rg, in Claude Code)

# the project has no build step, no package.json, no node_modules
# tests use plain node + built-in assert
```

---

## 9. Memory pointers (the why behind the rules)

See `MEMORY.md` under
`C:\Users\chchy\.claude\projects\d--OneDrive-CCY-LINKAGE-Projects-RoomLab\memory\`
for the curated index. Categories:

- **user_*** — who the user is, how to collaborate
- **project_*** — initiatives, audits, decisions in flight
- **reference_*** — external pointers (GitHub repo, deploy URL)
- **feedback_*** — past failures + the rule that prevents recurrence

Always check the `feedback_*` set before tackling rendering, presets,
panels, or physics — the past bug catalog is mostly there.
