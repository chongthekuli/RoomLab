# RoomLab — Full Calculations Reference

**Version pinned to:** commit `HEAD` of `main` (keep in sync when physics changes).
**Purpose:** a single, auditable document that any acoustic engineer or AI reviewer can read cold and identify whether the math is correct, what assumptions hold, and where the simplifications lie. Every formula below is accompanied by a source-code anchor so you can verify the implementation matches the description.

> If you are an AI reviewer: your job is to **challenge this document**. Pick a section. Ask: is the formula right? Is the unit consistent? What edge case breaks it? Is there a newer standard we should be tracking? Is any comparison against measured real-world values plausible? Our goal is convergence on a defensible acoustic-simulation engine, not a proof that we're already right.

---

## 0. Scope

RoomLab is a **browser-based statistical-and-geometric-acoustic simulator** in the class of EASE, ODEON, CATT-Acoustic — but simpler, faster, and runnable from a single HTML page. It answers:

1. **RT60 per octave band** (Sabine + Eyring) for a user-defined room geometry and material palette.
2. **Direct-field SPL** at arbitrary listener positions from a set of loudspeakers with published directivity data.
3. **Statistical reverberant SPL** (Hopkins-Stryker diffuse field) combined with direct to produce a full SPL number and a 2D heatmap on audience surfaces.
4. **STIPA** (IEC 60268-16) speech-intelligibility index per listener and as a heatmap.
5. **Master graphic EQ** applied pre-speaker, with a live frequency-response probe at any audience point.

The engine is **not** a ray-tracer or image-source predictor. Early reflections and time-domain impulse responses are out of scope for the current version.

---

## 1. Conventions

### 1.1 Coordinate system

- **State (physics) coordinates:** `(x, y, z)` = `(right, depth-into-room, height-up)`.
- **Three.js (render) coordinates:** `(x, y, z)` = `(right, height-up, depth-into-room)` — state `y` maps to Three.js `z`, state `z` to Three.js `y`.
- The physics layer does **not** touch Three.js coords. All conversion happens in `js/graphics/*.js` when building meshes. This invariant is enforced by keeping `import * as THREE` out of `js/physics/`.

### 1.2 Units

All SI throughout the physics layer.

| Quantity | Unit |
|---|---|
| Distance | m |
| Volume | m³ |
| Area | m² |
| Absorption | m² Sabins (dimensionless α × area) |
| Frequency | Hz |
| Power | W |
| SPL / L_w | dB (re 20 μPa for SPL, re 1 pW for L_w) |
| Temperature | °C (internally converted to K when used) |
| Angles | degrees in JSON / UI; radians in trigonometric code |

No imperial conversions exist anywhere. A future metric/imperial toggle is a UI-layer concern only.

### 1.3 Frequency bands

Six octave bands used by the core physics (materials):

```
125, 250, 500, 1000, 2000, 4000, 8000  Hz    (7 bands; 8 kHz added for STIPA)
```

The **loudspeaker sensitivity** is currently a flat scalar (single number per speaker), not per-band (known limitation — see §11).

The **Master EQ** operates on 10 bands extending to 31.5 Hz and 16 kHz (§8), with log-frequency interpolation.

### 1.4 Reference standards

| Topic | Standard / Source |
|---|---|
| Sabine RT60 | Sabine 1922; ISO 3382-1:2009 |
| Eyring RT60 | Eyring 1930 |
| Air absorption | ISO 9613-1:1993 Annex A Table 1 (reference 20 °C / 50 % RH / 101.325 kPa) |
| Hopkins-Stryker | Hopkins & Stryker 1948; Kuttruff §4 |
| Audience absorption α | ISO 3382-1 (folding seats) / Beranek *Concert Halls and Opera Houses* 2nd ed. (upholstered seats) |
| STIPA | IEC 60268-16:2011 Annex C (test signal); Bradley 1986 / ISO 9921 (D/R-aware MTF prediction form) |
| Sound power from sensitivity | `L_w = L_p(1m, 1W) + 11 − DI` (directivity-index correction; Beranek ch. 5) |
| Speed of sound | `c = 331.3 · √(1 + T/273.15)` (dry air approximation) |

---

## 2. Geometry

### 2.1 Room shapes supported

Rectangular, polygonal (N-sided), round, custom 2D polygon. Optional ceiling types: flat, dome (spherical cap). File: [js/physics/room-shape.js](../js/physics/room-shape.js).

### 2.2 Base area

```
rectangular:   A_base = width · depth
polygon (N):   A_base = (N/2) · r² · sin(2π/N)       where r = polygon_radius_m
round:         A_base = π · r²
custom:        A_base = shoelace(custom_vertices)
```

### 2.3 Wall perimeter

```
rectangular:   P = 2 · (width + depth)
polygon (N):   P = N · 2r · sin(π/N)
round:         P = 2π · r
custom:        P = Σ |v_{i+1} − v_i|
```

### 2.4 Ceiling

Flat: ceiling area = base area.

Spherical-cap dome with rise `d`:

```
a = √(A_base / π)         — equivalent-circle radius
A_cap = π · (a² + d²)     — lateral surface of spherical cap
V_dome = (π · d / 6) · (3a² + d²)
```

**Known simplification:** `a = √(A_base / π)` treats a polygon base as its equivalent-area circle. Error is <1 % for 36-sided (arena preset) and ~10 % for low-side (octagon). Flagged in Chen audit H1.

**Defensive check (reviewer challenge, commit `HEAD`):** the formula assumes radial symmetry. For a highly elongated base (e.g. rectangular 10 × 100 m shoebox with a "dome" ceiling), the spherical-cap formulas produce physically meaningless volume/area. `domeVolume()` and `ceilingArea()` now log a one-time `console.warn` when the base bounding-box aspect ratio exceeds **2:1**, asking the user to switch to `ceiling_type: 'flat'` for reliable RT60. We warn rather than throw so a preset with a slightly elongated shape can still render for rough sanity-checking. File: [room-shape.js:checkDomeAspect](../js/physics/room-shape.js).

### 2.5 Room volume

```
V_gross = A_base · height + V_dome
V_air   = V_gross − V_stadium_solid
```

Where `V_stadium_solid` is subtracted only for presets that carry a `stadiumStructure` descriptor (bowl concrete + upper-bowl rake + scoreboard cube occupy real volume). See [room-shape.js:74](../js/physics/room-shape.js). Arena preset: `V_stadium_solid ≈ 4,227 m³`, which is ~9 % of gross — exactly the correction Chen audit item H7 flagged.

### 2.6 Surface enumeration with zones

Every user-defined audience zone gets its 2D polygon footprint subtracted from the base floor (regardless of elevation — §2.6.1 below) and added to the surface list as its own patch with its own material:

```
roomEffectiveSurfaces(room, zones):
    surfaces = [floor, ceiling, walls..., dome]      # from roomSurfaces(room)
    for z in zones:
        a = shoelace(z.vertices)
        floor.area_m2 -= a           # always carve, regardless of z.elevation_m
        surfaces.push({ id: 'zone_'+z.id, area_m2: a,
                        materialId: z.material_id,
                        occupancy_percent: z.occupancy_percent ?? 0 })
    # Center-hung scoreboard as one additional surface (LED + steel)
    if room.stadiumStructure.scoreboard:
        surfaces.push({ id: 'scoreboard',
                        area_m2: 4·w·h + 2·w²,       # 4 sides + top/bot
                        materialId: 'led-glass' })
```

File: [room-shape.js:185](../js/physics/room-shape.js#L185).

#### 2.6.1 Why always carve the floor

A sound wave travelling **down** from the ceiling only hits the topmost surface in a given column. If a bowl tier sits at elev = 3 m, the floor beneath it is in shadow acoustically — counting both would double-count absorption in that column. The previous version gated carve-out by `|elev| < 0.1 m` which worked for ground-level zones but silently triple-counted the arena's 900+ m² of bowl seating. Chen audit item C2. Fixed in commit `230e99a`.

### 2.7 Inside-room tests

- `isInsideRoom(x, y, room)` — 2D point-in-polygon (shoelace for polygon, distance test for round).
- `isInsideRoom3D(pos, room)` — 2D test + `0 ≤ z ≤ maxCeilingHeightAt(x,y)`.

Used for the wall-transmission-loss path check (§5.3) and for the walkthrough character bounds.

---

## 3. Materials

### 3.1 File

[data/materials.json](../data/materials.json) — schema v1.3. Shape:

```json
{
  "frequency_bands_hz": [125, 250, 500, 1000, 2000, 4000, 8000],
  "materials": [
    {
      "id": "...", "name": "...",
      "absorption": [α₁, α₂, α₃, α₄, α₅, α₆, α₇],
      "scattering": [s₁, s₂, s₃, s₄, s₅, s₆, s₇]
    },
    …
  ]
}
```

**`absorption` (α)** — surface absorption coefficient per octave band (ISO 3382-1 / Beranek). Drives RT60 + Hopkins-Stryker R today.

**`scattering` (s)** — fraction of incident energy scattered non-specularly per ISO 17497-1. **Draft engine ignores scattering** (Sabine assumes diffuse field a priori — no per-reflection specular-vs-diffuse decision). The precision ray tracer (Phase B+) uses `s(f)` at each ray bounce to pick Lambertian vs specular reflection per the dual-engine blueprint §4. Values sourced from Cox & D'Antonio *Acoustic Absorbers and Diffusers* 2nd ed. — reasonable defaults, users can override per-zone when precision mode ships.

### 3.2 Audience-occupancy blend

For any zone, the effective absorption coefficient at band `k` is:

```
occ = clamp(zone.occupancy_percent / 100, 0, 1)
α_eff(k) = α_mat(k) · (1 − occ) + α_audience(k) · occ
```

Where `α_audience` is pulled from the `'audience-seated'` material (Beranek occupied-upholstered-seat values). When `occ = 0`, the formula degrades to `α_mat` exactly, which is the **regression-tested backwards-compat guarantee** for presets authored before occupancy existed.

File: [rt60.js:17](../js/physics/rt60.js#L17).

**Known approximation (Chen M2):** Real empty-upholstered seats are α ≈ 0.5 at mid-band, but we use `α_mat = carpet-heavy` (α = 0.37 @ 1 kHz) or `α_mat = upholstered-seat-empty` (α = 0.61 @ 1 kHz). This means the blend exaggerates the empty→full swing slightly. Mitigated in the L1 material-palette refactor by using Beranek seat values throughout the arena preset.

---

## 4. RT60

### 4.1 Sabine (with volumetric air absorption)

```
T60_Sabine(k) = 0.161 · V / (A_surfaces(k) + 4·m(k)·V)
```

Where:
- `0.161` is the Sabine constant in metric units (20 °C air). Dimensional analysis: `m · s / (m)` = s.
- `V = V_air` from §2.5.
- `A_surfaces(k) = Σ_surfaces (area × α_eff(k))` in m² Sabins.
- `m(k)` is the **energy attenuation coefficient** in Nepers/m, obtained from the ISO 9613-1 dB/m table (§5.3) via `m = α_dB/m / (10 · log10 e) = α_dB/m / 4.343`. See [air-absorption.js](../js/physics/air-absorption.js).
- `4·m·V` is the **volumetric air sink** — air itself dissipates acoustic energy; the factor 4 comes from the mean-free-path derivation (Kuttruff §5.3).

**Why this matters (reviewer challenge, addressed commit `HEAD`):** in small rooms `4mV` is a fraction of a percent of `A_surfaces` and can be safely ignored. In a 48,000 m³ arena at 8 kHz, `4mV ≈ 4,100 Sabins` vs surface absorption of ~3,000 Sabins — so omitting it made our predicted 8 kHz RT60 double-counted reverb energy and came in ~2.4× too long. Arena 8 kHz RT60 now reports 1.00 s (was 2.40 s with the omission).

Air absorption can be disabled per-calculation with `airAbsorption: false` (used by tests that verify classical textbook α=0.1 results). The RT60 and `computeRoomConstant` both honour the same flag so a reviewer can compare pre/post-fix numbers cleanly.

### 4.2 Eyring (with volumetric air absorption)

```
α̅_surface(k) = A_surfaces(k) / S_total
T60_Eyring(k) = 0.161 · V / (−S_total · ln(1 − α̅_surface(k)) + 4·m(k)·V)
```

Kuttruff §5.3: the Eyring form keeps the logarithm on **surface** absorption only (the logarithm comes from the geometric reflection-count decay which doesn't apply to air), then adds the air term linearly as in Sabine. Used when `α̅_surface > ~0.2` (transition point where Sabine overestimates; noted in UI as "Eyring more accurate in dead rooms").

### 4.3 Mean absorption (for UI display)

The Results panel headline is the average of **500 Hz + 1 kHz** Sabine RT60:

```
T60_mid = (T60(500) + T60(1000)) / 2
α_bar_mid = (α_bar(500) + α_bar(1000)) / 2
```

**Previously wrong** (commit `8e5f6db`): the meta line showed `α_bar` from `bands[0]` (125 Hz) while the headline used 500 + 1k. Because gypsum has α = 0.29 at 125 Hz and 0.04 at 1 kHz, the numbers on-screen appeared to contradict the Sabine formula. Fixed — α_bar shown always matches the band driving the headline.

### 4.4 File anchor

[rt60.js:16](../js/physics/rt60.js#L16).

---

## 5. Sound Propagation — Direct Field

### 5.1 Inverse-square + sensitivity

For a single source at distance `r` from a listener, on-axis direct SPL at 1 W is:

```
L_p(r, 1W) = sens + 10 · log10(P/1W) − 20 · log10(r) + attn(θ, φ, f)
```

- `sens` — speaker sensitivity in dB SPL at 1 m, 1 W (flat-across-bands; see §11 L_w-per-band note).
- `P` — input power in W.
- `r` — slant distance in m, clamped to `r ≥ 0.1 m` (near-field floor to avoid `log(0)`).
- `attn(θ, φ, f)` — directivity attenuation in dB from the speaker's measured polar grid, interpolated bilinearly in `(θ, φ)` and lookup-only in `f` (see §5.2).

### 5.2 Directivity

Every speaker has a `directivity.attenuation_db[freqKey]` table: a 2D grid of `(azimuth_deg × elevation_deg)` entries in dB (0 = on-axis, negative off-axis). `freqKey` is a string like `"1000"`.

**Interpolation** — bilinear in (az, el):

```
localAngles(speakerPos, aim, listenerPos) → (r, az, el)
tAz = (az − azs[i0]) / (azs[i1] − azs[i0])
tEl = (el − els[j0]) / (els[j1] − els[j0])
attn = bilinear interpolation over the 4 corners at {i0, i1} × {j0, j1}
```

Out-of-range az/el clamp to edge. Missing frequency key returns 0 dB (omnidirectional fallback).

File: [loudspeaker.js:16](../js/physics/loudspeaker.js#L16).

**Known limitation:** The default line-array JSON only defines `"1000"`. At other band frequencies the speaker is treated as omnidirectional. Users shipping custom JSONs should provide a full `125, 250, 500, 1k, 2k, 4k, 8k` grid for accurate modelling. This is flagged in the `line-array-element.json` header comment and is not a physics bug — the physics does what the data tells it.

### 5.3 Air absorption (ISO 9613-1)

Per-band α in dB/m at 20 °C / 50 % RH:

```
125 → 0.00038    1000 → 0.00487    8000 → 0.10200
250 → 0.00108    2000 → 0.01154
500 → 0.00244    4000 → 0.03751
```

Arbitrary frequency: log-linear interpolation between the two enclosing bands. Clamp to edges outside [125, 8000]. File: [spl-calculator.js:32](../js/physics/spl-calculator.js#L32).

Direct SPL subtracts `air_α(f) · r` when `airAbsorption` is enabled. Sanity: at 4 kHz over 30 m the loss is 1.13 dB — matches the ISO 9613-1 reference value (regression-tested).

**Known simplification (P2):** Only the reference T/RH values are wired in. A future real-weather pass would plug in the ISO 9613-1 relaxation model. Impact: ±0.5 dB at 4 kHz over 30 m for typical indoor ranges 15–25 °C.

### 5.4 Wall transmission loss

If a source is outside the room and a listener inside (or vice versa), 30 dB is subtracted from the direct SPL:

```
through_wall = (isInsideRoom3D(src.pos) ≠ isInsideRoom3D(listener.pos))
if through_wall:   L_p −= 30 dB
```

**Known simplification (P1 + P5):**
- Flat 30 dB regardless of frequency (real walls show +6 dB/octave above their resonance).
- Only detected when the straight line from source to listener crosses a single boundary.

### 5.5 Master EQ gain

If enabled (§8), an additional per-band gain is added:

```
L_p_direct = L_p + eqGainAt(eq, f)
```

Where `eqGainAt` is log-frequency linear-dB interpolation between the 10 band centres. When bypassed, `eqGainAt` returns 0 and direct SPL is unchanged — bypass is acoustically a no-op. Verified by test `'EQ returns 0 when bypassed'`.

File: [spl-calculator.js:147](../js/physics/spl-calculator.js#L147).

### 5.6 Multi-source summation — incoherent (default)

At a given frequency, sum pressures² across all sources:

```
L_p_total = 10 · log10(Σ_i 10^(L_p_i / 10))
```

Valid for broadband speech/music where phase between sources decorrelates over any reasonable listening window. Regression-tested: two co-located identical sources at the same distance should sum to **+3 dB** — measured +3.01 dB.

### 5.7 Multi-source summation — coherent (opt-in)

When `coherent = true`, sum complex pressure amplitudes with phase from path-length difference:

```
A_i = 10^(L_p_i / 20)
phase_i = 2π · f · r_i / c(T)
Re = Σ A_i · cos(phase_i)
Im = Σ A_i · sin(phase_i)
L_p_total = 10 · log10(Re² + Im²)
```

Speed of sound: `c(T) = 331.3 · √(1 + T/273.15)`. Default T = 20 °C → c = 343.2 m/s.

Regression-tested: two co-located in-phase sources sum to **+6 dB** — measured +6.02 dB.

**Known simplification (Chen M1):** No 1/4-wavelength spatial-decorrelation limit. Above ~500 Hz coherent summation between spatially-separated sources produces physically unrealistic interference fringes. Real line-array designers use incoherent sum above 500 Hz (see Viktor / Mac audit, line-array physics feedback memory).

---

## 6. Reverberant Field (Hopkins-Stryker)

### 6.1 Room constant (with volumetric air absorption)

Classical form:

```
α̅(f) = A_surfaces(f) / S_total
R(f) = S_total · α̅ / (1 − α̅)
```

**Extended form used in the code** (Kuttruff §5.3 with air absorption):

```
A_total(f) = A_surfaces(f) + 4·m(f)·V      (m from §4.1 / air-absorption.js)
α̅_eff(f)  = A_total(f) / S_total
R(f)      = A_total(f) / (1 − α̅_eff(f))
```

Dimensions of R: m². Interpretation: "equivalent open-window absorption area, accounting for both wall surface absorption and volumetric air dissipation."

Without the `4mV` term, `R` at 8 kHz in the arena came out ~3× too small (the air sink dominates surface absorption by 40 %), which put the Hopkins-Stryker reverberant level ~4–5 dB too loud at HF in big venues. Fixed commit `HEAD`.

**Edge case:** if `α̅_eff ≥ 0.995`, we return `R = 1e9` to avoid division blow-up.

`computeRoomConstant(..., { airAbsorption: true })` is the default; pass `false` to get the classical form for comparison. The RT60 module reports `totalAbsorption_sabins` which already includes `4mV` when air is enabled, so Hopkins-Stryker R reuses that number directly rather than recomputing.

File: [spl-calculator.js:60](../js/physics/spl-calculator.js#L60).

### 6.2 Sound power per source

For a directional speaker with directivity index `DI`:

```
L_w = sens + 10 · log10(P) + 11 − DI        (Beranek ch. 5)
```

- `+11` converts on-axis 1-m SPL to total radiated power for an omni source (`10 · log10(4π · 1²)` approximately).
- `−DI` corrects because sensitivity is **on-axis** and therefore overstates total radiated power by DI dB (a directional speaker concentrates energy into the beam; the power averaged over the sphere is less than the on-axis value implies).

**Prior bug (fixed commit `b795477`):** `−DI` was missing. Reverb was overstated by the DI value (typically 8–12 dB), which **masked per-source power changes in reverb-dominated rooms** — turn off a speaker and the total SPL dropped by < 1 dB everywhere because reverb was fake-dominating at +10 dB over reality. Captured in `feedback_sound_power_needs_DI.md`.

With EQ enabled, `L_w` gets the same per-band gain as the direct term (§5.5) because a pre-speaker EQ literally raises the radiated power at that band:

```
L_w(f) = sens + 10 · log10(P) + 11 − DI + eqGainAt(eq, f)
```

### 6.3 Reverberant SPL at any listener

The statistical diffuse field is spatially uniform. Per source:

```
L_rev_i(f) = L_w_i(f) + 10 · log10(4 / R(f))
```

Total reverb pressure² summed across sources:

```
P²_rev = Σ_i 10^(L_rev_i / 10)
```

Combined with direct:

```
L_p_total = 10 · log10(P²_direct + P²_rev)
```

File: [spl-calculator.js:231](../js/physics/spl-calculator.js#L231).

**Known conceptual quirk (Chen H2):** the comment says "per source" but algebraically this is equivalent to `L_rev_total = L_w_total + 10·log10(4/R)` because log-of-sum equals sum-of-powers. The implementation is correct; the framing in comments was misleading and has been updated.

---

## 7. Line Array

### 7.1 Compound source descriptor

A line-array source in `state.sources` looks like:

```js
{
  kind: 'line-array',
  id: 'LA1',
  modelUrl: 'data/loudspeakers/line-array-element.json',
  origin: { x, y, z },        // TOP-BACK corner of element 0
  baseYaw_deg, topTilt_deg,   // flown aim
  splayAnglesDeg: [a1, a2, …], // degrees between adjacent elements
  elementSpacing_m,           // cabinet height
  power_watts_each,
}
```

`expandSources()` unpacks this into N physical elements, each treated as its own point source by the physics.

### 7.2 Back-pivot rigging (Elena + Viktor audit)

Real line-array hardware rigs at the **top-back** corner of each cabinet, not the geometric center. Splay angles rotate about this pivot so adjacent cabinets share their back edge and only fan out at the fronts. This invariant is regression-tested: `"Back-pivot: adjacent cabinets share their back edge (no overlap)"`.

```
// For element i:
pitch[i] = topTilt − Σ_{k=0..i-1} splayAngles[k]
rigPoint[0] = origin
rigPoint[i+1] = rigPoint[i] + (h · cabinet_down_vector)
elementCenter[i] = rigPoint[i] + (h/2 · down) + (d/2 · aim)
```

Where `down` and `aim` are the local cabinet axes rotated by the current `(baseYaw, pitch[i])`.

**Each element gets the full rated power** (not divided across the array). This matches real signal routing — every element is driven by its own amplifier channel at the same signal level.

File: [app-state.js:256](../js/app-state.js#L256). Feedback memory: `feedback_line_array_physics.md`, `feedback_line_array_rigging_pivot.md`.

### 7.3 Multi-element summation

Every call to physics (SPL, STIPA) runs through `expandSources()` first, so the physics layer never sees the compound descriptor — it sees a flat list of N elements. Incoherent sum by default (§5.6); coherent only if opted in.

---

## 8. Master EQ

### 8.1 State

```js
state.physics.eq = {
  enabled: false,
  bands: [
    { freq_hz: 31.5,  gain_db: 0 },
    { freq_hz: 63,    gain_db: 0 },
    …                                    // 10 bands, 31.5 → 16 kHz
    { freq_hz: 16000, gain_db: 0 },
  ],
}
```

Range: ±12 dB per band. ISO preferred centres.

### 8.2 Gain interpolation

```
eqGainAt(eq, f):
  if not eq.enabled: return 0
  if f ≤ bands[0].freq_hz:   return bands[0].gain_db
  if f ≥ bands[-1].freq_hz:  return bands[-1].gain_db
  find i such that bands[i].freq_hz ≤ f ≤ bands[i+1].freq_hz
  t = ln(f / bands[i].freq_hz) / ln(bands[i+1].freq_hz / bands[i].freq_hz)
  return bands[i].gain_db + t · (bands[i+1].gain_db − bands[i].gain_db)
```

**Log-frequency linear-dB** interpolation. File: [app-state.js:404](../js/app-state.js#L404). Regression-tested for band-edge, between-band, out-of-range, and bypass semantics.

### 8.3 Application

Applied at the SPL calculation layer (§5.5 + §6.2). Same gain is applied to both direct and reverb terms because a pre-speaker EQ raises the radiated power at that band. Bypass returns 0 gain — zero cost on physics, and the Probe tool suppresses its FR chart.

### 8.4 Frequency-response probe

When EQ is enabled, hovering the 3D viewport with Probe on renders a 48-point log-spaced SPL curve from 20 Hz to 20 kHz at the probed position. Room constant R is pre-computed at the 7 physics bands once per mousemove and log-interpolated for the 48 sample frequencies (avoids walking the surface list 48 ×). File: [scene.js:drawFrequencyResponse](../js/graphics/scene.js).

---

## 9. STIPA

### 9.1 Standard

IEC 60268-16:2011 Annex C (simplified STIPA variant of full STI). Seven octave bands × 2 modulation frequencies per band. Scalar STI ∈ [0, 1] with a 5-tier rating (bad / poor / fair / good / excellent).

### 9.2 Bands + modulation frequencies

```
BANDS      = [ 125, 250, 500, 1000, 2000, 4000, 8000 ] Hz
MOD_FREQS  = { 125:  [1.60,  8.00],   1000: [2.00, 10.00],
               250:  [1.00,  5.00],   2000: [1.25,  6.25],
               500:  [0.63,  3.15],   4000: [0.80,  4.00],
                                      8000: [2.50, 12.50] } Hz
```

### 9.3 Male weighting (α, β)

```
α_male = [0.085, 0.127, 0.230, 0.233, 0.309, 0.224, 0.173]   # 7 entries, Σ = 1.381
β_male = [0.085, 0.078, 0.065, 0.011, 0.047, 0.095]          # 6 entries
```

`β` has **one fewer** entry than `α` — it weights pairs of adjacent bands in the redundancy-correction term. This is a common source of confusion and was flagged in a prior implementation pass (`feedback_stipa_impl.md`).

### 9.4 MTF — direct-to-reverb aware (Bradley 1986 / ISO 9921)

**This is the form currently implemented** after the D/R-aware fix (commit `53e497d`):

```
D  = Σ_i direct_pressure²_i                      at listener
R  = Σ_i reverb_pressure²_i                      at listener (0 if reverb disabled)
N  = ambient noise pressure² (NC-35 per band by default)
m_rev(k, f_m) = 1 / √(1 + (2π · f_m · RT60(k) / 13.8)²)

MTF(k, f_m) = (D + R · m_rev) / (D + R + N)
```

The direct field is impulse-like (modulation preserved, MTF ≈ 1 on its contribution); only the reverb component is smeared by `m_rev`. The simplified IEC form `m_rev · (D+R)/(D+R+N)` — which was previously implemented — collapses to spatially uniform STI in any loud-PA room, because D+R ≫ N saturates the noise term to 1 and the remaining factor depends only on band-level quantities. User-visible symptom: `STI = 0.43 everywhere` in the arena.

The D/R-aware form is what EASE, CATT-Acoustic, and ODEON use. Captured in `feedback_stipa_dr_aware.md`.

### 9.5 Apparent SNR + TI per band

```
m̄(k)      = mean of MTF over the 2 modulation frequencies
m_safe    = clamp(m̄, 0.0001, 0.9999)
SNR_app_raw(k) = 10 · log10(m_safe / (1 − m_safe))
SNR_app(k)     = clamp(SNR_app_raw, −15, +15)   dB
TI(k)     = (SNR_app + 15) / 30
```

The ±15 dB clamp is the IEC apparent-SNR range.

### 9.6 STI composition

```
STI_raw = Σ_k α_male(k) · TI(k) − Σ_k β_male(k) · √(TI(k) · TI(k+1))
STI     = clamp(STI_raw, 0, 1)
rating  = { STI < 0.30: bad, < 0.45: poor, < 0.60: fair, < 0.75: good, else: excellent }
```

### 9.7 Ambient noise

Default: **NC-35** per-band spectrum — a "quiet venue with HVAC running" reference.

```
NC_35_PER_BAND = [55, 50, 45, 40, 36, 34, 33]   dB (125 → 8k Hz)
```

The earlier flat `40 dB` assumption overstated SNR at low frequencies and understated at high. Captured in `feedback_stipa_impl.md`.

### 9.8 Source power in STIPA

Per-source `L_w` is currently flat-across-bands:

```
L_w_i = sens_i + 10 · log10(P_i) + 11 − DI_i     (same at every band)
```

**Known approximation (Chen M3 + M15):** Real speaker sensitivity drops 6–12 dB at 125 Hz and varies at 4–8 kHz. Impact: STI error on the order of ±0.05. Mitigation path: add `sensitivity_db_per_band` to the loudspeaker JSON schema; fall back to scalar when absent.

### 9.9 Files

- [js/physics/stipa.js](../js/physics/stipa.js) — full algorithm.
- [tests/stipa.test.mjs](../tests/stipa.test.mjs) — regression tests including the spatial-variation test that catches any reversion to the pre-D/R MTF form.

---

## 10. Heatmap Sampling

### 10.1 Zone grid (non-stadium presets)

For each audience zone, a 2D adaptive grid (cell target ≈ 0.5 m, clamped to 24–80 cells across) is sampled by `computeZoneSPLGrid`. Each cell computes full multi-source SPL with the current physics options (direct + optional reverb + optional coherent + EQ gain at current frequency).

### 10.2 Unified stadium heatmap (arena preset)

For bowl presets, 13 continuous **per-sector ring geometries** replace per-tier patches. Each sector is a `(radialCells+1) × (arcCells+1)` vertex grid at a fixed ear elevation above the stepped rake. `sampleSurfaceColors` computes SPL at each vertex and writes to the vertex-color attribute for smooth Gouraud interpolation.

This avoids the "stripe artifact" problem of per-tier CanvasTextures that was an earlier design mistake (`feedback_heatmap_unified_surface.md`).

### 10.3 STIPA heatmap

Same surface grids; the shader maps STI [0, 1] through a 5-tier color palette (red → orange → yellow → green → teal) rather than the 60–110 dB SPL gradient.

Performance: ~10,000 vertices × full STIPA per vertex would be too slow; the `precomputeSTIPAContext(...)` + `computeSTIPAAt(ctx, listenerPos)` split computes per-band RT60 and per-source `L_w` **once per frame**, then just iterates bands per vertex.

### 10.4 Isobars

2D marching-squares contour lines are extracted from the vertex SPL (or TI) grid at 5 dB increments for SPL, 0.1 increments for STI. Implemented in the scene module (not a physics concern).

---

## 11. Known Simplifications (live list)

From the Chen and cross-cutting audits, in order of decreasing impact:

| ID | Description | Impact | Mitigation path |
|---|---|---|---|
| P1 | Flat 30 dB wall transmission loss | ±6 dB vs realistic | Per-band wall TL curve |
| P2 | ISO 9613-1 reference T/RH only | ±0.5 dB at 4k / 30 m | Wire T/RH controls into air-abs |
| P3 | Bilinear directivity interp | Small unless grid is sparse | Spherical-harmonic directivity |
| P4 | No image-source early reflections | Low-to-medium in large spaces | Optional ISM pass for first 2 reflections |
| P5 | Single wall-crossing TL | Rarely triggers | Multi-segment path check |
| P6 | Flat-across-bands sensitivity / L_w | ±0.05 STI | Per-band sensitivity in loudspeaker JSON |
| P7 | Coherent sum has no 1/4-λ decorrelation limit | Wrong above 500 Hz if enabled | Auto-disable coherent > 500 Hz |
| P8 | Dome area uses equivalent-circle radius for polygon | <1 % @ 36-sided, ~10 % @ octagon; aspect > 2 logs a one-time warning (reviewer `HEAD`) | Accept, or disable dome for elongated bases in the UI |
| P9 | Audience blend is material-swap (not seat-type aware) | Small; dominates only at occ ≥ 50 % | `audience-seating-empty` material + between-material blend |
| P10 | Bowl risers / retaining walls not enumerated in Sabine budget | Small (concrete α ≈ 0.02) | Extract lathe-mesh area by material tag |

All of these are intentional starting points, not bugs. The top of this list is where an AI reviewer should focus challenges.

---

## 12. Validation Notes

| Scenario | Our result | Real-world reference | Delta |
|---|---|---|---|
| Arena preset, 30 % occupancy, mid-band RT60 | 1.89 s (with 4mV) | Staples Center ~2.0 s, Pepsi Center ~1.9 s | Within range |
| Arena 30 %, 8 kHz RT60 | 1.00 s (with 4mV) | Real occupied arenas 0.8–1.2 s at 8 kHz | Within range |
| Arena 30 %, 8 kHz RT60 — OMITTING 4mV | 2.40 s (pre-fix) | Real target 0.8–1.2 s | **2.4× too long** — physically wrong, reviewer challenge fixed commit `HEAD` |
| 10×10×4 m concrete shoebox w/ 36 m² absorber zone, 1 kHz RT60 | 1.63 s (w/ zone) vs 8.94 s (w/o zone) | Hand Sabine calc matches | Exact |
| 2 co-located sources, incoherent sum | +3.01 dB | +3.00 dB exact | Good |
| 2 co-located sources, coherent in-phase | +6.02 dB | +6.00 dB exact | Good |
| Arena walkthrough, under line-array cluster, STI | 0.88 (excellent) | EASE prediction of similar config 0.80–0.90 | Plausible |
| Arena diagonal upper-back corner, STI | 0.58 (fair) | EASE prediction 0.55–0.65 | Plausible |
| 4 kHz air absorption over 30 m direct-field | 1.13 dB | ISO 9613-1 table | Exact |
| Air-absorption coefficient m @ 4 kHz | 0.00864 Np/m | α_dB/m / 4.343 | Exact |
| Air-absorption coefficient m @ 8 kHz | 0.02349 Np/m | α_dB/m / 4.343 | Exact |
| 4mV sabins for V=1000 m³ @ 8 kHz | 93.95 Sabins | `4 · 0.02349 · 1000` | Exact |
| 48k m³ room α=0.1 surfaces, 8 kHz RT60 drop from 4mV | 84 % | Kuttruff worked example | Consistent |
| Critical distance for DI=10 box in R=2590 m² | r_c ≈ 14 m | Hand Sabine-R calc | Exact |

---

## 13. File Map

```
js/physics/
  room-shape.js        §2 geometry; roomSurfaces, roomEffectiveSurfaces, domeVolume, stadiumSolidVolume
  rt60.js              §4 Sabine/Eyring; computeRT60Band, computeAllBands, audience blend
  spl-calculator.js    §5 direct; §6 reverb; air absorption, wall TL, multi-source sum
  stipa.js             §9 IEC 60268-16; precomputeSTIPAContext + computeSTIPAAt + computeSTIPA
  loudspeaker.js       §5.2 directivity interpolation
  materials.js         materials.json loader

js/app-state.js         §7.2 expandSources / expandLineArrayToElements; §8.1-2 eqGainAt; state shape

data/
  materials.json       §3 7-band α per material
  loudspeakers/*.json  §5.2 sensitivity + directivity grid

tests/
  rt60.test.mjs        Sabine regression; volume + surface correctness
  spl.test.mjs         Direct inverse-square; air absorption; 30 dB TL; zone blend; EQ; coherent ±6 dB / incoherent +3 dB
  stipa.test.mjs       Band tables; D/R spatial-variation regression; weighting array lengths
  room-shape.test.mjs  Inside/outside; carve-out; volume
  preset.test.mjs      Preset shape invariance; field plumbing
```

---

## 14. Open Issues / Audit Backlog

Tracked as deferred items across several audits. The most impactful unresolved:

1. **Scene teardown (Weiss C2)** — no `unmount3DViewport` yet; blocks the Google Sites embed roadmap.
2. **Per-band sensitivity (Chen M3)** — flat scalar is a real physics gap.
3. **Vomitory / concourse IBC code compliance (Morales C1, C2, C3)** — arena preset would fail plan review.
4. **Bowl capacity expansion (Rivera H5 / Morales C3)** — 6-row bowl is middle-school-sized for a 50k m³ volume.
5. **PMREM + RoomEnvironment dispose (Weiss C1)** — latent leak, one-time.
6. **Post-processing retry (Viktor #1)** — SSAOPass broke color pipeline in r0.160; GTAOPass migration path is open.

---

## 14.1 Dual-Engine Transition (Phase A landed `HEAD`)

The full architectural blueprint is at [DUAL-ENGINE-BLUEPRINT.md](./DUAL-ENGINE-BLUEPRINT.md). Phase A foundation shipped:

- **`buildPhysicsScene(...)`** — [js/physics/scene-snapshot.js](../js/physics/scene-snapshot.js) produces an immutable, worker-transferable snapshot of every physics input. Not yet wired into existing call sites; that's Phase A2.
- **`materials.json` schema v1.3** — adds `scattering` per band for every material. Draft engine unchanged; precision engine (Phase B+) uses it.
- **`state.results.precision` + `state.results.engines`** — scaffold for the dual-engine UI. Populated only when Precision Render runs.

When Phase A2 (the refactor of RT60/SPL/STIPA to consume `PhysicsScene`) and Phase B (ISM + ray tracer in a worker pool with `three-mesh-bvh`) land, the physics sections above will get per-section Draft/Precision split tables. Until then, everything in §4–§10 describes the Draft engine only.

---

## 15. Audit Protocol — how to challenge this document

If you are an AI reviewer, do this:

1. **Pick a formula** from §4–§9.
2. **Open the referenced file and line.** Verify the code matches the formula verbatim. If it doesn't, the bug is in the document or the code; flag which.
3. **Pick an input** — a specific room, speaker set, or listener position that could stress a boundary. Work the math by hand. Report the expected result.
4. **Run the Node tests** (`node tests/spl.test.mjs` etc.) to see what the engine produces on the existing fixtures. If your expected result differs by more than the test's tolerance, that's a finding.
5. **Pick a known simplification from §11** and quantify its worst-case impact on your scenario. We already know P1–P10 exist; we want to know if any of them matters **for the specific use case under review**.
6. **Flag anything you'd ship differently.** Be specific — "replace X with Y because of Z" beats "this seems wrong."

Severity grading used throughout the codebase:

- **CRITICAL** — numerically wrong, user-visible, physics defect.
- **HIGH** — silent-fail or large (> 3 dB / > 50 % RT60) error.
- **MEDIUM** — correctness issue under edge cases.
- **LOW** — polish, rounding, naming.

Leave findings as markdown sections in review comments or as PRs against this document. The document is the source of truth; the code is the implementation we verify against it.
