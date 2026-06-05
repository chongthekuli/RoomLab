// Rail-panel registration guard (2026-06-05).
//
// Bug it prevents (building-structure panel, v=756→757): a new left/right rail
// icon (`<button class="rail-icon" data-panel="structure" data-side="left">`)
// was added with its `<section id="panel-structure">` and its mount function,
// but the CSS that REVEALS the matching section is a hand-maintained selector
// list (main.css: `html[data-rail-left="X"] #panel-X`). The new id was missing
// from that list, so clicking the icon opened the panel container but the
// section stayed `display:none` — the panel read EMPTY even though everything
// else (state, physics, 3D, mount) worked.
//
// This test asserts, for every rail icon in index.html:
//   (1) a matching <section id="panel-<panel>"> exists, AND
//   (2) main.css carries a `html[data-rail-<side>="<panel>"] #panel-<panel>`
//       show-selector (so the section is actually revealed when opened).
//
// Three things must stay in sync (icon ↔ section ↔ CSS reveal). Any future
// panel that wires two of the three but forgets the CSS trips here.
//
// Run: node tests/rail-panel-registration.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (c, l, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${!c && e ? '  — ' + e : ''}`); if (!c) failed++; };

const html = readFileSync('./index.html', 'utf8');
const css = readFileSync('./css/main.css', 'utf8');

// Every rail icon: capture data-panel + data-side (attribute order varies).
const buttons = [...html.matchAll(/<button class="rail-icon"[^>]*>/g)].map(m => m[0]);
const icons = [];
for (const b of buttons) {
  const panel = b.match(/data-panel="([^"]+)"/)?.[1];
  const side = b.match(/data-side="([^"]+)"/)?.[1];
  if (panel && side) icons.push({ panel, side });
}

ok(icons.length > 0, `found rail icons in index.html (${icons.length})`);

// Normalise whitespace so the multi-line selector list matches regardless of
// the column alignment used in main.css.
const cssFlat = css.replace(/\s+/g, ' ');

for (const { panel, side } of icons) {
  // (1) matching section exists in the HTML.
  const hasSection = new RegExp(`<section id="panel-${panel}"`).test(html);
  ok(hasSection, `rail "${panel}" (${side}): <section id="panel-${panel}"> exists in index.html`,
     'add the panel section to #panel-' + side);

  // (2) CSS reveal selector exists: html[data-rail-<side>="<panel>"] #panel-<panel>
  const sel = `html[data-rail-${side}="${panel}"] #panel-${panel}`;
  ok(cssFlat.includes(sel),
     `rail "${panel}" (${side}): main.css reveals it ( ${sel} )`,
     'without this the panel opens but the section stays display:none (empty panel)');
}

console.log(failed === 0 ? '\nAll rail-panel-registration checks PASSED' : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
