# Virtual Loudspeaker Schema (open JSON — GLL replacement)

See [../data/loudspeakers/generic-12inch.json](../data/loudspeakers/generic-12inch.json)
for a working example.

## Top-level fields

| Field | Type | Description |
|---|---|---|
| `schema_version` | string | Currently `"1.0"` |
| `id` | string | Unique identifier |
| `manufacturer`, `model` | string | Human-readable |
| `license` | string | SPDX identifier recommended |
| `physical` | object | Weight + enclosure dimensions |
| `electrical` | object | Impedance, power handling, max SPL |
| `acoustic` | object | Sensitivity, frequency range, bands |
| `placement` | object | Default position + aim (overridable) |
| `directivity` | object | 2D attenuation grids per frequency |

## Directivity grid

`attenuation_db[frequency]` is a 2D array indexed `[elevation_index][azimuth_index]`,
values in **dB relative to on-axis** (so 0 = on-axis, −6 = half-power edge).

Absolute SPL at a listener position:

    SPL = sensitivity + 10*log10(W) - 20*log10(r) + attenuation(θ, φ, f)

Interpolation between grid points is bilinear (to be implemented in
`js/physics/loudspeaker.js`).
