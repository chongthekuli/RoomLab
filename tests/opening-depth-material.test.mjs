// Opening depth ↔ material thickness regression test (v=808, 2026-06-12).
//
// An opening's render depth (thickness_m) is a 3D-only value — the acoustics
// come entirely from the material's transmission-loss data, never the depth.
// So the depth must follow the material's real thickness: picking "Glass window
// 6mm" should set the opening depth to 6 mm, not leave the old flat 50 mm. The
// field stays editable afterward (deep frame / reveal), but auto-fills on add
// and on material change.
//
// Behavioural where possible: the material reference thicknesses are read from
// data/materials.json. The wiring (auto-fill on add + material change, re-render,
// lowered min) is text-grep — needs the DOM it can't load in Node.
//
// Run: node tests/opening-depth-material.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

// ---- Behavioural: materials carry real thicknesses the depth follows -------
const mats = JSON.parse(readFileSync('./data/materials.json', 'utf8')).materials;
const byId = Object.fromEntries(mats.map(m => [m.id, m]));
ok(byId['glass-window']?.reference_thickness_m === 0.006,
   'glass-window reference_thickness_m is 6 mm');
ok(byId['door-solid-wood']?.reference_thickness_m > 0.03,
   `solid wood door reference_thickness_m is a real leaf thickness (${byId['door-solid-wood']?.reference_thickness_m} m)`);
// Every door/window material has a usable reference thickness to auto-fill from.
const openingMats = mats.filter(m => (m.applicableTo || []).some(k => k === 'door' || k === 'window'));
ok(openingMats.length > 0 && openingMats.every(m => Number(m.reference_thickness_m) > 0),
   `all ${openingMats.length} door/window materials have a positive reference_thickness_m`);
// The thinnest opening material (glazing) is below the OLD 10 mm input floor —
// proves the min had to be lowered.
const thinnest = Math.min(...openingMats.map(m => m.reference_thickness_m));
ok(thinnest < 0.01, `thinnest opening material is ${thinnest * 1000} mm (< old 10 mm input floor)`);

// ---- Wiring (text-grep) ----------------------------------------------------
const panel = readFileSync('./js/ui/panel-room.js', 'utf8');

ok(/function refThicknessForMaterial\(matId\)/.test(panel)
   && /reference_thickness_m/.test(panel),
   'panel-room.js: refThicknessForMaterial() reads reference_thickness_m');

// Auto-fill on add (door + window).
ok(/\.\.\.DEFAULT_DOOR, x_m, thickness_m: refThicknessForMaterial\(DEFAULT_DOOR\.materialId\)/.test(panel),
   'adding a door auto-fills depth from its material');
ok(/\.\.\.DEFAULT_WINDOW, x_m, thickness_m: refThicknessForMaterial\(DEFAULT_WINDOW\.materialId\)/.test(panel),
   'adding a window auto-fills depth from its material');

// Auto-fill on material change, then re-render so the field updates.
ok(/next\.openings\[idx\]\.materialId = e\.target\.value;[\s\S]{0,160}thickness_m = refThicknessForMaterial\(e\.target\.value\)/.test(panel),
   'changing an opening material auto-fills its depth from the new material');
ok(/thickness_m = refThicknessForMaterial\(e\.target\.value\);[\s\S]{0,120}renderSurfaceMaterials\(\)/.test(panel),
   'the material-change handler re-renders so the depth field reflects the new thickness');

// Depth field still editable, but its min was lowered to admit thin glazing.
ok(/tInput\.min = '3'/.test(panel) && /Math\.max\(3, mm\)/.test(panel),
   'depth input min lowered to 3 mm (admits 6 mm glazing) and the clamp matches');

if (failed) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log('\nAll opening-depth-material assertions passed.');
