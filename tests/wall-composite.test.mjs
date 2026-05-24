// Phase 5 Step 5 regression — wall-composite.js (v=616, 2026-05-23).
//
// ISO 12354-3:2017 Eq. 17 area-weighted τ-bar composite wall TL.
// Dr. Chen's three named canaries from her Phase 5 spec land here as
// drop-in fixtures plus a handful of structural / defensive checks.

import assert from 'node:assert';
import { compositeTL } from '../js/physics/wall-composite.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}
const within = (a, b, tol) => Math.abs(a - b) <= tol;

// =============================================================================
// 1. Single-element wall → unchanged (identity case)
// =============================================================================

{
  const bands = [60, 60, 60];   // flat 60 dB concrete
  const out = compositeTL({ elements: [{ tl_bands: bands, area_m2: 10 }] });
  check('100% single-material wall returns its own TL unchanged',
    out !== null && out.every((v, i) => within(v, bands[i], 0.0001)),
    `got [${out?.map(v => v.toFixed(2)).join(', ')}]`);
}

// =============================================================================
// 2. Dr. Chen canary: 50/50 split between 60 dB and 25 dB → 28 dB ±1
// =============================================================================
//
// Hand verification:
//   τ_concrete = 10^-6;          τ_door = 10^-2.5 = 3.162e-3
//   τ_avg = 0.5·10^-6 + 0.5·3.162e-3 = 1.581e-3
//   R = -10·log10(1.581e-3) = 28.01 dB.

{
  const out = compositeTL({
    elements: [
      { tl_bands: [60], area_m2: 5 },        // 50% concrete @ 60 dB
      { tl_bands: [25], area_m2: 5 },        // 50% door @ 25 dB
    ],
  });
  check('50/50 split: 60 dB + 25 dB → ~28 dB (Beranek §11.5 canary)',
    out !== null && within(out[0], 28.01, 1),
    `got ${out?.[0].toFixed(2)} dB`);
}

// =============================================================================
// 3. Dr. Chen canary: 1% door in 99% concrete → ~45 dB ("leaky door dominates")
// =============================================================================
//
// Hand verification:
//   τ_concrete = 10^-6;  τ_door = 10^-2.5
//   τ_avg = (0.99 · 10^-6 + 0.01 · 10^-2.5) / 1.0
//         = 9.9e-7 + 3.162e-5
//         = 3.262e-5
//   R = -10·log10(3.262e-5) = 44.87 dB ≈ 45.

{
  const out = compositeTL({
    elements: [
      { tl_bands: [60], area_m2: 99 },       // 99% concrete @ 60 dB
      { tl_bands: [25], area_m2: 1 },        // 1% door @ 25 dB
    ],
  });
  check('1% door in 60 dB wall → ~45 dB (leaky-door-dominates canary)',
    out !== null && within(out[0], 44.87, 0.5),
    `got ${out?.[0].toFixed(2)} dB`);
}

// =============================================================================
// 4. Per-band propagation (frequency-dependent input)
// =============================================================================
//
// Compute composite across multiple bands; verify each band is computed
// independently from its own τ_i.

{
  const concrete = [40, 45, 50, 55, 60, 60, 60];      // rises with f
  const door     = [22, 25, 28, 30, 32, 35, 36];
  const out = compositeTL({
    elements: [
      { tl_bands: concrete, area_m2: 9 },             // 90%
      { tl_bands: door,     area_m2: 1 },             // 10%
    ],
  });
  check('per-band composite returns 7 values for 7-band input',
    out !== null && out.length === 7);
  // At 125 Hz (R_door = 22): τ_avg = (0.9·10^-4 + 0.1·10^-2.2)/1
  //                        = 9e-5 + 6.31e-4 = 7.21e-4 → R = 31.4 dB
  check('per-band: low-f composite ~31 dB (door dominates at LF)',
    out !== null && within(out[0], 31.4, 0.5), `got ${out?.[0].toFixed(2)}`);
  // At 8 kHz (R_door = 36): τ_avg = (0.9·10^-6 + 0.1·10^-3.6)/1
  //                       = 9e-7 + 2.51e-5 = 2.6e-5 → R = 45.85 dB
  check('per-band: HF composite ~45.8 dB (door dominates less)',
    out !== null && within(out[6], 45.85, 0.5), `got ${out?.[6].toFixed(2)}`);
}

// =============================================================================
// 5. Composite always ≤ min(individual R) — physical invariant
// =============================================================================
//
// Mixing in any weaker element can only WORSEN the wall's TL. The
// composite must never exceed the strongest element's TL either —
// upper-bound = max(individual R) ONLY when areas of weaker elements → 0.

{
  const stronger = [50];
  const weaker = [30];
  const out = compositeTL({
    elements: [
      { tl_bands: stronger, area_m2: 5 },
      { tl_bands: weaker, area_m2: 5 },
    ],
  });
  check('composite ≤ stronger element (cannot exceed best individual TL)',
    out !== null && out[0] < 50, `got ${out?.[0].toFixed(2)}`);
  check('composite ≥ weaker element (cannot underperform worst individual TL)',
    out !== null && out[0] > 30, `got ${out?.[0].toFixed(2)}`);
}

// =============================================================================
// 6. Three-element composite (door + window + concrete) — multi-slot
// =============================================================================
//
// Real building scenario: 80% concrete @ 55, 15% window @ 32, 5% door @ 28.
//   τ_avg = 0.80·10^-5.5 + 0.15·10^-3.2 + 0.05·10^-2.8
//         = 2.53e-6 + 9.49e-5 + 7.92e-5
//         = 1.766e-4
//   R = -10·log10(1.766e-4) = 37.53 dB

{
  const out = compositeTL({
    elements: [
      { tl_bands: [55], area_m2: 80 },     // concrete
      { tl_bands: [32], area_m2: 15 },     // window
      { tl_bands: [28], area_m2: 5 },      // door
    ],
  });
  check('three-element (concrete + window + door) composite ~37.5 dB',
    out !== null && within(out[0], 37.53, 0.5),
    `got ${out?.[0].toFixed(2)}`);
}

// =============================================================================
// 7. Defensive guards
// =============================================================================

check('no elements returns null', compositeTL({ elements: [] }) === null);
check('null elements returns null', compositeTL({}) === null);
check('non-array elements returns null', compositeTL({ elements: 'bad' }) === null);
check('zero area returns null',
  compositeTL({ elements: [{ tl_bands: [40], area_m2: 0 }] }) === null);
check('negative area returns null',
  compositeTL({ elements: [{ tl_bands: [40], area_m2: -5 }] }) === null);
check('non-finite area returns null',
  compositeTL({ elements: [{ tl_bands: [40], area_m2: NaN }] }) === null);
check('NaN in tl_bands returns null',
  compositeTL({ elements: [{ tl_bands: [40, NaN, 50], area_m2: 5 }] }) === null);
check('length mismatch between elements returns null',
  compositeTL({ elements: [
    { tl_bands: [40, 45, 50], area_m2: 5 },
    { tl_bands: [20, 25],     area_m2: 5 },
  ] }) === null);
check('missing tl_bands returns null',
  compositeTL({ elements: [{ area_m2: 5 }] }) === null);
check('empty tl_bands returns null',
  compositeTL({ elements: [{ tl_bands: [], area_m2: 5 }] }) === null);

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
