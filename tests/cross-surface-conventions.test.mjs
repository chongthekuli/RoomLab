// Cross-surface convention fixture (Sam, 2026-05-19).
//
// Subsumes regression-backlog item #2 ("2D ↔ 3D ↔ print Y-axis convention")
// and complements tests/scene-x-mirror.test.mjs. Spec'd by Hannes; see
// CLAUDE.md §3 (Cross-surface conventions invariant) and the
// "Cross-surface convention owner" sub-hat in .claude/agents/qa-engineer.md.
//
// What this guards:
//
//   Four projection surfaces draw the same plan view of the scene:
//     1. 2D viewport      — js/graphics/room-2d.js renderNormal
//     2. 3D top-camera    — js/graphics/scene.js _cameraPresetTransform.top
//                           (plus the scene.scale.x = -1 global mirror)
//     3. Print plan SVG   — js/ui/print-plan-svg.js buildFloorPlanSVG
//     4. Print heatmap    — js/ui/print-heatmap.js buildHeatmapPageSVG
//
//   The convention they MUST all agree on:
//     • state +x renders to the RIGHT on the page
//     • state +y renders UP the page (the "north / front-wall" convention)
//     • any drawn north arrow points UP (toward state +y)
//     • scale-bar magnitudes line up within 2 %
//     • units strings are canonical ("m", "mm", "dB", "Hz") — no synonyms,
//       no UTF-8 BOM, no surrounding whitespace
//
// Why this fixture exists: the v=515 → v=525 north-arrow chase (9 Debug
// commits) was the trigger. Five files carried north-arrow logic with no
// shared contract. Other repeat offenders: v=458 (Y-flip applied to plan
// SVG but missed the heatmap legend), v=504 (X-mirror applied to scene
// but downstream callsites missed). Any future divergence between any
// pair of these four surfaces should trip this fixture before it ships.
//
// How it works:
//   • For the two pure SVG modules (print-plan, print-heatmap), call the
//     function directly and parse the SVG output for source/listener
//     screen coords + scale-bar length + north-arrow geometry.
//   • For the two browser-side modules (room-2d, scene 3D), text-grep
//     the source for the projection formula AND re-run the formula
//     analytically on the fixture state. This is the same pattern as
//     tests/scene-x-mirror.test.mjs and tests/heatmap-shader-orientation.
//     test.mjs — full DOM/Three.js integration in Node is more cost than
//     benefit; the regression surface here is "someone changes the
//     formula in one surface only".
//
// Registry guard:
//   The SURFACES list at the top is the authoritative set of render
//   surfaces. Adding a 5th surface (an elevation view, a new export
//   format, a video frame renderer) requires registering it here AND
//   adding parity assertions. The registry check inspects the file system
//   for any js/graphics/* or js/ui/print-*.js file that defines an
//   exported `buildXxxSVG` / `renderXxx` and isn't in the registry —
//   trips the fixture if found.
//
// Run: node tests/cross-surface-conventions.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { state } from '../js/app-state.js';
import { buildFloorPlanSVG } from '../js/ui/print-plan-svg.js';
import { buildHeatmapPageSVG } from '../js/ui/print-heatmap.js';

// --------------------------------------------------------------------
// Registry — the four surfaces this fixture guards.
// --------------------------------------------------------------------

const SURFACES = [
  { id: '2d-viewport',   file: 'js/graphics/room-2d.js',     mode: 'text-grep' },
  // 3D top-camera: registered but numeric projection NOT asserted yet —
  // see "Deferred: 3D top-camera numeric projection" below for the reason
  // and the TODO that closes the gap.
  { id: '3d-top-camera', file: 'js/graphics/scene.js',       mode: 'text-grep' },
  { id: 'print-plan',    file: 'js/ui/print-plan-svg.js',    mode: 'svg-output' },
  { id: 'print-heatmap', file: 'js/ui/print-heatmap.js',     mode: 'svg-output' },
];

// --------------------------------------------------------------------
// Deferred: 3D top-camera numeric projection.
//
// Replicating Three.js's lookAt + perspective-projection pipeline in
// pure Node would let us assert screen-coord ordering for the 3D top
// view alongside the SVG surfaces. Today the fixture covers the 3D
// surface via TEXT-GREP only (assertScene3DFormula) — same shape as
// tests/scene-x-mirror.test.mjs.
//
// What's blocking a numeric assertion:
//   • The v=504 fix (`scene.scale.x = -1` + `camera at -cx`) was
//     verified empirically against the live WebGL render. A naive
//     re-derivation of the Three.js lookAt matrix (with camera.up =
//     (0,1,0) and the tiny -0.001 z-offset to dodge gimbal lock)
//     produces a camera-right axis = world +X — which means the
//     monotonic mapping "state +x → screen RIGHT" does NOT hold for
//     two points on the same side of the camera. Two reads possible:
//       a) The Three.js view-matrix calculation has a subtlety in
//          this near-degenerate case that pure math reproduction
//          misses (most likely candidate: OrbitControls overriding
//          the lookAt quaternion after each preset commit).
//       b) The v=504 fix is correct for the iso/perspective views
//          but ambiguous for the strict top-down case.
//
// Either way, before this fixture asserts numerically against the
// 3D top-camera, someone needs to nail down which model is right by
// running a tiny diagnostic in the live app (toggle
// `window.__roomlabDebugCam = true`, scene.js line 3600) and capture
// the actual `camera.matrixWorld` for the top preset. With that
// matrix, this fixture can project state-coords analytically and
// trip on the same regression as the SVG surfaces.
//
// Owner: Viktor (3d-rendering-expert) for the matrix capture; Sam
// folds it back into this fixture.
// --------------------------------------------------------------------

// --------------------------------------------------------------------
// Test scaffolding (matches tests/scene-x-mirror.test.mjs style).
// --------------------------------------------------------------------

let failed = 0;
const pass = (l) => console.log(`PASS  ${l}`);
const fail = (l, e = '') => { console.log(`FAIL  ${l}${e ? '  — ' + e : ''}`); failed++; };
const ok = (c, l, e = '') => (c ? pass(l) : fail(l, e));

// --------------------------------------------------------------------
// Fixture: rectangular 6 m × 8 m × 3 m, one source, one listener.
// Source at state (+1, +2, 1.2); listener at state (−1, −3, 1.2).
// Both negative state-X for the listener and negative state-Y put it
// OUTSIDE the room (room footprint is 0..6, 0..8) — this is intentional.
// The test asserts SCREEN ORDERING, which is well-defined whether the
// markers fall inside or outside the room outline.
// --------------------------------------------------------------------

function buildFixtureState() {
  // Reset to a minimal rectangular room — we touch only the fields the
  // four surfaces read for plan projection. NOT calling
  // applyPresetToState() because the presets carry zones / treatments /
  // surauStructure noise that could confuse the assertions.
  state.room = {
    name: 'CROSS-SURFACE FIXTURE',
    shape: 'rectangular',
    width_m: 6,
    depth_m: 8,
    height_m: 3,
    ceiling_type: 'flat',
    surfaces: {
      floor: 'gypsum-board',
      ceiling: 'gypsum-board',
      wall_north: 'gypsum-board',
      wall_south: 'gypsum-board',
      wall_east: 'gypsum-board',
      wall_west: 'gypsum-board',
    },
    custom_vertices: null,
    subStructures: [],
    standaloneEnclosures: [],
    wallSegments: [],
  };
  state.sources = [{
    modelUrl: 'data/loudspeakers/generic-12inch.json',
    position: { x: +1, y: +2, z: 1.2 },
    aim: { yaw: 0, pitch: 0, roll: 0 },
    power_watts: 50,
    groupId: 'A',
    kind: 'point',
  }];
  state.listeners = [{
    id: 'L1',
    label: 'L1',
    position: { x: -1, y: -3, z: 1.2 },
    posture: 'standing',
  }];
  state.zones = [];
  state.treatments = [];
  state.results = { splGrid: null };
}

const SOURCE_POS = { x: +1, y: +2 };
const LISTENER_POS = { x: -1, y: -3 };

// --------------------------------------------------------------------
// Surface 3 — print-plan-svg.js. Pure SVG, called directly. We parse
// the SVG text for the listener circle (cx, cy) and the FIRST source
// triangle's bounding-box centre.
// --------------------------------------------------------------------

function probePrintPlan() {
  buildFixtureState();
  const svg = buildFloorPlanSVG(state);
  // Listener — emitted as <circle cx=".." cy=".." r="0.26" fill="#0a8a4a" ...>.
  const lst = svg.match(/<circle cx="([^"]+)" cy="([^"]+)" r="0\.26" fill="#0a8a4a"/);
  if (!lst) return { error: 'listener circle not found in print-plan SVG' };
  // Source — emitted as <polygon points="ax,ay bx,by cx,cy" fill="<groupColor>" stroke="#000" ...>.
  // The polygon's three vertices: apex (along aim), then two base corners.
  // For yaw=0 the apex sits ABOVE the centre on screen (y decreases).
  const srcPoly = svg.match(/<polygon points="([^"]+)" fill="[^"]+" stroke="#000" stroke-width="0\.04" \/>/);
  if (!srcPoly) return { error: 'source triangle not found in print-plan SVG' };
  const pts = srcPoly[1].split(/\s+/).map(p => p.split(',').map(Number));
  // Bounding-box centre = mean of the three vertex coords.
  const sx = pts.reduce((a, p) => a + p[0], 0) / 3;
  const sy = pts.reduce((a, p) => a + p[1], 0) / 3;
  // Scale bar text — "X m" pattern in a centred <text>.
  const bar = svg.match(/text-anchor="middle"[^>]*>(\S+) m</);
  const barLen = bar ? parseFloat(bar[1]) : null;
  // viewBox to compute m_per_pixel.
  const vb = svg.match(/viewBox="0 0 (\S+) (\S+)"/);
  const viewW = vb ? parseFloat(vb[1]) : null;
  return {
    listener: { sx: parseFloat(lst[1]), sy: parseFloat(lst[2]) },
    source: { sx, sy },
    barLen,
    viewW,
    svg,
  };
}

// --------------------------------------------------------------------
// Surface 4 — print-heatmap.js. Needs a splGrid AND a `document`
// global with a working canvas to produce a data URL. Shim both with
// a 30-line stub that records pixel writes without rasterising.
// --------------------------------------------------------------------

function installCanvasShim() {
  if (typeof globalThis.document !== 'undefined') return;
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`shim does not implement ${tag}`);
      let _w = 0, _h = 0;
      return {
        set width(v) { _w = v; },  get width() { return _w; },
        set height(v) { _h = v; }, get height() { return _h; },
        getContext() {
          return {
            createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
            putImageData() { /* no-op */ },
          };
        },
        // Tiny opaque PNG (1×1) — content doesn't matter to the SVG
        // parser; we only need a non-empty data URL so the SVG renders
        // and we can probe the linework on top.
        toDataURL() { return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; },
      };
    },
  };
}

function makeFakeSplGrid(room) {
  // Minimal grid — origin (0,0), spans the room footprint, 2×2 cells.
  // All cells finite so buildHeatmapDataURL emits non-transparent pixels.
  const cellsX = 2, cellsY = 2;
  return {
    grid: [[60, 70], [50, 80]],
    cellsX, cellsY,
    originX_m: 0,
    originY_m: 0,
    cellW_m: room.width_m / cellsX,
    cellD_m: room.depth_m / cellsY,
    metric: 'spl',
    minSPL_db: 50, maxSPL_db: 80, avgSPL_db: 65,
    sourceCount: 1,
  };
}

function probePrintHeatmap() {
  installCanvasShim();
  buildFixtureState();
  const splGrid = makeFakeSplGrid(state.room);
  const svg = buildHeatmapPageSVG(state, splGrid);
  if (!svg) return { error: 'buildHeatmapPageSVG returned empty string' };
  // Listener — same circle marker as print-plan, but the heatmap version
  // emits TWO circles (white halo + black outline) so match the FIRST
  // one (halo carries cx/cy/r).
  const lst = svg.match(/<circle cx="([^"]+)" cy="([^"]+)" r="0\.26" fill="#0a8a4a"/);
  if (!lst) return { error: 'listener circle not found in print-heatmap SVG' };
  const srcPoly = svg.match(/<polygon points="([^"]+)" fill="[^"]+" stroke="#fff"/);
  if (!srcPoly) return { error: 'source triangle not found in print-heatmap SVG' };
  const pts = srcPoly[1].split(/\s+/).map(p => p.split(',').map(Number));
  const sx = pts.reduce((a, p) => a + p[0], 0) / 3;
  const sy = pts.reduce((a, p) => a + p[1], 0) / 3;
  const bar = svg.match(/text-anchor="middle"[^>]*>(\S+) m</);
  const barLen = bar ? parseFloat(bar[1]) : null;
  const vb = svg.match(/viewBox="0 0 (\S+) (\S+)"/);
  const viewW = vb ? parseFloat(vb[1]) : null;
  return {
    listener: { sx: parseFloat(lst[1]), sy: parseFloat(lst[2]) },
    source: { sx, sy },
    barLen,
    viewW,
    svg,
  };
}

// --------------------------------------------------------------------
// Surface 1 — 2D viewport (room-2d.js). Cannot import in Node
// (depends on rail-system → DOM at module load). We replicate the
// projection formula and text-grep-assert the source uses the same
// formula. This matches the pattern in tests/scene-x-mirror.test.mjs.
// --------------------------------------------------------------------

function projection2D(state, pt) {
  // Mirror of currentRoomGeom() (room-2d.js lines 703-744) for the
  // rectangular-no-extension case (which the fixture is). Verified by
  // grep below.
  const { width_m: w, depth_m: d } = state.room;
  // bounds = roomEffectiveBounds — for a plain rectangular room with no
  // podium / no enclosures, bounds collapse to (0,0)→(w,d).
  const totW = w, totD = d;
  const vbW = 800, vbH = 500, pad = 90;
  const scale = Math.min((vbW - pad * 2) / totW, (vbH - pad * 2) / totD);
  const pxW = w * scale, pxD = d * scale;
  const pxTotalW = totW * scale, pxTotalD = totD * scale;
  const x0 = (vbW - pxTotalW) / 2 - 0 * scale;       // bounds.minX = 0
  const y0 = (vbH - pxTotalD) / 2 + d * scale;       // bounds.maxY = d
  return {
    sx: x0 + (pt.x / w) * pxW,
    sy: y0 - (pt.y / d) * pxD,
  };
}

function probe2DViewport() {
  buildFixtureState();
  const lst = projection2D(state, LISTENER_POS);
  const src = projection2D(state, SOURCE_POS);
  return { listener: lst, source: src };
}

// Text-grep assertions for room-2d.js — the formula MUST match
// projection2D() above. If a source-side refactor changes the formula,
// our analytical probe goes stale silently; this guards that.
function assertRoom2DFormula() {
  const src = readFileSync('./js/graphics/room-2d.js', 'utf8');
  // Listener X projection (line 2575).
  ok(/sx = x0 \+ \(lst\.position\.x \/ room\.width_m\) \* pxW;/.test(src),
     '2d-viewport: listener.sx = x0 + (state.x / width_m) * pxW (state +x → screen RIGHT)');
  // Listener Y projection (line 2576) — note the MINUS (Y-flip).
  ok(/sy = y0 - \(lst\.position\.y \/ room\.depth_m\) \* pxD;/.test(src),
     '2d-viewport: listener.sy = y0 - (state.y / depth_m) * pxD (state +y → screen UP)');
  // currentRoomGeom y0 anchor (line 743).
  ok(/y0 = \(vbH - pxTotalD\) \/ 2 \+ bounds\.maxY \* scale;/.test(src),
     '2d-viewport: y0 anchored at SVG-bottom so world-Y=0 → screen-bottom');
  // North arrow exists as an HTML overlay (not SVG content). Apex of
  // the polygon has the SMALLEST y → arrow points UP on the page.
  // Polygon "6,0 9,6 6,5 3,6" — first vertex y=0 is the apex.
  ok(/<polygon points="6,0 9,6 6,5 3,6"/.test(src),
     '2d-viewport: north arrow polygon apex at (6, 0) — points UP the page');
}

// --------------------------------------------------------------------
// Surface 2 — 3D top-camera. Numeric projection deferred (see top of
// file). Today the surface is guarded by text-grep on scene.js — the
// scene-X-mirror invariants from tests/scene-x-mirror.test.mjs PLUS
// the top-camera preset's specific construction. Any future change
// to either trips a failure here, even though we don't yet assert
// the screen-coord ordering of a fixture point.
// --------------------------------------------------------------------

function probe3DTopCamera() {
  // Returns `deferred: true` so the assertYAxisAgreement /
  // assertXAxisAgreement helpers can skip this surface without
  // pretending it passed. The text-grep gate in assertScene3DFormula
  // is what actually guards this surface today.
  return { deferred: true };
}

function assertScene3DFormula() {
  const src = readFileSync('./js/graphics/scene.js', 'utf8');
  // The mesh-local position for a listener: (state.x, ear, state.y).
  ok(/body\.position\.set\(lst\.position\.x, bodyBottom \+ bodyH \/ 2, lst\.position\.y\)/.test(src),
     'scene.js: listener body uses position.set(state.x, ear-y, state.y) — state.y → world.z');
  // scene.scale.x = -1 invariant — already covered by scene-x-mirror but
  // we re-assert it here so this fixture is self-contained.
  ok(/scene\.scale\.x\s*=\s*-1\s*;/.test(src),
     'scene.js: scene.scale.x = -1 (global X mirror invariant)');
  // Top-camera preset: targetPos negates cx, targetCam at world.x = -cx.
  ok(/case 'top': \{[\s\S]*?targetPos: new THREE\.Vector3\(-cx, 0, cz - 0\.001\)/.test(src),
     "scene.js top-camera: targetPos = (-cx, 0, cz - 0.001) — X negated, looks down");
  ok(/case 'top': \{[\s\S]*?targetCam: new THREE\.Vector3\(-cx, camY, cz\)/.test(src),
     'scene.js top-camera: targetCam = (-cx, camY, cz) — directly above target');
}

// --------------------------------------------------------------------
// Assertion 1 — Y-axis sign agreement across all four surfaces.
// Listener at state y=-3 renders BELOW source at state y=+2.
// "Below" = larger SVG-y (SVG y grows DOWN).
// --------------------------------------------------------------------

function assertYAxisAgreement(probes) {
  const verdicts = {};
  for (const [id, p] of Object.entries(probes)) {
    if (p.deferred) { verdicts[id] = 'DEFERRED'; continue; }
    if (p.error) { verdicts[id] = `ERROR: ${p.error}`; continue; }
    verdicts[id] = p.listener.sy > p.source.sy ? 'listener-below-source' : 'listener-above-source';
  }
  const expected = 'listener-below-source';
  let allMatch = true;
  for (const [, v] of Object.entries(verdicts)) {
    if (v === 'DEFERRED') continue;
    if (v !== expected) allMatch = false;
  }
  ok(allMatch,
     'Y-axis: listener at state y=-3 renders BELOW source at state y=+2 on every surface',
     `verdicts: ${JSON.stringify(verdicts)}`);
}

// --------------------------------------------------------------------
// Assertion 2 — X-axis sign agreement across all four surfaces.
// Source at state x=+1 renders to the RIGHT of listener at state x=-1.
// "Right" = larger SVG-x.
// --------------------------------------------------------------------

function assertXAxisAgreement(probes) {
  const verdicts = {};
  for (const [id, p] of Object.entries(probes)) {
    if (p.deferred) { verdicts[id] = 'DEFERRED'; continue; }
    if (p.error) { verdicts[id] = `ERROR: ${p.error}`; continue; }
    verdicts[id] = p.source.sx > p.listener.sx ? 'source-right-of-listener' : 'source-left-of-listener';
  }
  const expected = 'source-right-of-listener';
  let allMatch = true;
  for (const [, v] of Object.entries(verdicts)) {
    if (v === 'DEFERRED') continue;
    if (v !== expected) allMatch = false;
  }
  ok(allMatch,
     'X-axis: source at state x=+1 renders to the RIGHT of listener at state x=-1 on every surface',
     `verdicts: ${JSON.stringify(verdicts)}`);
}

// --------------------------------------------------------------------
// Assertion 3 — north-arrow tip direction. Each surface that draws a
// north arrow must point UP (matches the Y-axis convention above).
// If a surface omits a north arrow, record null — failure is only if
// any surface points the WRONG way.
// --------------------------------------------------------------------

function assertNorthArrowAgreement(probes) {
  // print-plan-svg.js + print-heatmap.js — both comment "North arrow
  // REMOVED from SVG content as of 2026-05-17" (HTML overlay on the
  // print container). So neither SVG-output surface emits the arrow.
  // We assert this is the current state via grep, and that the 2D
  // viewport HTML overlay points up (already asserted in
  // assertRoom2DFormula). The 3D viewport has no north arrow at all.
  const planSrc = readFileSync('./js/ui/print-plan-svg.js', 'utf8');
  const heatSrc = readFileSync('./js/ui/print-heatmap.js', 'utf8');
  ok(/North arrow REMOVED from SVG content/.test(planSrc),
     'print-plan-svg: north arrow correctly emits NONE in SVG (HTML overlay handles it)');
  ok(/North arrow REMOVED from SVG content/.test(heatSrc),
     'print-heatmap: north arrow correctly emits NONE in SVG (HTML overlay handles it)');
  // The 2D viewport HTML overlay polygon — apex at smallest y → points
  // UP — already checked in assertRoom2DFormula. Confirm the print CSS
  // overlay file exists and references the arrow.
  let printCss = '';
  try { printCss = readFileSync('./css/print.css', 'utf8'); } catch (e) { /* ok */ }
  if (printCss) {
    ok(/pr-cover-hero-plan::after|pr-heatmap-stage::after/.test(printCss),
       'print.css carries the ::after north arrow overlay for the print pages');
  }
}

// --------------------------------------------------------------------
// Assertion 4 — scale-bar magnitude agreement. The two SVG surfaces
// must pick the same "nice" bar length for the same room width.
// Within 2 % (they should be byte-identical for the same room).
// --------------------------------------------------------------------

function assertScaleBarAgreement(probes) {
  const planBar = probes['print-plan']?.barLen;
  const heatBar = probes['print-heatmap']?.barLen;
  if (planBar == null && heatBar == null) {
    ok(true, 'scale-bar: neither print surface drew a scale bar (no comparison)');
    return;
  }
  if (planBar == null || heatBar == null) {
    fail('scale-bar: one print surface drew a bar but not the other',
         `print-plan=${planBar}, print-heatmap=${heatBar}`);
    return;
  }
  const rel = Math.abs(planBar - heatBar) / Math.max(planBar, heatBar);
  ok(rel < 0.02,
     `scale-bar: print-plan (${planBar} m) and print-heatmap (${heatBar} m) agree within 2%`,
     `relative delta = ${(rel * 100).toFixed(2)} %`);
}

// --------------------------------------------------------------------
// Assertion 5 — units string canonicalisation. "m" not "meter",
// no BOM, no surrounding whitespace.
// --------------------------------------------------------------------

const CANONICAL_UNITS = ['m', 'mm', 'dB', 'Hz'];

function assertUnitsCanonical(probes) {
  for (const [id, p] of Object.entries(probes)) {
    if (p.deferred || p.error || !p.svg) continue;
    // No "meter" / "meters" / "metre" / "metres" as standalone words —
    // we use "m".
    const synonyms = /\b(meter|meters|metre|metres|millimeter|millimeters|millimetre|millimetres|decibel|decibels|hertz)\b/i;
    const m = p.svg.match(synonyms);
    ok(!m, `${id}: no spelled-out unit synonyms in SVG output`,
       m ? `found "${m[0]}" — use "m" / "mm" / "dB" / "Hz"` : '');
    // No UTF-8 BOM (the codebase pulled this in once via PowerShell —
    // see feedback_powershell_utf8_corruption).
    ok(p.svg.charCodeAt(0) !== 0xFEFF, `${id}: SVG output starts without UTF-8 BOM`);
    // The scale-bar label uses the canonical " m" suffix (exactly).
    const scaleLabel = p.svg.match(/text-anchor="middle"[^>]*>(\S+) (\w+)</);
    if (scaleLabel) {
      ok(CANONICAL_UNITS.includes(scaleLabel[2]),
         `${id}: scale-bar unit "${scaleLabel[2]}" is canonical (${CANONICAL_UNITS.join(', ')})`);
    }
  }
}

// --------------------------------------------------------------------
// Registry guard — any future "build*SVG" / "render*" export in
// js/graphics or js/ui that LOOKS like a plan-projection surface must
// be registered above. Trips if found.
//
// Heuristic: scan js/graphics + js/ui for files NOT in the SURFACES
// registry that export a function whose name implies plan rendering.
// The flagged set is "obvious additions"; this is a tripwire, not a
// complete static analysis.
// --------------------------------------------------------------------

function assertRegistryComplete() {
  const known = new Set(SURFACES.map(s => s.file));
  // Patterns that imply "this file renders a top-down view of the room".
  const suspectPatterns = [
    /export function buildFloorPlanSVG/,
    /export function buildHeatmapPageSVG/,
    /export function buildPlanView/,
    /export function buildElevationView/,
    /export function buildSiteSVG/,
    /export function renderTopDownView/,
  ];
  const candidates = [];
  for (const dir of ['js/graphics', 'js/ui']) {
    let entries = [];
    try { entries = readdirSync(dir); } catch (e) { continue; }
    for (const name of entries) {
      const p = join(dir, name);
      let stat; try { stat = statSync(p); } catch { continue; }
      if (!stat.isFile() || !name.endsWith('.js')) continue;
      const rel = p.replace(/\\/g, '/');
      if (known.has(rel)) continue;
      const src = readFileSync(p, 'utf8');
      if (suspectPatterns.some(re => re.test(src))) {
        candidates.push(rel);
      }
    }
  }
  ok(candidates.length === 0,
     'registry: no unregistered plan-projection surfaces found',
     candidates.length ? `unregistered: ${candidates.join(', ')} — add to SURFACES at top of this file` : '');
}

// --------------------------------------------------------------------
// Run.
// --------------------------------------------------------------------

const probes = {
  '2d-viewport':   probe2DViewport(),
  '3d-top-camera': probe3DTopCamera(),
  'print-plan':    probePrintPlan(),
  'print-heatmap': probePrintHeatmap(),
};

// Surface-formula text-grep gates.
assertRoom2DFormula();
assertScene3DFormula();

// Cross-surface parity.
assertYAxisAgreement(probes);
assertXAxisAgreement(probes);
assertNorthArrowAgreement(probes);
assertScaleBarAgreement(probes);
assertUnitsCanonical(probes);
assertRegistryComplete();

// Diagnostic dump — printed before exit so failures carry context.
if (failed > 0) {
  console.log('\n--- Probe results (state-frame source (+1,+2), listener (-1,-3)) ---');
  for (const [id, p] of Object.entries(probes)) {
    if (p.deferred) { console.log(`  ${id}: DEFERRED (text-grep only — see file header)`); continue; }
    if (p.error) { console.log(`  ${id}: ERROR ${p.error}`); continue; }
    console.log(`  ${id}: listener=(${p.listener.sx.toFixed(3)}, ${p.listener.sy.toFixed(3)})  source=(${p.source.sx.toFixed(3)}, ${p.source.sy.toFixed(3)})`);
  }
}

console.log(failed === 0
  ? '\nAll cross-surface convention tests passed.'
  : `\n${failed} test(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
