// Phase 5 Step 9 — Composite-wall UI gesture (v=623).
//
// Maya UX sign-off 2026-05-23 — composite is "+ add inset" beneath the
// primary material rail, slot-and-fill row with material + area-fraction
// (% slider + numeric twin) + remove (×), summary chip switches to the
// composite Rw, plot adds primary + inset overlays under the composite,
// table extends to 3 rows (primary / inset / composite), right rail adds
// a third section "COMPOSITE BREAKDOWN" with a τ·S contribution bar.
//
// Engine reused: wall-composite.js (ISO 12354-3 §17 area-weighted τ-bar).
// Canonical scenario: 1% door in 60 dB concrete → composite ≈ 45 dB
// (the "leaky-door-dominates fast" intuition).

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
// (1) Engine wiring — wall-composite.js imported and used
// =============================================================================

check('wall-sim imports compositeTL from wall-composite.js',
  /from\s+['"][^'"]*wall-composite\.js['"]/.test(sim) &&
  /compositeTL/.test(sim));

// =============================================================================
// (2) State extension — iso.inset = { enabled, matId, area_percent }
// =============================================================================

check('iso state extended with inset block',
  /iso\.inset\s*=\s*iso\.inset\s*\|\|\s*\{[^}]*enabled:\s*false/.test(sim));
check("inset default material is 'door-solid-wood' (Maya §6 canonical anchor)",
  /matId:\s*'door-solid-wood'/.test(sim));
check('inset default area_percent is 5 (Maya §6 "5% of the wall")',
  /area_percent:\s*5/.test(sim));

// =============================================================================
// (3) "+ add inset" button — Maya §1 exact label
// =============================================================================

check("insetButtonHTML exists with class 'wall-inset-add-btn' and id 'wall-inset-add'",
  /function insetButtonHTML/.test(sim) &&
  /class="wall-inset-add-btn"/.test(sim) &&
  /id="wall-inset-add"/.test(sim));
check("button label is exactly '+ add inset (door, window, vent…)' (Maya §1)",
  /\+ add inset \(door, window, vent…\)/.test(sim));

// =============================================================================
// (4) Inset row — Maya §2 (data-inset-index for future-proofing) + §3 (slider
//     + numeric twin) + §4 (no constraint, but doors/windows grouped at top)
// =============================================================================

check('inset row carries data-inset-index="0" for future multi-inset extension',
  /data-inset-index="0"/.test(sim));
check('inset row has a material <select> with id="wall-inset-mat"',
  /id="wall-inset-mat"/.test(sim));
check('inset row has a percentage slider + numeric input twin (Maya §3)',
  /id="wall-inset-pct"/.test(sim) &&
  /id="wall-inset-pct-num"/.test(sim));
check("dropdown groups doors/windows/vents at top under an <optgroup> (Maya §4)",
  /<optgroup label="Doors, windows &amp; vents">/.test(sim));
check("dropdown also has 'All other materials' optgroup",
  /<optgroup label="All other materials">/.test(sim));
check('inset row has a "Remove inset" × button',
  /class="wall-inset-remove"/.test(sim) &&
  /aria-label="Remove inset"/.test(sim));

// =============================================================================
// (5) Fraction summary "primary: 95% · inset: 5%" updates on slider change
// =============================================================================

check("fraction summary renders 'primary: X% · inset: Y%' (Maya §3)",
  /primary: \$\{primaryPct\}% · inset: \$\{st\.inset\.area_percent\}%/.test(sim));
check('syncPct keeps slider + numeric input + summary in sync',
  /function syncPct/.test(sim) &&
  /pctRange\.value\s*=\s*n/.test(sim) &&
  /pctNum\.value\s*=\s*n/.test(sim));
check('syncPct clamps to [0, 100] integer (defensive)',
  /Math\.max\(0,\s*Math\.min\(100,\s*Math\.round\(n\)\)\)/.test(sim));

// =============================================================================
// (6) Inset removal — immediate, no confirmation (Maya §7)
// =============================================================================

check('remove button sets st.inset.enabled = false and rerenders',
  /removeBtn\.addEventListener\('click', \(\) => \{[\s\S]*?st\.inset\.enabled = false[\s\S]*?rerender/.test(sim));

// =============================================================================
// (7) Compute functions — inset TL, composite TL, breakdown
// =============================================================================

check('computeInsetTL branches by cat.model (formula / catalogue / mass-law)',
  /function computeInsetTL/.test(sim) &&
  /cat\.model === 'formula' && cat\.assembly/.test(sim) &&
  /cat\.model === 'catalogue' && Array\.isArray\(cat\.tl_third_oct\)/.test(sim));
check('computeCompositeFromInset short-circuits at 0% and 100% (limit guards)',
  /function computeCompositeFromInset/.test(sim) &&
  /fraction <= 1e-6/.test(sim) &&
  /fraction >= 1 - 1e-6/.test(sim));
check('computeCompositeBreakdown computes τ·S share over Rw bands',
  /function computeCompositeBreakdown/.test(sim) &&
  /primary_taus \+= Math\.pow\(10, -primaryTL\.tl_third_oct\[i\] \/ 10\) \* \(1 - fraction\)/.test(sim) &&
  /inset_taus \+= Math\.pow\(10, -insetTL\.tl_third_oct\[i\] \/ 10\) \* fraction/.test(sim));

// =============================================================================
// (8) Chip + plot + table swap when composite active (Maya §5)
// =============================================================================

check('render() uses composite TL for rating when inset enabled',
  /const ratingTL = compositeTL \|\| primaryTL/.test(sim));
check('plot extras pass primary + inset overlay curves when inset active',
  /\{ tl: primaryTL, label: 'primary', className: 'wp-primary-overlay' \}/.test(sim) &&
  /\{ tl: insetTL, label: 'inset', className: 'wp-inset-overlay' \}/.test(sim));
check('plotSVG renders extras layer (primary + inset overlay paths)',
  /extrasLayer/.test(sim) &&
  /opts\.extras/.test(sim));
check('table swaps to compositeTableHTML (3-row primary / inset / composite) when inset active',
  /function compositeTableHTML/.test(sim) &&
  /Inset \(\$\{insetName\}\)/.test(sim) &&
  /<th>Composite<\/th>/.test(sim));
check('compositeTableHTML composite row uses wall-tl-net class (accented)',
  /<tr class="wall-tl-net"><th>Composite<\/th>/.test(sim));

// =============================================================================
// (9) Right-rail third section — COMPOSITE BREAKDOWN (Maya §8)
// =============================================================================

check('isolationMethodHTML appends third section when insetEnabled + breakdown present',
  /ctx\.insetEnabled && ctx\.breakdown && ctx\.insetCat/.test(sim));
check("third section labelled 'Composite breakdown'",
  /<span class="wall-method-section-label">Composite breakdown<\/span>/.test(sim));
check('breakdownSectionHTML renders a τ·S proportion bar',
  /function breakdownSectionHTML/.test(sim) &&
  /wall-breakdown-bar/.test(sim));
check("breakdown narrative names the dominant element by name",
  /dominant === 'inset'/.test(sim) &&
  /carries <strong>\$\{breakdown\.inset_pct\}%<\/strong> of the τ·S budget/.test(sim));

// =============================================================================
// (10) EQUATION & METHOD switches to τ-bar formula when composite active
// =============================================================================

check("equationMethodHTML routes to compositeEquationHTML when ctx.insetEnabled",
  /if \(ctx\.insetEnabled && ctx\.insetCat\) return compositeEquationHTML/.test(sim));
check('compositeEquationHTML shows the ISO 12354-3 τ-bar formula',
  /function compositeEquationHTML/.test(sim) &&
  /R<sub>composite<\/sub>\(f\) = −10·log₁₀\( Σ τᵢ\(f\)·Sᵢ \/ Σ Sᵢ \)/.test(sim));
check('compositeEquationHTML cites ISO 12354-3:2017 §17 + Bies & Hansen Eq. 8.27',
  /ISO 12354-3:2017 §17/.test(sim) &&
  /Bies/.test(sim) && /Eq\. 8\.27/.test(sim));
check('compositeEquationHTML preserves ISO 12354 flanking caveat',
  /flanking transmission/.test(sim) && /ISO 12354/.test(sim));

// =============================================================================
// (11) CSS — all new classes defined
// =============================================================================

const cssClasses = [
  ['.wall-inset-container', 'inset container'],
  ['.wall-inset-add-btn', 'add-inset button'],
  ['.wall-inset-row', 'inset row layout'],
  ['.wall-inset-pct-pair', 'percentage pair (slider + input)'],
  ['.wall-inset-pct-input', 'numeric input twin'],
  ['.wall-inset-remove', '× remove button'],
  ['.wall-inset-fraction-summary', 'primary/inset percent summary'],
  ['.wp-primary-overlay', 'primary curve overlay (dashed muted)'],
  ['.wp-inset-overlay', 'inset curve overlay (dotted muted)'],
  ['.wall-tl-overlay', 'muted table rows for primary/inset'],
  ['.wall-method-section-breakdown', 'third section variant'],
  ['.wall-breakdown-bar', 'τ·S contribution bar'],
  ['.wall-breakdown-bar-primary', 'primary segment'],
  ['.wall-breakdown-bar-inset', 'inset segment'],
];
for (const [cls, label] of cssClasses) {
  check(`CSS defines ${cls} (${label})`,
    new RegExp(cls.replace('.', '\\.') + '\\b').test(css));
}

// =============================================================================
// (12) Cache bump
// =============================================================================

const html = read('index.html');
const _vAll = [...html.matchAll(/\?v=(\d+)\b/g)].map(m => Number(m[1]));
check('index.html cache-bust is past v=622 (Step 9 shipped at v=623+)',
  _vAll.length > 0 && _vAll.every(v => v >= 623));

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
