# RoomLAB Competitive Gap Analysis (2026-04)

Author: Carmen Vasquez (market-strategist), reviewed and synthesised by Hannes Brauer (tech-lead).
Scope: 8 competitors covering the room-acoustics + PA-prediction segment that overlaps RoomLAB's positioning (browser, single-user, free).

---

## Where RoomLAB already wins

- **Zero-install, browser-only, free.** None of EASE 5, EASE Focus 3, Odeon, CATT-Acoustic, ArrayCalc, MAPP 3D, or Soundvision runs in a browser without an account or installer. Treble does, but it is paid SaaS behind a 14-day trial. RoomLAB is the only tool that opens from a Google Site embed and works in 30 seconds. (Source: each vendor's product page, listed below.)
- **Multi-vendor speaker library out of the box.** ArrayCalc, Soundvision, MAPP 3D, and Compass are vendor-locked by design — d&b only, L-Acoustics only, Meyer only. EASE Focus 3 supports multi-vendor but only through GLL files supplied by each manufacturer. RoomLAB's open JSON speaker schema (~17 models including Amperes ceiling line + line arrays) is a positioning anchor for system designers who specify across brands.
- **Two arena-scale signature presets + 8 parametric templates.** None of the vendor-tools ship "load a 4-level mall in one click"; in EASE / Odeon the user builds the room first. RoomLAB skips the cold-start that competitors universally fail at.
- **Free STIPA prediction.** EASE Pro tier and EASE EARS module gate STI behind their licence; ArrayCalc reports STI Aural; RoomLAB exposes it free at draft fidelity.

---

## Top 3 feature gaps to close in the next 6 months

1. **Shareable read-only project link (URL-encoded `.roomlab.json`)** — drawn from **Treble** (Google-Docs-style sharing) and **Soundvision Connect** (2025 Pro-AV award winner, explicitly built for "share with the system tech and the venue manager"). User pain it solves: today a designer sends a `.roomlab.json` over email and the recipient has to know how to load it; the file is small enough to fit in a URL hash. Effort estimate after specialist input: **S** (Maya / Sam). Specialist who weighed in: ux-designer + qa-engineer.
2. **PDF / printable report export** — drawn from **EASE Focus 3** (printed report with packing list and safety data), **ArrayCalc V12** (the Virtual Patch Plan is essentially a print-ready document), and the universal user complaint that a system-design tool isn't "real" until the spec sheet leaves the screen. User pain: designers cannot hand a venue manager a screen recording of the heatmap. Effort estimate: **S–M** (Maya). Specialist: ux-designer.
3. **Per-surface scattering coefficient (single mid-band entry, ISO 17497-style)** — drawn from **Odeon 19** (frequency-dependent scattering per surface) and **CATT-Acoustic / TUCT** (Lambert scattering as the first-class physics). User pain: at high mean-α, all-specular reflections produce flutter and an unphysically clean RT60 decay; even one mid-band scattering value per surface eliminates the "too-clean" look. Effort estimate: **M** (Dr. Chen). Specialist: acoustics-engineer.

---

## Top 5 feature gaps to track (12+ month horizon)

1. **Auralisation (binaural impulse-response convolution at the listener)** — EASE EARS, Odeon, CATT, Treble all have it. RoomLAB is the only browser tool that *could* ship it via Web Audio API + ConvolverNode without a server tier. Effort: **L** (Dr. Chen + Viktor; needs the precision ray-tracer to produce a usable IR first).
2. **GLL speaker-data import** — EASE's moat. Without it, the manufacturers who only publish GLL (most of d&b, L-Acoustics for export, Bose, Renkus-Heinz, JBL Vertec) stay out of reach. Track but do not chase: GLL is a closed binary format and AFMG controls the SDK. Effort: **L** with significant legal/licensing question marks.
3. **IFC / 3D-model import for arbitrary room geometry** — EASE 5 imports IFC, Treble imports IFC and Revit, Odeon imports DXF/SU. RoomLAB has DXF import but no IFC. Effort: **M** (Sam round-trip; Viktor for geometry sanity).
4. **Real-time / GPU-accelerated SPL preview while moving sources** — EASE 5's Acousteer engine (October 2025, v5.77) made this the new bar. Hybrid CPU/GPU; user drags a source and sees the heatmap update at interactive frame rates. WebGL-compute is the path. Effort: **L** (Viktor).
5. **Auto-splay / auto-EQ for line arrays** — Soundvision's Autosolver / Autosplay / Autofilter and EASE Focus 3's Auto-Splay. Designers spending 10 minutes per array on splay angles are losing to a one-click optimiser. Effort: **M** (Dr. Chen owns the objective function; Hannes the implementation).

---

## What RoomLAB should explicitly NOT build

**Cloud-rendered wave-based simulation (the Treble play).** Treble's hybrid wave / geometrical-acoustics solver is its differentiator, and it is the wrong fight for RoomLAB. Reasons: (a) wave-based solvers below 500 Hz require GPU clusters that don't fit on GitHub Pages; (b) running it client-side in WebGL2 is not viable at room scale; (c) Treble already raised venture capital to fund the GPU farm and we have not. RoomLAB's positioning advantage (free, browser, embed-anywhere, no account) is incompatible with the infrastructure cost a wave solver demands. Carmen's house rule: you cannot out-feature a funded incumbent on their core differentiator on a 12-month timeline. Compete where they are slow (sharing, embedding, multi-vendor neutrality, zero install), not where they are fast.

---

## Per-competitor matrix

| Competitor | Their killer feature | RoomLAB has? | User pain we'd solve by adding it |
|---|---|---|---|
| EASE 5 (AFMG) | AURA ray-tracer + Acousteer real-time engine + EARS auralisation + GLL import | partial (precision engine in dev; no GLL; no auralisation) | "Real-time SPL while I drag the source"; binaural listening; GLL data |
| EASE Focus 3 (AFMG) | Free line-array tool with Auto-Splay, virtual EQ, GLL multi-brand support | partial (free; multi-brand via JSON; no auto-splay; no virtual EQ) | One-click splay optimisation, per-source virtual EQ |
| Odeon 19 | Per-surface frequency-dependent scattering, MP4 auralisation walkthrough export, building-acoustics module | no on all three | Realistic late-decay shape; sharable walkthrough video |
| CATT-Acoustic / TUCT | Edge-diffraction (Biot-Tolstoy), T-30 vs T-20 non-diffuseness diagnostic, binaural IR convolution | no | Diagnostic that a "non-diffuse" room shows up in the prediction; first-order diffraction off balcony fronts |
| Treble | Browser-native, cloud wave+GA hybrid solver, immersive auralisation, Google-Docs sharing | partial (browser yes; sharing no; auralisation no; wave solver no) | Send a project link to a colleague; hear the room |
| ArrayCalc 12 (d&b) | Virtual Patch Plan, vendor-perfect d&b directivity, ArrayProcessing, native Mac+Win | no | Spec-sheet-ready printable doc; signal-flow diagram |
| Soundvision (L-Acoustics) | Autosplay / Autofilter / Autosolver, Soundvision Connect sharing, EASE 5 export | no | One-click array optimisation; designer-to-tech sharing |
| MAPP 3D (Meyer Sound) | Free, Mac+Win, 65k-point anechoic dataset, GALAXY/Compass integration | no on platforms; no on integration | Mac users currently locked out of every other tool except Treble and MAPP 3D |

---

## Sources

- [EASE 5 Third Edition product page (AFMG)](https://www.afmg.eu/en/ease) — AURA ray-tracer, EARS auralisation pro-tier gating
- [EASE 5 v5.77 release / Acousteer real-time SPL (AFMG)](https://www.afmg.eu/en/real-time-revolution-how-ease-5s-acousteer-engine-pioneering-new-unified-era-acoustic-design) — backs the "real-time GPU SPL preview" gap
- [ISEAT 2025 Acousteer hybrid CPU/GPU article (AFMG)](https://www.afmg.eu/en/iseat-2025-how-ease-5s-hybrid-cpugpu-architecture-redefining-acoustic-simulation-workflows-instant) — backs same gap
- [audioXpress on EASE 5 Acousteer engine](https://audioxpress.com/article/acoustic-simulation-ease-5-s-acousteer-engine-redefines-design-workflows) — third-party validation
- [EASE Focus 3 free download page (AFMG)](https://www.afmg.eu/en/ease-focus-3-free-download) — backs free-PA-tool framing, GLL, Auto-Splay
- [EASE Focus 3 User Guide (Purdue mirror)](https://engineering.purdue.edu/ece40020/DesPrj/EASE_Focus_3_User_Guide.pdf) — backs 40-source cap, virtual EQ, Auto-Splay, plug-in PDF reports
- [Treble main product page](https://www.treble.tech/) — backs browser-native + auralisation + collab claim
- [Treble Acoustic Simulation Suite product page](https://www.treble.tech/acoustics-suite) — hybrid wave+GA, immersive auralisation
- [Treble Web Application page](https://www.treble.tech/treble-web-app) — Google-Docs sharing, unlimited concurrent simulations
- [Treble pricing page](https://www.treble.tech/pricing) — backs paid-SaaS positioning, single-user vs premium tiers
- [audioXpress on Treble cloud-based launch](https://audioxpress.com/news/treble-launches-cloud-based-virtual-acoustics-simulation-platform) — third-party validation of architectural-competitor framing
- [Capterra Treble reviews](https://www.capterra.com/p/10009212/Treble-Acoustic-Simulation-Suite/reviews/) — user complaint "needing to alter scattering responses to match real-life measurements" backs the scattering gap
- [Odeon 19 What's New page](https://odeon.dk/product/whats-new/) — per-surface frequency-dependent scattering, MP4 walkthrough export
- [Odeon Auralization article](https://odeon.dk/learn/articles/auralization/) — auralisation reference
- [audioXpress on Odeon 19 release](https://audioxpress.com/news/odeon-19-room-acoustics-software-adds-new-3d-render-interface-building-acoustics-module-and-much-more) — building-acoustics module + 3D render
- [CATT TUCT overview](https://www.catt.se/TUCT/TUCToverview.html) — edge diffraction, non-diffuse diagnostics
- [CATT-Acoustic v9.1 news PDF](https://www.catt.se/CATT-Acoustic_v9.1_news.pdf) — backs scattering + binaural convolution claims
- [ArrayCalc V12 product page (d&b)](https://www.dbaudio.com/global/en/products/software/arraycalc/) — Virtual Patch Plan, Mac+Win native
- [ProSoundWeb on ArrayCalc V12](https://www.prosoundweb.com/db-releases-new-arraycalc-version-12-system-simulation-software/) — third-party validation
- [FOH Online ArrayCalc V12 first-look ISE 2025](https://fohonline.com/blogs/new-gear/db-provides-first-look-at-arraycalc-version-12-at-ise-2025/) — Virtual Patch Plan + CCL support detail
- [Soundvision product page (L-Acoustics)](https://www.l-acoustics.com/products/soundvision/) — Autosolver / Autosplay / Autofilter
- [Soundvision Connect spotlight](https://www.l-acoustics.com/stories/product-spotlight-soundvision-connect-transforming-collaborative-sound-design/) — backs sharing-as-a-feature claim
- [L-Acoustics + AFMG Soundvision↔EASE 5 collaboration](https://www.l-acoustics.com/press-releases/l-acoustics-announces-collaboration-with-afmg-on-ease-5-integration-enhancing-soundvision-workflow/) — vendor-tool → EASE export pattern
- [MAPP 3D product page (Meyer Sound)](https://meyersound.com/product/mapp-3d/) — free Mac+Win, 65k anechoic measurement points
- [Meyer Sound MAPP 3D launch (ProSoundWeb)](https://www.prosoundweb.com/meyer-sound-unveils-new-mapp-3d-system-design-software/) — third-party validation
- [Common pitfalls in computer modelling of room acoustics (James Acoustics, peer-reviewed)](https://www.adrianjamesacoustics.com/papers/Common%20pitfalls%20in%20computer%20modelling%20of%20room%20acoustics.pdf) — backs the "scattering matters at high α" physics claim Dr. Chen leaned on
