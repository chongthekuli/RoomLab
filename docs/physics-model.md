# Physics Model

## Phase 2 (current): RT60

Sabine's formula:

    T60 = 0.161 * V / A

where `V` is room volume (m³) and `A` is total absorption (m² Sabins),
summed per frequency band over all surfaces.

Eyring's formula (for highly absorbent rooms):

    T60 = 0.161 * V / (-S * ln(1 - a_avg))

where `S` is total surface area and `a_avg` is area-weighted mean absorption.

## Phase 3+ (deferred)

- Image-source method for early reflections
- Stochastic ray tracing for late field
- Direct SPL with loudspeaker directivity
- Coverage heatmaps on audience plane
