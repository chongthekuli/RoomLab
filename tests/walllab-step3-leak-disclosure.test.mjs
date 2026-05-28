// Phase 6 Step 3 — perimeter-leak disclosure card (v=629).
//
// Dr. Chen sign-off 2026-05-23: real-world walls always have some leakage
// (door perimeters, electrical penetrations, junction cracks). A 1 mm crack
// has TL ≈ 0 dB and acts as a parallel transmission path that bypasses the
// wall. A 50 dB wall with a 1 mm × 2 m perimeter crack composites down to
// 37 dB. The workbench was silent on this until Step 3.
//
// This test pins the disclosure card's presence and the load-bearing numbers
// (the three worked examples + the three citations) so a future copy-only
// refactor can't silently drop the engineering meaning.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`); passed++; }
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

const sim = read('js/labs/walllab/wall-sim.js');
const css = read('css/main.css');

// =============================================================================
// (1) Section structurally present in the right-rail render
// =============================================================================

check('isolationMethodHTML renders the Perimeter & leaks section ALWAYS',
  /<section class="wall-method-section wall-method-section-leaks">/.test(sim));
check("section label is exactly 'Perimeter & leaks'",
  /<span class="wall-method-section-label">Perimeter &amp; leaks<\/span>/.test(sim));
check('leakDisclosureSectionHTML function defined',
  /function leakDisclosureSectionHTML\(\)/.test(sim));

// =============================================================================
// (2) Composite TL formula in the equation block
// =============================================================================

check('formula block shows composite TL = -10·log10(Σ τᵢ·Sᵢ / Σ Sᵢ)',
  /TL<sub>actual<\/sub> = −10·log₁₀\(.*Σ τᵢ·Sᵢ.*Σ Sᵢ.*\)/s.test(sim));
check("formula block notes τ_leak ≈ 1 (a 1 mm crack has TL ≈ 0 dB)",
  /τ<sub>leak<\/sub>.*≈.*1.*1.*mm crack.*TL ≈ 0 dB/s.test(sim));

// =============================================================================
// (3) The three worked examples — Dr. Chen's specific numbers
// =============================================================================

check('worked example 1: properly sealed (pinhole) → 49.96 dB, loss < 0.04',
  /Properly sealed \(pinhole\)/.test(sim) &&
  /10⁻⁴ m²/.test(sim) &&
  /49\.96 dB/.test(sim) &&
  /&lt; 0\.04/.test(sim));
check('worked example 2: 1 mm × 2 m perimeter crack → 37 dB, loss −13',
  /1 mm × 2 m perimeter crack/.test(sim) &&
  /0\.002 m²/.test(sim) &&
  /<strong>37 dB<\/strong>/.test(sim) &&
  /−13/.test(sim));
check('worked example 3: 10 mm under-door gap → 27 dB, loss −23',
  /10 mm under-door gap/.test(sim) &&
  /0\.02 m²/.test(sim) &&
  /<strong>27 dB<\/strong>/.test(sim) &&
  /−23/.test(sim));

// =============================================================================
// (4) Three citations on the engineering claim
// =============================================================================

check('cite Bies & Hansen Eq. 8.46 (two-path composite TL with leak)',
  /Bies &amp; Hansen/.test(sim) &&
  /Eq\. 8\.46/.test(sim) &&
  /two-path composite/.test(sim));
check('cite Hopkins 2007 §3.3.4 "Air paths and flanking"',
  /Hopkins.*2007.*§3\.3\.4/.test(sim) &&
  /Air paths and flanking/.test(sim));
check('cite ISO 10140-2 Annex A (lab measurement excludes leakage)',
  /ISO 10140-2 Annex A/.test(sim) &&
  /excludes leakage/.test(sim));

// =============================================================================
// (5) The narrative — engineering meaning preserved
// =============================================================================

check('narrative names "perfectly sealed perimeter" as the assumption',
  /perfectly sealed perimeter/.test(sim));
check("narrative names the 50 dB → 27 dB intuition (one badly-sealed door)",
  /50&nbsp;dB wall[\s\S]*one badly-sealed door[\s\S]*transmits like a 27&nbsp;dB wall/.test(sim));

// =============================================================================
// (6) CSS — table styling defined
// =============================================================================

check('CSS defines .wall-leak-table (table container)',
  /\.wall-leak-table\b/.test(css));
check('CSS defines .wall-method-section-leaks (section variant)',
  /\.wall-method-section-leaks\b/.test(css));
check('table cells: leak description left-aligned, numeric columns right-aligned',
  /\.wall-leak-table[^}]*th:nth-child\(2\)[\s\S]*text-align:\s*right/.test(css));

// =============================================================================
// (7) Cache bump
// =============================================================================

const html = read('index.html');
const _vAll = [...html.matchAll(/\?v=(\d+)\b/g)].map(m => Number(m[1]));
check('index.html cache-bust is past v=628 (Step 3 shipped at v=629+)',
  _vAll.length > 0 && _vAll.every(v => v >= 629));

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
