// Phase 6 Step 5 — flanking-transmission disclosure card (v=631).
//
// Dr. Chen sign-off 2026-05-23: structure-borne flanking is the OTHER half of
// "field ≠ lab". Step 3 covered airborne leaks (perimeter cracks); this card
// covers vibration transfer through floor/ceiling/side-wall junctions.
// ISO 12354-1:2017 §4.2 Eq. (24) gives R'_w = -10·log10(10^(-Rw/10) +
// Σ 10^(-R_ij/10)); R_ij per Hopkins §4.4.4 Eq. 4.52.
//
// Numbers pinned (locked by Dr. Chen, Rw 50, 4 paths, R_flank ≈ R_partition,
// area term lumped into K_ij):
//   K_ij = 10 dB rigid masonry T:    R'_w = 48.5 dB  loss −1.5
//   K_ij = 5  dB lightweight stud T: R'_w = 46.5 dB  loss −3.5
//   K_ij = 20 dB resilient (well-detailed): R'_w = 49.8 dB  loss −0.2
//
// Card is DISCLOSURE-ONLY (Dr. Chen Q6): no chip line. We have no
// per-construction K_ij data; computing R'_w on a real assembly would be
// dishonest. The chip stays Rw/DnT,w.

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

check('isolationMethodHTML renders the Flanking transmission section ALWAYS',
  /<section class="wall-method-section wall-method-section-flanking">/.test(sim));
check("section label is exactly 'Flanking transmission'",
  /<span class="wall-method-section-label">Flanking transmission<\/span>/.test(sim));
check('flankingDisclosureSectionHTML function defined',
  /function flankingDisclosureSectionHTML\(\)/.test(sim));

// =============================================================================
// (2) Formula block — ISO 12354-1 Eq. 24 + Eq. 25 (R_ij)
// =============================================================================

check("R'_w formula shows the path sum: -10·log10(10^(-Rw/10) + Σ 10^(-R_ij/10))",
  /R'<sub>w<\/sub> = −10·log₁₀\([\s\S]*?10<sup>−Rw\/10<\/sup>[\s\S]*?Σᵢ[\s\S]*?10<sup>−R<sub>ij<\/sub>\/10<\/sup>/.test(sim));
check('R_ij sub-line shows (R_i + R_j)/2 + K_ij + 10·log10(S_s/(l0·l_ij))',
  /R<sub>ij<\/sub> = \(R<sub>i<\/sub> \+ R<sub>j<\/sub>\)\/2 \+ K<sub>ij<\/sub> \+ 10·log₁₀/.test(sim));
check('K_ij definition line names it the junction vibration-reduction index',
  /K<sub>ij<\/sub>[\s\S]*?junction vibration-reduction index/.test(sim));
check("K_ij description names 'structure-borne vibration' (per Dr. Chen Q4)",
  /structure-borne vibration the junction blocks/.test(sim));

// =============================================================================
// (3) The three worked examples — Dr. Chen's locked numbers
// =============================================================================

check('row 1: rigid masonry T-junction, K_ij = 10 dB, R\'_w = 48.5 dB, loss −1.5',
  /Rigid masonry T-junction/.test(sim) &&
  /<td>10 dB<\/td><td><strong>48\.5 dB<\/strong><\/td><td>−1\.5<\/td>/.test(sim));
check('row 2: lightweight stud T-junction, K_ij = 5 dB, R\'_w = 46.5 dB, loss −3.5',
  /Lightweight stud T-junction/.test(sim) &&
  /<td>5 dB<\/td><td><strong>46\.5 dB<\/strong><\/td><td>−3\.5<\/td>/.test(sim));
check('row 3: decoupled / resilient layer (well-detailed), K_ij = 20 dB, R\'_w = 49.8 dB, loss −0.2',
  /Decoupled \/ resilient layer \(well-detailed\)/.test(sim) &&
  /<td>20 dB<\/td><td><strong>49\.8 dB<\/strong><\/td><td>−0\.2<\/td>/.test(sim));

// Sanity-check the math (Dr. Chen reproduced these):
//   Rw 50, 4 paths, R_ij = Rw + K_ij
//   K=10:  R'_w = -10·log10(1e-5 + 4·10^-6)   = 48.54 → "48.5"
//   K=5:   R'_w = -10·log10(1e-5 + 4·10^-5.5) = 46.45 → "46.5"
//   K=20:  R'_w = -10·log10(1e-5 + 4·10^-7)   = 49.83 → "49.8"
function rPrimeW(rw_db, kij_db, nPaths = 4) {
  const tau_part = Math.pow(10, -rw_db / 10);
  const r_ij = rw_db + kij_db;
  const tau_flank_sum = nPaths * Math.pow(10, -r_ij / 10);
  return -10 * Math.log10(tau_part + tau_flank_sum);
}
check('math: K=10 dB gives R\'_w = 48.5 dB (computed)',
  Math.abs(rPrimeW(50, 10) - 48.5) < 0.1,
  `computed ${rPrimeW(50, 10).toFixed(2)}`);
check('math: K=5 dB gives R\'_w = 46.5 dB (computed)',
  Math.abs(rPrimeW(50, 5) - 46.5) < 0.1,
  `computed ${rPrimeW(50, 5).toFixed(2)}`);
check('math: K=20 dB gives R\'_w = 49.8 dB (computed)',
  Math.abs(rPrimeW(50, 20) - 49.8) < 0.1,
  `computed ${rPrimeW(50, 20).toFixed(2)}`);

// =============================================================================
// (4) Three citations on the engineering claim
// =============================================================================

check('cite Hopkins 2007 §4.4.4 Eq. 4.52 (per Dr. Chen Q5 — NOT 4.51)',
  /Hopkins[\s\S]*?Sound Insulation[\s\S]*?\(2007\)[\s\S]*?§4\.4\.4 Eq\. 4\.52/.test(sim));
check('cite ISO 12354-1:2017 §4.2 Eq. (24) — path sum',
  /ISO 12354-1:2017 §4\.2 Eq\. \(24\)/.test(sim));
check('cite ISO 12354-1 Eq. (25) — R_ij per path',
  /Eq\. \(25\)/.test(sim));
check('cite Hopkins 2007 §4.6 Table 4.4 — typical K_ij ranges',
  /Hopkins 2007 §4\.6 Table 4\.4/.test(sim));
check('cite EN ISO 10848-1:2017 — K_ij measurement protocol',
  /EN ISO 10848-1:2017/.test(sim));
check('K=20 row caveat present: "optimistic edge" + "well-detailed"',
  /optimistic edge[\s\S]*?well[- ]executed/.test(sim) || /well-detailed[\s\S]*?optimistic edge/.test(sim));

// =============================================================================
// (5) Narrative — engineering meaning preserved
// =============================================================================

check('narrative names "structure-borne flanking" as the mechanism',
  /structure-borne flanking/.test(sim));
check('narrative names the 3-junction-class spectrum (concrete-block / stud / resilient)',
  /heavy concrete-block junctions[\s\S]*?lightweight stud T-junctions[\s\S]*?resilient floating layer/.test(sim));
check('narrative discloses the 4-path + R_flank ≈ R_partition assumption inline (Dr. Chen Q3)',
  /4 flanking paths[\s\S]*?floor \+ ceiling \+ 2 side walls/.test(sim) &&
  /R<sub>flank<\/sub> ≈ R<sub>partition<\/sub>/.test(sim));
check('narrative names "area term lumped into K_ij" (Hopkins §4.4.5 shortcut)',
  /area term lumped into K<sub>ij<\/sub>[\s\S]*?Hopkins §4\.4\.5/.test(sim));

// =============================================================================
// (6) Disclosure-only — NO chip line added (Dr. Chen Q6 sign-off)
// =============================================================================

check("no R'_w chip line in renderSummary (disclosure-only — chip stays Rw/DnT,w)",
  !/wall-rw-chip-flanking|R'_w ≈/.test(sim) && !/R'<sub>w<\/sub> ≈ \$\{/.test(sim));

// =============================================================================
// (7) CSS — flanking table styled, mirrors leak-table
// =============================================================================

check('CSS defines .wall-flanking-table (table container)',
  /\.wall-flanking-table\b/.test(css));
check('CSS defines .wall-method-section-flanking (section variant)',
  /\.wall-method-section-flanking\b/.test(css));
check('table cells: junction-type column left-aligned, numeric columns right-aligned',
  /\.wall-flanking-table[^}]*th:nth-child\(2\)[\s\S]*text-align:\s*right/.test(css));
check('flanking table uses tabular-nums for column alignment',
  /\.wall-flanking-table[\s\S]*?font-variant-numeric:\s*tabular-nums/.test(css));

// =============================================================================
// (8) Step 5 ships AFTER Step 3 + Step 4 (sibling cards remain present)
// =============================================================================

check("Step 3 leak section still present (not regressed by Step 5)",
  /<section class="wall-method-section wall-method-section-leaks">/.test(sim) &&
  /function leakDisclosureSectionHTML\(\)/.test(sim));
check("Step 4 Hopkins derating still present (not regressed by Step 5)",
  /HOPKINS_DERATING_N/.test(sim) && /function computeFieldDerating\(cat, meta\)/.test(sim));

// =============================================================================
// (9) Cache bump
// =============================================================================

const html = read('index.html');
const _vAll = [...html.matchAll(/\?v=(\d+)\b/g)].map(m => Number(m[1]));
check('index.html cache-bust is past v=630 (Step 5 shipped at v=631+)',
  _vAll.length > 0 && _vAll.every(v => v >= 631));

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
