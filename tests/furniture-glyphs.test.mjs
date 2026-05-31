// Regression: FurnitureLAB catalogue glyphs (2D iso-ink thumbnails) must be
// VALID and DISTINCT per object.
//
// User report (2026-05-30): the 2D catalogue drawings were "cacat" — generic
// family shapes that didn't match the real-world objects (theater seat and
// office chair drew the same chair; lectern looked like a table; bookshelf /
// server rack were near-flat planes; audience block ignored its 1.2 m height;
// occupied vs empty looked identical). Fixed by per-id bespoke glyphs in the
// GLYPHS map (buildGlyph checks it before family dispatch).
//
// This guards: every catalogue row builds valid SVG (no NaN/undefined, balanced
// <g>), bespoke items carry their distinguishing class, and occupied variants
// differ from empty (the occupant figure must be present) — so the family-
// collapse can't silently come back.
//
// Run: node tests/furniture-glyphs.test.mjs

import { readFileSync } from 'node:fs';
import { buildGlyph, glyphViewBox } from '../js/labs/furniturelab/glyphs.js';

let failed = 0;
function assert(cond, label) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; }

const cat = JSON.parse(readFileSync('./data/furniture/catalogue.json', 'utf8'));
const items = cat.items ?? cat;
const byId = Object.fromEntries(items.map(it => [it.id, it]));
const svgOf = (id) => buildGlyph(byId[id], {});

// --- 1. Every row builds clean SVG ----------------------------------------
for (const it of items) {
  let svg = '';
  let threw = false;
  try { svg = buildGlyph(it, {}); } catch { threw = true; }
  const openG = (svg.match(/<g[\s>]/g) || []).length;
  const closeG = (svg.match(/<\/g>/g) || []).length;
  const clean = !threw && svg.length > 100 && openG > 0 && openG === closeG
    && !/NaN|undefined/.test(svg);
  assert(clean, `${it.id} builds clean SVG (balanced <g>, no NaN/undefined)`);
}
assert(glyphViewBox() === '0 0 110 140', 'glyphViewBox is the stable shared box (card/panel parity)');

// --- 2. Bespoke items carry their distinguishing class --------------------
// (i.e. they are NOT falling through to a generic family glyph.)
const CLASS = {
  'theater-seat-upholstered-occupied': 'fl-glyph-theater-seat',
  'office-chair-padded-occupied':      'fl-glyph-office-chair',
  'lectern-wood':                      'fl-glyph-lectern',
  'bookshelf-loaded-1x2':              'fl-glyph-bookshelf',
  'server-rack-42u-perforated':        'fl-glyph-server-rack',
  'audience-block-per-m2-occupied':    'fl-glyph-audience-block',
  'prayer-mat-unrolled-per-m2':        'fl-glyph-prayer-mat',
};
for (const [id, cls] of Object.entries(CLASS)) {
  assert(svgOf(id).includes(cls), `${id} uses its bespoke glyph (.${cls}), not a generic family shape`);
}

// theater seat and office chair must be DISTINCT drawings (the original bug
// drew them identically).
assert(svgOf('theater-seat-upholstered-occupied') !== svgOf('office-chair-padded-occupied'),
  'theater seat and office chair are distinct glyphs (not the same generic chair)');

// --- 3. Occupied variants differ from empty (occupant figure present) -----
const occCls = 'fl-occupant';
function occupantCount(svg) { return (svg.split(occCls).length - 1); }
for (const [occ, emp] of [
  ['theater-seat-upholstered-occupied', 'theater-seat-upholstered-empty'],
  ['office-chair-padded-occupied',      'office-chair-padded-empty'],
]) {
  const so = svgOf(occ), se = svgOf(emp);
  assert(so !== se, `${occ} differs from ${emp} (occupied ≠ empty)`);
  assert(occupantCount(so) > occupantCount(se), `${occ} adds an occupant figure the empty variant lacks`);
}

// --- 4. Audience block respects its height (not clamped to a flat mat) ----
// The flat-pad family clamped height to ≤6 cm; the bespoke block carries
// multiple seated occupants, so it must contain occupant figures.
assert(svgOf('audience-block-per-m2-occupied').includes('fl-occupant'),
  'audience block reads as occupied (seated occupants), not a flat mat');

if (failed) { console.log(`\n${failed} test(s) FAILED.`); process.exit(1); }
console.log('\nAll furniture-glyph tests passed.');
