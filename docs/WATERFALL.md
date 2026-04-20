# Waterfall (Cumulative Spectral Decay) — render algorithm

File: `js/ui/speaker-detail.js` → `drawWaterfall(canvas, def, onAxis)`.

## Input data

Three inputs per speaker:

1. `onAxis` — array of `{ hz, db }` pairs, 27 log-spaced points from 40 Hz to 20 kHz. This is the **on-axis frequency response**: deviation in dB from the sensitivity value at 1 kHz. Comes from `acoustic.fr_fine_db` in the loudspeaker JSON (falls back to per-octave `on_axis_response_db`).
2. `csd` — array of `{ hz, decay_ms }`, seven points at the STIPA octave-band centres (125, 250, 500, 1k, 2k, 4k, 8k). `decay_ms` is the **time for the on-axis magnitude at that frequency to decay by 20 dB** after the stimulus ends. Derived from `acoustic.csd_ms` in the JSON.
3. `sens` — sensitivity in dB @ 1 W / 1 m from `acoustic.sensitivity_db_1w_1m`.

## Physics model

For any `(hz, tms)`:

```
fr(hz)       = log-space linear interp of onAxis[i].db across onAxis[]
decay_ms(hz) = log-space linear interp of csd[i].decay_ms across csd[]

level(hz, tms) = max(floorDb,  sens + fr(hz) − (20 / decay_ms(hz)) × tms)
```

Both interpolations **clamp at the endpoints**: frequencies below the lowest table entry receive the lowest entry's value, frequencies above the highest receive the highest. Earlier drafts re-used a single `tBlend` from the FR lookup for the CSD lookup — that was the source of the sub-125 Hz and super-8 kHz stripes in the first waterfall screenshot.

## Layout

- Canvas: 720 × 340 px
- Padding: left 54, right 20, top 18, bottom 34
- 24 time slices from `tms = 0` (front) to `tms = tMaxMs` (back). `tMaxMs = 6` — matches the REW / LspCAD default for speakers.
- Isometric skew: each successive slice shifts `skewX = 1.3 px` right and `skewY = 4.4 px` down. Total back-slice offset ≈ 30 px right, 101 px down.
- Plot area width/height are reduced by the skew so the rear slice still fits inside the canvas:

```
plotW = canvasW − padL − padR − skewX × (nSlices − 1)
plotH = canvasH − padT − padB − skewY × (nSlices − 1)
```

### Axes

- X: `log2(hz)` mapped linearly to `[padL, padL + plotW]`, 50 Hz → 20 kHz.
- Y: dB SPL mapped linearly to `[padT + plotH, padT]`. Range is `sens + 3` at top to `sens − 25` at bottom (28 dB vertical).
- Time axis is implicit in the skew — labels are drawn at `xOfHz(fMax) + s × skewX + 4, padT + plotH + s × skewY + 3` for `tms = 0, 1, 2, 3, 4, 5, 6`.

## Rendering

Three stages, in order:

### 1. Grid (isometric box, drawn first so slices sit on top)

Eight anchor points define the box:

```
                back_top_L (padL + bkX, padT + bkY) ─── back_top_R
                    │                                    │
front_top_L (padL, padT) ──────────────── front_top_R (padL + plotW, padT)
    │                                    │                                │
front_bottom_L (padL, padT + plotH) ── front_bottom_R
                    │                                    │
                back_bottom_L ────────── back_bottom_R (rightX + bkX, bottomY + bkY)
```

Where `bkX = (nSlices − 1) × skewX`, `bkY = (nSlices − 1) × skewY`.

Grid lines drawn, in order:

- **Back wall**: vertical freq ticks (`63, 125, 250, 500, 1k, 2k, 5k, 10k`), horizontal dB ticks (`sens, sens−10, sens−20`). Colour: `rgba(255, 255, 255, 0.05)`.
- **Floor**: one diagonal line per freq tick, front-bottom → back-bottom (gives the "depth" illusion).
- **Side walls**: four depth edges (top-left, bottom-left, top-right, bottom-right) connecting front to back corners. Colour: `rgba(255, 255, 255, 0.10)`.
- **Back frame**: `strokeRect(padL + bkX, padT + bkY, plotW, plotH)` — the back panel outline.
- **Front plane**: dB grid + `strokeRect(padL, padT, plotW, plotH)`.

Earlier draft drew "vertical" lines from `(xOfHz(tick), padT)` to `(xOfHz(tick) + bkX, bottomY + bkY)` — that's a diagonal from top-front to bottom-back, not a proper isometric edge. Replaced with the eight-corner model above.

### 2. Slices (strokes only, two passes)

```
// Pass 1 — back-to-front, dark under-stroke (lineWidth 2.6, black @ 0.92).
for (s = nSlices − 1 … 0):
    stroke the slice's polyline

// Pass 2 — back-to-front, coloured stroke on top.
for (s = nSlices − 1 … 0):
    colour = waterfallColor(timeFrac = 1 − s / (nSlices − 1))
    lineWidth = (s == 0 ? 1.8 : 1.0)
    stroke the slice's polyline
```

Each slice's polyline is 181 vertices (180 sample intervals) computed once up-front and stored in `slicePaths[s]`.

### 3. Labels

- **dB** labels: left-edge, at `padL − 48, yOfDb(db)`. Values: `peakDb, sens, sens − 10, sens − 20`.
- **Frequency** labels: at `xOfHz(tick) + bkX, H − 10` — aligned under the **back-bottom** edge so they don't clash with slice traces that project past the front baseline.
- **Time** labels + ticks: along the right-depth edge from `(rightX, bottomY)` (t=0) to `(rightX + bkX, bottomY + bkY)` (t=tMaxMs). Each integer millisecond gets a short outward tick + numeric label. "ms" unit sits past the last tick.

Colour ramp (`waterfallColor(t)`, `t ∈ [0, 1]`, where 1 = initial / hot and 0 = late / cold):

```
stops = [(60, 40, 120),     // t = 0.00 — violet (late)
         (70, 90, 180),     // t = 0.25 — blue
         (80, 200, 200),    // t = 0.50 — cyan
         (230, 220, 70),    // t = 0.75 — yellow
         (255, 230, 150)]   // t = 1.00 — warm (early)
```

The front slice (`s = 0`) gets the warmest colour and a slightly thicker stroke. Strokes are drawn back-to-front so that the front trace visually sits on top of the rear traces where they overlap in screen space.

## Why the earlier filled version failed

When each slice was drawn as a filled polygon from its curve down to the plot baseline `padT + plotH + s × skewY`:

1. Front slice (`s = 0`) fills from the **full FR curve** down to `padT + plotH`.
2. Rear slices (`s > 0`) have decayed curves that sit **below** the FR.
3. Back-to-front draw order: rear filled first, then front drawn on top.
4. The front slice's fill covers the entire region below the FR → every rear slice's filled area was inside the front's fill → rear slices were invisible except where isometric skew pushed them past the front's right / bottom edge.

Symptom (reported): only the front curve was visible; the bottom right of the plot showed thin horizontal bands corresponding to rear slices peeking out below the front's shape.

Strokes-only avoids this because there is no filled mask occluding the rear traces.

## Alternatives considered

- **Mesh-fill with per-slice clipping** — clip each slice's fill to the region above the next-newer slice's trace. Works but adds a second pass and the clipping region is non-convex.
- **Per-slice "ribbon" fills between adjacent slices** — fill the thin strip bounded by slice `s` above and slice `s − 1` below. Good look but requires polygon intersection at the edges of the frequency range.
- **3D mesh via WebGL** — true perspective, correct occlusion. Ultimately the "right" answer but overkill for a 2D spec display.

## Known simplifications / caveats

- The decay model is a **single exponential per frequency band**. Real cabinets have resonances that ring on longer than a single time-constant predicts. Modelling that properly would need the impulse response (not just a decay-time table).
- The `csd_ms` table is authored by hand for the three stock cabinets and synthesised from the `max_spl_db` for imported files without explicit data. The synthesis rule is documented in `csdPerBand()` in `speaker-expert.js`.
- Frequency resolution is **log-linear interpolation** between FR points. It's not a cubic spline — a sharp inflection in the FR table (e.g. the 400 Hz baffle-step dip) will appear as a single kink, not a smooth dip. That matches how the underlying data was authored.
- `tMaxMs = 6` was chosen because by then HF bands (decay ≈ 3 ms) have decayed 40 dB — past the floor — and further time gives no additional information. The REW default is 5 ms; LspCAD ranges 3–10 ms depending on whether the user zooms LF or HF.
