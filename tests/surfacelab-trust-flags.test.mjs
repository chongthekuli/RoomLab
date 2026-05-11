// SurfaceLAB trust-flag validator regression tests.
//
// The validator runs over every catalogue entry on load and flags
// the common manufacturer-datasheet lies Dr. Chen identified. Each
// rule is tested with a positive case (should flag) and a negative
// case (should not flag) so regressions surface immediately.

import { runTrustFlagAudit } from '../js/labs/surfacelab/trust-flags.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`PASS  ${msg}`); passed++; }
  else      { console.log(`FAIL  ${msg}`); failed++; }
}

function hasFlag(flags, id) {
  return flags.some(f => f.id === id);
}

// ---- Rule 1: high alpha on thin Type-A panel --------------------------
{
  const entry = {
    id: 'fake-thin-panel',
    absorption: [0.98, 0.95, 0.9, 0.8, 0.7, 0.6, 0.5],
    geometry: { depth_mm: 50 },
    mounting: 'ASTM_C423_TypeA',
  };
  const flags = runTrustFlagAudit(entry);
  assert(hasFlag(flags, 'high_alpha_thin_panel'),
    'thin Type-A panel with α(125 Hz) = 0.98 should flag high_alpha_thin_panel');
}
{
  const entry = {
    id: 'real-thick-panel',
    absorption: [0.95, 0.95, 0.9, 0.8, 0.7, 0.6, 0.5],
    geometry: { depth_mm: 152 },
    mounting: 'ASTM_C423_TypeA',
  };
  const flags = runTrustFlagAudit(entry);
  assert(!hasFlag(flags, 'high_alpha_thin_panel'),
    'thick panel (152mm) with α(125 Hz) = 0.95 should NOT flag high_alpha_thin_panel');
}

// ---- Rule 2: alpha > 1.0 ----------------------------------------------
{
  const entry = {
    id: 'edge-effect',
    absorption: [0.3, 0.7, 1.15, 1.10, 1.05, 1.00, 0.95],
    geometry: { depth_mm: 50 },
    mounting: 'ASTM_C423_TypeA',
  };
  const flags = runTrustFlagAudit(entry);
  assert(hasFlag(flags, 'alpha_exceeds_unity'),
    'α peak 1.15 should flag alpha_exceeds_unity');
}
{
  const entry = {
    id: 'no-edge-effect',
    absorption: [0.3, 0.7, 0.95, 0.90, 0.85, 0.80, 0.75],
    geometry: { depth_mm: 50 },
    mounting: 'ASTM_C423_TypeA',
  };
  const flags = runTrustFlagAudit(entry);
  assert(!hasFlag(flags, 'alpha_exceeds_unity'),
    'α peak 0.95 should NOT flag alpha_exceeds_unity');
}

// ---- Rule 3: QRD claiming f_lower below physical limit ----------------
{
  // d_max=100mm → physical floor c/(2·0.1) = 1715 Hz.
  // Claiming 200 Hz is impossible (>½ octave below physical limit).
  const entry = {
    id: 'fake-qrd',
    kind: 'diffuser_qrd_1d',
    geometry: { max_well_depth_mm: 100 },
    operating_range_hz: [200, 5000],
  };
  const flags = runTrustFlagAudit(entry);
  assert(hasFlag(flags, 'qrd_below_physical_limit'),
    'QRD with d_max=100mm claiming f_lower=200 Hz should flag qrd_below_physical_limit');
}
{
  // d_max=175mm → physical floor c/(2·0.175) = 980 Hz.
  // Claiming 490 Hz is below, but a deeper d_max would mean true.
  // Actually for this test, d_max=350mm → floor 490 Hz, claim 490 Hz fine.
  const entry = {
    id: 'real-qrd',
    kind: 'diffuser_qrd_1d',
    geometry: { max_well_depth_mm: 350 },
    operating_range_hz: [490, 1400],
  };
  const flags = runTrustFlagAudit(entry);
  assert(!hasFlag(flags, 'qrd_below_physical_limit'),
    'QRD with d_max=350mm claiming f_lower=490 Hz should NOT flag (claim ≈ physical limit)');
}

// ---- Rule 4: NRC on tuned trap ----------------------------------------
{
  const entry = {
    id: 'fake-membrane-with-nrc',
    kind: 'trap_membrane',
    nrc: 0.85,
    trap: { type: 'membrane', f0_hz: 75 },
  };
  const flags = runTrustFlagAudit(entry);
  assert(hasFlag(flags, 'nrc_on_tuned_trap'),
    'membrane trap with NRC=0.85 should flag nrc_on_tuned_trap');
}
{
  const entry = {
    id: 'real-membrane',
    kind: 'trap_membrane',
    nrc: null,
    trap: { type: 'membrane', f0_hz: 75 },
  };
  const flags = runTrustFlagAudit(entry);
  assert(!hasFlag(flags, 'nrc_on_tuned_trap'),
    'membrane trap without NRC should NOT flag nrc_on_tuned_trap');
}

// ---- Rule 5: thin diffusion data --------------------------------------
{
  const entry = {
    id: 'fake-skinny-diffuser-data',
    category: 'diffuser',
    diffusion_d: [null, null, null, 0.8, null, null, null],   // 1 octave only
  };
  const flags = runTrustFlagAudit(entry);
  assert(hasFlag(flags, 'diffusion_data_thin'),
    'diffuser with 1 octave of d(f) data should flag diffusion_data_thin');
}
{
  const entry = {
    id: 'real-diffuser',
    category: 'diffuser',
    diffusion_d: [null, null, 0.55, 0.80, 0.75, 0.60, 0.40],  // 5 octaves
  };
  const flags = runTrustFlagAudit(entry);
  assert(!hasFlag(flags, 'diffusion_data_thin'),
    'diffuser with 5 octaves of d(f) data should NOT flag diffusion_data_thin');
}

// ---- Rule 6: missing mounting -----------------------------------------
{
  const entry = {
    id: 'no-mounting',
    category: 'absorber',
    absorption: [0.4, 0.8, 1.0, 1.0, 0.9, 0.8, 0.7],
    geometry: { depth_mm: 50 },
    mounting: null,
  };
  const flags = runTrustFlagAudit(entry);
  assert(hasFlag(flags, 'mounting_unclear'),
    'absorber with null mounting should flag mounting_unclear');
}
{
  const entry = {
    id: 'plain-finish-no-mounting',
    category: 'finish',
    absorption: [0.02, 0.03, 0.04, 0.05, 0.05, 0.05, 0.05],
  };
  const flags = runTrustFlagAudit(entry);
  assert(!hasFlag(flags, 'mounting_unclear'),
    'plain finish without mounting should NOT flag mounting_unclear (rule skips finishes)');
}

// ---- Rule 7: untested / self-reported ---------------------------------
{
  const entry = {
    id: 'self-reported',
    category: 'diffuser',
    test_standard: 'manufacturer self-report',
  };
  const flags = runTrustFlagAudit(entry);
  assert(hasFlag(flags, 'self_reported'),
    'product with manufacturer self-report should flag self_reported');
}
{
  const entry = {
    id: 'tested',
    category: 'diffuser',
    test_standard: 'ISO 17497-2',
  };
  const flags = runTrustFlagAudit(entry);
  assert(!hasFlag(flags, 'self_reported') && !hasFlag(flags, 'untested_legacy'),
    'product with ISO 17497-2 test should NOT flag self_reported or untested_legacy');
}

// ---- Defensive: malformed entry shouldn't throw -----------------------
{
  const flags = runTrustFlagAudit({});
  assert(Array.isArray(flags), 'empty entry should return an array, not throw');
}
{
  const flags = runTrustFlagAudit({ id: 'partial', absorption: null });
  assert(Array.isArray(flags), 'partial entry should return an array, not throw');
}

if (failed === 0) console.log('\nAll SurfaceLAB trust-flag tests passed.');
else { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
