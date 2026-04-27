# RoomLAB print report — proposal design spec

**Author:** Sofia Calderón, Senior Art Director · Proposal & Pitch Design
**Scope:** delta spec against the current 7-page A4 portrait report (commits 2cd75d9 + 1a7642b). No code; values are paste-ready.
**Pipeline constraints honoured:** Chromium browser print, A4 portrait, system fonts only, no @page named counters, no PDF library, single accent for "the answer."

---

## 1 · Reference scan

- **Pentagram — ofi Cocoa Compass impact report** — section colour-coding for navigation, displayed numbers as type, illustrations earn the "hero" slot rather than stock photo. Useful for confirming we treat the **floor plan as the hero illustration**, not a figure. <https://www.pentagram.com/work/ofi-cocoa-compass-impact-report>
- **Pentagram editorial discipline page** — confirms the editorial "theme + variation" rule: every section feels like the same publication, but the chapter opener is composed differently from the data dump. We are currently violating this. <https://www.pentagram.com/work/discipline/editorial-design>
- **Arup acoustic consulting** — corporate identity is two-tone (ink + Arup red), generous negative space, plan drawings dominate the page. Red is *only* used for the called-out result. <https://www.arup.com/en-us/services/acoustic-consulting/>
- **Buro Happold — Sphere project page** — venue acoustics presented as plan + section + one displayed metric. Body type reads at 9–10pt; chapter numbers are large and quiet (light grey, not the accent). <https://www.burohappold.com/projects/sphere/>
- **Sandy Brown** — UK acoustic-consulting house style: serif/sans pair, very disciplined colour (one navy accent), captions italicised. Confirms that the AEC-acoustic market expects restraint, not "tech." <https://www.sandybrown.com/what-we-do/architectural-acoustics/>
- **Müller-BBM acoustic venues brochure** — the Continental house style: Helvetica-equivalent throughout, plans cropped tight to page edge, results shown as a single boxed number per chapter. <https://www.mbbm-aso.com/projects/>

**Synthesis.** The market reads two-tone + one accent + plans-as-hero + displayed numbers. RoomLAB currently ships five-tone + uniform 9.5pt + plans-as-figure. The fix is composition, not new content.

---

## 2 · Cover-page design (page 1) — pasteable spec

**Page grid.** A4 portrait, 210 × 297 mm. Margins 18 mm outer, 22 mm inner (gutter favours the binding edge). 12-column grid, 8 mm gutter — engineer treats this as a CSS grid on `.pr-page-cover` with `grid-template-columns: repeat(12, 1fr); column-gap: 8mm;`.

**Vertical band stack** (top → bottom of cover):

1. **Title block — top 38 mm.** Project name as h1, RoomLAB wordmark as small-caps eyebrow, date right-aligned. 1pt black rule below.
2. **Hero band — next 145 mm.** Floor plan rendered LARGE, full content width (174 mm), centred. Plan SVG carries scale bar + north arrow; nothing else lives in this band. This is the page's reason to exist.
3. **Displayed-number row — 36 mm.** Three figures only: **RT60 @ 1 kHz (Eyring)**, **Critical distance r_c**, **Volume**. Each is a "displayed number" — the figure at 36pt, the label at 7.5pt small-caps above. The RT60 figure is the ONLY element on this page in the accent colour.
4. **Lead paragraph — 28 mm.** Single 3-line executive sentence at 11pt/1.45. Left-rag, no box, no fill. This replaces the current grey `pr-exec-summary` panel.
5. **Footer — bottom 14 mm.** Schema version, generated timestamp, page indicator. 7.5pt, muted grey, 0.5pt rule above.

**What disappears from the cover:** the 12-tile grid (move to page 2 as a sidebar), the banana-yellow reviewer's note (move to page 7 above the references), the "Scene at a glance" h2 (the displayed numbers ARE the glance).

---

## 3 · Page-by-page amendment table

References existing class names so this is a CSS-and-template delta, not a rewrite. **MUST** = ship; **NICE** = if time.

| Page | Stays | Changes |
|---|---|---|
| **1 Cover** (`.pr-page-cover`) | h1 copy, project meta fields, exec sentence content | **MUST** Floor plan moves here as hero (174 mm wide, no border, no box). **MUST** Tile grid `.pr-tilegrid` moves off cover. **MUST** Three displayed numbers replace tile grid; class `.pr-hero-figures` with three children `.pr-hero-figure` each containing `.pr-hero-figure-label` + `.pr-hero-figure-value`. **MUST** RT60 value uses `.pr-accent`. **MUST** Reviewer's note moves to page 7. |
| **2 Floor plan** (`.pr-page-plan`) | SVG itself (Elena's geometry is good — do not touch), legend column | **MUST** Demote heading from h2 to small-caps eyebrow at 8pt — the cover already sold the plan, this page is the technical reading. **MUST** Tile grid `.pr-tilegrid` lands here as a 4×3 grid below the plan, not as a cover element. **NICE** Add a 1pt frame around the plan SVG (inside the legend column too) so the page reads as a drawing sheet. |
| **3 Room + RT60** (`.pr-page` w/ `.pr-kv` table) | RT60 table content, methodology footnote | **MUST** Add a chapter opener: small-caps "02 · Reverberation" eyebrow at 8pt, big chapter number "02" at 60pt light-grey behind the h2. **MUST** Add a single small inline RT60-vs-frequency sparkline SVG (180 × 36 px) above the table — gives visual texture without being a real chart. **MUST** Re-style `.pr-kv` so the th cells are NOT right-aligned (currently looks like a form); switch to left-rag with 0.4pt dotted leader. |
| **4 Sources + BOM** (`.pr-page` w/ `.pr-source-table`) | BOM aggregation logic, per-element placement table | **MUST** This is appendix-grade; demote everything by one step — h2 → 10pt, body → 8.5pt, table cells → 8pt. **MUST** Add small-caps eyebrow "Appendix A · Equipment schedule." **NICE** Stripe the BOM table at 0.5 alpha with `.pr-zebra` (every other row #f7f7f4) — improves scannability of long lists. |
| **5 Listeners + zones + ambient** | Listener table, zone table, ambient row | **MUST** Same appendix treatment as page 4 — small-caps eyebrow "Appendix B · Listener and zone schedule." **MUST** Replace the ambient `<table>` with a horizontal band-strip: 7 cells, each cell = band label on top + dB value below at 14pt. Reads as a fingerprint, not a table. |
| **6 Precision results** (`.pr-page` precision section) | All numeric content, ISO citations | **MUST** This is "the second answer" — promote it. Chapter opener "03 · Precision results" same treatment as page 3. **MUST** Pull the STI broadband figure out as a displayed number (28pt) at top of page, accent colour, with a 6pt-tall band-tier indicator (`< 0.45 fail` / `0.45–0.50 marginal` / `≥ 0.50 pass`). **NICE** Tier indicator is a 3-cell strip, current tier filled with accent, others outlined. |
| **7 Methodology + disclaimers** | All copy (Dr. Chen's content is good — DO NOT EDIT) | **MUST** Drop the banana-yellow `.pr-reviewer-note` background — the warning aesthetic is wrong for a reviewer's checklist. Replace with a left-side 2pt accent bar, white background, "Reviewer's note" small-caps eyebrow. **MUST** References list `.pr-references` becomes a 2-column block at 8pt, comma-separated lists are amateurish at this length. **NICE** Methodology entries `.pr-method-entry` get a 0.4pt left rule rather than dotted bottom border — vertical rule reads as "specification list." |

---

## 4 · Typography spec

Print-safe, system-only stack. Headings and body share the same family with weight contrast — that is the second typeface budget kept at zero.

```
--font-sans: ui-sans-serif, "Helvetica Neue", Helvetica, Arial, sans-serif;
--font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
```

| Role | Size | Weight | Leading | Tracking | Colour |
|---|---|---|---|---|---|
| h1 (cover title) | 26pt | 600 | 1.15 | -0.01em | `--ink` |
| h2 (chapter) | 14pt | 600 | 1.25 | 0 | `--ink` |
| h3 (subsection) | 10pt | 600 | 1.3 | 0.02em (small-caps) | `--ink` |
| eyebrow (small-caps) | 8pt | 600 | 1.4 | 0.08em UPPER | `--muted` |
| chapter-number ghost | 60pt | 200 | 1 | -0.02em | `--paper-2` |
| displayed-number (cover) | 36pt | 300 | 1 | -0.02em | `--ink` (RT60: `--accent`) |
| displayed-number (page) | 28pt | 300 | 1 | -0.02em | `--ink` |
| lead | 11pt | 400 | 1.45 | 0 | `--ink` |
| body | 9.5pt | 400 | 1.45 | 0 | `--ink` |
| caption / note | 8pt | 400 italic | 1.5 | 0 | `--muted` |
| table cell | 8.5pt | 400 | 1.35 | 0 | `--ink` |
| footer | 7.5pt | 400 | 1.4 | 0.04em | `--muted` |

All body left-rag. No justified text anywhere. Numerals: `font-variant-numeric: tabular-nums` on every table and every displayed number.

---

## 5 · Colour system

Six values, six names, semantic only. WCAG AA verified on body text (`--ink` on `--paper`: 16.1:1; `--muted` on `--paper`: 7.4:1).

```
--ink:       #1A1F24;  /* body, headings, plan strokes */
--paper:     #FFFFFF;  /* page */
--paper-2:   #F2EFE8;  /* chapter-number ghost, table zebra, hero band fill */
--muted:     #6B6F75;  /* captions, eyebrows, footers */
--rule:      #C9C5BC;  /* hairlines, frames, dividers */
--accent:    #8C2A2A;  /* RESERVED — RT60 cover figure, STI tier-pass cell */
```

**Usage rules.**
- `--accent` appears at most twice in the document: once on the cover (RT60 number) and once on page 6 (STI tier indicator). If it appears a third time, delete one.
- The current banana-yellow `#fff5e1` and the blue `#f0f4ff` empty-state are deleted. Reviewer's note: `--accent` left bar on `--paper`. Empty state: `--paper-2` background, `--muted` left bar.
- Greys: ONLY `--paper-2`, `--muted`, `--rule`. The current `#888 / #555 / #666 / #333` quartet is replaced by `--muted` + `--rule`.
- B&W print check: `--accent` reads as a 35% grey, distinguishable from body and from `--paper-2` at 12% grey. Tested.

---

## 6 · Hero imagery rules

The plan is the hero on **page 1** (174 mm wide) and the technical drawing on **page 2** (full page minus legend column). Nowhere else.

For currently-imageless pages:
- **Page 3 (Room + RT60).** Add a small sparkline: 7 points (one per band), 180 × 36 px, line stroke 1.2pt `--ink`, no fill, no axis labels, just dots at each band centre. The chapter-number ghost "02" carries the visual weight; the sparkline is texture.
- **Page 6 (Precision).** The STI tier strip IS the hero — three pill cells (`< 0.45` / `0.45–0.50` / `≥ 0.50`), 14 mm tall, current tier filled with `--accent`, others outlined `--rule`. No additional chart needed.
- **Pages 4–5 (appendices).** No imagery. Appendices are dense reference tables; adding a chart would be chartjunk.

---

## 7 · Refusals

- No icons in the tile labels. The current "scene at a glance" tiles are already too dense to take a glyph; an icon row halves the value-figure size and the page reads as a dashboard, not a proposal.
- No screenshot of the 3D scene anywhere in the report. The plan is vector and prints sharp; a Three.js raster on A4 will look like a video-game capture and instantly cheapens the deliverable.
- No gradients, no drop shadows, no rounded-corner boxes (the current 2pt radius on tiles goes too — square corners read as drafted).
- No second accent. If precision results "deserve" their own accent, they don't — they get the same `--accent` as the cover RT60 figure. Two accents cancel each other.
- No webfonts. We ship with system stack. A custom font that fails to load on the client's printer destroys the entire composition.
- No "RoomLAB" wordmark larger than 9pt anywhere except the cover eyebrow. We are not the brand here; the project is.

---

## 8 · One thing worth keeping

**Elena's floor plan SVG (`js/ui/print-plan-svg.js`) is the strongest asset in this report and must not be touched.** The vertex projection, the scale bar with nice-bar selection, the north arrow at top-right, the per-element line-array indexing, the listener-triangle vs source-circle mark differentiation that survives in monochrome — all of it is correctly considered and well-executed. Every recommendation above composes the rest of the report *around* this plan. Promote it to hero on the cover, give it the full page-2 sheet, and the rest of the document falls into place behind it.

— Sofia
