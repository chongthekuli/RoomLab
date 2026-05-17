// Tripwire — user-visible bug 2026-05-18:
//
//   "look at the yellow area, its located at the corridor without speaker,
//    and blue color occur at the corridor with speaker."
//
// Surau preset, 3D viewport: north qibla podium (no speakers, ~74 dB at
// 1 kHz) rendered HOT YELLOW while south podium (3 arcade speakers,
// ~99 dB) rendered as COLD BLUE. The visualization was inverted N↔S.
//
// Root cause: js/graphics/scene.js#renderZones UV mapping
//   uv.v = 1 - (sy - minY) / d
// was authored against CanvasTexture (flipY=true → canvas top row lands
// at UV.v=1). The Tier 1a scalar-field shader path uses DataTexture
// which IGNORES the flipY hint per Three.js docs — so south physics
// data (grid row j=0) landed at UV.v=0 (texture bottom) while the UV
// math was looking south up at UV.v=1 (texture top), pulling the NORTH
// cell value.
//
// Fix: heatmap-shader.js#buildScalarTexture mirrors the row order at
// write-time (jSrc = cellsY - 1 - j) so the DataTexture orientation
// matches CanvasTexture orientation and the UV math is correct.
//
// This test reads heatmap-shader.js as text and grep-asserts the
// row-flip line is present. Pure source-text check — doesn't depend on
// THREE being importable in Node.

import { readFileSync } from 'node:fs';

let failed = 0;
const pass = l => console.log(`PASS  ${l}`);
const fail = (l, e = '') => { console.log(`FAIL  ${l}${e ? '  ' + e : ''}`); failed++; };
const assertTrue = (c, l, e = '') => c ? pass(l) : fail(l, e);

const src = readFileSync('./js/graphics/heatmap-shader.js', 'utf8');

// (1) The row-flip line must exist inside buildScalarTexture. Pattern is
// permissive on whitespace but anchors on the canonical mirror math:
// `cellsY - 1 - j`. Absence = regression.
assertTrue(
  /jSrc\s*=\s*cellsY\s*-\s*1\s*-\s*j/.test(src),
  '(1) buildScalarTexture row-flip line `jSrc = cellsY - 1 - j` is present',
  'If this fails, the surau N↔S inversion bug has regressed. See header comment.'
);

// (2) The grid lookup inside the inner loop must use jSrc (not j) on the
// row index. If somebody re-introduces `grid[j][i]` the flip is undone.
assertTrue(
  /grid\[jSrc\]\[i\]/.test(src),
  '(2) grid lookup uses the flipped row index `grid[jSrc][i]`',
  'If this fails, the row-flip variable is declared but unused — back to inverted output.'
);

// (3) Defensive: there must be exactly ONE row-flip site so we don't
// double-flip if a future patch adds a second loop without coordinating.
const flipMatches = (src.match(/cellsY\s*-\s*1\s*-\s*j/g) || []).length;
assertTrue(
  flipMatches === 1,
  `(3) Exactly one row-flip site exists (found ${flipMatches})`,
  'Double-flip = back to inverted output; zero = no flip at all.'
);

// (4) Documentation tripwire — the buildScalarTexture comment must
// reference the bug context so a future contributor reading the code
// understands WHY the flip is there before refactoring it out.
assertTrue(
  /flipY|CanvasTexture|surau|N.S|inverted|inversion/i.test(src),
  '(4) Source contains a documenting comment about flipY / CanvasTexture / N-S inversion',
  'The fix must stay self-documenting so the next pair of eyes doesn\'t delete the flip thinking it\'s redundant.'
);

if (failed > 0) {
  console.log(`\n${failed} heatmap orientation tripwire(s) FAILED`);
  process.exit(1);
}
console.log('\nAll heatmap shader orientation tripwires passed.');
