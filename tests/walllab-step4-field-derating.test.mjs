// Phase 6 Step 4 — field-vs-lab Rw derating display (v=630).
//
// Dr. Chen sign-off 2026-05-23: lab Rw → field DnT,w approximation per
// Hopkins 2007 Table 6.3 + §6.4.2. `DnT,w ≈ Rw − N` where N is a single
// calibration constant per construction family (no per-band fit, no
// measured-row dependency).
//
// N table (locked):
//   masonry           N = 3 dB
//   lightweight_stud  N = 5 dB
//   decoupled         N = 6 dB    (Dr. Chen corrected my 4 → 6)
//   glazing           N = 4 dB
//   door              N = 3 dB
//
// Construction family derived from existing schema fields (no schema 1.6
// needed). The chip gains a second caption line under the Rw value:
//   DnT,w ≈ 42 dB field (Hopkins 2007, lightweight stud)

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
// (1) HOPKINS_DERATING_N table — pin every N value (transcription drift)
// =============================================================================

check('HOPKINS_DERATING_N is frozen',
  /const HOPKINS_DERATING_N = Object\.freeze/.test(sim));
check('masonry: N = 3 dB',
  /masonry:\s*\{\s*N:\s*3\s*,\s*familyLabel:\s*'masonry'/.test(sim));
check("lightweight_stud: N = 5 dB, familyLabel 'lightweight stud' (space, not underscore)",
  /lightweight_stud:\s*\{\s*N:\s*5\s*,\s*familyLabel:\s*'lightweight stud'/.test(sim));
check('decoupled: N = 6 dB (Dr. Chen correction from 4)',
  /decoupled:\s*\{\s*N:\s*6\s*,\s*familyLabel:\s*'decoupled'/.test(sim));
check('glazing: N = 4 dB (midpoint of Hopkins 3-5 range)',
  /glazing:\s*\{\s*N:\s*4\s*,\s*familyLabel:\s*'glazing'/.test(sim));
check('door: N = 3 dB (own family, NOT composite)',
  /door:\s*\{\s*N:\s*3\s*,\s*familyLabel:\s*'door'/.test(sim));

// =============================================================================
// (2) computeFieldDerating — family derivation correct
// =============================================================================

check('computeFieldDerating function defined',
  /function computeFieldDerating\(cat, meta\)/.test(sim));
check("wallType 'masonry' → family 'masonry'",
  /meta\.wallType === 'masonry'\)\s*family\s*=\s*'masonry'/.test(sim));
check("wallType 'glazing' → family 'glazing'",
  /meta\.wallType === 'glazing'\)\s*family\s*=\s*'glazing'/.test(sim));
check("wallType 'door' → family 'door'",
  /meta\.wallType === 'door'\)\s*family\s*=\s*'door'/.test(sim));
check("formula + stud_type 'staggered' or 'double' → family 'decoupled'",
  /\(stud === 'staggered' \|\| stud === 'double'\) \? 'decoupled' : 'lightweight_stud'/.test(sim));
check("mass-law + double_leaf (gypsum-board v=609 case) → 'lightweight_stud' (Dr. Chen)",
  /lightweight_stud per Dr\. Chen/.test(sim));

// =============================================================================
// (3) Chip rendering — field line added between Rw value and the standard cite
// =============================================================================

check('renderSummary signature includes cat + meta',
  /function renderSummary\(scope, rating, cat, meta\)/.test(sim));
check('render() passes cat + meta to renderSummary',
  /renderSummary\(body\.querySelector\('#wall-summary'\), rating, cat, meta\)/.test(sim));
check("field line uses 'DnT,w ≈ X dB field' format (per Dr. Chen)",
  /DnT,w ≈ \$\{rating\.Rw - derating\.N\}&nbsp;dB field/.test(sim));
check("field line cites 'Hopkins 2007, ${family}' inline",
  /\(Hopkins 2007, \$\{derating\.familyLabel\}\)/.test(sim));
check("field line class is wall-rw-chip-field (own visual treatment)",
  /class="wall-rw-chip-field/.test(sim));
check('field line skipped when derating returns null (defensive)',
  /derating\s*\?[\s\S]*?:\s*''/.test(sim));

// =============================================================================
// (4) CSS — new chip-field classes styled
// =============================================================================

check('CSS defines .wall-rw-chip-field (DnT,w line)',
  /\.wall-rw-chip-field\b/.test(css));
check('CSS defines .wall-rw-chip-field-cite (Hopkins citation, smaller font)',
  /\.wall-rw-chip-field-cite\b/.test(css));
check('field-cite is visually subordinate to the field value',
  /\.wall-rw-chip-field-cite[\s\S]*?font-size:\s*9px/.test(css));

// =============================================================================
// (5) Hopkins 2007 citation present (engineering rigor)
// =============================================================================

check("comment cites 'Hopkins 2007 Table 6.3' (not just 'Hopkins')",
  /Hopkins 2007 Table 6\.3/.test(sim));
check("comment names Dr. Chen's decoupled N correction (range 5-7, lock 6)",
  /range 5-7/.test(sim));

// =============================================================================
// (6) Cache bump
// =============================================================================

const html = read('index.html');
const _vAll = [...html.matchAll(/\?v=(\d+)\b/g)].map(m => Number(m[1]));
check('index.html cache-bust is past v=629 (Step 4 shipped at v=630+)',
  _vAll.length > 0 && _vAll.every(v => v >= 630));

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
