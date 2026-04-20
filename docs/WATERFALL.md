# Directivity Waterfall — render algorithm

File: `js/ui/speaker-detail.js` → `drawWaterfall(canvas, def, onAxis)`.

3D surface of SPL as a function of **horizontal angle and frequency simultaneously**. After two iterations the axes settled on:

- **X**: frequency, log-spaced, 125 Hz → 20 kHz
- **depth**: azimuth angle, linear, +110° at front, 0° in the middle, −110° at back
- **Z**: SPL (dB)

With angle in the depth axis, the on-axis (0°) response sits exactly on the middle slice — so a warm-red ridge runs along the middle depth, tapering to cool blue at ±110° off-axis. Wide ridge = wide-pattern cabinet, narrow ridge concentrated at 0° = directive cabinet.

An earlier draft of this chart plotted Cumulative Spectral Decay (SPL vs freq vs time). That showed time-domain ringing and was swapped out after the user requested the angle-vs-frequency view.

## Input data

Three inputs per speaker:

1. `onAxis` — array of `{ hz, db }` pairs, up to 27 log-spaced points from 40 Hz to 20 kHz. The **on-axis frequency response**: deviation in dB from the sensitivity value at 1 kHz. Comes from `acoustic.fr_fine_db` in the loudspeaker JSON (falls back to per-octave `on_axis_response_db`).
2. `def.directivity` — the full 7-band × 13-azimuth × 7-elevation attenuation grid. Off-axis attenuation at `(angle, hz)` is read via `interpolateAttenuation(dir, angle, 0, hz)` — bilinear over the grid, with elevation fixed at 0° (horizontal plane).
3. `sens` — sensitivity in dB @ 1 W / 1 m.

Per-band directivity missing from the JSON is back-filled by `loudspeaker.js` using class-based multipliers (standard / horn / line-element) so that every loaded speaker has realistic freq-dependent patterns even if only 1 kHz data was authored.

## Physics model

For any `(hz, angle_deg)`:

```
fr(hz)      = log-space linear interp of onAxis[i].db
att(a, hz)  = bilinear over dir.attenuation_db[hz][el][az], el=0
spl(hz, a)  = max(floorDb,  sens + fr(hz) + att(a, hz))
```

Both interpolations **clamp at the endpoints** so sub-125 Hz and super-8 kHz regions stay finite.

## Layout — tilted-down 3D view

- Canvas: 760 × 420 px
- Padding: left 60, right 36, top 24, bottom 48
- 23 angle slices (one per 10° step). Slice `s=0` is the FRONT slice (= `+110°`), `s=11` is the middle slice (= `0°`, on-axis, the peak of the mesh), `s=22` is the BACK slice (= `−110°`). Angle axis is linear via `angleAt(s) = 110 − s × 10`.
- Oblique projection: each successive slice shifts `skewX = +2.6 px` right and `skewY = −7.0 px` **up** (`skewY < 0` puts the viewer above the mesh). Earlier draft used `skewX = 0.7, skewY = −5.5` which read as almost 2D — dialled up for a proper 3D tilt.
- `bkX = skewX × (nSlices − 1) = +57 px`, `bkY = skewY × (nSlices − 1) = −154 px`.
- Plot dimensions leave room for the depth offsets:
  ```
  plotW = canvasW − padL − padR − bkX
  plotH = canvasH − padT − padB − |bkY|
  ```

### Axes

- **X**: `log2(hz)` → `[padL, padL + plotW]`, 125 Hz → 20 kHz.
- **Y**: dB SPL → `[frontBase, frontBase − plotH]`. Range is `sens + 5` (top) to `sens − 45` (bottom).
- `frontBase = padT + plotH − bkY` — because `bkY < 0`, this is the largest Y in the plot (= the front baseline, at the bottom of the canvas).
- **Depth axis** (angle) is implicit in the skew. Labels go at `(rightX + s·skewX, frontBase + s·skewY)` for `s = sOfAngle(tick)`.

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

### 2. Filled surface (jet colormap, back-to-front quads)

Between every pair of adjacent slices `(s, s+1)` and every pair of adjacent frequency samples `(i, i+1)` we draw **one small quadrilateral** coloured by the average amplitude of its four corners. Drawn back-to-front so the near face correctly occludes the rear.

```
for s = nSlices − 2 … 0:
    front = slicePaths[s]
    back  = slicePaths[s + 1]
    for i = 0 … nF − 1:
        a = front[i],   b = front[i + 1]
        c = back[i + 1], d = back[i]
        avgDb = mean(a.db, b.db, c.db, d.db)
        t = (avgDb − floorDb) / (peakDb − floorDb)
        fillStyle = jetColor(clamp(t, 0, 1))
        fillPath(a → b → c → d → a)
```

Quad count = `(nSlices − 1) × nF = 25 × 180 = 4500`. Drawn once per render, no animation overhead.

After the surface is filled, a thin black under-stroke and a white-accent stroke on the front slice trace the FR contour so it reads clearly against the rainbow fill.

### 3. Jet colormap

Classic MATLAB 'jet':

```
t = 0.00 → (  0,   0, 128)   dark blue
t = 0.14 → (  0,   0, 255)   blue
t = 0.28 → (  0, 128, 255)   azure
t = 0.42 → (  0, 255, 255)   cyan
t = 0.57 → (128, 255, 128)   green
t = 0.71 → (255, 255,   0)   yellow
t = 0.85 → (255, 128,   0)   orange
t = 1.00 → (200,   0,   0)   dark red
```

Piecewise-linear interpolation between adjacent stops. Same convention as REW, ARTA, Klippel, LspCAD. The reference image in this file (the "attached great waterfall example") uses the same colormap.

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
