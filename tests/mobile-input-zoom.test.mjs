// Tripwire — mobile auto-zoom layout bug (Maya, 2026-06-07 · v=768):
//
//   "On Android/tablet Chrome: Draw custom room → name dialog → the page
//    auto-zooms when the input is focused → after Draw room, the top tab
//    bar AND the upper-left rail icons are HIDDEN. Never on desktop."
//
// Root cause: the app shell is position:fixed; height:100vh;
// overflow:hidden, and the draw-flow inputs had font-size < 16px. iOS /
// Android Chrome auto-zoom the visual viewport on focus of any control
// below the 16px threshold; in a fixed/overflow:hidden shell the zoom
// scrolls the header + rail off-screen and never resets on blur.
//
// Fix (css/main.css, end of file): an @media (pointer: coarse) block that
// forces focusable controls to >= 16px on touch / stylus devices, plus
// width/padding adjustments so the tight CAD coord + height-prompt inputs
// don't overflow the canvas on a narrow phone. Desktop (pointer: fine) is
// untouched. The viewport meta deliberately KEEPS pinch-zoom (no
// maximum-scale / user-scalable=no — WCAG 1.4.4).
//
// This is a pure source-text check: parse css/main.css + index.html as
// strings, no DOM/CSSOM needed. Same style as the other tripwire tests
// under tests/.

import { readFileSync } from 'node:fs';

let failed = 0;
const pass = l => console.log(`PASS  ${l}`);
const fail = (l, e = '') => { console.log(`FAIL  ${l}${e ? '  ' + e : ''}`); failed++; };
const assertTrue = (c, l, e = '') => c ? pass(l) : fail(l, e);

const css = readFileSync('./css/main.css', 'utf8');
const html = readFileSync('./index.html', 'utf8');

// ── Extract the @media (pointer: coarse) block body ──────────────────────
// Match `@media (pointer: coarse) {` then balance braces to the close.
function extractMediaBlock(source, headerRe) {
  const m = headerRe.exec(source);
  if (!m) return null;
  let i = source.indexOf('{', m.index);
  if (i < 0) return null;
  let depth = 0;
  const start = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start + 1, i); }
  }
  return null;
}

const coarse = extractMediaBlock(css, /@media\s*\(\s*pointer:\s*coarse\s*\)/);

assertTrue(
  coarse !== null,
  '(1) css/main.css contains an @media (pointer: coarse) block',
  'The mobile auto-zoom guard block is missing entirely — bug has regressed.'
);

// ── Helper: find the font-size declared for a selector INSIDE the block ──
// Returns the px value (numeric) for the LAST matching rule, or null.
function fontSizePxFor(blockBody, selector) {
  if (!blockBody) return null;
  // Escape selector for regex (it contains dots).
  const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match `<selector> { ... font-size: <value> ... }`. Allow the selector to
  // appear in a comma group, but here our rules declare each on its own.
  const ruleRe = new RegExp(sel + '\\s*\\{([^}]*)\\}', 'g');
  let px = null, m;
  while ((m = ruleRe.exec(blockBody)) !== null) {
    const fs = /font-size:\s*([0-9.]+)px/.exec(m[1]);
    if (fs) px = parseFloat(fs[1]);
  }
  return px;
}

// (2) The three named draw-flow input classes must resolve to >= 16px
//     INSIDE the coarse-pointer block. 16px is the exact no-auto-zoom floor.
const targets = ['.rl-modal-input', '.draw-float-coord-input', '.draw-height-prompt-row input'];
for (const sel of targets) {
  const px = fontSizePxFor(coarse, sel);
  assertTrue(
    px !== null && px >= 16,
    `(2) ${sel} resolves to >= 16px under (pointer: coarse) [got ${px === null ? 'no rule' : px + 'px'}]`,
    'Below 16px re-triggers Android/iOS Chrome auto-zoom on focus — the header/rail get scrolled off-screen.'
  );
}

// (3) Global safety net: bare input/textarea/select must also be bumped so
//     future inputs don't reintroduce the bug. Assert the block sets a
//     >= 16px font-size on a bare `input` rule.
{
  // A rule whose selector list contains a bare `input` (word-boundary, not
  // `.something-input`) declaring font-size >= 16px.
  const globalRe = /(^|,|\{|\s)input\s*(,[^{]*)?\{[^}]*font-size:\s*([0-9.]+)px/m;
  const gm = globalRe.exec(coarse || '');
  const gpx = gm ? parseFloat(gm[3]) : null;
  assertTrue(
    gpx !== null && gpx >= 16,
    `(3) a global input/textarea/select rule sets font-size >= 16px [got ${gpx === null ? 'none' : gpx + 'px'}]`,
    'Without the global floor, the next input added to the draw flow silently brings the bug back.'
  );
}

// (4) The coord panel must be pinned inside the viewport on a narrow phone
//     so it cannot overflow the canvas once the inputs grow to 16px.
assertTrue(
  /\.draw-float-coord\s*\{[^}]*max-width:\s*calc\(100vw/.test(coarse || ''),
  '(4) .draw-float-coord has a viewport-relative max-width under (pointer: coarse)',
  'At 16px the CAD coord panel widens; without a max-width it can spill off a narrow phone screen.'
);

// (5) Accessibility guard — the viewport meta must NOT disable pinch-zoom.
//     The whole point of the font-size fix is to avoid maximum-scale /
//     user-scalable=no (WCAG 1.4.4). Assert neither appears in the meta.
{
  const meta = /<meta\s+name=["']viewport["'][^>]*>/i.exec(html);
  assertTrue(meta !== null, '(5a) viewport meta tag is present');
  const content = meta ? meta[0] : '';
  assertTrue(
    !/maximum-scale/i.test(content),
    '(5b) viewport meta does NOT contain maximum-scale (keeps pinch-zoom)',
    'WCAG 1.4.4 — low-vision users must keep zoom. Fix the input font-size, not the viewport.'
  );
  assertTrue(
    !/user-scalable\s*=\s*no/i.test(content),
    '(5c) viewport meta does NOT contain user-scalable=no (keeps pinch-zoom)',
    'WCAG 1.4.4 — never disable pinch-zoom to dodge auto-zoom; raise input font-size instead.'
  );
}

// (6) Desktop-cascade safety: the BASE (non-media-query) rules must keep
//     their original compact sizes so mouse users are unaffected. Assert the
//     base .rl-modal-input still declares 12px somewhere OUTSIDE the coarse
//     block (i.e. the desktop styling wasn't globally rewritten).
{
  const coarseStart = (css.indexOf('@media (pointer: coarse)') >= 0)
    ? css.indexOf('@media (pointer: coarse)') : css.length;
  const baseCss = css.slice(0, coarseStart);
  assertTrue(
    /\.rl-modal-input\s*\{[^}]*font-size:\s*12px/.test(baseCss),
    '(6) base .rl-modal-input keeps font-size: 12px (desktop unchanged)',
    'The fix must be additive under (pointer: coarse), not a rewrite of the desktop cascade.'
  );
}

if (failed > 0) {
  console.log(`\n${failed} mobile-input-zoom tripwire(s) FAILED`);
  process.exit(1);
}
console.log('\nAll mobile input auto-zoom tripwires passed.');
