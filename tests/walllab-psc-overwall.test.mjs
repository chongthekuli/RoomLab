// WallLAB PSC v=610 regression guard (2026-05-23) — over-wall mode honest.
//
// PSC (parallel small commit before Phase 5 Step 1) wires the existing pure
// modules into the over-wall diffraction demo per Maya's UX call:
//
//   1. Three rays in the cross-section — direct sightline, over-top diffracted
//      path, ground-reflected over-top path (drawn from an image-source
//      marker on the ground line, NO below-ground line drawing).
//   2. Ground-type segmented control (Hard / Soft) below the geometry sliders;
//      soft ground hides the image marker + reflected ray entirely.
//   3. Per-band table extends to three rows — Maekawa IL on the over-top path,
//      air-abs penalty on the same detour (signed negative), bolded Net IL row.
//   4. Summary block switches from "IL @ 1 kHz" to broadband mean (250 Hz –
//      4 kHz) matching Mode 1's summary cap — toggling Mode 1 ↔ Mode 2 must
//      not covertly redefine the headline number.
//   5. Source / listener label-anchor bugfix — old code had anchor direction
//      inverted from offset, causing label overlap with the receiver circle
//      at recvDist=20 m. Labels now sit OUTSIDE the scene (source LEFT of
//      source circle, listener RIGHT of receiver circle) with heights shown
//      on both for symmetry.
//
// Wiring assertions are text-grep against wall-sim.js — same pattern as
// walllab-phase1.test.mjs (avoids importing DOM-coupled modules in Node).
// The pure-module physics (overBarrierPathDifference, maekawaIL,
// airAbsorptionDbPerM) is already tested in its own files.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`PASS  ${name}`);
  passed++;
}

const sim = read('js/labs/walllab/wall-sim.js');

// (1) airAbsorptionDbPerM imported and reachable.
check('wall-sim imports airAbsorptionDbPerM from air-absorption.js',
  /import\s*\{\s*airAbsorptionDbPerM\s*\}\s*from\s*['"][^'"]*air-absorption\.js['"]/.test(sim));

// (2) Diffraction state carries groundType, default 'hard'.
check("diff state default groundType is 'hard'",
  /groundType:\s*'hard'/.test(sim));

// (3) The render path computes two diffracted paths — direct + ground-mirrored.
check('render mirrors source through ground plane (sourceH: -sH)',
  /sourceH:\s*-sH/.test(sim));
check('render computes detour for direct over-top path',
  /detour_overtop\s*=\s*Math\.hypot\(d1,\s*wH\s*-\s*sH\)\s*\+\s*Math\.hypot\(d2,\s*rH\s*-\s*wH\)/.test(sim));
check('render computes detour for ground-reflected over-top path',
  /detour_overtop_ground\s*=\s*Math\.hypot\(d1,\s*wH\s*\+\s*sH\)/.test(sim));
check('render documents the demo ground-plane = z = 0 assumption (Martina HIGH #3)',
  /GROUND_Z_M\s*=\s*0/.test(sim));

// (4) Air-abs penalty uses airAbsorptionDbPerM, signed negative.
// After Martina audit (v=612): the over-top air-abs is computed as
// "EXTRA absorption vs the direct sightline" (= α × (detour − direct))
// so the row honestly attributes only the extra-over-the-top penalty
// to the wall. The ground-reflected path still uses its full detour
// (no equivalent direct reference — no-wall has no ground-bounce-over-
// top arrival). Regex accepts either form for forward-compat across
// the v=611 → v=612 boundary.
check('per-band air_abs uses airAbsorptionDbPerM(f), signed negative, on direct over-top path',
  /air_abs\s*=\s*bands\.map\(f\s*=>\s*-airAbsorptionDbPerM\(f\)\s*\*\s*(?:detour_overtop\b|\(detour_overtop\s*-\s*direct_sightline_m\))/.test(sim));
check('air_abs subtracts direct sightline to express EXTRA over-the-top absorption (Martina MEDIUM #2)',
  /direct_sightline_m\s*=\s*Math\.hypot\(d1\s*\+\s*d2/.test(sim) &&
  /-airAbsorptionDbPerM\(f\)\s*\*\s*\(detour_overtop\s*-\s*direct_sightline_m\)/.test(sim));

// (5) Net IL is the energy-sum of the two diffracted paths weighted by (1-G).
check('net_il energy-sums the two paths weighted by (1 - G)',
  /\(1\s*-\s*G\)\s*\*\s*Math\.pow\(10,\s*-loss_ground\s*\/\s*10\)/.test(sim));

// (6) Broadband mean over 250 Hz – 4 kHz (indices 1..5 in 7-band octave list).
check('summary uses broadband mean over 250 Hz – 4 kHz (indices 1..5)',
  /broadbandIdx\s*=\s*\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*\]/.test(sim));
check("summary caption reads '250 Hz – 4 kHz' (not '@ 1 kHz')",
  /250&nbsp;Hz\s*–\s*4&nbsp;kHz/.test(sim) && !/insertion loss<br>@ 1&nbsp;kHz/.test(sim));

// (7) Ground-type segmented control wired.
check('ground-type segment has Hard + Soft options with data-ground attribute',
  /data-ground="hard"/.test(sim) && /data-ground="soft"/.test(sim));
check('clicking a ground segment updates st.groundType + re-renders',
  /st\.groundType\s*=\s*btn\.dataset\.ground/.test(sim));

// (8) Three-row table — Maekawa / Air abs / Net IL.
check('diffractionTableHTML renders three rows: Maekawa, Air abs, Net IL',
  /diffractionTableHTML/.test(sim) &&
  /<th>Maekawa<\/th>/.test(sim) &&
  /<th>Air abs<\/th>/.test(sim) &&
  /<th>Net IL<\/th>/.test(sim));
check('Net IL row carries wall-tl-net class for visual hierarchy',
  /wall-tl-net.*Net IL/s.test(sim));

// (9) Cross-section: third ray + image-source marker on hard ground only.
check('crossSectionSVG signature accepts groundIsHard',
  /function crossSectionSVG\([^)]*groundIsHard\)/.test(sim));
check('ground-reflected path is drawn from the image source on the ground line',
  /xs-path-ground/.test(sim) && /yImage\s*=\s*ground/.test(sim));
check('image-source marker has class xs-src-image and a screen-reader title',
  /xs-src-image/.test(sim) && /<title>image source/.test(sim));
check('soft ground hides the reflected ray + marker + leader (groundLayer conditional)',
  /if\s*\(groundIsHard\)\s*\{[\s\S]*?groundLayer\s*=/.test(sim));

// (10) Source / listener label anchors — v=624 (user-reported clipping bug).
//      v=610: labels OUTSIDE the scene (source LEFT, listener RIGHT).
//      Problem: when source is at the left edge of canvas the "source · 7.0 m"
//        label extends OFF-canvas, leaving only the trailing "0 m" visible.
//      v=624: labels INSIDE the scene, growing AWAY from the wall —
//        source text-anchor="start" at xSrc+8 (extends right, into canvas);
//        listener text-anchor="end" at xRecv-8 (extends left, into canvas).
//      Y clamped to max(11, ySrc-11) so high-mounted sources can't push
//        the label above the SVG viewport.
check('source label is anchored INSIDE the scene (extends right from xSrc+8)',
  /x="\$\{xSrc\s*\+\s*8\}"[^>]*text-anchor="start">source/.test(sim));
check('listener label is anchored INSIDE the scene (extends left from xRecv-8)',
  /x="\$\{xRecv\s*-\s*8\}"[^>]*text-anchor="end">listener/.test(sim));
check('source label y clamped to Math.max(11, ySrc-11) — no off-top clipping',
  /Math\.max\(11,\s*ySrc\s*-\s*11\)/.test(sim));
check('listener label includes its height (symmetry with source label)',
  /listener · \$\{recvH\.toFixed\(1\)\}/.test(sim));

// (11) Status line carries detour length suffix (Maya: one number, one place).
check("status line appends 'detour XX m' suffix",
  /detourTxt\s*=\s*`detour \$\{detour_overtop\.toFixed\(1\)\} m`/.test(sim));

// (12) Method panel mentions ground reflection + air absorption.
check('diffractionMethodHTML now takes groundIsHard',
  /function diffractionMethodHTML\([^)]*groundIsHard\)/.test(sim));
check('method panel cites ISO 9613-2 §7.3.1 for ground reflection',
  /9613-2 §7\.3\.1/.test(sim));
check('method panel cites ISO 9613-1 for air absorption',
  /ISO 9613-1/.test(sim));

// (13) CSS additions wired.
const css = read('css/main.css');
check('css adds .xs-path-ground class', /\.xs-path-ground\b/.test(css));
check('css adds .xs-src-image class', /\.xs-src-image\b/.test(css));
check('css adds .xs-image-leader class', /\.xs-image-leader\b/.test(css));
check('css adds .wall-tl-net row styling', /\.wall-tl-net\b/.test(css));
check('css adds .wall-ground-row layout', /\.wall-ground-row\b/.test(css));

// (14) Cache bump — assert no stale ?v=60x left behind (PSC shipped at
// v=610). Forward-compat: future cache bumps to v=611, v=612, … still pass.
const html = read('index.html');
check('index.html cache-bust is past v=609 (PSC shipped at v=610+)',
  !/\?v=60[0-9]\b/.test(html) && /\?v=6[1-9][0-9]\b/.test(html));

console.log(`\nOK  ${passed} assertions passed`);
