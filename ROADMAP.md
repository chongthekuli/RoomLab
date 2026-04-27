# RoomLAB Roadmap (2026-04)

Source: `COMPETITIVE_GAPS.md` (Carmen Vasquez, market-strategist) + specialist feasibility briefs from Dr. Chen (acoustics), Viktor Lindqvist (3D), Maya Okafor (UX), Sam Reyes (QA). Synthesised by Hannes Brauer.

This is a decision document. Each item names the competitor that inspired it, the user pain it solves, the specialist's effort estimate, and what breaks if we don't ship it.

---

## Q1 2026 (next 3 months) — three quick wins

1. **Shareable read-only project URL ("Copy link" button).**
   Inspired by **Treble** (Google-Docs-style sharing) and **Soundvision Connect** (2025 Pro-AV award winner).
   User pain: `.roomlab.json` over email is friction; the recipient doesn't know how to load it.
   Effort: **S, 2 days** (Maya) + **3 hours** of round-trip tests (Sam). Fallback to "save the file" when payload > 8 KB.

2. **Printable report (browser print stylesheet).**
   Inspired by **EASE Focus 3** printed report and **ArrayCalc V12** Virtual Patch Plan.
   User pain: a system-design tool isn't "real" until the spec sheet leaves the screen.
   Effort: **S, 3 days** (Maya). One-page report: dimensions, RT60 table, STIPA, source list, heatmap screenshot. `window.print()` + a print stylesheet — no PDF library.

3. **Per-surface scattering coefficient (single mid-band value).**
   Inspired by **Odeon 19** (frequency-dependent scattering per surface) and **CATT-Acoustic** (Lambert scattering as first-class physics).
   User pain: ISM-only paths in rooms with mean α > 0.25 produce flutter and an unphysically clean late-decay tail.
   Effort: **M, ~1 week** (Dr. Chen plumbing + precision-engine integration; Sam round-trip tests). New `materials.json` field; default 0.10. Does NOT claim ISO 17497-1 compliance — owns the simplification (P3-tier on the backlog).

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

7. **Surface scattering visual cue (hatched overlay on faces with scatter > 0).**
   Inspired by **Odeon** material-property visualisation.
   Effort: **S, ~3 days** (Viktor; depends on Q1 item 3 having shipped).

---

## 12+ month horizon — major architectural moves

8. **Auralisation (binaural impulse-response convolution at the listener).**
   Inspired by **EASE EARS**, **Odeon**, **CATT**, **Treble**.
   The flagship "we are the only browser tool that can do this" feature, but only honest after the precision ray-tracer produces a usable IR. Pipeline: precision engine → energy-time response per DOA → HRTF convolution (MIT KEMAR or CIPIC) → Web Audio API ConvolverNode plays user-uploaded anechoic source.
   Effort: **L, 6–8 weeks AFTER the precision ray-tracer v1 ships** (Dr. Chen + Viktor for head-tracking integration). Refuse to ship a fake reverb-tail "auralisation" — users will compare to EASE EARS and lose trust.

9. **Real-time SPL preview while dragging sources (WebGL-compute or worker-thread heatmap).**
   Inspired by **EASE 5 Acousteer** (October 2025, v5.77 — the new bar for the industry).
   User pain: today the heatmap recomputes on a debounce after the drag ends; pros want continuous feedback.
   Effort: **L, 4–6 weeks** (Viktor for WebGL2 compute path; Hannes for solver refactor). Browser support is now adequate (~95% of WebGL2 in 2026).

10. **In-browser GLL-style speaker data import (open spec, not AFMG's GLL).**
    Inspired by the user pain that **EASE Focus 3**'s entire moat is GLL data files supplied by manufacturers.
    Strategy: do NOT chase GLL itself (closed binary, AFMG-controlled SDK). Define a public open-format spec, publish it, lobby 2–3 vendors (Amperes already on board) to ship native files in our format. Effort: **L over 6+ months**, mostly outreach. Carmen leads the vendor conversations; Hannes maintains the spec; Lin (docs-writer) publishes it.

---

## Things we should explicitly NOT build

- **Cloud-rendered wave-based simulation (the Treble play).**
  Reasons: (a) wave solvers below 500 Hz need GPU clusters that don't fit on GitHub Pages; (b) WebGL2-compute is not viable at room scale client-side; (c) Treble has VC funding for the GPU farm, we do not. Our positioning advantage is "free, browser, embed-anywhere, no account" — that is structurally incompatible with running a paid GPU backend. Compete where the incumbents are slow (sharing, embedding, multi-vendor neutrality, zero install), not where they are fast.

- **Native GLL import.** GLL is a closed binary, AFMG's SDK is licensed, and even if we cracked it tomorrow we'd be shipping a feature that depends on a competitor's continued blessing. See item 10 above for the alternative.

- **A modal "Did you mean…?" autocorrect or a confirmation dialog on every save.** Maya's house rule: pro tools don't second-guess engineers. If a user saves, it saves. Undo / load handle the rest.

- **An Odeon-class ray-visualisation animation as a primary-UI feature.** Even Odeon and EASE use it as a QA / debug tool. Our screen real estate is not big enough to compete on visual spectacle, and the heatmap+isobars already communicate coverage. Keep ray viz behind a debug toggle if it ships at all.

---

## Decision matrix (for the user to react to)

| Item | Q | Effort | Inspired by | Why now |
|---|---|---|---|---|
| Copy-link share | Q1 | S | Treble, Soundvision Connect | Free win; closes the #1 user-pain gap |
| Printable report | Q1 | S | EASE Focus 3, ArrayCalc V12 | Pros need spec sheets that leave the screen |
| Scattering coeff | Q1 | M | Odeon 19, CATT | Fixes a known physics simplification (P3) |
| Auto-splay | Q2 | M | Soundvision, EASE Focus 3 | Highest-value feature for line-array users |
| Virtual EQ per source | Q2 | M | EASE Focus 3 | Pairs with auto-splay |
| DXF layer-as-material | Q2-Q3 | M | EASE 5, Treble | Architects already have these files |
| Scatter visual cue | Q2-Q3 | S | Odeon | Cheap polish on Q1 #3 |
| Auralisation | 12+ mo | L | EASE EARS, Treble, Odeon, CATT | The "only browser tool that can" feature |
| Real-time SPL | 12+ mo | L | EASE 5 Acousteer | Industry bar shifted in Oct 2025 |
| Open speaker spec | 12+ mo | L | (Counter to GLL moat) | Strategic, not technical |
| Cloud wave solver | NEVER | — | Treble | Wrong fight; structurally incompatible |
| GLL native import | NEVER | — | EASE | Closed format; vendor-controlled |

---

Last reviewed 2026-04-27.
