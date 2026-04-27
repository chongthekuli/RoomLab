# RoomLAB Roadmap (2026-04, rev 2)

Source: `COMPETITIVE_GAPS.md` (Carmen Vasquez, market-strategist) + independent specialist sign-offs from Dr. Chen (acoustics), Maya Okafor (UX), Sam Reyes (QA), Martina Weiss (fullstack-code-review). Synthesised by Hannes Brauer.

**Rev 2 changelog:** Q1 #3 was originally "per-surface scattering coefficient." Dr. Chen vetoed it on physics grounds — see Q1 #3 below. Replaced with a higher-impact RT60 upgrade that closes the same user-facing gap with correct physics. Implementation notes added per Q1 item from specialist input. Scattering moved to Phase B (precision tracer integration).

This is a decision document. Each item names the competitor that inspired it, the user pain it solves, the specialist's effort estimate, and what breaks if we don't ship it.

---

## Q1 2026 (next 3 months) — three quick wins

### 1. Shareable read-only project URL ("Copy link" button)

Inspired by **Treble** (Google-Docs-style sharing) and **Soundvision Connect** (2025 Pro-AV award winner).
User pain: `.roomlab.json` over email is friction; the recipient doesn't know how to load it.
**Effort: S, 3 days** (Maya UX + 1 day Sam round-trip tests + 1 day Martina-flagged hardening).

**Implementation notes (must-do-before-code):**
- Encoder: `TextEncoder` → URL-safe base64 (`-` `_` `=`-stripped). NOT raw `btoa(JSON.stringify(...))` — that throws on em-dash, ″, future i18n labels (Martina, CRITICAL).
- Optional: `CompressionStream` deflate before base64 — drops pavilion from ~70 KB to ~12 KB encoded.
- Boot order: hash decode runs **once** in a microtask deferred until **after** `bootstrap()` mounts every panel. Otherwise `emit('scene:reset')` fires into an empty subscriber set and the panels silently miss the load (Martina, CRITICAL).
- Hash policy: **explicit-only**. No `hashchange` auto-replace — that silently clobbers unsaved work (Martina, CRITICAL). Incoming link → banner: "shared scene detected — open it? [open] [keep current] [dismiss]". Default focus on `open`, Esc dismisses (Maya).
- Oversize fallback: > 8 000 chars triggers an inline banner offering Save instead. Never silently truncate.
- Slimmed payload: reuse `serializeProject()` so save and share NEVER drift. New tests must whitelist the share-encoded keys to catch future leakage (e.g. accidental `splGrid` in URL) (Sam).
- New test file: `tests/share-link.test.mjs` — round-trip, oversize fixture, truncated-hash, garbage-hash, format-version mismatch, Unicode preservation.

**Files**: `js/io/share-link.js` (new), `js/io/project-file.js` (extend), `js/ui/panel-room.js` (🔗 button next to Save/Load), `tests/share-link.test.mjs` (new).

### 2. Printable report (browser print stylesheet)

Inspired by **EASE Focus 3** printed report and **ArrayCalc V12** Virtual Patch Plan.
User pain: a system-design tool isn't "real" until the spec sheet leaves the screen.
**Effort: S, 3 days** (Maya for layout; Sam for `buildPrintModel` test).

**Implementation notes (must-do-before-code):**
- Snapshot, not live canvas: `beforeprint` raster the heatmap to an offscreen canvas with `preserveDrawingBuffer: true` *just for that frame*, swap an `<img>` into the print stylesheet, restore on `afterprint`. Globally setting `preserveDrawingBuffer: true` costs 10–15% framerate on integrated GPUs (Martina, HIGH).
- Cancel rAF during print to avoid mid-rebuild rasterising (Martina, HIGH).
- A4 portrait default. Print-only checkbox in room panel for landscape on wide rooms (Maya).
- Page header: project name + date right-aligned + RoomLAB version. Project name source: last loaded/saved filename, fallback "untitled scene". Editable inline in room-panel title — one source of truth used by Save, Share, AND Print (Maya).
- Body order, drop-bottom-on-overflow: room plan, RT60 table, source list, zone STIPA table, listener table.
- Pagination: `tr { break-inside: avoid }` and `thead { display: table-header-group }` — repeat header on every page (Martina, MEDIUM).
- BLOCKER on shipping: every numeric column in print MUST carry units (`s`, `dB`, `°`, `m`, `Hz`). A printed report attached to a BOMBA submission without units is a liability (Maya).

**Files**: `js/ui/print-report.js` (new), `css/print.css` (new), `js/ui/panel-room.js` (🖨 button + Cmd/Ctrl-P binding).

### 3. RT60 upgrade — Eyring default + Fitzroy for asymmetric α (REPLACES original "per-surface scattering")

**Why this changed**: Dr. Chen's sign-off on the original scope was a hard NO. Sabine's diffuse-field assumption already implies scattering = 1; injecting a `scattering[]` weighting into the Sabine sum is dimensionally meaningless. The actual P1 — "too-clean RT60 tail at high mean-α" — is a **non-diffuse-field** problem solved by Eyring (already implemented but not used) plus Fitzroy for axis-asymmetric α (Beranek 2nd ed. §7.7). Cited: Kuttruff §5.4, Cox & D'Antonio §1.5.
Inspired by **Odeon** (which uses Eyring/Fitzroy by default in its statistical-acoustics tab).
User pain: Sabine over-predicts RT60 by 25–35% in absorptive auditoriums; the printed report claims a number measured rooms don't reproduce.

**Effort: M, 2 weeks** — broken down by Dr. Chen:
- Day 1: switch displayed RT60 to Eyring when ᾱ > 0.2 (toggle for Sabine comparison kept).
- Days 2–4: Fitzroy option for asymmetric-α rooms (auto-suggest when max(αᵢ)/min(αᵢ) > 3).
- Days 5–8: regression fixture against Beranek table 7-3 measured halls (Boston Symphony occupied + ISO 354 reverb chamber + Bradley 1986 mid-α office), tolerance per band: Fitzroy ±10%, Eyring ±15%, Sabine documented as "expected to diverge >25% on chamber".
- Days 9–10: documentation entry — "Draft engine assumes diffuse field; scattering coefficients in materials.json drive the precision tracer only."

**Pre-implementation gate (Sam)**: ship `tests/golden-rt60.test.mjs` BEFORE the physics change lands. Snapshot every preset/template's RT60 today; this test will fail loudly when Eyring/Fitzroy ships, forcing an intentional snapshot update co-signed by Dr. Chen in the same PR. Without this test, RT60 numbers shift silently and we won't catch it until a customer asks.

**The strategic dividend**: this fix *will* move the auditorium RT60 visibly (it has highly asymmetric α — absorptive seats vs reflective bowl walls). The pavilion will barely move (mean α ≈ 0.07, Eyring−Sabine = 3.5%). That ordering of impact is the OPPOSITE of what shipping "scattering" would have produced — Carmen's competitive-positioning argument now has measurable weight.

**Files**: `js/physics/rt60.js` (use Eyring path; add Fitzroy), `tests/golden-rt60.test.mjs` (new — pre-implementation), `tests/rt60-reference-halls.test.mjs` (new), `docs/physics-simplifications.md` (new — owns the limitation).

---

## Q2–Q3 2026 (3–9 months) — medium-effort features

4. **Auto-splay optimiser for line arrays.**
   Inspired by **Soundvision Autosplay/Autosolver** and **EASE Focus 3 Auto-Splay**.
   User pain: designers spend ~10 minutes per array hand-tuning splay angles; one click should do it.
   Effort: **M, ~2 weeks** (Dr. Chen owns objective function = minimise audience-zone SPL variance subject to splay bounds; Hannes implements greedy element-by-element search). Honest only above ~800 Hz with our current 0.42 m spacing assumption — frame the UI accordingly ("HF-coverage-optimised splay").

5. **Per-source virtual EQ (per-band gain trim before sum).**
   Inspired by **EASE Focus 3** virtual EQ.
   User pain: today the master EQ acts globally; line-array tuning needs per-source HPF/shelf to demonstrate vendor presets.
   Effort: **M, ~1 week** (Dr. Chen for the per-band convolution; Maya for the panel; Sam for round-trip).

6. **IFC / SketchUp DXF improvements (extend existing DXF importer to handle named layers as material zones).**
   Inspired by **EASE 5** and **Treble** IFC/Revit support.
   User pain: today, custom-room geometry has to be drawn in our polygon tool. Architects already have IFC files.
   Effort: **M, ~3 weeks** (Hannes; Sam for malformed-file negative tests). Defer real IFC; do better DXF first.

7. **Per-surface scattering — sidecar field, precision-engine consumer only** (replaces former Q1 #3).
   Inspired by **Odeon 19** (frequency-dependent scattering per surface) and **CATT-Acoustic** (Lambert scattering as first-class physics).
   User pain (Phase B): the precision tracer needs scattering input to choose diffuse vs specular bounce; without it, ISM-only paths flutter.
   Architecture (Martina, HIGH): NEW `room.surfaceScattering: { floor: 0.3, ... }` sidecar object — null/missing means "inherit from material". DO NOT mutate `room.surfaces` shape. ONE resolver helper (`scatteringFor(surfaceKey)`) plumbed through draft, precision, AND `multiLevelInteriorSurfaces` / `stadiumStructure` so physics is consistent. Schema stays at `formatVersion: 1` (additive optional field).
   Test strategy (Sam): `tests/scattering.test.mjs` — v1-without-scattering migration, range clamping (s ∈ [0, 1]), property test (RT60 deltas with/without scattering once the precision tracer reads it).
   Effort: **M, ~1 week** for the sidecar field + UI + tests. The physics consumer is the precision tracer (separate epic).

8. **Surface scattering visual cue (hatched overlay on faces with scatter > 0).**
   Inspired by **Odeon** material-property visualisation.
   Effort: **S, ~3 days** (Viktor; depends on item 7 having shipped).

---

## 12+ month horizon — major architectural moves

9. **Auralisation (binaural impulse-response convolution at the listener).**
   Inspired by **EASE EARS**, **Odeon**, **CATT**, **Treble**.
   The flagship "we are the only browser tool that can do this" feature, but only honest after the precision ray-tracer produces a usable IR. Pipeline: precision engine → energy-time response per DOA → HRTF convolution (MIT KEMAR or CIPIC) → Web Audio API ConvolverNode plays user-uploaded anechoic source.
   Effort: **L, 6–8 weeks AFTER the precision ray-tracer v1 ships** (Dr. Chen + Viktor for head-tracking integration). Refuse to ship a fake reverb-tail "auralisation" — users will compare to EASE EARS and lose trust.

10. **Real-time SPL preview while dragging sources (WebGL-compute or worker-thread heatmap).**
    Inspired by **EASE 5 Acousteer** (October 2025, v5.77 — the new bar for the industry).
    User pain: today the heatmap recomputes on a debounce after the drag ends; pros want continuous feedback.
    Effort: **L, 4–6 weeks** (Viktor for WebGL2 compute path; Hannes for solver refactor). Browser support is now adequate (~95% of WebGL2 in 2026).

11. **In-browser GLL-style speaker data import (open spec, not AFMG's GLL).**
    Inspired by the user pain that **EASE Focus 3**'s entire moat is GLL data files supplied by manufacturers.
    Strategy: do NOT chase GLL itself (closed binary, AFMG-controlled SDK). Define a public open-format spec, publish it, lobby 2–3 vendors (Amperes already on board) to ship native files in our format. Effort: **L over 6+ months**, mostly outreach. Carmen leads the vendor conversations; Hannes maintains the spec; Lin (docs-writer) publishes it.

---

## Things we should explicitly NOT build

- **Cloud-rendered wave-based simulation (the Treble play).**
  Reasons: (a) wave solvers below 500 Hz need GPU clusters that don't fit on GitHub Pages; (b) WebGL2-compute is not viable at room scale client-side; (c) Treble has VC funding for the GPU farm, we do not. Our positioning advantage is "free, browser, embed-anywhere, no account" — that is structurally incompatible with running a paid GPU backend. Compete where the incumbents are slow (sharing, embedding, multi-vendor neutrality, zero install), not where they are fast.

- **Native GLL import.** GLL is a closed binary, AFMG's SDK is licensed, and even if we cracked it tomorrow we'd be shipping a feature that depends on a competitor's continued blessing. See item 11 above for the alternative.

- **Per-surface scattering wired into the draft engine.** Vetoed by Dr. Chen — Sabine's diffuse-field assumption already implies scattering = 1. Injecting a `scattering[]` weighting into the Sabine sum is dimensionally meaningless and would mislead users when their RT60 number doesn't change. Scattering belongs in the precision tracer's bounce decisions, nowhere else.

- **`hashchange`-triggered auto-replace of the current scene.** Vetoed by Maya AND Martina — silent data loss is the worst class of bug. Pasting a colleague's link mid-edit must NEVER overwrite without confirm.

- **Globally-on `preserveDrawingBuffer` to support print snapshots.** Vetoed by Martina — pays a 10–15% framerate tax on every user for a feature few will use. Snapshot offscreen at print-time only.

- **A modal "Did you mean…?" autocorrect or a confirmation dialog on every save.** Maya's house rule: pro tools don't second-guess engineers. If a user saves, it saves. Undo / load handle the rest.

- **An Odeon-class ray-visualisation animation as a primary-UI feature.** Even Odeon and EASE use it as a QA / debug tool. Our screen real estate is not big enough to compete on visual spectacle, and the heatmap+isobars already communicate coverage. Keep ray viz behind a debug toggle if it ships at all.

---

## Pre-implementation gates (Q1)

These must land BEFORE the corresponding Q1 feature lands, otherwise the feature will silently break things:

- **Q1 #1 (Share)** → defer the boot-time dispatch + use `TextEncoder`. Without these, the first non-ASCII label in the wild crashes Share, and racing-against-panel-mount loses scene state silently.
- **Q1 #2 (Print)** → `beforeprint`/`afterprint` lifecycle with rAF cancel + offscreen-canvas snapshot. Without this, printing prints a black rectangle on Chromium and nothing else fits.
- **Q1 #3 (RT60 upgrade)** → ship `tests/golden-rt60.test.mjs` (snapshot of every preset's RT60 today) BEFORE the physics change lands. Without this, the RT60 numbers shift and the test suite stays green; nobody notices until a customer.

---

## Decision matrix (for the user to react to)

| Item | Q | Effort | Inspired by | Why now |
|---|---|---|---|---|
| Copy-link share | Q1 | S | Treble, Soundvision Connect | Free win; closes the #1 user-pain gap |
| Printable report | Q1 | S | EASE Focus 3, ArrayCalc V12 | Pros need spec sheets that leave the screen |
| RT60 upgrade (Eyring + Fitzroy) | Q1 | M | Odeon, Beranek (textbook) | Replaces vetoed scattering plan; auditorium will visibly improve |
| Auto-splay | Q2 | M | Soundvision, EASE Focus 3 | Highest-value feature for line-array users |
| Virtual EQ per source | Q2 | M | EASE Focus 3 | Pairs with auto-splay |
| DXF layer-as-material | Q2-Q3 | M | EASE 5, Treble | Architects already have these files |
| Scattering sidecar field | Q2-Q3 | M | Odeon 19, CATT | Phase B physics input — precision tracer only |
| Scatter visual cue | Q2-Q3 | S | Odeon | Cheap polish on item 7 |
| Auralisation | 12+ mo | L | EASE EARS, Treble, Odeon, CATT | The "only browser tool that can" feature |
| Real-time SPL | 12+ mo | L | EASE 5 Acousteer | Industry bar shifted in Oct 2025 |
| Open speaker spec | 12+ mo | L | (Counter to GLL moat) | Strategic, not technical |
| Cloud wave solver | NEVER | — | Treble | Wrong fight; structurally incompatible |
| GLL native import | NEVER | — | EASE | Closed format; vendor-controlled |
| Scattering in draft engine | NEVER | — | (Carmen's first-cut idea) | Dr. Chen veto — dimensionally meaningless in Sabine |
| `hashchange` auto-replace | NEVER | — | (apparent-convenience) | Silent-data-loss footgun |

---

Last reviewed 2026-04-27 (rev 2 — post-specialist sign-off).
